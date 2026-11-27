import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { setup, spawn, settled } from './helpers/setup.js';
import { DashboardData, readTail, summarizeActivity, contextAnalysis, pullRequestLinks, parseDashboardPort } from '../src/dashboard-data.js';
import { startDashboard } from '../src/dashboard.js';
import { ensureDashboard } from '../src/dashboard-launcher.js';
import { LiveStream } from '../src/live-stream.js';

test('dashboard reads live agents and identifies disconnected controllers without changing ownership', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const root = manager.storage.root; const data = new DashboardData(root);
  assert.equal(data.list().agents[0].controllerAlive, true);
  assert.equal(data.list().agents[0].status, 'completed');
  const lock = fs.readFileSync(path.join(root, a.id, 'owner.lock'), 'utf8');
  const detail = data.detail(a.id); assert.ok(detail.agent.events.length);
  assert.equal(fs.readFileSync(path.join(root, a.id, 'owner.lock'), 'utf8'), lock);
  const owned = manager.get(a.id); owned.record.status = 'waiting'; owned.record.questionIds = ['sample-question'];
  manager.event(owned, 'question', { questionId: 'sample-question', question: 'Choose a page size' });
  manager.event(owned, 'tool_execution_start', { toolCallId: 'sample-tool', toolName: 'ask_parent' });
  assert.equal(data.list().agents[0].questions[0].question, 'Choose a page size');
  assert.deepEqual(data.list().agents[0].currentTools, ['ask_parent']);
  const record = manager.storage.load(a.id); record.status = 'running'; manager.storage.save(record);
  manager.release(manager.get(a.id).lock);
  assert.equal(data.list().agents[0].status, 'disconnected');
  const bad = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; fs.mkdirSync(path.join(root, bad)); fs.writeFileSync(path.join(root, bad, 'agent.json'), '{');
  assert.equal(data.list().agents.length, 1); assert.equal(data.list().errors.length, 1);
});

