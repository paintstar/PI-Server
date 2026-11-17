import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { providerFetch } from '../src/provider-fetch.js';

test('invalid URLs reject asynchronously like native fetch', async () => {
  const scoped = providerFetch('https://target.invalid');
  try {
    let promise;
    assert.doesNotThrow(() => { promise = scoped.fetch('not a URL'); });
    await assert.rejects(promise, TypeError);
  } finally { await scoped.close(); }
});

test('stream idle override is effective with Node fetch, and abort is retained', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.write('a');
    // Undici's timer wheel has coarse scheduling; exceed one tick in the failure case.
    setTimeout(() => res.end('b'), 1200);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const short = providerFetch(origin, { bodyTimeout: 20 });
  const fixed = providerFetch(origin, { bodyTimeout: 4000 });
  try {
    const broken = await short.fetch(origin);
    await assert.rejects(broken.text(), error => error.cause?.code === 'UND_ERR_BODY_TIMEOUT');
    assert.equal(await (await fixed.fetch(origin)).text(), 'ab');
    await assert.rejects(async () => {
      const response = await fixed.fetch(origin, { signal: AbortSignal.timeout(20) });
      await response.text();
    });
  } finally {
    await Promise.all([short.close(), fixed.close()]);
    await new Promise(resolve => server.close(resolve));
  }
});

test('unrelated origins and all request fields are preserved; explicit dispatchers remain in use', async () => {
  const seen = []; let dispatched;
  const custom = { dispatch: (request, handler) => { dispatched = { request, handler }; return true; } };
  const scoped = providerFetch('https://target.invalid', { fetch: (input, options) => { seen.push([input, options]); return options; } });
  try {
    const options = { method: 'POST', body: 'original', headers: { x: 'original' }, signal: new AbortController().signal, dispatcher: custom };
    assert.equal(await scoped.fetch('https://other.invalid', options), options);
    const result = await scoped.fetch('https://target.invalid/api', options);
    for (const field of ['method', 'body', 'headers', 'signal']) assert.equal(result[field], options[field]);
    const handler = {}; result.dispatcher.dispatch({ bodyTimeout: 300000, path: '/api' }, handler);
    assert.deepEqual(dispatched, { request: { bodyTimeout: 600000, path: '/api' }, handler });
    assert.equal(seen.length, 2);
  } finally { await scoped.close(); }
});
