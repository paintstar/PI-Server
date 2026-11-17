import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const dir = args.includes('--session-dir') ? flag('--session-dir') : process.cwd();
fs.mkdirSync(dir, { recursive: true });
const sessionFile = args.includes('--session') ? flag('--session') : path.join(dir, randomUUID() + '.jsonl');
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, '');
if (process.env.PI_SUBAGENT_ENDPOINT) await fetch(process.env.PI_SUBAGENT_ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` }, body: JSON.stringify({ action: 'policy_ready', agentId: process.env.PI_SUBAGENT_ID }) });
let model = { provider: flag('--provider') || 'fake', id: flag('--model') || 'cheap' };
let thinkingLevel = flag('--thinking') || 'high';
let active = false; let timer; let requestAbort;
let messages = []; let queue = [];
function finish(text, reason = 'stop') {
  if (!active) return;
  active = false;
  const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: reason, usage: { input: 10, output: 3, cost: { total: 0.01 } }, ...(reason === 'error' ? { errorMessage: text } : {}) };
  messages.push(message); fs.appendFileSync(sessionFile, JSON.stringify(message) + '\n');
  emit({ type: 'message_end', message }); emit({ type: 'agent_end' });
  if (queue.length) run(queue.shift()); else emit({ type: 'agent_settled' });
}
function run(prompt) {
  active = true; messages.push({ role: 'user', content: prompt }); emit({ type: 'agent_start' });
  if (prompt === 'HANG') return;
  if (prompt === 'ASK') {
    requestAbort = new AbortController();
    fetch(process.env.PI_SUBAGENT_ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` }, body: JSON.stringify({ action: 'question', agentId: process.env.PI_SUBAGENT_ID, question: 'Which value?' }), signal: requestAbort.signal }).then(r => r.json()).then(result => finish('ANSWER:' + result.answer)).catch(() => finish('aborted', 'aborted'));
    return;
  }
  timer = setTimeout(() => finish(prompt, prompt === 'FAIL' ? 'error' : 'stop'), 30);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const respond = (data, error) => emit({ type: 'response', id: command.id, command: command.type, success: !error, ...(error ? { error } : { data }) });
    switch (command.type) {
      case 'get_available_models': respond({ models: ['cheap', 'strong'].map(id => ({ provider: 'fake', id, name: id, reasoning: true, contextWindow: 100000, maxTokens: 1000, input: ['text'] })) }); break;
      case 'get_state': respond({ sessionFile, model, thinkingLevel, isStreaming: active }); break;
      case 'get_messages': respond({ messages }); break;
      case 'set_model': model = { provider: command.provider, id: command.modelId }; respond(model); break;
      case 'set_thinking_level': thinkingLevel = command.level; respond(); break;
      case 'prompt':
        command.message = command.message.replace(/^\[Pi message [0-9a-f-]{36}\]\n/, '');
        if (active) { queue.push(command.message); respond({ disposition: 'queued' }); }
        else { respond({ disposition: 'started' }); run(command.message); }
        break;
      case 'clear_queue': respond({ steering: queue, followUp: [] }); queue = []; break;
      case 'abort': clearTimeout(timer); requestAbort?.abort(); queue = []; finish('stopped', 'aborted'); respond(); break;
      default: respond(null, 'Unsupported command');
    }
  }
});
process.stdin.on('end', () => { clearTimeout(timer); requestAbort?.abort(); process.exit(0); });
