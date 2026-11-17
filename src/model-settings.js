import fs from 'node:fs';
import path from 'node:path';
import { PiProcess } from './rpc-client.js';
import { atomicWriteJson, readJsonSafe } from './storage.js';
import { buildEnrichedModels, PI_TOOLS_MANIFEST, VALID_SANDBOX, VALID_THINKING } from './model-profiles.js';
import {
  applyProviderAuthUpdate,
  backupFile,
  BLOCKED_KEYS,
  defaultBackupDir,
  isValidProviderName,
  readJsonStrictIfExists,
  readMaskedAuthMap,
  resolvePiAgentDir,
  runProviderAuthCheck,
} from './provider-auth.js';

export { defaultModelProfile, filterModelProfiles, PI_TOOLS_MANIFEST } from './model-profiles.js';
export { maskSecret, readMaskedAuthMap, resolvePiAgentDir } from './provider-auth.js';

const inflightCatalogs = new Map();

function parseModelKey(key) {
  if (typeof key !== 'string' || !/^[^/\s]+\/.+$/.test(key) || key.length > 200) {
    throw new Error(`不合法的模型键：${key}`);
  }
  const slash = key.indexOf('/');
  const provider = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  if (!isValidProviderName(provider) || BLOCKED_KEYS.has(modelId)) {
    throw new Error(`不合法的模型键：${key}`);
  }
  return { provider, modelId };
}

export function defaultModelSettings() {
  return {
    providers: {},
    models: {},
    defaults: {
      sandboxMode: null,
      allowNetwork: true,
      thinking: 'high',
      loadSkills: true,
      loadContextFiles: true,
    },
    updatedAt: null,
  };
}

export function readModelSettings(stateRoot) {
  const base = defaultModelSettings();
  if (!stateRoot) return base;
  const saved = readJsonStrictIfExists(path.join(stateRoot, 'model-settings.json'), 'model-settings.json');
  if (!saved) return base;
  const providers = {};
  if (saved.providers && typeof saved.providers === 'object') {
    for (const [key, value] of Object.entries(saved.providers)) {
      if (isValidProviderName(key) && value && typeof value === 'object' && typeof value.enabled === 'boolean') {
        providers[key] = { enabled: value.enabled };
      }
    }
  }
  const models = {};
  if (saved.models && typeof saved.models === 'object') {
    for (const [key, value] of Object.entries(saved.models)) {
      if (value && typeof value === 'object' && !BLOCKED_KEYS.has(key.split('/')[1])) {
        models[key] = { ...value };
      }
    }
  }
  const d = saved.defaults && typeof saved.defaults === 'object' ? saved.defaults : {};
  return {
    providers,
    models,
    defaults: {
      sandboxMode: VALID_SANDBOX.has(d.sandboxMode) ? d.sandboxMode : null,
      allowNetwork: typeof d.allowNetwork === 'boolean' ? d.allowNetwork : base.defaults.allowNetwork,
      thinking: VALID_THINKING.has(d.thinking) ? d.thinking : base.defaults.thinking,
      loadSkills: typeof d.loadSkills === 'boolean' ? d.loadSkills : base.defaults.loadSkills,
      loadContextFiles: typeof d.loadContextFiles === 'boolean' ? d.loadContextFiles : base.defaults.loadContextFiles,
    },
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
  };
}

export function catalogFilesStamp(stateRoot, agentDir) {
  const piDir = resolvePiAgentDir(agentDir);
  const files = [
    path.join(piDir, 'auth.json'),
    path.join(piDir, 'models.json'),
    ...(stateRoot ? [path.join(stateRoot, 'model-settings.json')] : []),
  ];
  return files.map(file => {
    try { return `${fs.statSync(file).mtimeMs}`; }
    catch (error) {
      if (error?.code === 'ENOENT') return '0';
      throw error;
    }
  }).join(':');
}

export function enrichModels(rawModels, stateRoot, options = {}) {
  const settings = readModelSettings(stateRoot);
  const existing = stateRoot ? readJsonSafe(path.join(stateRoot, 'models-catalog.json')) : null;
  const prevMap = new Map((Array.isArray(existing) ? existing : []).map(item => [`${item.provider}/${item.model || item.id}`, item]));
  const withBaseline = (rawModels || []).map(raw => {
    const key = `${raw.provider}/${raw.model || raw.id}`;
    const prev = prevMap.get(key);
    const ov = Object.hasOwn(settings.models, key) ? settings.models[key] : null;
    if (!prev || !ov) return raw;
    return {
      ...raw,
      ...(raw.baseContextWindow === undefined && ov.contextWindow !== undefined && prev.baseContextWindow != null ? { baseContextWindow: prev.baseContextWindow } : {}),
      ...(raw.baseMaxTokens === undefined && ov.maxTokens !== undefined && prev.baseMaxTokens != null ? { baseMaxTokens: prev.baseMaxTokens } : {}),
    };
  });
  return buildEnrichedModels(withBaseline, settings, options);
}

