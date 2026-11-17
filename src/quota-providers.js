import { readPiAuth, quotaRequest } from './quota-transport.js';
import { getQuota as getCodexQuota } from './quota.js';

// Provider identities select fixed hosts. Never send a Pi key to a caller-supplied URL.
const ENDPOINTS = {
  zhipu: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  'minimax-tokenplan': 'https://api.minimaxi.com/v1/token_plan/remains',
  deepseek: 'https://api.deepseek.com/user/balance',
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
};
export const quotaProviders = ['openai-codex', ...Object.keys(ENDPOINTS)];
const numeric = value => value !== null && value !== '' && ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value)) ? Number(value) : null;
const date = value => {
  const millis = typeof value === 'string' ? Date.parse(value) : numeric(value);
  return millis !== null && Number.isFinite(millis) && Math.abs(millis) <= 8640000000000000 ? new Date(millis).toISOString() : null;
};
const percent = value => {
  const result = numeric(value);
  if (result === null || result < 0 || result > 100) throw new Error('Quota response has an invalid percentage.');
  return result;
};
function window(kind, used, resetsAt, extra = {}) {
  return { kind, usedPercent: used, remainingPercent: used === null ? null : Math.max(0, 100 - used), resetsAt: date(resetsAt), ...extra };
}

export function normalizeDomesticQuota(provider, data) {
  if (provider === 'zhipu' || provider === 'zai') {
    if (data?.success !== true || data.code !== 200 || !Array.isArray(data.data?.limits)) throw new Error('GLM quota response reports failure or has an unknown format.');
    const windows = data.data.limits.map(value => {
      // TIME_LIMIT is the plan's search/reader tool allowance, separate from coding tokens.
      const type = value.type;
      if (typeof type !== 'string' || !Number.isInteger(value.unit) || !Number.isInteger(value.number) || value.number <= 0) throw new Error('GLM quota response contains an invalid window.');
      const seconds = ({ 1: 86400, 3: 3600, 5: 60, 6: 604800 }[value.unit] || 0) * value.number;
      const kind = type === 'TIME_LIMIT' ? 'tool_allowance' : seconds === 18000 ? 'five_hour' : seconds === 604800 ? 'weekly' : 'other';
      const total = numeric(value.usage), usedCount = numeric(value.currentValue);
      const used = total > 0 && usedCount !== null ? usedCount / total * 100 : percent(value.percentage);
      return window(kind, used, value.nextResetTime, { quotaType: type, windowSeconds: type === 'TIME_LIMIT' && value.unit === 5 ? null : seconds || null,
        totalCount: total, usedCount, remainingCount: numeric(value.remaining) });
    });
    return { plan: typeof data.data.level === 'string' ? data.data.level : null, windows };
  }
  if (provider === 'minimax-tokenplan') {
    if (data?.base_resp?.status_code !== 0 || !Array.isArray(data.model_remains)) throw new Error('MiniMax quota response reports failure or has an unknown format.');
    const warnings = [];
    const windows = data.model_remains.flatMap(value => ['interval', 'weekly'].map(period => {
      const prefix = `current_${period}`;
      const total = numeric(value[`${prefix}_total_count`]);
      // Despite its name, *_usage_count is REMAINING count in MiniMax's remains API.
      const remaining = numeric(value[`${prefix}_usage_count`]);
      const remainingPercent = value[`${prefix}_remaining_percent`] == null ? total > 0 && remaining !== null ? remaining / total * 100 : null : percent(value[`${prefix}_remaining_percent`]);
      const start = numeric(value[period === 'weekly' ? 'weekly_start_time' : 'start_time']);
      const end = numeric(value[period === 'weekly' ? 'weekly_end_time' : 'end_time']);
      const seconds = start !== null && end !== null ? (end - start) / 1000 : null;
      if (total > 0 && remaining === 0 && remainingPercent > 0) warnings.push(`${value.model_name || 'service'} ${period}: percentage and remaining count disagree; do not infer availability from percentage alone.`);
      return window(period === 'weekly' ? 'weekly' : seconds === 18000 ? 'five_hour' : 'other', remainingPercent === null ? null : 100 - remainingPercent, end,
        { service: typeof value.model_name === 'string' ? value.model_name : null, windowSeconds: seconds, totalCount: total, remainingCount: remaining, status: numeric(value[`${prefix}_status`]) });
    }));
    return { plan: null, windows, warnings };
  }
  if (provider === 'opencode-go') {
    if (!data?.usage?.rolling) throw new Error('OpenCode Go quota response has an unknown format.');
    return { plan: 'go', windows: ['rolling', 'weekly', 'monthly'].flatMap(period => {
      const value = data.usage[period];
      return value == null ? [] : [window(period === 'rolling' ? 'rolling' : period, percent(value.percent), value.resetsAt, { status: typeof value.status === 'string' ? value.status : null })];
    }) };
  }
  if (provider === 'deepseek') {
    if (typeof data?.is_available !== 'boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new Error('DeepSeek balance response has an unknown format.');
    const balances = data.balance_infos.map(value => {
      const total = numeric(value.total_balance), granted = numeric(value.granted_balance), toppedUp = numeric(value.topped_up_balance);
      if (total === null || granted === null || toppedUp === null || typeof value.currency !== 'string') throw new Error('DeepSeek balance response contains invalid currency amounts.');
      return { currency: value.currency, total, granted, toppedUp };
    });
    return { plan: null, windows: [], available: data.is_available, balances };
  }
  throw new Error('Unsupported quota provider.');
}

/** Query one service, or all supported providers present in Pi; failures never become invented quotas. */
export async function getProviderQuota({ provider = 'all', ...options } = {}) {
  if (provider === 'openai-codex') return getCodexQuota(options);
  if (provider !== 'all' && !Object.hasOwn(ENDPOINTS, provider)) throw new Error('Unsupported quota provider.');
  const auth = await readPiAuth(options.agentDir);
  if (provider === 'all') {
    const selected = quotaProviders.filter(value => auth?.[value]);
    const results = await Promise.all(selected.map(async value => {
      try { return { provider: value, status: 'ok', quota: await getProviderQuota({ ...options, provider: value }) }; }
      catch (error) { return { provider: value, status: 'error', error: error.message }; }
    }));
    return { queriedAt: new Date().toISOString(), results, unsupportedProviders: Object.keys(auth).filter(value => !quotaProviders.includes(value)),
      note: 'Services may share an account; do not add their quotas. Available quota is not spending authorization.' };
  }
  const credential = auth?.[provider];
  if (credential?.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key.trim() || credential.key.trim().startsWith('!')) {
    throw new Error(`${provider} needs an API key stored in Pi auth.json; command-based keys are not executed by quota queries.`);
  }
  const request = quotaRequest(options);
  const data = await request(ENDPOINTS[provider], { Authorization: `Bearer ${credential.key}` }, provider);
  const quota = normalizeDomesticQuota(provider, data);
  return { provider, source: 'provider-api-via-pi-key', queriedAt: new Date().toISOString(), warnings: [], ...quota,
    authorization: 'Account quota is not permission to spend. Follow explicit user task/model/budget authorization; ask before extra paid usage.' };
}
