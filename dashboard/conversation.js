import {
  el, svg, morph, clock, fullDate, shortDuration, longDuration, safeHref, copyText, replyPayload, busyStatuses,
} from './dom.js';

const icons = {
  shell: 'M4 6l5 5-5 5M11 17h8',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4 4',
  think: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z',
  tool: 'M14 6a4 4 0 0 0 5 5l-8 8-3-3 8-8a4 4 0 0 0-2-2zM5 19l-1 1',
  message: 'M4 5h16v11H8l-4 4z',
  ask: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7V14M12 17.5v.5',
  files: 'M5 4h9l5 5v11H5zM9 13h6M12 10v6',
  skill: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.8 2.2 2.2.8-2.2.8L18 21l-.8-2.2-2.2-.8 2.2-.8z',
  guide: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6M9 10.5h4',
  pr: 'M6 4v16M18 20V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
};

function icon(name, cls = 'ico') {
  const box = svg('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  box.append(svg('path', { d: icons[name] || icons.tool }));
  return box;
}

function inline(text) {
  const nodes = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const match of String(text || '').matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) nodes.push(el('code', { text: token.slice(1, -1) }));
    else if (token.startsWith('**')) nodes.push(el('strong', { text: token.slice(2, -2) }));
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      nodes.push(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: link[1] }) : token);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function markdown(source) {
  const root = el('div', { class: 'md' });
  String(source || '').split(/^```[^\n]*\n?/m).forEach((part, index) => {
    if (index % 2) {
      root.append(el('pre', { class: 'code', text: part.replace(/\n$/, '') }));
      return;
    }
    let list = null;
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) root.append(el('p', {}, inline(paragraph.join('\n'))));
      paragraph = [];
    };
    for (const line of part.split('\n')) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        list = null;
        root.append(el('h4', {}, inline(heading[2])));
      } else if (item) {
        flush();
        const wantTag = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== wantTag) root.append(list = el(wantTag));
        list.append(el('li', {}, inline(item[1])));
      } else if (!line.trim()) {
        flush();
        list = null;
      } else {
        list = null;
        paragraph.push(line);
      }
    }
    flush();
  });
  return root;
}

const parsePath = args => args.path ?? args.file_path ?? args.filePath ?? '';

function describe(call, running) {
  const a = call.arguments || {};
  const name = call.name;
  if (name === 'bash') {
    const command = String(a.command || '');
    if (/\bgh pr (create|merge|view|checks)\b/.test(command)) {
      const verb = running ? '正在处理 PR' : /gh pr create/.test(command) ? '创建了 PR' : /gh pr merge/.test(command) ? '合并了 PR' : '查看了 PR';
      return { icon: 'pr', verb, target: command.split('\n')[0] };
    }
    return { icon: 'shell', verb: running ? '正在运行命令' : '运行了命令', target: command.split('\n')[0] };
  }
  if (name === 'read') {
    const file = parsePath(a);
    const skill = /([^/]+)\/SKILL\.md$/i.exec(file);
    if (skill) return { icon: 'skill', verb: running ? '正在加载技能' : '使用技能', target: skill[1], kind: 'skill' };
    if (/(^|\/)(AGENTS|CLAUDE)\.md$/i.test(file)) {
      return { icon: 'guide', verb: running ? '正在读取项目说明' : '读取了项目说明', target: file.split('/').slice(-2).join('/'), kind: 'guide' };
    }
    return { icon: 'file', verb: running ? '正在读取' : '读取了', target: file };
  }
  if (name === 'edit') return { icon: 'edit', verb: running ? '正在编辑' : '编辑了', target: parsePath(a) };
  if (name === 'write') return { icon: 'edit', verb: running ? '正在写入' : '写入了', target: parsePath(a) };
  if (name === 'grep' || name === 'find') return { icon: 'search', verb: running ? '正在搜索' : '搜索了', target: a.pattern || a.query || parsePath(a) };
  if (name === 'ls') return { icon: 'search', verb: running ? '正在列出' : '列出了', target: parsePath(a) || '.' };
  return { icon: 'tool', verb: running ? `正在调用 ${name}` : `调用了 ${name}`, target: '' };
}

export function diffStats(diff = '') {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  return { add, del };
}

function diffView(diff) {
  const box = el('div', { class: 'diff' });
  for (const line of diff.split('\n')) {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.trim() === '...' ? 'gap' : '';
    box.append(el('div', { class: cls, text: line || ' ' }));
  }
  return box;
}

function extractAnswer(result) {
  if (!result) return '';
  if (result.answer) return result.answer;
  if (typeof result.text === 'string' && result.text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(result.text);
      if (typeof parsed?.answer === 'string') return parsed.answer;
    } catch {}
  }
  return result.text || '';
}

function toolWindow(call, result, liveOutput) {
  const a = call.arguments || {};
  const output = liveOutput ?? result?.text ?? '';
  if (call.name === 'bash') {
    return el('div', { class: 'term' },
      el('div', { class: 'term-head' }, el('i'), el('i'), el('i'), el('span', { text: 'Shell' }), result?.durationMs != null ? el('em', { text: shortDuration(result.durationMs) }) : null),
      el('pre', { class: 'term-body' }, el('span', { class: 'prompt', text: '$ ' }), String(a.command || ''), output ? `\n${output}` : liveOutput === '' ? '\n' : '', !result ? el('span', { class: 'caret' }) : null),
      result ? el('div', { class: `term-foot ${result.isError ? 'bad' : ''}`, text: result.isError ? '命令失败' : '执行成功' }) : null,
    );
  }
  if (call.name === 'edit' || call.name === 'write') {
    const diff = result?.diff;
    const stats = diff ? diffStats(diff) : { add: String(a.content || '').split('\n').length, del: 0 };
    const head = el('div', { class: 'file-head' }, icon('file'), el('code', { text: parsePath(a) }), el('span', { class: 'plus', text: `+${stats.add}` }), el('span', { class: 'minus', text: `-${stats.del}` }));
    const body = diff ? diffView(diff) : call.name === 'write'
      ? el('pre', { class: 'file-body', text: String(a.content || '') })
      : el('div', { class: 'diff' }, (a.edits || [a]).flatMap(edit => [
          ...String(edit.oldText ?? edit.old_string ?? '').split('\n').map(line => el('div', { class: 'del', text: `- ${line}` })),
          ...String(edit.newText ?? edit.new_string ?? '').split('\n').map(line => el('div', { class: 'add', text: `+ ${line}` })),
        ]));
    return el('div', { class: 'file-win' }, head, body, result?.isError ? el('div', { class: 'win-error', text: result.text }) : null);
  }
  return el('div', { class: 'file-win' },
    el('div', { class: 'file-head' }, icon(describe(call).icon), el('code', { text: parsePath(a) || call.name }), result?.durationMs != null ? el('em', { text: shortDuration(result.durationMs) }) : null),
    call.name === 'read' ? null : el('pre', { class: 'file-body args', text: JSON.stringify(a, null, 2) }),
    output ? el('pre', { class: `file-body ${result?.isError ? 'bad' : ''}`, text: output }) : el('div', { class: 'win-wait', text: result ? '没有输出' : '等待结果…' }),
  );
}

function toolItem(call, result, ctx) {
  const running = !result && ctx.working;
  const liveOutput = ctx.live?.tools?.[call.id]?.output;
  if (call.name === 'agent_message') {
    const target = call.arguments?.recipient === 'parent' ? '父代理' : call.arguments?.recipient || '';
    return el('div', { class: 'note-item' },
      el('div', { class: 'note-head' }, icon('message'), `向${target}报告`, el('time', { text: clock(result?.time) })),
      markdown(String(call.arguments?.message || '')),
    );
  }
  if (call.name === 'ask_parent') {
    const pendingQuestion = !result ? ctx.questions?.at(-1) : null;
    const answerText = extractAnswer(result);
    return el('div', { class: `ask-item ${result ? '' : 'pending'}` },
      el('div', { class: 'note-head' },
        icon('ask'),
        result ? '向父代理提问 · 已答复' : '向父代理提问 · 等待答复',
        pendingQuestion ? el('button', { type: 'button', class: 'btn small ask-copy', onclick: () => copyText(replyPayload(pendingQuestion.questionId), '已复制 reply_question 参数') }, '复制答复参数') : null,
      ),
      el('p', { class: 'q', text: String(call.arguments?.question || '') }),
      result && answerText ? el('p', { class: 'a', text: answerText }) : null,
    );
  }
  const d = describe(call, running);
  const stats = (call.name === 'edit' || call.name === 'write') && result?.diff ? diffStats(result.diff) : null;
  const status = running ? el('span', { class: 'spin' })
    : !result ? el('span', { class: 'muted', text: '未完成' })
    : result.isError ? el('span', { class: 'bad', text: '失败' })
    : stats ? el('span', { class: 'stat' }, el('b', { class: 'plus', text: `+${stats.add}` }), el('b', { class: 'minus', text: `-${stats.del}` }))
    : result.durationMs != null ? el('span', { class: 'muted', text: shortDuration(result.durationMs) }) : null;
  const key = `${ctx.agentId}:tool:${call.id}`;
  const chipOrTarget = d.kind
    ? el('span', { class: `skill-chip ${d.kind}`, title: parsePath(call.arguments || {}) }, icon(d.icon), d.target)
    : d.target ? el('code', { class: 'target', text: d.target }) : null;
  const node = el('details', { class: `tool-item ${d.kind || ''} ${running ? 'running' : ''} ${result?.isError ? 'error' : ''}`, 'data-key': key },
    el('summary', {}, d.kind ? null : icon(d.icon), el('span', { class: 'verb', text: d.verb }), chipOrTarget, status),
    toolWindow(call, result, liveOutput),
  );
  node.open = ctx.expanded.get(key) ?? (running && liveOutput != null);
  return node;
}

function editsCard(edits, key, ctx) {
  const files = new Map();
  for (const { call, result } of edits) {
    const stats = result.diff ? diffStats(result.diff) : { add: String(call.arguments?.content || '').split('\n').length, del: 0 };
    const name = parsePath(call.arguments || {});
    const total = files.get(name) || { add: 0, del: 0 };
    files.set(name, { add: total.add + stats.add, del: total.del + stats.del });
  }
  const sum = [...files.values()].reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });
  const node = el('details', { class: 'edits-card', 'data-key': key },
    el('summary', {}, icon('files'), el('span', { text: `已编辑 ${files.size} 个文件` }), el('b', { class: 'plus', text: `+${sum.add}` }), el('b', { class: 'minus', text: `-${sum.del}` })),
    el('ul', {}, [...files].map(([name, f]) => {
      const slash = name.lastIndexOf('/');
      return el('li', {}, el('span', { class: 'dir', text: name.slice(0, slash + 1) }), el('span', { text: name.slice(slash + 1) }), el('b', { class: 'plus', text: `+${f.add}` }), el('b', { class: 'minus', text: `-${f.del}` }));
    })),
  );
  node.open = ctx.expanded.get(key) ?? files.size <= 4;
  return node;
}

function thinkingRow(message, ctx) {
  const spent = Date.parse(message.time) - Date.parse(message.startedAt);
  const label = `思考了 ${Number.isFinite(spent) ? shortDuration(spent) : ''}`.trim();
  if (!message.thinking) {
    return el('div', { class: 'step' }, icon('think'), label, message.thinkingRedacted ? el('span', { class: 'muted', text: ' · 模型未公开思考内容' }) : null);
  }
  const key = `${ctx.agentId}:think:${message.id}`;
  const node = el('details', { class: 'think-row', 'data-key': key }, el('summary', {}, icon('think'), label), el('div', { class: 'think-text' }, markdown(message.thinking)));
  node.open = ctx.expanded.get(key) ?? false;
  return node;
}

function userBubble(message, ctx) {
  const text = String(message.text || '').replace(/^\[Pi message [^\]]+\]\n/, '');
  const key = `${ctx.agentId}:user:${message.id}`;
  const long = text.length > 220 || text.split('\n').length > 4;
  const isExpanded = Boolean(ctx.expanded.get(key));
  const bubble = el('div', { class: `bubble ${long && !isExpanded ? 'clamped' : ''}`, 'data-key': key },
    el('div', { class: 'bubble-text', text }),
    long ? el('button', {
      type: 'button',
      class: 'more',
      text: isExpanded ? '收起 ⌃' : '显示更多 ⌄',
      onclick: event => {
        const clampedNow = bubble.classList.toggle('clamped');
        ctx.expanded.set(key, !clampedNow);
        event.currentTarget.textContent = clampedNow ? '显示更多 ⌄' : '收起 ⌃';
      },
    }) : null,
  );
  return el('div', { class: 'turn-user', title: fullDate(message.time) }, bubble);
}

const typing = { shown: new Map(), target: new Map(), live: new Set() };
let tailBuild = null;

function revealed(key, text) {
  typing.target.set(key, text.length);
  typing.live.add(key);
  if (!typing.shown.has(key)) {
    if (typing.shown.size > 60) { typing.shown.clear(); typing.target.clear(); typing.target.set(key, text.length); }
    typing.shown.set(key, text.length > 300 ? text.length : 0);
  }
  const shown = Math.min(typing.shown.get(key), text.length);
  typing.shown.set(key, shown);
  return text.slice(0, shown);
}

export function refreshTail() {
  const old = document.querySelector('#records .live-tail');
  if (!tailBuild || !old) return false;
  let moved = false;
  for (const key of typing.live) {
    const target = typing.target.get(key);
    const shown = Math.min(typing.shown.get(key) ?? 0, target);
    const backlog = target - shown;
    if (backlog > 0) {
      typing.shown.set(key, shown + Math.max(1, Math.ceil(backlog * 0.09)));
      moved = true;
    }
  }
  if (!moved) return false;
  const next = tailBuild();
  if (!next) return false;
  morph(old, [...next.childNodes]);
  return true;
}

function liveTail(data, ctx, pendingCalls, lastTime) {
  typing.live = new Set();
  const tail = el('div', { class: 'live-tail' });
  const live = data.live;
  if (data.agent.status === 'waiting') {
    tail.append(el('div', { class: 'step' }, icon('ask'), '暂停在提问上，等待所属聊天答复'));
    return tail;
  }
  if (!ctx.working) return null;
  if (live?.message) {
    const since = Date.parse(live.message.startedAt) || Date.now();
    live.message.blocks.forEach((block, index) => {
      if (!block) return;
      const shown = block.type === 'toolCall' ? '' : revealed(`${ctx.agentId}:${live.message.startedAt}:${index}`, String(block.text || ''));
      if (block.type === 'thinking') {
        tail.append(el('div', { class: 'live-think' },
          el('div', { class: 'step shimmer' }, icon('think'), '正在思考', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })),
          shown ? el('div', { class: 'think-text streaming' }, markdown(shown.slice(-1600))) : null,
        ));
      } else if (block.type === 'text') {
        tail.append(el('div', { class: 'live-text' }, markdown(shown), el('span', { class: 'caret' })));
      } else if (block.type === 'toolCall') {
        tail.append(el('div', { class: 'step shimmer' }, icon('tool'), block.done ? `准备调用 ${block.name}` : `正在写 ${block.name || '工具'} 的参数`, el('span', { class: 'muted', text: `${String(block.text || '').length} 字` })));
      }
    });
    if (!live.message.blocks.filter(Boolean).length) {
      tail.append(el('div', { class: 'step shimmer' }, icon('think'), '正在等待模型响应', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })));
    }
    return tail;
  }
  if (!pendingCalls) {
    const since = Date.parse(lastTime) || Date.now();
    tail.append(el('div', { class: 'step shimmer' }, icon('think'), '正在思考', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })));
    return tail;
  }
  return null;
}

export function renderConversation(data, expanded) {
  const ctx = { agentId: data.agent.id, expanded, working: busyStatuses.has(data.agent.status), live: data.live, questions: data.agent.questions || [] };
  const results = new Map(data.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
  const runs = [];
  let run = null;
  for (const message of data.messages) {
    if (message.role === 'user') runs.push(run = { user: message, steps: [] });
    else if (message.role === 'assistant') {
      if (!run) runs.push(run = { user: null, steps: [] });
      run.steps.push(message);
    }
  }
  const convo = el('div', { class: 'convo' });
  tailBuild = null;
  runs.forEach((r, index) => {
    const active = index === runs.length - 1 && (ctx.working || data.agent.status === 'waiting');
    if (r.user) convo.append(userBubble(r.user, ctx));
    const last = r.steps.at(-1);
    const final = !active && last && last.text && !last.calls.length ? last : null;
    const process = final ? r.steps.slice(0, -1) : r.steps;
    const body = el('div', { class: 'run-body' });
    const edits = [];
    let pending = 0;
    let lastParentReport = '';
    for (const message of process) {
      pending = 0;
      if (message.thinking || message.thinkingRedacted) body.append(thinkingRow(message, ctx));
      if (message.text) body.append(markdown(message.text));
      if (message.error) body.append(el('div', { class: 'win-error', text: `模型请求失败：${message.error}` }));
      for (const call of message.calls || []) {
        const result = results.get(call.id);
        if (!result) pending++;
        if (call.name === 'agent_message' && (!call.arguments?.recipient || call.arguments?.recipient === 'parent')) {
          lastParentReport = String(call.arguments?.message || '');
        }
        body.append(toolItem(call, result, ctx));
        if (result && !result.isError && (call.name === 'edit' || call.name === 'write')) edits.push({ call, result });
      }
    }
    if (final?.thinking || final?.thinkingRedacted) body.append(thinkingRow(final, ctx));
    if (active) {
      const lastTime = r.steps.at(-1)?.time || r.user?.time;
      const waiting = pending > 0;
      const tail = liveTail(data, ctx, waiting, lastTime);
      if (tail) body.append(tail);
      tailBuild = () => liveTail(data, ctx, waiting, lastTime);
    }
    const rawStart = Date.parse(r.user?.time || r.steps[0]?.startedAt || r.steps[0]?.time);
    const start = Number.isFinite(rawStart) ? rawStart : Date.now();
    const end = active ? Date.now() : (Date.parse(last?.time || r.user?.time) || start);
    if (body.childNodes.length) {
      const key = `${ctx.agentId}:run:${r.user?.id || 'start'}`;
      const elapsedLabel = longDuration(end - start);
      const summary = el('summary', { class: active ? 'active' : '' },
        active ? el('span', { class: 'spin' }) : null,
        active ? el('span', { 'data-run-start': start, text: `正在工作 ${elapsedLabel}`.trim() }) : `用时 ${elapsedLabel || '0秒'}`,
      );
      const fold = el('details', { class: 'run-fold', 'data-key': key }, summary, body);
      fold.open = expanded.get(key) ?? (active || Boolean(last?.error));
      convo.append(fold);
    }
    if (final) convo.append(el('div', { class: 'final' }, markdown(final.text)));
    else if (!active && lastParentReport && !last?.error) convo.append(el('div', { class: 'final' }, markdown(lastParentReport)));
    if (edits.length) convo.append(editsCard(edits, `${ctx.agentId}:edits:${r.user?.id || 'start'}`, ctx));
  });
  if (!runs.length) {
    const tail = liveTail(data, ctx, false, null);
    convo.append(tail || el('p', { class: 'records-empty', text: '暂时没有已保存的对话。' }));
  }
  return convo;
}
