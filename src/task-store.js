import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './storage.js';

const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const resultOf = agent => ({ content: [{ type: 'text', text: JSON.stringify(agent) }], structuredContent: { result: agent }, ...(agent.status === 'failed' ? { isError: true } : {}) });
/** Persistent MCP Tasks store; task IDs and results survive bridge reconnects. */
export class FileTaskStore {
  constructor(root, manager) { this.directory = path.join(root, 'tasks'); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.manager = manager; }
  filename(id) { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID'); return path.join(this.directory, id + '.json'); }
  read(id, owner) {
    const file = this.filename(id); if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() >= Date.parse(record.task.createdAt) + record.task.ttl) { fs.unlinkSync(file); return null; }
    if (record.owner !== owner) throw new Error('Task belongs to another parent');
    return record;
  }
  save(record) { atomicWriteJson(this.filename(record.task.taskId), record); }
  async createTask(params, requestId, request, owner) {
    if (params.context?.agentId) {
      for (const file of fs.readdirSync(this.directory).filter(v => v.endsWith('.json'))) {
        const saved = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
        if (saved.owner === owner && saved.agentId === params.context.agentId) { const old = this.read(saved.task.taskId, owner); if (old) return old.task; }
      }
    }
    const now = new Date().toISOString();
    const task = { taskId: randomUUID(), status: 'working', createdAt: now, lastUpdatedAt: now, ttl: Math.max(1000, Math.min(params.ttl ?? 86400000, 604800000)), pollInterval: 1000 };
    this.save({ task, owner, agentId: params.context?.agentId, progressToken: request?.params?._meta?.progressToken }); return task;
  }
  async getTask(id, owner) {
    const record = this.read(id, owner); if (!record) return null;
    if (!terminal(record.task.status) && record.agentId) {
      const active = this.manager.agents.get(record.agentId);
      let status, message;
      if (!active) { status = 'failed'; message = 'Controller restarted; task did not replay. Explicitly recover its saved agent.'; }
      else {
        const value = active.record.status;
        status = value === 'waiting' ? 'input_required' : value === 'completed' ? 'completed' : value === 'failed' ? 'failed' : ['interrupted', 'closed'].includes(value) ? 'cancelled' : 'working';
        message = active.record.error;
        if (terminal(status)) record.result = resultOf(this.manager.summary(active));
      }
      if (record.task.status !== status) { record.task.status = status; record.task.lastUpdatedAt = new Date().toISOString(); record.task.statusMessage = message; this.save(record); }
    }
    return record.task;
  }
  async storeTaskResult(id, status, result, owner) {
    const record = this.read(id, owner); if (!record) throw new Error('Task not found');
    if (terminal(record.task.status)) throw new Error('Task already reached a terminal status');
    record.task.status = status; record.task.lastUpdatedAt = new Date().toISOString(); record.result = result; this.save(record);
  }
  async getTaskResult(id, owner) {
    const task = await this.getTask(id, owner); if (!task) throw new Error('Task not found');
    const record = this.read(id, owner);
    if (!terminal(task.status)) throw new Error('Task is still running');
    return record.result || { isError: true, content: [{ type: 'text', text: task.statusMessage || `Task ${task.status}` }] };
  }
  async updateTaskStatus(id, status, message, owner) {
    const record = this.read(id, owner); if (!record) throw new Error('Task not found');
    if (terminal(record.task.status)) throw new Error('Task already reached a terminal status');
    if (status === 'cancelled' && record.agentId && this.manager.agents.has(record.agentId)) await this.manager.interrupt(record.agentId);
    record.task.status = status; record.task.statusMessage = message; record.task.lastUpdatedAt = new Date().toISOString(); this.save(record);
  }
  async listTasks(cursor, owner) {
    const ids = fs.readdirSync(this.directory).filter(value => value.endsWith('.json')).map(value => value.slice(0, -5)).sort();
    const owned = [];
    for (const id of ids) {
      const record = JSON.parse(fs.readFileSync(this.filename(id), 'utf8'));
      if (record.owner === owner) { const task = await this.getTask(id, owner); if (task) owned.push(task); }
    }
    const start = cursor ? owned.findIndex(value => value.taskId === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error('Invalid task cursor');
    const tasks = owned.slice(start, start + 50);
    return { tasks, ...(owned.length > start + 50 ? { nextCursor: tasks.at(-1).taskId } : {}) };
  }
  async notificationStates(owner) {
    const { tasks } = await this.listTasks(undefined, owner);
    return tasks.map(task => { const r = this.read(task.taskId, owner); return { task, progressToken: r.progressToken, sequence: this.manager.agents.get(r.agentId)?.record.sequence || 0 }; });
  }
  prune() {
    if (!fs.existsSync(this.directory)) return 0;
    let removed = 0;
    for (const file of fs.readdirSync(this.directory).filter(v => v.endsWith('.json'))) {
      const target = path.join(this.directory, file);
      try {
        const r = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (Date.now() >= Date.parse(r.task.createdAt) + r.task.ttl) { fs.unlinkSync(target); removed++; }
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return removed;
  }
  async adopt(id, owner, isConnected) {
    const record = JSON.parse(fs.readFileSync(this.filename(id), 'utf8'));
    if (record.owner !== owner && isConnected(record.owner)) throw new Error('Task belongs to an attached parent');
    record.owner = owner; delete record.progressToken; this.save(record); return { task: await this.getTask(id, owner), agentId: record.agentId };
  }
}

/** SDK TaskStore adapter binds every operation to its MCP parent's controller capability. */
export class RemoteTaskStore {
  constructor(client) { this.client = client; }
  call(operation, args) { return this.client.call('task', { operation, args }); }
  createTask(params, requestId, request) { return this.call('createTask', [params, requestId, request]); }
  getTask(id) { return this.call('getTask', [id]); }
  storeTaskResult(id, status, result) { return this.call('storeTaskResult', [id, status, result]); }
  getTaskResult(id) { return this.call('getTaskResult', [id]); }
  updateTaskStatus(id, status, message) { return this.call('updateTaskStatus', [id, status, message]); }
  listTasks(cursor) { return this.call('listTasks', [cursor]); }
  notificationStates() { return this.call('notificationStates', []); }
}
