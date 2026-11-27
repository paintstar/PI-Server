import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PiProcess } from './rpc-client.js';
import { LiveStream } from './live-stream.js';
import { Storage, processAlive, atomicWriteJson, readJsonSafe, ownerLockAlive } from './storage.js';
import { normalizeParentInfo } from './controller-client.js';
import { MessageChannel } from './messages.js';
import { MessageStore } from './message-store.js';
import { agentPolicy, assertModelAllowed, reserveRequest } from './agent-policy.js';
import { sandboxProfile, canonicalPath } from './tool-sandbox.js';
import { createWorkspace, resolveWorkspaceMode, validateOwnedPaths, pathsOverlap } from './workspace.js';
import { catalogFilesStamp, enrichModels, fetchPiRawModels, readModelSettings } from './model-settings.js';
import { isCleanBenchmarkProfile } from './benchmark-profile.js';
import { buildAgentInstructions, normalizeOrchestration, runAcceptanceChecks, summarizeVerification, validateAcceptanceChecks } from './acceptance.js';

const extension = fileURLToPath(new URL('../extensions/communication.ts', import.meta.url));
export const maxAgentLimit = 50;
export const defaultMaxAgents = 50;
const activeStatuses = new Set(['starting', 'running', 'waiting', 'finishing']);
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/** Own Pi processes, durable sessions, model changes and events for an independent controller. */
export class Manager extends EventEmitter {
  constructor({ root, executable = 'pi', maxAgents = defaultMaxAgents, piAgentDir = process.env.PI_CODING_AGENT_DIR, processFactory = options => new PiProcess(options), checkRunner = runAcceptanceChecks }) {
    super();
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > maxAgentLimit) throw new Error(`maxAgents must be an integer from 1 to ${maxAgentLimit}`);
    this.storage = new Storage(root);
    this.executable = executable;
    this.maxAgents = maxAgents;
    this.piAgentDir = piAgentDir;
    this.processFactory = processFactory;
    this.checkRunner = checkRunner;
    this.owner = randomUUID();
    this.messages = new MessageStore(this.storage);
    this.agents = new Map();
    this.channel = new MessageChannel(this);
    this.closed = false;
    this.catalog = null;
    this.catalogStamp = '';
  }
  async start() { await this.channel.start(); return this; }
  get(id) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent is not owned by this connection. Use resume_agent to claim a saved session.');
    return agent;
  }
  summary(agent) {
    const r = agent.record;
    return { id: r.id, name: r.name, status: r.status, model: r.model, thinking: r.thinking, workspace: r.workspace, parentInfo: r.parentInfo,
      policy: r.policy, modelRequests: r.modelRequests, limitReason: r.limitReason, sequence: r.sequence, questionIds: r.questionIds, lastText: r.lastText?.slice(-12000), error: r.error,
      temporaryModel: r.restoreModel, usage: r.usage, sessionFile: r.sessionFile, createdAt: r.createdAt, updatedAt: r.updatedAt,
      verification: r.verification || { status: 'none' }, ...(r.acceptanceChecks ? { acceptanceChecks: r.acceptanceChecks } : {}), ...(r.orchestration ? { orchestration: r.orchestration } : {}) };
  }
  event(agent, type, data = {}) {
    const r = agent.record;
    const event = JSON.parse(JSON.stringify({ agentId: r.id, sequence: ++r.sequence, time: new Date().toISOString(), type, ...data }));
    r.updatedAt = event.time;
    agent.events.push(event);
    if (agent.events.length > 500) agent.events.shift();
    this.storage.append(r.id, event);
    this.storage.save(r);
    this.emit('event', event);
    return event;
  }
  serial(agent, operation) {
    const result = agent.control.then(operation);
    agent.control = result.catch(() => undefined);
    return result;
  }
  requireIdle(agent) {
    if (activeStatuses.has(agent.record.status)) throw new Error('Agent is busy. Wait for completion or explicitly interrupt it first.');
    if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is closed; resume it first.');
  }
  capacity() {
    if (this.closed) throw new Error('Controller is shutting down');
    if ([...this.agents.values()].filter(a => a.rpc && !a.rpc.exited).length >= this.maxAgents) throw new Error(`Agent limit reached (${this.maxAgents}). Close an idle agent first.`);
  }
  async models(provider, { includeDisabled = false } = {}) {
    const stamp = catalogFilesStamp(this.storage.root, this.piAgentDir);
    if (!this.catalog || stamp !== this.catalogStamp) {
      this.catalogStamp = stamp;
      this.catalog = (async () => {
        const models = await fetchPiRawModels({
          executable: this.executable,
          cwd: this.storage.root,
          agentDir: this.piAgentDir,
          processFactory: this.processFactory,
        });
        try {
          atomicWriteJson(path.join(this.storage.root, 'models-catalog.json'), enrichModels(models, this.storage.root, { includeDisabled: true }));
        } catch (error) {
          if (error?.code !== 'ENOENT') process.stderr.write(`Catalog write failed: ${error.message}\n`);
        }
        return models;
      })().catch(error => { this.catalog = null; this.catalogStamp = ''; throw error; });
    }
    const all = await this.catalog;
    return enrichModels(all, this.storage.root, { includeDisabled }).filter(m => !provider || m.provider === provider);
  }
  async validateModel(model) {
    const listed = await this.models(model.provider, { includeDisabled: true });
    const match = listed.find(m => m.model === model.model);
    if (!match) throw new Error(`Model is unavailable: ${model.provider}/${model.model}`);
    if (!match.enabled) throw new Error(`Model is disabled in settings: ${model.provider}/${model.model}`);
  }
  claim(record) {
    const lock = path.join(this.storage.directory(record.id), 'owner.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    const previous = readJsonSafe(lock);
    if (fs.existsSync(lock)) {
      if (previous && processAlive(previous.pid)) throw new Error('Saved agent is already controlled by a live process');
      try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    if (record.piPid && processAlive(record.piPid)) throw new Error('Saved Pi process is still alive after its controller disconnected; stop it before recovering, to avoid duplicate work');
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: this.owner })); fs.closeSync(fd);
    record.owner = this.owner; record.ownerPid = process.pid;
    return lock;
  }
  async spawn({ cwd, prompt, provider, model, name, ownedPaths, workspaceMode = 'auto', baseRef, thinking, context = '', parentId, parentInfo, parentSession, antigravitySessionId, opencodeSessionId, policy, acceptanceChecks, orchestration }) {
    if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
    const normalizedChecks = validateAcceptanceChecks(acceptanceChecks);
    const normalizedOrch = normalizeOrchestration(orchestration);
    this.capacity(); await this.validateModel({ provider, model }); this.capacity();
    const settingsDefaults = readModelSettings(this.storage.root).defaults;
    const effectiveThinking = thinking || settingsDefaults.thinking;
    const effectivePolicy = {
      ...(policy || {}),
      ...(policy?.allowNetwork === undefined ? { allowNetwork: settingsDefaults.allowNetwork } : {}),
      ...(policy?.sandboxMode === undefined && settingsDefaults.sandboxMode ? { sandboxMode: settingsDefaults.sandboxMode } : {}),
    };
    const builtPolicy = agentPolicy(effectivePolicy, { provider, model });
    const paths = validateOwnedPaths(ownedPaths, { readOnly: builtPolicy.readOnly });
    const { resolvedCwd: original, effectiveMode } = resolveWorkspaceMode({ cwd, mode: workspaceMode });
    if (effectiveMode === 'shared' && !builtPolicy.readOnly) {
      for (const a of this.agents.values()) {
        if (a.record.workspace?.mode === 'shared' && !a.record.policy?.readOnly && a.rpc && !a.rpc.exited && pathsOverlap(paths.map(p => canonicalPath(path.resolve(original, p))), a.record.ownedPaths.map(p => canonicalPath(path.resolve(a.record.workspace.sourceCwd, p))))) throw new Error('Owned paths overlap another live agent in the shared directory');
      }
      for (const saved of this.storage.all()) {
        if (this.agents.has(saved.id) || saved.workspace?.mode !== 'shared' || saved.policy?.readOnly || !ownerLockAlive(this.storage.directory(saved.id))) continue;
        if (pathsOverlap(paths.map(p => canonicalPath(path.resolve(original, p))), saved.ownedPaths.map(p => canonicalPath(path.resolve(saved.workspace.cwd, p))))) throw new Error('Owned paths overlap a live agent from an earlier controller');
      }
    }
    const id = randomUUID();
    const explicitParent = antigravitySessionId
      ? { kind: 'antigravity', sessionId: antigravitySessionId, cwd: original }
      : opencodeSessionId
        ? { kind: 'opencode', sessionId: opencodeSessionId, cwd: original }
        : parentSession ? { ...parentSession, cwd: parentSession.cwd || original } : null;
    const resolvedParentInfo = normalizeParentInfo(explicitParent, parentInfo);
    const cleanBenchmark = isCleanBenchmarkProfile(context);
    const record = { id, parentId, parentInfo: resolvedParentInfo, policy: builtPolicy, modelRequests: 0, name: name || id.slice(0, 8), model: { provider, model }, thinking: effectiveThinking, loadSkills: cleanBenchmark ? false : settingsDefaults.loadSkills, loadContextFiles: cleanBenchmark ? false : settingsDefaults.loadContextFiles, ownedPaths: paths, context,
      ...(normalizedChecks ? { acceptanceChecks: normalizedChecks } : {}), ...(normalizedOrch ? { orchestration: normalizedOrch } : {}), verification: { status: 'none' },
      status: 'starting', sequence: 0, questionIds: [], createdAt: new Date().toISOString(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedCost: 0 } };
    const lock = this.claim(record);
    try {
      record.workspace = createWorkspace({ cwd, id, mode: workspaceMode, baseRef, directory: this.storage.directory(id) });
      this.storage.save(record);
      const agent = { record, lock, events: [], control: Promise.resolve(), interruptedRun: false };
      this.agents.set(id, agent);
      await this.launch(agent);
      await this.send(id, prompt, 'steer');
      return this.summary(agent);
    } catch (error) {
      record.status = 'failed'; record.error = error.message; this.storage.save(record);
      const a = this.agents.get(id); if (a?.rpc) await a.rpc.close();
      this.agents.delete(id);
      this.release(lock); throw error;
    }
  }
  release(lock) {
    const value = readJsonSafe(lock);
    if (value?.owner === this.owner) {
      try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  async launch(agent) {
    const r = agent.record;
    agent.messageToken = randomUUID(); agent.policyReady = false;
    r.policy ||= agentPolicy({}, r.model);
    const tempDir = path.join(this.storage.directory(r.id), 'tool-tmp'); fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const toolPolicy = { ...r.policy, cwd: r.workspace.cwd, ownedPaths: r.ownedPaths, stateRoot: this.storage.root, tempDir };
    agent.toolPolicy = toolPolicy;
    if (!this.processFactory.testOnly) sandboxProfile(toolPolicy);
    const policyFile = path.join(this.storage.directory(r.id), 'tool-policy.json'); atomicWriteJson(policyFile, toolPolicy);
    const instructions = buildAgentInstructions(r);
    const args = ['--mode', 'rpc', '--offline', '--provider', r.model.provider, '--model', r.model.model, '--thinking', r.thinking,
      '--no-extensions', '--extension', extension, '--extension', fileURLToPath(new URL('../extensions/policy.ts', import.meta.url)), '--append-system-prompt', instructions, '--session-dir', path.join(this.storage.directory(r.id), 'sessions')];
    if (r.loadSkills === false) args.push('--no-skills');
    if (r.loadContextFiles === false) args.push('--no-context-files');
    if (r.sessionFile) args.push('--session', r.sessionFile);
    agent.rpc = this.processFactory({ executable: this.executable, args, cwd: r.workspace.cwd, env: {
      ...(this.piAgentDir ? { PI_CODING_AGENT_DIR: this.piAgentDir } : {}),
      PI_SUBAGENT_POLICY: policyFile, PI_SUBAGENT_ID: r.id, PI_SUBAGENT_ENDPOINT: this.channel.endpoint, PI_SUBAGENT_TOKEN: agent.messageToken,
    } });
    r.piPid = agent.rpc.child.pid;
    agent.live?.close(); agent.live = new LiveStream(path.join(this.storage.directory(r.id), 'live.json'));
    agent.rpc.on('event', event => { agent.live.handle(event); this.onPiEvent(agent, event); });
    agent.rpc.on('stopped', error => {
      clearTimeout(agent.runtimeTimer);
      agent.live.close();
      if (agent.closing) return;
      r.status = 'failed'; r.error = r.limitReason || error.message;
      this.channel.cancelAgent(r.id); this.event(agent, 'process_failed', { error: error.message }); this.release(agent.lock);
    });
    const state = await agent.rpc.command('get_state');
    if (!this.processFactory.testOnly) {
      for (let attempt = 0; attempt < 100 && !agent.policyReady && !agent.rpc.exited; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!agent.policyReady) throw new Error('Pi policy extension did not confirm startup; no model work was dispatched');
    }
    r.sessionFile = state.sessionFile;
    r.status = 'idle'; r.questionIds = []; r.error = undefined;
    this.event(agent, 'ready');
  }
  onPiEvent(agent, event) {
    const r = agent.record;
    if (event.type === 'agent_start') { r.status = r.questionIds.length ? 'waiting' : 'running'; this.event(agent, 'started'); }
    else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      const text = textOf(message); if (text) r.lastText = text.slice(-24000);
      r.stopReason = message.stopReason;
      r.error = message.stopReason === 'error' ? message.errorMessage || 'Model request failed' : undefined;
      if (message.usage) {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) r.usage[key] += message.usage[key] || 0;
        r.usage.reportedCost += message.usage.cost?.total || 0;
      }
      this.storage.save(r);
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      this.event(agent, event.type, { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
    } else if (event.type === 'agent_settled') {
      clearTimeout(agent.runtimeTimer); r.status = 'finishing';
      this.serial(agent, async () => {
        if (r.restoreModel) await this.restoreModel(agent);
        const baseStatus = r.limitReason || r.stopReason === 'error' ? 'failed' : r.stopReason === 'aborted' || agent.interrupting || agent.interruptedRun ? 'interrupted' : 'completed';
        if (r.limitReason) r.error = r.limitReason;
        if (baseStatus === 'completed' && r.acceptanceChecks?.length) {
          r.verification = { status: 'running', totalCount: r.acceptanceChecks.length, passedCount: 0, failedCount: 0, totalDurationMs: 0, checks: [] };
          this.event(agent, 'acceptance_started', { totalCount: r.acceptanceChecks.length });
          const ac = new AbortController(); agent.acceptanceAbort = ac;
          let result;
          try { result = await this.checkRunner(r.acceptanceChecks, agent.toolPolicy, { signal: ac.signal }); }
          finally { if (agent.acceptanceAbort === ac) agent.acceptanceAbort = null; }
          if (agent.interruptedRun || ac.signal.aborted || result?.aborted) {
            r.verification = { status: 'skipped', checkedAt: new Date().toISOString(), sandboxBackend: result?.sandboxBackend || null, totalDurationMs: result?.totalDurationMs || 0, passedCount: 0, failedCount: 0, totalCount: r.acceptanceChecks.length, checks: result?.checks || [] };
            r.status = 'interrupted';
          } else {
            r.verification = result;
            r.status = result.status === 'verified' ? 'completed-verified' : 'completed-unverified';
            this.event(agent, 'acceptance_completed', summarizeVerification(result));
          }
        } else if (r.acceptanceChecks?.length) {
          r.verification = { status: 'skipped', checkedAt: new Date().toISOString(), totalCount: r.acceptanceChecks.length, passedCount: 0, failedCount: 0, totalDurationMs: 0, checks: [] };
          r.status = baseStatus;
        } else {
          r.status = baseStatus;
        }
        this.event(agent, 'settled', { status: r.status, text: r.lastText, error: r.error, ...(r.acceptanceChecks?.length ? { verification: summarizeVerification(r.verification) } : {}) });
      }).catch(error => { r.status = 'failed'; r.error = error.message; this.event(agent, 'control_failed', { error: error.message }); });
    } else if (event.type === 'extension_error') this.event(agent, 'extension_error', { error: event.error || event.message });
  }
  async send(id, message, mode = 'steer', messageId = randomUUID()) {
    const agent = this.get(id);
    return this.serial(agent, async () => {
      if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is closed; resume it first');
      const receipt = this.messages.create(id, { messageId, direction: 'to_agent', sender: 'parent', message, mode });
      if (receipt.duplicate) return { accepted: receipt.record.state === 'accepted' || receipt.record.state === 'consumed', duplicate: true, receipt: receipt.record, agent: this.summary(agent) };
      if (agent.record.limitReason) { this.messages.update(id, messageId, { state: 'denied', reason: agent.record.limitReason }); throw new Error('Agent limit reached; obtain authorization and update its policy before more work.'); }
      const busy = activeStatuses.has(agent.record.status);
      if (!busy) {
        agent.interruptedRun = false;
        if (agent.record.acceptanceChecks?.length) agent.record.verification = { status: 'none' };
        agent.record.runStartedAt = Date.now();
        clearTimeout(agent.runtimeTimer);
        agent.runtimeTimer = setTimeout(() => {
          if (!agent.rpc || agent.rpc.exited || !activeStatuses.has(agent.record.status)) return;
          agent.record.limitReason = 'Maximum running time reached'; this.event(agent, 'budget_limit', { reason: agent.record.limitReason });
          this.serial(agent, async () => { const rpc = agent.rpc; if (!rpc || rpc.exited) return; try { await rpc.command('abort'); } finally { await rpc.close(); } }).catch(error => this.emit('controller_error', error));
        }, agent.record.policy.maxRuntimeMs); agent.runtimeTimer.unref();
        agent.record.status = 'running'; agent.record.error = undefined; agent.record.stopReason = undefined;
      }
      try {
        this.messages.update(id, messageId, { state: 'delivery_attempted' });
        const result = await agent.rpc.command('prompt', { message: `[Pi message ${messageId}]\n${message}`, ...(busy ? { streamingBehavior: mode === 'follow_up' ? 'followUp' : 'steer' } : {}) });
        const receipt = this.messages.update(id, messageId, { state: this.messages.all(id).find(value => value.messageId === messageId)?.state === 'consumed' ? 'consumed' : 'accepted', disposition: result?.disposition });
        this.event(agent, 'instruction', { messageId, mode, disposition: result?.disposition });
        if (result?.disposition === 'handled' && !busy) { agent.record.status = 'idle'; this.storage.save(agent.record); }
        return { accepted: true, disposition: result?.disposition, receipt, agent: this.summary(agent) };
      } catch (error) { this.messages.update(id, messageId, { state: this.messages.all(id).find(value => value.messageId === messageId)?.state === 'consumed' ? 'consumed' : 'uncertain', error: error.message }); if (!busy) { agent.record.status = 'failed'; agent.record.error = error.message; this.event(agent, 'instruction_failed', { error: error.message }); } throw error; }
    });
  }
  async restoreModel(agent) {
    const previous = agent.record.restoreModel;
    await agent.rpc.command('set_model', { provider: previous.model.provider, modelId: previous.model.model });
    await agent.rpc.command('set_thinking_level', { level: previous.thinking });
    agent.record.model = previous.model; agent.record.thinking = previous.thinking;
    delete agent.record.restoreModel;
    this.event(agent, 'model_restored', { model: agent.record.model });
  }
  async setModel(id, { provider, model, thinking, scope = 'session' }) {
    const agent = this.get(id);
    await this.validateModel({ provider, model });
    assertModelAllowed(agent.record.policy, { provider, model });
    return this.serial(agent, async () => {
      this.requireIdle(agent);
      if (agent.record.restoreModel) throw new Error('A temporary model change is already pending. Complete a run or restore it before changing again.');
      const old = { model: agent.record.model, thinking: agent.record.thinking };
      await agent.rpc.command('set_model', { provider, modelId: model });
      agent.record.model = { provider, model };
      if (scope === 'next_run') agent.record.restoreModel = old;
      this.storage.save(agent.record);
      if (thinking) await agent.rpc.command('set_thinking_level', { level: thinking });
      const state = await agent.rpc.command('get_state'); agent.record.thinking = state.thinkingLevel;
      this.event(agent, 'model_changed', { model: agent.record.model, scope });
      return this.summary(agent);
    });
  }
  async updatePolicy(id, policy, authorizationReference) {
    const agent = this.get(id);
    return this.serial(agent, async () => {
      if (activeStatuses.has(agent.record.status)) throw new Error('Wait for completion or interrupt before changing policy');
      const next = agentPolicy({ ...(agent.record.policy || {}), ...(policy || {}) }, agent.record.model); assertModelAllowed(next, agent.record.model);
      if (!agent.rpc || agent.rpc.exited) { this.capacity(); agent.lock = this.claim(agent.record); }
      agent.record.policy = next; agent.record.limitReason = undefined; agent.record.budgetWarned = false;
      this.event(agent, 'policy_changed', { policy: agent.record.policy, authorizationReference });
      // Tool policy is loaded once per Pi process: restart an idle session without replaying work.
      agent.closing = true; await agent.rpc?.close(); agent.closing = false; await this.launch(agent);
      return this.summary(agent);
    });
  }
  reserveProviderRequest(id, requestId) {
    const agent = this.get(id);
    try { const result = reserveRequest(agent, requestId, this.messages); this.storage.save(agent.record); return result; }
    catch (error) { this.event(agent, 'budget_limit', { reason: error.message }); throw error; }
  }
  async interrupt(id) {
    const agent = this.get(id);
    agent.interruptedRun = true;
    agent.acceptanceAbort?.abort();
    return this.serial(agent, async () => {
      if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is not running');
      clearTimeout(agent.runtimeTimer); agent.interrupting = true;
      try {
        const cleared = await agent.rpc.command('clear_queue');
        this.channel.cancelAgent(id);
        await agent.rpc.command('abort');
        agent.record.status = 'interrupted'; this.event(agent, 'interrupted', { cleared });
        return this.summary(agent);
      } finally { agent.interrupting = false; }
    });
  }
  async closeAgent(id) {
    const agent = this.get(id);
    agent.interruptedRun = true;
    agent.acceptanceAbort?.abort();
    let shutdownError;
    if (activeStatuses.has(agent.record.status)) {
      try { await this.interrupt(id); }
      catch (error) { shutdownError = error.message; }
    }
    return this.serial(agent, async () => {
      clearTimeout(agent.runtimeTimer); agent.closing = true; this.channel.cancelAgent(id); await agent.rpc?.close();
      agent.record.status = 'closed'; this.event(agent, 'closed'); this.release(agent.lock);
      return { ...this.summary(agent), ...(shutdownError ? { shutdownError } : {}) };
    });
  }
  async resume(id, options = {}) {
    this.capacity();
    const existing = this.agents.get(id);
    if (existing?.rpc && !existing.rpc.exited) throw new Error('Agent already has a live process');
    const record = this.storage.load(id);
    this.storage.repairEvents(id);
    record.sequence = Math.max(record.sequence, this.storage.events(id).at(-1)?.sequence || 0);
    const explicitParent = options?.antigravitySessionId
      ? { kind: 'antigravity', sessionId: options.antigravitySessionId, cwd: record.workspace?.sourceCwd || record.workspace?.cwd }
      : options?.opencodeSessionId
        ? { kind: 'opencode', sessionId: options.opencodeSessionId, cwd: record.workspace?.sourceCwd || record.workspace?.cwd }
        : options?.parentSession || null;
    if (explicitParent) record.parentInfo = normalizeParentInfo(explicitParent, record.parentInfo);
    for (const question of this.messages.all(id).filter(value => value.direction === 'question' && value.state === 'stored')) this.messages.update(id, question.messageId, { state: 'cancelled' });
    if (!record.sessionFile || !fs.existsSync(record.sessionFile)) throw new Error('No saved Pi session is available');
    await this.validateModel(record.model); this.capacity();
    const lock = this.claim(record);
    const agent = { record, lock, events: this.storage.events(id), control: Promise.resolve(), interruptedRun: false };
    this.agents.set(id, agent);
    try { await this.launch(agent); this.event(agent, 'resumed'); return this.summary(agent); }
    catch (error) { record.status = 'failed'; record.error = error.message; this.storage.save(record); if (agent.rpc) await agent.rpc.close(); this.agents.delete(id); this.release(lock); throw error; }
  }
  bindParentInfo(id, parent, parentId) {
    const agent = this.get(id);
    if (parentId && agent.record.parentId !== parentId) agent.record.parentId = parentId;
    const merged = normalizeParentInfo(parent, agent.record.parentInfo);
    if (merged) agent.record.parentInfo = merged;
    if (parentId || merged) this.storage.save(agent.record);
    return this.summary(agent);
  }
  list(includeSaved = false) {
    const current = [...this.agents.values()].map(a => this.summary(a));
    if (!includeSaved) return current;
    return [...current, ...this.storage.all().filter(r => !this.agents.has(r.id)).map(r => ({ ...this.summary({ record: r }), owned: false, controllerAlive: ownerLockAlive(this.storage.directory(r.id)) }))];
  }
  read(id, afterSequence = 0, limit = 50) {
    const agent = this.get(id);
    let events;
    if (afterSequence >= agent.record.sequence) {
      events = [];
    } else if (agent.events.length && agent.events[0].sequence <= afterSequence + 1) {
      events = agent.events.filter(event => event.sequence > afterSequence).slice(0, limit);
    } else {
      events = this.storage.events(id, afterSequence, limit);
    }
    return { agent: this.summary(agent), events, nextSequence: events.at(-1)?.sequence ?? Math.min(afterSequence, agent.record.sequence),
      truncated: events.length > 0 && events[0].sequence > afterSequence + 1 };
  }
  async wait(ids, after = {}, timeoutMs = 25000, signal) {
    ids.forEach(id => this.get(id));
    const snapshot = () => ids.map(id => this.read(id, after[id] || 0)).filter(value => value.events.length);
    const immediate = snapshot(); if (immediate.length) return { reason: 'event', results: immediate };
    if (!timeoutMs) return { reason: 'snapshot', results: ids.map(id => this.read(id, after[id] || 0)) };
    return new Promise(resolve => {
      let settled = false;
      const finish = reason => {
        if (settled) return; settled = true; clearTimeout(timer); this.off('event', onEvent); signal?.removeEventListener('abort', onAbort);
        resolve({ reason, results: ids.map(id => this.read(id, after[id] || 0)) });
      };
      const onEvent = event => { if (ids.includes(event.agentId) && event.sequence > (after[event.agentId] || 0)) finish('event'); };
      const onAbort = () => finish('cancelled');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.on('event', onEvent); signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish('cancelled');
      else if (snapshot().length) finish('event');
    });
  }
  async close() {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.agents.keys()].map(id => this.closeAgent(id)));
    await this.channel.close();
  }
}