test('private read-only HTTP rejects missing token, other hosts and mutation requests', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'test-secret' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin; const headers = { authorization: 'Bearer test-secret' };
  assert.equal((await fetch(origin + '/api/agents')).status, 401);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/agents', { headers: { ...headers, host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(origin + '/api/agents', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(origin + '/api/agents', { method: 'POST', headers: { ...headers, 'x-pi-dashboard': '1' } })).status, 404);
  assert.equal((await fetch(origin + '/api/agents', { method: 'DELETE', headers })).status, 405);
  const result = await (await fetch(origin + '/api/agents', { headers })).json(); assert.equal(result.agents[0].id, a.id);
  const detail = await (await fetch(origin + '/api/agents/' + a.id, { headers })).json(); assert.equal(detail.agent.status, 'completed');
  assert.equal((await fetch(origin + '/api/agents/not-an-id', { headers })).status, 400);
  assert.equal((await fetch(origin + '/', { headers })).status, 200);
  const page = await fetch(origin + '/');
  const cookie = page.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const fromPlainAddress = await fetch(origin + '/api/agents', { headers: { cookie: cookie.split(';')[0], 'sec-fetch-site': 'same-origin' } });
  assert.equal(fromPlainAddress.status, 200);
  assert.equal((await fromPlainAddress.json()).agents[0].id, a.id);
  assert.equal((await fetch(origin + '/api/agents', { headers: { cookie: cookie.split(';')[0], 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(origin + '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(manager.read(a.id).agent.status, 'completed');
});

test('saved session rendering shows thinking text without provider signatures, bounds text and rejects arbitrary session paths', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const directory = manager.storage.directory(a.id); const sessions = path.join(directory, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'test.jsonl');
  const entry = { type: 'message', timestamp: '2026-10-06', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Visible plan', thinkingSignature: 'ENCRYPTED' }, { type: 'text', text: '<script>sample</script>' }, { type: 'toolCall', name: 'bash', arguments: { command: 'test' } }] } };
  fs.writeFileSync(file, JSON.stringify(entry) + '\n' + '{"unfinished":');
  assert.equal(readTail(file).length, 1);
  const record = manager.storage.load(a.id); record.sessionFile = file; manager.storage.save(record);
  const data = new DashboardData(manager.storage.root); const detail = data.detail(a.id);
  assert.equal(detail.messages[0].text, '<script>sample</script>'); assert.equal(detail.messages[0].thinking, 'Visible plan'); assert.ok(!JSON.stringify(detail).includes('ENCRYPTED'));
  assert.equal(detail.messages[0].calls[0].arguments.command, 'test');
  record.sessionFile = path.join(cwd, 'outside.jsonl'); fs.writeFileSync(record.sessionFile, JSON.stringify(entry) + '\n'); manager.storage.save(record);
  assert.match(data.detail(a.id).transcriptError, /outside/);
});

test('activity summary counts finished tools, failures and recent per-minute buckets', () => {
  const now = Date.parse('2026-10-13T02:00:00Z'); const at = minutes => new Date(now - minutes * 60000).toISOString();
  const events = [
    { type: 'tool_execution_start', time: at(45), toolName: 'bash' }, { type: 'tool_execution_end', time: at(45), toolName: 'bash' },
    { type: 'tool_execution_end', time: at(2), toolName: 'read', isError: true }, { type: 'tool_execution_end', time: at(0.5), toolName: 'bash' },
    { type: 'message', time: at(0.2), message: 'done' },
  ];
  const activity = summarizeActivity(events, now);
  assert.equal(activity.toolCalls, 3); assert.equal(activity.toolErrors, 1);
  assert.equal(activity.buckets.length, 30); assert.equal(activity.buckets[29], 1); assert.equal(activity.buckets[27], 1);
  assert.equal(activity.buckets.reduce((a, b) => a + b), 2); assert.equal(activity.lastEvent.type, 'message');
});

test('live stream mirrors streaming thinking, text and tool output, then clears itself', async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'live-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'live.json'); const live = new LiveStream(file, 5);
  const read = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; };
  live.handle({ type: 'message_start', message: { role: 'assistant' } });
  live.handle({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
  live.handle({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Plan ' } });
  live.handle({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'steps' } });
  live.handle({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'bash' } });
  live.handle({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { name: 'bash', arguments: { command: 'ls' } } } });
  let state = await read();
  assert.equal(state.message.blocks[0].text, 'Plan steps'); assert.equal(state.message.blocks[1].name, 'bash'); assert.equal(state.message.blocks[1].done, true);
  live.handle({ type: 'message_end', message: { role: 'assistant' } });
  live.handle({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash' });
  live.handle({ type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'a.txt' }] } });
  state = await read(); assert.equal(state.message, null); assert.equal(state.tools.c1.output, 'a.txt');
  live.handle({ type: 'tool_execution_end', toolCallId: 'c1' });
  assert.equal(await read(), null);
});

test('dashboard marks stay in the dashboard: they relabel idle sessions, can be undone, and never apply to working ones', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const data = new DashboardData(manager.storage.root);
  assert.equal(data.list().agents[0].status, 'completed');
  assert.deepEqual(data.mark(a.id, 'closed'), { id: a.id, status: 'closed', marked: true });
  assert.equal(data.list().agents[0].status, 'closed'); assert.equal(data.list().agents[0].recordedStatus, 'completed');
  assert.throws(() => data.mark(a.id, 'running'), /completed, closed or null/);
  assert.equal(data.mark(a.id, null).marked, false); assert.equal(data.list().agents[0].status, 'completed');
  data.mark(a.id, 'closed');
  const record = manager.storage.load(a.id); record.status = 'running'; record.updatedAt = new Date(Date.now() + 5000).toISOString(); manager.storage.save(record);
  assert.notEqual(data.snapshot(a.id).status, 'closed');
});

test('context analysis reads per-request context size, system prompt sections and part estimates', () => {
  const head = [{ type: 'message', message: { role: 'system', content: '', sections: { tools: 'read write edit bash', project_context: '项目说明'.repeat(50) } } }];
  const entries = [
    { type: 'message', timestamp: '2026-10-13T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '请升级依赖' }] } },
    { type: 'message', timestamp: '2026-10-13T00:00:05Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', arguments: { command: 'ls' } }], usage: { input: 100, cacheRead: 900, output: 20 } } },
    { type: 'message', timestamp: '2026-10-13T00:00:06Z', message: { role: 'toolResult', content: [{ type: 'text', text: 'a\nb\nc' }] } },
    { type: 'message', timestamp: '2026-10-13T00:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 50, cacheRead: 1000, cacheWrite: 10, output: 5 } } },
  ];
  const ctx = contextAnalysis(head, entries, 512000);
  assert.equal(ctx.requests, 2); assert.equal(ctx.used, 1060); assert.equal(ctx.peak, 1060); assert.equal(ctx.cached, 1000); assert.equal(ctx.contextWindow, 512000);
  assert.deepEqual(ctx.sections.map(s => s.name), ['工具说明', '项目说明']);
  assert.ok(ctx.parts.user > 0 && ctx.parts.thinking > 0 && ctx.parts.toolCalls > 0 && ctx.parts.toolResults > 0 && ctx.parts.assistant > 0);
});

test('pull request links are collected once with created and merged hints', () => {
  const entries = [
    { type: 'message', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'toolCall', arguments: { command: 'gh pr create --fill' } }] } },
    { type: 'message', timestamp: 't2', message: { role: 'toolResult', content: [{ type: 'text', text: 'https://github.com/acme/app/pull/42\n' }] } },
    { type: 'message', timestamp: 't3', message: { role: 'toolResult', content: [{ type: 'text', text: 'Merged https://github.com/acme/app/pull/42' }] } },
  ];
  const prs = pullRequestLinks(entries);
  assert.equal(prs.length, 1); assert.equal(prs[0].number, 42); assert.equal(prs[0].repo, 'acme/app'); assert.equal(prs[0].merged, true); assert.equal(prs[0].firstAt, 't2');
});

