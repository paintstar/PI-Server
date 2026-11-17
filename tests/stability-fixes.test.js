import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileOperation, runSandboxed } from '../src/tool-sandbox.js';
import { sandboxedReadOperations } from '../src/read-operations.js';
import { FileTaskStore } from '../src/task-store.js';
import { Storage, readTail, atomicWriteJson } from '../src/storage.js';
import { setup, settled } from './helpers/setup.js';

test('fileOperation keeps stderr warnings out of read bytes and read_head reads only the prefix', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-readhead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['work', 'state', 'tmp']) fs.mkdirSync(path.join(root, name));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'assets'));
  const big = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]), Buffer.alloc(4096, 65)]);
  fs.writeFileSync(path.join(cwd, 'assets/sample.png'), big);
  fs.writeFileSync(path.join(cwd, 'assets/note.txt'), 'hello world');
  const policy = { cwd, ownedPaths: ['assets'], tempDir: path.join(root, 'tmp'), stateRoot: path.join(root, 'state'), allowNetwork: false, sandboxMode: 'strict' };

  const head = await fileOperation(policy, 'read_head', 'assets/sample.png', undefined, { length: 32 });
  assert.equal(head.length, 32);
  assert.equal(head.toString('ascii', 12, 16), 'IHDR');

  const ops = sandboxedReadOperations(policy);
  assert.equal(await ops.detectImageMimeType('assets/sample.png'), 'image/png');
  assert.equal(await ops.detectImageMimeType('assets/note.txt'), undefined);
  assert.equal(String(await ops.readFile('assets/note.txt')), 'hello world');

  const out = [];
  const err = [];
  const res = await runSandboxed(policy, process.execPath, ['-e', 'process.stdout.write("OUT");process.stderr.write("ERR")'], {
    onStdout: c => out.push(c),
    onStderr: c => err.push(c),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(Buffer.concat(out).toString('utf8'), 'OUT');
  assert.equal(Buffer.concat(err).toString('utf8'), 'ERR');
});

test('spawning auto or worktree agents succeeds alongside a shared agent in the same Git repo', async t => {
  const { manager, cwd } = await setup(t);
  const repo = path.join(cwd, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.txt'), 'v1\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
    execFileSync('git', ['-C', repo, ...args]);
  }
  const shared = await manager.spawn({ cwd: repo, prompt: 'LONG', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' });
  const isolated = await manager.spawn({ cwd: repo, prompt: 'OK', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'auto' });
  assert.equal(shared.workspace.mode, 'shared');
  assert.equal(isolated.workspace.mode, 'worktree');
  await assert.rejects(manager.spawn({ cwd: repo, prompt: 'OK', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' }), /overlap/);
  await manager.interrupt(shared.id);
  await settled(manager, isolated.id);
});

test('FileTaskStore.prune handles missing tasks directory and atomicWriteJson leaves no tmp files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FileTaskStore(dir, { agents: new Map() });
  fs.rmSync(store.directory, { recursive: true, force: true });
  assert.equal(store.prune(), 0);
  const file = path.join(dir, 'sample.json');
  atomicWriteJson(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0);
  const storage = new Storage(dir);
  const logFile = path.join(dir, 'sample.jsonl');
  fs.writeFileSync(logFile, '{"a":1}\n{"a":2}\n{"partial":');
  assert.equal(readTail(logFile).length, 2);
  assert.deepEqual(readTail(logFile, 0), []);
  assert.deepEqual(readTail(logFile, -5), []);
  assert.deepEqual(readTail(logFile, Number.NaN), []);
  const completeLog = path.join(dir, 'complete.jsonl');
  fs.writeFileSync(completeLog, '{"a":1}\n{"a":2}');
  assert.equal(readTail(completeLog, 10, { tolerateIncomplete: false }).length, 2);
  assert.equal(storage.root, path.resolve(dir));
});

test('read_head handles length=0 and rejects invalid lengths explicitly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-readhead-edge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['work', 'state', 'tmp']) fs.mkdirSync(path.join(root, name));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'assets'));
  fs.writeFileSync(path.join(cwd, 'assets/sample.bin'), Buffer.from('abcdef'));
  const policy = { cwd, ownedPaths: ['assets'], tempDir: path.join(root, 'tmp'), stateRoot: path.join(root, 'state'), allowNetwork: false, sandboxMode: 'strict' };

  const empty = await fileOperation(policy, 'read_head', 'assets/sample.bin', undefined, { length: 0 });
  assert.equal(empty.length, 0);
  await assert.rejects(() => fileOperation(policy, 'read_head', 'assets/sample.bin', undefined, { length: -1 }), /length|non-negative|integer/i);
  await assert.rejects(() => fileOperation(policy, 'read_head', 'assets/sample.bin', undefined, { length: 1.5 }), /length|integer/i);
});
