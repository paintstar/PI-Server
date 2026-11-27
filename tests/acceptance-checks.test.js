import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAgentInstructions, validateAcceptanceChecks } from '../src/acceptance.js';
import { assertToolPath, sandboxProfile } from '../src/tool-sandbox.js';
import { buildBwrapArgs } from '../src/linux-sandbox.js';
import { callbackText } from '../src/callbacks.js';
import { waitReminder } from '../src/wait-reminder.js';
import { FileTaskStore } from '../src/task-store.js';
import { setup, settled } from './helpers/setup.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('acceptanceChecks transitions to completed-verified, emits ordered events and keeps unconfigured runs completed', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/ok.txt'), 'ready\n');

  const plain = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared',
  });
  const plainDone = await settled(manager, plain.id);
  assert.equal(plainDone.status, 'completed');
  assert.equal(plainDone.verification.status, 'none');
  await manager.closeAgent(plain.id);

  const a = await manager.spawn({
    cwd,
    prompt: 'done',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
    policy: { sandboxMode: 'strict', allowNetwork: false },
    acceptanceChecks: [
      { name: 'read-ok', command: 'cat src/ok.txt', expectExit: 0, timeoutMs: 5000 },
      { name: 'expect-nonzero', command: 'exit 2', expectExit: 2, timeoutMs: 5000 },
    ],
  });
  const final = await settled(manager, a.id, 5000);
  assert.equal(final.status, 'completed-verified');
  assert.equal(final.verification.status, 'verified');
  assert.equal(final.verification.passedCount, 2);
  assert.equal(final.verification.failedCount, 0);
  assert.equal(final.verification.totalCount, 2);
  assert.match(final.verification.checks[0].stdoutTail, /ready/);

  const events = manager.read(a.id, 0, 50).events;
  const types = events.map(e => e.type);
  const startIdx = types.indexOf('acceptance_started');
  const endIdx = types.indexOf('acceptance_completed');
  const settledIdx = types.lastIndexOf('settled');
  assert.ok(startIdx > 0 && endIdx > startIdx && settledIdx > endIdx);

  const settledEv = events[settledIdx];
  assert.equal(settledEv.status, 'completed-verified');
  assert.equal(settledEv.verification.status, 'verified');
  assert.match(callbackText(settledEv), /Verification: verified \(2\/2 passed\)/);

  const waitRes = { reason: 'event', results: [{ agent: final, nextSequence: settledEv.sequence }] };
  assert.equal(waitReminder(waitRes), waitRes);
});

test('failed acceptanceChecks enters completed-unverified and re-verifies to completed-verified after send_message fix', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/flag.txt'), 'broken');

  const a = await manager.spawn({
    cwd,
    prompt: 'initial attempt',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
    policy: { sandboxMode: 'strict', allowNetwork: false },
    acceptanceChecks: [
      { name: 'check-flag', command: 'grep -q fixed src/flag.txt || (echo "missing fixed" >&2; exit 1)', expectExit: 0, timeoutMs: 5000 },
    ],
  });

  const first = await settled(manager, a.id, 5000);
  assert.equal(first.status, 'completed-unverified');
  assert.equal(first.verification.status, 'failed');
  assert.equal(first.verification.failedCount, 1);
  assert.match(first.verification.checks[0].stderrTail, /missing fixed/);

  const reminded = waitReminder({ reason: 'event', results: [{ agent: first, nextSequence: first.sequence }] });
  assert.equal(reminded.unverified.length, 1);
  assert.match(reminded.reminder, /completed-unverified/);

  await manager.send(a.id, 'FAKE_WRITE:src/flag.txt=fixed', 'steer');
  const second = await settled(manager, a.id, 5000);
  assert.equal(second.status, 'completed-verified');
  assert.equal(second.verification.status, 'verified');
  assert.equal(second.verification.passedCount, 1);
});

