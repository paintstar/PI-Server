import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileOperation, runSandboxed, sandboxMode } from '../src/tool-sandbox.js';
import { SpeedMeter } from '../src/speed-meter.js';
import path from 'node:path';
import { applyBenchmarkPromptProfile } from '../src/benchmark-profile.js';
import { sandboxedReadOperations } from '../src/read-operations.js';
import { observeTransport } from '../src/transport-diagnostics.js';
import { providerFetch } from '../src/provider-fetch.js';

/** Explicit tools only: filesystem and shell operations execute in OS-restricted subprocesses. */
export default function (pi: ExtensionAPI) {
  const policy = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_POLICY!, 'utf8'));
  const readFile = (file: string) => fileOperation(policy, 'read', file);
  const writeFile = async (file: string, value: string) => { await fileOperation(policy, 'write', file, value); };
  const access = async (file: string) => { await fileOperation(policy, 'access', file); };
  pi.registerTool(createReadToolDefinition(policy.cwd, { operations: sandboxedReadOperations(policy) }));
  pi.registerTool(createWriteToolDefinition(policy.cwd, { operations: { writeFile, mkdir: async () => {} } }));
  pi.registerTool(createEditToolDefinition(policy.cwd, { operations: { readFile, writeFile, access } }));
  // 开发模式要跑完整检查，单条命令最多 30 分钟；严格模式仍是 5 分钟。
  pi.registerTool(createBashToolDefinition(policy.cwd, { exposeSessionEnvironment: false, operations: {
    exec: (command, cwd, options) => runSandboxed({ ...policy, cwd }, '/bin/bash', ['--noprofile', '--norc', '-c', command], { ...options, timeout: Math.min((options.timeout || 60) * 1000, sandboxMode(policy) !== 'strict' ? 1800000 : 300000) }),
  } }));
  const tools = ['read', 'write', 'edit', 'bash', 'agent_message', 'ask_parent'];
  pi.on('before_agent_start', event => {
    applyBenchmarkPromptProfile(event.systemPromptOptions);
  });
  // 实时输出速度写在本代理目录，面板服务读取后推送给页面；只计数，不保存内容。
  let meter: SpeedMeter | null = null;
  let stopTransportDiagnostics: (() => void) | null = null;
  let transportDiagnosticWriteFailed = false;
  let closeProviderFetch: (() => Promise<void>) | null = null;
  let previousFetch: typeof globalThis.fetch | null = null;
  let scopedFetch: typeof globalThis.fetch | null = null;
  pi.on('session_start', async (_event, context) => {
    if (context.model?.provider === 'step-relay') {
      previousFetch = globalThis.fetch;
      const transport = providerFetch(new URL(context.model.baseUrl).origin);
      scopedFetch = transport.fetch;
      globalThis.fetch = scopedFetch;
      closeProviderFetch = transport.close;
    }
    meter = new SpeedMeter(path.join(path.dirname(process.env.PI_SUBAGENT_POLICY!), 'speed.json'));
    pi.setActiveTools(tools);
    const response = await fetch(process.env.PI_SUBAGENT_ENDPOINT!, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` }, body: JSON.stringify({ action: 'policy_ready', agentId: process.env.PI_SUBAGENT_ID }) });
    if (!response.ok) process.exit(77);
  });
  pi.on('tool_call', event => tools.includes(event.toolName) ? undefined : { block: true, reason: 'Tool is outside this agent policy', terminate: true });
  pi.on('before_provider_request', async (event, context) => {
    if (context.model?.provider === 'step-relay' && !stopTransportDiagnostics) {
      const origin = new URL(context.model.baseUrl).origin;
      const destination = path.join(path.dirname(process.env.PI_SUBAGENT_POLICY!), 'transport-diagnostics.jsonl');
      stopTransportDiagnostics = observeTransport(origin, value => {
        try { fs.appendFileSync(destination, JSON.stringify(value) + '\n'); }
        catch {
          if (!transportDiagnosticWriteFailed) process.stderr.write('Transport diagnostics could not be saved.\n');
          transportDiagnosticWriteFailed = true;
        }
      });
    }
    try {
      const response = await fetch(process.env.PI_SUBAGENT_ENDPOINT!, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` },
        body: JSON.stringify({ action: 'reserve_request', agentId: process.env.PI_SUBAGENT_ID, messageId: randomUUID() }) });
      if (!response.ok) process.exit(77);
      const result = await response.json();
      if (result.warning) pi.sendUserMessage(result.warning, { deliverAs: 'steer' });
      const payload = event.payload as Record<string, unknown>;
      const api = context.model?.api;
      if (api === 'openai-responses' || api === 'openai-codex-responses') payload.max_output_tokens = Math.min(Number(payload.max_output_tokens) || result.maxOutputTokens, result.maxOutputTokens);
      else if (api === 'anthropic-messages') payload.max_tokens = Math.min(Number(payload.max_tokens) || result.maxOutputTokens, result.maxOutputTokens);
      else if (api === 'openai-completions' && payload.max_tokens === undefined && payload.max_completion_tokens === undefined) payload.max_tokens = result.maxOutputTokens;
      for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (typeof payload[key] === 'number') payload[key] = Math.min(payload[key] as number, result.maxOutputTokens);
      // Codex 的快速模式是同一模型加 priority 服务等级；ChatGPT 账号不接受 "-fast" 模型名。
      if (api === 'openai-codex-responses' && typeof payload.model === 'string' && payload.model.endsWith('-fast')) {
        payload.model = payload.model.slice(0, -'-fast'.length);
        payload.service_tier = 'priority';
      }
      meter?.start();
      return payload;
    } catch { process.exit(77); } // Pi catches hook exceptions; exiting is required to block an unapproved provider request.
  });
  pi.on('provider_stream_event', event => { meter?.event(event.data); });
  pi.on('message_end', event => { if (event.message?.role === 'assistant') meter?.finish(event.message.usage); });
  pi.on('session_shutdown', async () => {
    meter?.close(); stopTransportDiagnostics?.();
    if (scopedFetch && globalThis.fetch === scopedFetch && previousFetch) globalThis.fetch = previousFetch;
    await closeProviderFetch?.();
  });
}
