#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Manager, defaultMaxAgents, maxAgentLimit } from './manager.js';
import { connectController, normalizeParentInfo } from './controller-client.js';
import { FileTaskStore, RemoteTaskStore } from './task-store.js';
import { installCommunication } from './mcp-communication.js';
import { installTaskTool } from './mcp-tasks.js';
import { installCallbacks, callbackShape } from './callbacks.js';
import { agentChanges } from './agent-changes.js';
import { Storage } from './storage.js';
import { getProviderQuota, quotaProviders } from './quota-providers.js';
import { DashboardData } from './dashboard-data.js';
import { dashboardInfo, ensureDashboard } from './dashboard-launcher.js';
import { spawnReminder, waitReminder, waitCommandFor, sessionIdPattern } from './wait-reminder.js';
import { buildSettingsPayload, enrichModels, filterModelProfiles } from './model-settings.js';
import { inspectOpencodeConfig } from './opencode-config.js';
import { sandboxHealth } from './tool-sandbox.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
export const instructions = `HARD RULE: after spawn_agent or send_message starts work, you must not end your turn while any child is still starting/running/finishing/waiting. Keep calling wait_agent (passing each nextSequence in after[agentId]) until every child is completed, failed, interrupted or closed. If you truly must stop earlier, tell the user plainly that the children are still running in the background. Forgetting to wait is the most common failure: the host cannot wake you after your turn ends. spawn_agent and wait_agent results carry a reminder field; follow it. Claude Code parents should also run the wait-events command given in the spawn result as a background command so events wake them. Antigravity parents should pass their Conversation ID as antigravitySessionId on spawn_agent/resume_agent (or call bind_session), then wait synchronously with wait_agent or asynchronously via run_command (WaitMsBeforeAsync=500, IsDaemon=false) running the mustWait.antigravityBackgroundCommand (scripts/wait-events.js --session <Conversation ID>); installed Antigravity hooks also inject pending events on PreInvocation and prevent premature Stop while a child lacks an active watcher. OpenCode parents should pass their session ID as opencodeSessionId (or parentSession={kind:"opencode", sessionId} / bind_session(kind="opencode")), wait with wait_agent or scripts/wait-events.js --session <sessionId>, and may opt in to callback.opencodeCliWake=true for CLI session wake-ups.
Pi external subagents supplement the host agent's capabilities, enabling large-scale parallel work with configured models. Use this capability only when the human user has explicitly authorized external model delegation in the conversation. A generic coding request or available quota is not authorization. Respect the authorized task, providers/models, concurrency and spending limits; continue within existing authorization without repeatedly asking. Ask the user before expanding beyond it, including additional paid usage. Read-only inspection does not require delegation authorization. Use get_client_capabilities and get_subagent_health to inspect capabilities and health. Use get_model_profiles or list_models to check context windows, model capability descriptions and Pi tool defaults, then spawn_agent with an explicit provider/model, absolute cwd, ownedPaths and concrete acceptance criteria. Spawn returns immediately; accepted does not mean completed. While children run, use wait_agent with each returned nextSequence as after[agentId], read_agent for details and reply_question for blocking questions. Send messages via send_message; steer is delivered at a Pi turn boundary. Waits return events, including progress; inspect status and keep waiting until completed, failed, interrupted or closed. Change models only when idle, or interrupt first; next_run restores the previous model after a settled run. Claims of success need actual changes/checks, not model prose. Standard resource, logging and task notifications are available, but host UI support does not guarantee model-turn wake after a parent turn ended. Keep coordinating until the assigned tasks finish. spawn_agent enables wake-up callbacks by default: Antigravity gets hook/watcher session callbacks and optional agy CLI resume; OpenCode gets session watcher callbacks and optional opencode CLI wake; Claude Code gets channel notifications when this server is enabled as a channel; Codex parents should pass callback.codexThreadId from the shell command "echo $CODEX_THREAD_ID" so settled/question events are queued into their thread. Callbacks are hints, never acceptance. Use get_agent_changes to review actual files. Git worktrees preserve only the explicit committed baseRef; review/merge changes separately. New agents use OS-restricted tool processes. Declare ownedPaths; omit policy maxModelRequests/maxTotalTokens/maxRuntimeMs unless the human user explicitly requested a hard cap (defaults already allow 100000 requests, 1e12 non-cached tokens, and 7 days runtime). Non-cached tokens (input, output, cacheWrite) are observed before each request, so an in-flight request can exceed the threshold; these limits do not guarantee an exact currency charge. Supply stable requestId/messageId on retries; uncertain delivery must be inspected, not replayed. Credentials remain in Pi; get_quota reads Pi credentials only to perform account-scoped read-only quota queries. Quota is not spending authorization. Do not send provider secrets in tools. Never auto-deploy or send external messages. The independent controller keeps agents/questions alive after MCP disconnects. Use resume_agent or resume_task to attach to their saved identities after reconnecting; do not rerun completed work blindly.`;

