import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson } from '../src/storage.js';

const argDir = process.argv.find(a => a.startsWith('--dir='))?.slice(6);
const ownerPidArg = Number(process.argv.find(a => a.startsWith('--owner-pid='))?.slice(12) || 0);
const targetRoot = path.resolve(argDir || process.env.PI_SERVER_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-demo-state-')));
const repoDir = path.join(targetRoot, 'demo-repo');
fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(targetRoot, 'runs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(targetRoot, 'callbacks'), { recursive: true, mode: 0o700 });

function initDemoRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Demo Builder'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'src/payment-lock.js'), 'export function acquireLock(orderId) {\n  return { orderId, acquired: true };\n}\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'chore: initial payment lock module'], { cwd: dir });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'src/payment-lock.js'), 'const activeLocks = new Map();\n\nexport function acquireLock(orderId, ttlMs = 30000) {\n  const now = Date.now();\n  const prev = activeLocks.get(orderId);\n  if (prev && prev.expiresAt > now) return { orderId, acquired: false, holder: prev.token };\n  const token = `${orderId}-${now}`;\n  activeLocks.set(orderId, { token, expiresAt: now + ttlMs });\n  return { orderId, acquired: true, token };\n}\n');
  fs.writeFileSync(path.join(dir, 'src/idempotency.js'), 'export function idempotencyKey(orderId, attempt) {\n  return `pay:${orderId}:${attempt}`;\n}\n');
  return baseCommit;
}

const baseCommit = initDemoRepo(repoDir);
const now = Date.now();
const iso = offsetSec => new Date(now - offsetSec * 1000).toISOString();
const ids = {
  verified: '11111111-1111-4111-8111-111111111101', reviewer: '11111111-1111-4111-8111-111111111102',
  councilA: '22222222-2222-4222-8222-222222222201', councilB: '22222222-2222-4222-8222-222222222202',
  councilC: '22222222-2222-4222-8222-222222222203', opencodeFail: '33333333-3333-4333-8333-333333333301',
  claudeActive: '44444444-4444-4444-8444-444444444401', codexDone: '55555555-5555-4555-8555-555555555501',
  reviewRun: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', councilRun: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
};

function writeAgent({ id, name, status, model, parentInfo, workspace, ownedPaths, usage, lastText, verification, orchestration, events, messages, createdSec, updatedSec, aliveOwner = false }) {
  const dir = path.join(targetRoot, id);
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
  fs.writeFileSync(sessionFile, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ sequence: i + 1, ...e })).join('\n') + '\n');
  if (aliveOwner && Number.isInteger(ownerPidArg) && ownerPidArg > 0) {
    atomicWriteJson(path.join(dir, 'owner.lock'), { pid: ownerPidArg, parentId: 'demo-parent', createdAt: iso(createdSec) });
  }
  atomicWriteJson(path.join(dir, 'agent.json'), {
    id, name, status, model, thinking: 'high', parentId: 'demo-parent', parentInfo,
    workspace, ownedPaths, sessionFile, sequence: events.length, usage, lastText,
    ...(verification ? { verification } : {}),
    ...(orchestration ? { orchestration } : {}),
    createdAt: iso(createdSec), updatedAt: iso(updatedSec),
  });
}

