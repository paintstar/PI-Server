import { el, glyph, paths, shortDuration, tokens, cost, mount } from './dom.js';

const VERIFY_META = {
  verified: { label: '已验收', cls: 'badge-ok', icon: paths.shield },
  failed: { label: '验收未通过', cls: 'badge-fail', icon: paths.warn },
  running: { label: '验收中', cls: 'badge-run', icon: null },
  skipped: { label: '验收已跳过', cls: 'badge-dim', icon: null },
};

const VERDICT_META = {
  approve: { label: '通过 (Approve)', cls: 'verdict-ok' },
  concerns: { label: '存在关注点 (Concerns)', cls: 'verdict-warn' },
  blockers: { label: '存在阻塞项 (Blockers)', cls: 'verdict-fail' },
};

const SEVERITY_META = {
  blocker: { label: '阻塞', cls: 'badge-fail' },
  concern: { label: '关注', cls: 'badge-warn' },
  nit: { label: '建议', cls: 'badge-dim' },
};

const STANCE_LABEL = { support: '支持', oppose: '反对', conditional: '有条件', uncertain: '不确定' };

export function verificationBadge(agent) {
  const status = agent?.verification?.status || (agent?.status === 'completed-verified' ? 'verified' : agent?.status === 'completed-unverified' ? 'failed' : 'none');
  const meta = VERIFY_META[status];
  if (!meta) return null;
  return el('span', { class: `badge verify-badge ${meta.cls}` }, meta.icon ? glyph(meta.icon, 'v-ico') : null, meta.label);
}

export function renderAcceptanceCard(agent, compact = false) {
  const v = agent?.verification;
  if (!v || !v.status || v.status === 'none') return null;
  const meta = VERIFY_META[v.status] || { label: v.status, cls: 'badge-dim' };
  const checks = Array.isArray(v.checks) ? v.checks : [];
  const passed = v.passedCount ?? checks.filter(c => c.passed).length;
  const total = v.totalCount ?? checks.length;
  const list = checks.map((chk, idx) => {
    const ok = Boolean(chk.passed);
    const out = [chk.stdoutTail, chk.stderrTail].filter(Boolean).join('\n');
    const summaryRow = el('summary', { class: 'check-row-head' },
      el('span', { class: `check-dot ${ok ? 'ok' : 'bad'}`, text: ok ? '✓' : '✕' }),
      el('code', { class: 'check-cmd', text: chk.name ? `${chk.name}: ${chk.command}` : chk.command }),
      el('span', { class: 'check-meta mono', text: `exit ${chk.exitCode ?? '?'}/${chk.expectExit ?? 0}${chk.durationMs != null ? ` · ${shortDuration(chk.durationMs)}` : ''}` }),
    );
    if (!out && !chk.sandboxHint) return el('div', { class: `check-item static ${ok ? 'ok' : 'bad'}` }, summaryRow);
    const det = el('details', { class: `check-item ${ok ? 'ok' : 'bad'}`, 'data-key': `chk-${agent.id}-${idx}` }, summaryRow);
    if (!ok && !compact) det.open = true;
    if (chk.sandboxHint) det.append(el('div', { class: 'check-hint', text: chk.sandboxHint }));
    if (out) det.append(el('pre', { class: 'check-out', text: out }));
    return det;
  });
  return el('section', { class: compact ? 'collab-card compact' : 'collab-card' },
    el('header', { class: 'collab-head' },
      el('div', { class: 'collab-title' }, el('strong', { text: '机械验收闭环' }), el('span', { class: `badge ${meta.cls}`, text: `${meta.label} ${passed}/${total}` })),
      el('span', { class: 'muted mono', text: [v.sandboxBackend, v.totalDurationMs != null ? shortDuration(v.totalDurationMs) : ''].filter(Boolean).join(' · ') }),
    ),
    list.length ? el('div', { class: 'check-list' }, list) : el('p', { class: 'muted', text: v.status === 'running' ? '正在隔离沙箱内执行验收命令…' : '暂无逐条检查记录' }),
  );
}

export function loadRunData(runId, state, apiFetch, onLoaded) {
  if (!runId) return null;
  const cached = state.runs.get(runId);
  if (cached) return cached;
  const entry = { loading: true, data: null, error: null };
  state.runs.set(runId, entry);
  apiFetch(`/api/runs/${runId}`)
    .then(data => { state.runs.set(runId, { loading: false, data, error: null }); onLoaded?.(); })
    .catch(error => { state.runs.set(runId, { loading: false, data: null, error: error.message }); onLoaded?.(); });
  return entry;
}

