import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeDomesticQuota, getProviderQuota } from '../src/quota-providers.js';

test('GLM separates coding window from search allowance and calculates remaining coding percentage', () => {
  const result = normalizeDomesticQuota('zhipu', { success: true, code: 200, data: { level: 'max', limits: [
    { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 27, remaining: 3973, percentage: 1 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 88, nextResetTime: 1791249329638 },
  ] } });
  assert.equal(result.windows[0].kind, 'tool_allowance');
  assert.equal(result.windows[0].windowSeconds, null);
  assert.equal(result.windows[0].remainingCount, 3973);
  assert.equal(result.windows[1].kind, 'five_hour');
  assert.equal(result.windows[1].remainingPercent, 12);
  assert.equal(result.windows[1].resetsAt, '2026-10-06T01:15:29.638Z');
  assert.throws(() => normalizeDomesticQuota('zai', { code: 401, success: false }), /reports failure/);
});

test('MiniMax usage_count means remaining count; token percentages can exist with zero count totals', () => {
  const result = normalizeDomesticQuota('minimax-tokenplan', { base_resp: { status_code: 0 }, model_remains: [
    { model_name: 'general', start_time: 0, end_time: 18000000, current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 99, current_interval_status: 1, current_weekly_remaining_percent: 93 },
    { model_name: 'video', current_interval_total_count: 3, current_interval_usage_count: 1, current_weekly_total_count: 21, current_weekly_usage_count: 0, current_weekly_remaining_percent: 100, current_weekly_status: 3 },
  ] });
  assert.equal(result.windows[0].remainingPercent, 99);
  assert.equal(result.windows[0].kind, 'five_hour');
  assert.equal(result.windows[1].remainingPercent, 93);
  assert.equal(result.windows[2].remainingCount, 1);
  assert.ok(Math.abs(result.windows[2].remainingPercent - 100 / 3) < 1e-8);
  assert.equal(result.windows[3].remainingCount, 0);
  assert.equal(result.windows[3].status, 3);
  assert.equal(result.warnings.length, 1);
});

test('OpenCode Go preserves separate rolling, weekly and monthly lanes; DeepSeek preserves currencies', () => {
  const go = normalizeDomesticQuota('opencode-go', { usage: { rolling: { percent: 7 }, weekly: { percent: 48 }, monthly: { percent: 36 } } });
  assert.deepEqual(go.windows.map(value => value.remainingPercent), [93, 52, 64]);
  assert.equal(go.windows[0].resetsAt, null);
  const deepseek = normalizeDomesticQuota('deepseek', { is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '0.23', granted_balance: '0', topped_up_balance: '0.23' },
    { currency: 'USD', total_balance: '5', granted_balance: '1', topped_up_balance: '4' },
  ] });
  assert.equal(deepseek.balances[0].total, 0.23);
  assert.equal(deepseek.balances[1].currency, 'USD');
  assert.deepEqual(deepseek.windows, []);
  assert.throws(() => normalizeDomesticQuota('opencode-go', { usage: { rolling: { percent: 'invalid' } } }), /invalid percentage/);
});

test('all queries only configured providers, keeps individual failures visible and never changes keys', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-provider-quota-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  const auth = JSON.stringify({ deepseek: { type: 'api_key', key: 'PRIVATE-DEEPSEEK' }, zhipu: { type: 'api_key', key: 'PRIVATE-GLM' }, other: { type: 'api_key', key: 'PRIVATE-OTHER' } });
  await fs.writeFile(path.join(agentDir, 'auth.json'), auth, { mode: 0o600 });
  const urls = [];
  const result = await getProviderQuota({ agentDir, fetchImpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://open.bigmodel.cn/')) {
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE-GLM');
      return new Response('PRIVATE-BODY', { status: 403 });
    }
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE-DEEPSEEK');
    return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.23', granted_balance: '0', topped_up_balance: '0.23' }], email: 'PRIVATE-EMAIL' });
  } });
  assert.equal(urls.length, 2);
  assert.equal(result.results.find(value => value.provider === 'deepseek').status, 'ok');
  assert.equal(result.results.find(value => value.provider === 'zhipu').status, 'error');
  assert.deepEqual(result.unsupportedProviders, ['other']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(await fs.readFile(path.join(agentDir, 'auth.json'), 'utf8'), auth);
  await assert.rejects(getProviderQuota({ provider: 'https://attacker.invalid', agentDir }), /Unsupported/);
});