function makeSession(userPrompt, thinking, replyText, usage, multiTurn = false) {
  const base = [
    { type: 'message', timestamp: iso(200), message: { role: 'system', content: '', sections: { preamble: 'Pi Server isolated worker'.repeat(20), tools: 'read write edit bash agent_message ask_parent'.repeat(30), rules: 'Respect ownedPaths and acceptance checks'.repeat(25), project_context: 'Acme Payments Ledger service concurrency specification'.repeat(80) } } },
    { type: 'message', timestamp: iso(190), message: { role: 'user', content: [{ type: 'text', text: userPrompt }] } },
  ];
  if (multiTurn) {
    const turns = [
      [175, 170, 'read', { path: 'src/payment-lock.js' }, 'export function acquireLock(orderId) { return { orderId, acquired: true }; }', { input: 16200, cacheRead: 12000, cacheWrite: 6400, output: 640 }],
      [155, 148, 'edit', { path: 'src/payment-lock.js' }, 'Updated TTL lock map with holder token check', { input: 9800, cacheRead: 34200, cacheWrite: 5100, output: 980 }],
      [130, 122, 'write', { path: 'src/idempotency.js' }, 'Created src/idempotency.js helper', { input: 11400, cacheRead: 58600, cacheWrite: 4800, output: 860 }],
      [95, 86, 'bash', { command: 'npm run test:lock' }, 'ok 6/6 payment lock tests passed', { input: 14100, cacheRead: 79400, cacheWrite: 3900, output: 1120 }],
    ];
    for (const [s, e, tool, args, out, u] of turns) {
      base.push(
        { type: 'message', timestamp: iso(e), message: { role: 'assistant', timestamp: now - s * 1000, content: [{ type: 'thinking', thinking }, { type: 'toolCall', id: `tc-${s}`, name: tool, arguments: args }], usage: u } },
        { type: 'message', timestamp: iso(e - 1), message: { role: 'toolResult', toolCallId: `tc-${s}`, toolName: tool, durationMs: 420, content: [{ type: 'text', text: out }] } },
      );
    }
  }
  base.push({ type: 'message', timestamp: iso(26), message: { role: 'assistant', timestamp: now - 42000, content: [{ type: 'thinking', thinking }, { type: 'text', text: replyText }], usage } });
  return base;
}

writeAgent({
  id: ids.verified, name: '支付并发锁与幂等键实现', status: 'completed-verified',
  model: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
  parentInfo: { kind: 'antigravity', sessionId: 'conv-demo-agy-01', cwd: '/workspace/acme-payments' },
  workspace: { mode: 'worktree', cwd: repoDir, sourceCwd: '/workspace/acme-payments', branch: 'pi/payment-lock', baseCommit },
  ownedPaths: ['src/payment-lock.js', 'src/idempotency.js'],
  usage: { input: 18420, output: 3120, cacheRead: 94200, cacheWrite: 4200, reportedCost: 0.042 },
  lastText: '已完成 `payment-lock.js` 的 TTL 并发锁与 `idempotency.js` 幂等键封装，两项机械验收检查全部通过。',
  verification: {
    status: 'verified', checkedAt: iso(25), sandboxBackend: 'seatbelt', totalDurationMs: 1480, passedCount: 2, failedCount: 0, totalCount: 2,
    checks: [
      { name: 'syntax', command: 'node --check src/payment-lock.js src/idempotency.js', expectExit: 0, exitCode: 0, passed: true, timedOut: false, durationMs: 320, stdoutTail: '', stderrTail: '' },
      { name: 'unit', command: 'npm run test:lock', expectExit: 0, exitCode: 0, passed: true, timedOut: false, durationMs: 1160, stdoutTail: 'ok 6/6 payment lock tests passed', stderrTail: '' },
    ],
  },
  events: [
    { type: 'ready', time: iso(200) },
    { type: 'started', time: iso(190) },
    { type: 'tool_execution_start', time: iso(160), toolCallId: 't1', toolName: 'edit' },
    { type: 'tool_execution_end', time: iso(145), toolCallId: 't1', toolName: 'edit' },
    { type: 'acceptance_started', time: iso(30) },
    { type: 'acceptance_completed', time: iso(25) },
    { type: 'settled', time: iso(24), status: 'completed-verified' },
  ],
  messages: makeSession('实现支付并发锁并补充幂等键模块', '检查并发重入与 TTL 边界条件，保证无外部依赖。', '已完成 `src/payment-lock.js` 与 `src/idempotency.js`，两项机械验收检查全部通过。', { input: 18420, cacheRead: 112000, cacheWrite: 4200, output: 3120 }, true),
  createdSec: 200, updatedSec: 24,
});

