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
import { Callbacks, readCallbackRecord, deliveredCursorOf } from '../src/callbacks.js';
import { parentIdentity } from '../src/controller-client.js';
import { DashboardData } from '../src/dashboard-data.js';
import { spawnReminder, waitReminder } from '../src/wait-reminder.js';
import { parseJsonc, removeJsoncMcpServer, inspectOpencodeConfig } from '../src/opencode-config.js';
import { fileOperation } from '../src/tool-sandbox.js';
import { setup, spawn, settled, processFactory } from './helpers/setup.js';

const waitScript = fileURLToPath(new URL('../scripts/wait-events.js', import.meta.url));
const installScript = fileURLToPath(new URL('../scripts/install.js', import.meta.url));

test('parentIdentity recognizes OpenCode environment and client name without leaking inherited host env', () => {
  const fromEnv = parentIdentity({ OPENCODE_SESSION_ID: 'ses_alpha123' }, '');
  assert.equal(fromEnv.kind, 'opencode');
  assert.equal(fromEnv.sessionId, 'ses_alpha123');
  const fromHostFlag = parentIdentity({ PI_SUBAGENTS_HOST: 'opencode', ANTIGRAVITY_CONVERSATION_ID: 'conv-leaked' }, '');
  assert.equal(fromHostFlag.kind, 'opencode');
  assert.equal(fromHostFlag.sessionId, undefined);
  const fromClientName = parentIdentity({ ANTIGRAVITY_CONVERSATION_ID: 'conv-leaked', ANTIGRAVITY_PROJECT_ID: 'proj-leaked' }, 'opencode');
  assert.equal(fromClientName.kind, 'opencode');
  assert.equal(fromClientName.sessionId, undefined);
  assert.equal(fromClientName.projectId, undefined);
});

test('MCP tools support OpenCode host detection, session binding, filtering, wait reminders and health check', async t => {
  const { cwd, manager: helper, track } = await setup(t);
  const ocCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oc-health-'));
  t.after(() => fs.rmSync(ocCfgDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ocCfgDir, 'opencode.jsonc'), '// comment\n{"mcp":{"servers":{"pi-subagents":{"type":"local","command":["node","server.js"]}}}}\n');
  fs.mkdirSync(path.join(ocCfgDir, 'skills/pi-subagents'), { recursive: true });
  fs.writeFileSync(path.join(ocCfgDir, 'skills/pi-subagents/SKILL.md'), '# skill\n');

  const prevCfgDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = ocCfgDir;
  t.after(() => {
    if (prevCfgDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevCfgDir;
  });

  const { server, manager } = await createServer({ root: `${helper.storage.root}-oc`, executable: process.execPath, processFactory });
  track(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'opencode', version: '2.3.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const health = (await client.callTool({ name: 'get_subagent_health', arguments: {} })).structuredContent.result;
  assert.equal(health.ok, true);
  assert.equal(health.host, 'opencode');
  assert.equal(health.opencodeMcpConfigured, true);
  assert.equal(health.opencodeSkillInstalled, true);

  const caps = (await client.callTool({ name: 'get_client_capabilities', arguments: {} })).structuredContent.result;
  assert.equal(caps.client.name, 'opencode');
  assert.match(caps.callbacks.opencode, /opencodeSessionId/);

  const listedTools = await client.listTools();
  const spawnTool = listedTools.tools.find(tool => tool.name === 'spawn_agent');
  assert.equal(spawnTool.inputSchema.properties.opencodeSessionId.type, 'string');
  assert.equal(spawnTool.inputSchema.properties.parentSession.properties.sessionId.type, 'string');

  const s1 = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared', opencodeSessionId: 'ses_alpha' },
  })).structuredContent.result;
  assert.equal(s1.parentInfo.kind, 'opencode');
  assert.equal(s1.parentInfo.sessionId, 'ses_alpha');
  assert.equal(s1.callback.host, 'opencode');
  assert.equal(s1.callback.opencodeSessionId, 'ses_alpha');
  assert.equal(s1.callback.routes.opencodeSession, true);
  assert.equal(s1.callback.routes.opencodeCli, false);
  assert.match(s1.callback.routes.opencodeWaitCommand, /--session ses_alpha/);
  assert.match(s1.mustWait.opencodeBackgroundCommand, /--session ses_alpha/);

  const s2 = (await client.callTool({
    name: 'spawn_agent',
    arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['docs'], workspaceMode: 'shared' },
  })).structuredContent.result;

  const onlyAlpha = (await client.callTool({ name: 'list_agents', arguments: { sessionId: 'ses_alpha' } })).structuredContent.result;
  assert.deepEqual(onlyAlpha.agents.map(a => a.id), [s1.id]);

  const bound = (await client.callTool({
    name: 'bind_session',
    arguments: { sessionId: 'ses_beta', agentIds: [s2.id] },
  })).structuredContent.result;
  assert.equal(bound.identity.kind, 'opencode');
  assert.deepEqual(bound.boundAgents, [s2.id]);
  assert.match(bound.waitEventsCommand, /--session ses_beta/);

  const onlyBeta = (await client.callTool({ name: 'list_agents', arguments: { sessionId: 'ses_beta' } })).structuredContent.result;
  assert.deepEqual(onlyBeta.agents.map(a => a.id), [s2.id]);

  const waited = (await client.callTool({
    name: 'wait_agent',
    arguments: { agentIds: [s1.id], timeoutMs: 3000 },
  })).structuredContent.result;
  assert.ok(waited.results.some(r => r.agent.id === s1.id));
  const cbAfterWait = readCallbackRecord(manager.storage.root, s1.id);
  assert.ok(deliveredCursorOf(cbAfterWait) >= waited.results[0].nextSequence);

  const reminderNote = spawnReminder(s1.id, { sessionId: 'ses_alpha' });
  assert.match(reminderNote.opencode, /--session ses_alpha/);
  const waitNote = waitReminder({ reason: 'timeout', results: [{ agent: { id: s1.id, status: 'running' }, nextSequence: 2 }] }, { sessionId: 'ses_alpha' });
  assert.match(waitNote.opencodeBackgroundCommand, /--session ses_alpha/);
});

