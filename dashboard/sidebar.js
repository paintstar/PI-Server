import {
  $, el, glyph, paths, labels, order, colors, working, busyStatuses, attention, filters,
  ms, ago, tokens, cost, modelName, agentHost, hostMeta, agentSessionId, store, mount,
} from './dom.js';

function combinedSpeed(agents) {
  const recent = agents.filter(a => working.has(a.status) && a.speed && Date.now() - ms(a.speed.at) < 180000);
  return recent.length ? `${Math.round(recent.reduce((sum, a) => sum + a.speed.tps, 0))}/s` : '—';
}

export function renderOverview(state) {
  const active = state.agents.filter(a => !a.archived);
  const archivedCount = state.agents.length - active.length;
  const counts = new Map();
  for (const a of active) counts.set(a.status, (counts.get(a.status) || 0) + 1);
  const dist = $('#dist');
  dist.replaceChildren();
  for (const status of order) {
    const n = counts.get(status);
    if (!n) continue;
    const bar = el('i', { title: `${labels[status] || status} ${n}` });
    bar.style.flexGrow = n;
    bar.style.background = `var(${colors[status] || '--idle'})`;
    dist.append(bar);
  }
  const sum = key => state.agents.reduce((total, a) => total + (a.usage?.[key] || 0), 0);
  mount($('#totals'),
    el('span', { title: archivedCount ? `活跃 ${active.length} · 已归档 ${archivedCount}` : `活跃会话 ${active.length}` }, '运行', el('b', { text: active.filter(a => busyStatuses.has(a.status)).length })),
    el('span', { title: '全部会话输入 + 输出 token' }, 'Token', el('b', { text: tokens(sum('input') + sum('output')) })),
    el('span', { title: '模型服务上报的费用，不是真实扣费记录' }, '上报', el('b', { text: cost(sum('reportedCost')) })),
    el('span', { title: '工作中会话最近一次请求的输出速度之和' }, '速度', el('b', { text: combinedSpeed(active) })),
  );
  const waiting = counts.get('waiting') || 0;
  document.title = waiting ? `(${waiting} 待答复) Pi 调度台` : 'Pi 调度台';
}

const commonDir = list => {
  const parts = list.map(p => p.split('/'));
  let n = parts[0].length;
  for (const p of parts) {
    let i = 0;
    while (i < n && i < p.length && p[i] === parts[0][i]) i++;
    n = i;
  }
  return parts[0].slice(0, n).join('/') || '/';
};

function directoryName(dirPath) {
  const scratch = /^\/private\/tmp\/claude-\d+\/[^/]+\/([0-9a-f]{8})[0-9a-f-]*(\/|$)/.exec(dirPath);
  return scratch ? `Claude 会话 ${scratch[1]}` : dirPath.replace(/\/+$/, '').split('/').pop() || '/';
}

export function bucketOf(agent) {
  const sid = agentSessionId(agent);
  return sid ? `sid:${sid}` : `pid:${agent.parentId || ''}`;
}

export function parentGroups(agents) {
  const byBucket = new Map();
  for (const a of agents) {
    const bucket = bucketOf(a);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(a);
  }
  return new Map([...byBucket].map(([bucket, list]) => {
    const sample = list.find(a => a.parentInfo || a.callback) || list[0];
    const sid = agentSessionId(sample);
    const host = hostMeta(agentHost(sample));
    const dirs = list.map(a => a.parentInfo?.cwd || a.sourceCwd || a.cwd).filter(Boolean);
    const cwd = sample?.parentInfo?.cwd || (dirs.length ? commonDir(dirs) : '');
    if (sid) {
      const prefix = host.short || '会话';
      return [bucket, {
        key: `s:${sid}`,
        cwd,
        sessionId: sid,
        host,
        tag: `${prefix} ${sid.slice(0, 8)}`,
        detail: `${host.label} 会话 ${sid}`,
      }];
    }
    const pid = sample?.parentId || '';
    return [bucket, {
      key: `p:${pid || '未知'}`,
      cwd,
      inferred: !sample?.parentInfo?.cwd,
      host,
      tag: pid ? `${host.short || '旧代理'} ${pid.slice(0, 6)}` : '',
      detail: '未绑定显式父会话编号，按父连接与工作目录归组',
    }];
  }));
}

export function buildGroups(visibleList, state) {
  const parents = parentGroups(state.agents);
  const groups = new Map();
  for (const [, p] of parents) {
    if (!groups.has(p.key)) groups.set(p.key, { key: p.key, info: p, agents: [] });
  }
  for (const a of visibleList) {
    const own = parents.get(bucketOf(a));
    const key = a.movedTo || own?.key || 'p:未知';
    if (!groups.has(key)) {
      groups.set(key, { key, info: { key, custom: true, detail: '手动建立的分组', tag: '' }, agents: [] });
    }
    groups.get(key).agents.push(a);
  }
  for (const g of groups.values()) {
    const customName = Object.hasOwn(state.groupNames, g.key) ? state.groupNames[g.key] : '';
    g.name = customName
      || (g.info.custom ? g.key.replace(/^custom:/, '') : g.info.cwd && g.info.cwd !== '/' ? directoryName(g.info.cwd) : '未归类会话');
  }
  return groups;
}

