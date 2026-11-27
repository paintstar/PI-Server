import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractResolvedPath,
  isEphemeralBinPath,
  resolveExecutable,
  stabilizeExecutablePath,
} from '../src/bin-resolve.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliBin = path.join(root, 'bin/pi-server.js');
const installScript = path.join(root, 'scripts/install.js');
const docsLogo = fs.readFileSync(path.join(root, 'docs/assets/logo.svg'), 'utf8');

function buildFnmFixture(tmp, realNodeTarget = null) {
  const installDir = path.join(tmp, 'fnm/node-versions/v24.22.3/installation');
  const binDir = path.join(installDir, 'bin');
  const piBundleDir = path.join(installDir, 'lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle');
  const aliasesDir = path.join(tmp, 'fnm/aliases');
  const multishellDir = path.join(tmp, 'fnm_multishells');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(piBundleDir, { recursive: true });
  fs.mkdirSync(aliasesDir, { recursive: true });
  fs.mkdirSync(multishellDir, { recursive: true });

  const nodeFile = path.join(binDir, 'node');
  if (realNodeTarget) fs.symlinkSync(realNodeTarget, nodeFile);
  else fs.writeFileSync(nodeFile, '#!/bin/sh\necho v24.22.3\n', { mode: 0o755 });

  const piCli = path.join(piBundleDir, 'cli.js');
  fs.writeFileSync(piCli, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  fs.symlinkSync('../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', path.join(binDir, 'pi'));

  const defaultAlias = path.join(aliasesDir, 'default');
  fs.symlinkSync('../node-versions/v24.22.3/installation', defaultAlias);

  const msDefault = path.join(multishellDir, '7600_1795742273281');
  fs.symlinkSync(defaultAlias, msDefault);

  const msPinned = path.join(multishellDir, '8800_1795742299999');
  fs.symlinkSync(installDir, msPinned);

  return { installDir, defaultAlias, msDefault, msPinned };
}

test('stabilizeExecutablePath resolves fnm default and pinned aliases without penetrating bin/pi symlink', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fnm-fix-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { installDir, defaultAlias, msDefault, msPinned } = buildFnmFixture(tmp);

  const ephemeralNode = path.join(msDefault, 'bin/node');
  const ephemeralPi = path.join(msDefault, 'bin/pi');
  assert.equal(isEphemeralBinPath(ephemeralNode), true);
  assert.equal(isEphemeralBinPath(ephemeralPi), true);

  const stableDefaultNode = stabilizeExecutablePath(ephemeralNode, { FNM_MULTISHELL_PATH: msDefault });
  const stableDefaultPi = stabilizeExecutablePath(ephemeralPi, { FNM_MULTISHELL_PATH: msDefault });
  assert.equal(stableDefaultNode, path.join(defaultAlias, 'bin/node'));
  assert.equal(stableDefaultPi, path.join(defaultAlias, 'bin/pi'));
  assert.equal(isEphemeralBinPath(stableDefaultNode), false);
  assert.equal(stableDefaultPi.endsWith('cli.js'), false);

  const stablePinnedNode = stabilizeExecutablePath(path.join(msPinned, 'bin/node'), {});
  const stablePinnedPi = stabilizeExecutablePath(path.join(msPinned, 'bin/pi'), {});
  assert.equal(stablePinnedNode, path.join(installDir, 'bin/node'));
  assert.equal(stablePinnedPi, path.join(installDir, 'bin/pi'));
  assert.equal(stablePinnedPi.endsWith('cli.js'), false);
});