test('dashboard can move a session to another group and rename groups without touching agent records', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const data = new DashboardData(manager.storage.root); const record = fs.readFileSync(path.join(manager.storage.root, a.id, 'agent.json'), 'utf8');
  data.move(a.id, 'custom:发布'); assert.equal(data.list().agents[0].movedTo, 'custom:发布');
  data.renameGroup('custom:发布', '上线'); assert.deepEqual(data.list().groupNames, { 'custom:发布': '上线' });
  data.mark(a.id, 'closed'); assert.equal(data.list().agents[0].status, 'closed'); assert.equal(data.list().agents[0].movedTo, 'custom:发布');
  data.move(a.id, null); data.renameGroup('custom:发布', null); data.mark(a.id, null);
  assert.equal(data.list().agents[0].movedTo, undefined); assert.deepEqual(data.list().groupNames, {});
  assert.throws(() => data.move(a.id, ''), /Invalid group/);
  assert.equal(fs.readFileSync(path.join(manager.storage.root, a.id, 'agent.json'), 'utf8'), record);
});

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test('concurrent ensureDashboard calls share one healthy viewer via lock and include scriptPath', async t => {
  const { manager } = await setup(t);
  const root = path.join(manager.storage.root, 'launcher-test');
  const port = await freePort();
  const prevPort = process.env.PI_DASHBOARD_PORT;
  process.env.PI_DASHBOARD_PORT = String(port);
  let launchedPid = null;
  t.after(() => {
    if (prevPort === undefined) delete process.env.PI_DASHBOARD_PORT;
    else process.env.PI_DASHBOARD_PORT = prevPort;
    if (launchedPid) {
      try { process.kill(launchedPid, 'SIGTERM'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  });
  const [first, second] = await Promise.all([ensureDashboard(root), ensureDashboard(root)]);
  launchedPid = first.pid;
  assert.equal(first.pid, second.pid);
  assert.equal(first.url, second.url);
  assert.ok(first.scriptPath.endsWith(path.join('src', 'dashboard.js')));
  assert.equal(fs.existsSync(path.join(root, 'dashboard.lock')), false);
  const health = await (await fetch(new URL('/api/health', first.url), {
    headers: { authorization: `Bearer ${first.token}` },
  })).json();
  assert.equal(health.service, 'pi-dashboard');
  assert.equal(health.pid, first.pid);
});

test('dashboard SSE /api/events pushes initial state and subsequent settled agent updates', async t => {
  const { manager, cwd } = await setup(t);
  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'sse-secret' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin;
  const controller = new AbortController();
  t.after(() => controller.abort());

  const res = await fetch(origin + '/api/events', {
    headers: { authorization: 'Bearer sse-secret' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async () => {
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended unexpectedly');
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const initial = await nextEvent();
  assert.deepEqual(initial.agents, []);
  const a = await spawn(manager, cwd);
  await settled(manager, a.id);

  let updated = null;
  for (let i = 0; i < 6; i++) {
    const candidate = await nextEvent();
    if (candidate.agents.some(item => item.id === a.id && item.status === 'completed')) {
      updated = candidate;
      break;
    }
  }
  assert.ok(updated);
});

test('dashboard /api/system, cached /api/quota and modular JS routes work safely', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd);
  await settled(manager, a.id);
  let quotaCalls = 0;
  const dashboard = await startDashboard({
    root: manager.storage.root,
    port: 0,
    token: 'sys-secret',
    fetchQuota: async () => {
      quotaCalls++;
      return {
        queriedAt: new Date().toISOString(),
        results: [{ provider: 'zhipu', status: 'ok', quota: { plan: 'pro', windows: [] } }],
        unsupportedProviders: [],
      };
    },
  });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin;
  const headers = { authorization: 'Bearer sys-secret' };

  const sys = await (await fetch(origin + '/api/system', { headers })).json();
  assert.equal(sys.dashboardPid, process.pid);
  assert.equal(sys.counts.completed, 1);
  assert.equal(typeof sys.modelCount, 'number');
  assert.ok(Array.isArray(sys.watchers));

  const q1 = await (await fetch(origin + '/api/quota', { headers })).json();
  const q2 = await (await fetch(origin + '/api/quota', { headers })).json();
  assert.equal(quotaCalls, 1);
  assert.equal(q1.cached, false);
  assert.equal(q2.cached, true);
  const q3 = await (await fetch(origin + '/api/quota?refresh=1', { headers })).json();
  assert.equal(quotaCalls, 2);
  assert.equal(q3.cached, false);

  for (const asset of ['/dom.js', '/panels.js', '/dialogs.js', '/sidebar.js', '/conversation.js', '/charts.js', '/app.js', '/style.css']) {
    const assetRes = await fetch(origin + asset);
    assert.equal(assetRes.status, 200);
  }
});

test('DashboardData snapshot includes Antigravity parentInfo, callback cursor and active watcher flag', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd, 'done', { parentInfo: { kind: 'antigravity', sessionId: 'conv-snap' } });
  await settled(manager, a.id);
  const root = manager.storage.root;
  fs.mkdirSync(path.join(root, 'callbacks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'callbacks', `${a.id}.json`), JSON.stringify({
    agentId: a.id,
    enabled: true,
    host: 'antigravity',
    antigravitySessionId: 'conv-snap',
    antigravityDeliveredSeq: 4,
    lastObservedBy: 'wait-events',
  }));
  const watchersDir = path.join(root, 'watchers');
  fs.mkdirSync(watchersDir, { recursive: true });
  const watcherFile = path.join(watchersDir, 'conv-snap-live.json');
  fs.writeFileSync(watcherFile, JSON.stringify({ pid: process.pid, sessionId: 'conv-snap', agentIds: [], startedAt: new Date().toISOString() }));

  const data = new DashboardData(root);
  const liveSnap = data.snapshot(a.id);
  assert.equal(liveSnap.parentInfo.kind, 'antigravity');
  assert.equal(liveSnap.parentInfo.sessionId, 'conv-snap');
  assert.equal(liveSnap.callback.antigravityDeliveredSeq, 4);
  assert.equal(liveSnap.watcherActive, true);

  fs.unlinkSync(watcherFile);
  assert.equal(data.snapshot(a.id).watcherActive, false);
});

test('module line limits and zero-comment hygiene hold across refactored files', () => {
  for (const dir of ['bin', 'src', 'scripts', 'dashboard']) {
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      assert.ok(lines.length < 500, `${dir}/${file} exceeds 500 lines (${lines.length})`);
      if (dir === 'dashboard') {
        assert.ok(lines.length < 450, `${dir}/${file} exceeds 450 lines (${lines.length})`);
      }
    }
  }
  const cleanFiles = [
    ...fs.readdirSync('bin').filter(name => name.endsWith('.js')).map(name => path.join('bin', name)),
    ...fs.readdirSync('dashboard').filter(name => name.endsWith('.js')).map(name => path.join('dashboard', name)),
    'src/bin-resolve.js',
    'src/acceptance.js',
    'src/budget.js',
    'src/orchestration-core.js',
    'src/consult.js',
    'src/council.js',
    'src/cross-review.js',
    'src/orchestration-tools.js',
    'src/dashboard.js',
    'src/dashboard-data.js',
    'src/dashboard-insights.js',
    'src/dashboard-sse.js',
    'src/dashboard-launcher.js',
    'src/benchmark-profile.js',
  ];
  for (const file of cleanFiles) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      assert.equal(/^\s*(\/\/|\/\*|\*\/)/.test(lines[i]), false, `Unexpected comment in ${file}:${i + 1}`);
    }
  }
});