const rank = a => attention.has(a.status) ? 0 : busyStatuses.has(a.status) ? 1 : a.pinned ? 2 : a.status === 'closed' ? 4 : 3;

function indicator(a) {
  if (busyStatuses.has(a.status)) return el('span', { class: 'spin', title: labels[a.status] });
  if (a.status === 'waiting') return el('span', { class: 'dot waiting', title: '等待答复' });
  if (a.status === 'failed' || a.status === 'disconnected') return el('span', { class: 'bang', title: labels[a.status] });
  if (a.status === 'completed') return glyph(paths.check, 'check');
  if (a.status === 'closed') return null;
  return el('span', { class: 'ring-off', title: labels[a.status] || a.status });
}

export function visibleAgents(state) {
  const query = ($('#search')?.value || '').trim().toLowerCase();
  const filter = filters.find(f => f.key === state.filter) || filters[0];
  return state.agents.filter(a => (state.filter === 'all' && query ? true : filter.match(a.status, a)) && (!query || `${a.name} ${a.rawName || ''} ${a.note || ''} ${modelName(a)} ${a.cwd} ${a.sourceCwd} ${a.id} ${agentSessionId(a) || ''} ${a.parentInfo?.cwd || ''}`.toLowerCase().includes(query)));
}

export function renderChips(state, onPick) {
  const chips = $('#chips');
  chips.replaceChildren();
  for (const f of filters) {
    const count = state.agents.filter(a => f.match(a.status, a)).length;
    if (f.secondary && !count && state.filter !== f.key) continue;
    chips.append(el('button', {
      type: 'button',
      'aria-pressed': String(state.filter === f.key),
      onclick: () => onPick(f.key),
    }, f.title, el('span', { text: count })));
  }
}

function row(a, state, handlers) {
  const canArchive = !working.has(a.status) || a.archived;
  const tipLines = [
    `${a.name || a.id}${a.title && a.rawName && a.title !== a.rawName ? `（原名：${a.rawName}）` : ''}`,
    `${modelName(a)} · ${labels[a.status] || a.status}${a.pinned ? ' · 已置顶' : ''}${a.archived ? ' · 已归档' : ''}${a.marked ? ' · 手动标记' : ''}`,
    a.note ? `备注：${a.note}` : '',
  ].filter(Boolean).join('\n');
  return el('button', {
    type: 'button',
    class: `row ${a.status === 'closed' ? 'closed' : ''} ${a.archived ? 'archived' : ''} ${a.pinned ? 'pinned' : ''}`.trim(),
    'data-agent': a.id,
    'aria-current': String(a.id === state.selected),
    draggable: 'true',
    title: tipLines,
    onclick: () => handlers.onSelect(a.id),
    ondblclick: () => handlers.onEditAgent(a),
    oncontextmenu: event => {
      event.preventDefault();
      handlers.onSelect(a.id);
      handlers.onAgentMenu(a, event.clientX, event.clientY);
    },
    ondragstart: event => {
      event.dataTransfer.setData('text/agent', a.id);
      event.dataTransfer.effectAllowed = 'move';
    },
  },
  el('span', { class: 'ind' }, indicator(a)),
  a.pinned ? glyph(paths.pin, 'pin-ico') : null,
  el('span', { class: 'name', text: a.name || a.id.slice(0, 8) }),
  a.note ? glyph(paths.note, 'note-ico') : null,
  a.watcherActive ? el('span', { class: 'watch-dot', title: '正在监听回调事件' }) : null,
  a.movedTo ? glyph(paths.move, 'moved') : null,
  el('span', { class: 'ago', 'data-ago': a.updatedAt, text: ago(a.updatedAt) }),
  el('span', { class: 'row-tools' },
    canArchive ? el('span', {
      class: 'row-act',
      role: 'button',
      title: a.archived ? '取消归档' : '归档会话',
      onclick: event => {
        event.stopPropagation();
        handlers.onArchiveAgent(a);
      },
    }, glyph(a.archived ? paths.unarchive : paths.archive)) : null,
    el('span', {
      class: 'row-act more',
      role: 'button',
      title: '更多操作',
      onclick: event => {
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        handlers.onAgentMenu(a, box.right - 6, box.bottom + 4);
      },
    }, glyph(paths.more)),
  ));
}

function listKey(state) {
  return JSON.stringify([
    state.filter,
    $('#search')?.value || '',
    [...state.collapsed],
    [...state.showClosed],
    state.groupNames,
    state.selected,
    state.agents.map(a => [a.id, a.status, a.name, a.title, a.note, a.pinned, a.archived, a.movedTo, a.marked, a.watcherActive, a.parentId, agentSessionId(a)]),
  ]);
}

