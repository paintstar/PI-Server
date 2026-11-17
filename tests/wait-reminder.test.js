import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnReminder, waitReminder } from '../src/wait-reminder.js';
import { instructions } from '../src/server.js';

test('启动提醒要求结束本轮前必须等待，并给出 Claude Code 唤醒命令', () => {
  const note = spawnReminder('11111111-1111-4111-8111-111111111111');
  assert.match(note.rule, /wait_agent/);
  assert.match(note.next, /11111111-1111-4111-8111-111111111111/);
  assert.match(note.claudeCode, /wait-events\.js"? --agent 11111111/);
});

test('等待返回里列出仍在工作和等待答复的代理，全部结束则不加提醒', () => {
  const result = { reason: 'timeout', results: [
    { agent: { id: 'a', status: 'running' }, nextSequence: 7 }, { agent: { id: 'b', status: 'waiting' }, nextSequence: 3 }, { agent: { id: 'c', status: 'completed' }, nextSequence: 9 }] };
  const out = waitReminder(result);
  assert.deepEqual(out.pending, [{ agentId: 'a', status: 'running', after: 7 }]);
  assert.deepEqual(out.asking, [{ agentId: 'b', status: 'waiting', after: 3 }]);
  assert.match(out.reminder, /reply_question/);
  const done = { reason: 'event', results: [{ agent: { id: 'c', status: 'completed' }, nextSequence: 9 }] };
  assert.equal(waitReminder(done), done);
});

test('服务说明第一句就是不许在子代理未结束时收尾', () => {
  assert.match(instructions, /^HARD RULE:.*must not end your turn/);
});
