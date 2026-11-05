import { h, delegate } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, promptDialog, confirmDialog } from '../core/ui.js';
import { uid, posBetween, fmtDate } from '../core/util.js';
import { go } from '../core/router.js';
import { api, friendlyError } from '../data/api.js';

export const DEFAULT_PATHS = ['Morning', 'Afternoon', 'Atemporal', 'Futures', 'Cache'];

// "Now" marker for time-of-day paths.
function isNow(title) {
  const t = title.trim().toLowerCase();
  const hr = new Date().getHours();
  if (t === 'morning') return hr >= 4 && hr < 12;
  if (t === 'afternoon') return hr >= 12 && hr < 18;
  if (t === 'evening') return hr >= 18 && hr < 22;
  if (t === 'night' || t === 'nighttime' || t === 'tonight') return hr >= 22 || hr < 4;
  return false;
}

let seeding = null;

export function mountPaths(root, initialOpen = null) {
  let columns = [];
  let tasks = [];
  let loading = true;
  let loadError = null;
  let composerFor = null;      // column id with the add-task composer open
  let editing = null;          // { id, field: 'title' | 'note' }
  let renamingCol = null;      // column id being renamed inline
  let suppressClick = false;
  let drag = null;
  let openCol = initialOpen;   // mobile: the path being viewed (null = tile grid)
  let openedFromGrid = false;
  const mq = window.matchMedia('(max-width: 720px)');
  const isMobile = () => mq.matches;
  const onMq = () => render();
  mq.addEventListener?.('change', onMq);

  const el = h('div', { class: 'view paths' });
  root.append(el);

  const fail = (e) => toast(`Not saved — ${friendlyError(e)}`, { tone: 'error', ms: 5000 });
  const tasksOf = (colId) => tasks.filter((t) => t.column_id === colId).sort((a, b) => a.position - b.position);
  const sortCols = () => columns.sort((a, b) => a.position - b.position);

  async function load() {
    try {
      const [cols, ts] = await Promise.all([
        api.db.select('path_columns', { order: 'position.asc' }),
        api.db.select('path_tasks', { order: 'position.asc' }),
      ]);
      columns = cols;
      tasks = ts;
      if (!columns.length) {
        seeding = seeding || api.db.insert('path_columns', DEFAULT_PATHS.map((title, i) => ({ id: uid(), title, position: (i + 1) * 1024 })));
        columns = await seeding;
        seeding = null;
      }
      sortCols();
    } catch (e) {
      loadError = friendlyError(e);
    }
    loading = false;
    render();
  }

  /* ---------------- Rendering ---------------- */

  // Progress line on the left border of each path. Renders at the last value, then eases to the new one.
  const lastPct = new Map();
  function progressBar(colId, list) {
    const done = list.filter((t) => t.done).length;
    const pct = list.length ? done / list.length : 0;
    const from = lastPct.has(colId) ? lastPct.get(colId) : pct;
    lastPct.set(colId, pct);
    const bar = h('i', { class: ['pcol-progress', list.length && pct === 1 && 'is-full'], 'aria-hidden': 'true' }, h('b'));
    bar.style.setProperty('--p', String(from));
    if (from !== pct) requestAnimationFrame(() => requestAnimationFrame(() => bar.style.setProperty('--p', String(pct))));
    return bar;
  }

  // While a pointer is pressed, defer re-rendering until after the click lands —
  // otherwise a blur-triggered render would swap the button out from under the click.
  let pointerDown = false;
  let pendingRender = false;
  let rendering = false; // focusout fired by our own DOM swap must be ignored
  const onDocDown = () => { pointerDown = true; };
  const onDocUp = () => {
    pointerDown = false;
    if (pendingRender) setTimeout(() => { if (pendingRender) render(); }, 0);
  };
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('pointerup', onDocUp, true);

  function render() {
    if (pointerDown && !drag) { pendingRender = true; return; }
    pendingRender = false;
    const scroller = el.querySelector('.pboard');
    const scrollLeft = scroller ? scroller.scrollLeft : 0;
    const detail = mobileDetailCol();
    el.classList.toggle('is-mobile-detail', !!detail);
    rendering = true;
    try { el.replaceChildren(...(detail ? [detailHeader(detail), detailBody(detail)] : [header(), body()])); } finally { rendering = false; }
    const next = el.querySelector('.pboard');
    if (next) next.scrollLeft = scrollLeft;
    focusActive();
  }

  function header() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const segs = 24;
    const filled = total ? Math.round((done / total) * segs) : 0;
    return h('header', { class: 'view-head' },
      h('h1', { class: 'dot-title' }, 'Paths'),
      h('div', { class: 'paths-meta' },
        h('span', { class: 'label' }, fmtDate()),
        h('div', { class: 'meter', role: 'img', 'aria-label': `${done} of ${total} tasks done` },
          Array.from({ length: segs }, (_, i) => h('i', { class: i < filled ? 'on' : null }))),
        h('span', { class: 'meter-count' }, `${done}/${total}`)));
  }

  function mobileDetailCol() {
    if (!isMobile() || !openCol || loading || loadError) return null;
    return columns.find((c) => c.id === openCol) || null;
  }

  function openPath(id) { openedFromGrid = true; go(`paths/${id}`); }
  function closePath() {
    if (openedFromGrid) { openedFromGrid = false; history.back(); }
    else go('paths');
  }

  // Mobile: a grid of path tiles, like app icons.
  function tiles() {
    return h('div', { class: 'ptiles' },
      columns.map((col) => {
        const list = tasksOf(col.id);
        const done = list.filter((t) => t.done).length;
        const left = list.length - done;
        const now = isNow(col.title);
        return h('button', { class: ['ptile', now && 'is-now'], type: 'button', 'data-act': 'open-col', 'data-col': col.id, 'aria-label': `${col.title}, ${left} to do` },
          progressBar(col.id, list),
          h('div', { class: 'ptile-top' },
            h('span', { class: 'ptile-count' }, String(left)),
            now ? h('span', { class: 'now-tag' }, h('i'), 'Now') : null),
          h('div', { class: 'ptile-bottom' },
            list.length ? h('div', { class: 'ptile-dots', 'aria-hidden': 'true' }, list.slice(0, 18).map((t) => h('i', { class: t.done ? 'on' : null }))) : null,
            h('span', { class: 'ptile-name' }, col.title)));
      }),
      h('button', { class: 'ptile is-new', type: 'button', 'data-act': 'new-col' }, icon('plus', 22), h('span', { class: 'ptile-name' }, 'New path')));
  }

  function detailHeader(col) {
    const list = tasksOf(col.id);
    const done = list.filter((t) => t.done).length;
    const renaming = renamingCol === col.id;
    return h('header', { class: 'pdetail-head', 'data-col': col.id },
      h('div', { class: 'pdetail-bar' },
        h('button', { class: 'pback', type: 'button', 'data-act': 'close-col' }, icon('back', 16), 'Paths'),
        h('button', { class: 'icon-btn', type: 'button', 'data-act': 'col-menu', 'aria-label': `${col.title} options` }, icon('more', 18))),
      renaming
        ? h('input', { class: 'pcol-rename pdetail-rename', value: col.title, maxlength: 40, 'data-rename': col.id, 'aria-label': 'Path name' })
        : h('h1', { class: 'dot-title pdetail-title' }, col.title),
      h('div', { class: 'paths-meta' },
        isNow(col.title) ? h('span', { class: 'now-tag' }, h('i'), 'Now') : null,
        h('span', { class: 'label' }, list.length ? `${list.length - done} to do` : 'Empty'),
        h('span', { class: 'meter-count' }, `${done}/${list.length}`)));
  }

  function detailBody(col) {
    return h('section', { class: 'pcol is-full', 'data-col': col.id, 'aria-label': col.title },
      h('div', { class: 'pcol-list', 'data-list': col.id },
        tasksOf(col.id).map(taskView),
        composerFor === col.id ? composerView(col) : null),
      composerFor !== col.id
        ? h('button', { class: 'pcol-add', 'data-act': 'add-task' }, icon('plus', 16), h('span', {}, 'Add task'))
        : null);
  }

  function body() {
    if (!loading && !loadError && isMobile()) return tiles();
    if (loading) return h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
    if (loadError) return h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, loadError), h('button', { class: 'btn', onclick: () => { loading = true; loadError = null; render(); load(); } }, 'Try again'));
    return h('div', { class: 'pboard' },
      columns.map(columnView),
      h('button', { class: 'pcol-new', 'data-act': 'new-col' }, icon('plus', 18), h('span', {}, 'New path')));
  }

  function columnView(col) {
    const list = tasksOf(col.id);
    const done = list.filter((t) => t.done).length;
    const now = isNow(col.title);
    const renaming = renamingCol === col.id;
    return h('section', { class: ['pcol', now && 'is-now'], 'data-col': col.id, 'aria-label': col.title },
      progressBar(col.id, list),
      h('header', { class: 'pcol-head' },
        renaming
          ? h('input', { class: 'pcol-rename', value: col.title, maxlength: 40, 'data-rename': col.id, 'aria-label': 'Path name' })
          : h('h2', { class: 'pcol-title', 'data-act': 'rename-col', title: 'Double-click to rename' }, col.title),
        now ? h('span', { class: 'now-tag' }, h('i'), 'Now') : null,
        h('span', { class: 'pcol-count', 'aria-label': `${done} of ${list.length} done` }, list.length ? `${done}/${list.length}` : '0'),
        h('button', { class: 'icon-btn sm', 'data-act': 'col-menu', 'aria-label': `${col.title} options` }, icon('more', 16)),
        h('button', { class: 'icon-btn sm', 'data-act': 'add-task', 'aria-label': `Add task to ${col.title}` }, icon('plus', 16))),
      list.length ? h('div', { class: 'pcol-dots', 'aria-hidden': 'true' }, list.slice(0, 40).map((t) => h('i', { class: t.done ? 'on' : null }))) : null,
      h('div', { class: 'pcol-list', 'data-list': col.id },
        list.map(taskView),
        composerFor === col.id ? composerView(col) : null),
      composerFor !== col.id
        ? h('button', { class: 'pcol-add', 'data-act': 'add-task' }, icon('plus', 16), h('span', {}, 'Add task'))
        : null);
  }

  function taskView(t) {
    const editTitle = editing?.id === t.id && editing.field === 'title';
    const editNote = editing?.id === t.id && editing.field === 'note';
    return h('article', { class: ['ptask', t.done && 'is-done', (editTitle || editNote) && 'is-editing'], 'data-task': t.id },
      h('button', {
        class: 'pcheck', 'data-act': 'toggle', role: 'checkbox', 'aria-checked': String(!!t.done),
        'aria-label': `${t.done ? 'Mark not done' : 'Mark done'}: ${t.title}`,
      }, icon('check', 12, { weight: 2.4 })),
      h('div', { class: 'ptask-body' },
        editTitle
          ? textEditor(t.title, 'title')
          : h('div', { class: 'ptask-title', 'data-act': 'edit-title' }, t.title || 'Untitled'),
        editNote
          ? textEditor(t.note, 'note')
          : t.note ? h('div', { class: 'ptask-note', 'data-act': 'edit-note' }, t.note) : null),
      h('button', { class: 'icon-btn xs ptask-more', 'data-act': 'task-menu', 'aria-label': 'Task options' }, icon('more', 16)));
  }

  function textEditor(value, field) {
    return h('textarea', {
      class: ['ptask-input', field === 'note' && 'is-note'],
      rows: 1,
      'data-editor': field,
      placeholder: field === 'note' ? 'Add a note' : 'Task',
      'aria-label': field === 'note' ? 'Note' : 'Task title',
      value: value || '',
    });
  }

  function composerView(col) {
    return h('div', { class: 'ptask is-composer' },
      h('span', { class: 'pcheck is-ghost', 'aria-hidden': 'true' }),
      h('textarea', { class: 'ptask-input', rows: 1, 'data-composer': col.id, placeholder: 'What needs doing?', 'aria-label': `New task in ${col.title}` }));
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function focusActive() {
    const ta = el.querySelector('[data-editor], [data-composer], [data-rename]');
    if (!ta) return;
    if (ta.tagName === 'TEXTAREA') autosize(ta);
    ta.focus();
    const len = ta.value.length;
    if (ta.dataset.rename) ta.select();
    else ta.setSelectionRange(len, len);
  }

  /* ---------------- Mutations ---------------- */

  async function addTask(colId, title) {
    const list = tasksOf(colId);
    const t = { id: uid(), column_id: colId, title, note: '', done: false, position: posBetween(list.at(-1)?.position ?? null, null) };
    tasks.push(t);
    render();
    try { await api.db.insert('path_tasks', t); } catch (e) { fail(e); }
  }

  async function patchTask(t, patch) {
    Object.assign(t, patch);
    render();
    try { await api.db.update('path_tasks', t.id, patch); } catch (e) { fail(e); }
  }

  async function deleteTask(t) {
    tasks = tasks.filter((x) => x.id !== t.id);
    render();
    try { await api.db.remove('path_tasks', t.id); } catch (e) { fail(e); }
  }

  async function duplicateTask(t) {
    const list = tasksOf(t.column_id);
    const i = list.findIndex((x) => x.id === t.id);
    const copy = { ...t, id: uid(), done: false, position: posBetween(t.position, list[i + 1]?.position ?? null) };
    delete copy.created_at; delete copy.updated_at; delete copy.user_id;
    tasks.push(copy);
    render();
    try { await api.db.insert('path_tasks', copy); } catch (e) { fail(e); }
  }

  async function moveTask(t, colId, position) {
    t.column_id = colId;
    t.position = position;
    render();
    try { await api.db.update('path_tasks', t.id, { column_id: colId, position }); } catch (e) { fail(e); }
  }

  async function addColumn() {
    const title = await promptDialog('New path', { placeholder: 'e.g. Evening', ok: 'Create path', label: 'Name' });
    if (!title) return;
    const col = { id: uid(), title, position: posBetween(columns.at(-1)?.position ?? null, null) };
    columns.push(col);
    render();
    el.querySelector('.pboard')?.scrollTo({ left: 1e6, behavior: 'smooth' });
    try { await api.db.insert('path_columns', col); } catch (e) { fail(e); }
  }

  async function renameColumn(col, title) {
    renamingCol = null;
    title = title.trim();
    if (!title || title === col.title) { render(); return; }
    col.title = title;
    render();
    try { await api.db.update('path_columns', col.id, { title }); } catch (e) { fail(e); }
  }

  async function shiftColumn(col, dir) {
    const i = columns.indexOf(col);
    const j = i + dir;
    if (j < 0 || j >= columns.length) return;
    const other = columns[j];
    [col.position, other.position] = [other.position, col.position];
    sortCols();
    render();
    try {
      await Promise.all([
        api.db.update('path_columns', col.id, { position: col.position }),
        api.db.update('path_columns', other.id, { position: other.position }),
      ]);
    } catch (e) { fail(e); }
  }

  async function clearDone(col) {
    const ids = tasksOf(col.id).filter((t) => t.done).map((t) => t.id);
    if (!ids.length) return;
    tasks = tasks.filter((t) => !ids.includes(t.id));
    render();
    toast(`Cleared ${ids.length} done ${ids.length === 1 ? 'task' : 'tasks'}`);
    try { await api.db.remove('path_tasks', ids); } catch (e) { fail(e); }
  }

  async function deleteColumn(col) {
    const n = tasksOf(col.id).length;
    const ok = await confirmDialog(`Delete “${col.title}”?`, n ? `Its ${n} ${n === 1 ? 'task' : 'tasks'} will be deleted too.` : 'This path is empty.', { ok: 'Delete path' });
    if (!ok) return;
    const ids = tasksOf(col.id).map((t) => t.id);
    columns = columns.filter((c) => c.id !== col.id);
    if (openCol === col.id) { openCol = null; if (isMobile()) go('paths'); }
    tasks = tasks.filter((t) => t.column_id !== col.id);
    render();
    try {
      if (ids.length) await api.db.remove('path_tasks', ids);
      await api.db.remove('path_columns', col.id);
    } catch (e) { fail(e); }
  }

  /* ---------------- Events ---------------- */

  const taskOf = (node) => tasks.find((t) => t.id === node.closest('[data-task]')?.dataset.task);
  const colOf = (node) => columns.find((c) => c.id === node.closest('[data-col]')?.dataset.col);
  const offs = [];

  offs.push(delegate(el, 'click', '[data-act]', (e, t) => {
    if (suppressClick) return;
    const act = t.dataset.act;
    const task = taskOf(t);
    const col = colOf(t);
    if (act === 'toggle' && task) patchTask(task, { done: !task.done });
    else if (act === 'edit-title' && task) { editing = { id: task.id, field: 'title' }; composerFor = null; render(); }
    else if (act === 'edit-note' && task) { editing = { id: task.id, field: 'note' }; composerFor = null; render(); }
    else if (act === 'add-task' && col) { composerFor = col.id; editing = null; render(); }
    else if (act === 'new-col') addColumn();
    else if (act === 'task-menu' && task) taskMenu(t, task);
    else if (act === 'col-menu' && col) colMenu(t, col);
    else if (act === 'open-col' && col) openPath(col.id);
    else if (act === 'close-col') closePath();
  }));

  offs.push(delegate(el, 'dblclick', '[data-act="rename-col"]', (e, t) => {
    const col = colOf(t);
    if (!col) return;
    renamingCol = col.id;
    render();
  }));

  function taskMenu(anchor, task) {
    const others = columns.filter((c) => c.id !== task.column_id);
    menu(anchor, [
      { label: 'Edit task', icon: 'edit', onSelect: () => { editing = { id: task.id, field: 'title' }; render(); } },
      { label: task.note ? 'Edit note' : 'Add note', icon: 'note', onSelect: () => { editing = { id: task.id, field: 'note' }; render(); } },
      { label: task.done ? 'Mark not done' : 'Mark done', icon: 'check', onSelect: () => patchTask(task, { done: !task.done }) },
      { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateTask(task) },
      '-',
      { header: 'Move to' },
      ...others.map((c) => ({
        label: c.title, icon: 'toPaths',
        onSelect: () => moveTask(task, c.id, posBetween(tasksOf(c.id).at(-1)?.position ?? null, null)),
      })),
      '-',
      { label: 'Delete task', icon: 'trash', danger: true, onSelect: () => deleteTask(task) },
    ], { align: 'end' });
  }

  function colMenu(anchor, col) {
    const i = columns.indexOf(col);
    const doneCount = tasksOf(col.id).filter((t) => t.done).length;
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onSelect: () => { renamingCol = col.id; render(); } },
      { label: 'Move left', icon: 'chevronLeft', disabled: i === 0, onSelect: () => shiftColumn(col, -1) },
      { label: 'Move right', icon: 'chevronRight', disabled: i === columns.length - 1, onSelect: () => shiftColumn(col, 1) },
      { label: doneCount ? `Clear ${doneCount} done` : 'Clear done', icon: 'check', disabled: !doneCount, onSelect: () => clearDone(col) },
      '-',
      { label: 'Delete path', icon: 'trash', danger: true, onSelect: () => deleteColumn(col) },
    ], { align: 'end' });
  }

  // Inline editors: commit on Enter / blur, cancel on Escape.
  el.addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA') autosize(e.target);
  });

  el.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.dataset.composer) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = t.value.trim();
        t.value = '';
        if (v) addTask(t.dataset.composer, v);   // keeps composer open for rapid entry
        else { composerFor = null; render(); }
      } else if (e.key === 'Escape') { composerFor = null; render(); }
    } else if (t.dataset.editor) {
      const note = t.dataset.editor === 'note';
      if (e.key === 'Escape') { editing = null; render(); }
      else if (e.key === 'Enter' && (!note || e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); t.blur(); }
    } else if (t.dataset.rename) {
      if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      else if (e.key === 'Escape') { renamingCol = null; render(); }
    }
  });

  el.addEventListener('focusout', (e) => {
    if (rendering) return;
    const t = e.target;
    if (t.dataset.composer) {
      const v = t.value.trim();
      const colId = t.dataset.composer;
      composerFor = null;
      if (v) addTask(colId, v); else render();
    } else if (t.dataset.editor && editing) {
      const task = tasks.find((x) => x.id === editing.id);
      const field = editing.field;
      editing = null;
      if (!task) { render(); return; }
      const v = field === 'title' ? t.value.replace(/\s+/g, ' ').trim() : t.value.trim();
      if (field === 'title' && !v) { render(); return; }
      if (v !== (task[field] || '')) patchTask(task, { [field]: v }); else render();
    } else if (t.dataset.rename) {
      const col = columns.find((c) => c.id === t.dataset.rename);
      if (col) renameColumn(col, t.value); else { renamingCol = null; render(); }
    }
  });

  /* ---------------- Drag and drop (mouse / pen) ---------------- */

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const card = e.target.closest('.ptask:not(.is-composer):not(.is-editing)');
    if (!card || e.target.closest('button, textarea, input')) return;
    drag = { card, id: card.dataset.task, x0: e.clientX, y0: e.clientY, started: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    window.addEventListener('pointercancel', onDragEnd, { once: true });
  });

  function beginDrag(e) {
    const r = drag.card.getBoundingClientRect();
    drag.started = true;
    drag.dx = e.clientX - r.left;
    drag.dy = e.clientY - r.top;
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add('ptask-ghost');
    Object.assign(drag.ghost.style, { width: `${r.width}px`, left: '0px', top: '0px' });
    drag.ph = h('div', { class: 'ptask-ph', style: { height: `${r.height}px` } });
    drag.card.after(drag.ph);
    drag.card.style.display = 'none';
    document.body.append(drag.ghost);
    document.body.classList.add('is-dragging');
  }

  function onDragMove(e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      beginDrag(e);
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const colEl = under?.closest('.pcol');
    if (colEl) {
      const list = colEl.querySelector('.pcol-list');
      const cards = [...list.querySelectorAll('.ptask:not(.is-composer)')].filter((c) => c !== drag.card);
      const before = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (before) { if (drag.ph.nextSibling !== before) list.insertBefore(drag.ph, before); }
      else {
        const composer = list.querySelector('.is-composer');
        if (composer) list.insertBefore(drag.ph, composer);
        else if (list.lastElementChild !== drag.ph) list.append(drag.ph);
      }
    }
    const board = el.querySelector('.pboard');
    if (board) {
      const br = board.getBoundingClientRect();
      if (e.clientX < br.left + 60) board.scrollLeft -= 14;
      else if (e.clientX > br.right - 60) board.scrollLeft += 14;
    }
    if (e.clientY < 80) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    const d = drag;
    drag = null;
    if (!d?.started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    document.body.classList.remove('is-dragging');
    d.ghost.remove();
    const colEl = d.ph.closest('.pcol');
    const task = tasks.find((t) => t.id === d.id);
    const sib = (node, dir) => {
      let n = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
      while (n && (n === d.card || !n.dataset.task)) n = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
      return n ? tasks.find((t) => t.id === n.dataset.task) : null;
    };
    const prev = sib(d.ph, -1);
    const next = sib(d.ph, 1);
    d.card.style.display = '';
    d.ph.remove();
    if (!task || !colEl) { render(); return; }
    const colId = colEl.dataset.col;
    const orig = tasksOf(task.column_id);
    const idx = orig.indexOf(task);
    if (task.column_id === colId && prev?.id === orig[idx - 1]?.id && next?.id === orig[idx + 1]?.id) {
      render();
      return; // dropped where it started
    }
    moveTask(task, colId, posBetween(prev?.position ?? null, next?.position ?? null));
  }

  const nowTimer = setInterval(() => {
    if (!editing && !composerFor && !renamingCol && !drag) render();
  }, 60_000);

  render();
  load();

  return {
    update(r) {
      openCol = r.id || null;
      composerFor = null; editing = null; renamingCol = null;
      render();
      window.scrollTo(0, 0);
    },
    destroy() {
      mq.removeEventListener?.('change', onMq);
      clearInterval(nowTimer);
      offs.forEach((f) => f());
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('pointerup', onDocUp, true);
      window.removeEventListener('pointermove', onDragMove);
      document.body.classList.remove('is-dragging');
      drag?.ghost?.remove();
      el.remove();
    },
  };
}
