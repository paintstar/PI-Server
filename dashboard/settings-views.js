import { el, showToast } from './dom.js';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function statusBadge(p, note) {
  if (p.authType === 'oauth') {
    if (p.expired) return el('span', { className: 'badge badge-fail' }, 'OAuth 过期');
    if (note && note.ok === false) return el('span', { className: 'badge badge-fail' }, 'OAuth 异常');
    return el('span', { className: 'badge badge-ok' }, 'OAuth 正常');
  }
  return p.configured ? el('span', { className: 'badge badge-ok' }, '已配 Key') : el('span', { className: 'badge badge-dim' }, '未配 Key');
}

function selectEl(options, value, disabled, onChange) {
  const node = el('select', { className: 'input', disabled }, options.map(opt => {
    const o = el('option', { value: opt.value }, opt.label);
    if (opt.value === value) o.selected = true;
    return o;
  }));
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function formatK(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return value >= 1000000 ? `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(value / 1000)}K`;
}

function saveBaseUrlBtn(p, urlInput, state, postAction) {
  return el('button', {
    type: 'button',
    className: 'btn btn-xs',
    disabled: state.busy,
    onclick: () => postAction('/api/settings/provider-auth', {
      provider: p.provider,
      action: 'set_base_url',
      baseUrl: urlInput.value.trim(),
    }, `已更新 ${p.provider} 接口地址`),
  }, '保存地址');
}

function renderProviderRows(target, ctx) {
  const { state, render } = ctx;
  const q = state.providerQuery.trim().toLowerCase();
  const list = (state.payload?.providers || [])
    .filter(p => !q || p.provider.toLowerCase().includes(q))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));
  if (!list.length) {
    target.replaceChildren(el('div', { className: 'empty-mini' }, '没有匹配的服务商'));
    return;
  }
  target.replaceChildren(...list.map(p => {
    const cls = `provider-item${p.provider === state.selectedProvider ? ' active' : ''}${!p.enabled ? ' is-off' : ''}`;
    return el('button', {
      type: 'button',
      className: cls,
      onclick: () => {
        state.selectedProvider = p.provider;
        state.confirmClear = null;
        render();
      },
    },
      el('div', { className: 'provider-top' },
        el('span', { className: 'provider-name mono' }, p.provider),
        statusBadge(p, state.authNotes.get(p.provider)),
      ),
      el('div', { className: 'provider-sub muted' }, `${p.enabled ? '已启用' : '已停用'} · ${p.enabledModelsCount}/${p.totalModelsCount} 模型`),
    );
  }));
}

function renderOAuthCard(p, head, ctx) {
  const { state, postAction } = ctx;
  const note = state.authNotes.get(p.provider);
  const expText = p.expiresAt ? new Date(p.expiresAt).toLocaleString('zh-CN') : '未知';
  const urlInput = el('input', {
    className: 'input', type: 'url', value: p.baseUrl || '',
    disabled: state.busy, placeholder: '可选自定义中转接口地址 https://...',
  });
  return el('div', { className: 'settings-card' },
    head,
    el('div', { className: 'kv-row' }, el('span', { className: 'kv-k' }, '认证方式'), el('span', {}, `OAuth（到期时间：${expText}）`)),
    note ? el('div', { className: note.ok ? 'answer-box' : 'err-card' },
      `检测结果：${note.status}${note.reason ? `（${note.reason}）` : ''}`,
    ) : null,
    el('div', { className: 'settings-inline-row' },
      urlInput,
      saveBaseUrlBtn(p, urlInput, state, postAction),
      p.provider === 'openai-codex' ? el('button', {
        type: 'button',
        className: 'btn btn-xs',
        disabled: state.busy,
        onclick: () => postAction('/api/settings/provider-auth', {
          provider: p.provider,
          action: 'sync_codex',
        }, '已同步本机 Codex 登录凭据并刷新目录'),
      }, '同步本机 Codex 登录') : null,
      el('button', {
        type: 'button',
        className: 'btn btn-xs btn-primary',
        disabled: state.busy,
        onclick: () => postAction('/api/settings/check-auth', { provider: p.provider }, `已完成 ${p.provider} 凭据检查`),
      }, '检查并续期凭据'),
    ),
    el('div', { className: 'muted ctx-sub' }, p.provider === 'openai-codex'
      ? '若 OAuth 显示过期或异常，先在终端完成 codex login，再点击“同步本机 Codex 登录”和“检查并续期凭据”。'
      : 'OAuth 若显示过期或异常，需在终端重新执行 pi 登录授权后点“检查并续期凭据”。'),
  );
}

