import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { Callbacks, scanAgentEvents, readCallbackRecord } from '../src/callbacks.js';
import { parentIdentity } from '../src/controller-client.js';
import { spawnReminder, waitReminder } from '../src/wait-reminder.js';
import { setup, spawn, settled, processFactory } from './helpers/setup.js';

const waitScript = fileURLToPath(new URL('../scripts/wait-events.js', import.meta.url));
const hookScript = fileURLToPath(new URL('../scripts/antigravity-hook.js', import.meta.url));
const installScript = fileURLToPath(new URL('../scripts/install.js', import.meta.url));

function runHook(input, stateDir, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [hookScript], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PI_SERVER_STATE_DIR: stateDir, PI_HOOK_STOP_WAIT_MS: '120', ...extraEnv },
  });
  return JSON.parse(stdout);
}

test('parentIdentity recognizes Antigravity environment and client name', () => {
  const fromEnv = parentIdentity({ ANTIGRAVITY_CONVERSATION_ID: 'conv-123', ANTIGRAVITY_TRAJECTORY_ID: 'traj-9', ANTIGRAVITY_PROJECT_ID: 'proj-1' }, 'antigravity');
  assert.equal(fromEnv.kind, 'antigravity');
  assert.equal(fromEnv.sessionId, 'conv-123');
  assert.equal(fromEnv.hostSessionId, 'traj-9');
  assert.equal(fromEnv.projectId, 'proj-1');
  const fromName = parentIdentity({}, 'Antigravity');
  assert.equal(fromName.kind, 'antigravity');
  const fromAgent = parentIdentity({ ANTIGRAVITY_AGENT: '1' }, '');
  assert.equal(fromAgent.kind, 'antigravity');
});

test('MCP tools support Antigravity session binding, filtering, wait reminders and health check', async t => {
  const { cwd, manager: helper, track } = await setup(t);
  const { server, manager } = await createServer({ root: `${helper.storage.root}-agy`, executable: process.execPath, processFactory });
  track(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'antigravity-client', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const health = (await client.callTool({ name: 'get_subagent_health', arguments: {} })).structuredContent.result;
  assert.equal(health.ok, true);
  assert.equal(health.host, 'antigravity');
  assert.equal(health.pi.ok, true);
  assert.equal(health.controller.ok, true);
  assert.ok(health.modelsCount >= 1);

  const s1 = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared', antigravitySessionId: 'conv-alpha' },
  })).structuredContent.result;
  assert.equal(s1.parentInfo.kind, 'antigravity');
  assert.equal(s1.parentInfo.sessionId, 'conv-alpha');
  assert.equal(s1.callback.routes.antigravityHook, true);
  assert.match(s1.mustWait.antigravityBackgroundCommand, /--session conv-alpha/);

  const s2 = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['docs'], workspaceMode: 'shared' },
  })).structuredContent.result;

  const onlyAlpha = (await client.callTool({ name: 'list_agents', arguments: { sessionId: 'conv-alpha' } })).structuredContent.result;
  assert.deepEqual(onlyAlpha.agents.map(a => a.id), [s1.id]);

  const bound = (await client.callTool({
    name: 'bind_session',
    arguments: { sessionId: 'conv-beta', kind: 'antigravity', agentIds: [s2.id] },
  })).structuredContent.result;
  assert.deepEqual(bound.boundAgents, [s2.id]);
  assert.match(bound.waitEventsCommand, /--session conv-beta/);

  const onlyBeta = (await client.callTool({ name: 'list_agents', arguments: { sessionId: 'conv-beta' } })).structuredContent.result;
  assert.deepEqual(onlyBeta.agents.map(a => a.id), [s2.id]);

  const waited = (await client.callTool({
    name: 'wait_agent',
    arguments: { agentIds: [s1.id], timeoutMs: 3000 },
  })).structuredContent.result;
  assert.ok(waited.results.some(r => r.agent.id === s1.id));

  const reminderNote = spawnReminder(s1.id, { sessionId: 'conv-alpha' });
  assert.match(reminderNote.antigravity, /--session conv-alpha/);
  const waitNote = waitReminder({ reason: 'timeout', results: [{ agent: { id: s1.id, status: 'running' }, nextSequence: 2 }] }, { sessionId: 'conv-alpha' });
  assert.match(waitNote.antigravityBackgroundCommand, /--session conv-alpha/);
});

