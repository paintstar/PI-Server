#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage, processAlive, readJsonSafe, ownerLockAlive } from '../src/storage.js';
import { callbackText, readCallbackRecord, sessionBoundAgentIds, scanAgentEvents } from '../src/callbacks.js';
import { waitCommandFor, sessionIdPattern } from '../src/wait-reminder.js';

const relevantEvents = new Set(['question', 'settled', 'process_failed', 'budget_limit', 'control_failed']);
const activeStatuses = new Set(['starting', 'running', 'finishing', 'waiting']);

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

let rawInput = '';
try {
  rawInput = fs.readFileSync(0, 'utf8');
} catch (error) {
  if (error?.code !== 'EAGAIN' && error?.code !== 'ENOENT') throw error;
}

let payload = {};
if (rawInput.trim()) {
  try { payload = JSON.parse(rawInput); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

const hookEvent = payload.hookEventName || '';
const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
if (!conversationId || !sessionIdPattern.test(conversationId)) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

const root = path.resolve(process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime', import.meta.url)));
if (!fs.existsSync(root)) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

const storage = new Storage(root);
const watchersDir = path.join(root, 'watchers');

function activeBoundIds(ids) {
  const active = [];
  for (const id of ids) {
    const record = readJsonSafe(path.join(root, id, 'agent.json'));
    if (record && activeStatuses.has(record.status) && ownerLockAlive(path.join(root, id))) active.push(id);
  }
  return active;
}

function hasLiveWatcher(ids) {
  if (!fs.existsSync(watchersDir)) return false;
  for (const file of fs.readdirSync(watchersDir).filter(name => name.endsWith('.json'))) {
    const target = path.join(watchersDir, file);
    const watcher = readJsonSafe(target);
    if (!watcher) continue;
    if (!processAlive(watcher.pid)) {
      try { fs.unlinkSync(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      continue;
    }
    if (watcher.sessionId === conversationId) return true;
    if (Array.isArray(watcher.agentIds) && watcher.agentIds.some(id => ids.includes(id))) return true;
  }
  return false;
}

function collectUndelivered(ids) {
  const blocks = [];
  for (const id of ids) {
    const cb = readCallbackRecord(root, id);
    const { matched } = scanAgentEvents(storage, id, {
      afterSequence: cb?.antigravityDeliveredSeq || 0,
      eventTypes: relevantEvents,
      source: hookEvent || 'hook',
      sessionId: conversationId,
    });
    for (const event of matched) blocks.push(callbackText(event));
  }
  return blocks.join('\n\n');
}

const boundIds = sessionBoundAgentIds(storage, conversationId, { respectEnabled: true });
if (!boundIds.length) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

if (hookEvent === 'PreInvocation') {
  const text = collectUndelivered(boundIds);
  if (!text) respond({});
  respond({
    injectSteps: [{ systemMessage: { systemMessage: text } }],
    terminationBehavior: '',
  });
}

if (hookEvent === 'Stop') {
  if ((payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') || payload.continuationActive === true) {
    respond({ decision: 'allow' });
  }
  const immediate = collectUndelivered(boundIds);
  if (immediate) respond({ decision: 'continue', reason: immediate });

  const initialActive = activeBoundIds(boundIds);
  if (!initialActive.length || hasLiveWatcher(initialActive) || payload.fullyIdle === false) {
    respond({ decision: 'allow' });
  }

  const waitMs = Math.max(0, Math.min(8000, Number(process.env.PI_HOOK_STOP_WAIT_MS ?? 3500)));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(20, deadline - Date.now()))));
    const arrived = collectUndelivered(boundIds);
    if (arrived) respond({ decision: 'continue', reason: arrived });
    const nowActive = activeBoundIds(boundIds);
    if (!nowActive.length || hasLiveWatcher(nowActive)) respond({ decision: 'allow' });
  }

  const remainingActive = activeBoundIds(boundIds);
  if (!remainingActive.length || hasLiveWatcher(remainingActive)) respond({ decision: 'allow' });
  respond({
    decision: 'continue',
    reason: `Active pi-subagents children (${remainingActive.join(', ')}) are still running for conversation ${conversationId} without a watcher. Call wait_agent or start background watcher: ${waitCommandFor({ sessionId: conversationId })}`,
  });
}

respond({});
