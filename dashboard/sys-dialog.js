import { el, glyph, paths, clock, fullDate, hostMeta, mount } from './dom.js';

function renderQuotaCard(item) {
  if (item.status === 'error') {
    return el('div', { class: 'quota-card err' },
      el('div', { class: 'quota-head' }, el('strong', { class: 'mono', text: item.provider }), el('span', { class: 'badge badge-fail', text: '查询失败' })),
      el('div', { class: 'muted', text: item.error || '未知错误' }),
    );
  }
  const q = item.quota || {};
  const lines = [];
  for (const w of q.windows || []) {
    const rem = Number.isFinite(w.remainingPercent) ? `${w.remainingPercent.toFixed(1)}% 剩余` : '剩余未知';
    const reset = w.resetsAt ? ` · 重置 ${fullDate(w.resetsAt)}` : '';
    lines.push(el('div', { class: 'quota-line', text: `${w.kind}${w.service ? ` (${w.service})` : ''}: ${rem}${reset}` }));
  }
  for (const b of q.balances || []) {
    lines.push(el('div', { class: 'quota-line', text: `余额 ${b.total} ${b.currency} (充 ${b.toppedUp} / 赠 ${b.granted})` }));
  }
  for (const w of q.warnings || []) lines.push(el('div', { class: 'quota-warn', text: w }));
  return el('div', { class: 'quota-card' },
    el('div', { class: 'quota-head' },
      el('strong', { class: 'mono', text: item.provider }),
      q.plan ? el('span', { class: 'badge badge-dim', text: q.plan }) : null,
    ),
    lines.length ? lines : el('div', { class: 'muted', text: '暂无窗口明细' }),
  );
}

function renderSandboxCard(sandbox) {
  if (!sandbox) return null;
  const label = sandbox.backend === 'seatbelt'
    ? 'macOS Seatbelt'
    : sandbox.backend === 'bwrap'
      ? (sandbox.wsl ? 'WSL2 Bubblewrap (bwrap)' : 'Linux Bubblewrap (bwrap)')
      : '未受支持平台';
  return el('div', { class: 'sandbox-bar' },
    el('div', { class: 'sandbox-main' },
      el('span', { class: `badge ${sandbox.ok ? 'badge-ok' : 'badge-fail'}`, text: sandbox.ok ? '沙箱就绪' : '沙箱异常' }),
      el('strong', { text: label }),
      sandbox.defaultMode ? el('span', { class: 'badge badge-dim', text: `默认 ${sandbox.defaultMode}` }) : null,
    ),
    el('code', { class: 'muted mono', text: sandbox.executable || '不可用' }),
  );
}

function renderHostsMatrix(hosts) {
  if (!hosts || typeof hosts !== 'object') return null;
  const order = ['antigravity', 'claude', 'codex', 'opencode'];
  return el('div', { class: 'host-matrix' }, order.map(key => {
    const info = hosts[key] || {};
    const meta = hostMeta(key);
    const activeCount = Number(info.activeAgents || 0);
    return el('div', { class: `host-card ${info.configured ? 'is-ready' : ''}` },
      el('div', { class: 'host-card-head' },
        el('span', { class: `prop-tag ${meta.cls}`, text: meta.label }),
        el('span', { class: `badge ${info.configured ? 'badge-ok' : 'badge-dim'}`, text: info.configured ? '已接入' : '未配置' }),
      ),
      el('div', { class: 'muted host-detail', text: info.detail || (info.configured ? 'MCP 配置就绪' : '未检测到本地配置') }),
      el('div', { class: 'host-foot mono' }, activeCount ? `活跃子代理 ${activeCount}` : '当前无活跃代理'),
    );
  }));
}

export async function renderSystemDialog(dialogEl, apiFetch, forceQuota = false) {
  mount(dialogEl, el('div', { class: 'dialog-box dialog-wide' },
    el('div', { class: 'dialog-head' },
      el('strong', { text: '运行环境、四端宿主与账号额度' }),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn small', onclick: () => renderSystemDialog(dialogEl, apiFetch, true) }, glyph(paths.refresh), '刷新额度'),
        el('button', { type: 'button', class: 'btn small', onclick: () => dialogEl.close() }, '关闭'),
      ),
    ),
    el('div', { class: 'dialog-body' }, el('p', { class: 'muted', text: '正在读取本机服务状态与额度…' })),
  ));
  if (!dialogEl.open) dialogEl.showModal();
  const body = dialogEl.querySelector('.dialog-body');
  try {
    const [sys, quota] = await Promise.all([
      apiFetch('/api/system'),
      apiFetch(`/api/quota${forceQuota ? '?refresh=1' : ''}`),
    ]);
    const ctrl = sys.controller;
    const cText = ctrl ? `${ctrl.alive ? '在线' : '已停止'} · PID ${ctrl.pid || '—'} · 版本 ${ctrl.version || '—'}` : '未启动控制进程';
    const c = sys.counts || {};
    const doneTotal = (c.completed || 0) + (c.completedVerified || 0) + (c.completedUnverified || 0);
    const verifyDetail = (c.completedVerified || c.completedUnverified)
      ? `（已验收 ${c.completedVerified || 0} / 未过 ${c.completedUnverified || 0}）`
      : '';
    mount(body,
      sys.sandbox || sys.hosts
        ? el('section', { class: 'settings-card' },
            el('div', { class: 'sec-title', text: '双平台沙箱与四端宿主矩阵' }),
            renderSandboxCard(sys.sandbox),
            renderHostsMatrix(sys.hosts),
          )
        : null,
      el('section', { class: 'settings-card' },
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: '独立控制进程' }), el('span', { class: 'kv-v mono', text: cText })),
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: 'Web 面板进程' }), el('span', { class: 'kv-v mono', text: `PID ${sys.dashboardPid} · 模型目录 ${sys.modelCount} 个` })),
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: '子代理统计' }), el('span', { class: 'kv-v', text: `共 ${c.total || 0} · 工作中 ${c.working || 0} · 待答复 ${c.waiting || 0} · 已完成 ${doneTotal}${verifyDetail}${c.archived ? ` · 已归档 ${c.archived}` : ''}${c.interrupted ? ` · 已中断 ${c.interrupted}` : ''} · 异常 ${(c.failed || 0) + (c.disconnected || 0)}` })),
      ),
      el('div', { class: 'sec-title', text: `活跃事件监听器 (${sys.watchers.length})` }),
      sys.watchers.length
        ? el('div', { class: 'watcher-list' }, sys.watchers.map(w =>
            el('div', { class: 'watcher-row', text: `PID ${w.pid} · 会话 ${w.sessionId || '—'} · 启动于 ${clock(w.startedAt)}` }),
          ))
        : el('div', { class: 'muted', text: '当前没有运行中的后台 wait-events 监听进程' }),
      el('div', { class: 'sec-title', text: `模型额度（查询于 ${clock(quota.queriedAt)}${quota.cached ? ' · 60秒缓存' : ''}）` }),
      quota.error
        ? el('div', { class: 'err-card', text: quota.error })
        : quota.results?.length
          ? el('div', { class: 'quota-grid' }, quota.results.map(renderQuotaCard))
          : el('div', { class: 'muted', text: '未检测到已配置的支持查询的服务商凭据' }),
    );
  } catch (error) {
    body.textContent = `读取失败：${error.message}`;
  }
}
