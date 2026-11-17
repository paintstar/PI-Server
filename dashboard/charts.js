import { $, el, svg, mount, working, ms, clock, shortDuration } from './dom.js';

export function showTip(lines, x, y) {
  const tip = document.getElementById('chart-tip');
  if (!tip) return;
  tip.replaceChildren();
  lines.forEach((line, index) => {
    if (index) tip.append('\n');
    if (Array.isArray(line)) {
      tip.append(...line.map(part => typeof part === 'string' ? part : Object.assign(document.createElement('b'), { textContent: part.b })));
    } else {
      tip.append(String(line));
    }
  });
  tip.hidden = false;
  const half = tip.offsetWidth / 2 + 8;
  tip.style.left = `${Math.min(innerWidth - half, Math.max(half, x))}px`;
  tip.style.top = `${Math.max(tip.offsetHeight + 16, y)}px`;
}

export function hideTip() {
  const tip = document.getElementById('chart-tip');
  if (tip) tip.hidden = true;
}

export function bindTips(root) {
  if (!root) return;
  root.addEventListener('pointermove', event => {
    const target = event.target.closest?.('[data-tip]');
    if (!target) {
      hideTip();
      return;
    }
    showTip(target.getAttribute('data-tip').split('\n'), event.clientX, event.clientY);
  });
  root.addEventListener('pointerleave', hideTip);
}

function smoothPath(points) {
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : '';
  const n = points.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push(dx[i] ? (points[i + 1][1] - points[i][1]) / dx[i] : 0);
  }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!slope[i]) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += ` C${(x0 + h).toFixed(1)},${(y0 + m[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - m[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

let gradientId = 0;
function gradient(chart, color, top = 0.32) {
  const id = `g${++gradientId}`;
  const defs = svg('defs');
  const g = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(
    svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': top }),
    svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }),
  );
  defs.append(g);
  chart.append(defs);
  return `url(#${id})`;
}

const niceMax = value => {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  const f = value / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
};

