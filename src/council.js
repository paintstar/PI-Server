import { randomUUID } from 'node:crypto';
import { preflightBudget } from './budget.js';
import { ensureScratchCwd, parseStructuredJson, resolveContextFiles, runEphemeralAgent, saveRun } from './orchestration-core.js';

const ROLE_HINTS = {
  critic: 'Prioritize skeptical scrutiny and stress-test assumptions.',
  reviewer: 'Prioritize correctness, security, and maintainability.',
  implementer: 'Prioritize practical implementation trade-offs and delivery risk.',
  redteam: 'Prioritize adversarial failure modes, security, and edge cases.',
  architect: 'Prioritize architectural boundaries, contracts, and long-term evolution.',
  general: 'Provide a balanced, independent engineering assessment.',
};

function buildMemberPrompt(question, role, fileBlock, extraContext) {
  const parts = [`Council member role (${role}): ${ROLE_HINTS[role] || ROLE_HINTS.general}`, '', 'Question:', question];
  if (extraContext) parts.push('', 'Additional context:', extraContext);
  if (fileBlock) parts.push('', 'Referenced workspace files:', fileBlock);
  parts.push('', 'Give your independent analysis, then end with a fenced ```json block:',
    '{"stance":"support|oppose|conditional|uncertain","confidence":0.0,"summary":"string","claims":["string"],"risks":["string"]}');
  return parts.join('\n');
}

function normalizeMemberStructured(data) {
  if (!data) return null;
  const stances = new Set(['support', 'oppose', 'conditional', 'uncertain']);
  const stance = stances.has(String(data.stance || '').toLowerCase()) ? String(data.stance).toLowerCase() : 'uncertain';
  const rawConf = Number(data.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.5;
  const claims = Array.isArray(data.claims) ? data.claims.map(String) : Array.isArray(data.keyPoints) ? data.keyPoints.map(String) : [];
  return {
    stance,
    confidence: Math.round(confidence * 100) / 100,
    summary: typeof data.summary === 'string' ? data.summary : '',
    claims: claims.slice(0, 10),
    risks: Array.isArray(data.risks) ? data.risks.map(String).slice(0, 10) : [],
  };
}

function synthesizeDeterministic(members) {
  const succeeded = members.filter(m => m.status === 'completed');
  const stanceCounts = { support: 0, oppose: 0, conditional: 0, uncertain: 0 };
  const confidences = [];
  const claimFreq = new Map();
  const riskFreq = new Map();
  for (const m of succeeded) {
    const s = m.structured;
    if (!s) { stanceCounts.uncertain++; continue; }
    stanceCounts[s.stance] = (stanceCounts[s.stance] || 0) + 1;
    confidences.push(s.confidence);
    for (const c of s.claims) { const k = c.trim(); if (k) claimFreq.set(k, (claimFreq.get(k) || 0) + 1); }
    for (const r of s.risks) { const k = r.trim(); if (k) riskFreq.set(k, (riskFreq.get(k) || 0) + 1); }
  }
  const active = Object.entries(stanceCounts).filter(([, n]) => n > 0);
  const consensus = [];
  const disagreements = [];
  if (active.length === 1 && succeeded.length > 0) consensus.push(`Unanimous stance: ${active[0][0]} (${active[0][1]}/${succeeded.length})`);
  else if (active.length > 1) disagreements.push(`Divergent stances across models: ${active.map(([st, n]) => `${st}=${n}`).join(', ')}`);
  for (const [claim, n] of claimFreq) if (n >= 2) consensus.push(claim);
  for (const [risk, n] of riskFreq) if (n >= 2) consensus.push(`Shared risk: ${risk}`);
  if (active.length > 1) {
    for (const m of succeeded) if (m.structured?.summary) disagreements.push(`${m.model.provider}/${m.model.model} (${m.structured.stance}): ${m.structured.summary}`);
  }
  const averageConfidence = confidences.length ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100 : null;
  const confidenceSpread = confidences.length >= 2 ? Math.round((Math.max(...confidences) - Math.min(...confidences)) * 100) / 100 : 0;
  return { mode: 'deterministic', consensus: consensus.slice(0, 12), disagreements: disagreements.slice(0, 12), stanceCounts, averageConfidence, confidenceSpread };
}

function sumUsage(members) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedCost: 0 };
  for (const m of members) {
    const u = m.usage || {};
    total.input += u.input || 0;
    total.output += u.output || 0;
    total.cacheRead += u.cacheRead || 0;
    total.cacheWrite += u.cacheWrite || 0;
    total.reportedCost += u.reportedCost || 0;
  }
  total.reportedCost = Math.round(total.reportedCost * 1e6) / 1e6;
  return total;
}