const id = z.string().uuid();
const text = z.string().min(1).max(24000);
const safeSessionId = () => z.string().trim().min(1).max(200).regex(sessionIdPattern);
const policyShape = z.object({ allowedModels: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1).max(50).optional(), maxModelRequests: z.number().int().min(1).max(1000000).optional(), maxTotalTokens: z.number().int().min(1).max(1e12).optional(), maxRuntimeMs: z.number().int().min(1000).max(2147483647).optional(), maxOutputTokens: z.number().int().min(1).max(1000000).optional(), allowNetwork: z.boolean().optional(), sandboxMode: z.enum(['strict', 'dev', 'bypass']).optional() }).describe('Optional runtime overrides. Omit maxModelRequests, maxTotalTokens and maxRuntimeMs unless the human user explicitly requested a hard cap.');
const thinkingShape = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const parentSessionShape = () => z.object({
  kind: z.enum(['antigravity', 'codex', 'claude', 'opencode', 'mcp']).optional(),
  sessionId: safeSessionId(),
  hostSessionId: z.string().trim().min(1).max(200).optional(),
  cwd: z.string().min(1).max(2000).optional(),
});
const spawnShape = {
  requestId: id.optional(), policy: policyShape.optional(), cwd: z.string().min(1), prompt: text, provider: z.string().min(1), model: z.string().min(1), name: z.string().max(100).optional(),
  ownedPaths: z.array(z.string().min(1)).min(1).max(100), context: z.string().max(40000).default(''),
  workspaceMode: z.enum(['auto', 'worktree', 'shared']).default('auto'), baseRef: z.string().optional(), thinking: thinkingShape.optional(),
  antigravitySessionId: safeSessionId().optional(), opencodeSessionId: safeSessionId().optional(), parentSession: parentSessionShape().optional(),
};

async function collectHealth(manager, callbacks, managerOptions) {
  let pi = { executable: managerOptions.executable, ok: false };
  try {
    const { stdout } = await execFileAsync(managerOptions.executable, ['--version'], { timeout: 2000 });
    pi = { executable: managerOptions.executable, ok: true, version: stdout.trim() };
  } catch (error) {
    pi = { executable: managerOptions.executable, ok: false, error: error.message };
  }
  let controller;
  if (manager.health) {
    try { controller = { ok: true, ...await manager.health() }; }
    catch (error) { controller = { ok: false, error: error.message }; }
  } else {
    controller = { ok: true, embedded: true, activeAgents: manager.agents.size, maxAgents: manager.maxAgents };
  }
  let modelsCount = 0; let modelsError;
  try { modelsCount = (await manager.models()).length; }
  catch (error) { modelsError = error.message; }
  const pluginDir = path.join(process.env.PI_ANTIGRAVITY_PLUGINS_DIR || path.join(os.homedir(), '.gemini/config/plugins'), 'pi-subagents');
  const opencode = inspectOpencodeConfig();
  const sandbox = sandboxHealth();
  return {
    ok: Boolean(pi.ok && controller.ok),
    host: callbacks.host(),
    pi,
    controller,
    sandbox,
    sandboxExec: process.platform === 'darwin' ? sandbox.ok : null,
    modelsCount,
    ...(modelsError ? { modelsError } : {}),
    dashboardUrl: dashboardInfo(manager.storage.root)?.url || null,
    antigravityPluginInstalled: fs.existsSync(path.join(pluginDir, 'plugin.json')),
    antigravityHooksConfigured: fs.existsSync(path.join(pluginDir, 'hooks.json')),
    opencodeMcpConfigured: opencode.mcpConfigured,
    opencodeSkillInstalled: opencode.skillInstalled,
  };
}