function renderAuthCard(p, ctx) {
  const { state, postAction, render } = ctx;
  const note = state.authNotes.get(p.provider);
  const toggleInput = el('input', { type: 'checkbox', checked: p.enabled, disabled: state.busy });
  toggleInput.addEventListener('change', () => {
    postAction('/api/settings/provider-auth', {
      provider: p.provider, action: 'toggle', enabled: toggleInput.checked,
    }, toggleInput.checked ? `已启用 ${p.provider}` : `已禁用 ${p.provider}`);
  });
  const head = el('div', { className: 'settings-card-head' },
    el('div', { className: 'btn-row' },
      el('strong', { className: 'mono' }, p.provider),
      statusBadge(p, note),
      p.maskedKey ? el('span', { className: 'muted mono auth-mask' }, p.maskedKey) : null,
    ),
    el('label', { className: 'switch-row' }, toggleInput, el('span', {}, '启用该服务商')),
  );
  if (p.authType === 'oauth') return renderOAuthCard(p, head, ctx);

  const keyInput = el('input', {
    className: 'input mono', type: 'password', autocomplete: 'off', disabled: state.busy,
    placeholder: p.configured ? '已保存（输入新 Key 将覆盖，留空不变）' : '输入 API Key、$ENV_VAR 或 !命令',
  });
  const urlInput = el('input', {
    className: 'input mono', type: 'url', value: p.baseUrl || '',
    disabled: state.busy, placeholder: '默认接口地址（可选填 https://...）',
  });
  const isConfirming = state.confirmClear === p.provider;
  return el('div', { className: 'settings-card' },
    head,
    el('div', { className: 'settings-form-grid' },
      el('label', { className: 'field' }, el('span', { className: 'field-label' }, 'API Key'), keyInput),
      el('label', { className: 'field' }, el('span', { className: 'field-label' }, 'Base URL（可选）'), urlInput),
    ),
    el('div', { className: 'btn-row' },
      el('button', {
        type: 'button', className: 'btn btn-xs btn-primary', disabled: state.busy,
        onclick: () => {
          if (!keyInput.value.trim()) return showToast('请先输入 API Key');
          postAction('/api/settings/provider-auth', {
            provider: p.provider, action: 'set_key',
            apiKey: keyInput.value.trim(), baseUrl: urlInput.value.trim(),
          }, `已保存 ${p.provider} Key 配置`);
        },
      }, '保存 Key'),
      saveBaseUrlBtn(p, urlInput, state, postAction),
      el('button', {
        type: 'button', className: `btn btn-xs${isConfirming ? ' btn-warn' : ''}`, disabled: state.busy || !p.configured,
        onclick: () => {
          if (!isConfirming) { state.confirmClear = p.provider; render(); return; }
          postAction('/api/settings/provider-auth', { provider: p.provider, action: 'clear_key' }, `已清除 ${p.provider} 凭据`);
        },
      }, isConfirming ? '确认清除 Key' : '清除 Key'),
    ),
  );
}

