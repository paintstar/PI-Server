import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '../src/storage.js';
import { opencodeConfigDir } from '../src/opencode-config.js';
import { installOpencode, uninstallOpencode } from './opencode-install.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = 'pi-server';
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const targetArg = args.find(arg => arg.startsWith('--target='));
const target = targetArg === undefined ? 'all' : targetArg.slice(9);
if (args.some(arg => arg !== '--remove' && !arg.startsWith('--target=')) || !['all', 'codex', 'claude', 'antigravity', 'opencode'].includes(target)) {
  throw new Error('Usage: install.js [--target=all|codex|claude|antigravity|opencode] [--remove]');
}

function resolveShell() {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '/bin/sh';
}

function resolve(command) {
  try {
    const shell = resolveShell();
    const flag = /\/(?:zsh|bash)$/.test(shell) ? '-lc' : '-c';
    return execFileSync(shell, [flag, `command -v ${command}`], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error?.status == null && error?.code == null) throw error;
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, command);
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }
}

const antigravityBaseDir = process.env.PI_ANTIGRAVITY_PLUGINS_DIR || path.join(os.homedir(), '.gemini/config/plugins');
const opencodeDir = opencodeConfigDir(process.env);
const clients = {
  codex: resolve('codex'),
  claude: resolve('claude'),
  antigravity: resolve('agy') || (fs.existsSync(path.dirname(antigravityBaseDir)) || process.env.PI_ANTIGRAVITY_PLUGINS_DIR || target === 'antigravity' ? 'plugin-dir' : ''),
  opencode: resolve('opencode') || (process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG || (target === 'opencode' && fs.existsSync(opencodeDir)) ? 'config-dir' : ''),
};

const selected = (target === 'all' ? ['codex', 'claude', 'antigravity', 'opencode'] : [target]).filter(client => {
  if (clients[client]) return true;
  if (target !== 'all') throw new Error(`${client} CLI was not found`);
  console.log(`Skipped ${client}: CLI not found.`);
  return false;
});

const backup = process.env.PI_CONFIG_BACKUP_DIR || path.join(root, '.agents/records/config-backups');
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
const configs = {
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
  claude: path.join(os.homedir(), '.claude.json'),
};
for (const client of selected) {
  if (!configs[client] || !fs.existsSync(configs[client])) continue;
  const copy = path.join(backup, `${client}-${Date.now()}${path.extname(configs[client])}`);
  fs.copyFileSync(configs[client], copy);
  fs.chmodSync(copy, 0o600);
}

