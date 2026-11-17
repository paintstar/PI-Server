import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { Manager, defaultMaxAgents } from './manager.js';
import { processAlive, atomicWriteJson } from './storage.js';
import { normalizeParentInfo } from './controller-client.js';
import { FileTaskStore } from './task-store.js';

const controllerScriptPath = fileURLToPath(import.meta.url);
const activeAgentStatuses = new Set(['starting', 'running', 'waiting', 'finishing']);
const operationRetentionMs = 7 * 86400 * 1000;
const detachedParentRetentionMs = 86400 * 1000;

const root = path.resolve(process.env.PI_SUBAGENTS_STATE_DIR);
const lock = path.join(root, 'controller.lock');
if (fs.existsSync(lock)) {
  let old;
  try { old = JSON.parse(fs.readFileSync(lock, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError && Date.now() - fs.statSync(lock).mtimeMs < 5000) process.exit(0); throw new Error('Controller lock is damaged; verify its process has stopped before removing it.'); }
  if (processAlive(old.pid)) process.exit(0);
  fs.unlinkSync(lock);
}
try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error; }
const manager = await new Manager({ root, executable: process.env.PI_EXECUTABLE || 'pi', maxAgents: Number(process.env.PI_SUBAGENTS_MAX_AGENTS || defaultMaxAgents) }).start();
const parents = new Map();
const parentWake = new EventEmitter();
parentWake.setMaxListeners(0);
manager.on('event', event => {
  const pid = manager.agents.get(event.agentId)?.record?.parentId;
  if (pid) parentWake.emit(pid);
});
const tasks = new FileTaskStore(root, manager);
const operations = path.join(root, 'operations'); fs.mkdirSync(operations, { recursive: true, mode: 0o700 });
const writes = new Map();

