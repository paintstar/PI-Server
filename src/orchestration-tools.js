import { z } from 'zod';
import { runConsult } from './consult.js';
import { runCouncil } from './council.js';
import { runCrossReview } from './cross-review.js';

function sessionBindingFrom(resolveSessionId, values) {
  const host = resolveSessionId(values, undefined);
  if (host.kind === 'opencode' && host.sessionId) return { opencodeSessionId: host.sessionId, parentSession: values.parentSession };
  if (host.kind === 'antigravity' && host.sessionId) return { antigravitySessionId: host.sessionId, parentSession: values.parentSession };
  return values.parentSession ? { parentSession: values.parentSession } : {};
}

function progressReporter(server, extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  let step = 0;
  return info => {
    step++;
    server.server.notification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: step, message: `${info.status || 'running'} (${info.agentId?.slice(0, 8) || ''})` },
    }).catch(() => {});
  };
}

export function installOrchestrationTools({ register, manager, callbacksRef, resolveSessionId, server, schemas }) {
  const { id, text, thinkingShape, safeSessionId, parentSessionShape } = schemas;
  const sessionFields = {
    antigravitySessionId: safeSessionId().optional(),
    opencodeSessionId: safeSessionId().optional(),
    parentSession: parentSessionShape().optional(),
  };
  const roleEnum = z.enum(['critic', 'reviewer', 'implementer', 'redteam', 'architect', 'general']);

  register(
    'consult',
    'One-shot read-only second opinion from a chosen Pi model. Handles spawn, wait, read, close, and optional archive automatically inside a read-only non-interactive OS sandbox. Supports dryRun for zero-spawn static catalog cost estimation.',
    {
      question: text,
      provider: z.string().min(1),
      model: z.string().min(1),
      thinking: thinkingShape.optional(),
      style: z.enum(['critic', 'reviewer', 'implementer', 'redteam', 'architect']).default('reviewer'),
      cwd: z.string().min(1).optional(),
      contextFiles: z.array(z.string().min(1)).max(20).default([]),
      context: z.string().max(40000).default(''),
      allowWorkspaceRead: z.boolean().default(true),
      timeoutMs: z.number().int().min(5000).max(300000).default(120000),
      budgetCapUsd: z.number().positive().max(100).optional(),
      dryRun: z.boolean().default(false),
      autoArchive: z.boolean().default(true),
      ...sessionFields,
    },
    (values, extra) => runConsult({
      manager,
      callbacks: callbacksRef(),
      stateRoot: manager.storage.root,
      input: values,
      parentSession: sessionBindingFrom(resolveSessionId, values),
      signal: extra?.signal,
      onProgress: progressReporter(server, extra),
    }),
  );

  register(
    'council',
    'Run 2 to 4 models in parallel on the same question inside read-only non-interactive sandboxes and synthesize consensus, disagreements, stance counts, and confidence deterministically. Supports cleanProfile, minQuorum partial degradation, budgetCapUsd, and dryRun.',
    {
      question: text,
      members: z.array(z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        thinking: thinkingShape.optional(),
        role: roleEnum.default('general'),
      })).min(2).max(4),
      cwd: z.string().min(1).optional(),
      contextFiles: z.array(z.string().min(1)).max(20).default([]),
      context: z.string().max(40000).default(''),
      cleanProfile: z.boolean().default(false),
      synthesizer: z.literal('deterministic').default('deterministic'),
      minQuorum: z.number().int().min(1).max(4).optional(),
      timeoutMs: z.number().int().min(10000).max(300000).default(150000),
      budgetCapUsd: z.number().positive().max(100).optional(),
      dryRun: z.boolean().default(false),
      autoArchive: z.boolean().default(true),
      ...sessionFields,
    },
    (values, extra) => runCouncil({
      manager,
      callbacks: callbacksRef(),
      stateRoot: manager.storage.root,
      input: values,
      parentSession: sessionBindingFrom(resolveSessionId, values),
      signal: extra?.signal,
      onProgress: progressReporter(server, extra),
    }),
  );

  register(
    'cross_review',
    'Audit a settled subagent\'s actual Git diff (including untracked files) and acceptance check results using an independent reviewer model in a network-disabled read-only sandbox. Produces fail-closed approve/concerns/blockers verdicts with structured findings.',
    {
      sourceAgentId: id,
      reviewer: z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        thinking: thinkingShape.optional(),
      }),
      focus: z.string().max(4000).default(''),
      includeVerification: z.boolean().default(true),
      maxDiffBytes: z.number().int().min(2000).max(120000).default(40000),
      allowSameModel: z.boolean().default(false),
      timeoutMs: z.number().int().min(10000).max(300000).default(120000),
      budgetCapUsd: z.number().positive().max(100).optional(),
      dryRun: z.boolean().default(false),
      autoArchive: z.boolean().default(true),
      ...sessionFields,
    },
    (values, extra) => runCrossReview({
      manager,
      callbacks: callbacksRef(),
      stateRoot: manager.storage.root,
      input: values,
      parentSession: sessionBindingFrom(resolveSessionId, values),
      signal: extra?.signal,
      onProgress: progressReporter(server, extra),
    }),
  );
}
