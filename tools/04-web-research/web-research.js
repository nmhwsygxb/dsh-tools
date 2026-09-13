// Web Research — 全局宿主插件（写入 Host 组合，所有会话生效）
//
// 功能：查看/搜索各大技术网站与论文网站、抓取网页正文、下载文件到工作区。
//
// 提供 5 个 wr_* 工具：
//   wr_search       通用网站搜索（DuckDuckGo HTML 端点，免登录）
//   wr_paper_search 论文搜索（arXiv / Semantic Scholar / Crossref / PubMed / DBLP 官方公开 API，全部免登录）
//   wr_fetch        抓取网页正文为纯文本（登录墙页面返回明确提示，不做攻击性绕过）
//   wr_download     下载任意 URL 文件到工作区（支持二进制）
//   wr_paper_pdf    按 arXiv ID / DOI / 标题查找论文开放获取 PDF，并可下载到工作区
//
// 登录/付费墙处理原则（合法边界）：
//   - 只使用各网站的官方公开 API 与公开端点，不实现任何破解、绕过验证码、
//     凭据填充或抓取需要登录的私有内容。
//   - 论文优先走开放获取渠道（arXiv 预印本、Semantic Scholar openAccessPdf、
//     作者公开版本）；确实无公开版本的付费论文，返回明确提示而非攻击。
//
// 实现要点（与 github-manager.js 同构）：
//   - HTTP：通过 ctx.subprocess 启动 PowerShell（PS7 → PS 5.1 兜底）执行
//     Invoke-WebRequest；TLS12、UTF-8、自定义 UA。
//   - 工具：ctx.tools.register 直接注册（raw ToolDefinition），全局可见。
//   - 下载：Invoke-WebRequest -OutFile 保存到工作区（WS_ROOT 为 cwd，patch 配置
//     config.workspaceRoot 优先，否则 sandboxPolicy.workspaceRoot，最后 process.cwd()）。
'use strict';

