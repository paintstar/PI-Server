import {
  $, el, glyph, paths, working, doneStatuses, copyText, showToast, agentSessionId, mount,
} from './dom.js';
import { buildGroups, currentAgentGroupKey, defaultAgentGroupKey } from './sidebar.js';

export function closeMenu() {
  const menu = $('#menu');
  if (!menu) return;
  menu.hidden = true;
  menu.replaceChildren();
}

function menuItems(items) {
  return items.filter(Boolean).map(item => {
    if (item === '-') return el('hr');
    if (item.header) return el('div', { class: 'menu-label', text: item.header });
    const button = el('button', {
      type: 'button',
      role: 'menuitem',
      class: item.danger ? 'danger' : '',
      disabled: item.disabled || false,
      onclick: item.sub ? null : () => {
        closeMenu();
        Promise.resolve(item.run()).catch(error => showToast(error?.message || '操作失败'));
      },
    },
    item.icon ? glyph(item.icon) : glyph(''),
    el('span', { text: item.label }),
    item.sub ? glyph(paths.chevron, 'sc') : item.sc ? el('span', { class: 'sc', text: item.sc }) : null);
    if (!item.sub) return button;
    return el('div', { class: `sub ${item.left ? 'left' : ''}` }, button, el('div', { class: 'menu', role: 'menu' }, menuItems(item.sub)));
  });
}

export function openMenu(items, x, y) {
  const menu = $('#menu');
  menu.replaceChildren(...menuItems(items));
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(x, innerWidth - w - 8);
  const top = Math.min(y, innerHeight - h - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.transformOrigin = `${x > left ? 'right' : 'left'} ${y > top ? 'bottom' : 'top'}`;
  for (const sub of menu.querySelectorAll('.sub')) {
    if (left + w * 2 + 12 > innerWidth) sub.classList.add('left');
  }
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

export function promptDialog(title, value, hint) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-hint').textContent = hint || '';
  const input = $('#dialog-input');
  input.value = value || '';
  return new Promise(resolve => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    dialog.returnValue = '';
    dialog.showModal();
    input.select();
  });
}

function buildEditControls(agent, state) {
  const groups = [...buildGroups(state.agents, state).values()].filter(g => g.agents.length || g.info.custom);
  const defaultKey = defaultAgentGroupKey(agent, state.agents);
  const defaultGroup = groups.find(g => g.key === defaultKey);
  const rawName = agent.rawName || agent.name || agent.id.slice(0, 8);
  const titleInput = el('input', { class: 'input', maxlength: 100, value: agent.title || '', placeholder: rawName });
  const customInput = el('input', { class: 'input', maxlength: 60, placeholder: '输入新分组名称', hidden: true });
  const groupSelect = el('select', {
    class: 'input',
    onchange: () => {
      customInput.hidden = groupSelect.value !== '__new__';
      if (!customInput.hidden) customInput.focus();
    },
  },
    el('option', { value: '', text: `默认分组（${defaultGroup?.name || '按宿主会话自动归类'}）` }),
    ...groups.filter(g => g.key !== defaultKey).map(g => el('option', { value: g.key, selected: agent.movedTo === g.key, text: g.name })),
    el('option', { value: '__new__', text: '+ 新建自定义分组…' }),
  );
  if (agent.movedTo && ![...groupSelect.options].some(o => o.value === agent.movedTo)) {
    groupSelect.add(el('option', { value: agent.movedTo, selected: true, text: agent.movedTo.replace(/^custom:/, '') }), groupSelect.options.length - 1);
  }
  groupSelect.value = agent.movedTo || '';
  const noteInput = el('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: '记录任务背景、结论或待跟进事项（支持左侧搜索）' }, agent.note || '');
  const pinCheck = el('input', { type: 'checkbox', checked: Boolean(agent.pinned) });
  return { rawName, titleInput, customInput, groupSelect, noteInput, pinCheck };
}

export function openEditDialog(agent, state, onSave) {
  const dialog = $('#edit-dialog');
  const { rawName, titleInput, customInput, groupSelect, noteInput, pinCheck } = buildEditControls(agent, state);
  const hasCustom = Boolean(agent.title || agent.note || agent.pinned || agent.movedTo);
  const submit = async payload => { await onSave(agent.id, payload); dialog.close(); };
  mount(dialog, el('form', {
    class: 'dialog-box edit-box',
    onsubmit: event => {
      event.preventDefault();
      let group = groupSelect.value || null;
      if (group === '__new__') {
        const custom = customInput.value.trim();
        if (!custom) { customInput.focus(); return; }
        group = `custom:${custom}`;
      }
      submit({ title: titleInput.value.trim() || null, note: noteInput.value.trim() || null, pinned: pinCheck.checked, group })
        .catch(err => showToast(err?.message || '保存失败'));
    },
  },
    el('div', { class: 'dialog-head' }, el('strong', { text: '编辑会话' }), el('button', { type: 'button', class: 'btn btn-xs', onclick: () => dialog.close() }, '关闭')),
    el('div', { class: 'dialog-body' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: '显示名称' }), titleInput, el('span', { class: 'muted field-sub', text: `留空则恢复原名：${rawName}` })),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: '所属分组' }), groupSelect, customInput),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: '会话备注' }), noteInput),
      el('label', { class: 'switch-row' }, pinCheck, el('span', { text: '在所属分组内置顶此会话' })),
    ),
    el('div', { class: 'dialog-foot' },
      hasCustom ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => submit({ title: null, note: null, pinned: false, group: null }).catch(err => showToast(err?.message || '重置失败')) }, glyph(paths.undo), '恢复默认') : el('span'),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, '取消'),
        el('button', { type: 'submit', class: 'btn primary' }, '保存'),
      ),
    ),
  ));
  dialog.showModal();
  titleInput.focus();
  titleInput.select();
}

