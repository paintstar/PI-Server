import { randomUUID } from 'node:crypto';
import { preflightBudget } from './budget.js';
import {
  ensureScratchCwd,
  parseStructuredJson,
  resolveContextFiles,
  runEphemeralAgent,
  saveRun,
} from './orchestration-core.js';

const STYLE_PROMPTS = {
  critic: 'Act as a rigorous technical critic. Challenge optimistic assumptions, expose hidden edge cases, and state clear trade-offs.',
  reviewer: 'Act as an independent senior code reviewer. Focus on correctness, security, regressions, and maintainability.',
  implementer: 'Act as a pragmatic senior engineer. Propose concrete, minimal, actionable implementation steps.',
  redteam: 'Act as an adversarial security and reliability red-teamer. Hunt for failure modes, injection vectors, and race conditions.',
  architect: 'Act as a systems architect. Evaluate boundaries, scalability, protocol contracts, and long-term coupling.',
};

function buildConsultPrompt(question, style, fileBlock, extraContext) {
  const parts = [
    STYLE_PROMPTS[style] || STYLE_PROMPTS.reviewer,
    '',
    'Question:',
    question,
  ];
  if (extraContext) parts.push('', 'Additional context:', extraContext);
  if (fileBlock) parts.push('', 'Referenced workspace files:', fileBlock);
  parts.push(
    '',
    'Respond clearly, then finish with a fenced ```json block matching:',
    '{"summary":"string","stance":"support|oppose|conditional|uncertain","confidence":0.0,"keyPoints":["string"],"risks":["string"],"recommendation":"string"}',
  );
  return parts.join('\n');
}

function normalizeStructured(data) {
  if (!data) return null;
  const stances = new Set(['support', 'oppose', 'conditional', 'uncertain']);
  const stance = stances.has(String(data.stance || '').toLowerCase()) ? String(data.stance).toLowerCase() : 'uncertain';
  const rawConf = Number(data.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.5;
  return {
    summary: typeof data.summary === 'string' ? data.summary : '',
    stance,
    confidence: Math.round(confidence * 100) / 100,
    keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(String).slice(0, 12) : [],
    risks: Array.isArray(data.risks) ? data.risks.map(String).slice(0, 12) : [],
    recommendation: typeof data.recommendation === 'string' ? data.recommendation : '',
  };
}

export async function runConsult({ manager, callbacks, stateRoot, input, parentSession, signal, onProgress }) {
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const style = input.style || 'reviewer';
  const resolved = resolveContextFiles({
    cwd: input.cwd,
    contextFiles: input.contextFiles || [],
    stateRoot,
  });
  const prompt = buildConsultPrompt(input.question, style, resolved.block, input.context || '');
  const estimate = await preflightBudget(
    manager,
    [{ provider: input.provider, model: input.model, promptText: prompt, expectedOutputTokens: 1200 }],
    { neededAgents: 1, budgetCapUsd: input.budgetCapUsd },
  );

  if (input.dryRun) {
    return {
      runId,
      kind: 'consult',
      dryRun: true,
      status: 'dry_run',
      agentId: null,
      model: { provider: input.provider, model: input.model, thinking: input.thinking || null },
      style,
      answer: '',
      structured: null,
      usage: null,
      estimate,
      contextFiles: resolved.files,
      durationMs: 0,
      archived: false,
    };
  }

  const cwd = input.cwd || ensureScratchCwd(stateRoot, runId);
  const allowWorkspaceRead = Boolean(input.cwd && input.allowWorkspaceRead !== false);
  const outcome = await runEphemeralAgent({
    manager,
    callbacks,
    stateRoot,
    runId,
    kind: 'consult',
    role: style,
    provider: input.provider,
    model: input.model,
    thinking: input.thinking,
    cwd,
    prompt,
    allowWorkspaceRead,
    timeoutMs: input.timeoutMs || 120000,
    autoArchive: input.autoArchive !== false,
    parentSession,
    signal,
    onProgress,
  });

  const parsed = outcome.status === 'completed' ? parseStructuredJson(outcome.answer) : { data: null, warning: outcome.error };
  const structured = normalizeStructured(parsed.data);
  const result = {
    runId,
    kind: 'consult',
    dryRun: false,
    createdAt,
    completedAt: new Date().toISOString(),
    question: input.question.slice(0, 2000),
    status: outcome.status,
    agentId: outcome.agentId,
    model: { provider: input.provider, model: input.model, thinking: input.thinking || null },
    style,
    answer: outcome.answer,
    structured,
    ...(parsed.warning ? { parseWarning: parsed.warning } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    usage: outcome.usage,
    estimate,
    contextFiles: resolved.files,
    durationMs: outcome.durationMs,
    archived: outcome.archived,
  };
  saveRun(stateRoot, result);
  return result;
}
