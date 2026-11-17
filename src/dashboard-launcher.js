import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, processAlive, readJsonSafe } from './storage.js';
import { parseDashboardPort, readRunningDashboard } from './dashboard-data.js';

export const defaultStateRoot = fileURLToPath(new URL('../.agents/runtime/', import.meta.url));
const script = fileURLToPath(new URL('./dashboard.js', import.meta.url));
const maxLogBytes = 1024 * 1024;
const keepLogBytes = 512 * 1024;

export function dashboardInfo(root = defaultStateRoot) {
  return readJsonSafe(path.join(root, 'dashboard.json'));
}

function matchesTarget(info, port) {
  if (!info) return false;
  return Number(new URL(info.url).port) === port && info.scriptPath === script;
}

function truncateLogTail(logPath) {
  let size = 0;
  try { size = fs.statSync(logPath).size; }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (size <= maxLogBytes) return;
  const fd = fs.openSync(logPath, 'r');
  let tail;
  try {
    const start = Math.max(0, size - keepLogBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const firstNewline = start > 0 ? buffer.indexOf(10) : -1;
    tail = firstNewline >= 0 ? buffer.subarray(firstNewline + 1) : buffer;
  } finally { fs.closeSync(fd); }
  const tmp = `${logPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, tail, { mode: 0o600 });
  fs.renameSync(tmp, logPath);
}

function tryAcquireLock(lockFile, port) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, createdAt: Date.now() }));
      } finally { fs.closeSync(fd); }
      return () => {
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          if (raw.pid === process.pid) fs.unlinkSync(lockFile);
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        stale = !holder?.pid || !processAlive(holder.pid) || (Date.now() - (holder.createdAt || 0) > 20000);
      } catch (readError) {
        if (readError?.code === 'ENOENT') stale = true;
        else if (readError instanceof SyntaxError) {
          try { stale = Date.now() - fs.statSync(lockFile).mtimeMs > 2000; } catch (statError) { stale = statError?.code === 'ENOENT'; }
        } else throw readError;
      }
      if (!stale) return null;
      try { fs.unlinkSync(lockFile); }
      catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return null;
}

async function retirePid(pid, waitForExit) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return;
  }
  if (!waitForExit) return;
  for (let i = 0; i < 30; i++) {
    if (!processAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function ensureDashboard(root = defaultStateRoot) {
  const port = parseDashboardPort();
  const initial = await readRunningDashboard(root);
  if (matchesTarget(initial, port)) return initial;

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockFile = path.join(root, 'dashboard.lock');
  let release = null;
  for (let wait = 0; wait < 60; wait++) {
    release = tryAcquireLock(lockFile, port);
    if (release) break;
    await new Promise(resolve => setTimeout(resolve, 100));
    const ready = await readRunningDashboard(root);
    if (matchesTarget(ready, port)) return ready;
  }
  if (!release) {
    const ready = await readRunningDashboard(root);
    if (matchesTarget(ready, port)) return ready;
    throw new Error('Timed out waiting for dashboard launch lock');
  }

  try {
    const previous = await readRunningDashboard(root);
    if (matchesTarget(previous, port)) return previous;
    const samePort = previous && Number(new URL(previous.url).port) === port;
    if (samePort) await retirePid(previous.pid, true);

    const logPath = path.join(root, 'dashboard.log');
    truncateLogTail(logPath);
    const log = fs.openSync(logPath, 'a', 0o600);
    let failure;
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PI_SUBAGENTS_STATE_DIR: root },
    });
    fs.closeSync(log);
    child.on('error', error => { failure = error; });
    child.unref();

    for (let n = 0; n < 40; n++) {
      const info = await readRunningDashboard(root);
      if (info && info.pid !== previous?.pid && Number(new URL(info.url).port) === port) {
        if (previous && !samePort) await retirePid(previous.pid, false);
        atomicWriteJson(path.join(root, 'dashboard.json'), { ...info, updatedAt: new Date().toISOString() });
        return info;
      }
      if (failure) throw failure;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Dashboard did not start. Check .agents/runtime/dashboard.log and whether port ${port} is occupied.`);
  } finally {
    release();
  }
}
