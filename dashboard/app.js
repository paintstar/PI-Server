import {
  $, morph, mount, working, notifyOn, clock, duration, shortDuration, longDuration, ago,
  modelName, elapsedOf, showToast, apiFetch, store, syncSeg, bindResizers,
} from './dom.js';
import { bindTips, renderSpeed, drawSpeed, subscribeSpeed, closeSpeed, tickSpeed } from './charts.js';
import { renderConversation, refreshTail } from './conversation.js';
import { renderOverview, renderChips, renderList, toggleGroup } from './sidebar.js';
import {
  pairTools, renderLane, clearHead, renderHead, renderContext,
  renderToolsTab, renderEventsTab, renderResultTab, renderInfoTab,
} from './panels.js';
import { loadChanges, renderChanges } from './changes.js';
import { closeMenu, createSessionActions, agentMenu, groupMenu, renderSystemDialog } from './dialogs.js';
import { openSettingsDialog } from './settings.js';

if (location.hash) history.replaceState(null, '', location.pathname);
try { sessionStorage.removeItem('pi-dashboard-token'); } catch {}

const state = {
  agents: [], groupNames: {}, selected: store.get('selected', ''), filter: store.get('filter', 'all'),
  collapsed: new Set(store.get('collapsed2', [])), showClosed: new Set(store.get('showClosed', [])),
  tab: store.get('tab', 'messages'), ptab: store.get('ptab', 'overview'), hideTools: store.get('hideTools', false),
  paused: false, fetching: false, detailFetching: false, liveFetching: false, detail: null, recordsKey: '', renderedView: '',
  previous: new Map(), notify: store.get('notify', false), refreshedAt: null,
  sideHidden: store.get('sideHidden', null), panelHidden: store.get('panelHidden', null),
  listRendered: false, listKey: '', changes: new Map(), sseActive: false,
};

const narrow = () => innerWidth <= 760;
const compact = () => innerWidth <= 1180;
const nearBottom = box => box.scrollHeight - box.scrollTop - box.clientHeight < 120;
const post = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) });

function showError(message) {
  const err = $('#error');
  err.textContent = message || '';
  err.hidden = !message;
}

function switchPanelTab(ptab) {
  state.ptab = ptab;
  store.set('ptab', ptab);
  $('#panel-body').scrollTop = 0;
  if (state.detail) renderPanel(state.detail);
  else syncSeg($('#ptabs'), 'ptab', ptab);
}

const listHandlers = {
  onSelect: select,
  onEditAgent: a => menuActions.onEdit(a),
  onArchiveAgent: a => menuActions.onArchive([a.id], !a.archived, a.name || a.id.slice(0, 8)).catch(err => showToast(err.message)),
  onAgentMenu: (a, x, y) => agentMenu(a, x, y, state, menuActions),
  onGroupMenu: (g, x, y) => groupMenu(g, x, y, state, menuActions),
  onMoveAgent: (id, key) => menuActions.onMove(id, key).catch(err => showToast(err.message)),
};

const menuActions = createSessionActions({ state, post, refresh, onSelect: select, onSwitchTab: switchPanelTab, onToggleGroup: key => toggleGroup(key, state, listHandlers) });
state.actions = menuActions;

function syncSelectedPool() {
  const current = state.agents.find(a => a.id === state.selected);
  if (current && Boolean(current.archived) === (state.filter === 'archived')) return false;
  const pool = state.agents.filter(a => Boolean(a.archived) === (state.filter === 'archived'));
  const pick = pool.find(a => a.status === 'waiting') || pool.find(a => working.has(a.status)) || pool.find(a => a.status !== 'closed') || pool[0];
  state.selected = pick?.id || ''; state.recordsKey = ''; state.detail = null;
  return true;
}

function pickFilter(key) {
  state.filter = key; store.set('filter', key);
  const changed = syncSelectedPool();
  renderChips(state, pickFilter); renderList(state, listHandlers);
  if (changed) state.selected ? refreshDetail().catch(error => showError(error.message)) : clearHead(state.agents.length > 0);
}

