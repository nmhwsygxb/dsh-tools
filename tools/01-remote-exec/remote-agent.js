// Remote Agent — 全局宿主插件（所有会话生效）
//
// 提供 remote_exec 工具：在远程机器上执行命令（通过 remote-agent.js）。
// 远程机器需先运行 node remote-agent.js --port 3788。
// 安全（分级审批，2026-09-12）：
//   - 会话审批策略 never（完全访问模式）：remote_exec 直接执行（该模式语义=完全信任）。
//   - 策略 ask + 低危命令（非删除/格式化/系统级变更）：直接执行，免审批。
//   - 策略 ask + 高危命令（删除/格式化/系统级变更）：必须审批（approval.request，fail-closed），
//     未批准/审批不可用/无 agent 均拒绝执行。
//   - token 通过 X-Token Header 传递（不落 URL）。
//
// 实现要点：
//   - HTTP：通过 ctx.subprocess 启动 PowerShell 执行 Invoke-RestMethod
//     调远程 agent 的 GET /exec 端点，返回 JSON 结果。
//   - 配置：config.host / config.port / config.token 通过 patch 配置。
//   - 工具：ctx.tools.register 直接注册，全局可见。
'use strict';

module.exports = {
  name: 'remote-agent',

  inject: ['tools'],

  apply(ctx, config) {
    const HOST = (config && config.host) || process.env.REMOTE_AGENT_HOST || '127.0.0.1';
    const PORT = (config && config.port) || 3788;
    const TOKEN = (config && config.token) || process.env.REMOTE_AGENT_TOKEN || '';
    const BASE_URL = 'http://' + HOST + ':' + PORT;

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (!value) return [{ type: 'text', text: '无返回' }];
        if (value._error) return [{ type: 'text', text: '错误: ' + value._error }];
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    };

    async function resolveShellExe() {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return null;
      for (const name of ['pwsh', 'powershell']) {
        try { return await sub.resolveExecutable(name); } catch (e) { /* try next */ }
      }
      return null;
    }

    async function runShell(script, env, signal) {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return { _error: 'subprocess 服务不可用' };
      const shellPath = await resolveShellExe();
      if (!shellPath) return { _error: '未找到 PowerShell' };
      let handle;
      try {
        handle = sub.spawn({
          argv: [shellPath, '-NoProfile', '-NonInteractive', '-Command', script],
          cwd: '.',
          stdio: { stdin: { data: '' }, stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
          graceMs: 60000,
          signal,
          env,
        });
      } catch (e) {
        return { _error: '启动子进程失败: ' + ((e && e.message) || String(e)) };
      }
      let outcome;
      try { outcome = await handle.done; }
      catch (e) { return { _error: '执行失败: ' + ((e && e.message) || String(e)) }; }
      const stdout = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : '';
      const stderr = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : '';
      if (outcome.exitCode !== 0) return { _error: stderr || '退出码: ' + outcome.exitCode };
      try { return JSON.parse(stdout); } catch (e) { return { _error: '无法解析输出: ' + stdout.slice(0, 500) }; }
    }

    const PS_SCRIPT_TEMPLATE = (
  '\n' +
  '$ErrorActionPreference = \'Stop\'\n' +
  'try {\n' +
  '  $url = $env:REMOTE_URL\n' +
  '  $headers = @{ "X-Token" = $env:REMOTE_TOKEN }\n' +
  '  $result = Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 120\n' +
  '  if ($result -is [string]) { Write-Host $result } else { $result | ConvertTo-Json -Depth 10 -Compress | Write-Host }\n' +
  '} catch {\n' +
  '  $code = 0; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}\n' +
  '  $msg = $_.Exception.Message\n' +
  '  @{ _error = ("HTTP " + $code + ": " + $msg) } | ConvertTo-Json -Compress | Write-Host\n' +
  '}\n'
);

    // 高危命令关键词（命中任一 → 必须审批）。覆盖删除/格式化/系统级变更。
    // 未命中 → 低危命令，正常模式下免审批直接执行。
    const HIGH_RISK_RE = new RegExp(
      '\\b(del|erase|rm|rmdir|rd|format|diskpart|shutdown|restart-computer|stop-computer|bcdedit|taskkill)\\b' +
      '|\\b(Remove-Item|Remove-ItemProperty|Clear-Item|Clear-Content|Delete-Item|Remove-ChildItem)\\b' +
      '|\\b(sc\\s+delete|schtasks\\s+/delete|reg\\s+delete|net\\s+(stop|start)|vssadmin\\s+delete|mountvol\\s+\\S+\\s+/d)\\b',
      'i');

    function isHighRisk(command) {
      return HIGH_RISK_RE.test(String(command || ''));
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

    reg('remote_exec',
      '在远程机器上执行命令。远程机器需先运行 remote-agent-server.js（见本工具目录）。' +
      '审批规则：删除/格式化/系统级变更等高危命令必须审批（未批准不执行）；普通命令直接执行；' +
      '会话审批策略为 never（完全访问模式）时全部直接执行。',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在远程机器上执行的命令（必填）' },
        },
        required: ['command'],
      },
      async (args, { signal, agent, callId }) => {
        if (!args.command) return { _error: 'command 必填' };
        // 分级审批：
        //  - 会话策略 never（danger-full-access 完全访问模式）：直接执行（该模式语义=完全信任，无审批）
        //  - 策略 ask + 低危命令（非删除/格式化/系统级）：直接执行（免审批）
        //  - 策略 ask + 高危命令：必须审批（fail-closed，未批准不执行）
        const approval = ctx.get('approval');
        let policy = 'ask';
        if (approval && agent && typeof approval.effectivePolicy === 'function') {
          try { policy = approval.effectivePolicy(agent.session) || 'ask'; } catch (e) { /* 默认 ask */ }
        }
        const highRisk = isHighRisk(args.command);
        if (policy !== 'never' && highRisk) {
          if (approval === undefined) return { _error: '审批服务不可用（fail-closed），高危命令被拒绝。' };
          if (!agent) return { _error: '无法定位发起调用的 agent，高危命令被拒绝。' };
          let outcome;
          try {
            outcome = await approval.request({
              agent,
              toolName: 'remote_exec',
              callId,
              reason: '在远程机器 ' + HOST + ':' + PORT + ' 上执行【高危命令】（删除/格式化/系统级变更，需审批，未批准不执行）。\n命令：' + String(args.command),
              ...(signal ? { signal } : {}),
            });
          } catch (e) {
            return { _error: '审批请求失败（fail-closed），未执行：' + ((e && e.message) || String(e)) };
          }
          if (outcome !== 'allowed-once') return { _error: '高危命令未获批准（' + outcome + '），未执行。' };
        }
        const url = BASE_URL + '/exec?command=' + encodeURIComponent(String(args.command));
        const env = { REMOTE_URL: url, REMOTE_TOKEN: TOKEN };
        return await runShell(PS_SCRIPT_TEMPLATE, env, signal);
      });

    reg('remote_info',
      '查看远程机器系统信息（IP、主机名、Node 版本）。',
      { type: 'object', properties: {} },
      async (args, { signal }) => {
        const env = { REMOTE_URL: BASE_URL + '/info', REMOTE_TOKEN: TOKEN };
        return await runShell(PS_SCRIPT_TEMPLATE, env, signal);
      });

    reg('remote_ping',
      '检查远程机器连接状态。',
      { type: 'object', properties: {} },
      async (args, { signal }) => {
        const env = { REMOTE_URL: BASE_URL + '/ping', REMOTE_TOKEN: TOKEN };
        return await runShell(PS_SCRIPT_TEMPLATE, env, signal);
      });

    console.log('[remote-agent] loaded: 3 tools registered globally (host=' + HOST + ':' + PORT + ', exec=approval-gated)');
  },
};