async function queryProfileModels(manager, { provider, search, includeDisabled }) {
  const raw = await manager.models(provider, { includeDisabled });
  const list = raw.length && raw[0].description !== undefined ? raw : enrichModels(raw, manager.storage.root, { includeDisabled });
  return filterModelProfiles(list, { provider, search });
}

function registerModelAndQuotaTools({ register, manager, options }) {
  register('get_quota', 'Read plan quotas or balance directly using Pi credentials for Codex, GLM (zhipu/zai), MiniMax Token Plan, DeepSeek and OpenCode Go. Default all queries configured supported providers; choose provider to query one. Returns each service separately, including visible failures. Missing fields are unknown; credit units and currency amounts differ. Quota does not grant spending permission: respect explicit user budget, ask before extra paid usage or reset credits. Never purchases, redeems, refreshes credentials or calls models.', {
    provider: z.enum(['all', ...quotaProviders]).default('all'),
  }, (values, extra) => getProviderQuota({ ...values, agentDir: options.piAgentDir, signal: extra.signal }), true);
  register('list_models', 'List authenticated Pi model choices with context windows and capability descriptions. Disabled models/providers in settings are excluded unless includeDisabled is true. Explicitly choose provider/model for each agent; prices are catalog values, not measured charges.', {
    provider: z.string().max(200).optional(), search: z.string().max(200).optional(), includeDisabled: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(60),
  }, async ({ provider, search, includeDisabled, limit }) => {
    const models = await queryProfileModels(manager, { provider, search, includeDisabled });
    return { models: models.slice(0, limit), total: models.length, truncated: models.length > limit };
  }, true);
  register('get_model_profiles', 'Read Pi subagent model profiles (context window, capability description, recommended thinking, differences), provider readiness without secrets, and configured Pi tool/sandbox defaults before delegating work.', {
    provider: z.string().max(200).optional(), search: z.string().max(200).optional(), includeDisabled: z.boolean().default(false),
  }, async ({ provider, search, includeDisabled }) => {
    const filtered = await queryProfileModels(manager, { provider, search, includeDisabled });
    const payload = buildSettingsPayload({ stateRoot: manager.storage.root, agentDir: options.piAgentDir });
    const providers = payload.providers
      .filter(item => !provider || item.provider === provider)
      .map(({ provider: p, enabled, configured, authType, expired, baseUrl, totalModelsCount, enabledModelsCount }) => ({
        provider: p, enabled, configured, authType, expired, baseUrl, totalModelsCount, enabledModelsCount,
      }));
    return {
      models: filtered.map(({ provider: p, model, name, enabled, contextWindow, maxTokens, reasoning, recommendedThinking, input, cost, description }) => ({
        provider: p, model, name, enabled, contextWindow, maxTokens, reasoning, recommendedThinking, input, cost, description,
      })),
      providers,
      subagentTools: payload.subagentTools,
      defaults: payload.defaults,
    };
  }, true);
}

function registerOrganizeTool({ register, manager, callbacksRef }) {
  register('organize_agents', 'Edit session display title, summary note, pinned flag, group (plain custom names are stored as custom:<name>), manual status mark, or archive/unarchive finished sessions (shared live with the 3141 dashboard). Never stops or alters running Pi processes.', {
    agentIds: z.array(id).min(1).max(maxAgentLimit),
    title: z.string().max(100).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    pinned: z.boolean().optional(),
    group: z.string().max(300).nullable().optional(),
    statusMark: z.enum(['completed', 'closed']).nullable().optional(),
    archived: z.boolean().optional(),
  }, async ({ agentIds, ...patch }) => {
    const listed = new Map((await manager.list(true)).map(agent => [agent.id, agent]));
    const callbacks = callbacksRef();
    const envSessionId = process.env.ANTIGRAVITY_CONVERSATION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.OPENCODE_SESSION_ID;
    for (const agentId of agentIds) {
      const target = listed.get(agentId);
      const cb = callbacks.get(agentId);
      const sameHostSession = envSessionId && (target?.parentInfo?.sessionId === envSessionId || cb?.antigravitySessionId === envSessionId || cb?.opencodeSessionId === envSessionId);
      if (target?.attachedOtherParent && !sameHostSession) {
        throw new Error('Agent belongs to another attached parent');
      }
    }
    return new DashboardData(manager.storage.root).organize(agentIds, patch);
  });
}

