import { runSandboxed, sandboxHealth, sandboxMode } from './tool-sandbox.js';

export const MAX_ACCEPTANCE_CHECKS = 10;
export const MAX_CHECK_TIMEOUT_MS = 300000;
export const MAX_TOTAL_ACCEPTANCE_MS = 300000;
const CAPTURE_BUFFER_LIMIT = 8192;
const PERSIST_TAIL_LIMIT = 4000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const ORCH_KINDS = new Set(['consult', 'council', 'cross_review']);
const SANDBOX_DENY_RE = /operation not permitted|permission denied|read-only file system|eacces|eperm|erofs/i;

export function validateAcceptanceChecks(checks) {
  if (checks === undefined || checks === null) return undefined;
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > MAX_ACCEPTANCE_CHECKS) {
    throw new Error(`acceptanceChecks must contain 1 to ${MAX_ACCEPTANCE_CHECKS} entries`);
  }
  return checks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`acceptanceChecks[${index}] must be an object`);
    }
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!command || command.length > 4000) {
      throw new Error(`acceptanceChecks[${index}].command must be a non-empty string up to 4000 chars`);
    }
    let name;
    if (item.name !== undefined) {
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) {
        throw new Error(`acceptanceChecks[${index}].name must be a non-empty string up to 100 chars`);
      }
      name = item.name.trim();
    }
    const expectExit = item.expectExit ?? 0;
    if (!Number.isInteger(expectExit) || expectExit < 0 || expectExit > 255) {
      throw new Error(`acceptanceChecks[${index}].expectExit must be an integer from 0 to 255`);
    }
    const timeoutMs = item.timeoutMs ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
      throw new Error(`acceptanceChecks[${index}].timeoutMs must be an integer from 1000 to ${MAX_CHECK_TIMEOUT_MS}`);
    }
    return { ...(name ? { name } : {}), command, expectExit, timeoutMs };
  });
}

export function normalizeOrchestration(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid orchestration metadata');
  if (!ORCH_KINDS.has(input.kind)) throw new Error('Invalid orchestration kind');
  if (typeof input.runId !== 'string' || !UUID_RE.test(input.runId)) throw new Error('Invalid orchestration runId');
  const result = { kind: input.kind, runId: input.runId };
  if (input.role !== undefined && input.role !== null) {
    if (typeof input.role !== 'string' || !input.role.trim() || input.role.trim().length > 60) {
      throw new Error('Invalid orchestration role');
    }
    result.role = input.role.trim();
  }
  if (input.sourceAgentId !== undefined && input.sourceAgentId !== null) {
    if (typeof input.sourceAgentId !== 'string' || !UUID_RE.test(input.sourceAgentId)) {
      throw new Error('Invalid orchestration sourceAgentId');
    }
    result.sourceAgentId = input.sourceAgentId;
  }
  return result;
}

export function buildAgentInstructions(record) {
  const policy = record.policy || {};
  if (policy.readOnly || policy.nonInteractive) {
    const readNote = policy.allowWorkspaceRead === false
      ? 'Workspace file tools are disabled; answer purely from the prompt and provided context.'
      : `You have read-only access to ${record.workspace.cwd} via the read tool. Do not attempt to write, edit, or execute shell commands.`;
    const askNote = policy.nonInteractive
      ? 'Interactive questioning (ask_parent) is disabled; do not call ask_parent. State explicit assumptions if any detail is uncertain.'
      : 'Use ask_parent only for unresolved blocking decisions.';
    return `You are a read-only external Pi analysis subagent orchestrated by the parent agent (${record.parentInfo?.kind || 'mcp'}). Your ID: ${record.id}.\n${readNote}\n${askNote}\nProvided context:\n${record.context}`;
  }
  const checksNote = record.acceptanceChecks?.length
    ? `\nAutomated acceptance checks will run in your sandboxed workspace after you settle (${record.acceptanceChecks.map((c, i) => c.name || `check-${i + 1}: ${c.command}`).join('; ')}). Run them yourself before finishing.`
    : '';
  return `You are an external Pi subagent orchestrated by the parent agent (${record.parentInfo?.kind || 'mcp'}). Your ID: ${record.id}.\nOwned paths: ${record.ownedPaths.join(', ')}. Do not edit siblings' files or revert others' changes. Your directory is ${record.workspace.cwd}. File tools and shell descendants are restricted to the assigned workspace and owned paths. Shell networking is ${policy.allowNetwork ? 'enabled' : 'disabled'} by policy.\nUse agent_message(recipient="parent", message=...) for important progress. Use ask_parent for unresolved blocking decisions; its tool result is the parent's answer. Finish with changed files, checks actually run, remaining issues. Never claim tests passed without running them. Do not deploy or send external messages without explicit parent authorization.${checksNote}\nProvided context:\n${record.context}`;
}

