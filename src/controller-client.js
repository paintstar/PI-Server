import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultMaxAgents } from './manager.js';
import { processAlive, readJsonSafe } from './storage.js';

const script = fileURLToPath(new URL('./controller.js', import.meta.url));
export function normalizeParentInfo(input, fallback) {
  const source = input && typeof input === 'object' ? input : {};
  const result = {};
  if (typeof source.kind === 'string' && ['antigravity', 'codex', 'claude', 'opencode', 'mcp', 'other', 'unknown'].includes(source.kind)) result.kind = source.kind;
  else if (fallback?.kind) result.kind = fallback.kind;
  for (const key of ['sessionId', 'hostSessionId', 'projectId']) {
    const val = typeof source[key] === 'string' && source[key].trim() && source[key].length <= 500 ? source[key].trim() : fallback?.[key];
    if (val) result[key] = val;
  }
  const cwd = typeof source.cwd === 'string' && path.isAbsolute(source.cwd) && source.cwd.length <= 500 ? source.cwd : fallback?.cwd;
  if (cwd) result.cwd = cwd;
  return Object.keys(result).length ? result : undefined;
}
export function parentIdentity(env = process.env, clientName = '') {
  const fromClient = /opencode/i.test(clientName) ? 'opencode'
    : /codex/i.test(clientName) ? 'codex'
      : /claude/i.test(clientName) ? 'claude'
        : /antigravity|agy/i.test(clientName) ? 'antigravity' : '';
  const fromHint = ['antigravity', 'codex', 'claude', 'opencode'].includes(env.PI_SERVER_HOST) ? env.PI_SERVER_HOST : '';
  const kind = fromClient || fromHint
    || (env.CODEX_THREAD_ID ? 'codex'
      : (env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_PROJECT_ID) ? 'antigravity'
        : env.CLAUDE_CODE_SESSION_ID ? 'claude'
          : (env.OPENCODE_SESSION_ID || env.OPENCODE) ? 'opencode' : 'unknown');
  const sessionId = kind === 'opencode' ? env.OPENCODE_SESSION_ID
    : kind === 'codex' ? env.CODEX_THREAD_ID
      : kind === 'claude' ? env.CLAUDE_CODE_SESSION_ID
        : kind === 'antigravity' ? env.ANTIGRAVITY_CONVERSATION_ID : undefined;
  return normalizeParentInfo({
    kind,
    sessionId,
    hostSessionId: kind === 'antigravity' ? env.ANTIGRAVITY_TRAJECTORY_ID : kind === 'claude' ? env.CLAUDE_CODE_HOST_SESSION_ID : undefined,
    projectId: kind === 'antigravity' ? env.ANTIGRAVITY_PROJECT_ID : undefined,
    cwd: process.cwd(),
  });
}
export class ControllerClient extends EventEmitter {
  constructor(root, info, parentId = randomUUID()) {
    super();
    this.storage = { root };
    this.info = info;
    this.parentId = parentId;
    this.closed = false;
    this.httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 4 });
  }
  async call(method, values = {}, signal) {
    try { return await this.request(method, values, signal); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code) || this.closed || signal?.aborted) throw error;
      const latest = readJsonSafe(path.join(this.storage.root, 'controller.json'));
      if (!latest) throw error;
      if (latest.socket === this.info.socket) {
        if (['ECONNRESET', 'EPIPE'].includes(error.code)) return this.request(method, values, signal);
        throw error;
      }
      this.httpAgent.destroy();
      this.httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 4 });
      this.info = latest;
      await this.request('attach', { pid: process.pid, parent: parentIdentity() });
      return this.request(method, values, signal);
    }
  }
  request(method, values = {}, signal) {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.info.socket, path: '/rpc', method: 'POST', agent: this.httpAgent, headers: { authorization: `Bearer ${this.info.token}`, 'content-type': 'application/json' }, signal }, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) response.destroy(new Error('Controller response too large')); });
        response.on('error', reject);
        response.on('end', () => { try { const value = JSON.parse(body); if (value.error) reject(new Error(value.error)); else resolve(value.result); } catch (error) { reject(error); } });
      });
      request.setTimeout(55000, () => request.destroy(new Error('Controller request timed out; inspect operation receipts before retrying mutations.')));
      request.on('error', reject); request.end(JSON.stringify({ parentId: this.parentId, method, values }));
    });
  }
  models(provider, options = {}) { return this.call('models', { provider, ...options }); }
  spawn(values) { return this.call('spawn', values); }
  list(includeSaved) { return this.call('list', { includeSaved }); }
  read(agentId, afterSequence = 0, limit = 50) { return this.call('read', { agentId, afterSequence, limit }); }
  transcript(agentId) { return this.call('transcript', { agentId }); }
  send(agentId, message, mode, messageId) { return this.call('send', { agentId, message, mode, messageId }); }
  reply(questionId, message) { return this.call('reply', { questionId, message }); }
  wait(agentIds, after, timeoutMs, signal) { return this.call('wait', { agentIds, after, timeoutMs }, signal); }
  setModel(agentId, options) { return this.call('setModel', { agentId, ...options }); }
  interrupt(agentId) { return this.call('interrupt', { agentId }); }
  closeAgent(agentId) { return this.call('closeAgent', { agentId }); }
  resume(agentId, options = {}) { return this.call('resume', { agentId, ...options }); }
  rebindParent(parent) { return this.call('attach', { pid: process.pid, parent }); }
  health() { return this.call('health', {}); }
  readMessages(values) { return this.call('readMessages', values); }
  ackMessages(agentId, messageIds) { return this.call('ackMessages', { agentId, messageIds }); }
  updatePolicy(values) { return this.call('updatePolicy', values); }
  adoptTask(taskId) { return this.call('adoptTask', { taskId }); }
  async bindSession(parent, agentIds) {
    try { return await this.call('bindSession', { parent, agentIds }); }
    catch (error) {
      if (error.message !== 'Unsupported controller method') throw error;
      await this.rebindParent(parent);
      return { identity: parent, boundAgents: [], legacyController: true };
    }
  }
  async watch() {
    const after = {};
    while (!this.closed) {
      let pauseMs = 0;
      const started = Date.now();
      try {
        this.watchAbort = new AbortController();
        const value = await this.call('poll', { after, timeoutMs: 20000 }, this.watchAbort.signal);
        for (const event of value.events) { after[event.agentId] = event.sequence; this.emit('event', event); }
        if (!value.events.length && Date.now() - started < 40) pauseMs = 500;
      } catch (error) {
        if (!this.closed) { this.emit('controller_error', error); pauseMs = 500; }
      }
      if (!this.closed && pauseMs > 0) await new Promise(resolve => { this.watchTimer = setTimeout(resolve, pauseMs); this.watchResolve = resolve; });
    }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.watchAbort?.abort(); clearTimeout(this.watchTimer); this.watchResolve?.();
    try { await this.call('detach'); } finally { this.httpAgent.destroy(); }
  }
}

