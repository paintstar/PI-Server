import fs from 'node:fs';
import path from 'node:path';
import { processAlive, readTail, atomicWriteJson, readJsonSafe, ownerLockAlive } from './storage.js';
import { estimateRoundedTokens } from './token-estimate.js';

export const defaultDashboardPort = 3141;
export const workingStatuses = new Set(['starting', 'running', 'finishing']);
export const activeStatuses = new Set(['starting', 'running', 'waiting', 'finishing', 'idle']);
export const isWorkingStatus = status => workingStatuses.has(status);
export const isActiveStatus = status => activeStatuses.has(status);
const active = activeStatuses;
const working = new Set(['starting', 'running', 'waiting', 'finishing']);
export const isAgentId = id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
export { readTail };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizeGroupKey(group) {
  if (group === null) return null;
  if (typeof group !== 'string' || !group.trim() || group.trim().length > 300) throw new Error('Invalid group');
  const trimmed = group.trim();
  if (FORBIDDEN_KEYS.has(trimmed)) throw new Error('Invalid group');
  return /^(s:|p:|custom:)/.test(trimmed) ? trimmed : `custom:${trimmed}`;
}

function resolveRecordState(directory, record, mark = {}) {
  const controllerAlive = directory ? ownerLockAlive(directory) : true;
  const baseStatus = !controllerAlive && active.has(record.status) ? 'disconnected' : record.status;
  const marked = Boolean(mark.status) && (record.updatedAt || '') <= mark.at && !working.has(baseStatus);
  const status = marked ? mark.status : baseStatus;
  const archived = Boolean(mark.archived) && (!mark.archivedAt || (record.updatedAt || '') <= mark.archivedAt) && !working.has(baseStatus);
  return { controllerAlive, baseStatus, status, marked, archived };
}

export function parseDashboardPort(raw = process.env.PI_DASHBOARD_PORT) {
  if (raw === undefined || raw === null || raw === '') return defaultDashboardPort;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid dashboard port: ${raw}`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid dashboard port: ${raw}`);
  return port;
}

export async function readRunningDashboard(root, { checkPidMatch = true, timeoutMs = 1500 } = {}) {
  const info = readJsonSafe(path.join(root, 'dashboard.json'));
  if (!info || (checkPidMatch && !processAlive(info.pid))) return null;
  let url;
  try { url = new URL(info.url); }
  catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.hostname !== '127.0.0.1') throw new Error('Invalid local dashboard address');
  try {
    const response = await fetch(new URL('/api/health', url), {
      headers: { authorization: `Bearer ${info.token || url.hash.slice(1)}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const health = await response.json();
    if (!response.ok || health.service !== 'pi-dashboard' || (checkPidMatch && health.pid !== info.pid)) return null;
    return { ...info, scriptPath: health.scriptPath || null };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError') return null;
    throw error;
  }
}

/** Bound every string inside tool arguments so one huge write cannot flood the page. */
function clipValue(value, limit = 6000) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字）` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => clipValue(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, clipValue(item, limit)]));
  return value;
}
const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Project one saved session entry for display. Thinking text is shown; provider signatures and encrypted reasoning never are. */
export function transcriptMessage(entry, index = 0) {
  if (entry.type !== 'message' || !entry.message) return null;
  const m = entry.message;
  const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  const base = { id: entry.id || `${entry.timestamp}-${index}`, role: m.role, time: entry.timestamp };
  if (m.role === 'toolResult') {
    const text = textOf(blocks);
    return { ...base, toolCallId: m.toolCallId, toolName: m.toolName, isError: !!m.isError, durationMs: m.durationMs,
      text: text.length > 6000 ? `…\n${text.slice(-6000)}` : text, diff: typeof m.details?.diff === 'string' ? m.details.diff.slice(0, 12000) : undefined,
      answer: typeof m.details?.answer === 'string' ? m.details.answer.slice(0, 6000) : undefined };
  }
  const thinkingBlocks = blocks.filter(b => b.type === 'thinking');
  const thinking = thinkingBlocks.map(b => b.thinking || '').filter(Boolean).join('\n\n');
  const calls = blocks.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, name: b.name, arguments: clipValue(b.arguments || {}) }));
  const text = textOf(blocks).slice(-12000);
  if (!text && !calls.length && !thinkingBlocks.length && m.role !== 'assistant') return null;
  return { ...base, text, calls, startedAt: typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : undefined,
    thinking: thinking.slice(-8000) || undefined, thinkingRedacted: thinkingBlocks.length > 0 && !thinking,
    stopReason: m.stopReason, error: m.stopReason === 'error' ? String(m.errorMessage || '').slice(0, 2000) : undefined };
}