writeAgent({
  id: ids.reviewer, name: 'cross_review:reviewer:claude-sonnet-4-5', status: 'completed',
  model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  parentInfo: { kind: 'antigravity', sessionId: 'conv-demo-agy-01', cwd: '/workspace/acme-payments' },
  workspace: { mode: 'shared', cwd: repoDir, sourceCwd: '/workspace/acme-payments' },
  ownedPaths: [],
  usage: { input: 11200, output: 1450, cacheRead: 16000, cacheWrite: 0, reportedCost: 0.028 },
  lastText: '已完成跨模型只读审查，识别 1 条并发过期清理关注点与 1 条命名建议，无阻塞级安全漏洞。',
  orchestration: { kind: 'cross_review', runId: ids.reviewRun, role: 'reviewer', sourceAgentId: ids.verified },
  events: [{ type: 'ready', time: iso(22) }, { type: 'started', time: iso(20) }, { type: 'settled', time: iso(10), status: 'completed' }],
  messages: makeSession('审查支付并发锁改动与新建幂等键文件', '逐行比对 tracked diff 与 untracked 新建文件。', '审查结论：`concerns`（1 条关注，1 条建议）。', { input: 11200, cacheRead: 16000, cacheWrite: 0, output: 1450 }),
  createdSec: 22, updatedSec: 10,
});

const councilConfigs = [
  { id: ids.councilA, provider: 'deepseek', model: 'deepseek-reasoner', role: 'architect', stance: 'support', conf: 0.91, summary: '建议采用单实例 SSE 广播器 + mtimeMs 快照缓存，消除连接级 fs.watch 泄漏。' },
  { id: ids.councilB, provider: 'openai-codex', model: 'gpt-5.3-codex', role: 'critic', stance: 'conditional', conf: 0.84, summary: '支持单实例广播器，但需在 Linux 缺失 recursive watch 时保留 1s 兜底轮询。' },
  { id: ids.councilC, provider: 'anthropic', model: 'claude-sonnet-4-5', role: 'redteam', stance: 'support', conf: 0.88, summary: '确认只读投影不触碰 owner.lock，且需保证 SSE 断连立即释放句柄。' },
];
for (const c of councilConfigs) {
  writeAgent({
    id: c.id, name: `council:${c.role}:${c.model}`, status: 'completed',
    model: { provider: c.provider, model: c.model },
    parentInfo: { kind: 'antigravity', sessionId: 'conv-demo-agy-01', cwd: '/workspace/acme-payments' },
    workspace: { mode: 'shared', cwd: repoDir, sourceCwd: '/workspace/acme-payments' },
    ownedPaths: [],
    usage: { input: 6400, output: 980, cacheRead: 8200, cacheWrite: 0, reportedCost: 0.011 },
    lastText: c.summary,
    orchestration: { kind: 'council', runId: ids.councilRun, role: c.role },
    events: [{ type: 'ready', time: iso(90) }, { type: 'started', time: iso(88) }, { type: 'settled', time: iso(60), status: 'completed' }],
    messages: makeSession('评估调度台 SSE 共享广播器改造方案', '分析并发句柄与跨平台 fs.watch 兼容性。', c.summary, { input: 6400, cacheRead: 8200, cacheWrite: 0, output: 980 }),
    createdSec: 90, updatedSec: 60,
  });
}