test('wait-events --session wakes on OpenCode session event, advances unified cursor and updates DashboardData', async t => {
  const { manager, cwd } = await setup(t);
  const agent = await spawn(manager, cwd, 'ASK', { parentInfo: { kind: 'opencode', sessionId: 'ses_watch_1' } });
  const cb = new Callbacks({ root: manager.storage.root, server: { getClientVersion: () => ({ name: 'opencode', version: '2.3.0' }) } });
  cb.configure(agent.id, { opencodeSessionId: 'ses_watch_1' }, 0);

  const child = spawnChild(process.execPath, [waitScript, '--session', 'ses_watch_1', '--events', 'settled', '--timeout', '5'], {
    env: { ...process.env, PI_SUBAGENTS_STATE_DIR: manager.storage.root },
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

  const dash = new DashboardData(manager.storage.root);
  const snapDuring = dash.snapshot(agent.id);
  assert.equal(snapDuring.parentInfo.kind, 'opencode');
  assert.equal(snapDuring.callback.opencodeSessionId, 'ses_watch_1');
  assert.equal(snapDuring.watcherActive, true);

  const question = await manager.wait([agent.id], {}, 2000);
  const qEvent = question.results[0].events.find(e => e.type === 'question');
  assert.ok(qEvent);
  await manager.channel.reply(qEvent.questionId, 'proceed');
  await settled(manager, agent.id);

  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  assert.match(output, /event=settled/);
  const updated = readCallbackRecord(manager.storage.root, agent.id);
  assert.ok(deliveredCursorOf(updated) >= 2);
  assert.equal(updated.deliveredSeq, updated.antigravityDeliveredSeq);
  assert.equal(dash.snapshot(agent.id).watcherActive, false);
});

test('opt-in opencodeCliWake invokes opencode run --session detached once per sequence without blocking', async t => {
  const { manager } = await setup(t);
  const calls = [];
  let unreffed = false;
  const cb = new Callbacks({
    root: manager.storage.root,
    server: { getClientVersion: () => ({ name: 'opencode', version: '2.3.0' }) },
    opencodeExecutable: '/usr/local/bin/opencode',
    spawnDetached: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      const handlers = {};
      queueMicrotask(() => handlers.spawn?.());
      return {
        once(ev, fn) { handlers[ev] = fn; return this; },
        unref() { unreffed = true; },
      };
    },
  });
  const agentId = '22222222-2222-4222-8222-222222222222';
  const cfg = cb.configure(agentId, { opencodeSessionId: 'ses_cli_wake', opencodeCliWake: true }, 1);
  assert.equal(cfg.routes.opencodeCli, true);

  await cb.handle({ agentId, type: 'settled', sequence: 2, status: 'completed', text: 'all done' });
  await cb.handle({ agentId, type: 'settled', sequence: 2, status: 'completed', text: 'duplicate' });
  assert.equal(calls.length, 1);
  assert.equal(unreffed, true);
  assert.equal(calls[0].exe, '/usr/local/bin/opencode');
  assert.equal(calls[0].opts.detached, true);
  assert.deepEqual(calls[0].args.slice(0, 3), ['run', '--session', 'ses_cli_wake']);
  assert.match(calls[0].args[3], /all done/);
  const saved = readCallbackRecord(manager.storage.root, agentId);
  assert.equal(saved.deliveredSeq, 2);
  assert.equal(saved.lastDelivery.results.opencodeCli, 'woken');
});

test('removeJsoncMcpServer preserves comments and unrelated servers across first, middle and last positions', () => {
  const sample = `{
  // Top comment
  "mcp": {
    "servers": {
      // Keep alpha
      "alpha": { "type": "local", "command": ["echo", "a"] },
      "pi-subagents": {
        "type": "local",
        "command": ["node", "src/server.js"],
        "environment": { "PI_SUBAGENTS_HOST": "opencode" }
      },
      /* Keep omega */
      "omega": { "type": "remote", "url": "https://example.com" }
    }
  }
}
`;
  const mid = removeJsoncMcpServer(sample, 'pi-subagents');
  assert.equal(mid.changed, true);
  assert.match(mid.content, /\/\/ Top comment/);
  assert.match(mid.content, /\/\/ Keep alpha/);
  assert.match(mid.content, /\/\* Keep omega \*\//);
  const parsedMid = parseJsonc(mid.content);
  assert.deepEqual(Object.keys(parsedMid.mcp.servers), ['alpha', 'omega']);

  const lastRemoved = removeJsoncMcpServer(mid.content, 'omega');
  assert.equal(lastRemoved.changed, true);
  assert.deepEqual(Object.keys(parseJsonc(lastRemoved.content).mcp.servers), ['alpha']);

  const noop = removeJsoncMcpServer(lastRemoved.content, 'missing');
  assert.equal(noop.changed, false);
});

test('install.js installs and uninstalls OpenCode MCP entry and skill with 0600 backup while preserving comments', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oc-install-'));
  const cfgDir = path.join(tmp, 'opencode');
  const backupDir = path.join(tmp, 'backups');
  const fakePi = path.join(tmp, 'pi');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(fakePi, '#!/bin/sh\necho "pi 1.0.2"\n', { mode: 0o755 });
  const cfgFile = path.join(cfgDir, 'opencode.jsonc');
  fs.writeFileSync(cfgFile, '{\n  // User comment\n  "mcp": {\n    "servers": {\n      "existing": { "type": "local", "command": ["echo", "keep"] }\n    }\n  }\n}\n');

  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: cfgDir,
    PI_CONFIG_BACKUP_DIR: backupDir,
    PI_EXECUTABLE: fakePi,
  };

  execFileSync(process.execPath, [installScript, '--target=opencode'], { env, encoding: 'utf8' });
  const inspected = inspectOpencodeConfig(env);
  assert.equal(inspected.mcpConfigured, true);
  assert.equal(inspected.skillInstalled, true);

  const afterInstallRaw = fs.readFileSync(cfgFile, 'utf8');
  assert.match(afterInstallRaw, /\/\/ User comment/);
  const afterInstall = parseJsonc(afterInstallRaw);
  assert.ok(afterInstall.mcp.servers.existing);
  assert.equal(afterInstall.mcp.servers['pi-subagents'].type, 'local');
  assert.equal(afterInstall.mcp.servers['pi-subagents'].environment.PI_SUBAGENTS_HOST, 'opencode');

  const backups = fs.readdirSync(backupDir).filter(name => name.startsWith('opencode-'));
  assert.ok(backups.length >= 1);
  assert.equal(fs.statSync(path.join(backupDir, backups[0])).mode & 0o777, 0o600);

  execFileSync(process.execPath, [installScript, '--target=opencode', '--remove'], { env, encoding: 'utf8' });
  const afterRemove = inspectOpencodeConfig(env);
  assert.equal(afterRemove.mcpConfigured, false);
  assert.equal(afterRemove.skillInstalled, false);
  const afterRemoveRaw = fs.readFileSync(cfgFile, 'utf8');
  assert.match(afterRemoveRaw, /\/\/ User comment/);
  assert.deepEqual(Object.keys(parseJsonc(afterRemoveRaw).mcp.servers), ['existing']);
});

test('tool-sandbox blocks OpenCode config and credential directories in strict and dev modes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oc-sandbox-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const dir of ['src', 'state', 'tmp']) fs.mkdirSync(path.join(cwd, dir));
  const home = os.homedir();
  for (const mode of ['strict', 'dev']) {
    const policy = { cwd, ownedPaths: ['src'], tempDir: path.join(cwd, 'tmp'), stateRoot: path.join(cwd, 'state'), allowNetwork: false, sandboxMode: mode };
    await assert.rejects(fileOperation(policy, 'read', path.join(home, '.config/opencode/opencode.jsonc')), /credentials|scope/);
    await assert.rejects(fileOperation(policy, 'read', path.join(home, '.local/share/opencode/auth.json')), /credentials|scope/);
  }
});
