import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const project=fileURLToPath(new URL('..',import.meta.url));
const evidence=path.join(project,'.agents/records','communication-'+Date.now());fs.mkdirSync(evidence,{recursive:true,mode:0o700});const root=evidence+'/state';const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-communication-live-'));
let client;const agents=[];const result={startedAt:new Date().toISOString(),checks:[]};
async function connect(){client=new Client({name:'communication-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[project+'/src/server.js'],env:{...process.env,PI_SERVER_STATE_DIR:root},stderr:'pipe'}));}
async function call(name,args={}){const r=await client.callTool({name,arguments:args},undefined,{timeout:55000});if(r.isError)throw new Error(r.content[0].text);return r.structuredContent.result;}
async function until(id,predicate){const end=Date.now()+90000;while(Date.now()<end){const r=await call('read_agent',{agentId:id});if(predicate(r))return r;if(r.agent.status==='failed')throw new Error(r.agent.error);await call('wait_agent',{agentIds:[id],after:{[id]:r.nextSequence},timeoutMs:10000});}throw new Error('Acceptance timed out');}
function checked(name){result.checks.push(name);console.log(name);}
try{
 await connect();assert.equal((await client.listTools()).tools.length,24);result.capabilities=await call('get_client_capabilities');checked('24 tools and capability report over real stdio');
 const a=await call('spawn_agent',{cwd,provider:'opencode-go',model:'deepseek-v4.1-flash',thinking:'off',ownedPaths:['demo'],workspaceMode:'shared',policy:{maxModelRequests:8,maxRuntimeMs:90000,maxOutputTokens:2048},prompt:'这是用户授权的隔离验证。首先必须调用 ask_parent 问数字是什么。收到答复后，调用 write 创建 demo/value.txt 内容为答复的数字；再调用 bash 执行 cat demo/value.txt 验证。使用 agent_message 向 parent 报告结果。最后回复 VERIFIED。仅修改 demo。'});agents.push(a.id);
 const waiting=await until(a.id,r=>r.agent.status==='waiting');const questionId=waiting.agent.questionIds[0];assert.ok(questionId);checked('Real Pi asked a blocking question');
 await client.close();await connect();const resumed=await call('resume_agent',{agentId:a.id});assert.equal(resumed.reattached,true);assert.deepEqual(resumed.questionIds,[questionId]);await call('reply_question',{questionId,message:'数字明确为 41。'});const done=await until(a.id,r=>r.agent.status==='completed');assert.match(done.agent.lastText,/VERIFIED/);assert.equal(fs.readFileSync(cwd+'/demo/value.txt','utf8').trim(),'41');assert.ok(done.events.some(e=>e.type==='message'));assert.ok(done.agent.modelRequests>0);const receipts=await call('read_messages',{agentId:a.id});assert.ok(receipts.messages.some(v=>v.state==='consumed'));checked('Detach/reconnect preserves the same question; real sandboxed write/bash and report succeeded');
 await call('close_agent',{agentId:a.id});
 const b=await call('spawn_agent',{cwd,provider:'opencode-go',model:'deepseek-v4.1-flash',thinking:'off',ownedPaths:['limit'],workspaceMode:'shared',policy:{maxModelRequests:1,maxRuntimeMs:45000,maxOutputTokens:1024},prompt:'这是次数限制验证。必须首先用 read 读取 demo/value.txt，然后再回复读到的值。'});agents.push(b.id);
 const stopped=await until(b.id,r=>r.agent.status==='failed');assert.equal(stopped.agent.modelRequests,1);assert.match(stopped.agent.limitReason,/request count/);checked('Real Pi second provider request was denied and process stopped');result.completed=true;
}catch(error){result.error=error.message;console.error(error.message);process.exitCode=1;}
finally{
 for(const id of agents)try{await call('close_agent',{agentId:id});}catch(error){(result.cleanupErrors??=[]).push(error.message)}
 await client?.close();const info=root+'/controller.json';if(fs.existsSync(info)){process.kill(JSON.parse(fs.readFileSync(info,'utf8')).pid,'SIGTERM');for(let i=0;i<50&&fs.existsSync(root+'/controller.lock');i++)await new Promise(r=>setTimeout(r,50));}
 result.finishedAt=new Date().toISOString();fs.writeFileSync(evidence+'/result.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});fs.rmSync(cwd,{recursive:true,force:true});console.log('Evidence: '+evidence);
}
