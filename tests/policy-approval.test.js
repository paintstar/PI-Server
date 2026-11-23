import test from 'node:test';import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';import { setup, processFactory, settled } from './helpers/setup.js';
test('policy changes require client approval when enabled by PI_SERVER_CONFIRM_POLICY=1 and preserve usage and authorization evidence', async t => {
 process.env.PI_SERVER_CONFIRM_POLICY='1';t.after(()=>{delete process.env.PI_SERVER_CONFIRM_POLICY;});
 const { cwd, manager: helper, track } = await setup(t);const { server, manager } = await createServer({ root: helper.storage.root+'-approval', processFactory });track(manager);
 const [ct,st] = InMemoryTransport.createLinkedPair();const client = new Client({name:'approval-test',version:'1'},{capabilities:{elicitation:{form:{}}}});let approve=false;
 client.setRequestHandler(ElicitRequestSchema, async request => { assert.match(request.params.message,/maxModelRequests/);return approve?{action:'accept',content:{approved:true}}:{action:'decline'}; });
 t.after(async()=>{await client.close();await server.close();});await server.connect(st);await client.connect(ct);
 const a=await client.callTool({name:'spawn_agent',arguments:{cwd,prompt:'done',provider:'fake',model:'cheap',ownedPaths:['src'],workspaceMode:'shared'}});const id=a.structuredContent.result.id;await settled(manager,id);
 const args={agentId:id,policy:{maxModelRequests:5},authorizationReference:'Explicit test approval'};
 const denied=await client.callTool({name:'update_agent_policy',arguments:args});assert.equal(denied.isError,true);assert.equal(manager.read(id).agent.policy.maxModelRequests,100000);
 const usage={...manager.read(id).agent.usage};approve=true;const allowed=await client.callTool({name:'update_agent_policy',arguments:args});assert.ok(!allowed.isError);assert.equal(manager.read(id).agent.policy.maxModelRequests,5);assert.deepEqual(manager.read(id).agent.usage,usage);assert.equal(manager.read(id).events.find(e=>e.type==='policy_changed').authorizationReference,args.authorizationReference);
 await assert.rejects(manager.setModel(id,{provider:'fake',model:'strong'}),/outside this agent policy/);
});