test('acceptanceChecks handles timeout, fail-closed strict sandbox with sandboxHint, and skips on Pi error', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'other'), { recursive: true });

  const timedAgent = await manager.spawn({
    cwd,
    prompt: 'done',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
    policy: { sandboxMode: 'strict', allowNetwork: false },
    acceptanceChecks: [
      { name: 'slow', command: 'sleep 5; echo escaped > src/escaped.txt', expectExit: 0, timeoutMs: 1000 },
      { name: 'escape-write', command: 'echo bad > other/blocked.txt', expectExit: 0, timeoutMs: 5000 },
    ],
  });
  const final = await settled(manager, timedAgent.id, 6000);
  assert.equal(final.status, 'completed-unverified');
  assert.equal(final.verification.status, 'failed');
  assert.equal(final.verification.checks[0].timedOut, true);
  assert.equal(final.verification.checks[0].passed, false);
  assert.equal(fs.existsSync(path.join(cwd, 'src/escaped.txt')), false);
  assert.equal(final.verification.checks[1].passed, false);
  assert.equal(fs.existsSync(path.join(cwd, 'other/blocked.txt')), false);
  assert.match(final.verification.checks[1].sandboxHint || '', /strict sandbox/);

  let runnerCalled = false;
  const { manager: mgr2, cwd: cwd2 } = await setup(t, {
    checkRunner: async () => { runnerCalled = true; return { status: 'verified', checks: [] }; },
  });
  const errored = await mgr2.spawn({
    cwd: cwd2,
    prompt: 'FAIL',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
    acceptanceChecks: [{ command: 'true' }],
  });
  const errFinal = await settled(mgr2, errored.id, 4000);
  assert.equal(errFinal.status, 'failed');
  assert.equal(errFinal.verification.status, 'skipped');
  assert.equal(runnerCalled, false);
});

test('interrupt and closeAgent abort running acceptanceChecks immediately without serial deadlock', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });

  const a = await manager.spawn({
    cwd,
    prompt: 'done',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['src'],
    workspaceMode: 'shared',
    policy: { sandboxMode: 'strict', allowNetwork: false },
    acceptanceChecks: [{ name: 'long-wait', command: 'sleep 10', expectExit: 0, timeoutMs: 15000 }],
  });

  for (let i = 0; i < 80; i++) {
    if (manager.read(a.id, 0, 50).events.some(e => e.type === 'acceptance_started')) break;
    await pause(25);
  }
  const t0 = Date.now();
  await manager.interrupt(a.id);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `interrupt deadlocked on acceptanceChecks (${elapsed}ms)`);
  const afterInt = manager.read(a.id).agent;
  assert.equal(afterInt.status, 'interrupted');
  assert.equal(afterInt.verification.status, 'skipped');

  const b = await manager.spawn({
    cwd,
    prompt: 'done',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['other'],
    workspaceMode: 'shared',
    policy: { sandboxMode: 'strict', allowNetwork: false },
    acceptanceChecks: [{ name: 'long-close', command: 'sleep 10', expectExit: 0, timeoutMs: 15000 }],
  });
  for (let i = 0; i < 80; i++) {
    if (manager.read(b.id, 0, 50).events.some(e => e.type === 'acceptance_started')) break;
    await pause(25);
  }
  const t1 = Date.now();
  await manager.closeAgent(b.id);
  const closeElapsed = Date.now() - t1;
  assert.ok(closeElapsed < 2500, `closeAgent deadlocked on acceptanceChecks (${closeElapsed}ms)`);
  assert.equal(manager.read(b.id).agent.status, 'closed');
});