function parseBoundedInt(raw, min, max, message) {
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
    throw new Error(message);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(message);
  return value;
}

function validateModelOverride(entry) {
  const clean = {};
  if (entry.enabled !== undefined) {
    if (typeof entry.enabled !== 'boolean') throw new Error('模型 enabled 必须为布尔值');
    clean.enabled = entry.enabled;
  }
  if (entry.contextWindow !== undefined) {
    clean.contextWindow = entry.contextWindow === null
      ? null
      : parseBoundedInt(entry.contextWindow, 1024, 10_000_000, '上下文窗口必须是 1024 到 10000000 之间的整数');
  }
  if (entry.maxTokens !== undefined) {
    clean.maxTokens = entry.maxTokens === null
      ? null
      : parseBoundedInt(entry.maxTokens, 1, 2_000_000, '最大输出 Token 必须是 1 到 2000000 之间的整数');
  }
  if (entry.description !== undefined) {
    if (entry.description === null) clean.description = null;
    else {
      if (typeof entry.description !== 'string') throw new Error('模型能力描述必须为字符串');
      const text = entry.description.trim();
      if (text.length > 2000) throw new Error('模型能力描述不能超过 2000 字');
      clean.description = text || null;
    }
  }
  if (entry.recommendedThinking !== undefined) {
    if (entry.recommendedThinking === null || entry.recommendedThinking === '') clean.recommendedThinking = null;
    else if (typeof entry.recommendedThinking !== 'string' || !VALID_THINKING.has(entry.recommendedThinking)) {
      throw new Error('推荐思考强度不合法');
    } else clean.recommendedThinking = entry.recommendedThinking;
  }
  return clean;
}

function syncPiModelsJson(modelsUpdates, catalog, { agentDir, backupDir, stateRoot }) {
  const piDir = resolvePiAgentDir(agentDir);
  const modelsFile = path.join(piDir, 'models.json');
  const existing = readJsonStrictIfExists(modelsFile, 'Pi models.json');
  const authMap = readMaskedAuthMap(piDir);
  if (!existing && !Object.keys(authMap).length && !catalog.length) return;
  const piModels = existing
    ? { ...existing, providers: existing.providers && typeof existing.providers === 'object' ? { ...existing.providers } : {} }
    : { providers: {} };
  let dirty = false;
  for (const [key, patch] of Object.entries(modelsUpdates)) {
    if (patch.contextWindow === undefined && patch.maxTokens === undefined) continue;
    const { provider, modelId } = parseModelKey(key);
    const catalogItem = catalog.find(item => item.provider === provider && (item.model || item.id) === modelId);
    const hasProvider = Object.hasOwn(piModels.providers, provider);
    if (!hasProvider && ((!Object.hasOwn(authMap, provider) && !catalogItem) || (patch.contextWindow === null && patch.maxTokens === null))) continue;
    if (!hasProvider) piModels.providers[provider] = {};
    const pConfig = piModels.providers[provider];
    if (!pConfig || typeof pConfig !== 'object') continue;
    const listEntry = Array.isArray(pConfig.models) ? pConfig.models.find(item => item.id === modelId) : null;
    if (listEntry) {
      if (patch.contextWindow !== undefined) {
        const nextVal = patch.contextWindow === null ? catalogItem?.baseContextWindow : patch.contextWindow;
        if (Number.isInteger(nextVal) && listEntry.contextWindow !== nextVal) { listEntry.contextWindow = nextVal; dirty = true; }
      }
      if (patch.maxTokens !== undefined) {
        const nextVal = patch.maxTokens === null ? catalogItem?.baseMaxTokens : patch.maxTokens;
        if (Number.isInteger(nextVal) && listEntry.maxTokens !== nextVal) { listEntry.maxTokens = nextVal; dirty = true; }
      }
    } else {
      pConfig.modelOverrides ||= {};
      const prev = Object.hasOwn(pConfig.modelOverrides, modelId) ? pConfig.modelOverrides[modelId] : null;
      const ov = { ...(prev || {}) };
      if (patch.contextWindow === null) delete ov.contextWindow;
      else if (patch.contextWindow !== undefined) ov.contextWindow = patch.contextWindow;
      if (patch.maxTokens === null) delete ov.maxTokens;
      else if (patch.maxTokens !== undefined) ov.maxTokens = patch.maxTokens;
      if (JSON.stringify(prev || null) !== JSON.stringify(Object.keys(ov).length ? ov : null)) {
        if (Object.keys(ov).length) pConfig.modelOverrides[modelId] = ov;
        else delete pConfig.modelOverrides[modelId];
        if (!hasProvider && !Object.keys(pConfig.modelOverrides).length) delete piModels.providers[provider];
        dirty = true;
      }
    }
  }
  if (!dirty) return;
  fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
  backupFile(modelsFile, backupDir || defaultBackupDir(stateRoot, piDir), 'models');
  atomicWriteJson(modelsFile, piModels, { pretty: true });
  fs.chmodSync(modelsFile, 0o600);
}

