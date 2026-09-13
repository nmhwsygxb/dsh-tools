// auto-heal.js — DeepSeek Harness 启动自愈器（独立 Node 脚本，不是 Cordis 插件）
//
// 作用：包装 `dsh web` 的启动过程。启动前先做"内核检查"（dsh 入口 bin.js 本身能否
// 启动；内核起不来时禁用插件没有意义，直接中止）；内核没问题才进入自愈流程：
// 用随机端口做一次快速"冒烟测试"，如果插件树加载崩溃（例如某个插件 apply / import
// 失败、工具名冲突、配置不兼容），自动解析出出问题的插件 id，把它追加进禁用清单
// disabled-plugins.yml（格式与 dsh 的 --patch overlay 一致：
// `- id: <插件id>\n  disabled: true`），然后带上该清单重试冒烟 —— 出问题的插件被
// 跳过，其余插件照常加载，服务能正常起来。策略：内核没问题，则"哪里有问题就禁哪里"
// （工作区/会话/存储等基础项也可能被禁，先保证服务能起来，再人工修根因后 --heal-reset）。
//
// 用法：
//   node auto-heal.js                 # 冒烟 + 正式启动（dsh web，默认 3080）
//   node auto-heal.js --heal-smoke-only   # 只跑冒烟测试并打印结果（排障用）
//   node auto-heal.js --heal-reset        # 清空禁用清单，恢复所有插件
//   透传参数会原样交给 dsh web：node auto-heal.js --host 0.0.0.0 --port 8080
//
// 恢复被禁插件：修好问题后删除 disabled-plugins.yml 里对应两行，或执行 --heal-reset。
//
// 环境变量（测试/定制用）：
//   DSH_BIN                       覆盖 dsh 入口 bin.js 的绝对路径
//   AUTO_HEAL_DISABLED_FILE       覆盖禁用清单路径（测试隔离用）
//   AUTO_HEAL_LOG                 覆盖自愈日志路径
//   AUTO_HEAL_EXTRA_PATCH         启动时额外附加的 overlay patch 列表（分号分隔），
//                                 按顺序排在禁用清单之前应用
//   AUTO_HEAL_KERNEL_TIMEOUT_MS   内核检查超时毫秒数（默认 30000）
//   AUTO_HEAL_SMOKE_TIMEOUT_MS    冒烟测试超时毫秒数（默认 60000）
//   AUTO_HEAL_EXTRA_PROTECT       逗号分隔的额外受保护插件 id（默认不保护任何 id）
//
// 2026-09 修复记录：
//   1) writeDisabled() 写出的 id 未加引号，包名以 @ 开头时是非法 YAML
//      （js-yaml: bad indentation of a mapping entry），下次启动必崩 → 改为 yamlQuote()。
//   2) parseEntryIds() 会把错误文本里的 `[cause]:` 误当成插件 id `[cause]`
//      → 增加 isPlausibleId() 形状校验。
//   3) 2026-09-13 策略调整（用户要求）：原 PROTECTED_IDS 保护名单撤销，改为内核硬核
//      HARD_CORE（仅 include 根入口这类"骨架"不可禁）。只要 dsh 内核（bin.js 能启动）
//      没问题，插件树里"哪里出问题就禁用哪里"——包括 workspace / session / storage
//      之类基础项，先保证服务能起来；修好根因后执行 --heal-reset 整体恢复。
//      若仍想保护某些 id，可设环境变量 AUTO_HEAL_EXTRA_PROTECT="id1,id2"。
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- 常量 ----------
const HERE = __dirname; // 本脚本所在目录 = profile 目录（profiles/<name>/）
const PROFILE_PATCH = path.join(HERE, 'cordis.patch.yml'); // 用户插件层（读 id/name 映射用）
const SMOKE_TIMEOUT_MS = Number(process.env.AUTO_HEAL_SMOKE_TIMEOUT_MS) || 60000; // 冒烟最长等待：默认 60 秒
const KERNEL_TIMEOUT_MS = Number(process.env.AUTO_HEAL_KERNEL_TIMEOUT_MS) || 30000; // 内核检查最长等待：默认 30 秒
const MAX_HEAL_ROUNDS = 6; // 自愈重试轮数上限（防死循环；一棵树里可能依次暴露多个坏条目）
const READY_MARKER = 'dsh web: http://'; // 就绪标记：服务已开始监听

const DISABLED_FILE = process.env.AUTO_HEAL_DISABLED_FILE
  ? path.resolve(process.env.AUTO_HEAL_DISABLED_FILE)
  : path.join(HERE, 'disabled-plugins.yml');
const HEAL_LOG = process.env.AUTO_HEAL_LOG
  ? path.resolve(process.env.AUTO_HEAL_LOG)
  : path.join(HERE, 'auto-heal.log');