export function findLinkedReviewRunId(agent, state) {
  if (agent?.orchestration?.kind === 'cross_review' && agent.orchestration.runId) return agent.orchestration.runId;
  const hit = (state.runsList || []).find(r => r.kind === 'cross_review' && r.sourceAgentId === agent?.id);
  return hit?.runId || null;
}

function renderCouncilView(run, currentAgentId, actions) {
  const syn = run.synthesis || {};
  const members = Array.isArray(run.members) ? run.members : [];
  const q = run.quorum || {};
  const est = run.estimate;
  const stancePills = Object.entries(syn.stanceCounts || {}).filter(([, n]) => n > 0).map(([k, n]) =>
    el('span', { class: 'badge badge-dim', text: `${STANCE_LABEL[k] || k} ${n}` }),
  );
  return el('section', { class: 'collab-card council-view' },
    el('header', { class: 'collab-head' },
      el('div', { class: 'collab-title' },
        glyph(paths.council, 'c-ico'),
        el('strong', { text: '多模型委员会会诊' }),
        el('span', { class: `badge ${run.status === 'completed' ? 'badge-ok' : run.status === 'partial' ? 'badge-warn' : 'badge-fail'}`, text: `${run.status} · ${q.succeeded ?? 0}/${q.total ?? members.length}` }),
        run.cleanProfile ? el('span', { class: 'badge badge-watch', text: 'Clean Profile' }) : null,
      ),
      el('span', { class: 'muted mono', text: [
        syn.averageConfidence != null ? `置信 ${Math.round(syn.averageConfidence * 100)}%` : '',
        est?.catalogEstimateUsd != null ? `预估 ${cost(est.catalogEstimateUsd)}` : '',
        run.durationMs ? shortDuration(run.durationMs) : '',
      ].filter(Boolean).join(' · ') }),
    ),
    run.question ? el('p', { class: 'collab-q', text: run.question }) : null,
    stancePills.length ? el('div', { class: 'btn-row' }, ...stancePills) : null,
    (syn.consensus?.length || syn.disagreements?.length)
      ? el('div', { class: 'syn-grid' },
          syn.consensus?.length ? el('div', { class: 'syn-box ok' }, el('strong', { text: '共识点' }), el('ul', {}, syn.consensus.map(c => el('li', { text: c })))) : null,
          syn.disagreements?.length ? el('div', { class: 'syn-box warn' }, el('strong', { text: '分歧点' }), el('ul', {}, syn.disagreements.map(d => el('li', { text: d })))) : null,
        )
      : null,
    el('div', { class: 'council-grid' }, members.map(m => {
      const mLabel = `${m.model?.provider || ''}/${m.model?.model || ''}`;
      const st = m.structured?.stance;
      const isCurrent = m.agentId && m.agentId === currentAgentId;
      return el('button', {
        type: 'button',
        class: `council-card ${isCurrent ? 'current' : ''}`,
        disabled: !m.agentId,
        onclick: () => m.agentId && actions.onSelect?.(m.agentId),
      },
      el('div', { class: 'council-card-head' },
        el('code', { class: 'mono', text: mLabel }),
        el('span', { class: `badge ${m.status === 'completed' ? 'badge-ok' : 'badge-fail'}`, text: st ? (STANCE_LABEL[st] || st) : m.status }),
      ),
      el('p', { class: 'council-summary', text: m.structured?.summary || m.error || m.answer?.slice(0, 140) || '无摘要' }),
      el('div', { class: 'council-meta mono' },
        el('span', { text: m.role || 'general' }),
        m.structured?.confidence != null ? el('span', { text: `${Math.round(m.structured.confidence * 100)}%` }) : null,
        m.durationMs ? el('span', { text: shortDuration(m.durationMs) }) : null,
        m.usage ? el('span', { text: tokens((m.usage.input || 0) + (m.usage.output || 0)) }) : null,
      ));
    })),
  );
}

