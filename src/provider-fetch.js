import { Agent } from 'undici';

/** Override only the selected origin's stream-idle timeout; retain SDK abort signals. */
export function providerFetch(origin, { bodyTimeout = 600000, fetch: baseFetch = globalThis.fetch } = {}) {
  const agent = new Agent();
  const fetch = async (input, options) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (new URL(url).origin !== origin) return baseFetch(input, options);
    const original = options?.dispatcher || agent;
    // Node fetch supplies its own 300s value, overriding Agent defaults. Override at dispatch.
    const dispatcher = { dispatch: (request, handler) => original.dispatch({ ...request, bodyTimeout }, handler) };
    return baseFetch(input, { ...options, dispatcher });
  };
  return { fetch, close: () => agent.close() };
}
