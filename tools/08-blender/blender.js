'use strict';
/**
 * dsh-blender —— DeepSeek Harness (dsh) 插件：驱动本机 Blender 做 3D 建模 / 渲染 / 导出
 *
 * 设计要点
 *  - 架构：进程即用即走（spawn `blender --background --python`）+ 文件即会话（.blend 落盘）
 *  - 状态：workspace/sessions/<id>/scene.blend 是会话"内存"，每次调用加载→执行→保存
 *  - 并发：同 session 串行（进程内队列 + 跨进程 lock 文件），全局 Blender 进程数有上限
 *  - 输出：统一结构化 JSON（execute 默认返回 JSON 字符串，便于模型直接解析）
 *  - 安全：路径限制在工作区内 + 危险代码静态扫描 + 可选受限执行模式（详见文件底部说明）
 *
 * 无任何 npm 依赖，仅用 Node 内置模块（fs/path/os/crypto/child_process）。
 * 不需要在 Blender 侧安装任何 Add-on：全部通过 bpy Python API + Blender 自带导出器完成。
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PLUGIN_NAME = 'dsh-blender';
const PLUGIN_VERSION = '1.0.0';

/* ==========================================================================
 * 0. 配置
 * ========================================================================== */

const DEFAULTS = {
  // Blender 可执行文件。留空 = 自动探测（配置 > 环境变量 > PATH > 常见安装目录）
  blenderPath: '',
  // 工作区根目录（相对路径按 process.cwd() 解析）。会话、渲染、导出、临时文件都在里面
  workspace: '.dsh-blender',
  // 默认会话 id
  defaultSession: 'main',
  // 用 --factory-startup 启动：不加载用户偏好与启动文件，行为可复现。
  // 若你需要某个用户级 Add-on，把它设为 false
  factoryStartup: true,
  // 后台模式禁用音频设备（避免无声卡环境报错）
  noAudio: true,
  // 超时（毫秒）
  timeoutMs: 120000,
  pythonTimeoutMs: 300000,
  renderTimeoutMs: 900000,
  exportTimeoutMs: 600000,
  versionTimeoutMs: 30000,
  // 同时最多几个 Blender 进程
  maxConcurrent: 2,
  // 等待会话锁
  lockTimeoutMs: 120000,
  // 锁过期判定必须大于最长的 renderTimeoutMs 并留余量：
  // 否则渲染在超时收尾的瞬间，锁 mtime 恰好跨过 stale 边界，第二个等待者会"合法"偷走锁，
  // 与仍在收尾（准备 save_as_mainfile）的第一个进程并发写同一 scene.blend。
  lockStaleMs: 1200000,
  // 单次调用回传的 stdout/stderr 上限（字节），超出会截断
  maxOutputBytes: 131072,
  // 单段 Python 代码长度上限
  maxCodeBytes: 200000,
  // 保留临时脚本（排错用）
  keepScripts: false,
  // 危险代码扫描：off | warn | block（block 只拦 high 级别）
  guard: 'block',
  // 受限执行模式：屏蔽危险模块导入、限制 open() 写入路径（防误伤，不是沙箱）。
  // 默认开启（2026-09-13 安全加固：blender_run_python 在宿主权限下执行任意 Python，
  // 默认受限可显著降低模型/注入内容读取本机文件的暴露面）。
  restrictedMode: true,
  blockedModules: [
    'subprocess', 'shutil', 'socket', 'ctypes', 'winreg', 'urllib', 'http',
    'requests', 'ftplib', 'telnetlib', 'multiprocessing', 'pty', 'pexpect'
  ],
  // 是否允许导出/渲染到工作区之外的路径
  allowOutsideWorkspace: false,
  // 渲染结果是否内联 base64（模型有视觉能力时可开，很吃上下文）
  inlineImage: false,
  maxInlineImageBytes: 2097152,
  // execute 返回值：json-string（默认，最通用） | object
  resultFormat: 'object',
  // JSON 缩进（0 = 紧凑）
  jsonIndent: 0,
  // 追加/覆盖传给 Blender 的环境变量
  extraEnv: {},
  // 新会话首次创建时，从这个 .blend 复制模板（可选）
  startupBlend: '',
  // 在返回值里附带 Node 堆栈（排错用）
  debug: false
};

function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULTS, raw || {});
  cfg.workspace = path.resolve(String(cfg.workspace || '.dsh-blender'));
  cfg.maxConcurrent = Math.max(1, Number(cfg.maxConcurrent) || 1);
  cfg.jsonIndent = Number(cfg.jsonIndent) || 0;
  if (!/^(off|warn|block)$/.test(String(cfg.guard))) cfg.guard = 'warn';
  if (!/^(json-string|object)$/.test(String(cfg.resultFormat))) cfg.resultFormat = 'json-string';
  cfg.blockedModules = Array.isArray(cfg.blockedModules) ? cfg.blockedModules.map(String) : [];
  return cfg;
}

/* ==========================================================================
 * 1. 小工具
 * ========================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pluginError(kind, message, hint) {
  const err = new Error(message);
  err.kind = kind;
  if (hint) err.hint = hint;
  return err;
}

function expandVars(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
}

function normCase(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isInside(parent, child) {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function sanitizeId(id) {
  const s = String(id == null ? '' : id).trim();
  if (/^[A-Za-z0-9._-]{1,48}$/.test(s) && s !== '.' && s !== '..') return s;
  return 's' + crypto.createHash('sha1').update(s || 'default').digest('hex').slice(0, 12);
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function writeJson(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Blender 在 Windows 上可能用系统代码页输出中文，这里做 UTF-8 → GBK 回退解码 */
function decodeBuffer(buf) {
  if (!buf || !buf.length) return '';
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0 || bad / Math.max(1, utf8.length) < 0.005) return utf8;
  for (const enc of ['gbk', 'big5', 'latin1']) {
    try {
      const alt = new TextDecoder(enc, { fatal: false }).decode(buf);
      const altBad = (alt.match(/\uFFFD/g) || []).length;
      if (altBad < bad) return alt;
    } catch (e) { /* 该编码不可用则跳过 */ }
  }
  return utf8;
}

function truncate(text, limit) {
  const s = text == null ? '' : String(text);
  if (!limit || s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return s.slice(0, half) + `\n... [已截断 ${s.length - limit} 字符] ...\n` + s.slice(-half);
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      // Windows 下 child.kill() 不保证杀掉子进程，用 taskkill /T 杀进程树
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore'
      });
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 非进程组长 */ }
    }
  } catch (e) { /* ignore */ }
  try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function parseVersion(str) {
  const m = String(str).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
}

function cmpVersionDesc(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) { active += 1; next(release); }
  };
  return {
    acquire() {
      if (active < max) { active += 1; return Promise.resolve(release); }
      return new Promise((resolve) => waiters.push((rel) => resolve(rel)));
    }
  };
}

/* ==========================================================================
 * 2. 进程执行
 * ========================================================================== */

function baseEnv(config) {
  return Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  }, config.extraEnv || {});
}

/**
 * 用 spawn（shell:false，参数数组）执行命令，绝不经过 cmd.exe，避免路径/引号注入。
 */
function spawnCapture(cmd, args, opts = {}) {
  const maxBytes = opts.maxBytes || 131072;
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || undefined,
        env: opts.env || process.env,
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({
        ok: false, spawnError: err, code: null, signal: null, timedOut: false,
        stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        durationMs: Date.now() - started, cmd, args
      });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;

    child.stdout.on('data', (b) => {
      if (outBytes < maxBytes) { outChunks.push(b); outBytes += b.length; }
    });
    child.stderr.on('data', (b) => {
      if (errBytes < maxBytes) { errChunks.push(b); errBytes += b.length; }
    });

    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
      if (timer.unref) timer.unref();
    }

    const finish = (code, signal, err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: !err && !timedOut && code === 0,
        spawnError: err || null,
        code, signal, timedOut,
        stdout: decodeBuffer(Buffer.concat(outChunks)),
        stderr: decodeBuffer(Buffer.concat(errChunks)),
        stdoutTruncated: outBytes >= maxBytes,
        stderrTruncated: errBytes >= maxBytes,
        durationMs: Date.now() - started,
        cmd, args
      });
    };

    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

/* ==========================================================================
 * 3. Blender 可执行文件探测
 * ========================================================================== */

