import { execFile } from 'node:child_process';

function git(cwd, args) {
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** Read-only review of an agent's files: worktrees compare with their base commit, shared Git directories with HEAD. */
export async function agentChanges(agent, { includeDiff = true, maxBytes = 20000 } = {}) {
  const workspace = agent.workspace;
  if (!workspace?.cwd) throw new Error('Agent has no recorded workspace');
  let root;
  try { root = (await git(workspace.cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { return { mode: workspace.mode, cwd: workspace.cwd, git: false, note: 'Not a Git directory; inspect owned paths directly.', ownedPaths: agent.ownedPaths }; }
  const base = workspace.mode === 'worktree' ? workspace.baseCommit : 'HEAD';
  const scope = workspace.mode === 'worktree' ? [] : ['--', ...agent.ownedPaths];
  const [status, stat, commits] = await Promise.all([
    git(workspace.cwd, ['status', '--porcelain', '--untracked-files=all', ...scope]),
    git(workspace.cwd, ['diff', '--stat', base, ...scope]),
    workspace.mode === 'worktree' ? git(workspace.cwd, ['log', '--oneline', `${base}..HEAD`]) : Promise.resolve(''),
  ]);
  const result = { mode: workspace.mode, cwd: workspace.cwd, repository: root, branch: workspace.branch, base, ownedPaths: agent.ownedPaths,
    status: status.split('\n').filter(Boolean), commits: commits.split('\n').filter(Boolean), diffStat: stat.trim() };
  if (includeDiff) {
    const diff = await git(workspace.cwd, ['diff', base, ...scope]);
    result.diff = diff.slice(0, maxBytes); result.diffTruncated = diff.length > maxBytes;
  }
  if (workspace.mode !== 'worktree') result.note = 'Shared directory: changes are limited to owned paths but may include edits by others.';
  return result;
}
