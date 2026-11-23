import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createServer } from '../src/server.js';
import { Callbacks } from '../src/callbacks.js';
import { setup, processFactory } from './helpers/setup.js';

async function connect(t, clientName) {
  const { cwd, manager: helper, track } = await setup(t);
  const { server, manager } = await createServer({ root: helper.storage.root + '-mcp', processFactory });
  track(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { cwd, client, manager };
}
const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) });

test('Claude Code parent receives one channel callback when a child settles', async t => {
  const { cwd, client } = await connect(t, 'claude-code');
  assert.ok(client.getServerCapabilities().experimental['claude/channel']);
  const received = [];
  const settled = new Promise(resolve => client.setNotificationHandler(channel, notification => { received.push(notification.params); if (notification.params.meta.event === 'settled') resolve(); }));
  const spawn = await client.callTool({ name: 'spawn_agent', arguments: { cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' } });
  const agent = spawn.structuredContent.result;
  assert.equal(agent.callback.routes.claudeChannel, true);
  await settled;
  assert.equal(received.filter(value => value.meta.event === 'settled').length, 1);
  assert.match(received.at(-1).content, /status=completed/);
  assert.match(received.at(-1).content, new RegExp(`wait_agent\\(agentIds=\\["${agent.id}"\\]`));
});

test('Codex callback queues into the configured thread and history never replays', async t => {
  const { manager, cwd } = await setup(t);
  const calls = [];
  const callbacks = new Callbacks({ root: manager.storage.root, server: { getClientVersion: () => ({ name: 'codex-mcp-client' }) }, codexExecutable: '/bin/codex', run: (file, args, options, done) => { calls.push([file, args]); done(null); } });
  const thread = '01a11e9e-9d1f-7a23-b2a5-ddf634f08fc5', agentId = '00000000-0000-4000-8000-000000000001';
  const config = callbacks.configure(agentId, { codexThreadId: thread }, 5);
  assert.deepEqual(config.routes, { claudeChannel: false, codexQueue: true });
  await callbacks.handle({ agentId, sequence: 4, type: 'settled', status: 'completed' });
  await callbacks.handle({ agentId, sequence: 6, type: 'tool_execution_end' });
  await callbacks.handle({ agentId, sequence: 7, type: 'question', questionId: 'q1', question: 'Which table?' });
  await callbacks.handle({ agentId, sequence: 7, type: 'question', questionId: 'q1', question: 'Which table?' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 4), ['queue', '--thread', thread, '--message']);
  assert.match(calls[0][1][4], /Which table\?[\s\S]*reply_question\(questionId="q1"\)/);
  assert.deepEqual(callbacks.get(agentId).lastDelivery.results, { codexQueue: 'queued' });
  callbacks.configure(agentId, { enabled: false });
  await callbacks.handle({ agentId, sequence: 9, type: 'settled', status: 'completed' });
  assert.equal(calls.length, 1);
});

test('get_agent_changes reports worktree files and diff against the base commit', async t => {
  const { cwd, client } = await connect(t, 'codex-mcp-client');
  const repo = path.join(cwd, 'repo'); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.txt'), 'one\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']]) execFileSync('git', ['-C', repo, ...args]);
  const spawn = await client.callTool({ name: 'spawn_agent', arguments: { cwd: repo, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], callback: { enabled: false } } });
  const agent = spawn.structuredContent.result;
  assert.equal(agent.workspace.mode, 'worktree');
  fs.writeFileSync(path.join(agent.workspace.cwd, 'src/a.txt'), 'two\n');
  fs.writeFileSync(path.join(agent.workspace.cwd, 'src/b.txt'), 'new\n');
  const changes = (await client.callTool({ name: 'get_agent_changes', arguments: { agentId: agent.id } })).structuredContent.result;
  assert.deepEqual(changes.status.sort(), [' M src/a.txt', '?? src/b.txt']);
  assert.match(changes.diff, /-one\n\+two/);
  assert.equal(changes.diffTruncated, false);
});

test('wait-events command wakes a background parent with the next settled event', async t => {
  const { manager, cwd } = await setup(t);
  const { spawn: start, settled } = await import('./helpers/setup.js');
  const agent = await start(manager, cwd); await settled(manager, agent.id);
  const script = fileURLToPath(new URL('../scripts/wait-events.js', import.meta.url));
  const output = execFileSync(process.execPath, [script, '--agent', agent.id, '--after', `${agent.id}=0`, '--timeout', '5'], { encoding: 'utf8', env: { ...process.env, PI_SERVER_STATE_DIR: manager.storage.root } });
  assert.match(output, /event=settled[\s\S]*status=completed/);
  assert.throws(() => execFileSync(process.execPath, [script, '--agent', agent.id, '--timeout', '1'], { env: { ...process.env, PI_SERVER_STATE_DIR: manager.storage.root } }), error => error.status === 2);
});