test('extractResolvedPath and resolveExecutable ignore login-shell MOTD noise and stabilize fnm paths', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-motd-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { defaultAlias, msDefault } = buildFnmFixture(tmp);
  const ephemeralPi = path.join(msDefault, 'bin/pi');

  const noisyStdout = [
    'Welcome to zsh! Last login: Fri Nov 27',
    'conda initialized (base)',
    '',
    ephemeralPi,
  ].join('\n');
  assert.equal(extractResolvedPath(noisyStdout), ephemeralPi);

  const resolved = resolveExecutable('pi', {
    env: { PATH: '/nonexistent-dir', SHELL: '/bin/sh', FNM_MULTISHELL_PATH: msDefault },
    homedir: path.join(tmp, 'empty-home'),
    execFile: () => noisyStdout,
  });
  assert.equal(resolved, path.join(defaultAlias, 'bin/pi'));
  assert.equal(isEphemeralBinPath(resolved), false);
});

test('install --dry-run has zero disk side effects and real install stabilizes node/hook/pi paths with shin metadata', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-inst-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { defaultAlias, msDefault } = buildFnmFixture(tmp, process.execPath);
  const pluginsDir = path.join(tmp, 'plugins');
  const backupDir = path.join(tmp, 'backups');

  const env = {
    ...process.env,
    FNM_MULTISHELL_PATH: msDefault,
    PI_NODE_EXECUTABLE: path.join(msDefault, 'bin/node'),
    PI_EXECUTABLE: path.join(msDefault, 'bin/pi'),
    PI_ANTIGRAVITY_PLUGINS_DIR: pluginsDir,
    PI_CONFIG_BACKUP_DIR: backupDir,
  };

  const dryOut = JSON.parse(execFileSync(process.execPath, [cliBin, 'install', 'antigravity', '--dry-run'], { env, encoding: 'utf8' }));
  assert.equal(dryOut.dryRun, true);
  assert.equal(dryOut.action, 'install');
  assert.equal(dryOut.version, '2.0.0');
  assert.equal(dryOut.author, 'shin');
  assert.equal(dryOut.node, path.join(defaultAlias, 'bin/node'));
  assert.equal(dryOut.pi, path.join(defaultAlias, 'bin/pi'));
  assert.equal(fs.existsSync(pluginsDir), false);
  assert.equal(fs.existsSync(backupDir), false);

  execFileSync(process.execPath, [installScript, '--target=antigravity'], { env, encoding: 'utf8' });
  const pluginRoot = path.join(pluginsDir, 'pi-server');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp_config.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  const rules = fs.readFileSync(path.join(pluginRoot, 'rules/AGENTS.md'), 'utf8');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills/pi-server/SKILL.md'), 'utf8');
  const installedLogo = fs.readFileSync(path.join(pluginRoot, 'assets/logo.svg'), 'utf8');

  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.author.name, 'shin');
  assert.equal(installedLogo, docsLogo);
  assert.equal(mcp.mcpServers['pi-server'].command, path.join(defaultAlias, 'bin/node'));
  assert.equal(mcp.mcpServers['pi-server'].env.PI_EXECUTABLE, path.join(defaultAlias, 'bin/pi'));
  assert.equal(hooks['pi-server-callbacks'].PreInvocation[0].command.includes('fnm_multishells'), false);
  assert.ok(hooks['pi-server-callbacks'].PreInvocation[0].command.includes(path.join(defaultAlias, 'bin/node')));
  assert.equal(/gpt-6-astra|gpt-6\.1-sol/.test(rules), false);
  assert.equal(/gpt-6-astra|gpt-6\.1-sol/.test(skill), false);
});

