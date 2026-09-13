// 200K Context Auto-Compactor — 全局宿主插件（加固版：任何加载语义下不炸）
//
// 行为：监听 agent/pre-step（每一步模型请求前），用 tokenMeter 测量上下文；
// 当 totalTokens >= thresholdTokens（默认 200K）时，调用 compaction 服务
// 将中间段压缩成详细摘要，并保留：
//   - 对话最前面的 keepFirstNodes 条消息原文
//   - 最近 retainTailTokens tokens 的原文
// 两端做 tool-pairing 平衡检查，绝不切碎“工具调用↔结果”配对。
//
// 溢出自动恢复（借鉴社区 dsh-compact）：额外监听 agent/request-error，
// 当请求因 CONTEXT_WINDOW_EXCEEDED 失败时，立即执行一次压缩并返回
// { kind: 'retry' } 让原请求重试，避免上下文超限导致任务中断。
// 每个 agent 最多自动恢复 maxOverflowRetries 次，agent 空闲后重置计数，防死循环。
//
// 加固点：
//   * 顶层不依赖 require/__dirname/module（宿主 internal loader 可能不提供），
//     只用 module.exports 导出；
//   * fs 用 process.getBuiltinModule('fs') 惰性获取，全部 try/catch；
//   * 每次 pre-step 的状态写入 ctx-compact-debug.log + console（双通道诊断）。
'use strict';

// ---- 惰性环境探测：任何情况都不抛错 ----
function getFs() {
  try {
    if (typeof process !== 'undefined' && process.getBuiltinModule) {
      return process.getBuiltinModule('fs');
    }
  } catch (e) { /* 继续尝试 require */ }
  try {
    if (typeof require === 'function') return require('fs');
  } catch (e) { /* 无 fs */ }
  return null;
}

function debugLogPath() {
  try {
    if (typeof __dirname !== 'undefined' && __dirname) {
      return __dirname + '/ctx-compact-debug.log';
    }
    if (typeof process !== 'undefined' && process.cwd) return process.cwd() + '/ctx-compact-debug.log';
  } catch (e) { /* fallthrough */ }
  return null;
}

let lastRotateCheck = 0;
// 日志轮转：超过 5MB 时把当前日志改名为 .old（下次写入新建），防止长会话日志无限增长。
// 每分钟最多检查一次，stat 开销可忽略。
function maybeRotate(fs, p) {
  const now = Date.now();
  if (now - lastRotateCheck < 60000) return;
  lastRotateCheck = now;
  try {
    const st = fs.statSync(p);
    if (st && st.size > 5 * 1024 * 1024) {
      try { fs.renameSync(p, p + '.old'); } catch (e) { /* 竞争时忽略 */ }
    }
  } catch (e) { /* 文件不存在等，忽略 */ }
}

function debug(...args) {
  const fs = getFs();
  const line = new Date().toISOString() + ' | ' + args.join(' ');
  try {
    if (fs) {
      const p = debugLogPath();
      if (p) {
        maybeRotate(fs, p);
        fs.appendFileSync(p, line + '\n');
      }
    }
  } catch (e) { /* 忽略 */ }
  try { console.log('[ctx-compact] ' + line); } catch (e) { /* 忽略 */ }
}