// ---------- 禁用安全护栏 ----------
// 内核硬核名单：只有这些"骨架级" id 永远不允许自动禁用（它们是 loader 根入口，
// 禁掉它们整个插件树都不存在）。其余任何条目——包括 workspace / session / storage
// 等基础项——只要 dsh 内核能启动，启动时哪里报错就禁哪里（见上方修复记录 3）。
const HARD_CORE = new Set(['include']);

// 可选追加保护：通过环境变量 AUTO_HEAL_EXTRA_PROTECT="id1,id2" 额外保护某些 id。
function extraProtectedIds() {
  return String(process.env.AUTO_HEAL_EXTRA_PROTECT || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isHardCore(id) {
  if (!id) return true;
  if (HARD_CORE.has(id)) return true;
  return extraProtectedIds().includes(id);
}

// 合法插件 id 形状校验：包名（@scope/name）、相对脚本名（./x.js）、简单标识符。
// 拒绝 `[cause]` 这类从错误文本里误抓的片段，以及含空格 / 括号 / 冒号的内容。
function isPlausibleId(id) {
  if (!id || typeof id !== 'string' || id.length > 80) return false;
  if (id.startsWith('[') || id.includes(']')) return false;
  if (/[\s(){}[\],;:'"]/.test(id)) return false;
  return /^[A-Za-z0-9_@./-]+$/.test(id);
}

// YAML 安全引用：以 @ 开头的裸标量是非法 YAML，必须加引号。
function yamlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// ---------- 工具函数 ----------
function log(line) {
  const text = `[${new Date().toISOString()}] ${String(line)}`;
  try { fs.appendFileSync(HEAL_LOG, text + '\n'); } catch (e) { /* 日志失败不阻塞 */ }
  process.stdout.write(text + '\n');
}

function findBin() {
  const candidates = [
    process.env.DSH_BIN,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    // 兜底：从本脚本（profile 目录）上溯查找全局安装
    path.join(HERE, '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean);
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return null;
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// 读禁用清单：返回已禁用的插件 id 集合
function readDisabledIds() {
  try {
    const text = fs.readFileSync(DISABLED_FILE, 'utf8');
    const ids = new Set();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*-\s*id:\s*['"]?(.+?)['"]?\s*$/);
      if (m && isPlausibleId(m[1]) && !isHardCore(m[1])) ids.add(m[1]);
    }
    return ids;
  } catch (e) {
    return new Set();
  }
}

// 确保禁用清单文件存在（dsh 的 --patch 要求文件必须存在，缺失会直接报错）
function ensureDisabledFile() {
  if (!fs.existsSync(DISABLED_FILE)) writeDisabled(new Set());
}

// 写入禁用清单（保持 YAML patch 格式；空清单必须是显式数组 []，纯注释会被 YAML 解析成 null）
function writeDisabled(ids) {
  const head = '# auto-heal 自动生成的插件禁用清单（dsh --patch overlay 格式）\n'
    + '# 以下插件曾在启动时崩溃，已被自动禁用（disabled: true）。\n'
    + '# 要恢复某个插件：删除对应两行后重启；或执行  node auto-heal.js --heal-reset\n'
    + '# 注意：id 一律加引号，因为以 @ 开头的裸标量是非法 YAML。\n';
  const body = [...ids]
    .filter((id) => isPlausibleId(id) && !isHardCore(id))
    .sort()
    .map((id) => `- id: ${yamlQuote(id)}\n  disabled: true`)
    .join('\n');
  fs.writeFileSync(DISABLED_FILE, head + (body ? body : '[]') + '\n', 'utf8');
}

// 从 cordis.patch.yml 的 insert 块构建 name -> id 映射（did not activate 的行首是 name，需转成 id）
function buildNameToId(patchText) {
  const map = new Map();
  let currentId = null;
  for (const line of String(patchText).split('\n')) {
    const idM = line.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/);
    const nameM = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/);
    if (idM) currentId = idM[1];
    else if (nameM && currentId) map.set(nameM[1].trim(), currentId);
    // 遇到新的顶层条目则重置（idM 未匹配且行首是 "- "）
    else if (/^\s*-\s*[^-]/.test(line) && !/^\s*-\s*id:/.test(line)) currentId = null;
  }
  return map;
}

// 从失败输出中解析"出问题的插件 id"
// extraMap：额外 name -> id 映射（由 dump-config 提供，覆盖 bundle 插件，见 dumpEntryIdMap）
function parseEntryIds(stderrText, stdoutText, patchText, extraMap) {
  const text = String(stderrText || '') + '\n' + String(stdoutText || '');
  const preferred = [];

  // 1) failed to apply/import loader entry <id> (<name>) —— apply/import 失败路径，id 最可靠。
  //    注意 include 是根入口（嵌套子 entry 的失败也会先包一层 include），需要继续捕获内层真正失败的 entry。
  for (const m of text.matchAll(/failed to (?:apply|import|update) loader entry\s+([^\s(]+)/g)) {
    if (m[1] !== 'include') preferred.push(m[1]);
  }

  // 2) 堆栈行里的 #<entryId>（loader 的 getOuterStack 用 #entry.id），如 .../profiles/web/#workbench
  for (const m of text.matchAll(/[\\/]profiles[\\/][^#\s]*#([A-Za-z0-9_.-]+)/g)) {
    if (m[1] !== 'include') preferred.push(m[1]); // include 是根入口，不可禁
  }

  // 3) N entries did not activate 后的行首名称（可能是 ./x.js 或包名，转成 id）
  const act = text.match(/\d+\s+entr(?:y|ies)\s+did not activate([\s\S]*?)(?:\n\n|$)/);
  if (act) {
    const nameToId = buildNameToId(patchText);
    const extra = (extraMap && typeof extraMap.get === 'function') ? extraMap : new Map();
    for (const line of act[1].split('\n')) {
      const m = line.match(/^\s*(\S[^:]*):\s/);
      if (!m) continue;
      const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (!raw || raw.startsWith('(')) continue;
      if (raw === 'include') continue;
      const mapped = nameToId.get(raw) || extra.get(raw)
        || (raw.startsWith('./') ? raw.slice(2).replace(/\.(js|mjs|cjs)$/, '') : raw);
      preferred.push(mapped || raw);
    }
  }

  // 去重（保留出现顺序），过滤明显误抓与内核硬核条目（include 骨架）
  const seen = new Set();
  const ids = [];
  for (const id of preferred) {
    if (!isPlausibleId(id)) continue;
    if (id === 'include') continue;
    if (isHardCore(id)) continue;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

// 通过 `dsh web --dump-config` 构建完整 name -> id 映射（覆盖 bundle 插件）。
// dump-config 只解析组合树，不启动服务，很快；失败时返回空 Map。
function dumpEntryIdMap(bin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, 'web', '--dump-config'], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(new Map()));
    child.on('exit', () => {
      const map = new Map();
      let currentId = null;
      for (const line of out.split('\n')) {
        const idM = line.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/);
        const nameM = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/);
        if (idM) currentId = idM[1];
        else if (nameM && currentId) map.set(nameM[1].trim(), currentId);
      }
      resolve(map);
    });
  });
}

// 额外的 overlay patch 文件（分号分隔），应用顺序在禁用清单之前
function extraPatches() {
  return String(process.env.AUTO_HEAL_EXTRA_PATCH || '').split(';').map((p) => p.trim()).filter(Boolean);
}

// 内核检查：验证 dsh 入口本身能否启动（bin.js --version）。
// 内核起不来时禁用插件没有意义（问题不在插件树），直接中止并给出证据。
function kernelCheck(bin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--version'], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch (e) { /* 已退出 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', stdout: out, stderr: err });
    }, KERNEL_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => finish({ ok: false, reason: 'spawn-error', stdout: out, stderr: err, raw: String(e) }));
    child.on('exit', (code) => {
      finish({ ok: code === 0, reason: 'exit', code, stdout: out, stderr: err });
    });
  });
}

