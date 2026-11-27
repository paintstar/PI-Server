import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertToolPath, runSandboxed, sandboxProfile } from '../src/tool-sandbox.js';
import { buildBwrapArgs } from '../src/linux-sandbox.js';
import { agentChanges } from '../src/agent-changes.js';
import { defaultModelProfile } from '../src/model-profiles.js';
import { connectController } from '../src/controller-client.js';
import { startDashboard } from '../src/dashboard.js';
import { Manager } from '../src/manager.js';
import { fakePi, setup, spawn, settled } from './helpers/setup.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('privateHome blocks all 4 host credentials and bwrap masks regular files with /dev/null', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sec-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['work', 'state', 'tmp']) fs.mkdirSync(path.join(root, name));
  const policy = {
    cwd: path.join(root, 'work'),
    ownedPaths: ['.'],
    stateRoot: path.join(root, 'state'),
    tempDir: path.join(root, 'tmp'),
    allowNetwork: false,
    sandboxMode: 'dev',
  };
  const home = os.homedir();
  for (const secret of [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.gemini', 'config', 'plugins', 'pi-server', 'mcp_config.json'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.kube', 'config'),
    path.join(home, '.gnupg', 'secring.gpg'),
  ]) {
    assert.throws(() => assertToolPath(secret, policy, false), /private credentials/);
  }

  const existing = new Set([
    '/tmp', '/work/repo', '/work/state', '/work/tmp',
    '/home/dev/.claude', '/home/dev/.claude.json', '/home/dev/.gemini', '/home/dev/.pi',
  ]);
  const regularFiles = new Set(['/home/dev/.claude.json']);
  const deps = {
    existsSync: p => existing.has(p),
    lstatSync: p => ({ isSymbolicLink: () => false, isFile: () => regularFiles.has(p) }),
    readlinkSync: () => '',
    realpathSync: p => p,
    canonicalPath: p => path.resolve(p),
    mode: 'dev',
    privateDirectories: ['/home/dev/.claude', '/home/dev/.gemini', '/home/dev/.pi', '/home/dev/.claude.json'],
    privateFiles: ['/home/dev/.claude.json'],
    homedir: '/home/dev',
    tmpdir: '/tmp',
  };
  const args = buildBwrapArgs({ cwd: '/work/repo', ownedPaths: ['.'], stateRoot: '/work/state', tempDir: '/work/tmp', allowNetwork: false }, '/bin/bash', ['-c', 'true'], deps);
  const joined = args.join(' ');
  assert.ok(joined.includes('--ro-bind /dev/null /home/dev/.claude.json'));
  assert.ok(!joined.includes('--tmpfs /home/dev/.claude.json'));
  assert.ok(joined.includes('--perms 0000 --tmpfs /home/dev/.claude'));
  assert.ok(joined.includes('--perms 0000 --tmpfs /home/dev/.gemini'));

  if (process.platform === 'darwin') {
    const profile = sandboxProfile(policy);
    assert.ok(profile.includes('(literal ') && profile.includes('.claude.json'));
    assert.ok(profile.includes('.gemini'));
    assert.ok(profile.includes('.claude'));
  }
});

test('runSandboxed distinguishes normal exit, timeout and abort signal cleanly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-timeout-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['work', 'state', 'tmp']) fs.mkdirSync(path.join(root, name));
  const policy = {
    cwd: path.join(root, 'work'),
    ownedPaths: ['.'],
    stateRoot: path.join(root, 'state'),
    tempDir: path.join(root, 'tmp'),
    allowNetwork: false,
    sandboxMode: 'strict',
  };

  const ok = await runSandboxed(policy, '/bin/bash', ['-c', 'exit 0']);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.signal, null);

  const timed = await runSandboxed(policy, '/bin/bash', ['-c', 'sleep 5'], { timeout: 120 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, 137);
  assert.equal(timed.signal, 'SIGKILL');

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const aborted = await runSandboxed(policy, '/bin/bash', ['-c', 'sleep 5'], { signal: ac.signal, timeout: 5000 });
  assert.equal(aborted.timedOut, false);
  assert.equal(aborted.exitCode, 137);
  assert.equal(aborted.signal, 'SIGKILL');
});

