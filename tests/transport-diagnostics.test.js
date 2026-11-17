import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import http from 'node:http';
import { observeTransport } from '../src/transport-diagnostics.js';

test('records safe status/timing/cause codes, ignores other origins and private content', () => {
  const rows = []; let clock = 100;
  const stop = observeTransport('https://example.invalid', value => rows.push(value), { now: () => clock });
  const request = { origin: 'https://example.invalid', bodyTimeout: 300000, headers: 'secret-header', body: 'secret-payload', path: '/secret' };
  const publish = (name, data) => channel(`undici:request:${name}`).publish(data);
  publish('create', { request });
  publish('create', { request: { origin: 'http://localhost:1' } });
  clock = 400;
  publish('headers', { request, response: { statusCode: 200, headers: 'secret-response' } });
  const error = new Error('secret-error'); error.cause = { code: 'UND_ERR_BODY_TIMEOUT' }; error.cause.cause = error;
  publish('error', { request, error });
  publish('trailers', { request });
  stop(); publish('create', { request });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2].codes, ['UND_ERR_BODY_TIMEOUT']);
  assert.equal(rows[1].elapsedMs, 300);
  assert.equal(rows[1].status, 200);
  assert.equal(rows[0].bodyTimeoutMs, 300000);
  assert.ok(!JSON.stringify(rows).includes('secret'));
});

test('observes actual fetch stream socket failure without recording request content', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('private-stream');
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rows = []; const stop = observeTransport(origin, row => rows.push(row));
  try {
    const response = await fetch(origin + '/private-url');
    await assert.rejects(response.text());
    assert.ok(rows.some(row => row.event === 'headers' && row.status === 200));
    assert.ok(rows.some(row => row.event === 'request_error' && row.codes.includes('UND_ERR_SOCKET')));
    assert.ok(!JSON.stringify(rows).includes('private'));
  } finally {
    stop(); await new Promise(resolve => server.close(resolve));
  }
});
