// Bug Tracker — 全局宿主插件（写入 Host 组合，所有会话生效）
//
// 提供 9 个 bug_* 工具，维护一份【跨会话共享的 bug 知识库】：
//   - bug_guide    规范：AI 如何正确查找 bug、如何写标准 bug 报告（流程 + 模板）
//   - bug_new      新建一条 bug 记录（含"如何发现"，tags 可复用已有或新建标签）
//   - bug_get      查看单条 bug 完整生命周期（发现 → 根因 → 修复 → 修复后问题 → 关联）
//   - bug_list     快速浏览 bug 列表（按状态/严重度/项目/标签/关键词过滤）
//   - bug_search   全文搜索历史 bug（快速发现相似问题与历史修复，避免重复调查）
//   - bug_update   更新 bug：补充根因/修复/修复后问题、改状态、追加时间线、改标签
//   - bug_link     关联两条 bug（如"BUG-2 是 BUG-1 修复引入的回归"）
//   - bug_stats    知识库统计（状态/严重度分布、高频模块、常见根因）
//   - bug_tags     标签搜索/复用：列出已用标签及次数，按 q 过滤；写 bug 时先复用再创建
//
// 设计目标（对应需求）：
//   - 快速浏览、发现、了解 bug 的产生：bug_list / bug_search / bug_get 的 rootCause 段
//   - bug 如何被发现：discovery 段（信号、证据、复现步骤）
//   - 如何修复：fix 段（方案、改动文件、验证）
//   - 修复后问题：postFix 段（回归、遗留问题），并通过 bug_link 与原始 bug 双向关联
//   - 标签体系：写入时添加标签（可新建），bug_tags 搜索/复用既有标签保持一致性
//   - 规范查找与报告：bug_guide 输出标准调查流程与报告模板，systemPrompt 注入提醒
//
// 实现要点（与 github-manager.js / git-publish.js 同一机制）：
//   - 数据：纯 Node fs 直接读写 JSON（宿主权限），原子写（tmp + rename）+ 进程内写锁，
//     多会话并发安全；默认存 <workspaceRoot>/.bugtrack/bugs.json（config.dataDir 可配）。
//   - 工具：ctx.tools.register 直接注册（raw ToolDefinition），全局可见。
//   - 自测：node bug-tracker.js 且环境变量 BUGTRACK_SELF_TEST=1 时运行内存自测，
//     不依赖 DSH 运行时即可验证核心逻辑。
'use strict';

const path = require('path');
const fs = require('fs');

const msg = (e) => (e && e.message) ? e.message : String(e);

// ================= 纯存储核心（模块级，可独立测试） =================