async function resolveBlender(config, state) {
  const cached = state.blender;
  if (cached && Date.now() - cached.at < 60000 && fs.existsSync(cached.path)) return cached;

  const candidates = [];
  const seen = new Set();
  const push = (p, source, ver) => {
    if (!p) return;
    const abs = path.resolve(expandVars(p));
    const key = normCase(abs);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: abs, source, version: ver || null });
  };

  // 1) 显式配置
  if (config.blenderPath) {
    let p = expandVars(config.blenderPath);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        p = path.join(p, process.platform === 'win32' ? 'blender.exe' : 'blender');
      }
    } catch (e) { /* ignore */ }
    push(p, 'config.blenderPath');
  }

  // 2) 环境变量
  for (const key of ['DSH_BLENDER_PATH', 'BLENDER_PATH', 'BLENDER']) {
    if (process.env[key]) push(process.env[key], 'env:' + key);
  }

  // 3) PATH
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE').split(';').filter(Boolean)
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, 'blender' + ext.toLowerCase());
      if (fs.existsSync(cand)) push(cand, 'PATH');
      const cand2 = path.join(dir, 'blender' + ext);
      if (fs.existsSync(cand2)) push(cand2, 'PATH');
    }
  }

  // 4) 常见安装目录
  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Blender Foundation',
      'C:\\Program Files (x86)\\Blender Foundation',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Blender Foundation') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Blender Foundation') : null
    ].filter(Boolean);
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch (e) { continue; }
      const versions = [];
      for (const name of entries) {
        const dir = path.join(root, name);
        const exe = path.join(dir, 'blender.exe');
        try {
          if (fs.statSync(dir).isDirectory() && fs.existsSync(exe)) {
            versions.push({ exe, version: parseVersion(name), name });
          }
        } catch (e) { /* ignore */ }
      }
      versions.sort((a, b) => cmpVersionDesc(a.version, b.version));
      for (const v of versions) push(v.exe, 'scan:' + root, v.name);
      const direct = path.join(root, 'blender.exe');
      if (fs.existsSync(direct)) push(direct, 'scan:' + root);
    }
  } else if (process.platform === 'darwin') {
    push('/Applications/Blender.app/Contents/MacOS/Blender', 'scan:/Applications');
    try {
      const home = os.homedir();
      for (const n of fs.readdirSync(path.join(home, 'Applications'))) {
        const exe = path.join(home, 'Applications', n, 'Contents', 'MacOS', 'Blender');
        if (fs.existsSync(exe)) push(exe, 'scan:~/Applications');
      }
    } catch (e) { /* ignore */ }
  } else {
    for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender',
      '/opt/blender/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender']) {
      push(p, 'scan');
    }
  }

  const hit = candidates.find((c) => fs.existsSync(c.path));
  if (!hit) return null;
  state.blender = Object.assign({ at: Date.now() }, hit, { candidates: candidates.slice(0, 8) });
  return state.blender;
}

/* ==========================================================================
 * 4. 会话管理（文件即会话）
 * ========================================================================== */

function createState(config) {
  return {
    config,
    blender: null,
    queues: new Map(),
    sem: createSemaphore(config.maxConcurrent),
    sessionsDir: path.join(config.workspace, 'sessions'),
    tmpDir: path.join(config.workspace, 'tmp'),
    driverPath: path.join(config.workspace, 'tmp', 'driver.py')
  };
}

function sessionPaths(state, id) {
  const safe = sanitizeId(id);
  const dir = path.join(state.sessionsDir, safe);
  return {
    id: safe,
    dir,
    blend: path.join(dir, 'scene.blend'),
    meta: path.join(dir, 'session.json'),
    renders: path.join(dir, 'renders'),
    exports: path.join(dir, 'exports'),
    snapshots: path.join(dir, 'snapshots'),
    lock: path.join(dir, '.lock')
  };
}

async function ensureSession(state, id, opts = {}) {
  const sp = sessionPaths(state, id || state.config.defaultSession);
  await fsp.mkdir(sp.dir, { recursive: true });
  await fsp.mkdir(sp.renders, { recursive: true });
  await fsp.mkdir(sp.exports, { recursive: true });
  await fsp.mkdir(sp.snapshots, { recursive: true });

  let meta = await readJsonSafe(sp.meta);
  if (!meta) {
    meta = {
      id: sp.id,
      createdAt: new Date().toISOString(),
      blend: sp.blend,
      calls: 0,
      snapshots: []
    };
    await writeJson(sp.meta, meta);
  }

  // 可选：从模板 .blend 初始化
  const tpl = state.config.startupBlend;
  if (tpl && !fs.existsSync(sp.blend) && !opts.noTemplate) {
    const src = path.resolve(expandVars(tpl));
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, sp.blend);
      meta.createdFrom = src;
      await writeJson(sp.meta, meta);
    }
  }
  return { sp, meta };
}

/** 进程内串行队列：同一个 key 的任务按提交顺序执行 */
function enqueue(state, key, fn) {
  const prev = state.queues.get(key) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  state.queues.set(key, next.catch(() => {}));
  return next;
}

/** 跨进程 lock 文件：防止两个 dsh 实例同时写同一个 .blend */
async function acquireFileLock(lockPath, { timeoutMs = 120000, staleMs = 1200000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomBytes(16).toString('hex');
  // 原子删除残留锁：rename 到唯一名字，成功者（rename 是原子的，且目标存在时在
  // Windows 上会 EEXIST/EPERM）才有资格真正删除，避免两个等待者互相删掉对方新建的锁。
  const removeStale = (p) => {
    try {
      const stalePath = `${p}.stale.${crypto.randomBytes(6).toString('hex')}`;
      fs.renameSync(p, stalePath);
      try { fs.unlinkSync(stalePath); } catch (e) { /* ignore */ }
    } catch (e) { /* 已被别人处理或不存在，忽略 */ }
  };
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, host: os.hostname(), at: Date.now() }));
      fs.closeSync(fd);
      return {
        release() {
          // 只删"自己的"锁：回读校验 token 匹配才删，防止释放时误删别人刚抢到的新锁（ABA）
          try {
            const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (info && info.token === token) fs.unlinkSync(lockPath);
          } catch (e) { /* ignore */ }
        }
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      // 判断是否为残留锁
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) { removeStale(lockPath); continue; }
        const info = await readJsonSafe(lockPath);
        if (info && info.pid && !isAlive(info.pid) && info.host === os.hostname()) {
          removeStale(lockPath);
          continue;
        }
      } catch (e) { /* ignore */ }
      if (Date.now() > deadline) {
        throw pluginError(
          'session_locked',
          `等待会话锁超时：${lockPath}`,
          '可能有另一个 dsh 调用/实例正在写同一个会话。稍后重试，或换一个 session，或删除该 .lock 文件。'
        );
      }
      await sleep(150 + Math.floor(Math.random() * 200));
    }
  }
}

/* ==========================================================================
 * 5. 内嵌 Python driver
 *    （String.raw 保证反斜杠原样写入；运行时写到 workspace/tmp/driver.py）
 * ========================================================================== */

