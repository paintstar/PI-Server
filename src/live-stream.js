import fs from 'node:fs';
import { atomicWriteJson } from './storage.js';

const clip = (text, limit) => text.length > limit ? text.slice(-limit) : text;
const outputOf = result => (result?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/**
 * Mirror the assistant message being generated and partial tool output into a private live.json.
 * Only the read-only dashboard consumes it; saved session files stay the authoritative record.
 */
export class LiveStream {
  constructor(file, interval = 250) { this.file = file; this.interval = interval; this.message = null; this.tools = new Map(); this.timer = null; }
  handle(event) {
    const update = event.assistantMessageEvent;
    if (event.type === 'message_start' && event.message?.role === 'assistant') this.message = { startedAt: new Date().toISOString(), blocks: [] };
    else if (event.type === 'message_update' && update && this.message) this.apply(update);
    else if (event.type === 'message_end' && event.message?.role === 'assistant') this.message = null;
    else if (event.type === 'tool_execution_start') this.tools.set(event.toolCallId, { name: event.toolName, startedAt: new Date().toISOString(), output: '' });
    else if (event.type === 'tool_execution_update' && this.tools.has(event.toolCallId)) this.tools.get(event.toolCallId).output = clip(outputOf(event.partialResult), 6000);
    else if (event.type === 'tool_execution_end') this.tools.delete(event.toolCallId);
    else if (event.type === 'agent_settled') { this.message = null; this.tools.clear(); }
    else return;
    this.schedule();
  }
  apply(update) {
    const blocks = this.message.blocks; const index = update.contentIndex ?? 0;
    const kind = update.type.split('_')[0];
    if (update.type.endsWith('_start')) blocks[index] = { type: kind === 'toolcall' ? 'toolCall' : kind, text: '', name: update.toolName, id: update.id };
    const block = blocks[index] ||= { type: kind === 'toolcall' ? 'toolCall' : kind, text: '' };
    if (update.type.endsWith('_delta')) block.text = clip(block.text + (update.delta || ''), 16000);
    if (update.type === 'text_end' || update.type === 'thinking_end') block.text = clip(String(update.content ?? block.text), 16000);
    if (update.type === 'toolcall_end') { block.name = update.toolCall?.name || block.name; block.text = clip(JSON.stringify(update.toolCall?.arguments ?? {}), 16000); block.done = true; }
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.interval); this.timer.unref?.();
  }
  flush() {
    try {
      if (!this.message && !this.tools.size) { fs.rmSync(this.file, { force: true }); return; }
      atomicWriteJson(this.file, { updatedAt: new Date().toISOString(), message: this.message, tools: Object.fromEntries(this.tools) });
    } catch (error) {
      if (error?.code !== 'ENOENT') process.stderr.write(`LiveStream flush failed: ${error.message}\n`);
    }
  }
  close() { clearTimeout(this.timer); this.timer = null; this.message = null; this.tools.clear(); this.flush(); }
}
