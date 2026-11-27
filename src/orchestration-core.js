import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, readJsonSafe } from './storage.js';
import { assertToolPath } from './tool-sandbox.js';
import { DashboardData } from './dashboard-data.js';

export const TERMINAL_STATUSES = new Set(['completed', 'completed-verified', 'completed-unverified', 'failed', 'interrupted', 'closed', 'stopped']);
const RUN_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const isRunId = value => typeof value === 'string' && RUN_ID_RE.test(value);
export const runsDir = stateRoot => path.join(path.resolve(stateRoot), 'runs');

export function ensureScratchCwd(stateRoot, runId) {
  const dir = path.join(runsDir(stateRoot), runId, 'scratch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function resolveContextFiles({ cwd, contextFiles = [], stateRoot, maxFileBytes = 12000, maxTotalBytes = 32000 }) {
  if (!contextFiles?.length) return { files: [], block: '' };
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('contextFiles requires an explicit absolute cwd');
  const policy = { cwd, stateRoot: path.resolve(stateRoot), ownedPaths: [], tempDir: os.tmpdir(), sandboxMode: 'strict' };
  const files = [];
  const sections = [];
  let remaining = maxTotalBytes;
  for (const rel of contextFiles) {
    const resolved = assertToolPath(rel, policy, false);
    if (!fs.existsSync(resolved)) throw new Error(`Context file not found: ${rel}`);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Context path is not a file: ${rel}`);
    const raw = fs.readFileSync(resolved, 'utf8');
    const content = raw.slice(0, Math.min(maxFileBytes, Math.max(0, remaining)));
    const truncated = content.length < raw.length;
    remaining -= content.length;
    files.push({ path: rel, bytes: content.length, truncated });
    sections.push(`--- File: ${rel}${truncated ? ' (truncated)' : ''} ---\n${content}`);
    if (remaining <= 0) break;
  }
  return { files, block: sections.join('\n\n') };
}

export function parseStructuredJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { data: null, warning: 'Empty model response' };
  const tryObject = snippet => {
    try {
      const parsed = JSON.parse(snippet.trim());
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  };
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = tryObject(fenced[i][1]);
    if (parsed) return { data: parsed, warning: null };
  }
  const end = raw.lastIndexOf('}');
  if (end !== -1) {
    let depth = 0; let inString = false; let escape = false;
    for (let i = end; i >= 0; i--) {
      const ch = raw[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '}') depth++;
      else if (ch === '{' && --depth === 0) {
        const parsed = tryObject(raw.slice(i, end + 1));
        if (parsed) return { data: parsed, warning: null };
        break;
      }
    }
  }
  return { data: null, warning: 'Model response did not contain a valid structured JSON block' };
}

export function saveRun(stateRoot, record) {
  if (!isRunId(record?.runId)) throw new Error('Invalid runId');
  const dir = runsDir(stateRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${record.runId}.json`);
  atomicWriteJson(file, record);
  return file;
}

export function loadRun(stateRoot, runId) {
  if (!isRunId(runId)) throw new Error('Invalid runId');
  return readJsonSafe(path.join(runsDir(stateRoot), `${runId}.json`));
}

export function listRuns(stateRoot, limit = 100) {
  const dir = runsDir(stateRoot);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = readJsonSafe(path.join(dir, name));
    if (raw && isRunId(raw.runId)) items.push(raw);
  }
  items.sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
  return items.slice(0, limit);
}

export async function runEphemeralAgent({
  manager, callbacks, stateRoot, runId, kind, role = 'general', sourceAgentId,
  provider, model, thinking, cwd, prompt, context = '',
  allowWorkspaceRead = true, timeoutMs = 120000, autoArchive = true, parentSession, signal, onProgress,
}) {
  const startedAt = Date.now();
  const orchestration = { kind, runId, role, ...(sourceAgentId ? { sourceAgentId } : {}) };
  const spawned = await manager.spawn({
    cwd, prompt, context, provider, model,
    ...(thinking ? { thinking } : {}),
    name: `${kind}:${role}:${model}`.slice(0, 100),
    ownedPaths: [],
    workspaceMode: 'shared',
    policy: { readOnly: true, nonInteractive: true, allowWorkspaceRead, allowNetwork: false },
    orchestration,
    ...(parentSession || {}),
  });
  const agentId = spawned.id;
  if (callbacks) {
    callbacks.configure(agentId, {
      enabled: false,
      ...(parentSession?.antigravitySessionId ? { antigravitySessionId: parentSession.antigravitySessionId } : {}),
      ...(parentSession?.opencodeSessionId ? { opencodeSessionId: parentSession.opencodeSessionId } : {}),
    }, spawned.sequence);
  }

  let timedOut = false; let cancelled = false;
  let after = spawned.sequence || 0;
  let lastAgent = spawned;
  const deadline = startedAt + timeoutMs;

  try {
    while (!TERMINAL_STATUSES.has(lastAgent.status)) {
      if (signal?.aborted) { cancelled = true; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { timedOut = true; break; }
      const stepAbort = new AbortController();
      const onOuterAbort = () => stepAbort.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const waited = await manager.wait([agentId], { [agentId]: after }, Math.min(20000, remaining), stepAbort.signal);
        const item = waited?.results?.[0];
        if (item) {
          after = item.nextSequence ?? after;
          lastAgent = item.agent || lastAgent;
          onProgress?.({ agentId, status: lastAgent.status, sequence: after });
        }
      } catch (error) {
        if (signal?.aborted) { cancelled = true; break; }
        throw error;
      } finally {
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    if (timedOut || cancelled) { try { await manager.interrupt(agentId); } catch {} }
    try { lastAgent = (await manager.read(agentId, 0, 20)).agent || lastAgent; } catch {}
  } finally {
    try { await manager.closeAgent(agentId); } catch {}
  }

  let archived = false;
  if (autoArchive && stateRoot) {
    try { archived = Boolean(new DashboardData(stateRoot).organize([agentId], { archived: true }).archiveResult?.updatedIds?.includes(agentId)); } catch {}
  }

  const status = cancelled ? 'cancelled' : timedOut ? 'timeout' : (lastAgent.status === 'failed' ? 'failed' : 'completed');
  return {
    agentId, status,
    answer: lastAgent.lastText || '',
    usage: lastAgent.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedCost: 0 },
    error: cancelled ? 'Cancelled by caller' : timedOut ? `Timed out after ${timeoutMs}ms` : (lastAgent.error || null),
    durationMs: Date.now() - startedAt,
    archived,
  };
}