test('pi-server doctor --json runs all 8 checks, flags ephemeral host paths and never leaks secrets', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-doctor-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const stateDir = path.join(tmp, 'state');
  const agentDir = path.join(tmp, 'pi-agent');
  const pluginsDir = path.join(home, '.gemini/config/plugins');
  const fakePi = path.join(tmp, 'fake-pi');
  fs.mkdirSync(path.join(pluginsDir, 'pi-server'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fakePi, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
    deepseek: { type: 'api_key', key: 'sk-secret-sentinel-99999' },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(pluginsDir, 'pi-server/plugin.json'), JSON.stringify({ name: 'pi-server' }));
  fs.writeFileSync(path.join(pluginsDir, 'pi-server/mcp_config.json'), JSON.stringify({
    mcpServers: {
      'pi-server': {
        command: '/tmp/fnm_multishells/dead_123/bin/node',
        args: ['/nonexistent/server.js'],
        env: { PI_EXECUTABLE: '/tmp/fnm_multishells/dead_123/bin/pi' },
      },
    },
  }));

  const env = {
    ...process.env,
    HOME: home,
    PI_SERVER_STATE_DIR: stateDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_ANTIGRAVITY_PLUGINS_DIR: pluginsDir,
    PI_EXECUTABLE: fakePi,
    OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'),
  };
  const stdout = execFileSync(process.execPath, [cliBin, 'doctor', '--json'], { env, encoding: 'utf8' });
  assert.equal(stdout.includes('sk-secret-sentinel-99999'), false);

  const report = JSON.parse(stdout);
  assert.equal(report.version, '2.0.0');
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(c => c.id), ['node', 'pi', 'sandbox', 'controller', 'dashboard', 'models', 'hosts', 'git']);
  assert.equal(report.checks.find(c => c.id === 'sandbox').status, 'pass');
  const hostsCheck = report.checks.find(c => c.id === 'hosts');
  assert.equal(hostsCheck.status, 'warn');
  assert.ok(hostsCheck.issues.some(msg => msg.includes('ephemeral path')));
});

test('pi-server --version, --help and ask --dry-run work cleanly with zero side effects', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-ask-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stateDir = path.join(tmp, 'state');
  const fakePiBin = path.join(tmp, 'fake-pi-bin');
  const fakePiScript = path.join(root, 'tests/helpers/fake-pi.js');
  fs.writeFileSync(fakePiBin, `#!/bin/sh\nexec "${process.execPath}" "${fakePiScript}" "$@"\n`, { mode: 0o755 });

  assert.equal(execFileSync(process.execPath, [cliBin, '--version'], { encoding: 'utf8' }).trim(), '2.0.0');
  const help = execFileSync(process.execPath, [cliBin, '--help'], { encoding: 'utf8' });
  assert.match(help, /pi-server doctor/);
  assert.match(help, /pi-server ask/);

  const askOut = JSON.parse(execFileSync(process.execPath, [cliBin, 'ask', 'fake/cheap', 'hello world', '--dry-run', '--json'], {
    env: { ...process.env, PI_SERVER_STATE_DIR: stateDir, PI_EXECUTABLE: fakePiBin },
    encoding: 'utf8',
  }));
  assert.equal(askOut.dryRun, true);
  assert.equal(askOut.kind, 'consult');
  assert.equal(askOut.status, 'dry_run');
  assert.equal(askOut.model.provider, 'fake');
  assert.equal(askOut.model.model, 'cheap');
  assert.equal(askOut.estimate.pricingNote, 'Static catalog estimate, not actual billing');
  assert.equal(fs.existsSync(path.join(stateDir, 'runs')), false);
});

test('pi-server serve emits strictly pure MCP JSON-RPC frames on stdout', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-serve-pure-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const child = spawnChild(process.execPath, [cliBin, 'serve'], {
    env: { ...process.env, PI_SERVER_STATE_DIR: path.join(tmp, 'state'), PI_DASHBOARD_AUTO: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGTERM'); } catch {} });

  let stdout = '';
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP initialize response; stdout=${stdout}`)), 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length) {
        clearTimeout(timer);
        resolve(lines);
      }
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli-test', version: '1.0.0' } },
    })}\n`);
  });

  for (const line of response) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.jsonrpc, '2.0');
  }
  const initReply = JSON.parse(response[0]);
  assert.equal(initReply.id, 1);
  assert.equal(initReply.result.serverInfo.name, 'pi-server');
  assert.equal(initReply.result.serverInfo.version, '2.0.0');
  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
});
