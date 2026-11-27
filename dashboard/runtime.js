import { $ } from './dom.js';

export function createStreamController({ state, apiFetch, applyAgentsPayload, showError, onStreamState }) {
  let sse = null;
  let pollTimer = null;

  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const refresh = async (force = false) => {
    if (state.fetching || (state.paused && !force)) return;
    state.fetching = true;
    try {
      const [result, runsPayload] = await Promise.all([
        apiFetch('/api/agents'),
        apiFetch('/api/runs').catch(() => null),
      ]);
      if (runsPayload && Array.isArray(runsPayload.runs)) state.runsList = runsPayload.runs;
      await applyAgentsPayload(result);
      if (!sse && !state.paused) startEventsStream();
    } catch (error) {
      $('#live').className = 'live failed';
      $('#connection').textContent = '更新失败 · 保留上次数据';
      showError(error.message);
    } finally {
      state.fetching = false;
    }
  };

  const startPoll = () => {
    if (!pollTimer) pollTimer = setInterval(() => { if (!state.paused) refresh(); }, 2000);
  };

  const startEventsStream = () => {
    if (state.paused || typeof EventSource === 'undefined') { startPoll(); return; }
    if (sse) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    source.onopen = () => {
      state.sseActive = true;
      stopPoll();
      onStreamState?.(true);
    };
    source.onmessage = event => {
      if (state.paused) return;
      try {
        const parsed = JSON.parse(event.data);
        applyAgentsPayload(parsed);
        apiFetch('/api/runs').then(p => { if (Array.isArray(p?.runs)) state.runsList = p.runs; }).catch(() => {});
      } catch (err) { console.error(err); }
    };
    source.onerror = () => {
      state.sseActive = false;
      source.close();
      if (sse === source) sse = null;
      if (!state.paused) startPoll();
    };
    sse = source;
  };

  const stopStream = () => {
    sse?.close();
    sse = null;
    state.sseActive = false;
    stopPoll();
  };

  return { refresh, startEventsStream, stopStream, startPoll, stopPoll };
}

export function bindKeyboard({
  state,
  working,
  narrow,
  setSide,
  setPanel,
  setPaused,
  moveSelection,
  renderList,
  listHandlers,
  menuActions,
  agentMenu,
  closeMenu,
  openSettingsDialog,
  apiFetch,
  refresh,
}) {
  document.addEventListener('keydown', event => {
    if (!$('#menu').hidden) {
      const items = [...$('#menu').querySelectorAll(':scope > button:not(:disabled), :scope > .sub > button')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { closeMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
      return;
    }
    if (document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey) return;
    const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === 'Escape' && event.target.id === 'search') {
      event.target.value = '';
      event.target.blur();
      renderList(state, listHandlers);
      return;
    }
    if (isInput) return;
    if (event.key === '/') { event.preventDefault(); if (narrow()) setSide(true); $('#search').focus(); }
    else if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
    else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
    else if (event.key === 'e') {
      const a = state.detail?.agent || state.agents.find(x => x.id === state.selected);
      if (a) { event.preventDefault(); menuActions.onEdit(a); }
    } else if (event.key === 'a') {
      const a = state.detail?.agent || state.agents.find(x => x.id === state.selected);
      if (a && (!working.has(a.status) || a.archived)) {
        event.preventDefault();
        menuActions.onArchive([a.id], !a.archived, a.name || a.id.slice(0, 8));
      }
    } else if (event.key === 'p') setPaused(!state.paused);
    else if (event.key === '[') setSide($('#app').classList.contains('side-hidden'));
    else if (event.key === ']') setPanel($('#app').classList.contains('panel-hidden'));
    else if (event.key === ',') { event.preventDefault(); openSettingsDialog($('#settings-dialog'), apiFetch, () => refresh(true)); }
    else if (event.key === '?') { event.preventDefault(); $('#help-dialog').showModal(); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const a = state.agents.find(x => x.id === state.selected);
      const node = document.querySelector('.row[aria-current="true"]');
      if (a && node) {
        event.preventDefault();
        const box = node.getBoundingClientRect();
        agentMenu(a, box.left + 40, box.bottom, state, menuActions);
      }
    }
  });
}
