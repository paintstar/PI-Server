import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const waitScriptPath = path.join(projectRoot, 'scripts/wait-events.js');
export const sessionIdPattern = /^[A-Za-z0-9._:-]+$/;
const working = new Set(['starting', 'running', 'finishing']);

export function assertSafeSessionId(sessionId) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized || normalized.length > 200 || !sessionIdPattern.test(normalized)) {
    throw new Error('Invalid sessionId');
  }
  return normalized;
}

export function waitCommandFor({ agentId, sessionId } = {}) {
  if (sessionId) return `node "${waitScriptPath}" --session ${assertSafeSessionId(sessionId)}`;
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id || id.length > 200 || !sessionIdPattern.test(id)) throw new Error('Invalid agentId');
  return `node "${waitScriptPath}" --agent ${id}`;
}

export function spawnReminder(agentId, { sessionId } = {}) {
  const antigravityBackgroundCommand = waitCommandFor({ agentId, sessionId });
  const claudeCommand = waitCommandFor({ agentId });
  return {
    rule: '子代理已在后台运行，但这只是受理，不是完成。结束本轮回答之前，必须对它调用 wait_agent 直到状态变成 completed、failed、interrupted 或 closed；如果确实要提前结束本轮，要明确告诉用户它仍在后台运行以及怎么查看。',
    next: `立刻调用 wait_agent，agentIds 填 ["${agentId}"]，after 先用本次返回的 sequence。`,
    claudeCode: `Claude Code：另外把这条命令作为后台命令运行，事件到达时会唤醒你：${claudeCommand}`,
    antigravityBackgroundCommand,
    antigravity: `Antigravity：可继续调用 wait_agent，或用 run_command（WaitMsBeforeAsync=500, IsDaemon=false）在后台启动 ${antigravityBackgroundCommand}，事件到达时会自动唤醒当前会话。`,
  };
}

export function waitReminder(result, { sessionId } = {}) {
  const pending = [], asking = [];
  for (const item of result.results || []) {
    const status = item.agent?.status;
    const entry = { agentId: item.agent?.id, status, after: item.nextSequence };
    if (working.has(status)) pending.push(entry); else if (status === 'waiting') asking.push(entry);
  }
  if (!pending.length && !asking.length) return result;
  const targetId = asking[0]?.agentId || pending[0]?.agentId;
  return {
    ...result, pending, asking,
    antigravityBackgroundCommand: waitCommandFor({ agentId: targetId, sessionId }),
    reminder: [asking.length ? '有代理正在等待答复：先读取它的提问，用 reply_question 回答，否则它不会继续。' : null,
      pending.length ? '仍有代理在工作：把各自的 after 填进下一次 wait_agent 继续等，不要在它们结束前收尾本轮；若必须结束，要先告诉用户它们仍在后台运行。' : null].filter(Boolean).join(' '),
  };
}
