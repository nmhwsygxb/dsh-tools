// self-review.js — 全局宿主插件（写入 Host 组合，所有会话生效）
//
// "AI 执行程序时自动给自己审核"：提供 1 个工具 + 1 个自动旁路钩子 + 1 个提示段落。
//
//   - self_review：AI 在每次执行有副作用的命令/操作（pwsh / sandbox_escape /
//     remote_exec / git_publish / gh 写操作 / 文件清除等）之前应主动调用。
//     工具对"意图 + 命令原文 + 涉及路径"做静态危险扫描（删除/格式化/系统级/
//     磁盘分区/注册表/关机/凭据区等），结合当前会话生效的沙箱与审批策略给出
//     verdict: safe | caution | danger，以及命中的风险点与降险建议，并把本次
//     自审写入审计日志 self-review-audit.log。verdict=danger 时工具明确要求
//     AI 不得直接执行，必须先停下向用户说明或改用更安全的替代。
//   - tools/pre-execute 自动旁路：对命令类工具（pwsh、sandbox_escape、
//     remote_exec、git_publish、gh 写操作等）的每次真实调用，执行前自动做
//     一次相同的危险扫描并写入审计日志——不阻断执行（在完全权限/审批关闭
//     下也不改变工具行为），只负责"自动留痕 + 自动审核"，供事后回查。
//   - systemPrompt 段落：规定 AI 何时必须调用 self_review，以及 danger 结论
//     下必须暂停/降级/征询用户，不得绕过。
//
// 设计要点：
//   - 完全不依赖 approval 服务：审批策略为 never/ask/任何模式都正常生效，
//     因此"完全权限（danger-full-access）+ 审批关闭"下本工具的审核与审计
//     依然工作——它是对"AI 自律"的强制辅助，而不是第二个审批闸门。
//   - 危险扫描只做静态模式匹配，用于提示与留痕；真正控制权仍在用户
//     （审批框 / 沙箱策略），本插件从不静默阻止任何工具调用。
//   - 审计日志单行 JSON 追加，字段全部限长与 JSON 转义，可被脚本回查。
'use strict';

const path = require('path');
const fs = require('fs');

const AUDIT_LOG = process.env.SELF_REVIEW_LOG
  ? path.resolve(process.env.SELF_REVIEW_LOG)
  : path.join(__dirname, 'self-review-audit.log');
const MAX_COMMAND_CHARS = 4000;   // 扫描/记录的命令文本上限（超长截断，扫描仍用全文）
const MAX_TARGETS = 12;           // 涉及的路径最多记录条数

function appendAudit(line) {
  try {
    fs.appendFileSync(AUDIT_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) { /* 审计文件写失败不阻塞 */ }
}

const j = (s) => JSON.stringify(String(s));

function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n) + `…[截断 ${str.length - n} 字符]`;
}

// 工作区根（用于判定"越出工作区"的路径风险）：patch 配置优先，否则沙箱策略，
// 再否则进程 cwd。
function workspaceRootOf(ctx, config) {
  const sandbox0 = ctx.get('sandboxPolicy');
  if (config && config.workspaceRoot) return path.resolve(String(config.workspaceRoot));
  if (sandbox0 && sandbox0.workspaceRoot) return sandbox0.workspaceRoot;
  return process.cwd();
}

