import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateRoundedTokens } from './token-estimate.js';
import { readJsonSafe } from './storage.js';
import { sandboxHealth, sandboxMode } from './tool-sandbox.js';
import { inspectOpencodeConfig } from './opencode-config.js';
import { readModelSettings } from './model-settings.js';

const RUN_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting', 'finishing', 'idle']);
const SECTION_NAMES = {
  preamble: '角色说明',
  tools: '工具说明',
  rules: '规则',
  docs: '文档',
  addendum: '附加说明',
  project_context: '项目说明',
  skills: '技能列表',
  cwd: '工作目录',
};
const MINUTE_MS = 60 * 1000;

export const isRunId = id => typeof id === 'string' && RUN_ID_RE.test(id);

function clipValue(value, limit = 6000) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字）` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => clipValue(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, clipValue(item, limit)]));
  return value;
}

const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');

export function transcriptMessage(entry, index = 0) {
  if (entry.type !== 'message' || !entry.message) return null;
  const m = entry.message;
  const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  const base = { id: entry.id || `${entry.timestamp}-${index}`, role: m.role, time: entry.timestamp };
  if (m.role === 'toolResult') {
    const text = textOf(blocks);
    return {
      ...base,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      isError: !!m.isError,
      durationMs: m.durationMs,
      text: text.length > 6000 ? `…\n${text.slice(-6000)}` : text,
      diff: typeof m.details?.diff === 'string' ? m.details.diff.slice(0, 12000) : undefined,
      answer: typeof m.details?.answer === 'string' ? m.details.answer.slice(0, 6000) : undefined,
    };
  }
  const thinkingBlocks = blocks.filter(b => b.type === 'thinking');
  const thinking = thinkingBlocks.map(b => b.thinking || '').filter(Boolean).join('\n\n');
  const calls = blocks.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, name: b.name, arguments: clipValue(b.arguments || {}) }));
  const text = textOf(blocks).slice(-12000);
  if (!text && !calls.length && !thinkingBlocks.length && m.role !== 'assistant') return null;
  return {
    ...base,
    text,
    calls,
    startedAt: typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : undefined,
    thinking: thinking.slice(-8000) || undefined,
    thinkingRedacted: thinkingBlocks.length > 0 && !thinking,
    stopReason: m.stopReason,
    error: m.stopReason === 'error' ? String(m.errorMessage || '').slice(0, 2000) : undefined,
  };
}

export function requestSpeeds(entries, limit = 40) {
  const speeds = [];
  for (const entry of entries) {
    const m = entry.message;
    if (entry.type !== 'message' || m?.role !== 'assistant' || !m.usage || typeof m.timestamp !== 'number') continue;
    const end = Date.parse(entry.timestamp);
    const seconds = (end - m.timestamp) / 1000;
    if (!(seconds > 0.2) || !m.usage.output) continue;
    speeds.push({ at: entry.timestamp, output: m.usage.output, seconds: Math.round(seconds * 100) / 100, tps: Math.round(m.usage.output / seconds * 10) / 10 });
  }
  return speeds.slice(-limit);
}

export function estimateTokens(text = '') {
  return estimateRoundedTokens(text);
}

export function contextAnalysis(head, entries, contextWindow) {
  const system = [...head, ...entries].find(e => e.type === 'message' && e.message?.role === 'system')?.message;
  const sections = Object.entries(system?.sections || {}).map(([key, value]) => ({ key, name: SECTION_NAMES[key] || key, tokens: estimateTokens(String(value)) })).filter(s => s.tokens > 0);
  const parts = { user: 0, assistant: 0, thinking: 0, toolCalls: 0, toolResults: 0 };
  const series = [];
  let compactions = 0;
  for (const entry of entries) {
    if (entry.type === 'compaction' || entry.type === 'compaction_summary') compactions++;
    const m = entry.message;
    if (entry.type !== 'message' || !m) continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const b of blocks) {
      const size = estimateTokens(b.type === 'thinking' ? b.thinking || '' : b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : b.text || '');
      if (m.role === 'user') parts.user += size;
      else if (m.role === 'toolResult') parts.toolResults += size;
      else if (m.role === 'assistant') parts[b.type === 'thinking' ? 'thinking' : b.type === 'toolCall' ? 'toolCalls' : 'assistant'] += size;
    }
    if (m.role === 'assistant' && m.usage) {
      const used = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      if (used) series.push({ at: entry.timestamp, used, cached: m.usage.cacheRead || 0, output: m.usage.output || 0, reasoning: m.usage.reasoning || 0 });
    }
  }
  const latest = series.at(-1);
  return {
    contextWindow: contextWindow || null,
    used: latest?.used || 0,
    cached: latest?.cached || 0,
    peak: Math.max(0, ...series.map(s => s.used)),
    series: series.slice(-120),
    sections,
    parts,
    compactions,
    requests: series.length,
  };
}

export function pullRequestLinks(entries) {
  const found = new Map();
  const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  for (const entry of entries) {
    const m = entry.message;
    if (entry.type !== 'message' || !m || m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const text = blocks.map(b => b.text || (b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : '')).join('\n');
    for (const match of text.matchAll(pattern)) {
      const url = match[0];
      const item = found.get(url) || { url, repo: match[1], number: Number(match[2]), firstAt: entry.timestamp, merged: false, created: false };
      if (/merged|已合并|gh pr merge/i.test(text)) item.merged = true;
      if (/gh pr create|Creating pull request|created pull request/i.test(text)) item.created = true;
      item.lastAt = entry.timestamp;
      found.set(url, item);
    }
  }
  return [...found.values()].slice(-30);
}

export function summarizeActivity(events, now = Date.now()) {
  const ends = events.filter(e => e.type === 'tool_execution_end');
  const buckets = Array(30).fill(0);
  for (const e of ends) {
    const age = Math.floor((now - Date.parse(e.time)) / MINUTE_MS);
    if (age >= 0 && age < 30) buckets[29 - age]++;
  }
  const last = events.at(-1);
  const lastWork = events.findLast(e => !['closed', 'resumed', 'ready'].includes(e.type));
  return {
    lastWorkAt: lastWork?.time,
    toolCalls: ends.length,
    toolErrors: ends.filter(e => e.isError).length,
    buckets,
    lastEvent: last && { type: last.type, time: last.time, toolName: last.toolName },
  };
}

export function extractVerification(record, includeChecks = true) {
  const v = record?.verification;
  if (!v || typeof v !== 'object') return { status: 'none' };
  const base = {
    status: ['none', 'running', 'verified', 'failed', 'skipped'].includes(v.status) ? v.status : 'none',
    checkedAt: v.checkedAt || null,
    sandboxBackend: v.sandboxBackend || null,
    totalDurationMs: typeof v.totalDurationMs === 'number' ? v.totalDurationMs : 0,
    passedCount: typeof v.passedCount === 'number' ? v.passedCount : 0,
    failedCount: typeof v.failedCount === 'number' ? v.failedCount : 0,
    totalCount: typeof v.totalCount === 'number' ? v.totalCount : (Array.isArray(v.checks) ? v.checks.length : 0),
  };
  if (includeChecks && Array.isArray(v.checks)) {
    base.checks = v.checks.map(c => ({
      ...(c.name ? { name: c.name } : {}),
      command: c.command,
      expectExit: c.expectExit,
      exitCode: c.exitCode,
      passed: Boolean(c.passed),
      timedOut: Boolean(c.timedOut),
      durationMs: c.durationMs || 0,
      stdoutTail: c.stdoutTail || '',
      stderrTail: c.stderrTail || '',
      ...(c.sandboxHint ? { sandboxHint: c.sandboxHint } : {}),
    }));
  }
  return base;
}

function summarizeRun(raw) {
  return {
    runId: raw.runId,
    kind: raw.kind || 'consult',
    status: raw.status || 'completed',
    dryRun: Boolean(raw.dryRun),
    createdAt: raw.createdAt || null,
    completedAt: raw.completedAt || null,
    durationMs: raw.durationMs ?? null,
    question: typeof raw.question === 'string' ? raw.question.slice(0, 240) : null,
    sourceAgentId: raw.sourceAgentId || null,
    verdict: raw.verdict || raw.review?.verdict || null,
    membersCount: Array.isArray(raw.members) ? raw.members.length : (raw.agentId ? 1 : 0),
    models: Array.isArray(raw.members)
      ? raw.members.map(m => `${m.model?.provider || m.provider}/${m.model?.model || m.model}`)
      : raw.model ? [`${raw.model.provider}/${raw.model.model}`] : [],
    totalUsage: raw.totalUsage || raw.usage || null,
  };
}

export function readRun(root, runId) {
  if (!isRunId(runId)) throw new Error('Invalid run ID');
  return readJsonSafe(path.join(path.resolve(root), 'runs', `${runId}.json`));
}

export function readRuns(root, limit = 100) {
  const dir = path.join(path.resolve(root), 'runs');
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = readJsonSafe(path.join(dir, name));
    if (raw && isRunId(raw.runId)) items.push(summarizeRun(raw));
  }
  items.sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
  return items.slice(0, limit);
}

function hasTextEntry(file, pattern) {
  try { return fs.existsSync(file) && pattern.test(fs.readFileSync(file, 'utf8')); }
  catch { return false; }
}

export function collectRuntimeEnvironment(root, agents = [], env = process.env) {
  const health = sandboxHealth(process.platform, env);
  let defaultMode = sandboxMode({});
  try {
    const configured = readModelSettings(root).defaults.sandboxMode;
    if (configured) defaultMode = configured;
  } catch {}
  const activeByHost = kind => agents.filter(a => a.parentInfo?.kind === kind && ACTIVE_STATUSES.has(a.status)).length;
  const home = env.HOME || os.homedir();
  const agyDir = path.join(env.PI_ANTIGRAVITY_PLUGINS_DIR || path.join(home, '.gemini/config/plugins'), 'pi-server');
  const agyPlugin = fs.existsSync(path.join(agyDir, 'plugin.json'));
  const agyHooks = fs.existsSync(path.join(agyDir, 'hooks.json'));
  const claudeConfigured = hasTextEntry(path.join(home, '.claude.json'), /"pi-server"/);
  const codexFile = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  const codexConfigured = hasTextEntry(codexFile, /mcp_servers\.pi-server|\[mcp_servers\."pi-server"\]/);
  const oc = inspectOpencodeConfig(env);
  return {
    sandbox: { ...health, defaultMode },
    hosts: {
      antigravity: {
        configured: agyPlugin,
        detail: agyPlugin ? (agyHooks ? 'plugin + hooks' : 'plugin only') : 'not configured',
        activeAgents: activeByHost('antigravity'),
      },
      claude: {
        configured: claudeConfigured,
        detail: claudeConfigured ? 'mcp configured' : 'not configured',
        activeAgents: activeByHost('claude'),
      },
      codex: {
        configured: codexConfigured,
        detail: codexConfigured ? 'mcp configured' : 'not configured',
        activeAgents: activeByHost('codex'),
      },
      opencode: {
        configured: Boolean(oc.mcpConfigured),
        detail: oc.mcpConfigured ? (oc.skillInstalled ? 'mcp + skill' : 'mcp only') : 'not configured',
        activeAgents: activeByHost('opencode'),
      },
    },
  };
}