const pluginDir = path.join(antigravityBaseDir, name);
function backupPluginDir() {
  if (!fs.existsSync(pluginDir)) return;
  const dest = path.join(backup, `antigravity-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const item of ['plugin.json', 'mcp_config.json', 'hooks.json', 'README.md']) {
    const src = path.join(pluginDir, item);
    if (fs.existsSync(src)) {
      const dst = path.join(dest, item);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
    }
  }
}

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect x="8" y="8" width="112" height="112" rx="28" fill="#171614"/>
  <circle cx="64" cy="64" r="36" stroke="#e27448" stroke-width="6"/>
  <circle cx="64" cy="64" r="11" fill="#f4efe7"/>
  <circle cx="64" cy="28" r="7.5" fill="#e27448"/>
  <circle cx="95" cy="82" r="6" fill="#2f855a"/>
</svg>
`;

const pluginRules = `# Pi Server Rules for Antigravity

When delegating tasks to external models through \`pi-server\`, follow these rules:

1. Handle the majority of coding, research, and execution tasks directly yourself unless delegation clearly adds value (major decisions, independent review, or user-requested subagent runs).
2. Before spawning, check enabled models, context windows, capability descriptions, and Pi subagent tools via \`get_model_profiles\` or \`list_models\` (and \`get_subagent_health\` / \`get_quota\` if needed), and match each configured model's capability profile (for example, when \`openai-codex\` GPT models are enabled, prefer \`openai-codex/gpt-6-astra\` as a strict conservative brake on research and major architectural decisions due to tighter quota, and \`openai-codex/gpt-6.1-sol\` for lower-cost code review, debugging, or math/logic verification while explicitly instructing it to avoid defensive fallback code and redundant docs).
3. Always bind the subagent to the current Antigravity session by passing \`antigravitySessionId\` (your Conversation ID) to \`spawn_agent\` / \`resume_agent\`, or call \`bind_session\`. Do not set custom \`policy\` caps (\`maxTotalTokens\`, \`maxModelRequests\`, \`maxRuntimeMs\`) unless the user explicitly asks for them; rely on the built-in generous defaults.
4. Never treat \`spawn_agent\` acceptance as completion. Wait synchronously with \`wait_agent\` (forwarding \`nextSequence\` into \`after[agentId]\`) or start the background watcher returned in \`mustWait.antigravityBackgroundCommand\` (\`node ".../scripts/wait-events.js" --session <Conversation ID>\` via \`run_command\` with \`WaitMsBeforeAsync: 500\`, \`IsDaemon: false\`).
5. Answer pending \`ask_parent\` questions immediately via \`reply_question\`.
6. Filter children with \`list_agents(sessionId="<Conversation ID>")\` and inspect actual edits with \`get_agent_changes\` before reporting results.
`;

const pluginSkill = `---
name: pi-server
description: Orchestrate independent Pi subagents across external models in Antigravity with session binding, reactive wait-events wakeups, and lifecycle hooks.
---

# Pi Server Workflow in Antigravity

Handle routine coding and exploration directly as the main agent; invoke \`pi-server\` selectively when explicit delegation, independent review, or critical-decision calibration is beneficial.

## Session Binding & Model Selection

1. Inspect healthy runtime, Pi subagent tool defaults, model context windows, and model capability descriptions with \`get_subagent_health\`, \`get_model_profiles\`, and \`list_models\`.
2. Match the configured GPT models intentionally:
   - \`openai-codex/gpt-6-astra\`: rigorous, conservative, sometimes stubborn; use on research trade-offs or critical architectural decisions as a second-opinion brake when main-agent judgment may be overly optimistic (use selectively due to tighter quota).
   - \`openai-codex/gpt-6.1-sol\`: high-efficiency, cost-effective, strong math/logic precision for code review, bug hunting, and verification; explicitly constrain it in \`prompt\` not to add defensive fallbacks or extra documentation/comments.
3. Call \`spawn_agent\` with \`antigravitySessionId\` set to your current Conversation ID, an explicit \`provider\` and \`model\`, absolute \`cwd\`, non-overlapping \`ownedPaths\`, and clear acceptance criteria. Omit \`policy.maxTotalTokens\`, \`policy.maxModelRequests\`, and \`policy.maxRuntimeMs\` unless the user explicitly requested a hard cap.
4. For work spawned before binding or after reconnect, call \`bind_session({ sessionId: "<Conversation ID>" })\` and isolate inspection with \`list_agents({ sessionId: "<Conversation ID>" })\`.

## Waiting & Wake-Up

- **Synchronous wait**: call \`wait_agent\` passing returned \`nextSequence\` values in \`after\`.
- **Reactive background wait**: run \`mustWait.antigravityBackgroundCommand\` (\`node ".../scripts/wait-events.js" --session <Conversation ID>\`) via \`run_command\` with \`WaitMsBeforeAsync: 500\` and \`IsDaemon: false\`, then end the turn cleanly; the system wakes your session automatically when a child emits \`settled\`, \`question\`, \`process_failed\`, or \`budget_limit\`.
- **Lifecycle safety net**: bundled \`PreInvocation\` and \`Stop\` hooks automatically inject undelivered events and warn before stopping while bound children remain active without a watcher.

## Verification & Session Organization

Before accepting changes from a settled child, call \`get_agent_changes\` (for worktree or shared owned diffs) and run target checks directly. Use \`organize_agents\` (shared live with the 3141 dashboard) to set readable session titles, attach summary notes, pin key runs, or archive finished sessions, and filter with \`list_agents({ archiveFilter: "active" })\`.
`;

const pluginReadme = `# Pi Server Antigravity Plugin

Bundles the \`pi-server\` MCP server, Antigravity \`PreInvocation\` and \`Stop\` lifecycle hooks, session-binding rules, and orchestration skill.

- Repository root: \`${root}\`
- Web dashboard default URL: \`http://127.0.0.1:3141/\`
`;

function writeAntigravityPlugin(env) {
  backupPluginDir();
  fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(pluginDir, 'skills/pi-server'), { recursive: true, mode: 0o755 });

  const agyBin = resolve('agy');
  const mcpEnv = { ...env, ...(agyBin ? { AGY_EXECUTABLE: agyBin } : {}) };
  const serverScript = path.join(root, 'src/server.js');
  const hookScript = path.join(root, 'scripts/antigravity-hook.js');
  const hookCommand = `"${process.execPath}" "${hookScript}"`;

  atomicWriteJson(path.join(pluginDir, 'plugin.json'), {
    name: 'pi-server',
    displayName: 'Pi Server',
    version: pkg.version,
    description: 'Multi-model Pi subagent orchestration for Antigravity with session binding, reactive wait-events watcher, and PreInvocation/Stop hooks.',
    logo: 'assets/logo.svg',
    author: { name: 'mumuxsy' },
    repository: 'https://github.com/paintstar/PI-Server',
    suggestedPrompts: [
      'List authenticated Pi models and check subagent runtime health',
      'Delegate parallel codebase review subagents using Pi models for this session',
      'Check active Pi subagents bound to this Antigravity conversation',
    ],
  }, { pretty: true });

  atomicWriteJson(path.join(pluginDir, 'mcp_config.json'), {
    mcpServers: {
      'pi-server': {
        command: process.execPath,
        args: [serverScript],
        env: mcpEnv,
      },
    },
  }, { pretty: true });

  atomicWriteJson(path.join(pluginDir, 'hooks.json'), {
    'pi-server-callbacks': {
      PreInvocation: [{ type: 'command', command: hookCommand, timeout: 10 }],
      Stop: [{ type: 'command', command: hookCommand, timeout: 10 }],
    },
  }, { pretty: true });

  fs.writeFileSync(path.join(pluginDir, 'rules/AGENTS.md'), pluginRules);
  fs.writeFileSync(path.join(pluginDir, 'skills/pi-server/SKILL.md'), pluginSkill);
  fs.writeFileSync(path.join(pluginDir, 'assets/logo.svg'), logoSvg);
  fs.writeFileSync(path.join(pluginDir, 'README.md'), pluginReadme);

  if (agyBin && !process.env.PI_ANTIGRAVITY_PLUGINS_DIR) {
    execFileSync(agyBin, ['plugin', 'validate', pluginDir, '--strict'], { stdio: 'inherit' });
  }
}

const run = (client, values, quiet = false) => execFileSync(clients[client], values, { stdio: quiet ? 'ignore' : 'inherit' });
const removeFrom = {
  codex: () => run('codex', ['mcp', 'remove', name], true),
  claude: () => run('claude', ['mcp', 'remove', name, '-s', 'user'], true),
  antigravity: () => {
    backupPluginDir();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  },
  opencode: () => {
    const result = uninstallOpencode({ opencodeBin: clients.opencode, name, backupDir: backup });
    if (!result.removed) throw new Error('not installed');
  },
};

if (remove) {
  for (const client of selected) {
    try {
      removeFrom[client]();
      console.log(`Removed ${name} from ${client}.`);
    } catch {
      console.log(`${client} had no ${name} entry.`);
    }
  }
} else {
  const pi = process.env.PI_EXECUTABLE || resolve('pi');
  if (!pi) throw new Error('pi CLI was not found');
  execFileSync(pi, ['--version'], { stdio: 'inherit' });
  if (!path.isAbsolute(pi)) throw new Error('pi must resolve to an absolute executable path');
  const agyPath = resolve('agy');
  const opencodePath = clients.opencode && clients.opencode !== 'config-dir' ? clients.opencode : '';
  const binDirs = [
    path.dirname(process.execPath),
    path.dirname(pi),
    ...[clients.codex, clients.claude, agyPath, opencodePath].filter(Boolean).filter(p => path.isAbsolute(p)).map(path.dirname),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const executablePath = [...new Set(binDirs)].join(path.delimiter);
  const env = { PI_EXECUTABLE: pi, PATH: executablePath, ...(clients.codex ? { CODEX_EXECUTABLE: clients.codex } : {}) };
  const command = [process.execPath, path.join(root, 'src/server.js')];
  for (const client of selected) {
    if (client === 'antigravity') {
      writeAntigravityPlugin(env);
      console.log(`Installed ${name} Antigravity plugin at ${pluginDir}.`);
      continue;
    }
    if (client === 'opencode') {
      const res = installOpencode({ opencodeBin: clients.opencode, name, command, env, backupDir: backup });
      console.log(`Installed ${name} for opencode at ${res.configFile} (skill: ${res.skillFile}).`);
      continue;
    }
    try { removeFrom[client](); }
    catch (error) { if (error?.status == null && error?.code !== 'ENOENT') throw error; }
    if (client === 'codex') {
      run('codex', ['mcp', 'add', name, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', ...command]);
    } else if (client === 'claude') {
      run('claude', ['mcp', 'add-json', '-s', 'user', name, JSON.stringify({ type: 'stdio', command: command[0], args: command.slice(1), env })]);
    }
    console.log(`Installed ${name} for ${client}.`);
  }
  console.log('Running sessions keep their current bridge; open a new Codex/Claude Code/Antigravity/OpenCode session to load this version. Other MCP entries were preserved.');
}
