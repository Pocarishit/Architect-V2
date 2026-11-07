// ARCHITECT SPACE — one shared infinite canvas that replaces the tabs.
// Everything (Paths, Tracker, Ticket board, Blueprints) lives on it as movable objects.
// No chrome: right-click or press "/" for the menu. Invite-only: members invite by username.
import { icon } from '../core/icons.js';
import { menu, toast, dialog, promptDialog, closeFloating } from '../core/ui.js';
import { uid } from '../core/util.js';
import { h, isTypingTarget } from '../core/dom.js';
import { api, friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';
import { mountBoard } from '../board/board.js';
import { makePreview } from '../board/preview.js';
import { rectOf, unionRects } from '../board/geometry.js';
import { createWidgetHost, WIDGETS, editCustom } from '../space/widgets.js';
import { themeItems, changePassword } from './shell.js';
import { openSettings } from './settings.js';

export function mountSpace(root) {
  const me = api.auth.current()?.user;
  const page = h('div', { class: 'space-host' });
  root.append(page);
  page.append(h('div', { class: 'bp-loading' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i'))));
  document.body.classList.add('is-board', 'is-space');

  let board = null;     // mountBoard handle
  let t = null;         // the board page's tools (editor, addFiles, …)
  let spaceId = null;
  let destroyed = false;
  let lastPointer = null;
  const offs = [];
  let boardOffs = [];   // listeners tied to the canvas on screen
  const editor = () => t?.editor || null;
  const pathCtl = new Map(); // Path widget id → its controls (New path…)
  const register = (id, ctl) => { if (ctl) pathCtl.set(id, ctl); else pathCtl.delete(id); };
  // Two worlds: the shared Space (everyone you're with) and your personal one. Tab flips between them.
  let mode = 'shared';
  const ids = { shared: null, personal: null };
  let switching = false;

  /* ---------------- find (or make) your Space ---------------- */
  (async () => {
    try {
      await loadPrefs();
      await openMode(getPref('spaceMode', 'shared') === 'personal' ? 'personal' : 'shared', { first: true });
    } catch (e) {
      if (!destroyed) problem(e);
    }
  })();

  async function idFor(m) {
    if (!ids[m]) ids[m] = m === 'shared' ? await resolveSpace() : await resolvePersonal();
    return ids[m];
  }

  async function openMode(m, { first = false } = {}) {
    const id = await idFor(m);
    if (destroyed) return;
    closeFloating();
    board?.destroy();
    boardOffs.forEach((f) => { try { f(); } catch {} });
    boardOffs = [];
    board = null; t = null;
    mode = m; spaceId = id;
    page.replaceChildren();
    page.dataset.mode = m;
    board = mountBoard(page, id, {
      space: true,
      mountWidget: createWidgetHost({ editor, spaceId: id, me, snapBack, detach, openMenuFor, reveal, addPortal, register }),
      extendMenu,
      onReady,
    });
    if (!first) flash(m === 'personal' ? 'Personal space' : 'Shared space');
    if (getPref('spaceMode', 'shared') !== m) setPref('spaceMode', m).catch(() => {});
  }

  async function toggleSpace() {
    if (switching) return;
    switching = true;
    try { await openMode(mode === 'shared' ? 'personal' : 'shared'); }
    catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    finally { switching = false; }
  }

  function flash(text) {
    page.querySelector('.space-flash')?.remove();
    const tag = h('div', { class: 'space-flash', role: 'status' }, h('span', {}, text), h('small', {}, 'Tab to switch'));
    page.append(tag);
    setTimeout(() => tag.classList.add('out'), 1100);
    setTimeout(() => tag.remove(), 1600);
  }

  // Yours alone: no members, never in the API's shared Space.
  async function resolvePersonal() {
    const rows = await api.db.select('blueprints', { columns: 'id,user_id,kind,created_at', filters: { kind: 'personal', user_id: me.id }, order: 'created_at.asc' });
    if (rows[0]) return rows[0].id;
    const id = uid();
    await api.db.insert('blueprints', {
      id, name: 'Personal Space', kind: 'personal', folder_id: null, pinned: false, preview: [],
      data: { v: 1, elements: [widgetEl('path', { x: -730, y: -420, owner: me.id, ownerName: me.username, detached: [] }), widgetEl('blueprints', { x: 790, y: -420 })] },
    });
    return id;
  }

  async function resolveSpace() {
    let rows;
    try {
      rows = await api.db.select('blueprints', { columns: 'id,user_id,name,kind,created_at', filters: { kind: 'space' }, order: 'created_at.asc' });
    } catch (e) {
      const err = new Error('The Space needs one more database update. Run supabase/space.sql in the Supabase SQL editor, then reload.');
      err.cause = e;
      throw err;
    }
    const saved = getPref('spaceId', null);
    // Once someone invites you, their Space wins over the solo one you may have started.
    const savedRow = rows.find((r) => r.id === saved);
    const invited = rows.find((r) => r.user_id !== me.id);
    const pick = (savedRow && savedRow.user_id !== me.id ? savedRow : invited) || savedRow || rows[0];
    if (pick && savedRow && pick.id !== savedRow.id) setTimeout(() => toast('You joined a shared Space.', { ms: 3500 }), 1200);
    if (pick) { if (pick.id !== saved) setPref('spaceId', pick.id).catch(() => {}); return pick.id; }
    const id = uid();
    await api.db.insert('blueprints', { id, name: 'Architect Space', kind: 'space', folder_id: null, pinned: false, data: { v: 1, elements: starter() }, preview: [] });
    setPref('spaceId', id).catch(() => {});
    return id;
  }

  // First layout: your Path on top, Tracker / Ticket board / Blueprints below it.
  function starter() {
    return [
      widgetEl('path', { x: -730, y: -420, owner: me.id, ownerName: me.username, detached: [] }),
      widgetEl('tracker', { x: -730, y: 160, goal: 'Rona’s Apartment', start: mondayKey(), weeks: {} }),
      widgetEl('tickets', { x: -230, y: 160 }),
      widgetEl('blueprints', { x: 790, y: 160 }),
    ];
  }

  function widgetEl(kind, extra = {}) {
    const d = WIDGETS[kind];
    return { id: uid(), type: 'widget', kind, w: d.w, h: d.h, x: 0, y: 0, ...extra };
  }

  function problem(e) {
    page.replaceChildren(h('div', { class: 'bp-problem' },
      h('p', { class: 'empty-text' }, e?.message || friendlyError(e)),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Reload')));
  }

  /* ---------------- once the canvas is up ---------------- */
  function onReady(tools) {
    t = tools;
    const ed = t.editor;
    t.page.classList.toggle('show-chrome', !!getPref('spaceChrome', false));
    // Everyone gets their own Path on the shared canvas.
    if (!ed.els.some((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id)) {
      const rc = ed.els.length ? unionRects(ed.els.map((e) => rectOf(e, ed.byId))) : { x: 0, y: 0, w: 0, h: 0 };
      const el = widgetEl('path', { x: rc.x + rc.w + 120, y: rc.y, owner: me.id, ownerName: me.username, detached: [] });
      ed.addEls([el], { select: false });
      if (ed.els.length > 1) toast('Your Path was added to the Space.', { ms: 3000 });
    }
    // Phones: start on your own Path instead of the whole Space.
    const mine = ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id);
    if (mine && innerWidth < 720 && !localStorage.getItem(`architect.cam.${spaceId}`)) ed.fitRect(mine, { maxZ: 1, pad: 12, animate: false });
    if (!getPref('spaceHinted', false)) {
      const touch = matchMedia('(hover: none)').matches;
      setTimeout(() => toast(touch ? 'Long-press the canvas for the menu.' : 'Right-click or press / for the menu.', { ms: 5000 }), 800);
      setPref('spaceHinted', true).catch(() => {});
    }
    // Pull a detached column back home when you drop it on its Path.
    const vp = ed.vp;
    const onUp = () => setTimeout(checkSnap, 0);
    vp.addEventListener('pointerup', onUp);
    boardOffs.push(() => vp.removeEventListener('pointerup', onUp));
  }

  function checkSnap() {
    const ed = editor();
    if (!ed) return;
    const sel = ed.selected();
    if (sel.length !== 1 || sel[0].type !== 'widget' || sel[0].kind !== 'column' || sel[0].owner !== me.id) return;
    const col = sel[0];
    const home = ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === col.owner);
    if (!home) return;
    const cx = col.x + col.w / 2, cy = col.y + 40;
    if (cx > home.x && cx < home.x + home.w && cy > home.y && cy < home.y + home.h) snapBack(col.id);
  }

  /* ---------------- widget actions ---------------- */
  function detach(pathId, colId, at) {
    const ed = editor();
    const pathEl = ed?.byId.get(pathId);
    if (!pathEl) return;
    const p = at ? ed.toWorld(at.clientX, at.clientY) : { x: pathEl.x + pathEl.w + 60 + 165, y: pathEl.y + 260 };
    const col = widgetEl('column', { owner: pathEl.owner, ownerName: pathEl.ownerName, colId });
    col.x = p.x - col.w / 2; col.y = p.y - 20;
    ed.setEls([...ed.els.map((e) => (e.id === pathId ? { ...e, detached: [...new Set([...(e.detached || []), colId])] } : e)), col]);
    ed.select([col.id]);
  }

  function snapBack(colWidgetId) {
    const ed = editor();
    const col = ed?.byId.get(colWidgetId);
    if (!col) return;
    ed.setEls(ed.els
      .filter((e) => e.id !== colWidgetId)
      .map((e) => (e.type === 'widget' && e.kind === 'path' && e.owner === col.owner ? { ...e, detached: (e.detached || []).filter((x) => x !== col.colId) } : e)));
    toast('Snapped back into your Path.', { ms: 1800 });
  }

  function reveal(id) {
    const ed = editor();
    const el = ed?.byId.get(id);
    if (!el) return;
    const r = ed.rect();
    const s = ed.toScreen({ x: el.x, y: el.y });
    const e2 = ed.toScreen({ x: el.x + el.w, y: el.y + el.h });
    const visible = s.x >= r.left - 20 && s.y >= r.top - 20 && e2.x <= r.right + 20 && e2.y <= r.bottom + 20 && ed.cam.z > 0.45;
    if (!visible) ed.fitRect(el, { maxZ: 1, pad: 60 });
  }

  function addPortal(b, nearId) {
    const ed = editor();
    if (!ed) return;
    const near = ed.byId.get(nearId);
    const el = widgetEl('portal', { boardId: b.id, name: b.name, preview: b.preview || [] });
    const p = near ? { x: near.x + near.w + 40, y: near.y } : ed.viewCenter();
    el.x = p.x; el.y = p.y;
    ed.addEls([el]);
  }

  function openMenuFor(id, anchor) {
    const ed = editor();
    if (!ed) return;
    if (!ed.sel.has(id)) ed.select([id]);
    const r = anchor.getBoundingClientRect();
    ed.emit('contextmenu', { x: r.left, y: r.bottom + 4, onElement: true, at: ed.toWorld(r.left, r.bottom) });
  }

  function addWidget(kind, at) {
    const ed = editor();
    if (!ed) return;
    if (kind === 'path' && ed.els.some((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id)) {
      const mine = ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id);
      ed.select([mine.id]); ed.fitRect(mine, { maxZ: 1 });
      toast('Your Path is already on the canvas.');
      return;
    }
    const extra = kind === 'path' ? { owner: me.id, ownerName: me.username, detached: [] }
      : kind === 'tracker' ? { goal: 'Rona’s Apartment', start: mondayKey(), weeks: {} }
        : kind === 'custom' ? { title: 'Widget', html: '<h3 style="margin:0 0 6px;font-family:Space Mono,monospace">Hello</h3>\n<p>Edit me from the widget’s ✎ button.</p>' } : {};
    const el = widgetEl(kind, extra);
    const p = at || ed.viewCenter();
    el.x = p.x - el.w / 2; el.y = p.y - el.h / 2;
    ed.addEls([el]);
    if (kind === 'custom') editCustom({ current: () => ed.byId.get(el.id) || el, patch: (x) => ed.updateEls([el.id], x) });
  }

  /* ---------------- menus ---------------- */
  // Right-click on an object adds privacy, shortcuts and Blueprint conversion; on empty space, the Space menu.
  function extendMenu(items, { onElement, world, sel }) {
    if (!onElement) {
      return [items[0], '-', ...spaceItems(world)]; // Paste here, then the Space menu
    }
    const extra = [];
    const mineOrPublic = mode === 'shared' && sel.every((e) => !e.privateTo || e.privateTo === me.id);
    if (mineOrPublic) {
      const allPrivate = sel.every((e) => e.privateTo === me.id);
      extra.push({ label: allPrivate ? 'Show to others' : 'Hide from others', icon: allPrivate ? 'eye' : 'eyeOff', onSelect: () => setPrivate(sel, !allPrivate) });
    }
    if (sel.length === 1) {
      const el = sel[0];
      const key = (getPref('objectKeys', {}) || {})[el.id];
      extra.push({ label: key ? `Shortcut: ${key}` : 'Assign shortcut…', icon: 'keyboard', onSelect: () => assignObjectKey(el) });
      if (el.type === 'widget' && el.kind === 'path' && el.owner === me.id && pathCtl.get(el.id)) extra.push({ label: 'New path…', icon: 'plus', onSelect: () => pathCtl.get(el.id)?.addColumn() });
      if (el.type === 'widget' && el.kind === 'column' && el.owner === me.id) extra.push({ label: 'Snap back into Path', icon: 'collapse', onSelect: () => snapBack(el.id) });
      if (el.type === 'widget' && el.kind === 'portal') extra.push({ label: 'Open blueprint', icon: 'external', onSelect: () => (location.hash = `#/board/${el.boardId}`) });
      if (el.type === 'widget' && el.kind === 'custom') extra.push({ label: 'Edit widget…', icon: 'code', onSelect: () => editCustom({ current: () => editor().byId.get(el.id) || el, patch: (x) => editor().updateEls([el.id], x) }) });
    }
    const convertible = sel.filter((e) => e.type !== 'widget');
    if (convertible.length) extra.push({ label: 'Convert to Blueprint…', icon: 'frame', onSelect: () => toBlueprint(convertible) });
    const at = items.findIndex((x) => x === '-');
    return [...items.slice(0, at), '-', ...extra, ...items.slice(at)];
  }

  function spaceItems(world) {
    const ed = editor();
    const at = world || ed?.viewCenter();
    const tool = (name, opt) => () => { if (opt) ed.setOpt(...opt); ed.setTool(name); toast('Drag on the canvas', { ms: 1200 }); };
    const chrome = t?.page.classList.contains('show-chrome');
    return [
      { header: 'Add' },
      { label: 'Sticky note', icon: 'sticky', kbd: 'N', onSelect: () => ed.addEls([ed.makeEl('sticky', null, at)], { edit: true }) },
      { label: 'Text', icon: 'text', kbd: 'T', onSelect: () => ed.addEls([ed.makeEl('text', null, at)], { edit: true }) },
      { label: 'Shape', icon: 'rect', kbd: 'S', onSelect: tool('shape') },
      { label: 'Connector', icon: 'arrow', kbd: 'L', onSelect: tool('line') },
      { label: 'Draw', icon: 'pen', kbd: 'P', onSelect: tool('pen') },
      { label: 'Border — box', icon: 'borderBox', kbd: 'B', onSelect: tool('border', ['border', 'box']) },
      { label: 'Border — smooth curve', icon: 'borderCurve', kbd: '⇧B', onSelect: tool('border', ['border', 'curve']) },
      { label: 'Frame', icon: 'frame', kbd: 'F', onSelect: tool('frame') },
      { label: 'Image or video', icon: 'image', kbd: 'U', onSelect: () => t.pickFiles() },
      { label: 'Video or link', icon: 'video', kbd: 'K', onSelect: () => t.openEmbed() },
      { label: 'Widget…', icon: 'widget', onSelect: () => widgetPicker(at) },
      '-',
      { header: 'Move around' },
      { label: 'Save this view…', icon: 'target', onSelect: () => saveCameraPoint() },
      { label: 'Camera points…', icon: 'target', onSelect: () => cameraDialog() },
      { label: 'Zoom to fit', icon: 'fit', kbd: '⇧1', onSelect: () => ed.zoomToFit() },
      '-',
      { header: mode === 'personal' ? 'Personal space' : 'Shared space' },
      { label: mode === 'personal' ? 'Switch to shared space' : 'Switch to personal space', icon: 'home', kbd: 'Tab', onSelect: toggleSpace },
      { label: 'Invite…', icon: 'share', onSelect: async () => openSettings({ tab: 'members', spaceId: await idFor('shared') }) },
      { label: 'Settings & API…', icon: 'settings', onSelect: async () => openSettings({ spaceId: await idFor('shared') }) },
      { label: 'Show toolbar', icon: 'layers', checked: chrome, onSelect: () => { t.page.classList.toggle('show-chrome', !chrome); setPref('spaceChrome', !chrome).catch(() => {}); } },
      { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', onSelect: () => t.showShortcuts() },
      '-',
      { header: 'Theme' },
      ...themeItems(),
      '-',
      { label: 'Change password', icon: 'key', onSelect: changePassword },
      { label: 'Sign out', icon: 'logout', onSelect: () => api.auth.signOut() },
    ];
  }

  async function widgetPicker(at) {
    const choose = (kind) => { closeFloating(); addWidget(kind, at); };
    const opts = ['path', 'tracker', 'tickets', 'blueprints', 'custom'];
    dialog({
      title: 'Add a widget',
      width: 460,
      body: h('div', { class: 'wpick' }, opts.map((k) => h('button', { type: 'button', class: 'wpick-row', onclick: () => choose(k) },
        h('span', { class: 'wpick-ic' }, icon(WIDGETS[k].icon, 18)),
        h('span', { class: 'wpick-text' }, h('b', {}, WIDGETS[k].label))))),
      actions: [{ label: 'Cancel', value: null }],
    });
  }

  /* ---------------- privacy ---------------- */
  function setPrivate(sel, on) {
    const ids = sel.map((e) => e.id);
    editor().updateEls(ids, { privateTo: on ? me.id : null });
    toast(on ? 'Hidden from everyone else in the Space.' : 'Visible to the Space again.', { ms: 2200 });
  }

  /* ---------------- camera points + object shortcuts ---------------- */
  const points = () => getPref('cameraPoints', []) || [];
  const objKeys = () => getPref('objectKeys', {}) || {};

  function viewNow() {
    const ed = editor();
    const c = ed.viewCenter();
    return { cx: Math.round(c.x), cy: Math.round(c.y), z: +ed.cam.z.toFixed(3) };
  }
  function goTo(p) {
    const ed = editor();
    const r = ed.rect();
    ed.setCamera({ x: r.width / 2 - p.cx * p.z, y: r.height / 2 - p.cy * p.z, z: p.z }, { animate: true });
  }
  async function saveCameraPoint() {
    const used = new Set(points().map((p) => p.key));
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Alt+${n}`).find((k) => !used.has(k)) || null;
    const name = await promptDialog('Save this view', { value: `View ${points().length + 1}`, ok: 'Save', label: 'Name' });
    if (!name) return;
    await setPref('cameraPoints', [...points(), { id: uid(), name, key: free, ...viewNow() }]);
    toast(free ? `Saved — press ${free} to come back.` : 'Saved.', { ms: 2600 });
  }

  function cameraDialog() {
    const body = h('div', { class: 'cam-list' });
    const paint = () => {
      const list = points();
      body.replaceChildren(
        ...(list.length ? list.map((p) => h('div', { class: 'cam-row' },
          h('button', { type: 'button', class: 'cam-go', onclick: () => { goTo(p); } }, icon('target', 15), h('span', {}, p.name)),
          keyButton(p.key, async (key) => { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, key } : key && x.key === key ? { ...x, key: null } : x))); paint(); }),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Update to this view', 'aria-label': 'Update to this view', onclick: async () => { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, ...viewNow() } : x))); toast('Updated.'); } }, icon('fit', 14)),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Rename', 'aria-label': 'Rename', onclick: async () => { const n = await promptDialog('Rename view', { value: p.name, ok: 'Save' }); if (n) { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, name: n } : x))); paint(); } } }, icon('edit', 14)),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Delete', 'aria-label': 'Delete', onclick: async () => { await setPref('cameraPoints', points().filter((x) => x.id !== p.id)); paint(); } }, icon('trash', 14))))
          : [h('p', { class: 'dlg-text' }, 'No camera points yet. Save a view to jump back to it with a key.')]),
        h('button', { type: 'button', class: 'btn sm cam-add', onclick: async () => { await saveCameraPoint(); paint(); } }, icon('plus', 14), 'Save current view'));
    };
    paint();
    dialog({ title: 'Camera points', width: 520, body, actions: [{ label: 'Done', primary: true, value: true }] });
  }

  // A button that records the next key combo you press.
  function keyButton(current, onSet) {
    const b = h('button', { type: 'button', class: ['kbd-rec', !current && 'is-empty'], title: 'Click, then press a key combo · Backspace clears' }, current || 'Set key');
    b.addEventListener('click', () => {
      b.textContent = 'Press keys…';
      b.classList.add('is-rec');
      const onKey = (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        b.classList.remove('is-rec');
        if (e.key === 'Escape') { b.textContent = current || 'Set key'; return; }
        const key = e.key === 'Backspace' || e.key === 'Delete' ? null : comboOf(e);
        if (key && !e.altKey && !e.ctrlKey && !e.metaKey && /^[A-Z0-9]$/.test(key.replace(/^Shift\+/, ''))) toast('Tip: plain letters also drive canvas tools — Alt+key is safer.', { ms: 3200 });
        b.textContent = key || 'Set key';
        b.classList.toggle('is-empty', !key);
        onSet(key);
      };
      window.addEventListener('keydown', onKey, true);
    });
    return b;
  }

  async function assignObjectKey(el) {
    const keys = objKeys();
    let chosen = keys[el.id] || null;
    const ok = await dialog({
      title: 'Object shortcut',
      width: 420,
      body: h('div', { class: 'stack' },
        h('p', { class: 'dlg-text' }, el.type === 'widget' && el.kind === 'portal' ? 'Press it anywhere in the Space to open this blueprint.' : 'Press it anywhere in the Space to fly to this object.'),
        keyButton(chosen, (k) => { chosen = k; })),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }],
    });
    if (!ok) return;
    const next = { ...objKeys() };
    for (const [id, k] of Object.entries(next)) if (k === chosen) delete next[id];
    if (chosen) next[el.id] = chosen; else delete next[el.id];
    await setPref('objectKeys', next);
    if (chosen) toast(`${chosen} now opens it.`);
  }

  function openObject(id) {
    const ed = editor();
    const el = ed?.byId.get(id);
    if (!el || ed.isHidden(el)) return false;
    if (el.type === 'widget' && el.kind === 'portal') { location.hash = `#/board/${el.boardId}`; return true; }
    ed.select([id]);
    ed.fitRect(rectOf(el, ed.byId), { maxZ: el.type === 'widget' ? 1 : 1.5, pad: 60 });
    return true;
  }

  const onPointer = (e) => { lastPointer = { x: e.clientX, y: e.clientY }; };
  window.addEventListener('pointermove', onPointer, { passive: true });
  offs.push(() => window.removeEventListener('pointermove', onPointer));

  const onKeyDown = (e) => {
    const ed = editor();
    if (!ed || isTypingTarget(e.target) || document.querySelector('.dlg') || ed.editingId) return;
    if (e.target instanceof Element && e.target.closest('.wg-body')) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleSpace(); return; }
    const combo = comboOf(e);
    const p = points().find((x) => x.key && x.key === combo);
    if (p) { e.preventDefault(); e.stopPropagation(); goTo(p); return; }
    const obj = Object.entries(objKeys()).find(([, k]) => k === combo);
    if (obj && openObject(obj[0])) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const at = lastPointer || { x: innerWidth / 2, y: innerHeight / 2 };
      menu({ x: at.x, y: at.y }, spaceItems(ed.toWorld(at.x, at.y)));
    }
  };
  window.addEventListener('keydown', onKeyDown, true);
  offs.push(() => window.removeEventListener('keydown', onKeyDown, true));

  /* ---------------- group → Blueprint ---------------- */
  async function toBlueprint(list) {
    const ed = editor();
    const ids = new Set(ed.expandGroups ? ed.expandGroups(list.map((e) => e.id)) : list.map((e) => e.id));
    // Bring connectors whose both ends are inside along.
    for (const e of ed.els) if (e.type === 'line' && e.a?.id && e.b?.id && ids.has(e.a.id) && ids.has(e.b.id)) ids.add(e.id);
    const els = ed.els.filter((e) => ids.has(e.id) && e.type !== 'widget');
    if (!els.length) return;
    const name = await promptDialog('Convert to Blueprint', { value: els.find((e) => e.type === 'frame')?.title || 'New blueprint', ok: 'Convert', label: 'Name' });
    if (!name) return;
    const rc = unionRects(els.map((e) => rectOf(e, ed.byId)));
    const dx = -rc.x, dy = -rc.y;
    const shift = (p) => (p && p.x != null ? { ...p, x: p.x + dx, y: p.y + dy } : p);
    const moved = els.map((e) => (e.type === 'line' ? { ...e, a: shift(e.a), b: shift(e.b) } : { ...e, x: e.x + dx, y: e.y + dy, privateTo: undefined }));
    const byId = new Map(moved.map((e) => [e.id, e]));
    const row = { id: uid(), name, kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: moved }, preview: makePreview(moved, byId) };
    try {
      await api.db.insert('blueprints', row);
    } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); return; }
    // Everyone in the Space can open it.
    if (api.mode !== 'local') {
      try {
        const people = (await api.rpc('board_people', { b: spaceId })) || [];
        for (const p of people) if (p.user_id !== me.id) await api.rpc('share_board', { b: row.id, uname: p.username }).catch(() => {});
      } catch {}
    }
    const portal = widgetEl('portal', { boardId: row.id, name, preview: row.preview });
    portal.x = rc.x + rc.w / 2 - portal.w / 2;
    portal.y = rc.y + rc.h / 2 - portal.h / 2;
    ed.setEls([...ed.els.filter((e) => !ids.has(e.id)), portal]);
    ed.select([portal.id]);
    window.dispatchEvent(new CustomEvent('architect:blueprints-changed'));
    toast(`“${name}” is a Blueprint now — open it from the portal.`, { ms: 3200 });
  }

  return {
    destroy() {
      destroyed = true;
      offs.forEach((f) => { try { f(); } catch {} });
      boardOffs.forEach((f) => { try { f(); } catch {} });
      board?.destroy();
      page.remove();
      document.body.classList.remove('is-space');
    },
  };
}

function mondayKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// "Alt+1", "Ctrl+Shift+K", "G" — layout-independent for letters and digits.
export function comboOf(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}

