// Git Publish — 全局宿主插件（所有会话生效）
//
// 提供 2 个全局工具（基于【本地 git】，不是 GitHub）：
//   - git_repo_status：查看目标仓库状态（是否 git 仓库、分支、改动文件、现有最高版本号、
//     下一个推荐版本号）。适合在发布前先看一眼。
//   - git_publish：AI 写完代码后一步到位 —— git add -A → commit → 自动创建递增的版本号
//     tag（v1.0.0 → v1.0.1……，可选 major / minor / patch 或显式指定版本）→ 推送到本地
//     git 远程（本地裸仓库路径 / 局域网 git 服务器）。公网托管（github.com / gitlab.com
//     等）默认跳过推送。也可只做本地提交 + 打标签，不推送。
//
// 实现要点（与 remote-agent.js / sandbox-escape.js 同一机制）：
//   - 执行：ctx.subprocess.spawn 直接调用 git.exe（宿主权限，不经过沙箱执行器）。
//   - 版本：扫描仓库现有 vX.Y.Z 标签取最高值，按 bump 递增；无标签时从 initialVersion 起步。
//   - 身份：仓库缺 user.name / user.email 时自动写入【仓库级】本地配置（默认
//     "AI 助手 <ai@dsh.local>"），绝不改全局配置。
//   - 安全：不删除、不改写任何已有提交；目标版本 tag 已存在时必须显式 force 才会覆盖。
'use strict';

const path = require('path');
const fs = require('fs');

const PUBLIC_HOSTS = /github\.com|gitlab\.com|gitee\.com|bitbucket\.org|codeberg\.org|git\.coding\.net/i;
const GIT_EXE_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\bin\\git.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
];

const msg = (e) => (e && e.message) ? e.message : String(e);

function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatVersion(v) {
  return v.major + '.' + v.minor + '.' + v.patch;
}

