import { channel } from 'node:diagnostics_channel';

/** Connection metadata only. Never inspect URLs, headers, payloads or model text. */
export function observeTransport(origin, write, { now = Date.now } = {}) {
  const requests = new WeakMap();
  let sequence = 0;
  const subscriptions = [];
  const on = (name, handler) => {
    const source = channel(`undici:request:${name}`);
    source.subscribe(handler);
    subscriptions.push(() => source.unsubscribe(handler));
  };
  on('create', ({ request }) => {
    if (String(request.origin) !== origin) return;
    const record = { id: ++sequence, start: now() };
    requests.set(request, record);
    const data = { event: 'request_start', id: record.id, at: record.start };
    if (Number.isSafeInteger(request.bodyTimeout) && request.bodyTimeout >= 0) data.bodyTimeoutMs = request.bodyTimeout;
    write(data);
  });
  const event = (type, { request, response, error }) => {
    const record = requests.get(request);
    if (!record) return;
    const data = { event: type, id: record.id, at: now(), elapsedMs: now() - record.start };
    if (type === 'headers' && Number.isInteger(response?.statusCode)) data.status = response.statusCode;
    if (error) {
      data.codes = [];
      const seen = new Set();
      for (let current = error; current && !seen.has(current) && seen.size < 8; current = current.cause) {
        seen.add(current);
        const code = current.code;
        if (typeof code === 'string' && /^(UND_ERR_[A-Z_]+|ECONNRESET|ETIMEDOUT|EPIPE|ABORT_ERR)$/.test(code)) data.codes.push(code);
      }
    }
    write(data);
  };
  on('headers', data => event('headers', data));
  on('trailers', data => event('response_complete', data));
  on('error', data => event('request_error', data));
  return () => subscriptions.forEach(stop => stop());
}
