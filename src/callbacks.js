import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { maxAgentLimit } from './manager.js';
import { atomicWriteJson, readJsonSafe } from './storage.js';
import { waitCommandFor, sessionIdPattern } from './wait-reminder.js';

export const callbackEvents = ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed', 'message'];
const defaultEvents = ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed'];
export const callbackShape = z.object({
  enabled: z.boolean().default(true),
  codexThreadId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  antigravitySessionId: z.string().trim().min(1).max(200).regex(sessionIdPattern).optional(),
  antigravityCliResume: z.boolean().default(false),
  events: z.array(z.enum(callbackEvents)).min(1).optional(),
});

const isUuid = value => /^[0-9a-f-]{36}$/.test(value);

export function readCallbackRecord(root, agentId) {
  if (!isUuid(agentId)) return null;
  return readJsonSafe(path.join(root, 'callbacks', `${agentId}.json`));
}

export function advanceAntigravityCursor(root, agentId, sequence, { source = 'wait_agent', sessionId } = {}) {
  if (!sequence || !isUuid(agentId)) return null;
  const old = readCallbackRecord(root, agentId);
  if (!old && !sessionId) return null;
  const next = Math.max(old?.antigravityDeliveredSeq || 0, sequence);
  if (old && next <= (old.antigravityDeliveredSeq || 0)) return old;
  const updated = old
    ? { ...old, antigravityDeliveredSeq: next, lastObservedBy: source, updatedAt: new Date().toISOString() }
    : {
        agentId,
        enabled: true,
        events: defaultEvents,
        host: 'antigravity',
        antigravitySessionId: sessionId,
        antigravityCliResume: false,
        since: 0,
        antigravityDeliveredSeq: next,
        lastObservedBy: source,
        updatedAt: new Date().toISOString(),
      };
  atomicWriteJson(path.join(root, 'callbacks', `${agentId}.json`), updated);
  return updated;
}

export function sessionBoundAgentIds(storage, sessionId, { respectEnabled = true, extraIds = [] } = {}) {
  const ids = new Set(extraIds);
  if (!sessionId) return [...ids];
  const callbacksDir = path.join(storage.root, 'callbacks');
  if (fs.existsSync(callbacksDir)) {
    for (const file of fs.readdirSync(callbacksDir).filter(name => name.endsWith('.json'))) {
      const id = file.slice(0, -5);
      const cb = readCallbackRecord(storage.root, id);
      if (cb?.antigravitySessionId === sessionId && (!respectEnabled || cb.enabled !== false) && fs.existsSync(path.join(storage.root, id, 'agent.json'))) {
        ids.add(id);
      }
    }
  }
  for (const record of storage.all()) {
    if (record.parentInfo?.sessionId !== sessionId) continue;
    const cb = readCallbackRecord(storage.root, record.id);
    if (respectEnabled && cb?.enabled === false) continue;
    ids.add(record.id);
  }
  return [...ids];
}

const defaultEventSet = new Set(defaultEvents);

export function scanAgentEvents(storage, agentId, { afterSequence = 0, eventTypes = defaultEvents, source = 'observer', sessionId } = {}) {
  const allowed = eventTypes instanceof Set ? eventTypes : new Set(eventTypes);
  const matched = [];
  let cursor = afterSequence;
  let sharedCursor = afterSequence;
  let sharedBlocked = false;
  for (;;) {
    let batch;
    try { batch = storage.events(agentId, cursor, 100); }
    catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) break;
      throw error;
    }
    if (!batch.length) break;
    for (const event of batch) {
      cursor = event.sequence;
      const wanted = allowed.has(event.type) && (event.type !== 'message' || event.recipient === 'parent');
      if (wanted) {
        matched.push(event);
        if (!sharedBlocked) sharedCursor = event.sequence;
        continue;
      }
      if (defaultEventSet.has(event.type)) sharedBlocked = true;
      else if (!sharedBlocked) sharedCursor = event.sequence;
    }
    if (batch.length < 100) break;
  }
  if (sharedCursor > afterSequence && (sessionId || readCallbackRecord(storage.root, agentId))) {
    advanceAntigravityCursor(storage.root, agentId, sharedCursor, { source, sessionId });
  }
  return { matched, cursor };
}