// ---------- 危险 / 谨慎模式表 ----------
// DANGER_PATTERNS：命中任一 → verdict=danger（破坏性/系统级/不可逆/凭据敏感）
const DANGER_PATTERNS = [
  /\bRemove-Item\b[^\n]*?(?:-Recurse|-Force|-Confirm:\$false)/i,
  /\b(?:rm|rmdir|del|erase|rd)\b[^\n]*?(?:\/[sqrf]|\s+-\s?[sqrf])/i,
  /\bRemove-(?:Item|File|Directory|Folder)\b[^\n]*?(?:-Recurse|-Force)/i,
  /\bFormat-(?:Volume|Disk|Partition)\b/i,
  /\bClear-(?:Disk|Volume|Partition|RecycleBin)\b/i,
  /\bInitialize-Disk\b[^\n]*-?[^\n]*/i,
  /\bNew-Partition\b[^\n]*?(?:-AssignDriveLetter|-Size)/i,
  /\bdiskpart\b/i,
  /\bchkdsk\b[^\n]*-?[^\n]*\/f/i,
  /\bbcdedit\b/i,
  /\b(?:Stop-Computer|Restart-Computer)\b|\bshutdown\b/i,
  /\bRemove-(?:ADUser|ADGroup|ADComputer|LocalUser)\b/i,
  /\bSet-MpPreference\b|\bDisable-MpPreference\b/i,
  /\b(?:reg\s+delete|regedt32|sc\s+delete)\b/i,
  /\b(?:Reset-ComputerMachinePassword|Clear-Tpm|Disable-BitLocker)\b/i,
  /\bReset-(?:ComputerMachinePassword|LocalMachinePassword)\b/i,
  /\bRemove-ItemProperty\b[^\n]*?(?:-Recurse)/i,
  /\bgit\s+(?:push|reset|rebase|clean|branch\s+-D)\b[^\n]*?(?:--force|-f\b)/i,
  /\bgit\s+filter-branch\b/i,
  /\b(?:certutil|bitsadmin)\b[^\n]*?(?:-urlcache\s+delete|\/transfer)/i,
  /\b(?:wmic|wbemtest)\b/i,
  /\bClear-Content\b[^\n]*?(?:-Path.*(?:\\\\|:\\)|\$env:|C:\\Windows)/i,
  /\bRemove-Item\b[^\n]*\$env:/i,
];

// CAUTION_PATTERNS：命中任一 → verdict=caution（越界写/敏感读/大范围操作/网络外发）
const CAUTION_PATTERNS = [
  /\b(?:Out-File|Set-Content|Add-Content|Copy-Item|Move-Item|New-Item)\b[^\n]*?(?:C:\\Windows|C:\\Program Files|HKLM:|HKCR:|\\System32)/i,
  /\b(?:[a-zA-Z]:\\Windows\\|[a-zA-Z]:\\Program Files\\)/i,
  /\bHKLM:|HKCR:\\/i,
  /\b(?:\.ssh|id_rsa|credentials|token|secret|\.env)\b/i,
  /\b(?:taskkill|Stop-Process|kill)\b[^\n]*?(?:\/F|-Force)/i,
  /\b(?:net\s+user|net\s+localgroup|whoami\s+\/priv)\b/i,
  /\bgit\s+push\b/i,
  /\bcurl\b[^\n]*?\|\s*(?:sh|bash|pwsh|powershell)/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n]*?(?:-OutFile|>)/i,
  /\bNew-Service\b|\bSet-Service\b/i,
  /\b(?:schtasks|at\s+[0-9])/i,
  /\bRemove-Item\b/i,                           // 未带 -Recurse 的删除也提示
  /\bdel\b|\berase\b|\brm\b/i,                  // cmd 删除
  /\bEnable-PSRemoting\b|\bEnter-PSSession\b/i,
  /\b[A-Za-z]:\\[^\\/:*?"<>|\n]*\\[^\\/:*?"<>|\n]*\\\*\s*$/m, // 通配删除某盘符下多层目录
  /\b(?:Remove-Item|rmdir|rd)\b[^\n]*\*\.\*\b/i,             // 删除目录里的全部文件
];

// 真正会"执行程序/命令"的工具：自动旁路只覆盖这些，避免把普通文件编辑
// （edit/write/delete/move 等）的全文内容当成命令刷进审计日志。
const COMMAND_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'sh', 'cmd', 'powershell',
  'sandbox_escape', 'remote_exec', 'git_publish', 'blender_run_python',
]);