test('Dashboard and Controller decode split multi-byte UTF-8 chunks without corruption and support large payloads', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd);
  await settled(manager, a.id);

  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'utf8-token' });
  t.after(() => dashboard.close());
  const port = dashboard.port;
  const title = '跨分片中文标题验证';
  const payloadBuf = Buffer.from(JSON.stringify({ title }), 'utf8');
  const splitAt = payloadBuf.indexOf(Buffer.from('中', 'utf8')) + 1;
  const metaResult = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/agents/${a.id}/meta`,
      method: 'POST',
      headers: {
        authorization: 'Bearer utf8-token',
        'x-pi-dashboard': '1',
        'content-type': 'application/json',
        'content-length': payloadBuf.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(payloadBuf.subarray(0, splitAt));
    setTimeout(() => req.end(payloadBuf.subarray(splitAt)), 15);
  });
  assert.equal(metaResult.title, title);
  assert.equal(metaResult.title.includes('\uFFFD'), false);

  const ctrlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ctrl-utf8-'));
  const ctrlRoot = path.join(ctrlDir, 'state');
  const executable = path.join(ctrlDir, 'fake-pi');
  fs.writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fakePi}' "$@"\n`, { mode: 0o700 });
  const client = await connectController({ root: ctrlRoot, executable });
  t.after(async () => {
    await client.close().catch(() => {});
    try { process.kill(client.info.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 40 && fs.existsSync(path.join(ctrlRoot, 'controller.lock')); i++) await pause(30);
    fs.rmSync(ctrlDir, { recursive: true, force: true });
  });

  const health = await client.health();
  assert.equal(typeof health.version, 'string');
  assert.ok(Array.isArray(health.capabilities) && health.capabilities.includes('utf8Body'));
  assert.equal(health.liveProcesses, 0);
  assert.equal(health.activeParents, 1);
  assert.equal(health.inflightOps, 0);

  const bigChinese = '中文上下文'.repeat(12000);
  assert.ok(Buffer.byteLength(bigChinese, 'utf8') > 150000);
  const bigSpawn = await client.spawn({
    cwd: ctrlDir,
    prompt: 'OK',
    context: bigChinese,
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
  });
  assert.ok(bigSpawn.id);
  const savedRec = JSON.parse(fs.readFileSync(path.join(ctrlRoot, bigSpawn.id, 'agent.json'), 'utf8'));
  assert.equal(savedRec.context.includes('\uFFFD'), false);
  assert.equal(savedRec.context.length, bigChinese.length);

  await assert.rejects(
    client.spawn({ cwd: ctrlDir, prompt: 'OK', context: 'x'.repeat(520000), provider: 'fake', model: 'cheap', ownedPaths: ['other'], workspaceMode: 'shared' }),
    /Request too large/,
  );

  await client.bindSession({ kind: 'opencode', sessionId: 'ses_keep_identity', cwd: ctrlDir });
  assert.equal(client.parentInfo.kind, 'opencode');
  assert.equal(client.parentInfo.sessionId, 'ses_keep_identity');
  await client.call('detach');
  const reattached = await client.call('attach', { pid: process.pid });
  assert.equal(reattached.identity.kind, 'opencode');
  assert.equal(reattached.identity.sessionId, 'ses_keep_identity');
});

