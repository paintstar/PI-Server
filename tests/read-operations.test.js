import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxedReadOperations } from '../src/read-operations.js';

test('restricted read detects binary images and preserves bytes without expanding access', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-image-read-'));
  t.after(() => fs.rmSync(cwd, { recursive:true, force:true }));
  for (const dir of ['state','tmp']) fs.mkdirSync(path.join(cwd, dir));
  const bytes = Buffer.from([255,216,255,224,0,0,128,255]);
  fs.writeFileSync(path.join(cwd,'photo.bin'), bytes);
  fs.writeFileSync(path.join(cwd,'text.jpg'), 'ordinary text');
  fs.writeFileSync(path.join(cwd,'bm.txt'), 'BM is a plain text heading followed by ordinary prose');
  fs.writeFileSync(path.join(cwd,'state','private'), bytes);
  fs.symlinkSync(path.join(cwd,'state','private'), path.join(cwd,'private.jpg'));
  const ops = sandboxedReadOperations({cwd, ownedPaths:['.'], tempDir:path.join(cwd,'tmp'), stateRoot:path.join(cwd,'state'), allowNetwork:false, sandboxMode:'strict'});
  assert.equal(await ops.detectImageMimeType(path.join(cwd,'photo.bin')), 'image/jpeg');
  assert.deepEqual(await ops.readFile(path.join(cwd,'photo.bin')), bytes);
  assert.equal(await ops.detectImageMimeType(path.join(cwd,'text.jpg')), undefined);
  assert.equal(await ops.detectImageMimeType(path.join(cwd,'bm.txt')), undefined);
  assert.match(String(await ops.readFile(path.join(cwd,'bm.txt'))), /^BM is a plain text/);
  await assert.rejects(ops.detectImageMimeType(path.join(cwd,'state','private')), /controller state/);
  await assert.rejects(ops.detectImageMimeType(path.join(cwd,'private.jpg')), /controller state/);
});