// 少量确有内容传输的写操作也纳入自动旁路（只记工具名与判定，不提取全文）
function isWriteLikeTool(name) {
  if (COMMAND_TOOLS.has(name)) return true;
  if (typeof name !== 'string') return false;
  return /^(gh_write_file|gh_create_repo|gh_create_issue|gh_create_pr|gh_download|wr_download|job_kill|bug_new|bug_update)$/.test(name);
}

// 提取工具调用里的"命令原文"（只提取真正代表命令/代码的字段；
// 刻意排除 content / prompt：那是文件正文或长篇意图，不该进入审计日志）
function extractCommandText(name, argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object') return '';
  const args = argumentsValue;
  for (const key of ['command', 'script', 'code', 'cmd']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// 提取涉及路径（数组或字符串）
function extractTargets(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object') return [];
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim() && out.length < MAX_TARGETS) out.push(v.trim());
  };
  push(argumentsValue.path);
  push(argumentsValue.target);
  push(argumentsValue.cwd);
  push(argumentsValue.file_path);
  push(argumentsValue.dest);
  push(argumentsValue.repoPath);
  if (Array.isArray(argumentsValue.paths)) argumentsValue.paths.slice(0, MAX_TARGETS).forEach(push);
  return out;
}

// 判定路径是否在工作区外 / 命中敏感区
function pathFindings(targets, wsRoot) {
  const findings = [];
  const wsLower = String(wsRoot || '').toLowerCase();
  for (const t of targets) {
    const tl = String(t).toLowerCase();
    if (!wsLower || !tl.includes(wsLower)) {
      // 明确是 C:\Windows / Program Files / HKLM 等系统区 → caution 已在模式表里；
      // 这里只提示"工作区外路径"
      if (!/^(?:[a-z]:\\windows|[a-z]:\\program files|hk)/i.test(tl)) {
        findings.push({ level: 'info', message: `涉及工作区外路径: ${truncate(t, 200)}` });
      }
    }
  }
  return findings;
}

// 核心：对"意图 + 命令 + 路径"做静态审核
function scan(commandText, targets, wsRoot) {
  const findings = [];
  const text = String(commandText || '');
  for (const re of DANGER_PATTERNS) {
    if (re.test(text)) {
      const m = text.match(re);
      findings.push({ level: 'danger', message: `命中危险模式: ${m ? m[0].slice(0, 120) : re}` });
    }
  }
  for (const re of CAUTION_PATTERNS) {
    if (re.test(text)) {
      const m = text.match(re);
      findings.push({ level: 'caution', message: `命中谨慎模式: ${m ? m[0].slice(0, 120) : re}` });
    }
  }
  findings.push(...pathFindings(targets, wsRoot));

  const dangerN = findings.filter((f) => f.level === 'danger').length;
  const cautionN = findings.filter((f) => f.level === 'caution').length;
  let verdict = 'safe';
  if (dangerN > 0) verdict = 'danger';
  else if (cautionN > 0) verdict = 'caution';
  if (!text && targets.length === 0) {
    // 无命令也无路径时，若只是记意图则可给 safe 但提示信息不足
    findings.push({ level: 'info', message: '没有提供命令原文或路径，审核依据仅限意图描述。' });
  }
  // 去重：同一条命令可能同时命中多个相似正则，保留首个+计数
  const seenMsg = new Map();
  const dedup = [];
  for (const f of findings) {
    const key = f.level + '|' + f.message;
    const n = seenMsg.get(key) || 0;
    seenMsg.set(key, n + 1);
    if (n === 0) dedup.push({ ...f, count: 1 });
    else {
      const last = dedup[dedup.length - 1];
      if (last && last.level === f.level && last.message === f.message) last.count = n + 1;
    }
  }
  return { verdict, dangerN, cautionN, findings: dedup };
}

