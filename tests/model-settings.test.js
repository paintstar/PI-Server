import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PiProcess } from '../src/rpc-client.js';
import { createServer } from '../src/server.js';
import { startDashboard } from '../src/dashboard.js';
import {
  buildSettingsPayload,
  defaultModelProfile,
  enrichModels,
  maskSecret,
  PI_TOOLS_MANIFEST,
  readMaskedAuthMap,
  saveModelSettings,
  updateProviderAuth,
} from '../src/model-settings.js';
import { fakePi, processFactory, setup } from './helpers/setup.js';

function makeTempPiEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-settings-test-'));
  const agentDir = path.join(dir, 'agent');
  const stateRoot = path.join(dir, 'state');
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, agentDir, stateRoot, backupDir };
}

test('secret masking and updateProviderAuth keep backups at 0o600 without leaking raw tokens', t => {
  const { agentDir, stateRoot, backupDir } = makeTempPiEnv(t);
  assert.equal(maskSecret('sk-proj-secret-abcdef1234'), 'sk-••••1234');
  assert.equal(maskSecret('$ZAI_API_KEY'), '$ZAI_API_KEY');
  assert.equal(maskSecret('!security find-generic-password -w'), '命令动态获取 (!…)');
  assert.equal(maskSecret('short'), '••••••••');

  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'raw-oauth-access', refresh: 'raw-oauth-refresh', expires: Date.now() + 60_000 },
    zai: { type: 'api_key', key: 'zai-very-secret-key-9876' },
  }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      zai: { baseUrl: 'https://old.example.com/v1', modelOverrides: { 'glm-5.3': { contextWindow: 200000 } } },
    },
  }));

  const maskedMap = readMaskedAuthMap(agentDir);
  assert.equal(maskedMap['openai-codex'].type, 'oauth');
  assert.equal(maskedMap['openai-codex'].expired, false);
  assert.equal(maskedMap.zai.masked, 'zai••••9876');

  assert.throws(() => updateProviderAuth({
    stateRoot, agentDir, backupDir, provider: 'zai', action: 'set_base_url', baseUrl: 'http://remote.example.com/v1',
  }), /HTTPS/);
  assert.throws(() => updateProviderAuth({
    stateRoot, agentDir, backupDir, provider: 'zai', action: 'set_key', apiKey: 'line1\nline2',
  }), /API Key/);

  const updated = updateProviderAuth({
    stateRoot, agentDir, backupDir, provider: 'zai', action: 'set_key',
    apiKey: 'new-super-secret-value-5555', baseUrl: 'https://open.example.com/v2/',
  });
  const serialized = JSON.stringify(updated);
  assert.equal(serialized.includes('new-super-secret-value-5555'), false);
  assert.equal(serialized.includes('raw-oauth-access'), false);
  assert.equal(serialized.includes('raw-oauth-refresh'), false);

  const zaiProvider = updated.providers.find(p => p.provider === 'zai');
  assert.equal(zaiProvider.maskedKey, 'new••••5555');
  assert.equal(zaiProvider.baseUrl, 'https://open.example.com/v2');

  const backups = fs.readdirSync(backupDir);
  assert.ok(backups.some(f => f.startsWith('auth-')));
  assert.ok(backups.some(f => f.startsWith('models-')));
  for (const file of backups) {
    assert.equal(fs.statSync(path.join(backupDir, file)).mode & 0o777, 0o600);
  }

  const afterClear = updateProviderAuth({ stateRoot, agentDir, backupDir, provider: 'zai', action: 'clear_key' });
  assert.equal(afterClear.providers.find(p => p.provider === 'zai').configured, false);
  const afterToggle = updateProviderAuth({ stateRoot, agentDir, backupDir, provider: 'zai', action: 'toggle', enabled: false });
  assert.equal(afterToggle.providers.find(p => p.provider === 'zai').enabled, false);
});