/** Output speed of each finished model request: output tokens over request wall time, from the saved session. */
export function requestSpeeds(entries, limit = 40) {
  const speeds = [];
  for (const entry of entries) {
    const m = entry.message;
    if (entry.type !== 'message' || m?.role !== 'assistant' || !m.usage || typeof m.timestamp !== 'number') continue;
    const end = Date.parse(entry.timestamp); const seconds = (end - m.timestamp) / 1000;
    if (!(seconds > 0.2) || !m.usage.output) continue;
    speeds.push({ at: entry.timestamp, output: m.usage.output, seconds: Math.round(seconds * 100) / 100, tps: Math.round(m.usage.output / seconds * 10) / 10 });
  }
  return speeds.slice(-limit);
}

export function estimateTokens(text = '') {
  return estimateRoundedTokens(text);
}
const sectionNames = { preamble: '角色说明', tools: '工具说明', rules: '规则', docs: '文档', addendum: '附加说明', project_context: '项目说明', skills: '技能列表', cwd: '工作目录' };
/** 上下文分析：每次请求实际送进模型的 token（输入 + 缓存读写），以及按来源估算的构成。 */
export function contextAnalysis(head, entries, contextWindow) {
  const system = [...head, ...entries].find(e => e.type === 'message' && e.message?.role === 'system')?.message;
  const sections = Object.entries(system?.sections || {}).map(([key, value]) => ({ key, name: sectionNames[key] || key, tokens: estimateTokens(String(value)) })).filter(s => s.tokens > 0);
  const parts = { user: 0, assistant: 0, thinking: 0, toolCalls: 0, toolResults: 0 };
  const series = []; let compactions = 0;
  for (const entry of entries) {
    if (entry.type === 'compaction' || entry.type === 'compaction_summary') compactions++;
    const m = entry.message; if (entry.type !== 'message' || !m) continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const b of blocks) {
      const size = estimateTokens(b.type === 'thinking' ? b.thinking || '' : b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : b.text || '');
      if (m.role === 'user') parts.user += size; else if (m.role === 'toolResult') parts.toolResults += size;
      else if (m.role === 'assistant') parts[b.type === 'thinking' ? 'thinking' : b.type === 'toolCall' ? 'toolCalls' : 'assistant'] += size;
    }
    if (m.role === 'assistant' && m.usage) {
      const used = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      if (used) series.push({ at: entry.timestamp, used, cached: m.usage.cacheRead || 0, output: m.usage.output || 0, reasoning: m.usage.reasoning || 0 });
    }
  }
  const latest = series.at(-1);
  return { contextWindow: contextWindow || null, used: latest?.used || 0, cached: latest?.cached || 0, peak: Math.max(0, ...series.map(s => s.used)),
    series: series.slice(-120), sections, parts, compactions, requests: series.length };
}
/** 会话里出现过的 GitHub PR 链接（创建、查看或合并时的输出），按首次出现排序。 */
export function pullRequestLinks(entries) {
  const found = new Map(); const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  for (const entry of entries) {
    const m = entry.message; if (entry.type !== 'message' || !m || m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const text = blocks.map(b => b.text || (b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : '')).join('\n');
    for (const match of text.matchAll(pattern)) {
      const url = match[0]; const item = found.get(url) || { url, repo: match[1], number: Number(match[2]), firstAt: entry.timestamp, merged: false, created: false };
      if (/merged|已合并|gh pr merge/i.test(text)) item.merged = true;
      if (/gh pr create|Creating pull request|created pull request/i.test(text)) item.created = true;
      item.lastAt = entry.timestamp; found.set(url, item);
    }
  }
  return [...found.values()].slice(-30);
}

const minute = 60 * 1000;
/** Compact progress figures for the list: tool totals, last step and per-minute tool activity of the last 30 minutes. */
export function summarizeActivity(events, now = Date.now()) {
  const ends = events.filter(e => e.type === 'tool_execution_end');
  const buckets = Array(30).fill(0);
  for (const e of ends) {
    const age = Math.floor((now - Date.parse(e.time)) / minute);
    if (age >= 0 && age < 30) buckets[29 - age]++;
  }
  const last = events.at(-1);
  // Closing or resuming later must not stretch the time the agent actually worked.
  const lastWork = events.findLast(e => !['closed', 'resumed', 'ready'].includes(e.type));
  return { lastWorkAt: lastWork?.time, toolCalls: ends.length, toolErrors: ends.filter(e => e.isError).length, buckets,
    lastEvent: last && { type: last.type, time: last.time, toolName: last.toolName } };
}

/** Read-only projection of existing MCP records; never claim, resume or command an agent. */
export class DashboardData {
  constructor(root) { this.root = path.resolve(root); }
  directory(id) {
    if (!isAgentId(id)) throw new Error('Invalid agent ID');
    return path.join(this.root, id);
  }
  get marksFile() { return path.join(this.root, 'dashboard-marks.json'); }
  /** 面板自己的整理数据：每个会话的手动状态与所在分组，以及分组改名。旧版是 {id: {status, at}}，读取时兼容。 */
  marks() {
    try {
      const stat = fs.statSync(this.marksFile);
      if (this.marksCache?.mtime !== stat.mtimeMs) {
        const raw = JSON.parse(fs.readFileSync(this.marksFile, 'utf8'));
        const value = raw.agents || raw.groups ? { agents: raw.agents || {}, groups: raw.groups || {} } : { agents: raw, groups: {} };
        this.marksCache = { mtime: stat.mtimeMs, value };
      }
      return structuredClone(this.marksCache.value);
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { agents: {}, groups: {} };
      throw error;
    }
  }
  saveMarks(marks) {
    atomicWriteJson(this.marksFile, marks);
    this.marksCache = null;
  }
  ensureAgentExists(id) {
    const dir = this.directory(id);
    fs.statSync(path.join(dir, 'agent.json'));
    return dir;
  }
  loadRecord(id) {
    const directory = this.ensureAgentExists(id);
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
    return { directory, record };
  }
  sessionFileBytes(directory, record) {
    if (!record?.sessionFile) return 0;
    try {
      const file = fs.realpathSync(record.sessionFile);
      const allowed = fs.realpathSync(path.join(directory, 'sessions'));
      return file.startsWith(allowed + path.sep) ? fs.statSync(file).size : 0;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }
  validateOrganizePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid metadata');
    if (patch.title !== undefined && patch.title !== null && (typeof patch.title !== 'string' || patch.title.trim().length > 100)) throw new Error('显示名称不能超过 100 字');
    if (patch.note !== undefined && patch.note !== null && (typeof patch.note !== 'string' || patch.note.trim().length > 1000)) throw new Error('会话备注不能超过 1000 字');
    if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw new Error('Invalid pinned flag');
    const normalizedGroup = patch.group !== undefined ? normalizeGroupKey(patch.group) : undefined;
    if (patch.statusMark !== undefined && patch.statusMark !== null && !['completed', 'closed'].includes(patch.statusMark)) throw new Error('Mark must be completed, closed or null');
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new Error('Invalid archived flag');
    return normalizedGroup;
  }
  organize(ids, patch = {}) {
    const list = typeof ids === 'string' ? [ids] : ids;
    if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error('Invalid agentIds');
    const normalizedGroup = this.validateOrganizePatch(patch);
    const targets = list.map(id => ({ id, ...this.loadRecord(id) }));
    const marks = this.marks();
    const now = new Date().toISOString();
    const markUpdated = []; const markSkipped = []; const archUpdated = []; const archSkipped = [];
    for (const { id, directory, record } of targets) {
      const entry = { ...marks.agents[id] };
      const { baseStatus } = resolveRecordState(directory, record, entry);
      if (patch.title !== undefined) { const v = patch.title?.trim(); if (v) entry.title = v; else delete entry.title; }
      if (patch.note !== undefined) { const v = patch.note?.trim(); if (v) entry.note = v; else delete entry.note; }
      if (patch.pinned !== undefined) { if (patch.pinned) entry.pinned = true; else delete entry.pinned; }
      if (normalizedGroup !== undefined) { if (normalizedGroup) entry.group = normalizedGroup; else delete entry.group; }
      if (patch.statusMark !== undefined) {
        if (patch.statusMark !== null && working.has(baseStatus)) markSkipped.push(id);
        else {
          if (patch.statusMark === null) { delete entry.status; delete entry.at; } else Object.assign(entry, { status: patch.statusMark, at: now });
          markUpdated.push(id);
        }
      }
      if (patch.archived !== undefined) {
        if (patch.archived && working.has(baseStatus)) {
          if (list.length === 1) throw new Error('正在工作或等待答复的会话不能归档');
          archSkipped.push(id);
        } else {
          if (patch.archived) { entry.archived = true; entry.archivedAt = now; } else { delete entry.archived; delete entry.archivedAt; }
          archUpdated.push(id);
        }
      }
      if (Object.keys(entry).length) marks.agents[id] = entry; else delete marks.agents[id];
    }
    this.saveMarks(marks);
    return {
      updatedAgents: targets.map(({ id, directory, record }) => ({ id, organization: this.organizationOf(id, record, directory) })),
      ...(patch.statusMark !== undefined ? { markResult: { status: patch.statusMark, updatedIds: markUpdated, skippedIds: markSkipped } } : {}),
      ...(patch.archived !== undefined ? { archiveResult: { archived: patch.archived, updatedIds: archUpdated, skippedIds: archSkipped } } : {}),
    };
  }
  mark(id, status) {
    const res = this.organize([id], { statusMark: status }).markResult;
    if (!res.updatedIds.length) throw new Error('正在工作或等待答复的会话不能手动标记');
    return { id, status: this.snapshot(id).status, marked: status !== null };
  }
  batchMark(ids, status) { return this.organize(ids, { statusMark: status }).markResult; }
  move(id, group) { return { id, group: this.organize([id], { group }).updatedAgents[0].organization?.group || null }; }
  editMeta(id, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid metadata');
    const meta = {};
    for (const k of ['title', 'note', 'pinned', 'group']) if (k in patch) meta[k] = patch[k];
    this.organize([id], meta);
    const snap = this.snapshot(id);
    return { id, name: snap.name, rawName: snap.rawName, title: snap.title, note: snap.note, pinned: snap.pinned, movedTo: snap.movedTo || null };
  }
  archive(ids, archived = true) { return this.organize(ids, { archived }).archiveResult; }
  organizationOf(id, recordOrUpdatedAt = null, knownDirectory = null) {
    const entry = this.marks().agents[id];
    if (!entry) return null;
    const directory = knownDirectory || this.directory(id);
    const disk = readJsonSafe(path.join(directory, 'agent.json'));
    const passed = typeof recordOrUpdatedAt === 'object' && recordOrUpdatedAt !== null ? recordOrUpdatedAt : { updatedAt: typeof recordOrUpdatedAt === 'string' ? recordOrUpdatedAt : '' };
    const updatedAt = [disk?.updatedAt, passed.updatedAt].filter(Boolean).sort().at(-1) || '';
    const record = { status: 'closed', ...disk, ...passed, updatedAt };
    const { marked, archived } = resolveRecordState(fs.existsSync(directory) ? directory : null, record, entry);
    return { title: entry.title || null, note: entry.note || null, pinned: Boolean(entry.pinned), archived, archivedAt: archived ? entry.archivedAt || null : null, group: entry.group || null, statusMark: marked ? entry.status : null };
  }
  /** 给分组起一个面板里显示的名字；name 为空时恢复默认名。 */
  renameGroup(key, name) {
    if (typeof key !== 'string' || !key || key.length > 300 || FORBIDDEN_KEYS.has(key)) throw new Error('Invalid group');
    if (name != null && (typeof name !== 'string' || name.length > 60)) throw new Error('Invalid name');
    const marks = this.marks();
    if (name?.trim()) marks.groups[key] = { ...marks.groups[key], name: name.trim() }; else delete marks.groups[key];
    this.saveMarks(marks);
    return { key, name: name?.trim() || null };
  }
  /** 模型目录由管理进程写入，用来显示上下文窗口。 */
  catalog() {
    const file = path.join(this.root, 'models-catalog.json');
    try {
      const stat = fs.statSync(file);
      if (this.catalogCache?.mtime !== stat.mtimeMs) this.catalogCache = { mtime: stat.mtimeMs, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      return this.catalogCache.value;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
  }
  activeWatchers() {
    const dir = path.join(this.root, 'watchers');
    let files;
    try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const watchers = [];
    for (const file of files) {
      const raw = readJsonSafe(path.join(dir, file));
      if (!raw || !Number.isInteger(raw.pid) || !processAlive(raw.pid)) continue;
      watchers.push({
        pid: raw.pid,
        sessionId: raw.sessionId || null,
        agentIds: Array.isArray(raw.agentIds) ? raw.agentIds : [],
        startedAt: raw.startedAt || null,
      });
    }
    return watchers;
  }
  callbackInfo(id) {
    const raw = readJsonSafe(path.join(this.root, 'callbacks', `${id}.json`));
    if (!raw) return null;
    const deliveredSeq = Math.max(raw.deliveredSeq || 0, raw.antigravityDeliveredSeq || 0);
    return {
      host: raw.host || null,
      enabled: !!raw.enabled,
      antigravitySessionId: raw.antigravitySessionId || null,
      antigravityDeliveredSeq: deliveredSeq,
      deliveredSeq,
      opencodeSessionId: raw.opencodeSessionId || null,
      claudeSessionId: raw.claudeSessionId || null,
      codexThreadId: raw.codexThreadId || null,
      lastObservedBy: raw.lastObservedBy || null,
    };
  }
  snapshot(id, watchers = null, preloaded = null) {
    const { directory, record } = preloaded || this.loadRecord(id);
    const events = readTail(path.join(directory, 'events.jsonl'));
    const pending = new Map();
    for (const event of events) {
      if (event.type === 'tool_execution_start') pending.set(event.toolCallId, event.toolName);
      if (event.type === 'tool_execution_end') pending.delete(event.toolCallId);
    }
    const mark = this.marks().agents[id] || {};
    const { controllerAlive, status, marked, archived } = resolveRecordState(directory, record, mark);
    const questionIds = new Set(record.questionIds || []);
    const activity = summarizeActivity(events);
    const callback = this.callbackInfo(id);
    const cbSid = callback?.antigravitySessionId || callback?.opencodeSessionId;
    const parentInfo = record.parentInfo || (cbSid
      ? { kind: callback?.opencodeSessionId ? 'opencode' : 'antigravity', sessionId: cbSid, cwd: record.workspace?.sourceCwd || record.workspace?.cwd }
      : undefined);
    const activeWatcherList = watchers ?? this.activeWatchers();
    const watcherActive = activeWatcherList.some(w =>
      w.agentIds.includes(id)
      || (parentInfo?.sessionId && w.sessionId === parentInfo.sessionId)
      || (cbSid && w.sessionId === cbSid)
    );
    return { id, name: mark.title || record.name, rawName: record.name, title: mark.title || null, note: mark.note || null, pinned: Boolean(mark.pinned), archived, archivedAt: archived ? mark.archivedAt || null : null,
      status, recordedStatus: record.status, controllerAlive, marked, movedTo: mark.group, parentId: record.parentId, contextWindow: this.contextWindow(record.model), parentInfo,
      callback, watcherActive,
      model: record.model, thinking: record.thinking, temporaryModel: record.restoreModel,
      cwd: record.workspace?.cwd, sourceCwd: record.workspace?.sourceCwd, workspaceMode: record.workspace?.mode,
      ownedPaths: record.ownedPaths, createdAt: record.createdAt, updatedAt: record.updatedAt,
      sequence: record.sequence, usage: record.usage, lastText: record.lastText?.slice(-12000), error: record.error,
      currentTools: active.has(status) ? [...pending.values()] : [],
      questions: events.filter(e => e.type === 'question' && questionIds.has(e.questionId)).map(e => ({ questionId: e.questionId, question: e.question, time: e.time })),
      recentMessage: events.findLast(e => e.type === 'message')?.message?.slice(-2000), activity, events };
  }
  sessionEntries(directory, record, limit = 500) {
    if (!record.sessionFile) return [];
    const file = fs.realpathSync(record.sessionFile);
    const allowed = fs.realpathSync(path.join(directory, 'sessions'));
    if (!file.startsWith(allowed + path.sep)) throw new Error('Session file is outside its private session directory');
    return readTail(file, limit);
  }
  sessionHead(directory, record, bytes = 256 * 1024) {
    if (!record.sessionFile) return [];
    const file = fs.realpathSync(record.sessionFile);
    if (!file.startsWith(fs.realpathSync(path.join(directory, 'sessions')) + path.sep)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size)); fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lines = buffer.toString('utf8').split('\n'); if (buffer.length === bytes) lines.pop();
      return lines.filter(Boolean).slice(0, 20).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { fs.closeSync(fd); }
  }
  latestSpeed(id) {
    try {
      const directory = this.directory(id);
      const record = readJsonSafe(path.join(directory, 'agent.json'));
      if (!record) return null;
      return requestSpeeds(this.sessionEntries(directory, record, 60), 1)[0] || null;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  list() {
    if (!fs.existsSync(this.root)) return { agents: [], errors: [], refreshedAt: new Date().toISOString() };
    const watchers = this.activeWatchers();
    const agents = []; const errors = [];
    for (const id of fs.readdirSync(this.root).filter(isAgentId)) {
      try { const { events, ...agent } = this.snapshot(id, watchers); if (working.has(agent.status)) agent.speed = this.latestSpeed(id); agents.push(agent); }
      catch (error) { errors.push({ id, error: error.message }); }
    }
    agents.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    return { agents, errors, groupNames: Object.fromEntries(Object.entries(this.marks().groups).map(([key, value]) => [key, value.name])), refreshedAt: new Date().toISOString() };
  }
  systemStatus() {
    const rawController = readJsonSafe(path.join(this.root, 'controller.json'));
    const controller = rawController
      ? { pid: rawController.pid || null, alive: Number.isInteger(rawController.pid) ? processAlive(rawController.pid) : false, startedAt: rawController.startedAt || null, version: rawController.version || null, scriptPath: rawController.scriptPath || null }
      : null;
    const watchers = this.activeWatchers();
    const listed = this.list();
    const counts = { total: listed.agents.length, working: 0, waiting: 0, idle: 0, completed: 0, failed: 0, closed: 0, disconnected: 0, stopped: 0, interrupted: 0, archived: 0, errors: listed.errors.length };
    for (const agent of listed.agents) {
      if (agent.archived) counts.archived++;
      if (isWorkingStatus(agent.status)) counts.working++;
      else if (agent.status === 'waiting') counts.waiting++;
      else if (agent.status === 'idle') counts.idle++;
      else if (agent.status === 'completed') counts.completed++;
      else if (agent.status === 'failed') counts.failed++;
      else if (agent.status === 'closed') counts.closed++;
      else if (agent.status === 'disconnected') counts.disconnected++;
      else if (agent.status === 'stopped') counts.stopped++;
      else if (agent.status === 'interrupted') counts.interrupted++;
    }
    return { controller, modelCount: this.catalog().length, watchers, counts, dashboardPid: process.pid, refreshedAt: new Date().toISOString() };
  }
  contextWindow(model) { return this.catalog().find(m => m.provider === model?.provider && m.model === model?.model)?.contextWindow; }
  liveState(id) {
    const { directory, record } = this.loadRecord(id);
    const { status } = resolveRecordState(directory, record, this.marks().agents[id] || {});
    return {
      id,
      status,
      sequence: record.sequence ?? 0,
      updatedAt: record.updatedAt,
      usage: record.usage,
      sessionBytes: this.sessionFileBytes(directory, record),
      live: working.has(status) ? this.live(directory) : null,
    };
  }
  detail(id) {
    const loaded = this.loadRecord(id);
    const { directory, record } = loaded;
    const agent = this.snapshot(id, null, loaded);
    const messages = [];
    let transcriptError; let speeds = []; let context = null; let pullRequests = [];
    try {
      const entries = this.sessionEntries(directory, record);
      for (const entry of entries) {
        const message = transcriptMessage(entry, messages.length);
        if (message) messages.push(message);
      }
      speeds = requestSpeeds(entries);
      context = contextAnalysis(this.sessionHead(directory, record), entries, agent.contextWindow);
      pullRequests = pullRequestLinks(entries);
    } catch (error) { transcriptError = error.message; }
    return { agent, messages: messages.slice(-160), speeds, context, pullRequests, sessionBytes: this.sessionFileBytes(directory, record), live: working.has(agent.status) ? this.live(directory) : null, transcriptError, refreshedAt: new Date().toISOString() };
  }
  live(directory) {
    const live = readJsonSafe(path.join(directory, 'live.json'));
    if (!live) return null;
    return Date.now() - Date.parse(live.updatedAt) < 10 * 60 * 1000 ? live : null;
  }
}
