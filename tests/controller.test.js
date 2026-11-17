import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {connectController} from '../src/controller-client.js';import {fakePi} from './helpers/setup.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('independent controller survives detach, preserves questions and isolates parents with idempotent dispatch',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-controller-test-'));const root=cwd+'/state';const executable=cwd+'/fake-pi';fs.writeFileSync(executable,`#!/bin/sh\nexec '${process.execPath}' '${fakePi}' "$@"\n`,{mode:0o700});
 const first=await connectController({root,executable});const clients=[first];
 t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});for(const pid of new Set(clients.map(c=>c.info.pid)))try{process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e};for(let i=0;i<50&&fs.existsSync(root+'/controller.lock');i++)await pause(50);fs.rmSync(cwd,{recursive:true,force:true});});
 const values={cwd,prompt:'ASK',provider:'fake',model:'cheap',ownedPaths:['src'],workspaceMode:'shared',requestId:randomUUID()};const a=await first.spawn(values);const duplicate=await first.spawn(values);assert.equal(duplicate.id,a.id);assert.equal(duplicate.duplicate,true);
 let state;for(let i=0;i<50;i++){state=await first.read(a.id);if(state.agent.status==='waiting')break;await pause(20)}assert.equal(state.agent.status,'waiting');const q=state.agent.questionIds[0];
 const second=await connectController({root,executable});clients.push(second);await assert.rejects(second.send(a.id,'bad'),/another parent/);await assert.rejects(second.resume(a.id),/attached parent/);
 await first.close();assert.equal((await second.resume(a.id)).reattached,true);assert.deepEqual((await second.read(a.id)).agent.questionIds,[q]);await second.reply(q,'41');
 for(let i=0;i<50;i++){state=await second.read(a.id);if(state.agent.status==='completed')break;await pause(20)}assert.equal(state.agent.status,'completed');assert.equal(state.agent.lastText,'ANSWER:41');assert.equal((await second.reply(q,'41')).duplicate,true);
 const id=randomUUID();await second.send(a.id,'one','steer',id);assert.equal((await second.send(a.id,'one','steer',id)).duplicate,true);await second.close();const third=await connectController({root,executable});clients.push(third);await third.resume(a.id);await pause(80);assert.equal((await third.read(a.id)).agent.lastText,'one');assert.equal((await third.call('readMessages',{agentId:a.id})).messages.filter(v=>v.messageId===id).length,1);
 await third.close();process.kill(third.info.pid,'SIGTERM');for(let i=0;i<50&&fs.existsSync(root+'/controller.lock');i++)await pause(50);
 const fourth=await connectController({root,executable});clients.push(fourth);assert.notEqual(fourth.info.pid,third.info.pid);assert.equal((await fourth.resume(a.id)).status,'idle');assert.equal((await fourth.read(a.id)).agent.lastText,'one');assert.equal((await fourth.call('readMessages',{agentId:a.id})).messages.filter(v=>v.messageId===id).length,1);
});

test('bridge reports which parent session it belongs to, from the client environment', async () => {
  const { parentIdentity } = await import('../src/controller-client.js');
  assert.deepEqual(parentIdentity({ CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' }), { kind: 'claude', sessionId: 'abc', hostSessionId: 'local_abc', cwd: process.cwd() });
  assert.equal(parentIdentity({ CODEX_THREAD_ID: 'thread-1', CLAUDE_CODE_SESSION_ID: 'abc' }).kind, 'codex');
  assert.equal(parentIdentity({}).kind, 'unknown');
});

test('controller watch long-polls quietly when idle and wakes immediately when a new agent spawns', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-controller-wake-'));
  const root = cwd + '/state';
  const executable = cwd + '/fake-pi';
  fs.writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fakePi}' "$@"\n`, { mode: 0o700 });
  const client = await connectController({ root, executable });
  const seen = [];
  client.on('event', ev => seen.push(ev));
  client.watch();
  t.after(async () => {
    await client.close().catch(() => {});
    try { process.kill(client.info.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 40 && fs.existsSync(root + '/controller.lock'); i++) await pause(30);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await pause(120);
  const t0 = Date.now();
  const spawned = await client.spawn({ cwd, prompt: 'OK', provider: 'fake', model: 'cheap', ownedPaths: ['src'], workspaceMode: 'shared' });
  for (let i = 0; i < 50 && !seen.some(ev => ev.agentId === spawned.id && ev.type === 'settled'); i++) {
    await pause(20);
  }
  assert.ok(Date.now() - t0 < 2000, 'watch woke immediately without waiting for 20s poll timeout');
  assert.ok(seen.some(ev => ev.agentId === spawned.id && ev.type === 'settled'));
});
