// Sandbox Escape — 全局宿主插件（写入 Host 组合，所有会话生效）
//
// 提供 2 个全局工具：
//   - sandbox_escape：让 AI 在沙箱外以宿主权限执行 PowerShell 命令（真正"跳出沙箱"）。
//     执行前必须先向用户提交审核：通过 ctx.approval.request 弹出 GUI 审批框展示命令与
//     理由，由用户决定同意或拒绝；只有返回 'allowed-once' 命令才会真正运行，
//     'rejected' / 'cancelled' / 'unavailable' 都不会执行任何操作（失败关闭）。
//     高风险命令（删除/格式化/系统级操作等，见 HIGH_RISK_PATTERNS）需要【连续两次】
//     同意才会执行：第一次普通审批通过后，会再发起一次"高风险二次确认"审批，两次都
//     为 'allowed-once' 才真正运行，任一环节被拒/取消/无人应答都不执行。
//     每次请求与结果同时写入：会话审计事件（approval/asked + approval/decided）
//     和本地审计文件 sandbox-escape-audit.log。
//   - sandbox_status：查询当前会话的沙箱模式、工作区根与审批策略，供 AI 申请前了解现状。
//
// 实现要点：
//   - 执行：直接 ctx.subprocess.spawn 启动 pwsh，不经过沙箱执行器。沙箱约束是
//     bash/pwsh 工具层显式调用 sandbox.confine 才施加的；本工具刻意不施加，即"跳出"。
//   - 审批：ctx.approval.request({ agent, toolName, callId, reason, signal })，
//     与官方 approveEscalation 完全同一通道；工具执行上下文提供 exec.agent /
//     exec.callId / exec.signal（与 dsh-tool-pwsh 相同）。
//   - 超时：AbortController 合并 exec.signal 与 timeoutMs，触发 subprocess 的
//     进程树终止（SIGTERM→grace→SIGKILL / Windows taskkill /T）；并用 race 兜底，
//     保证进程树顽固不退时 execute 也能尽快返回而不是挂起。
//   - 安全加固：命令超过 MAX_COMMAND_CHARS 直接拒绝（用户必须能看到完整命令再批准）；
//     reason / 输出 / 审计日志字段全部限长与转义；高风险命令需要两次确认。
'use strict';

const path = require('path');
const fs = require('fs');

const AUDIT_LOG = path.join(__dirname, 'sandbox-escape-audit.log');
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const TOOL_TIMEOUT_MS = 900000; // 工具级总上限：两次审批等待 + 命令执行
const MAX_REASON_CHARS = 2000;   // reason 显示/记录上限
const MAX_COMMAND_CHARS = 50000; // 命令上限：超过直接拒绝，不做截断展示
const MAX_STDOUT_CHARS = 20000;  // 返回给模型的 stdout 上限
const MAX_STDERR_CHARS = 10000;  // 返回给模型的 stderr 上限
const COLLECT_STDOUT_BYTES = 512 * 1024;
const COLLECT_STDERR_BYTES = 256 * 1024;

function appendAudit(line) {
  try {
    fs.appendFileSync(AUDIT_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) { /* 审计文件写失败不阻塞执行 */ }
}

// 审计/提示里的字段统一 JSON 转义，保证日志单行可解析
const j = (s) => JSON.stringify(String(s));

// 保留末尾 n 字符，并标注省略量
function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(-n) + `\n...[输出被截断，省略 ${str.length - n} 字符]`;
}

// 高风险破坏性模式（尽力识别并强制两次确认；真正控制仍是用户审批）
const HIGH_RISK_PATTERNS = [
  /\bRemove-Item\b[^\n]*?(?:-Recurse|-Force|-Confirm:\$false)/i,
  /\b(?:rm|rmdir|del|erase)\b[^\n]*?(?:\/[sqrf]|\s+-\s?[sqrf])/i,
  /\bFormat-(?:Volume|Disk|Partition)\b/i,
  /\bClear-(?:Disk|Volume|Partition)\b/i,
  /\bInitialize-Disk\b[^\n]*-?[^\n]*/i,
  /\bdiskpart\b/i,
  /\b(?:Stop-Computer|Restart-Computer)\b|\bshutdown\b/i,
  /\bRemove-(?:ADUser|ADGroup|ADComputer)\b/i,
  /\bSet-MpPreference\b|\bDisable-MpPreference\b/i,
  /\b(?:reg\s+delete|sc\s+delete)\b/i,
  /\b(?:Reset-ComputerMachinePassword|Clear-Tpm)\b/i,
];

function isHighRisk(command) {
  return HIGH_RISK_PATTERNS.some((re) => re.test(String(command)));
}

function riskWarning(command) {
  return isHighRisk(command)
    ? '⚠️ 高风险命令（可能造成破坏性影响，需要两次确认）！ '
    : '';
}