function pruneRuntime() {
  tasks.prune();
  const now = Date.now();
  if (fs.existsSync(operations)) {
    for (const file of fs.readdirSync(operations).filter(name => name.endsWith('.json'))) {
      const key = file.slice(0, -5);
      if (writes.has(key)) continue;
      const target = path.join(operations, file);
      try {
        if (now - fs.statSync(target).mtimeMs > operationRetentionMs) fs.unlinkSync(target);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  const callbacksDir = path.join(root, 'callbacks');
  if (fs.existsSync(callbacksDir)) {
    for (const file of fs.readdirSync(callbacksDir).filter(name => name.endsWith('.json'))) {
      const id = file.slice(0, -5);
      const target = path.join(callbacksDir, file);
      if (manager.agents.has(id) || fs.existsSync(path.join(root, id))) continue;
      try {
        if (now - fs.statSync(target).mtimeMs > operationRetentionMs) fs.unlinkSync(target);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  const ownedParents = new Set([...manager.agents.values()].map(a => a.record.parentId).filter(Boolean));
  for (const [id, info] of parents) {
    if (!info.connected && !ownedParents.has(id) && now - (info.lastSeen || 0) > detachedParentRetentionMs) parents.delete(id);
  }
}

const cleanup = setInterval(() => { try { pruneRuntime(); } catch (error) { process.stderr.write(`Task cleanup failed: ${error.message}\n`); } }, 60000); cleanup.unref();
const token = randomUUID();
// macOS limits Unix socket paths; its dedicated directory is private even when the state root is long.
const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-controller-')); fs.chmodSync(socketDirectory, 0o700);
const socket = path.join(socketDirectory, 'rpc.sock');
function own(parentId, agentId) {
  const agent = manager.get(agentId);
  if (agent.record.parentId !== parentId) throw new Error('Agent belongs to another parent; explicitly resume only after its parent detaches.');
  return agent;
}
async function once(parentId, key, values, operation) {
  if (!key) return operation();
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid requestId');
  const file = path.join(operations, key + '.json');
  const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  if (writes.has(key)) await writes.get(key);
  if (fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.parentId !== parentId || old.fingerprint !== fingerprint) throw new Error('requestId already belongs to different content or parent');
    if (old.state === 'completed') return { ...old.result, duplicate: true };
    if (old.state === 'failed') throw new Error(old.error);
    throw new Error('Operation outcome is uncertain after a controller failure; inspect saved agents before dispatching new work.');
  }
  const record = { parentId, fingerprint, state: 'attempted' };
  const save = () => atomicWriteJson(file, record);
  save();
  const pending = (async () => {
    try { record.result = await operation(); record.state = 'completed'; save(); return record.result; }
    catch (error) { record.state = 'failed'; record.error = error.message; save(); throw error; }
  })();
  writes.set(key, pending);
  try { return await pending; } finally { writes.delete(key); }
}
const isParentAttached = id => Boolean(parents.get(id)?.connected && processAlive(parents.get(id).pid));
function resumeAgent(parentId, v) {
  const current = manager.agents.get(v.agentId);
  const parentIdentityInfo = parents.get(parentId)?.identity;
  const explicit = v.antigravitySessionId ? { kind: 'antigravity', sessionId: v.antigravitySessionId, cwd: parentIdentityInfo?.cwd } : v.parentSession || parentIdentityInfo;
  if (current && current.record.parentId !== parentId && isParentAttached(current.record.parentId)) {
    throw new Error('Agent belongs to an attached parent');
  }
  if (current?.rpc && !current.rpc.exited) {
    current.record.parentId = parentId;
    current.record.parentInfo = normalizeParentInfo(explicit, current.record.parentInfo);
    manager.storage.save(current.record);
    parentWake.emit(parentId);
    return { ...manager.summary(current), reattached: true };
  }
  return manager.resume(v.agentId, v).then(() => {
    const agent = manager.get(v.agentId);
    agent.record.parentId = parentId;
    agent.record.parentInfo = normalizeParentInfo(explicit, agent.record.parentInfo);
    manager.storage.save(agent.record);
    parentWake.emit(parentId);
    return manager.summary(agent);
  });
}

function bindSession(parentId, parent, v) {
  const identity = normalizeParentInfo(v.parent, parent.identity);
  parents.set(parentId, { ...parent, connected: true, identity, lastSeen: Date.now() });
  const ids = Array.isArray(v.agentIds) ? v.agentIds : [...manager.agents.values()].filter(a => a.record.parentId === parentId).map(a => a.record.id);
  const bound = [];
  for (const id of ids) {
    const target = manager.get(id);
    const owner = target.record.parentId;
    if (owner !== parentId && isParentAttached(owner)) {
      throw new Error('Agent belongs to another parent; explicitly resume only after its parent detaches.');
    }
    bound.push(manager.bindParentInfo(id, identity, owner !== parentId ? parentId : undefined));
  }
  if (bound.length) parentWake.emit(parentId);
  return { identity, boundAgents: bound.map(a => a.id) };
}

function collectPollEvents(ownedAgents, after = {}) {
  return ownedAgents.flatMap(a => manager.read(a.record.id, after[a.record.id] || 0).events);
}

function waitParentEvents(owned, parentId, after = {}, timeoutMs = 20000, signal) {
  const immediate = collectPollEvents(owned(), after);
  if (immediate.length || !timeoutMs || signal?.aborted) return Promise.resolve({ events: immediate });
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentWake.off(parentId, onWake);
      signal?.removeEventListener('abort', finish);
      resolve({ events: collectPollEvents(owned(), after) });
    };
    const onWake = () => { if (collectPollEvents(owned(), after).length || !parents.get(parentId)?.connected) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    parentWake.on(parentId, onWake);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted || collectPollEvents(owned(), after).length) finish();
  });
}

async function dispatch(parentId, method, v, signal) {
  if (method === 'health') {
    const activeAgents = [...manager.agents.values()].filter(a => activeAgentStatuses.has(a.record.status)).length;
    return { service: 'pi-controller', pid: process.pid, scriptPath: controllerScriptPath, piAgentDir: process.env.PI_CODING_AGENT_DIR || '', activeAgents, totalAgents: manager.agents.size };
  }
  if (method === 'attach') {
    const identity = normalizeParentInfo(v.parent, parents.get(parentId)?.identity);
    parents.set(parentId, { connected: true, pid: v.pid, identity, lastSeen: Date.now() }); return { parentId, identity };
  }
  if (method === 'detach') { parents.set(parentId, { connected: false, lastSeen: Date.now() }); parentWake.emit(parentId); return { detached: true }; }
  const parent = parents.get(parentId); if (!parent?.connected) throw new Error('Parent is not attached'); parent.lastSeen = Date.now();
  const owned = () => [...manager.agents.values()].filter(value => value.record.parentId === parentId);
  if (method === 'task') {
    const allowed = ['createTask', 'getTask', 'storeTaskResult', 'getTaskResult', 'updateTaskStatus', 'listTasks', 'notificationStates'];
    if (!allowed.includes(v.operation)) throw new Error('Invalid task operation');
    if (v.operation === 'createTask' && v.args[0]?.context?.agentId) own(parentId, v.args[0].context.agentId);
    return tasks[v.operation](...v.args, parentId);
  }
  if (method === 'adoptTask') {
    const value = await tasks.adopt(v.taskId, parentId, isParentAttached);
    const agent = manager.agents.get(value.agentId);
    if (agent) { agent.record.parentId = parentId; agent.record.parentInfo = parents.get(parentId)?.identity; manager.storage.save(agent.record); parentWake.emit(parentId); }
    return value;
  }
  if (method === 'models') return manager.models(v.provider, { includeDisabled: Boolean(v.includeDisabled) });
  if (method === 'spawn') return once(parentId, v.requestId, { method, ...v }, () => manager.spawn({ ...v, parentId, parentInfo: parents.get(parentId)?.identity }));
  if (method === 'list') {
    const all = manager.list(v.includeSaved);
    return all
      .filter(value => manager.agents.get(value.id)?.record.parentId === parentId || v.includeSaved)
      .map(value => {
        const owner = manager.agents.get(value.id)?.record.parentId;
        return { ...value, owned: owner === parentId, attachedOtherParent: Boolean(owner && owner !== parentId && isParentAttached(owner)) };
      });
  }
  if (method === 'resume') return resumeAgent(parentId, v);
  if (method === 'bindSession') return bindSession(parentId, parent, v);
  if (method === 'poll') {
    const timeoutMs = Math.max(0, Math.min(25000, Number(v.timeoutMs ?? 20000)));
    return waitParentEvents(owned, parentId, v.after || {}, timeoutMs, signal);
  }
  if (method === 'reply') {
    const question = manager.channel.questions.get(v.questionId);
    const agent = question ? manager.get(question.agentId) : owned().find(value => manager.messages.all(value.record.id).some(message => message.messageId === v.questionId));
    if (!agent) throw new Error('Question does not belong to this parent'); own(parentId, agent.record.id); return manager.channel.reply(v.questionId, v.message);
  }
  if (method === 'wait') { v.agentIds.forEach(id => own(parentId, id)); return manager.wait(v.agentIds, v.after, v.timeoutMs, signal); }
  if (method === 'readMessages') { own(parentId, v.agentId); return manager.messages.read(v.agentId, v); }
  if (method === 'ackMessages') { own(parentId, v.agentId); return manager.messages.acknowledge(v.agentId, v.messageIds); }
  const agent = own(parentId, v.agentId);
  if (method === 'read') return manager.read(v.agentId, v.afterSequence, v.limit);
  if (method === 'transcript') { if (!agent.rpc || agent.rpc.exited) throw new Error('Resume the saved session first'); return agent.rpc.command('get_messages'); }
  if (method === 'send') return manager.send(v.agentId, v.message, v.mode, v.messageId);
  if (method === 'updatePolicy') return manager.updatePolicy(v.agentId, v.policy, v.authorizationReference);
  if (method === 'setModel') return manager.setModel(v.agentId, v);
  if (method === 'interrupt') return manager.interrupt(v.agentId);
  if (method === 'closeAgent') return manager.closeAgent(v.agentId);
  throw new Error('Unsupported controller method');
}
const server = http.createServer(async (request, response) => {
  const reqAbort = new AbortController();
  response.on('close', () => { if (!response.writableEnded) reqAbort.abort(); });
  const reply = data => { if (!response.destroyed && !response.writableEnded) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); } };
  try {
    const authorization = Buffer.from(request.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/rpc' || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) throw new Error('Unauthorized controller request');
    let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 128000) throw new Error('Request too large'); }
    const { parentId, method, values } = JSON.parse(body);
    if (!/^[0-9a-f-]{36}$/.test(parentId)) throw new Error('Invalid parent ID');
    reply({ result: await dispatch(parentId, method, values || {}, reqAbort.signal) });
  } catch (error) { reply({ error: error.message }); }
});
server.keepAliveTimeout = 0;
await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
const metadata = path.join(root, 'controller.json');
atomicWriteJson(metadata, { pid: process.pid, socket, token, scriptPath: controllerScriptPath });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await manager.close(); server.closeAllConnections(); server.close();
  fs.rmSync(socketDirectory, { recursive: true, force: true }); fs.rmSync(lock, { force: true }); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