test('agentChanges includes untracked text files, handles binary safely and respects maxBytes', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-changes-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/tracked.js'), 'export const a = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
    execFileSync('git', ['-C', repo, ...args]);
  }
  fs.writeFileSync(path.join(repo, 'src/tracked.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(repo, 'src/added.js'), 'export const b = 42;\nexport const c = "你好";\n');
  fs.writeFileSync(path.join(repo, 'src/bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  const fakeAgent = { workspace: { mode: 'shared', cwd: repo }, ownedPaths: ['src'] };
  const full = await agentChanges(fakeAgent, { includeDiff: true, includeUntracked: true, maxBytes: 20000 });
  assert.ok(full.untrackedFiles.includes('src/added.js'));
  assert.ok(full.untrackedFiles.includes('src/bin.dat'));
  assert.match(full.diff, /\+export const a = 2;/);
  assert.match(full.diff, /\+\+\+ b\/src\/added\.js[\s\S]*\+export const b = 42;/);
  assert.match(full.diff, /Binary file src\/bin\.dat/);
  assert.equal(full.diffTruncated, false);

  const trackedOnly = await agentChanges(fakeAgent, { includeDiff: true, includeUntracked: false, maxBytes: 20000 });
  assert.equal(trackedOnly.diff.includes('src/added.js'), false);

  const tiny = await agentChanges(fakeAgent, { includeDiff: true, includeUntracked: true, maxBytes: 120 });
  assert.equal(tiny.diffTruncated, true);
  assert.ok(tiny.diff.length <= 120);
});

test('Manager cleans failed spawn from memory, blocks late agent_settled after interrupt, and serves read() from memory window', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-hardening-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let failLaunch = true;
  const failingFactory = options => {
    if (options.args.includes('--no-session')) {
      return {
        command: async () => ({ models: [{ provider: 'fake', id: 'cheap', name: 'cheap', reasoning: true, contextWindow: 100000, maxTokens: 1000, input: ['text'] }] }),
        close: async () => {},
      };
    }
    if (failLaunch) throw new Error('simulated spawn failure');
    return null;
  };
  failingFactory.testOnly = true;
  const badMgr = await new Manager({ root: path.join(root, 'bad-state'), processFactory: failingFactory }).start();
  t.after(() => badMgr.close());
  await assert.rejects(
    badMgr.spawn({ cwd, prompt: 'hi', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' }),
    /simulated spawn failure/,
  );
  assert.equal(badMgr.agents.size, 0);
  assert.equal(badMgr.list(false).length, 0);
  assert.equal(badMgr.list(true).length, 1);
  assert.equal(badMgr.list(true)[0].status, 'failed');

  const { manager, cwd: okCwd } = await setup(t);
  const a = await manager.spawn({ cwd: okCwd, prompt: 'HANG', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' });
  await pause(40);
  await manager.interrupt(a.id);
  const liveAgent = manager.get(a.id);
  assert.equal(liveAgent.record.status, 'interrupted');
  assert.equal(liveAgent.interrupting, false);
  liveAgent.record.stopReason = 'stop';
  manager.onPiEvent(liveAgent, { type: 'agent_settled' });
  await liveAgent.control;
  assert.equal(liveAgent.record.status, 'interrupted');

  await manager.send(a.id, 'recover-now', 'steer');
  const afterSecond = await settled(manager, a.id);
  assert.equal(afterSecond.status, 'completed');

  const diskRead = manager.storage.events(a.id, 0, 100);
  const memRead = manager.read(a.id, 0, 100);
  assert.deepEqual(memRead.events, diskRead);

  for (let i = 0; i < 510; i++) manager.event(liveAgent, 'progress_tick', { i });
  const tailRead = manager.read(a.id, liveAgent.record.sequence - 5, 10);
  assert.equal(tailRead.events.length, 5);
  assert.equal(tailRead.events.at(-1).sequence, liveAgent.record.sequence);
  const oldDiskRead = manager.read(a.id, 0, 3);
  assert.equal(oldDiskRead.events.length, 3);
  assert.equal(oldDiskRead.events[0].sequence, 1);
});

test('mainstream model profiles cover OpenAI, Anthropic and Google families without private model names', () => {
  assert.equal(defaultModelProfile('openai-codex', 'gpt-5.4-codex').recommendedThinking, 'high');
  assert.equal(defaultModelProfile('openai', 'o3').recommendedThinking, 'high');
  assert.equal(defaultModelProfile('openai', 'gpt-5-mini').recommendedThinking, 'low');
  assert.equal(defaultModelProfile('anthropic', 'claude-opus-4-6').recommendedThinking, 'high');
  assert.equal(defaultModelProfile('anthropic', 'claude-sonnet-4-5').recommendedThinking, 'medium');
  assert.equal(defaultModelProfile('anthropic', 'claude-haiku-4-5').recommendedThinking, 'low');
  assert.equal(defaultModelProfile('google', 'gemini-2.5-pro').recommendedThinking, 'high');
  assert.equal(defaultModelProfile('google', 'gemini-2.5-flash').recommendedThinking, 'low');
});

test('antigravity-hook reads unified deliveredSeq cursor even if legacy field is absent', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd, 'done', { antigravitySessionId: 'conv-unified-cursor' });
  await settled(manager, a.id);
  const currentSeq = manager.read(a.id).agent.sequence;
  fs.mkdirSync(path.join(manager.storage.root, 'callbacks'), { recursive: true });
  fs.writeFileSync(path.join(manager.storage.root, 'callbacks', `${a.id}.json`), JSON.stringify({
    agentId: a.id,
    enabled: true,
    host: 'antigravity',
    antigravitySessionId: 'conv-unified-cursor',
    deliveredSeq: currentSeq,
  }));
  const hookScript = fileURLToPath(new URL('../scripts/antigravity-hook.js', import.meta.url));
  const out = execFileSync(process.execPath, [hookScript], {
    input: JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'conv-unified-cursor' }),
    encoding: 'utf8',
    env: { ...process.env, PI_SERVER_STATE_DIR: manager.storage.root },
  });
  assert.deepEqual(JSON.parse(out), {});
});
