import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspace, validateOwnedPaths } from '../src/workspace.js';
import { setup } from './helpers/setup.js';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test('parallel worktrees isolate changes and dirty source requires an explicit decision', async t => {
  const { cwd } = await setup(t);
  git(cwd, 'init'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'original'); git(cwd, 'add', 'source.txt'); git(cwd, 'commit', '-m', 'Initial');
  // Test state directory is untracked, so explicitly select the committed HEAD.
  const work = createWorkspace({ cwd, id: 'test-agent', directory: path.join(cwd, 'state/agent'), baseRef: 'HEAD' });
  fs.writeFileSync(path.join(work.cwd, 'source.txt'), 'changed');
  assert.equal(fs.readFileSync(path.join(cwd, 'source.txt'), 'utf8'), 'original');
  assert.equal(work.mode, 'worktree');
  await assert.rejects(async () => createWorkspace({ cwd, id: 'other', directory: path.join(cwd, 'state/other') }), /local changes/);
  assert.throws(() => validateOwnedPaths(['../outside']), /relative/);
  const missing = path.join(cwd, 'new-package'); fs.mkdirSync(missing);
  assert.throws(() => createWorkspace({ cwd: missing, id: 'missing-package', directory: path.join(cwd, 'state/missing'), baseRef: 'HEAD' }), /subdirectory does not exist/);
  assert.equal(git(cwd, 'branch', '--list', 'pi-agent/missing-package'), '');
});
