import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { opencodeConfigDir, opencodeConfigFile, opencodeSkillFile, upsertJsoncMcpServer, removeJsoncMcpServer } from '../src/opencode-config.js';

function atomicWriteText(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

function backupOpencodeConfig(backupDir, processEnv) {
  const configFile = opencodeConfigFile(processEnv);
  if (!fs.existsSync(configFile)) return null;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const copy = path.join(backupDir, `opencode-${Date.now()}${path.extname(configFile) || '.jsonc'}`);
  fs.copyFileSync(configFile, copy);
  fs.chmodSync(copy, 0o600);
  return copy;
}

const opencodeSkill = `---
name: pi-subagents
description: Orchestrate independent Pi subagents across external models in OpenCode with session binding, wait-events wakeups, sandboxed workspaces, and diff review.
---

# Pi Subagents Workflow in OpenCode

Use \`pi-subagents\` only when the user explicitly authorizes external model delegation (for parallel work, independent second opinion, or cross-model review). Handle routine coding directly as the main agent.

## Model Selection & Session Binding

1. In OpenCode v2 Code Mode, invoke tools via \`tools["pi-subagents"].<toolName>(...)\` inside \`execute\` (call \`search({ query: "pi-subagents" })\` if some of the 24 tools are collapsed in the catalog).
2. Inspect runtime health, enabled model profiles, context windows, and Pi tool defaults via \`get_subagent_health\`, \`get_model_profiles\`, and \`list_models\`.
3. Call \`spawn_agent\` with explicit \`provider\`, \`model\`, absolute \`cwd\`, non-overlapping \`ownedPaths\`, and concrete acceptance criteria. Omit \`policy.maxTotalTokens\`, \`policy.maxModelRequests\`, and \`policy.maxRuntimeMs\` unless the user explicitly requested a hard cap.
4. Pass your current OpenCode session ID (\`ses_...\`, discoverable via \`opencode session list --format json -n 5\`) as \`opencodeSessionId\` (or \`parentSession: { kind: "opencode", sessionId }\`) on \`spawn_agent\` / \`resume_agent\`, or call \`bind_session({ sessionId, kind: "opencode" })\` so callbacks and the Pi dashboard (\`http://127.0.0.1:3141/\`) group your children cleanly.

## Waiting, Q&A & Wake-Up

- **Do not treat \`spawn_agent\` as completion.** Keep calling \`wait_agent\` (forwarding returned \`nextSequence\` in \`after[agentId]\`) until every child reaches \`completed\`, \`failed\`, \`interrupted\`, or \`closed\`.
- Answer blocking \`ask_parent\` questions immediately via \`reply_question\`.
- For long-running tasks, you can monitor events with \`mustWait.opencodeBackgroundCommand\` (\`node ".../scripts/wait-events.js" --session <sessionId>\`), or opt in to CLI session wake-ups via \`callback: { opencodeSessionId, opencodeCliWake: true }\`. All channels share a monotonic delivery cursor to avoid duplicates.

## Verification & Session Organization

- Before accepting any settled child's work, inspect actual edits via \`get_agent_changes\` and run target checks directly.
- Use \`organize_agents\` (shared live with the 3141 dashboard) to title, annotate, pin, or archive finished sessions, and filter active runs with \`list_agents({ sessionId, archiveFilter: "active" })\`.
`;

function writeOpencodeMcpDirect(configFile, name, command, env) {
  const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const updated = upsertJsoncMcpServer(raw, name, { type: 'local', command, environment: env });
  const mode = fs.existsSync(configFile) ? (fs.statSync(configFile).mode & 0o777) : 0o644;
  atomicWriteText(configFile, updated, mode || 0o644);
}

function reloadOpencodeService(opencodeBin, processEnv) {
  if (!opencodeBin || opencodeBin === 'config-dir' || processEnv.OPENCODE_CONFIG_DIR || processEnv.OPENCODE_CONFIG) return;
  try {
    execFileSync(opencodeBin, ['reload'], { stdio: 'ignore', timeout: 5000, env: processEnv });
  } catch {
    return;
  }
}

export function installOpencode({ opencodeBin, name = 'pi-subagents', command, env, backupDir, processEnv = process.env }) {
  backupOpencodeConfig(backupDir, processEnv);
  const configDir = opencodeConfigDir(processEnv);
  const configFile = opencodeConfigFile(processEnv);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });

  const mcpEnv = {
    ...env,
    PI_SUBAGENTS_HOST: 'opencode',
    ...(opencodeBin && opencodeBin !== 'config-dir' ? { OPENCODE_EXECUTABLE: opencodeBin } : {}),
  };

  if (opencodeBin && opencodeBin !== 'config-dir') {
    const cliArgs = [
      'mcp', 'add', '--global', name,
      ...Object.entries(mcpEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--', ...command,
    ];
    execFileSync(opencodeBin, cliArgs, { stdio: 'inherit', env: processEnv });
  } else {
    writeOpencodeMcpDirect(configFile, name, command, mcpEnv);
  }

  const skillFile = opencodeSkillFile(processEnv, name);
  atomicWriteText(skillFile, opencodeSkill);
  reloadOpencodeService(opencodeBin, processEnv);
  return { configFile, skillFile };
}

export function uninstallOpencode({ opencodeBin, name = 'pi-subagents', backupDir, processEnv = process.env }) {
  const configFile = opencodeConfigFile(processEnv);
  const skillDir = path.dirname(opencodeSkillFile(processEnv, name));
  let removed = false;

  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, 'utf8');
    const result = removeJsoncMcpServer(raw, name);
    if (result.changed) {
      backupOpencodeConfig(backupDir, processEnv);
      const mode = fs.statSync(configFile).mode & 0o777;
      atomicWriteText(configFile, result.content, mode || 0o644);
      removed = true;
    }
  }

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed = true;
  }

  if (removed) reloadOpencodeService(opencodeBin, processEnv);
  return { removed, configFile, skillDir };
}