export async function runCouncil({ manager, callbacks, stateRoot, input, parentSession, signal, onProgress }) {
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();
  const minQuorum = input.minQuorum ?? Math.ceil(input.members.length / 2);
  const resolved = resolveContextFiles({ cwd: input.cwd, contextFiles: input.contextFiles || [], stateRoot });
  const memberSpecs = input.members.map(member => {
    const role = member.role || 'general';
    return { ...member, role, prompt: buildMemberPrompt(input.question, role, resolved.block, input.context || '') };
  });
  const estimate = await preflightBudget(
    manager,
    memberSpecs.map(m => ({ provider: m.provider, model: m.model, promptText: m.prompt, expectedOutputTokens: 1200 })),
    { neededAgents: memberSpecs.length, budgetCapUsd: input.budgetCapUsd },
  );
  if (input.dryRun) {
    return {
      runId, kind: 'council', dryRun: true, status: 'dry_run',
      quorum: { required: minQuorum, succeeded: 0, total: memberSpecs.length, met: false },
      synthesis: null,
      members: memberSpecs.map(m => ({ agentId: null, model: { provider: m.provider, model: m.model, thinking: m.thinking || null }, role: m.role, status: 'dry_run' })),
      totalUsage: null, estimate, contextFiles: resolved.files, durationMs: 0,
    };
  }
  const cwd = input.cwd || ensureScratchCwd(stateRoot, runId);
  const cleanContext = input.cleanProfile ? 'BENCHMARK_PROMPT_PROFILE=clean' : '';
  const settled = await Promise.allSettled(memberSpecs.map((spec, idx) =>
    runEphemeralAgent({
      manager, callbacks, stateRoot, runId, kind: 'council', role: spec.role,
      provider: spec.provider, model: spec.model, thinking: spec.thinking, cwd,
      prompt: spec.prompt, context: cleanContext, allowWorkspaceRead: Boolean(input.cwd),
      timeoutMs: input.timeoutMs || 150000, autoArchive: input.autoArchive !== false,
      parentSession, signal, onProgress: info => onProgress?.({ memberIndex: idx, ...info }),
    })
  ));
  const members = settled.map((item, idx) => {
    const spec = memberSpecs[idx];
    const model = { provider: spec.provider, model: spec.model, thinking: spec.thinking || null };
    if (item.status === 'rejected') {
      return { agentId: null, model, role: spec.role, status: 'failed', durationMs: 0, answer: '', structured: null, usage: null, error: item.reason?.message || String(item.reason) };
    }
    const out = item.value;
    const parsed = out.status === 'completed' ? parseStructuredJson(out.answer) : { data: null, warning: out.error };
    return {
      agentId: out.agentId, model, role: spec.role, status: out.status, durationMs: out.durationMs,
      answer: out.answer, structured: normalizeMemberStructured(parsed.data),
      ...(parsed.warning ? { parseWarning: parsed.warning } : {}),
      usage: out.usage, error: out.error,
    };
  });
  const succeeded = members.filter(m => m.status === 'completed').length;
  const met = succeeded >= minQuorum;
  const result = {
    runId, kind: 'council', dryRun: false, createdAt, completedAt: new Date().toISOString(),
    question: input.question.slice(0, 2000), cleanProfile: Boolean(input.cleanProfile),
    status: succeeded === members.length ? 'completed' : met ? 'partial' : 'failed',
    quorum: { required: minQuorum, succeeded, total: members.length, met },
    synthesis: synthesizeDeterministic(members),
    members, totalUsage: sumUsage(members), estimate, contextFiles: resolved.files,
    durationMs: Date.now() - startedAt,
  };
  saveRun(stateRoot, result);
  return result;
}
