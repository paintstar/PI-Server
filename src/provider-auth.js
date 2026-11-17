import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteJson } from './storage.js';

const execFileAsync = promisify(execFile);
const PROVIDER_NAME_RE = /^[a-zA-Z0-9._-]{1,80}$/;
export const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isValidProviderName(name) {
  return typeof name === 'string' && PROVIDER_NAME_RE.test(name) && !BLOCKED_KEYS.has(name);
}

export function resolvePiAgentDir(agentDir) {
  let directory = agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  if (directory === '~') return os.homedir();
  if (directory.startsWith('~/')) return path.join(os.homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function readJsonStrictIfExists(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 结构不是对象`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`无法解析 ${label}：${error.message}`);
  }
}

export function backupFile(source, backupDir, prefix) {
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}${path.extname(source)}`);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  return target;
}

export function defaultBackupDir(stateRoot, agentDir) {
  return stateRoot ? path.join(stateRoot, 'config-backups') : path.join(resolvePiAgentDir(agentDir), 'config-backups');
}

export function maskSecret(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('!')) return '命令动态获取 (!…)';
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}

export function readMaskedAuthMap(agentDir) {
  const file = path.join(resolvePiAgentDir(agentDir), 'auth.json');
  const data = readJsonStrictIfExists(file, 'Pi auth.json');
  if (!data) return {};
  const now = Date.now();
  const map = {};
  for (const [provider, cred] of Object.entries(data)) {
    if (!isValidProviderName(provider) || !cred || typeof cred !== 'object') continue;
    if (cred.type === 'oauth') {
      const expires = typeof cred.expires === 'number' && Number.isFinite(cred.expires) ? cred.expires : null;
      const expired = expires === null || expires <= now;
      map[provider] = {
        configured: Boolean(cred.access || cred.refresh),
        type: 'oauth',
        masked: expired ? 'OAuth 凭据已过期' : 'OAuth 已授权',
        expiresAt: expires ? new Date(expires).toISOString() : null,
        expired,
      };
      continue;
    }
    const key = typeof cred.key === 'string' ? cred.key : '';
    map[provider] = {
      configured: Boolean(key.trim()),
      type: cred.type || 'api_key',
      masked: maskSecret(key),
      expiresAt: null,
      expired: false,
    };
  }
  return map;
}

export function validateBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new Error('Base URL 格式不正确'); }
  const isLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error('Base URL 仅支持 HTTPS 或本机 HTTP 地址');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function readCodexOAuth(codexAuthFile) {
  const file = codexAuthFile || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const data = readJsonStrictIfExists(file, '本机 Codex auth.json');
  const tokens = data?.tokens;
  const access = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
  const refresh = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
  if (!access || !refresh) throw new Error('本机 Codex 凭据不存在或缺少 tokens，请先在终端完成 codex login');
  const parts = access.split('.');
  if (parts.length !== 3) throw new Error('本机 Codex access_token 格式无效');
  let expMs;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error('缺少 exp');
    expMs = payload.exp * 1000;
  } catch {
    throw new Error('无法解析本机 Codex 凭据有效期');
  }
  if (expMs <= Date.now()) throw new Error('本机 Codex 登录凭据已过期，请先重新执行 codex login');
  const accountId = typeof tokens?.account_id === 'string' && tokens.account_id.trim() ? tokens.account_id.trim() : undefined;
  return { type: 'oauth', access, refresh, expires: expMs, ...(accountId ? { accountId } : {}) };
}