test('saveModelSettings customizes contextWindow and description, syncs models.json and resets cleanly', t => {
  const { agentDir, stateRoot, backupDir } = makeTempPiEnv(t);
  const catalog = [
    { provider: 'zai', model: 'glm-5.3', contextWindow: 512000, maxTokens: 65536, reasoning: true, input: ['text'] },
    { provider: 'zhipu', model: 'glm-5.3', contextWindow: 200000, maxTokens: 32768, reasoning: true, input: ['text'] },
  ];
  fs.writeFileSync(path.join(stateRoot, 'models-catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelOverrides: {} },
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: [{ id: 'glm-5.3', contextWindow: 200000, maxTokens: 32768 }] },
    },
  }));

  saveModelSettings(stateRoot, {
    models: {
      'zai/glm-5.3': {
        contextWindow: 1000000,
        maxTokens: 131072,
        recommendedThinking: 'high',
        description: '用于大型中文仓库重构与多文件校验的主力档位。',
      },
      'zhipu/glm-5.3': { contextWindow: 512000, enabled: false },
    },
  }, { agentDir, backupDir });

  const enabledOnly = enrichModels(catalog, stateRoot);
  assert.equal(enabledOnly.length, 1);
  assert.equal(enabledOnly[0].contextWindow, 1000000);
  assert.equal(enabledOnly[0].description, '用于大型中文仓库重构与多文件校验的主力档位。');
  assert.equal(enabledOnly[0].customDescription, true);

  const piModels = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(piModels.providers.zai.modelOverrides['glm-5.3'].contextWindow, 1000000);
  assert.equal(piModels.providers.zhipu.models[0].contextWindow, 512000);

  saveModelSettings(stateRoot, { models: { 'zai/glm-5.3': null, 'zhipu/glm-5.3': null } }, { agentDir, backupDir });
  const restored = enrichModels(catalog, stateRoot);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].contextWindow, 512000);
  assert.equal(restored[0].description, defaultModelProfile('zai', 'glm-5.3', catalog[0]).description);
  const piModelsAfterReset = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(piModelsAfterReset.providers.zai.modelOverrides['glm-5.3'], undefined);
  assert.equal(piModelsAfterReset.providers.zhipu.models[0].contextWindow, 200000);
});

test('Manager rejects disabled models and passes configured defaults to spawned Pi processes', async t => {
  const launchedArgs = [];
  const trackingFactory = options => {
    launchedArgs.push(options.args);
    return new PiProcess({ ...options, executable: process.execPath, args: [fakePi, ...options.args] });
  };
  trackingFactory.testOnly = true;

  const { cwd, manager } = await setup(t, { processFactory: trackingFactory });
  saveModelSettings(manager.storage.root, {
    models: { 'fake/strong': { enabled: false } },
    defaults: {
      sandboxMode: 'strict',
      allowNetwork: false,
      thinking: 'medium',
      loadSkills: false,
      loadContextFiles: false,
    },
  }, { syncPiModels: false });

  const visible = await manager.models();
  assert.deepEqual(visible.map(m => m.model), ['cheap']);
  const all = await manager.models(undefined, { includeDisabled: true });
  assert.equal(all.length, 2);
  assert.equal(all.find(m => m.model === 'strong').enabled, false);

  await assert.rejects(() => manager.spawn({
    cwd, prompt: 'test', provider: 'fake', model: 'strong', ownedPaths: ['src'], workspaceMode: 'shared',
  }), /Model is disabled in settings/);

  const agent = await manager.spawn({
    cwd, prompt: 'done', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared',
  });
  assert.equal(agent.thinking, 'medium');
  assert.equal(agent.policy.allowNetwork, false);
  assert.equal(agent.policy.sandboxMode, 'strict');
  const spawnArgs = launchedArgs.find(a => a.includes('--extension'));
  assert.ok(spawnArgs.includes('--no-skills'));
  assert.ok(spawnArgs.includes('--no-context-files'));
});

test('MCP get_model_profiles and list_models expose contextWindow, descriptions and defaults without secrets', async t => {
  const { cwd, manager: helper, track } = await setup(t);
  const { agentDir } = makeTempPiEnv(t);
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
    fake: { type: 'api_key', key: 'fake-super-secret-xyz999' },
  }));
  const root = helper.storage.root + '-profiles';
  const { server, manager } = await createServer({ root, piAgentDir: agentDir, processFactory });
  track(manager);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);

  saveModelSettings(root, {
    models: {
      'fake/cheap': { contextWindow: 256000, description: '擅长极速检索与脚本验证的测试档位' },
      'fake/strong': { enabled: false },
    },
    defaults: { thinking: 'low', loadSkills: false },
  }, { agentDir, syncPiModels: false });

  const profiles = await client.callTool({ name: 'get_model_profiles', arguments: {} });
  const data = profiles.structuredContent.result;
  assert.equal(data.models.length, 1);
  assert.equal(data.models[0].model, 'cheap');
  assert.equal(data.models[0].contextWindow, 256000);
  assert.match(data.models[0].description, /极速检索/);
  assert.equal(data.defaults.thinking, 'low');
  assert.equal(data.defaults.loadSkills, false);
  assert.equal(data.subagentTools.length, PI_TOOLS_MANIFEST.length);
  assert.equal(JSON.stringify(data).includes('fake-super-secret-xyz999'), false);

  const found = await client.callTool({ name: 'list_models', arguments: { search: '极速检索' } });
  assert.equal(found.structuredContent.result.total, 1);
  const withDisabled = await client.callTool({ name: 'list_models', arguments: { includeDisabled: true } });
  assert.equal(withDisabled.structuredContent.result.total, 2);

  const settingsView = buildSettingsPayload({ stateRoot: root, agentDir });
  assert.ok(settingsView.providers.some(p => p.provider === 'fake'));
  assert.ok(cwd);
});

