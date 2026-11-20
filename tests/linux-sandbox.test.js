import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildBwrapArgs, isWsl, resolveBwrap } from '../src/linux-sandbox.js';
import { sandboxHealth } from '../src/tool-sandbox.js';

function fakeFs(existing, symlinks = {}) {
  const set = new Set(existing);
  return {
    existsSync: p => set.has(p),
    lstatSync: p => ({ isSymbolicLink: () => Object.hasOwn(symlinks, p) }),
    readlinkSync: p => symlinks[p],
    realpathSync: p => p,
    canonicalPath: p => path.resolve(p),
  };
}

test('resolveBwrap and isWsl detect Linux/WSL2 bubblewrap accurately', () => {
  assert.equal(isWsl('6.6.87.2-microsoft-standard-WSL2', {}), true);
  assert.equal(isWsl('6.8.0-generic', { WSL_DISTRO_NAME: 'Ubuntu-24.04' }), true);
  assert.equal(isWsl('6.8.0-generic', {}), false);

  assert.equal(resolveBwrap({ PI_BWRAP_EXECUTABLE: '/custom/bwrap' }, p => p === '/custom/bwrap'), '/custom/bwrap');
  assert.equal(resolveBwrap({ PATH: '/usr/local/bin:/usr/bin' }, p => p === '/usr/bin/bwrap'), '/usr/bin/bwrap');
  assert.equal(resolveBwrap({ PATH: '/usr/local/bin' }, () => false), '');

  const linuxHealth = sandboxHealth('linux', { PI_BWRAP_EXECUTABLE: '/nonexistent/bwrap' });
  assert.equal(linuxHealth.backend, 'bwrap');
  assert.equal(linuxHealth.ok, false);
  const winHealth = sandboxHealth('win32', {});
  assert.equal(winHealth.backend, 'unsupported');
  assert.equal(winHealth.ok, false);
});

test('buildBwrapArgs builds strict mode with usrmerge symlinks, owned binds, network isolation and state masking', () => {
  const deps = {
    ...fakeFs([
      '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc',
      '/home/dev/.fnm/v22', '/work/repo', '/work/repo/src', '/work/repo/state', '/work/tmp',
      '/home/dev/.pi',
    ], { '/bin': 'usr/bin', '/lib': 'usr/lib', '/lib64': 'usr/lib64' }),
    mode: 'strict',
    privateDirectories: ['/home/dev/.pi', '/home/dev/.ssh'],
    homedir: '/home/dev',
    tmpdir: '/tmp',
    execPath: '/home/dev/.fnm/v22/bin/node',
  };
  const policy = {
    cwd: '/work/repo',
    ownedPaths: ['src'],
    stateRoot: '/work/repo/state',
    tempDir: '/work/tmp',
    allowNetwork: false,
  };
  const args = buildBwrapArgs(policy, '/bin/bash', ['-c', 'echo ok'], deps);
  assert.ok(args.includes('--die-with-parent'));
  assert.ok(args.includes('--unshare-pid'));
  assert.ok(args.includes('--unshare-net'));
  assert.ok(args.join(' ').includes('--symlink usr/bin /bin'));
  assert.ok(args.join(' ').includes('--ro-bind /home/dev/.fnm/v22 /home/dev/.fnm/v22'));
  assert.ok(args.join(' ').includes('--ro-bind /work/repo /work/repo'));
  assert.ok(args.join(' ').includes('--bind /work/repo/src /work/repo/src'));
  assert.ok(args.join(' ').includes('--bind /work/tmp /work/tmp'));
  assert.ok(args.join(' ').includes('--perms 0000 --tmpfs /work/repo/state'));
  assert.deepEqual(args.slice(-5), ['--chdir', '/work/repo', '--', '/bin/bash', '-c', 'echo ok'].slice(-5));

  assert.throws(() => buildBwrapArgs({ ...policy, ownedPaths: ['../escape'] }, '/bin/bash', [], deps), /outside the workspace/);
});

test('buildBwrapArgs builds dev mode with worktree inside stateRoot and seals private credentials', () => {
  const stateRoot = '/work/.agents/runtime';
  const worktree = '/work/.agents/runtime/agent-1/worktree';
  const tempDir = '/work/.agents/runtime/agent-1/tmp';
  const deps = {
    ...fakeFs([
      '/tmp', stateRoot, worktree, tempDir,
      '/home/dev/.cache', '/home/dev/.pi', '/home/dev/.config/opencode',
    ]),
    mode: 'dev',
    privateDirectories: ['/home/dev/.pi', '/home/dev/.config/opencode', '/home/dev/.ssh'],
    homedir: '/home/dev',
    tmpdir: '/tmp',
  };
  const args = buildBwrapArgs({
    cwd: worktree,
    ownedPaths: ['.'],
    stateRoot,
    tempDir,
    allowNetwork: true,
  }, '/bin/bash', ['-c', 'git status'], deps);

  assert.ok(!args.includes('--unshare-net'));
  const joined = args.join(' ');
  assert.ok(joined.includes('--ro-bind / /'));
  assert.ok(joined.includes('--perms 0000 --tmpfs /home/dev/.pi'));
  assert.ok(joined.includes('--perms 0000 --tmpfs /home/dev/.config/opencode'));
  assert.ok(!joined.includes('/home/dev/.ssh'));
  const tmpfsIdx = joined.indexOf(`--tmpfs ${stateRoot}`);
  const worktreeIdx = joined.lastIndexOf(`--bind ${worktree} ${worktree}`);
  const remountIdx = joined.indexOf(`--remount-ro ${stateRoot}`);
  assert.ok(tmpfsIdx > 0 && worktreeIdx > tmpfsIdx && remountIdx > worktreeIdx);
});

test('buildBwrapArgs builds bypass mode preserving only stateRoot isolation', () => {
  const deps = {
    ...fakeFs(['/work/repo', '/work/state', '/work/tmp', '/home/dev/.pi']),
    mode: 'bypass',
    privateDirectories: ['/home/dev/.pi'],
    homedir: '/home/dev',
    tmpdir: '/tmp',
  };
  const args = buildBwrapArgs({
    cwd: '/work/repo',
    ownedPaths: ['.'],
    stateRoot: '/work/state',
    tempDir: '/work/tmp',
    allowNetwork: true,
  }, '/bin/bash', ['-c', 'true'], deps);

  const joined = args.join(' ');
  assert.ok(joined.includes('--bind / /'));
  assert.ok(joined.includes('--perms 0000 --tmpfs /work/state'));
  assert.ok(!joined.includes('/home/dev/.pi'));
});
