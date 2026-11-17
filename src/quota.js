import { readPiAuth, quotaRequest } from './quota-transport.js';

const BASE_URL = 'https://chatgpt.com/backend-api/wham/';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const string = value => typeof value === 'string' ? value : null;
const isoSeconds = value => number(value) !== null && value >= 0 && value < 8640000000000 ? new Date(value * 1000).toISOString() : null;

/** Pi owns credential renewal. This reader never copies or changes its auth file. */
export async function readPiCodexCredential({ agentDir, now = Date.now() } = {}) {
  const data = await readPiAuth(agentDir);
  const credential = data?.['openai-codex'];
  if (credential?.type !== 'oauth' || !string(credential.access) || !string(credential.accountId)) {
    throw new Error('Pi openai-codex OAuth credentials are missing; log in with Pi. API keys cannot query ChatGPT plan quota.');
  }
  if (number(credential.expires) === null || credential.expires <= now) {
    throw new Error('Pi Codex OAuth credentials have expired or have no valid expiry; renew them through Pi before querying quota.');
  }
  return { access: credential.access, accountId: credential.accountId };
}

function windows(rateLimit) {
  return ['primary_window', 'secondary_window'].flatMap(slot => {
    const value = rateLimit?.[slot];
    if (value == null) return [];
    const seconds = number(value.limit_window_seconds);
    const used = number(value.used_percent);
    if (seconds === null || seconds <= 0 || used === null || used < 0) throw new Error('Quota response contains an invalid usage window.');
    return [{ kind: seconds === 18000 ? 'five_hour' : seconds === 604800 ? 'weekly' : 'other', windowSeconds: seconds,
      usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: isoSeconds(value.reset_at) }];
  });
}

/** Select explicit fields only: account identity, tokens and reset-card IDs never leave this module. */
export function normalizeUsage(data) {
  if (!data || typeof data !== 'object' || (!data.rate_limit && !data.credits && !data.spend_control)) {
    throw new Error('Unrecognized Codex quota response; no reliable quota fields were returned.');
  }
  const limits = windows(data.rate_limit);
  const balanceValue = data.credits?.balance;
  const balance = typeof balanceValue === 'string' && balanceValue.trim() !== '' ? number(Number(balanceValue)) : number(balanceValue);
  return {
    plan: string(data.plan_type), windows: limits,
    fiveHour: limits.find(value => value.kind === 'five_hour') || null,
    weekly: limits.find(value => value.kind === 'weekly') || null,
    allowed: boolean(data.rate_limit?.allowed), limitReached: boolean(data.rate_limit?.limit_reached),
    spendControlReached: boolean(data.spend_control?.reached),
    credits: { balance, unit: 'credits', hasCredits: boolean(data.credits?.has_credits), unlimited: boolean(data.credits?.unlimited), overageLimitReached: boolean(data.credits?.overage_limit_reached) },
    additionalLimits: Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.map(value => ({ name: string(value.limit_name), windows: windows(value.rate_limit) })) : [],
  };
}

function resetCredits(data) {
  if (!Number.isInteger(data?.available_count) || data.available_count < 0 || !Array.isArray(data.credits)) {
    throw new Error('Unrecognized reset-credit response.');
  }
  return { availableCount: data.available_count, available: data.credits.filter(value => value.status === 'available').map(value => ({
    resetType: string(value.reset_type), supportedByPlan: boolean(value.is_supported_by_plan),
    expiresAt: string(value.expires_at),
  })) };
}

/** Account-scoped GETs only, with bounded requests and no redirects to other credential recipients. */
export async function getQuota({ agentDir, fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const credential = await readPiCodexCredential({ agentDir, now });
  const get = quotaRequest({ fetchImpl, signal });
  const request = endpoint => get(BASE_URL + endpoint, { Authorization: `Bearer ${credential.access}`, 'ChatGPT-Account-Id': credential.accountId }, `Codex ${endpoint}`);
  const usage = normalizeUsage(await request('usage'));
  // Reset inventory is supplementary: failure stays visible without discarding valid usage.
  let inventory = null;
  const warnings = [];
  try { inventory = resetCredits(await request('rate-limit-reset-credits')); }
  catch (error) { warnings.push(error.message); }
  return { provider: 'openai-codex', source: 'chatgpt-wham-via-pi-oauth', queriedAt: new Date().toISOString(),
    ...usage, resetCredits: inventory, warnings,
    authorization: 'Quota is account-wide availability, not permission to spend. Respect explicit user task/model/budget authorization; ask before extra paid usage or using reset credits.',
  };
}
