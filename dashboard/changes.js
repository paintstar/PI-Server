import { $, el, glyph, paths, copyText, mount } from './dom.js';
import { changedFiles, pairTools, renderHead } from './panels.js';

function parseDiff(diff = '') {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      file = { path: m ? m[1] : line.slice(11), status: 'M', add: 0, del: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file')) file.status = 'A';
    else if (line.startsWith('deleted file')) file.status = 'D';
    else if (line.startsWith('rename to ')) { file.path = line.slice(10); file.status = 'R'; }
    else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = Number(m?.[1] || 0);
      newLine = Number(m?.[2] || 0);
      file.lines.push({ type: 'hunk', text: line });
    } else if (/^(\+\+\+|---|index |similarity|rename from|old mode|new mode)/.test(line)) continue;
    else if (line.startsWith('+')) { file.add++; file.lines.push({ type: 'add', text: line.slice(1), n: newLine++ }); }
    else if (line.startsWith('-')) { file.del++; file.lines.push({ type: 'del', text: line.slice(1), o: oldLine++ }); }
    else if (line.startsWith(' ') || line === '') { if (file.lines.length) file.lines.push({ type: 'ctx', text: line.slice(1), o: oldLine++, n: newLine++ }); }
    else if (line.startsWith('Binary')) file.lines.push({ type: 'hunk', text: '二进制文件' });
  }
  return files;
}

function minibar(add, del) {
  const total = add + del;
  const box = el('span', { class: 'minibar' });
  const a = total ? Math.round(add / total * 5) : 0;
  const d = total ? Math.min(5 - a, Math.round(del / total * 5)) : 0;
  for (let i = 0; i < 5; i++) box.append(el('i', { class: i < a ? 'a' : i < a + d ? 'd' : '' }));
  return box;
}

function diffTable(file) {
  const body = el('tbody');
  const clip = text => text.length > 1000 ? `${text.slice(0, 1000)} …（本行还有 ${text.length - 1000} 字）` : text;
  for (const line of file.lines.slice(0, 1500)) {
    if (line.type === 'hunk') body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: line.text })));
    else body.append(el('tr', { class: line.type }, el('td', { class: 'ln', text: line.o ?? '' }), el('td', { class: 'ln', text: line.n ?? '' }), el('td', { class: 'code' }, el('span', { class: 'mk', text: line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }), clip(line.text))));
  }
  if (file.lines.length > 1500) body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: `还有 ${file.lines.length - 1500} 行未显示` })));
  return el('div', { class: 'dscroll' }, el('table', { class: 'dtable' }, body));
}

export async function loadChanges(id, state, apiFetch, force = false) {
  const cached = state.changes.get(id);
  if (!force && cached && (cached.loading || Date.now() - cached.at < 15000)) return;
  state.changes.set(id, { ...cached, loading: true });
  if (state.ptab === 'changes') renderChanges(state.detail, state, apiFetch, true);
  try {
    const result = await apiFetch(`/api/agents/${id}/changes`);
    state.changes.set(id, { result, files: parseDiff(result.diff), at: Date.now() });
  } catch (error) {
    state.changes.set(id, { error: error.message, at: Date.now() });
  }
  if (state.detail?.agent.id === id) {
    renderChanges(state.detail, state, apiFetch, true);
    renderHead(state.detail, pairTools(state.detail.agent.events), state);
  }
}

function buildGitSections(entry, refresh) {
  const secs = [];
  const r = entry.result;
  if (entry.error) {
    secs.push(el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: 'Git 状态' }), el('span', { class: 'sec-meta' }, refresh)), el('p', { class: 'muted', text: `读取失败：${entry.error}` })));
  } else if (r.git === false) {
    secs.push(el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: 'Git 状态' }), el('span', { class: 'sec-meta' }, refresh)), el('p', { class: 'muted', text: '工作目录不是 Git 仓库，以下为对话内记录的编辑。' })));
  } else {
    const add = entry.files.reduce((s, f) => s + f.add, 0);
    const del = entry.files.reduce((s, f) => s + f.del, 0);
    const sum = el('div', { class: 'sumbar' });
    const a = el('i', { class: 'a' }); a.style.flexGrow = add || 0;
    const d = el('i', { class: 'd' }); d.style.flexGrow = del || 0;
    sum.append(a, d);
    secs.push(el('section', { class: 'p-sec' },
      el('header', { class: 'sec-head' }, el('h3', { text: 'Git 摘要' }), el('span', { class: 'sec-meta' }, refresh)),
      el('div', { class: 'git-line' }, glyph(paths.repo), el('code', { text: r.repository?.split('/').pop() || r.cwd }), el('span', { class: 'muted', text: r.mode === 'worktree' ? '独立工作树' : '共享目录' })),
      el('div', { class: 'git-line' }, glyph(paths.branch), el('code', { text: r.branch || '当前分支' }), el('span', { class: 'muted', text: `基于 ${String(r.base).slice(0, 8)}` })),
      el('div', { class: 'git-line' }, glyph(paths.commit), el('span', { text: `${entry.files.length} 个文件` }), el('span', { class: 'diffstat muted' }, el('span', { class: 'plus', text: `+${add}` }), el('span', { class: 'minus', text: `−${del}` }))),
      (add + del) ? sum : null,
      r.note && r.mode !== 'worktree' ? el('p', { class: 'ctx-note', text: '共享目录：只看声明范围，可能包含外部修改。' }) : null,
    ));
    if (r.commits?.length) {
      secs.push(el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: '提交记录' }), el('span', { class: 'sec-meta', text: `${r.commits.length} 个` })), el('ul', { class: 'commits' }, r.commits.slice(0, 20).map(line => el('li', {}, el('i'), el('code', { text: line.slice(0, 7) }), el('span', { text: line.slice(8), title: line.slice(8) }))))));
    }
  }
  return secs;
}

