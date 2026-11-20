import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isWsl(release = os.release(), env = process.env) {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release || ''));
}

export function resolveBwrap(env = process.env, exists = fs.existsSync) {
  const explicit = env.PI_BWRAP_EXECUTABLE?.trim();
  if (explicit) return exists(explicit) ? explicit : '';
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (exists(candidate)) return candidate;
  }
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'bwrap');
    if (exists(candidate)) return candidate;
  }
  return '';
}

function inside(target, directory) {
  return target === directory || target.startsWith(directory + path.sep);
}

function uniqueExisting(paths, exists) {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    if (!item || seen.has(item) || !exists(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function addSystemEntry(flags, target, { exists, lstat, readlink }) {
  if (!exists(target)) return;
  try {
    const stat = lstat(target);
    if (stat.isSymbolicLink()) {
      flags.push('--symlink', readlink(target), target);
      return;
    }
  } catch {
    return;
  }
  flags.push('--ro-bind', target, target);
}

function maskDir(flags, dir, exists) {
  if (!dir || !exists(dir)) return;
  flags.push('--perms', '0000', '--tmpfs', dir);
}

function maskStateRoot(flags, { stateRoot, workspace, tempDir, exists }) {
  if (!stateRoot || !exists(stateRoot)) return;
  const workspaceInside = inside(workspace, stateRoot);
  const tempInside = inside(tempDir, stateRoot);
  if (workspaceInside || tempInside) {
    flags.push('--tmpfs', stateRoot);
    if (workspaceInside && exists(workspace)) flags.push('--bind', workspace, workspace);
    if (tempInside && exists(tempDir)) flags.push('--bind', tempDir, tempDir);
    flags.push('--remount-ro', stateRoot);
    return;
  }
  maskDir(flags, stateRoot, exists);
}

export function buildBwrapArgs(policy, executable, args, deps = {}) {
  const exists = deps.existsSync || fs.existsSync;
  const lstat = deps.lstatSync || fs.lstatSync;
  const readlink = deps.readlinkSync || fs.readlinkSync;
  const realpath = deps.realpathSync || fs.realpathSync;
  const canonical = deps.canonicalPath;
  const mode = deps.mode;
  const privateDirectories = deps.privateDirectories || [];
  const gitCommon = deps.gitCommonDir || null;
  const home = deps.homedir || os.homedir();
  const tmpRoot = deps.tmpdir || os.tmpdir();
  const nodeExec = deps.execPath || process.execPath;

  const workspace = canonical(policy.cwd);
  const stateRoot = canonical(policy.stateRoot);
  const tempDir = canonical(policy.tempDir);
  const owned = (policy.ownedPaths || []).map(value => canonical(path.resolve(policy.cwd, value)));
  if (mode === 'strict' && owned.some(value => !inside(value, workspace))) {
    throw new Error('Owned path resolves outside the workspace');
  }

  const flags = ['--die-with-parent', '--new-session', '--unshare-pid'];
  if (!policy.allowNetwork) flags.push('--unshare-net');

  if (mode === 'strict') {
    flags.push('--proc', '/proc', '--dev', '/dev');
    if (exists('/usr')) flags.push('--ro-bind', '/usr', '/usr');
    for (const dir of ['/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
      addSystemEntry(flags, dir, { exists, lstat, readlink });
    }
    if (exists('/etc')) flags.push('--ro-bind', '/etc', '/etc');

    const nodePrefixes = [path.dirname(path.dirname(nodeExec))];
    try { nodePrefixes.push(path.dirname(path.dirname(realpath(nodeExec)))); } catch {}
    for (const prefix of uniqueExisting(nodePrefixes, exists)) {
      if (!inside(prefix, '/usr') && prefix !== '/') flags.push('--ro-bind', prefix, prefix);
    }

    const wholeWorkspaceOwned = owned.some(value => value === workspace);
    flags.push(wholeWorkspaceOwned ? '--bind' : '--ro-bind', workspace, workspace);
    if (!wholeWorkspaceOwned) {
      for (const item of uniqueExisting(owned, exists)) {
        if (item !== workspace) flags.push('--bind', item, item);
      }
    }
    if (exists(tempDir)) flags.push('--bind', tempDir, tempDir);
    if (inside(stateRoot, workspace)) {
      maskStateRoot(flags, { stateRoot, workspace, tempDir, exists });
    }
    for (const dir of uniqueExisting(privateDirectories, exists)) {
      if (inside(dir, workspace)) maskDir(flags, dir, exists);
    }
  } else if (mode === 'dev') {
    flags.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc');
    const writable = uniqueExisting([
      tmpRoot,
      '/tmp',
      gitCommon,
      path.join(home, '.cache'),
      path.join(home, '.local/share/uv'),
      path.join(home, '.npm'),
      workspace,
      tempDir,
    ], exists);
    for (const dir of writable) flags.push('--bind', dir, dir);
    for (const dir of uniqueExisting(privateDirectories, exists)) maskDir(flags, dir, exists);
    maskStateRoot(flags, { stateRoot, workspace, tempDir, exists });
  } else {
    flags.push('--bind', '/', '/', '--dev', '/dev', '--proc', '/proc');
    maskStateRoot(flags, { stateRoot, workspace, tempDir, exists });
  }

  flags.push('--chdir', workspace, '--', executable, ...args);
  return flags;
}
