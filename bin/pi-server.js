#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEphemeralBinPath, resolveExecutable, resolveStableNode, stabilizeExecutablePath } from '../src/bin-resolve.js';
import { parseDashboardPort, readRunningDashboard } from '../src/dashboard-data.js';
import { defaultStateRoot, ensureDashboard } from '../src/dashboard-launcher.js';
import { buildSettingsPayload } from '../src/model-settings.js';
import { inspectOpencodeConfig, parseJsonc } from '../src/opencode-config.js';
import { processAlive, readJsonSafe } from '../src/storage.js';
import { runSandboxed, sandboxHealth } from '../src/tool-sandbox.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [cmd = 'serve', ...rest] = process.argv.slice(2);

function compareSemver(actual, minimum) {
  const parse = v => String(v || '').replace(/^v/i, '').match(/\d+/g)?.slice(0, 3).map(Number) || [];
  const a = parse(actual); const b = parse(minimum);
  if (a.length < 2) return -1;
  for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d !== 0) return d; }
  return 0;
}

function printHelp() {
  console.log([
    `Pi Server v${pkg.version} — Multi-Model Subagent MCP Platform`,
    'Usage:',
    '  pi-server [serve]                       Start stdio MCP server (default)',
    '  pi-server install [target] [--dry-run]  Register host MCP/hooks (all|antigravity|claude|codex|opencode)',
    '  pi-server uninstall [target] [--dry-run] Remove host integration with 0600 backup',
    '  pi-server dashboard [--port N] [--open] Start or reuse local web console (127.0.0.1)',
    '  pi-server doctor [--json]               Run 8-point runtime, sandbox and host health check',
    '  pi-server ask <provider/model> "<q>"    Headless one-shot consult (--style --file --cwd --dry-run --json)',
    '  pi-server --version | --help            Show version or usage',
  ].join('\n'));
}

function forwardInstall(remove) {
  const forwarded = remove ? ['--remove'] : [];
  for (const arg of rest) {
    if (arg === '--dry-run' || arg.startsWith('--target=')) forwarded.push(arg);
    else if (!arg.startsWith('-')) forwarded.push(`--target=${arg}`);
    else throw new Error(`Unknown option: ${arg}`);
  }
  process.exit(spawnSync(process.execPath, [path.join(root, 'scripts/install.js'), ...forwarded], { stdio: 'inherit' }).status ?? 1);
}

async function runServe() {
  const [{ StdioServerTransport }, { createServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('../src/server.js'),
  ]);
  if (!process.env.PI_SERVER_STATE_DIR && process.env.PI_DASHBOARD_AUTO !== '0') {
    try { await ensureDashboard(); } catch (error) { process.stderr.write(`Pi dashboard: ${error.message}\n`); }
  }
  const { server, manager } = await createServer();
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await manager.close(); await server.close(); };
  server.server.onclose = () => { shutdown().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}