export function renderChanges(data, state, apiFetch, force = false) {
  if (!data) return;
  const box = $('#p-changes');
  const id = data.agent.id;
  const entry = state.changes.get(id);
  const key = JSON.stringify([id, entry?.at, entry?.loading, data.pullRequests?.length]);
  if (!force && box.dataset.key === key) return;
  box.dataset.key = key;
  if (!entry || (entry.loading && !entry.result)) {
    mount(box, el('section', { class: 'p-sec' }, el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton w80' })), el('section', { class: 'p-sec' }, el('div', { class: 'skeleton tall' })));
    return;
  }
  const refresh = el('button', { type: 'button', class: `btn small ghost ${entry.loading ? 'spinning' : ''}`, title: '重新读取', onclick: () => loadChanges(id, state, apiFetch, true) }, glyph(paths.refresh), '刷新');
  const secs = buildGitSections(entry, refresh);
  const prs = data.pullRequests || [];
  const r = entry.result;
  if (prs.length) {
    secs.push(el('section', { class: 'p-sec' }, el('header', { class: 'sec-head' }, el('h3', { text: 'PR 记录' }), el('span', { class: 'sec-meta', text: `${prs.length} 个` })), el('ul', { class: 'prs' }, prs.slice().reverse().map(pr => el('li', {}, el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: `pr-ico ${pr.merged ? 'merged' : ''}` }, glyph(pr.merged ? paths.merge : paths.pr)), el('span', { class: 'pr-meta' }, el('b', { text: `#${pr.number}` }), el('span', { class: 'repo', text: pr.repo })), el('span', { class: 'state', text: pr.merged ? '已合并' : pr.created ? '已创建' : '已引用' })))))));
  }
  const gitFiles = r && r.git !== false ? entry.files : [];
  const recordedFiles = !gitFiles.length ? [...changedFiles(data)].map(([filePath, f]) => ({ path: filePath, status: 'M', add: f.add, del: f.del, lines: [] })) : [];
  const files = gitFiles.length ? gitFiles : recordedFiles;
  if (files.length) {
    const hasDiff = files.some(f => f.lines.length);
    let toggleBtn = null;
    const syncToggle = () => {
      if (!toggleBtn) return;
      const nodes = [...box.querySelectorAll('details.cfile')];
      toggleBtn.textContent = nodes.some(n => !n.open) ? '展开全部' : '收起全部';
    };
    const items = files.map((f, i) => {
      const slash = f.path.lastIndexOf('/');
      const copyBtn = el('button', { type: 'button', class: 'cfile-copy', title: '复制路径', onclick: ev => { ev.preventDefault(); ev.stopPropagation(); copyText(f.path, '已复制文件路径'); } }, glyph(paths.copy));
      const headNodes = [
        f.lines.length ? glyph(paths.chevron, 'cfile-arr') : null,
        el('span', { class: `st ${f.status}`, text: f.status }),
        el('span', { class: 'fname', title: f.path }, el('bdi', {}, el('span', { class: 'muted', text: f.path.slice(0, slash + 1) }), el('b', { text: f.path.slice(slash + 1) }))),
        el('span', { class: 'diffstat' }, el('span', { class: 'plus', text: `+${f.add}` }), el('span', { class: 'minus', text: `−${f.del}` })),
        minibar(f.add, f.del),
        copyBtn,
      ];
      if (!f.lines.length) return el('div', { class: 'cfile static' }, ...headNodes);
      const node = el('details', { class: 'cfile', 'data-file': i }, el('summary', {}, ...headNodes));
      node.open = i < 2 && f.lines.length < 260;
      node.addEventListener('toggle', () => {
        if (node.open && !node.querySelector('.dscroll')) node.append(diffTable(f));
        syncToggle();
      });
      if (node.open) node.append(diffTable(f));
      return node;
    });
    const initialHasClosed = items.some(node => node.tagName === 'DETAILS' && !node.open);
    toggleBtn = hasDiff ? el('button', {
      type: 'button',
      class: 'link-btn',
      text: initialHasClosed ? '展开全部' : '收起全部',
      onclick: () => {
        const nodes = [...box.querySelectorAll('details.cfile')];
        const nextOpen = nodes.some(n => !n.open);
        for (const n of nodes) n.open = nextOpen;
        syncToggle();
      },
    }) : null;
    secs.push(el('section', { class: 'p-sec' },
      el('header', { class: 'sec-head' },
        el('h3', { text: `${gitFiles.length ? '改动文件' : '对话内记录文件'} (${files.length})` }),
        el('span', { class: 'sec-meta' }, r?.diffTruncated ? '已截断 · ' : '', toggleBtn),
      ),
      el('div', { class: 'cfile-list' }, items),
    ));
  }
  if (!files.length && !prs.length && !entry.error) secs.push(el('section', { class: 'p-empty' }, glyph(paths.empty), '没有发现改动。'));
  mount(box, secs);
}