export function areaChart({ width = 300, height = 96, series, yMax, xMin, xMax, tooltip, refLines = [], animate = false, ticks = 3, format = v => v }) {
  const pad = { top: 6, right: 4, bottom: 4, left: 0 };
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' });
  chart.style.height = `${height}px`;
  const all = series.flatMap(s => s.values);
  if (!all.length) return chart;
  const x0 = xMin ?? Math.min(...all.map(p => p.x));
  const x1 = Math.max(xMax ?? Math.max(...all.map(p => p.x)), x0 + 1);
  const top = yMax ?? niceMax(Math.max(...all.map(p => p.y), ...refLines.map(r => r.y)) * 1.08);
  const X = x => pad.left + (x - x0) / (x1 - x0) * (width - pad.left - pad.right);
  const Y = y => height - pad.bottom - Math.min(1, y / top) * (height - pad.top - pad.bottom);
  for (let i = 1; i <= ticks; i++) {
    const gy = Y(top * i / ticks);
    chart.append(svg('line', { x1: 0, x2: width, y1: gy, y2: gy, class: 'grid dash' }));
  }
  chart.append(svg('line', { x1: 0, x2: width, y1: height - pad.bottom, y2: height - pad.bottom, class: 'grid' }));
  for (const ref of refLines) {
    chart.append(svg('line', { x1: 0, x2: width, y1: Y(ref.y), y2: Y(ref.y), class: ref.cls || 'avg' }));
  }
  for (const s of series) {
    const points = s.values.map(p => [X(p.x), Y(p.y)]);
    if (!points.length) continue;
    const d = smoothPath(points);
    if (s.fill !== false) {
      chart.append(svg('path', {
        d: `${d} L${points.at(-1)[0].toFixed(1)},${height - pad.bottom} L${points[0][0].toFixed(1)},${height - pad.bottom} Z`,
        fill: gradient(chart, s.color, s.opacity ?? 0.28),
        class: 'area',
      }));
    }
    const line = svg('path', { d, stroke: s.color, class: `line ${animate ? 'draw' : ''}` });
    chart.append(line);
    if (animate) {
      requestAnimationFrame(() => {
        try { line.style.setProperty('--len', line.getTotalLength()); }
        catch {}
      });
    }
    if (s.dot !== false) {
      const last = points.at(-1);
      chart.append(svg('circle', { cx: last[0], cy: last[1], r: 3, fill: s.color, class: 'pt' }));
    }
  }
  if (tooltip) {
    const base = series[0].values;
    const cross = svg('line', { y1: pad.top, y2: height - pad.bottom, class: 'cross', visibility: 'hidden' });
    const marks = series.map(s => svg('circle', { r: 3.5, fill: s.color, class: 'pt', visibility: 'hidden' }));
    const hit = svg('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
    chart.append(cross, ...marks, hit);
    hit.addEventListener('pointermove', event => {
      const box = chart.getBoundingClientRect();
      const px = (event.clientX - box.left) / box.width * width;
      let index = 0;
      let best = Infinity;
      base.forEach((p, i) => {
        const dist = Math.abs(X(p.x) - px);
        if (dist < best) { best = dist; index = i; }
      });
      const cx = X(base[index].x);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      series.forEach((s, i) => {
        const p = s.values[index];
        if (!p) return;
        marks[i].setAttribute('cx', X(p.x));
        marks[i].setAttribute('cy', Y(p.y));
        marks[i].setAttribute('visibility', 'visible');
      });
      showTip(tooltip(index), box.left + cx / width * box.width, box.top + Y(base[index].y) / height * box.height);
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      marks.forEach(m => m.setAttribute('visibility', 'hidden'));
      hideTip();
    });
  }
  chart.dataset.max = format(top);
  return chart;
}

export function barChart({ width = 300, height = 56, items, color = 'var(--brand)', average, animate = false }) {
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' });
  chart.style.height = `${height}px`;
  if (!items.length) return chart;
  const top = niceMax(Math.max(...items.map(i => i.v), average || 0) * 1.1);
  const gap = items.length > 40 ? 1 : 2;
  const bar = Math.max(2, (width - gap * (items.length - 1)) / items.length);
  chart.append(svg('line', { x1: 0, x2: width, y1: height - 0.5, y2: height - 0.5, class: 'grid' }));
  items.forEach((item, index) => {
    const h = Math.max(2, item.v / top * (height - 2));
    const x = index * (bar + gap);
    const rect = svg('rect', {
      x,
      y: height - h,
      width: bar,
      height: h,
      rx: Math.min(2.5, bar / 2),
      fill: color,
      opacity: index === items.length - 1 ? 1 : 0.42,
      class: `bar ${animate ? 'grow' : ''}`,
      'data-tip': item.tip,
    });
    if (animate) rect.style.animationDelay = `${index * 18}ms`;
    chart.append(rect);
  });
  if (average) {
    const ay = height - average / top * (height - 2);
    chart.append(svg('line', { x1: 0, x2: width, y1: ay, y2: ay, class: 'avg' }));
  }
  bindTips(chart);
  return chart;
}

export function gauge(fraction, label, sub) {
  const size = 112;
  const r = 46;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction || 0));
  const color = f > 0.85 ? 'var(--fail)' : f > 0.65 ? 'var(--wait)' : 'var(--brand)';
  const box = svg('svg', { class: 'gauge', viewBox: `0 0 ${size} ${size}`, role: 'img' });
  const fill = svg('circle', { cx: size / 2, cy: size / 2, r, class: 'fill', stroke: color, 'stroke-dasharray': c, 'stroke-dashoffset': c });
  box.append(svg('circle', { cx: size / 2, cy: size / 2, r, class: 'track' }), fill);
  const t1 = svg('text', { x: '50%', y: '50%', 'text-anchor': 'middle', class: 'pct', dy: '2' });
  t1.textContent = label;
  const t2 = svg('text', { x: '50%', y: '50%', 'text-anchor': 'middle', class: 'pct-sub', dy: '19' });
  t2.textContent = sub;
  box.append(t1, t2);
  requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', c * (1 - f))));
  return box;
}

export function tweenNumber(node, to, format, dur = 600) {
  const from = Number(node.dataset.value);
  node.dataset.value = to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  cancelAnimationFrame(node._tween);
  const step = now => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - (1 - t) ** 3;
    node.textContent = format(from + (to - from) * e);
    if (t < 1) node._tween = requestAnimationFrame(step);
  };
  node._tween = requestAnimationFrame(step);
}

const speedState = { agent: '', message: '', last: null, rate: 0, history: [], detail: null };
const meterState = { id: '', source: null, data: null };

function estimateTokens(text) {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿＀-￯]/.test(ch)) cjk++;
  return cjk / 1.3 + (text.length - cjk) / 3.8;
}

function sampleLive(data) {
  const now = Date.now();
  const id = data.agent.id;
  const message = data.live?.message?.startedAt || '';
  if (speedState.agent !== id) Object.assign(speedState, { agent: id, message: '', last: null, rate: 0, history: [] });
  if (!message) { speedState.message = ''; speedState.last = null; speedState.rate = 0; return; }
  const total = (data.live?.message?.blocks || []).reduce((sum, block) => sum + (block?.text ? estimateTokens(block.text) : 0), 0);
  if (speedState.message !== message || !speedState.last) { Object.assign(speedState, { message, last: { total, time: now }, rate: 0 }); return; }
  const seconds = (now - speedState.last.time) / 1000;
  if (seconds >= 0.5) {
    const instant = Math.max(0, (total - speedState.last.total) / seconds);
    speedState.rate = speedState.rate ? speedState.rate * 0.5 + instant * 0.5 : instant;
    speedState.last = { total, time: now };
    speedState.history.push([now, speedState.rate]);
    speedState.history = speedState.history.filter(([time]) => now - time < 120000);
  }
}