module.exports = {
  name: 'web-research',

  inject: ['tools'],

  apply(ctx, config) {
    // ================= 工作区根解析 =================
    // 组合插件拿不到会话 cwd；sandboxPolicy.workspaceRoot 是 dsh 进程启动目录，
    // 可能不是会话工作区（实测会落到桌面）。所以优先 patch 配置 config.workspaceRoot，
    // 其次 sandboxPolicy.workspaceRoot，最后 process.cwd()。
    const pathMod = require('path');
    const sandbox0 = ctx.get('sandboxPolicy');
    const WS_ROOT = config && config.workspaceRoot
      ? pathMod.resolve(String(config.workspaceRoot))
      : (sandbox0 && sandbox0.workspaceRoot ? sandbox0.workspaceRoot : process.cwd());

    // ================= 通用输出渲染 =================
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
      const cwd = WS_ROOT;
      let handle;
      try {
        handle = sub.spawn({
          argv: [shellPath, '-NoProfile', '-NonInteractive', '-Command', script],
          cwd,
          stdio: {
            stdin: { data: stdinData || '' },
            stdout: { maxBytes: 64 * 1024 * 1024 },
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

    // ================= HTTP GET（返回 {status, body}，非 2xx 也解析返回）=================
    const HTTP_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  $headers = @{ 'User-Agent' = $env:WR_UA }
  if ($env:WR_ACCEPT) { $headers['Accept'] = $env:WR_ACCEPT }
  $params = @{
    Uri = $env:WR_URL
    Headers = $headers
    UseBasicParsing = $true
    MaximumRedirection = 10
  }
  if ($env:WR_METHOD) { $params.Method = $env:WR_METHOD }
  $status = 0
  $content = ''
  try {
    $resp = Invoke-WebRequest @params
    $status = [int]$resp.StatusCode
    if ($null -ne $resp.Content) {
      $content = [string]$resp.Content
      # PS 5.1 的 Invoke-WebRequest 按 Latin-1 解码响应，无 charset 的中文网页会乱码；
      # 用原始字节按 UTF-8 重新解码。
      if ($PSVersionTable.PSVersion.Major -lt 7) {
        try {
          $bytes = $resp.RawContentStream.ToArray()
          $content = [System.Text.Encoding]::UTF8.GetString($bytes)
        } catch { }
      }
    }
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
  [pscustomobject]@{ status = $status; body = $content } | ConvertTo-Json -Compress -Depth 100
} catch {
  [pscustomobject]@{ status = 0; body = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 100
}
`;

    // ================= 文件下载（保存到工作区）=================
    // 2026-09 性能修复：优先用 curl.exe（原生 C 实现，实测比 Invoke-WebRequest 快约 17 倍：
    // 50MB 文件 IWR 413s / 0.12 MB/s vs curl 24s / 2 MB/s）。
    // 失败或 curl 不可用时回退 Invoke-WebRequest。Windows 10 1803+ 自带 curl.exe。
    const DOWNLOAD_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try {
  $dest = $env:WR_DEST
  $parent = Split-Path -Parent $dest
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $downloaded = $false
  $curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue)
  if ($curlExe) {
    try {
      & $curlExe.Source -L -sS -A $env:WR_UA --max-time 600 --connect-timeout 30 -o $dest $env:WR_URL 2>$null
      $downloaded = ($LASTEXITCODE -eq 0) -and (Test-Path $dest)
    } catch { $downloaded = $false }
  }
  if (-not $downloaded) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -Uri $env:WR_URL -OutFile $dest -UseBasicParsing -MaximumRedirection 10 -Headers @{ 'User-Agent' = $env:WR_UA }
  }
  $bytes = (Get-Item $dest).Length
  [pscustomobject]@{ ok = $true; saved_to = $dest; bytes = $bytes } | ConvertTo-Json -Compress -Depth 100
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 100
}
`;

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-web-research/1.0';

    async function httpGet(url, accept, signal) {
      const r = await runShell(HTTP_SCRIPT, {
        WR_URL: url,
        WR_ACCEPT: accept || '',
        WR_METHOD: 'GET',
        WR_UA: UA,
      }, '', signal);
      if (r._error) return { status: 0, ok: false, error: r._error };
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.body };
    }

    // 带重试的 GET：Semantic Scholar 无 key 时共享配额常返回 429，等待后重试一次
    async function httpGetWithRetry(url, accept, signal) {
      let r = await httpGet(url, accept, signal);
      if (r.status === 429) {
        const timer = ctx.get('timer');
        if (timer !== undefined) {
          try { await timer.timeout(4000); } catch (e) { /* ignore */ }
        }
        r = await httpGet(url, accept, signal);
      }
      return r;
    }

    async function download(url, dest, signal) {
      const r = await runShell(DOWNLOAD_SCRIPT, {
        WR_URL: url,
        WR_DEST: dest,
        WR_UA: UA,
      }, '', signal);
      if (r._error) return { status: 0, ok: false, error: r._error };
      if (!r.ok) return { status: 0, ok: false, error: r.error || '下载失败' };
      return { status: 200, ok: true, saved_to: r.saved_to, bytes: r.bytes };
    }

    // ================= 工具注册辅助 =================
    function reg(name, description, parameters, execute) {
      ctx.tools.register({
        name,
        description,
        parameters,
        output,
        timeoutMs: 300000,
        execute,
      });
    }

    const enc = encodeURIComponent;
    // DOI 专用编码：保留 DOI 合法字符（含 / 与 .），只编码空白与不安全字符。
    // 不能用 enc()，否则 10.48550/arXiv.xxx 的斜杠被编码成 %2F 会导致 API 404。
    const encDoi = (doi) => String(doi).replace(/[^A-Za-z0-9.\/\-_()]/g, (c) => encodeURIComponent(c));
    const req = (args, name) => String(args[name] === undefined || args[name] === null ? '' : args[name]).trim();
    const clamp = (v, lo, hi) => { const n = Number(v); if (!isFinite(n)) return lo; return Math.min(hi, Math.max(lo, Math.floor(n))); };
    const err = (message) => ({ status: 0, ok: false, error: message });

    // 校验下载目标路径：规范化后必须留在工作区内，拒绝 .. 逃逸与绝对路径。
    function validateDest(dest) {
      const s = String(dest || '').replace(/\\/g, '/').trim();
      if (!s) return { ok: false, error: 'dest 不能为空。' };
      if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return { ok: false, error: 'dest 必须是相对工作区的路径。' };
      const segments = s.split('/');
      for (const seg of segments) {
        if (seg === '..') return { ok: false, error: 'dest 不能包含 ..（不允许逃出工作区）。' };
      }
      return { ok: true, dest: s };
    }

    // ---------- 文本工具 ----------
    function decodeEntities(s) {
      return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return m; } });
    }

    function htmlToText(html, maxChars) {
      let s = String(html || '');
      s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
      s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
      s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
      s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
      s = s.replace(/<!--[\s\S]*?-->/g, ' ');
      s = s.replace(/<[^>]+>/g, ' ');
      s = decodeEntities(s);
      s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
      const limit = clamp(maxChars || 20000, 1000, 200000);
      if (s.length > limit) s = s.slice(0, limit) + '\n…（已截断）';
      return s;
    }

    function stripTags(s) {
      return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    }

    function parseJsonLoose(body) {
      if (!body) return null;
      try { return JSON.parse(body); } catch (e) { return null; }
    }

    // ---------- arXiv Atom XML 解析（免登录公开 API）----------
    function parseArxivEntries(xml) {
      const out = [];
      const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = entryRe.exec(String(xml))) !== null) {
        const e = m[1];
        const title = stripTags((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
        const summary = stripTags((e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '');
        const published = stripTags((e.match(/<published[^>]*>([\s\S]*?)<\/published>/) || [])[1] || '');
        const id = stripTags((e.match(/<id[^>]*>([\s\S]*?)<\/id>/) || [])[1] || '');
        const authors = [];
        const authorRe = /<author>([\s\S]*?)<\/author>/g;
        let am;
        while ((am = authorRe.exec(e)) !== null) {
          const nm = stripTags((am[1].match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || '');
          if (nm) authors.push(nm);
        }
        const links = [];
        const linkRe = /<link[^>]*>/g;
        let lm;
        while ((lm = linkRe.exec(e)) !== null) {
          const href = (lm[0].match(/href="([^"]*)"/) || [])[1] || '';
          const rel = (lm[0].match(/rel="([^"]*)"/) || [])[1] || '';
          const ltitle = (lm[0].match(/title="([^"]*)"/) || [])[1] || '';
          if (href && (rel === 'alternate' || rel === 'related')) links.push({ rel, href, title: ltitle });
        }
        const absUrl = links.find((l) => l.rel === 'alternate');
        // PDF 链接：优先 rel=related 且 title=pdf 的，其次任一 related
        const pdfLink = links.find((l) => l.rel === 'related' && l.title === 'pdf') || links.find((l) => l.rel === 'related');
        const pdfUrl = pdfLink ? pdfLink.href : '';
        const arxivId = (id.match(/arxiv\.org\/abs\/([^\/\s]+)/) || [])[1] || '';
        out.push({
          title,
          authors,
          published: published.slice(0, 10),
          arxiv_id: arxivId,
          url: absUrl ? absUrl.href : id,
          pdf_url: pdfUrl || (arxivId ? 'https://arxiv.org/pdf/' + arxivId : ''),
          summary: summary.slice(0, 600),
        });
      }
      return out;
    }

    // ================= 工具 1：wr_search 通用网站搜索 =================
    reg('wr_search',
      '通用网站搜索（DuckDuckGo HTML 端点，无需登录）。返回标题、URL 与摘要。适合查技术文章、文档、论坛、代码片段等公开网页内容。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（必填）' },
          max_results: { type: 'integer', description: '返回条数，1-20，默认 8' },
        },
        required: ['query'],
      },
      async (args, exec) => {
        const query = req(args, 'query');
        if (!query) return err('query 不能为空。');
        const max = clamp(args.max_results || 8, 1, 20);

        // 从 DuckDuckGo HTML 中解析结果（属性顺序无关）
        function parseDdg(html) {
          const items = [];
          const blockRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
          const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          const blocks = [];
          let bm;
          while ((bm = blockRe.exec(html)) !== null) {
            const href = (bm[0].match(/href="([^"]*)"/) || [])[1] || '';
            if (href) blocks.push({ href, title: bm[1] });
          }
          const snips = [];
          let sm;
          while ((sm = snipRe.exec(html)) !== null) snips.push(stripTags(sm[1]));
          for (let i = 0; i < blocks.length && items.length < max; i++) {
            let href = blocks[i].href;
            // DuckDuckGo 重定向链接解码
            const uddg = (href.match(/[?&]uddg=([^&]+)/) || [])[1];
            if (uddg) {
              try { href = decodeURIComponent(uddg); } catch (e) { /* keep */ }
            } else if (/^\/\//.test(href)) {
              href = 'https:' + href;
            }
            const title = stripTags(blocks[i].title);
            const snippet = snips[i] || '';
            if (title) items.push({ title, url: href, snippet });
          }
          return items;
        }

        // 主端点：html.duckduckgo.com
        let r = await httpGet('https://html.duckduckgo.com/html/?q=' + enc(query), 'text/html', exec.signal);
        let engine = 'duckduckgo';
        let items = r.ok ? parseDdg(String(r.body || '')) : [];
        // 后备 1：lite 端点（主端点 403/失败时），结构不同，单独解析
        if (!items.length && !r.ok) {
          const lite = await httpGet('https://lite.duckduckgo.com/lite/?q=' + enc(query), 'text/html', exec.signal);
          if (lite.ok) {
            engine = 'duckduckgo-lite';
            const html = String(lite.body || '');
            const liteItems = [];
            const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
            let lm;
            while ((lm = linkRe.exec(html)) !== null && liteItems.length < max) {
              let href = lm[1];
              const uddg = (href.match(/[?&]uddg=([^&]+)/) || [])[1];
              if (uddg) { try { href = decodeURIComponent(uddg); } catch (e) { /* keep */ } }
              else if (/^\/\//.test(href)) href = 'https:' + href;
              const title = stripTags(lm[2]);
              if (title) liteItems.push({ title, url: href, snippet: '' });
            }
            items = liteItems;
          }
        }
        // 后备 2：Bing（DuckDuckGo 域名被屏蔽/超时时仍可用）
        if (!items.length) {
          const bing = await httpGet('https://www.bing.com/search?q=' + enc(query) + '&count=' + max, 'text/html', exec.signal);
          if (bing.ok) {
            engine = 'bing';
            const html = String(bing.body || '');
            const bingItems = [];
            const h2Re = /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
            let hm;
            while ((hm = h2Re.exec(html)) !== null && bingItems.length < max) {
              let href = hm[1];
              // Bing 重定向链接（/ck/a?...）解码：u=a1 后是 base64url 编码的真实 URL
              // （不是 percent-encoding，decodeURIComponent 解不出，2026-09-13 修复）
              const ck = (href.match(/[?&]u=a1([^&]*)&/) || [])[1];
              if (ck) {
                try {
                  const b64 = ck.replace(/-/g, '+').replace(/_/g, '/');
                  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
                  const decoded = Buffer.from(padded, 'base64').toString('utf8');
                  if (/^https?:\/\//.test(decoded)) href = decoded;
                } catch (e) { /* keep original */ }
              }
              else if (/^\/\//.test(href)) href = 'https:' + href;
              const title = stripTags(hm[2]);
              if (title && href.startsWith('http')) bingItems.push({ title, url: href, snippet: '' });
            }
            items = bingItems;
          }
        }
        if (!items.length) {
          const st = r.ok ? 0 : r.status;
          return { status: st, ok: false, error: '搜索请求失败：DuckDuckGo 与 Bing 均未返回结果（网络受限或 HTTP ' + st + '），请稍后重试。' };
        }
        return { status: 200, ok: true, engine, count: items.length, items };
      });

    // ================= 工具 2：wr_paper_search 论文搜索 =================
    reg('wr_paper_search',
      '论文搜索。接入 5 个官方公开 API（全部免登录）：arxiv（预印本）、semanticscholar（语义学者，含引用数/开放获取 PDF）、crossref（DOI 元数据）、pubmed（生物医学）、dblp（计算机科学）。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（必填），如 "attention is all you need"' },
          source: { type: 'string', enum: ['arxiv', 'semanticscholar', 'crossref', 'pubmed', 'dblp'], description: '数据源，默认 arxiv' },
          max_results: { type: 'integer', description: '返回条数，1-20，默认 8' },
        },
        required: ['query'],
      },
      async (args, exec) => {
        const query = req(args, 'query');
        if (!query) return err('query 不能为空。');
        const source = req(args, 'source') || 'arxiv';
        const max = clamp(args.max_results || 8, 1, 20);
        try {
          if (source === 'arxiv') {
            // arXiv API 搜索语法：多词短语用引号包裹更准确
            const r = await httpGet('https://export.arxiv.org/api/query?search_query=all:%22' + enc(query) + '%22&start=0&max_results=' + max, 'application/atom+xml', exec.signal);
            if (!r.ok) return { status: r.status, ok: false, error: 'arXiv API 请求失败（HTTP ' + r.status + '）。' };
            const items = parseArxivEntries(r.body);
            return { status: 200, ok: true, source: 'arxiv', count: items.length, items };
          }
          if (source === 'semanticscholar') {
            const r = await httpGetWithRetry('https://api.semanticscholar.org/graph/v1/paper/search?query=' + enc(query) + '&limit=' + max + '&fields=title,authors,year,venue,abstract,url,openAccessPdf,externalIds,citationCount,publicationDate', 'application/json', exec.signal);
            if (!r.ok) return { status: r.status, ok: false, error: 'Semantic Scholar API 请求失败（HTTP ' + r.status + '）。' + (r.status === 429 ? '无 API key 的共享配额已限流，请稍后重试，或改用 arxiv/crossref/pubmed/dblp 数据源。' : '') };
            const data = parseJsonLoose(r.body);
            const items = (data && Array.isArray(data.data) ? data.data : []).slice(0, max).map((p) => ({
              title: p.title,
              authors: (p.authors || []).map((a) => a.name),
              year: p.year,
              venue: p.venue,
              publication_date: p.publicationDate,
              citation_count: p.citationCount,
              url: p.url,
              pdf_url: p.openAccessPdf && p.openAccessPdf.url ? p.openAccessPdf.url : null,
              doi: p.externalIds && p.externalIds.DOI ? p.externalIds.DOI : null,
              arxiv_id: p.externalIds && p.externalIds.ArXiv ? p.externalIds.ArXiv : null,
              abstract: p.abstract ? p.abstract.slice(0, 600) : null,
            }));
            return { status: 200, ok: true, source: 'semanticscholar', count: items.length, items };
          }
          if (source === 'crossref') {
            const r = await httpGet('https://api.crossref.org/works?query=' + enc(query) + '&rows=' + max + '&select=DOI,title,author,issued,container-title,URL,is-referenced-by-count,abstract', 'application/json', exec.signal);
            if (!r.ok) return { status: r.status, ok: false, error: 'Crossref API 请求失败（HTTP ' + r.status + '）。' };
            const data = parseJsonLoose(r.body);
            const items = (data && data.message && Array.isArray(data.message.items) ? data.message.items : []).slice(0, max).map((p) => ({
              title: (p.title || [''])[0],
              authors: (p.author || []).map((a) => (a.given ? a.given + ' ' : '') + (a.family || '')),
              year: p.issued && p.issued['date-parts'] && p.issued['date-parts'][0] ? p.issued['date-parts'][0][0] : null,
              venue: (p['container-title'] || [''])[0],
              doi: p.DOI,
              citation_count: p['is-referenced-by-count'],
              url: p.URL,
              abstract: p.abstract ? htmlToText(p.abstract, 600) : null,
            }));
            return { status: 200, ok: true, source: 'crossref', count: items.length, items };
          }
          if (source === 'pubmed') {
            const es = await httpGet('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=' + enc(query) + '&retmax=' + max + '&retmode=json&sort=relevance', 'application/json', exec.signal);
            if (!es.ok) return { status: es.status, ok: false, error: 'PubMed E-utilities 请求失败（HTTP ' + es.status + '）。' };
            const esData = parseJsonLoose(es.body);
            const ids = (esData && esData.esearchresult && esData.esearchresult.idlist) || [];
            if (!ids.length) return { status: 200, ok: true, source: 'pubmed', count: 0, items: [] };
            const su = await httpGet('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=' + ids.join(',') + '&retmode=json', 'application/json', exec.signal);
            if (!su.ok) return { status: su.status, ok: false, error: 'PubMed 摘要请求失败（HTTP ' + su.status + '）。' };
            const suData = parseJsonLoose(su.body);
            const result = (suData && suData.result) || {};
            const items = ids.map((id) => {
              const p = result[id] || {};
              return {
                title: p.title,
                authors: (p.authors || []).map((a) => a.name),
                year: p.pubdate ? p.pubdate.slice(0, 4) : null,
                journal: p.fulljournalname || p.source,
                pmid: id,
                url: p.elocationid && String(p.elocationid).startsWith('http') ? p.elocationid : ('https://pubmed.ncbi.nlm.nih.gov/' + id + '/'),
                doi: (p.articleids || []).find((x) => x.idtype === 'doi') ? (p.articleids.find((x) => x.idtype === 'doi').value) : null,
                abstract: null,
              };
            });
            return { status: 200, ok: true, source: 'pubmed', count: items.length, items };
          }
          if (source === 'dblp') {
            const r = await httpGet('https://dblp.org/search/publ/api?q=' + enc(query) + '&format=json&h=' + max, 'application/json', exec.signal);
            if (!r.ok) return { status: r.status, ok: false, error: 'DBLP API 请求失败（HTTP ' + r.status + '）。' };
            const data = parseJsonLoose(r.body);
            // DBLP 单条结果时 hit 是对象而非数组
            const rawHits = data && data.result && data.result.hits ? data.result.hits.hit : null;
            const hits = Array.isArray(rawHits) ? rawHits : (rawHits ? [rawHits] : []);
            const items = hits.slice(0, max).map((h) => {
              const p = h.info || {};
              return {
                title: p.title,
                authors: Array.isArray(p.authors) ? p.authors.map((a) => (a && a.text) || '') : (p.authors && p.authors.text ? [p.authors.text] : []),
                year: p.year,
                venue: p.venue,
                url: p.ee || p.url,
                doi: p.doi || null,
                type: p.type,
              };
            });
            return { status: 200, ok: true, source: 'dblp', count: items.length, items };
          }
          return err('未知数据源：' + source);
        } catch (e) {
          return { status: 0, ok: false, error: '搜索失败：' + ((e && e.message) || String(e)) };
        }
      });

    // ================= 工具 3：wr_fetch 抓取网页正文 =================
    reg('wr_fetch',
      '抓取一个网页并提取正文纯文本。适合阅读技术博客、文档页、论文摘要页等公开页面。若页面需要登录或处于验证墙后（如 401/403、登录跳转、新浪访客系统等），会返回明确提示；本工具不做攻击性登录绕过。',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 URL（必填），如 https://developer.mozilla.org/zh-CN/docs/Web/API/fetch' },
          max_chars: { type: 'integer', description: '返回正文最大字符数，1000-200000，默认 20000' },
        },
        required: ['url'],
      },
      async (args, exec) => {
        const url = req(args, 'url');
        if (!url) return err('url 不能为空。');
        if (!/^https?:\/\//i.test(url)) return err('url 必须以 http:// 或 https:// 开头。');
        const r = await httpGet(url, 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', exec.signal);
        const body = String(r.body || '');
        const lower = body.toLowerCase();

        // 登录/验证墙特征检测。分两级：
        //  - STRONG：几乎专属于验证墙/登录墙的结构特征（访客系统、验证码、
        //    反爬标记、明确要求"登录后查看"），200 响应也据此判定。
        //  - WEAK：导航栏常见词（login/登录/sign in），正常网站也有，仅辅助
        //    非 200 响应的判定，避免把 arXiv 等含登录按钮的正常页面误报。
        const strongLogin =
          /(sina\s*visitor|visitor\s*system|访客系统|passport\.|安全验证|滑动验证|verify\s*you\s*are\s*human|captcha|zh-zse-ck|请登录后|登录后查看|登录后继续|登录后才能|请先登录)/i.test(lower);
        const weakLogin = /(sign\s*in|log\s*in|login|请登录|登录|验证码)/i.test(lower);

        if (!r.ok) {
          return {
            status: r.status,
            ok: false,
            error: '请求失败（HTTP ' + r.status + '）。' + (r.status === 401 || r.status === 403 ? '该页面需要登录或访问受限，公开端点无法获取内容；请改用官方公开 API 或向用户索取授权凭据。' : ''),
            login_required: r.status === 401 || r.status === 403 || strongLogin || weakLogin,
          };
        }

        // HTTP 200 但页面实际是登录/验证墙（如微博 Sina Visitor System）：不返回无用正文
        if (strongLogin) {
          return {
            status: 200,
            ok: false,
            error: '该页面返回了登录/验证墙内容（检测到访客验证或登录墙特征），未提取到有效正文；公开端点无法获取，请改用官方公开 API 或向用户索取授权凭据。',
            login_required: true,
          };
        }

        const text = htmlToText(body, clamp(args.max_chars || 20000, 1000, 200000));
        return { status: 200, ok: true, url, chars: text.length, text };
      });

    // ================= 工具 4：wr_download 下载文件到工作区 =================
    reg('wr_download',
      '下载任意 URL 的文件到工作区（支持二进制，如 PDF/zip/图片/源码包）。dest 为相对工作区的路径（如 downloads/xxx.pdf），默认存到 downloads/<文件名>。',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件 URL（必填）' },
          dest: { type: 'string', description: '保存路径（相对工作区），如 downloads/paper.pdf；默认 downloads/<文件名>' },
        },
        required: ['url'],
      },
      async (args, exec) => {
        const url = req(args, 'url');
        if (!url) return err('url 不能为空。');
        if (!/^https?:\/\//i.test(url)) return err('url 必须以 http:// 或 https:// 开头。');
        const clean = url.split(/[?#]/)[0].replace(/\/+$/, '');
        const filename = clean.split('/').pop() || 'download.bin';
        const safeName = filename.replace(/[\\/:*?"<>|]/g, '_');
        const rawDest = req(args, 'dest') || ('downloads/' + safeName);
        const vd = validateDest(rawDest);
        if (!vd.ok) return err(vd.error);
        const dest = vd.dest;
        const r = await download(url, dest, exec.signal);
        if (!r.ok) return { status: 0, ok: false, error: r.error || '下载失败' };
        return { status: 200, ok: true, saved_to: r.saved_to, bytes: r.bytes, note: '已保存到工作区：' + r.saved_to };
      });

    // ================= 工具 5：wr_paper_pdf 查找论文开放获取 PDF =================
    reg('wr_paper_pdf',
      '按 arXiv ID、DOI 或标题查找论文的开放获取（OA）PDF，并可下载到工作区 downloads/papers/。优先 arXiv 官方 PDF；DOI/标题走 Semantic Scholar 开放获取字段。付费论文若无公开版本会明确告知（不做攻击性绕过）。',
      {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv 编号，如 1706.03762（可选）' },
          doi: { type: 'string', description: 'DOI，如 10.48550/arXiv.1706.03762（可选）' },
          title: { type: 'string', description: '论文标题关键词（可选，用于模糊查找）' },
          download: { type: 'boolean', description: '是否下载 PDF 到工作区 downloads/papers/，默认 false（只返回链接）' },
        },
      },
      async (args, exec) => {
        const arxivId = req(args, 'arxiv_id');
        const doi = req(args, 'doi');
        const title = req(args, 'title');
        if (!arxivId && !doi && !title) return err('请至少提供 arxiv_id、doi 或 title 之一。');
        const wantDownload = args.download === true;
        let info = null;

        try {
          // 1) arXiv ID：直接构造官方 PDF 链接（公开）
          if (arxivId) {
            const cleanId = arxivId.replace(/^arXiv:/i, '').trim();
            const pdfUrl = 'https://arxiv.org/pdf/' + cleanId;
            const meta = await httpGet('https://export.arxiv.org/api/query?id_list=' + enc(cleanId), 'application/atom+xml', exec.signal);
            if (!meta.ok) return { status: meta.status, ok: false, error: 'arXiv API 请求失败（HTTP ' + meta.status + '）。' };
            const entries = parseArxivEntries(meta.body || '');
            if (!entries.length) return { status: 404, ok: false, error: 'arXiv 中未找到该编号：' + cleanId + '。请检查编号格式（如 1706.03762 或 2103.00020v2）。' };
            info = {
              source: 'arxiv',
              arxiv_id: cleanId,
              title: entries[0] ? entries[0].title : null,
              authors: entries[0] ? entries[0].authors : [],
              pdf_url: pdfUrl,
              page_url: 'https://arxiv.org/abs/' + cleanId,
            };
          } else {
            // 2) DOI 或标题：Semantic Scholar Graph API（公开，无 key 可用）
            let url;
            if (doi) {
              url = 'https://api.semanticscholar.org/graph/v1/paper/DOI:' + encDoi(doi) + '?fields=title,authors,year,venue,url,openAccessPdf,externalIds,abstract';
            } else {
              url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + enc(title) + '&limit=3&fields=title,authors,year,venue,url,openAccessPdf,externalIds,abstract';
            }
            const r = await httpGetWithRetry(url, 'application/json', exec.signal);
            if (r.ok) {
              const data = parseJsonLoose(r.body);
              const p = (data && data.data && Array.isArray(data.data)) ? data.data[0] : data;
              if (p) {
                info = {
                  source: doi ? 'semanticscholar-doi' : 'semanticscholar-search',
                  title: p.title,
                  authors: (p.authors || []).map((a) => a.name),
                  year: p.year,
                  venue: p.venue,
                  page_url: p.url,
                  doi: p.externalIds && p.externalIds.DOI ? p.externalIds.DOI : null,
                  arxiv_id: p.externalIds && p.externalIds.ArXiv ? p.externalIds.ArXiv : null,
                  pdf_url: p.openAccessPdf && p.openAccessPdf.url ? p.openAccessPdf.url : null,
                  abstract: p.abstract ? p.abstract.slice(0, 600) : null,
                };
              }
            } else if (doi && r.status !== 429) {
              // S2 未收录该 DOI（404 等）：回退 Crossref 取元数据，并尝试 arXiv 按标题找 OA PDF
              const cr = await httpGet('https://api.crossref.org/works/' + encDoi(doi), 'application/json', exec.signal);
              if (cr.ok) {
                const cd = parseJsonLoose(cr.body);
                const msg = cd && cd.message;
                if (msg) {
                  info = {
                    source: 'crossref-fallback',
                    title: (msg.title || [''])[0] || null,
                    authors: (msg.author || []).map((a) => (a.given ? a.given + ' ' : '') + (a.family || '')),
                    year: msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0] ? msg.issued['date-parts'][0][0] : null,
                    venue: (msg['container-title'] || [''])[0] || null,
                    page_url: 'https://doi.org/' + encDoi(doi),
                    doi,
                    pdf_url: null,
                    abstract: null,
                  };
                  // 按标题去 arXiv 找预印本
                  const t = (info.title || '').replace(/[^\w\u4e00-\u9fff\s-]/g, ' ').trim().slice(0, 120);
                  if (t) {
                    const ax = await httpGet('https://export.arxiv.org/api/query?search_query=ti:%22' + enc(t) + '%22&start=0&max_results=3', 'application/atom+xml', exec.signal);
                    if (ax.ok) {
                      const entries = parseArxivEntries(ax.body || '');
                      const best = entries.find((e) => e.title && e.title.toLowerCase() === info.title.toLowerCase()) || entries[0];
                      if (best) {
                        info.arxiv_id = best.arxiv_id;
                        info.pdf_url = best.pdf_url || null;
                        info.source = 'crossref+arxiv';
                      }
                    }
                  }
                }
              }
            } else if (title && r.status === 429) {
              // S2 限流：直接回退 arXiv 按标题搜
              const ax = await httpGet('https://export.arxiv.org/api/query?search_query=ti:%22' + enc(title) + '%22&start=0&max_results=3', 'application/atom+xml', exec.signal);
              if (ax.ok) {
                const entries = parseArxivEntries(ax.body || '');
                const best = entries[0];
                if (best) {
                  info = {
                    source: 'arxiv-fallback',
                    title: best.title,
                    authors: best.authors,
                    year: best.published ? best.published.slice(0, 4) : null,
                    venue: null,
                    page_url: best.url,
                    doi: null,
                    arxiv_id: best.arxiv_id,
                    pdf_url: best.pdf_url,
                    abstract: best.summary ? best.summary.slice(0, 600) : null,
                  };
                }
              }
            } else {
              return { status: r.status, ok: false, error: 'Semantic Scholar API 请求失败（HTTP ' + r.status + '）。' + (r.status === 404 ? '该 DOI 可能未被 Semantic Scholar 收录，已尝试 Crossref/arXiv 回退但未找到。' : (r.status === 429 ? '触发限流，请稍后重试。' : '')) };
            }
          }

          if (!info) return err('未找到该论文。');
          if (!info.pdf_url) {
            return {
              status: 200,
              ok: true,
              found: false,
              info,
              note: '该论文没有公开的开放获取 PDF（可能在付费墙后）。合法获取方式：使用机构订阅、Google Scholar 的作者自存版（green OA）、或向作者索取。本工具不做攻击性绕过。',
            };
          }
          if (wantDownload) {
            const safeTitle = (info.title || info.arxiv_id || 'paper').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            const rawDest = 'downloads/papers/' + safeTitle + '.pdf';
            const vd = validateDest(rawDest);
            if (!vd.ok) return err(vd.error);
            const dl = await download(info.pdf_url, vd.dest, exec.signal);
            if (!dl.ok) return { status: 0, ok: false, error: 'PDF 下载失败：' + (dl.error || '未知错误'), info };
            info.saved_to = dl.saved_to;
            info.bytes = dl.bytes;
          }
          return { status: 200, ok: true, found: true, info };
        } catch (e) {
          return { status: 0, ok: false, error: '查找失败：' + ((e && e.message) || String(e)) };
        }
      });

    console.log('[web-research] loaded: 5 wr_* tools registered globally');
  },
};
