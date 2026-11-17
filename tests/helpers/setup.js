import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Manager } from '../../src/manager.js';
import { PiProcess } from '../../src/rpc-client.js';
export const fakePi = fileURLToPath(new URL('./fake-pi.js', import.meta.url));
export const processFactory = options => new PiProcess({ ...options, executable: process.execPath, args: [fakePi, ...options.args] });
processFactory.testOnly = true;
export async function setup(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-test-'));
  const manager = await new Manager({ root: path.join(cwd, 'state'), processFactory, ...options }).start();
  const managers = [manager];
  t.after(async () => { for (const value of managers) await value.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, manager, track: value => managers.push(value) };
}
export function spawn(manager, cwd, prompt = 'done', extra = {}) {
  return manager.spawn({ cwd, prompt, provider: 'fake', model: 'cheap', ownedPaths: ['src'], policy: { allowedModels: [{ provider: 'fake', model: 'cheap' }, { provider: 'fake', model: 'strong' }] }, workspaceMode: 'shared', ...extra });
}
export async function settled(manager, id, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = manager.read(id);
    if (['completed', 'failed', 'interrupted', 'closed'].includes(state.agent.status)) return state.agent;
    await manager.wait([id], { [id]: state.nextSequence }, 100);
  }
  throw new Error('Test agent did not settle');
}