// 冒烟测试：spawn dsh web --port 0，看插件树能否正常加载。
// 返回 { ok, code, stdout, stderr, raw }
function smokeTest(bin) {
  return new Promise((resolve) => {
    const args = ['web', ...extraPatches().map((p) => ['--patch', p]).flat(), '--patch', DISABLED_FILE, '--port', '0'];
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch (e) { /* 已退出 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      // 超时未退出 → 已稳定 serve（至少插件树加载成功），视为通过
      finish({ ok: true, code: 0, stdout: out, stderr: err, reason: 'timeout' });
    }, SMOKE_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes(READY_MARKER)) finish({ ok: true, code: 0, stdout: out, stderr: err, reason: 'ready' });
    });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => finish({ ok: false, code: -1, stdout: out, stderr: err, reason: 'spawn-error', raw: String(e) }));
    child.on('exit', (code) => {
      // dsh web 正常会一直运行；提前退出说明启动失败（含插件树崩溃）
      finish({ ok: false, code, stdout: out, stderr: err, reason: 'exit' });
    });
  });
}

// 正式启动：spawn dsh web（继承 stdio，日志显示在本窗口），等待退出并透传退出码
function startForeground(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, 'web', ...extraPatches().map((p) => ['--patch', p]).flat(), '--patch', DISABLED_FILE, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (e) => { log('正式启动失败: ' + String(e)); resolve(1); });
    child.on('exit', (code) => resolve(code === null ? 0 : code));
  });
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--heal-reset')) {
    writeDisabled(new Set());
    log('禁用清单已清空，所有插件恢复。');
    return 0;
  }

  const bin = findBin();
  if (!bin) {
    log('找不到 dsh 入口 bin.js（可设置环境变量 DSH_BIN 指定）。');
    return 1;
  }
  log('dsh 入口: ' + bin);
  log('禁用清单: ' + DISABLED_FILE);
  ensureDisabledFile(); // --patch 要求文件存在，先创建空清单

  // ---- 内核检查：内核本身必须能启动；起不来则禁用插件无意义，中止 ----
  log('内核检查（bin.js --version）...');
  const kernel = await kernelCheck(bin);
  if (!kernel.ok) {
    const kerr = kernel.raw || kernel.stderr || kernel.stdout || '<无输出>';
    log(`内核检查失败（${kernel.reason || 'exit'}）——dsh 内核本身起不来，禁用插件无法自愈，中止启动。`);
    log('----- 内核错误输出（截断 2000 字符）-----');
    log(String(kerr).slice(0, 2000));
    log('----- 结束 -----');
    return 1;
  }
  const ver = (kernel.stdout || '').trim() || '(无版本输出)';
  log(`内核检查通过：${ver}。插件树里哪里出问题就禁哪里。`);

  const smokeOnly = argv.includes('--heal-smoke-only');
  const forwardedArgs = argv.filter((a) => !a.startsWith('--heal-'));

  const patchText = fs.existsSync(PROFILE_PATCH) ? fs.readFileSync(PROFILE_PATCH, 'utf8') : '';
  const disabled = readDisabledIds();
  let smokePassed = false;
  let lastErr = '';

  // ---- 自愈循环：冒烟 -> 失败解析 -> 追加禁用 -> 重试 ----
  for (let round = 1; round <= MAX_HEAL_ROUNDS; round++) {
    log(`冒烟测试 第 ${round} 轮（随机端口）...`);
    const smoke = await smokeTest(bin);
    if (smoke.ok) {
      log('冒烟测试通过：插件树加载成功。');
      smokePassed = true;
      break;
    }
    lastErr = smoke.raw || smoke.stderr || smoke.stdout || '';
    log(`冒烟测试失败（退出码=${String(smoke.code)}, ${smoke.reason || ''}）`);

    let parsed = parseEntryIds(smoke.stderr || '', smoke.stdout || '', patchText);
    if (parsed.length === 0 && /did not activate|failed to apply loader|failed to load/.test(lastErr)) {
      // bundle 插件的 name 不在 patch 里：用 dump-config 补全 name->id 再试一次
      log('基础解析没有命中，正在读取完整组合树（dump-config）补全插件映射...');
      const extraMap = await dumpEntryIdMap(bin);
      parsed = parseEntryIds(smoke.stderr || '', smoke.stdout || '', patchText, extraMap);
    }
    if (parsed.length === 0) {
      log('无法解析出具体是哪个插件出问题（或候选全部属于内核硬核），跳过自动禁用。错误输出如下：');
      log('----- 错误输出（截断 2000 字符）-----');
      log((lastErr || '').slice(0, 2000));
      log('----- 结束 -----');
      break;
    }

    const newlyAdded = parsed.filter((id) => !disabled.has(id) && isPlausibleId(id) && !isHardCore(id));
    if (newlyAdded.length === 0) {
      log(`解析出的插件（${parsed.join(', ')}）已在禁用清单中或属于内核硬核，停止重试。`);
      break;
    }
    for (const id of newlyAdded) disabled.add(id);
    writeDisabled(disabled);
    log(`已自动禁用插件: ${newlyAdded.join(', ')}（清单见 disabled-plugins.yml，下一轮冒烟验证）`);
    await sleep(500);
  }

  if (smokeOnly) {
    log(smokePassed
      ? '--heal-smoke-only：冒烟结果 = 通过，跳过正式启动。'
      : '--heal-smoke-only：冒烟结果 = 失败，跳过正式启动。');
    return smokePassed ? 0 : 1;
  }

  if (!smokePassed) {
    log('冒烟测试最终未通过，正式启动已取消（避免启动即崩溃）。请检查上方错误，或运行 --heal-reset 后重试。');
    return 1;
  }

  log('一切就绪，正式启动 dsh web ...');
  const code = await startForeground(bin, forwardedArgs);
  log('dsh web 已退出，退出码=' + code);
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stdout.write('auto-heal 异常: ' + String((e && e.stack) || e) + '\n');
    process.exit(1);
  });