function select(id) {
  if (narrow()) setSide(false);
  if (state.selected === id && state.detail) return;
  state.selected = id;
  store.set('selected', id);
  state.recordsKey = '';
  state.detail = null;
  for (const node of document.querySelectorAll('.row')) node.setAttribute('aria-current', String(node.dataset.agent === id));
  applyLayout();
  refreshDetail().catch(error => showError(error.message));
}

function moveSelection(step) {
  const rows = [...document.querySelectorAll('.row')];
  if (!rows.length) return;
  const index = rows.findIndex(r => r.dataset.agent === state.selected);
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))];
  select(next.dataset.agent);
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

function syncJump() {
  const box = $('#scroller');
  $('#jump').hidden = state.tab !== 'messages' || nearBottom(box);
}

function conversationTab(data, expanded) {
  const note = data.transcriptError
    ? `会话内容暂时无法读取：${data.transcriptError}`
    : data.live ? '正在逐字同步模型输出与工具输出' : `显示最近 ${data.messages.length} 条已保存内容`;
  return [renderConversation(data, expanded), note];
}

function renderRecords() {
  const data = state.detail;
  if (!data) return;
  const records = $('#records');
  const box = $('#scroller');
  const key = JSON.stringify([
    state.tab, state.hideTools, data.agent.sequence, data.agent.status,
    data.messages.length, data.messages.at(-1)?.id, data.live?.updatedAt,
    data.transcriptError, data.agent.lastText?.length,
  ]);
  syncSeg($('#views'), 'tab', state.tab);
  if (key === state.recordsKey) return;
  state.recordsKey = key;
  const expanded = new Map([
    ...[...records.querySelectorAll('details')].map(node => [node.dataset.key, node.open]),
    ...[...records.querySelectorAll('.bubble[data-key]')].map(node => [node.dataset.key, !node.classList.contains('clamped')]),
  ]);
  const view = `${data.agent.id}:${state.tab}`;
  const fresh = state.renderedView !== view;
  state.renderedView = view;
  const follow = state.tab === 'messages' && (fresh || nearBottom(box));
  const scroll = box.scrollTop;
  const tools = pairTools(data.agent.events);
  const [content, note] = state.tab === 'messages' ? conversationTab(data, expanded)
    : state.tab === 'tools' ? renderToolsTab(tools)
    : state.tab === 'events' ? renderEventsTab(data.agent, state, () => { state.recordsKey = ''; renderRecords(); })
    : state.tab === 'result' ? renderResultTab(data.agent)
    : renderInfoTab(data.agent);
  records.classList.toggle('enter', fresh);
  if (fresh || state.tab !== 'messages') mount(records, content);
  else morph(records, [content].flat().map(node => typeof node === 'string' ? document.createTextNode(node) : node));
  for (const live of records.querySelectorAll('.think-text.streaming, .live-tail .term-body')) live.scrollTop = live.scrollHeight;
  if (note !== $('#record-note').textContent) $('#record-note').textContent = note;
  box.scrollTop = follow ? box.scrollHeight : fresh ? 0 : scroll;
  syncJump();
}

let typingFrame = 0;
requestAnimationFrame(function pump(now) {
  requestAnimationFrame(pump);
  if (now - typingFrame < 32 || state.tab !== 'messages') return;
  typingFrame = now;
  const box = $('#scroller');
  const follow = nearBottom(box);
  if (!refreshTail()) return;
  for (const live of $('#records').querySelectorAll('.think-text.streaming')) live.scrollTop = live.scrollHeight;
  if (follow) box.scrollTop = box.scrollHeight;
});

function renderPanel(data) {
  for (const view of document.querySelectorAll('[data-pview]')) view.hidden = view.dataset.pview !== state.ptab;
  syncSeg($('#ptabs'), 'ptab', state.ptab);
  if (state.ptab === 'context') renderContext(data, state.ptab);
  if (state.ptab === 'changes') { loadChanges(data.agent.id, state, apiFetch); renderChanges(data, state, apiFetch); }
}