test('wait-events --session wakes on event, advances cursor and cleans watcher heartbeat', async t => {
  const { manager, cwd } = await setup(t);
  const agent = await spawn(manager, cwd, 'ASK', { parentInfo: { kind: 'antigravity', sessionId: 'conv-watch' } });
  const cb = new Callbacks({ root: manager.storage.root, server: { getClientVersion: () => ({ name: 'antigravity' }) } });
  cb.configure(agent.id, { antigravitySessionId: 'conv-watch' }, 0);

  const child = spawnChild(process.execPath, [waitScript, '--session', 'conv-watch', '--events', 'settled', '--timeout', '5'], {
    env: { ...process.env, PI_SERVER_STATE_DIR: manager.storage.root },
    encoding: 'utf8',
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });

  const watchersDir = path.join(manager.storage.root, 'watchers');
  let sawWatcher = false;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(watchersDir) && fs.readdirSync(watchersDir).some(name => name.endsWith('.json'))) {
      sawWatcher = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(sawWatcher, true);

  for (let i = 0; i < 40; i++) {
    if (manager.read(agent.id).agent.status === 'waiting') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const qId = manager.read(agent.id).agent.questionIds[0];
  manager.channel.reply(qId, 'proceed');

  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /event=settled/);
  assert.equal(cb.get(agent.id).antigravityDeliveredSeq > 0, true);
  assert.deepEqual(fs.readdirSync(watchersDir).filter(name => name.endsWith('.json')), []);
});

