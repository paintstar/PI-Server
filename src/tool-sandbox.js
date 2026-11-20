import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBwrapArgs, isWsl, resolveBwrap } from './linux-sandbox.js';

const inside = (target, directory) => target === directory || target.startsWith(directory + path.sep);
/** Resolve existing ancestors before checking a path, including new files under symlinked directories. */
export function canonicalPath(value) {
  let parent = path.resolve(value); const suffix = [];
  while (!fs.existsSync(parent)) { if (parent === path.dirname(parent)) throw new Error('Cannot resolve path'); suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}
const configFile = fileURLToPath(new URL('../.agents/sandbox.json', import.meta.url));
const modes = new Set(['strict', 'dev', 'bypass']);
/** policy.sandboxMode wins; otherwise {"mode":"dev"|"bypass"} in .agents/sandbox.json. dev keeps credentials blocked; bypass opens every path including credentials, and only protects controller state. */
export function sandboxMode(policy = {}) {
  if (policy.sandboxMode) return modes.has(policy.sandboxMode) ? policy.sandboxMode : 'strict';
  try { const mode = JSON.parse(fs.readFileSync(configFile, 'utf8')).mode; return modes.has(mode) ? mode : 'strict'; } catch { return 'strict'; }
}
const privateHome = () => ['.pi', '.codex', '.ssh', '.config/opencode', '.local/share/opencode'].map(value => canonicalPath(path.join(os.homedir(), value)));
function gitCommonDir(cwd) {
  try {
    const marker = path.join(cwd, '.git');
    if (fs.statSync(marker).isDirectory()) return marker;
    const gitdir = path.resolve(cwd, fs.readFileSync(marker, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const common = path.join(gitdir, 'commondir');
    return fs.existsSync(common) ? path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim()) : gitdir;
  } catch { return null; }
}
export function assertToolPath(value, policy, write = false) {
  const target = canonicalPath(path.resolve(policy.cwd, value));
  const mode = sandboxMode(policy);
  const dev = mode !== 'strict';
  const allowed = write ? (dev ? [policy.cwd, policy.tempDir] : policy.ownedPaths.map(value => path.resolve(policy.cwd, value))).map(canonicalPath) : [fs.realpathSync(policy.cwd)];
  if (mode !== 'bypass' && (write || !dev) && !allowed.some(directory => inside(target, directory))) throw new Error('Tool path is outside the permitted file scope');
  const state = canonicalPath(policy.stateRoot);
  const workspace = fs.realpathSync(policy.cwd);
  if (inside(target, state) && !(inside(workspace, state) && inside(target, workspace))) throw new Error('Tool cannot read controller state');
  if (mode !== 'bypass') for (const directory of privateHome()) if (inside(target, directory)) throw new Error('Tool cannot read private credentials');
  return target;
}
export function sandboxHealth(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const ok = fs.existsSync('/usr/bin/sandbox-exec');
    return { backend: 'seatbelt', ok, executable: ok ? '/usr/bin/sandbox-exec' : null, platform };
  }
  if (platform === 'linux') {
    const executable = resolveBwrap(env);
    return { backend: 'bwrap', ok: Boolean(executable), executable: executable || null, platform, wsl: isWsl(undefined, env) };
  }
  return { backend: 'unsupported', ok: false, executable: null, platform };
}
const filter = value => `(subpath ${JSON.stringify(canonicalPath(value))})`;
export function sandboxProfile(policy) {
  if (process.platform === 'linux') {
    const bwrap = resolveBwrap();
    if (!bwrap) throw new Error('Tool sandbox on Linux/WSL2 requires bubblewrap (bwrap); install with: sudo apt-get install -y bubblewrap');
    const mode = sandboxMode(policy);
    return buildBwrapArgs(policy, '/bin/true', [], {
      canonicalPath,
      mode,
      privateDirectories: privateHome(),
      gitCommonDir: gitCommonDir(policy.cwd),
    });
  }
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('Strict tool sandbox requires macOS sandbox-exec or Linux/WSL2 bubblewrap (bwrap); unsupported platforms fail closed.');
  const mode = sandboxMode(policy);
  if (mode !== 'strict') return developmentProfile(policy, mode === 'bypass');
  const read = [policy.cwd, policy.tempDir, path.dirname(path.dirname(process.execPath)), '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc', '/private/var/db', '/dev', ...(fs.existsSync('/opt/homebrew') ? ['/opt/homebrew'] : [])];
  const workspace = canonicalPath(policy.cwd);
  const owned = policy.ownedPaths.map(value => canonicalPath(path.resolve(policy.cwd, value)));
  if (owned.some(value => !inside(value, workspace))) throw new Error('Owned path resolves outside the workspace');
  const write = [...owned, policy.tempDir, '/dev/null', '/dev/tty'];
  const privateDirectories = privateHome();
  return `(version 1) (allow default)
(deny file-read-data (require-not (require-any (literal "/") ${read.map(filter).join(' ')})))
(deny file-write* (require-not (require-any ${write.map(filter).join(' ')})))
${privateDirectories.map(value => `(deny file-read* ${filter(value)}) (deny file-write* ${filter(value)})`).join('\n')}
(deny file-read* (require-all ${filter(policy.stateRoot)} (require-not (require-any ${inside(canonicalPath(policy.cwd), canonicalPath(policy.stateRoot)) ? filter(policy.cwd) : ''} ${filter(policy.tempDir)}))))
(deny file-write* (require-all ${filter(policy.stateRoot)} (require-not (require-any ${inside(canonicalPath(policy.cwd), canonicalPath(policy.stateRoot)) ? filter(policy.cwd) : ''} ${filter(policy.tempDir)}))))
${policy.allowNetwork ? '' : '(deny network*)'}
(deny appleevent-send) (deny mach-lookup) (deny process-info*) (deny signal)`;
}
function developmentProfile(policy, open = false) {
  const home = os.homedir();
  const write = [policy.cwd, policy.tempDir, gitCommonDir(policy.cwd), path.join(home, '.cache'), path.join(home, '.local/share/uv'), path.join(home, 'Library/Caches'), '/private/var/folders', '/private/tmp', '/dev']
    .filter(value => value && fs.existsSync(value));
  const privateDirectories = open ? [] : privateHome();
  const own = inside(canonicalPath(policy.cwd), canonicalPath(policy.stateRoot)) ? filter(policy.cwd) : '';
  return `(version 1) (allow default)
${open ? '' : `(deny file-write* (require-not (require-any ${write.map(filter).join(' ')})))`}
${privateDirectories.map(value => `(deny file-read* ${filter(value)}) (deny file-write* ${filter(value)})`).join('\n')}
(deny file-read-data (require-all ${filter(policy.stateRoot)} (require-not (require-any ${own} ${filter(policy.tempDir)}))))
(deny file-write* (require-all ${filter(policy.stateRoot)} (require-not (require-any ${own} ${filter(policy.tempDir)}))))
${policy.allowNetwork ? '' : '(deny network*) (allow network* (remote ip "localhost:*")) (allow network* (remote unix-socket))'}
(deny appleevent-send)`;
}
const children = new Set(); let cleanupInstalled = false;
function terminateChildren() { for (const pid of children) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') process.stderr.write(`Tool shutdown failed: ${error.message}\n`); } } }
export function runSandboxed(policy, executable, args, { signal, timeout = 60000, onData = () => {}, onStdout, onStderr, input } = {}) {
  let command;
  let commandArgs;
  if (process.platform === 'linux') {
    const bwrap = resolveBwrap();
    if (!bwrap) throw new Error('Tool sandbox on Linux/WSL2 requires bubblewrap (bwrap); install with: sudo apt-get install -y bubblewrap');
    command = bwrap;
    commandArgs = buildBwrapArgs(policy, executable, args, {
      canonicalPath,
      mode: sandboxMode(policy),
      privateDirectories: privateHome(),
      gitCommonDir: gitCommonDir(policy.cwd),
    });
  } else {
    const profile = sandboxProfile(policy);
    command = '/usr/bin/sandbox-exec';
    commandArgs = ['-p', profile, executable, ...args];
  }
  if (!cleanupInstalled) { cleanupInstalled = true; process.once('exit', terminateChildren); process.once('SIGTERM', () => { terminateChildren(); process.exit(143); }); }
  const env = { PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: policy.tempDir };
  if (sandboxMode(policy) !== 'strict') {
    const extraPath = [
      path.join(os.homedir(), '.local/bin'),
      ...(process.platform === 'darwin' ? ['/Library/Developer/CommandLineTools/usr/bin', '/opt/homebrew/bin'] : ['/usr/local/bin']),
      process.env.PATH,
    ].filter(Boolean);
    Object.assign(env, { HOME: os.homedir(), PATH: extraPath.join(path.delimiter) });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: policy.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child.pid);
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); } };
    const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', chunk => { onStdout?.(chunk); onData(chunk); });
    child.stderr.on('data', chunk => { onStderr?.(chunk); onData(chunk); });
    child.on('error', error => { children.delete(child.pid); clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', (code, termination) => { children.delete(child.pid); clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ exitCode: code ?? (termination ? 137 : 1) }); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
    if (signal?.aborted) stop();
  });
}

