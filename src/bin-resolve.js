import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FNM_MULTISHELL_RE = /^(.*[/\\]fnm_multishells[/\\][^/\\]+)([/\\].*)?$/;

export function isEphemeralBinPath(value = '') {
  return typeof value === 'string' && /(?:^|[/\\])fnm_multishells[/\\]/.test(value);
}

function splitMultishellPath(rawPath, env) {
  const envRoot = env?.FNM_MULTISHELL_PATH ? env.FNM_MULTISHELL_PATH.replace(/[/\\]+$/, '') : '';
  if (envRoot && (rawPath === envRoot || rawPath.startsWith(envRoot + path.sep))) {
    return { root: envRoot, tail: rawPath.slice(envRoot.length) };
  }
  const match = FNM_MULTISHELL_RE.exec(rawPath);
  if (!match) return null;
  return { root: match[1], tail: match[2] || '' };
}

function joinTail(base, tail) {
  const clean = tail ? tail.replace(/^[/\\]+/, '') : '';
  return clean ? path.join(base, clean) : base;
}

export function stabilizeExecutablePath(rawPath, env = process.env, fsApi = fs) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  const split = splitMultishellPath(trimmed, env);
  if (!split) return trimmed;
  try {
    const linkTarget = fsApi.readlinkSync(split.root);
    const resolvedRoot = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(split.root), linkTarget);
    const candidate = joinTail(resolvedRoot, split.tail);
    if (!isEphemeralBinPath(candidate) && fsApi.existsSync(candidate)) return candidate;
  } catch {}
  try {
    const realRoot = fsApi.realpathSync(split.root);
    const candidate = joinTail(realRoot, split.tail);
    if (!isEphemeralBinPath(candidate) && fsApi.existsSync(candidate)) return candidate;
  } catch {}
  return trimmed;
}

export function extractResolvedPath(stdout = '', fsApi = fs) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i];
    if (path.isAbsolute(candidate) && fsApi.existsSync(candidate)) return candidate;
  }
  return '';
}

export function resolveShell(env = process.env, fsApi = fs) {
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  return candidates.find(candidate => candidate && fsApi.existsSync(candidate)) || '/bin/sh';
}

export function resolveExecutable(command, options = {}) {
  const {
    env = process.env,
    fsApi = fs,
    execFile = execFileSync,
    allowShell = true,
    homedir = os.homedir(),
  } = options;
  if (!command || typeof command !== 'string') return '';
  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const fallbackDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homedir, '.local', 'bin'),
    path.join(homedir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(homedir, '.volta', 'bin'),
  ];
  for (const dir of [...new Set([...pathDirs, ...fallbackDirs])]) {
    const candidate = path.join(dir, command);
    if (fsApi.existsSync(candidate)) return stabilizeExecutablePath(candidate, env, fsApi);
  }
  if (!allowShell) return '';
  try {
    const shell = resolveShell(env, fsApi);
    const flag = /\/(?:zsh|bash)$/.test(shell) ? '-lc' : '-c';
    const stdout = execFile(shell, [flag, `command -v ${command}`], { encoding: 'utf8', env, timeout: 4000 });
    const found = extractResolvedPath(stdout, fsApi);
    return found ? stabilizeExecutablePath(found, env, fsApi) : '';
  } catch (error) {
    if (error?.status == null && error?.code == null) throw error;
    return '';
  }
}

export function resolveStableNode(env = process.env, execPath = process.execPath, fsApi = fs) {
  const raw = env.PI_NODE_EXECUTABLE?.trim() || execPath;
  return stabilizeExecutablePath(raw, env, fsApi);
}

export function standardBinDirs(extraDirs = [], fsApi = fs) {
  const optional = ['/opt/homebrew/bin', '/usr/local/bin'].filter(dir => fsApi.existsSync(dir));
  const base = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([...extraDirs.filter(Boolean), ...optional, ...base])];
}
