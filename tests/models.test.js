import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, spawn, settled } from './helpers/setup.js';
test('temporary upgrade preserves the session and restores the prior model after one run', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const original = manager.read(a.id).agent;
  await manager.setModel(a.id, { provider: 'fake', model: 'strong', thinking: 'max', scope: 'next_run' });
  assert.equal(manager.read(a.id).agent.model.model, 'strong');
  await manager.send(a.id, 'upgraded task');
  const final = await settled(manager, a.id);
  assert.equal(final.model.model, 'cheap'); assert.equal(final.thinking, 'high');
  assert.equal(final.sessionFile, original.sessionFile); assert.equal(final.temporaryModel, undefined);
});
test('busy model changes are rejected, invalid models do not change state', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd, 'HANG');
  await assert.rejects(manager.setModel(a.id, { provider: 'fake', model: 'strong' }), /busy/);
  await assert.rejects(manager.setModel(a.id, { provider: 'fake', model: 'missing' }), /unavailable/);
  assert.equal(manager.read(a.id).agent.model.model, 'cheap');
});