function renderModelCard(m, p, ctx) {
  const { state, keyOf, currentDraft, updateDraft, dirtyCount, render } = ctx;
  const key = keyOf(m);
  const draft = currentDraft(m);
  const isReset = state.resets.has(key);
  const isDirty = state.drafts.has(key) || isReset;

  const enableCheck = el('input', { type: 'checkbox', checked: draft.enabled, disabled: state.busy });
  const ctxInput = el('input', {
    type: 'number', className: 'input num-input', min: '1024', max: '10000000',
    disabled: state.busy, value: draft.contextWindow ?? '',
  });
  const maxInput = el('input', {
    type: 'number', className: 'input num-input', min: '1', max: '2000000',
    disabled: state.busy, value: draft.maxTokens ?? '',
  });
  const thinkSelect = selectEl(
    THINKING_LEVELS.map(lvl => ({ value: lvl, label: lvl })),
    draft.recommendedThinking || m.recommendedThinking || 'medium',
    state.busy,
    value => updateDraft(m, { recommendedThinking: value }),
  );
  const descInput = el('textarea', {
    className: 'input model-desc', rows: '2', disabled: state.busy,
    placeholder: '说明适合何时调度、与同系列模型有何差异…',
  });
  descInput.value = draft.description || '';

  const card = el('div', { className: `model-card${p.enabled && draft.enabled ? '' : ' is-off'}` },
    el('div', { className: 'model-head' },
      el('div', { className: 'btn-row' },
        el('label', { className: 'switch-row' }, enableCheck, el('span', { className: 'mono model-id' }, m.model)),
        !p.enabled ? el('span', { className: 'badge badge-dim' }, '服务商已停用') : null,
        el('span', { className: 'badge badge-dim' }, formatK(draft.contextWindow ?? m.contextWindow)),
        m.reasoning ? el('span', { className: 'badge badge-ok' }, '推理') : null,
        m.input?.includes('image') ? el('span', { className: 'badge badge-watch' }, '图文') : null,
        m.customDescription && !isReset ? el('span', { className: 'badge badge-warn' }, '自定义描述') : null,
        isDirty && dirtyCount() > 0 ? el('span', { className: 'badge badge-warn' }, isReset ? '待恢复默认' : '已修改') : null,
      ),
      el('button', {
        type: 'button', className: 'btn btn-xs', disabled: state.busy,
        onclick: () => {
          state.drafts.delete(key);
          state.resets.add(key);
          enableCheck.checked = true;
          ctxInput.value = m.baseContextWindow ?? '';
          maxInput.value = m.baseMaxTokens ?? '';
          thinkSelect.value = m.defaultRecommendedThinking || m.recommendedThinking || 'medium';
          descInput.value = m.defaultDescription || '';
          render();
        },
      }, '恢复默认'),
    ),
    el('div', { className: 'model-fields' },
      el('label', { className: 'field' }, el('span', { className: 'field-label' }, '上下文窗口'), ctxInput),
      el('label', { className: 'field' }, el('span', { className: 'field-label' }, '最大输出'), maxInput),
      el('label', { className: 'field' }, el('span', { className: 'field-label' }, '推荐思考'), thinkSelect),
    ),
    el('label', { className: 'field' }, el('span', { className: 'field-label' }, '能力描述（AI 选模型时读取）'), descInput),
  );

  enableCheck.addEventListener('change', () => {
    updateDraft(m, { enabled: enableCheck.checked });
    card.classList.toggle('is-off', !(p.enabled && enableCheck.checked));
  });
  ctxInput.addEventListener('input', () => updateDraft(m, { contextWindow: ctxInput.value === '' ? null : Number(ctxInput.value) }));
  maxInput.addEventListener('input', () => updateDraft(m, { maxTokens: maxInput.value === '' ? null : Number(maxInput.value) }));
  descInput.addEventListener('input', () => updateDraft(m, { description: descInput.value }));
  return card;
}