function suggestionFor(verdict, findings) {
  if (verdict === 'danger') {
    return '危险结论：不要直接执行。请停下，向用户说明这条命令会造成什么影响、是否有更安全的替代（缩小范围 / 先备份 / 改用只读操作），征得用户明确同意后再执行。';
  }
  if (verdict === 'caution') {
    return '谨慎结论：可以执行，但请先确认影响范围（尤其涉及删除/外部路径/网络外发时），并在执行前说明理由。';
  }
  return '安全结论：可以执行。执行后如产生副作用，建议再次调用 self_review(phase="post") 复盘。';
}

module.exports = {
  name: 'self-review',

  inject: ['tools'],

  apply(ctx, config) {
    const wsRoot = workspaceRootOf(ctx, config);

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    };

    // 读取当前会话生效的沙箱/审批策略（工具执行上下文里拿 agent → session）
    function environmentOf(exec) {
      const env = {};
      try {
        const sp = ctx.get('sandboxPolicy');
        const ap = ctx.get('approval');
        const session = exec && exec.agent && exec.agent.session;
        if (sp) {
          env.mode = sp.defaultMode;
          env.workspaceRoot = sp.workspaceRoot;
          if (session) {
            try { env.mode = sp.resolve({ session }).mode; } catch (e) { /* ignore */ }
          }
        }
        if (ap && session) {
          try { env.approvalPolicy = ap.overrideOf(session) || 'default'; } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return env;
    }

    const sessionIdOf = (exec) => {
      try {
        const s = exec && exec.agent && exec.agent.session;
        return s && s.id ? String(s.id) : 'unknown';
      } catch (e) { return 'unknown'; }
    };

    function doAudit(opts) {
      // opts: { phase, action, command, tool, targets, exec }
      const phase = opts.phase === 'post' ? 'post' : 'pre';
      const commandText = String(opts.command || '').trim();
      const targets = (opts.targets || []).slice(0, MAX_TARGETS);
      const env = environmentOf(opts.exec);
      const scanned = scan(commandText, targets, wsRoot);
      const fullPower = env.mode === 'danger-full-access';
      if (fullPower) {
        scanned.findings.push({ level: 'info', message: '当前为完全权限模式（danger-full-access），命令不受沙箱限制，执行风险敞口最大，请格外谨慎。' });
      }
      const suggestion = suggestionFor(scanned.verdict, scanned.findings);

      const record = {
        ts: new Date().toISOString(),
        session: sessionIdOf(opts.exec),
        phase,
        tool: String(opts.tool || ''),
        action: truncate(String(opts.action || ''), 500),
        command: truncate(commandText, MAX_COMMAND_CHARS),
        targets,
        mode: env.mode || 'unknown',
        approvalPolicy: env.approvalPolicy || 'unknown',
        verdict: scanned.verdict,
        dangerN: scanned.dangerN,
        cautionN: scanned.cautionN,
        findings: scanned.findings.slice(0, 20),
      };
      appendAudit(`${j(record.ts)} session=${j(record.session)} phase=${phase} tool=${j(record.tool)} mode=${j(record.mode)} policy=${j(record.approvalPolicy)} verdict=${record.verdict} action=${j(record.action)} command=${j(record.command)} findings=${j(scanned.findings.map((f) => f.level + ':' + f.message))}`);

      return {
        verdict: scanned.verdict,
        summary: scanned.verdict === 'danger'
          ? '⚠️ 审核不通过：检测到高风险（破坏性/系统级/不可逆）内容。'
          : scanned.verdict === 'caution'
            ? '审核提示：存在需要注意的风险项，请确认影响范围后再执行。'
            : '审核通过：未发现明显风险。',
        suggestion,
        findings: scanned.findings,
        dangerCount: scanned.dangerN,
        cautionCount: scanned.cautionN,
        environment: env,
        auditLog: AUDIT_LOG,
      };
    }

    // ================= self_review 工具 =================
    ctx.tools.register({
      name: 'self_review',
      description:
        'AI 执行程序前给"自己"做的自动审核：在执行任何有副作用的命令/操作'
        + '（pwsh / sandbox_escape / remote_exec / git_publish / gh 写操作 / 删除清除类）之前，'
        + '把要执行的命令原文与涉及路径交给我做静态危险扫描，返回 verdict'
        + '（safe / caution / danger）、命中的风险点与降险建议，并写入审计日志'
        + ' self-review-audit.log。完全不依赖审批服务——即使当前是完全权限'
        + '（danger-full-access、审批关闭）也照常生效，用于强制 AI 自律与留痕。'
        + ' 规则：verdict=danger 时不得直接执行，必须先停下向用户说明、改用更安全的'
        + ' 替代或征得明确同意；caution 时确认影响范围后再执行。执行产生副作用后'
        + ' 可再调一次 phase="post" 复盘。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '打算执行的操作，用一句话描述（必填）。' },
          command: { type: 'string', description: '要执行的命令/脚本原文（强烈建议提供，用于危险模式扫描）。' },
          tool: { type: 'string', description: '打算使用哪个工具执行，如 pwsh / sandbox_escape / remote_exec / git_publish / gh_api / write。' },
          targets: { type: 'array', items: { type: 'string' }, description: '涉及的文件/路径列表（可选）。' },
          phase: { type: 'string', enum: ['pre', 'post'], description: '审核阶段：pre=执行前（默认），post=执行后复盘。' },
        },
        required: ['action'],
      },
      output,
      execute: async (args, exec) => {
        const action = String(args && args.action !== undefined ? args.action : '').trim();
        if (!action) return { error: 'action 不能为空：必须说明打算执行的操作。' };
        const commandText = String((args && (args.command || '')) || '');
        const targets = Array.isArray(args && args.targets) ? args.targets.map(String) : [];
        const tool = String((args && args.tool) || '');
        return doAudit({
          phase: (args && args.phase) || 'pre',
          action,
          command: commandText,
          tool,
          targets,
          exec,
        });
      },
    });

    // ================= tools/pre-execute 自动旁路 =================
    // 对命令/写操作类工具，每次真实调用前自动扫描并写审计日志；不阻断执行。
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const name = exec && exec.name ? String(exec.name) : '';
        if (isWriteLikeTool(name)) {
          const commandText = extractCommandText(name, exec.arguments);
          const targets = extractTargets(exec.arguments);
          doAudit({
            phase: 'pre',
            action: `[自动] 工具 ${name} 被调用`,
            command: commandText,
            tool: name,
            targets,
            exec,
          });
        }
      } catch (e) { /* 旁路审核失败绝不影响工具执行 */ }
      return next();
    });

    // ================= 系统提示段落 =================
    const spService = ctx.get('systemPrompt');
    if (spService !== undefined && typeof spService.section === 'function') {
      try {
        spService.section({
          name: 'tool:self-review',
          order: 105,
          text:
            '执行任何有副作用的命令/操作（pwsh / sandbox_escape / remote_exec / git_publish / '
            + 'gh 写操作 / 删除、清除、格式化、关机、注册表、磁盘类操作）之前，必须先调用 '
            + 'self_review 做"执行前自动审核"：把命令原文与涉及路径交给它，按其返回的 verdict 行事。'
            + 'verdict=danger（删除/格式化/系统级/不可逆/凭据敏感）时禁止直接执行：必须先停下来向用户'
            + '说明影响与更安全的替代，得到明确同意后才执行，且执行后调用 self_review(phase="post") 复盘。'
            + 'verdict=caution（越界写/敏感路径/网络外发/强推 git 等）时确认影响范围后再执行。'
            + '即使当前是完全权限模式（danger-full-access、审批关闭）也必须走此自审流程；每次自审与'
            + '每次命令类工具调用都会自动写入 self-review-audit.log 留痕。被审核拒绝的命令不得换说法'
            + '拆分绕过。',
        });
      } catch (e) { /* 提示段落失败不影响工具 */ }
    }

    console.log('[self-review] loaded: self_review tool + pre-execute audit hook + prompt section (approval-independent)');
  },
};