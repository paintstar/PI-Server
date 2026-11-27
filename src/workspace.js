import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function validateOwnedPaths(paths, { readOnly = false } = {}) {
  if (readOnly && (!paths || !paths.length)) return [];
  if (!Array.isArray(paths) || !paths.length) throw new Error('Declare at least one owned path for development work');
  return paths.map(value => {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || !value.trim()) throw new Error('Owned paths must be relative without ..');
    return value.replace(/\\/g, '/').replace(/\/$/, '');
  });
}
export function pathsOverlap(a, b) {
  return a.some(x => b.some(y => x === '.' || y === '.' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/')));
}
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

export function resolveWorkspaceMode({ cwd, mode = 'auto' }) {
  const resolvedCwd = fs.realpathSync(cwd);
  if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('cwd must be a directory');
  let repository;
  try { repository = git(resolvedCwd, ['rev-parse', '--show-toplevel']); }
  catch (error) { if (mode === 'worktree') throw new Error('worktree requires a Git repository', { cause: error }); }
  const effectiveMode = mode === 'shared' || !repository ? 'shared' : 'worktree';
  return { resolvedCwd, root: repository || null, effectiveMode };
}

export function createWorkspace({ cwd, id, mode = 'auto', baseRef, directory }) {
  const { resolvedCwd: original, root: repository, effectiveMode } = resolveWorkspaceMode({ cwd, mode });
  if (effectiveMode === 'shared') return { cwd: original, sourceCwd: original, mode: 'shared', note: 'Shared directory; file and shell permissions are enforced separately by the agent tool policy.' };
  const base = git(repository, ['rev-parse', '--verify', `${baseRef || 'HEAD'}^{commit}`]);
  const dirty = !!git(repository, ['status', '--porcelain']);
  if (dirty && !baseRef) throw new Error('Git checkout has local changes. Supply an explicit committed baseRef, or explicitly choose shared mode.');
  const branch = `pi-agent/${id}`;
  const target = path.join(directory, 'worktree');
  const relative = path.relative(repository, original);
  if (relative) {
    let kind;
    try { kind = git(repository, ['cat-file', '-t', `${base}:${relative}`]); }
    catch (error) { throw new Error('Working subdirectory does not exist in selected baseRef', { cause: error }); }
    if (kind !== 'tree') throw new Error('Working subdirectory is not a directory in selected baseRef');
  }
  git(repository, ['worktree', 'add', '-b', branch, target, base]);
  const agentCwd = path.join(target, relative);
  if (!fs.existsSync(agentCwd)) throw new Error('Working subdirectory does not exist in selected baseRef');
  return { cwd: agentCwd, sourceCwd: original, mode: 'worktree', repository, branch, worktree: target, baseCommit: base, note: dirty ? 'Source checkout has local changes; only the selected committed baseRef was copied.' : undefined };
}