async function runDashboard() {
  const portIdx = rest.indexOf('--port');
  const portEq = rest.find(arg => arg.startsWith('--port='));
  const rawPort = portEq ? portEq.slice(7) : (portIdx >= 0 ? rest[portIdx + 1] : undefined);
  if (rawPort !== undefined) process.env.PI_DASHBOARD_PORT = String(parseDashboardPort(rawPort));
  const info = await ensureDashboard(process.env.PI_SERVER_STATE_DIR || defaultStateRoot);
  console.log(`Pi Server · 调度台（仅本机）：${info.url}`);
  if (rest.includes('--open')) {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [info.url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
}

function inspectHostPaths(items) {
  return items.filter(Boolean).flatMap(item =>
    isEphemeralBinPath(item) ? [`ephemeral path: ${item}`]
      : (path.isAbsolute(item) && !fs.existsSync(item) ? [`missing path: ${item}`] : [])
  );
}

function inspectHosts() {
  const home = os.homedir();
  const agyDir = path.join(process.env.PI_ANTIGRAVITY_PLUGINS_DIR || path.join(home, '.gemini/config/plugins'), 'pi-server');
  const agyEntry = readJsonSafe(path.join(agyDir, 'mcp_config.json'))?.mcpServers?.['pi-server'];
  const claudeEntry = readJsonSafe(path.join(home, '.claude.json'))?.mcpServers?.['pi-server'];
  const codexFile = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  const codexRaw = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf8') : '';
  const codexConfigured = /\[mcp_servers\.(?:"pi-server"|pi-server)\]/.test(codexRaw);
  const oc = inspectOpencodeConfig(process.env);
  let ocEntry = null;
  if (oc.configExists) { try { ocEntry = parseJsonc(fs.readFileSync(oc.configFile, 'utf8'))?.mcp?.servers?.['pi-server'] || null; } catch {} }
  const hosts = {
    antigravity: { configured: fs.existsSync(path.join(agyDir, 'plugin.json')), hooks: fs.existsSync(path.join(agyDir, 'hooks.json')), issues: agyEntry ? inspectHostPaths([agyEntry.command, agyEntry.args?.[0], agyEntry.env?.PI_EXECUTABLE]) : [] },
    claude: { configured: Boolean(claudeEntry), issues: claudeEntry ? inspectHostPaths([claudeEntry.command, claudeEntry.args?.[0], claudeEntry.env?.PI_EXECUTABLE]) : [] },
    codex: { configured: codexConfigured, issues: codexConfigured && /fnm_multishells/.test(codexRaw) ? ['ephemeral fnm_multishells path in config.toml'] : [] },
    opencode: { configured: oc.mcpConfigured, skill: oc.skillInstalled, issues: ocEntry ? inspectHostPaths([ocEntry.command?.[0], ocEntry.command?.[1], ocEntry.environment?.PI_EXECUTABLE]) : [] },
  };
  const issues = Object.entries(hosts).flatMap(([host, info]) => info.issues.map(msg => `${host}: ${msg}`));
  const configured = Object.values(hosts).filter(h => h.configured).length;
  return { id: 'hosts', status: issues.length ? 'warn' : 'pass', detail: `${configured}/4 hosts configured${issues.length ? `; ${issues.length} path issue(s)` : ''}`, fix: issues.length ? 'pi-server install' : undefined, hosts, issues };
}

async function probeSandbox() {
  const health = sandboxHealth();
  if (!health.ok) return { id: 'sandbox', status: 'fail', detail: `missing (${health.backend}, platform=${health.platform})`, fix: health.platform === 'linux' ? 'sudo apt-get install -y bubblewrap' : 'Requires macOS /usr/bin/sandbox-exec or Linux/WSL2 bwrap', sandbox: health };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-doctor-sbx-'));
  try {
    const stateRoot = path.join(tmp, 'state'); const tempDir = path.join(tmp, 'tmp');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const res = await runSandboxed({ cwd: tmp, ownedPaths: [], stateRoot, tempDir, sandboxMode: 'strict', allowNetwork: false }, '/bin/sh', ['-c', 'echo ok'], { timeout: 3000 });
    const ok = res.exitCode === 0;
    return { id: 'sandbox', status: ok ? 'pass' : 'fail', detail: ok ? `${health.backend} (${health.executable}) probe passed` : `${health.backend} probe failed (exit ${res.exitCode})`, fix: ok ? undefined : (health.backend === 'bwrap' ? 'Check Linux/WSL2 AppArmor unprivileged userns policy for bwrap' : 'Verify /usr/bin/sandbox-exec permissions'), sandbox: health };
  } catch (error) {
    return { id: 'sandbox', status: 'fail', detail: error.message, sandbox: health };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function checkPiCli() {
  const rawPi = process.env.PI_EXECUTABLE?.trim() || resolveExecutable('pi');
  const piBin = rawPi ? stabilizeExecutablePath(rawPi) : '';
  if (!piBin || !path.isAbsolute(piBin) || !fs.existsSync(piBin)) return { id: 'pi', status: 'fail', detail: 'pi CLI not found', fix: 'Install @earendil-works/pi-coding-agent >= 1.0.2 or set PI_EXECUTABLE' };
  try {
    const ver = execFileSync(piBin, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
    const ok = compareSemver(ver, '1.0.2') >= 0; const ephemeral = isEphemeralBinPath(piBin);
    return { id: 'pi', status: !ok ? 'fail' : ephemeral ? 'warn' : 'pass', detail: `${ver} (${piBin})`, fix: !ok ? 'Upgrade Pi CLI to >= 1.0.2' : ephemeral ? 'Set PI_EXECUTABLE to a non-ephemeral path' : undefined };
  } catch (error) { return { id: 'pi', status: 'fail', detail: `${piBin}: ${error.message}`, fix: 'Verify Pi CLI installation' }; }
}

async function runDoctor() {
  const jsonMode = rest.includes('--json');
  const stateDir = process.env.PI_SERVER_STATE_DIR || defaultStateRoot;
  const nodeOk = compareSemver(process.versions.node, '22.19.0') >= 0;
  const stableNode = resolveStableNode(); const nodeEphemeral = isEphemeralBinPath(process.execPath);
  const ctrlInfo = readJsonSafe(path.join(stateDir, 'controller.json'));
  const ctrlAlive = Boolean(ctrlInfo?.pid && processAlive(ctrlInfo.pid));
  const ctrlDrift = ctrlAlive && ctrlInfo.scriptPath && path.resolve(ctrlInfo.scriptPath) !== path.resolve(path.join(root, 'src/controller.js'));
  const badPerms = fs.existsSync(stateDir) && ((fs.statSync(stateDir).mode & 0o077) !== 0);
  const dashInfo = await readRunningDashboard(stateDir, { timeoutMs: 1000 });
  const dashDrift = Boolean(dashInfo?.scriptPath && path.resolve(dashInfo.scriptPath) !== path.resolve(path.join(root, 'src/dashboard.js')));
  let modelsCheck;
  try {
    const settings = buildSettingsPayload({ stateRoot: stateDir, agentDir: process.env.PI_CODING_AGENT_DIR });
    const configured = settings.providers.filter(p => p.configured).length;
    const enabledModels = settings.providers.reduce((sum, p) => sum + (p.enabledModelsCount || 0), 0);
    const expired = settings.providers.filter(p => p.expired).map(p => p.provider);
    modelsCheck = { id: 'models', status: expired.length || configured === 0 ? 'warn' : 'pass', detail: `${configured} provider(s) configured, ${enabledModels} enabled model(s)${expired.length ? `, expired: ${expired.join(', ')}` : ''}`, fix: expired.length ? 'Re-authenticate expired provider(s) in Pi CLI or dashboard settings' : configured === 0 ? 'Configure at least one model provider in Pi CLI' : undefined };
  } catch (error) { modelsCheck = { id: 'models', status: 'warn', detail: error.message }; }
  let gitCheck;
  try { gitCheck = { id: 'git', status: 'pass', detail: execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 2000 }).trim() }; }
  catch (error) { gitCheck = { id: 'git', status: 'fail', detail: `git unavailable: ${error.message}`, fix: 'Install Git for isolated worktree execution' }; }
  const checks = [
    { id: 'node', status: !nodeOk ? 'fail' : nodeEphemeral ? 'warn' : 'pass', detail: `v${process.versions.node} (${stableNode})${nodeEphemeral ? ' [shell path ephemeral, stabilized]' : ''}`, fix: !nodeOk ? 'Upgrade Node.js to >= 22.19.0' : nodeEphemeral ? 'Run pi-server install so host configs use the stabilized Node path' : undefined },
    checkPiCli(), await probeSandbox(),
    { id: 'controller', status: ctrlDrift || badPerms ? 'warn' : 'pass', detail: ctrlAlive ? `alive (pid=${ctrlInfo.pid}${ctrlDrift ? ', stale scriptPath' : ''})` : 'idle (starts on demand)', fix: badPerms ? `chmod 700 "${stateDir}"` : ctrlDrift ? 'Close idle agents to allow automatic controller upgrade' : undefined },
    { id: 'dashboard', status: dashDrift ? 'warn' : 'pass', detail: dashInfo ? `running at ${dashInfo.url} (pid=${dashInfo.pid})` : `idle (default port ${parseDashboardPort()})`, fix: dashDrift ? 'pi-server dashboard' : undefined },
    modelsCheck, inspectHosts(), gitCheck,
  ];
  const summary = { pass: checks.filter(c => c.status === 'pass').length, warn: checks.filter(c => c.status === 'warn').length, fail: checks.filter(c => c.status === 'fail').length };
  const report = { ok: summary.fail === 0, version: pkg.version, checkedAt: new Date().toISOString(), summary, checks };
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Pi Server Doctor v${pkg.version} — ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    for (const c of checks) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.id.padEnd(10)} ${c.detail}${c.fix ? `\n         fix: ${c.fix}` : ''}`);
  }
  process.exit(report.ok ? 0 : 1);
}

async function runAsk() {
  const opts = { style: 'reviewer', contextFiles: [], dryRun: false, json: false };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--style') opts.style = rest[++i];
    else if (arg === '--cwd') opts.cwd = path.resolve(rest[++i]);
    else if (arg === '--file') opts.contextFiles.push(rest[++i]);
    else if (arg === '--thinking') opts.thinking = rest[++i];
    else if (arg === '--timeout') opts.timeoutMs = Number(rest[++i]);
    else if (arg === '--budget') opts.budgetCapUsd = Number(rest[++i]);
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown option for ask: ${arg}`);
  }
  const [modelSpec = '', ...qParts] = positional;
  const slash = modelSpec.indexOf('/'); const question = qParts.join(' ').trim();
  if (slash <= 0 || slash === modelSpec.length - 1 || !question) {
    throw new Error('Usage: pi-server ask <provider/model> "<question>" [--style reviewer] [--file path] [--cwd dir] [--dry-run] [--json]');
  }
  const provider = modelSpec.slice(0, slash); const model = modelSpec.slice(slash + 1);
  const stateDir = process.env.PI_SERVER_STATE_DIR || defaultStateRoot;
  const [{ connectController }, { runConsult }] = await Promise.all([import('../src/controller-client.js'), import('../src/consult.js')]);
  const client = await connectController({ root: stateDir, executable: process.env.PI_EXECUTABLE || resolveExecutable('pi') || 'pi' });
  try {
    const result = await runConsult({
      manager: client, stateRoot: stateDir,
      input: { provider, model, question, style: opts.style, cwd: opts.cwd, contextFiles: opts.contextFiles, thinking: opts.thinking, timeoutMs: opts.timeoutMs, budgetCapUsd: opts.budgetCapUsd, dryRun: opts.dryRun },
    });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else if (result.dryRun) console.log(`[dry-run] ${provider}/${model} est=$${result.estimate.catalogEstimateUsd} (~${result.estimate.totalInputTokens} in / ${result.estimate.totalOutputTokens} out)`);
    else console.log(result.answer || result.structured?.summary || result.error || '(empty response)');
    process.exit(result.status === 'failed' || result.status === 'timeout' ? 1 : 0);
  } finally { await client.close(); }
}

try {
  if (cmd === 'serve') await runServe();
  else if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(pkg.version);
  else if (cmd === '--help' || cmd === '-h' || cmd === 'help') printHelp();
  else if (cmd === 'install') forwardInstall(false);
  else if (cmd === 'uninstall') forwardInstall(true);
  else if (cmd === 'dashboard') await runDashboard();
  else if (cmd === 'doctor') await runDoctor();
  else if (cmd === 'ask') await runAsk();
  else { process.stderr.write(`Unknown command: ${cmd}\nRun "pi-server --help" for usage.\n`); process.exit(1); }
} catch (error) { process.stderr.write(`${error?.message || String(error)}\n`); process.exit(1); }
