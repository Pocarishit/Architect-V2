// Variables — your map of everything outside you that shapes your life.
// Sections (School, Family, Business, Friends… all renamable) hold entries: a person, a group,
// a commitment. Each entry opens into its own running chat of notes, so you can reflect and
// track how it changes over time. Lives on the widget object, synced like the rest of the Space.
// Nov 18: subsections nest to any depth (a subsection can hold its own subsections) and each can carry
// an image. Free View works at the object level too: tiles and variables loosen from the grid onto a
// canvas with links, boxes, circles and notes — a layer per subsection (section.free), on top of the same
// data. Toggle it off and the standard grid is back.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, dialog, confirmDialog, promptDialog, popover, closeFloating } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia } from './media.js';
import { bubbleRow, dayRow, chatDayLabel, CHAT_GROUP_MS } from './sidechat.js';
import { myVarsSource, myVarsStatus } from '../data/myvars.js';
import { registerVarChat } from './saycomposer.js';
import { mountFreeView } from './freeview.js';
import { shareCategory, unshareCategory } from '../data/varshare.js';

export const DEFAULT_SECTIONS = ['School', 'Family', 'Business', 'Friends'];
export const defaultVariables = () => ({ sections: DEFAULT_SECTIONS.map((name) => ({ id: uid(), name })), entries: [] });
const MAX_NOTES = 600;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLabel = (ts) => {
  const d = new Date(ts), t = new Date();
  const k = (x) => x.toDateString();
  if (k(d) === k(t)) return 'Today';
  if (k(d) === k(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
};

/* ---------------- importing the custom-widget Variables (v59) ---------------- */
// Its HTML: <main> › <details> sections (nested <details> = sub-sections) › <button data-target> people.
export function readVariablesHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const mainEl = doc.querySelector('main');
  if (!mainEl) return null;
  const label = (d) => { const sm = d.querySelector(':scope > summary'); const t = sm && [...sm.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); return (t?.textContent || sm?.textContent || '').trim(); };
  const people = (d) => [...d.querySelectorAll(':scope > button[data-target]')].map((b) => ({ name: (b.querySelector('span')?.textContent || '').trim(), img: b.querySelector('i img')?.getAttribute('src') || null, target: b.dataset.target })).filter((p) => p.name);
  return [...mainEl.querySelectorAll(':scope > details')].map((top) => ({ name: label(top), people: people(top), subs: [...top.querySelectorAll(':scope > details')].map((x) => ({ name: label(x), people: people(x) })) }));
}
export const countPeople = (plan) => plan.reduce((n, t) => n + t.people.length + t.subs.reduce((m, x) => m + x.people.length, 0), 0);

// A board-chat message → a Variables note.
const toNote = (m) => ({
  id: m.id || uid(), by: m.by || null, name: m.name || '', ts: Number(m.ts) || Date.parse(m.at || m.created_at) || Date.now(),
  text: String(m.text || '').slice(0, 4000), files: Array.isArray(m.files) ? m.files.filter((f) => f?.path).map((f) => ({ kind: f.kind || 'photo', path: f.path, name: f.name || '' })) : [],
  ...(m.edited ? { edited: true } : {}),
});

/** Merge a parsed v59 plan into { sections, entries }. chats: data-target → chat element (its messages become notes). */
export async function mergeVariables(base, plan, { chats = {}, onStep } = {}) {
  let secs = [...(base.sections || [])];
  let list = [...(base.entries || [])];
  const find = (name, parent) => secs.find((x) => (x.parent || null) === (parent || null) && x.name.toLowerCase() === name.toLowerCase());
  const ensure = (name, parent) => { let x = find(name, parent); if (!x) { x = parent ? { id: uid(), name, parent } : { id: uid(), name }; secs.push(x); } return x; };
  let done = 0, added = 0, notes = 0;
  const take = async (secId, p) => {
    onStep?.(++done);
    let x = list.find((y) => y.section === secId && y.name.toLowerCase() === p.name.toLowerCase());
    if (!x) { x = { id: uid(), section: secId, name: p.name.slice(0, 48), photo: null, notes: [], at: Date.now() }; list.push(x); added++; }
    const patch = {};
    if (!x.photo && p.img?.startsWith('data:image')) {
      try {
        const blob = await (await fetch(p.img)).blob();
        patch.photo = (await uploadMedia(new File([blob], `${p.name}.jpg`, { type: blob.type || 'image/jpeg' }))).path;
      } catch {}
    }
    const msgs = chats[p.target]?.messages;
    if (Array.isArray(msgs) && msgs.length) {
      const have = new Set((x.notes || []).map((n) => n.id));
      const fresh = msgs.filter((m) => m && (m.text || m.files?.length) && !have.has(m.id)).map(toNote);
      if (fresh.length) { notes += fresh.length; patch.notes = [...(x.notes || []), ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_NOTES); }
    }
    if (Object.keys(patch).length) { const id = x.id; list = list.map((y) => (y.id === id ? { ...y, ...patch } : y)); }
  };
  for (const t of plan) {
    const top = ensure(t.name || 'Imported', null);
    for (const p of t.people) await take(top.id, p);
    for (const sub of t.subs) { const child = ensure(sub.name || 'Imported', top.id); for (const p of sub.people) await take(child.id, p); }
  }
  return { sections: secs, entries: list, added, notes };
}

const hue = (t) => { let x = 0; for (const c of String(t).trim()) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const initials = (n) => String(n).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

/* ---------------- colors (Nov 24) ---------------- */
// A variable or subsection can carry a color: its tile, card and sidebar row pick it up.
export const VAR_COLORS = ['#f4f4f4', '#9b9b9b', '#e5484d', '#f2994a', '#f2c94c', '#3fae6a', '#2fb5a8', '#4c8df6', '#8b5cf6', '#e45fa8'];
/** Resolves to a color, null (back to default) or undefined (closed). */
export function pickColor(anchor, current = null) {
  return new Promise((resolve) => {
    let done = false;
    const pick = (c) => { if (done) return; done = true; closeFloating(); resolve(c); };
    const box = h('div', { class: 'vr-colors', role: 'listbox', 'aria-label': 'Color' },
      ...VAR_COLORS.map((c) => h('button', { type: 'button', class: ['vr-swatch', current === c && 'is-on'], style: { background: c }, 'aria-label': c, role: 'option', 'aria-selected': String(current === c), onclick: () => pick(c) })),
      h('button', { type: 'button', class: ['vr-swatch is-none', !current && 'is-on'], 'aria-label': 'Default', title: 'Default', onclick: () => pick(null) }));
    const p = popover(anchor && anchor.nodeType ? anchor : { x: anchor?.x ?? innerWidth / 2, y: anchor?.y ?? innerHeight / 2 }, box, { onClose: () => { if (!done) { done = true; resolve(undefined); } } });
    if (!p) resolve(undefined);
  });
}

/* ---------------- undo inside Variables (Nov 24) ----------------
   Ctrl/⌘+Z (and ⇧ / Ctrl+Y to redo) step back changes in whichever Variables you were last working in —
   the board's own undo never sees them, and nothing on the Blueprint is undone. */
const undoRoots = new Map(); // root element → source
let lastRoot = null;
let undoKeys = false;
export function trackUndo(root, src) {
  undoRoots.set(root, src);
  const touch = () => { lastRoot = root; };
  root.addEventListener('pointerdown', touch, true);
  root.addEventListener('focusin', touch);
  if (!undoKeys) {
    undoKeys = true;
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (!mod || e.altKey || !(k === 'z' || k === 'y')) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      const r = lastRoot;
      const s2 = r && r.isConnected && r.getClientRects().length ? undoRoots.get(r) : null;
      if (!s2) return;
      if (document.activeElement && document.activeElement !== document.body && !r.contains(document.activeElement) && !document.activeElement.closest?.('.sb-stage, .vr')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const redo = k === 'y' || e.shiftKey;
      if (!(redo ? s2.redo() : s2.undo())) toast(redo ? 'Nothing to redo in Variables.' : 'Nothing to undo in Variables.', { ms: 1200 });
    }, true);
  }
  return () => { undoRoots.delete(root); if (lastRoot === root) lastRoot = null; root.removeEventListener('pointerdown', touch, true); root.removeEventListener('focusin', touch); };
}

/* Nov 26 — on the board, a drag that starts inside a Variables object:
   · right button → pans the Variables canvas itself (any direction), never the Architect workspace around it;
   · middle button → pans the workspace (the board's own middle-drag; Free View no longer takes it here).
   A right-click that doesn't move still opens the menu of what's under it. */
function scrollableIn(t, root) {
  for (let n = t; n && n !== root.parentNode; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    const cs = getComputedStyle(n);
    const ox = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    const oy = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    if (ox || oy) return n;
    if (n === root) break;
  }
  return root.querySelector('.vr-fv') || null;
}
function innerRightPan(root) {
  let g = null;
  const onDown = (e) => {
    if (e.button !== 2 || e.pointerType !== 'mouse' || e.target.closest('[contenteditable="true"], input, textarea')) return;
    const sc = scrollableIn(e.target, root);
    e.stopPropagation(); // the board doesn't see it: the workspace stays where it is
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, sc, l: sc?.scrollLeft || 0, t: sc?.scrollTop || 0, moved: false, menu: null,
      k: sc ? (sc.getBoundingClientRect().width / (sc.offsetWidth || 1)) || 1 : 1 };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };
  const onMove = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved) { if (Math.hypot(dx, dy) < 5) return; g.moved = true; root.classList.add('is-rpanning'); }
    e.preventDefault(); e.stopPropagation();
    if (g.sc) { g.sc.scrollLeft = g.l - dx / g.k; g.sc.scrollTop = g.t - dy / g.k; }
  };
  const onUp = (e) => {
    if (!g || e.pointerId !== g.id) return;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    root.classList.remove('is-rpanning');
    const done = g; g = null;
    if (done.moved) { eatUntil = performance.now() + 450; return; }
    // A still right-click whose menu came on press (macOS / Linux): deliver it now.
    if (done.menu && done.menu.target.isConnected) {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: done.menu.x, clientY: done.menu.y, button: 2 });
      ev.__replay = true; ev.__inner = true;
      done.menu.target.dispatchEvent(ev);
    }
  };
  let eatUntil = 0;
  const onMenu = (e) => {
    if (e.__inner) return;
    if (performance.now() < eatUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (g) { e.preventDefault(); e.stopPropagation(); if (!g.moved) g.menu = { target: e.target, x: e.clientX, y: e.clientY }; }
  };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('contextmenu', onMenu, true);
  return () => { root.removeEventListener('pointerdown', onDown); root.removeEventListener('contextmenu', onMenu, true); };
}

