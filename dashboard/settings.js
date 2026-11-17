import { el, showToast } from './dom.js';
import { renderModelsTab, renderToolsTab } from './settings-views.js';

function keyOf(m) {
  return `${m.provider}/${m.model}`;
}

function defaultDraft(m) {
  return {
    enabled: true,
    contextWindow: m.baseContextWindow,
    maxTokens: m.baseMaxTokens,
    recommendedThinking: m.defaultRecommendedThinking || m.recommendedThinking,
    description: m.defaultDescription,
  };
}

function baseModelDraft(m) {
  return {
    enabled: m.modelEnabled !== false,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    recommendedThinking: m.recommendedThinking,
    description: m.customDescription ? m.description : m.defaultDescription,
  };
}

function normalizeNumField(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

function buildDirtyModels(state) {
  const byKey = new Map((state.payload?.models || []).map(m => [keyOf(m), m]));
  const models = {};
  for (const key of state.resets) models[key] = null;
  for (const [key, draft] of state.drafts.entries()) {
    const m = byKey.get(key);
    const patch = {};
    if (!m || draft.enabled !== (m.modelEnabled !== false)) patch.enabled = draft.enabled;
    const nextCtx = normalizeNumField(draft.contextWindow);
    const prevCtx = m?.contextWindow ?? null;
    if (!m || nextCtx !== prevCtx) patch.contextWindow = nextCtx;
    const nextMax = normalizeNumField(draft.maxTokens);
    const prevMax = m?.maxTokens ?? null;
    if (!m || nextMax !== prevMax) patch.maxTokens = nextMax;
    const nextThink = draft.recommendedThinking || null;
    if (!m || nextThink !== m.recommendedThinking) patch.recommendedThinking = nextThink;
    const prevDesc = m?.customDescription ? m.description : (m?.defaultDescription || '');
    if (!m || (draft.description ?? '') !== prevDesc) {
      patch.description = draft.description === m?.defaultDescription ? null : draft.description;
    }
    if (Object.keys(patch).length) models[key] = patch;
  }
  return models;
}

function selectPreferredProvider(state) {
  const list = state.payload?.providers || [];
  if (!list.length) { state.selectedProvider = null; return; }
  if (list.some(item => item.provider === state.selectedProvider)) return;
  const preferred = list.find(item => item.enabled && item.configured && item.totalModelsCount > 0)
    || list.find(item => item.configured && item.totalModelsCount > 0)
    || list[0];
  state.selectedProvider = preferred.provider;
}

function toolsDraftFromPayload(payload) {
  const d = payload?.defaults || {};
  return {
    sandboxMode: d.sandboxMode || '',
    allowNetwork: d.allowNetwork !== false,
    thinking: d.thinking || 'high',
    loadSkills: d.loadSkills !== false,
    loadContextFiles: d.loadContextFiles !== false,
  };
}

let activeOpenSeq = 0;

export async function openSettingsDialog(dialogEl, apiFetch, onSaved) {
  const openSeq = ++activeOpenSeq;
  const state = {
    tab: 'models',
    payload: null,
    selectedProvider: null,
    providerQuery: '',
    modelQuery: '',
    drafts: new Map(),
    resets: new Set(),
    toolsDraft: null,
    authNotes: new Map(),
    confirmClear: null,
    busy: false,
    error: null,
  };

  function currentDraft(m) {
    const key = keyOf(m);
    if (state.drafts.has(key)) return state.drafts.get(key);
    return state.resets.has(key) ? defaultDraft(m) : baseModelDraft(m);
  }

  function syncSaveModelsButton() {
    const btn = dialogEl.querySelector('#save-models-btn');
    if (!btn) return;
    const count = dirtyCount();
    btn.disabled = state.busy || count === 0;
    btn.textContent = count ? `保存模型配置 (${count})` : '保存模型配置';
  }

  function updateDraft(m, patch) {
    const key = keyOf(m);
    state.resets.delete(key);
    state.drafts.set(key, { ...currentDraft(m), ...patch });
    syncSaveModelsButton();
  }

  function dirtyCount() {
    return Object.keys(buildDirtyModels(state)).length;
  }

  async function loadSettings(forceRefresh = false) {
    state.busy = true;
    state.error = null;
    render();
    try {
      const payload = await apiFetch(`/api/settings${forceRefresh ? '?refresh=1' : ''}`);
      if (openSeq !== activeOpenSeq || !dialogEl.open) return;
      state.payload = payload;
      state.toolsDraft ||= toolsDraftFromPayload(payload);
      selectPreferredProvider(state);
      if (forceRefresh) showToast('已刷新 Pi 模型目录');
    } catch (error) {
      if (openSeq !== activeOpenSeq || !dialogEl.open) return;
      state.error = error.message;
    } finally {
      if (openSeq === activeOpenSeq && dialogEl.open) {
        state.busy = false;
        render();
      }
    }
  }

  async function postAction(url, body, okMessage) {
    state.busy = true;
    render();
    try {
      const res = await apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
      if (openSeq !== activeOpenSeq) return null;
      if (res.settings) {
        state.payload = res.settings;
        if (body?.provider) state.authNotes.set(body.provider, res);
      } else {
        state.payload = res;
        if (body?.defaults) state.toolsDraft = toolsDraftFromPayload(res);
      }
      state.confirmClear = null;
      selectPreferredProvider(state);
      if (res.ok === false) showToast(`${body?.provider || ''} 凭据异常：${res.reason || res.status}`.trim());
      else showToast(okMessage);
      if (onSaved) onSaved();
      return res;
    } catch (error) {
      showToast(error.message);
      return null;
    } finally {
      if (openSeq === activeOpenSeq && dialogEl.open) {
        state.busy = false;
        render();
      }
    }
  }

  function render() {
    if (openSeq !== activeOpenSeq) return;
    const body = el('div', { className: 'dialog-body settings-body' });
    if (state.error) body.append(el('div', { className: 'err-card' }, state.error));
    else if (!state.payload) body.append(el('div', { className: 'empty-mini' }, '加载模型与设置中…'));
    else {
      if (state.payload.catalogRefreshError) {
        body.append(el('div', { className: 'err-card' }, `目录刷新告警（不影响已有设置）：${state.payload.catalogRefreshError}`));
      }
      const view = el('div', { className: 'settings-view' });
      const ctx = {
        state, keyOf, currentDraft, updateDraft, dirtyCount,
        dirtyPayloadModels: () => buildDirtyModels(state),
        syncSaveModelsButton, postAction, render,
      };
      if (state.tab === 'models') renderModelsTab(view, ctx);
      else renderToolsTab(view, ctx);
      body.append(view);
    }
    dialogEl.replaceChildren(el('div', { className: 'dialog-box dialog-wide dialog-xl' },
      el('div', { className: 'dialog-head' },
        el('div', { className: 'btn-row' },
          el('strong', {}, '模型、Key 与子代理设置'),
          el('div', { className: 'settings-tabs' },
            el('button', { type: 'button', className: `chip${state.tab === 'models' ? ' active' : ''}`, onclick: () => { state.tab = 'models'; render(); } }, '模型与 Key 配置'),
            el('button', { type: 'button', className: `chip${state.tab === 'tools' ? ' active' : ''}`, onclick: () => { state.tab = 'tools'; render(); } }, '子代理工具与默认策略'),
          ),
        ),
        el('div', { className: 'btn-row' },
          el('button', { type: 'button', className: 'btn btn-xs', disabled: state.busy, onclick: () => loadSettings(true) }, '刷新目录'),
          el('button', { type: 'button', className: 'btn btn-xs', onclick: () => dialogEl.close() }, '关闭'),
        ),
      ),
      body,
    ));
  }

  render();
  if (!dialogEl.open) dialogEl.showModal();
  await loadSettings(false);
}
