import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';import {Storage} from '../src/storage.js';
test('durable event pagination exceeds the memory tail and recovery removes an incomplete final record',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-events-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const storage=new Storage(root);const id=randomUUID();storage.save({id});for(let sequence=1;sequence<=650;sequence++)storage.append(id,{sequence,text:'中文事件'});
 let cursor=0;const events=[];while(cursor<650){const page=storage.events(id,cursor,31);events.push(...page);cursor=page.at(-1).sequence}assert.equal(events.length,650);assert.equal(new Set(events.map(v=>v.sequence)).size,650);assert.equal(storage.events(id).length,500);
 fs.appendFileSync(path.join(storage.directory(id),'events.jsonl'),'{"sequence":651');storage.repairEvents(id);storage.append(id,{sequence:651,text:'recovered'});assert.equal(storage.events(id,650)[0].text,'recovered');
});