module.exports = {
  name: 'sandbox-escape',

  inject: ['tools'],

  apply(ctx, config) {
    // 工作区根：patch 配置 config.workspaceRoot 优先（组合插件拿不到会话 cwd，
    // sandboxPolicy.workspaceRoot 是 dsh 进程启动目录，可能不是工作区）。
    const sandbox0 = ctx.get('sandboxPolicy');
    const WS_ROOT = config && config.workspaceRoot
      ? path.resolve(String(config.workspaceRoot))
      : (sandbox0 && sandbox0.workspaceRoot ? sandbox0.workspaceRoot : process.cwd());

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    };

    // ================= PowerShell 可执行文件解析（PS7 → PATH → PS 5.1 兜底）=================
    async function resolveShellExe() {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return null;
      for (const name of ['pwsh', 'powershell']) {
        try { return await sub.resolveExecutable(name); } catch (e) { /* try next */ }
      }
      const fsSvc = ctx.get('fs');
      if (fsSvc !== undefined) {
        const candidates = [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ];
        for (const candidate of candidates) {
          try {
            const target = await fsSvc.resolve(candidate);
            const info = await fsSvc.stat(target);
            if (info) return candidate;
          } catch (e) { /* try next */ }
        }
      }
      return null;
    }

    // 合并外部信号与超时信号：任一触发都会终止进程树
    function withDeadline(signal, timeoutMs) {
      const state = { timedOut: false };
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      const onAbort = () => { if (ctrl) ctrl.abort(); };
      if (ctrl && signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort);
      }
      if (ctrl && typeof setTimeout === 'function') {
        timer = setTimeout(() => { state.timedOut = true; ctrl.abort(); }, timeoutMs);
      }
      return {
        signal: ctrl ? ctrl.signal : undefined,
        timedOut: () => state.timedOut,
        cancel() {
          if (timer) { clearTimeout(timer); timer = null; }
          if (ctrl && signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
        },
      };
    }

    // done 与 deadline 竞速：超时/取消时立即返回错误，进程树终止在后台完成
    function raceDone(done, deadline) {
      return new Promise((resolve, reject) => {
        const sig = deadline.signal;
        if (!sig) { done.then(resolve, reject); return; }
        if (sig.aborted) { reject(new Error('命令超时或已被取消（进程树已终止）')); return; }
        const onAbort = () => reject(new Error('命令超时或已被取消（进程树已终止）'));
        sig.addEventListener('abort', onAbort, { once: true });
        done.then(resolve, reject).finally(() => sig.removeEventListener('abort', onAbort));
      });
    }

    // 无沙箱执行 PowerShell 命令（宿主权限，不经过沙箱执行器）
    async function runUnconfined(command, cwd, timeoutMs, signal) {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return { error: 'subprocess 服务不可用，无法执行。' };
      const shellPath = await resolveShellExe();
      if (!shellPath) return { error: '未找到可用的 PowerShell（pwsh / powershell）。' };
      // 编码预置不影响命令语义，仅保证捕获输出按 UTF-8 解码
      const script = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n'
        + 'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n'
        + command;
      const deadline = withDeadline(signal, timeoutMs);
      let handle;
      try {
        handle = sub.spawn({
          argv: [shellPath, '-NoProfile', '-NonInteractive', '-Command', script],
          cwd,
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: COLLECT_STDOUT_BYTES },
            stderr: { maxBytes: COLLECT_STDERR_BYTES },
          },
          graceMs: 5000,
          ...(deadline.signal ? { signal: deadline.signal } : {}),
        });
      } catch (e) {
        deadline.cancel();
        return { error: '启动子进程失败：' + ((e && e.message) || String(e)) };
      }
      let outcome;
      try {
        outcome = await raceDone(handle.done, deadline);
      } catch (e) {
        deadline.cancel();
        return { error: (e && e.message) || '命令未能在时限内结束，已终止。' };
      }
      const so = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null;
      const se = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null;
      deadline.cancel();
      const stdoutRaw = so ? so.text : '';
      const stderrRaw = se ? se.text : '';
      const stdout = stdoutRaw.length > MAX_STDOUT_CHARS ? truncate(stdoutRaw, MAX_STDOUT_CHARS) : stdoutRaw;
      const stderr = stderrRaw.length > MAX_STDERR_CHARS ? truncate(stderrRaw, MAX_STDERR_CHARS) : stderrRaw;
      return {
        exitCode: outcome.exitCode,
        termSignal: outcome.signal,
        timedOut: deadline.timedOut(),
        stdout,
        stdoutTruncated: (so ? !!so.lossy : false) || stdoutRaw.length > MAX_STDOUT_CHARS,
        stderr,
        stderrTruncated: (se ? !!se.lossy : false) || stderrRaw.length > MAX_STDERR_CHARS,
      };
    }

    // ================= 工具注册 =================
    function reg(name, description, parameters, execute) {
      ctx.tools.register({
        name,
        description,
        parameters,
        output,
        timeoutMs: TOOL_TIMEOUT_MS,
        execute,
      });
    }

    const sessionIdOf = (exec) => {
      try {
        const s = exec && exec.agent && exec.agent.session;
        return s && s.id ? String(s.id) : 'unknown';
      } catch (e) { return 'unknown'; }
    };

    // ================= sandbox_status：查看当前沙箱状态 =================
    reg('sandbox_status',
      '查询当前会话的沙箱状态：生效模式（read-only / workspace-write / danger-full-access）、工作区根、会话覆盖模式与审批策略。AI 在决定是否需要申请跳出沙箱前可先调用了解现状。',
      { type: 'object', properties: {} },
      async (args, exec) => {
        const sp = ctx.get('sandboxPolicy');
        const ap = ctx.get('approval');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const out = {
          escape_tool_available: true,
          workspaceRoot: sp ? sp.workspaceRoot : undefined,
          defaultMode: sp ? sp.defaultMode : undefined,
        };
        if (session) {
          if (sp) {
            try { out.sessionOverride = sp.overrideOf(session); } catch (e) { /* ignore */ }
            try { out.effectiveMode = sp.resolve({ session }).mode; } catch (e) { /* ignore */ }
          }
          if (ap) {
            try { out.approvalPolicy = ap.overrideOf(session); } catch (e) { /* ignore */ }
          }
        }
        return out;
      });

    // ================= sandbox_escape：审批门控的无沙箱执行 =================
    reg('sandbox_escape',
      '以宿主权限在沙箱外执行一条 PowerShell 命令（真正跳出文件沙箱，可访问/修改整台机器）。'
      + '执行前必须先提交审核：工具会向用户弹出审批框展示命令与理由，由用户决定同意或拒绝；'
      + '只有用户明确同意（allowed-once）命令才会运行，拒绝/取消/无人应答（unavailable）都不会执行任何操作。'
      + '高风险命令（删除/格式化/系统级操作等）需要【连续两次同意】才会执行：第一次审批通过后还会再弹一次'
      + '"高风险二次确认"，两次都为同意才真正运行，任一环节未同意都不执行。'
      + '每次请求与结果都会记入会话审计日志和本地审计文件 sandbox-escape-audit.log。'
      + '使用要求：1) 仅在沙箱内确实无法完成时才申请（例如已见到 [sandbox: file access denied ...] 拒绝标记、'
      + '需要访问工作区外路径、或需要系统级操作）；2) reason 必须如实说明这条命令要做什么、会触及哪些路径/系统；'
      + '3) 被用户拒绝后不得换一种说法重试同一条命令；4) 不得用于删除用户数据、格式化磁盘等不可逆破坏性操作。'
      + '注意：命令长度上限 50000 字符（超过直接拒绝，不截断执行）；stdout/stderr 返回给模型时分别截断为 20000/10000 字符。',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在沙箱外执行的 PowerShell 命令（可多行，上限 50000 字符）。' },
          reason: { type: 'string', description: '提交给用户审核的理由：为什么必须跳出沙箱、这条命令要做什么、会触及哪些路径/系统（上限 2000 字符）。' },
          cwd: { type: 'string', description: '命令工作目录（绝对路径）。默认：工作区根。' },
          timeoutMs: { type: 'number', description: '命令超时（毫秒）。默认 120000，上限 600000。' },
        },
        required: ['command', 'reason'],
      },
      async (args, exec) => {
        const command = String(args.command === undefined || args.command === null ? '' : args.command).trim();
        const reason = String(args.reason === undefined || args.reason === null ? '' : args.reason).trim();
        if (!command) return { approved: false, error: 'command 不能为空。' };
        if (!reason) return { approved: false, error: 'reason 不能为空：必须向用户说明为什么需要跳出沙箱。' };
        if (command.length > MAX_COMMAND_CHARS) {
          return { approved: false, error: `command 过长（${command.length} 字符 > 上限 ${MAX_COMMAND_CHARS}），已拒绝。用户必须能看到完整命令才能批准。` };
        }

        const agent = exec && exec.agent;
        const approval = ctx.get('approval');
        if (!approval) return { approved: false, error: '审批服务不可用（未组合 approval），按失败关闭处理，未执行任何命令。' };
        if (!agent) return { approved: false, error: '无法定位发起调用的 agent，按失败关闭处理，未执行任何命令。' };

        const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
          ? Math.min(Math.floor(args.timeoutMs), MAX_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS;

        let cwd = WS_ROOT;
        if (args.cwd !== undefined && args.cwd !== null && String(args.cwd).trim() !== '') {
          cwd = path.isAbsolute(String(args.cwd)) ? String(args.cwd) : path.resolve(WS_ROOT, String(args.cwd));
        }
        if (!fs.existsSync(cwd)) {
          return { approved: false, error: `cwd 不存在：${cwd}，已拒绝。` };
        }

        const shownReason = reason.length > MAX_REASON_CHARS ? truncate(reason, MAX_REASON_CHARS) : reason;
        const highRisk = isHighRisk(command);
        const sessId = sessionIdOf(exec);

        const ask = (reasonText, withCallId) => approval.request({
          agent,
          toolName: 'sandbox_escape',
          ...(withCallId ? { callId: exec.callId } : {}),
          reason: reasonText,
          ...(exec.signal ? { signal: exec.signal } : {}),
        });

        const outcomeMessage = (o) => o === 'rejected'
          ? '用户拒绝了这次跳出沙箱的请求，命令未执行。'
          : o === 'cancelled'
            ? '审批被取消（请求中止），命令未执行。'
            : '审批通道不可用（unavailable，失败关闭），命令未执行。';

        // ---- 第一次确认（所有命令）----
        const auditReason = `[跳出沙箱审核] ${riskWarning(command)}理由：${shownReason} | 命令：${command} | cwd：${cwd}`;
        let outcome;
        try {
          outcome = await ask(auditReason, true);
        } catch (e) {
          appendAudit(`session=${sessId} approval1=error reason=${j(shownReason)} command=${j(command)} error=${j((e && e.message) || String(e))}`);
          return { approved: false, outcome: 'error', error: '审批请求失败：' + ((e && e.message) || String(e)) };
        }
        appendAudit(`session=${sessId} approval1=${outcome} reason=${j(shownReason)} command=${j(command)} cwd=${j(cwd)} highRisk=${highRisk}`);
        if (outcome !== 'allowed-once') {
          return { approved: false, outcome, message: outcomeMessage(outcome) };
        }

        // ---- 高风险命令：第二次确认 ----
        if (highRisk) {
          const confirmReason = `[高风险二次确认] ⚠️ 这是一条高风险命令（可能造成破坏性影响），需要再次确认才会执行。\n命令：${command}\ncwd：${cwd}`;
          let outcome2;
          try {
            outcome2 = await ask(confirmReason, false);
          } catch (e) {
            appendAudit(`session=${sessId} approval2=error command=${j(command)} error=${j((e && e.message) || String(e))}`);
            return { approved: false, outcome: 'error', error: '高风险二次确认请求失败：' + ((e && e.message) || String(e)) };
          }
          appendAudit(`session=${sessId} approval2=${outcome2} command=${j(command)} highRisk=true`);
          if (outcome2 !== 'allowed-once') {
            const why = outcome2 === 'rejected' ? '第二次确认被拒绝' : outcome2 === 'cancelled' ? '第二次确认被取消' : '第二次确认无人应答';
            return { approved: false, outcome: outcome2, message: `高风险命令未获得二次确认（${why}），未执行。` };
          }
        }

        const result = await runUnconfined(command, cwd, timeoutMs, exec.signal);
        if (result.error) {
          appendAudit(`session=${sessId} outcome=allowed-once error=${j(result.error)} command=${j(command)}`);
          return { approved: true, outcome, error: result.error };
        }
        appendAudit(`session=${sessId} outcome=allowed-once exitCode=${result.exitCode} timedOut=${result.timedOut} highRisk=${highRisk} command=${j(command)}`);
        return {
          approved: true,
          outcome,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stdoutTruncated: result.stdoutTruncated,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        };
      });

    // ================= 系统提示段落：告诉 AI 何时/如何使用 =================
    const spService = ctx.get('systemPrompt');
    if (spService !== undefined && typeof spService.section === 'function') {
      try {
        spService.section({
          name: 'tool:sandbox-escape',
          order: 106,
          text: 'sandbox_escape 是唯一被允许的"跳出沙箱"通道：执行前必须先向用户提交审核，'
            + '用户同意后才以宿主权限运行，拒绝/取消/无人应答都不会执行。'
            + '高风险命令（删除/格式化/系统级操作等）需要用户连续两次同意，任一环节未同意都不执行。'
            + '只在沙箱确实挡路时使用（看到 [sandbox: file access denied ...] 标记、需要访问工作区外路径或系统级操作），'
            + '每次都要如实填写 reason；被拒绝后不得换说法重试同一条命令。'
            + '命令将被原样展示给用户审批，禁止用过长命令"淹没"审批框，也不得拆分绕过。',
        });
      } catch (e) { /* 提示段落失败不影响工具 */ }
    }

    console.log('[sandbox-escape] loaded: sandbox_escape / sandbox_status tools registered globally (approval-gated unconfined execution, high-risk = double confirm)');
  },
};