const STATUSES = ['open', 'investigating', 'fixed', 'verified', 'reopened', 'closed'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const RELATIONS = ['related_to', 'duplicate_of', 'regression_of', 'blocks', 'fixed_by', 'breaks_fix'];

// 标准调查流程与报告模板（bug_guide 返回，同时供自测引用）
const GUIDE = [
  '# Bug 调查与报告规范（所有会话通用）',
  '',
  '## 一、如何正确查找 bug（发现阶段）',
  '1. 复现优先：先确认现象与复现步骤（触发条件、输入、环境），不要急于猜测。',
  '2. 收集证据：错误日志/堆栈、崩溃信息、异常输入输出、截图、相关文件路径与行号。',
  '3. 定位根因：用二分法缩小范围（新改动引入？git log/diff 最近提交？模块边界？），',
  '   读调用链与数据流，先查 bug_search 是否已有相似历史与修复，避免重复调查。',
  '4. 形成假设并验证：用最小复现或针对性日志验证根因，确认"为什么会产生"。',
  '',
  '## 二、标准 bug 报告模板（bug_new / bug_update 按此记录）',
  '1. 基本信息：标题、项目 project、模块 component、严重度 severity、标签 tags。',
  '2. discovery（如何被发现）：信号（用户反馈/测试失败/日志/崩溃/审查/回归探测）、证据、复现步骤。',
  '3. cause（如何产生/根因）：根因分析、涉及文件/函数、触发条件、关联提交。',
  '4. fix（如何修复）：修复方案、改动文件、提交标识、验证方式（回归测试/复现验证）。',
  '5. postFix（修复后问题）：修复引入的回归、遗留问题、需要后续跟进的点。',
  '6. 关联：修复后问题通常与原始 bug 用 bug_link（regression_of / related_to 等）关联。',
  '',
  '## 三、标签规范',
  '- 写 bug 时用 bug_tags 先查已有标签：能复用就复用（如 登录/性能/崩溃/回归），保持一致、方便统计。',
  '- 没有合适标签时可以创建新标签：bug_new / bug_update 的 tags 直接填新标签名即可自动创建。',
  '- 标签要简短、语义清晰，用关键词而非长句。',
  '',
  '## 四、工具使用规则',
  '- 遇到新 bug：先 bug_search（关键词）查重，查无再用 bug_new 建档。',
  '- 调查过程中：用 bug_update 的 event / cause 持续补充，保持时间线完整。',
  '- 修复完成：bug_update 设置 status=fixed 并记录 fix；验证后置为 verified。',
  '- 修复后发现问题：立即 bug_update 追加 postFix，并用 bug_link 关联到原始 bug。',
  '- 回复用户时引用 bug id（如 BUG-3），方便跨会话追溯。',
].join('\n');

const nowIso = () => new Date().toISOString();

function blankRecord() {
  return {
    id: null,
    title: '',
    project: '',
    component: '',
    severity: 'medium',
    status: 'open',
    tags: [],
    discovery: [], // 如何被发现（信号/证据/复现步骤）
    cause: [],     // 根因分析（如何产生）
    fix: [],       // 如何修复（方案/改动/提交/验证）
    postFix: [],   // 修复后问题（回归/遗留）
    links: [],     // [{ id, relation, at }]
    timeline: [],  // [{ at, kind, text, by }]
    meta: { createdAt: null, updatedAt: null, sessionId: '' },
  };
}

function pushLines(arr, text) {
  if (text === undefined || text === null) return arr;
  String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((s) => arr.push(s));
  return arr;
}

function splitTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags).split(/[,，;；]/).map((t) => t.trim()).filter(Boolean);
}

// 从文件中加载完整知识库；文件不存在/损坏时返回空库（损坏文件改名为 .corrupt-<ts> 而非静默丢失）
function loadData(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { seq: 0, records: {} }; }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.records) return { seq: 0, records: {} };
    return { seq: Number.isInteger(data.seq) ? data.seq : Object.keys(data.records).length, records: data.records };
  } catch (e) {
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (e2) { /* ignore */ }
    return { seq: 0, records: {} };
  }
}

function saveData(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 摘要视图：列表/搜索用，字段全部为标量（避免把整条记录刷屏）
function summarize(r) {
  const links = Array.isArray(r.links) ? r.links : [];
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    severity: r.severity,
    project: r.project,
    component: r.component,
    tags: r.tags,
    summary: [
      (Array.isArray(r.cause) && r.cause.length ? '根因: ' + r.cause[r.cause.length - 1] : ''),
      (Array.isArray(r.fix) && r.fix.length ? '修复: ' + r.fix[r.fix.length - 1] : ''),
      (Array.isArray(r.postFix) && r.postFix.length ? '修复后问题: ' + r.postFix[r.postFix.length - 1] : ''),
    ].filter(Boolean).join(' | '),
    linkCount: links.length,
    updatedAt: r.meta && r.meta.updatedAt,
  };
}

// 文本搜索：匹配所有字符串字段（含标签、时间线文本）
function matchesQuery(r, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  const hay = [];
  hay.push(r.title, r.project, r.component);
  hay.push.apply(hay, r.tags || []);
  hay.push.apply(hay, r.discovery || []);
  hay.push.apply(hay, r.cause || []);
  hay.push.apply(hay, r.fix || []);
  hay.push.apply(hay, r.postFix || []);
  (r.links || []).forEach((l) => hay.push(l.id));
  (r.timeline || []).forEach((t) => hay.push(t.text));
  return hay.join('\n').toLowerCase().indexOf(needle) !== -1;
}

function filterRecord(r, f) {
  if (f.status && r.status !== f.status) return false;
  if (f.severity && r.severity !== f.severity) return false;
  if (f.project && r.project !== f.project) return false;
  if (f.component && r.component !== f.component) return false;
  if (f.tag && (r.tags || []).indexOf(f.tag) === -1) return false;
  if (!matchesQuery(r, f.q)) return false;
  return true;
}

