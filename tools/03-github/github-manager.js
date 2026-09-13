// GitHub Manager — 全局宿主插件（写入 Host 组合，所有会话生效）
//
// 提供 13 个 gh_* 工具：Token 管理、仓库/Issue/PR/文件操作、任意 REST API、
// 以及从公开仓库下载文件（raw 文件 / 整仓 zip）到工作区。
//
// 实现要点：
//   - HTTP：通过 ctx.subprocess 启动 PowerShell（PS7 或 PS 5.1 兜底）执行
//     Invoke-WebRequest 调 GitHub REST API；Token 走环境变量、请求体走 stdin，
//     不进入命令行，避免泄露。
//   - Token：优先内存，其次凭据存储（credentials 服务，ref = GITHUB_TOKEN）。
//   - 工具：ctx.tools.register 直接注册（raw ToolDefinition），全局可见。
'use strict';

const path = require('path');

module.exports = {
  name: 'github-manager',

  inject: ['tools'],

  apply(ctx, config) {
    // ================= Token 存储 =================
    let memoryToken = null;
    const CRED_REF = 'GITHUB_TOKEN';

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

    const getCreds = () => ctx.get('credentials');

    async function persistToken(token) {
      const c = getCreds();
      if (c === undefined) return false;
      try { await c.set(CRED_REF, token); return true; } catch (e) { return false; }
    }

    async function clearPersistedToken() {
      const c = getCreds();
      if (c === undefined) return;
      try { await c.unset(CRED_REF); } catch (e) { /* ignore */ }
    }

    async function resolveToken() {
      if (memoryToken) return memoryToken;
      const c = getCreds();
      if (c !== undefined) {
        try {
          const r = await c.resolve(CRED_REF);
          if (r && r.value) return r.value;
        } catch (e) { /* ignore */ }
      }
      return null;
    }

    // ================= PowerShell 可执行文件解析（PS7 → PATH → PS 5.1 兜底）=================
    async function resolveShellExe() {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return null;
      for (const name of ['pwsh', 'powershell']) {
        try { return await sub.resolveExecutable(name); } catch (e) { /* try next */ }
      }
      const fs = ctx.get('fs');
      if (fs !== undefined) {
        const candidates = [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ];
        for (const candidate of candidates) {
          try {
            const target = await fs.resolve(candidate);
            const info = await fs.stat(target);
            if (info) return candidate;
          } catch (e) { /* try next */ }
        }
      }
      return null;
    }

    // 通用子进程执行：spawn PowerShell 脚本，返回解析后的 JSON envelope
    async function runShell(script, env, stdinData, signal) {
      const sub = ctx.get('subprocess');
      if (sub === undefined) return { _error: 'subprocess 服务不可用，无法执行。' };
      const shellPath = await resolveShellExe();
      if (!shellPath) return { _error: '未找到可用的 PowerShell（pwsh / powershell）。' };
      const sandbox = ctx.get('sandboxPolicy');
      const cwd = WS_ROOT;
      let handle;
      try {
        handle = sub.spawn({
          argv: [shellPath, '-NoProfile', '-NonInteractive', '-Command', script],
          cwd,
          stdio: {
            stdin: { data: stdinData || '' },
            stdout: { maxBytes: 8 * 1024 * 1024 },
            stderr: { maxBytes: 1024 * 1024 },
          },
          graceMs: 5000,
          signal,
          env,
        });
      } catch (e) {
        return { _error: '启动子进程失败：' + ((e && e.message) || String(e)) };
      }
      let outcome;
      try { outcome = await handle.done; }
      catch (e) { return { _error: '启动子进程失败：' + ((e && e.message) || String(e)) }; }
      const stdout = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : '';
      const stderr = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : '';
      if (outcome.exitCode !== 0) return { _error: stderr || '未知错误' };
      try { return JSON.parse(stdout); } catch (e) { return { _error: '无法解析子进程输出。' }; }
    }

    const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try {
  $body = [Console]::In.ReadToEnd()
  $headers = @{
    'User-Agent' = 'dsh-github-manager'
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  if (-not [string]::IsNullOrEmpty($env:GH_TOKEN)) {
    $headers.Authorization = ('Bearer ' + $env:GH_TOKEN)
  }
  $params = @{
    Uri = $env:GH_URL
    Method = $env:GH_METHOD
    Headers = $headers
    UseBasicParsing = $true
  }
  if ($body -ne '') {
    $params.Body = $body
    $params.ContentType = 'application/json; charset=utf-8'
  }
  $status = 0
  $content = ''
  $scopes = ''
  try {
    $resp = Invoke-WebRequest @params
    $status = [int]$resp.StatusCode
    if ($null -ne $resp.Content) { $content = [string]$resp.Content }
    try {
      if ($resp.Headers -ne $null) {
        $s = $resp.Headers['X-OAuth-Scopes']
        if ($s -ne $null) { $scopes = [string]$s }
      }
    } catch {}
  } catch {
    if ($_.Exception.Response -ne $null) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $content = $reader.ReadToEnd()
      } catch { $content = '' }
    } else {
      $content = $_.Exception.Message
    }
  }
  [pscustomobject]@{ status = $status; body = $content; scopes = $scopes } | ConvertTo-Json -Compress -Depth 100
} catch {
  [pscustomobject]@{ status = 0; body = $_.Exception.Message; scopes = '' } | ConvertTo-Json -Compress -Depth 100
}
`;

    const DOWNLOAD_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try {
  $dest = $env:GH_DEST
  $parent = Split-Path -Parent $dest
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Invoke-WebRequest -Uri $env:GH_URL -OutFile $dest -UseBasicParsing -MaximumRedirection 10
  $bytes = (Get-Item $dest).Length
  [pscustomobject]@{ ok = $true; saved_to = $dest; bytes = $bytes } | ConvertTo-Json -Compress -Depth 100
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 100
}
`;

    async function callGitHub(method, path, body, signal, allowAnon) {
      const token = await resolveToken();
      if (!token && !allowAnon) {
        return { status: 0, ok: false, error: '未设置 GitHub Token。请先运行 gh_set_token 并提供 GitHub Personal Access Token。' };
      }
      const env = {
        GH_TOKEN: token || '',
        GH_URL: 'https://api.github.com' + path,
        GH_METHOD: String(method || 'GET').toUpperCase(),
      };
      const r = await runShell(PS_SCRIPT, env, body === undefined || body === null ? '' : JSON.stringify(body), signal);
      if (r._error) return { status: 0, ok: false, error: r._error };
      let data = null;
      if (r.body !== undefined && r.body !== null && r.body !== '') {
        const raw = String(r.body).replace(/^\uFEFF/, '');
        try { data = JSON.parse(raw); } catch (e) { data = r.body; }
      }
      if (r.status >= 200 && r.status < 300) {
        const out = { status: r.status, ok: true, data };
        if (r.scopes) out.scopes = r.scopes;
        return out;
      }
      const msg = (data && data.message) || r.body || ('HTTP ' + r.status);
      return { status: r.status, ok: false, error: msg };
    }

    // ================= 工具注册 =================
    function reg(name, description, parameters, execute) {
      ctx.tools.register({
        name,
        description,
        parameters,
        output,
        timeoutMs: 120000,
        execute,
      });
    }

    // ================= 写操作审批网关（借鉴社区 dsh-git-auth 的 approveEscalation 思路，
    // 复用 sandbox-escape 的 approval.request 审批通道）=================
    // GitHub 写操作（创建/修改/删除远端资产）先向用户弹审批框；
    // 审批服务不可用或未获批准时 fail-closed，不执行写操作。
    const approval = ctx.get('approval');
    // 开关：默认启用写操作审批（fail-closed）。headless 等没有审批通道的环境，
    // 可在 patch 配置 requireApprovalForWrites: false 关闭（恢复增强前的放行行为）。
    const requireApprovalForWrites = config && config.requireApprovalForWrites !== false;
    async function requireWriteApproval(exec, toolName, description) {
      if (!requireApprovalForWrites) return 'allowed-once';
      if (approval === undefined) return 'approval-unavailable';
      if (!exec || !exec.agent) return 'no-agent';
      try {
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: String(toolName || 'github-manager'),
          callId: exec.callId,
          reason: 'GitHub 写操作审批（' + toolName + '）：' + description,
          ...(exec.signal ? { signal: exec.signal } : {}),
        });
        return outcome;
      } catch (e) {
        return 'error';
      }
    }
    const deniedWrite = (outcome, what) => ({
      status: 0, ok: false, approved: false, outcome,
      message: 'GitHub 写操作未获批准（' + outcome + '）' + (what ? '，未执行：' + what : '，未执行。'),
    });

    // Node 原生 btoa 只支持 Latin1；用 Buffer 实现 UTF-8 base64
    const b64encode = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const b64decode = (s) => Buffer.from(String(s), 'base64').toString('utf8');

    const enc = encodeURIComponent;
    const encPath = (s) => String(s).split('/').map(enc).join('/');
    const pick = (obj, keys) => {
      const out = {};
      for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
      return out;
    };
    const qs = (params) => {
      const parts = [];
      for (const k of Object.keys(params)) if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(enc(k) + '=' + enc(String(params[k])));
      return parts.length ? ('?' + parts.join('&')) : '';
    };
    const err = (message) => ({ status: 0, ok: false, error: message });
    const req = (args, name) => String(args[name] === undefined || args[name] === null ? '' : args[name]).trim();

    // ================= 工具列表 =================

    reg('gh_set_token',
      '保存 GitHub Personal Access Token（PAT）。使用任何 gh_* 工具前必须先调用一次。Token 保存在插件内存中，并尽可能持久化到系统凭据存储。',
      {
        type: 'object',
        properties: { token: { type: 'string', description: 'GitHub Personal Access Token，形如 ghp_xxx 或 github_pat_xxx' } },
        required: ['token'],
      },
      async (args) => {
        const token = req(args, 'token');
        if (!token) return err('token 不能为空。');
        memoryToken = token;
        const persisted = await persistToken(token);
        return { status: 0, ok: true, stored: true, persisted, hint: 'Token 已保存。可运行 gh_whoami 验证有效性。' };
      });

    reg('gh_clear_token',
      '清除已保存的 GitHub Token（内存与凭据存储）。',
      { type: 'object', properties: {} },
      async () => {
        memoryToken = null;
        await clearPersistedToken();
        return { status: 0, ok: true, cleared: true };
      });

    reg('gh_whoami',
      '用已保存的 Token 查询当前 GitHub 账号信息，验证 Token 是否有效，并返回该 Token 的 OAuth 权限范围（scopes）。',
      { type: 'object', properties: {} },
      async (args, exec) => {
        const r = await callGitHub('GET', '/user', null, exec.signal);
        if (!r.ok) return r;
        const out = { status: r.status, ok: true, login: r.data.login, name: r.data.name, html_url: r.data.html_url, id: r.data.id };
        if (r.scopes) out.scopes = r.scopes;
        return out;
      });

    reg('gh_api',
      '调用任意 GitHub REST API。path 为以 / 开头的 API 路径（如 /repos/octocat/Hello-World/issues）；body 为可选请求体。适用于所有 GitHub REST 端点，包括搜索（/search/repositories?q=关键词）。',
      {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP 方法，默认 GET' },
          path: { type: 'string', description: 'API 路径，必须以 / 开头，例如 /user/repos' },
          body: { type: 'object', description: '可选的请求体（JSON 对象），将作为 JSON 请求体发送' },
        },
        required: ['path'],
      },
      async (args, exec) => {
        const path = req(args, 'path');
        if (!path.startsWith('/')) return err('path 必须以 / 开头。');
        const method = String(args.method || 'GET').toUpperCase();
        if (method !== 'GET') {
          const bodyKeys = args.body && typeof args.body === 'object' ? Object.keys(args.body).join(',') : '';
          const ap = await requireWriteApproval(exec, 'gh_api', method + ' ' + path + (bodyKeys ? '  body 字段: ' + bodyKeys : ''));
          if (ap !== 'allowed-once') return deniedWrite(ap, method + ' ' + path);
        }
        const r = await callGitHub(method, path, args.body === undefined ? null : args.body, exec.signal);
        if (!r.ok) return r;
        return { status: r.status, ok: true, data: r.data };
      });

    reg('gh_list_repos',
      '列出仓库。不传 owner 时列出当前用户自己的仓库；传 owner 时列出该用户的公开仓库（可查他人）。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '用户名（可选）。省略时列出当前登录用户自己的仓库' },
          visibility: { type: 'string', enum: ['all', 'public', 'private'], description: '可见性过滤（仅当前用户有效），默认 all' },
          per_page: { type: 'integer', description: '每页数量 1-100，默认 30' },
        },
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const path = owner ? '/users/' + enc(owner) + '/repos' : '/user/repos';
        // 传 owner 时是公开仓库列表，允许匿名（无需 token）；自己的仓库列表需要 token
        const r = await callGitHub('GET', path + qs({ visibility: args.visibility, per_page: args.per_page }), null, exec.signal, !!owner);
        if (!r.ok) return r;
        const items = Array.isArray(r.data) ? r.data.map((it) => pick(it, ['name', 'full_name', 'html_url', 'private', 'description', 'fork', 'default_branch', 'updated_at'])) : [];
        return { status: r.status, ok: true, count: items.length, items };
      });

    reg('gh_create_repo',
      '在 GitHub 上创建新仓库（归当前登录用户所有）。注意：该操作会弹审批框，需用户确认后才会执行。',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: '仓库名（必填）' },
          description: { type: 'string', description: '仓库描述（可选）' },
          private: { type: 'boolean', description: '是否私有仓库，默认 false（公开）' },
          auto_init: { type: 'boolean', description: '是否自动初始化 README，默认 false' },
        },
        required: ['name'],
      },
      async (args, exec) => {
        const name = req(args, 'name');
        if (!name) return err('name 不能为空。');
        const ap = await requireWriteApproval(exec, 'gh_create_repo', '创建 GitHub 仓库 ' + name + (args.private ? '（私有）' : '（公开）'));
        if (ap !== 'allowed-once') return deniedWrite(ap, '创建仓库 ' + name);
        const r = await callGitHub('POST', '/user/repos', {
          name,
          description: args.description,
          private: args.private === true,
          auto_init: args.auto_init === true,
        }, exec.signal);
        if (!r.ok) return r;
        const d = r.data;
        return { status: r.status, ok: true, name: d.name, full_name: d.full_name, html_url: d.html_url, private: d.private, default_branch: d.default_branch };
      });

    reg('gh_list_issues',
      '列出仓库的 Issue（state=open 时也会包含未关闭的 Pull Request，结果中用 is_pr 区分）。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open' },
          per_page: { type: 'integer', description: '每页数量 1-100，默认 30' },
        },
        required: ['owner', 'repo'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        // 公开仓库 Issue 列表可匿名读取
        const r = await callGitHub('GET', '/repos/' + enc(owner) + '/' + enc(repo) + '/issues' + qs({ state: args.state || 'open', per_page: args.per_page }), null, exec.signal, true);
        if (!r.ok) return r;
        const items = Array.isArray(r.data) ? r.data.map((it) => ({
          number: it.number, title: it.title, state: it.state, html_url: it.html_url,
          user: it.user && it.user.login, created_at: it.created_at, is_pr: !!it.pull_request,
          labels: (it.labels || []).map((l) => l.name).filter(Boolean),
        })) : [];
        return { status: r.status, ok: true, count: items.length, items };
      });

    reg('gh_create_issue',
      '在仓库中创建 Issue。注意：该操作会弹审批框，需用户确认后才会执行。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          title: { type: 'string', description: 'Issue 标题（必填）' },
          body: { type: 'string', description: 'Issue 正文（可选）' },
        },
        required: ['owner', 'repo', 'title'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        const title = req(args, 'title');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        if (!title) return err('title 不能为空。');
        const ap = await requireWriteApproval(exec, 'gh_create_issue', '在 ' + owner + '/' + repo + ' 创建 Issue：「' + title.slice(0, 80) + '」');
        if (ap !== 'allowed-once') return deniedWrite(ap, '创建 Issue ' + title.slice(0, 80));
        const r = await callGitHub('POST', '/repos/' + enc(owner) + '/' + enc(repo) + '/issues', { title, body: args.body }, exec.signal);
        if (!r.ok) return r;
        const d = r.data;
        return { status: r.status, ok: true, number: d.number, title: d.title, state: d.state, html_url: d.html_url };
      });

    reg('gh_list_prs',
      '列出仓库的 Pull Request。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open' },
          per_page: { type: 'integer', description: '每页数量 1-100，默认 30' },
        },
        required: ['owner', 'repo'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        // 公开仓库 PR 列表可匿名读取
        const r = await callGitHub('GET', '/repos/' + enc(owner) + '/' + enc(repo) + '/pulls' + qs({ state: args.state || 'open', per_page: args.per_page }), null, exec.signal, true);
        if (!r.ok) return r;
        const items = Array.isArray(r.data) ? r.data.map((it) => ({
          number: it.number, title: it.title, state: it.state, html_url: it.html_url,
          user: it.user && it.user.login, created_at: it.created_at,
          head: it.head && it.head.ref, base: it.base && it.base.ref, draft: !!it.draft, merged: !!it.merged,
        })) : [];
        return { status: r.status, ok: true, count: items.length, items };
      });

    reg('gh_create_pr',
      '在仓库中创建 Pull Request。head 为源分支名，base 为目标分支名。注意：该操作会弹审批框，需用户确认后才会执行。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          title: { type: 'string', description: 'PR 标题（必填）' },
          head: { type: 'string', description: '源分支名（必填）' },
          base: { type: 'string', description: '目标分支名（必填），通常为 main 或 master' },
          body: { type: 'string', description: 'PR 描述（可选）' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        const title = req(args, 'title');
        const head = req(args, 'head');
        const base = req(args, 'base');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        if (!title || !head || !base) return err('title、head、base 不能为空。');
        const ap = await requireWriteApproval(exec, 'gh_create_pr', '在 ' + owner + '/' + repo + ' 创建 PR：' + head + ' -> ' + base + '「' + title.slice(0, 80) + '」');
        if (ap !== 'allowed-once') return deniedWrite(ap, '创建 PR ' + title.slice(0, 80));
        const r = await callGitHub('POST', '/repos/' + enc(owner) + '/' + enc(repo) + '/pulls', { title, head, base, body: args.body }, exec.signal);
        if (!r.ok) return r;
        const d = r.data;
        return { status: r.status, ok: true, number: d.number, title: d.title, state: d.state, html_url: d.html_url, merged: !!d.merged };
      });

    reg('gh_read_file',
      '读取仓库中某个文件的文本内容（GitHub Contents API），公开仓库无需登录权限也可读。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          path: { type: 'string', description: '文件路径，例如 src/main.js（必填）' },
          ref: { type: 'string', description: '分支名或 commit SHA（可选），默认默认分支' },
        },
        required: ['owner', 'repo', 'path'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        const path = req(args, 'path');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        if (!path) return err('path 不能为空。');
        // 公开仓库文件读取无需 token（匿名可读）
        const r = await callGitHub('GET', '/repos/' + enc(owner) + '/' + enc(repo) + '/contents/' + encPath(path) + qs({ ref: args.ref }), null, exec.signal, true);
        if (!r.ok) return r;
        let content = '';
        try { content = r.data && r.data.content ? b64decode(r.data.content) : ''; } catch (e) { content = '(内容解码失败)'; }
        // 大文件（>1MB）Contents API 不返回 content 字段，走 download_url 提示
        if (content === '' && r.data && r.data.size > 1024 * 1024) {
          return { status: r.status, ok: true, name: r.data.name, path: r.data.path, sha: r.data.sha, size: r.data.size,
            content: '', note: '文件超过 1MB，Contents API 不返回内容；请用 gh_download 下载该文件。' };
        }
        return { status: r.status, ok: true, name: r.data.name, path: r.data.path, sha: r.data.sha, size: r.data.size, content };
      });

    reg('gh_write_file',
      '通过 Contents API 写入/更新仓库文件并提交。更新已有文件时需提供 sha（用 gh_read_file 获取）。注意：该操作会弹审批框，需用户确认后才会执行。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          path: { type: 'string', description: '文件路径，例如 docs/README.md（必填）' },
          content: { type: 'string', description: '文件文本内容（必填）' },
          message: { type: 'string', description: '提交信息（必填）' },
          branch: { type: 'string', description: '目标分支（可选），默认默认分支' },
          sha: { type: 'string', description: '更新已有文件时必填：当前文件的 blob SHA（用 gh_read_file 获取）' },
        },
        required: ['owner', 'repo', 'path', 'content', 'message'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        const path = req(args, 'path');
        const content = String(args.content === undefined || args.content === null ? '' : args.content);
        const message = req(args, 'message');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        if (!path) return err('path 不能为空。');
        if (!message) return err('message 不能为空。');
        const ap = await requireWriteApproval(exec, 'gh_write_file', (args.sha ? '更新' : '写入') + ' ' + owner + '/' + repo + '/' + path + '（提交信息：' + message.slice(0, 80) + '）');
        if (ap !== 'allowed-once') return deniedWrite(ap, (args.sha ? '更新' : '写入') + ' ' + path);
        const body = { message, content: b64encode(content) };
        if (args.branch) body.branch = String(args.branch);
        if (args.sha) body.sha = String(args.sha);
        const r = await callGitHub('PUT', '/repos/' + enc(owner) + '/' + enc(repo) + '/contents/' + encPath(path), body, exec.signal);
        if (!r.ok) return r;
        const d = r.data;
        return { status: r.status, ok: true, path: d.content && d.content.path, commit_sha: d.commit && d.commit.sha, html_url: d.content && d.content.html_url };
      });

    reg('gh_download',
      '从公开仓库下载文件到本地工作区。传 path 时下载单个文件（raw，支持二进制）；不传 path 时下载整个仓库的 zip 压缩包。',
      {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者（必填）' },
          repo: { type: 'string', description: '仓库名（必填）' },
          path: { type: 'string', description: '文件路径，例如 README.md 或 images/logo.png；不传则下载整个仓库 zip' },
          ref: { type: 'string', description: '分支、tag 或 commit SHA（可选），默认默认分支' },
          dest: { type: 'string', description: '本地保存路径（可选，相对工作区；也可传绝对路径），默认自动生成到工作区 github-downloads/ 目录下' },
        },
        required: ['owner', 'repo'],
      },
      async (args, exec) => {
        const owner = req(args, 'owner');
        const repo = req(args, 'repo');
        if (!owner || !repo) return err('owner 和 repo 不能为空。');
        const filePath = req(args, 'path');
        const ref = req(args, 'ref');
        let url;
        let filename;
        if (filePath) {
          filename = filePath.split('/').pop() || 'file';
          let u = 'https://raw.githubusercontent.com/' + enc(owner) + '/' + enc(repo);
          if (ref) u += '/' + encPath(ref);
          u += '/' + encPath(filePath);
          url = u;
        } else {
          // 公开仓库元数据可匿名读取（无需 token）
          const meta = await callGitHub('GET', '/repos/' + enc(owner) + '/' + enc(repo), null, exec.signal, true);
          if (!meta.ok) return meta;
          const branch = ref || (meta.data && meta.data.default_branch) || 'main';
          filename = repo + '-' + branch + '.zip';
          url = 'https://codeload.github.com/' + enc(owner) + '/' + enc(repo) + '/zip/refs/heads/' + encPath(branch);
        }
        const dest = req(args, 'dest') || ('github-downloads/' + owner + '-' + repo + '/' + filename);
        // 归一化后再做工作区边界校验（path.isAbsolute 结果不归一，正斜杠绝对路径会被误拒，2026-09-13 修复）
        const absDest = path.resolve(path.isAbsolute(dest) ? dest : path.resolve(WS_ROOT, dest));
        // 安全：解析后的目标必须位于工作区内，禁止任意路径写（防止模型把文件下载到系统任意位置）。
        const wsRootNorm = path.resolve(WS_ROOT);
        if (!(absDest === wsRootNorm || absDest.startsWith(wsRootNorm + path.sep))) {
          return { status: 0, ok: false, error: 'dest 必须位于工作区内（' + WS_ROOT + '），已拒绝：' + absDest };
        }
        const r = await runShell(DOWNLOAD_SCRIPT, { GH_URL: url, GH_DEST: absDest }, '', exec.signal);
        if (r._error) return { status: 0, ok: false, error: r._error };
        if (!r.ok) return { status: 0, ok: false, error: r.error || '下载失败' };
        return { status: 200, ok: true, saved_to: r.saved_to, bytes: r.bytes, note: '已保存到工作区：' + r.saved_to };
      });

    console.log('[github-manager] loaded: 13 gh_* tools registered globally');
  },
};