function renderCrossReviewCard(run, actions, compact = false) {
  const vm = VERDICT_META[run.verdict] || { label: run.verdict || '未知', cls: 'verdict-warn' };
  const findings = Array.isArray(run.findings) ? run.findings : [];
  const srcName = run.sourceModel ? `${run.sourceModel.provider}/${run.sourceModel.model}` : '源代理';
  const revName = run.reviewerModel ? `${run.reviewerModel.provider}/${run.reviewerModel.model}` : '审查者';
  const header = el('header', { class: 'collab-head' },
    el('div', { class: 'collab-title' },
      el('strong', { text: '交叉审查结论' }),
      el('span', { class: `verdict-pill ${vm.cls}`, text: vm.label }),
      run.confidence != null ? el('span', { class: 'muted mono', text: `置信 ${Math.round(run.confidence * 100)}%` }) : null,
    ),
    el('div', { class: 'btn-row' },
      run.sourceAgentId ? el('button', { type: 'button', class: 'btn btn-xs', onclick: () => actions.onSelect?.(run.sourceAgentId) }, `实现: ${srcName}`) : null,
      run.reviewerAgentId ? el('button', { type: 'button', class: 'btn btn-xs', onclick: () => actions.onSelect?.(run.reviewerAgentId) }, `审查: ${revName}`) : null,
    ),
  );
  if (compact) {
    return el('div', { class: `review-compact ${vm.cls}` },
      el('div', { class: 'review-compact-row' },
        el('span', { class: `verdict-pill ${vm.cls}`, text: vm.label }),
        el('span', { class: 'muted', text: `${findings.length} 条发现` }),
        run.reviewerAgentId ? el('button', { type: 'button', class: 'link-btn', onclick: () => actions.onSelect?.(run.reviewerAgentId) }, '查看审查') : null,
      ),
      run.summary ? el('p', { class: 'review-compact-sum', text: run.summary }) : null,
    );
  }
  return el('section', { class: `collab-card review-card ${vm.cls}` },
    header,
    run.summary ? el('p', { class: 'collab-q', text: run.summary }) : null,
    run.parseWarning ? el('div', { class: 'err-card', text: `Fail-Closed 降级：${run.parseWarning}` }) : null,
    findings.length
      ? el('ul', { class: 'finding-list' }, findings.map(f => {
          const sm = SEVERITY_META[f.severity] || SEVERITY_META.concern;
          return el('li', { class: 'finding-item' },
            el('div', { class: 'finding-head' },
              el('span', { class: `badge ${sm.cls}`, text: sm.label }),
              el('strong', { text: f.title || f.detail || '审查发现' }),
              f.file ? el('button', {
                type: 'button',
                class: 'link-btn mono',
                onclick: () => actions.onJumpToFile?.(f.file, run.sourceAgentId),
              }, `${f.file}${f.line ? `:${f.line}` : ''}`) : null,
            ),
            f.detail && f.detail !== f.title ? el('p', { class: 'finding-body', text: f.detail }) : null,
            f.suggestion ? el('p', { class: 'finding-sug', text: `建议：${f.suggestion}` }) : null,
          );
        }))
      : el('p', { class: 'muted', text: run.emptyDiff ? '工作区无变更，已零成本短路跳过审查。' : '未记录问题发现。' }),
  );
}

function renderConsultSummary(run) {
  const s = run.structured;
  if (!s) return null;
  return el('section', { class: 'collab-card' },
    el('header', { class: 'collab-head' },
      el('div', { class: 'collab-title' },
        el('strong', { text: `独立咨询 (${run.style || 'reviewer'})` }),
        el('span', { class: 'badge badge-ok', text: STANCE_LABEL[s.stance] || s.stance }),
        el('span', { class: 'muted mono', text: `置信 ${Math.round((s.confidence || 0) * 100)}%` }),
      ),
      run.estimate?.catalogEstimateUsd != null ? el('span', { class: 'muted mono', text: `预估 ${cost(run.estimate.catalogEstimateUsd)}` }) : null,
    ),
    s.summary ? el('p', { class: 'collab-q', text: s.summary }) : null,
    s.recommendation ? el('p', { class: 'finding-sug', text: `建议：${s.recommendation}` }) : null,
  );
}

export function renderCollabNodes(agent, state, apiFetch, actions, onLoaded) {
  const nodes = [];
  const acc = renderAcceptanceCard(agent, false);
  if (acc) nodes.push(acc);
  const runId = agent?.orchestration?.runId || findLinkedReviewRunId(agent, state);
  if (!runId) return nodes;
  const entry = loadRunData(runId, state, apiFetch, onLoaded);
  if (entry?.loading) {
    nodes.push(el('div', { class: 'collab-card muted', text: '正在加载多模型协作记录…' }));
    return nodes;
  }
  const run = entry?.data;
  if (!run) return nodes;
  if (run.kind === 'council') nodes.push(renderCouncilView(run, agent.id, actions));
  else if (run.kind === 'cross_review') nodes.push(renderCrossReviewCard(run, actions, false));
  else if (run.kind === 'consult') nodes.push(renderConsultSummary(run));
  return nodes;
}

export function renderChangesReviewBanner(container, agent, state, apiFetch, actions, onLoaded) {
  if (!container) return;
  const runId = findLinkedReviewRunId(agent, state);
  if (!runId) { container.hidden = true; container.replaceChildren(); return; }
  const entry = loadRunData(runId, state, apiFetch, onLoaded);
  const run = entry?.data;
  if (!run || run.kind !== 'cross_review') { container.hidden = true; container.replaceChildren(); return; }
  container.hidden = false;
  mount(container, renderCrossReviewCard(run, actions, true));
}