// 标签统计：全库已用标签 + 出现次数（供 bug_tags 复用/发现已有标签）
function tagsFrom(data) {
  const counts = {};
  Object.keys(data.records).forEach((k) => {
    (data.records[k].tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  });
  return Object.keys(counts)
    .map((k) => ({ tag: k, count: counts[k] }))
    .sort((a, b) => (b.count - a.count) || String(a.tag).localeCompare(String(b.tag)));
}

function statsFrom(data) {
  const records = Object.keys(data.records).map((k) => data.records[k]);
  const byStatus = {};
  const bySeverity = {};
  const byProject = {};
  const byComponent = {};
  const rootCause = {}; // 归一化根因类别（取 cause 首行前 40 字符粗分）
  records.forEach((r) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    if (r.project) byProject[r.project] = (byProject[r.project] || 0) + 1;
    if (r.component) byComponent[r.component] = (byComponent[r.component] || 0) + 1;
    const c = (Array.isArray(r.cause) && r.cause.length) ? r.cause[0].slice(0, 40) : '(未记录)';
    rootCause[c] = (rootCause[c] || 0) + 1;
  });
  const top = (obj, n) => Object.keys(obj).map((k) => ({ key: k, count: obj[k] }))
    .sort((a, b) => b.count - a.count).slice(0, n || 10);
  return {
    total: records.length,
    openCount: records.filter((r) => ['open', 'investigating', 'reopened'].indexOf(r.status) !== -1).length,
    withPostFix: records.filter((r) => (r.postFix || []).length > 0).length,
    byStatus: top(byStatus),
    bySeverity: top(bySeverity),
    byProject: top(byProject),
    byComponent: top(byComponent),
    commonRootCause: top(rootCause, 8),
  };
}

// ================= 插件 =================

