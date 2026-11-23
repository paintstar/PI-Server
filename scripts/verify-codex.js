import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, '.agents/records', 'codex-' + Date.now());
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pi-acceptance-'));
const prompt = `这是用户授权的隔离 MCP 接入验证。请通过 pi-server MCP 工具执行：1. get_client_capabilities 并保留返回数据，随后 list_models(provider="zhipu")。2. spawn_agent(cwd=${JSON.stringify(cwd)}, provider="zhipu", model="glm-5.3", thinking="low", ownedPaths=["demo"], workspaceMode="shared", prompt="只回复 CODEX-PI-READY。不要调用工具或修改文件。")。3. 用 read_agent / wait_agent 等待实际完成，wait_agent.timeoutMs 最大45000，进度事件不代表完成。4. 确认返回文字含 CODEX-PI-READY，close_agent 关闭该代理。不要执行其他工作。最后只报告 PASS 或具体失败原因。`;
const command = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '-c', `mcp_servers.pi-server.env.PI_SERVER_STATE_DIR=${JSON.stringify(path.join(directory, 'state'))}`, prompt];
const child = spawn('codex', command, { stdio: ['ignore', 'pipe', 'pipe'] });
const output = []; const errors = [];
child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
const timer = setTimeout(() => { child.kill('SIGTERM'); }, 240000);
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
clearTimeout(timer);
const records = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return { type: 'unparsed', text: line }; }
});
fs.writeFileSync(path.join(directory, 'events.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(directory, 'stderr.txt'), Buffer.concat(errors), { mode: 0o600 });
const items = records.filter(r => r.type === 'item.completed').map(r => r.item);
const calls = items.filter(i => i.type === 'mcp_tool_call');
const final = items.filter(i => i.type === 'agent_message').at(-1)?.text;
const payload = item => item?.result?.structured_content?.result || (item?.result?.content?.[0]?.text && JSON.parse(item.result.content[0].text));
const capabilities = payload(calls.find(c => c.tool === 'get_client_capabilities'));
const actualCompletion = calls.filter(c => c.status === 'completed' && ['read_agent', 'wait_agent'].includes(c.tool)).some(c => { const value = payload(c); return [value, ...(value?.results || [])].some(v => v?.agent?.status === 'completed' && /CODEX-PI-READY/.test(v.agent.lastText || '')); });
const result = { capabilities, actualCompletion, exitCode, final, toolCalls: calls.map(c => ({ server: c.server, tool: c.tool, status: c.status })), completed: actualCompletion && exitCode === 0 && /^PASS\b/.test(final || '') && calls.some(c => c.tool === 'spawn_agent') && calls.some(c => c.tool === 'close_agent') };
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const controllerFile = path.join(directory, 'state/controller.json');
if (fs.existsSync(controllerFile)) { process.kill(JSON.parse(fs.readFileSync(controllerFile, 'utf8')).pid, 'SIGTERM'); for (let i = 0; i < 50 && fs.existsSync(path.join(directory, 'state/controller.lock')); i++) await new Promise(resolve => setTimeout(resolve, 50)); }
fs.rmSync(cwd, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2)); console.log('Evidence: ' + directory);
if (!result.completed) process.exitCode = 1;
