export const $ = selector => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';

export const labels = {
  starting: '正在启动',
  running: '运行中',
  waiting: '等待答复',
  finishing: '正在结束',
  idle: '空闲',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
  closed: '已关闭',
  disconnected: '控制进程离线',
};

export const order = ['running', 'starting', 'finishing', 'waiting', 'idle', 'completed', 'interrupted', 'stopped', 'failed', 'disconnected', 'closed'];
export const colors = {
  running: '--run',
  starting: '--run',
  finishing: '--run',
  waiting: '--wait',
  idle: '--idle',
  completed: '--done',
  interrupted: '--idle',
  stopped: '--idle',
  failed: '--fail',
  disconnected: '--off',
  closed: '--closed',
};

export const working = new Set(['starting', 'running', 'waiting', 'finishing']);
export const busyStatuses = new Set(['starting', 'running', 'finishing']);
export const attention = new Set(['waiting', 'failed', 'disconnected']);

export const filters = [
  { key: 'all', title: '全部', match: (_, a) => !a?.archived },
  { key: 'working', title: '工作中', match: (s, a) => !a?.archived && working.has(s) },
  { key: 'waiting', title: '待答复', match: (s, a) => !a?.archived && s === 'waiting', secondary: true },
  { key: 'completed', title: '已完成', match: (s, a) => !a?.archived && s === 'completed' },
  { key: 'problem', title: '异常', match: (s, a) => !a?.archived && (s === 'failed' || s === 'disconnected'), secondary: true },
  { key: 'closed', title: '已关闭', match: (s, a) => !a?.archived && s === 'closed', secondary: true },
  { key: 'archived', title: '已归档', match: (_, a) => Boolean(a?.archived), secondary: true },
];

export const eventTypes = {
  ready: '准备就绪',
  started: '开始执行',
  instruction: '收到任务',
  message_consumed: '消息已读入',
  question: '向父代理提问',
  answer: '父代理答复',
  message: '向父代理报告',
  tool_execution_start: '开始工具',
  tool_execution_end: '工具结束',
  settled: '本次执行结束',
  model_changed: '模型已更换',
  model_restored: '原模型已恢复',
  resumed: '会话已恢复',
  interrupted: '执行已中断',
  closed: '会话已关闭',
  process_failed: '进程失败',
  control_failed: '控制命令失败',
  extension_error: '扩展失败',
  question_cancelled: '问题已取消',
  instruction_failed: '任务发送失败',
  policy_changed: '策略已更新',
  budget_limit: '达到用量上限',
};