const PY_DRIVER = String.raw`# -*- coding: utf-8 -*-
"""dsh-blender driver —— 由 dsh-blender 插件写入工作区，交给 Blender 在 --background 下执行。

命令行: blender -b <scene.blend> --python-exit-code 77 --python <driver.py> -- <job.json>

约定: 只要 driver 成功写出 result.json 就以 exit 0 退出。
      非 0 退出码且没有 result.json => driver 本身崩了（Node 侧据此生成可读错误）。
"""
import contextlib
import io
import json
import os
import sys
import time
import traceback

import bpy
import bmesh
import math
import random
import re
from mathutils import Vector, Matrix, Euler, Quaternion, Color

START = time.time()
OUT = io.StringIO()
ERR = io.StringIO()
RESULT_PATH = None
JOB = {}


# ---------------------------------------------------------------- 基础设施

def _script_args():
    argv = list(sys.argv)
    if '--' in argv:
        return argv[argv.index('--') + 1:]
    return argv[1:]


def _truncate(text, limit):
    if text is None:
        return ''
    if not isinstance(text, str):
        text = str(text)
    if not limit or len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + ('\n... [省略 %d 字符] ...\n' % (len(text) - limit)) + text[-half:]


def _jsonable(value, depth=0, seen=None):
    """把任意 Python 对象转成可 JSON 序列化的结构（有深度/数量/长度上限）。"""
    if seen is None:
        seen = set()
    if depth > 6:
        return '<max-depth>'
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float('inf'), float('-inf')):
            return str(value)
        return value
    if id(value) in seen:
        return '<recursion>'
    if isinstance(value, (list, tuple, set, frozenset)):
        seen.add(id(value))
        out = [_jsonable(v, depth + 1, seen) for v in list(value)[:500]]
        seen.discard(id(value))
        return out
    if isinstance(value, dict):
        seen.add(id(value))
        out = {}
        for i, k in enumerate(value.keys()):
            if i >= 500:
                break
            out[str(k)] = _jsonable(value[k], depth + 1, seen)
        seen.discard(id(value))
        return out
    for attr in ('to_dict', 'to_list', 'to_tuple', 'to_euler', 'to_quaternion'):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return _jsonable(fn(), depth + 1, seen)
            except Exception:
                pass
    for attrs in (('x', 'y', 'z', 'w'), ('x', 'y', 'z'), ('x', 'y')):
        if all(hasattr(value, a) for a in attrs):
            try:
                return [getattr(value, a) for a in attrs]
            except Exception:
                pass
    try:
        return '<%s %s>' % (type(value).__name__, _truncate(repr(value), 300))
    except Exception:
        return '<%s>' % type(value).__name__


def _vec(v):
    try:
        return [round(float(x), 6) for x in v]
    except Exception:
        return None


@contextlib.contextmanager
def _redirect(out, err):
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        yield
    finally:
        sys.stdout, sys.stderr = old_out, old_err


def hint_for(exc):
    msg = str(exc)
    low = msg.lower()
    if isinstance(exc, SyntaxError):
        return 'Python 语法错误：检查缩进（必须 4 空格/一致）、括号与冒号。'
    if isinstance(exc, IndentationError):
        return '缩进错误：代码块内缩进必须一致，不要混用 tab 和空格。'
    if isinstance(exc, NameError):
        return '名字未定义：检查拼写，或忘了 import（bpy/bmesh/mathutils 已预置）。'
    if isinstance(exc, AttributeError):
        return '属性不存在：可能是 Blender 版本差异，用 blender_scene_info 或 hasattr() 先探测。'
    if isinstance(exc, ImportError):
        return '导入失败：Blender 内置环境只有标准库 + bpy/bmesh/mathutils/numpy，没有第三方包。'
    if isinstance(exc, KeyError):
        return '字典键不存在：检查 bpy 集合名/输入插座名（如 4.x 的 Emission 改名为 Emission Color）。'
    if 'poll() failed' in low or 'context is incorrect' in low or 'context is invalid' in low:
        return ('该算子需要特定上下文。改用 bpy 数据 API（bpy.data.*），'
                '或先设置 bpy.context.view_layer.objects.active 并确保对象模式。')
    if 'no camera' in low or 'camera' in low and 'none' in low:
        return '场景没有激活相机：先创建相机并设置 scene.camera，或给 blender_render 传 camera 参数。'
    if 'evee' in low and 'gpu' in low:
        return 'EEVEE 在 --background 下需要 GPU 上下文：改用 CYCLES（CPU）或 BLENDER_WORKBENCH。'
    if isinstance(exc, PermissionError):
        return '权限被拒：受限模式拦截了该路径写入，或目标目录不可写。'
    if isinstance(exc, FileNotFoundError):
        return '文件不存在：检查路径拼写与大小写（Windows 路径建议用正斜杠）。'
    if isinstance(exc, SystemExit):
        return '代码里调用了 sys.exit()，这会中断整个任务。'
    return None


def describe_exception(exc):
    tb = traceback.format_exc()
    lines = tb.splitlines()
    keep = []
    started = False
    for ln in lines:
        if '<dsh-blender' in ln:
            started = True
        if started:
            keep.append(ln)
    if not keep:
        keep = lines[-14:]
    info = {
        'kind': 'python_exception',
        'pythonType': type(exc).__name__,
        'message': _truncate(str(exc), 4000),
        'traceback': _truncate('\n'.join(keep), 8000)
    }
    line = getattr(exc, 'lineno', None)
    if line is not None:
        info['line'] = line
    h = hint_for(exc)
    if h:
        info['hint'] = h
    return info


def scene_summary():
    try:
        scn = bpy.context.scene
        return {
            'scene': scn.name,
            'frame': scn.frame_current,
            'objects': len(bpy.data.objects),
            'engine': getattr(scn.render, 'engine', None),
            'camera': scn.camera.name if scn.camera else None,
            'blend': bpy.data.filepath or None
        }
    except Exception as exc:
        return {'error': str(exc)}


def collect_files(job, options):
    paths = []
    out = options.get('outPath')
    if out:
        for cand in (out, out + '.png', out + '.jpg', out + '.jpeg',
                     out + '.obj', out + '.mtl', out + '.glb', out + '.gltf',
                     out + '.bin', out + '.fbx', out + '.stl'):
            if os.path.isfile(cand) and cand not in paths:
                paths.append(cand)
    blend = job.get('blendPath')
    if blend and os.path.isfile(blend) and blend not in paths:
        paths.append(blend)
    files = []
    for p in paths:
        try:
            st = os.stat(p)
            files.append({'path': p, 'bytes': st.st_size, 'mtime': int(st.st_mtime)})
        except OSError:
            pass
    return files


# ---------------------------------------------------------------- 用户命名空间

def _obj(name):
    ob = bpy.data.objects.get(name)
    if ob is None:
        names = ', '.join(o.name for o in bpy.data.objects) or '（空场景）'
        raise ValueError('找不到对象: %s；现有对象: %s' % (name, names))
    return ob


def _deselect_all():
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)


def _select(name=None, active=True):
    _deselect_all()
    if name is None:
        return None
    ob = _obj(name)
    ob.select_set(True)
    if active:
        bpy.context.view_layer.objects.active = ob
    return ob


def _link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _look_at(ob, target):
    direction = Vector(target) - ob.location
    if direction.length == 0:
        return ob
    ob.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    return ob


def _add_cube(name='Cube', size=2.0, location=(0.0, 0.0, 0.0)):
    """用 bmesh 直接建网格，避免算子上下文问题（后台模式最稳）。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=float(size))
    bm.to_mesh(mesh)
    bm.free()
    ob = bpy.data.objects.new(name, mesh)
    ob.location = location
    return _link(ob)


def _add_plane(name='Plane', size=10.0, location=(0.0, 0.0, 0.0)):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=float(size) / 2.0)
    bm.to_mesh(mesh)
    bm.free()
    ob = bpy.data.objects.new(name, mesh)
    ob.location = location
    return _link(ob)


def _add_camera(name='Camera', location=(7.0, -7.0, 5.0), target=(0.0, 0.0, 0.0), lens=50.0):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = float(lens)
    ob = bpy.data.objects.new(name, cam_data)
    ob.location = location
    _link(ob)
    _look_at(ob, target)
    bpy.context.scene.camera = ob
    return ob


def _add_light(name='Light', type='AREA', location=(4.0, -4.0, 6.0),
               target=(0.0, 0.0, 0.0), energy=1000.0, size=5.0, color=(1.0, 1.0, 1.0)):
    light_data = bpy.data.lights.new(name, type=type)
    light_data.energy = float(energy)
    if hasattr(light_data, 'size'):
        light_data.size = float(size)
    light_data.color = color
    ob = bpy.data.objects.new(name, light_data)
    ob.location = location
    _link(ob)
    _look_at(ob, target)
    return ob


def _set_material(obj, name='Material', color=(0.8, 0.8, 0.8, 1.0), metallic=0.0,
                  roughness=0.5, emission=None, emission_strength=1.0):
    """给对象挂 Principled BSDF 材质。obj 可以是对象名或对象本身。"""
    ob = obj if hasattr(obj, 'data') else _obj(obj)
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except AttributeError:
        # Blender 6.0+ 移除 use_nodes（节点默认启用）
        pass
    bsdf = None
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n
            break
    if bsdf is None:
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf is not None:
        try:
            bsdf.inputs['Base Color'].default_value = tuple(color)
        except Exception:
            pass
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = float(metallic)
        if 'Roughness' in bsdf.inputs:
            bsdf.inputs['Roughness'].default_value = float(roughness)
        if emission is not None:
            key = 'Emission Color' if 'Emission Color' in bsdf.inputs else 'Emission'
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = tuple(emission)
            if 'Emission Strength' in bsdf.inputs:
                bsdf.inputs['Emission Strength'].default_value = float(emission_strength)
    data = getattr(ob, 'data', None)
    if data is not None and hasattr(data, 'materials'):
        if len(data.materials) == 0:
            data.materials.append(mat)
        else:
            data.materials[0] = mat
    return mat


def _studio():
    """一键搭一个可渲染的棚：地面 + 三点光 + 相机。"""
    _add_plane('Ground', size=20.0)
    _add_light('Key', 'AREA', (5.0, -5.0, 7.0), (0, 0, 0), 1500.0, 6.0)
    _add_light('Fill', 'AREA', (-6.0, -3.0, 4.0), (0, 0, 0), 500.0, 8.0)
    _add_light('Rim', 'AREA', (0.0, 6.0, 5.0), (0, 0, 0), 800.0, 6.0)
    cam = _add_camera('Camera', (7.0, -7.0, 5.0), (0.0, 0.0, 0.5), 50.0)
    return {'camera': cam.name, 'lights': ['Key', 'Fill', 'Rim'], 'ground': 'Ground'}


def _restricted_builtins(options):
    """受限模式：屏蔽危险模块导入 + 限制 open() 写工作区之外。
    注意：这是"防误伤"级别，不是安全沙箱（bpy 自身仍能读写文件）。"""
    import builtins as _b
    allowed_prefix = options.get('allowedPathPrefix') or ''
    blocked = set(options.get('blockedModules') or [])
    real_import = _b.__import__
    real_open = _b.open

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = str(name).split('.')[0]
        if root in blocked:
            raise ImportError('[dsh-blender 受限模式] 禁止导入模块: %s' % name)
        return real_import(name, globals, locals, fromlist, level)

    def _is_within(prefix, p):
        # 用 commonpath 做"真目录边界"判定，避免 startswith 前缀匹配把
        # C:\dsh\.dsh-blender-backup 这类兄弟目录误判为工作区内（路径分隔符陷阱）。
        try:
            return os.path.commonpath([os.path.abspath(prefix), os.path.abspath(p)]) == os.path.abspath(prefix)
        except ValueError:  # 不同盘符等不可比情况
            return False

    def guarded_open(file, mode='r', *args, **kwargs):
        writing = any(c in str(mode) for c in ('w', 'a', 'x', '+'))
        if writing and allowed_prefix:
            try:
                p = os.path.abspath(str(file))
                if not _is_within(allowed_prefix, p):
                    raise PermissionError(
                        '[dsh-blender 受限模式] 只允许写入工作区内: %s' % file)
            except PermissionError:
                raise
            except Exception:
                pass
        return real_open(file, mode, *args, **kwargs)

    ns = dict(_b.__dict__)
    ns['__import__'] = guarded_import
    ns['open'] = guarded_open
    return ns


def build_namespace(options):
    import builtins as _b
    ns = {
        '__name__': 'dsh_user_code',
        '__doc__': None,
        'bpy': bpy,
        'bmesh': bmesh,
        'math': math,
        'random': random,
        'json': json,
        're': re,
        'Vector': Vector,
        'Matrix': Matrix,
        'Euler': Euler,
        'Quaternion': Quaternion,
        'Color': Color,
        'C': bpy.context,
        'D': bpy.data,
        'scene': bpy.context.scene,
        'RESULT': None,
        'log': lambda *a: print(*a),
        # 便捷函数
        'obj': _obj,
        'select': _select,
        'deselect_all': _deselect_all,
        'look_at': _look_at,
        'add_cube': _add_cube,
        'add_plane': _add_plane,
        'add_camera': _add_camera,
        'add_light': _add_light,
        'set_material': _set_material,
        'studio': _studio,
    }
    if options.get('restricted'):
        ns['__builtins__'] = _restricted_builtins(options)
    else:
        ns['__builtins__'] = _b.__dict__
    return ns


def run_user_code(job, options, max_text):
    code = job.get('code') or ''
    ns = build_namespace(options)
    compiled = compile(code, '<dsh-blender>', 'exec')
    error = None
    with _redirect(OUT, ERR):
        try:
            exec(compiled, ns)
        except BaseException as exc:
            error = exc
    result = ns.get('RESULT', None)
    expr = options.get('resultExpression')
    if error is None and expr:
        with _redirect(OUT, ERR):
            try:
                result = eval(compile(expr, '<dsh-blender-result>', 'eval'), ns)
            except BaseException as exc:
                error = exc
    payload = {'ok': error is None, 'result': _jsonable(result)}
    payload['globals'] = sorted(k for k in ns.keys() if not k.startswith('_'))
    if error is not None:
        payload['error'] = describe_exception(error)
    return payload


# ---------------------------------------------------------------- 内置任务

def scene_info(options):
    scn = bpy.context.scene
    detail = options.get('detail') or 'objects'
    max_objs = int(options.get('maxObjects') or 200)
    info = {
        'blendFile': bpy.data.filepath or None,
        'blenderVersion': bpy.app.version_string,
        'scene': {
            'name': scn.name,
            'frame': scn.frame_current,
            'frameRange': [scn.frame_start, scn.frame_end],
            'fps': scn.render.fps,
            'engine': scn.render.engine,
            'resolution': [scn.render.resolution_x, scn.render.resolution_y,
                           scn.render.resolution_percentage],
            'camera': scn.camera.name if scn.camera else None,
            'unitSystem': scn.unit_settings.system,
            'world': scn.world.name if scn.world else None
        },
        'counts': {
            'objects': len(bpy.data.objects),
            'meshes': len(bpy.data.meshes),
            'materials': len(bpy.data.materials),
            'lights': len(bpy.data.lights),
            'cameras': len(bpy.data.cameras),
            'collections': len(bpy.data.collections),
            'images': len(bpy.data.images),
            'texts': len(bpy.data.texts)
        }
    }
    if detail == 'summary':
        info['objects'] = [{'name': o.name, 'type': o.type} for o in list(bpy.data.objects)[:max_objs]]
        info['truncated'] = len(bpy.data.objects) > max_objs
        return info

    objects = []
    for ob in list(bpy.data.objects)[:max_objs]:
        rec = {
            'name': ob.name,
            'type': ob.type,
            'location': _vec(ob.location),
            'rotationEuler': _vec(ob.rotation_euler),
            'scale': _vec(ob.scale),
            'dimensions': _vec(ob.dimensions),
            'parent': ob.parent.name if ob.parent else None,
            'collections': [c.name for c in ob.users_collection],
            'hideViewport': bool(ob.hide_viewport),
            'hideRender': bool(ob.hide_render),
            'modifiers': [{'name': m.name, 'type': m.type} for m in ob.modifiers],
            'materials': [ms.material.name if ms.material else None for ms in ob.material_slots]
        }
        if ob.type == 'MESH' and ob.data:
            rec['mesh'] = {
                'vertices': len(ob.data.vertices),
                'edges': len(ob.data.edges),
                'polygons': len(ob.data.polygons),
                'uvLayers': [l.name for l in ob.data.uv_layers],
                'materials': [m.name if m else None for m in ob.data.materials]
            }
        elif ob.type == 'CAMERA' and ob.data:
            rec['camera'] = {'lens': ob.data.lens, 'type': ob.data.type,
                             'sensorWidth': ob.data.sensor_width}
        elif ob.type == 'LIGHT' and ob.data:
            rec['light'] = {'type': ob.data.type, 'energy': ob.data.energy,
                            'color': _vec(ob.data.color)}
        objects.append(rec)
    info['objects'] = objects
    info['truncated'] = len(bpy.data.objects) > max_objs

    if detail == 'full':
        info['materials'] = [{'name': m.name, 'users': m.users, 'useNodes': m.use_nodes}
                             for m in bpy.data.materials]
        info['collections'] = [{'name': c.name, 'objects': [o.name for o in c.objects]}
                               for c in bpy.data.collections]
        info['worlds'] = [w.name for w in bpy.data.worlds]
        info['images'] = [{'name': i.name, 'size': list(i.size), 'source': i.source}
                          for i in bpy.data.images]
        info['texts'] = [t.name for t in bpy.data.texts]
    return info


def do_render(options):
    scn = bpy.context.scene
    engine = options.get('engine')
    if engine:
        try:
            scn.render.engine = str(engine)
        except Exception as exc:
            raise ValueError('无效的渲染引擎 %r（%s）。可选: CYCLES / BLENDER_EEVEE_NEXT / '
                             'BLENDER_EEVEE / BLENDER_WORKBENCH' % (engine, exc))

    samples = options.get('samples')
    if samples:
        samples = int(samples)
        if hasattr(scn, 'cycles'):
            scn.cycles.samples = samples
            if hasattr(scn.cycles, 'preview_samples'):
                scn.cycles.preview_samples = min(samples, 16)
        if hasattr(scn, 'eevee') and hasattr(scn.eevee, 'taa_render_samples'):
            scn.eevee.taa_render_samples = samples

    if options.get('resolutionX'):
        scn.render.resolution_x = int(options['resolutionX'])
    if options.get('resolutionY'):
        scn.render.resolution_y = int(options['resolutionY'])
    if options.get('resolutionPercentage'):
        scn.render.resolution_percentage = int(options['resolutionPercentage'])
    if options.get('filmTransparent') is not None:
        scn.render.film_transparent = bool(options['filmTransparent'])

    fmt = str(options.get('format') or 'PNG').upper()
    if fmt not in ('PNG', 'JPEG'):
        raise ValueError('不支持的图片格式: %s（只支持 PNG / JPEG）' % fmt)
    scn.render.image_settings.file_format = fmt
    cm = options.get('colorMode')
    scn.render.image_settings.color_mode = cm or ('RGBA' if scn.render.film_transparent else 'RGB')

    if options.get('frame') is not None:
        scn.frame_set(int(options['frame']))

    cam_name = options.get('camera')
    if cam_name:
        cam = bpy.data.objects.get(str(cam_name))
        if cam is None:
            raise ValueError('找不到相机对象: %s' % cam_name)
        if cam.type != 'CAMERA':
            raise ValueError('对象 %s 不是相机（type=%s）' % (cam_name, cam.type))
        scn.camera = cam
    if scn.camera is None:
        raise ValueError('场景没有激活相机。先用 blender_run_python 创建相机'
                         '（例如 add_camera()），或给 blender_render 传 camera 参数。')

    out = options.get('outPath')
    if not out:
        raise ValueError('缺少输出路径 outPath')
    scn.render.filepath = out
    scn.render.use_file_extension = True

    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    elapsed = int((time.time() - t0) * 1000)

    candidates = [out, out + '.png', out + '.jpg', out + '.jpeg']
    written = None
    for c in candidates:
        if os.path.isfile(c):
            written = c
            break
    if written is None:
        raise RuntimeError('渲染命令执行完成，但没有找到输出文件（期望 %s.png）。'
                           '请检查 scene.render.filepath 与目录权限。' % out)
    return {
        'file': written,
        'bytes': os.path.getsize(written),
        'engine': scn.render.engine,
        'samples': samples,
        'camera': scn.camera.name,
        'frame': scn.frame_current,
        'resolution': [scn.render.resolution_x, scn.render.resolution_y,
                       scn.render.resolution_percentage],
        'renderMs': elapsed
    }


def _ensure_addon(module):
    try:
        import addon_utils
        if not addon_utils.check(module)[1]:
            addon_utils.enable(module, default_set=True, persistent=False)
    except Exception:
        pass


def do_export(options):
    fmt = str(options.get('format') or '').lower()
    out = options.get('outPath')
    if not out:
        raise ValueError('缺少输出路径 outPath')
    selection = str(options.get('selection') or 'all').lower()
    names = list(options.get('objects') or [])
    apply_mod = bool(options.get('applyModifiers', True))
    extra = dict(options.get('formatOptions') or {})

    use_sel = selection in ('selected', 'objects')
    if selection == 'objects':
        if not names:
            raise ValueError('selection=objects 时必须提供 objects 数组')
        _deselect_all()
        missing = []
        for n in names:
            ob = bpy.data.objects.get(str(n))
            if ob is None:
                missing.append(str(n))
                continue
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
        if missing:
            raise ValueError('找不到对象: %s' % ', '.join(missing))

    kwargs = dict(extra)
    kwargs['filepath'] = out

    if fmt in ('glb', 'gltf'):
        _ensure_addon('io_scene_gltf2')
        if not hasattr(bpy.ops.export_scene, 'gltf'):
            raise RuntimeError('当前 Blender 没有 glTF 导出器（io_scene_gltf2 未启用）')
        kwargs.setdefault('export_format', 'GLB' if fmt == 'glb' else 'GLTF_SEPARATE')
        kwargs.setdefault('use_selection', use_sel)
        kwargs.setdefault('export_apply', apply_mod)
        kwargs.setdefault('export_yup', True)
        bpy.ops.export_scene.gltf(**kwargs)

    elif fmt == 'obj':
        if hasattr(bpy.ops.wm, 'obj_export'):
            kwargs.setdefault('export_selected_objects', use_sel)
            kwargs.setdefault('apply_modifiers', apply_mod)
            kwargs.setdefault('export_materials', True)
            bpy.ops.wm.obj_export(**kwargs)
        elif hasattr(bpy.ops.export_scene, 'obj'):
            kwargs.setdefault('use_selection', use_sel)
            kwargs.setdefault('apply_modifiers', apply_mod)
            bpy.ops.export_scene.obj(**kwargs)
        else:
            raise RuntimeError('当前 Blender 没有 OBJ 导出器')

    elif fmt == 'fbx':
        _ensure_addon('io_scene_fbx')
        if not hasattr(bpy.ops.export_scene, 'fbx'):
            raise RuntimeError('当前 Blender 没有 FBX 导出器（io_scene_fbx 未启用）')
        kwargs.setdefault('use_selection', use_sel)
        kwargs.setdefault('use_mesh_modifiers', apply_mod)
        kwargs.setdefault('apply_unit_scale', True)
        kwargs.setdefault('global_scale', float(options.get('scale') or 1.0))
        bpy.ops.export_scene.fbx(**kwargs)

    elif fmt == 'stl':
        if hasattr(bpy.ops.wm, 'stl_export'):
            kwargs.setdefault('use_selection', use_sel)
            kwargs.setdefault('apply_modifiers', apply_mod)
            kwargs.setdefault('global_scale', float(options.get('scale') or 1.0))
            bpy.ops.wm.stl_export(**kwargs)
        elif hasattr(bpy.ops.export_mesh, 'stl'):
            kwargs.setdefault('use_selection', use_sel)
            kwargs.setdefault('apply_modifiers', apply_mod)
            bpy.ops.export_mesh.stl(**kwargs)
        else:
            raise RuntimeError('当前 Blender 没有 STL 导出器')

    else:
        raise ValueError('不支持的导出格式: %r（支持 glb / obj / fbx / stl）' % fmt)

    found = []
    for c in (out, out + '.obj', out + '.mtl', out + '.glb', out + '.gltf',
              out + '.bin', out + '.fbx', out + '.stl'):
        if os.path.isfile(c) and c not in found:
            found.append(c)
    if not found:
        raise RuntimeError('导出算子执行完成，但没有生成文件（期望 %s）。'
                           '请检查路径与对象选择。' % out)
    return {
        'format': fmt,
        'files': [{'path': p, 'bytes': os.path.getsize(p)} for p in found],
        'objects': len([o for o in bpy.context.scene.objects if o.visible_get()]),
        'selection': selection,
        'applyModifiers': apply_mod
    }


# ---------------------------------------------------------------- 主流程

def write_result(path, payload):
    tmp = path + '.tmp'
    with io.open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, default=_jsonable)
    os.replace(tmp, path)


def main():
    global RESULT_PATH, JOB
    args = _script_args()
    if not args:
        sys.stderr.write('dsh-blender driver: 缺少 job.json 参数\n')
        sys.exit(78)
    job_path = args[0]
    try:
        with io.open(job_path, 'r', encoding='utf-8') as fh:
            JOB = json.load(fh)
    except Exception as exc:
        sys.stderr.write('dsh-blender driver: 读取 job.json 失败: %s\n' % exc)
        sys.exit(79)

    RESULT_PATH = JOB['resultPath']
    max_text = int(JOB.get('maxText') or 20000)
    mode = JOB.get('mode') or 'python'
    options = JOB.get('options') or {}

    payload = None
    try:
        if mode == 'check':
            compile(JOB.get('code') or '', '<dsh-blender>', 'exec')
            payload = {'ok': True, 'result': {'syntax': 'ok'}}
        elif mode == 'python':
            payload = run_user_code(JOB, options, max_text)
        elif mode == 'scene_info':
            payload = {'ok': True, 'result': scene_info(options)}
        elif mode == 'render':
            payload = {'ok': True, 'result': do_render(options)}
        elif mode == 'export':
            payload = {'ok': True, 'result': do_export(options)}
        else:
            raise ValueError('未知 mode: %s' % mode)
    except BaseException as exc:
        payload = {'ok': False, 'error': describe_exception(exc)}

    payload.setdefault('stdout', _truncate(OUT.getvalue(), max_text))
    payload.setdefault('stderr', _truncate(ERR.getvalue(), max_text))
    payload['blenderVersion'] = getattr(bpy.app, 'version_string', 'unknown')
    payload['mode'] = mode
    payload['durationMs'] = int((time.time() - START) * 1000)

    # 落盘：失败默认不保存，避免把半成品写进会话
    blend_path = JOB.get('blendPath')
    want_save = bool(options.get('save', True)) and (
        payload.get('ok') or bool(options.get('saveOnError')))
    saved = False
    if blend_path and want_save and mode in ('python', 'scene_info', 'render', 'export'):
        try:
            bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=True)
            saved = True
        except Exception as exc:
            payload.setdefault('warnings', []).append('保存 .blend 失败: %s' % exc)
    payload['saved'] = saved
    payload['scene'] = scene_summary()
    payload['files'] = collect_files(JOB, options)

    try:
        write_result(RESULT_PATH, payload)
    except Exception as exc:
        sys.stderr.write('dsh-blender driver: 写 result.json 失败: %s\n' % exc)
        sys.exit(80)
    sys.exit(0)


main()
`;

