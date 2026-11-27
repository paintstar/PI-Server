#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Storage, atomicWriteJson, readJsonSafe } from '../src/storage.js';
import {
  callbackEvents, callbackText, readCallbackRecord, deliveredCursorOf, sessionBoundAgentIds, scanAgentEvents,
} from '../src/callbacks.js';
import { assertSafeSessionId } from '../src/wait-reminder.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string', multiple: true },
    session: { type: 'string' },
    after: { type: 'string', multiple: true },
    events: { type: 'string', default: 'settled,question,process_failed,budget_limit,control_failed' },
    timeout: { type: 'string', default: '3600' },
    follow: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

if (!values.agent?.length && !values.session) {
  console.error('Usage: wait-events.js (--agent <id> | --session <sessionId>) [--after <id>=<sequence>] [--events settled,question] [--timeout seconds] [--follow] [--json]');
  process.exit(64);
}
const sessionId = values.session ? assertSafeSessionId(values.session) : undefined;
const timeoutSec = Number(values.timeout);
if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
  console.error('--timeout must be a non-negative number');
  process.exit(64);
}
const events = values.events.split(',').filter(Boolean);
if (!events.length || events.some(type => !callbackEvents.includes(type))) {
  console.error(`Events must be from: ${callbackEvents.join(', ')}`);
  process.exit(64);
}

const root = path.resolve(process.env.PI_SERVER_STATE_DIR || fileURLToPath(new URL('../.agents/runtime', import.meta.url)));
const storage = new Storage(root);
const watchersDir = path.join(root, 'watchers');
const explicitOverrides = new Map();
for (const item of values.after || []) {
  const sep = item.indexOf('=');
  const id = sep > 0 ? item.slice(0, sep) : '';
  const rawSeq = sep > 0 ? item.slice(sep + 1) : '';
  const seq = Number(rawSeq);
  if (!id || !rawSeq || !Number.isInteger(seq) || seq < 0) {
    console.error(`Invalid --after value: ${item}`);
    process.exit(64);
  }
  explicitOverrides.set(id, seq);
}

const after = {};
for (const id of values.agent || []) {
  const record = readJsonSafe(path.join(storage.directory(id), 'agent.json'));
  if (!record) {
    console.error(`Agent not found: ${id}`);
    process.exit(66);
  }
  after[id] = explicitOverrides.has(id) ? explicitOverrides.get(id) : record.sequence;
}

const key = String(sessionId || values.agent?.[0] || 'watch').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
const watcherFile = path.join(watchersDir, `${key}-${process.pid}.json`);
let watcherHandle = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (watcherHandle) {
    try { watcherHandle.close(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    watcherHandle = null;
  }
  try { fs.unlinkSync(watcherFile); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

fs.mkdirSync(watchersDir, { recursive: true, mode: 0o700 });
atomicWriteJson(watcherFile, {
  pid: process.pid,
  sessionId: sessionId || null,
  agentIds: values.agent || [],
  startedAt: new Date().toISOString(),
});
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let dirty = false;
let wake = null;
const onFsChange = () => {
  dirty = true;
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
};
if (fs.existsSync(root)) {
  try { watcherHandle = fs.watch(root, { recursive: true }, onFsChange); }
  catch (error) {
    if (error?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw error;
    watcherHandle = fs.watch(root, onFsChange);
  }
  watcherHandle?.on('error', () => {
    try { watcherHandle?.close(); } catch {}
    watcherHandle = null;
  });
}

const deadline = Date.now() + timeoutSec * 1000;
for (;;) {
  const targets = sessionId
    ? sessionBoundAgentIds(storage, sessionId, { respectEnabled: true, extraIds: values.agent || [] })
    : [...(values.agent || [])];
  let matched = 0;
  for (const id of targets) {
    if (after[id] === undefined) {
      after[id] = explicitOverrides.has(id) ? explicitOverrides.get(id) : deliveredCursorOf(readCallbackRecord(root, id));
    }
    const scanned = scanAgentEvents(storage, id, {
      afterSequence: after[id],
      eventTypes: events,
      source: 'wait-events',
      sessionId,
    });
    after[id] = scanned.cursor;
    for (const event of scanned.matched) {
      console.log(values.json ? JSON.stringify(event) : `${callbackText(event)}\n`);
      matched++;
    }
  }
  if (matched && !values.follow) {
    cleanup();
    process.exit(0);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const label = sessionId ? `session ${sessionId}` : values.agent.join(', ');
    console.log(`No callback event within ${values.timeout}s for ${label}. Cursor: ${JSON.stringify(after)} (state ${path.basename(root)})`);
    cleanup();
    process.exit(values.follow ? 0 : 2);
  }
  if (!dirty) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(250, Math.max(20, remaining)));
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
  dirty = false;
}
