// ARCHITECT — Desktop sidebar (Nov 23, from "Architect Systems Blueprint").
// A rail on the left gives direct access to the parts of Architect you use most, without hunting for them
// on the canvas. ARCHITECT still opens the full Space (pan and zoom as usual); the others open full views:
//   · VARIABLES — pick a category from the top row, pick one of its chats in the sidebar; the main pane is
//     that chat as a standard Variables chat object. The category map (its tiles, Free View) opens from its
//     preview at the bottom of the sidebar, compact or full screen. Each category has its own cover and is
//     SHARED (with your shared Space) or PRIVATE.
//   · PATH — your Path on the left, Fleeting Moments on the right (Story / Weekly) beside it.
//   · MORE — Settings, Profile, Custom.
//   · Custom views ("My View") — a bordered dot-grid workspace of your own: add any object, drag it into
//     place, resize it, lock the layout (Nov 24). Rename an object, hide just its title, or hide its header.
// Board objects (Fleeting Moments, Radio, …) are borrowed: their header and body move into the view and go
// back to the board when you leave it — one instance, never two. Path is mounted fresh (it's account data).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, promptDialog, confirmDialog, closeFloating } from '../core/ui.js';
import { store, uid } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';
import { setSurface } from '../board/editor.js';
import { mountPaths } from '../views/paths.js';
import { mountVariables, pickColor, trackUndo } from './variables.js';
import { mountSideChat } from './sidechat.js';
import { WIDGETS } from './widgets.js';
import { urlOf, pickMedia, uploadMedia } from './media.js';
import { loadMyVars, myVars, setMyVars, onMyVars, myVarsSource, flushMyVars } from '../data/myvars.js';
import { removeShared } from '../data/shared.js';
import { appKey } from './nov27.js';
import { deleteSharedCat } from '../data/varshare.js';
import { startVarShare, foreignCats, onShared, shareCategory, unshareCategory, setSharedSpace, syncShared, sharedSource } from '../data/varshare.js';