function registerSessionTools({ register, manager, server, options, managerOptions, resolveSessionId, callbacksRef }) {
  registerModelAndQuotaTools({ register, manager, options });
  registerOrganizeTool({ register, manager, callbacksRef });
  register('list_agents', 'Inspect current children, or include saved sessions for explicit recovery, optionally filtered by Antigravity/host sessionId or archiveFilter. Includes dashboard display title, note, pinned and archived state.', {
    includeSaved: z.boolean().default(false),
    sessionId: safeSessionId().optional(),
    archiveFilter: z.enum(['all', 'active', 'archived']).default('all'),
  }, async ({ includeSaved, sessionId, archiveFilter }) => {
    const raw = await manager.list(includeSaved);
    const callbacks = callbacksRef();
    const dash = new DashboardData(manager.storage.root);
    const enriched = raw.map(agent => {
      const org = dash.organizationOf(agent.id, agent);
      return org ? { ...agent, displayName: org.title || agent.name, organization: org } : agent;
    });
    const agents = enriched.filter(agent => {
      const cb = callbacks.get(agent.id);
      if (sessionId && agent.parentInfo?.sessionId !== sessionId && cb?.antigravitySessionId !== sessionId && cb?.opencodeSessionId !== sessionId) return false;
      const isArchived = Boolean(agent.organization?.archived);
      if (archiveFilter === 'active' && isArchived) return false;
      if (archiveFilter === 'archived' && !isArchived) return false;
      return true;
    });
    return { agents, dashboardUrl: dashboardInfo(manager.storage.root)?.url };
  }, true);
  register('bind_session', 'Bind the current MCP connection and owned or named agents to an Antigravity, OpenCode, or other host session so hooks, callbacks and dashboard group them cleanly.', {
    sessionId: safeSessionId(),
    kind: z.enum(['antigravity', 'codex', 'claude', 'opencode', 'mcp']).optional(),
    cwd: z.string().min(1).max(2000).optional(),
    agentIds: z.array(id).max(maxAgentLimit).optional(),
    antigravityCliResume: z.boolean().optional(),
    opencodeCliWake: z.boolean().optional(),
  }, async ({ sessionId, kind, cwd, agentIds, antigravityCliResume, opencodeCliWake }) => {
    const callbacks = callbacksRef();
    const effectiveKind = kind || (['antigravity', 'codex', 'claude', 'opencode'].includes(callbacks.host()) ? callbacks.host() : 'antigravity');
    const parent = normalizeParentInfo({ kind: effectiveKind, sessionId, cwd });
    let bound;
    if (manager.bindSession) {
      bound = await manager.bindSession(parent, agentIds);
    } else {
      const ids = Array.isArray(agentIds) ? agentIds : manager.list(false).map(a => a.id);
      const updated = ids.map(agentId => manager.bindParentInfo(agentId, parent));
      bound = { identity: parent, boundAgents: updated.map(a => a.id) };
    }
    if (effectiveKind === 'antigravity' || effectiveKind === 'opencode') {
      const targets = bound.legacyController ? (agentIds || []) : (bound.boundAgents || []);
      for (const agentId of targets) {
        callbacks.configure(agentId, effectiveKind === 'opencode'
          ? { opencodeSessionId: sessionId, ...(opencodeCliWake !== undefined ? { opencodeCliWake } : {}) }
          : { antigravitySessionId: sessionId, ...(antigravityCliResume !== undefined ? { antigravityCliResume } : {}) });
      }
    }
    return { ...bound, waitEventsCommand: waitCommandFor({ sessionId }) };
  });
  register('get_subagent_health', 'Read-only health check for pi-subagents runtime: Pi executable, independent controller, macOS sandbox-exec, authenticated model count, dashboard URL, Antigravity plugin/hooks and OpenCode MCP/skill status.', {}, () => collectHealth(manager, callbacksRef(), managerOptions), true);
  register('update_agent_policy', 'Change limits or allowed models for an idle agent only after explicit human authorization. authorizationReference records the actual user instruction; it is a host assertion, not server proof of identity. If supported, the client additionally displays a confirmation form. Restart retains the Pi session and does not replay tasks.', { agentId: id, policy: policyShape, authorizationReference: z.string().min(1).max(2000) }, async values => {
    if (process.env.PI_SUBAGENTS_CONFIRM_POLICY === '1' && server.server.getClientCapabilities()?.elicitation?.form) {
      const confirmation = await server.server.elicitInput({ mode: 'form', message: `Allow changing Pi agent ${values.agentId}? Requested limits: ${JSON.stringify(values.policy)}. Authorization cited by host: ${values.authorizationReference}`, requestedSchema: { type: 'object', properties: { approved: { type: 'boolean', title: 'Allow the requested policy change' } }, required: ['approved'] } });
      if (confirmation.action !== 'accept' || confirmation.content?.approved !== true) throw new Error('User did not approve the policy change');
    }
    return manager.call ? manager.updatePolicy(values) : manager.updatePolicy(values.agentId, values.policy, values.authorizationReference);
  });
  register('resume_task', 'Explicitly take over a persisted MCP task after its previous parent disconnected. Does not replay completed work or allow taking control from an attached parent.', { taskId: id }, ({ taskId }) => manager.adoptTask ? manager.adoptTask(taskId) : Promise.reject(new Error('Task adoption requires the independent controller')));
  register('get_agent_changes', 'Read-only review of an owned agent\'s actual file changes: Git status, commits and bounded diff against its worktree base commit (or HEAD limited to owned paths in shared mode). Use before accepting or merging work.', {
    agentId: id, includeDiff: z.boolean().default(true), maxBytes: z.number().int().min(1000).max(200000).default(20000),
  }, async ({ agentId, ...options }) => {
    await manager.read(agentId, 0, 1);
    return agentChanges(new Storage(manager.storage.root).load(agentId), options);
  }, true);
}