export function agentMenu(a, x, y, state, actions) {
  const active = working.has(a.status);
  const groups = [...buildGroups(state.agents, state).values()].filter(g => g.agents.length || g.info.custom);
  const current = currentAgentGroupKey(a, state.agents);
  const sid = agentSessionId(a);
  openMenu([
    { label: '打开', icon: paths.open, sc: '↵', run: () => actions.onSelect(a.id) },
    { label: '编辑会话…', icon: paths.pen, sc: 'E', run: () => actions.onEdit(a) },
    { label: a.pinned ? '取消置顶' : '置顶会话', icon: paths.pin, run: () => actions.onPin(a) },
    {
      label: a.archived ? '取消归档' : '归档会话',
      icon: a.archived ? paths.unarchive : paths.archive,
      sc: 'A',
      disabled: active && !a.archived,
      run: () => actions.onArchive([a.id], !a.archived, a.name || a.id.slice(0, 8)),
    },
    '-',
    { label: '标记为已结束', icon: paths.check, disabled: active || doneStatuses.has(a.status), run: () => actions.onMark(a.id, 'completed') },
    { label: '关闭会话', icon: paths.close, disabled: active || a.status === 'closed', run: () => actions.onMark(a.id, 'closed') },
    a.marked ? { label: '取消手动标记', icon: paths.undo, run: () => actions.onMark(a.id, null) } : null,
    {
      label: '移动到',
      icon: paths.move,
      sub: [
        ...groups.filter(g => g.key !== current).slice(0, 30).map(g => ({ label: g.name, icon: paths.folder, run: () => actions.onMove(a.id, g.key) })),
        groups.length > 1 ? '-' : null,
        {
          label: '新建分组…',
          icon: paths.plus,
          run: async () => {
            const name = await promptDialog('新建分组', '', '会话会移到这个分组；只改变面板里的显示。');
            if (name) await actions.onMove(a.id, `custom:${name}`);
          },
        },
        a.movedTo ? { label: '移回原分组', icon: paths.undo, run: () => actions.onMove(a.id, null) } : null,
      ],
    },
    '-',
    { label: '复制会话身份', icon: paths.copy, run: () => copyText(a.id, '已复制会话身份') },
    sid ? { label: '复制父会话编号', icon: paths.copy, run: () => copyText(sid, '已复制父会话编号') } : null,
    { label: '复制工作目录', icon: paths.copy, disabled: !a.cwd, run: () => copyText(a.cwd, '已复制工作目录') },
  ], x, y);
}

const FINISHED = new Set(['completed', 'completed-verified', 'completed-unverified', 'failed', 'interrupted', 'stopped', 'closed']);