export function renderList(state, handlers, force = false) {
  const key = listKey(state);
  if (!force && key === state.listKey) return;
  state.listKey = key;
  const focused = document.activeElement?.dataset?.agent;
  const list = $('#list');
  const scroll = list.scrollTop;
  list.replaceChildren();
  list.classList.toggle('no-anim', state.listRendered);
  const visible = visibleAgents(state);
  const searching = Boolean(($('#search')?.value || '').trim() || state.filter !== 'all');
  const groups = [...buildGroups(visible, state).values()].filter(g => g.agents.length);
  const latest = g => Math.max(...g.agents.map(a => (rank(a) < 4 ? 1e13 : 0) + (a.pinned ? 5e12 : 0) + (ms(a.updatedAt) || 0)));
  groups.sort((x, y) => latest(y) - latest(x));

  for (const g of groups) {
    const open = searching || !state.collapsed.has(g.key);
    const fail = g.agents.filter(a => a.status === 'failed' || a.status === 'disconnected').length;
    const wait = g.agents.filter(a => a.status === 'waiting').length;
    const busy = g.agents.filter(a => busyStatuses.has(a.status)).length;
    const head = el('button', {
      type: 'button',
      class: 'proj-head',
      'aria-expanded': String(open),
      'data-group': g.key,
      title: `${g.info.detail || ''}${g.info.cwd ? `\n目录：${g.info.cwd}${g.info.inferred ? '（推断）' : ''}` : ''}`,
      onclick: () => toggleGroup(g.key, state, handlers),
      oncontextmenu: event => {
        event.preventDefault();
        handlers.onGroupMenu(g, event.clientX, event.clientY);
      },
      ondragover: event => {
        if (event.dataTransfer.types.includes('text/agent')) {
          event.preventDefault();
          head.classList.add('dragover');
        }
      },
      ondragleave: () => head.classList.remove('dragover'),
      ondrop: event => {
        event.preventDefault();
        head.classList.remove('dragover');
        const id = event.dataTransfer.getData('text/agent');
        if (id) handlers.onMoveAgent(id, g.key);
      },
    },
    glyph(paths.folder, 'folder'),
    el('span', { class: 'proj-name', text: g.name }),
    el('span', { class: 'proj-tag', text: g.info.tag || '' }),
    el('span', { class: 'proj-flags' },
      fail ? el('span', { class: 'flag fail', title: '异常', text: fail }) : null,
      wait ? el('span', { class: 'flag wait', title: '待答复', text: wait }) : null,
      busy ? el('span', { class: 'flag run', title: '正在工作' }, el('i'), String(busy)) : null,
    ),
    el('span', {
      class: 'proj-more',
      role: 'button',
      title: '分组操作',
      onclick: event => {
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        handlers.onGroupMenu(g, box.right - 6, box.bottom + 4);
      },
    }, glyph(paths.more)));

    const inner = el('div');
    const members = g.agents.slice().sort((a, b) => rank(a) - rank(b) || (ms(b.updatedAt) || 0) - (ms(a.updatedAt) || 0));
    const live = members.filter(a => a.status !== 'closed');
    const closed = members.filter(a => a.status === 'closed');
    for (const a of live) inner.append(row(a, state, handlers));
    if (closed.length) {
      const auto = searching || state.filter === 'closed' || (!live.length && closed.length <= 3);
      const showAll = auto || state.showClosed.has(g.key);
      if (!auto) {
        inner.append(el('button', {
          type: 'button',
          class: 'fold-row',
          'aria-expanded': String(showAll),
          onclick: () => {
            state.showClosed.has(g.key) ? state.showClosed.delete(g.key) : state.showClosed.add(g.key);
            store.set('showClosed', [...state.showClosed]);
            renderList(state, handlers, true);
          },
        }, glyph(paths.chevron), showAll ? `收起已关闭 ${closed.length}` : `已关闭 ${closed.length}`));
      }
      if (showAll) for (const a of closed) inner.append(row(a, state, handlers));
    }
    list.append(el('section', { class: `proj ${open ? '' : 'collapsed'}` }, head, el('div', { class: 'proj-body' }, inner)));
  }

  list.scrollTop = scroll;
  state.listRendered = true;
  for (const node of list.querySelectorAll('.row')) {
    if (node.dataset.agent === focused) node.focus({ preventScroll: true });
  }
  const empty = $('#empty');
  empty.hidden = visible.length > 0;
  empty.textContent = !state.agents.length
    ? '还没有会话。创建子代理后会出现在这里。'
    : state.filter === 'archived'
      ? '还没有归档会话。可将已结束的会话归档收纳到这里。'
      : '没有符合条件的会话';
}

export function toggleGroup(key, state, handlers) {
  state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
  store.set('collapsed2', [...state.collapsed]);
  const section = document.querySelector(`.proj-head[data-group="${CSS.escape(key)}"]`)?.parentElement;
  if (section) {
    section.classList.toggle('collapsed', state.collapsed.has(key));
    section.querySelector('.proj-head').setAttribute('aria-expanded', String(!state.collapsed.has(key)));
  } else {
    renderList(state, handlers, true);
  }
}

export function defaultAgentGroupKey(a, agents) {
  return parentGroups(agents).get(bucketOf(a))?.key || '';
}

export function currentAgentGroupKey(a, agents) {
  return a.movedTo || defaultAgentGroupKey(a, agents);
}
