import { randomUUID } from 'node:crypto';
import { agentChanges } from './agent-changes.js';
import { preflightBudget } from './budget.js';
import { parseStructuredJson, runEphemeralAgent, saveRun } from './orchestration-core.js';
import { Storage } from './storage.js';

const ACTIVE_SOURCE = new Set(['starting', 'running', 'waiting', 'finishing']);
const VALID_VERDICTS = new Set(['approve', 'concerns', 'blockers']);
const VALID_SEVERITIES = new Set(['blocker', 'concern', 'nit']);

function normalizeSeverity(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (VALID_SEVERITIES.has(value)) return value;
  if (['critical', 'high', 'error', 'severe'].includes(value)) return 'blocker';
  if (['low', 'info', 'minor', 'suggestion', 'note'].includes(value)) return 'nit';
  return 'concern';
}

export function normalizeReviewOutput(answer) {
  const { data, warning } = parseStructuredJson(answer);
  if (!data) {
    return {
      verdict: 'concerns',
      summary: String(answer || '').slice(0, 600) || 'Reviewer response was unparseable; downgraded to concerns.',
      confidence: 0,
      findings: [],
      parseWarning: warning || 'Invalid JSON verdict; fail-closed to concerns',
    };
  }
  const findings = Array.isArray(data.findings)
    ? data.findings.filter(f => f && typeof f === 'object').slice(0, 40).map(f => ({
        severity: normalizeSeverity(f.severity),
        file: typeof f.file === 'string' ? f.file : '',
        line: Number.isInteger(f.line) ? f.line : null,
        title: typeof f.title === 'string' ? f.title : '',
        detail: typeof f.detail === 'string' ? f.detail : '',
        suggestion: typeof f.suggestion === 'string' ? f.suggestion : '',
      }))
    : [];
  const rawVerdict = String(data.verdict || '').toLowerCase().trim();
  let parseWarning = VALID_VERDICTS.has(rawVerdict) ? null : `Invalid verdict "${rawVerdict || 'missing'}"; fail-closed to concerns`;
  let verdict = VALID_VERDICTS.has(rawVerdict) ? rawVerdict : 'concerns';
  if (findings.some(f => f.severity === 'blocker')) verdict = 'blockers';
  else if (verdict === 'approve' && findings.some(f => f.severity === 'concern')) verdict = 'concerns';
  const rawConf = Number(data.confidence);
  return {
    verdict,
    summary: typeof data.summary === 'string' ? data.summary : '',
    confidence: Math.round((Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.5) * 100) / 100,
    findings,
    ...(parseWarning ? { parseWarning } : {}),
  };
}

function buildReviewPrompt({ sourceRecord, changes, focus, includeVerification }) {
  const parts = [
    'You are an independent read-only code reviewer auditing changes produced by another model.',
    'Check correctness, edge cases, regressions, security/sandbox boundaries, and test coverage.',
    `Source model: ${sourceRecord.model?.provider || 'unknown'}/${sourceRecord.model?.model || 'unknown'}`,
    `Workspace mode: ${changes.mode || 'unknown'}`,
  ];
  if (focus) parts.push('', 'Review focus:', focus);
  if (includeVerification && sourceRecord.verification && sourceRecord.verification.status !== 'none') {
    parts.push('', 'Mechanical acceptance checks result:', JSON.stringify(sourceRecord.verification));
  }
  if (changes.commits?.length) parts.push('', 'Commits:', changes.commits.join('\n'));
  if (changes.status?.length) parts.push('', 'Git status:', changes.status.join('\n'));
  if (changes.diffStat) parts.push('', 'Diff stat:', changes.diffStat);
  parts.push('', `Unified diff${changes.diffTruncated ? ' (truncated)' : ''}:`, changes.diff || '(empty)');
  parts.push('', 'Provide a concise review and end with a fenced ```json block:',
    '{"verdict":"approve|concerns|blockers","summary":"string","confidence":0.0,"findings":[{"severity":"blocker|concern|nit","file":"path","line":1,"title":"string","detail":"string","suggestion":"string"}]}');
  return parts.join('\n');
}

