import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {setup,spawn,settled} from './helpers/setup.js';import {reserveRequest} from '../src/agent-policy.js';
test('message receipts deduplicate instructions, reject conflicting content and acknowledge durably',async t=>{
 const {cwd,manager}=await setup(t);const agent=await spawn(manager,cwd);await settled(manager,agent.id);const id=randomUUID();await manager.send(agent.id,'one','steer',id);await settled(manager,agent.id);const twice=await manager.send(agent.id,'one','steer',id);assert.equal(twice.duplicate,true);assert.equal(twice.accepted,true);await assert.rejects(manager.send(agent.id,'two','steer',id),/different/);
 const transcript=await manager.get(agent.id).rpc.command('get_messages');assert.equal(transcript.messages.filter(v=>v.role==='user'&&v.content==='one').length,1);
 manager.messages.acknowledge(agent.id,[id]);assert.ok(manager.messages.all(agent.id).find(v=>v.messageId===id).acknowledgedAt);assert.ok(!manager.messages.read(agent.id,{unacknowledgedOnly:true}).messages.some(v=>v.messageId===id));
});
test('provider limit checks are preflight and wall time stops a hanging process',async t=>{
 const {cwd,manager}=await setup(t);const value=await spawn(manager,cwd,'HANG',{policy:{maxModelRequests:1,maxRuntimeMs:200}});const agent=manager.get(value.id);assert.equal(reserveRequest(agent,randomUUID(),manager.messages).allowed,true);assert.throws(()=>manager.reserveProviderRequest(value.id,randomUUID()),/request count/);const result=await settled(manager,value.id);assert.equal(result.status,'failed');assert.match(result.limitReason,/running time/);
 await manager.updatePolicy(value.id,{maxModelRequests:5},'test human instruction');assert.equal(manager.read(value.id).agent.status,'idle');
});
test('reserveRequest excludes cacheRead from maxTotalTokens and stopped process clears runtimeTimer',async t=>{
 const {cwd,manager}=await setup(t);const value=await spawn(manager,cwd,'ok',{policy:{maxTotalTokens:1500000,maxRuntimeMs:120}});await settled(manager,value.id);
 const agent=manager.get(value.id);agent.record.usage={input:114000,output:20000,cacheRead:2000000,cacheWrite:0,reportedCost:0};agent.record.runStartedAt=Date.now();
 const ok=reserveRequest(agent,randomUUID(),manager.messages);assert.equal(ok.allowed,true);assert.equal(ok.warning,undefined);
 agent.record.usage.input=1200000;const warned=reserveRequest(agent,randomUUID(),manager.messages);assert.match(warned.warning,/80%/);
 agent.record.usage.cacheWrite=300000;assert.throws(()=>manager.reserveProviderRequest(value.id,randomUUID()),/Observed token limit reached/);
 await manager.closeAgent(value.id);
 const crashing=await spawn(manager,cwd,'HANG',{policy:{maxTotalTokens:1000,maxRuntimeMs:120}});const live=manager.get(crashing.id);
 live.record.usage.input=1000;assert.throws(()=>manager.reserveProviderRequest(crashing.id,randomUUID()),/Observed token limit reached/);
 live.rpc.child.kill('SIGKILL');await new Promise(r=>setTimeout(r,200));
 const final=manager.read(crashing.id).agent;assert.equal(final.limitReason,'Observed token limit reached');assert.equal(final.error,'Observed token limit reached');
});
