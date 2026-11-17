import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual extension hook without loading Pi or making provider calls.
function hook(fetch) {
  const source = fs.readFileSync(new URL('../extensions/policy.ts', import.meta.url), 'utf8');
  const javascript = stripTypeScriptTypes(source)
    .replace(/^import .*;\n/gm, '')
    .replace('export default function', 'function initialize');
  const hooks = new Map(), messages = [], exits = [];
  const context = {
    fs: { readFileSync: () => JSON.stringify({ cwd: '/unused' }) },
    process: { env: {}, exit: code => { exits.push(code); throw new Error(`exit ${code}`); } },
    fetch, AbortSignal, randomUUID: () => 'isolated-request',
    createReadToolDefinition: () => ({}), createWriteToolDefinition: () => ({}),
    createEditToolDefinition: () => ({}), createBashToolDefinition: () => ({}),
    sandboxedReadOperations: () => ({}),
    pi: {
      registerTool() {}, on: (name, callback) => hooks.set(name, callback),
      // Installed ExtensionAPI returns void, not a Promise.
      sendUserMessage(content, options) { messages.push({ content, options }); },
    },
  };
  vm.runInNewContext(`${javascript}\ninitialize(pi);`, context);
  return { run: hooks.get('before_provider_request'), messages, exits };
}

const model = { model: { provider: 'zai', api: 'openai-completions' } };

test('budget warning with void sendUserMessage preserves approved request and output cap', async () => {
  const h = hook(async () => ({ ok: true, json: async () => ({ warning: '80% used', maxOutputTokens: 4096 }) }));
  const payload = { max_tokens: 8192 };
  assert.equal(await h.run({ payload }, model), payload);
  assert.equal(payload.max_tokens, 4096);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].content, '80% used');
  assert.equal(h.messages[0].options.deliverAs, 'steer');
  assert.deepEqual(h.exits, []);
});

test('request denial still stops before provider dispatch', async () => {
  const h = hook(async () => ({ ok: false }));
  await assert.rejects(h.run({ payload: {} }, model), /exit 77/);
  assert.ok(h.exits.every(code => code === 77));
  assert.equal(h.messages.length, 0);
});

test('controller failure still stops before provider dispatch', async () => {
  const h = hook(async () => { throw new Error('controller unavailable'); });
  await assert.rejects(h.run({ payload: {} }, model), /exit 77/);
  assert.deepEqual(h.exits, [77]);
  assert.equal(h.messages.length, 0);
});