export async function runCrossReview({ manager, callbacks, stateRoot, input, parentSession, signal, onProgress }) {
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();
  const readRes = await manager.read(input.sourceAgentId, 0, 1);
  if (ACTIVE_SOURCE.has(readRes.agent?.status)) {
    throw new Error(`Source agent ${input.sourceAgentId} is still ${readRes.agent.status}; wait until it settles before cross_review`);
  }
  const sourceRecord = new Storage(stateRoot).load(input.sourceAgentId);
  if (!input.allowSameModel && sourceRecord.model?.provider === input.reviewer.provider && sourceRecord.model?.model === input.reviewer.model) {
    throw new Error('Reviewer model must differ from source model unless allowSameModel is true');
  }
  const reviewerModel = { provider: input.reviewer.provider, model: input.reviewer.model, thinking: input.reviewer.thinking || null };
  const changes = await agentChanges(sourceRecord, { includeDiff: true, includeUntracked: true, maxBytes: input.maxDiffBytes || 40000 });
  const emptyDiff = changes.git !== false && !(changes.status?.length) && !(changes.commits?.length);
  if (emptyDiff) {
    const shortResult = {
      runId, kind: 'cross_review', dryRun: Boolean(input.dryRun), createdAt, completedAt: new Date().toISOString(),
      status: 'completed', sourceAgentId: input.sourceAgentId, sourceModel: sourceRecord.model || null,
      reviewerAgentId: null, reviewerModel, verdict: 'concerns',
      summary: 'No file changes or commits detected in source agent workspace; skipped reviewer invocation.',
      confidence: 1, findings: [], diffStat: '', diffTruncated: false, emptyDiff: true,
      usage: null, estimate: null, durationMs: Date.now() - startedAt,
    };
    if (!input.dryRun) saveRun(stateRoot, shortResult);
    return shortResult;
  }
  const prompt = buildReviewPrompt({ sourceRecord, changes, focus: input.focus || '', includeVerification: input.includeVerification !== false });
  const estimate = await preflightBudget(
    manager,
    [{ provider: input.reviewer.provider, model: input.reviewer.model, promptText: prompt, expectedOutputTokens: 1500 }],
    { neededAgents: 1, budgetCapUsd: input.budgetCapUsd },
  );
  if (input.dryRun) {
    return {
      runId, kind: 'cross_review', dryRun: true, status: 'dry_run', sourceAgentId: input.sourceAgentId,
      sourceModel: sourceRecord.model || null, reviewerAgentId: null, reviewerModel, verdict: null,
      summary: '', confidence: null, findings: [], diffStat: changes.diffStat || '',
      diffTruncated: Boolean(changes.diffTruncated), emptyDiff: false, usage: null, estimate, durationMs: 0,
    };
  }
  const outcome = await runEphemeralAgent({
    manager, callbacks, stateRoot, runId, kind: 'cross_review', role: 'reviewer', sourceAgentId: input.sourceAgentId,
    provider: input.reviewer.provider, model: input.reviewer.model, thinking: input.reviewer.thinking,
    cwd: sourceRecord.workspace.cwd, prompt, allowWorkspaceRead: true,
    timeoutMs: input.timeoutMs || 120000, autoArchive: input.autoArchive !== false, parentSession, signal, onProgress,
  });
  const normalized = outcome.status === 'completed'
    ? normalizeReviewOutput(outcome.answer)
    : { verdict: 'concerns', summary: outcome.error || 'Reviewer did not complete', confidence: 0, findings: [], parseWarning: outcome.error || 'Reviewer failed' };
  const result = {
    runId, kind: 'cross_review', dryRun: false, createdAt, completedAt: new Date().toISOString(),
    status: outcome.status, sourceAgentId: input.sourceAgentId, sourceModel: sourceRecord.model || null,
    reviewerAgentId: outcome.agentId, reviewerModel, verdict: normalized.verdict, summary: normalized.summary,
    confidence: normalized.confidence, findings: normalized.findings,
    ...(normalized.parseWarning ? { parseWarning: normalized.parseWarning } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    diffStat: changes.diffStat || '', diffTruncated: Boolean(changes.diffTruncated), emptyDiff: false,
    usage: outcome.usage, estimate, durationMs: outcome.durationMs,
  };
  saveRun(stateRoot, result);
  return result;
}