export const commTypes = new Set(['instruction', 'message', 'question', 'answer', 'question_cancelled']);
export const badTypes = new Set(['process_failed', 'control_failed', 'extension_error', 'instruction_failed', 'interrupted', 'budget_limit']);
export const lifeTypes = new Set(['ready', 'started', 'settled', 'resumed', 'interrupted', 'closed', 'model_changed', 'model_restored', 'process_failed', 'control_failed', 'extension_error', 'instruction_failed', 'budget_limit']);
export const notifyOn = { waiting: '在等待答复', failed: '执行失败', completed: '已完成', disconnected: '控制进程离线' };
export const kindNames = { antigravity: 'AGY', claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`pi-dash:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`pi-dash:${key}`, JSON.stringify(value)); }
    catch {}
  },
};

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'checked') { node.checked = true; node.setAttribute('checked', ''); }
    else if (key === 'value' && ('value' in node)) { node.value = String(value); node.setAttribute('value', String(value)); }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function mount(parent, ...children) {
  parent.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false).map(c => c instanceof Node ? c : document.createTextNode(String(c))));
}

export function morph(parent, next) {
  const old = [...parent.childNodes];
  next.forEach((node, i) => old[i] ? patchNode(old[i], node) : parent.append(node));
  for (const node of old.slice(next.length)) node.remove();
}

function patchNode(old, next) {
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName || old.nodeName === 'BUTTON') {
    old.replaceWith(next);
    return;
  }
  if (next.nodeType !== 1) {
    if (old.data !== next.data) old.data = next.data;
    return;
  }
  for (const { name } of [...old.attributes]) {
    if (!next.hasAttribute(name)) old.removeAttribute(name);
  }
  for (const { name, value } of [...next.attributes]) {
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  morph(old, [...next.childNodes]);
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null && v !== false) node.setAttribute(k, String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function glyph(d, cls = '') {
  const box = svg('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  for (const part of [d].flat()) if (part) box.append(svg('path', { d: part }));
  return box;
}

export const paths = {
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2h7.8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  open: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7',
  close: 'M6 6l12 12M18 6 6 18',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  plus: 'M12 5v14M5 12h14',
  pen: 'M4 20h4L19 9l-4-4L4 16z',
  fold: 'M7 10l5 5 5-5',
  chevron: 'M9 6l6 6-6 6',
  branch: 'M6 4v12M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 5-6 4-12 8',
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 12h6M15 12h6',
  pr: 'M6 4v16M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01M18 18V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
  merge: 'M6 4v16M6 8c0 6 12 4 12 10M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  repo: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12',
  empty: 'M4 7h16v13H4zM9 11h6M8 3h8l4 4H4z',
  pin: 'M9 4h6l1 5 2.5 2v2H5.5v-2L8 9zM12 13v7',
  archive: 'M3.5 5h17v3.5h-17zM5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4',
  unarchive: 'M3.5 5h17v3.5h-17zM5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10M12 16v-5M9.5 13.5 12 11l2.5 2.5',
  note: 'M5 4.5h10l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1zM14.5 4.5v4h4M8 12h8M8 15.5h5',
};

export const ms = value => value ? Date.parse(value) : NaN;
export const clock = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
export const fullDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export const modelName = agent => !agent?.model ? '未知模型' : typeof agent.model === 'string' ? agent.model.replace('/', ' / ') : `${agent.model.provider || '未知服务'} / ${agent.model.model || '未知模型'}`;
export const shortModel = agent => (!agent?.model ? '' : typeof agent.model === 'string' ? agent.model.split('/').pop() : agent.model.model || '').replace(/^gpt-/i, 'GPT-');

export function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const s = Math.floor(milliseconds / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function shortDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60000)}m${Math.round(milliseconds % 60000 / 1000)}s`;
}

export function longDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const s = Math.round(milliseconds / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
  return `${Math.floor(m / 60)}小时${m % 60 ? `${m % 60}分` : ''}`;
}