module.exports = {
  name: 'bug-tracker',

  inject: ['tools'],

  apply(ctx, config) {
    const cfg = config || {};
    const sandbox0 = ctx.get('sandboxPolicy');
    const WS_ROOT = cfg.workspaceRoot
      ? path.resolve(String(cfg.workspaceRoot))
      : (sandbox0 && sandbox0.workspaceRoot ? sandbox0.workspaceRoot : process.cwd());
    const DATA_FILE = cfg.dataDir
      ? path.resolve(String(cfg.dataDir), 'bugs.json')
      : path.join(WS_ROOT, '.bugtrack', 'bugs.json');

    // 进程内写锁：多会话并发调用时串行化 读-改-写
    let lock = Promise.resolve();
    function withLock(fn) {
      let release;
      const prev = lock;
      lock = new Promise((resolve) => { release = resolve; });
      return prev.then(() => fn()).finally(() => release());
    }

    function mutate(fn) {
      return withLock(() => {
        const data = loadData(DATA_FILE);
        const result = fn(data);
        if (result && result.changed) saveData(DATA_FILE, data);
        return result;
      });
    }

    function sessionOf(exec) {
      try {
        const agent = exec && exec.agent;
        if (agent && (agent.id || agent.sessionId)) return String(agent.id || agent.sessionId);
      } catch (e) { /* ignore */ }
      return '';
    }

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    };

    function reg(name, description, parameters, execute) {
      ctx.tools.register({
        name,
        description,
        parameters,
        output,
        timeoutMs: 30000,
        execute,
      });
    }

    // ================= 工具：bug_guide（规范流程与报告模板） =================

    reg('bug_guide',
      '返回 Bug 调查与报告规范：AI 如何正确查找 bug 的流程、标准 bug 报告模板（发现→根因→修复→修复后问题→关联）、以及 bug_* 工具的使用规则。调查或记录任何 bug 前先调用本工具。',
      { type: 'object', properties: {} },
      async () => ({ ok: true, guide: GUIDE }));

    // ================= 工具：bug_new =================

    reg('bug_new',
      '新建一条 bug 记录到跨会话共享的 bug 知识库。必填 title；其余按标准模板选填（project、component、severity、tags、discovery=如何被发现）。返回新 bug 的 id（如 BUG-3）。',
      {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'bug 标题（必填）' },
          project: { type: 'string', description: '所属项目/仓库' },
          component: { type: 'string', description: '模块/文件/组件' },
          severity: { type: 'string', enum: SEVERITIES, description: '严重度，默认 medium' },
          tags: { type: 'string', description: '标签，逗号分隔' },
          discovery: { type: 'string', description: '如何被发现：信号、证据、复现步骤（可多行）' },
        },
        required: ['title'],
      },
      async (args, exec) => {
        const title = String(args.title || '').trim();
        if (!title) return { ok: false, error: 'title 不能为空。' };
        return mutate((data) => {
          data.seq += 1;
          const r = blankRecord();
          r.id = 'BUG-' + data.seq;
          r.title = title;
          r.project = (args.project || '').trim();
          r.component = (args.component || '').trim();
          if (SEVERITIES.indexOf(args.severity) !== -1) r.severity = args.severity;
          r.tags = splitTags(args.tags);
          pushLines(r.discovery, args.discovery);
          const sid = sessionOf(exec);
          r.meta.createdAt = r.meta.updatedAt = nowIso();
          r.meta.sessionId = sid;
          r.timeline.push({ at: r.meta.createdAt, kind: 'created', text: '新建 bug 记录', by: sid });
          data.records[r.id] = r;
          return { changed: true, ok: true, id: r.id, record: summarize(r) };
        });
      });

    // ================= 工具：bug_get =================

    reg('bug_get',
      '查看单条 bug 的完整生命周期：基本信息、discovery（如何发现）、cause（根因/如何产生）、fix（如何修复）、postFix（修复后问题）、links（关联 bug 及其关系）、timeline（时间线）。id 传 BUG-N 或标题关键词。',
      {
        type: 'object',
        properties: { id: { type: 'string', description: 'bug id（如 BUG-3）或标题关键词（必填）' } },
        required: ['id'],
      },
      async (args, exec) => {
        const q = String(args.id || '').trim();
        if (!q) return { ok: false, error: 'id 不能为空。' };
        return mutate((data) => {
          const r = data.records[q] || Object.keys(data.records)
            .map((k) => data.records[k])
            .find((x) => String(x.title).toLowerCase().indexOf(q.toLowerCase()) !== -1);
          if (!r) return { ok: false, error: '未找到 bug：' + q + '。可先运行 bug_list 或 bug_search。' };
          const linked = (r.links || []).map((l) => {
            const t = data.records[l.id];
            return { id: l.id, relation: l.relation, at: l.at, title: t ? t.title : '(已删除)', status: t ? t.status : '', summary: t ? summarize(t) : null };
          });
          return { ok: true, record: r, linked };
        });
      });

    // ================= 工具：bug_list =================

    reg('bug_list',
      '快速浏览 bug 列表（摘要视图）。支持按 status、severity、project、component、tag、关键词 q 过滤，limit 控制条数，默认按更新时间倒序。',
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: STATUSES, description: '按状态过滤' },
          severity: { type: 'string', enum: SEVERITIES, description: '按严重度过滤' },
          project: { type: 'string', description: '按项目过滤' },
          component: { type: 'string', description: '按模块过滤' },
          tag: { type: 'string', description: '按标签过滤（精确匹配单个标签）' },
          q: { type: 'string', description: '关键词，匹配标题/根因/修复等任意字段' },
          limit: { type: 'integer', description: '返回条数，默认 30，最大 200' },
        },
      },
      async (args, exec) => {
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        return mutate((data) => {
          const items = Object.keys(data.records)
            .map((k) => data.records[k])
            .filter((r) => filterRecord(r, args))
            .sort((a, b) => String((b.meta && b.meta.updatedAt) || '').localeCompare(String((a.meta && a.meta.updatedAt) || '')))
            .slice(0, limit)
            .map(summarize);
          return { ok: true, count: items.length, items };
        });
      });

    // ================= 工具：bug_search =================

    reg('bug_search',
      '全文搜索 bug 知识库（标题、根因、修复、修复后问题、时间线、标签等所有文本字段），用于快速发现相似问题与历史修复。返回摘要列表。',
      {
        type: 'object',
        properties: {
          q: { type: 'string', description: '搜索关键词（必填）' },
          limit: { type: 'integer', description: '返回条数，默认 20，最大 100' },
        },
        required: ['q'],
      },
      async (args, exec) => {
        const q = String(args.q || '').trim();
        if (!q) return { ok: false, error: 'q 不能为空。' };
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        return mutate((data) => {
          const items = Object.keys(data.records)
            .map((k) => data.records[k])
            .filter((r) => matchesQuery(r, q))
            .sort((a, b) => String((b.meta && b.meta.updatedAt) || '').localeCompare(String((a.meta && a.meta.updatedAt) || '')))
            .slice(0, limit)
            .map(summarize);
          return { ok: true, query: q, count: items.length, items };
        });
      });

    // ================= 工具：bug_update =================

    reg('bug_update',
      '更新一条 bug 记录：追加 discovery/cause/fix/postFix 内容（多行会用多个条目追加）、event 追加时间线、改 status/severity/title/project/component/tags。id 传 BUG-N。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'bug id（如 BUG-3，必填）' },
          title: { type: 'string', description: '替换标题' },
          project: { type: 'string', description: '替换项目' },
          component: { type: 'string', description: '替换模块' },
          severity: { type: 'string', enum: SEVERITIES, description: '替换严重度' },
          status: { type: 'string', enum: STATUSES, description: '替换状态（open/investigating/fixed/verified/reopened/closed）' },
          tags: { type: 'string', description: '替换标签（逗号分隔）' },
          discovery: { type: 'string', description: '追加"如何被发现"（信号/证据/复现步骤）' },
          cause: { type: 'string', description: '追加根因分析（如何产生）' },
          fix: { type: 'string', description: '追加修复说明（方案/改动/提交/验证）' },
          postFix: { type: 'string', description: '追加修复后问题（回归/遗留/待跟进）' },
          event: { type: 'string', description: '追加一条时间线事件（调查进展等）' },
        },
        required: ['id'],
      },
      async (args, exec) => {
        const q = String(args.id || '').trim();
        if (!q) return { ok: false, error: 'id 不能为空。' };
        return mutate((data) => {
          const r = data.records[q];
          if (!r) return { ok: false, error: '未找到 bug：' + q + '。' };
          const sid = sessionOf(exec);
          let changed = false;
          const app = (field, src, kind) => {
            if (src === undefined || src === null || String(src).trim() === '') return;
            pushLines(r[field], src);
            const firstLine = String(src).trim().split(/\r?\n/)[0];
            r.timeline.push({ at: nowIso(), kind: kind || field, text: firstLine, by: sid });
            changed = true;
          };
          if (args.title !== undefined && String(args.title).trim()) { r.title = String(args.title).trim(); changed = true; }
          if (args.project !== undefined) { r.project = String(args.project).trim(); changed = true; }
          if (args.component !== undefined) { r.component = String(args.component).trim(); changed = true; }
          if (SEVERITIES.indexOf(args.severity) !== -1) { r.severity = args.severity; changed = true; }
          if (STATUSES.indexOf(args.status) !== -1) { r.status = args.status; changed = true; }
          if (args.tags !== undefined) { r.tags = splitTags(args.tags); changed = true; }
          app('discovery', args.discovery, 'discovered');
          app('cause', args.cause, 'root_cause');
          app('fix', args.fix, 'fixed');
          app('postFix', args.postFix, 'post_fix');
          if (args.event !== undefined && String(args.event).trim() !== '') {
            r.timeline.push({ at: nowIso(), kind: 'event', text: String(args.event).trim(), by: sid });
            changed = true;
          }
          if (!changed) return { ok: false, error: '没有可更新的字段（请提供 discovery/cause/fix/postFix/event/status 等）。' };
          r.meta.updatedAt = nowIso();
          return { changed: true, ok: true, id: r.id, status: r.status, record: summarize(r), timelineCount: r.timeline.length };
        });
      });

    // ================= 工具：bug_link =================

    reg('bug_link',
      '关联两条 bug 记录（双向）。用于表达"修复后问题/回归/重复/阻塞"等关系，例如：BUGB 是 BUGA 修复引入的回归 → bug_link(id=BUGA, target=BUGB, relation=regression_of)。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '被关联的 bug id（如 BUG-3，必填）' },
          target: { type: 'string', description: '目标 bug id（如 BUG-7，必填）' },
          relation: { type: 'string', enum: RELATIONS, description: '关系：related_to 相关 / duplicate_of 重复 / regression_of 回归自 / blocks 阻塞 / fixed_by 由…修复 / breaks_fix 破坏…的修复，默认 related_to' },
        },
        required: ['id', 'target'],
      },
      async (args, exec) => {
        const a = String(args.id || '').trim();
        const b = String(args.target || '').trim();
        if (!a || !b) return { ok: false, error: 'id 和 target 不能为空。' };
        if (a === b) return { ok: false, error: '不能关联到自身。' };
        const relation = RELATIONS.indexOf(args.relation) !== -1 ? args.relation : 'related_to';
        return mutate((data) => {
          const ra = data.records[a];
          const rb = data.records[b];
          if (!ra || !rb) return { ok: false, error: '未找到 bug：' + (!ra ? a : b) + '。' };
          const at = nowIso();
          const sid = sessionOf(exec);
          const ensure = (from, to) => {
            if ((from.links || []).some((l) => l.id === to)) return false;
            from.links.push({ id: to, relation, at, by: sid });
            return true;
          };
          const added = ensure(ra, b) | ensure(rb, a);
          if (!added) return { ok: false, error: '这两条 bug 已经存在关联。' };
          ra.meta.updatedAt = rb.meta.updatedAt = at;
          ra.timeline.push({ at, kind: 'link', text: '关联 ' + b + ' (' + relation + ')', by: sid });
          rb.timeline.push({ at, kind: 'link', text: '关联 ' + a + ' (' + relation + ')', by: sid });
          return { changed: true, ok: true, id: a, target: b, relation, note: '关联已建立（双向）。' };
        });
      });

    // ================= 工具：bug_stats =================

    reg('bug_stats',
      'bug 知识库统计：总数、未解决数、带修复后问题的记录数，按状态/严重度/项目/模块分布，以及常见根因类别。用于快速了解整体情况。',
      { type: 'object', properties: {} },
      async () => {
        const data = loadData(DATA_FILE);
        return { ok: true, dataFile: DATA_FILE, stats: statsFrom(data) };
      });

    // ================= 工具：bug_tags（标签搜索/复用） =================

    reg('bug_tags',
      '查看 bug 知识库中已使用的全部标签及出现次数（可按 q 过滤标签名）。写 bug 时先用它发现/复用已有标签保持一致，确实没有合适标签时再创建新标签（bug_new / bug_update 的 tags 直接填新标签名即可自动创建）。',
      {
        type: 'object',
        properties: {
          q: { type: 'string', description: '标签关键词过滤（可选），如 q=性能 只返回含"性能"的标签' },
        },
      },
      async (args) => {
        const data = loadData(DATA_FILE);
        const all = tagsFrom(data);
        const q = String(args.q || '').trim().toLowerCase();
        const items = q ? all.filter((t) => String(t.tag).toLowerCase().indexOf(q) !== -1) : all;
        return { ok: true, total: all.length, query: q, count: items.length, tags: items.slice(0, 200) };
      });

    // ================= 系统提示段落 =================
    const spService = ctx.get('systemPrompt');
    if (spService !== undefined && typeof spService.section === 'function') {
      try {
        spService.section({
          name: 'tool:bug-tracker',
          order: 108,
          text: '调查或修复 bug 时，使用 bug_* 工具维护跨会话的 bug 知识库：先用 bug_search 查重，'
            + '无结果用 bug_new 建档，用 bug_update 记录根因(cause)/修复(fix)/修复后问题(postFix)，'
            + '修复后问题用 bug_link 关联到原始 bug（regression_of 等）。'
            + '动手调查前先看 bug_guide 获取标准流程与报告模板。',
        });
      } catch (e) { /* 提示段落失败不影响工具 */ }
    }

    console.log('[bug-tracker] loaded: bug_guide / bug_new / bug_get / bug_list / bug_search / bug_update / bug_link / bug_stats / bug_tags (data=' + DATA_FILE + ')');
  },
};

