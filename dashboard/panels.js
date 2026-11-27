import {
  $, el, svg, glyph, paths, labels, working, busyStatuses, eventTypes, commTypes, badTypes, lifeTypes,
  ms, clock, duration, shortDuration, ago, tokens, cost, modelName, shortModel, elapsedOf,
  agentHost, hostMeta, agentSessionId, copyText, replyPayload, mount,
} from './dom.js';
import { areaChart, gauge } from './charts.js';
import { markdown, diffStats } from './conversation.js';
import { renderAcceptanceCard, verificationBadge } from './collab-views.js';

const shortPath = p => !p ? '—' : p.replace(/\/+$/, '').split('/').slice(-2).join('/') || p;

function propRow(label, nodes, copyVal, copyMsg) {
  if (!copyVal) return el('div', { class: 'prop-row' }, el('span', { class: 'prop-k', text: label }), el('span', { class: 'prop-v' }, nodes));
  return el('button', {
    type: 'button',
    class: 'prop-row copyable',
    title: `点击复制：${copyVal}`,
    onclick: () => copyText(copyVal, copyMsg),
  }, el('span', { class: 'prop-k', text: label }), el('span', { class: 'prop-v' }, nodes), glyph(paths.copy, 'prop-copy'));
}

export function pairTools(events = []) {
  const open = new Map();
  const calls = [];
  for (const e of events) {
    if (e.type === 'tool_execution_start') {
      const call = { id: e.toolCallId, name: e.toolName, start: ms(e.time), end: null, isError: false };
      open.set(e.toolCallId, call);
      calls.push(call);
    } else if (e.type === 'tool_execution_end') {
      const call = open.get(e.toolCallId);
      if (call) { call.end = ms(e.time); call.isError = Boolean(e.isError); open.delete(e.toolCallId); }
      else calls.push({ id: e.toolCallId, name: e.toolName, start: ms(e.time), end: ms(e.time), isError: Boolean(e.isError) });
    }
  }
  return { calls, open: [...open.values()] };
}