export function subscribeSpeed(id, paused = false) {
  if (meterState.id === id) return;
  meterState.source?.close();
  Object.assign(meterState, { id, source: null, data: null });
  if (!id || paused || typeof EventSource === 'undefined') return;
  const source = new EventSource(`/api/agents/${id}/speed`, { withCredentials: true });
  source.onmessage = event => { try { meterState.data = JSON.parse(event.data); if (speedState.detail?.agent.id === id) drawSpeed(); } catch (err) { console.error(err); } };
  meterState.source = source;
}

export function closeSpeed() {
  meterState.source?.close();
  Object.assign(meterState, { id: '', source: null, data: null });
}

export function tickSpeed() {
  if (meterState.data?.request) drawSpeed();
}

export function renderSpeed(data, paused = false) {
  speedState.detail = data;
  subscribeSpeed(data.agent.id, paused);
  if (!meterState.data) sampleLive(data);
  drawSpeed();
}

export function drawSpeed() {
  const data = speedState.detail;
  if (!data) return;
  const meter = meterState.data && meterState.id === data.agent.id ? meterState.data : null;
  const request = working.has(data.agent.status) ? meter?.request : null;
  const history = meter?.history?.length ? meter.history : data.speeds || [];
  const latest = history.at(-1);
  let value;
  let caption;
  let live = false;
  if (request?.phase === 'output') { value = meter.rate; live = true; caption = `正在生成 · 本次约 ${request.tokens} token`; }
  else if (request) { value = null; live = true; caption = `${request.phase === 'thinking' ? '正在思考' : '等待首个 token'} · ${shortDuration(Date.now() - ms(request.startedAt))}`; }
  else if (!meter && working.has(data.agent.status) && data.live?.message) { value = speedState.rate; live = true; caption = '正在生成 · 按可见文字估算'; }
  else { value = latest?.tps; caption = latest ? `最近一次 · ${latest.output} token / ${latest.seconds} 秒${latest.waitSeconds != null ? ` · 首字 ${latest.waitSeconds} 秒` : ''}` : '还没有完成的请求'; }
  const totalSec = history.reduce((sum, item) => sum + item.seconds, 0);
  const average = history.length && totalSec > 0 ? history.reduce((sum, item) => sum + item.output, 0) / totalSec : 0;
  const peak = history.length ? Math.max(...history.map(item => item.tps)) : 0;
  const box = $('#p-speed');
  const animate = box.dataset.agent !== data.agent.id;
  box.dataset.agent = data.agent.id;
  let head = box.querySelector('.speed-now');
  if (!head || animate) head = el('div', { class: 'speed-now' }, el('b', { text: '—' }), el('span', { text: 'tok/s' }), el('i', { class: 'pulse' }));
  head.classList.toggle('streaming', live);
  head.querySelector('.pulse').hidden = !live;
  const number = head.querySelector('b');
  if (value == null) { number.textContent = '—'; number.dataset.value = ''; }
  else tweenNumber(number, value, v => v >= 100 ? String(Math.round(v)) : v.toFixed(1), 450);
  const series = (meter?.series || speedState.history).filter(([time]) => Date.now() - time <= 60000);
  const liveChart = live && series.length > 1
    ? areaChart({ width: 320, height: 64, series: [{ values: series.map(([t, r]) => ({ x: t, y: r })), color: 'var(--brand)' }], xMin: Date.now() - 60000, xMax: Date.now(), ticks: 2, tooltip: i => [[{ b: `${series[i][1].toFixed(1)}` }, ' tok/s'], `${Math.round((Date.now() - series[i][0]) / 1000)} 秒前`] })
    : null;
  const items = history.slice(-36).map(item => ({ v: item.tps, tip: `${item.tps} tok/s\n${item.output} token · ${item.seconds} 秒\n${clock(item.at)}` }));
  const bars = items.length ? barChart({ width: 320, height: 54, items, average, animate }) : null;
  $('#speed-meta').textContent = history.length ? `最近 ${Math.min(36, history.length)} 次请求` : '';
  mount(box, head, el('div', { class: 'speed-cap', text: caption }), liveChart || bars, liveChart && bars ? bars : null,
    el('dl', { class: 'speed-figures' },
      el('div', {}, el('dt', { text: '平均' }), el('dd', { text: history.length ? average.toFixed(1) : '—' })),
      el('div', {}, el('dt', { text: '最高' }), el('dd', { text: history.length ? String(peak) : '—' })),
      el('div', {}, el('dt', { text: '请求' }), el('dd', { text: String(history.length) })),
    ));
}