test('Dashboard settings HTTP routes validate headers and persist model and key changes', async t => {
  const { agentDir, stateRoot, backupDir } = makeTempPiEnv(t);
  fs.writeFileSync(path.join(stateRoot, 'models-catalog.json'), JSON.stringify([
    { provider: 'deepseek', model: 'deepseek-v4-pro', contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ['text'] },
  ]));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { deepseek: { modelOverrides: {} } },
  }));

  const dashboard = await startDashboard({
    root: stateRoot,
    port: 0,
    token: 'dash-token',
    agentDir,
    backupDir,
  });
  t.after(() => dashboard.close());

  const origin = new URL(dashboard.url).origin;
  const authHeaders = { authorization: 'Bearer dash-token' };

  const viewAsset = await fetch(origin + '/settings-views.js');
  assert.equal(viewAsset.status, 200);

  const initial = await (await fetch(origin + '/api/settings', { headers: authHeaders })).json();
  assert.equal(initial.models.length, 1);
  assert.equal(initial.subagentTools.length, PI_TOOLS_MANIFEST.length);

  const forbidden = await fetch(origin + '/api/settings', {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { thinking: 'low' } }),
  });
  assert.equal(forbidden.status, 403);

  const postHeaders = { ...authHeaders, 'content-type': 'application/json', 'x-pi-dashboard': '1' };
  const keyRes = await fetch(origin + '/api/settings/provider-auth', {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      provider: 'deepseek',
      action: 'set_key',
      apiKey: 'ds-key-secret-value-4321',
      baseUrl: 'https://api.deepseek.example/v1',
    }),
  });
  assert.equal(keyRes.status, 200);
  const keyJson = await keyRes.json();
  assert.equal(JSON.stringify(keyJson).includes('ds-key-secret-value-4321'), false);
  assert.equal(keyJson.providers.find(p => p.provider === 'deepseek').maskedKey, 'ds-••••4321');

  const saveRes = await fetch(origin + '/api/settings', {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      models: { 'deepseek/deepseek-v4-pro': { contextWindow: 500000, description: '深度推演专用' } },
      defaults: { allowNetwork: false, thinking: 'medium' },
    }),
  });
  assert.equal(saveRes.status, 200);
  const savedJson = await saveRes.json();
  assert.equal(savedJson.models[0].contextWindow, 500000);
  assert.equal(savedJson.models[0].description, '深度推演专用');
  assert.equal(savedJson.defaults.allowNetwork, false);
  assert.equal(savedJson.defaults.thinking, 'medium');

  const protoAttempt = await fetch(origin + '/api/settings/provider-auth', {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ provider: '__proto__', action: 'set_base_url', baseUrl: 'https://evil.example/v1' }),
  });
  assert.equal(protoAttempt.status, 400);
  assert.equal(({}).baseUrl, undefined);

  const dirEscape = await fetch(origin + '/api/settings/provider-auth', {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      provider: 'deepseek',
      action: 'set_key',
      apiKey: 'escaped-secret-7777',
      agentDir: path.join(stateRoot, 'unrelated-dir'),
      stateRoot: path.join(stateRoot, 'unrelated-state'),
    }),
  });
  assert.equal(dirEscape.status, 200);
  assert.equal(fs.existsSync(path.join(stateRoot, 'unrelated-dir')), false);
  assert.equal(fs.existsSync(path.join(stateRoot, 'unrelated-state')), false);
});