export function renderLane(agent, tools) {
  const lane = $('#lane');
  const wrap = $('#lane-wrap');
  if (!lane || !wrap) return;
  lane.replaceChildren();
  const width = Math.max(200, wrap.clientWidth);
  const height = 66;
  lane.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const events = agent.events || [];
  const start = Math.min(ms(agent.createdAt) || Infinity, ms(events[0]?.time) || Infinity);
  const live = working.has(agent.status);
  const end = Math.max(live ? Date.now() : 0, ms(agent.activity?.lastWorkAt || agent.updatedAt) || 0, start + 1000);
  const x = t => (Math.min(Math.max(t, start), end) - start) / (end - start) * (width - 4);
  for (const [y, h] of [[2, 24], [32, 14], [50, 14]]) lane.append(svg('rect', { x: 0, y, width: width - 4, height: h, rx: 5, class: 'lane-bg' }));
  for (let i = 1; i < 4; i++) { const gx = (width - 4) * i / 4; lane.append(svg('line', { x1: gx, x2: gx, y1: 0, y2: height, class: 'grid' })); }
  const tip = (node, text) => { node.setAttribute('data-tip', text); return node; };
  for (const call of tools.calls) {
    const x1 = x(call.start);
    const x2 = call.end == null ? x(end) : x(call.end);
    const cls = call.end == null ? 'seg open' : call.isError ? 'seg err' : 'seg';
    lane.append(tip(svg('rect', { x: x1, y: 5, width: Math.max(2, x2 - x1), height: 18, rx: 2, class: cls }),
      `${call.name}${call.isError ? ' · 失败' : ''}\n${clock(call.start)} · ${call.end == null ? `进行中 ${shortDuration(Date.now() - call.start)}` : shortDuration(call.end - call.start)}`));
  }
  for (const e of events) {
    const text = String(e.question || e.message || e.text || e.error || e.reason || '').slice(0, 140);
    if (commTypes.has(e.type)) {
      lane.append(tip(svg('circle', { cx: x(ms(e.time)), cy: 39, r: 4, class: `comm ${e.type === 'question' ? 'question' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    } else if (lifeTypes.has(e.type)) {
      const cx = x(ms(e.time));
      lane.append(tip(svg('path', { d: `M${cx} 51 l4.5 6 l-4.5 6 l-4.5 -6 z`, class: `life ${badTypes.has(e.type) ? 'bad' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    }
  }
  if (live) lane.append(svg('line', { x1: x(end) - 1, x2: x(end) - 1, y1: 0, y2: height, class: 'nowline' }));
  $('#axis-start').textContent = Number.isFinite(start) ? clock(start) : '—';
  $('#axis-mid').textContent = Number.isFinite(start) ? `跨度 ${duration(end - start)}` : '';
  $('#axis-end').textContent = live ? '现在' : Number.isFinite(end) ? clock(end) : '—';
}

export function changedFiles(data) {
  const results = new Map(data.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
  const files = new Map();
  for (const m of data.messages) for (const call of m.calls || []) {
    const result = results.get(call.id);
    if (!result || result.isError || !['edit', 'write'].includes(call.name)) continue;
    const stats = result.diff ? diffStats(result.diff) : { add: String(call.arguments?.content || '').split('\n').length, del: 0 };
    const name = call.arguments?.path || call.arguments?.file_path || '?';
    const total = files.get(name) || { add: 0, del: 0 };
    files.set(name, { add: total.add + stats.add, del: total.del + stats.del });
  }
  return files;
}

export function clearHead(hasAgents) {
  $('#d-dot').className = 'dot';
  $('#d-name').textContent = 'Pi Server · 调度台';
  $('#d-name').title = '';
  $('#d-model').textContent = '';
  if ($('#d-badges')) { $('#d-badges').hidden = true; $('#d-badges').replaceChildren(); }
  if ($('#p-acceptance')) { $('#p-acceptance').hidden = true; $('#p-acceptance').replaceChildren(); }
  if ($('#d-edit')) { $('#d-edit').hidden = true; $('#d-edit').onclick = null; }
  $('#d-host').hidden = true;
  $('#d-host').onclick = null;
  $('#placeholder').hidden = false;
  $('#records').replaceChildren();
  $('#dock').hidden = true;
  $('#placeholder-text').textContent = hasAgents ? '当前筛选下没有可显示的会话。' : '还没有会话。创建子代理后，这里会实时显示它的进度。';
}

function renderStatusCard(agent, actions, host, sid, active) {
  const card = $('#p-status');
  const cardKey = JSON.stringify([
    agent.id, agent.status, agent.name, agent.rawName, agent.title, agent.note,
    agent.pinned, agent.archived, agent.marked, agent.movedTo, agent.watcherActive, agent.cwd,
    agent.workspaceMode, agent.thinking, agent.temporaryModel, agent.ownedPaths?.length,
    agent.callback?.antigravityDeliveredSeq, sid,
  ]);
  if (card.dataset.key === cardKey) return;
  card.dataset.key = cardKey;
  mount(card,
    el('div', { class: 'p-bar' },
      el('span', { class: `pill ${agent.status}` }, el('span', { class: `dot ${agent.status}` }), labels[agent.status] || agent.status),
      el('span', { class: 'p-time' }, active ? '已用 ' : '用时 ', el('b', { id: 'p-elapsed', text: duration(elapsedOf(agent)) })),
      el('span', { class: 'ago', 'data-ago': agent.updatedAt, text: ago(agent.updatedAt) }),
      el('div', { class: 'p-acts' },
        el('button', { type: 'button', class: 'icon-btn tiny', title: '编辑会话 (E)', onclick: () => actions.onEdit?.(agent) }, glyph(paths.pen)),
        el('button', { type: 'button', class: 'icon-btn tiny', 'aria-pressed': String(Boolean(agent.pinned)), title: agent.pinned ? '取消置顶' : '置顶会话', onclick: () => actions.onPin?.(agent) }, glyph(paths.pin)),
        el('button', {
          type: 'button',
          class: 'icon-btn tiny',
          'aria-pressed': String(Boolean(agent.archived)),
          disabled: active && !agent.archived,
          title: active && !agent.archived ? '运行或等待中的会话不可归档' : agent.archived ? '取消归档 (A)' : '归档会话 (A)',
          onclick: () => actions.onArchive?.([agent.id], !agent.archived, agent.name || agent.id.slice(0, 8)),
        }, glyph(agent.archived ? paths.unarchive : paths.archive)),
      ),
    ),
    agent.note
      ? el('button', { type: 'button', class: 'p-note', title: '点击修改备注', onclick: () => actions.onEdit?.(agent) }, glyph(paths.note), el('span', { text: agent.note }))
      : el('button', { type: 'button', class: 'p-note-add', onclick: () => actions.onEdit?.(agent) }, glyph(paths.plus), '添加会话备注…'),
    el('div', { class: 'p-props' },
      agent.title && agent.rawName && agent.title !== agent.rawName ? propRow('原名', el('code', { text: agent.rawName })) : null,
      propRow('模型', [
        el('code', { text: shortModel(agent) || modelName(agent) }),
        el('span', { class: 'prop-tag', text: `思考 ${agent.thinking || '默认'}` }),
        agent.temporaryModel ? el('span', { class: 'prop-tag warn', text: '临时' }) : null,
      ]),
      sid ? propRow('宿主', [
        el('span', { class: `prop-tag ${host.cls}`, text: host.short || host.label }),
        el('code', { text: sid.slice(0, 8) }),
        agent.watcherActive
          ? el('span', { class: 'prop-tag watch', text: '监听中' })
          : agent.callback?.enabled ? el('span', { class: 'prop-tag', text: `回调 #${agent.callback.antigravityDeliveredSeq || 0}` }) : null,
      ], sid, '已复制父会话编号') : null,
      agent.cwd ? propRow('工作区', [
        el('code', { text: shortPath(agent.cwd) }),
        agent.workspaceMode ? el('span', { class: 'prop-tag', text: agent.workspaceMode === 'worktree' ? '独立工作树' : '共享目录' }) : null,
      ], agent.cwd, '已复制工作目录') : null,
      propRow('身份', [
        el('code', { text: `${agent.id.slice(0, 8)}…${agent.id.slice(-4)}` }),
        agent.marked ? el('span', { class: 'prop-tag', text: '手动标记' }) : null,
        agent.archived ? el('span', { class: 'prop-tag', text: '已归档' }) : null,
      ], agent.id, '已复制会话身份'),
      agent.ownedPaths?.length ? propRow('范围', el('span', { class: 'muted', text: `限定 ${agent.ownedPaths.length} 个路径` })) : null,
    ),
  );
}

function renderTelemetryCard(data, agent, tools, actions) {
  const u = agent.usage || {};
  const errors = tools.calls.filter(c => c.isError).length;
  const cacheBase = (u.input || 0) + (u.cacheRead || 0);
  const ctx = data.context;
  const win = ctx?.contextWindow || agent.contextWindow;
  const used = ctx?.used || 0;
  const pct = win && used ? Math.min(100, Math.round(used / win * 100)) : null;
  const tele = $('#p-telemetry');
  const teleKey = JSON.stringify([agent.id, u.input, u.output, u.cacheRead, u.reportedCost, tools.calls.length, errors, agent.sequence, used, win]);
  if (!tele || tele.dataset.key === teleKey) return;
  tele.dataset.key = teleKey;
  const fill = el('i');
  fill.style.width = `${pct ?? 0}%`;
  fill.style.background = pct > 85 ? 'var(--fail)' : pct > 65 ? 'var(--wait)' : 'var(--brand)';
  const cells = [
    ['输入', tokens(u.input)],
    ['输出', tokens(u.output)],
    ['缓存命中', cacheBase ? `${Math.round((u.cacheRead || 0) / cacheBase * 100)}%` : '0%', u.cacheRead ? tokens(u.cacheRead) : null],
    ['工具调用', String(tools.calls.length), errors ? `${errors} 失败` : null, errors > 0],
  ];
  mount(tele,
    el('button', { type: 'button', class: 'ctx-inline', title: '查看上下文构成与增长详情', onclick: () => actions.onSwitchTab?.('context') },
      el('div', { class: 'ctx-inline-head' },
        el('span', { class: 'ctx-inline-k', text: '上下文水位' }),
        el('span', { class: 'ctx-inline-v mono', text: used ? `${tokens(used)}${win ? ` / ${tokens(win)} · ${pct}%` : ''}` : win ? `窗口 ${tokens(win)}` : '暂无请求' }),
        glyph(paths.chevron, 'ctx-arrow'),
      ),
      win ? el('div', { class: 'ctx-bar' }, fill) : null,
    ),
    el('dl', { class: 'metric-grid' }, cells.map(([name, val, extra, bad]) =>
      el('div', {}, el('dt', { text: name }), el('dd', { class: bad ? 'bad' : '' }, val, extra ? el('small', { text: extra }) : null)),
    )),
    el('div', { class: 'metric-foot' },
      el('span', { title: '模型服务返回值，非真实扣费' }, '上报 ', el('b', { text: cost(u.reportedCost) })),
      el('span', {}, '事件 ', el('b', { text: `#${agent.sequence ?? 0}` })),
    ),
  );
}

export function renderHead(data, tools, state) {
  const agent = data.agent;
  const actions = state.actions || {};
  const host = hostMeta(agentHost(agent));
  const sid = agentSessionId(agent);
  const active = working.has(agent.status);
  $('#d-dot').className = `dot ${agent.status}`;
  $('#d-name').textContent = agent.name || agent.id;
  $('#d-name').title = agent.title && agent.rawName && agent.title !== agent.rawName ? `原名：${agent.rawName}` : '';
  $('#d-model').textContent = modelName(agent);

  const badges = $('#d-badges');
  if (badges) {
    const vBadge = verificationBadge(agent);
    badges.hidden = !agent.pinned && !agent.archived && !vBadge;
    mount(badges,
      vBadge,
      agent.pinned ? el('span', { class: 'badge badge-warn', text: '已置顶' }) : null,
      agent.archived ? el('span', { class: 'badge badge-dim', text: '已归档' }) : null,
    );
  }
  const accBox = $('#p-acceptance');
  if (accBox) {
    const accKey = JSON.stringify([agent.id, agent.verification]);
    if (accBox.dataset.key !== accKey) {
      accBox.dataset.key = accKey;
      const card = renderAcceptanceCard(agent, true);
      accBox.hidden = !card;
      if (card) mount(accBox, card);
      else accBox.replaceChildren();
    }
  }
  const editBtn = $('#d-edit');
  if (editBtn) { editBtn.hidden = false; editBtn.onclick = () => actions.onEdit?.(agent); }

  const hostBtn = $('#d-host');
  if (sid) {
    hostBtn.hidden = false;
    hostBtn.className = `d-host ${host.cls}`;
    hostBtn.textContent = `${host.short || host.label} · ${sid.slice(0, 8)}${agent.watcherActive ? ' · 监听中' : ''}`;
    hostBtn.title = `点击复制父会话编号：${sid}`;
    hostBtn.onclick = () => copyText(sid, '已复制父会话编号');
  } else {
    hostBtn.hidden = true;
    hostBtn.onclick = null;
  }

  renderStatusCard(agent, actions, host, sid, active);
  renderTelemetryCard(data, agent, tools, actions);

  const report = $('#d-report');
  report.hidden = !agent.recentMessage;
  const reportBody = report.querySelector('.p-report');
  const reportHint = $('#report-hint');
  if (reportBody.dataset.text !== (agent.recentMessage || '')) {
    reportBody.dataset.text = agent.recentMessage || '';
    mount(reportBody, markdown(agent.recentMessage || ''));
    reportBody.classList.remove('expanded');
  }
  if (reportHint && !report.hidden) {
    const longReport = (agent.recentMessage || '').length > 160 || (agent.recentMessage || '').split('\n').length > 4;
    reportHint.textContent = !longReport ? '' : reportBody.classList.contains('expanded') ? '点击收起' : '点击展开';
  }

  const files = changedFiles(data);
  const badge = $('#changes-badge');
  const loaded = state.changes.get(agent.id);
  const count = loaded?.result && loaded.result.git !== false && loaded.files.length ? loaded.files.length : files.size;
  badge.hidden = !count;
  badge.textContent = count;

  const alerts = $('#d-alerts');
  const alertKey = JSON.stringify([agent.id, (agent.questions || []).map(q => q.questionId), agent.error, agent.status === 'disconnected']);
  if (alerts.dataset.key !== alertKey) {
    alerts.dataset.key = alertKey;
    alerts.replaceChildren();
    for (const q of agent.questions || []) {
      alerts.append(el('div', {
        class: 'alert clamp',
        title: '点击展开或收起',
        onclick: event => { if (!event.target.closest('button')) event.currentTarget.classList.toggle('clamp'); },
      },
      el('div', { class: 'alert-head' }, el('strong', { text: `等待父代理答复 · ${ago(q.time)}前` }), el('button', { type: 'button', class: 'btn small', onclick: () => copyText(replyPayload(q.questionId), '已复制 reply_question 参数') }, '复制答复参数')),
      el('p', { text: q.question }),
      el('small', { text: `问题身份 ${q.questionId}` })));
    }
    if (agent.error) alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '错误' }), el('p', { text: agent.error })));
    if (agent.status === 'disconnected') alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '控制进程已离线' }), el('p', { text: '在所属聊天中用 list_agents(includeSaved=true) 和 resume_agent 恢复。' })));
  }

  const bar = $('#d-now');
  const openCall = busyStatuses.has(agent.status) ? tools.open.at(-1) : null;
  const last = agent.activity?.lastEvent;
  const barKey = JSON.stringify([agent.id, agent.status, openCall?.id, data.live?.message?.blocks?.some(b => b?.type === 'text'), last?.type, last?.time]);
  $('#dock').hidden = false;
  if (bar.dataset.key === barKey) return;
  bar.dataset.key = barKey;
  bar.className = `dock-bar ${['failed', 'disconnected'].includes(agent.status) ? 'bad' : ''}`;
  bar.replaceChildren();
  const clockNode = el('span', { class: 'clock' }, el('small', { text: working.has(agent.status) ? '已用时' : '总用时' }), el('span', { id: 'd-elapsed', text: duration(elapsedOf(agent)) }));
  if (openCall) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow' }, '正在执行 ', el('code', { text: openCall.name }), ' ', el('span', { class: 'muted', 'data-since': openCall.start, text: shortDuration(Date.now() - openCall.start) })), clockNode);
  else if (agent.status === 'waiting') bar.append(el('span', { class: 'dot waiting' }), el('span', { class: 'grow', text: '暂停在提问上，等所属聊天答复' }), clockNode);
  else if (working.has(agent.status)) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow shimmer', text: data.live?.message?.blocks?.some(b => b?.type === 'text') ? '正在回复' : '正在思考' }), clockNode);
  else {
    const suffix = last ? ` · 最后动作 ${eventTypes[last.type] || last.type}${last.toolName ? ` ${last.toolName}` : ''} · ${ago(last.time)}前` : '';
    bar.append(el('span', { class: `dot ${agent.status}` }), el('span', { class: 'grow', text: `${labels[agent.status] || agent.status}${suffix}` }), clockNode);
  }
}

