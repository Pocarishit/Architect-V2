// ARCHITECT — Nov 27 ("Architect SYSTEM Updates").
// Small shared pieces: configurable app shortcuts (Switch to Personal Space, Toggle Sidebar), the Blueprint
// view (an opaque, library-style dot-grid canvas of preview cards), and a "type the name to confirm" dialog.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { dialog, toast } from '../core/ui.js';
import { api, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';
import { previewSvg } from '../board/preview.js';
import { uid } from '../core/util.js';

/* ---------------- app shortcuts (Settings → Shortcuts) ---------------- */
// Each action has one key (or none). Tab used to be hardwired to Personal Space; now it's only the default,
// so it can be given to Toggle Sidebar instead.
export const APP_ACTIONS = [
  { id: 'personal', label: 'Switch to Personal Space', hint: 'Flip between your personal space and the shared one', def: 'Tab' },
  { id: 'sidebar', label: 'Toggle Sidebar', hint: 'Pin the sidebar open, or let it hide until you point at the left edge', def: null },
];
export function appKeys() {
  const saved = getPref('appKeys', null) || {};
  const out = {};
  for (const a of APP_ACTIONS) out[a.id] = a.id in saved ? saved[a.id] : a.def;
  return out;
}
export const appKey = (id) => appKeys()[id] || null;
export function setAppKey(id, key) {
  const next = { ...appKeys(), [id]: key || null };
  return setPref('appKeys', next);
}
/** The action bound to this key combo, if any. */
export function actionFor(combo) {
  const k = appKeys();
  return Object.keys(k).find((id) => k[id] && k[id] === combo) || null;
}
export function comboOf(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}
const MOD_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** Settings → Shortcuts. Click a key box, press the new key. A key that's already taken is flagged; you
 *  choose to move it here (the other action loses it) or keep looking. */
export function shortcutsPane({ extra = null } = {}) {
  const rows = h('div', { class: 'ak-rows' });
  const paint = () => {
    const keys = appKeys();
    rows.replaceChildren(...APP_ACTIONS.map((a) => {
      const btn = h('button', { type: 'button', class: ['ak-key', !keys[a.id] && 'is-empty'], 'aria-label': `${a.label}: ${keys[a.id] || 'no key'}. Click, then press a key.` }, keys[a.id] || 'None');
      const note = h('small', { class: 'ak-note', 'aria-live': 'polite' });
      btn.addEventListener('click', () => listen(a, btn, note));
      const clear = keys[a.id] ? h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': `Remove the key for ${a.label}`, title: 'Remove key', onclick: async () => { await setAppKey(a.id, null).catch(() => {}); paint(); } }, icon('close', 13)) : null;
      return h('div', { class: 'ak-row' }, h('span', { class: 'ak-text' }, h('b', {}, a.label), h('small', {}, a.hint)), h('span', { class: 'ak-ctl' }, btn, clear), note);
    }));
  };
  function listen(a, btn, note) {
    btn.classList.add('is-listening'); btn.textContent = 'Press a key…';
    note.textContent = 'Esc cancels.';
    const onKey = async (e) => {
      if (MOD_ONLY.has(e.key)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      window.removeEventListener('keydown', onKey, true);
      btn.classList.remove('is-listening');
      if (e.key === 'Escape') { paint(); return; }
      const combo = comboOf(e);
      const owner = actionFor(combo);
      if (owner && owner !== a.id) {
        const other = APP_ACTIONS.find((x) => x.id === owner);
        btn.textContent = combo;
        note.replaceChildren(
          h('span', { class: 'ak-clash' }, `${combo} is already used by ${other.label}.`), ' ',
          h('button', { type: 'button', class: 'btn sm', onclick: async () => { await setAppKey(owner, null).catch(() => {}); await setAppKey(a.id, combo).catch(() => {}); toast(`${combo} now ${a.label.toLowerCase()}. ${other.label} has no key.`, { ms: 2600 }); paint(); } }, `Use it here`), ' ',
          h('button', { type: 'button', class: 'btn sm', onclick: () => paint() }, 'Choose another'));
        return;
      }
      try { await setAppKey(a.id, combo); } catch (err) { toast(friendlyError(err), { tone: 'error' }); }
      paint();
    };
    window.addEventListener('keydown', onKey, true);
  }
  paint();
  return h('div', { class: 'stack ak' },
    h('section', { class: 'set-section' }, h('h3', {}, 'Shortcuts'),
      h('p', { class: 'dlg-text' }, 'One key per action. If a key is already taken, you choose which action keeps it.'),
      rows),
    extra);
}

/* ---------------- type-the-name confirmation ---------------- */
/** Resolves true only after the exact name is typed and the button pressed. */
export async function confirmByName({ title, name, message, ok = 'Delete' }) {
  const input = h('input', { class: 'input', autofocus: true, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${name} to confirm` });
  const body = h('div', { class: 'stack' },
    message ? h('p', { class: 'dlg-text' }, message) : null,
    h('p', { class: 'dlg-text' }, 'Type ', h('b', { class: 'cbn-name' }, name), ' to confirm.'),
    input);
  const p = dialog({ title, body, actions: [{ label: 'Cancel', value: false }, { label: ok, primary: true, danger: true, value: () => (input.value === name ? true : undefined) }] });
  requestAnimationFrame(() => {
    const btn = body.closest('.dlg')?.querySelector('.btn-primary');
    const sync = () => { if (btn) btn.disabled = input.value !== name; };
    input.addEventListener('input', sync);
    sync();
  });
  return !!(await p);
}

/* ---------------- the Blueprint view ---------------- */
// An opaque dot-grid canvas (the board behind never shows through) with every saved Blueprint as a preview
// card. No header bar: the canvas reaches the top edge; only Fit and Close sit in the top-right corner.
// Drag the canvas to pan, Ctrl/⌘ + wheel to zoom, drag a card to arrange it (saved on your account),
// click a card to open it.
export function openBlueprintsCanvas({ openBoard, host = null }) {
  document.querySelector('.bpc-layer')?.remove();
  // Nov 28: inside the Architect workspace (the sidebar still slides in over it), not a separate full screen.
  const layer = h('div', { class: ['bpc-layer', host && 'is-inline'], role: 'dialog', 'aria-label': 'Blueprints' });
  const world = h('div', { class: 'bpc-world' });
  const vp = h('div', { class: 'bpc-vp' }, world);
  const corner = h('div', { class: 'bpc-corner' },
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Fit', title: 'Fit', onclick: () => fit() }, icon('fit', 16)),
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => close() }, icon('close', 16)));
  layer.append(vp, corner);
  (host || document.body).append(layer);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.menu, .dlg, .pop')) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  layer.addEventListener('bpc-close', () => close());
  function close() { window.removeEventListener('keydown', onKey, true); window.removeEventListener('architect:blueprints-changed', load); layer.remove(); }

  const CW = 240, CH = 190, GAP = 28;
  let boards = [];
  let pos = { ...(getPref('bpCanvas', null)?.pos || {}) };
  let cam = getPref('bpCanvas', null)?.cam || null;
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => setPref('bpCanvas', { pos, cam }).catch(() => {}), 600); };
  const apply = () => {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    vp.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    vp.style.backgroundSize = `${22 * cam.z}px ${22 * cam.z}px`;
  };
  const placeOf = (b, i) => pos[b.id] || { x: (i % 5) * (CW + GAP), y: Math.floor(i / 5) * (CH + GAP) };
  function fit() {
    const ps = [{ x: -CW - GAP, y: 0 }, ...boards.map(placeOf)]; // the New card is always in view
    const x0 = Math.min(...ps.map((p) => p.x)), y0 = Math.min(...ps.map((p) => p.y));
    const x1 = Math.max(...ps.map((p) => p.x + CW)), y1 = Math.max(...ps.map((p) => p.y + CH));
    const z = Math.max(0.2, Math.min(1.4, (vp.clientWidth - 120) / (x1 - x0), (vp.clientHeight - 120) / (y1 - y0)));
    cam = { z, x: vp.clientWidth / 2 - ((x0 + x1) / 2) * z, y: vp.clientHeight / 2 - ((y0 + y1) / 2) * z };
    apply(); save();
  }
  function zoomBy(k, cx, cy) {
    const z1 = Math.min(3, Math.max(0.2, cam.z * k));
    cam = { z: z1, x: cx - (cx - cam.x) * (z1 / cam.z), y: cy - (cy - cam.y) * (z1 / cam.z) };
    apply(); save();
  }
  function card(b, i) {
    const p = placeOf(b, i);
    const n = h('div', { class: 'bpc-card', tabindex: 0, role: 'button', 'aria-label': `Open ${b.name || 'Untitled'}`, style: { left: `${p.x}px`, top: `${p.y}px`, width: `${CW}px`, height: `${CH}px` } },
      h('div', { class: 'bpc-pv' }, previewSvg(b.preview) || icon('frame', 28)),
      h('div', { class: 'bpc-name' }, b.name || 'Untitled'));
    const open = () => { close(); openBoard(b.id); };
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
    n.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, x0 = p.x, y0 = p.y;
      let moved = false;
      n.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        moved = true; n.classList.add('is-held');
        n.style.left = `${x0 + (ev.clientX - sx) / cam.z}px`; n.style.top = `${y0 + (ev.clientY - sy) / cam.z}px`;
      };
      const up = (ev) => {
        n.removeEventListener('pointermove', mv); n.removeEventListener('pointerup', up); n.classList.remove('is-held');
        if (!moved) { open(); return; }
        pos[b.id] = { x: Math.round(x0 + (ev.clientX - sx) / cam.z), y: Math.round(y0 + (ev.clientY - sy) / cam.z) };
        p.x = pos[b.id].x; p.y = pos[b.id].y;
        save();
      };
      n.addEventListener('pointermove', mv); n.addEventListener('pointerup', up);
    });
    return n;
  }
  const newCard = () => h('button', { type: 'button', class: 'bpc-new', style: { left: `${-CW - GAP}px`, top: '0px', width: `${CW}px`, height: `${CH}px` }, onclick: create, 'aria-label': 'New blueprint' }, icon('plus', 22), h('span', {}, 'New blueprint'));
  function paint() { world.replaceChildren(newCard(), ...boards.map(card)); }
  async function create() {
    try {
      const row = { id: uid(), name: 'Untitled blueprint', kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: [] }, preview: [] };
      await api.db.insert('blueprints', row).catch(async (e) => { if (/kind/.test(String(e?.message))) { delete row.kind; return api.db.insert('blueprints', row); } throw e; });
      window.dispatchEvent(new CustomEvent('architect:blueprints-changed'));
      close(); openBoard(row.id);
    } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }
  async function load() {
    try {
      const rows = await api.db.select('blueprints', { columns: 'id,name,kind,preview,updated_at', order: 'updated_at.desc' })
        .catch(() => api.db.select('blueprints', { columns: 'id,name,preview,updated_at', order: 'updated_at.desc' }));
      boards = rows.filter((b) => !['space', 'personal', 'er', 'er-chat'].includes(b.kind));
    } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    paint();
    if (!cam) requestAnimationFrame(fit); else apply();
  }
  window.addEventListener('architect:blueprints-changed', load);
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.bpc-card, .bpc-new')) return;
    if (!cam) return;
    const sx = e.clientX, sy = e.clientY, c0 = { ...cam };
    vp.setPointerCapture(e.pointerId); vp.classList.add('is-panning');
    const mv = (ev) => { cam = { ...c0, x: c0.x + ev.clientX - sx, y: c0.y + ev.clientY - sy }; apply(); };
    const up = () => { vp.removeEventListener('pointermove', mv); vp.removeEventListener('pointerup', up); vp.classList.remove('is-panning'); save(); };
    vp.addEventListener('pointermove', mv); vp.addEventListener('pointerup', up);
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!cam) return;
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY }; apply(); save(); }
  }, { passive: false });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  if (cam) apply();
  load();
  return { close };
}

/* ---------------- snapped objects: no gaps at the corners ---------------- */
// When objects sit against each other, their rounded corners leave little wedges where the board shows
// through. A corner is squared off when it lands on another object (shared edges, and junctions where three
// or four meet, even if the edges don't line up end to end). Exposed outer corners stay round, and moving an
// object away gives it its normal corners back. Only the corners change: each object keeps its own border, so
// a thin line still separates them.
const JOIN_TYPES = new Set(['widget', 'sticky']);
export function watchJoins(ed) {
  let raf = 0;
  const TOL = 3;
  const run = () => {
    raf = 0;
    const items = ed.els.filter((e) => JOIN_TYPES.has(e.type) && !(ed.isHidden?.(e)) && !e.rot);
    const inside = (p, r) => p.x >= r.x - TOL && p.x <= r.x + r.w + TOL && p.y >= r.y - TOL && p.y <= r.y + r.h + TOL;
    for (const el of items) {
      const node = ed.nodes?.get(el.id);
      if (!node) continue;
      const corners = { tl: { x: el.x, y: el.y }, tr: { x: el.x + el.w, y: el.y }, br: { x: el.x + el.w, y: el.y + el.h }, bl: { x: el.x, y: el.y + el.h } };
      const joined = [];
      for (const [k, p] of Object.entries(corners)) {
        if (items.some((o) => o.id !== el.id && inside(p, o))) joined.push(k);
      }
      const v = joined.join(' ');
      if ((node.dataset.join || '') !== v) { if (v) node.dataset.join = v; else delete node.dataset.join; }
    }
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(run); };
  const off1 = ed.on('change', kick);
  const off2 = ed.on('gesture', (on) => { if (!on) kick(); });
  kick();
  return () => { cancelAnimationFrame(raf); off1?.(); off2?.(); };
}
