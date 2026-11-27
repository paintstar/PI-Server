import { estimateRoundedTokens } from './token-estimate.js';

function modelKey(provider, model) {
  return `${provider}/${model}`;
}

async function countActiveCapacity(manager) {
  if (manager.health) {
    const h = await manager.health();
    const used = Number.isInteger(h.liveProcesses) ? h.liveProcesses : (h.activeAgents || 0);
    return { used, max: h.maxAgents || 50 };
  }
  let used = 0;
  for (const agent of manager.agents?.values?.() || []) {
    if (agent.record?.status !== 'closed' && !agent.rpc?.exited) used++;
  }
  return { used, max: manager.maxAgents || 50 };
}

export async function checkCapacity(manager, neededAgents) {
  const { used, max } = await countActiveCapacity(manager);
  const available = Math.max(0, max - used);
  if (used + neededAgents > max) {
    throw new Error(`Insufficient agent capacity: need ${neededAgents}, available ${available} of ${max}`);
  }
  return { used, max, available };
}

export async function preflightBudget(manager, items, { neededAgents = items.length, budgetCapUsd } = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('At least one model invocation is required');
  const catalog = await manager.models(undefined, { includeDisabled: false });
  const byKey = new Map(catalog.map(m => [modelKey(m.provider, m.model), m]));
  const models = [];
  const unknownPricingModels = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let catalogEstimateUsd = 0;

  for (const item of items) {
    const key = modelKey(item.provider, item.model);
    const meta = byKey.get(key);
    if (!meta) throw new Error(`Model unavailable or disabled: ${key}`);
    const estimatedInputTokens = Math.max(1, estimateRoundedTokens(item.promptText || ''));
    const estimatedOutputTokens = Math.max(1, Number(item.expectedOutputTokens) || 1200);
    const inRate = Number(meta.cost?.input || 0);
    const outRate = Number(meta.cost?.output || 0);
    const pricingKnown = inRate > 0 || outRate > 0;
    const itemUsd = pricingKnown ? ((estimatedInputTokens / 1e6) * inRate + (estimatedOutputTokens / 1e6) * outRate) : 0;
    if (!pricingKnown && !unknownPricingModels.includes(key)) unknownPricingModels.push(key);
    totalInputTokens += estimatedInputTokens;
    totalOutputTokens += estimatedOutputTokens;
    catalogEstimateUsd += itemUsd;
    models.push({
      provider: item.provider,
      model: item.model,
      estimatedInputTokens,
      estimatedOutputTokens,
      catalogEstimateUsd: Math.round(itemUsd * 1e6) / 1e6,
      pricingKnown,
    });
  }

  const capacity = await checkCapacity(manager, neededAgents);
  const roundedUsd = Math.round(catalogEstimateUsd * 1e6) / 1e6;
  const pricingComplete = unknownPricingModels.length === 0;
  if (budgetCapUsd !== undefined && roundedUsd > budgetCapUsd) {
    throw new Error(`Estimated catalog cost $${roundedUsd.toFixed(4)} exceeds budgetCapUsd $${budgetCapUsd}`);
  }

  return {
    models,
    totalInputTokens,
    totalOutputTokens,
    catalogEstimateUsd: roundedUsd,
    unknownPricingModels,
    pricingComplete,
    capacity,
    ...(budgetCapUsd !== undefined && !pricingComplete
      ? { budgetWarning: `Catalog pricing unavailable for: ${unknownPricingModels.join(', ')}` }
      : {}),
    pricingNote: 'Static catalog estimate, not actual billing',
  };
}