export function callbackText(event) {
  const head = `[pi-subagents callback] agent ${event.agentId} event=${event.type} sequence=${event.sequence}`;
  const next = `Continue with wait_agent(agentIds=["${event.agentId}"], after={"${event.agentId}": ${event.sequence}}) or read_agent.`;
  if (event.type === 'question') return `${head}\nBlocking question ${event.questionId}:\n${String(event.question).slice(0, 4000)}\nAnswer with reply_question(questionId="${event.questionId}").`;
  if (event.type === 'settled') return `${head} status=${event.status}${event.error ? `\nError: ${String(event.error).slice(0, 1000)}` : ''}\nLast reply (verify actual changes before accepting):\n${String(event.text || '').slice(-3000)}\n${next}`;
  if (event.type === 'message') return `${head}\nReport:\n${String(event.message).slice(0, 3000)}\n${next}`;
  return `${head}\n${String(event.reason || event.error || '').slice(0, 1000)}\n${next}`;
}

export function eventSnapshot(event) {
  return {
    sequence: event.sequence,
    type: event.type,
    time: event.time || new Date().toISOString(),
    ...(event.status ? { status: event.status } : {}),
    ...(event.questionId ? { questionId: event.questionId } : {}),
    ...(event.question ? { question: String(event.question).slice(0, 4000) } : {}),
    ...(event.text ? { text: String(event.text).slice(-3000) } : {}),
    ...(event.message ? { message: String(event.message).slice(0, 3000) } : {}),
    ...(event.reason ? { reason: String(event.reason).slice(0, 1000) } : {}),
    ...(event.error ? { error: String(event.error).slice(0, 1000) } : {}),
  };
}