function appendBounded(current, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const combined = current + text;
  return combined.length > CAPTURE_BUFFER_LIMIT ? combined.slice(-CAPTURE_BUFFER_LIMIT) : combined;
}

export function summarizeVerification(verification) {
  if (!verification) return { status: 'none' };
  return {
    status: verification.status,
    ...(verification.checkedAt ? { checkedAt: verification.checkedAt } : {}),
    ...(verification.sandboxBackend ? { sandboxBackend: verification.sandboxBackend } : {}),
    ...(verification.totalDurationMs !== undefined ? { totalDurationMs: verification.totalDurationMs } : {}),
    ...(verification.passedCount !== undefined ? { passedCount: verification.passedCount } : {}),
    ...(verification.failedCount !== undefined ? { failedCount: verification.failedCount } : {}),
    ...(verification.totalCount !== undefined ? { totalCount: verification.totalCount } : {}),
  };
}

function abortedPayload(backend, startedAll, results, totalCount) {
  const passedCount = results.filter(r => r.passed).length;
  return {
    aborted: true, status: 'skipped', checkedAt: new Date().toISOString(), sandboxBackend: backend,
    totalDurationMs: Date.now() - startedAll, passedCount, failedCount: results.length - passedCount, totalCount, checks: results,
  };
}

export async function runAcceptanceChecks(checks, toolPolicy, { signal, runner = runSandboxed } = {}) {
  const startedAll = Date.now();
  const totalBudgetMs = Math.min(checks.reduce((sum, item) => sum + item.timeoutMs, 0), MAX_TOTAL_ACCEPTANCE_MS);
  const batchDeadline = startedAll + totalBudgetMs;
  const backend = sandboxHealth().backend;
  const strict = sandboxMode(toolPolicy) === 'strict';
  const results = [];

  for (const check of checks) {
    if (signal?.aborted) return abortedPayload(backend, startedAll, results, checks.length);
    const remainingBatch = batchDeadline - Date.now();
    if (remainingBatch <= 0) {
      results.push({ ...(check.name ? { name: check.name } : {}), command: check.command, expectExit: check.expectExit, exitCode: 137, passed: false, timedOut: true, durationMs: 0, stdoutTail: '', stderrTail: `Batch acceptance timeout exceeded (${totalBudgetMs}ms)` });
      continue;
    }
    let stdout = ''; let stderr = '';
    const started = Date.now();
    let runResult;
    try {
      runResult = await runner(toolPolicy, '/bin/bash', ['--noprofile', '--norc', '-c', check.command], {
        timeout: Math.min(check.timeoutMs, remainingBatch), signal,
        onStdout: chunk => { stdout = appendBounded(stdout, chunk); },
        onStderr: chunk => { stderr = appendBounded(stderr, chunk); },
      });
    } catch (error) {
      if (signal?.aborted) return abortedPayload(backend, startedAll, results, checks.length);
      runResult = { exitCode: 1, timedOut: false, signal: null };
      stderr = appendBounded(stderr, error?.message || String(error));
    }
    if (signal?.aborted) return abortedPayload(backend, startedAll, results, checks.length);
    const stdoutTail = stdout.slice(-PERSIST_TAIL_LIMIT);
    const stderrTail = stderr.slice(-PERSIST_TAIL_LIMIT);
    const timedOut = Boolean(runResult.timedOut);
    const passed = !timedOut && runResult.exitCode === check.expectExit;
    const sandboxHint = !passed && strict && SANDBOX_DENY_RE.test(stderrTail)
      ? 'Command hit strict sandbox restriction (fail-closed). Ensure writes target ownedPaths or TMPDIR, or explicitly authorize dev sandboxMode.'
      : undefined;
    results.push({ ...(check.name ? { name: check.name } : {}), command: check.command, expectExit: check.expectExit, exitCode: runResult.exitCode, passed, timedOut, durationMs: Date.now() - started, stdoutTail, stderrTail, ...(sandboxHint ? { sandboxHint } : {}) });
  }

  const passedCount = results.filter(r => r.passed).length;
  return { status: passedCount === checks.length ? 'verified' : 'failed', checkedAt: new Date().toISOString(), sandboxBackend: backend, totalDurationMs: Date.now() - startedAll, passedCount, failedCount: checks.length - passedCount, totalCount: checks.length, checks: results };
}
