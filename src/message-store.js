import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJson } from './storage.js';

const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Durable message receipts. Uncertain delivery never triggers an automatic second model instruction. */
export class MessageStore {
  constructor(storage) { this.storage = storage; }
  all(agentId) {
    const file = path.join(this.storage.directory(agentId), 'messages.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  }
  save(agentId, records) {
    atomicWriteJson(path.join(this.storage.directory(agentId), 'messages.json'), records);
  }
  create(agentId, { messageId = randomUUID(), ...data }) {
    if (!/^[0-9a-f-]{36}$/.test(messageId)) throw new Error('Invalid message ID');
    const records = this.all(agentId);
    const fingerprint = identity(data);
    const existing = records.find(value => value.messageId === messageId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Message ID was already used with different content');
      return { record: existing, duplicate: true };
    }
    const record = { messageId, ...data, fingerprint, state: 'stored', createdAt: new Date().toISOString() };
    records.push(record); this.save(agentId, records);
    return { record, duplicate: false };
  }
  update(agentId, messageId, changes) {
    const records = this.all(agentId);
    const record = records.find(value => value.messageId === messageId);
    if (!record) throw new Error('Unknown message ID');
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    this.save(agentId, records); return record;
  }
  read(agentId, { afterMessageId, limit = 50, unacknowledgedOnly = false } = {}) {
    const records = this.all(agentId);
    const start = afterMessageId ? records.findIndex(value => value.messageId === afterMessageId) : -1;
    if (afterMessageId && start === -1) throw new Error('Unknown message cursor');
    const selected = records.slice(start + 1).filter(value => !unacknowledgedOnly || !value.acknowledgedAt);
    const messages = selected.slice(0, limit).map(({ fingerprint, ...value }) => value);
    return { messages, nextMessageId: messages.at(-1)?.messageId || afterMessageId || null, hasMore: selected.length > limit };
  }
  acknowledge(agentId, ids) {
    const records = this.all(agentId);
    for (const id of ids) if (!records.some(value => value.messageId === id)) throw new Error('Unknown message ID');
    for (const record of records) if (ids.includes(record.messageId)) record.acknowledgedAt ||= new Date().toISOString();
    this.save(agentId, records); return { acknowledged: ids };
  }
}
