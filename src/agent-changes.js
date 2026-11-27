import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function git(cwd, args) {
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function isBinaryBuffer(buf) {
  const limit = Math.min(buf.length, 4096);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

function buildUntrackedDiff(cwd, files, remainingBytes) {
  const chunks = [];
  let used = 0;
  let truncated = false;
  const rootReal = fs.realpathSync(cwd);
  for (const rel of files) {
    const cleanRel = rel.replace(/\\/g, '/');
    const full = path.resolve(cwd, rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let real;
    try { real = fs.realpathSync(full); } catch { continue; }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
    let raw;
    try { raw = fs.readFileSync(full); } catch { continue; }
    let block;
    if (isBinaryBuffer(raw)) {
      block = `diff --git a/${cleanRel} b/${cleanRel}\nnew file mode 100644\nBinary file ${cleanRel} (${raw.length} bytes)\n`;
    } else {
      const text = raw.toString('utf8');
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      const body = lines.map(line => `+${line}`).join('\n');
      block = `diff --git a/${cleanRel} b/${cleanRel}\nnew file mode 100644\n--- /dev/null\n+++ b/${cleanRel}\n@@ -0,0 +1,${lines.length} @@\n${body}${lines.length ? '\n' : ''}`;
    }
    if (used + block.length > remainingBytes) {
      const room = Math.max(0, remainingBytes - used);
      if (room > 0) chunks.push(block.slice(0, room));
      truncated = true;
      break;
    }
    chunks.push(block);
    used += block.length;
  }
  return { text: chunks.join(''), truncated };
}

/** Read-only review of an agent's files: worktrees compare with their base commit, shared Git directories with HEAD. */
export async function agentChanges(agent, { includeDiff = true, includeUntracked = true, maxBytes = 20000 } = {}) {
  const workspace = agent.workspace;
  if (!workspace?.cwd) throw new Error('Agent has no recorded workspace');
  let root;
  try { root = (await git(workspace.cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { return { mode: workspace.mode, cwd: workspace.cwd, git: false, note: 'Not a Git directory; inspect owned paths directly.', ownedPaths: agent.ownedPaths }; }
  const base = workspace.mode === 'worktree' ? workspace.baseCommit : 'HEAD';
  const scope = workspace.mode === 'worktree' ? [] : ['--', ...agent.ownedPaths];
  const [status, stat, commits, untrackedRaw] = await Promise.all([
    git(workspace.cwd, ['status', '--porcelain', '--untracked-files=all', ...scope]),
    git(workspace.cwd, ['diff', '--stat', base, ...scope]),
    workspace.mode === 'worktree' ? git(workspace.cwd, ['log', '--oneline', `${base}..HEAD`]) : Promise.resolve(''),
    git(workspace.cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]),
  ]);
  const untrackedFiles = untrackedRaw.split('\0').filter(Boolean);
  const result = { mode: workspace.mode, cwd: workspace.cwd, repository: root, branch: workspace.branch, base, ownedPaths: agent.ownedPaths,
    status: status.split('\n').filter(Boolean), commits: commits.split('\n').filter(Boolean), untrackedFiles, diffStat: stat.trim() };
  if (includeDiff) {
    const trackedDiff = await git(workspace.cwd, ['diff', base, ...scope]);
    if (trackedDiff.length >= maxBytes) {
      result.diff = trackedDiff.slice(0, maxBytes);
      result.diffTruncated = trackedDiff.length > maxBytes || (includeUntracked && untrackedFiles.length > 0);
    } else if (includeUntracked && untrackedFiles.length > 0) {
      const separator = trackedDiff && !trackedDiff.endsWith('\n') ? '\n' : '';
      const remaining = maxBytes - trackedDiff.length - separator.length;
      const extra = buildUntrackedDiff(workspace.cwd, untrackedFiles, remaining);
      result.diff = trackedDiff + (extra.text ? separator + extra.text : '');
      result.diffTruncated = extra.truncated;
    } else {
      result.diff = trackedDiff;
      result.diffTruncated = false;
    }
  }
  if (workspace.mode !== 'worktree') result.note = 'Shared directory: changes are limited to owned paths but may include edits by others.';
  return result;
}
