import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const runDir = path.join(project, '.agents/records', `v2-${Date.now()}`);
const stateDir = path.join(runDir, 'state');
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-server-v2-live-'));

fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/math.mjs'), 'export function add(a, b) { return a - b; }\n');
for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=verify@local', '-c', 'user.name=verify', 'commit', '-qm', 'base']]) {
  execFileSync('git', ['-C', repo, ...args]);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, 'src/server.js')],
  env: { ...process.env, PI_SERVER_STATE_DIR: stateDir, PI_DASHBOARD_AUTO: '0' },
  stderr: 'pipe',
});
const client = new Client({ name: 'v2-live-verify', version: '2.0.0' });
const results = { startedAt: new Date().toISOString(), checks: [], agents: [], runs: [], completed: false };
const terminal = new Set(['completed', 'completed-verified', 'completed-unverified', 'failed', 'interrupted', 'closed']);

function record(name, detail) {
  results.checks.push({ name, detail, time: new Date().toISOString() });
  console.log(`${name}: ${detail}`);
}

async function call(name, args = {}, timeout = 240000) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (response.isError) throw new Error(`${name}: ${response.content[0].text}`);
  return response.structuredContent?.result ?? JSON.parse(response.content[0].text);
}

async function waitTerminal(agentId, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  while (Date.now() < deadline) {
    const read = await call('read_agent', { agentId, afterSequence: after }, 30000);
    if (terminal.has(read.agent.status)) return read.agent;
    after = read.nextSequence;
    await call('wait_agent', { agentIds: [agentId], after: { [agentId]: after }, timeoutMs: 20000 }, 35000);
  }
  throw new Error(`Timed out waiting for agent ${agentId}`);
}

function pickModels(listed) {
  if (process.env.PI_VERIFY_MODELS) {
    return process.env.PI_VERIFY_MODELS.split(',').map(spec => {
      const slash = spec.trim().indexOf('/');
      return { provider: spec.trim().slice(0, slash), model: spec.trim().slice(slash + 1) };
    }).filter(m => m.provider && m.model);
  }
  const byProvider = new Map();
  for (const item of listed) {
    if (!byProvider.has(item.provider)) byProvider.set(item.provider, { provider: item.provider, model: item.model });
  }
  const distinct = [...byProvider.values()];
  if (distinct.length >= 2) return distinct.slice(0, 3);
  return listed.slice(0, 2).map(m => ({ provider: m.provider, model: m.model }));
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 27);
  for (const name of ['consult', 'council', 'cross_review']) {
    assert.ok(tools.tools.some(t => t.name === name), `missing tool ${name}`);
  }
  record('MCP handshake', '27 tools discovered (consult, council, cross_review ready)');

  const listed = (await call('list_models', { limit: 100 })).models;
  const chosen = pickModels(listed);
  assert.ok(chosen.length >= 2, 'Need at least 2 authenticated models (or set PI_VERIFY_MODELS=p1/m1,p2/m2)');
  const [implModel, reviewModel] = chosen;
  record('Model selection', chosen.map(m => `${m.provider}/${m.model}`).join(', '));

  const checkCmd = 'node --input-type=module -e "import assert from \'node:assert/strict\'; import { add } from \'./src/math.mjs\'; import { double } from \'./src/extra.mjs\'; assert.equal(add(2, 3), 5); assert.equal(double(4), 8);"';
  const worker = await call('spawn_agent', {
    cwd: repo,
    provider: implModel.provider,
    model: implModel.model,
    thinking: 'low',
    name: 'v2-acceptance-worker',
    ownedPaths: ['src'],
    workspaceMode: 'worktree',
    policy: { sandboxMode: 'dev', allowNetwork: false },
    acceptanceChecks: [{ name: 'math-and-extra', command: checkCmd, expectExit: 0, timeoutMs: 30000 }],
    prompt: '仅把 src/math.mjs 改为 export function add(a, b) { return a + b; }，先不要创建 src/extra.mjs，然后简短结束。',
  });
  results.agents.push(worker.id);
  const first = await waitTerminal(worker.id);
  assert.equal(first.status, 'completed-unverified');
  assert.equal(first.verification.status, 'failed');
  record('Acceptance fail gate', `worker settled as completed-unverified (${first.verification.passedCount}/${first.verification.totalCount})`);

  await call('send_message', {
    agentId: worker.id,
    message: '现在创建新文件 src/extra.mjs，导出 export function double(x) { return x * 2; }，验证后汇报。',
  });
  const second = await waitTerminal(worker.id);
  assert.equal(second.status, 'completed-verified');
  assert.equal(second.verification.status, 'verified');
  record('Acceptance re-verify', `worker re-verified as completed-verified (${second.verification.passedCount}/${second.verification.totalCount})`);

  const review = await call('cross_review', {
    sourceAgentId: worker.id,
    reviewer: { provider: reviewModel.provider, model: reviewModel.model, thinking: 'low' },
    focus: '检查 src/math.mjs 与新建未跟踪文件 src/extra.mjs 的实现正确性。',
    timeoutMs: 120000,
  });
  results.runs.push(review.runId);
  assert.ok(['approve', 'concerns', 'blockers'].includes(review.verdict));
  assert.equal(review.emptyDiff, false);
  assert.ok(fs.existsSync(path.join(stateDir, 'runs', `${review.runId}.json`)));
  record('Cross review', `verdict=${review.verdict}, findings=${review.findings?.length ?? 0}`);

  fs.writeFileSync(path.join(repo, 'src/dirty.tmp'), 'dirty working tree\n');
  const councilMembers = chosen.slice(0, 3).map((m, idx) => ({
    provider: m.provider,
    model: m.model,
    thinking: 'low',
    role: idx === 0 ? 'critic' : 'reviewer',
  }));
  const dry = await call('council', {
    question: '在单进程本机服务里，使用原子临时文件重命名还是直接覆盖写配置文件更安全？',
    members: councilMembers,
    cwd: repo,
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.status, 'dry_run');
  record('Council dryRun', `estimated tokens=${dry.estimate?.totalInputTokens ?? 0}, zero spawn`);

  const council = await call('council', {
    question: '在单进程本机服务里，使用原子临时文件重命名还是直接覆盖写配置文件更安全？简短给出立场与理由。',
    members: councilMembers,
    cwd: repo,
    cleanProfile: true,
    timeoutMs: 150000,
  });
  results.runs.push(council.runId);
  assert.ok(['completed', 'partial'].includes(council.status));
  assert.ok(fs.existsSync(path.join(stateDir, 'runs', `${council.runId}.json`)));
  record('Council live', `status=${council.status}, quorum=${council.quorum.succeeded}/${council.quorum.total}`);

  const serialized = JSON.stringify(results);
  assert.equal(/sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,}/.test(serialized), false, 'Secret pattern detected');
  results.completed = true;
} catch (error) {
  results.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const id of results.agents) {
    try { await call('close_agent', { agentId: id }, 20000); } catch {}
  }
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  await client.close();
  const info = path.join(stateDir, 'controller.json');
  if (fs.existsSync(info)) {
    const pid = JSON.parse(fs.readFileSync(info, 'utf8')).pid;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 50 && fs.existsSync(path.join(stateDir, 'controller.lock')); i++) await new Promise(r => setTimeout(r, 50));
  }
  fs.rmSync(repo, { recursive: true, force: true });
  console.log(`Evidence: ${runDir}`);
}