const worker = `const fs=require('fs'); const [operation,file,extra]=process.argv.slice(1);
if(operation==='read') process.stdout.write(fs.readFileSync(file));
else if(operation==='read_head'){const len=Number(extra);if(!Number.isInteger(len)||len<0)throw new Error('Invalid read_head length');if(len>0){const fd=fs.openSync(file,'r');try{const buf=Buffer.alloc(len);const n=fs.readSync(fd,buf,0,len,0);process.stdout.write(buf.subarray(0,n));}finally{fs.closeSync(fd);}}}
else if(operation==='access') fs.accessSync(file);
else {let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>{fs.mkdirSync(require('path').dirname(file),{recursive:true});fs.writeFileSync(file,value)});}`;
export async function fileOperation(policy, operation, filename, content, options = {}) {
  const file = assertToolPath(filename, policy, operation === 'write');
  if (process.platform === 'linux' && operation === 'write' && sandboxMode(policy) === 'strict') {
    const parent = path.dirname(file);
    const owned = policy.ownedPaths.map(value => canonicalPath(path.resolve(policy.cwd, value)));
    if (owned.some(dir => inside(parent, dir)) && !fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
  }
  const stdout = [];
  const stderr = [];
  const workerArgs = ['--no-warnings', '-e', worker, operation, file];
  if (operation === 'read_head') {
    const length = options.length ?? 64;
    if (!Number.isInteger(length) || length < 0) throw new Error('Invalid read_head length');
    if (length === 0) return Buffer.alloc(0);
    workerArgs.push(String(length));
  }
  const result = await runSandboxed(policy, process.execPath, workerArgs, {
    input: content,
    onStdout: chunk => stdout.push(chunk),
    onStderr: chunk => stderr.push(chunk),
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(detail ? `Sandboxed ${operation} failed: ${detail.split('\n')[0]}` : `Sandboxed file operation failed or was denied (${result.exitCode})`);
  }
  return Buffer.concat(stdout);
}