export class Callbacks {
  constructor({ root, server, codexExecutable = process.env.CODEX_EXECUTABLE || 'codex', agyExecutable = process.env.AGY_EXECUTABLE || 'agy', run = execFile }) {
    this.root = root;
    this.directory = path.join(root, 'callbacks');
    this.server = server; this.codexExecutable = codexExecutable; this.agyExecutable = agyExecutable; this.run = run;
    this.queues = new Map();
  }
  file(agentId) {
    if (!isUuid(agentId)) throw new Error('Invalid agent ID');
    return path.join(this.directory, agentId + '.json');
  }
  get(agentId) {
    return isUuid(agentId) ? readCallbackRecord(this.root, agentId) : null;
  }
  save(agentId, value) {
    atomicWriteJson(this.file(agentId), value);
    return value;
  }
  host() {
    const name = this.server.getClientVersion()?.name || '';
    if (/codex/i.test(name)) return 'codex';
    if (/claude/i.test(name)) return 'claude';
    if (/antigravity|agy|gemini/i.test(name) || process.env.ANTIGRAVITY_CONVERSATION_ID || process.env.ANTIGRAVITY_AGENT) return 'antigravity';
    return 'other';
  }
  routes(config) {
    const host = config.host || this.host();
    const base = { claudeChannel: host === 'claude', codexQueue: Boolean(config.codexThreadId) };
    if (host !== 'antigravity' && !config.antigravitySessionId) return base;
    return {
      ...base,
      antigravityHook: Boolean(config.antigravitySessionId),
      antigravityCli: Boolean(config.antigravitySessionId && config.antigravityCliResume),
      antigravityWaitCommand: waitCommandFor({ agentId: config.agentId, sessionId: config.antigravitySessionId }),
    };
  }
  configure(agentId, options = {}, since = 0) {
    const old = this.get(agentId);
    const host = old?.host || this.host();
    const envSessionId = host === 'codex' || host === 'claude' ? undefined : process.env.ANTIGRAVITY_CONVERSATION_ID;
    const rawSid = options.antigravitySessionId || old?.antigravitySessionId || envSessionId;
    const antigravitySessionId = typeof rawSid === 'string' && sessionIdPattern.test(rawSid.trim()) ? rawSid.trim() : undefined;
    const delivered = Math.max(since, old?.antigravityDeliveredSeq || 0);
    const value = {
      agentId,
      enabled: options.enabled ?? old?.enabled ?? true,
      events: options.events || old?.events || defaultEvents,
      codexThreadId: options.codexThreadId || old?.codexThreadId || process.env.CODEX_THREAD_ID || undefined,
      antigravitySessionId,
      antigravityCliResume: options.antigravityCliResume ?? old?.antigravityCliResume ?? false,
      host,
      since: Math.max(since, old?.since || 0),
      antigravityDeliveredSeq: delivered,
      lastEvent: old?.lastEvent,
      lastDelivery: old?.lastDelivery,
      updatedAt: new Date().toISOString(),
    };
    this.save(agentId, value);
    return { ...value, routes: this.routes(value) };
  }
  markObserved(agentId, sequence, source = 'wait_agent') {
    return advanceAntigravityCursor(this.root, agentId, sequence, { source });
  }
  handle(event) {
    const config = this.get(event.agentId);
    if (!config?.enabled || event.sequence <= config.since || !config.events.includes(event.type)) return;
    if (event.type === 'message' && event.recipient !== 'parent') return;
    const previous = this.queues.get(event.agentId) || Promise.resolve();
    const next = previous.then(() => this.deliver(event)).catch(error => process.stderr.write(`Pi callback failed: ${error.message}\n`));
    this.queues.set(event.agentId, next);
    return next;
  }
  async deliver(event) {
    const config = this.get(event.agentId);
    if (!config || event.sequence <= config.since) return;
    config.since = event.sequence;
    config.lastEvent = eventSnapshot(event);
    this.save(event.agentId, config);
    const content = callbackText(event), routes = this.routes(config), results = {};
    if (routes.claudeChannel) {
      try {
        await this.server.notification({ method: 'notifications/claude/channel', params: { content, meta: { agent_id: event.agentId, event: event.type, sequence: String(event.sequence) } } });
        results.claudeChannel = 'sent';
      } catch (error) { results.claudeChannel = `failed: ${error.message}`; }
    }
    if (routes.codexQueue) {
      results.codexQueue = await new Promise(resolve => {
        this.run(this.codexExecutable, ['queue', '--thread', config.codexThreadId, '--message', content], { timeout: 20000, maxBuffer: 64 * 1024 },
          error => resolve(error ? `failed: ${error.message.split('\n')[0]}` : 'queued'));
      });
    }
    let cliDelivered = 0;
    if (routes.antigravityCli) {
      results.antigravityCli = await new Promise(resolve => {
        this.run(this.agyExecutable, ['--conversation', config.antigravitySessionId, '--mode', 'auto', '-p', content], { timeout: 30000, maxBuffer: 64 * 1024 },
          error => resolve(error ? `failed: ${error.message.split('\n')[0]}` : 'resumed'));
      });
      if (results.antigravityCli === 'resumed') cliDelivered = event.sequence;
    } else if (routes.antigravityHook) {
      results.antigravityHook = 'pending_hook_or_watcher';
    }
    const latest = this.get(event.agentId) || config;
    const merged = {
      ...latest,
      since: Math.max(latest.since || 0, event.sequence),
      antigravityDeliveredSeq: Math.max(latest.antigravityDeliveredSeq || 0, cliDelivered),
      lastEvent: config.lastEvent,
      lastDelivery: { sequence: event.sequence, type: event.type, time: new Date().toISOString(), results },
      updatedAt: new Date().toISOString(),
    };
    this.save(event.agentId, merged);
    return results;
  }
}

export function installCallbacks(server, manager, register) {
  server.server.registerCapabilities({ experimental: { 'claude/channel': {} } });
  const callbacks = new Callbacks({ root: manager.storage.root, server: server.server });
  manager.on('event', event => { callbacks.handle(event); });
  register('set_agent_callback', 'Configure parent wake-up callbacks for owned agents. Supports Antigravity hooks/background watcher (pass callback.antigravitySessionId = Conversation ID, optionally antigravityCliResume=true), Claude Code channel notifications, and Codex queue (codexThreadId). Default events: settled, question, process_failed, budget_limit, control_failed.', {
    agentIds: z.array(z.string().uuid()).min(1).max(maxAgentLimit), ...callbackShape.shape,
  }, async ({ agentIds, ...options }) => {
    const result = [];
    for (const agentId of agentIds) {
      const current = await manager.read(agentId, 0, 1);
      result.push(callbacks.configure(agentId, options, current.agent.sequence));
    }
    return { callbacks: result, host: callbacks.host() };
  });
  return callbacks;
}
