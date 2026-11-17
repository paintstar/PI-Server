/** Limits are explicit runtime controls, not proof of human consent or estimates of money charged. */
export function agentPolicy(input = {}, model) {
  const allowedModels = input.allowedModels || [model];
  if (!Array.isArray(allowedModels) || !allowedModels.length || allowedModels.some(value => !value.provider || !value.model)) throw new Error('allowedModels must name authorized provider/model pairs');
  const policy = { allowedModels, maxModelRequests: input.maxModelRequests ?? 100000, maxTotalTokens: input.maxTotalTokens ?? 1e12,
    maxRuntimeMs: input.maxRuntimeMs ?? 604800000, maxOutputTokens: input.maxOutputTokens ?? 128000, allowNetwork: input.allowNetwork ?? true,
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}) };
  if (policy.sandboxMode && !['strict', 'dev', 'bypass'].includes(policy.sandboxMode)) throw new Error('sandboxMode must be strict, dev or bypass');
  for (const key of ['maxModelRequests', 'maxTotalTokens', 'maxRuntimeMs', 'maxOutputTokens']) if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error(`${key} must be a positive integer`);
  if (typeof policy.allowNetwork !== 'boolean') throw new Error('allowNetwork must be boolean');
  return policy;
}
export function assertModelAllowed(policy, model) {
  if (!policy.allowedModels.some(value => value.provider === model.provider && value.model === model.model)) throw new Error('Model is outside this agent policy; obtain user authorization before updating allowedModels.');
}
export function reserveRequest(agent, requestId, store) {
  const r = agent.record;
  const receipt = store.create(r.id, { messageId: requestId, direction: 'provider_request' });
  if (receipt.duplicate) {
    if (receipt.record.state !== 'reserved') throw new Error('This provider request was denied');
    return { allowed: true, duplicate: true, maxOutputTokens: r.policy.maxOutputTokens };
  }
  let reason;
  try { assertModelAllowed(r.policy, r.model); } catch (error) { reason = error.message; }
  const tokens = ['input', 'output', 'cacheWrite'].reduce((sum, key) => sum + (r.usage[key] || 0), 0);
  if (r.modelRequests >= r.policy.maxModelRequests) reason = 'Maximum provider request count reached';
  if (tokens >= r.policy.maxTotalTokens) reason = 'Observed token limit reached';
  if (Date.now() - r.runStartedAt >= r.policy.maxRuntimeMs) reason = 'Maximum running time reached';
  if (reason) { store.update(r.id, requestId, { state: 'denied', reason }); r.limitReason = reason; throw new Error(reason); }
  r.modelRequests = (r.modelRequests || 0) + 1;
  store.update(r.id, requestId, { state: 'reserved' });
  const warning = !r.budgetWarned && tokens >= r.policy.maxTotalTokens * 0.8
    ? `[系统提醒] 本代理的 token 用量已达上限的 80%（${tokens}/${r.policy.maxTotalTokens}）。请立刻用 agent_message 汇报已有进展和改动，再继续收尾。` : undefined;
  if (warning) r.budgetWarned = true;
  return { allowed: true, maxOutputTokens: r.policy.maxOutputTokens, ...(warning ? { warning } : {}) };
}
