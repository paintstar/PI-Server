import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, '.agents/records', 'opencode-' + Date.now());
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pi-acceptance-'));
const cwd = path.join(workRoot, 'workspace');
const extraConfig = path.join(workRoot, 'opencode-extra.json');
const stateDir = path.join(directory, 'state');
fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

function findExecutable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return '';
}

const useFakePi = process.argv.includes('--fake-pi');
const modelArg = process.argv.find(arg => arg.startsWith('--model='));
const opencodeModel = modelArg ? modelArg.slice(8) : (process.env.OPENCODE_MODEL || '');
let piBin = process.env.PI_EXECUTABLE || findExecutable('pi');
if (useFakePi) {
  piBin = path.join(workRoot, 'fake-pi-bin');
  const fakeScript = path.join(root, 'tests/helpers/fake-pi.js');
  fs.writeFileSync(piBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 1.0.2"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`, { mode: 0o755 });
}
if (!piBin) throw new Error('pi CLI was not found (pass --fake-pi to test real OpenCode LLM with local fake-pi child)');
const opencodeBin = process.env.OPENCODE_EXECUTABLE || findExecutable('opencode') || 'opencode';
const targetProvider = process.env.PI_VERIFY_PROVIDER || (useFakePi ? 'fake' : 'zhipu');
const targetModel = process.env.PI_VERIFY_MODEL || (useFakePi ? 'cheap' : 'glm-5.3');

const overlay = {
  permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  mcp: {
    servers: {
      'pi-subagents': {
        type: 'local',
        command: [process.execPath, path.join(root, 'src/server.js')],
        environment: {
          PI_EXECUTABLE: piBin,
          PI_SUBAGENTS_STATE_DIR: stateDir,
          PI_DASHBOARD_AUTO: '0',
          PI_SUBAGENTS_HOST: 'opencode',
          OPENCODE_EXECUTABLE: opencodeBin,
          PATH: process.env.PATH || '/usr/bin:/bin',
        },
      },
    },
  },
};
fs.writeFileSync(extraConfig, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });

const childPrompt = useFakePi ? 'OPENCODE-PI-READY' : '只回复 OPENCODE-PI-READY。不要调用工具或修改文件。';
const prompt = `这是用户授权的隔离 MCP 接入验证。请通过 Code Mode 中的 tools["pi-subagents"] 工具执行：1. 调用 get_client_capabilities 和 get_subagent_health，随后 list_models(provider=${JSON.stringify(targetProvider)})。2. 调用 spawn_agent(cwd=${JSON.stringify(cwd)}, provider=${JSON.stringify(targetProvider)}, model=${JSON.stringify(targetModel)}, thinking="low", ownedPaths=["demo"], workspaceMode="shared", prompt=${JSON.stringify(childPrompt)})。3. 用 read_agent / wait_agent 等待实际完成，wait_agent.timeoutMs 最大45000，进度事件不代表完成。4. 确认返回文字含 OPENCODE-PI-READY，调用 close_agent 关闭该代理。不要执行其他工作。最后只报告 PASS 或具体失败原因。`;

try {
  execFileSync('git', ['init', '-q'], { cwd });
  const args = ['run', '--standalone', ...(opencodeModel ? ['--model', opencodeModel] : []), '--format', 'json', '--archived', prompt];
  const child = spawn(opencodeBin, args, {
    cwd,
    env: { ...process.env, OPENCODE_CONFIG: extraConfig },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const errors = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 240000);
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code));
  });
  clearTimeout(timer);

  const records = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', text: line }; }
  });
  fs.writeFileSync(path.join(directory, 'events.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'stderr.txt'), Buffer.concat(errors), { mode: 0o600 });

  const serialized = JSON.stringify(records);
  const result = {
    exitCode,
    useFakePi,
    sawOpencodeHost: /\\?"host\\?"\s*:\s*\\?"opencode\\?"/.test(serialized),
    sawOpencodeParent: /\\?"kind\\?"\s*:\s*\\?"opencode\\?"/.test(serialized),
    sawSpawn: /spawn_agent/.test(serialized),
    sawClose: /close_agent/.test(serialized),
    sawReadyText: /OPENCODE-PI-READY/.test(serialized),
    completed: exitCode === 0 && /OPENCODE-PI-READY/.test(serialized) && /PASS/.test(serialized),
  };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  console.log('Evidence: ' + directory);
  if (!result.completed) process.exitCode = 1;
} finally {
  const controllerFile = path.join(stateDir, 'controller.json');
  if (fs.existsSync(controllerFile)) {
    try { process.kill(JSON.parse(fs.readFileSync(controllerFile, 'utf8')).pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 50 && fs.existsSync(path.join(stateDir, 'controller.lock')); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
}