test('parseDashboardPort validates ports, systemStatus counts interrupted agents, and SSE survives early close', async t => {
  assert.equal(parseDashboardPort(undefined), 3141);
  assert.equal(parseDashboardPort('8080'), 8080);
  for (const bad of ['0', '70000', 'abc', '3141x']) {
    assert.throws(() => parseDashboardPort(bad), /Invalid dashboard port/);
  }

  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd);
  await settled(manager, a.id);
  const record = manager.storage.load(a.id);
  record.status = 'interrupted';
  manager.storage.save(record);

  const data = new DashboardData(manager.storage.root);
  assert.equal(data.systemStatus().counts.interrupted, 1);

  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'sse-safe' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin;
  const headers = { authorization: 'Bearer sse-safe' };

  const evStatus = await new Promise((resolve, reject) => {
    const req = http.get(origin + '/api/events', { headers }, res => {
      res.once('data', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', reject);
  });
  assert.equal(evStatus, 200);

  const spStatus = await new Promise((resolve, reject) => {
    const req = http.get(origin + `/api/agents/${a.id}/speed`, { headers }, res => {
      req.destroy();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(spStatus, 200);

  const health = await fetch(origin + '/api/health', { headers });
  assert.equal(health.status, 200);
});

test('dashboard session editing, archiving, batch-mark and lightweight live endpoint work safely', async t => {
  const { manager, cwd } = await setup(t);
  const idle = await spawn(manager, cwd);
  await settled(manager, idle.id);
  const busy = await manager.spawn({
    cwd,
    prompt: 'ASK',
    provider: 'fake',
    model: 'cheap',
    ownedPaths: ['b'],
    workspaceMode: 'shared',
    parentId: 'parent-dash',
  });
  for (let i = 0; i < 40; i++) {
    if (manager.read(busy.id).agent.status === 'waiting') break;
    await new Promise(r => setTimeout(r, 20));
  }

  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'org-test' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin;
  const auth = { authorization: 'Bearer org-test' };
  const postHeaders = { ...auth, 'content-type': 'application/json', 'x-pi-dashboard': '1' };

  const changesAsset = await fetch(`${origin}/changes.js`, { headers: auth });
  assert.equal(changesAsset.status, 200);

  const metaRes = await fetch(`${origin}/api/agents/${idle.id}/meta`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ title: '检索验证会话', note: '核对接口返回', pinned: true, group: 'custom:核心检查' }),
  });
  assert.equal(metaRes.status, 200);
  const detail = await (await fetch(`${origin}/api/agents/${idle.id}`, { headers: auth })).json();
  assert.equal(detail.agent.name, '检索验证会话');
  assert.equal(detail.agent.rawName, idle.name);
  assert.equal(detail.agent.note, '核对接口返回');
  assert.equal(detail.agent.pinned, true);
  assert.equal(detail.agent.movedTo, 'custom:核心检查');

  const rejectBusy = await fetch(`${origin}/api/agents/archive`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ id: busy.id, archived: true }),
  });
  assert.equal(rejectBusy.status, 400);

  const rejectWaitingMark = await fetch(`${origin}/api/agents/${busy.id}/mark`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ status: 'closed' }),
  });
  assert.equal(rejectWaitingMark.status, 400);

  const rejectBadFlag = await fetch(`${origin}/api/agents/archive`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ id: idle.id, archived: 'false' }),
  });
  assert.equal(rejectBadFlag.status, 400);

  const batchArch = await (await fetch(`${origin}/api/agents/archive`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ agentIds: [idle.id, busy.id], archived: true }),
  })).json();
  assert.deepEqual(batchArch.updatedIds, [idle.id]);
  assert.equal(batchArch.skippedIds.length, 1);

  const sys = await (await fetch(`${origin}/api/system`, { headers: auth })).json();
  assert.equal(sys.counts.archived, 1);

  const liveRes = await (await fetch(`${origin}/api/agents/${busy.id}/live`, { headers: auth })).json();
  assert.equal(liveRes.id, busy.id);
  assert.equal(liveRes.status, 'waiting');
  assert.equal(typeof liveRes.sessionBytes, 'number');

  const rec = manager.storage.load(idle.id);
  rec.updatedAt = new Date(Date.now() + 5000).toISOString();
  manager.storage.save(rec);
  const afterActivity = await (await fetch(`${origin}/api/agents/${idle.id}`, { headers: auth })).json();
  assert.equal(afterActivity.agent.archived, false);

  const batchClose = await (await fetch(`${origin}/api/agents/batch-mark`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ agentIds: [idle.id, busy.id], status: 'closed' }),
  })).json();
  assert.deepEqual(batchClose.updatedIds, [idle.id]);
  assert.deepEqual(batchClose.skippedIds, [busy.id]);
});

