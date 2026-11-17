import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Read only the existing Pi credential store; renewal and command-based keys remain Pi's work. */
export async function readPiAuth(agentDir) {
  let directory = agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  if (directory === '~') directory = os.homedir();
  else if (directory.startsWith('~/')) directory = path.join(os.homedir(), directory.slice(2));
  try { return JSON.parse(await fs.readFile(path.join(directory, 'auth.json'), 'utf8')); }
  catch { throw new Error('Cannot read Pi auth.json; check the Pi agent directory and valid JSON.'); }
}

/** Fixed provider URLs, account-scoped GET only; errors omit server bodies and credential details. */
export function quotaRequest({ fetchImpl = fetch, signal } = {}) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  return async (url, headers, label) => {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: requestSignal, headers: { Accept: 'application/json', ...headers } }); }
    catch { throw new Error(`${label} quota request failed or timed out; no quota was inferred.`); }
    if (!response.ok) {
      if (response.status === 401) throw new Error(`${label} quota authentication failed (HTTP 401); renew the credentials through Pi.`);
      throw new Error(`${label} quota returned HTTP ${response.status}; no quota was inferred.`);
    }
    try {
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new Error('too large');
      return JSON.parse(body);
    } catch { throw new Error(`${label} quota returned invalid or oversized JSON.`); }
  };
}