test('FileTaskStore maps completed-verified to completed and completed-unverified to failed with isError', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  const store = new FileTaskStore(manager.storage.root, manager);

  const okAgent = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared',
    acceptanceChecks: [{ command: 'exit 0' }],
  });
  const okTask = await store.createTask({ context: { agentId: okAgent.id } }, 'r1', {}, 'owner-1');
  await settled(manager, okAgent.id, 5000);
  assert.equal((await store.getTask(okTask.taskId, 'owner-1')).status, 'completed');
  const okResult = await store.getTaskResult(okTask.taskId, 'owner-1');
  assert.equal(okResult.isError, undefined);

  const badAgent = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['other'], workspaceMode: 'shared',
    acceptanceChecks: [{ command: 'exit 1' }],
  });
  const badTask = await store.createTask({ context: { agentId: badAgent.id } }, 'r2', {}, 'owner-1');
  await settled(manager, badAgent.id, 5000);
  const fetchedBad = await store.getTask(badTask.taskId, 'owner-1');
  assert.equal(fetchedBad.status, 'failed');
  assert.match(fetchedBad.statusMessage, /Acceptance checks failed/);
  const badResult = await store.getTaskResult(badTask.taskId, 'owner-1');
  assert.equal(badResult.isError, true);
  assert.equal(badResult.structuredContent.result.status, 'completed-unverified');
});

test('readOnly/nonInteractive policy allows parallel council reads without overlap and seals OS write access', async t => {
  const { manager, cwd } = await setup(t);
  const runId = randomUUID();
  const spawned = await Promise.all([
    manager.spawn({
      cwd, prompt: 'FAKE_REPLY:m1', provider: 'fake', model: 'cheap', ownedPaths: [], workspaceMode: 'shared',
      policy: { readOnly: true, nonInteractive: true, allowNetwork: false, sandboxMode: 'strict' },
      orchestration: { kind: 'council', runId, role: 'critic' },
    }),
    manager.spawn({
      cwd, prompt: 'FAKE_REPLY:m2', provider: 'fake', model: 'strong', ownedPaths: [], workspaceMode: 'shared',
      policy: { readOnly: true, nonInteractive: true, allowNetwork: false, sandboxMode: 'strict' },
      orchestration: { kind: 'council', runId, role: 'reviewer' },
    }),
  ]);
  assert.equal(spawned[0].orchestration.runId, runId);
  assert.equal(spawned[1].orchestration.role, 'reviewer');
  assert.equal(spawned[0].policy.readOnly, true);
  assert.equal(spawned[0].policy.nonInteractive, true);
  for (const agent of spawned) {
    const done = await settled(manager, agent.id, 4000);
    assert.equal(done.status, 'completed');
  }

  const roPrompt = buildAgentInstructions({ id: 'a1', workspace: { cwd }, policy: { readOnly: true, nonInteractive: true, allowWorkspaceRead: true }, ownedPaths: [], context: '' });
  assert.match(roPrompt, /Do not attempt to write/);
  assert.match(roPrompt, /do not call ask_parent/i);

  const policy = { cwd, ownedPaths: [], stateRoot: path.join(cwd, 'state'), tempDir: path.join(cwd, 'tmp'), allowNetwork: false, sandboxMode: 'strict', readOnly: true, allowWorkspaceRead: true };
  assert.throws(() => assertToolPath('a.txt', policy, true), /read-only/);
  assert.throws(() => assertToolPath('a.txt', { ...policy, allowWorkspaceRead: false }, false), /Workspace read is disabled/);

  const bwrapArgs = buildBwrapArgs(policy, '/bin/true', [], {
    existsSync: () => true,
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => false }),
    readlinkSync: () => '',
    realpathSync: p => p,
    canonicalPath: p => path.resolve(p),
    mode: 'strict',
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
  });
  const joined = bwrapArgs.join(' ');
  assert.ok(joined.includes(`--ro-bind ${path.resolve(cwd)} ${path.resolve(cwd)}`));
  assert.ok(!joined.includes(`--bind ${path.resolve(cwd)} ${path.resolve(cwd)}`));

  if (process.platform === 'darwin') {
    const profile = sandboxProfile(policy);
    assert.ok(!profile.includes(`(deny file-write* (require-not (require-any (subpath ${JSON.stringify(fs.realpathSync(cwd))})`));
  }

  assert.throws(() => validateAcceptanceChecks([]), /1 to 10/);
  assert.throws(() => validateAcceptanceChecks([{ command: 'ok', timeoutMs: 500 }]), /timeoutMs/);
});