export function mountVariables(root, el0, w) {
  let el = el0;
  const me = api.auth.current()?.user;
  const memKey = `architect.var.${el.id}`;
  const mem = store.get(memKey, {});
  let section = mem.section || null; // top-level tab
  let sub = mem.sub || null;         // open sub-section (e.g. School › Student), or null
  let open = mem.open || null;       // entry id whose chat is open
  let busy = false;
  let pending = false;
  let draft = '';
  let sending = false;
  let dragging = false;
  let free = null; // Free View of the open chat, when it's on
  let gfree = null; // Free View of the grid (object level), when it's on
  const freeBusy = () => !!free?.busy() || !!gfree?.busy();
  let finding = false, query = '', hit = 0; // the open chat's search bar
  let editing = null; // { entry, id, keep } — a note being edited in the composer, Side Chat style
  const remember = () => store.set(memKey, { section, sub, open });

  const box = h('div', { class: 'vr' });
  root.append(box);

  // Your Variables live on your account (data/myvars.js), not on this object: the same in both Spaces,
  // and in the shared Space everyone sees only their own. What's still saved on the object from before
  // is "legacy" — offered once, never shown as yours until you bring it in.
  let ready = false;
  // Nov 24: a Variables object runs on a data source — your own Variables (default), or a category someone
  // shared with you (data/varshare.js → sharedSource), with the same editing, menus and Free View.
  const src = w?.source || myVarsSource;
  const foreign = !!src.foreign;
  const setMyVars = (p) => src.set(p);
  const undoItem = () => ({ label: 'Undo', icon: 'undo', kbd: '⌘Z', disabled: !src.canUndo?.(), onSelect: () => src.undo() });
  const acct = () => src.get() || { sections: null, entries: [] };
  let defaults = null;
  const sections = () => acct().sections || (defaults ||= defaultVariables().sections);
  const tops = () => sections().filter((s) => !s.parent && !s.organs); // the Organs space lives in the sidebar only
  const kids = (id) => sections().filter((s) => s.parent === id);
  const secById = (id) => sections().find((s) => s.id === id);
  const entries = () => acct().entries || [];
  const inSec = (id) => entries().filter((x) => x.section === id);
  const countIn = (id, seen = new Set()) => { if (seen.has(id)) return 0; seen.add(id); return inSec(id).length + kids(id).reduce((n, k) => n + countIn(k.id, seen), 0); };
  // Root → this section (guarded against a broken parent loop).
  const chainOf = (id) => { const out = []; let s = secById(id); const seen = new Set(); while (s && !seen.has(s.id)) { seen.add(s.id); out.unshift(s); s = s.parent && secById(s.parent); } return out; };
  const topOf = (id) => chainOf(id)[0]?.id || null;
  const pathOf = (id) => chainOf(id).map((x) => x.name).join(' › ');
  const descOf = (id) => { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const x of sections()) if (x.parent && out.has(x.parent) && !out.has(x.id)) { out.add(x.id); grew = true; } } return out; };
  const goTo = (id) => { const t = topOf(id); if (!t) return; section = t; sub = id === t ? null : id; remember(); };
  const freeOn = () => !!acct().vfree;
  const save = (p) => setMyVars({ sections: sections(), entries: entries(), ...p });
  const legacyNew = () => {
    const have = new Set(entries().map((x) => x.id));
    return (el.entries || []).filter((x) => !have.has(x.id));
  };
  function bringIn() {
    const secIds = new Set(sections().map((x) => x.id));
    const add = (el.sections || []).filter((x) => !secIds.has(x.id));
    const n = legacyNew().length;
    save({ sections: [...sections(), ...add], entries: [...entries(), ...legacyNew()] });
    store.set(`${memKey}.legacy`, 'done');
    toast(`Brought in ${n} variable${n === 1 ? '' : 's'}.`, { ms: 2200 });
  }
  const setEntries = (list) => save({ entries: list });
  const patchEntry = (id, fn) => setEntries(entries().map((x) => (x.id === id ? { ...x, ...fn(x) } : x)));
  const here = () => sub || section;

  function render() {
    if (!ready) { box.replaceChildren(h('p', { class: 'vr-hint' }, 'Loading your variables…')); return; }
    // Nov 27: a load or sync problem is never shown as an empty account (no default tabs, no Add-only view).
    if (!foreign && !acct().sections && !acct().entries.length && myVarsStatus() !== 'ok' && myVarsStatus() !== 'local') {
      box.replaceChildren(h('p', { class: 'vr-hint' }, myVarsStatus() === 'error' ? 'Your Variables couldn’t be reached yet — retrying…' : 'Loading your variables…'));
      return;
    }
    if (dragging || freeBusy()) { pending = true; return; }
    if (busy) {
      // Typing a note: refresh the messages in place, keep the composer (and your cursor) alone.
      const x = open && entries().find((e) => e.id === open);
      const list = box.querySelector('.vr-msgs');
      if (x && free && x.free?.on) { free.update(x); markFind(false); return; }
      if (x && list && !x.free?.on) {
        const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.replaceChildren(...orderRows(x));
        if (atEnd && !query) list.scrollTop = list.scrollHeight;
        markFind(false);
      } else pending = true;
      return;
    }
    pending = false;
    const t = tops();
    if (!t.some((s) => s.id === section)) section = t[0]?.id || null;
    if (sub && (sub === section || topOf(sub) !== section)) sub = null;
    const entry = open && entries().find((x) => x.id === open);
    if (open && !entry) open = null;
    const keep = box.querySelector('.vr-grid')?.scrollTop;
    free?.destroy(); free = null;
    gfree?.destroy(); gfree = null;
    if (!entry && w?.chatTools) w.chatTools.replaceChildren();
    box.replaceChildren(entry ? chat(entry) : grid(t));
    if (keep && !entry) box.querySelector('.vr-grid').scrollTop = keep;
    if (entry && !free && !query) requestAnimationFrame(() => { const l = box.querySelector('.vr-msgs'); if (l) l.scrollTop = l.scrollHeight; });
    if (entry) requestAnimationFrame(() => markFind(false));
  }

  /* ---------------- search the open chat ---------------- */
  // Matching notes light up, the rest dim; Enter / the arrows step through them, oldest to newest.
  function findIds() {
    const x = open && entries().find((e) => e.id === open);
    const q = query.trim().toLowerCase();
    if (!x || !q) return [];
    return (x.notes || []).filter((m) => `${m.text || ''} ${(m.files || []).map((f) => f.name || '').join(' ')}`.toLowerCase().includes(q)).map((m) => m.id);
  }
  function markFind(jump) {
    const list = box.querySelector('.vr-msgs');
    const count = box.querySelector('.vr-find-n');
    if (!list) return;
    const ids = findIds();
    const on = finding && !!query.trim();
    list.classList.toggle('is-finding', on);
    const rows = new Map([...list.querySelectorAll('.sc-msg[data-id]')].map((r) => [r.dataset.id, r]));
    for (const r of rows.values()) { r.classList.remove('is-hit', 'is-cur'); }
    if (!on) { if (count) count.textContent = ''; return; }
    for (const id of ids) rows.get(id)?.classList.add('is-hit');
    if (count) count.textContent = ids.length ? `${Math.min(hit, ids.length - 1) + 1}/${ids.length}` : '0';
    if (!ids.length) return;
    hit = Math.max(0, Math.min(hit, ids.length - 1));
    const cur = rows.get(ids[hit]);
    if (!cur) return;
    cur.classList.add('is-cur');
    if (!jump) return;
    // Scroll inside the chat only (the canvas around it may be zoomed).
    const lr = list.getBoundingClientRect(), rr = cur.getBoundingClientRect();
    const k = lr.width / (list.offsetWidth || 1) || 1;
    list.scrollTop += (rr.top - lr.top) / k - list.clientHeight / 2 + rr.height / k / 2;
    list.scrollLeft += Math.max(0, (rr.right - lr.right) / k + 24) - Math.max(0, (lr.left - rr.left) / k + 24);
  }
  function stepFind(d) {
    const n = findIds().length;
    if (!n) return;
    hit = (hit + d + n) % n;
    markFind(true);
  }
  function findBar() {
    const inp = h('input', {
      class: 'vr-find-input', type: 'search', placeholder: 'Search this chat', value: query, spellcheck: false, 'aria-label': 'Search this chat',
      oninput: (e) => { query = e.target.value; const n = findIds().length; hit = Math.max(0, n - 1); markFind(true); }, // start from the newest match
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? 1 : -1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
      },
      onfocus: () => { busy = true; },
      onblur: () => { busy = false; if (pending) setTimeout(render, 0); },
    });
    const bar = h('div', { class: 'vr-find', role: 'search' },
      icon('search', 14),
      inp,
      h('span', { class: 'vr-find-n', 'aria-live': 'polite' }),
      h('button', { class: 'vr-find-btn', type: 'button', 'aria-label': 'Older match', title: 'Older match (Enter)', onclick: () => stepFind(-1) }, icon('chevronUp', 14)),
      h('button', { class: 'vr-find-btn', type: 'button', 'aria-label': 'Newer match', title: 'Newer match (Shift+Enter)', onclick: () => stepFind(1) }, icon('chevronDown', 14)),
      h('button', { class: 'vr-find-btn', type: 'button', 'aria-label': 'Close search', title: 'Close (Esc)', onclick: () => closeFind() }, icon('close', 14)));
    requestAnimationFrame(() => { if (finding && !query) inp.focus(); });
    return bar;
  }
  function openFind() {
    if (finding) { box.querySelector('.vr-find-input')?.focus(); return; }
    finding = true; query = ''; hit = 0; render();
  }
  function closeFind() { finding = false; query = ''; hit = 0; busy = false; render(); }

  /* ---------------- sections + grid ---------------- */
  // A section's face: its image as a thumbnail, when it has one.
  function secImg(sec, cls) {
    if (!sec?.img) return null;
    const url = urlOf(sec.img, render);
    return h('span', { class: cls, 'aria-hidden': 'true' }, url ? h('img', { src: url, alt: '', draggable: false }) : null);
  }

  function grid(t) {
    // Nov 27: up to five text-only tabs (no cover thumbnails — the covers stay saved), in their order. More
    // than five: a ⌄ after the fifth opens the rest as a text list; picking one opens it without reshuffling
    // the first five, and while it's open the ⌄ is highlighted and the list marks it.
    const MAXT = 5;
    const pickSec = (s) => { section = s.id; sub = null; if (w?.slot) open = null; remember(); render(); };
    const tabBtn = (s) => h('button', {
      type: 'button', role: 'tab', class: ['vr-tab is-text', s.id === section && 'is-on', s.share?.item && 'is-shared'], 'aria-selected': String(s.id === section), 'data-sec': s.id,
      onclick: () => pickSec(s),
      ondblclick: () => renameSection(s),
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, s); },
    }, s.name.toUpperCase());
    const head5 = t.slice(0, MAXT);
    // Whatever isn't shown as a tab (past the fifth, or squeezed out by a narrow header) goes in the ⌄ list.
    const hiddenSecs = () => t.filter((s) => !tabs.querySelector(`.vr-tab[data-sec="${CSS.escape(s.id)}"]`));
    const more = h('button', {
      type: 'button', class: 'vr-tab-more', 'aria-haspopup': 'menu', 'aria-label': 'More sections', title: 'More sections',
      onclick: (e) => menu(e.currentTarget, hiddenSecs().map((s) => ({ label: s.name.toUpperCase(), checked: s.id === section, onSelect: () => pickSec(s) })), { align: 'start' }),
    }, icon('chevronDown', 14));
    const tabs = h('div', { class: 'vr-tabs', role: 'tablist' },
      head5.map(tabBtn), more,
      h('button', { type: 'button', class: 'vr-tab-add', title: 'Add', 'aria-label': 'Add a section or import', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 14)));
    const paintMore = () => {
      const hid = hiddenSecs();
      more.hidden = !hid.length;
      more.classList.toggle('is-on', hid.some((s) => s.id === section));
    };
    // Never clip tabs: while the row overflows, the last tab moves into the ⌄ list (the open one stays).
    const fitTabs = () => {
      if (!tabs.isConnected) return;
      tabs.querySelectorAll('.vr-tab.is-text').forEach((n) => n.remove());
      const add = tabs.querySelector('.vr-tab-more');
      for (const sec of head5) add.before(tabBtn(sec));
      let shown = [...tabs.querySelectorAll('.vr-tab.is-text')];
      // Room = up to the header's own buttons (the slot may otherwise just push them out of view).
      const head = tabs.closest('.wg-head');
      const slot = tabs.closest('.wg-slot');
      const over = () => {
        if (tabs.scrollWidth > tabs.clientWidth + 1) return true;
        if (!head || !slot) return false;
        const hr = head.getBoundingClientRect();
        const padR = parseFloat(getComputedStyle(head).paddingRight) || 0;
        let reserve = 0;
        for (let n = slot.nextElementSibling; n; n = n.nextElementSibling) if (!n.classList.contains('wg-space') && !n.hidden) reserve += n.getBoundingClientRect().width + 6;
        const kids = [...tabs.children].filter((n) => !n.hidden && n.getBoundingClientRect().width > 0);
        const right = Math.max(...kids.map((n) => n.getBoundingClientRect().right));
        return right > Math.min(slot.getBoundingClientRect().right, hr.right - padR - reserve) + 0.5;
      };
      more.hidden = false;
      while (over() && shown.length > 1) {
        const drop = [...shown].reverse().find((n) => n.dataset.sec !== section) || shown[shown.length - 1];
        drop.remove();
        shown = shown.filter((n) => n !== drop);
      }
      paintMore();
    };
    paintMore();
    requestAnimationFrame(fitTabs);
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!tabs.isConnected) { ro.disconnect(); return; } fitTabs(); }); requestAnimationFrame(() => tabs.isConnected && ro.observe(tabs.closest('.wg-head') || tabs.parentElement || tabs)); }

    const cur = here();
    // Nov 25: the sidebar's map always shows everything at once (never the Free View layer, which only
    // holds the items you've already pulled onto it — that's what left the map an empty dotted grid).
    // Nov 27: the sidebar's map shows the same Free View canvas as the Variables object (every node where you
    // put it, links and arrows included) and fits it to the preview by zooming — the layout isn't touched.
    const fvOn = freeOn() || (!!w?.field && !!secById(cur)?.free);
    const cats = kids(cur);
    const list = inSec(cur);

    // The bar under the tabs: where you are (School › Student › Cadets), then Free View.
    const bar = [];
    if (sub) {
      const chain = chainOf(sub).slice(1); // below the tab
      const s = secById(sub);
      const up = s?.parent || section;
      bar.push(h('button', { type: 'button', class: 'vr-crumb-back', title: `Back to ${secById(up)?.name || 'sections'}`, onclick: () => { goTo(up); render(); } }, icon('chevronLeft', 14), 'BACK'));
      chain.forEach((c, i) => {
        const last = i === chain.length - 1;
        if (i) bar.push(h('span', { class: 'vr-crumb-sep', 'aria-hidden': 'true' }, '›'));
        bar.push(h(last ? 'span' : 'button', {
          ...(last ? {} : { type: 'button', onclick: () => { goTo(c.id); render(); } }),
          class: ['vr-crumb-name', !last && 'is-link', c.color && 'has-color'], style: { '--h': hue(c.name), ...(c.color ? { '--vc': c.color } : {}) },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, c); },
          ondblclick: () => renameSection(c),
        }, secImg(c, 'vr-crumb-img'), c.name.toUpperCase()));
      });
    }
    const fvToggle = h('button', {
      type: 'button', class: ['vr-fv-toggle', fvOn && 'is-on'], 'aria-pressed': String(fvOn),
      title: fvOn ? 'Back to the grid' : 'Free view: drag tiles anywhere, link them, draw, add notes',
      onclick: () => setMyVars({ vfree: !fvOn }),
    }, h('i'), 'FREE VIEW');

    const tiles = (only) => (only || cats).map((c) => tile(c));
    const cards = (only) => (only || list).map((x) => card(x));
    const addCard = h('button', { type: 'button', class: 'vr-card vr-new', onclick: () => addEntry() }, icon('plus', 18), h('span', {}, 'Add'));
    const gridMenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: `Add variable to ${secById(cur)?.name || 'here'}`, icon: 'plus', onSelect: () => addEntry() },
        { label: `Add sub-section in ${secById(cur)?.name || 'here'}`, icon: 'folder', onSelect: () => addSection(cur) },
        { label: 'Add section', icon: 'folder', onSelect: () => addSection(null) },
        '-',
        foreign ? null : { label: 'Import from Variables file…', icon: 'upload', onSelect: importFile },
        undoItem(),
      ].filter(Boolean));
    };

    let main;
    if (fvOn) {
      // Object-level Free View: every tile and variable is an item; the grid is the "column" they leave.
      const items = () => [...kids(here()).map((k) => ({ id: k.id })), ...inSec(here()).map((x) => ({ id: x.id }))];
      gfree = mountFreeView({
        item: '.vr-it', bubble: ':scope', noun: 'tile', home: 'the grid', top: true, openRight: true, // no chat here: no wall
        className: 'vr-fv vr-fv-grid', role: 'region', stageClass: 'is-grid',
        lockRatio: true, baseW: 170, // corners keep a tile's shape; its face and name grow with it
        media: { pick: pickMedia, upload: uploadMedia, url: urlOf },
        entry: () => ({ id: `sec:${cur}`, notes: items(), free: secById(cur)?.free || {} }),
        flowRows: () => {
          const g = h('div', { class: 'vr-grid is-fv' }, ...tiles(kids(cur)), ...cards(inSec(cur)), addCard);
          g.addEventListener('contextmenu', (e) => { if (e.target === g) gridMenu(e); });
          return [g];
        },
        one: (m) => { const c = secById(m.id); if (c) return tile(c); const x = entries().find((y) => y.id === m.id); return x ? card(x) : h('div'); },
        save: (f) => save({ sections: sections().map((x) => (x.id === cur ? { ...x, free: { ...f, on: true } } : x)) }),
        idle: () => { if (pending) setTimeout(render, 0); },
      });
      gfree.scroller.addEventListener('contextmenu', (e) => { if (e.target.classList?.contains('vr-fv-board') || e.target === gfree.scroller) gridMenu(e); });
      main = gfree.el;
      if (w?.field) { const g0 = gfree; requestAnimationFrame(() => requestAnimationFrame(() => g0.fit?.())); }
    } else if (w?.field) {
      // The sidebar's map (Nov 24): each subsection opens out in place — its variables and its own
      // subsections are on the map without opening it first.
      main = h('div', { class: 'vr-grid is-groups' }, ...cards(), w?.preview ? null : addCard, ...cats.map((c) => group(c)));
      main.addEventListener('contextmenu', (e) => { if (e.target === main) gridMenu(e); });
    } else {
      main = h('div', { class: 'vr-grid' }, ...tiles(), ...cards(), addCard);
      main.addEventListener('contextmenu', (e) => { if (e.target === main) gridMenu(e); });
    }

    const old = store.get(`${memKey}.legacy`, null) ? [] : legacyNew();
    const banner = old.length ? h('div', { class: 'vr-legacy' },
      h('span', {}, `Variables are now private to each account. ${old.length} saved on this object from before ${old.length === 1 ? 'isn’t' : 'aren’t'} in yours.`),
      h('button', { type: 'button', class: 'btn btn-primary sm', onclick: bringIn }, 'Bring in'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { store.set(`${memKey}.legacy`, 'dismissed'); render(); } }, 'Not mine')) : null;
    // Title beside the tabs (Nov 19): on the Space the section tabs ride in the widget header, right after
    // VARIABLES, like Path's day tabs — the header loses a whole row.
    if (w?.slot) w.slot.replaceChildren(tabs);
    // In the sidebar's map (w.field, Nov 23b) the space is the whole field: no tabs, no other spaces.
    return h('div', { class: ['vr-home', fvOn && 'is-free', w?.field && 'is-field'] }, w?.slot || w?.field ? null : tabs, w?.field ? null : banner,
      w?.field ? null : h('div', { class: 'vr-bar' }, h('div', { class: 'vr-crumb' }, ...bar), fvToggle),
      main,
      !list.length && !cats.length && !fvOn ? h('p', { class: 'vr-hint' }, 'A teacher, a committee, your family, the office — every influence gets its own space. Right-click here to add one.') : null);
  }

  // A subsection tile: its image (if any), its name, how many variables live inside (all depths).
  function tile(c) {
    const node = h('div', {
      class: ['vr-cat vr-it', c.img && 'has-img', c.color && 'has-color'], role: 'button', tabindex: 0, 'data-sec': c.id, 'data-id': c.id, style: { '--h': hue(c.name), ...(c.color ? { '--vc': c.color } : {}) },
      'aria-label': `Open ${c.name}`,
      onclick: (e) => { if (e.target.closest('.vr-fv-h')) return; goTo(c.id); render(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); goTo(c.id); render(); } if (e.key === 'F2') renameSection(c); },
      ondblclick: (e) => { e.preventDefault(); renameSection(c); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, c); },
    }, secImg(c, 'vr-cat-img'), h('span', { class: 'vr-cat-name' }, c.name.toUpperCase())); // the picture and the name — no counters
    return node;
  }

  // A subsection opened out on the map: its name (Doto), its variables, its own subsections as tiles.
  function group(c, depth = 0, seen = new Set()) {
    // Nested subsections open out too (Nov 25): nothing on the map waits for a click to appear.
    seen.add(c.id);
    const inner = [...inSec(c.id).map((x) => card(x)), ...kids(c.id).filter((k) => !seen.has(k.id)).map((k) => (depth < 6 ? group(k, depth + 1, seen) : tile(k)))];
    const node = h('section', {
      class: ['vr-group', depth && 'is-nested', c.color && 'has-color'], 'data-sec': c.id, style: c.color ? { '--vc': c.color } : null,
      oncontextmenu: (e) => { if (e.target.closest('.vr-card, .vr-cat')) return; e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, c); },
    },
      h('header', { class: 'vr-group-head' },
        secImg(c, 'vr-group-img'),
        h('button', { type: 'button', class: 'vr-group-name', title: `Open ${c.name}`, onclick: () => { goTo(c.id); render(); }, ondblclick: (e) => { e.preventDefault(); renameSection(c); } }, c.name.toUpperCase()),
        h('button', { type: 'button', class: 'vr-group-add', title: `Add a variable to ${c.name}`, 'aria-label': `Add a variable to ${c.name}`, onclick: () => addEntry(c.id) }, icon('plus', 13))),
      h('div', { class: 'vr-group-body' }, ...(inner.length ? inner : [h('span', { class: 'vr-group-empty' }, 'Nothing here yet')])));
    return node;
  }

  function card(x) {
    const url = x.photo ? urlOf(x.photo, render) : null;
    const more = h('button', { type: 'button', class: 'vr-card-more', 'aria-label': `Options for ${x.name}`, onclick: (e) => { e.stopPropagation(); entryMenu(e.currentTarget, x); } }, icon('more', 14));
    const name = h('span', { class: 'vr-name', title: 'Double-click to rename' }, x.name);
    const hh = hue(x.name);
    const node = h('div', {
      class: ['vr-card vr-it', x.color && 'has-color'], role: 'button', tabindex: 0, 'aria-label': `Open ${x.name}`, 'data-id': x.id, style: x.color ? { '--vc': x.color } : null,
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openEntry(x.id); if (e.key === 'F2') renameInline(name, x); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); entryMenu({ x: e.clientX, y: e.clientY }, x); },
    },
      h('span', { class: ['vr-face', !x.photo && 'is-initials'], style: x.photo ? null : { background: `hsl(${hh},32%,26%)`, color: `hsl(${hh},60%,78%)` } },
        x.photo ? (url ? h('img', { src: url, alt: '', draggable: false }) : null) : initials(x.name)),
      name,
      more);
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); clearTimeout(node._open); renameInline(name, x); });
    // In Free View the whole card is the handle (Free View moves it); a click still opens it.
    node.addEventListener('pointerdown', (e) => { if (!node.closest('.vr-fv')) dragCard(e, node, x); });
    node.addEventListener('click', (e) => {
      if (!node.closest('.vr-fv') || e.target.closest('button, [contenteditable="true"]')) return;
      if (e.target.closest('.vr-name')) node._open = setTimeout(() => openEntry(x.id), 230); else openEntry(x.id);
    });
    return node;
  }

  // Nov 23: a top-level category can be shared with your shared Space (data/varshare.js).
  async function toggleShare(s) {
    try {
      if (s.share?.item) { await unshareCategory(s.id); toast(`${s.name} is private again.`, { ms: 2200 }); }
      else {
        const { failed } = await shareCategory(s.id);
        toast(failed.length ? `${s.name} is shared — couldn’t add ${failed.join(', ')}.` : `${s.name} is shared with your Space.`, { ms: 2600 });
      }
    } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); }
  }

  function openEntry(id) { open = id; draft = ''; editing = null; finding = false; query = ''; hit = 0; remember(); render(); }

  function renameInline(span, x) {
    if (span.isContentEditable) return;
    busy = true;
    span.contentEditable = 'true';
    span.focus();
    document.getSelection()?.selectAllChildren(span);
    const done = (ok) => {
      span.removeEventListener('blur', onBlur); span.removeEventListener('keydown', onKey);
      span.contentEditable = 'false';
      busy = false;
      const t = span.textContent.replace(/\s+/g, ' ').trim();
      if (ok && t && t !== x.name) patchEntry(x.id, () => ({ name: t.slice(0, 120) }));
      else { span.textContent = x.name; if (pending) render(); }
    };
    const onBlur = () => done(true);
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); span.blur(); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    span.addEventListener('blur', onBlur); span.addEventListener('keydown', onKey);
  }

  // Drag a card to reorder it, or onto a section tab / category tile to move it there.
  function dragCard(e, node, x) {
    if (e.button !== 0 || e.target.closest('button, [contenteditable="true"]')) return;
    const sx = e.clientX, sy = e.clientY;
    const r0 = node.getBoundingClientRect();
    let ghost = null, mark = null, drop = null;
    const clear = () => { mark?.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-in'); mark = null; };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!ghost) {
        dragging = true;
        ghost = node.cloneNode(true);
        ghost.classList.add('vr-ghost');
        Object.assign(ghost.style, { width: `${r0.width}px`, height: `${r0.height}px`, left: `${r0.left}px`, top: `${r0.top}px` });
        document.body.append(ghost);
        node.classList.add('is-lifted');
        document.body.classList.add('fi-dragging');
      }
      ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) rotate(-1.5deg)`;
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const sec = t?.closest?.('.vr [data-sec]');
      const other = t?.closest?.('.vr-card[data-id]');
      clear(); drop = null;
      if (sec && box.contains(sec)) { mark = sec; sec.classList.add('is-drop-in'); drop = { section: sec.dataset.sec }; }
      else if (other && other !== node && box.contains(other)) {
        const b = other.getBoundingClientRect();
        const after = ev.clientX > b.left + b.width / 2;
        mark = other; other.classList.add(after ? 'is-drop-after' : 'is-drop-before');
        drop = { id: other.dataset.id, after };
      }
    };
    const up = (ev) => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
      clear();
      document.body.classList.remove('fi-dragging');
      if (!ghost) {
        // A click. Clicking the name waits a beat so a double-click can rename instead.
        if (ev.type === 'pointerup') {
          if (e.target.closest('.vr-name')) node._open = setTimeout(() => openEntry(x.id), 230);
          else openEntry(x.id);
        }
        return;
      }
      ghost.remove();
      node.classList.remove('is-lifted');
      dragging = false;
      if (!drop) { if (pending) render(); return; }
      const rest = entries().filter((y) => y.id !== x.id);
      if (drop.section) {
        const target = secById(drop.section);
        if (!target) return;
        // Dropping on a tab with sub-sections files it at the top level of that tab.
        setEntries([...rest, { ...x, section: target.id }]);
        toast(`Moved to ${pathOf(target.id)}.`, { ms: 1600 });
        return;
      }
      const ref = rest.find((y) => y.id === drop.id);
      const i = rest.indexOf(ref);
      rest.splice(drop.after ? i + 1 : i, 0, { ...x, section: ref.section });
      setEntries(rest);
    };
    node.setPointerCapture(e.pointerId);
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
  }

  function addMenu(anchor) {
    menu(anchor, [
      { label: 'New section', icon: 'folder', onSelect: () => addSection(null) },
      here() ? { label: `New sub-section in ${secById(here())?.name}`, icon: 'folder', onSelect: () => addSection(here()) } : null,
      '-',
      { label: 'Import from Variables file…', icon: 'upload', onSelect: importFile },
    ].filter(Boolean));
  }

  async function addSection(parent) {
    const name = await promptDialog(parent ? `New sub-section in ${secById(parent)?.name}` : 'New section', { placeholder: parent ? 'e.g. Student, Cadet Officer' : 'e.g. Gym, Church, Clients', ok: 'Add', maxLength: 120 });
    if (!name?.trim()) return;
    const dup = sections().some((x) => (x.parent || null) === (parent || null) && x.name.toLowerCase() === name.trim().toLowerCase());
    if (dup) { toast('There’s already a section with that name.', { tone: 'error' }); return; }
    const s = parent ? { id: uid(), name: name.trim(), parent } : { id: uid(), name: name.trim() };
    save({ sections: [...sections(), s] });
    goTo(s.id); render();
  }

  async function renameSection(s) {
    const name = await promptDialog('Rename section', { value: s.name, maxLength: 120 });
    if (!name?.trim() || name.trim() === s.name) return;
    save({ sections: sections().map((x) => (x.id === s.id ? { ...x, name: name.trim() } : x)) });
  }

  function sectionMenu(anchor, s) {
    const siblings = sections().filter((x) => (x.parent || null) === (s.parent || null));
    const i = siblings.findIndex((x) => x.id === s.id);
    const swap = (j) => {
      const a = siblings[i], b = siblings[j];
      save({ sections: sections().map((x) => (x.id === a.id ? b : x.id === b.id ? a : x)) });
    };
    const prev = s.parent ? 'Move up' : 'Move left', next = s.parent ? 'Move down' : 'Move right';
    menu(anchor, [
      { header: pathOf(s.id) },
      { label: 'Add variable here', icon: 'plus', onSelect: () => { goTo(s.id); render(); addEntry(); } },
      { label: 'Add sub-section', icon: 'folder', onSelect: () => addSection(s.id) },
      { label: 'Rename', icon: 'edit', onSelect: () => renameSection(s) },
      { label: s.img ? 'Replace image' : 'Add an image', icon: 'image', onSelect: async () => { const [f] = await pickMedia({ multiple: false, accept: 'image/*' }); if (f) setSecImg(s.id, f); } },
      s.img ? { label: 'Remove image', icon: 'eyeOff', onSelect: () => save({ sections: sections().map((x) => (x.id === s.id ? { ...x, img: null } : x)) }) } : null,
      !s.parent && !foreign ? { label: s.share?.item ? 'Make private' : 'Share with your Space', icon: s.share?.item ? 'lock' : 'users', onSelect: () => toggleShare(s) } : null,
      { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, s.color).then((c) => { if (c !== undefined) save({ sections: sections().map((x) => (x.id === s.id ? { ...x, color: c } : x)) }); }) },
      undoItem(),
      { label: prev, icon: 'chevronLeft', disabled: i === 0, onSelect: () => swap(i - 1) },
      { label: next, icon: 'chevronRight', disabled: i === siblings.length - 1, onSelect: () => swap(i + 1) },
      '-',
      { label: 'Delete section', icon: 'trash', danger: true, disabled: !s.parent && tops().length < 2, onSelect: () => deleteSection(s) },
    ].filter(Boolean));
  }

  async function setSecImg(id, f) {
    try {
      const up = await uploadMedia(f);
      save({ sections: sections().map((x) => (x.id === id ? { ...x, img: up.path } : x)) });
    } catch (e) { toast(e?.message || friendlyError(e), { tone: 'error' }); }
  }

  async function deleteSection(s) {
    const ids = descOf(s.id);
    const inside = entries().filter((x) => ids.has(x.section));
    const subs = ids.size - 1;
    if ((inside.length || subs) && !(await confirmDialog(`Delete ${s.name}?`, [subs ? `${subs} sub-section${subs === 1 ? '' : 's'}` : '', inside.length ? `${inside.length} entr${inside.length === 1 ? 'y' : 'ies'} and their notes` : ''].filter(Boolean).join(' and ') + ' go with it.'))) return;
    if (ids.has(sub)) { const up = s.parent; if (up && up !== section) sub = up; else sub = null; }
    save({ sections: sections().filter((x) => !ids.has(x.id)), entries: entries().filter((x) => !ids.has(x.section)) });
  }

  // Every section as "School › Student" for pickers.
  const allSecs = () => { const out = [], seen = new Set(); const walk = (x) => { if (seen.has(x.id)) return; seen.add(x.id); out.push(x); kids(x.id).forEach(walk); }; tops().forEach(walk); return out; };

  async function addEntry(into = null) {
    const name = h('input', { class: 'input', placeholder: 'A person, a group, a commitment', maxlength: 120, 'aria-label': 'Name' });
    let file = null;
    const face = h('span', { class: 'vr-pick-face' }, icon('user', 22));
    const pick = h('button', {
      type: 'button', class: 'vr-pick', onclick: async () => {
        const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
        if (!f) return;
        file = f;
        face.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }));
        pickLabel.textContent = 'Change photo';
      },
    }, face);
    const pickLabel = h('span', { class: 'vr-pick-label' }, 'Add a photo (optional)');
    const secSel = h('select', { class: 'input', 'aria-label': 'Section' }, allSecs().map((s) => h('option', { value: s.id, selected: s.id === (into || here()) }, s.parent ? `   ${pathOf(s.id)}` : s.name)));
    setTimeout(() => name.focus(), 50);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('.dlg')?.querySelector('.btn-primary')?.click(); });
    const ok = await dialog({
      title: 'New variable',
      width: 420,
      body: h('div', { class: 'stack' },
        h('div', { class: 'vr-pick-row' }, pick, pickLabel),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Section'), secSel)),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    const n = name.value.trim();
    if (!ok || !n) return;
    const x = { id: uid(), section: secSel.value, name: n, photo: null, notes: [], at: Date.now() };
    goTo(x.section);
    setEntries([...entries(), x]);
    if (file) setPhoto(x.id, file);
  }

  async function setPhoto(id, f) {
    try {
      const up = await uploadMedia(f);
      patchEntry(id, () => ({ photo: up.path }));
    } catch (e) { toast(e?.message || friendlyError(e), { tone: 'error' }); }
  }

  function entryMenu(anchor, x) {
    const others = allSecs().filter((s) => s.id !== x.section);
    const nameEl = () => box.querySelector(`.vr-card[data-id="${x.id}"] .vr-name`);
    menu(anchor, [
      { label: 'Open notes', icon: 'chat', onSelect: () => openEntry(x.id) },
      { label: 'Rename', icon: 'edit', kbd: 'F2', onSelect: () => { const n = nameEl(); if (n) renameInline(n, x); else promptDialog('Rename', { value: x.name, maxLength: 120 }).then((v) => { if (v?.trim()) patchEntry(x.id, () => ({ name: v.trim().slice(0, 120) })); }); } },
      { label: x.photo ? 'Replace profile picture' : 'Add a profile picture', icon: 'image', onSelect: async () => { const [f] = await pickMedia({ multiple: false, accept: 'image/*' }); if (f) setPhoto(x.id, f); } },
      x.photo ? { label: 'Remove picture', icon: 'eyeOff', onSelect: () => patchEntry(x.id, () => ({ photo: null })) } : null,
      { label: 'Color…', icon: 'textColor', onSelect: () => pickColor(anchor, x.color).then((c) => { if (c !== undefined) patchEntry(x.id, () => ({ color: c })); }) },
      { label: 'Duplicate', icon: 'copy', onSelect: () => { const list = entries(); const i = list.findIndex((y) => y.id === x.id); const copy = { ...x, id: uid(), name: `${x.name} copy`, notes: [], at: Date.now() }; setEntries([...list.slice(0, i + 1), copy, ...list.slice(i + 1)]); } },
      others.length ? { header: 'Move to' } : null,
      ...others.map((s) => ({ label: pathOf(s.id), icon: 'folderMove', onSelect: () => patchEntry(x.id, () => ({ section: s.id })) })),
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => { if (await confirmDialog(`Delete ${x.name}?`, x.notes?.length ? 'Its notes go with it. Ctrl+Z brings it back.' : 'Ctrl+Z brings it back.')) setEntries(entries().filter((y) => y.id !== x.id)); } },
      undoItem(),
    ].filter(Boolean));
  }

  /* ---------------- import: the v59 custom-widget Variables (HTML export) ---------------- */
  // Reads its sections (School › Student …), names and profile pictures; merges by name.
  async function importFile() {
    const [f] = await pickMedia({ multiple: false, accept: '.html,.htm,text/html' });
    if (!f) return;
    let plan;
    try { plan = readVariablesHtml(await f.text()); } catch { plan = null; }
    if (!plan) { toast('That doesn’t look like a Variables export.', { tone: 'error' }); return; }
    const total = countPeople(plan);
    if (!total) { toast('No variables found in that file.', { tone: 'error' }); return; }
    if (!(await confirmDialog('Import variables?', `${plan.length} section${plan.length === 1 ? '' : 's'} and ${total} entr${total === 1 ? 'y' : 'ies'}. Anything with the same name is kept, not duplicated.`, { ok: 'Import', danger: false }))) return;
    const progress = toast(`Importing… 0/${total}`, { ms: 0 });
    const out = await mergeVariables({ sections: sections(), entries: entries() }, plan, { onStep: (n) => progress.update(`Importing… ${n}/${total}`) });
    progress.close();
    save({ sections: out.sections, entries: out.entries });
    toast(`Imported ${out.added} new entr${out.added === 1 ? 'y' : 'ies'}.`, { ms: 3000 });
  }

  /* ---------------- an entry's notes ---------------- */
  function msgRows(x, list = x.notes || []) {
    const rows = [];
    let lastDay = '', prev = null;
    for (const m of list) {
      const dl = chatDayLabel(m.ts);
      if (dl !== lastDay) { rows.push(dayRow(m.ts)); lastDay = dl; prev = null; }
      rows.push(bubble(x, m, prev && prev.by === m.by && m.ts - prev.ts < CHAT_GROUP_MS));
      prev = m;
    }
    return rows.length ? rows : (x.notes?.length ? [] : [h('p', { class: 'sc-empty' }, `Notes on ${x.name}. Reflect, keep track, see how things change.`)]);
  }

  /* ---------------- reorder (default view) ---------------- */
  // Drag a message's handle up or down to change where it sits in the conversation. The order is the
  // notes' own order, so Free View's column follows it too (messages you've placed by hand stay put).
  function orderRows(x) {
    const rows = msgRows(x);
    for (const row of rows) {
      if (!row.matches?.('.sc-msg[data-id]')) continue;
      const g = h('button', { type: 'button', class: 'vr-ord-grip', 'aria-label': 'Drag to reorder', title: 'Drag to reorder' }, icon('grip', 12));
      g.addEventListener('pointerdown', (e) => dragOrder(e, row, x));
      row.classList.add('has-grip');
      row.prepend(g);
    }
    return rows;
  }

  function dragOrder(e, row, x) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const list = row.closest('.vr-msgs');
    if (!list) return;
    const id = row.dataset.id;
    const sy = e.clientY;
    const line = h('div', { class: 'vr-ord-line', 'aria-hidden': 'true' });
    let on = false, before = undefined; // undefined: no move · null: to the end · id: above that message
    const move = (ev) => {
      if (!on && Math.abs(ev.clientY - sy) < 4) return;
      if (!on) { on = true; dragging = true; row.classList.add('is-lifted'); list.classList.add('is-ordering'); list.append(line); document.body.classList.add('fi-dragging'); }
      const lr = list.getBoundingClientRect();
      if (ev.clientY > lr.bottom - 30) list.scrollTop += 12; else if (ev.clientY < lr.top + 30) list.scrollTop -= 12;
      const rows = [...list.querySelectorAll('.sc-msg[data-id]')].filter((r) => r !== row);
      const next = rows.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; }) || null;
      before = next ? next.dataset.id : null;
      const ref = next || rows[rows.length - 1];
      const top = ref ? (next ? ref.offsetTop - 5 : ref.offsetTop + ref.offsetHeight + 3) : 0;
      line.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      document.body.classList.remove('fi-dragging');
      line.remove(); row.classList.remove('is-lifted'); list.classList.remove('is-ordering');
      dragging = false;
      if (!on || before === undefined || before === id) { if (pending) render(); return; }
      patchEntry(x.id, (en) => {
        const notes = [...(en.notes || [])];
        const i = notes.findIndex((m) => m.id === id);
        if (i < 0) return {};
        const [m] = notes.splice(i, 1);
        const j = before ? notes.findIndex((n) => n.id === before) : -1;
        notes.splice(j < 0 ? notes.length : j, 0, m);
        return { notes };
      });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  // Menu shortcut: one step up or down.
  function nudgeNote(x, m, d) {
    patchEntry(x.id, (en) => {
      const notes = [...(en.notes || [])];
      const i = notes.findIndex((n) => n.id === m.id), j = i + d;
      if (i < 0 || j < 0 || j >= notes.length) return {};
      [notes[i], notes[j]] = [notes[j], notes[i]];
      return { notes };
    });
  }

  // Nov 28 — Free View's chat dock: the conversation and its composer sit in a side dock outside the canvas
  // (panning and zooming move only the canvas). No header, outline or divider. Drag a message from the dock
  // onto the canvas to place that bubble there; placed messages show only on the canvas, the rest stay here.
  // The toggle on the dock's edge hides it (the canvas takes the full width) and brings it back as it was.
  let dockScroll = null;
  function fvDock(x, fv, editingHere, compose) {
    const shown = store.get('architect.vr.dock', true);
    const pos = x.free?.pos || {};
    const list = h('div', { class: 'vr-msgs sc-list vr-dock-list', role: 'log' }, msgRows(x, (x.notes || []).filter((m) => !pos[m.id])));
    const dock = h('div', { class: 'vr-dock', hidden: !shown }, list, editingHere ? editBar(x) : null, compose);
    const tab = h('button', {
      type: 'button', class: ['vr-dock-tab', shown && 'is-open'], 'aria-pressed': String(shown),
      'aria-label': shown ? 'Hide the chat' : 'Show the chat', 'data-tip': shown ? 'Hide the chat' : 'Show the chat',
      onclick: () => { dockScroll = list.scrollTop; store.set('architect.vr.dock', !shown); render(); },
    }, icon(shown ? 'chevronRight' : 'chevronLeft', 15));
    list.addEventListener('scroll', () => { dockScroll = list.scrollTop; }, { passive: true });
    requestAnimationFrame(() => { list.scrollTop = dockScroll ?? list.scrollHeight; });
    // drag a bubble out of the dock and onto the canvas
    list.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, video, input, textarea, [contenteditable="true"]')) return;
      const row = e.target.closest('.sc-msg[data-id]');
      if (!row) return;
      const id = row.dataset.id, x0 = e.clientX, y0 = e.clientY, r = row.getBoundingClientRect();
      let ghost = null;
      const mv = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
          ghost = row.cloneNode(true); ghost.classList.add('vr-dock-ghost');
          Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
          document.body.append(ghost); row.classList.add('is-lifting');
        }
        ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
        ghost.classList.toggle('is-over', fv.over(ev.clientX, ev.clientY));
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
        if (!ghost) return;
        ghost.remove(); row.classList.remove('is-lifting');
        if (fv.over(ev.clientX, ev.clientY)) fv.placeAt(id, ev.clientX, ev.clientY, { x: x0 - r.left, y: y0 - r.top });
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    return h('div', { class: ['vr-fv-split', !shown && 'is-dock-off'] }, fv.el, tab, dock);
  }

  function chat(x) {
    if (editing && (editing.entry !== x.id || !(x.notes || []).some((m) => m.id === editing.id))) editing = null;
    const editingHere = !!editing;
    const ta = h('textarea', {
      class: 'vr-input sc-input', rows: 1, placeholder: 'Enter your message', maxlength: 4000, 'aria-label': 'Write a note', value: draft,
      oninput: (e) => { draft = e.target.value; grow(e.target); },
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(x.id, e.target); }
        else if (e.key === 'Escape' && editingHere) { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
        else if (e.key === 'ArrowUp' && !e.target.value && !editingHere) {
          const last = [...(x.notes || [])].reverse().find((m) => m.text && (!m.by || m.by === me?.id));
          if (last) { e.preventDefault(); beginEdit(x, last); }
        }
      },
      onfocus: () => { busy = true; },
      onblur: () => { busy = false; if (pending) setTimeout(render, 0); },
    });
    const fvOn = !!x.free?.on;
    if (fvOn) {
      free = mountFreeView({
        entry: () => entries().find((e) => e.id === x.id) || x,
        flowRows: (list) => msgRows(x, list),
        one: (m) => bubble(x, m),
        media: { pick: pickMedia, upload: uploadMedia, url: urlOf },
        save: (f) => patchEntry(x.id, () => ({ free: f })),
        // Clearing messages from free view deletes them from the chat, and tidies their layout.
        remove: (ids, fp = {}) => {
          const gone = new Set(ids);
          patchEntry(x.id, (e) => {
            const f = { pos: {}, size: {}, links: [], ...(e.free || {}), ...fp, on: true };
            const pos = { ...f.pos }, size = { ...f.size };
            gone.forEach((id) => { delete pos[id]; delete size[id]; });
            return { notes: (e.notes || []).filter((m) => !gone.has(m.id)), free: { ...f, pos, size, links: f.links.filter((l) => !gone.has(l.a) && !gone.has(l.b)) } };
          });
        },
        idle: () => { if (pending) setTimeout(render, 0); },
        // Zones (Nov 26): Capture moves the section into this chat's Library in one write — the messages
        // leave the chat as they enter the cube (moved, never duplicated).
        zones: true,
        capture: async (cube, msgIds, fp) => {
          const gone = new Set(msgIds);
          const byId = new Map(((entries().find((e) => e.id === x.id) || x).notes || []).map((m) => [m.id, m]));
          if (msgIds.some((id) => !byId.has(id))) throw new Error('Some of those messages changed — try again.');
          patchEntry(x.id, (e) => {
            const f = { pos: {}, size: {}, links: [], ...(e.free || {}), ...fp, on: true };
            const pos = { ...f.pos }, size = { ...f.size };
            gone.forEach((id) => { delete pos[id]; delete size[id]; });
            const lib = e.library || { cubes: [] };
            const n = (lib.cubes || []).length;
            const placed = { ...cube, x: 40 + (n % 4) * 230, y: 40 + Math.floor(n / 4) * 210 };
            return { notes: (e.notes || []).filter((m) => !gone.has(m.id)), free: { ...f, pos, size }, library: { ...lib, cubes: [...(lib.cubes || []), placed] } };
          });
        },
        paste: async (notes, fp) => patchEntry(x.id, (e) => ({ notes: [...(e.notes || []), ...notes].slice(-MAX_NOTES), free: { ...(e.free || {}), ...fp, on: true } })),
        library: libraryOf(x),
        dock: true,
      });
    }
    const toggle = h('button', {
      type: 'button', class: ['vr-fv-toggle', fvOn && 'is-on'], 'aria-pressed': String(fvOn),
      title: fvOn ? 'Back to the normal column' : 'Free view: drag messages anywhere, link them, draw',
      onclick: () => patchEntry(x.id, (e) => ({ free: { pos: {}, links: [], ink: [], ...(e.free || {}), on: !fvOn } })),
    }, h('i'), 'FREE VIEW');
    const tools = [
      h('button', { class: ['vr-find-toggle', finding && 'is-on'], type: 'button', 'aria-label': 'Search this chat', 'aria-pressed': String(finding), title: 'Search this chat', onclick: () => (finding ? closeFind() : openFind()) }, icon('search', 15)),
      toggle,
      h('button', { class: 'vr-card-more', type: 'button', 'aria-label': 'Options', onclick: (e) => entryMenu(e.currentTarget, x) }, icon('more', 14))];
    // In the sidebar (Nov 24) the chat has no title row of its own — the sidebar already shows which chat
    // is open; Search, Free View and ··· ride in the top bar instead.
    if (w?.chatTools) w.chatTools.replaceChildren(...tools);
    const head = w?.chatTools ? null : h('div', { class: 'vr-chat-head' },
      h('button', { class: 'vr-back', type: 'button', 'aria-label': 'Back to variables', onclick: () => { open = null; editing = null; draft = ''; finding = false; query = ''; remember(); render(); } }, icon('chevronLeft', 16)),
      x.photo ? h('span', { class: 'vr-mini-face' }, urlOf(x.photo, render) ? h('img', { src: urlOf(x.photo), alt: '' }) : null) : null,
      h('span', { class: 'vr-chat-name' }, x.name),
      h('span', { class: 'vr-chat-sec' }, pathOf(x.section)),
      ...tools);
    const compose = h('div', { class: ['vr-compose sc-compose', editingHere && 'is-editing'] },
      h('button', { class: ['sc-plus', sending && 'is-busy'], type: 'button', 'aria-label': 'Add a photo', disabled: sending, onclick: async () => { const fs = await pickMedia({ accept: 'image/*,video/*' }); if (fs.length) sendFiles(x.id, fs); } },
        sending ? h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')) : icon('plus', 18)),
      ta);
    const wrap = h('div', { class: ['vr-chat is-sc', fvOn && 'is-free', free && 'has-dock'] }, head,
      finding ? findBar() : null,
      free ? fvDock(x, free, editingHere, compose) : h('div', { class: 'vr-msgs sc-list', role: 'log' }, orderRows(x)),
      free ? null : editingHere ? editBar(x) : null,
      free ? null : compose);
    wrap.addEventListener('paste', (e) => { const fs = mediaFiles(e.clipboardData); if (fs.length) { e.preventDefault(); sendFiles(x.id, fs); } });
    wrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); wrap.classList.add('is-drop'); } });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('is-drop'); });
    wrap.addEventListener('drop', (e) => { wrap.classList.remove('is-drop'); const fs = mediaFiles(e.dataTransfer); if (fs.length) { e.preventDefault(); e.stopPropagation(); sendFiles(x.id, fs); } });
    requestAnimationFrame(() => {
      grow(ta);
      if (editing?.focus) { editing.focus = false; ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
    return wrap;
  }

  // Editing a note works like Side Chat: the composer becomes the edit, with the note it changes above it.
  function editBar(x) {
    const m = (x.notes || []).find((n) => n.id === editing.id);
    return h('div', { class: 'sc-mode vr-mode' }, icon('edit', 13),
      h('span', { class: 'sc-mode-body' }, h('b', {}, 'Editing'), h('span', { class: 'sc-mode-text' }, (m?.text || '').replace(/\s+/g, ' ').slice(0, 140))),
      h('button', { class: 'sc-mode-x', type: 'button', 'aria-label': 'Cancel editing', title: 'Cancel (Esc)', onclick: () => cancelEdit() }, icon('close', 13)));
  }
  function beginEdit(x, m) {
    { const z = zonedIn(x, m.id); if (z) { zoneLocked(z); return; } }
    editing = { entry: x.id, id: m.id, keep: editing ? editing.keep : draft, focus: true };
    draft = m.text || '';
    busy = false;
    render();
  }
  function cancelEdit() {
    if (!editing) return;
    draft = editing.keep || '';
    editing = null;
    busy = false;
    render();
    requestAnimationFrame(() => box.querySelector('.vr-input')?.focus({ preventScroll: true }));
  }

  function bubble(x, m, cont = false) {
    const mine = !m.by || m.by === me?.id;
    return bubbleRow({ id: m.id, text: m.text, files: m.files, at: m.ts, edited: m.edited }, {
      cont, theirs: !mine, who: m.name || '',
      onAsset: render,
      onMenu: (e) => msgMenu({ x: e.clientX, y: e.clientY }, x, m),
    });
  }

  // A chat's Library of Zone Cubes (Nov 26).
  function libraryOf(x) {
    const cur = () => entries().find((e) => e.id === x.id) || x;
    const get = () => cur().library || { cubes: [] };
    const set = (p, { dropEmbeds = null } = {}) => patchEntry(x.id, (e) => {
      const out = { library: { ...(e.library || { cubes: [] }), ...p } };
      if (dropEmbeds && e.free?.embeds) out.free = { ...e.free, embeds: e.free.embeds.filter((q) => q.cube !== dropEmbeds) };
      return out;
    });
    return {
      name: cur().name, get, set,
      patchCube: (id, p) => set({ cubes: (get().cubes || []).map((c) => (c.id === id ? { ...c, ...p } : c)) }),
      others: () => entries().filter((e) => e.id !== x.id && !e.kind).map((e) => ({ id: e.id, name: `${e.name}${e.section ? ` · ${pathOf(e.section)}` : ''}` })),
      // Copy keeps it here too; Move takes it (and its embeds) out of this chat.
      copyTo: async (cube, id, move) => {
        const copy = { ...structuredClone(cube), id: uid(), x: 40, y: 40 };
        setEntries(entries().map((e) => {
          if (e.id === id) { const lib = e.library || { cubes: [] }; return { ...e, library: { ...lib, cubes: [...(lib.cubes || []), { ...copy, x: 40 + ((lib.cubes || []).length % 4) * 230 }] } }; }
          if (move && e.id === x.id) return { ...e, library: { ...(e.library || {}), cubes: (e.library?.cubes || []).filter((c) => c.id !== cube.id) }, free: e.free ? { ...e.free, embeds: (e.free.embeds || []).filter((q) => q.cube !== cube.id) } : e.free };
          return e;
        }));
        toast(`${move ? 'Moved' : 'Copied'} to ${entries().find((e) => e.id === id)?.name || 'that chat'}.`, { ms: 1800 });
      },
    };
  }
  const zonedIn = (x, id) => (x.free?.on ? (x.free.zones || []).find((z) => (z.members || []).includes(id)) : null);
  const zoneLocked = (z) => toast(`In the zone “${z.name}”: read and copy only. Remove the zone to release it.`, { ms: 3000 });

  function msgMenu(anchor, x, m) {
    const z = zonedIn(x, m.id);
    if (z) {
      menu(anchor, [
        { header: `In zone “${z.name}” · protected` },
        m.text ? { label: 'Copy', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(m.text); toast('Copied.', { ms: 1400 }); } catch {} } } : null,
      ].filter(Boolean));
      return;
    }
    menu(anchor, [
      m.text ? { label: 'Copy', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(m.text); toast('Copied.', { ms: 1400 }); } catch {} } } : null,
      !x.free?.on ? { label: 'Move up', icon: 'chevronUp', disabled: (x.notes || [])[0]?.id === m.id, onSelect: () => nudgeNote(x, m, -1) } : null,
      !x.free?.on ? { label: 'Move down', icon: 'chevronDown', disabled: (x.notes || []).at(-1)?.id === m.id, onSelect: () => nudgeNote(x, m, 1) } : null,
      m.text ? { label: 'Edit', icon: 'edit', kbd: '↑', onSelect: () => beginEdit(x, m) } : null,
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => patchEntry(x.id, (e) => ({ notes: (e.notes || []).filter((y) => y.id !== m.id) })) },
    ].filter(Boolean));
  }

  const note = (p) => ({ id: uid(), by: me?.id || null, name: me?.username || '', ts: Date.now(), text: '', files: [], ...p });
  const pushNote = (id, n) => patchEntry(id, (e) => ({ notes: [...(e.notes || []), n].slice(-MAX_NOTES) }));

  function send(id, ta) {
    const text = ta.value.trim();
    if (editing && editing.entry === id) {
      const eid = editing.id;
      const old = entries().find((e) => e.id === id)?.notes?.find((m) => m.id === eid)?.text;
      draft = editing.keep || ''; editing = null; busy = false;
      if (text && text !== old) patchEntry(id, (e) => ({ notes: (e.notes || []).map((y) => (y.id === eid ? { ...y, text: text.slice(0, 4000), edited: true, et: Date.now() } : y)) }));
      else render();
      requestAnimationFrame(() => box.querySelector('.vr-input')?.focus({ preventScroll: true }));
      return;
    }
    if (!text) return;
    ta.value = ''; draft = ''; grow(ta);
    pushNote(id, note({ text }));
  }

  async function sendFiles(id, fs) {
    if (sending) return;
    sending = true; render();
    const files = [];
    for (const f of fs) {
      try { const up = await uploadMedia(f); files.push({ kind: up.kind, path: up.path, name: up.name, dur: up.dur }); }
      catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    }
    sending = false;
    if (files.length) pushNote(id, note({ files }));
    render();
  }

  function grow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(160, ta.scrollHeight)}px`; }

  render();
  const off = src.on((d, keys) => { if (keys && keys.every((k) => k === 'ideas')) return; render(); }); // ideas share the row: don't repaint for them
  // Enter to talk (Nov 24): an open chat here is where the composer sends.
  const offSay = w?.field ? () => {} : registerVarChat({
    root: box,
    isOpen: () => !!open && entries().some((e) => e.id === open),
    name: () => entries().find((e) => e.id === open)?.name || 'this chat',
    send: (t) => { if (open) pushNote(open, note({ text: String(t).slice(0, 4000) })); },
    sendFiles: (files) => { if (open && files?.length) pushNote(open, note({ files })); },
  });
  const offUndo = trackUndo(box, src);
  const offRpan = w?.host?.editor ? innerRightPan(box) : () => {};
  src.load().then(() => {
    // Your account has no Variables yet: your personal Space's list becomes yours automatically.
    // (The shared object's old list could be anyone's, so that one waits for "Bring in".)
    const empty = !acct().entries.length && !acct().sections;
    if (!foreign && empty && w.host?.personal && !store.get(`${memKey}.legacy`, null) && ((el.entries || []).length || (el.sections || []).length)) {
      setMyVars({ sections: el.sections?.length ? el.sections : null, entries: el.entries || [] });
      store.set(`${memKey}.legacy`, 'done');
    }
    ready = true;
    render();
  }).catch(() => { ready = true; render(); });

  return {
    // Driven from outside (the desktop sidebar, Nov 23): open a category, a sub-section, or one chat.
    show(p = {}) {
      if ('section' in p) section = p.section;
      if ('sub' in p) sub = p.sub;
      if ('open' in p && p.open !== open) { open = p.open; draft = ''; editing = null; finding = false; query = ''; hit = 0; }
      remember();
      render();
    },
    state: () => ({ section, sub, open }),
    update(next) {
      const legacyChanged = next.entries !== el.entries;
      el = next;
      if (legacyChanged && ready && !open) render();
    },
    destroy() { off(); offSay(); offUndo(); offRpan(); free?.destroy(); box.remove(); },
  };
}
