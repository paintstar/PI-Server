import {
  el, glyph, paths, labels, eventTypes, commTypes, badTypes,
  clock, fullDate, shortDuration, tokens, modelName, agentHost, hostMeta, agentSessionId, copyText, store,
} from './dom.js';
import { markdown } from './conversation.js';

export function renderToolsTab(tools) {
  const stats = new Map();
  for (const c of tools.calls) {
    const s = stats.get(c.name) || { name: c.name, count: 0, errors: 0, time: 0, timed: 0 };
    s.count++;
    if (c.isError) s.errors++;
    if (c.end != null) { s.time += c.end - c.start; s.timed++; }
    stats.set(c.name, s);
  }
  const rows = [...stats.values()].sort((a, b) => b.count - a.count);
  if (!rows.length) return [el('p', { class: 'records-empty', text: '还没有工具调用。' }), ''];
  const max = Math.max(1, ...rows.map(r => r.count));
  const meter = n => { const bar = el('i'); bar.style.width = `${n / max * 100}%`; return el('div', { class: 'meter' }, bar); };
  const summary = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: '工具' }), el('th', { text: '次数' }), el('th', { class: 'num', text: '调用' }), el('th', { class: 'num', text: '失败' }), el('th', { class: 'num', text: '平均耗时' }), el('th', { class: 'num', text: '合计' }))),
    el('tbody', {}, rows.map(r => el('tr', {},
      el('td', {}, el('code', { text: r.name })),
      el('td', {}, meter(r.count)),
      el('td', { class: 'num', text: r.count }),
      el('td', { class: `num ${r.errors ? 'bad' : ''}`, text: r.errors }),
      el('td', { class: 'num', text: r.timed ? shortDuration(r.time / r.timed) : '—' }),
      el('td', { class: 'num', text: r.timed ? shortDuration(r.time) : '—' }),
    ))),
  );
  const recent = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: '开始' }), el('th', { text: '工具' }), el('th', { text: '结果' }), el('th', { class: 'num', text: '耗时' }))),
    el('tbody', {}, tools.calls.slice(-40).reverse().map(c => el('tr', { class: c.isError ? 'err' : '' },
      el('td', { class: 'mono', text: clock(c.start) }),
      el('td', {}, el('code', { text: c.name })),
      el('td', { class: c.isError ? 'bad' : '', text: c.end == null ? '进行中' : c.isError ? '失败' : '成功' }),
      c.end == null ? el('td', { class: 'num', 'data-since': c.start, text: shortDuration(Date.now() - c.start) }) : el('td', { class: 'num', text: shortDuration(c.end - c.start) }),
    ))),
  );
  return [[summary, el('p', { class: 'section-title', text: '最近 40 次调用' }), recent], '根据最近 500 条事件统计；耗时从工具开始到结束事件计算。'];
}

export function renderEventsTab(agent, state, onToggle) {
  const toggle = el('input', {
    type: 'checkbox',
    checked: state.hideTools,
    onchange: event => { state.hideTools = event.target.checked; store.set('hideTools', state.hideTools); onToggle(); },
  });
  const events = (agent.events || []).filter(e => !state.hideTools || !e.type.startsWith('tool_execution')).slice(-200).reverse();
  const list = el('ul', { class: 'events', onclick: event => event.target.closest('li')?.classList.toggle('open') }, events.map(e => {
    const cls = e.type === 'question' ? 'question' : commTypes.has(e.type) ? 'comm' : badTypes.has(e.type) || e.isError ? 'bad' : e.type.startsWith('tool_') ? 'tool' : '';
    const text = e.question || e.message || e.error || e.text || e.reason || '';
    return el('li', {},
      el('time', { title: fullDate(e.time), text: clock(e.time) }),
      el('span', { class: `type ${cls}`, text: eventTypes[e.type] || e.type }),
      el('div', { class: 'body' }, el('span', { class: 'seq', text: `#${e.sequence}` }), e.toolName ? el('code', { text: e.toolName }) : null, e.isError ? ' 失败' : null, text ? `${e.toolName ? ' · ' : ''}${text}` : null),
    );
  }));
  return [[el('div', { class: 'subbar' }, el('label', {}, toggle, '隐藏工具事件')), events.length ? list : el('p', { class: 'records-empty', text: '暂时没有事件。' })], '最近 200 条状态与通信记录，最新在前。'];
}