writeAgent({
  id: ids.opencodeFail, name: 'OpenCode · WSL2 bwrap 沙箱回归验证', status: 'completed-unverified',
  model: { provider: 'deepseek', model: 'deepseek-chat' },
  parentInfo: { kind: 'opencode', sessionId: 'ses_demo_oc_01', cwd: '/workspace/acme-payments' },
  workspace: { mode: 'shared', cwd: repoDir, sourceCwd: '/workspace/acme-payments' },
  ownedPaths: ['src/idempotency.js'],
  usage: { input: 9100, output: 1120, cacheRead: 12000, cacheWrite: 0, reportedCost: 0.004 },
  lastText: '已补充幂等键边界检查，等待修复集成测试中的退出码偏差。',
  verification: {
    status: 'failed', checkedAt: iso(40), sandboxBackend: 'bwrap', totalDurationMs: 920, passedCount: 1, failedCount: 1, totalCount: 2,
    checks: [
      { name: 'lint', command: 'node --check src/idempotency.js', expectExit: 0, exitCode: 0, passed: true, timedOut: false, durationMs: 180, stdoutTail: '', stderrTail: '' },
      { name: 'e2e', command: 'npm run test:e2e-cache', expectExit: 0, exitCode: 1, passed: false, timedOut: false, durationMs: 740, stdoutTail: '', stderrTail: 'EACCES: permission denied, mkdir "/home/demo/.cache/acme"', sandboxHint: 'Command failed under strict sandbox restrictions; switch to dev mode or widen ownedPaths if caches are required.' },
    ],
  },
  events: [{ type: 'ready', time: iso(110) }, { type: 'started', time: iso(105) }, { type: 'acceptance_started', time: iso(42) }, { type: 'acceptance_completed', time: iso(40) }, { type: 'settled', time: iso(39), status: 'completed-unverified' }],
  messages: makeSession('在 OpenCode 会话中校验幂等键模块', '执行本地静态检查与隔离回归。', '语法检查通过，但 `e2e` 检查触发 `strict` 沙箱缓存写入拦截。', { input: 9100, cacheRead: 12000, cacheWrite: 0, output: 1120 }),
  createdSec: 110, updatedSec: 39,
});

writeAgent({
  id: ids.claudeActive, name: 'Claude · 支付重试状态机分析', status: 'waiting', aliveOwner: true,
  model: { provider: 'zhipu', model: 'glm-4.7' },
  parentInfo: { kind: 'claude', sessionId: 'claude-demo-01', cwd: '/workspace/acme-payments' },
  workspace: { mode: 'shared', cwd: repoDir, sourceCwd: '/workspace/acme-payments' },
  ownedPaths: ['src/payment-lock.js'],
  usage: { input: 7200, output: 860, cacheRead: 15000, cacheWrite: 0, reportedCost: 0.006 },
  lastText: '等待父代理确认重试退避上限。',
  events: [{ type: 'ready', time: iso(55) }, { type: 'started', time: iso(50) }, { type: 'question', time: iso(15), questionId: 'q-demo-01', question: '重试退避窗口采用 30s 固定上限还是指数退避至 5 分钟？' }],
  messages: makeSession('审查重试退避策略', '识别到需求歧义，调用 ask_parent 请求人类或主代理拍板。', '已暂停等待 `reply_question` 答复。', { input: 7200, cacheRead: 15000, cacheWrite: 0, output: 860 }),
  createdSec: 55, updatedSec: 15,
});

writeAgent({
  id: ids.codexDone, name: 'Codex · 日志脱敏规则核对', status: 'completed',
  model: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
  parentInfo: { kind: 'codex', sessionId: 'codex-thread-demo-01', cwd: '/workspace/acme-payments' },
  workspace: { mode: 'shared', cwd: repoDir, sourceCwd: '/workspace/acme-payments' },
  ownedPaths: ['src/idempotency.js'],
  usage: { input: 5100, output: 640, cacheRead: 9800, cacheWrite: 0, reportedCost: 0.009 },
  lastText: '确认无明文凭证与敏感字段外泄。',
  events: [{ type: 'ready', time: iso(140) }, { type: 'started', time: iso(135) }, { type: 'settled', time: iso(120), status: 'completed' }],
  messages: makeSession('核对所有日志与接口输出是否脱敏', '逐项扫描状态序列化字段。', '全部输出已脱敏，未发现明文令牌。', { input: 5100, cacheRead: 9800, cacheWrite: 0, output: 640 }),
  createdSec: 140, updatedSec: 120,
});

