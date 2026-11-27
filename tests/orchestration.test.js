import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { PiProcess } from '../src/rpc-client.js';
import { runConsult } from '../src/consult.js';
import { runCouncil } from '../src/council.js';
import { runCrossReview } from '../src/cross-review.js';
import { loadRun, listRuns } from '../src/orchestration-core.js';
import { setup, spawn, settled } from './helpers/setup.js';

function createCustomFakePi(tmp, scriptBody) {
  const file = path.join(tmp, 'orch-fake-pi.mjs');
  fs.writeFileSync(file, scriptBody);
  const factory = options => new PiProcess({ ...options, executable: process.execPath, args: [file, ...options.args] });
  factory.testOnly = true;
  return factory;
}

const ORCH_FAKE_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const emit = data => process.stdout.write(JSON.stringify(data) + '\\n');
const dir = args.includes('--session-dir') ? flag('--session-dir') : process.cwd();
fs.mkdirSync(dir, { recursive: true });
const sessionFile = args.includes('--session') ? flag('--session') : path.join(dir, randomUUID() + '.jsonl');
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, '');
if (process.env.PI_SUBAGENT_ENDPOINT) {
  await fetch(process.env.PI_SUBAGENT_ENDPOINT, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.PI_SUBAGENT_TOKEN },
    body: JSON.stringify({ action: 'policy_ready', agentId: process.env.PI_SUBAGENT_ID }),
  });
}
let model = { provider: flag('--provider') || 'fake', id: flag('--model') || 'alpha' };
let thinkingLevel = flag('--thinking') || 'high';
let active = false; let timer;
let messages = [];
const models = [
  { provider: 'fake', id: 'alpha', name: 'alpha', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 2, output: 8 } },
  { provider: 'fake', id: 'beta', name: 'beta', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 1, output: 4 } },
  { provider: 'fake', id: 'gamma', name: 'gamma', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 0, output: 0 } },
  { provider: 'fake', id: 'expensive', name: 'expensive', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 50000, output: 50000 } },
  { provider: 'fake', id: 'flaky', name: 'flaky', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 1, output: 2 } },
  { provider: 'fake', id: 'hang', name: 'hang', reasoning: true, contextWindow: 128000, maxTokens: 8000, input: ['text'], cost: { input: 1, output: 2 } },
];
function replyFor(prompt) {
  if (model.id === 'flaky' || prompt.includes('FORCE_FAIL')) return { text: 'boom', reason: 'error' };
  if (prompt.includes('FORCE_PLAIN')) return { text: 'Plain text advice without json', reason: 'stop' };
  if (prompt.includes('FORCE_BLOCKER')) {
    return {
      text: 'Found blocker.\\n\`\`\`json\\n' + JSON.stringify({
        verdict: 'approve',
        summary: 'Has SQL injection',
        confidence: 0.9,
        findings: [{ severity: 'blocker', file: 'src/new.js', line: 1, title: 'Unsafe query', detail: 'Unsanitized input', suggestion: 'Parameterize' }],
      }) + '\\n\`\`\`',
      reason: 'stop',
    };
  }
  if (prompt.includes('FORCE_MALFORMED_REVIEW')) {
    return { text: 'Looks totally fine to me, ship it!', reason: 'stop' };
  }
  if (prompt.includes('FORCE_CHECK_UNTRACKED')) {
    const saw = prompt.includes('untracked-feature.js') && prompt.includes('export const magic = 42');
    return {
      text: '\`\`\`json\\n' + JSON.stringify({
        verdict: saw ? 'approve' : 'concerns',
        summary: saw ? 'Verified untracked diff' : 'Missing untracked diff',
        confidence: 0.95,
        findings: [],
      }) + '\\n\`\`\`',
      reason: 'stop',
    };
  }
  if (prompt.includes('Council member role')) {
    const stance = model.id === 'beta' ? 'oppose' : 'support';
    const conf = model.id === 'beta' ? 0.6 : 0.9;
    const cleanTag = args.includes('--no-skills') ? 'clean-yes' : 'clean-no';
    return {
      text: 'Analysis ' + cleanTag + '\\n\`\`\`json\\n' + JSON.stringify({
        stance,
        confidence: conf,
        summary: model.id + ' summary (' + cleanTag + ')',
        claims: ['Shared claim A', model.id + ' unique'],
        risks: ['Shared risk R'],
      }) + '\\n\`\`\`',
      reason: 'stop',
    };
  }
  return {
    text: 'Detailed review.\\n\`\`\`json\\n' + JSON.stringify({
      summary: 'Solid design',
      stance: 'support',
      confidence: 0.85,
      keyPoints: ['Clear boundaries'],
      risks: ['Watch timeouts'],
      recommendation: 'Proceed',
    }) + '\\n\`\`\`',
    reason: 'stop',
  };
}
function finish(text, reason = 'stop') {
  if (!active) return;
  active = false;
  const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: reason, usage: { input: 40, output: 20, cost: { total: 0.002 } }, ...(reason === 'error' ? { errorMessage: text } : {}) };
  messages.push(message); fs.appendFileSync(sessionFile, JSON.stringify(message) + '\\n');
  emit({ type: 'message_end', message }); emit({ type: 'agent_end' }); emit({ type: 'agent_settled' });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) !== -1) {
    const cmd = JSON.parse(buf.slice(0, idx)); buf = buf.slice(idx + 1);
    const respond = (data, error) => emit({ type: 'response', id: cmd.id, command: cmd.type, success: !error, ...(error ? { error } : { data }) });
    if (cmd.type === 'get_available_models') respond({ models });
    else if (cmd.type === 'get_state') respond({ sessionFile, model, thinkingLevel, isStreaming: active });
    else if (cmd.type === 'get_messages') respond({ messages });
    else if (cmd.type === 'set_model') { model = { provider: cmd.provider, id: cmd.modelId }; respond(model); }
    else if (cmd.type === 'set_thinking_level') { thinkingLevel = cmd.level; respond(); }
    else if (cmd.type === 'prompt') {
      active = true;
      emit({ type: 'agent_start' });
      const clean = cmd.message.replace(/^\\[Pi message [0-9a-f-]{36}\\]\\n/, '');
      if (model.id === 'hang' || clean.includes('FORCE_HANG')) { respond({ disposition: 'started' }); continue; }
      respond({ disposition: 'started' });
      const out = replyFor(clean);
      timer = setTimeout(() => finish(out.text, out.reason), 25);
    }
    else if (cmd.type === 'abort') { clearTimeout(timer); finish('stopped', 'aborted'); respond(); }
    else respond(null, 'Unsupported command');
  }
});
process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
`;

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/base.js'), 'export const base = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

test('consult runs read-only ephemeral agent, persists run, handles contextFiles, dryRun, non-JSON and abort', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orch-consult-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const factory = createCustomFakePi(tmp, ORCH_FAKE_SCRIPT);
  const { cwd, manager } = await setup(t, { processFactory: factory });
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'Architecture note v2');

  const dry = await runConsult({
    manager,
    stateRoot: manager.storage.root,
    input: { question: 'Evaluate design', provider: 'fake', model: 'alpha', cwd, contextFiles: ['notes.txt'], dryRun: true },
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.agentId, null);
  assert.equal(dry.estimate.pricingComplete, true);
  assert.equal(manager.list(true).length, 0);
  assert.equal(listRuns(manager.storage.root).length, 0);

  await assert.rejects(
    () => runConsult({ manager, stateRoot: manager.storage.root, input: { question: 'q', provider: 'fake', model: 'alpha', contextFiles: ['notes.txt'] } }),
    /explicit absolute cwd/,
  );
  await assert.rejects(
    () => runConsult({ manager, stateRoot: manager.storage.root, input: { question: 'q', provider: 'fake', model: 'alpha', cwd, contextFiles: ['../outside.txt'] } }),
    /outside the permitted file scope/,
  );

  const ok = await runConsult({
    manager,
    stateRoot: manager.storage.root,
    input: { question: 'Evaluate design', provider: 'fake', model: 'alpha', style: 'architect', cwd, contextFiles: ['notes.txt'] },
  });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.archived, true);
  assert.equal(ok.structured.stance, 'support');
  assert.equal(ok.structured.confidence, 0.85);
  assert.equal(loadRun(manager.storage.root, ok.runId).runId, ok.runId);
  const savedAgent = manager.storage.load(ok.agentId);
  assert.equal(savedAgent.status, 'closed');
  assert.equal(savedAgent.orchestration.kind, 'consult');
  assert.equal(savedAgent.orchestration.runId, ok.runId);
  assert.equal(savedAgent.orchestration.verdict, undefined);

  const plain = await runConsult({
    manager,
    stateRoot: manager.storage.root,
    input: { question: 'FORCE_PLAIN', provider: 'fake', model: 'alpha' },
  });
  assert.equal(plain.status, 'completed');
  assert.equal(plain.structured, null);
  assert.match(plain.answer, /Plain text advice/);
  assert.ok(plain.parseWarning);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const aborted = await runConsult({
    manager,
    stateRoot: manager.storage.root,
    input: { question: 'FORCE_HANG', provider: 'fake', model: 'hang', timeoutMs: 5000 },
    signal: ac.signal,
  });
  assert.equal(aborted.status, 'cancelled');
  assert.equal(manager.storage.load(aborted.agentId).status, 'closed');
});

test('council executes 3 parallel read-only models on dirty repo, supports cleanProfile, partial/quorum, budget and capacity guards', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orch-council-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const factory = createCustomFakePi(tmp, ORCH_FAKE_SCRIPT);
  const { cwd, manager } = await setup(t, { processFactory: factory, maxAgents: 4 });
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'src/base.js'), 'export const base = 999;\n');

  const dry = await runCouncil({
    manager,
    stateRoot: manager.storage.root,
    input: {
      question: 'Should we adopt event sourcing?',
      cwd,
      dryRun: true,
      members: [
        { provider: 'fake', model: 'alpha', role: 'architect' },
        { provider: 'fake', model: 'gamma', role: 'critic' },
      ],
    },
  });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.estimate.unknownPricingModels, ['fake/gamma']);
  assert.equal(dry.estimate.pricingComplete, false);
  assert.equal(manager.list(true).length, 0);

  await assert.rejects(
    () => runCouncil({
      manager,
      stateRoot: manager.storage.root,
      input: {
        question: 'Costly question',
        budgetCapUsd: 0.01,
        members: [
          { provider: 'fake', model: 'expensive' },
          { provider: 'fake', model: 'alpha' },
        ],
      },
    }),
    /exceeds budgetCapUsd/,
  );

  const full = await runCouncil({
    manager,
    stateRoot: manager.storage.root,
    input: {
      question: 'Parallel dirty repo review',
      cwd,
      cleanProfile: true,
      members: [
        { provider: 'fake', model: 'alpha', role: 'architect' },
        { provider: 'fake', model: 'beta', role: 'critic' },
        { provider: 'fake', model: 'gamma', role: 'redteam' },
      ],
    },
  });
  assert.equal(full.status, 'completed');
  assert.equal(full.quorum.met, true);
  assert.equal(full.quorum.succeeded, 3);
  assert.equal(full.synthesis.stanceCounts.support, 2);
  assert.equal(full.synthesis.stanceCounts.oppose, 1);
  assert.ok(full.synthesis.consensus.some(c => c.includes('Shared claim A')));
  assert.ok(full.synthesis.disagreements.length > 0);
  assert.ok(full.members.every(m => m.answer.includes('clean-yes')));
  assert.equal(loadRun(manager.storage.root, full.runId).kind, 'council');

  const partial = await runCouncil({
    manager,
    stateRoot: manager.storage.root,
    input: {
      question: 'Quorum partial test',
      cwd,
      members: [
        { provider: 'fake', model: 'alpha' },
        { provider: 'fake', model: 'beta' },
        { provider: 'fake', model: 'flaky' },
      ],
    },
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.quorum.met, true);
  assert.equal(partial.quorum.succeeded, 2);

  const failedQuorum = await runCouncil({
    manager,
    stateRoot: manager.storage.root,
    input: {
      question: 'Below quorum test',
      cwd,
      members: [
        { provider: 'fake', model: 'alpha' },
        { provider: 'fake', model: 'flaky' },
        { provider: 'fake', model: 'flaky' },
      ],
    },
  });
  assert.equal(failedQuorum.status, 'failed');
  assert.equal(failedQuorum.quorum.met, false);
  assert.equal(failedQuorum.members[0].status, 'completed');
  assert.ok(failedQuorum.members[0].answer.length > 0);

  const tight = await setup(t, { processFactory: factory, maxAgents: 2 });
  await assert.rejects(
    () => runCouncil({
      manager: tight.manager,
      stateRoot: tight.manager.storage.root,
      input: {
        question: 'Over capacity',
        members: [
          { provider: 'fake', model: 'alpha' },
          { provider: 'fake', model: 'beta' },
          { provider: 'fake', model: 'gamma' },
        ],
      },
    }),
    /Insufficient agent capacity/,
  );
  assert.equal(tight.manager.list(true).length, 0);
});

test('cross_review handles untracked files, same-model guard, empty diff short-circuit, blocker escalation and fail-closed parsing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orch-review-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const factory = createCustomFakePi(tmp, ORCH_FAKE_SCRIPT);
  const { cwd, manager } = await setup(t, { processFactory: factory });
  initGitRepo(cwd);

  const source = await spawn(manager, cwd, 'done', { provider: 'fake', model: 'alpha', ownedPaths: ['src'], workspaceMode: 'shared', policy: {} });
  await settled(manager, source.id);

  await assert.rejects(
    () => runCrossReview({
      manager,
      stateRoot: manager.storage.root,
      input: { sourceAgentId: source.id, reviewer: { provider: 'fake', model: 'alpha' } },
    }),
    /must differ from source model/,
  );

  const empty = await runCrossReview({
    manager,
    stateRoot: manager.storage.root,
    input: { sourceAgentId: source.id, reviewer: { provider: 'fake', model: 'beta' } },
  });
  assert.equal(empty.emptyDiff, true);
  assert.equal(empty.reviewerAgentId, null);
  assert.equal(empty.verdict, 'concerns');

  fs.writeFileSync(path.join(cwd, 'src/untracked-feature.js'), 'export const magic = 42;\n');

  const untrackedOk = await runCrossReview({
    manager,
    stateRoot: manager.storage.root,
    input: { sourceAgentId: source.id, reviewer: { provider: 'fake', model: 'beta' }, focus: 'FORCE_CHECK_UNTRACKED' },
  });
  assert.equal(untrackedOk.emptyDiff, false);
  assert.equal(untrackedOk.verdict, 'approve');
  assert.equal(untrackedOk.summary, 'Verified untracked diff');

  const escalated = await runCrossReview({
    manager,
    stateRoot: manager.storage.root,
    input: { sourceAgentId: source.id, reviewer: { provider: 'fake', model: 'beta' }, focus: 'FORCE_BLOCKER' },
  });
  assert.equal(escalated.verdict, 'blockers');
  assert.equal(escalated.findings[0].severity, 'blocker');

  const failClosed = await runCrossReview({
    manager,
    stateRoot: manager.storage.root,
    input: { sourceAgentId: source.id, reviewer: { provider: 'fake', model: 'alpha' }, allowSameModel: true, focus: 'FORCE_MALFORMED_REVIEW' },
  });
  assert.equal(failClosed.verdict, 'concerns');
  assert.ok(failClosed.parseWarning);
});

test('MCP tools consult, council and cross_review work end-to-end over InMemoryTransport', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orch-mcp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const factory = createCustomFakePi(tmp, ORCH_FAKE_SCRIPT);
  const { cwd, manager: helper, track } = await setup(t, { processFactory: factory });
  const { server, manager } = await createServer({ root: `${helper.storage.root}-orch`, processFactory: factory });
  track(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orch-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const cRes = (await client.callTool({
    name: 'consult',
    arguments: { question: 'Quick check', provider: 'fake', model: 'alpha', cwd },
  })).structuredContent.result;
  assert.equal(cRes.status, 'completed');
  assert.equal(cRes.structured.stance, 'support');

  const councilRes = (await client.callTool({
    name: 'council',
    arguments: {
      question: 'Multi-model check',
      members: [{ provider: 'fake', model: 'alpha' }, { provider: 'fake', model: 'beta' }],
    },
  })).structuredContent.result;
  assert.equal(councilRes.status, 'completed');
  assert.equal(councilRes.quorum.succeeded, 2);
});