test('antigravity-hook handles fast-path, idempotent PreInvocation and Stop watcher gating', async t => {
  const { manager, cwd } = await setup(t);
  const root = manager.storage.root;
  assert.deepEqual(runHook({ hookEventName: 'PreInvocation', conversationId: 'conv-none' }, root), {});
  assert.deepEqual(runHook({ hookEventName: 'Stop', conversationId: 'conv-none' }, root), { decision: 'allow' });

  const aDone = await spawn(manager, cwd, 'done', { parentInfo: { kind: 'antigravity', sessionId: 'conv-hooks' } });
  await settled(manager, aDone.id);
  const firstPre = runHook({ hookEventName: 'PreInvocation', conversationId: 'conv-hooks' }, root);
  assert.equal(firstPre.injectSteps.length, 1);
  assert.match(firstPre.injectSteps[0].systemMessage.systemMessage, /event=settled/);
  const secondPre = runHook({ hookEventName: 'PreInvocation', conversationId: 'conv-hooks' }, root);
  assert.deepEqual(secondPre, {});

  const aAsk = await spawn(manager, cwd, 'ASK', { ownedPaths: ['docs'], parentInfo: { kind: 'antigravity', sessionId: 'conv-stop' } });
  for (let i = 0; i < 40; i++) {
    if (manager.read(aAsk.id).agent.status === 'waiting') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(manager.read(aAsk.id).agent.status, 'waiting');

  const askPre = runHook({ hookEventName: 'PreInvocation', conversationId: 'conv-stop' }, root);
  assert.match(askPre.injectSteps[0].systemMessage.systemMessage, /event=question/);

  const stopBlocked = runHook({ hookEventName: 'Stop', conversationId: 'conv-stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, root);
  assert.equal(stopBlocked.decision, 'continue');
  assert.match(stopBlocked.reason, /wait-events\.js"? --session conv-stop/);

  assert.deepEqual(runHook({ hookEventName: 'Stop', conversationId: 'conv-stop', continuationActive: true }, root), { decision: 'allow' });
  assert.deepEqual(runHook({ hookEventName: 'Stop', conversationId: 'conv-stop', terminationReason: 'USER_CANCELED' }, root), { decision: 'allow' });

  const watchersDir = path.join(root, 'watchers');
  fs.mkdirSync(watchersDir, { recursive: true });
  fs.writeFileSync(path.join(watchersDir, 'conv-stop-live.json'), JSON.stringify({ pid: process.pid, sessionId: 'conv-stop', agentIds: [] }));
  assert.deepEqual(runHook({ hookEventName: 'Stop', conversationId: 'conv-stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, root), { decision: 'allow' });

  const qId = manager.read(aAsk.id).agent.questionIds[0];
  manager.channel.reply(qId, 'proceed');
  await settled(manager, aAsk.id);
});

test('opt-in antigravityCliResume triggers agy CLI once per sequence', async t => {
  const { manager } = await setup(t);
  const calls = [];
  const callbacks = new Callbacks({
    root: manager.storage.root,
    server: { getClientVersion: () => ({ name: 'antigravity' }) },
    agyExecutable: '/usr/local/bin/agy',
    run: (file, args, options, done) => { calls.push([file, args]); done(null); },
  });
  const agentId = '00000000-0000-4000-8000-000000000099';
  const cfg = callbacks.configure(agentId, { antigravitySessionId: 'conv-cli', antigravityCliResume: true }, 0);
  assert.equal(cfg.routes.antigravityCli, true);
  await callbacks.handle({ agentId, sequence: 1, type: 'settled', status: 'completed', text: 'all good' });
  await callbacks.handle({ agentId, sequence: 1, type: 'settled', status: 'completed', text: 'all good' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/local/bin/agy');
  assert.deepEqual(calls[0][1].slice(0, 5), ['--conversation', 'conv-cli', '--mode', 'auto', '-p']);
  assert.equal(callbacks.get(agentId).antigravityDeliveredSeq, 1);
});

test('install.js builds and removes Antigravity plugin bundle cleanly', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-install-agy-'));
  const pluginsDir = path.join(tmp, 'plugins');
  const backupDir = path.join(tmp, 'backups');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const env = { ...process.env, PI_ANTIGRAVITY_PLUGINS_DIR: pluginsDir, PI_CONFIG_BACKUP_DIR: backupDir, PI_EXECUTABLE: process.execPath };
  execFileSync(process.execPath, [installScript, '--target=antigravity'], { env, encoding: 'utf8' });

  const pluginRoot = path.join(pluginsDir, 'pi-server');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp_config.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  assert.equal(manifest.name, 'pi-server');
  assert.equal(manifest.displayName, 'Pi Server');
  assert.ok(mcp.mcpServers['pi-server'].args[0].endsWith(path.join('src', 'server.js')));
  assert.equal(hooks['pi-server-callbacks'].PreInvocation.length, 1);
  assert.equal(hooks['pi-server-callbacks'].Stop.length, 1);
  assert.ok(fs.existsSync(path.join(pluginRoot, 'rules/AGENTS.md')));
  assert.ok(fs.existsSync(path.join(pluginRoot, 'skills/pi-server/SKILL.md')));
  assert.ok(fs.existsSync(path.join(pluginRoot, 'assets/logo.svg')));

  execFileSync(process.execPath, [installScript, '--target=antigravity', '--remove'], { env, encoding: 'utf8' });
  assert.equal(fs.existsSync(pluginRoot), false);
  assert.ok(fs.readdirSync(backupDir).some(name => name.startsWith('antigravity-')));
});

test('scanAgentEvents drains >100 non-matching events and advances cursor without dropping trailing events', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd, 'done');
  await settled(manager, a.id);
  const owned = manager.get(a.id);
  const startSeq = owned.record.sequence;
  for (let i = 0; i < 125; i++) {
    manager.event(owned, 'tool_execution_start', { toolCallId: `tc-${i}`, toolName: 'read' });
  }
  const onlyProgress = scanAgentEvents(manager.storage, a.id, {
    afterSequence: startSeq,
    eventTypes: ['settled', 'question'],
    source: 'test-progress',
    sessionId: 'conv-drain',
  });
  assert.equal(onlyProgress.matched.length, 0);
  assert.equal(onlyProgress.cursor, startSeq + 125);
  assert.equal(readCallbackRecord(manager.storage.root, a.id).antigravityDeliveredSeq, startSeq + 125);

  manager.event(owned, 'question', { questionId: 'q-tail', question: 'Ready?' });
  const subsetOnly = scanAgentEvents(manager.storage, a.id, {
    afterSequence: onlyProgress.cursor,
    eventTypes: ['settled'],
    source: 'test-subset',
    sessionId: 'conv-drain',
  });
  assert.equal(subsetOnly.matched.length, 0);
  assert.equal(subsetOnly.cursor, startSeq + 126);
  assert.equal(readCallbackRecord(manager.storage.root, a.id).antigravityDeliveredSeq, startSeq + 125);

  const hit = scanAgentEvents(manager.storage, a.id, {
    afterSequence: readCallbackRecord(manager.storage.root, a.id).antigravityDeliveredSeq,
    eventTypes: ['settled', 'question'],
    source: 'test-drain',
    sessionId: 'conv-drain',
  });
  assert.equal(hit.matched.length, 1);
  assert.equal(hit.matched[0].questionId, 'q-tail');
  assert.equal(hit.cursor, startSeq + 126);
  assert.equal(readCallbackRecord(manager.storage.root, a.id).antigravityDeliveredSeq, startSeq + 126);
});

test('bind_session with empty agentIds binds nothing and read_agent advances cursor while reply_question does not', async t => {
  const { cwd, manager: helper, track } = await setup(t);
  const { server, manager } = await createServer({ root: `${helper.storage.root}-cursor`, executable: process.execPath, processFactory });
  track(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'antigravity-client', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const s1 = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' },
  })).structuredContent.result;
  const emptyBind = (await client.callTool({
    name: 'bind_session',
    arguments: { sessionId: 'conv-empty', kind: 'antigravity', agentIds: [] },
  })).structuredContent.result;
  assert.deepEqual(emptyBind.boundAgents, []);
  const noneInEmpty = (await client.callTool({ name: 'list_agents', arguments: { sessionId: 'conv-empty' } })).structuredContent.result;
  assert.deepEqual(noneInEmpty.agents, []);

  const ask = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'ASK', provider: 'fake', model: 'cheap', ownedPaths: ['docs'], workspaceMode: 'shared', antigravitySessionId: 'conv-cur' },
  })).structuredContent.result;
  let questionId;
  for (let i = 0; i < 40; i++) {
    const cur = manager.read(ask.id).agent;
    if (cur.status === 'waiting' && cur.questionIds?.length) {
      questionId = cur.questionIds[0];
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(questionId);

  const beforeReplySeq = readCallbackRecord(manager.storage.root, ask.id)?.antigravityDeliveredSeq || 0;
  await client.callTool({ name: 'reply_question', arguments: { questionId, message: 'proceed' } });
  const afterReplyCb = readCallbackRecord(manager.storage.root, ask.id);
  assert.notEqual(afterReplyCb?.lastObservedBy, 'reply_question');
  assert.equal(afterReplyCb?.antigravityDeliveredSeq || 0, beforeReplySeq);

  await settled(manager, ask.id);
  const readRes = (await client.callTool({
    name: 'read_agent',
    arguments: { agentId: ask.id, afterSequence: 0 },
  })).structuredContent.result;
  const afterReadCb = readCallbackRecord(manager.storage.root, ask.id);
  assert.equal(afterReadCb.lastObservedBy, 'read_agent');
  assert.ok(afterReadCb.antigravityDeliveredSeq >= readRes.nextSequence);
  assert.ok(s1.id);
});