function fakeJwt(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, sub: 'user_test' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('sync_codex imports OAuth tokens at 0o600, validates before writing and preserves baseline windows', t => {
  const { dir, agentDir, stateRoot, backupDir } = makeTempPiEnv(t);
  const codexFile = path.join(dir, 'codex-auth.json');
  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  fs.writeFileSync(codexFile, JSON.stringify({
    tokens: {
      access_token: fakeJwt(futureExp),
      refresh_token: 'codex-refresh-secret-abc123',
      account_id: 'acc_synthetic_1',
    },
  }));

  assert.throws(() => updateProviderAuth({
    stateRoot, agentDir, backupDir, codexAuthFile: codexFile, provider: 'zai', action: 'sync_codex',
  }), /openai-codex/);

  assert.throws(() => updateProviderAuth({
    stateRoot, agentDir, backupDir, provider: 'zai', action: 'set_key',
    apiKey: 'partial-write-check-key', baseUrl: 'https://missing-provider.example/v1',
  }), /models\.json/);
  assert.equal(fs.existsSync(path.join(agentDir, 'auth.json')), false);

  const synced = updateProviderAuth({
    stateRoot, agentDir, backupDir, codexAuthFile: codexFile, provider: 'openai-codex', action: 'sync_codex',
  });
  assert.equal(JSON.stringify(synced).includes('codex-refresh-secret-abc123'), false);
  const codexProvider = synced.providers.find(p => p.provider === 'openai-codex');
  assert.equal(codexProvider.authType, 'oauth');
  assert.equal(codexProvider.expired, false);
  assert.equal(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777, 0o600);

  const stored = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
  assert.equal(stored['openai-codex'].refresh, 'codex-refresh-secret-abc123');
  assert.equal(stored['openai-codex'].accountId, 'acc_synthetic_1');
  assert.equal(stored['openai-codex'].expires, futureExp * 1000);

  fs.writeFileSync(path.join(stateRoot, 'models-catalog.json'), JSON.stringify([
    { provider: 'openai-codex', model: 'gpt-5.4-codex', contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ['text'] },
    { provider: 'openai-codex', model: 'gpt-5.3-codex-spark', contextWindow: 128000, maxTokens: 64000, reasoning: true, input: ['text'] },
    { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ['text'] },
    { provider: 'opencode-go', model: 'deepseek-v4-pro', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text'] },
  ]));
  saveModelSettings(stateRoot, { models: { 'openai-codex/gpt-5.4-codex': { contextWindow: 400000 } } }, { agentDir, backupDir, syncPiModels: false });

  const afterPiRefresh = enrichModels([
    { provider: 'openai-codex', model: 'gpt-5.4-codex', contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ['text'] },
    { provider: 'openai-codex', model: 'gpt-5.3-codex-spark', contextWindow: 128000, maxTokens: 64000, reasoning: true, input: ['text'] },
    { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ['text'] },
    { provider: 'opencode-go', model: 'deepseek-v4-pro', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text'] },
  ], stateRoot);

  const codexMain = afterPiRefresh.find(m => m.model === 'gpt-5.4-codex');
  const spark = afterPiRefresh.find(m => m.model === 'gpt-5.3-codex-spark');
  const opus = afterPiRefresh.find(m => m.model === 'claude-opus-4-6');
  const og = afterPiRefresh.find(m => m.provider === 'opencode-go');
  assert.equal(codexMain.baseContextWindow, 272000);
  assert.equal(codexMain.defaultRecommendedThinking, 'high');
  assert.match(codexMain.description, /Code Review/);
  assert.equal(spark.defaultRecommendedThinking, 'low');
  assert.match(spark.description, /纯文本高速/);
  assert.equal(opus.defaultRecommendedThinking, 'high');
  assert.match(opus.description, /Claude Opus/);
  assert.match(og.description, /OpenCode Go/);

  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'openai-codex': { models: [{ id: 'gpt-5.4-codex', contextWindow: 512000, maxTokens: 128000 }] },
    },
  }));
  saveModelSettings(stateRoot, {
    models: {
      'openai-codex/gpt-5.4-codex': { contextWindow: 1000000 },
      'openai-codex/gpt-5.3-codex-spark': { contextWindow: 1000000 },
    },
  }, { agentDir, backupDir });
  const piUpdated = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(piUpdated.providers['openai-codex'].models[0].contextWindow, 1000000);
  assert.equal(piUpdated.providers['openai-codex'].modelOverrides['gpt-5.3-codex-spark'].contextWindow, 1000000);
  const full1M = enrichModels([
    { provider: 'openai-codex', model: 'gpt-5.4-codex', contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ['text'] },
  ], stateRoot);
  assert.match(full1M[0].description, /1M 上下文/);
});
