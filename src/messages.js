import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Durable reports/questions, replay-safe answers and authenticated local child communication. */
export class MessageChannel {
  constructor(manager) {
    this.manager = manager; this.questions = new Map();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => this.respond(response, 400, { error: error.message }));
    });
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}/message`;
  }
  respond(response, status, data) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data));
  }
  async handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/message') { this.respond(response, 404, { error: 'Not found' }); return; }
    let bytes = 0; const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 20000) { this.respond(response, 413, { error: 'Message is too large' }); return; }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const authorization = Buffer.from(request.headers.authorization || '');
    const possible = this.manager.agents.get(value.agentId);
    const expected = Buffer.from(`Bearer ${possible?.messageToken || randomUUID()}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { this.respond(response, 401, { error: 'Unauthorized' }); return; }
    const agent = this.manager.get(value.agentId);
    if (!agent.rpc || agent.rpc.exited) throw new Error('Agent is not active');
    if (value.action === 'policy_ready') { agent.policyReady = true; this.respond(response, 200, { ready: true }); return; }
    if (value.action === 'reserve_request') { this.respond(response, 200, this.manager.reserveProviderRequest(value.agentId, value.messageId)); return; }
    if (value.action === 'consumed') {
      const record = this.manager.messages.all(value.agentId).find(item => item.messageId === value.messageId && item.direction === 'to_agent');
      if (!record) throw new Error('Unknown instruction receipt');
      if (record.state === 'consumed') { this.respond(response, 200, { consumed: true, duplicate: true }); return; }
      this.manager.messages.update(value.agentId, value.messageId, { state: 'consumed', consumedAt: new Date().toISOString() });
      this.manager.event(agent, 'message_consumed', { messageId: value.messageId });
      this.respond(response, 200, { consumed: true }); return;
    }
    if (value.action === 'message') {
      if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 12000) throw new Error('Invalid message');
      if (value.recipient !== 'parent' && this.manager.get(value.recipient).record.parentId !== agent.record.parentId) throw new Error('Sibling belongs to another parent');
      const result = this.manager.messages.create(value.agentId, { messageId: value.messageId, direction: 'from_agent', sender: value.agentId, recipient: value.recipient, message: value.message });
      if (!result.duplicate) {
        if (value.recipient === 'parent') this.manager.event(agent, 'message', { messageId: result.record.messageId, sender: value.agentId, recipient: 'parent', message: value.message });
        else {
          const target = this.manager.get(value.recipient);
          if (target.record.parentId !== agent.record.parentId) throw new Error('Sibling belongs to another parent');
          this.manager.messages.update(value.agentId, result.record.messageId, { state: 'uncertain' });
          const delivery = await this.manager.send(value.recipient, `[Message from sibling ${value.agentId}]\n${value.message}`, 'steer', result.record.messageId);
          if (!delivery.accepted) throw new Error('Sibling delivery is uncertain; inspect its receipt before retrying');
        }
      }
      const receipt = result.duplicate ? result.record : this.manager.messages.update(value.agentId, result.record.messageId, { state: 'accepted' });
      this.respond(response, 200, { accepted: receipt.state === 'accepted', messageId: receipt.messageId, duplicate: result.duplicate, state: receipt.state });
    } else if (value.action === 'question') {
      if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 12000) throw new Error('Invalid question');
      const result = this.manager.messages.create(value.agentId, { messageId: value.messageId, direction: 'question', sender: value.agentId, question: value.question });
      const questionId = result.record.messageId;
      if (result.record.state === 'answered') { this.respond(response, 200, { questionId, answer: result.record.answer }); return; }
      if (result.record.state === 'cancelled') throw new Error('Question was cancelled');
      let question = this.questions.get(questionId);
      if (!question) { question = { agentId: value.agentId, responses: new Set() }; this.questions.set(questionId, question); }
      question.responses.add(response);
      if (!agent.record.questionIds.includes(questionId)) agent.record.questionIds.push(questionId);
      agent.record.status = 'waiting';
      if (!result.duplicate) this.manager.event(agent, 'question', { questionId, question: value.question });
      response.on('close', () => question.responses.delete(response));
      // A dropped transport is not a cancelled question. The child may reconnect using the same ID.
    } else throw new Error('Unknown message action');
  }
  reply(questionId, message) {
    const question = this.questions.get(questionId);
    if (!question) {
      for (const agent of this.manager.agents.values()) {
        const old = this.manager.messages.all(agent.record.id).find(value => value.messageId === questionId);
        if (old?.state === 'answered') {
          if (old.answer !== message) throw new Error('Question already answered differently');
          return { answered: true, duplicate: true, agentId: agent.record.id, questionId };
        }
      }
      throw new Error('Question is no longer waiting; read the current agent state');
    }
    const agent = this.manager.get(question.agentId);
    this.manager.messages.update(question.agentId, questionId, { state: 'answered', answer: message });
    this.questions.delete(questionId); agent.record.questionIds = agent.record.questionIds.filter(id => id !== questionId);
    if (!agent.record.questionIds.length) agent.record.status = 'running';
    this.manager.event(agent, 'answer', { questionId, message });
    for (const response of question.responses) this.respond(response, 200, { questionId, answer: message });
    return { answered: true, agentId: question.agentId, questionId };
  }
  cancelAgent(id) {
    for (const [questionId, question] of this.questions) {
      if (question.agentId !== id) continue;
      this.questions.delete(questionId); this.manager.messages.update(id, questionId, { state: 'cancelled' });
      for (const response of question.responses) this.respond(response, 409, { error: 'Parent interrupted or closed this agent' });
    }
    this.manager.get(id).record.questionIds = [];
  }
  async close() {
    for (const id of this.manager.agents.keys()) this.cancelAgent(id);
    this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve));
  }
}