const partNames = [
  ['system', '系统提示', 'var(--c7)'], ['user', '任务与消息', 'var(--c2)'], ['assistant', '模型回复', 'var(--c1)'],
  ['thinking', '思考', 'var(--c3)'], ['toolCalls', '工具调用', 'var(--c4)'], ['toolResults', '工具结果', 'var(--c6)'],
];

export function renderContext(data, ptab) {
  const ctx = data.context;
  const box = $('#p-context');
  const key = JSON.stringify([data.agent.id, ctx?.requests, ctx?.used, ctx?.contextWindow, ptab]);
  if (box.dataset.key === key) return;
  const animate = box.dataset.agent !== data.agent.id;
  box.dataset.key = key;
  box.dataset.agent = data.agent.id;
  if (!ctx || !ctx.requests) {
    mount(box, el('section', { class: 'p-empty' }, glyph(paths.empty), data.transcriptError ? `会话记录无法读取：${data.transcriptError}` : '还没有完成的模型请求，暂时没有上下文数据。'));
    return;
  }
  const windowSize = ctx.contextWindow;
  const fraction = windowSize ? ctx.used / windowSize : null;
  const top = el('section', { class: 'p-sec' },
    el('header', { class: 'sec-head' }, el('h3', { text: '窗口占用' }), el('span', { class: 'sec-meta', text: `最近一次 · 共 ${ctx.requests} 次` })),
    el('div', { class: 'ctx-top' },
      gauge(fraction ?? 0, fraction == null ? tokens(ctx.used) : `${Math.round(fraction * 100)}%`, fraction == null ? '窗口未知' : '已使用'),
      el('dl', { class: 'ctx-figs' }, [['当前', tokens(ctx.used)], ['窗口', windowSize ? tokens(windowSize) : '未知'], ['剩余', windowSize ? tokens(Math.max(0, windowSize - ctx.used)) : '—'], ['峰值', tokens(ctx.peak)], ['缓存命中', ctx.used ? `${Math.round(ctx.cached / ctx.used * 100)}%` : '—'], ['压缩', `${ctx.compactions} 次`]].map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v })))),
    ),
  );
  const parts = { system: ctx.sections.reduce((s, x) => s + x.tokens, 0), ...ctx.parts };
  const total = Object.values(parts).reduce((s, v) => s + v, 0) || 1;
  const stack = el('div', { class: 'stack' });
  const list = el('ul', { class: 'breakdown' });
  for (const [k, name, color] of partNames) {
    const v = parts[k] || 0;
    if (!v) continue;
    const seg = el('i', { title: `${name} 约 ${tokens(v)}` });
    seg.style.background = color;
    seg.style.flexGrow = animate ? 0 : v;
    stack.append(seg);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { seg.style.flexGrow = v; }));
    const dot = el('i');
    dot.style.background = color;
    list.append(el('li', {}, dot, el('span', { text: name }), el('span', { class: 'v', text: tokens(v) }), el('span', { class: 'p', text: `${Math.round(v / total * 100)}%` })));
  }
  const compose = el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: '构成比例' }), el('span', { class: 'sec-meta', text: '按文字估算' })), stack, list, el('p', { class: 'ctx-note', text: '实际占用以模型上报为准；最多读取最近 500 条记录。' }));
  const values = ctx.series.map((s, i) => ({ x: i, y: s.used }));
  const cached = ctx.series.map((s, i) => ({ x: i, y: s.cached }));
  const showLimit = Boolean(windowSize && ctx.peak > windowSize * 0.6);
  const chart = areaChart({
    width: 320, height: 104, animate,
    series: [{ values, color: 'var(--c2)', label: '占用' }, { values: cached, color: 'var(--c1)', opacity: 0.12, dot: false, label: '缓存' }],
    yMax: showLimit ? windowSize * 1.02 : undefined,
    refLines: showLimit ? [{ y: windowSize, cls: 'limit' }] : [],
    tooltip: i => {
      const s = ctx.series[i];
      return [`第 ${i + 1} 次请求 · ${clock(s.at)}`, ['占用 ', { b: tokens(s.used) }, windowSize ? `（${Math.round(s.used / windowSize * 100)}%）` : ''], ['缓存 ', { b: tokens(s.cached) }, '  输出 ', { b: tokens(s.output) }], s.reasoning ? ['推理 ', { b: tokens(s.reasoning) }] : null].filter(Boolean);
    },
  });
  const growth = el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: '请求增长' }), el('span', { class: 'sec-meta', text: `最高 ${tokens(ctx.peak)}` })), chart, el('div', { class: 'legend' }, el('span', { class: 'k-used', text: '每次占用' }), el('span', { class: 'k-cached', text: '其中缓存' }), showLimit ? el('span', { class: 'k-limit', text: '窗口上限' }) : null));
  const secs = [top, compose, growth];
  if (ctx.sections.length) {
    const max = Math.max(...ctx.sections.map(s => s.tokens));
    secs.push(el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: '系统提示' }), el('span', { class: 'sec-meta', text: `约 ${tokens(parts.system)}` })), el('ul', { class: 'bars' }, ctx.sections.slice().sort((a, b) => b.tokens - a.tokens).map((s, i) => {
      const bar = el('i'); bar.style.width = `${s.tokens / max * 100}%`; bar.style.animationDelay = `${i * 40}ms`; if (!animate) bar.style.animation = 'none';
      return el('li', {}, el('span', { text: s.name }), el('span', { class: 'v', text: tokens(s.tokens) }), el('div', { class: 'meter' }, bar));
    }))));
  }
  mount(box, secs);
}