function renderModelList(target, p, ctx) {
  const q = ctx.state.modelQuery.trim().toLowerCase();
  const list = (ctx.state.payload?.models || [])
    .filter(m => m.provider === p.provider && (!q || `${m.model} ${m.name || ''} ${m.description || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.modelEnabled !== false) - Number(a.modelEnabled !== false));
  if (!list.length) {
    target.replaceChildren(el('div', { className: 'empty-mini' }, p.totalModelsCount ? '没有匹配的模型' : '当前服务商暂无可用模型目录（可点右上角“刷新目录”）'));
    return;
  }
  target.replaceChildren(...list.map(m => renderModelCard(m, p, ctx)));
}

export function renderModelsTab(container, ctx) {
  const { state, dirtyCount, dirtyPayloadModels, postAction, render } = ctx;
  const p = (state.payload?.providers || []).find(item => item.provider === state.selectedProvider);
  const providerListBox = el('div', { className: 'settings-provider-list' });
  const providerSearch = el('input', { type: 'search', className: 'input', value: state.providerQuery, placeholder: '筛选服务商…' });
  providerSearch.addEventListener('input', () => {
    state.providerQuery = providerSearch.value;
    renderProviderRows(providerListBox, ctx);
  });
  renderProviderRows(providerListBox, ctx);

  if (!p) {
    container.replaceChildren(el('div', { className: 'empty-mini' }, '暂未读取到任何服务商配置，请点击“刷新目录”。'));
    return;
  }
  const modelListBox = el('div', { className: 'settings-model-list' });
  const modelSearch = el('input', { type: 'search', className: 'input settings-model-search', value: state.modelQuery, placeholder: '搜索模型或能力描述…' });
  modelSearch.addEventListener('input', () => {
    state.modelQuery = modelSearch.value;
    renderModelList(modelListBox, p, ctx);
  });
  renderModelList(modelListBox, p, ctx);

  const count = dirtyCount();
  const saveBtn = el('button', {
    id: 'save-models-btn', type: 'button', className: 'btn btn-xs btn-primary', disabled: state.busy || count === 0,
    onclick: async () => {
      const models = dirtyPayloadModels();
      if (!Object.keys(models).length) return;
      const saved = await postAction('/api/settings', { models }, '已保存模型配置并同步目录');
      if (saved) { state.drafts.clear(); state.resets.clear(); render(); }
    },
  }, count ? `保存模型配置 (${count})` : '保存模型配置');

  container.replaceChildren(el('div', { className: 'settings-grid' },
    el('div', { className: 'settings-side' }, providerSearch, providerListBox),
    el('div', { className: 'settings-main' },
      renderAuthCard(p, ctx),
      el('div', { className: 'settings-models-head' },
        el('strong', {}, `模型与上下文 (${p.enabledModelsCount}/${p.totalModelsCount} 可用)`),
        el('div', { className: 'btn-row' }, modelSearch, saveBtn),
      ),
      modelListBox,
    ),
  ));
}

export function renderToolsTab(container, ctx) {
  const { state, postAction } = ctx;
  const draft = state.toolsDraft;
  const netCheck = el('input', { type: 'checkbox', checked: draft.allowNetwork, disabled: state.busy });
  const skillsCheck = el('input', { type: 'checkbox', checked: draft.loadSkills, disabled: state.busy });
  const ctxCheck = el('input', { type: 'checkbox', checked: draft.loadContextFiles, disabled: state.busy });
  netCheck.addEventListener('change', () => { draft.allowNetwork = netCheck.checked; });
  skillsCheck.addEventListener('change', () => { draft.loadSkills = skillsCheck.checked; });
  ctxCheck.addEventListener('change', () => { draft.loadContextFiles = ctxCheck.checked; });

  const tools = state.payload?.subagentTools || [];
  container.replaceChildren(
    el('div', { className: 'settings-card' },
      el('div', { className: 'settings-card-head' },
        el('strong', {}, '新子代理默认运行策略'),
        el('button', {
          type: 'button', className: 'btn btn-xs btn-primary', disabled: state.busy,
          onclick: () => postAction('/api/settings', {
            defaults: {
              sandboxMode: draft.sandboxMode || null,
              allowNetwork: draft.allowNetwork,
              thinking: draft.thinking,
              loadSkills: draft.loadSkills,
              loadContextFiles: draft.loadContextFiles,
            },
          }, '已保存默认策略'),
        }, '保存默认策略'),
      ),
      el('div', { className: 'settings-form-grid' },
        el('label', { className: 'field' },
          el('span', { className: 'field-label' }, '默认沙箱模式'),
          selectEl([
            { value: '', label: '自动按项目规则' },
            { value: 'strict', label: 'strict（严格工作区隔离）' },
            { value: 'dev', label: 'dev（开发模式）' },
            { value: 'bypass', label: 'bypass（放开路径，仅保护状态目录）' },
          ], draft.sandboxMode, state.busy, v => { draft.sandboxMode = v; }),
        ),
        el('label', { className: 'field' },
          el('span', { className: 'field-label' }, '默认思考强度'),
          selectEl(THINKING_LEVELS.map(v => ({ value: v, label: v })), draft.thinking, state.busy, v => { draft.thinking = v; }),
        ),
      ),
      el('div', { className: 'settings-checks' },
        el('label', { className: 'switch-row' }, netCheck, el('span', {}, '允许子代理联网')),
        el('label', { className: 'switch-row' }, skillsCheck, el('span', {}, '加载 Pi 全局与项目 Skills')),
        el('label', { className: 'switch-row' }, ctxCheck, el('span', {}, '加载工作区 AGENTS.md 上下文')),
      ),
    ),
    el('div', { className: 'settings-card' },
      el('div', { className: 'settings-card-head' }, el('strong', {}, `Pi 子代理工具清单 (${tools.length})`)),
      el('div', { className: 'tools-grid' }, tools.map(tool =>
        el('div', { className: 'tool-info-card' },
          el('div', { className: 'provider-top' },
            el('span', { className: 'mono tool-info-name' }, tool.name),
            el('span', { className: 'badge badge-dim' }, tool.scope),
          ),
          el('div', { className: 'tool-info-label' }, tool.label),
          el('div', { className: 'muted ctx-sub' }, tool.description),
        ),
      )),
    ),
  );
}
