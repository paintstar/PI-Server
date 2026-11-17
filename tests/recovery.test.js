import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/manager.js';
import { setup, spawn, settled, processFactory } from './helpers/setup.js';
test('closed saved sessions resume without replaying the previous task', async t => {
  const { manager, cwd, track } = await setup(t);
  const a = await spawn(manager, cwd, 'first'); await settled(manager, a.id);
  const original = manager.read(a.id).agent.sessionFile;
  const other = await new Manager({ root: manager.storage.root, processFactory }).start(); track(other);
  await assert.rejects(other.resume(a.id), /live process/);
  await manager.closeAgent(a.id);
  const resumed = await other.resume(a.id);
  assert.equal(resumed.status, 'idle'); assert.equal(resumed.sessionFile, original);
  await other.send(a.id, 'second'); assert.equal((await settled(other, a.id)).lastText, 'second');
});
