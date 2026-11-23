import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const runDir = path.join(project, '.agents/records', 'live-' + Date.now());
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-server-live-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(project, 'src/server.js')], env: { ...process.env, PI_SERVER_STATE_DIR: path.join(runDir, 'state') }, stderr: 'pipe' });
const client = new Client({ name: 'live-acceptance', version: '1' });
const results = { startedAt: new Date().toISOString(), checks: [], agents: [], completed: false };
const after = {};
const terminal = new Set(['completed', 'failed', 'interrupted', 'closed']);
function record(name, detail) { results.checks.push({ name, detail, time: new Date().toISOString() }); console.log(name + ': ' + detail); }
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 55000 });
  if (response.isError) throw new Error(`${name}: ${response.content[0].text}`);
  return response.structuredContent?.result ?? JSON.parse(response.content[0].text);
}
async function waitUntil(id, predicate, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await call('read_agent', { agentId: id });
    if (predicate(r)) return r;
    if (r.agent.status === 'failed') throw new Error(`Agent failed: ${r.agent.error || r.agent.lastText}`);
    after[id] = r.nextSequence;
    await call('wait_agent', { agentIds: [id], after: { [id]: after[id] }, timeoutMs: 20000 });
  }
  throw new Error(`Live agent timed out: ${id}`);
}
const done = id => waitUntil(id, r => terminal.has(r.agent.status)).then(r => {
  assert.equal(r.agent.status, 'completed', r.agent.error || r.agent.lastText); return r;
});
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 24);
  record('MCP handshake', '24 tools discovered over real stdio');
  for (const provider of ['zhipu', 'deepseek', 'minimax-tokenplan', 'opencode-go']) {
    const models = await call('list_models', { provider });
    assert.ok(models.models.length); record('Model discovery', `${provider}: ${models.models.length}`);
  }
  const a = await call('spawn_agent', { cwd, provider: 'zhipu', model: 'glm-5.3', thinking: 'low', name: 'GLM-page-package', policy: { allowedModels: [{ provider: 'zhipu', model: 'glm-5.3' }, { provider: 'minimax-tokenplan', model: 'MiniMax-M3.1-Flash-Preview' }] }, ownedPaths: ['packages/a'], workspaceMode: 'shared',
    prompt: '这是隔离的开发演示。先调用 ask_parent 工具询问默认 page_size 应为多少，明确答复前不要猜。收到答复后创建 packages/a/index.mjs，导出 pageSize() 返回答复的整数；用 node 实际检查该函数返回值，最后报告结果。只改 packages/a。' });
  results.agents.push(a.id);
  const b = await call('spawn_agent', { cwd, provider: 'deepseek', model: 'deepseek-flash', thinking: 'low', name: 'DeepSeek-total-package', ownedPaths: ['packages/b'], workspaceMode: 'shared',
    prompt: '这是隔离开发演示。创建 packages/b/index.mjs，导出 total(items)，返回 items 中 amount 的总和。创建 packages/b/check.mjs，通过 Node assert 检查空数组返回0，[{amount:2},{amount:3}]返回5，运行检查并报告。只改 packages/b。' });
  results.agents.push(b.id); record('Parallel launch', 'GLM and DeepSeek accepted separate packages');
  const question = await waitUntil(a.id, r => r.events.some(e => e.type === 'question'));
  const q = question.events.find(e => e.type === 'question');
  assert.equal(question.agent.status, 'waiting');
  await call('reply_question', { questionId: q.questionId, message: '演示默认 page_size 明确采用 41。请按此创建函数并验证。' });
  record('Blocking question', 'GLM asked; parent explicitly replied 41');
  await Promise.all([done(a.id), done(b.id)]);
  execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';import {pageSize} from ${JSON.stringify('file://' + path.join(cwd,'packages/a/index.mjs'))};assert.equal(pageSize(),41);`]);
  execFileSync(process.execPath, [path.join(cwd, 'packages/b/check.mjs')]);
  record('Package acceptance', 'Parent independently ran pageSize=41 and total(empty)=0 / total(2,3)=5');
  await call('send_message', { agentId: a.id, message: `请实际调用 agent_message 工具向兄弟代理 ${b.id} 发消息，内容为：请在你负责的 packages/b/peer-confirm.txt 写入 PEER-41 并检查内容。然后用 agent_message 向 parent 报告已发送。你自己不要修改任何文件，最后简短确认。` });
  await done(a.id); await done(b.id);
  assert.equal(fs.readFileSync(path.join(cwd, 'packages/b/peer-confirm.txt'), 'utf8').trim(), 'PEER-41');
  assert.ok((await call('read_agent', { agentId: a.id })).events.some(e => e.type === 'message' && e.recipient === 'parent'));
  record('Bidirectional communication', 'GLM sent a sibling instruction; DeepSeek wrote PEER-41; GLM reported to parent');
  const before = (await call('read_agent', { agentId: a.id })).agent;
  await call('set_agent_model', { agentId: a.id, provider: 'minimax-tokenplan', model: 'MiniMax-M3.1-Flash-Preview', thinking: 'low', scope: 'next_run' });
  await call('send_message', { agentId: a.id, message: '临时模型切换演示。读取已有 packages/a/index.mjs，确认 pageSize() 原有值41，创建 packages/a/upgrade.txt 内容为 UPGRADED-41，用命令检查这两个结果。保留其他文件。简短报告。' });
  const switched = await done(a.id);
  assert.equal(fs.readFileSync(path.join(cwd, 'packages/a/upgrade.txt'), 'utf8').trim(), 'UPGRADED-41');
  assert.deepEqual(switched.agent.model, before.model); assert.equal(switched.agent.sessionFile, before.sessionFile);
  record('Temporary model upgrade', 'MiniMax completed the next run in the same session; GLM model restored');
  await call('close_agent', { agentId: a.id });
  const resumed = await call('resume_agent', { agentId: a.id }); assert.equal(resumed.sessionFile, before.sessionFile); assert.equal(resumed.status, 'idle');
  await call('send_message', { agentId: a.id, message: '恢复演示。只读 packages/a/upgrade.txt，调用 agent_message 向 parent 报告读到的内容，勿修改文件。' }); await done(a.id);
  record('Saved-session recovery', 'Same Pi session resumed and read prior work');
  const c = await call('spawn_agent', { cwd, provider: 'opencode-go', model: 'deepseek-v4.1-flash', thinking: 'off', name: 'Go-smoke', ownedPaths: ['packages/c'], workspaceMode: 'shared', prompt: '只回复 GO-READY，不调用工具、不修改文件。' });
  results.agents.push(c.id); const go = await done(c.id); assert.match(go.agent.lastText, /GO-READY/);
  record('OpenCode Go real call', 'Configured Go provider returned GO-READY');
  results.completed = true;
} catch (error) {
  results.error = error.message; process.exitCode = 1; console.error(error.message);
} finally {
  for (const id of results.agents) {
    try { const state = await call('close_agent', { agentId: id }); results.finalStates ??= []; results.finalStates.push(state); }
    catch (error) { results.cleanupErrors ??= []; results.cleanupErrors.push(error.message); }
  }
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  if (results.completed) fs.cpSync(path.join(cwd, 'packages'), path.join(runDir, 'packages'), { recursive: true });
  await client.close();
  const info = path.join(runDir, 'state/controller.json'); if (fs.existsSync(info)) { process.kill(JSON.parse(fs.readFileSync(info, 'utf8')).pid, 'SIGTERM'); for (let i = 0; i < 50 && fs.existsSync(path.join(runDir, 'state/controller.lock')); i++) await new Promise(resolve => setTimeout(resolve, 50)); }
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('Evidence: ' + runDir);
}