// ================= 自测（node bug-tracker.js 且 BUGTRACK_SELF_TEST=1） =================
if (require.main === module && process.env.BUGTRACK_SELF_TEST === '1') {
  const mem = { seq: 0, records: {} };
  const load = () => mem;
  const save = (d) => { mem.seq = d.seq; mem.records = d.records; };
  const fail = (label, cond) => { if (!cond) { console.error('FAIL: ' + label); process.exit(1); } };

  // 模拟 mutate
  function simulate(fn) {
    const data = load();
    const result = fn(data);
    if (result && result.changed) save(data);
    return result;
  }
  const mk = (over) => Object.assign(blankRecord(), over);
  const R = {
    id: null, title: '', project: '', component: '', severity: 'medium', status: 'open', tags: [],
    discovery: [], cause: [], fix: [], postFix: [], links: [], timeline: [], meta: {},
  };

  // bug_guide 输出非空
  fail('guide', GUIDE.length > 100);
  // bug_new 分配自增 id
  const n1 = simulate((data) => {
    data.seq += 1; const r = mk(); r.id = 'BUG-' + data.seq;
    r.title = '登录接口 500'; r.project = 'web'; r.component = 'auth';
    pushLines(r.discovery, '用户反馈登录报错\n日志 500 stack');
    r.meta.createdAt = r.meta.updatedAt = nowIso();
    data.records[r.id] = r; return { changed: true, ok: true, id: r.id };
  });
  const n2 = simulate((data) => {
    data.seq += 1; const r = mk(); r.id = 'BUG-' + data.seq;
    r.title = '登录后偶发白屏'; r.project = 'web'; r.component = 'auth';
    r.meta.createdAt = r.meta.updatedAt = nowIso();
    data.records[r.id] = r; return { changed: true, ok: true, id: r.id };
  });
  fail('ids', n1.id === 'BUG-1' && n2.id === 'BUG-2');

  // filter / search / summarize
  const l1 = Object.keys(mem.records).map((k) => mem.records[k]).filter((r) => filterRecord(r, { project: 'web' }));
  fail('filter project', l1.length === 2);
  const s1 = Object.keys(mem.records).map((k) => mem.records[k]).filter((r) => matchesQuery(r, '日志 500'));
  fail('search 日志 500', s1.length === 1 && s1[0].id === 'BUG-1');
  const s2 = Object.keys(mem.records).map((k) => mem.records[k]).filter((r) => matchesQuery(r, '白屏'));
  fail('search 白屏', s2.length === 1);

  // bug_update：追加 cause / status / postFix
  const u1 = simulate((data) => {
    const r = data.records['BUG-1'];
    r.status = 'fixed';
    pushLines(r.cause, 'JWT 过期校验抛异常未捕获');
    pushLines(r.fix, '捕获异常返回 401 并跳转登录');
    pushLines(r.postFix, '退出登录偶发先跳首页再跳登录');
    r.meta.updatedAt = nowIso();
    return { changed: true, ok: true, id: r.id };
  });
  fail('update ok', u1.ok);
  fail('update fields', mem.records['BUG-1'].status === 'fixed' && mem.records['BUG-1'].cause.length === 1);

  // bug_update 的 event 追加走 timeline 对象数组（非字符串），模拟真实路径
  const ev = simulate((data) => {
    const r = data.records['BUG-2'];
    r.timeline.push({ at: nowIso(), kind: 'event', text: '已定位为前端路由竞态', by: '' });
    r.meta.updatedAt = nowIso();
    return { changed: true, ok: true, id: r.id };
  });
  fail('update event', ev.ok && mem.records['BUG-2'].timeline.length === 1
    && typeof mem.records['BUG-2'].timeline[0].text === 'string'
    && mem.records['BUG-2'].timeline[0].kind === 'event');

  // 关联：BUG-2 是 BUG-1 修复引入的回归
  const lk = simulate((data) => {
    const ra = data.records['BUG-1'], rb = data.records['BUG-2'];
    ra.links.push({ id: 'BUG-2', relation: 'regression_of', at: nowIso() });
    rb.links.push({ id: 'BUG-1', relation: 'regression_of', at: nowIso() });
    return { changed: true, ok: true };
  });
  fail('link ok', lk.ok && mem.records['BUG-1'].links.length === 1);

  // summarize 带 linkCount / 关联查询
  const sum = summarize(mem.records['BUG-1']);
  fail('summarize', sum.id === 'BUG-1' && sum.linkCount === 1 && /登录/.test(sum.summary));

  // stats / tags
  const st = statsFrom(mem);
  fail('stats', st.total === 2 && st.withPostFix === 1
    && st.byStatus.some((x) => x.key === 'fixed' && x.count === 1));
  // 标签：复用统计 + 过滤（bug_tags 逻辑）
  mem.records['BUG-1'].tags = ['登录', '500'];
  mem.records['BUG-2'].tags = ['登录', '前端'];
  const tf = tagsFrom(mem);
  fail('tags total', tf.length === 3);
  fail('tags count', tf.find((t) => t.tag === '登录').count === 2);
  fail('tags filter', tf.filter((t) => String(t.tag).toLowerCase().indexOf('登录') !== -1).length === 1);

  // bug_get 关联解析
  const linkedView = (mem.records['BUG-1'].links || []).map((l) => mem.records[l.id] ? l.id : null);
  fail('linked view', linkedView[0] === 'BUG-2');

  console.log('[bug-tracker] self-test OK: ids/filter/search/update/link/summarize/stats all passed');
}