import fs from 'node:fs';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  connection: 'keep-alive',
};

export function writeSse(response, payload, cleanup) {
  if (response.writableEnded || response.destroyed) { cleanup(); return false; }
  try { response.write(payload); return true; }
  catch (error) { cleanup(); console.error(error?.message || String(error)); return false; }
}

export function streamSpeed(file, request, response, cleanups) {
  response.writeHead(200, SSE_HEADERS);
  let last = 0; let closed = false; let timer = null; let ping = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
    cleanups.delete(cleanup);
  };
  writeSse(response, ': ok\n\n', cleanup);
  const push = () => {
    if (closed) return;
    try {
      const changed = fs.statSync(file).mtimeMs;
      if (changed === last) return;
      last = changed;
      writeSse(response, `data: ${fs.readFileSync(file, 'utf8')}\n\n`, cleanup);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      cleanup();
      if (!response.writableEnded) response.end();
      console.error(error?.message || String(error));
    }
  };
  push();
  if (closed) return;
  timer = setInterval(push, 100);
  ping = setInterval(() => { if (!closed) writeSse(response, ': ping\n\n', cleanup); }, 15000);
  cleanups.add(cleanup);
  request.on('close', cleanup);
  response.on('close', cleanup);
}

export function createEventsBroadcaster(root, data) {
  const clients = new Set();
  let watcher = null; let debounceTimer = null; let fallbackTimer = null; let pingTimer = null;
  let lastDigest = null; let lastFrame = null;

  const stopWatching = () => {
    clearTimeout(debounceTimer); debounceTimer = null;
    clearInterval(fallbackTimer); fallbackTimer = null;
    clearInterval(pingTimer); pingTimer = null;
    if (watcher) {
      try { watcher.close(); } catch (err) { if (err?.code !== 'ENOENT') console.error(err?.message || String(err)); }
      watcher = null;
    }
  };

  const computeSnapshot = () => {
    const payload = data.list();
    const digest = JSON.stringify({ agents: payload.agents, errors: payload.errors, groupNames: payload.groupNames });
    if (digest !== lastDigest || !lastFrame) {
      lastDigest = digest;
      lastFrame = `data: ${JSON.stringify(payload)}\n\n`;
    }
    return { digest: lastDigest, frame: lastFrame };
  };

  const broadcast = () => {
    if (!clients.size) return;
    let snapshot;
    try { snapshot = computeSnapshot(); }
    catch (error) { console.error(error?.message || String(error)); return; }
    for (const client of [...clients]) {
      if (client.lastDigest === snapshot.digest) continue;
      if (writeSse(client.response, snapshot.frame, client.cleanup)) client.lastDigest = snapshot.digest;
    }
  };

  const onWatch = (_eventType, filename) => {
    const name = filename ? String(filename) : '';
    if (name && (/(^|[/\\])(live|speed)\.json(\..*\.tmp)?$/.test(name) || /\.tmp$/.test(name))) return;
    if (!clients.size || debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; broadcast(); }, 50);
  };

  const attachWatcher = () => {
    if (watcher || !clients.size || !fs.existsSync(root)) return;
    try { watcher = fs.watch(root, { recursive: true }, onWatch); }
    catch (error) {
      if (error?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        try { watcher = fs.watch(root, onWatch); } catch (fallbackError) { if (fallbackError?.code !== 'ENOENT') throw fallbackError; }
      } else if (error?.code !== 'ENOENT') throw error;
    }
    watcher?.on('error', error => {
      if (error?.code !== 'ENOENT') console.error(error?.message || String(error));
      try { watcher?.close(); } catch {}
      watcher = null;
    });
  };

  const ensureRunning = () => {
    attachWatcher();
    if (!fallbackTimer) { fallbackTimer = setInterval(() => { attachWatcher(); broadcast(); }, 1000); fallbackTimer.unref?.(); }
    if (!pingTimer) {
      pingTimer = setInterval(() => {
        for (const client of [...clients]) writeSse(client.response, ': ping\n\n', client.cleanup);
      }, 15000);
      pingTimer.unref?.();
    }
  };

  const subscribe = (request, response) => {
    response.writeHead(200, SSE_HEADERS);
    const client = { response, lastDigest: null, closed: false, cleanup: null };
    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      clients.delete(client);
      if (!clients.size) stopWatching();
    };
    client.cleanup = cleanup;
    clients.add(client);
    request.on('close', cleanup);
    response.on('close', cleanup);
    try {
      const snapshot = computeSnapshot();
      if (writeSse(response, snapshot.frame, cleanup)) client.lastDigest = snapshot.digest;
    } catch (error) {
      cleanup();
      if (!response.writableEnded) response.end();
      console.error(error?.message || String(error));
      return;
    }
    if (!client.closed) ensureRunning();
  };

  const closeAll = () => {
    for (const client of [...clients]) {
      client.cleanup();
      if (!client.response.writableEnded) client.response.end();
    }
    stopWatching();
  };

  return { subscribe, closeAll };
}