function cmpVersion(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function bumpVersion(v, kind) {
  if (kind === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

// 判断远程地址类型：local-path / local（内网主机、git://、ssh:// 等）/ public / none
function classifyRemote(url) {
  if (!url) return 'none';
  const u = String(url);
  if (/^file:/i.test(u) || /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('.') || u.startsWith('\\\\') || u.startsWith('/')) return 'local-path';
  if (PUBLIC_HOSTS.test(u)) return 'public';
  return 'local';
}

// 脱敏：把 URL 中的 user:password 与 user@（Token 作用户名）都替换，防止凭证被输出进工具结果与会话
function maskCreds(text) {
  return String(text).replace(/(\/\/)([^@/\s]+)@/g, '$1***@');
}

// 常见敏感文件模式：提交前检测，命中则警告（不阻止，但让 AI/用户核对）
const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.env([.-].*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk|asc|gpg)$/i,
  /(^|[\\/])id_rsa([.]|$)/i,
  /(^|[\\/])id_ed25519([.]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])credentials[.]json$/i,
  /(^|[\\/])secrets?\.[^\\/]*$/i,
  /(^|[\\/])token[s]?[_-]?[^\\/]*\.(txt|json|yaml|yml)$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
];

function findSensitiveFiles(files) {
  return (files || []).filter((f) => SENSITIVE_PATTERNS.some((re) => re.test(String(f))));
}

module.exports = {
  name: 'git-publish',

  inject: ['tools'],

  apply(ctx, config) {
    const cfg = config || {};
    const WS_ROOT = cfg.workspaceRoot ? path.resolve(String(cfg.workspaceRoot)) : process.cwd();
    const INITIAL_VERSION = String(cfg.initialVersion || '1.0.0');
    const DEFAULT_BRANCH = String(cfg.defaultBranch || 'main');
    // 默认【不】自动 git init：工作区根往往是多项目混合目录（可能数 GB、无 .gitignore），
    // 盲目初始化会把无关文件/构建产物/大文件一次性提交。只有目录确实是目标项目仓库、
    // 或配置显式打开 autoInit 时才允许初始化。
    const AUTO_INIT = cfg.autoInit === true;
    const LOCAL_REMOTE = cfg.localRemote ? String(cfg.localRemote) : ''; // 本地远程（裸仓库路径/内网地址/远程名）
    const ALLOW_PUBLIC_REMOTE = !!cfg.allowPublicRemote; // 允许推送到 GitHub 等公网（默认否）
    const DEFAULT_USER_NAME = String(cfg.defaultUserName || 'AI 助手');
    const DEFAULT_USER_EMAIL = String(cfg.defaultUserEmail || 'ai@dsh.local');

    // initialVersion 配置不合法（如 "1.0"）时兜底为 1.0.0，避免 formatVersion(null) 崩溃
    const INITIAL_VERSION_OBJ = parseVersion(INITIAL_VERSION) || { major: 1, minor: 0, patch: 0 };

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    };

    // ================= git 可执行文件解析 =================
    async function resolveGitExe(sub) {
      try { return await sub.resolveExecutable('git'); } catch (e) { /* PATH 没有则走候选路径 */ }
      const fsSvc = ctx.get('fs');
      if (fsSvc !== undefined) {
        for (const candidate of GIT_EXE_CANDIDATES) {
          try {
            const target = await fsSvc.resolve(candidate);
            const info = await fsSvc.stat(target);
            if (info) return candidate;
          } catch (e) { /* try next */ }
        }
      }
      return null;
    }

    // ================= 执行 git 命令（带超时与取消，参考 sandbox-escape.js 的 deadline 机制） =================
    async function runGit(args, cwd, signal, timeoutMs) {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return { _error: 'subprocess 服务不可用，无法执行 git。' };
      const gitPath = await resolveGitExe(sub);
      if (!gitPath) return { _error: '未找到 git 可执行文件（PATH 与常见安装路径均未命中）。' };

      const deadline = makeDeadline(signal, timeoutMs || 60000);
      let handle;
      try {
        handle = sub.spawn({
          // core.quotepath=false：让中文/特殊字符文件名在 status / diff 输出中保持原样，
          // 否则自动提交信息里中文文件名会变成八进制转义序列。
          argv: [gitPath, '-c', 'core.quotepath=false', ...args],
          cwd: cwd || WS_ROOT,
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 2 * 1024 * 1024 },
            stderr: { maxBytes: 512 * 1024 },
          },
          graceMs: 5000,
          ...(deadline.signal ? { signal: deadline.signal } : {}),
        });
      } catch (e) {
        deadline.cancel();
        return { _error: '启动 git 失败: ' + msg(e) };
      }
      let outcome;
      try {
        outcome = await raceDone(handle.done, deadline);
      } catch (e) {
        deadline.cancel();
        return { _error: 'git 执行超时或已被取消（已终止进程树）: ' + msg(e) };
      }
      deadline.cancel();
      const so = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : '';
      const se = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : '';
      return { exitCode: outcome.exitCode, stdout: so, stderr: se, _error: undefined };
    }

    // 合并外部信号与超时信号：任一触发都会终止进程树
    function makeDeadline(signal, timeoutMs) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      const onAbort = () => { if (ctrl) ctrl.abort(); };
      if (ctrl && signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort);
      }
      if (ctrl && typeof setTimeout === 'function') {
        timer = setTimeout(() => ctrl.abort(), timeoutMs);
      }
      return {
        signal: ctrl ? ctrl.signal : undefined,
        cancel() {
          if (timer) { clearTimeout(timer); timer = null; }
          if (ctrl && signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
        },
      };
    }

    // done 与 deadline 竞速：超时/取消时立即 reject，进程树终止在后台完成
    function raceDone(done, deadline) {
      return new Promise((resolve, reject) => {
        const sig = deadline.signal;
        if (!sig) { done.then(resolve, reject); return; }
        if (sig.aborted) { reject(new Error('命令超时或已被取消')); return; }
        const onAbort = () => reject(new Error('命令超时或已被取消（进程树已终止）'));
        sig.addEventListener('abort', onAbort, { once: true });
        done.then(resolve, reject).finally(() => sig.removeEventListener('abort', onAbort));
      });
    }

    async function isRepo(cwd) {
      const r = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
      return !r._error && r.exitCode === 0 && r.stdout.trim() === 'true';
    }

    async function currentBranch(cwd) {
      const r = await runGit(['branch', '--show-current'], cwd);
      if (!r._error && r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
      const s = await runGit(['symbolic-ref', '--short', 'HEAD'], cwd);
      return (!s._error && s.exitCode === 0) ? s.stdout.trim() : '';
    }

    // 仓库现有标签中最高 vX.Y.Z
    async function latestTag(cwd) {
      const r = await runGit(['tag'], cwd);
      if (r._error || r.exitCode !== 0) return null;
      let best = null;
      for (const line of r.stdout.split(/\r?\n/)) {
        const v = parseVersion(line);
        if (!v) continue;
        if (!best || cmpVersion(v, best) > 0) best = v;
      }
      return best;
    }

    // 脏文件（short status，两列代码 + 路径）
    async function dirtyFiles(cwd) {
      const r = await runGit(['status', '--porcelain'], cwd);
      if (r._error || r.exitCode !== 0) return [];
      const out = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const l = line.trimEnd('\r');
        if (!l) continue;
        out.push(l.length > 3 ? l.slice(3) : l);
      }
      return out;
    }

    function autoCommitMessage(files) {
      const n = files.length;
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      if (n === 0) return 'AI 自动提交（无文件变更）';
      const names = files.slice(0, 5).join(', ');
      return `AI 自动提交 ${stamp} · ${n} 个文件（${names}${n > 5 ? ' 等' : ''}）`;
    }

    function reg(name, description, parameters, execute) {
      ctx.tools.register({
        name,
        description,
        parameters,
        output,
        timeoutMs: 180000,
        execute,
      });
    }

    // ================= git_repo_status：发布前查看仓库状态 =================
    // 注意：工具名不用 git_status —— dsh-workbench-plugin（bundle）已注册 git_status，dsh-tools 拒绝同名。
    reg('git_repo_status',
      '查看本地 git 仓库的状态：是否为 git 仓库、当前分支、未提交的改动文件、现有最高版本号（vX.Y.Z 标签）与下一个推荐版本号。发布前可先调用确认目标目录与版本。',
      {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: '目标 git 仓库目录（绝对路径）。默认：全局配置的 workspaceRoot。' },
        },
      },
      async (args, exec) => {
        const repoPath = path.resolve(args.repoPath ? String(args.repoPath) : WS_ROOT);
        if (!fs.existsSync(repoPath)) return { _error: '目录不存在: ' + repoPath };
        const repo = await isRepo(repoPath);
        // 传入子目录时自动解析到仓库根，保证 "add -A / commit / tag" 作用于整个仓库
        let workPath = repoPath;
        if (repo) {
          const top = await runGit(['rev-parse', '--show-toplevel'], repoPath);
          if (!top._error && top.exitCode === 0 && top.stdout.trim()) {
            const resolved = path.resolve(top.stdout.trim());
            if (fs.existsSync(resolved)) workPath = resolved;
          }
        }
        const files = await dirtyFiles(workPath);
        const branch = await currentBranch(workPath);
        const latest = await latestTag(workPath);
        const next = latest ? bumpVersion(latest, 'patch') : INITIAL_VERSION_OBJ;
        return {
          repoPath: workPath,
          requestedPath: repoPath,
          isGitRepo: repo,
          branch: branch || (repo ? '(未命名/空仓库)' : '(无)'),
          changedFiles: files.length,
          changedFilesList: files.slice(0, 50),
          latestVersion: latest ? 'v' + formatVersion(latest) : '(无版本标签)',
          nextVersion: next ? 'v' + formatVersion(next) : '(无法计算)',
        };
      });

    // ================= git_publish：提交 + 版本号 + 推送本地 git =================
    reg('git_publish',
      '将 AI 写完的代码直接发布到本地 git：git add -A → commit → 创建递增版本号标签（vX.Y.Z）→ 推送到本地 git 远程（如果配置/存在）。'
      + 'repoPath 应为目标项目的 git 仓库根目录（可传子目录，会自动解析到根）；目录不是 git 仓库且未开启 autoInit 时会报错，'
      + '不会对多项目混合目录做整盘初始化。'
      + '默认递增补丁号（1.0.0 → 1.0.1），可用 bump=minor/major 或 version 显式指定；'
      + '推送到 GitHub/GitLab 等公网托管默认拒绝（必须显式 allowPublicRemote）。'
      + '适合在完成一轮代码改动后立即调用，把成果存进本地 git 并标记一个版本。',
      {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: '目标 git 仓库目录（绝对路径）。默认：全局配置的 workspaceRoot。' },
          commitMessage: { type: 'string', description: '提交信息。不填则自动生成（含文件数与时间）。' },
          version: { type: 'string', description: '显式版本号，如 "1.2.0" 或 "v1.2.0"。不填则按 bump 自动递增。' },
          bump: { type: 'string', enum: ['patch', 'minor', 'major'], description: '自动递增方式，默认 patch（补丁号 +1）。' },
          push: { type: 'boolean', description: '是否推送，默认 true（仅推送到本地/内网远程，公网默认拒绝）。' },
          force: { type: 'boolean', description: '目标版本号 tag 已存在时是否覆盖（默认 false，不覆盖）。' },
          branch: { type: 'string', description: '推送目标分支。默认使用当前分支（新仓库为配置的 defaultBranch）。' },
        },
      },
      async (args, exec) => {
        const repoPath = path.resolve(args.repoPath ? String(args.repoPath) : WS_ROOT);
        const signal = exec && exec.signal;
        if (!fs.existsSync(repoPath)) return { _error: '目录不存在: ' + repoPath };

        // 传入子目录时自动解析到仓库根，保证 "add -A / commit / tag" 作用于整个仓库
        let workPath = repoPath;
        {
          const r = await runGit(['rev-parse', '--show-toplevel'], repoPath, signal);
          if (!r._error && r.exitCode === 0 && r.stdout.trim()) {
            const resolved = path.resolve(r.stdout.trim());
            if (fs.existsSync(resolved)) workPath = resolved;
          }
        }

        const steps = [];
        let repo = await isRepo(workPath);

        // 1) 不是仓库 → 按配置自动初始化
        if (!repo) {
          if (!AUTO_INIT) return { _error: workPath + ' 不是 git 仓库（autoInit 已关闭，请先手动 git init，或调用时显式传 repoPath 指向目标项目仓库）。' };
          let init = await runGit(['init', '-b', DEFAULT_BRANCH], workPath, signal, 30000);
          if (init._error || init.exitCode !== 0) {
            // 旧版 git 不支持 -b：回退 git init，成功后再强制把 HEAD 指到 DEFAULT_BRANCH
            init = await runGit(['init'], workPath, signal, 30000);
            if (!init._error && init.exitCode === 0) {
              const sb = await runGit(['symbolic-ref', 'HEAD', 'refs/heads/' + DEFAULT_BRANCH], workPath, signal, 30000);
              if (sb._error || sb.exitCode !== 0) {
                return { _error: '初始化仓库后设置默认分支 ' + DEFAULT_BRANCH + ' 失败: ' + maskCreds(sb.stderr || sb._error) };
              }
            }
          }
          if (init._error || init.exitCode !== 0) {
            return { _error: 'git init 失败: ' + (init.stderr || init._error || '未知错误') };
          }
          steps.push('git init（自动初始化仓库，默认分支 ' + DEFAULT_BRANCH + '）');
          repo = true;
        }

        // 2) 仓库级身份（name 与 email 分开检查，缺少哪个写哪个，绝不改 --global）
        //    注意：git config 读取未配置项时退出码为 1 且 stdout 为空，故以"非 0 退出 或 空值"视为缺失。
        const missingIdentityKeys = [];
        const nameCfg = await runGit(['config', 'user.name'], workPath, signal);
        const hasName = !nameCfg._error && nameCfg.exitCode === 0 && !!nameCfg.stdout.trim();
        const emailCfg = await runGit(['config', 'user.email'], workPath, signal);
        const hasEmail = !emailCfg._error && emailCfg.exitCode === 0 && !!emailCfg.stdout.trim();
        if (!hasName) {
          const s1 = await runGit(['config', 'user.name', DEFAULT_USER_NAME], workPath, signal);
          if (s1._error || s1.exitCode !== 0) return { _error: '写入仓库级 user.name 失败: ' + (s1.stderr || s1._error) };
          missingIdentityKeys.push('user.name');
        }
        if (!hasEmail) {
          const s2 = await runGit(['config', 'user.email', DEFAULT_USER_EMAIL], workPath, signal);
          if (s2._error || s2.exitCode !== 0) return { _error: '写入仓库级 user.email 失败: ' + (s2.stderr || s2._error) };
          missingIdentityKeys.push('user.email');
        }
        if (missingIdentityKeys.length > 0) {
          steps.push('自动写入仓库级身份（缺失项）: ' + missingIdentityKeys.join(', ') + ' (' + DEFAULT_USER_NAME + ' <' + DEFAULT_USER_EMAIL + '>)');
        }

        // 3) add 全部改动
        const add = await runGit(['add', '-A'], workPath, signal);
        if (add._error || add.exitCode !== 0) return { _error: 'git add -A 失败: ' + maskCreds(add.stderr || add._error) };

        const files = await dirtyFiles(workPath);
        const stagedCount = files.length;
        // 敏感文件检测：命中则警告（不阻止，仅提示 AI/用户核对）
        const sensitiveFiles = findSensitiveFiles(files);
        const sensitiveWarning = sensitiveFiles.length > 0
          ? '⚠️ 提交内容包含疑似敏感文件：' + sensitiveFiles.slice(0, 10).join(', ') + '。请确认它们不应被提交（应加入 .gitignore 后再重新调用）。'
          : null;

        // 4) 提交
        let commitHash = '';
        let committed = false;
        if (stagedCount > 0) {
          const message = (args.commitMessage && String(args.commitMessage).trim())
            ? String(args.commitMessage).trim()
            : autoCommitMessage(files);
          const commit = await runGit(['commit', '-m', message], workPath, signal);
          if (commit._error || commit.exitCode !== 0) {
            return { _error: 'git commit 失败: ' + maskCreds(commit.stderr || commit._error) };
          }
          const head = await runGit(['rev-parse', 'HEAD'], workPath, signal);
          commitHash = (head._error || head.exitCode !== 0) ? '' : head.stdout.trim().slice(0, 12);
          committed = true;
          steps.push('commit: ' + message + (sensitiveWarning ? ' [含敏感文件警告]' : ''));
        } else if (!args.version) {
          return { ok: true, repoPath: workPath, changed: 0, message: '没有需要提交的改动，且未指定版本号，已跳过。可调用 git_repo_status 查看状态。' };
        }

        // 5) 版本号：显式 version 优先（若低于现有最高版本给出警告），否则按 bump 从最高标签递增
        let target = null;
        let versionWarning = null;
        let latest = null;
        if (args.version && String(args.version).trim()) {
          const v = parseVersion(String(args.version));
          if (!v) {
            return { _error: 'version 格式不正确，应为 X.Y.Z（如 1.2.0）。' };
          }
          target = v;
          latest = await latestTag(workPath);
          if (latest && cmpVersion(target, latest) < 0) {
            versionWarning = '指定的版本 v' + formatVersion(target) + ' 低于仓库现有最高版本 v' + formatVersion(latest) + '，会造成版本号倒退；如确需如此请确认。';
          }
        } else {
          latest = await latestTag(workPath);
          // 无标签时直接用初始版本（1.0.0），已有标签时才在最高标签上递增 —— 与 git_repo_status 的 nextVersion 语义一致
          target = latest
            ? bumpVersion(latest, String(args.bump || 'patch'))
            : INITIAL_VERSION_OBJ;
        }
        const tagName = 'v' + formatVersion(target);

        const exists = await runGit(['tag', '-l', tagName], workPath, signal);
        const tagExists = !exists._error && exists.exitCode === 0 && !!exists.stdout.trim();
        if (tagExists && !args.force) {
          return { _error: '版本号 ' + tagName + ' 已存在。请使用更大的版本（bump 或 version），或传 force=true 覆盖。' };
        }

        const tagArgs = ['tag', '-a', tagName, '-m', 'release ' + tagName];
        if (tagExists) tagArgs.push('-f');
        const tag = await runGit(tagArgs, workPath, signal);
        if (tag._error || tag.exitCode !== 0) {
          return { _error: '创建版本标签 ' + tagName + ' 失败: ' + maskCreds(tag.stderr || tag._error) };
        }
        steps.push('tag: ' + tagName + (tagExists ? '（force 覆盖）' : ''));

        // 6) 推送（仅本地/内网，公网默认拒绝；只推新提交 + 本次创建的那一个标签）
        let pushDetail = { pushed: false, reason: '推送被跳过' };
        if (args.push !== false) {
          let targetRemote = LOCAL_REMOTE;
          if (!targetRemote) {
            const origin = await runGit(['remote', 'get-url', 'origin'], workPath, signal, 15000);
            if (!origin._error && origin.exitCode === 0 && origin.stdout.trim()) targetRemote = origin.stdout.trim();
          }
          if (!targetRemote) {
            pushDetail = { pushed: false, reason: '未配置远程（config.localRemote 或 origin），已在本地完成提交与版本标签。' };
          } else {
            const kind = classifyRemote(targetRemote);
            const safeRemote = maskCreds(targetRemote);
            if (kind === 'public' && !ALLOW_PUBLIC_REMOTE) {
              pushDetail = { pushed: false, reason: '远程是公网托管（' + safeRemote + '），本插件默认只推本地 git；如需推送请设置 allowPublicRemote。' };
            } else {
              // 分支名只允许安全字符（防畸形 refspec），空值回退到当前分支
              let branch = (args.branch && String(args.branch).trim())
                ? String(args.branch).trim()
                : (await currentBranch(workPath)) || DEFAULT_BRANCH;
              if (!/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
                pushDetail = { pushed: false, reason: '非法分支名（仅允许字母数字 . _ - /）: ' + branch + '。提交与版本标签已在本地完成。' };
              } else {
                // 显式推送分支 + 仅本次创建的标签（refs/tags/<tagName>），不推仓库里其它历史标签
                const push = await runGit(['push', targetRemote, 'HEAD:' + branch, 'refs/tags/' + tagName], workPath, signal, 120000);
                if (push._error || push.exitCode !== 0) {
                  pushDetail = { pushed: false, reason: '推送失败: ' + maskCreds(push.stderr || push._error) + '。提交与版本标签已在本地完成。' };
                } else {
                  pushDetail = { pushed: true, remote: safeRemote, branch, tag: tagName };
                  steps.push('push -> ' + safeRemote + ' (' + branch + ', tag ' + tagName + ')');
                }
              }
            }
          }
        } else {
          pushDetail = { pushed: false, reason: 'push 参数为 false，仅本地提交与打标签。' };
        }

        return {
          ok: true,
          repoPath: workPath,
          requestedPath: repoPath,
          committed,
          changed: stagedCount,
          changedFilesList: files.slice(0, 200),
          commitHash,
          version: tagName,
          versionWarning,
          sensitiveWarning,
          pushDetail,
          steps,
        };
      });

    // ================= 系统提示段落 =================
    const spService = ctx.get('systemPrompt');
    if (spService !== undefined && typeof spService.section === 'function') {
      try {
        spService.section({
          name: 'tool:git-publish',
          order: 107,
          text: '代码写完、需要存进本地 git 并标记版本时，直接调用 git_publish：它会 add -A、commit、'
            + '自动创建递增版本号（vX.Y.Z）并推送到本地 git 远程（不是 GitHub；公网托管默认拒绝推送）。'
            + 'repoPath 要传目标项目仓库根目录（默认是工作区根，通常不是仓库，会报错并提示）。'
            + '发布前可用 git_repo_status 先查一下仓库状态与下一个版本号。',
        });
      } catch (e) { /* 提示段落失败不影响工具 */ }
    }

    console.log('[git-publish] loaded: git_repo_status / git_publish tools registered globally (local git commit + auto version tag + local push)');
  },
};