/** 把 driver.py 写到工作区（内容变了才写） */
async function ensureDriver(state) {
  ensureDirSync(state.tmpDir);
  const content = PY_DRIVER;
  let need = true;
  try {
    const cur = await fsp.readFile(state.driverPath, 'utf8');
    if (cur === content) need = false;
  } catch (e) { /* 不存在 */ }
  if (need) await fsp.writeFile(state.driverPath, content, 'utf8');
  return state.driverPath;
}

/* ==========================================================================
 * 6. 危险代码静态扫描（启发式，不是安全边界）
 * ========================================================================== */

const RISKY_PATTERNS = [
  { id: 'os.system', re: /\bos\s*\.\s*system\s*\(/g, level: 'high', why: '执行 shell 命令' },
  { id: 'os.popen', re: /\bos\s*\.\s*popen\s*\(/g, level: 'high', why: '执行 shell 命令' },
  { id: 'subprocess', re: /\bsubprocess\b/g, level: 'high', why: '创建子进程' },
  { id: 'shutil.rmtree', re: /\bshutil\s*\.\s*rmtree\s*\(/g, level: 'high', why: '递归删除目录' },
  { id: 'os.remove', re: /\bos\s*\.\s*(remove|unlink|rmdir)\s*\(/g, level: 'high', why: '删除文件/目录' },
  { id: 'socket', re: /\bsocket\s*\.\s*socket\s*\(/g, level: 'high', why: '网络连接' },
  { id: 'urllib', re: /\b(urllib|requests|httpx|aiohttp)\b/g, level: 'high', why: '网络请求' },
  { id: 'ctypes', re: /\bctypes\b/g, level: 'high', why: '调用本地库' },
  { id: 'winreg', re: /\bwinreg\b/g, level: 'high', why: '修改注册表' },
  { id: 'open-write', re: /\bopen\s*\([^)]*['"][wax]\+?['"]/g, level: 'medium', why: '写入文件' },
  { id: 'eval-exec', re: /\b(eval|exec|compile|__import__)\s*\(/g, level: 'medium', why: '动态执行代码' },
  { id: 'importlib', re: /\bimportlib\b/g, level: 'medium', why: '动态导入' },
  { id: 'env', re: /\bos\s*\.\s*environ\b/g, level: 'medium', why: '读取环境变量（可能含密钥）' },
  { id: 'bpy-open-mainfile', re: /open_mainfile|open_library|libraries\s*\.\s*load/g, level: 'medium', why: '加载外部 .blend（可触发脚本执行）' },
  { id: 'sys.exit', re: /\bsys\s*\.\s*exit\s*\(/g, level: 'medium', why: '中断进程' },
  { id: 'loop-forever', re: /\bwhile\s+True\s*:/g, level: 'medium', why: '可能死循环（会被超时杀掉）' },
  { id: 'pip-install', re: /\b(pip|ensurepip)\b/g, level: 'high', why: '安装依赖' }
];

function scanCode(code) {
  const src = String(code || '');
  const findings = [];
  for (const p of RISKY_PATTERNS) {
    const m = src.match(p.re);
    if (m && m.length) {
      findings.push({ id: p.id, level: p.level, count: m.length, why: p.why });
    }
  }
  return findings;
}

/* ==========================================================================
 * 7. 输出路径与文件信息
 * ========================================================================== */

function resolveOutputPath(config, sp, rawPath, kind) {
  const base = kind === 'render' ? sp.renders : sp.exports;
  let p;
  if (rawPath) {
    p = String(rawPath);
    p = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    p = path.join(base, `${kind}-${stamp}`);
  }
  if (!config.allowOutsideWorkspace && !isInside(config.workspace, p)) {
    throw pluginError(
      'path_outside_workspace',
      `输出路径必须位于工作区内。工作区=${config.workspace}，收到=${p}`,
      '改用相对路径（相对会话的 renders/ 或 exports/ 目录），或把配置 allowOutsideWorkspace 设为 true。'
    );
  }
  return p;
}

function stripExt(p) {
  return p.replace(/\.(png|jpg|jpeg|glb|gltf|obj|mtl|fbx|stl|blend)$/i, '');
}

function kindOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (['.png', '.jpg', '.jpeg'].includes(ext)) return 'image';
  if (ext === '.blend') return 'blend';
  if (['.glb', '.gltf', '.obj', '.mtl', '.fbx', '.stl', '.bin'].includes(ext)) return 'model';
  return 'other';
}

/** 只读文件头解析 PNG 尺寸（给模型一个"图多大"的快速判断） */
async function imageMeta(file) {
  if (path.extname(file).toLowerCase() !== '.png') return null;
  try {
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(26);
    await fh.read(buf, 0, 26, 0);
    await fh.close();
    const magic = buf.slice(0, 8).toString('hex');
    if (magic !== '89504e470d0a1a0a') return null;
    return { imageFormat: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch (e) {
    return null;
  }
}

async function enrichFiles(config, files) {
  const out = [];
  for (const f of files || []) {
    const rec = {
      path: f.path,
      relPath: isInside(config.workspace, f.path) ? toPosix(path.relative(config.workspace, f.path)) : null,
      kind: kindOf(f.path),
      bytes: f.bytes
    };
    try {
      if (f.bytes != null && f.bytes <= 64 * 1024 * 1024) rec.sha256 = await sha256File(f.path);
    } catch (e) { /* ignore */ }
    const meta = await imageMeta(f.path);
    if (meta) Object.assign(rec, meta);
    out.push(rec);
  }
  return out;
}

/* ==========================================================================
 * 8. 核心任务执行
 * ========================================================================== */

function classifyFailure(proc) {
  if (proc.spawnError) {
    return {
      kind: 'blender_spawn_failed',
      message: `无法启动 Blender 进程: ${proc.spawnError.message}`,
      hint: '检查 config.blenderPath 是否为 blender.exe 的完整路径；确认文件有执行权限；路径不要含未转义的特殊字符。'
    };
  }
  if (proc.timedOut) {
    return {
      kind: 'timeout',
      message: `Blender 执行超时（${proc.durationMs} ms），进程已被强制结束。`,
      hint: '把任务拆小；或提高 timeoutMs / pythonTimeoutMs / renderTimeoutMs；渲染降分辨率与采样数。注意：超时后本次改动不会写入 .blend。'
    };
  }
  if (proc.code === 77) {
    return {
      kind: 'python_exception',
      message: 'Blender 报告 Python 脚本异常（exit code 77），但没有写出 result.json。',
      hint: '看 stderr 的 traceback。通常是 driver.py 写坏了，或工作区不可写。'
    };
  }
  return {
    kind: 'blender_exit',
    message: `Blender 异常退出（exit code ${proc.code == null ? 'null' : proc.code}${proc.signal ? ', signal ' + proc.signal : ''}），没有产出 result.json。`,
    hint: '看 stderr 尾部。常见原因：.blend 文件损坏、显存/内存不足、驱动崩溃、工作区不可写。'
  };
}

/**
 * 执行一次 Blender 任务。
 * params: { toolName, sessionId, mode, code, options, timeoutMs, extraWarnings }
 */
async function runJob(state, params) {
  const config = state.config;
  const { sp, meta } = await ensureSession(state, params.sessionId);
  const blender = await resolveBlender(config, state);
  if (!blender) {
    throw pluginError(
      'blender_not_found',
      '找不到 Blender 可执行文件。',
      '在 cordis.patch.yml 的 config.blenderPath 写明完整路径，例如 "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe"。'
    );
  }
  await ensureDriver(state);

  return enqueue(state, sp.id, async () => {
    const lock = await acquireFileLock(sp.lock, {
      timeoutMs: config.lockTimeoutMs,
      staleMs: config.lockStaleMs
    });
    let releaseSem = null;
    const jobDir = path.join(state.tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      releaseSem = await state.sem.acquire();
      await fsp.mkdir(jobDir, { recursive: true });
      const resultPath = path.join(jobDir, 'result.json');
      const jobPath = path.join(jobDir, 'job.json');

      const job = {
        mode: params.mode,
        code: params.code || '',
        // 受限模式参数必须放进 options：driver 只读 JOB['options']，
        // 之前放在 job 顶层导致 restrictedMode/allowedPathPrefix/blockedModules 全部不生效。
        options: Object.assign({}, params.options || {}, {
          restricted: !!config.restrictedMode,
          allowedPathPrefix: config.workspace,
          blockedModules: config.blockedModules
        }),
        blendPath: sp.blend,
        resultPath,
        sessionId: sp.id,
        workspace: config.workspace,
        sessionDir: sp.dir,
        maxText: config.maxOutputBytes
      };
      await writeJson(jobPath, job);

      const args = [];
      if (config.factoryStartup) args.push('--factory-startup');
      if (config.noAudio) args.push('-noaudio');
      args.push('--background');
      if (fs.existsSync(sp.blend)) args.push(sp.blend);
      args.push('--python-exit-code', '77');
      args.push('--python', state.driverPath);
      args.push('--', jobPath);

      const proc = await spawnCapture(blender.path, args, {
        timeoutMs: params.timeoutMs || config.timeoutMs,
        maxBytes: config.maxOutputBytes,
        env: baseEnv(config),
        cwd: sp.dir
      });

      const raw = await readJsonSafe(resultPath);
      const warnings = (params.extraWarnings || []).slice();

      if (!raw) {
        const f = classifyFailure(proc);
        return {
          ok: false,
          tool: params.toolName,
          session: sp.id,
          mode: params.mode,
          durationMs: proc.durationMs,
          blender: { path: blender.path, version: null },
          error: Object.assign(f, {
            blenderExitCode: proc.code,
            timedOut: !!proc.timedOut,
            stderrTail: truncate(proc.stderr, 4000)
          }),
          stdout: truncate(proc.stdout, 8000),
          stderr: truncate(proc.stderr, 8000),
          warnings
        };
      }

      meta.calls = (meta.calls || 0) + 1;
      meta.lastUsed = new Date().toISOString();
      try { await writeJson(sp.meta, meta); } catch (e) { /* ignore */ }

      const out = {
        ok: raw.ok !== false,
        tool: params.toolName,
        session: sp.id,
        mode: params.mode,
        durationMs: proc.durationMs,
        blender: { path: blender.path, version: raw.blenderVersion || null },
        result: raw.result === undefined ? null : raw.result,
        scene: raw.scene || null,
        saved: !!raw.saved,
        files: await enrichFiles(config, raw.files),
        stdout: truncate(raw.stdout, config.maxOutputBytes),
        stderr: truncate(raw.stderr, config.maxOutputBytes)
      };
      if (raw.globals) out.globals = raw.globals;
      if (Array.isArray(raw.warnings)) warnings.push(...raw.warnings);
      if (warnings.length) out.warnings = warnings;

      if (!out.ok) {
        out.error = Object.assign(
          { kind: 'python_exception' },
          raw.error || { message: '未知错误' }
        );
      }

      // 可选：把渲染结果内联成 base64（模型有视觉能力时用）
      if (params.options && params.options.inline && out.ok) {
        const img = (out.files || []).find((f) => f.kind === 'image');
        if (img && img.bytes <= config.maxInlineImageBytes) {
          try {
            const buf = await fsp.readFile(img.path);
            out.image = {
              mime: path.extname(img.path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
              bytes: buf.length,
              width: img.width || null,
              height: img.height || null,
              base64: buf.toString('base64')
            };
          } catch (e) { /* ignore */ }
        } else if (img) {
          warnings.push(`图片 ${img.bytes} 字节，超过 maxInlineImageBytes，未内联。`);
        }
      }
      return out;
    } finally {
      if (releaseSem) releaseSem();
      lock.release();
      if (!config.keepScripts) {
        fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
}

/* ==========================================================================
 * 9. 输出格式化
 * ========================================================================== */

function formatOutput(config, obj) {
  if (config.resultFormat === 'object') return obj;
  return JSON.stringify(obj, null, config.jsonIndent);
}

function makeExecutor(config, toolName, fn) {
  return async (args = {}, toolCtx = {}) => {
    const started = Date.now();
    try {
      const out = await fn(args || {}, toolCtx || {});
      if (out && out.durationMs === undefined) out.durationMs = Date.now() - started;
      return formatOutput(config, out);
    } catch (err) {
      const payload = {
        ok: false,
        tool: toolName,
        durationMs: Date.now() - started,
        error: {
          kind: err.kind || 'internal_error',
          message: err.message || String(err),
          hint: err.hint || null
        }
      };
      if (config.debug) payload.error.stack = String(err.stack || '');
      return formatOutput(config, payload);
    }
  };
}

/* ==========================================================================
 * 10. 工具定义
 * ========================================================================== */

const SESSION_DESC = '会话 id（不同会话是相互独立的 .blend 场景文件）。默认 "main"。';

function buildTools(state) {
  const config = state.config;
  const tools = [];

  /* ------------------------------ 1. 状态检查 ------------------------------ */
  tools.push({
    name: 'blender_status',
    description:
      '检查本机 Blender 是否可用：可执行文件路径、版本号、工作区、会话列表。' +
      '首次使用或报错时先调这个。',
    parameters: {
      type: 'object',
      properties: {
        deep: { type: 'boolean', description: '是否真正启动 Blender 取版本号（约 1-3 秒，默认 true）' },
        listSessions: { type: 'boolean', description: '是否列出已有会话（默认 true）' }
      }
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        blender: { type: 'object', description: '{ path, version, source, candidates }' },
        workspace: { type: 'string' },
        sessions: { type: 'array' },
        error: { type: 'object', description: '{ kind, message, hint }' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: config.versionTimeoutMs + 20000,
    execute: makeExecutor(config, 'blender_status', async (args) => {
      const blender = await resolveBlender(config, state);
      const result = {
        ok: !!blender,
        plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
        platform: { os: process.platform, arch: process.arch, node: process.version },
        workspace: config.workspace,
        workspaceWritable: false,
        config: {
          factoryStartup: config.factoryStartup,
          restrictedMode: config.restrictedMode,
          guard: config.guard,
          maxConcurrent: config.maxConcurrent,
          allowOutsideWorkspace: config.allowOutsideWorkspace
        }
      };
      try {
        ensureDirSync(config.workspace);
        ensureDirSync(state.tmpDir);
        const probe = path.join(state.tmpDir, '.probe');
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
        result.workspaceWritable = true;
      } catch (e) {
        result.workspaceError = String(e.message || e);
      }

      if (!blender) {
        result.error = {
          kind: 'blender_not_found',
          message: '找不到 Blender 可执行文件。',
          hint: '设置 config.blenderPath（例如 "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe"），或把 Blender 加入 PATH。'
        };
        return result;
      }

      result.blender = {
        path: blender.path,
        source: blender.source,
        version: null,
        candidates: (blender.candidates || []).map((c) => c.path)
      };

      if (args.deep !== false) {
        const proc = await spawnCapture(blender.path, ['--version'], {
          timeoutMs: config.versionTimeoutMs,
          maxBytes: 65536,
          env: baseEnv(config)
        });
        const text = `${proc.stdout}\n${proc.stderr}`;
        const m = text.match(/Blender\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
        if (m) result.blender.version = m[1];
        result.blender.probe = {
          exitCode: proc.code,
          timedOut: proc.timedOut,
          durationMs: proc.durationMs,
          spawnError: proc.spawnError ? String(proc.spawnError.message) : null,
          output: truncate(text.trim(), 1200)
        };
        if (!m) {
          result.ok = false;
          result.error = {
            kind: 'blender_probe_failed',
            message: 'Blender 启动了但没有输出版本号。',
            hint: '可能路径指向的不是 Blender，或安装损坏。看 probe.output。'
          };
        }
      }

      if (args.listSessions !== false) {
        const sessions = [];
        try {
          for (const name of await fsp.readdir(state.sessionsDir)) {
            const meta = await readJsonSafe(path.join(state.sessionsDir, name, 'session.json'));
            if (meta) sessions.push(meta);
          }
        } catch (e) { /* 目录不存在 */ }
        result.sessions = sessions;
        result.defaultSession = config.defaultSession;
      }
      return result;
    })
  });

  /* ------------------------------ 2. 执行 Python ------------------------------ */
  tools.push({
    name: 'blender_run_python',
    description:
      '在 Blender 里执行一段 Python（bpy/bmesh）代码，这是核心能力：建模、改材质、加修改器、批量操作都靠它。\n' +
      '已预置的全局名：bpy, bmesh, math, random, json, re, Vector, Matrix, Euler, Quaternion, Color, C(=bpy.context), D(=bpy.data), scene。\n' +
      '便捷函数：obj(name) / select(name) / deselect_all() / add_cube(name,size,location) / add_plane() / ' +
      'add_camera(name,location,target,lens) / add_light(name,type,location,target,energy,size) / ' +
      'set_material(obj,name,color,metallic,roughness,emission,emission_strength) / studio() / look_at(ob,target)。\n' +
      '把要回传的结构化结果赋给变量 RESULT（会被 JSON 化后放进返回值 result）。\n' +
      '注意：优先用 bpy 数据 API 而不是 bpy.ops.*（后台模式下部分算子会因上下文失败）；' +
      'Blender 内置 Python 没有第三方包（numpy 除外）。\n' +
      '示例：\n' +
      '  cube = add_cube("Box", 2.0, (0, 0, 1))\n' +
      '  set_material(cube, "Red", color=(0.8, 0.1, 0.1, 1.0), roughness=0.3)\n' +
      '  RESULT = {"verts": len(cube.data.vertices)}',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Python 代码（bpy/bmesh）' },
        session: { type: 'string', description: SESSION_DESC },
        save: { type: 'boolean', description: '成功后是否保存 .blend（默认 true；失败默认不保存，保证会话不被半成品污染）' },
        resultExpression: { type: 'string', description: '代码执行成功后再求值的 Python 表达式，结果放进 result' },
        checkOnly: { type: 'boolean', description: '只做语法检查，不执行（默认 false）' },
        timeoutMs: { type: 'number', description: '本次调用的超时毫秒数（覆盖默认值）' }
      },
      required: ['code']
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        session: { type: 'string' },
        result: { description: '用户代码写入 RESULT 的值（JSON 化后）' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        scene: { type: 'object' },
        saved: { type: 'boolean' },
        files: { type: 'array' },
        error: { type: 'object', description: '{ kind, pythonType, message, traceback, hint }' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: config.pythonTimeoutMs + 15000,
    execute: makeExecutor(config, 'blender_run_python', async (args) => {
      const code = String(args.code || '');
      if (!code.trim()) {
        throw pluginError('invalid_request', 'code 不能为空。', '传入要执行的 Python 代码。');
      }
      if (Buffer.byteLength(code, 'utf8') > config.maxCodeBytes) {
        throw pluginError('code_too_large', `代码超过 ${config.maxCodeBytes} 字节上限。`,
          '把任务拆成多次调用，或把长代码放进 .py 文件再用 exec(open(...).read())。');
      }
      const findings = scanCode(code);
      const warnings = [];
      if (findings.length) {
        warnings.push(
          '代码静态扫描发现敏感调用：' +
          findings.map((f) => `${f.id}(${f.level})×${f.count}`).join(', ') +
          '（这是启发式检查，不是安全边界）'
        );
        if (config.guard === 'block' && findings.some((f) => f.level === 'high')) {
          throw pluginError(
            'code_blocked',
            '代码包含高风险调用，已被 guard=block 拦截：' +
            findings.filter((f) => f.level === 'high').map((f) => f.id).join(', '),
            '确认无误后把 config.guard 改成 "warn"，或用 restrictedMode 之外的专用工具完成该操作。'
          );
        }
      }
      return runJob(state, {
        toolName: 'blender_run_python',
        sessionId: args.session,
        mode: args.checkOnly ? 'check' : 'python',
        code,
        options: {
          save: args.save !== false,
          resultExpression: args.resultExpression || null
        },
        timeoutMs: Number(args.timeoutMs) || config.pythonTimeoutMs,
        extraWarnings: warnings
      });
    })
  });

  /* ------------------------------ 3. 场景查询 ------------------------------ */
  tools.push({
    name: 'blender_scene_info',
    description:
      '读取当前会话场景的结构化信息：对象列表（名称/类型/位置/尺寸/材质/修改器/网格统计）、' +
      '相机、灯光、渲染设置、材质与集合。用于"先看清现状再动手"。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: SESSION_DESC },
        detail: { type: 'string', enum: ['summary', 'objects', 'full'], description: 'summary=仅名称类型；objects=对象详情（默认）；full=再加材质/集合/图片/文本' },
        includeMeshStats: { type: 'boolean', description: '是否统计顶点/面数（默认 true）' },
        maxObjects: { type: 'number', description: '最多返回多少个对象（默认 200）' },
        save: { type: 'boolean', description: '查询后是否保存（默认 false）' }
      }
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        result: { type: 'object', description: '{ scene, counts, objects[], materials?, collections? }' },
        error: { type: 'object' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: config.timeoutMs + 15000,
    execute: makeExecutor(config, 'blender_scene_info', async (args) =>
      runJob(state, {
        toolName: 'blender_scene_info',
        sessionId: args.session,
        mode: 'scene_info',
        options: {
          detail: args.detail || 'objects',
          includeMeshStats: args.includeMeshStats !== false,
          maxObjects: Number(args.maxObjects) || 200,
          save: args.save === true
        }
      })
    )
  });

  /* ------------------------------ 4. 渲染 ------------------------------ */
  tools.push({
    name: 'blender_render',
    description:
      '把当前场景渲染成 PNG/JPEG（后台模式）。返回文件路径、尺寸、字节数、sha256，' +
      '之后你可以用文件读取/视觉工具看图做质检。\n' +
      '若场景没有相机，先用 blender_run_python 调 add_camera() 或 studio()。' +
      '后台渲染建议用 CYCLES（CPU 可靠）或 BLENDER_WORKBENCH（最快）；' +
      'EEVEE 在无 GPU 的后台环境可能失败。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: SESSION_DESC },
        file: { type: 'string', description: '输出路径。相对路径相对会话的 renders/ 目录；默认自动命名' },
        camera: { type: 'string', description: '用哪个相机对象渲染（默认用 scene.camera）' },
        frame: { type: 'number', description: '渲染第几帧' },
        engine: { type: 'string', description: 'CYCLES / BLENDER_EEVEE_NEXT / BLENDER_EEVEE / BLENDER_WORKBENCH' },
        samples: { type: 'number', description: '采样数（Cycles samples / EEVEE taa_render_samples）' },
        resolutionX: { type: 'number' },
        resolutionY: { type: 'number' },
        resolutionPercentage: { type: 'number' },
        filmTransparent: { type: 'boolean', description: '透明背景' },
        format: { type: 'string', enum: ['PNG', 'JPEG'], description: '默认 PNG' },
        colorMode: { type: 'string', description: 'RGB / RGBA / BW' },
        save: { type: 'boolean', description: '渲染后是否把相机/分辨率等改动保存进会话（默认 true）' },
        inline: { type: 'boolean', description: '是否把图片内联成 base64 一起返回（很吃上下文，默认 false）' },
        timeoutMs: { type: 'number' }
      }
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        result: { type: 'object', description: '{ file, bytes, resolution, engine, camera, renderMs }' },
        files: { type: 'array', description: '含 path/relPath/bytes/width/height/sha256' },
        image: { type: 'object', description: 'inline=true 时出现：{ mime, base64, width, height }' },
        error: { type: 'object' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: config.renderTimeoutMs + 20000,
    execute: makeExecutor(config, 'blender_render', async (args) => {
      const { sp } = await ensureSession(state, args.session);
      let outPath = resolveOutputPath(config, sp, args.file, 'render');
      outPath = stripExt(outPath); // driver 里按格式补扩展名
      return runJob(state, {
        toolName: 'blender_render',
        sessionId: args.session,
        mode: 'render',
        options: {
          outPath,
          camera: args.camera || null,
          frame: args.frame === undefined ? null : args.frame,
          engine: args.engine || null,
          samples: args.samples || null,
          resolutionX: args.resolutionX || null,
          resolutionY: args.resolutionY || null,
          resolutionPercentage: args.resolutionPercentage || null,
          filmTransparent: args.filmTransparent === true,
          format: args.format || 'PNG',
          colorMode: args.colorMode || null,
          save: args.save !== false,
          inline: args.inline === true
        },
        timeoutMs: Number(args.timeoutMs) || config.renderTimeoutMs
      });
    })
  });

  /* ------------------------------ 5. 导出 ------------------------------ */
  tools.push({
    name: 'blender_export',
    description:
      '导出当前场景为模型文件：GLB / OBJ / FBX / STL。' +
      '自动适配 Blender 版本（4.x 用 wm.obj_export / wm.stl_export，旧版回退到 export_scene.obj / export_mesh.stl）。\n' +
      'OBJ 会同时产生 .obj 与 .mtl。可用 formatOptions 传 Blender 导出算子的额外参数（键名与 bpy 一致，' +
      '例如 {"export_uv": false, "forward_axis": "NEGATIVE_Z"}）。',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['glb', 'obj', 'fbx', 'stl'], description: '导出格式' },
        session: { type: 'string', description: SESSION_DESC },
        file: { type: 'string', description: '输出路径。相对路径相对会话的 exports/ 目录；默认自动命名' },
        selection: { type: 'string', enum: ['all', 'selected', 'objects'], description: 'all=整个场景（默认）；selected=当前选中；objects=按 objects 数组选中后导出' },
        objects: { type: 'array', items: { type: 'string' }, description: 'selection=objects 时要导出的对象名列表' },
        applyModifiers: { type: 'boolean', description: '是否应用修改器（默认 true）' },
        scale: { type: 'number', description: '全局缩放（FBX/STL）' },
        formatOptions: { type: 'object', description: '直接传给 Blender 导出算子的额外参数' },
        save: { type: 'boolean', description: '导出后是否保存 .blend（默认 false）' },
        timeoutMs: { type: 'number' }
      },
      required: ['format']
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        result: { type: 'object', description: '{ format, files[], objects, selection }' },
        files: { type: 'array' },
        error: { type: 'object' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: config.exportTimeoutMs + 20000,
    execute: makeExecutor(config, 'blender_export', async (args) => {
      const fmt = String(args.format || '').toLowerCase();
      if (!['glb', 'obj', 'fbx', 'stl'].includes(fmt)) {
        throw pluginError('invalid_request', `不支持的格式: ${args.format}`,
          'format 必须是 glb / obj / fbx / stl 之一。');
      }
      const { sp } = await ensureSession(state, args.session);
      const ext = { glb: '.glb', obj: '.obj', fbx: '.fbx', stl: '.stl' }[fmt];
      let outPath = resolveOutputPath(config, sp, args.file, 'export');
      if (!outPath.toLowerCase().endsWith(ext)) outPath += ext;
      return runJob(state, {
        toolName: 'blender_export',
        sessionId: args.session,
        mode: 'export',
        options: {
          format: fmt,
          outPath,
          selection: args.selection || 'all',
          objects: args.objects || [],
          applyModifiers: args.applyModifiers !== false,
          scale: args.scale || 1.0,
          formatOptions: args.formatOptions || {},
          save: args.save === true
        },
        timeoutMs: Number(args.timeoutMs) || config.exportTimeoutMs
      });
    })
  });

  /* ------------------------------ 6. 会话管理 ------------------------------ */
  tools.push({
    name: 'blender_session',
    description:
      '会话管理。会话 = 一个独立的 .blend 文件 + renders/ + exports/ 目录，' +
      '用于隔离不同任务，并提供快照/回滚。\n' +
      'action: list / create / info / reset（清空场景，需 confirm=true）/ snapshot（存档）/ restore（回滚）/ delete（删除会话，需 confirm=true）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'reset', 'snapshot', 'restore', 'delete'] },
        session: { type: 'string', description: SESSION_DESC },
        snapshot: { type: 'string', description: 'restore 时要恢复的快照文件名（见 info 返回的 snapshots）' },
        keep: { type: 'number', description: 'snapshot 时最多保留多少个快照（默认 10）' },
        confirm: { type: 'boolean', description: 'reset / delete 为破坏性操作，必须显式传 true 才会执行' }
      },
      required: ['action']
    },
output: {
      schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        result: { type: 'object' },
        error: { type: 'object' }
      }
    
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs: 30000,
    execute: makeExecutor(config, 'blender_session', async (args) => {
      const action = String(args.action || '').toLowerCase();
      const { sp, meta } = await ensureSession(state, args.session);
      const rel = (p) => toPosix(path.relative(config.workspace, p));

      if (action === 'list') {
        const sessions = [];
        try {
          for (const name of await fsp.readdir(state.sessionsDir)) {
            const m = await readJsonSafe(path.join(state.sessionsDir, name, 'session.json'));
            if (m) sessions.push(m);
          }
        } catch (e) { /* ignore */ }
        return { ok: true, result: { workspace: config.workspace, defaultSession: config.defaultSession, sessions } };
      }

      if (action === 'create') {
        return { ok: true, result: { session: sp.id, dir: rel(sp.dir), blend: rel(sp.blend), created: true } };
      }

      if (action === 'info') {
        let snapshots = [];
        try { snapshots = (await fsp.readdir(sp.snapshots)).filter((f) => f.endsWith('.blend')); } catch (e) { /* ignore */ }
        let blendBytes = null;
        try { blendBytes = (await fsp.stat(sp.blend)).size; } catch (e) { /* ignore */ }
        return {
          ok: true,
          result: {
            session: sp.id,
            dir: rel(sp.dir),
            blend: rel(sp.blend),
            blendBytes,
            meta,
            snapshots: snapshots.sort()
          }
        };
      }

      if (action === 'reset') {
        // 破坏性操作：必须显式 confirm=true，防止模型误调清空场景
        if (args.confirm !== true) {
          throw pluginError('confirmation_required', 'reset 会清空当前场景（删除 .blend），必须传 confirm=true 才会执行。',
            '确认要清空时传 { action: "reset", confirm: true }。');
        }
        await fsp.rm(sp.blend, { force: true });
        return { ok: true, result: { session: sp.id, reset: true, note: '下一次调用会从空场景开始' } };
      }

      if (action === 'snapshot') {
        if (!fs.existsSync(sp.blend)) {
          throw pluginError('no_blend', '会话还没有 .blend，先执行一次会保存的操作。',
            '运行一次 blender_run_python（save=true）。');
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(sp.snapshots, `${stamp}.blend`);
        await fsp.copyFile(sp.blend, target);
        meta.snapshots = Array.isArray(meta.snapshots) ? meta.snapshots : [];
        meta.snapshots.push(path.basename(target));
        const keep = Math.max(1, Number(args.keep) || 10);
        while (meta.snapshots.length > keep) {
          const old = meta.snapshots.shift();
          await fsp.rm(path.join(sp.snapshots, old), { force: true });
        }
        await writeJson(sp.meta, meta);
        return { ok: true, result: { session: sp.id, snapshot: path.basename(target), kept: meta.snapshots.length } };
      }

      if (action === 'restore') {
        const snap = String(args.snapshot || '').trim();
        if (!/^[A-Za-z0-9._-]+\.blend$/.test(snap)) {
          throw pluginError('invalid_request', 'snapshot 参数必须是快照文件名。',
            '先用 action=info 查看可用快照。');
        }
        const src = path.join(sp.snapshots, snap);
        if (!fs.existsSync(src)) {
          throw pluginError('snapshot_not_found', `找不到快照: ${snap}`,
            '用 action=info 查看快照列表。');
        }
        await fsp.copyFile(src, sp.blend);
        return { ok: true, result: { session: sp.id, restored: snap } };
      }

      if (action === 'delete') {
        // 破坏性操作：必须显式 confirm=true，防止模型误调删除整个会话
        if (args.confirm !== true) {
          throw pluginError('confirmation_required', 'delete 会永久删除整个会话目录（.blend + renders + exports），必须传 confirm=true 才会执行。',
            '确认要删除时传 { action: "delete", confirm: true }。');
        }
        await fsp.rm(sp.dir, { recursive: true, force: true });
        return { ok: true, result: { session: sp.id, deleted: true } };
      }

      throw pluginError('invalid_request', `未知 action: ${args.action}`,
        '可用值: list / create / info / reset / snapshot / restore / delete');
    })
  });

  return tools;
}

/* ==========================================================================
 * 11. 插件入口
 * ========================================================================== */

module.exports = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  inject: ['tools'],
  apply(ctx, pluginConfig) {
    const ctx2 = ctx;
    const raw = pluginConfig || (ctx2 && ctx2.config) || {};
      const config = normalizeConfig(raw);
      const state = createState(config);

      ensureDirSync(config.workspace);
      ensureDirSync(state.sessionsDir);
      ensureDirSync(state.tmpDir);

      if (!ctx2 || !ctx2.tools || typeof ctx2.tools.register !== 'function') {
        throw new Error(
          `[${PLUGIN_NAME}] 找不到 ctx.tools.register —— 请确认本插件由 dsh 的 Cordis 运行时加载。`
        );
      }

      for (const tool of buildTools(state)) {
        ctx2.tools.register(tool);
      }

      if (typeof ctx2.logger === 'object' && ctx2.logger && typeof ctx2.logger.info === 'function') {
        ctx2.logger.info(`[${PLUGIN_NAME}] 已注册 ${buildTools(state).length} 个工具，工作区: ${config.workspace}`);
      }
    }
  };
