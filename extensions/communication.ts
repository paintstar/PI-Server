import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Route model messages to its owning MCP controller without exposing provider credentials. */
export default function (pi: ExtensionAPI) {
  async function call(action: string, values: object, signal?: AbortSignal) {
    const messageId = randomUUID();
    let result: { error?: string };
    let attempts = 0;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(process.env.PI_SUBAGENT_ENDPOINT!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` },
          body: JSON.stringify({ action, agentId: process.env.PI_SUBAGENT_ID, messageId, ...values }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
        });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Controller request failed');
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && !['TypeError', 'TimeoutError'].includes(error.name)) throw error;
        if (++attempts > 5 && action !== 'question') throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** attempts, 5000)));
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
  }
  const consumed = new Set<string>();
  pi.on('context', async event => {
    for (const message of event.messages) {
      if (message.role !== 'user') continue;
      const text = typeof message.content === 'string' ? message.content : message.content.filter(value => value.type === 'text').map(value => value.text).join('\n');
      for (const match of text.matchAll(/\[Pi message ([0-9a-f-]{36})\]/g)) {
        if (consumed.has(match[1])) continue;
        await call('consumed', { messageId: match[1] }); consumed.add(match[1]);
      }
    }
  });
  pi.registerTool({
    name: 'agent_message', label: '子代理消息',
    description: 'Send a progress report to parent, or send a message to a sibling agent ID supplied by parent. Messages to siblings become steering/follow-up instructions. Do not include credentials.',
    parameters: Type.Object({ recipient: Type.String(), message: Type.String({ maxLength: 12000 }) }),
    execute: (_id, values, signal) => call('message', values, signal),
  });
  pi.registerTool({
    name: 'ask_parent', label: '询问主代理',
    description: 'Ask the parent agent a specific blocking question and wait for its answer. Use only when project evidence cannot resolve a required decision. The tool waits; do not repeatedly ask or invent an answer.',
    parameters: Type.Object({ question: Type.String({ maxLength: 12000 }) }),
    execute: (_id, values, signal) => call('question', values, signal),
  });
}
