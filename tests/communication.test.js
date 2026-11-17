import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, spawn, settled } from './helpers/setup.js';
test('blocking child question is answered explicitly and then completes', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd, 'ASK');
  let question;
  for (let n = 0; n < 20 && !question; n++) {
    const r = manager.read(a.id); question = r.events.find(e => e.type === 'question');
    if (!question) await manager.wait([a.id], { [a.id]: r.nextSequence }, 100);
  }
  assert.ok(question); assert.equal(manager.read(a.id).agent.status, 'waiting');
  manager.channel.reply(question.questionId, '42');
  assert.equal((await settled(manager, a.id)).lastText, 'ANSWER:42');
  assert.throws(() => manager.channel.reply(question.questionId, 'again'), /already answered differently/);
});
test('fresh wait cursor blocks, cancellation stops waiting, unauthorized messages fail', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const after = { [a.id]: manager.read(a.id).nextSequence };
  const result = await manager.wait([a.id], after, 20); assert.equal(result.reason, 'timeout');
  const abort = new AbortController(); const pending = manager.wait([a.id], after, 1000, abort.signal); abort.abort();
  assert.equal((await pending).reason, 'cancelled');
  const response = await fetch(manager.channel.endpoint, { method: 'POST', body: '{}' }); assert.equal(response.status, 401);
});
test('sibling message starts or steers a sibling and parent reports remain events', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const b = await spawn(manager, cwd, 'done', { ownedPaths: ['other'] }); await settled(manager, b.id);
  const impersonation = await fetch(manager.channel.endpoint, { method: 'POST', headers: { authorization: `Bearer ${manager.get(a.id).messageToken}` }, body: JSON.stringify({ action: 'message', agentId: b.id, recipient: 'parent', message: 'forged' }) });
  assert.equal(impersonation.status, 401);
  async function send(recipient, message) {
    return fetch(manager.channel.endpoint, { method: 'POST', headers: { authorization: `Bearer ${manager.get(a.id).messageToken}` }, body: JSON.stringify({ action: 'message', agentId: a.id, recipient, message }) });
  }
  assert.equal((await send(b.id, 'peer update')).status, 200);
  assert.match((await settled(manager, b.id)).lastText, /peer update/);
  assert.equal((await send('parent', 'report')).status, 200);
  assert.equal(manager.read(a.id).events.at(-1).message, 'report');
});
test('limited reads preserve every event before advancing the cursor', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const initial = manager.read(a.id).agent.sequence;
  for (let n = 1; n <= 7; n++) manager.event(manager.get(a.id), 'message', { message: String(n) });
  let cursor = initial; const messages = [];
  for (let n = 0; n < 3; n++) {
    const result = manager.read(a.id, cursor, 3);
    messages.push(...result.events.map(event => event.message)); cursor = result.nextSequence;
  }
  assert.deepEqual(messages, ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(cursor, manager.read(a.id).agent.sequence);
});