function applyDefaultsPatch(defaults, patch) {
  if (patch.sandboxMode !== undefined) {
    if (patch.sandboxMode === null || patch.sandboxMode === '') defaults.sandboxMode = null;
    else if (VALID_SANDBOX.has(patch.sandboxMode)) defaults.sandboxMode = patch.sandboxMode;
    else throw new Error('默认沙箱档位不合法');
  }
  if (patch.allowNetwork !== undefined) {
    if (typeof patch.allowNetwork !== 'boolean') throw new Error('默认联网开关必须为布尔值');
    defaults.allowNetwork = patch.allowNetwork;
  }
  if (patch.thinking !== undefined) {
    if (!VALID_THINKING.has(patch.thinking)) throw new Error('默认思考强度不合法');
    defaults.thinking = patch.thinking;
  }
  if (patch.loadSkills !== undefined) {
    if (typeof patch.loadSkills !== 'boolean') throw new Error('Skills 开关必须为布尔值');
    defaults.loadSkills = patch.loadSkills;
  }
  if (patch.loadContextFiles !== undefined) {
    if (typeof patch.loadContextFiles !== 'boolean') throw new Error('AGENTS 开关必须为布尔值');
    defaults.loadContextFiles = patch.loadContextFiles;
  }
}

export function saveModelSettings(stateRoot, patch, { agentDir, backupDir, syncPiModels = true } = {}) {
  if (!stateRoot) throw new Error('Missing stateRoot');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings payload');
  const next = readModelSettings(stateRoot);
  if (patch.providers && typeof patch.providers === 'object') {
    for (const [provider, value] of Object.entries(patch.providers)) {
      if (!isValidProviderName(provider)) throw new Error(`不合法的服务商名称：${provider}`);
      if (value && typeof value === 'object' && typeof value.enabled === 'boolean') next.providers[provider] = { enabled: value.enabled };
    }
  }
  const appliedModels = {};
  if (patch.models && typeof patch.models === 'object') {
    for (const [key, value] of Object.entries(patch.models)) {
      parseModelKey(key);
      if (value === null) {
        delete next.models[key];
        appliedModels[key] = { contextWindow: null, maxTokens: null };
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const clean = validateModelOverride(value);
      const merged = { ...(Object.hasOwn(next.models, key) ? next.models[key] : {}), ...clean };
      for (const field of ['contextWindow', 'maxTokens', 'description', 'recommendedThinking']) {
        if (merged[field] === null) delete merged[field];
      }
      if (Object.keys(merged).length) next.models[key] = merged;
      else delete next.models[key];
      appliedModels[key] = clean;
    }
  }
  if (patch.defaults && typeof patch.defaults === 'object') applyDefaultsPatch(next.defaults, patch.defaults);
  next.updatedAt = new Date().toISOString();
  atomicWriteJson(path.join(stateRoot, 'model-settings.json'), next, { pretty: true });
  const catalogFile = path.join(stateRoot, 'models-catalog.json');
  const existingCatalog = readJsonSafe(catalogFile);
  if (syncPiModels && Object.keys(appliedModels).length) {
    syncPiModelsJson(appliedModels, Array.isArray(existingCatalog) ? existingCatalog : [], { agentDir, backupDir, stateRoot });
  }
  if (Array.isArray(existingCatalog)) {
    atomicWriteJson(catalogFile, enrichModels(existingCatalog, stateRoot, { includeDisabled: true }));
  }
  return next;
}

export function updateProviderAuth(options) {
  const { piDir, backups } = applyProviderAuthUpdate(options);
  if (typeof options.enabled === 'boolean' && options.stateRoot) {
    saveModelSettings(
      options.stateRoot,
      { providers: { [options.provider]: { enabled: options.enabled } } },
      { agentDir: piDir, backupDir: backups, syncPiModels: false },
    );
  }
  return buildSettingsPayload({ stateRoot: options.stateRoot, agentDir: piDir });
}

export async function checkProviderAuth(options) {
  const res = await runProviderAuthCheck(options);
  return {
    provider: res.provider,
    ok: res.ok,
    status: res.status,
    authType: res.authType,
    reason: res.reason,
    settings: buildSettingsPayload({ stateRoot: options.stateRoot, agentDir: res.piDir }),
  };
}

export async function fetchPiRawModels({ executable = process.env.PI_EXECUTABLE || 'pi', cwd, agentDir, processFactory }) {
  const piDir = resolvePiAgentDir(agentDir);
  const options = {
    executable,
    args: ['--mode', 'rpc', '--no-session', '--offline', '--no-extensions'],
    cwd: cwd || piDir,
    ...(piDir ? { env: { PI_CODING_AGENT_DIR: piDir } } : {}),
  };
  const rpc = processFactory ? processFactory(options) : new PiProcess(options);
  try {
    return (await rpc.command('get_available_models')).models || [];
  } finally {
    await rpc.close();
  }
}

export async function refreshPiCatalog({ stateRoot, executable = process.env.PI_EXECUTABLE || 'pi', agentDir }) {
  const piDir = resolvePiAgentDir(agentDir);
  const stamp = catalogFilesStamp(stateRoot, piDir);
  const key = `${stateRoot || ''}:${piDir}:${stamp}`;
  if (!inflightCatalogs.has(key)) {
    const job = (async () => {
      const raw = await fetchPiRawModels({ executable, cwd: stateRoot || piDir, agentDir: piDir });
      const enriched = enrichModels(raw, stateRoot, { includeDisabled: true });
      if (stateRoot && catalogFilesStamp(stateRoot, piDir) === stamp) {
        atomicWriteJson(path.join(stateRoot, 'models-catalog.json'), enriched);
      }
      return enriched;
    })().finally(() => inflightCatalogs.delete(key));
    inflightCatalogs.set(key, job);
  }
  return inflightCatalogs.get(key);
}

export function buildSettingsPayload({ stateRoot, agentDir } = {}) {
  const piDir = resolvePiAgentDir(agentDir);
  const settings = readModelSettings(stateRoot);
  const authMap = readMaskedAuthMap(piDir);
  const piModels = readJsonStrictIfExists(path.join(piDir, 'models.json'), 'Pi models.json');
  const rawCatalog = stateRoot ? readJsonSafe(path.join(stateRoot, 'models-catalog.json')) : null;
  const models = enrichModels(Array.isArray(rawCatalog) ? rawCatalog : [], stateRoot, { includeDisabled: true });
  const piProviders = piModels?.providers && typeof piModels.providers === 'object' ? piModels.providers : {};
  const providerNames = new Set([
    ...Object.keys(authMap),
    ...Object.keys(piProviders).filter(isValidProviderName),
    ...models.map(item => item.provider).filter(isValidProviderName),
    ...Object.keys(settings.providers),
  ]);
  const providers = [...providerNames].sort().map(provider => {
    const list = models.filter(item => item.provider === provider);
    const auth = Object.hasOwn(authMap, provider) ? authMap[provider] : { configured: false, type: null, masked: null, expiresAt: null, expired: false };
    const pConfig = Object.hasOwn(piProviders, provider) ? piProviders[provider] : null;
    const enabled = Object.hasOwn(settings.providers, provider) ? settings.providers[provider].enabled !== false : true;
    return {
      provider,
      enabled,
      configured: auth.configured,
      authType: auth.type,
      maskedKey: auth.masked,
      expiresAt: auth.expiresAt,
      expired: auth.expired,
      baseUrl: typeof pConfig?.baseUrl === 'string' ? pConfig.baseUrl : null,
      totalModelsCount: list.length,
      enabledModelsCount: list.filter(item => item.enabled).length,
    };
  });
  return { providers, models, defaults: settings.defaults, subagentTools: PI_TOOLS_MANIFEST, updatedAt: settings.updatedAt };
}