module.exports = {
  name: 'ctx-compact-global',

  apply(ctx, config = {}) {
    const thresholdTokens = config.thresholdTokens ?? 200000;
    const keepFirstNodes = config.keepFirstNodes ?? 2;
    const retainTailTokens = config.retainTailTokens ?? 40000;
    const maxRounds = config.maxRounds ?? 3;
    const enabled = config.enabled !== false;
    const maxOverflowRetries = config.maxOverflowRetries ?? 1;
    // 按会话覆盖阈值：{ '<sessionId>': <tokens> }，命中该会话时用覆盖值，
    // 未配置的会话一律用 thresholdTokens。用于"只改这一个对话，其他对话不变"。
    const sessionThresholds = config.sessionThresholds || {};

    // 解析某会话的生效阈值：完整 id 优先，其次去 "session-" 前缀的裸 id。
    function resolveThreshold(sessionId) {
      if (!sessionId) return thresholdTokens;
      const key = String(sessionId);
      if (sessionThresholds[key] != null) return sessionThresholds[key];
      const bare = key.replace(/^session-/, '');
      if (bare !== key && sessionThresholds[bare] != null) return sessionThresholds[bare];
      return thresholdTokens;
    }

    debug('apply() enabled=' + enabled + ' threshold=' + thresholdTokens +
          ' overrides=' + Object.keys(sessionThresholds).length +
          ' maxOverflowRetries=' + maxOverflowRetries +
          ' cfgKeys=[' + Object.keys(config).join(',') + ']');

    function eventDelta(event) {
      // 新版 dsh（0.1.2+）的 session.events 按需惰性加载：未加载的 seq 下标访问
      // 会返回 undefined（官方改用 seq/eventAt()/snapshotEvents()）。此处按平衡 0
      // 处理，避免抛错导致压缩中断；极端情况下可能放宽少量配对保护，但优先保证压缩可执行。
      if (!event) return 0;
      if (event.type === 'assistant/message') {
        const content = event.data && event.data.message ? event.data.message.content : [];
        let calls = 0;
        for (const block of content) {
          if (block && block.type === 'tool-call') calls += 1;
        }
        return calls;
      }
      if (event.type === 'tool/result') return -1;
      return 0;
    }

    function balanceAfterIndexes(session) {
      const nodes = session.surface.nodes;
      const balances = new Array(nodes.length);
      let balance = 0;
      for (let i = 0; i < nodes.length; i++) {
        // 新版 dsh（0.1.2+）：session.events 属性已被 eventAt(seq) 惰性按需读取取代
        // （官方 dsh-session 源码：Session#eventAt(seq)）。旧式 events[seq] 下标访问
        // 会拿到 undefined 并抛 "Cannot read properties of undefined"。eventAt 对
        // 未加载/越界的 seq 返回 undefined，eventDelta 已判空兜底。
        let ev;
        try {
          ev = typeof session.eventAt === 'function' ? session.eventAt(nodes[i]) : undefined;
        } catch (e) { ev = undefined; }
        balance += eventDelta(ev);
        balances[i] = balance;
      }
      return balances;
    }

    function selectRange(session, measurement, balances) {
      const nodes = session.surface.nodes;
      if (nodes.length <= keepFirstNodes + 1) return null;

      let startIdx = keepFirstNodes;
      while (startIdx < nodes.length && !(startIdx === 0 || balances[startIdx - 1] === 0)) {
        startIdx += 1;
      }
      if (startIdx >= nodes.length) return null;

      const priced = measurement.nodes;
      let acc = 0;
      let tailStartIdx = nodes.length;
      for (let i = nodes.length - 1; i >= 0; i--) {
        acc += priced[i] ? priced[i].tokens : 0;
        tailStartIdx = i;
        if (acc >= retainTailTokens) break;
      }
      if (tailStartIdx <= startIdx + 1) return null;

      let endIdx = tailStartIdx - 1;
      while (endIdx >= startIdx && balances[endIdx] !== 0) endIdx -= 1;
      if (endIdx <= startIdx) return null;

      return { start: nodes[startIdx], end: nodes[endIdx] };
    }

    // 溢出恢复重试计数：agent 空闲后重置，防死循环。
    const overflowRetries = new WeakMap();

    // 核心压缩：解析服务（tokenMeter / compaction via agentPresets.serviceFor）→
    // 测量 → 选段 → 压缩（最多 maxRounds 轮）。返回 { compacted, shadowedTokenCount }
    // 或 { compacted: false, reason }。任何环节不可用都返回 compacted:false，绝不抛错。
    async function maybeCompact(agent, signal, trigger) {
      const agentCtx = agent && agent.ctx ? agent.ctx : ctx;
      const tokenMeter = agentCtx.get('tokenMeter');
      // agentPresets 多路径解析：插件 ctx 优先，失败走 agent.ctx（它能到宿主平面）
      let agentPresets = ctx.get('agentPresets');
      let presetsPath = 'host';
      if (!agentPresets && agentCtx !== ctx) {
        agentPresets = agentCtx.get('agentPresets');
        presetsPath = 'agent';
      }
      let compaction;
      try {
        compaction = agentPresets ? agentPresets.serviceFor(agent, 'compaction') : undefined;
      } catch (e) {
        debug('[' + trigger + '] serviceFor error: ' + (e && e.message ? e.message : String(e)));
        compaction = undefined;
      }
      debug('[' + trigger + '] resolution: presetsPath=' + presetsPath + ' agentPresets=' + !!agentPresets +
            ' tokenMeter=' + !!tokenMeter + ' compaction(serviceFor)=' + !!compaction +
            ' session=' + !!(agent && agent.session));
      if (!tokenMeter || !compaction || !signal || signal.aborted) {
        return { compacted: false, reason: 'unavailable' };
      }

      // 本会话生效阈值：命中 sessionThresholds 用覆盖值，否则默认值
      const sessionId = agent && agent.session ? agent.session.id : undefined;
      const threshold = resolveThreshold(sessionId);
      debug('[' + trigger + '] threshold: session=' + sessionId + ' used=' + threshold);

      let any = false;
      let lastShadowed = 0;
      for (let round = 0; round < maxRounds; round++) {
        if (signal.aborted) break;
        const measurement = tokenMeter.measure(agent.session);
        debug('[' + trigger + '] measure round=' + round + ' total=' + measurement.totalTokens +
              ' threshold=' + threshold +
              ' nodes=' + (measurement.nodes ? measurement.nodes.length : '?'));
        if (measurement.totalTokens < threshold) break;
        const balances = balanceAfterIndexes(agent.session);
        const range = selectRange(agent.session, measurement, balances);
        if (!range) { debug('[' + trigger + '] no range (balance/tail)'); break; }
        const result = await compaction.compactRegion(range.start, range.end, agent, signal);
        any = true;
        lastShadowed = result.shadowedTokenCount;
        debug('[' + trigger + '] COMPACTED seqs ' + range.start + '-' + range.end +
              ' (~' + lastShadowed + ' tokens)');
      }
      return any
        ? { compacted: true, shadowedTokenCount: lastShadowed }
        : { compacted: false, reason: 'no-compress' };
    }

    // agentPresets.serviceFor() 是官方"外部读取隔离域服务"的 API：
    // isolate 域对 agent.ctx / 宿主都不可见，只有它知道怎么按 agent 的挂载找实现。
    // 注意：必须在 pre-step 里惰性解析（apply 阶段 agentPresets 可能还没挂载）。

    try {
      // ---- 压力触发：每步模型请求前，超阈值就压缩 ----
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        try {
          if (!enabled) { debug('skip: disabled'); return next(); }
          if (!agent || !signal) return next();
          debug('pre-step fired: agent=' + !!agent + ' signal=' + !!signal +
                ' aborted=' + !!(signal && signal.aborted));
          const r = await maybeCompact(agent, signal, 'pressure');
          debug('pre-step done: compacted=' + !!(r && r.compacted) +
                (r && r.compacted ? ' shadowed=' + r.shadowedTokenCount : ' reason=' + (r && r.reason)));
        } catch (error) {
          const message = error && error.stack ? error.stack : String(error);
          debug('pre-step ERROR: ' + message);
        }
        return next();
      }, { prepend: true });

      // ---- 溢出恢复：请求因上下文超限失败时，压缩后重试原请求（借鉴 dsh-compact）----
      ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        try {
          if (!enabled) return next();
          if (!failure || failure.code !== 'CONTEXT_WINDOW_EXCEEDED') return next();
          if (!signal || signal.aborted) return next();
          if (!agent) return next();
          const retries = overflowRetries.get(agent) ?? 0;
          if (retries >= maxOverflowRetries) {
            debug('overflow: max retries reached (' + retries + '), preserving original error');
            return next();
          }
          debug('overflow detected (CONTEXT_WINDOW_EXCEEDED), compacting...');
          const r = await maybeCompact(agent, signal, 'context-overflow');
          if (!r || !r.compacted) {
            debug('overflow recovery: nothing compacted (' + (r && r.reason) + '), preserving error');
            return next();
          }
          overflowRetries.set(agent, retries + 1);
          debug('overflow recovery OK: compacted ~' + r.shadowedTokenCount + ' tokens, retrying request');
          return { kind: 'retry' };
        } catch (error) {
          const message = error && error.stack ? error.stack : String(error);
          debug('request-error ERROR: ' + message);
          return next();
        }
      });

      // agent 空闲后重置溢出计数，避免跨轮次累计死循环。
      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle' && agent) overflowRetries.delete(agent);
      });

      debug('listeners registered (pre-step + request-error + status)');
    } catch (error) {
      debug('REGISTER ERROR: ' + (error && error.stack ? error.stack : String(error)));
    }
  },
};