export function groupMenu(g, x, y, state, actions) {
  const archivable = g.agents.filter(a => FINISHED.has(a.status) && !a.archived);
  const unarchivable = g.agents.filter(a => a.archived);
  const closable = g.agents.filter(a => !working.has(a.status) && a.status !== 'closed');
  const inArchivedView = state.filter === 'archived';
  openMenu([
    { header: g.info.cwd || g.name },
    { label: state.collapsed.has(g.key) ? '展开' : '折叠', icon: paths.fold, run: () => actions.onToggleGroup(g.key) },
    {
      label: '重命名分组…',
      icon: paths.pen,
      run: async () => {
        const name = await promptDialog('重命名分组', g.name, '只改变面板里的显示名称。');
        if (name) await actions.onRenameGroup(g.key, name);
      },
    },
    Object.hasOwn(state.groupNames, g.key) ? { label: '恢复默认名称', icon: paths.undo, run: () => actions.onRenameGroup(g.key, null) } : null,
    g.info.sessionId ? { label: '复制父会话编号', icon: paths.copy, run: () => copyText(g.info.sessionId, '已复制父会话编号') } : null,
    { label: '复制目录', icon: paths.copy, disabled: !g.info.cwd, run: () => copyText(g.info.cwd, '已复制目录') },
    '-',
    inArchivedView
      ? {
          label: `取消归档本组会话（${unarchivable.length}）`,
          icon: paths.unarchive,
          disabled: !unarchivable.length,
          run: () => actions.onArchive(unarchivable.map(a => a.id), false),
        }
      : {
          label: `归档本组已结束会话（${archivable.length}）`,
          icon: paths.archive,
          disabled: !archivable.length,
          run: () => actions.onArchive(archivable.map(a => a.id), true),
        },
    {
      label: `关闭本组不在工作的会话（${closable.length}）`,
      icon: paths.close,
      danger: true,
      disabled: !closable.length,
      run: () => actions.onBatchClose(closable),
    },
  ], x, y);
}

export function createSessionActions({ state, post, refresh, onSelect, onSwitchTab, onToggleGroup }) {
  const saveMeta = (id, patch) => post(`/api/agents/${id}/meta`, patch);
  const onEdit = a => openEditDialog(a, state, async (id, patch) => {
    await saveMeta(id, patch);
    showToast('会话信息已保存');
    await refresh(true);
  });
  const onPin = async a => {
    await saveMeta(a.id, { pinned: !a.pinned });
    showToast(a.pinned ? '已取消置顶' : '已置顶会话');
    await refresh(true);
  };
  const onArchive = async (agentIds, archived, label = '') => {
    let res;
    try { res = await post('/api/agents/archive', { agentIds, archived }); }
    catch (err) { showToast(err?.message || '操作失败'); return; }
    const n = res.updatedIds.length;
    if (!n) { showToast(res.skippedIds.length ? '运行或等待中的会话不可归档' : '没有可变更的会话'); return; }
    const msg = archived
      ? (n === 1 && label ? `已归档“${label}”` : `已归档 ${n} 个会话`) + (res.skippedIds.length ? `（跳过 ${res.skippedIds.length} 个活跃会话）` : '')
      : (n === 1 && label ? `已恢复“${label}”` : `已恢复 ${n} 个会话`);
    await refresh(true);
    showToast(msg, { label: '撤销', run: async () => {
      await post('/api/agents/archive', { agentIds: res.updatedIds, archived: !archived });
      await refresh(true);
      if (archived && res.updatedIds.length === 1 && label) onSelect(res.updatedIds[0]);
    } });
  };
  const onMark = async (id, status) => {
    await post(`/api/agents/${id}/mark`, { status });
    showToast(status === 'closed' ? '已标记为已关闭' : status === 'completed' ? '已标记为已结束' : '已取消标记');
    await refresh(true);
  };
  const onMove = async (id, group) => {
    await post(`/api/agents/${id}/move`, { group });
    showToast(group ? '已移动' : '已移回原分组');
    await refresh(true);
  };
  const onRenameGroup = async (key, name) => {
    await post('/api/groups', { key, name });
    showToast(name ? '已重命名' : '已恢复默认名称');
    await refresh(true);
  };
  const onBatchClose = async closable => {
    const res = await post('/api/agents/batch-mark', { agentIds: closable.map(a => a.id), status: 'closed' });
    showToast(res.skippedIds.length ? `已关闭 ${res.updatedIds.length}/${closable.length} 个会话` : `已关闭 ${res.updatedIds.length} 个会话`);
    await refresh(true);
  };
  return { onSelect, onEdit, onPin, onArchive, onMark, onMove, onRenameGroup, onBatchClose, onSwitchTab, onToggleGroup };
}
