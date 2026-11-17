import { estimateTextTokens } from './token-estimate.js';
import { atomicWriteJson } from './storage.js';

export function estimateTokens(text = '') {
  return estimateTextTokens(text);
}

/** Streamed text of one raw provider event, for OpenAI Responses, Chat Completions and Anthropic shapes. */
export function deltaText(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.type === 'string' && data.type.endsWith('.delta') && typeof data.delta === 'string') return data.delta;
  if (data.type === 'content_block_delta') return data.delta?.text ?? data.delta?.thinking ?? data.delta?.partial_json ?? null;
  const choice = data.choices?.[0]?.delta;
  if (choice) return [choice.content, choice.reasoning_content, ...(choice.tool_calls || []).map(call => call.function?.arguments)].filter(v => typeof v === 'string').join('') || null;
  return null;
}

/** Hidden reasoning started: the provider will not stream these tokens, only their final count. */
const reasoningStarted = data => (data?.type === 'response.output_item.added' && data.item?.type === 'reasoning')
  || (data?.type === 'content_block_start' && data.content_block?.type === 'thinking');

/**
 * Real-time output speed of one agent. Each streamed delta is usually one token; longer deltas are estimated.
 * The final count of every request comes from the provider usage at message end, so history stays exact.
 */
export class SpeedMeter {
  constructor(file, { now = () => Date.now(), interval = 150, window = 2000 } = {}) {
    Object.assign(this, { file, now, interval, window, timer: null, request: null, series: [], history: [] });
  }
  start() {
    this.request = { startedAt: this.now(), firstTokenAt: null, phase: 'waiting', tokens: 0, recent: [] };
    this.schedule();
  }
  event(data) {
    if (!this.request) this.start();
    const request = this.request;
    if (reasoningStarted(data) && !request.firstTokenAt) { request.phase = 'thinking'; this.schedule(); return; }
    const text = deltaText(data);
    if (!text) return;
    const now = this.now(); const count = text.length <= 8 ? 1 : estimateTokens(text);
    request.firstTokenAt ??= now; request.phase = 'output'; request.tokens += count;
    request.recent.push([now, count]);
    this.schedule();
  }
  /** Exact numbers reported by the provider once the message is complete. */
  finish(usage) {
    const request = this.request; if (!request) return;
    const end = this.now(); const output = usage?.output || Math.round(request.tokens);
    const seconds = (end - request.startedAt) / 1000;
    const visible = request.firstTokenAt ? (end - request.firstTokenAt) / 1000 : 0;
    this.history.push({ at: new Date(end).toISOString(), output, reasoning: usage?.reasoning || 0, seconds: round(seconds),
      waitSeconds: request.firstTokenAt ? round((request.firstTokenAt - request.startedAt) / 1000) : null,
      tps: seconds > 0 ? round(output / seconds) : 0, streamTps: visible > 0.2 ? round(request.tokens / visible) : null });
    this.history = this.history.slice(-40); this.request = null; this.flush();
  }
  rate() {
    const request = this.request; if (!request) return 0;
    const now = this.now(); request.recent = request.recent.filter(([time]) => now - time <= this.window);
    if (!request.recent.length) return 0;
    const span = Math.max(250, Math.min(this.window, now - request.recent[0][0]));
    return request.recent.reduce((sum, [, count]) => sum + count, 0) / (span / 1000);
  }
  snapshot() {
    const now = this.now(); const request = this.request; const rate = round(this.rate());
    this.series.push([now, rate]); this.series = this.series.filter(([time]) => now - time <= 60000);
    return { updatedAt: new Date(now).toISOString(), rate, series: this.series, history: this.history,
      request: request && { phase: request.phase, startedAt: new Date(request.startedAt).toISOString(), tokens: Math.round(request.tokens),
        firstTokenAt: request.firstTokenAt && new Date(request.firstTokenAt).toISOString() } };
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); if (this.request) this.schedule(); }, this.interval);
    this.timer.unref?.();
  }
  flush() {
    try { atomicWriteJson(this.file, this.snapshot()); }
    catch (error) {
      if (error?.code !== 'ENOENT') process.stderr.write(`SpeedMeter flush failed: ${error.message}\n`);
    }
  }
  close() { clearTimeout(this.timer); this.timer = null; this.request = null; this.flush(); }
}
const round = value => Math.round(value * 10) / 10;