atomicWriteJson(path.join(targetRoot, 'runs', `${ids.reviewRun}.json`), {
  runId: ids.reviewRun, kind: 'cross_review', dryRun: false, createdAt: iso(22), completedAt: iso(10),
  status: 'completed', sourceAgentId: ids.verified, sourceModel: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
  reviewerAgentId: ids.reviewer, reviewerModel: { provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'high' },
  verdict: 'concerns', confidence: 0.89,
  summary: '并发锁主体逻辑正确且已覆盖新建 untracked 文件 `src/idempotency.js`；建议补充过期锁定期回收避免长时间运行下 Map 增长。',
  findings: [
    { severity: 'concern', file: 'src/payment-lock.js', line: 8, title: '过期锁条目缺少定期清理', detail: '`activeLocks` 仅在同 `orderId` 再次获取时覆写，历史订单键不会自动淘汰。', suggestion: '在 `acquireLock` 中按阈值惰性清理过期键或引入 LRU 上限。' },
    { severity: 'nit', file: 'src/idempotency.js', line: 1, title: '建议校验 attempt 非空', detail: '当 `attempt` 为 undefined 时会拼出字符串 `"undefined"`。', suggestion: '为 `attempt` 提供默认值 `1` 并做非空校验。' },
  ],
  diffStat: '2 files changed, 13 insertions(+), 2 deletions(-)', diffTruncated: false, emptyDiff: false, durationMs: 12000,
});

atomicWriteJson(path.join(targetRoot, 'runs', `${ids.councilRun}.json`), {
  runId: ids.councilRun, kind: 'council', dryRun: false, createdAt: iso(90), completedAt: iso(60),
  question: '调度台 SSE 推送是否应升级为单实例共享 fs.watch 广播器 + mtimeMs 快照缓存？',
  cleanProfile: true, status: 'completed', quorum: { required: 2, succeeded: 3, total: 3, met: true },
  synthesis: {
    mode: 'deterministic',
    consensus: ['单实例共享 fs.watch 显著降低文件描述符占用', '只读投影严守不触碰 owner.lock / agent.json 边界'],
    disagreements: ['Divergent stances across models: support=2, conditional=1', 'openai-codex/gpt-5.3-codex (conditional): Linux 需保留 1s 轮询回退'],
    stanceCounts: { support: 2, oppose: 0, conditional: 1, uncertain: 0 },
    averageConfidence: 0.88, confidenceSpread: 0.07,
  },
  members: councilConfigs.map(c => ({
    agentId: c.id, model: { provider: c.provider, model: c.model, thinking: 'high' }, role: c.role, status: 'completed', durationMs: 28000,
    answer: c.summary, structured: { stance: c.stance, confidence: c.conf, summary: c.summary, claims: ['单实例广播器降低 FD 占用'], risks: ['Linux 无 recursive watch'] },
    usage: { input: 6400, output: 980, cacheRead: 8200, cacheWrite: 0, reportedCost: 0.011 },
  })),
  totalUsage: { input: 19200, output: 2940, cacheRead: 24600, cacheWrite: 0, reportedCost: 0.033 },
  estimate: { catalogEstimateUsd: 0.035, pricingComplete: true, unknownPricingModels: [], pricingNote: 'Static catalog estimate, not actual billing' },
  durationMs: 30000,
});

atomicWriteJson(path.join(targetRoot, 'models-catalog.json'), [
  { provider: 'openai-codex', model: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ['text'], cost: { input: 2, output: 8 } },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ['text'], cost: { input: 3, output: 15 } },
  { provider: 'deepseek', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 128000, maxTokens: 32000, reasoning: true, input: ['text'], cost: { input: 0.55, output: 2.19 } },
  { provider: 'zhipu', model: 'glm-4.7', name: 'GLM-4.7', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text'], cost: { input: 0.4, output: 1.6 } },
]);

console.log(JSON.stringify({ stateDir: targetRoot, repoDir, ids }, null, 2));