function registerControlTools({ register, manager, resolveSessionId, callbacksRef }) {
  register('spawn_agent', 'Start an independent Pi agent within explicit user delegation and spending authorization. Supply a stable requestId for safe retries; declare owned files and acceptance criteria. OS tool permissions and policy limits are enforced. Returns immediately; accepted is not completed. You MUST keep calling wait_agent until it settles before ending your turn (see mustWait in the result). callback (default enabled) wakes the parent on settle/question; Antigravity should supply antigravitySessionId (Conversation ID) or call bind_session; OpenCode should supply opencodeSessionId (or parentSession={kind:"opencode", sessionId}) or call bind_session; Codex should supply callback.codexThreadId.', { ...spawnShape, callback: callbackShape.optional() }, async ({ callback, ...values }) => {
    const callbacks = callbacksRef();
    const hostSession = resolveSessionId(values, callback);
    const sessionFields = hostSession.kind === 'opencode'
      ? { opencodeSessionId: hostSession.sessionId }
      : hostSession.kind === 'antigravity'
        ? { antigravitySessionId: hostSession.sessionId }
        : {};
    const agent = await manager.spawn({ ...values, ...sessionFields });
    const configured = callbacks.configure(agent.id, { ...callback, ...sessionFields }, agent.sequence);
    return { ...agent, callback: configured, mustWait: spawnReminder(agent.id, { sessionId: configured.antigravitySessionId || configured.opencodeSessionId }) };
  });
  register('read_agent', 'Read durable agent status and recent events after a sequence. Optionally retrieve a bounded transcript from the active Pi process.', {
    agentId: id, afterSequence: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), transcript: z.boolean().default(false),
  }, async ({ agentId, afterSequence, limit, transcript }) => {
    const result = await manager.read(agentId, afterSequence, limit);
    if (result.events?.length && result.nextSequence) callbacksRef().markObserved(agentId, result.nextSequence, 'read_agent');
    const org = new DashboardData(manager.storage.root).organizationOf(agentId, result.agent);
    if (org) result.organization = org;
    if (transcript) {
      const data = manager.transcript ? await manager.transcript(agentId) : await manager.get(agentId).rpc.command('get_messages');
      let remaining = 40000;
      result.messages = data.messages.slice(-Math.min(limit, 20)).map(message => {
        const original = JSON.stringify(message.content);
        const content = original.slice(0, Math.min(remaining, 6000)); remaining -= content.length;
        return { role: message.role, content, stopReason: message.stopReason, truncated: content.length < original.length };
      });
    }
    return result;
  }, true);
  register('send_message', 'Send a new task or communicate within the user-authorized delegation scope. Ask before expanding work or paid usage beyond it. Use a stable messageId when retrying; inspect uncertain receipts before dispatching again. steer delivers after current tools finish; follow_up waits until work finishes. Answer blocking questions with reply_question.', {
    agentId: id, message: text, mode: z.enum(['steer', 'follow_up']).default('steer'), messageId: id.optional(),
  }, async ({ agentId, message, mode, messageId }) => {
    const sent = await manager.send(agentId, message, mode, messageId);
    const cb = callbacksRef().get(agentId);
    return { ...sent, mustWait: spawnReminder(agentId, { sessionId: cb?.antigravitySessionId || cb?.opencodeSessionId }) };
  });
  register('reply_question', 'Answer an actual pending child question. Only an explicit answer releases the waiting tool.', {
    questionId: id, message: text,
  }, ({ questionId, message }) => manager.reply ? manager.reply(questionId, message) : manager.channel.reply(questionId, message));
  register('wait_agent', 'Wait until a selected child emits a new event, or a bounded timeout. Call again until every child is completed/failed/interrupted/closed; the result lists still-running children in pending. Reuse nextSequence in after to avoid repeated events. Progress also wakes this call; completed means Pi settled, not business acceptance.', {
    agentIds: z.array(id).min(1).max(maxAgentLimit), after: z.record(z.number().int().min(0)).default({}), timeoutMs: z.number().int().min(0).max(45000).default(25000),
  }, async ({ agentIds, after, timeoutMs }, extra) => {
    let progress = 0;
    const onEvent = event => { if (agentIds.includes(event.agentId) && extra._meta?.progressToken !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: ++progress, message: event.type } }).catch(error => process.stderr.write(error.message + '\n')); };
    manager.on('event', onEvent);
    try {
      const raw = await manager.wait(agentIds, after, timeoutMs, extra.signal);
      const callbacks = callbacksRef();
      for (const item of raw.results || []) {
        if (item.events?.length && item.agent?.id && item.nextSequence) callbacks.markObserved(item.agent.id, item.nextSequence, 'wait_agent');
      }
      const sessionId = agentIds.map(agentId => { const cb = callbacks.get(agentId); return cb?.antigravitySessionId || cb?.opencodeSessionId; }).find(Boolean);
      return waitReminder(raw, { sessionId });
    } finally { manager.off('event', onEvent); }
  }, true);
  register('set_agent_model', 'Change an idle session model within the user-authorized model and spending scope; ask before exceeding it. Global Pi defaults stay unchanged. next_run restores the prior model and thinking after one settled run. Interrupt busy work explicitly first.', {
    agentId: id, provider: z.string().min(1), model: z.string().min(1), thinking: thinkingShape.optional(), scope: z.enum(['session', 'next_run']).default('session'),
  }, ({ agentId, ...options }) => manager.setModel(agentId, options));
  register('interrupt_agent', 'Clear queued instructions and abort current Pi work. Edits already made remain; stopping is not rollback.', { agentId: id }, ({ agentId }) => manager.interrupt(agentId));
  register('close_agent', 'Stop and close this child while preserving its Pi session and worktree. Does not merge or delete source changes.', { agentId: id }, ({ agentId }) => manager.closeAgent(agentId));
  register('resume_agent', 'Reopen a saved child within explicit human delegation authorization, retaining its model and directory. Fails if another live controller owns it. Does not automatically repeat previous work.', {
    agentId: id, antigravitySessionId: safeSessionId().optional(), opencodeSessionId: safeSessionId().optional(), parentSession: parentSessionShape().optional(),
  }, async ({ agentId, antigravitySessionId, opencodeSessionId, parentSession }) => {
    const agent = await manager.resume(agentId, { antigravitySessionId, opencodeSessionId, parentSession });
    const agySid = antigravitySessionId || (parentSession?.kind === 'antigravity' ? parentSession.sessionId : undefined) || (agent.parentInfo?.kind === 'antigravity' ? agent.parentInfo.sessionId : undefined);
    const ocSid = opencodeSessionId || (parentSession?.kind === 'opencode' ? parentSession.sessionId : undefined) || (agent.parentInfo?.kind === 'opencode' ? agent.parentInfo.sessionId : undefined);
    if (ocSid) callbacksRef().configure(agentId, { opencodeSessionId: ocSid }, agent.sequence);
    else if (agySid) callbacksRef().configure(agentId, { antigravitySessionId: agySid }, agent.sequence);
    return agent;
  });
  register('read_messages', 'Read durable message receipts, reports and questions. accepted is transport acceptance; consumed means included in model context; acknowledged means parent explicitly confirmed reading. Reuse cursors.', { agentId: id, afterMessageId: id.optional(), limit: z.number().int().min(1).max(100).default(50), unacknowledgedOnly: z.boolean().default(false) }, values => manager.readMessages ? manager.readMessages(values) : manager.messages.read(values.agentId, values), true);
  register('ack_messages', 'Confirm the parent has read specific messages; does not mean the task passed acceptance checks.', { agentId: id, messageIds: z.array(id).min(1).max(100) }, values => manager.ackMessages ? manager.ackMessages(values.agentId, values.messageIds) : manager.messages.acknowledge(values.agentId, values.messageIds));
}