export function renderResultTab(agent, collabNodes = []) {
  const text = agent.lastText || agent.recentMessage || '';
  const copy = el('button', { type: 'button', class: 'btn small', onclick: () => copyText(text, '已复制结果'), disabled: !text }, glyph(paths.copy), '复制结果');
  const topNodes = Array.isArray(collabNodes) ? collabNodes.filter(Boolean) : [collabNodes].filter(Boolean);
  return [
    [...topNodes, el('div', { class: 'subbar' }, copy), text ? markdown(text) : el('p', { class: 'records-empty', text: '暂时没有模型结果。' })],
    '模型最近保存的回复。是否满足要求，仍需结合验收检查与实际改动独立确认。',
  ];
}

export function renderInfoTab(agent) {
  const code = text => el('code', { text: text || '—' });
  const host = hostMeta(agentHost(agent));
  const sid = agentSessionId(agent);
  const cbSeq = agent.callback?.deliveredSeq ?? agent.callback?.antigravityDeliveredSeq ?? 0;
  const cbText = agent.callback
    ? `${agent.callback.enabled ? '已开启' : '未开启'} · 已投递 seq ${cbSeq}${agent.callback.lastObservedBy ? `（${agent.callback.lastObservedBy}）` : ''}${agent.watcherActive ? ' · 监听活跃' : ''}`
    : '未启用回调';
  const v = agent.verification;
  const verifyText = v && v.status && v.status !== 'none'
    ? `${v.status}（${v.passedCount ?? 0}/${v.totalCount ?? v.checks?.length ?? 0}）${v.sandboxBackend ? ` · ${v.sandboxBackend}` : ''}`
    : '未配置机械验收检查';
  const orch = agent.orchestration;
  const rows = [
    ['身份', code(agent.id)],
    agent.title && agent.rawName ? ['显示名称', `${agent.title}（原名：${agent.rawName}）`] : null,
    agent.note ? ['会话备注', agent.note] : null,
    ['状态记录', `${labels[agent.recordedStatus] || agent.recordedStatus} · 控制进程${agent.controllerAlive ? '在线' : '不在线'}${agent.pinned ? ' · 已置顶' : ''}${agent.archived ? ' · 已归档' : ''}${agent.marked ? ' · 面板手动标记' : ''}`],
    ['验收闭环', verifyText],
    orch ? ['协作编排', `${orch.kind} · run ${orch.runId?.slice(0, 8) || '—'}${orch.role ? ` · ${orch.role}` : ''}`] : null,
    ['父会话', sid ? `${host.label} · ${sid}` : '未绑定父会话编号'],
    ['回调状态', cbText],
    ['父会话目录', code(agent.parentInfo?.cwd)],
    ['工作目录', code(agent.cwd)],
    ['来源目录', code(agent.sourceCwd)],
    ['目录模式', agent.workspaceMode === 'worktree' ? '独立 Git 工作目录' : agent.workspaceMode || '—'],
    ['文件范围', agent.ownedPaths?.length ? el('ul', { class: 'paths' }, agent.ownedPaths.map(p => el('li', { text: p }))) : '未限定'],
    ['开始时间', fullDate(agent.createdAt)],
    ['更新时间', fullDate(agent.updatedAt)],
    ['模型', `${modelName(agent)} · 思考 ${agent.thinking || '默认'}${agent.contextWindow ? ` · 窗口 ${tokens(agent.contextWindow)}` : ''}`],
    ['用量明细', `输入 ${agent.usage?.input || 0} · 输出 ${agent.usage?.output || 0} · 缓存读 ${agent.usage?.cacheRead || 0} · 缓存写 ${agent.usage?.cacheWrite || 0}`],
  ].filter(Boolean);
  return [el('dl', { class: 'info' }, rows.flatMap(([k, vNode]) => [el('dt', { text: k }), el('dd', {}, vNode)])), '上报费用来自模型服务的返回值，不等于真实扣费记录。'];
}
