import { h, delegate, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, promptDialog, confirmDialog, dialog } from '../core/ui.js';
import { uid, posBetween, fmtDate, plural } from '../core/util.js';
import { go } from '../core/router.js';
import { api, friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref, prefsOf } from '../data/prefs.js';
import { printToPdf, pdfHint } from '../core/print.js';
import { windowOf, stateOf, clock, logSetpoints, dayStart } from '../data/setpoints.js';

export const DEFAULT_PATHS = ['Morning', 'Afternoon', 'Atemporal', 'Futures', 'Cache'];
const DEFAULT_TITLE = 'Paths';

let seeding = null;

// Embedded (space widget) options:
//   owner      whose paths to show (default: you). Someone else's paths are read-only.
//   exclude    column ids shown elsewhere on the canvas (detached columns)
//   only       show just this one column (a detached column widget)
//   onDetach(colId, at)  pull a column out onto the canvas · onSnap()  put a detached column back
export function mountPaths(root, initialOpen = null, opts = {}) {
  const embedded = !!opts.embedded;
  const me = api.auth.current()?.user?.id;
  const owner = opts.owner || me;
  const readOnly = owner !== me;
  const instance = Math.random().toString(36).slice(2);
  let exclude = new Set(opts.exclude || []);
  let ownerTimes = null;       // someone else's setpoint windows
  let active = false;          // embedded: keyboard shortcuts only while you're working in this widget
  // Writes from a widget tell the other widgets showing the same paths to refresh.
  const db = embedded ? new Proxy(api.db, {
    get(t, k) {
      const fn = t[k];
      if (typeof fn !== 'function' || !['insert', 'update', 'remove'].includes(k)) return fn?.bind?.(t) ?? fn;
      return async (...args) => {
        const out = await fn.apply(t, args);
        window.dispatchEvent(new CustomEvent('architect:paths-changed', { detail: { owner, from: instance } }));
        return out;
      };
    },
  }) : api.db;
  const timesArg = () => (readOnly ? (ownerTimes?.pathTimes || {}) : undefined);
  const stOf = (col) => stateOf(col, columns, new Date(), timesArg());
  const winOf = (col) => windowOf(col, timesArg());
  let columns = [];
  let tasks = [];
  let loading = true;
  let loadError = null;
  let composerFor = null;      // column id with the add-task composer open
  let editing = null;          // { id, field: 'title' | 'note' }
  let renamingCol = null;      // column id being renamed inline
  let renamingTitle = false;   // the page title
  let suppressClick = false;
  let drag = null;             // task drag
  let colDrag = null;          // path (column) drag
  let marquee = null;          // lasso selection
  let picked = new Set();      // selected task ids
  let anchorId = null;         // last task clicked, for shift-click ranges
  let hoverCol = null;
  let openCol = initialOpen;   // mobile: the path being viewed (null = tile grid)
  let openedFromGrid = false;
  let title = DEFAULT_TITLE;
  const mq = window.matchMedia('(max-width: 720px)');
  const isMobile = () => !embedded && mq.matches;
  const onMq = () => render();
  mq.addEventListener?.('change', onMq);

  const el = h('div', { class: ['view paths', embedded && 'is-embedded', readOnly && 'is-readonly', opts.only && 'is-single'] });
  root.append(el);

  const fail = (e) => toast(`Not saved — ${friendlyError(e)}`, { tone: 'error', ms: 5000 });
  const tasksOf = (colId) => tasks.filter((t) => t.column_id === colId).sort((a, b) => a.position - b.position);
  const sortCols = () => columns.sort((a, b) => a.position - b.position);
  // Tasks in on-screen order: path by path, top to bottom.
  const shown = () => columns.filter((c) => (opts.only ? c.id === opts.only : !exclude.has(c.id)));
  const ordered = () => shown().flatMap((c) => tasksOf(c.id));
  const pickedTasks = () => ordered().filter((t) => picked.has(t.id));

  async function load() {
    try {
      const [cols, ts] = await Promise.all([
        api.db.select('path_columns', { order: 'position.asc', filters: owner ? { user_id: owner } : {} }),
        api.db.select('path_tasks', { order: 'position.asc', filters: owner ? { user_id: owner } : {} }),
        loadPrefs(),
        readOnly ? prefsOf(owner).then((p) => { ownerTimes = p; }) : null,
      ]);
      columns = cols;
      tasks = ts;
      title = getPref('pathsTitle', DEFAULT_TITLE) || DEFAULT_TITLE;
      if (!columns.length && !readOnly) {
        seeding = seeding || db.insert('path_columns', DEFAULT_PATHS.map((t, i) => ({ id: uid(), title: t, position: (i + 1) * 1024 })));
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
    if (pointerDown && !drag && !colDrag && !marquee) { pendingRender = true; return; }
    pendingRender = false;
    const scroller = el.querySelector('.pboard');
    const scrollLeft = scroller ? scroller.scrollLeft : 0;
    const detail = mobileDetailCol();
    el.classList.toggle('is-mobile-detail', !!detail);
    el.classList.toggle('is-picking', picked.size > 0);
    rendering = true;
    try { el.replaceChildren(...(detail ? [detailHeader(detail), detailBody(detail)] : embedded ? [body()] : [header(), body()])); } finally { rendering = false; }
    const next = el.querySelector('.pboard');
    if (next) next.scrollLeft = scrollLeft;
    renderSelBar();
    focusActive();
    if (!loading && !loadError) { lastPhases = phases(); if (!readOnly) queueLog(); }
  }

  function header() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const segs = 24;
    const filled = total ? Math.round((done / total) * segs) : 0;
    return h('header', { class: 'view-head paths-head' },
      renamingTitle
        ? h('input', { class: 'paths-title-input', value: title, maxlength: 32, 'data-rename-title': '1', 'aria-label': 'Page title' })
        : h('h1', { class: 'paths-title', 'data-act': 'rename-title', title: 'Click to rename', tabindex: '0' }, title),
      h('div', { class: 'paths-meta' },
        h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'export-pdf', 'aria-label': 'Export as PDF', 'data-tip': 'Export PDF' }, icon('download', 16))));
  }

  // Setpoint countdown. Live: time left (HH:MM:SS). Later today: its full length, dimmed. Ended: 00:00:00.
  function timerView(col, cls = 'pcol-timer') {
    const st = stOf(col);
    if (!st) return null;
    return h('span', {
      class: [cls, `is-${st.phase}`], 'data-timer': col.id, role: 'timer',
      title: st.phase === 'live' ? 'Time left in this setpoint' : st.phase === 'next' ? `Starts in ${clock(st.until)}` : 'Ended for today',
    }, clock(st.left));
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

  // Mobile: a grid of path tiles, like app icons. Long-press a tile to drag it into a new order.
  function tiles() {
    return h('div', { class: 'ptiles' },
      columns.map((col) => {
        const list = tasksOf(col.id);
        const done = list.filter((t) => t.done).length;
        const left = list.length - done;
        const live = stOf(col)?.phase === 'live';
        return h('button', { class: ['ptile', live && 'is-now'], type: 'button', 'data-act': 'open-col', 'data-col': col.id, 'aria-label': `${col.title}, ${left} to do` },
          h('div', { class: 'ptile-top' },
            h('span', { class: 'ptile-count' }, String(left)),
            timerView(col, 'ptile-timer')),
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
        h('button', { class: 'pback', type: 'button', 'data-act': 'close-col' }, icon('back', 16), title),
        h('div', { class: 'pdetail-tools' },
          list.length ? h('button', { class: 'icon-btn', type: 'button', 'data-act': 'select-col', 'aria-label': `Select all in ${col.title}` }, icon('selectAll', 18)) : null,
          h('button', { class: 'icon-btn', type: 'button', 'data-act': 'col-menu', 'aria-label': `${col.title} options` }, icon('more', 18)))),
      renaming
        ? h('input', { class: 'pcol-rename pdetail-rename', value: col.title, maxlength: 40, 'data-rename': col.id, 'aria-label': 'Path name' })
        : h('h1', { class: 'dot-title pdetail-title' }, col.title),
      h('div', { class: 'paths-meta' },
        h('span', { class: 'label' }, list.length ? `${list.length - done} to do` : 'Empty'),
        timerView(col, 'pdetail-timer')));
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
    const cols = shown();
    if (embedded && !cols.length) {
      return h('div', { class: 'pboard is-empty' }, h('p', { class: 'empty-text' }, readOnly ? 'No paths to show.' : opts.only ? 'This path was deleted.' : 'Every path is out on the canvas.'),
        null);
    }
    return h('div', { class: 'pboard' },
      cols.map(columnView),
      // New paths come from a path's ··· menu — no button at the end of the board.
      null);
  }

  function columnView(col) {
    const list = tasksOf(col.id);
    const live = stOf(col)?.phase === 'live';
    const renaming = renamingCol === col.id;
    const allPicked = list.length && list.every((t) => picked.has(t.id));
    return h('section', { class: ['pcol', live && 'is-now', list.length > 10 && 'is-capped'], 'data-col': col.id, 'aria-label': col.title },
      h('header', { class: 'pcol-head', title: renaming || readOnly ? null : embedded ? (opts.only ? 'Drag onto your Path to snap back' : 'Drag to reorder · drag out of the widget to detach') : 'Drag to reorder' },
        renaming
          ? h('input', { class: 'pcol-rename', value: col.title, maxlength: 40, 'data-rename': col.id, 'aria-label': 'Path name' })
          : h('h2', { class: 'pcol-title', 'data-act': 'rename-col', title: 'Double-click to rename · drag to reorder' }, col.title),
        timerView(col),
        list.length && !readOnly ? h('button', { class: ['icon-btn', 'sm', allPicked && 'is-on'], 'data-act': 'select-col', 'aria-label': `Select all in ${col.title}`, 'aria-pressed': String(!!allPicked), 'data-tip': 'Select all' }, icon('selectAll', 16)) : null,
        readOnly ? null : h('button', { class: 'icon-btn sm', 'data-act': 'col-menu', 'aria-label': `${col.title} options` }, icon('more', 16))),
      list.length ? h('div', { class: 'pcol-dots', 'aria-hidden': 'true' }, list.slice(0, 40).map((t) => h('i', { class: t.done ? 'on' : null }))) : null,
      h('div', { class: 'pcol-list', 'data-list': col.id },
        list.map(taskView),
        composerFor === col.id ? composerView(col) : null),
      composerFor !== col.id && !readOnly
        ? h('button', { class: 'pcol-add', 'data-act': 'add-task' }, icon('plus', 16), h('span', {}, 'Add task'))
        : null);
  }

  // "#12" in a task title links to ticket #012 on the Ticket board.
  function titleView(text) {
    const parts = String(text || 'Untitled').split(/(#\d{1,5}\b)/);
    return parts.map((part) => (/^#\d{1,5}$/.test(part)
      ? h('span', { class: 'ptask-ticket', 'data-act': 'open-ticket', 'data-no': String(Number(part.slice(1))), title: 'Open ticket' }, `#${part.slice(1).padStart(3, '0')}`)
      : part));
  }

  function taskView(t) {
    const editTitle = editing?.id === t.id && editing.field === 'title';
    const editNote = editing?.id === t.id && editing.field === 'note';
    const sel = picked.has(t.id);
    return h('article', { class: ['ptask', t.done && 'is-done', (editTitle || editNote) && 'is-editing', sel && 'is-picked', t.private && 'is-private'], 'data-task': t.id, 'aria-selected': picked.size ? String(sel) : null },
      h('button', {
        class: 'pcheck', 'data-act': 'toggle', role: 'checkbox', 'aria-checked': String(!!t.done),
        'aria-label': `${t.done ? 'Mark not done' : 'Mark done'}: ${t.title}`,
      }, icon('check', 12, { weight: 2.4 })),
      h('div', { class: 'ptask-body' },
        editTitle
          ? textEditor(t.title, 'title')
          : h('div', { class: 'ptask-title', 'data-act': 'edit-title' }, t.private ? h('span', { class: 'ptask-lock', title: 'Only you can see this' }, icon('lock', 11)) : null, titleView(t.title)),
        editNote
          ? textEditor(t.note, 'note')
          : t.note ? h('div', { class: 'ptask-note', 'data-act': 'edit-note' }, t.note) : null),
      readOnly ? null : h('button', { class: 'icon-btn xs ptask-more', 'data-act': 'task-menu', 'aria-label': 'Task options' }, icon('more', 16)));
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
    const ta = el.querySelector('[data-editor], [data-composer], [data-rename], [data-rename-title]');
    if (!ta) return;
    if (ta.tagName === 'TEXTAREA') autosize(ta);
    ta.focus();
    const len = ta.value.length;
    if (ta.dataset.rename || ta.dataset.renameTitle) ta.select();
    else ta.setSelectionRange(len, len);
  }

  /* ---------------- Selection ---------------- */

  const renderSelBar = () => {};

  function clearPick() {
    if (!picked.size) return;
    picked = new Set();
    anchorId = null;
    render();
  }

  function togglePick(task, { range = false } = {}) {
    if (range && anchorId) {
      const list = ordered();
      const a = list.findIndex((t) => t.id === anchorId);
      const b = list.findIndex((t) => t.id === task.id);
      if (a >= 0 && b >= 0) {
        const [i, j] = a < b ? [a, b] : [b, a];
        for (const t of list.slice(i, j + 1)) picked.add(t.id);
        render();
        return;
      }
    }
    if (picked.has(task.id)) picked.delete(task.id); else picked.add(task.id);
    anchorId = task.id;
    editing = null; composerFor = null;
    render();
  }

  function selectColumn(col) {
    const ids = tasksOf(col.id).map((t) => t.id);
    const all = ids.length && ids.every((id) => picked.has(id));
    if (all) ids.forEach((id) => picked.delete(id));
    else ids.forEach((id) => picked.add(id));
    editing = null; composerFor = null;
    render();
  }

  async function bulkDone(done) {
    const list = pickedTasks().filter((t) => !!t.done !== done);
    list.forEach((t) => { t.done = done; });
    render();
    try { await Promise.all(list.map((t) => db.update('path_tasks', t.id, { done }))); } catch (e) { fail(e); }
  }

  function bulkMoveMenu(anchor) {
    menu(anchor, [
      { header: 'Move to' },
      ...columns.map((c) => ({ label: c.title, icon: 'toPaths', onSelect: () => bulkMove(c.id) })),
    ], { side: 'top' });
  }

  async function bulkMove(colId, prevPos = undefined, nextPos = undefined) {
    const list = pickedTasks();
    if (!list.length) return;
    const ids = new Set(list.map((t) => t.id));
    if (prevPos === undefined) { prevPos = tasksOf(colId).filter((t) => !ids.has(t.id)).at(-1)?.position ?? null; nextPos = null; }
    // Spread the moved tasks evenly between their new neighbours, keeping their order.
    let lo = prevPos;
    const patches = list.map((t, i) => {
      const hi = nextPos;
      let pos;
      if (lo == null && hi == null) pos = (i + 1) * 1024;
      else if (hi == null) pos = lo + 1024;
      else if (lo == null) pos = hi - 1024 * (list.length - i);
      else pos = lo + (hi - lo) / (list.length - i + 1);
      lo = pos;
      t.column_id = colId;
      t.position = pos;
      return { id: t.id, column_id: colId, position: pos };
    });
    render();
    try { await Promise.all(patches.map((p) => db.update('path_tasks', p.id, { column_id: p.column_id, position: p.position }))); } catch (e) { fail(e); }
  }

  async function bulkDelete() {
    const list = pickedTasks();
    if (!list.length) return;
    const ids = new Set(list.map((t) => t.id));
    tasks = tasks.filter((t) => !ids.has(t.id));
    picked = new Set();
    render();
    try { await db.remove('path_tasks', [...ids]); } catch (e) { fail(e); }
  }

  async function restore(copies) {
    const live = new Set(columns.map((c) => c.id));
    const back = copies.filter((t) => live.has(t.column_id) && !tasks.some((x) => x.id === t.id));
    if (!back.length) return;
    tasks.push(...back);
    render();
    const rows = back.map(({ created_at, updated_at, user_id, ...r }) => r);
    try { await db.insert('path_tasks', rows); } catch (e) { fail(e); }
  }

  /* ---------------- Mutations ---------------- */

  async function addTask(colId, text) {
    const list = tasksOf(colId);
    const t = { id: uid(), column_id: colId, title: text, note: '', done: false, position: posBetween(list.at(-1)?.position ?? null, null) };
    tasks.push(t);
    render();
    try { await db.insert('path_tasks', t); } catch (e) { fail(e); }
  }

  async function patchTask(t, patch) {
    Object.assign(t, patch);
    render();
    try { await db.update('path_tasks', t.id, patch); } catch (e) { fail(e); }
  }

  async function deleteTask(t) {
    tasks = tasks.filter((x) => x.id !== t.id);
    picked.delete(t.id);
    render();
    try { await db.remove('path_tasks', t.id); } catch (e) { fail(e); }
  }

  async function duplicateTask(t) {
    const list = tasksOf(t.column_id);
    const i = list.findIndex((x) => x.id === t.id);
    const copy = { ...t, id: uid(), done: false, position: posBetween(t.position, list[i + 1]?.position ?? null) };
    delete copy.created_at; delete copy.updated_at; delete copy.user_id;
    tasks.push(copy);
    render();
    try { await db.insert('path_tasks', copy); } catch (e) { fail(e); }
  }

  async function moveTask(t, colId, position) {
    t.column_id = colId;
    t.position = position;
    render();
    try { await db.update('path_tasks', t.id, { column_id: colId, position }); } catch (e) { fail(e); }
  }

  async function addColumn() {
    const name = await promptDialog('New path', { placeholder: 'e.g. Evening', ok: 'Create path', label: 'Name' });
    if (!name) return;
    const col = { id: uid(), title: name, position: posBetween(columns.at(-1)?.position ?? null, null) };
    columns.push(col);
    render();
    el.querySelector('.pboard')?.scrollTo({ left: 1e6, behavior: 'smooth' });
    try { await db.insert('path_columns', col); } catch (e) { fail(e); }
  }

  async function renameColumn(col, name) {
    renamingCol = null;
    name = name.trim();
    if (!name || name === col.title) { render(); return; }
    col.title = name;
    render();
    try { await db.update('path_columns', col.id, { title: name }); } catch (e) { fail(e); }
  }

  async function renameTitle(name) {
    renamingTitle = false;
    name = name.replace(/\s+/g, ' ').trim() || DEFAULT_TITLE;
    if (name === title) { render(); return; }
    title = name;
    render();
    try { await setPref('pathsTitle', name); } catch (e) { fail(e); }
  }

  async function placeColumn(col, position) {
    col.position = position;
    sortCols();
    render();
    try { await db.update('path_columns', col.id, { position }); } catch (e) { fail(e); }
  }

  function shiftColumn(col, dir) {
    const i = columns.indexOf(col);
    const j = i + dir;
    if (j < 0 || j >= columns.length) return;
    const after = dir > 0 ? columns[j] : columns[j - 1];
    const before = dir > 0 ? columns[j + 1] : columns[j];
    placeColumn(col, posBetween(after?.position ?? null, before?.position ?? null));
  }

  async function clearDone(col) {
    const gone = tasksOf(col.id).filter((t) => t.done);
    if (!gone.length) return;
    const ids = gone.map((t) => t.id);
    tasks = tasks.filter((t) => !ids.includes(t.id));
    ids.forEach((id) => picked.delete(id));
    render();
    try { await db.remove('path_tasks', ids); } catch (e) { fail(e); }
  }

  async function deleteColumn(col) {
    const n = tasksOf(col.id).length;
    const ok = await confirmDialog(`Delete “${col.title}”?`, n ? `Its ${n} ${n === 1 ? 'task' : 'tasks'} will be deleted too.` : 'This path is empty.', { ok: 'Delete path' });
    if (!ok) return;
    const ids = tasksOf(col.id).map((t) => t.id);
    columns = columns.filter((c) => c.id !== col.id);
    if (openCol === col.id) { openCol = null; if (isMobile()) go('paths'); }
    tasks = tasks.filter((t) => t.column_id !== col.id);
    ids.forEach((id) => picked.delete(id));
    render();
    try {
      if (ids.length) await db.remove('path_tasks', ids);
      await db.remove('path_columns', col.id);
    } catch (e) { fail(e); }
  }

  /* ---------------- Time windows ---------------- */

  async function editTime(col) {
    const cur = windowOf(col);
    let mode = cur ? 'window' : 'none';
    const start = h('input', { class: 'input', type: 'time', value: cur?.[0] || '07:00', 'aria-label': 'Starts' });
    const end = h('input', { class: 'input', type: 'time', value: cur?.[1] || '13:00', 'aria-label': 'Ends' });
    const fields = h('div', { class: 'ptime-fields' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Starts'), start),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Ends'), end));
    const seg = h('div', { class: 'ptime-seg', role: 'radiogroup', 'aria-label': 'Time window' });
    const paint = () => {
      seg.replaceChildren(...[['window', 'Setpoint'], ['none', 'None']].map(([id, label]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === id), class: ['ptime-opt', mode === id && 'is-on'], onclick: () => { mode = id; paint(); } }, label)));
      fields.hidden = mode !== 'window';
    };
    paint();
    const ok = await dialog({
      title: `${col.title} — setpoint`,
      body: h('div', { class: 'stack' },
        seg, fields,
        h('p', { class: 'dlg-text ptime-hint' }, 'A setpoint shows a countdown while its window runs. Finish every task in it before the timer ends to dominate it — the Tracker counts it for you. The times stay hidden; a window can run past midnight.')),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }],
    });
    if (!ok) return;
    const all = { ...(getPref('pathTimes', {}) || {}) };
    all[col.id] = mode === 'none' ? { none: true } : { start: start.value || '00:00', end: end.value || '00:00' };
    try {
      await setPref('pathTimes', all);
      await setPref('spDayStart', dayStart(columns)); // partners' trackers use it to line days up
    } catch (e) { fail(e); }
    render();
  }

  /* ---------------- PDF export ---------------- */

  async function exportPdf() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const sheet = h('div', { class: 'ppr' },
      h('header', { class: 'ppr-head' },
        h('h1', { class: 'ppr-title' }, title),
        h('div', { class: 'ppr-meta' }, h('span', {}, fmtDate()), h('span', {}, `${done}/${total} done`))),
      h('div', { class: 'ppr-cols' },
        columns.map((col) => {
          const list = tasksOf(col.id);
          return h('section', { class: 'ppr-col' },
            h('header', { class: 'ppr-col-head' },
              h('h2', {}, col.title),
              h('span', {}, list.length ? `${list.filter((t) => t.done).length}/${list.length}` : '0')),
            list.length
              ? h('ol', { class: 'ppr-list' }, list.map((t) => h('li', { class: t.done ? 'is-done' : null },
                h('i', { class: 'ppr-check' }, t.done ? icon('check', 10, { weight: 2.6 }) : null),
                h('div', {}, h('div', { class: 'ppr-task' }, t.title || 'Untitled'), t.note ? h('div', { class: 'ppr-note' }, t.note) : null))))
              : h('p', { class: 'ppr-empty' }, 'Empty'));
        })));
    // Measure off-screen at natural size, then print on a page that fits it exactly.
    const probe = h('div', { class: 'print-probe' }, sheet);
    document.body.append(probe);
    await document.fonts?.ready;
    const width = Math.ceil(sheet.scrollWidth);
    const height = Math.ceil(sheet.scrollHeight);
    probe.remove();
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    pdfHint();
    printToPdf({ content: sheet, width, height, title: `${title} ${fmtDate()}`, background: bg });
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
    if (act === 'open-ticket' && !(e.metaKey || e.ctrlKey || e.shiftKey || picked.size)) {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('architect:open-ticket', { detail: { no: Number(t.dataset.no) } }));
      return;
    }
    if (readOnly) return;
    // Selecting: ⌘/Ctrl-click toggles, Shift-click selects a range; once anything is selected, a click toggles.
    if (task && (act === 'edit-title' || act === 'edit-note' || act === 'open-ticket') && (e.metaKey || e.ctrlKey || e.shiftKey || picked.size)) {
      togglePick(task, { range: e.shiftKey });
      return;
    }
    if (act === 'toggle' && task) patchTask(task, { done: !task.done });
    else if ((act === 'edit-title' || act === 'open-ticket') && task) { editing = { id: task.id, field: 'title' }; composerFor = null; render(); }
    else if (act === 'edit-note' && task) { editing = { id: task.id, field: 'note' }; composerFor = null; render(); }
    else if (act === 'add-task' && col) { composerFor = col.id; editing = null; render(); }
    else if (act === 'new-col') addColumn();
    else if (act === 'task-menu' && task) taskMenu(t, task);
    else if (act === 'col-menu' && col) colMenu(t, col);
    else if (act === 'select-col' && col) selectColumn(col);
    else if (act === 'open-col' && col) openPath(col.id);
    else if (act === 'close-col') closePath();
    else if (act === 'rename-title') { renamingTitle = true; render(); }
    else if (act === 'export-pdf') exportPdf();
  }));

  // Clicking empty space clears the selection.
  el.addEventListener('click', (e) => {
    if (suppressClick || !picked.size) return;
    if (e.target.closest('.ptask, button, input, textarea, .menu')) return;
    clearPick();
  });

  offs.push(delegate(el, 'dblclick', '[data-act="rename-col"]', (e, t) => {
    const col = colOf(t);
    if (!col || readOnly) return;
    renamingCol = col.id;
    render();
  }));

  el.addEventListener('pointerover', (e) => { hoverCol = e.target.closest?.('[data-col]')?.dataset.col || null; });

  const onActive = (e) => { active = el.contains(e.target); };
  if (embedded) document.addEventListener('pointerdown', onActive, true);
  function onKey(e) {
    if (isTypingTarget(e.target) || document.querySelector('.dlg')) return;
    if (embedded && (!active || readOnly || !el.isConnected)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a' && !loading) {
      e.preventDefault();
      const col = shown().find((c) => c.id === (openCol && isMobile() ? openCol : hoverCol));
      const scope = col ? tasksOf(col.id) : ordered();
      // A second ⌘A inside a fully selected path widens to everything.
      const ids = scope.every((t) => picked.has(t.id)) ? ordered().map((t) => t.id) : scope.map((t) => t.id);
      ids.forEach((id) => picked.add(id));
      editing = null; composerFor = null;
      render();
    } else if (e.key === 'Escape' && picked.size) {
      clearPick();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && picked.size) {
      e.preventDefault();
      bulkDelete();
    } else if (e.key.toLowerCase() === 'd' && !mod && picked.size) {
      bulkDone(!pickedTasks().every((t) => t.done));
    }
  }
  window.addEventListener('keydown', onKey);

  function taskMenu(anchor, task) {
    if (picked.has(task.id) && picked.size > 1) { selectionMenu(anchor); return; }
    const others = columns.filter((c) => c.id !== task.column_id);
    menu(anchor, [
      { label: task.private ? 'Show to others' : 'Hide from others', icon: task.private ? 'eye' : 'lock', onSelect: () => patchTask(task, { private: !task.private }) },
      { label: 'Edit task', icon: 'edit', onSelect: () => { editing = { id: task.id, field: 'title' }; render(); } },
      { label: task.note ? 'Edit note' : 'Add note', icon: 'note', onSelect: () => { editing = { id: task.id, field: 'note' }; render(); } },
      { label: task.done ? 'Mark not done' : 'Mark done', icon: 'check', onSelect: () => patchTask(task, { done: !task.done }) },
      { label: picked.has(task.id) ? 'Deselect' : 'Select', icon: 'selectAll', kbd: '⌘Click', onSelect: () => togglePick(task) },
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

  // ··· on any selected task: act on every selected task.
  function selectionMenu(anchor) {
    const list = pickedTasks();
    const allDone = list.every((t) => t.done);
    menu(anchor, [
      { header: `${list.length} selected` },
      { label: allDone ? 'Mark not done' : 'Mark done', icon: 'check', kbd: 'D', onSelect: () => bulkDone(!allDone) },
      '-',
      { header: 'Move to' },
      ...columns.map((c) => ({ label: c.title, icon: 'toPaths', onSelect: () => bulkMove(c.id) })),
      '-',
      { label: 'Clear selection', icon: 'close', kbd: 'Esc', onSelect: clearPick },
      { label: `Delete ${plural(list.length, 'task')}`, icon: 'trash', kbd: 'Del', danger: true, onSelect: bulkDelete },
    ], { align: 'end' });
  }

  function colMenu(anchor, col) {
    const i = columns.indexOf(col);
    const doneCount = tasksOf(col.id).filter((t) => t.done).length;
    const n = tasksOf(col.id).length;
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onSelect: () => { renamingCol = col.id; render(); } },
      { label: 'New path…', icon: 'plus', onSelect: addColumn },
      { label: winOf(col) ? 'Setpoint timer…' : 'Make setpoint…', icon: 'clock', onSelect: () => editTime(col) },
      { label: 'Select all', icon: 'selectAll', kbd: '⌘A', disabled: !n, onSelect: () => selectColumn(col) },
      { label: 'Move left', icon: 'chevronLeft', disabled: i === 0, onSelect: () => shiftColumn(col, -1) },
      { label: 'Move right', icon: 'chevronRight', disabled: i === columns.length - 1, onSelect: () => shiftColumn(col, 1) },
      { label: doneCount ? `Clear ${doneCount} done` : 'Clear done', icon: 'check', disabled: !doneCount, onSelect: () => clearDone(col) },
      '-',
      embedded && opts.onDetach && !opts.only ? '-' : null,
      embedded && opts.onDetach && !opts.only ? { label: 'Detach to canvas', icon: 'external', onSelect: () => opts.onDetach(col.id, null) } : null,
      embedded && opts.onSnap && opts.only ? { label: 'Snap back into Path', icon: 'collapse', onSelect: () => opts.onSnap() } : null,
      '-',
      { label: 'Delete path', icon: 'trash', danger: true, onSelect: () => deleteColumn(col) },
    ].filter(Boolean), { align: 'end' });
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
    } else if (t.dataset.rename || t.dataset.renameTitle) {
      if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      else if (e.key === 'Escape') { renamingCol = null; renamingTitle = false; render(); }
    } else if (t.dataset.act === 'rename-title' && e.key === 'Enter') {
      renamingTitle = true; render();
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
    } else if (t.dataset.renameTitle) {
      renameTitle(t.value);
    }
  });

  const swallowClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); };

  /* ---------------- Pointer: drag tasks, drag paths, lasso (mouse / pen) ---------------- */

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || readOnly) return;
    if (e.target.closest('button, textarea, input')) return;
    const card = e.target.closest('.ptask:not(.is-composer):not(.is-editing)');
    if (card) {
      drag = { card, id: card.dataset.task, x0: e.clientX, y0: e.clientY, started: false };
      listen(onDragMove, onDragEnd);
      return;
    }
    const head = e.target.closest('.pcol-head');
    if (head && !isMobile()) {
      const colEl = head.closest('.pcol');
      colDrag = { colEl, id: colEl.dataset.col, x0: e.clientX, y0: e.clientY, started: false };
      listen(onColMove, onColEnd);
      return;
    }
    if (e.target.closest('.pboard, .paths') && !e.target.closest('.paths-head, .pcol-add, a')) {
      marquee = { x0: e.clientX, y0: e.clientY, started: false, base: e.shiftKey || e.metaKey || e.ctrlKey ? new Set(picked) : new Set() };
      listen(onLassoMove, onLassoEnd);
    }
  });

  let activeMove = null, activeEnd = null;
  function listen(move, end) {
    activeMove = move; activeEnd = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  }
  function unlisten() {
    if (activeMove) window.removeEventListener('pointermove', activeMove);
    if (activeEnd) { window.removeEventListener('pointerup', activeEnd); window.removeEventListener('pointercancel', activeEnd); }
    activeMove = activeEnd = null;
  }

  function autoScroll(e) {
    const board = el.querySelector('.pboard');
    if (board) {
      const br = board.getBoundingClientRect();
      if (e.clientX < br.left + 60) board.scrollLeft -= 14;
      else if (e.clientX > br.right - 60) board.scrollLeft += 14;
    }
    if (e.clientY < 80) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  }

  /* Tasks — dragging a selected task carries the whole selection along. */
  function beginDrag(e) {
    const r = drag.card.getBoundingClientRect();
    drag.started = true;
    drag.dx = e.clientX - r.left;
    drag.dy = e.clientY - r.top;
    if (!picked.has(drag.id) && picked.size) { picked = new Set(); renderSelBar(); el.querySelectorAll('.is-picked').forEach((n) => n.classList.remove('is-picked')); }
    const group = picked.has(drag.id) && picked.size > 1 ? [...picked] : [drag.id];
    drag.group = new Set(group);
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add('ptask-ghost');
    if (group.length > 1) drag.ghost.append(h('span', { class: 'ptask-ghost-count' }, String(group.length)));
    Object.assign(drag.ghost.style, { width: `${r.width}px`, left: '0px', top: '0px' });
    drag.ph = h('div', { class: 'ptask-ph', style: { height: `${drag.card.offsetHeight}px` } });
    drag.card.after(drag.ph);
    drag.hidden = [...el.querySelectorAll('.ptask[data-task]')].filter((n) => drag.group.has(n.dataset.task));
    drag.hidden.forEach((n) => { n.style.display = 'none'; });
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
      const cards = [...list.querySelectorAll('.ptask:not(.is-composer)')].filter((c) => !drag.group.has(c.dataset.task));
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
    autoScroll(e);
  }

  function onDragEnd() {
    unlisten();
    const d = drag;
    drag = null;
    if (!d?.started) return;
    swallowClick();
    document.body.classList.remove('is-dragging');
    d.ghost.remove();
    const colEl = d.ph.closest('.pcol');
    const task = tasks.find((t) => t.id === d.id);
    const sib = (node, dir) => {
      let n = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
      while (n && (d.group.has(n.dataset.task) || !n.dataset.task)) n = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
      return n ? tasks.find((t) => t.id === n.dataset.task) : null;
    };
    const prev = sib(d.ph, -1);
    const next = sib(d.ph, 1);
    d.hidden.forEach((n) => { n.style.display = ''; });
    d.ph.remove();
    if (!task || !colEl) { render(); return; }
    const colId = colEl.dataset.col;
    if (d.group.size > 1) { bulkMove(colId, prev?.position ?? null, next?.position ?? null); return; }
    const orig = tasksOf(task.column_id);
    const idx = orig.indexOf(task);
    if (task.column_id === colId && prev?.id === orig[idx - 1]?.id && next?.id === orig[idx + 1]?.id) {
      render();
      return; // dropped where it started
    }
    moveTask(task, colId, posBetween(prev?.position ?? null, next?.position ?? null));
  }

  /* Paths — grab a path by its header and drop it somewhere else. */
  function onColMove(e) {
    const d = colDrag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      const r = d.colEl.getBoundingClientRect();
      d.started = true;
      d.dx = e.clientX - r.left; d.dy = e.clientY - r.top;
      d.ghost = d.colEl.cloneNode(true);
      d.ghost.classList.add('pcol-ghost');
      Object.assign(d.ghost.style, { width: `${r.width}px`, height: `${Math.min(r.height, 420)}px`, left: '0px', top: '0px' });
      d.ph = h('div', { class: 'pcol-ph', style: { height: `${d.colEl.offsetHeight}px` } });
      d.colEl.after(d.ph);
      d.colEl.style.display = 'none';
      document.body.append(d.ghost);
      document.body.classList.add('is-dragging');
    }
    d.ghost.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px) rotate(-1deg)`;
    d.lx = e.clientX; d.ly = e.clientY;
    if (embedded) {
      const r = el.getBoundingClientRect();
      d.outside = e.clientX < r.left - 20 || e.clientX > r.right + 20 || e.clientY < r.top - 20 || e.clientY > r.bottom + 20;
      d.ghost.classList.toggle('is-detaching', !!d.outside && !opts.only);
    }
    const board = el.querySelector('.pboard');
    const cols = [...board.querySelectorAll('.pcol')].filter((c) => c !== d.colEl);
    const before = cols.find((c) => { const r = c.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    const target = before || board.querySelector('.pcol-new');
    if (target && d.ph.nextElementSibling !== target) board.insertBefore(d.ph, target);
    else if (!target && board.lastElementChild !== d.ph) board.append(d.ph);
    autoScroll(e);
  }

  function onColEnd() {
    unlisten();
    const d = colDrag;
    colDrag = null;
    if (!d?.started) return;
    swallowClick();
    document.body.classList.remove('is-dragging');
    d.ghost.remove();
    const neighbour = (node, dir) => {
      let n = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
      while (n && (n === d.colEl || !n.classList.contains('pcol'))) n = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
      return n ? columns.find((c) => c.id === n.dataset.col) : null;
    };
    const prev = neighbour(d.ph, -1);
    const next = neighbour(d.ph, 1);
    d.colEl.style.display = '';
    d.ph.remove();
    const col = columns.find((c) => c.id === d.id);
    if (!col) { render(); return; }
    // Dragged out of the widget: it becomes its own object on the canvas (or snaps back home).
    if (embedded && d.outside) {
      if (opts.only) {
        const under = document.elementsFromPoint(d.lx, d.ly).find((n) => n.matches?.(`.el-widget[data-wkind="path"][data-owner="${owner}"]`));
        if (under && opts.onSnap) { opts.onSnap(); return; }
      } else if (opts.onDetach) { opts.onDetach(col.id, { clientX: d.lx, clientY: d.ly }); return; }
      render();
      return;
    }
    if (opts.only) { render(); return; }
    const i = columns.indexOf(col);
    if (columns[i - 1] === prev && columns[i + 1] === next) { render(); return; }
    placeColumn(col, posBetween(prev?.position ?? null, next?.position ?? null));
  }

  /* Lasso — drag across empty space to select tasks. */
  function onLassoMove(e) {
    const m = marquee;
    if (!m) return;
    if (!m.started) {
      if (Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 6) return;
      m.started = true;
      m.box = h('div', { class: 'plasso' });
      document.body.append(m.box);
      document.body.classList.add('is-lassoing');
      editing = null; composerFor = null;
    }
    const x = Math.min(m.x0, e.clientX), y = Math.min(m.y0, e.clientY);
    const w = Math.abs(e.clientX - m.x0), hh = Math.abs(e.clientY - m.y0);
    Object.assign(m.box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
    const next = new Set(m.base);
    el.querySelectorAll('.ptask[data-task]').forEach((n) => {
      const r = n.getBoundingClientRect();
      const hit = r.left < x + w && r.right > x && r.top < y + hh && r.bottom > y;
      if (hit) next.add(n.dataset.task);
      n.classList.toggle('is-picked', next.has(n.dataset.task));
    });
    picked = next;
    renderSelBar();
    autoScroll(e);
  }

  function onLassoEnd() {
    unlisten();
    const m = marquee;
    marquee = null;
    if (!m?.started) return;
    swallowClick();
    m.box.remove();
    document.body.classList.remove('is-lassoing');
    render();
  }

  /* ---------------- Touch: long-press to select tasks, long-press + drag to reorder tiles ---------------- */

  let press = null;
  const PRESS_MS = 420;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { cancelPress(); return; }
    const tch = e.touches[0];
    const card = e.target.closest('.ptask:not(.is-composer):not(.is-editing)');
    const tile = e.target.closest('.ptile:not(.is-new)');
    if (!card && !tile) return;
    if (card && e.target.closest('button')) return;
    press = { card, tile, x0: tch.clientX, y0: tch.clientY, x: tch.clientX, y: tch.clientY, active: false };
    press.timer = setTimeout(() => {
      if (!press) return;
      press.active = true;
      navigator.vibrate?.(12);
      if (press.card) {
        const task = taskOf(press.card);
        if (task) togglePick(task);
        swallowLater();
      } else if (press.tile) {
        startTileDrag();
      }
    }, PRESS_MS);
  }, { passive: true });

  function swallowLater() { suppressClick = true; setTimeout(() => { suppressClick = false; }, 450); }

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  const onTouchMove = (e) => {
    if (!press) return;
    const tch = e.touches[0];
    press.x = tch.clientX; press.y = tch.clientY;
    if (!press.active) {
      if (Math.hypot(press.x - press.x0, press.y - press.y0) > 8) cancelPress();
      return;
    }
    if (press.drag) { e.preventDefault(); moveTileDrag(); }
  };
  document.addEventListener('touchmove', onTouchMove, { passive: false });

  const onTouchEnd = () => {
    if (!press) return;
    const p = press;
    clearTimeout(p.timer);
    press = null;
    if (p.drag) endTileDrag(p);
  };
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchcancel', onTouchEnd);

  function startTileDrag() {
    const tile = press.tile;
    const r = tile.getBoundingClientRect();
    const ghost = tile.cloneNode(true);
    ghost.classList.add('ptile-ghost');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: '0px', top: '0px' });
    const ph = h('div', { class: 'ptile-ph' });
    tile.after(ph);
    tile.style.display = 'none';
    document.body.append(ghost);
    press.drag = { ghost, ph, dx: press.x - r.left, dy: press.y - r.top };
    moveTileDrag();
  }

  function moveTileDrag() {
    const d = press.drag;
    d.ghost.style.transform = `translate(${press.x - d.dx}px, ${press.y - d.dy}px) scale(1.04)`;
    const grid = el.querySelector('.ptiles');
    const items = [...grid.querySelectorAll('.ptile:not(.is-new)')].filter((t) => t !== press.tile);
    const before = items.find((t) => {
      const r = t.getBoundingClientRect();
      return press.y < r.top || (press.y <= r.bottom && press.x < r.left + r.width / 2);
    });
    const target = before || grid.querySelector('.ptile.is-new');
    if (target && d.ph.nextElementSibling !== target) grid.insertBefore(d.ph, target);
    if (press.y < 70) window.scrollBy(0, -10);
    else if (press.y > window.innerHeight - 70) window.scrollBy(0, 10);
  }

  function endTileDrag(p) {
    swallowLater();
    const d = p.drag;
    d.ghost.remove();
    const neighbour = (dir) => {
      let n = dir < 0 ? d.ph.previousElementSibling : d.ph.nextElementSibling;
      while (n && (n === p.tile || !n.dataset.col)) n = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
      return n ? columns.find((c) => c.id === n.dataset.col) : null;
    };
    const prev = neighbour(-1), next = neighbour(1);
    p.tile.style.display = '';
    d.ph.remove();
    const col = columns.find((c) => c.id === p.tile.dataset.col);
    if (!col) return;
    const i = columns.indexOf(col);
    if (columns[i - 1] === prev && columns[i + 1] === next) { render(); return; }
    placeColumn(col, posBetween(prev?.position ?? null, next?.position ?? null));
  }

  // Stop the long-press callout / text selection menu on tiles and tasks.
  el.addEventListener('contextmenu', (e) => { if (press || e.target.closest('.ptile')) e.preventDefault(); });

  // Tick the setpoint timers every second without re-rendering; re-render only when a setpoint starts or ends.
  const phases = () => columns.map((c) => stOf(c)?.phase || '').join('|');
  let lastPhases = '';
  const idle = () => !editing && !composerFor && !renamingCol && !renamingTitle && !drag && !colDrag && !marquee;
  const nowTimer = setInterval(() => {
    if (loading || loadError) return;
    const ph = phases();
    if (ph !== lastPhases && idle()) { lastPhases = ph; render(); if (!readOnly) logSetpoints(columns, tasks); return; }
    el.querySelectorAll('[data-timer]').forEach((n) => {
      const col = columns.find((c) => c.id === n.dataset.timer);
      const st = col && stOf(col);
      if (st) n.textContent = clock(st.left);
    });
  }, 1000);
  // Keep the setpoint log current while a timer runs (also after every change, via render()).
  const logTimer = setInterval(() => { if (!loading && !loadError && !readOnly) logSetpoints(columns, tasks); }, 30_000);
  let logT = 0;
  const queueLog = () => { clearTimeout(logT); logT = setTimeout(() => logSetpoints(columns, tasks), 800); };

  // Other widgets (and other people, and the API) change these paths too.
  const idleNow = () => idle() && !picked.size && !document.querySelector('.dlg') && !pointerDown;
  let reloadT = 0;
  const reloadSoon = () => { clearTimeout(reloadT); reloadT = setTimeout(() => { if (idleNow()) load(); else reloadSoon(); }, 250); };
  const onChanged = (e) => { if (e.detail?.owner === owner && e.detail.from !== instance) reloadSoon(); };
  if (embedded) window.addEventListener('architect:paths-changed', onChanged);
  const livePoll = embedded ? setInterval(() => { if (!document.hidden && !loading) reloadSoon(); }, readOnly ? 15_000 : 30_000) : 0;

  render();
  load();

  return {
    addColumn,
    setExclude(ids) {
      const next = new Set(ids || []);
      if ([...next].join() === [...exclude].join()) return;
      exclude = next;
      render();
    },
    update(r) {
      openCol = r.id || null;
      composerFor = null; editing = null; renamingCol = null; renamingTitle = false;
      picked = new Set();
      render();
      window.scrollTo(0, 0);
    },
    destroy() {
      clearInterval(livePoll); clearTimeout(reloadT);
      window.removeEventListener('architect:paths-changed', onChanged);
      document.removeEventListener('pointerdown', onActive, true);
      mq.removeEventListener?.('change', onMq);
      clearInterval(nowTimer);
      clearInterval(logTimer);
      clearTimeout(logT);
      offs.forEach((f) => f());
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('pointerup', onDocUp, true);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKey);
      unlisten();
      document.body.classList.remove('is-dragging', 'is-lassoing');
      drag?.ghost?.remove();
      colDrag?.ghost?.remove();
      marquee?.box?.remove();
      el.remove();
    },
  };
}