export function ago(value) {
  const diff = Date.now() - ms(value);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 10000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时`;
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function tokens(n = 0) {
  if (!Number.isFinite(n)) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

export const compactNumber = tokens;
export const cost = n => n ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : '$0';
export const statusLabel = status => labels[status] || status || '未知';
export const isWorking = status => busyStatuses.has(status);

export function elapsedOf(agent) {
  const end = working.has(agent.status) ? Date.now() : ms(agent.activity?.lastWorkAt || agent.updatedAt);
  return end - ms(agent.createdAt);
}

export function safeHref(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function agentSessionId(agent) {
  return agent?.parentInfo?.sessionId || agent?.callback?.antigravitySessionId || agent?.callback?.opencodeSessionId || agent?.callback?.claudeSessionId || agent?.callback?.codexThreadId || null;
}

export function agentHost(agent) {
  const kind = (agent?.parentInfo?.kind || agent?.callback?.host || '').toLowerCase();
  if (kind.includes('antigravity') || agent?.callback?.antigravitySessionId) return 'antigravity';
  if (kind.includes('opencode') || agent?.callback?.opencodeSessionId) return 'opencode';
  if (kind.includes('claude') || agent?.callback?.claudeSessionId) return 'claude';
  if (kind.includes('codex') || agent?.callback?.codexThreadId) return 'codex';
  return 'other';
}

export function hostMeta(host) {
  if (host === 'antigravity') return { id: 'antigravity', label: 'Antigravity', short: 'AGY', cls: 'host-agy' };
  if (host === 'opencode') return { id: 'opencode', label: 'OpenCode', short: 'OpenCode', cls: 'host-opencode' };
  if (host === 'claude') return { id: 'claude', label: 'Claude', short: 'Claude', cls: 'host-claude' };
  if (host === 'codex') return { id: 'codex', label: 'Codex', short: 'Codex', cls: 'host-codex' };
  return { id: 'other', label: '会话', short: '', cls: 'host-other' };
}

let toastTimer = null;
export function showToast(text, action = null) {
  const t = $('#toast');
  if (!t) return;
  mount(t, el('span', { text }), action ? el('button', {
    type: 'button',
    class: 'toast-act',
    text: action.label,
    onclick: () => {
      clearTimeout(toastTimer);
      t.hidden = true;
      Promise.resolve(action.run()).catch(err => showToast(err?.message || '操作失败'));
    },
  }) : null);
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 4500 : 2200);
}

export async function copyText(text, message = '已复制') {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(String(text));
    showToast(message);
    return true;
  } catch {
    showToast('复制失败，请手动选择');
    return false;
  }
}

export function replyPayload(questionId, message = '<填写答复内容>') {
  return JSON.stringify({ questionId, message }, null, 2);
}

export async function apiFetch(url, options = {}, retried = false) {
  const headers = new Headers(options.headers || {});
  if (options.method === 'POST') {
    headers.set('content-type', 'application/json');
    headers.set('x-pi-dashboard', '1');
  }
  const signal = options.signal || AbortSignal.timeout(options.method === 'POST' ? 10000 : 15000);
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers, signal });
  if (res.status === 401 && !retried) {
    const boot = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (boot.ok) return apiFetch(url, options, true);
  }
  const raw = await res.text();
  let json = {};
  if (raw) {
    try { json = JSON.parse(raw); }
    catch (parseError) {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
      throw new Error(`接口返回无效 JSON: ${parseError.message}`);
    }
  }
  if (!res.ok) throw new Error(json.error || `读取失败：${res.status}`);
  return json;
}

export function syncSeg(nav, attr, value) {
  if (!nav) return;
  const buttons = [...nav.querySelectorAll(`[data-${attr}]`)];
  const current = buttons.find(b => b.dataset[attr] === value) || buttons[0];
  for (const b of buttons) b.setAttribute('aria-selected', String(b === current));
  const thumb = nav.querySelector('.seg-thumb');
  if (!thumb || !current || !current.offsetWidth) return;
  thumb.style.width = `${current.offsetWidth}px`;
  thumb.style.transform = `translateX(${current.offsetLeft}px)`;
}

export function bindResizers(onDone) {
  const app = $('#app');
  const limits = { side: [220, 460, 280], panel: [300, 620, 360] };
  const setWidth = (which, value) => {
    const [min, max] = limits[which];
    const w = Math.round(Math.min(max, Math.max(min, value)));
    app.style.setProperty(`--${which}-w`, `${w}px`);
    store.set(`${which}-w`, w);
    return w;
  };
  for (const which of ['side', 'panel']) {
    const saved = store.get(`${which}-w`, null);
    if (saved) setWidth(which, saved);
  }
  for (const handle of document.querySelectorAll('.resizer')) {
    const which = handle.dataset.resize;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('active');
      app.classList.add('dragging');
      const move = e => setWidth(which, which === 'side' ? e.clientX : innerWidth - e.clientX);
      const up = () => {
        handle.classList.remove('active');
        app.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        if (onDone) onDone();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', () => { app.style.removeProperty(`--${which}-w`); store.set(`${which}-w`, null); if (onDone) onDone(); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const current = parseInt(getComputedStyle(app).getPropertyValue(`--${which}-w`), 10) || limits[which][2];
      setWidth(which, current + (event.key === 'ArrowRight' ? 16 : -16) * (which === 'side' ? 1 : -1));
      if (onDone) onDone();
    });
  }
}