export function applyProviderAuthUpdate({ stateRoot, agentDir, backupDir, codexAuthFile, provider, action, apiKey, baseUrl }) {
  if (!isValidProviderName(provider)) throw new Error('服务商名称不合法');
  if (!['set_key', 'clear_key', 'toggle', 'set_base_url', 'sync_codex'].includes(action)) {
    throw new Error('不支持的凭据操作');
  }
  if (action === 'sync_codex' && provider !== 'openai-codex') {
    throw new Error('仅支持从本机 Codex 同步 openai-codex 凭据');
  }
  const piDir = resolvePiAgentDir(agentDir);
  const backups = backupDir || defaultBackupDir(stateRoot, piDir);
  const authFile = path.join(piDir, 'auth.json');
  let nextAuthCred = null;
  let shouldWriteAuth = false;
  let auth = null;

  if (action === 'set_key' || action === 'clear_key' || action === 'sync_codex') {
    auth = readJsonStrictIfExists(authFile, 'Pi auth.json') || {};
    if (action === 'set_key') {
      const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!cleanKey || cleanKey.length > 4000 || /[\r\n]/.test(cleanKey)) {
        throw new Error('API Key 不能为空，且不能包含换行或超过 4000 字符');
      }
      nextAuthCred = { type: 'api_key', key: cleanKey };
      shouldWriteAuth = true;
    } else if (action === 'sync_codex') {
      nextAuthCred = readCodexOAuth(codexAuthFile);
      shouldWriteAuth = true;
    } else if (Object.hasOwn(auth, provider)) {
      shouldWriteAuth = true;
    }
  }

  let modelsFile = null;
  let piModels = null;
  let normalizedUrl = null;
  let pConfig = null;
  if (baseUrl !== undefined && action !== 'toggle') {
    normalizedUrl = validateBaseUrl(baseUrl);
    modelsFile = path.join(piDir, 'models.json');
    piModels = readJsonStrictIfExists(modelsFile, 'Pi models.json');
    pConfig = piModels?.providers && Object.hasOwn(piModels.providers, provider) ? piModels.providers[provider] : null;
    if (normalizedUrl && !pConfig) {
      throw new Error(`Pi models.json 中未定义服务商 ${provider}，无法单独修改接口地址`);
    }
  }

  if (shouldWriteAuth) {
    backupFile(authFile, backups, 'auth');
    if (nextAuthCred) auth[provider] = nextAuthCred;
    else delete auth[provider];
    fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
    atomicWriteJson(authFile, auth, { pretty: true });
    fs.chmodSync(authFile, 0o600);
  }
  if (pConfig && (normalizedUrl ? pConfig.baseUrl !== normalizedUrl : Object.hasOwn(pConfig, 'baseUrl'))) {
    backupFile(modelsFile, backups, 'models');
    if (normalizedUrl) pConfig.baseUrl = normalizedUrl;
    else delete pConfig.baseUrl;
    atomicWriteJson(modelsFile, piModels, { pretty: true });
    fs.chmodSync(modelsFile, 0o600);
  }
  return { piDir, backups };
}

export async function runProviderAuthCheck({ executable = process.env.PI_EXECUTABLE || 'pi', agentDir, provider }) {
  if (!isValidProviderName(provider)) throw new Error('服务商名称不合法');
  const piDir = resolvePiAgentDir(agentDir);
  const env = { ...process.env, PI_CODING_AGENT_DIR: piDir };
  let raw = '';
  let exitCode = 0;
  try {
    const out = await execFileAsync(executable, ['auth', 'check', '--provider', provider, '--json'], { timeout: 15000, env });
    raw = out.stdout || '';
  } catch (error) {
    raw = error?.stdout || '';
    exitCode = typeof error?.code === 'number' ? error.code : 1;
    if (!raw.trim()) throw new Error(error?.stderr?.trim() || error?.message || '检查 Pi 凭据失败');
  }
  let parsed;
  try { parsed = JSON.parse(raw.trim().split('\n').pop()); }
  catch { parsed = { status: exitCode === 0 ? 'ready' : 'error', provider, reason: raw.trim().slice(0, 200) }; }
  return {
    provider,
    piDir,
    ok: parsed.status === 'ready',
    status: parsed.status || (exitCode === 0 ? 'ready' : 'invalid'),
    authType: parsed.authType || null,
    reason: parsed.reason || null,
  };
}
