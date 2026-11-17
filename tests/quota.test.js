import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getQuota, normalizeUsage } from '../src/quota.js';

const usage = { account_id: 'PRIVATE-ID', email: 'private@example.invalid', plan_type: 'pro',
  rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 28, limit_window_seconds: 604800, reset_at: 1791779687 }, secondary_window: null },
  credits: { balance: '62496.674979', has_credits: true, unlimited: false }, spend_control: { reached: false } };
async function credentials(t, value = { type: 'oauth', access: 'PRIVATE-TOKEN', refresh: 'PRIVATE-REFRESH', accountId: 'PRIVATE-ID', expires: Date.now() + 60000 }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-quota-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ 'openai-codex': value }), { mode: 0o600 });
  return directory;
}

test('weekly primary window is classified by duration; missing five-hour window remains unknown', () => {
  const result = normalizeUsage(usage);
  assert.equal(result.weekly.remainingPercent, 72);
  assert.equal(result.weekly.resetsAt, '2026-10-12T04:34:47.000Z');
  assert.equal(result.fiveHour, null);
  assert.equal(result.credits.balance, 62496.674979);
  const reversed = normalizeUsage({ ...usage, rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000 }, secondary_window: usage.rate_limit.primary_window } });
  assert.equal(reversed.fiveHour.remainingPercent, 92);
  assert.equal(reversed.weekly.remainingPercent, 72);
  assert.equal(reversed.fiveHour.resetsAt, null);
  assert.equal(normalizeUsage({ credits: {} }).credits.balance, null);
  assert.throws(() => normalizeUsage({ error: 'private server response' }), /Unrecognized/);
  assert.throws(() => normalizeUsage({ rate_limit: { primary_window: {} } }), /invalid usage/);
});

test('reads Pi OAuth, makes account-scoped GETs, strips identity and preserves credential file', async t => {
  const agentDir = await credentials(t);
  const before = await fs.readFile(path.join(agentDir, 'auth.json'));
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'PRIVATE-ID');
    assert.ok(options.signal);
    return Response.json(url.endsWith('/usage') ? usage : { available_count: 1, credits: [
      { id: 'PRIVATE-CARD', status: 'available', reset_type: 'codexRateLimits', expires_at: '2026-10-29T00:00:00Z' },
      { id: 'used-card', status: 'redeemed' },
    ] });
  };
  const result = await getQuota({ agentDir, fetchImpl });
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits']);
  assert.equal(result.resetCredits.availableCount, 1);
  assert.equal(result.resetCredits.available.length, 1);
  assert.deepEqual(result.warnings, []);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('private@example'));
  assert.deepEqual(await fs.readFile(path.join(agentDir, 'auth.json')), before);
});

test('expired and API-key credentials fail before any network call or credential write', async t => {
  for (const credential of [{ type: 'api_key', key: 'SECRET' }, { type: 'oauth', access: 'SECRET', accountId: 'ID', expires: 1 }]) {
    const agentDir = await credentials(t, credential);
    const before = await fs.readFile(path.join(agentDir, 'auth.json'));
    await assert.rejects(getQuota({ agentDir, fetchImpl: () => assert.fail('unexpected network') }), /OAuth credentials|expired/);
    assert.deepEqual(await fs.readFile(path.join(agentDir, 'auth.json')), before);
  }
});

test('main endpoint errors are explicit and never expose server bodies or network secrets', async t => {
  const agentDir = await credentials(t);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(getQuota({ agentDir, fetchImpl: async () => new Response('SECRET', { status }) }), error => error.message.includes(`HTTP ${status}`) && !error.message.includes('SECRET'));
  }
  await assert.rejects(getQuota({ agentDir, fetchImpl: async () => { throw new Error('PRIVATE-TOKEN'); } }), /request failed or timed out/);
  await assert.rejects(getQuota({ agentDir, fetchImpl: async () => new Response('PRIVATE-TOKEN') }), /invalid or oversized JSON/);
});

test('reset inventory failure retains valid usage with visible warning and unknown inventory', async t => {
  const agentDir = await credentials(t);
  const result = await getQuota({ agentDir, fetchImpl: async url => url.endsWith('/usage') ? Response.json(usage) : new Response('PRIVATE', { status: 403 }) });
  assert.equal(result.weekly.remainingPercent, 72);
  assert.equal(result.resetCredits, null);
  assert.match(result.warnings[0], /HTTP 403/);
});
