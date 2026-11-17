import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { SpeedMeter, deltaText } from '../src/speed-meter.js';
test('speed meter counts streamed deltas in real time and keeps the exact final count', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'speed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=1000;const meter=new SpeedMeter(path.join(dir,'speed.json'),{now:()=>now,interval:5});
  meter.start();meter.event({type:'response.output_item.added',item:{type:'reasoning'}});assert.equal(meter.snapshot().request.phase,'thinking');
  now=3000;for(let i=0;i<50;i++){now+=10;meter.event({type:'response.output_text.delta',delta:'词'});}
  const live=meter.snapshot();assert.equal(live.request.phase,'output');assert.equal(live.request.tokens,50);assert.ok(live.rate>40,String(live.rate));
  now+=500;meter.finish({output:60,reasoning:200});const done=JSON.parse(fs.readFileSync(path.join(dir,'speed.json'),'utf8'));
  assert.equal(done.request,null);assert.equal(done.history[0].output,60);assert.equal(done.history[0].waitSeconds,2);assert.ok(done.history[0].streamTps>0);
  assert.equal(deltaText({choices:[{delta:{content:'a'}}]}),'a');assert.equal(deltaText({type:'content_block_delta',delta:{text:'b'}}),'b');assert.equal(deltaText({type:'response.created'}),null);
  meter.close();
});