async function probe(root, piAgentDir) {
  const info = readJsonSafe(path.join(root, 'controller.json'));
  if (!info?.socket) return null;
  let health;
  const probeClient = new ControllerClient(root, info);
  try { health = await probeClient.health(); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code) || error?.name === 'AbortError' || /timed out|Unauthorized/i.test(error?.message || '')) {
      return null;
    }
    throw error;
  } finally { probeClient.httpAgent.destroy(); }
  const expectedAgentDir = piAgentDir || process.env.PI_CODING_AGENT_DIR || '';
  const stalePath = health?.scriptPath && !fs.existsSync(health.scriptPath);
  const wrongAgentDir = health?.piAgentDir !== undefined && health.piAgentDir !== expectedAgentDir;
  if ((stalePath || wrongAgentDir) && (health.activeAgents ?? 0) === 0 && (health.totalAgents ?? 0) === 0) {
    try { process.kill(info.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 30 && processAlive(info.pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
    return null;
  }
  return info;
}
export async function connectController({ root, executable = 'pi', maxAgents = defaultMaxAgents, piAgentDir }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let info = await probe(root, piAgentDir);
  if (!info) {
    const log = fs.openSync(path.join(root, 'controller.log'), 'a', 0o600);
    const env = { ...process.env, PI_SERVER_STATE_DIR: root, PI_EXECUTABLE: executable, PI_SERVER_MAX_AGENTS: String(maxAgents) };
    if (piAgentDir) env.PI_CODING_AGENT_DIR = piAgentDir;
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', log, log], env });
    fs.closeSync(log); child.unref(); let failure; child.on('error', error => { failure = error; });
    for (let index = 0; index < 50; index++) {
      info = await probe(root); if (info) break;
      if (failure) throw failure;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!info) throw new Error('Independent Pi controller failed to start; inspect controller.log.');
  }
  const client = new ControllerClient(root, info);
  await client.call('attach', { pid: process.pid, parent: parentIdentity() }); return client;
}