test('dashboard v2 routes serve /logo.svg, modular assets, /api/runs, /api/system sandbox/hosts and verification counts read-only', async t => {
  const { manager, cwd } = await setup(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  const okAgent = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared',
    acceptanceChecks: [{ name: 'ok', command: 'exit 0' }],
  });
  await settled(manager, okAgent.id, 5000);
  const badAgent = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['other'], workspaceMode: 'shared',
    acceptanceChecks: [{ name: 'fail', command: 'exit 1' }],
  });
  await settled(manager, badAgent.id, 5000);
  const lockBefore = fs.readFileSync(path.join(manager.storage.root, okAgent.id, 'owner.lock'), 'utf8');

  const runId = '22222222-2222-4222-8222-222222222222';
  const runsDir = path.join(manager.storage.root, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    runId,
    kind: 'cross_review',
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    sourceAgentId: okAgent.id,
    verdict: 'concerns',
    findings: [{ severity: 'concern', file: 'src/a.js', line: 10, title: 'Check boundary', detail: 'Needs guard' }],
  }));

  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'v2-dash' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin;
  const auth = { authorization: 'Bearer v2-dash' };

  const logoRes = await fetch(`${origin}/logo.svg`);
  assert.equal(logoRes.status, 200);
  assert.match(logoRes.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(logoRes.headers.get('content-security-policy') || '', /default-src 'self'/);
  const logoBody = await logoRes.text();
  assert.match(logoBody, /<svg\b/);
  assert.equal(/data:/i.test(logoBody), false);

  for (const asset of ['/runtime.js', '/sys-dialog.js', '/tabs.js', '/collab-views.js']) {
    const res = await fetch(`${origin}${asset}`);
    assert.equal(res.status, 200, `asset ${asset}`);
  }

  const runsList = await (await fetch(`${origin}/api/runs`, { headers: auth })).json();
  assert.equal(runsList.runs.length, 1);
  assert.equal(runsList.runs[0].runId, runId);
  assert.equal(runsList.runs[0].verdict, 'concerns');

  const runDetail = await (await fetch(`${origin}/api/runs/${runId}`, { headers: auth })).json();
  assert.equal(runDetail.findings[0].severity, 'concern');
  assert.equal((await fetch(`${origin}/api/runs/not-a-uuid`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${origin}/api/runs/33333333-3333-4333-8333-333333333333`, { headers: auth })).status, 404);

  const sys = await (await fetch(`${origin}/api/system`, { headers: auth })).json();
  assert.equal(sys.counts.completedVerified, 1);
  assert.equal(sys.counts.completedUnverified, 1);
  assert.equal(sys.counts.total, 2);
  assert.equal(sys.runsCount, 1);
  assert.ok(sys.sandbox && typeof sys.sandbox.backend === 'string' && typeof sys.sandbox.defaultMode === 'string');
  for (const host of ['antigravity', 'claude', 'codex', 'opencode']) {
    assert.equal(typeof sys.hosts[host].configured, 'boolean');
    assert.equal(typeof sys.hosts[host].activeAgents, 'number');
  }

  const detail = await (await fetch(`${origin}/api/agents/${okAgent.id}`, { headers: auth })).json();
  assert.equal(detail.agent.verification.status, 'verified');
  assert.equal(detail.agent.verification.checks.length, 1);
  assert.equal(fs.readFileSync(path.join(manager.storage.root, okAgent.id, 'owner.lock'), 'utf8'), lockBefore);
});