async function refreshDetail() {
  if (!state.selected || state.detailFetching) return;
  state.detailFetching = true;
  let data;
  const requested = state.selected;
  try { data = await apiFetch(`/api/agents/${requested}`); }
  finally { state.detailFetching = false; }
  if (state.selected !== requested) return;
  state.detail = data;
  const tools = pairTools(data.agent.events);
  $('#placeholder').hidden = true;
  renderHead(data, tools, state);
  renderSpeed(data, state.paused);
  renderLane(data.agent, tools);
  renderRecords();
  renderPanel(data);
}

function notifyChanges() {
  for (const a of state.agents) {
    const before = state.previous.get(a.id);
    if (state.notify && before && before !== a.status && notifyOn[a.status] && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${a.name || a.id.slice(0, 8)} ${notifyOn[a.status]}`, { body: modelName(a), tag: `${a.id}:${a.status}` });
      n.onclick = () => { window.focus(); select(a.id); };
    }
    state.previous.set(a.id, a.status);
  }
}

async function applyAgentsPayload(result) {
  state.agents = result.agents || [];
  state.groupNames = result.groupNames || {};
  state.refreshedAt = result.refreshedAt;
  syncSelectedPool();
  notifyChanges();
  renderOverview(state);
  renderChips(state, pickFilter);
  if ($('#menu').hidden) renderList(state, listHandlers);
  applyLayout();
  if (state.selected) await refreshDetail().catch(error => showError(error.message));
  else clearHead(state.agents.length > 0);
  if (!state.paused) {
    $('#live').className = 'live';
    $('#connection').textContent = state.sseActive ? '实时推送' : `已更新 ${clock(result.refreshedAt)}`;
  }
  const errs = result.errors || [];
  showError(errs.length ? `${errs.length} 个会话读取失败：${errs.map(e => `${e.id.slice(0, 8)} ${e.error}`).join('；')}` : '');
}

let sse = null;
let pollTimer = null;
function startPoll() { if (!pollTimer) pollTimer = setInterval(() => { if (!state.paused) refresh(); }, 2000); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startEventsStream() {
  if (state.paused || typeof EventSource === 'undefined') { startPoll(); return; }
  if (sse) return;
  const source = new EventSource('/api/events', { withCredentials: true });
  source.onopen = () => {
    state.sseActive = true;
    stopPoll();
    if (!state.paused) { $('#live').className = 'live'; $('#connection').textContent = '实时推送'; }
  };
  source.onmessage = event => { if (!state.paused) { try { applyAgentsPayload(JSON.parse(event.data)); } catch (err) { console.error(err); } } };
  source.onerror = () => {
    state.sseActive = false;
    source.close();
    if (sse === source) sse = null;
    if (!state.paused) startPoll();
  };
  sse = source;
}

async function refresh(force = false) {
  if (state.fetching || (state.paused && !force)) return;
  state.fetching = true;
  try {
    const result = await apiFetch('/api/agents');
    await applyAgentsPayload(result);
    if (!sse && !state.paused) startEventsStream();
  } catch (error) {
    $('#live').className = 'live failed';
    $('#connection').textContent = '更新失败 · 保留上次数据';
    showError(error.message);
  } finally {
    state.fetching = false;
  }
}

function tick() {
  tickSpeed();
  for (const node of document.querySelectorAll('[data-ago]')) node.textContent = ago(node.dataset.ago);
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = shortDuration(Date.now() - Number(node.dataset.since));
  for (const node of document.querySelectorAll('[data-run-start]')) node.textContent = `正在工作 ${longDuration(Date.now() - Number(node.dataset.runStart))}`;
  const agent = state.detail?.agent;
  if (agent && working.has(agent.status)) {
    for (const id of ['#d-elapsed', '#p-elapsed']) { const node = $(id); if (node) node.textContent = duration(elapsedOf(agent)); }
  }
}

function setSide(open) {
  state.sideHidden = !open;
  if (!narrow()) store.set('sideHidden', state.sideHidden);
  applyLayout();
}

function setPanel(open) {
  state.panelHidden = !open;
  if (!compact()) store.set('panelHidden', state.panelHidden);
  applyLayout();
  if (open && state.detail) { renderPanel(state.detail); renderLane(state.detail.agent, pairTools(state.detail.agent.events)); }
}

function applyLayout() {
  const app = $('#app');
  const sideHidden = narrow() ? state.sideHidden !== false : Boolean(state.sideHidden);
  const panelHidden = !state.selected || (compact() ? state.panelHidden !== false : Boolean(state.panelHidden));
  app.classList.toggle('side-hidden', sideHidden);
  app.classList.toggle('panel-hidden', panelHidden);
  $('#panel-toggle').setAttribute('aria-pressed', String(!panelHidden));
}

function setPaused(value) {
  state.paused = value;
  const button = $('#pause');
  button.setAttribute('aria-pressed', String(value));
  button.title = value ? '继续更新 (P)' : '暂停更新 (P)';
  if (value) {
    sse?.close(); sse = null; state.sseActive = false;
    stopPoll();
    closeSpeed();
    $('#live').className = 'live paused';
    $('#connection').textContent = '已暂停';
  } else {
    refresh(true);
    startEventsStream();
    if (state.selected) subscribeSpeed(state.selected, false);
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (!theme && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
}

function rerenderCharts() {
  if (!state.detail) return;
  $('#p-context').dataset.key = '';
  renderLane(state.detail.agent, pairTools(state.detail.agent.events));
  drawSpeed();
  renderPanel(state.detail);
}

function syncNotifyButton() {
  $('#notify').setAttribute('aria-pressed', String(state.notify));
  $('#notify').title = state.notify ? '状态提醒已开启' : '状态变化时提醒';
}

applyTheme(store.get('theme', null));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', null)));
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme(next);
  rerenderCharts();
});
$('#notify').addEventListener('click', async () => {
  if (!('Notification' in window)) { showToast('当前浏览器不支持通知'); return; }
  if (!state.notify && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') { showToast('浏览器没有允许通知'); return; }
  state.notify = !state.notify;
  store.set('notify', state.notify);
  syncNotifyButton();
  showToast(state.notify ? '会话等待、完成或失败时会提醒你' : '已关闭提醒');
});
$('#settings-btn').addEventListener('click', () => openSettingsDialog($('#settings-dialog'), apiFetch, () => refresh(true)));
$('#sys-btn').addEventListener('click', () => renderSystemDialog($('#sys-dialog'), apiFetch, false));
$('#d-report').addEventListener('click', () => {
  const body = $('#d-report .p-report');
  const expanded = body.classList.toggle('expanded');
  const hint = $('#report-hint');
  if (hint && hint.textContent) hint.textContent = expanded ? '点击收起' : '点击展开';
});
$('#panel-toggle').addEventListener('click', () => setPanel($('#app').classList.contains('panel-hidden')));
$('#panel-close').addEventListener('click', () => setPanel(false));
$('#side-collapse').addEventListener('click', () => setSide(false));
$('#side-open').addEventListener('click', () => setSide(true));
$('#scroller').addEventListener('scroll', syncJump);
$('.main').addEventListener('pointerdown', event => {
  const app = $('#app');
  if (event.target.closest('.main-head')) return;
  if (narrow() && !app.classList.contains('side-hidden')) { event.preventDefault(); setSide(false); }
  else if (compact() && !app.classList.contains('panel-hidden')) { event.preventDefault(); setPanel(false); }
});
$('#jump').addEventListener('click', () => $('#scroller').scrollTo({ top: $('#scroller').scrollHeight, behavior: 'smooth' }));
$('#pause').addEventListener('click', () => setPaused(!state.paused));
$('#search').addEventListener('input', () => renderList(state, listHandlers));
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => { state.tab = button.dataset.tab; store.set('tab', state.tab); state.recordsKey = ''; renderRecords(); });
}
for (const button of document.querySelectorAll('[data-ptab]')) button.addEventListener('click', () => switchPanelTab(button.dataset.ptab));
for (const dlg of document.querySelectorAll('dialog.dialog')) {
  dlg.addEventListener('click', event => { if (event.target === dlg || event.target.closest('[data-close]')) dlg.close(); });
}
document.addEventListener('pointerdown', event => { if (!$('#menu').hidden && !event.target.closest('#menu')) closeMenu(); });
addEventListener('blur', closeMenu);
$('#list').addEventListener('scroll', closeMenu);
document.addEventListener('keydown', event => {
  if (!$('#menu').hidden) {
    const items = [...$('#menu').querySelectorAll(':scope > button:not(:disabled), :scope > .sub > button')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { closeMenu(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return; }
    return;
  }
  if (document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey) return;
  const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape' && event.target.id === 'search') { event.target.value = ''; event.target.blur(); renderList(state, listHandlers); return; }
  if (isInput) return;
  if (event.key === '/') { event.preventDefault(); if (narrow()) setSide(true); $('#search').focus(); }
  else if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
  else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
  else if (event.key === 'e') { const a = state.detail?.agent || state.agents.find(x => x.id === state.selected); if (a) { event.preventDefault(); menuActions.onEdit(a); } }
  else if (event.key === 'a') { const a = state.detail?.agent || state.agents.find(x => x.id === state.selected); if (a && (!working.has(a.status) || a.archived)) { event.preventDefault(); menuActions.onArchive([a.id], !a.archived, a.name || a.id.slice(0, 8)).catch(err => showToast(err.message)); } }
  else if (event.key === 'p') setPaused(!state.paused);
  else if (event.key === '[') setSide($('#app').classList.contains('side-hidden'));
  else if (event.key === ']') setPanel($('#app').classList.contains('panel-hidden'));
  else if (event.key === ',') { event.preventDefault(); openSettingsDialog($('#settings-dialog'), apiFetch, () => refresh(true)); }
  else if (event.key === '?') { event.preventDefault(); $('#help-dialog').showModal(); }
  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const a = state.agents.find(x => x.id === state.selected);
    const node = document.querySelector('.row[aria-current="true"]');
    if (a && node) { event.preventDefault(); const box = node.getBoundingClientRect(); agentMenu(a, box.left + 40, box.bottom, state, menuActions); }
  }
});
let resizeTimer;
addEventListener('resize', () => {
  applyLayout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { syncSeg($('#views'), 'tab', state.tab); syncSeg($('#ptabs'), 'ptab', state.ptab); }, 60);
});
new ResizeObserver(() => {
  if (state.detail && !$('#app').classList.contains('dragging')) renderLane(state.detail.agent, pairTools(state.detail.agent.events));
}).observe($('#lane-wrap'));
window.addEventListener('hashchange', () => { history.replaceState(null, '', location.pathname); setPaused(false); });
bindTips($('#lane-wrap'));
bindResizers(() => {
  if (state.detail) renderLane(state.detail.agent, pairTools(state.detail.agent.events));
  syncSeg($('#views'), 'tab', state.tab);
  syncSeg($('#ptabs'), 'ptab', state.ptab);
});
syncNotifyButton();
applyLayout();
requestAnimationFrame(() => { syncSeg($('#views'), 'tab', state.tab); syncSeg($('#ptabs'), 'ptab', state.ptab); });
refresh(true).then(applyLayout);
async function pollLive() {
  const cur = state.detail;
  if (state.paused || state.detailFetching || state.liveFetching || !cur || !working.has(cur.agent?.status)) return;
  const id = cur.agent.id; state.liveFetching = true;
  try {
    const live = await apiFetch(`/api/agents/${id}/live`);
    if (state.detail?.agent?.id !== id) return;
    if (live.sequence !== cur.agent.sequence || live.status !== cur.agent.status || (live.sessionBytes !== undefined && live.sessionBytes !== cur.sessionBytes) || (cur.live && !live.live)) { await refreshDetail(); return; }
    cur.live = live.live; if (live.usage) cur.agent.usage = live.usage;
    renderHead(cur, pairTools(cur.agent.events), state); renderRecords(); renderSpeed(cur, state.paused);
  } finally { state.liveFetching = false; }
}
setInterval(tick, 1000);
setInterval(() => { pollLive().catch(error => showError(error.message)); }, 350);