export async function createServer(options = {}) {
  const managerOptions = {
    root: options.root || process.env.PI_SUBAGENTS_STATE_DIR || path.join(projectRoot, '.agents/runtime'),
    executable: options.executable || process.env.PI_EXECUTABLE || 'pi',
    maxAgents: options.maxAgents || Number(process.env.PI_SUBAGENTS_MAX_AGENTS || defaultMaxAgents),
    ...(options.piAgentDir ? { piAgentDir: options.piAgentDir } : {}),
    ...(options.processFactory ? { processFactory: options.processFactory } : {}),
  };
  const manager = options.processFactory || options.embedded ? await new Manager(managerOptions).start() : await connectController(managerOptions);
  const taskStore = manager.call ? new RemoteTaskStore(manager) : new FileTaskStore(manager.storage.root, manager);
  const server = new McpServer({ name: 'pi-subagents', version: packageVersion }, { instructions, taskStore, capabilities: { logging: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } });
  function register(name, description, shape, handler, readOnly = false) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } }, async (values, extra) => {
      try {
        const data = await handler(values, extra);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  let callbacks;
  const callbacksRef = () => callbacks;
  function resolveSessionId(values, callback) {
    const ocExplicit = callback?.opencodeSessionId || values?.opencodeSessionId || (values?.parentSession?.kind === 'opencode' ? values.parentSession.sessionId : undefined);
    if (ocExplicit) return { kind: 'opencode', sessionId: ocExplicit };
    const agyExplicit = callback?.antigravitySessionId || values?.antigravitySessionId || (values?.parentSession?.kind === 'antigravity' ? values.parentSession.sessionId : undefined);
    if (agyExplicit) return { kind: 'antigravity', sessionId: agyExplicit };
    const host = callbacks?.host();
    if (host === 'opencode') {
      const fromEnv = process.env.OPENCODE_SESSION_ID?.trim();
      return fromEnv && sessionIdPattern.test(fromEnv) ? { kind: 'opencode', sessionId: fromEnv } : {};
    }
    if (host === 'antigravity') {
      const fromEnv = process.env.ANTIGRAVITY_CONVERSATION_ID?.trim();
      return fromEnv && sessionIdPattern.test(fromEnv) ? { kind: 'antigravity', sessionId: fromEnv } : {};
    }
    return {};
  }
  registerSessionTools({ register, manager, server, options, managerOptions, resolveSessionId, callbacksRef });
  registerControlTools({ register, manager, resolveSessionId, callbacksRef });
  installTaskTool(server, manager, spawnShape, taskStore);
  installCommunication(server, manager, register);
  callbacks = installCallbacks(server, manager, register);
  return { server, manager, taskStore };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.PI_SUBAGENTS_STATE_DIR && process.env.PI_DASHBOARD_AUTO !== '0') {
    try { await ensureDashboard(); }
    catch (error) { process.stderr.write(`Pi dashboard: ${error.message}\n`); }
  }
  const { server, manager } = await createServer();
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await manager.close(); await server.close();
  }
  const transport = new StdioServerTransport();
  server.server.onclose = () => { shutdown().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }); };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
  await server.connect(transport);
}