// The rail's own icons: thin strokes, round caps, drawn on a 24 grid.
// Nov 25 — Overview is the official dotted Architect mark (its red dot included), Variables an atom, Path
// the compass from the approved mockup: a round rim, four short directional marks, a diagonal needle with
// a centre dot.
// Nov 27 — ghost-white icons that look the same before and after selection. Architect is the original dotted A
// (the Nov 25 dot size and pattern), Variables a ball-and-stick atom (a larger centre dot, three smaller outer
// dots, thin bonds), Compass a flat four-point cross inside a thin ring. Below Compass: Blueprints (a frame /
// hash) and Personal Space (a home).
const DOT = (x, y) => `<circle cx="${x}" cy="${y}" r="1.45" fill="currentColor" stroke="none"/>`;
const ATOM = (() => {
  const pts = [0, 120, 240].map((a) => [12 + 7.4 * Math.cos(a * Math.PI / 180), 12 + 7.4 * Math.sin(a * Math.PI / 180)].map((n) => +n.toFixed(2)));
  return pts.map(([x, y]) => `<path d="M12 12L${x} ${y}"/>`).join('') + '<circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none"/>' + pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="currentColor" stroke="none"/>`).join('');
})();
const RAIL_ICONS = {
  logo: [[12.0, 5.25], [9.375, 8.625], [14.625, 8.625], [7.5, 12.0], [16.5, 12.0], [6.0, 15.375], [9.0, 15.375], [12.0, 15.375], [15.0, 15.375], [18.0, 15.375], [4.875, 18.75], [19.125, 18.75], [12.0, 18.75]].map(([x, y]) => DOT(x, y)).join(''),
  atom: ATOM,
  compass: '<circle cx="12" cy="12" r="7.4"/><path d="M12 3v18M3 12h18"/>',
  hash: '<path d="M9.2 4.5v15M14.8 4.5v15M4.5 9.2h15M4.5 14.8h15"/>',
  home: '<path d="M4.5 11.2 12 4.6l7.5 6.6"/><path d="M6.6 9.6V19.4h10.8V9.6"/><path d="M10.2 19.4v-4.6h3.6v4.6"/>',
  panel: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M9.5 5v14"/>',
  frame: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  stack: '<rect x="4" y="4.5" width="11" height="4" rx="2"/><rect x="8" y="10" width="12" height="4" rx="2"/><rect x="4" y="15.5" width="11" height="4" rx="2"/>',
  route: '<circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="5.5" r="2"/><path d="M7.2 17.2C9 14 11 14.5 13 13s3.2-3.8 4-5.8"/>',
  dots: '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
};
export function railIcon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '22'); s.setAttribute('height', '22');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.25'); // Nov 26: lighter
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.classList.add('sb-ic');
  s.innerHTML = RAIL_ICONS[name];
  return s;
}

// Objects a custom view can hold.
const KINDS = ['path', 'fleeting', 'variables', 'timer', 'blueprints', 'chat', 'tts', 'radio'];
const label = (k) => (k === 'path' ? 'Path' : WIDGETS[k]?.label || k);
const hue = (t) => { let x = 0; for (const c of String(t).trim()) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };

/**
 * ctx: { page, me, editor(), host(), mode(), toggleSpace(), addWidget(kind), openSettings(tab), sharedSpaceId(), onView(id) }
 */
export function mountSidebar(ctx) {
  const { page, me } = ctx;
  const memKey = `architect.sb.view.${me.id}`;
  let cur = store.get(memKey, 'space');
  let ed = ctx.editor();
  let active = null;            // the mounted view: { id, root, destroy() }
  const offs = [];

  const rail = h('nav', { class: 'sb-rail', 'aria-label': 'Architect' });
  // Nov 26 — the sidebar's own look (Settings → Personalize → Sidebar): a color and an optional PNG. Only paint:
  // the rail's layout, size and which views show stay exactly as they are.
  const applyLook = () => {
    const look = getPref('sbLook', null) || {};
    rail.style.setProperty('--sb-tint', look.color || '');
    rail.classList.toggle('has-tint', !!look.color);
    const url = look.png ? urlOf(look.png, applyLook) : null;
    rail.style.backgroundImage = url ? `url("${url}")` : '';
    rail.classList.toggle('has-png', !!url);
  };
  const onLook = () => applyLook();
  window.addEventListener('architect:sidebar-look', onLook);
  const stage = h('div', { class: 'sb-stage', 'data-surface': 'sidebar', hidden: true });
  const root = h('div', { class: 'sb' }, rail, stage);
  page.append(root);
  page.classList.add('has-sb');

  /* ---------------- custom views (saved on your account) ---------------- */
  const views = () => (Array.isArray(getPref('sbViews', null)) ? getPref('sbViews', []) : []);
  const saveViews = (list) => setPref('sbViews', list).catch((e) => toast(friendlyError(e), { tone: 'error' }));
  const viewById = (id) => views().find((v) => v.id === id);

  /* ---------------- the rail ---------------- */
  // Nov 24 — icons only: no labels under the icons, and nothing changes when one is clicked (no highlight,
  // accent bar, outline or tint). The name stays as the tooltip and for screen readers.
  function item(id, ic, text, onClick, extra = {}) {
    return h('button', {
      type: 'button', class: ['sb-item', cur === id && 'is-on'], 'data-v': id, 'aria-current': cur === id ? 'page' : 'false', title: text, 'aria-label': text,
      onclick: (e) => onClick(e.currentTarget), ...extra,
    }, RAIL_ICONS[ic] ? railIcon(ic) : icon(ic, 18));
  }
  function paintRail() {
    rail.replaceChildren(
      item('space', 'logo', 'Overview', () => show('space')),
      item('variables', 'atom', 'Variables', () => show('variables')),
      item('path', 'compass', 'Path', () => show('path')),
      // Nov 27 — Blueprints opens the Blueprint view (a library-style canvas); Personal Space switches to your
      // personal space (it replaces the action removed from the canvas menu).
      item('blueprints', 'hash', 'Blueprints', () => ctx.openBlueprints?.(), { 'aria-current': 'false', class: 'sb-item' }),
      item('personal', 'home', personalLabel(), () => goPersonal(), { 'aria-current': 'false', class: 'sb-item' }),
      ...views().map((v) => item(`custom:${v.id}`, 'square', v.name || 'My view', () => show(`custom:${v.id}`), {
        oncontextmenu: (e) => { e.preventDefault(); viewMenu({ x: e.clientX, y: e.clientY }, v); },
      })),
      // More sits at the very bottom of the rail (Nov 25).
      h('span', { class: 'sb-push', 'aria-hidden': 'true' }),
      item('hide', 'panel', `Hide sidebar${keyHint('sidebar')}`, () => ctx.toggleSidebar?.(), { 'aria-current': 'false', class: 'sb-item sb-toggle' }),
      item('more', 'dots', 'More', (b) => moreMenu(b), { class: 'sb-item sb-more' }));
    ctx.onRail?.(railSpec());
  }

  // What the rail holds, for the phone's icon sidebar (the same icons, in the same order).
  const railSpec = () => [
    { id: 'space', svg: railIcon('logo'), label: 'Overview' },
    { id: 'variables', svg: railIcon('atom'), label: 'Variables' },
    { id: 'path', svg: railIcon('compass'), label: 'Path' },
    { id: 'blueprints', svg: railIcon('hash'), label: 'Blueprints', run: () => ctx.openBlueprints?.() },
    { id: 'personal', svg: railIcon('home'), label: personalLabel(), run: () => goPersonal() },
    ...views().map((v) => ({ id: `custom:${v.id}`, svg: railIcon('square'), label: v.name || 'My view' })),
    { id: 'more', svg: railIcon('dots'), label: 'More', bottom: true },
  ];

  const personalLabel = () => (ctx.mode?.() === 'personal' ? 'Shared Space' : 'Personal Space');
  const keyHint = (action) => { const k = appKey(action); return k ? ` (${k})` : ''; };
  // Personal Space: show the canvas, then switch spaces. From your personal space the same button takes you
  // back to the shared one, so it's never a dead end.
  function goPersonal() {
    if (cur !== 'space') show('space');
    ctx.toggleSpace?.();
    setTimeout(paintRail, 400);
  }

  function moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    menu({ x: r.right + 6, y: Math.min(r.top, innerHeight - 220) }, [
      { label: 'Settings', icon: 'settings', onSelect: () => ctx.openSettings('general') },
      { label: 'Profile', icon: 'user', onSelect: () => ctx.openSettings('profile') },
      { label: 'Custom', icon: 'layers', onSelect: () => newView() },
      ...(views().length ? ['-', { header: 'Your views' }, ...views().map((v) => ({ label: v.name, icon: 'board', onSelect: () => show(`custom:${v.id}`) }))] : []),
      '-',
      ctx.changePassword ? { label: 'Change password', icon: 'key', onSelect: () => ctx.changePassword() } : null,
      ctx.signOut ? { label: 'Sign out', icon: 'logout', onSelect: () => ctx.signOut() } : null,
    ].filter(Boolean));
  }

  /* ---------------- switching ---------------- */
  function show(id) {
    if (id.startsWith('custom:') && !viewById(id.slice(7))) id = 'space';
    closeFloating();
    if (active && active.id === id) { if (id !== 'space') setSurface('sidebar'); return; }
    active?.destroy(); active = null;
    cur = id;
    store.set(memKey, id);
    stage.replaceChildren();
    const open = id !== 'space';
    stage.hidden = !open;
    page.classList.toggle('sb-open', open);
    if (open) {
      const v = h('section', { class: 'sbv', 'data-view': id });
      stage.append(v);
      const made = id === 'variables' ? variablesView(v) : id === 'path' ? pathView(v) : customView(v, viewById(id.slice(7)));
      active = { id, root: v, destroy: made.destroy };
      setSurface('sidebar');
    } else {
      active = { id, destroy() {} };
      setSurface(null);
    }
    paintRail();
    ctx.onView?.(id);
    // Nov 27: shared presence knows which view you're in (your cursor is only drawn on the canvas you share).
    document.body.dataset.archView = id;
    window.dispatchEvent(new CustomEvent('architect:view', { detail: { id } }));
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /* ---------------- borrowing a board object ---------------- */
  function objectFor(kind) {
    if (!ed) return null;
    const list = ed.els.filter((e) => e.type === 'widget' && e.kind === kind && !ed.isHidden(e));
    return list.find((e) => e.privateTo === me.id) || list.find((e) => e.owner === me.id) || list[0] || null;
  }
  const nodeOf = (el) => (el ? ed?.vp.querySelector(`.bp-world [data-eid="${CSS.escape(el.id)}"]`) : null);
  /** Move a board object's header + body into `box`. Returns giveBack(), or null if it isn't on the board. */
  function borrow(kind, box) {
    const el = objectFor(kind);
    const node = nodeOf(el);
    const head = node?.querySelector(':scope > .wg-head');
    const body = node?.querySelector(':scope > .wg-body');
    if (!head || !body) return null;
    box.append(head, body);
    node.classList.add('is-on-phone'); // same "lent out" state the phone uses
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => { if (node.isConnected) { node.append(head, body); node.classList.remove('is-on-phone'); } };
  }
  function missing(kind, box, retry) {
    box.replaceChildren(h('div', { class: 'sb-empty' },
      h('span', { class: 'sb-empty-ic' }, icon(WIDGETS[kind]?.icon || 'plus', 22)),
      h('p', {}, `No ${label(kind)} on this board yet.`),
      h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => { ctx.addWidget(kind); requestAnimationFrame(() => requestAnimationFrame(retry)); } }, icon('plus', 14), `Add ${label(kind)}`)));
  }

  /* ---------------- per-object zoom (Nov 23b) ----------------
     Each object in a view keeps its own scale: Path and Fleeting Moments can sit at different sizes, either
     can be locked against accidental changes, and Auto Fit hands the size back to the layout. Only that
     object's body scales — the rest of Architect stays as it is. Saved on your account (sbZoom). */
  const ZSTEPS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2];
  const zoomAll = () => getPref('sbZoom', {}) || {};
  const zoomOf = (key) => zoomAll()[key] || { z: null, locked: false };
  const saveZoom = (key, v) => setPref('sbZoom', { ...zoomAll(), [key]: v }).catch(() => {});
  function zoomControl(key, target) {
    let cur = zoomOf(key);
    const box = h('span', { class: 'sbz', role: 'group', 'aria-label': 'Zoom for this object' });
    const apply = () => {
      const z = cur.z || 1;
      const b = target();
      if (b) b.style.zoom = z === 1 ? '' : String(z);
      box.classList.toggle('is-locked', !!cur.locked);
      box.classList.toggle('is-auto', !cur.z);
      paintBox();
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    const set = (patch) => {
      if (cur.locked && !('locked' in patch)) { toast('This object’s zoom is locked — unlock it first.', { ms: 1600 }); return; }
      cur = { ...cur, ...patch };
      if (cur.z && Math.abs(cur.z - 1) < 0.001) cur.z = 1;
      saveZoom(key, cur); apply();
    };
    const step = (d) => {
      const z = cur.z || 1;
      const i = ZSTEPS.findIndex((x) => x >= z - 0.001);
      const at = i < 0 ? ZSTEPS.length - 1 : i;
      const next = d > 0 ? ZSTEPS[Math.min(ZSTEPS.length - 1, ZSTEPS[at] > z + 0.001 ? at : at + 1)] : ZSTEPS[Math.max(0, at - 1)];
      set({ z: next });
    };
    function paintBox() {
      const z = cur.z;
      box.replaceChildren(
        h('button', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', disabled: !!cur.locked, onclick: () => step(-1) }, icon('minus', 12)),
        h('button', { type: 'button', class: 'sbz-val', title: 'Zoom options', 'aria-haspopup': 'menu', onclick: (e) => menu(e.currentTarget, [
          { label: 'Auto Fit', icon: 'fit', checked: !z, disabled: !!cur.locked, onSelect: () => set({ z: null }) },
          '-',
          ...[0.5, 0.75, 0.9, 1, 1.25, 1.5].map((x) => ({ label: `${Math.round(x * 100)}%`, checked: z === x, disabled: !!cur.locked, onSelect: () => set({ z: x }) })),
          '-',
          { label: cur.locked ? 'Unlock zoom' : 'Lock zoom', icon: cur.locked ? 'lockOpen' : 'lock', onSelect: () => set({ locked: !cur.locked }) },
        ], { align: 'end' }) }, z ? `${Math.round(z * 100)}%` : 'AUTO'),
        h('button', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', disabled: !!cur.locked, onclick: () => step(1) }, icon('plus', 12)),
        h('button', { type: 'button', class: 'sbz-lock', 'aria-pressed': String(!!cur.locked), 'aria-label': cur.locked ? 'Unlock zoom' : 'Lock zoom', title: cur.locked ? 'Zoom locked' : 'Lock zoom', onclick: () => set({ locked: !cur.locked }) }, icon(cur.locked ? 'lock' : 'lockOpen', 12)));
    }
    // Ctrl/⌘ + wheel over the object zooms just the object (never the whole page).
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (cur.locked) return;
      clearTimeout(onWheel.t);
      onWheel.acc = (onWheel.acc || 0) + e.deltaY;
      onWheel.t = setTimeout(() => { const d = onWheel.acc; onWheel.acc = 0; if (Math.abs(d) > 2) step(d < 0 ? 1 : -1); }, 60);
    };
    apply();
    return { el: box, apply, onWheel, reset() { const b = target(); if (b) b.style.zoom = ''; } };
  }

  // A panel that holds one object: a borrowed board object, or your Path.
  function objectPanel(kind, { title, hideTitle, hideHeader, menuItems, zoomKey } = {}) {
    const box = h('div', { class: ['el-widget sb-obj', hideHeader && 'no-head', hideTitle && 'no-title'], 'data-wkind': kind });
    let back = null, paths = null;
    const more = menuItems ? h('button', { class: 'wg-btn sb-obj-more', type: 'button', 'aria-label': `${title || label(kind)} options`, onclick: (e) => menu(e.currentTarget, menuItems(), { align: 'end' }) }, icon('more', 15)) : null;
    const zc = zoomKey ? zoomControl(zoomKey, () => box.querySelector(':scope > .wg-body')) : null;
    if (zc) box.addEventListener('wheel', zc.onWheel, { passive: false });
    if (kind === 'path') {
      const t = h('span', { class: 'wg-title' }, (title || `${me.username}’s Path`).toUpperCase());
      const slot = h('span', { class: 'wg-slot' });
      const head = h('div', { class: 'wg-head' }, h('span', { class: 'wg-grip', 'aria-hidden': 'true' }), t, slot, h('span', { class: 'wg-space' }), zc?.el, more);
      const body = h('div', { class: 'wg-body' });
      box.append(head, body);
      paths = mountPaths(body, null, { embedded: true, owner: me.id, daySlot: slot });
      zc?.apply();
    } else {
      const fill = () => {
        back?.(); back = null;
        box.replaceChildren();
        back = borrow(kind, box);
        if (!back) { missing(kind, box, fill); return; }
        const head = box.querySelector(':scope > .wg-head');
        if (title && head) { const t = head.querySelector('.wg-title'); if (t) { t.dataset.sbOwn = t.textContent; t.textContent = title.toUpperCase(); } }
        // The board's own ··· stays at home in spirit: the panel's menu takes its place while it's here.
        if (more && head) { head.querySelector(':scope > .wg-btn:last-child')?.classList.add('sb-hide'); head.append(more); }
        if (zc && head) { const last = head.querySelector(':scope > .wg-btn:not(.sb-hide):last-of-type'); head.insertBefore(zc.el, more && more.parentNode === head ? more : last || null); zc.apply(); }
      };
      fill();
      // The object was deleted or replaced on the board: follow it.
      const off = ed?.on('change', () => { if (!box.isConnected) return; const el = objectFor(kind); const holding = box.querySelector(':scope > .wg-body'); if (!el || !holding) fill(); });
      box._off = off;
    }
    return {
      el: box,
      destroy() {
        box._off?.();
        if (zc) { zc.reset(); zc.el.remove(); box.removeEventListener('wheel', zc.onWheel); }
        if (back) {
          const head = box.querySelector(':scope > .wg-head');
          const t = head?.querySelector('.wg-title');
          if (t?.dataset.sbOwn != null) { t.textContent = t.dataset.sbOwn; delete t.dataset.sbOwn; }
          head?.querySelector('.sb-hide')?.classList.remove('sb-hide');
          more?.remove();
          back();
        }
        try { paths?.destroy?.(); } catch {}
      },
    };
  }

  /* ================= PATH: Path left, Fleeting Moments right ================= */
  /* Path's own "Customize My View" (Nov 25): the very same editor as My View — every control, the same
     editing — for the Path view: show / hide the title and header, start a new layout on a blank dot grid,
     add objects, drag them freely inside the border, lock / unlock positions. No top bar, no pan, no zoom.
     Kept separately (prefs.sbPathLayout), so changing Path never changes a My View, or the other way round. */
  const pathLayout = () => getPref('sbPathLayout', null);
  const savePathLayout = (next) => setPref('sbPathLayout', next).catch((e) => toast(friendlyError(e), { tone: 'error' }));
  function pathView(v) {
    const lay = pathLayout();
    if (lay?.on) return pathCustom(v, lay);
    return pathSplit(v);
  }
  function customizePath(blank = false) {
    const ratio = Math.min(0.8, Math.max(0.25, Number(getPref('sbSplit', 0.59)) || 0.59));
    const prev = pathLayout() || {};
    const items = blank ? [] : (prev.items?.length ? prev.items : [
      { id: uid(), kind: 'path', box: { x: 0.008, y: 0.012, w: ratio - 0.016, h: 0.976 } },
      { id: uid(), kind: 'fleeting', box: { x: ratio + 0.008, y: 0.012, w: 1 - ratio - 0.016, h: 0.976 } },
    ]);
    savePathLayout({ ...prev, on: true, items, locked: false }).then(() => { if (cur === 'path') { active?.destroy(); active = null; cur = ''; show('path'); } });
  }
  function pathCustom(v, lay) {
    v.classList.add('sbv-path-custom');
    let state = { ...lay };
    const io = {
      zoomPrefix: 'path',
      save: (patch) => { state = { ...state, ...patch, on: true }; return savePathLayout(state); },
      controls: () => [h('button', { type: 'button', class: 'mv-ctl', title: 'Customize My View', 'aria-label': 'Customize My View', onclick: (e) => menu(e.currentTarget, io.menu(), { align: 'end' }) }, icon('more', 15))],
      menu: () => [
        { header: 'Customize My View' },
        { label: 'New blank layout', icon: 'grid', onSelect: () => customizePath(true) },
        { label: 'Back to the standard layout', icon: 'collapse', onSelect: () => savePathLayout({ ...state, on: false }).then(() => { active?.destroy(); active = null; cur = ''; show('path'); }) },
      ],
    };
    return customView(v, { id: 'path', name: 'Path', items: lay.items || [], locked: !!lay.locked }, io);
  }
  function pathSplit(v) {
    const left = objectPanel('path', { zoomKey: 'path:path' });
    const right = objectPanel('fleeting', { zoomKey: 'path:fleeting' });
    v.classList.add('sbv-split');
    // The split itself: drag the gutter to give either side more room (remembered on your account).
    let ratio = Math.min(0.8, Math.max(0.25, Number(getPref('sbSplit', 0.59)) || 0.59));
    const a = h('div', { class: 'sbv-col', style: { flex: `${ratio} 1 0` } }, left.el);
    const b = h('div', { class: 'sbv-col', style: { flex: `${1 - ratio} 1 0` } }, right.el);
    const gutter = h('button', { type: 'button', class: 'sbv-gutter', 'aria-label': 'Resize Path and Fleeting Moments', title: 'Drag to resize · double-click to reset' }, h('i'));
    const row = h('div', { class: 'sbv-cols' }, a, gutter, b);
    const setRatio = (r, save) => {
      ratio = Math.min(0.8, Math.max(0.25, r));
      a.style.flex = `${ratio} 1 0`; b.style.flex = `${1 - ratio} 1 0`;
      if (save) setPref('sbSplit', Math.round(ratio * 1000) / 1000).catch(() => {});
      window.dispatchEvent(new Event('resize'));
    };
    gutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gutter.classList.add('is-drag');
      const r = row.getBoundingClientRect();
      const move = (ev) => setRatio((ev.clientX - r.left) / r.width, false);
      const up = () => { gutter.classList.remove('is-drag'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setRatio(ratio, true); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    gutter.addEventListener('dblclick', () => setRatio(0.59, true));
    gutter.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setRatio(ratio + (e.key === 'ArrowLeft' ? -0.03 : 0.03), true); } });
    v.append(row);
    // The way into Customize My View: a quiet control in the corner, and a right-click on the gutter.
    v.append(h('button', { type: 'button', class: 'sbv-customize', title: 'Customize My View', 'aria-label': 'Customize My View', onclick: (e) => menu(e.currentTarget, [
      { header: 'Customize My View' },
      { label: 'Edit this layout', icon: 'layers', onSelect: () => customizePath(false) },
      { label: 'New blank layout', icon: 'grid', onSelect: () => customizePath(true) },
    ], { align: 'end' }) }, icon('layers', 14)));
    gutter.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, [{ label: 'Customize My View…', icon: 'layers', onSelect: () => customizePath(false) }]); });
    return { destroy() { left.destroy(); right.destroy(); } };
  }

  /* ================= VARIABLES ================= */
  // Nov 24 — the sidebar is where Variables gets edited:
  //   · right-click a space tab, a subsection, a chat or an object for its menu (rename in place, color,
  //     add, move, delete, undo);
  //   · a subsection's + adds a chat straight into it; NEW CHAT is an inline field, not a pop-up;
  //   · drag chats to reorder them (or onto a subsection) — a line shows exactly where they'll land;
  //   · a space someone shared with you has the same controls, menus and Free View (data/varshare.js);
  //   · the Organs space holds the Organ chats that used to live in Side Chat (private to you).
  function variablesView(v) {
    v.classList.add('sbv-vars');
    const vmem = `architect.sb.vars.${me.id}`;
    const st = store.get(vmem, {}) || {};
    let cat = st.cat || null;      // a top-level section id, or "s:<sharedItemId>" for someone else's space
    let open = st.open || null;    // entry id
    let mapMode = null;            // null | 'compact' | 'full'
    let sideHidden = !!st.sideHidden;
    let adding = null;             // { parent } — the inline "new chat" field is open under this section
    let renaming = null;           // { kind: 'entry' | 'sec', id } — renaming in place
    const remember = () => store.set(vmem, { cat, open, sideHidden });
    // Nov 25 — subsections fold away (the toggle beside each one); remembered on this device.
    const foldKey = `architect.sb.folded.${me.id}`;
    const folded = new Set(store.get(foldKey, []) || []);
    const toggleFold = (id) => { if (folded.has(id)) folded.delete(id); else folded.add(id); store.set(foldKey, [...folded].slice(-400)); paintList(true); };
    // A small picture beside a name — only when there is one (no placeholder, no empty space).
    const thumb = (path) => {
      if (!path) return null;
      const url = urlOf(path, () => paintList());
      return url ? h('img', { class: 'sbv-thumb', src: url, alt: '', draggable: false, loading: 'lazy' }) : null;
    };

    /* ---------- sources: your Variables, or a space shared with you ---------- */
    const mine = () => myVars() || { sections: null, entries: [] };
    const foreign = () => foreignCats();
    const isForeign = () => String(cat || '').startsWith('s:');
    const foreignItem = () => foreign().find((x) => `s:${x.id}` === cat) || null;
    const S = () => (isForeign() && foreignItem() ? sharedSource(foreignItem().id) : myVarsSource);
    const acct = () => S().get() || { sections: null, entries: [] };
    const sections = () => acct().sections || [];
    const entries = () => acct().entries || [];
    const tops = () => (mine().sections || []).filter((s) => !s.parent);
    const kids = (id) => sections().filter((s) => s.parent === id);
    const entriesIn = (id) => entries().filter((e) => e.section === id);
    const secById = (id) => sections().find((s) => s.id === id);
    const rootId = () => (isForeign() ? foreignItem()?.data?.catId || null : cat);
    const curSpace = () => (isForeign() ? secById(rootId()) : (mine().sections || []).find((x) => x.id === cat)) || null;
    const isOrgans = () => !isForeign() && !!curSpace()?.organs;
    const setV = (p) => S().set(p);
    const offUndo = trackUndo(v, { undo: () => S().undo(), redo: () => S().redo(), canUndo: () => S().canUndo?.(), canRedo: () => S().canRedo?.() });
    const undoItem = () => ({ label: 'Undo', icon: 'undo', kbd: '⌘Z', disabled: !S().canUndo?.(), onSelect: () => S().undo() });

    // The chat pane is a standard Variables object, driven from here (on whichever source is current).
    const chatTools = h('span', { class: 'sbv-chattools' });
    const chatHost = h('div', { class: 'sbv-chat' });
    const organHost = h('div', { class: 'sbv-organs', hidden: true });
    let chatCtl = null, chatKey = null;
    function ensureChat() {
      const key = isForeign() ? cat : 'mine';
      if (chatCtl && chatKey === key) return chatCtl;
      try { chatCtl?.destroy?.(); } catch {}
      chatHost.replaceChildren();
      chatKey = key;
      chatCtl = mountVariables(chatHost, { id: `sidebar-${me.id}-${key}`, kind: 'variables', sections: [], entries: [] }, { host: { personal: false }, sidebar: true, chatTools, source: S() });
      return chatCtl;
    }
    const side = h('aside', { class: 'sbv-side' });
    const top = h('div', { class: 'sbv-cats', role: 'tablist', 'aria-label': 'Spaces' });
    const main = h('div', { class: 'sbv-main' }, top, chatHost, organHost);
    const mapLayer = h('div', { class: 'sbv-map', hidden: true });
    v.append(side, main, mapLayer);
    // Nov 27 — drag the sidebar's right edge to make it wider or narrower (remembered on your account). A wider
    // sidebar shows more of each name; the hierarchy and layout don't change. The edge never opens a menu.
    const SW = [180, 520];
    const applySideW = () => { const w0 = Number(getPref('sbvSideW', 0)) || 0; side.style.width = w0 ? `${Math.min(SW[1], Math.max(SW[0], w0))}px` : ''; };
    applySideW();
    const sizer = h('div', { class: 'sbv-side-sizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the chat sidebar', tabindex: 0, title: 'Drag to resize · double-click to reset' });
    sizer.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    sizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = side.getBoundingClientRect().width;
      sizer.setPointerCapture(e.pointerId); sizer.classList.add('is-drag');
      const mv = (ev) => { side.style.width = `${Math.round(Math.min(SW[1], Math.max(SW[0], w0 + ev.clientX - x0)))}px`; };
      const up = () => { sizer.removeEventListener('pointermove', mv); sizer.removeEventListener('pointerup', up); sizer.classList.remove('is-drag'); setPref('sbvSideW', Math.round(side.getBoundingClientRect().width)).catch(() => {}); window.dispatchEvent(new Event('resize')); };
      sizer.addEventListener('pointermove', mv); sizer.addEventListener('pointerup', up);
    });
    sizer.addEventListener('dblclick', () => { setPref('sbvSideW', 0).catch(() => {}); side.style.width = ''; });
    sizer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const w1 = Math.min(SW[1], Math.max(SW[0], side.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -16 : 16)));
      side.style.width = `${w1}px`; setPref('sbvSideW', Math.round(w1)).catch(() => {});
    });
    // Right-click on the sidebar's empty background: the current space's own menu (New chat first). Chats and
    // subsections keep their own menus.
    side.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.sbv-row, .sbv-group, .sbv-side-sizer, .sbv-mapsq, .sbv-mapcard, .sbv-spacepick, input')) return;
      e.preventDefault();
      catMenu({ x: e.clientX, y: e.clientY }, curSpace());
    });
    let mapCtl = null;

    /* ---------- Organs (the Organ chats, moved here from Side Chat) ---------- */
    let organs = null;
    function ensureOrgans() {
      if (organs) return organs;
      organs = mountSideChat({ me, embed: organHost, onChats: () => { if (isOrgans()) paintList(); } });
      return organs;
    }

    function pickCat(id) {
      cat = id; open = null; adding = null; renaming = null;
      const first = firstEntry();
      if (first) open = first.id;
      remember(); paint();
    }
    function firstEntry() {
      if (isOrgans()) return null;
      const ids = subtree(rootId());
      return entries().find((e) => ids.has(e.section)) || null;
    }
    function subtree(id) {
      const out = new Set([id]); let grew = true;
      while (grew) { grew = false; for (const s of sections()) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; } }
      return out;
    }

    function cover(s, { foreignOwner } = {}) {
      const url = s.img ? urlOf(s.img, paint) : null;
      return h('span', { class: ['sbv-cover', s.color && 'has-color'], style: { '--h': hue(s.name), ...(s.color ? { '--vc': s.color } : {}) } },
        url ? h('img', { src: url, alt: '', draggable: false }) : s.organs ? icon('spark', 15) : h('b', {}, (s.name || '?').trim().slice(0, 1).toUpperCase()),
        foreignOwner ? h('i', { class: 'sbv-owner', title: `Shared by ${foreignOwner}` }, foreignOwner.slice(0, 1).toUpperCase()) : null);
    }

    function paintTop() {
      const mineTabs = tops().map((s) => h('button', {
        type: 'button', role: 'tab', class: ['sbv-cat', cat === s.id && 'is-on'], 'aria-selected': String(cat === s.id), title: s.organs ? `${s.name} · Organ chats (private)` : s.share?.item ? `${s.name} · shared` : s.name,
        onclick: () => pickCat(s.id), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); catMenu({ x: e.clientX, y: e.clientY }, s); },
      }, h('span', { class: 'sbv-cat-name' }, s.name || 'Space')));
      const theirs = foreign().map((it) => h('button', {
        type: 'button', role: 'tab', class: ['sbv-cat is-theirs', cat === `s:${it.id}` && 'is-on'], 'aria-selected': String(cat === `s:${it.id}`), title: `${it.data?.name || 'Space'} · shared by ${it.data?.owner || 'a member'}`,
        onclick: () => pickCat(`s:${it.id}`),
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); if (cat !== `s:${it.id}`) pickCat(`s:${it.id}`); catMenu({ x: e.clientX, y: e.clientY }, secById(rootId())); },
      }, h('span', { class: 'sbv-cat-name' }, it.data?.name || 'Space')));
      const s = !isForeign() && curSpace();
      const shareBtn = s && !s.organs ? h('button', {
        type: 'button', class: ['sbv-share', s.share?.item && 'is-on'], 'aria-pressed': String(!!s.share?.item),
        title: s.share?.item ? 'Shared with your Space — click to make it private' : 'Private — click to share it with your Space',
        onclick: () => toggleShare(s),
      }, icon(s.share?.item ? 'users' : 'lock', 15), h('span', {}, s.share?.item ? 'SHARED' : 'PRIVATE'))
        : s?.organs ? h('span', { class: 'sbv-share is-ro', title: 'The Organ chats are private to you' }, icon('lock', 15), h('span', {}, 'PRIVATE'))
          : isForeign() ? h('span', { class: 'sbv-share is-ro' }, icon('users', 15), h('span', {}, `SHARED BY ${(foreignItem()?.data?.owner || '').toUpperCase()}`)) : null;
      top.replaceChildren(sideHidden ? sideToggle() : '', h('div', { class: 'sbv-cats-row' }, ...mineTabs, ...theirs), h('span', { class: 'sbv-flex' }), chatTools, shareBtn || '');
    }
    // Spaces are added from a right-click on the row of tiles.
    top.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.sbv-cat, .sbv-share, .sbv-icon, .sbv-chattools')) return;
      e.preventDefault();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: 'New space…', icon: 'plus', onSelect: newCategory },
        tops().some((x) => x.organs) ? null : { label: 'New Organs space…', icon: 'spark', onSelect: newOrgans },
        '-', undoItem(),
      ].filter(Boolean));
    });
    const sideToggle = () => h('button', {
      type: 'button', class: 'sbv-icon sbv-sidetoggle', 'aria-pressed': String(!sideHidden),
      'aria-label': sideHidden ? 'Show the chat sidebar' : 'Hide the chat sidebar', title: sideHidden ? 'Show sidebar' : 'Hide sidebar',
      onclick: () => { sideHidden = !sideHidden; remember(); paint(); },
    }, icon('sidebar', 17));

    function paintSide() {
      v.classList.toggle('is-side-hidden', sideHidden);
      const sp = curSpace();
      const name = isForeign() ? (foreignItem()?.data?.name || 'Shared') : (sp?.name || 'Variables');
      const pick = h('button', { type: 'button', class: 'sbv-spacepick', title: 'Switch space', 'aria-haspopup': 'menu', onclick: (e) => catPicker(e.currentTarget),
        oncontextmenu: (e) => { if (!sp) return; e.preventDefault(); catMenu({ x: e.clientX, y: e.clientY }, sp); },
      }, h('span', {}, name), icon('chevronDown', 14));
      list = h('div', { class: 'sbv-list', role: 'list' });
      side.replaceChildren(h('header', { class: 'sbv-spacebar' }, h('span', { class: 'wg-grip sbv-dothandle', 'aria-hidden': 'true' }), pick, sideToggle()), list, mapCard(), sizer);
      paintList();
    }
    let list = null;
    const inline = (placeholder, done, value = '') => {
      const inp = h('input', { class: 'sbv-inline', placeholder, value, maxlength: 120, 'aria-label': placeholder, spellcheck: false });
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; done(ok ? inp.value.replace(/\s+/g, ' ').trim() : null); };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(!!inp.value.trim() && value !== inp.value.trim() ? true : false));
      requestAnimationFrame(() => { inp.focus(); if (value) inp.select(); });
      return inp;
    };

    // Typing a name in place: background repaints (a sync, another device) wait until you're done.
    const typing = () => !!list && list.contains(document.activeElement) && document.activeElement.classList.contains('sbv-inline');
    function paintList(force = false) {
      if (!list) return;
      if (!force && typing() && (adding || renaming)) return;
      const out = [];
      if (isOrgans()) {
        const o = ensureOrgans();
        const act = o.active();
        out.push(adding?.parent === 'organs'
          ? inline('New organ name', (n) => { adding = null; if (n) o.add(n).then(() => paintList(true)); else paintList(true); })
          : h('button', { type: 'button', class: 'sbv-row sbv-new', onclick: () => { adding = { parent: 'organs' }; paintList(); } }, icon('plus', 13), h('span', {}, 'NEW ORGAN')));
        for (const [i, c] of o.chats().entries()) {
          out.push(h('button', {
            type: 'button', role: 'listitem', class: ['sbv-row', act === c.id && 'is-on'], 'data-oid': c.id, 'data-i': i, title: c.anytype_id ? `${c.name} · synced with Anytype` : c.name,
            onclick: () => { o.select(c.id); paintList(); },
            oncontextmenu: (e) => { e.preventDefault(); o.menu({ x: e.clientX, y: e.clientY }, c.id); },
          }, h('span', { class: 'sbv-row-name' }, (c.name || 'Untitled').toUpperCase()), c.anytype_id ? h('em', { title: 'Synced with Anytype' }, icon('anytype', 11)) : null));
        }
        if (!o.chats().length) out.push(h('p', { class: 'sbv-hint' }, o.loaded() ? 'No organs yet.' : 'Loading…'));
        out.push(h('button', { type: 'button', class: ['sbv-row sbv-ideas', act === 'ideas' && 'is-on'], onclick: () => { o.ideas(true); paintList(); } }, icon('bulb', 13), h('span', {}, 'IDEAS')));
        list.replaceChildren(...out);
        return;
      }
      const row = (x, depth = 0) => renaming?.kind === 'entry' && renaming.id === x.id
        ? h('div', { class: 'sbv-row is-renaming', style: { '--d': depth } }, inline('Chat name', (n) => { renaming = null; if (n) setV({ entries: entries().map((e) => (e.id === x.id ? { ...e, name: n.slice(0, 120) } : e)) }); paintList(true); }, x.name))
        : h('button', {
          type: 'button', role: 'listitem', class: ['sbv-row', open === x.id && 'is-on', x.color && 'has-color'], style: { '--d': depth, ...(x.color ? { '--vc': x.color } : {}) }, 'data-eid': x.id,
          onclick: () => { if (v._dragged) return; open = x.id; remember(); paintList(); paintMain(); },
          ondblclick: () => { renaming = { kind: 'entry', id: x.id }; paintList(); },
          oncontextmenu: (e) => { e.preventDefault(); entryMenu({ x: e.clientX, y: e.clientY }, x); },
        }, thumb(x.photo), h('span', { class: 'sbv-row-name' }, (x.name || 'Untitled').toUpperCase()), (x.notes || []).length ? h('em', {}, String((x.notes || []).length)) : null);
      const groupRow = (s, depth) => renaming?.kind === 'sec' && renaming.id === s.id
        ? h('div', { class: 'sbv-group is-renaming', style: { '--d': depth } }, inline('Subsection name', (n) => { renaming = null; if (n) setV({ sections: sections().map((y) => (y.id === s.id ? { ...y, name: n.slice(0, 120) } : y)) }); paintList(true); }, s.name))
        : h('div', {
          class: ['sbv-group', s.color && 'has-color', folded.has(s.id) && 'is-folded'], style: { '--d': depth, ...(s.color ? { '--vc': s.color } : {}) }, 'data-sid': s.id,
          ondblclick: (e) => { if (e.target.closest('.sbv-fold')) return; renaming = { kind: 'sec', id: s.id }; paintList(); },
          oncontextmenu: (e) => { e.preventDefault(); groupMenu({ x: e.clientX, y: e.clientY }, s); },
        }, h('button', {
          type: 'button', class: 'sbv-fold', 'aria-expanded': String(!folded.has(s.id)),
          'aria-label': `${folded.has(s.id) ? 'Expand' : 'Collapse'} ${s.name}`, title: folded.has(s.id) ? 'Expand' : 'Collapse',
          onclick: (e) => { e.stopPropagation(); toggleFold(s.id); },
        }, icon(folded.has(s.id) ? 'chevronRight' : 'chevronDown', 12)),
          thumb(s.img),
          h('span', { class: 'sbv-group-name' }, s.name.toUpperCase()),
          h('button', { type: 'button', class: 'sbv-group-add', title: `New chat in ${s.name}`, 'aria-label': `New chat in ${s.name}`, onclick: () => { adding = { parent: s.id }; paintList(); } }, icon('plus', 12)));
      const addField = (parent, depth) => h('div', { class: 'sbv-row is-adding', style: { '--d': depth } },
        inline('New chat name', (n) => { adding = null; if (n) createChat(parent, n); else paintList(true); }));
      const r = rootId();
      if (r) {
        // Nov 27: no standalone + New chat row — New chat is first in the space's menu (right-click the sidebar).
        if (adding?.parent === r) out.push(addField(r, 0));
        const walk = (id, depth) => {
          for (const x of entriesIn(id)) out.push(row(x, depth));
          for (const s of kids(id)) {
            out.push(groupRow(s, depth));
            if (adding?.parent === s.id) { folded.delete(s.id); out.push(addField(s.id, depth + 1)); }
            if (!folded.has(s.id)) walk(s.id, depth + 1);
          }
        };
        walk(r, 0);
      }
      if (!out.length) out.push(h('p', { class: 'sbv-hint' }, r ? 'No chats yet — right-click here for New chat.' : 'Right-click the top bar to add a space.'));
      list.replaceChildren(...out);
    }

    /* ---------- drag to reorder (with a line where it lands) ---------- */
    function startDrag(e) {
      if (e.button !== 0 || renaming) return;
      const rowEl = e.target.closest('.sbv-row[data-eid], .sbv-row[data-oid]');
      if (!rowEl || !list?.contains(rowEl)) return;
      const organ = !!rowEl.dataset.oid;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null, target = null;
      const line = h('i', { class: 'sbv-drop-line', hidden: true });
      const clearMarks = () => list.querySelectorAll('.is-drop-in').forEach((n) => n.classList.remove('is-drop-in'));
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          const r0 = rowEl.getBoundingClientRect();
          ghost = rowEl.cloneNode(true);
          ghost.classList.add('sbv-ghost');
          Object.assign(ghost.style, { width: `${r0.width}px`, left: `${r0.left}px`, top: `${r0.top}px` });
          document.body.append(ghost);
          rowEl.classList.add('is-lifted');
          list.append(line);
          v._dragged = true;
        }
        ghost.style.transform = `translate3d(0, ${ev.clientY - sy}px, 0)`;
        clearMarks(); target = null; line.hidden = true;
        const over = document.elementFromPoint(ev.clientX, ev.clientY);
        const lr = list.getBoundingClientRect();
        const r2 = over?.closest?.(organ ? '.sbv-row[data-oid]' : '.sbv-row[data-eid]');
        const g = !organ && over?.closest?.('.sbv-group[data-sid]');
        if (r2 && list.contains(r2) && r2 !== rowEl) {
          const b = r2.getBoundingClientRect();
          const after = ev.clientY > b.top + b.height / 2;
          target = { kind: 'row', id: r2.dataset.eid || r2.dataset.oid, i: Number(r2.dataset.i), after };
          line.hidden = false;
          line.style.top = `${(after ? b.bottom : b.top) - lr.top + list.scrollTop - 1}px`;
          line.style.left = `${b.left - lr.left + 6}px`; line.style.width = `${b.width - 12}px`;
        } else if (g && list.contains(g)) {
          target = { kind: 'group', id: g.dataset.sid };
          g.classList.add('is-drop-in');
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        clearMarks(); line.remove();
        if (!ghost) return;
        ghost.remove(); rowEl.classList.remove('is-lifted');
        setTimeout(() => { v._dragged = false; }, 0);
        if (!target) return;
        if (organ) {
          const from = Number(rowEl.dataset.i);
          let to = target.i + (target.after ? 1 : 0);
          if (from < to) to -= 1;
          organs?.move(rowEl.dataset.oid, to);
          return;
        }
        const id = rowEl.dataset.eid;
        const x = entries().find((y) => y.id === id);
        if (!x) return;
        const rest = entries().filter((y) => y.id !== id);
        if (target.kind === 'group') {
          const lastIn = rest.map((y, i) => (y.section === target.id ? i : -1)).filter((i) => i >= 0).pop();
          rest.splice(lastIn == null ? rest.length : lastIn + 1, 0, { ...x, section: target.id });
        } else {
          const ref = rest.find((y) => y.id === target.id);
          if (!ref) return;
          const i = rest.indexOf(ref);
          rest.splice(target.after ? i + 1 : i, 0, { ...x, section: ref.section });
        }
        setV({ entries: rest });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    }
    side.addEventListener('pointerdown', startDrag);

    /* ---------- the map ---------- */
    // Nov 26 — the square is the map itself, shrunk: the same Variables map the expand button opens (its
    // nodes where they sit, their connections), drawn straight on the card — no badges, no inner frame.
    let mini = null; // { key, node, ctl, ro }
    function mapCard() {
      if (!rootId() || isOrgans()) return h('span');
      const key = `${cat}`;
      if (!mini || mini.key !== key) {
        destroyMini();
        const stage = h('div', { class: 'sbv-mapmini-stage', 'aria-hidden': 'true', inert: '' });
        const node = h('div', { class: 'sbv-mapmini' }, stage);
        const ctl = mountVariables(stage, { id: `sidebar-mini-${me.id}-${cat}`, kind: 'variables', sections: [], entries: [] }, { host: { personal: false }, field: true, source: S(), preview: true });
        ctl.show?.({ section: rootId(), sub: null, open: null });
        // The map is laid out at a fixed size and scaled to the card, so it looks like the open map.
        const fit = () => { const w = node.clientWidth || 1; node.style.setProperty('--mk', String(w / 560)); };
        const ro = new ResizeObserver(fit); ro.observe(node);
        mini = { key, node, ctl, ro };
        requestAnimationFrame(fit);
      } else mini.ctl.show?.({ section: rootId(), sub: null, open: null });
      return h('div', { class: 'sbv-mapsq has-preview is-live', role: 'button', tabindex: 0, 'aria-label': 'Open the map', onclick: () => openMap('compact'),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMap('compact'); } } },
        mini.node,
        h('button', { type: 'button', class: 'sbv-mapsq-full', 'aria-label': 'Open the map full screen', title: 'Open the map', onclick: (e) => { e.stopPropagation(); openMap('full'); } }, icon('fullscreen', 14)));
    }
    function destroyMini() { if (!mini) return; try { mini.ro.disconnect(); mini.ctl.destroy?.(); } catch {} mini = null; }
    function openMap(mode) {
      mapMode = mode;
      if (mapCtl?._watch) clearInterval(mapCtl._watch);
      mapCtl?.destroy(); mapCtl = null;
      const s = secById(rootId());
      const body = h('div', { class: 'sbv-map-body' });
      const field = h('div', { class: 'sbv-field' }, h('span', { class: 'sbv-field-name', 'aria-hidden': 'true' }, s?.name || ''), body);
      const ctl = h('div', { class: 'sbv-map-ctl' },
        h('button', { type: 'button', class: 'sbv-icon', 'aria-label': mode === 'full' ? 'Compact' : 'Full screen', title: mode === 'full' ? 'Compact' : 'Full screen', onclick: () => openMap(mode === 'full' ? 'compact' : 'full') }, icon(mode === 'full' ? 'exitFullscreen' : 'fullscreen', 15)),
        h('button', { type: 'button', class: 'sbv-icon', 'aria-label': 'Close the map', title: 'Close', onclick: closeMap }, icon('close', 15)));
      mapLayer.replaceChildren(h('div', { class: ['sbv-map-card is-field', `is-${mode}`], 'data-wkind': 'variables' }, field, ctl));
      mapLayer.hidden = false;
      mapLayer.classList.toggle('is-full', mode === 'full');
      mapCtl = mountVariables(body, { id: `sidebar-map-${me.id}-${cat}`, kind: 'variables', sections: [], entries: [] }, { host: { personal: false }, field: true, source: S() });
      mapCtl.show?.({ section: rootId(), sub: null, open: null });
      // Opening a variable from the map opens its chat in the main pane.
      const watch = setInterval(() => {
        const st2 = mapCtl?.state?.();
        if (!st2?.open) return;
        open = st2.open; remember();
        mapCtl.show({ open: null });
        closeMap(); paint();
      }, 200);
      mapCtl._watch = watch;
    }
    function topOf(entryId) {
      const x = entries().find((e) => e.id === entryId);
      let s = x && secById(x.section);
      const seen = new Set();
      while (s?.parent && !seen.has(s.id)) { seen.add(s.id); s = secById(s.parent); }
      return s?.id || null;
    }
    function closeMap() { if (mapCtl?._watch) clearInterval(mapCtl._watch); mapCtl?.destroy(); mapCtl = null; mapMode = null; mapLayer.hidden = true; mapLayer.replaceChildren(); }
    const onEsc = (e) => { if (e.key === 'Escape' && mapMode && !document.querySelector('.dlg, .menu')) { e.preventDefault(); closeMap(); } };
    window.addEventListener('keydown', onEsc);

    /* ---------- the main pane ---------- */
    function paintMain() {
      main.querySelector('.sbv-blank')?.remove();
      if (isOrgans()) {
        chatHost.hidden = true; organHost.hidden = false;
        chatTools.replaceChildren(h('button', { type: 'button', class: 'sbv-icon', title: 'Organs options', 'aria-label': 'Organs options', onclick: (e) => ensureOrgans().options(e.currentTarget) }, icon('more', 14)));
        ensureOrgans();
        return;
      }
      organHost.hidden = true;
      const x = open && entries().find((e) => e.id === open);
      const ctl = ensureChat();
      chatHost.hidden = !x;
      if (!x) {
        chatTools.replaceChildren();
        main.append(blank(rootId() ? (sideHidden ? 'Open the sidebar to pick a chat.' : 'Pick a chat on the left — or make a new one.') : 'Right-click the top bar to add a space.'));
        return;
      }
      const st2 = ctl.state?.() || {};
      if (st2.open !== x.id) ctl.show({ section: topOf(x.id), sub: null, open: x.id });
    }
    const blank = (t) => h('div', { class: 'sbv-blank' }, h('span', { class: 'sbv-blank-ic' }, icon('chat', 22)), h('p', {}, t));

    function paint() {
      if (typing()) { paintTop(); return; }
      if (!isForeign() && !tops().some((s) => s.id === cat)) { cat = tops()[0]?.id || null; open = null; }
      if (isForeign() && !foreignItem()) { cat = tops()[0]?.id || null; open = null; }
      if (open && !entries().some((e) => e.id === open)) open = null;
      if (!open) { const f = firstEntry(); if (f) open = f.id; }
      remember();
      paintTop(); paintSide(); paintMain();
    }

    /* ---------- actions ---------- */
    function catPicker(anchor) {
      const cur = curSpace();
      menu(anchor, [
        { header: 'Your spaces' },
        ...tops().map((s) => ({ label: s.name, checked: s.id === cat, icon: s.organs ? 'spark' : s.share?.item ? 'users' : 'lock', onSelect: () => pickCat(s.id) })),
        ...(foreign().length ? ['-', { header: 'Shared with you' }, ...foreign().map((it) => ({ label: `${it.data?.name || 'Space'} · ${it.data?.owner || ''}`, checked: cat === `s:${it.id}`, icon: 'users', onSelect: () => pickCat(`s:${it.id}`) }))] : []),
        '-',
        cur ? { label: `${cur.name} options…`, icon: 'more', onSelect: () => catMenu(anchor, cur) } : null,
        { label: 'New space…', icon: 'plus', onSelect: newCategory },
      ].filter(Boolean));
    }
    function catMenu(anchor, s) {
      if (!s) return;
      if (s.organs) {
        menu(anchor, [
          { header: s.name },
          { label: 'New organ', icon: 'plus', onSelect: () => { if (cat !== s.id) pickCat(s.id); adding = { parent: 'organs' }; paintList(); } },
          { label: 'Rename…', icon: 'edit', onSelect: () => rename(s) },
          { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, s.color).then((c) => { if (c !== undefined) patchMine(s.id, { color: c }); }) },
          { label: s.img ? 'Change cover' : 'Add a cover', icon: 'image', onSelect: () => setCover(s) },
          { label: 'Messages are kept in…', icon: 'settings', onSelect: () => { if (cat !== s.id) pickCat(s.id); ensureOrgans().options(anchor); } },
          '-',
          { label: 'Remove this space', icon: 'trash', danger: true, onSelect: async () => {
            if (!(await confirmDialog(`Remove ${s.name}?`, 'Only the space goes. The Organ chats and their messages stay on your account — add an Organs space again to see them.', { ok: 'Remove space' }))) return;
            setMyVars({ sections: (mine().sections || []).filter((x) => x.id !== s.id) });
          } },
        ]);
        return;
      }
      const theirs = isForeign();
      menu(anchor, [
        { header: s.name },
        { label: 'New chat', icon: 'plus', onSelect: () => { adding = { parent: s.id }; paintList(); } },
        { label: 'New sub-section…', icon: 'folder', onSelect: () => newSub(s) },
        { label: 'Rename…', icon: 'edit', onSelect: () => rename(s) },
        { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, s.color).then((c) => { if (c !== undefined) patchSec(s.id, { color: c }); }) },
        { label: s.img ? 'Change cover' : 'Add a cover', icon: 'image', onSelect: () => setCover(s) },
        s.img ? { label: 'Remove cover', icon: 'eyeOff', onSelect: () => patchSec(s.id, { img: null }) } : null,
        theirs ? null : { label: s.share?.item ? 'Make private' : 'Share with your Space', icon: s.share?.item ? 'lock' : 'users', onSelect: () => toggleShare(s) },
        { label: 'Open map', icon: 'grid', onSelect: () => openMap('compact') },
        '-',
        undoItem(),
        theirs ? null : { label: 'New space…', icon: 'plus', onSelect: newCategory },
        '-',
        { label: 'Delete space…', icon: 'trash', danger: true, onSelect: () => deleteSpace(s) },
      ].filter(Boolean));
    }
    /* Nov 26 — Delete Space, for your own spaces and the shared ones you may delete. The confirmation names the
       space; for a shared one it says plainly that it goes for everyone. Gone after a reload too: your copy is
       removed from your account and the shared copy from the database. */
    async function deleteSpace(s) {
      const theirs = isForeign();
      const it = theirs ? foreignItem() : null;
      const shared = theirs || !!s.share?.item;
      const ok = await confirmDialog(`Delete ${s.name}?`, shared
        ? `${s.name} is shared: it will be deleted for both members — its chats, messages and pictures — not just removed from your sidebar. This can't be undone.`
        : `${s.name} and everything in it — its chats, sub-sections and messages — are deleted from your account. This can't be undone.`,
        { ok: shared ? 'Delete for everyone' : 'Delete space', danger: true });
      if (!ok) return;
      try {
        if (theirs) {
          if (!it) throw new Error('This space is no longer shared with you.');
          // Nov 27: either member may delete it, whoever created it.
          await deleteSharedCat(it);
        } else {
          if (s.share?.item) { try { await removeShared({ id: s.share.item }); } catch (e) { throw new Error(`Couldn’t delete the shared copy — ${friendlyError(e)}`); } }
          const v = mine();
          const gone = new Set(subtreeIds(v.sections || [], s.id));
          setMyVars({ sections: (v.sections || []).filter((x) => !gone.has(x.id)), entries: (v.entries || []).filter((e) => !gone.has(e.section)) });
          await flushMyVars();
        }
        const next = tops().find((x) => x.id !== s.id && !x.organs) || tops().find((x) => x.id !== s.id) || null;
        cat = next?.id || null; open = null; remember();
        toast(`${s.name} deleted.`, { ms: 2200 });
      } catch (e) {
        toast(/permission|denied|rls|policy|0 rows|not allowed/i.test(String(e?.message)) ? `Only ${s.name}’s owner can delete it.` : (e?.message || friendlyError(e)), { tone: 'error', ms: 5000 });
      }
      paint();
    }
    function subtreeIds(list, rootId) {
      const out = [rootId];
      for (let i = 0; i < out.length; i++) for (const x of list) if (x.parent === out[i] && !out.includes(x.id)) out.push(x.id);
      return out;
    }
    function groupMenu(anchor, s) {
      menu(anchor, [
        { header: s.name },
        { label: 'New chat here', icon: 'plus', onSelect: () => { adding = { parent: s.id }; paintList(); } },
        { label: 'New sub-section…', icon: 'folder', onSelect: () => newSub(s) },
        { label: 'Rename', icon: 'edit', kbd: 'Dbl-click', onSelect: () => { renaming = { kind: 'sec', id: s.id }; paintList(); } },
        { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, s.color).then((c) => { if (c !== undefined) patchSec(s.id, { color: c }); }) },
        '-',
        undoItem(),
        { label: 'Delete sub-section', icon: 'trash', danger: true, onSelect: async () => {
          const ids = subtree(s.id);
          const n = entries().filter((e) => ids.has(e.section)).length;
          if (n && !(await confirmDialog(`Delete ${s.name}?`, `${n} chat${n === 1 ? '' : 's'} and their notes go with it. Ctrl+Z brings it back.`, { ok: 'Delete' }))) return;
          setV({ sections: sections().filter((x) => !ids.has(x.id)), entries: entries().filter((e) => !ids.has(e.section)) });
        } },
      ]);
    }
    function entryMenu(anchor, x) {
      const r = rootId();
      const dests = r ? [...subtree(r)].map((id) => secById(id)).filter((s2) => s2 && s2.id !== x.section) : [];
      menu(anchor, [
        { header: x.name },
        { label: 'Rename', icon: 'edit', kbd: 'Dbl-click', onSelect: () => { renaming = { kind: 'entry', id: x.id }; paintList(); } },
        { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, x.color).then((c) => { if (c !== undefined) setV({ entries: entries().map((e) => (e.id === x.id ? { ...e, color: c } : e)) }); }) },
        dests.length ? { header: 'Move to' } : null,
        ...dests.map((s2) => ({ label: s2.name, icon: 'folderMove', onSelect: () => setV({ entries: entries().map((e) => (e.id === x.id ? { ...e, section: s2.id } : e)) }) })),
        '-',
        undoItem(),
        { label: 'Delete chat', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirmDialog(`Delete “${x.name}”?`, `Its ${(x.notes || []).length} notes go with it. Ctrl+Z brings it back.`, { ok: 'Delete chat' }))) return;
          setV({ entries: entries().filter((e) => e.id !== x.id) });
          if (open === x.id) open = null;
        } },
      ].filter(Boolean));
    }
    const patchSec = (id, p) => setV({ sections: sections().map((x) => (x.id === id ? { ...x, ...p } : x)) });
    const patchMine = (id, p) => setMyVars({ sections: (mine().sections || []).map((x) => (x.id === id ? { ...x, ...p } : x)) });
    const ensureSecs = () => { if (!mine().sections) setMyVars({ sections: [] }); };
    async function newCategory() {
      const n = await promptDialog('New space', { placeholder: 'Money, University, Family…', maxLength: 120, ok: 'Create' });
      if (!n?.trim()) return;
      ensureSecs();
      const s = { id: uid(), name: n.trim().slice(0, 120) };
      setMyVars({ sections: [...(mine().sections || []), s] });
      pickCat(s.id);
    }
    async function newOrgans() {
      const n = await promptDialog('New Organs space', { value: 'Organs', placeholder: 'Organs', maxLength: 120, ok: 'Create' });
      if (!n?.trim()) return;
      ensureSecs();
      const s = { id: uid(), name: n.trim().slice(0, 120), organs: true };
      setMyVars({ sections: [...(mine().sections || []), s] });
      pickCat(s.id);
      toast('Your Organ chats are here now — private to you, with their Anytype links.', { ms: 3200 });
    }
    async function newSub(parent) {
      const n = await promptDialog(`New sub-section in ${parent.name}`, { maxLength: 120, ok: 'Create' });
      if (!n?.trim()) return;
      setV({ sections: [...sections(), { id: uid(), name: n.trim().slice(0, 120), parent: parent.id }] });
    }
    function createChat(parent, name) {
      if (typing()) document.activeElement.blur();
      const x = { id: uid(), section: parent, name: name.slice(0, 120), photo: null, notes: [], at: Date.now() };
      setV({ entries: [...entries(), x] });
      open = x.id; remember(); paint();
    }
    async function rename(s) {
      const n = await promptDialog('Rename space', { value: s.name, maxLength: 120 });
      if (!n?.trim()) return;
      if (isForeign() || !(mine().sections || []).some((x) => x.id === s.id)) patchSec(s.id, { name: n.trim().slice(0, 120) });
      else patchMine(s.id, { name: n.trim().slice(0, 120) });
    }
    async function setCover(s) {
      const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
      if (!f) return;
      try {
        const up = await uploadMedia(f);
        if (isForeign()) patchSec(s.id, { img: up.path }); else patchMine(s.id, { img: up.path });
      } catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    }
    async function toggleShare(s) {
      try {
        if (s.share?.item) {
          if (!(await confirmDialog(`Make ${s.name} private?`, 'The people in your shared Space stop seeing it. Your own copy stays exactly as it is.', { ok: 'Make private', danger: false }))) return;
          await unshareCategory(s.id);
          toast(`${s.name} is private.`, { ms: 2000 });
        } else {
          setSharedSpace(ctx.sharedSpaceId?.() || null);
          const { failed } = await shareCategory(s.id);
          toast(failed.length ? `${s.name} is shared — couldn’t add ${failed.join(', ')}.` : `${s.name} is shared with your Space.`, { ms: 2600 });
        }
      } catch (e) { toast(/kind_check|check constraint/i.test(String(e?.message)) ? 'Sharing needs one database update: run supabase/nov23.sql in the Supabase SQL editor.' : friendlyError(e), { tone: 'error', ms: 6000 }); }
      paint();
    }

    const offVars = onMyVars((d, keys) => { if (keys && keys.every((k) => k === 'ideas')) return; if (!isForeign()) paint(); else paintTop(); });
    const offShared = onShared(() => { paintTop(); if (isForeign()) { paintSide(); paintMain(); } });
    loadMyVars().then(() => { paint(); syncShared(); }).catch(() => paint());
    paint();
    return {
      destroy() {
        window.removeEventListener('keydown', onEsc);
        offVars(); offShared(); offUndo(); closeMap(); destroyMini();
        try { chatCtl?.destroy?.(); } catch {}
        try { organs?.destroy(); } catch {}
      },
    };
  }

  /* ================= CUSTOM VIEWS ("My View", Nov 24) =================
     No top bar: a view is a bordered dot-grid workspace at a fixed scale (it doesn't pan, zoom or grow past
     its border). Add any Architect object (right-click, or the + in the corner) and drag it where you want
     it — by its header — and resize it from its corner. Lock the layout to keep everything in place; unlock
     to adjust. Positions are fractions of the workspace (box: { x, y, w, h }), so the layout keeps its
     shape on any window size. */
  async function newView() {
    const n = await promptDialog('New view', { placeholder: 'My view', value: 'My view', maxLength: 24, ok: 'Create' });
    if (!n?.trim()) return;
    const v = { id: uid(), name: n.trim().slice(0, 24), items: [], locked: false };
    await saveViews([...views(), v]);
    show2(v.id);
  }
  const show2 = (id) => { active?.destroy(); active = null; cur = ''; show(`custom:${id}`); };
  function viewMenu(anchor, v) {
    menu(anchor, [
      { header: v.name },
      { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename view', { value: v.name, maxLength: 24 }); if (n?.trim()) { await saveViews(views().map((x) => (x.id === v.id ? { ...x, name: n.trim().slice(0, 24) } : x))); paintRail(); } } },
      { label: v.locked ? 'Unlock layout' : 'Lock layout', icon: v.locked ? 'lockOpen' : 'lock', onSelect: async () => { await saveViews(views().map((x) => (x.id === v.id ? { ...x, locked: !v.locked } : x))); if (cur === `custom:${v.id}`) show2(v.id); } },
      { label: 'Delete view', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog(`Delete “${v.name}”?`, 'Only the view goes — every object stays where it is.', { ok: 'Delete view' }))) return;
        await saveViews(views().filter((x) => x.id !== v.id));
        if (cur === `custom:${v.id}`) show('space'); else paintRail();
      } },
    ]);
  }

  const MIN_W = 0.14, MIN_H = 0.16, SNAP = 0.005;
  const clamp01 = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const snapTo = (n) => Math.round(n / SNAP) * SNAP;
  // Views saved before Nov 24 had a row of columns: give each one its column's share of the width.
  function legacyBoxes(items) {
    const total = items.reduce((n, it) => n + (it.flex || 1), 0) || 1;
    let x = 0;
    return items.map((it) => { const w = (it.flex || 1) / total; const box = { x: x + 0.006, y: 0.012, w: w - 0.012, h: 0.976 }; x += w; return it.box ? it : { ...it, box }; });
  }
  function freeBox(items) {
    const k = items.length % 6;
    return { x: 0.06 + k * 0.04, y: 0.06 + k * 0.04, w: 0.38, h: 0.56 };
  }

  // io (Nov 25): where the layout is kept — a custom view in sbViews (default), or Path's own layout.
  function customView(root2, v, io = null) {
    root2.classList.add('sbv-custom', 'sbv-myview');
    const panels = new Map(); // item id → { p, node }
    let locked = !!v.locked;
    let items = (v.items || []).some((it) => !it.box) ? legacyBoxes(v.items || []) : [...(v.items || [])];
    const save = io
      ? (patch = {}) => io.save({ items, locked, ...patch })
      : (patch = {}) => saveViews(views().map((x) => (x.id === v.id ? { ...x, items, locked, ...patch } : x))).then(() => { v = viewById(v.id) || v; });
    const field = h('div', { class: ['mv-field', locked && 'is-locked'], 'aria-label': `${v.name} — workspace` });
    const hint = h('p', { class: 'mv-empty' }, 'Right-click to add an object — then drag it into place.');
    const addBtn = h('button', { type: 'button', class: 'mv-ctl', title: 'Add an object', 'aria-label': 'Add an object', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 15));
    const lockBtn = h('button', { type: 'button', class: 'mv-ctl', 'aria-pressed': String(locked) });
    const extra = io?.controls?.() || [];
    const ctls = h('div', { class: 'mv-ctls' }, addBtn, lockBtn, ...extra);
    field.append(hint, ctls);
    root2.append(field);

    function paintLock() {
      field.classList.toggle('is-locked', locked);
      lockBtn.setAttribute('aria-pressed', String(locked));
      lockBtn.title = locked ? 'Layout locked — click to unlock' : 'Lock the layout';
      lockBtn.setAttribute('aria-label', lockBtn.title);
      lockBtn.replaceChildren(icon(locked ? 'lock' : 'lockOpen', 15));
      addBtn.hidden = locked;
    }
    lockBtn.addEventListener('click', () => { locked = !locked; paintLock(); save(); toast(locked ? 'Layout locked.' : 'Layout unlocked — drag and resize to adjust.', { ms: 1600 }); });

    function addMenu(anchor) {
      const have = new Set(items.map((x) => x.kind));
      const at = anchor && 'x' in anchor && anchor.fx != null ? anchor : null;
      menu(anchor, [...(io?.menu ? [...io.menu(), '-'] : []), { header: 'Add to this view' }, ...KINDS.map((k) => ({
        label: label(k), icon: k === 'path' ? 'toPaths' : WIDGETS[k]?.icon || 'widget', disabled: have.has(k),
        onSelect: () => {
          const box = freeBox(items);
          if (at) { box.x = clamp01(snapTo(at.fx - box.w / 2), 0, 1 - box.w); box.y = clamp01(snapTo(at.fy - 0.03), 0, 1 - box.h); }
          const it = { id: uid(), kind: k, box };
          items = [...items, it];
          save(); mountItem(it); paintEmpty();
        },
      }))], { align: 'end' });
    }
    field.addEventListener('contextmenu', (e) => {
      if (e.target !== field && !e.target.classList.contains('mv-empty')) return;
      e.preventDefault();
      if (locked) { menu({ x: e.clientX, y: e.clientY }, [{ label: 'Unlock layout', icon: 'lockOpen', onSelect: () => lockBtn.click() }, ...(io?.menu?.() || [])]); return; }
      const r = field.getBoundingClientRect();
      addMenu({ x: e.clientX, y: e.clientY, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
    });
    const paintEmpty = () => { hint.hidden = !!items.length; };

    const patchItem = (id, p) => { items = items.map((x) => (x.id === id ? { ...x, ...p } : x)); save(); remount(id); };
    const removeItem = (id) => { items = items.filter((x) => x.id !== id); save(); const m = panels.get(id); m?.p.destroy(); m?.node.remove(); panels.delete(id); paintEmpty(); };
    function place(node, box) {
      Object.assign(node.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
    }
    function remount(id) {
      const m = panels.get(id);
      if (m) { m.p.destroy(); m.node.remove(); panels.delete(id); }
      const it = items.find((x) => x.id === id);
      if (it) mountItem(it);
    }
    function mountItem(it) {
      const p = objectPanel(it.kind, {
        title: it.title, hideTitle: it.hideTitle, hideHeader: it.hideHeader, zoomKey: `${io ? io.zoomPrefix : `custom:${v.id}`}:${it.id}`,
        menuItems: () => [
          { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename object', { value: it.title || label(it.kind), maxLength: 32 }); if (n != null) patchItem(it.id, { title: n.trim() || null }); } },
          { label: it.hideTitle ? 'Show title' : 'Hide title', icon: 'type', onSelect: () => patchItem(it.id, { hideTitle: !it.hideTitle }) },
          { label: it.hideHeader ? 'Show header' : 'Hide header', icon: 'rect', onSelect: () => patchItem(it.id, { hideHeader: !it.hideHeader }) },
          { label: locked ? 'Unlock position' : 'Lock position', icon: locked ? 'lockOpen' : 'lock', onSelect: () => lockBtn.click() },
          '-',
          { label: 'Remove from view', icon: 'close', danger: true, disabled: locked, onSelect: () => removeItem(it.id) },
        ],
      });
      const node = h('div', { class: 'mv-item', 'data-id': it.id }, p.el,
        h('span', { class: 'mv-move', title: 'Drag to move', 'aria-hidden': 'true' }, icon('grip', 13)),
        h('span', { class: 'mv-size', title: 'Drag to resize', 'aria-hidden': 'true' }));
      // A hidden header still needs a way back.
      if (it.hideHeader) node.append(h('button', { type: 'button', class: 'mv-float-more', 'aria-label': 'Options', onclick: (e) => menu(e.currentTarget, [{ label: 'Show header', icon: 'rect', onSelect: () => patchItem(it.id, { hideHeader: false }) }, { label: 'Remove from view', icon: 'close', danger: true, disabled: locked, onSelect: () => removeItem(it.id) }]) }, icon('more', 15)));
      place(node, it.box);
      field.append(node);
      panels.set(it.id, { p, node });
      node.addEventListener('pointerdown', (e) => {
        if (locked || e.button !== 0) return;
        const size = e.target.closest('.mv-size');
        const handle = e.target.closest('.mv-move') || (e.target.closest('.wg-head') && !e.target.closest('button, input, textarea, select, a, [contenteditable="true"], .sbz'));
        if (!size && !handle) return;
        e.preventDefault(); e.stopPropagation();
        drag(e, it.id, node, size ? 'size' : 'move');
      });
    }
    function drag(e, id, node, mode) {
      const r = field.getBoundingClientRect();
      const it0 = items.find((x) => x.id === id);
      if (!it0) return;
      const b0 = { ...it0.box };
      const sx = e.clientX, sy = e.clientY;
      let box = b0;
      node.classList.add('is-drag');
      field.append(node); // on top while it moves (and after)
      const move = (ev) => {
        const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
        box = mode === 'move'
          ? { ...b0, x: clamp01(snapTo(b0.x + dx), 0, 1 - b0.w), y: clamp01(snapTo(b0.y + dy), 0, 1 - b0.h) }
          : { ...b0, w: clamp01(snapTo(b0.w + dx), MIN_W, 1 - b0.x), h: clamp01(snapTo(b0.h + dy), MIN_H, 1 - b0.y) };
        place(node, box);
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        node.classList.remove('is-drag');
        // the last one moved sits on top next time too
        items = [...items.filter((x) => x.id !== id), { ...it0, box }];
        save();
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    }

    paintLock();
    items.forEach(mountItem);
    paintEmpty();
    if ((v.items || []).some((it) => !it.box)) save(); // legacy layout converted once
    return { destroy() { panels.forEach(({ p }) => p.destroy()); panels.clear(); } };
  }

  /* ---------------- life ---------------- */
  offs.push(startVarShare());
  offs.push(() => window.removeEventListener('architect:sidebar-look', onLook));
  setSharedSpace(ctx.sharedSpaceId?.() || null);
  paintRail();
  applyLook();
  requestAnimationFrame(() => show(cur || 'space'));

  return {
    root,
    current: () => cur,
    show,
    // The Space switched (Tab) or reloaded its canvas: borrowed objects must come from the new board.
    rebind(next) {
      ed = next;
      paintRail();
      const id = cur;
      if (id && id !== 'space') { active?.destroy(); active = null; cur = ''; show(id); }
    },
    destroy() {
      active?.destroy(); active = null;
      offs.forEach((f) => { try { f(); } catch {} });
      setSurface(null);
      page.classList.remove('has-sb', 'sb-open');
      root.remove();
    },
  };
}
