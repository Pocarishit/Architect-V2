// Variables — your map of everything outside you that shapes your life.
// Sections (School, Family, Business, Friends… all renamable) hold entries: a person, a group,
// a commitment. Each entry opens into its own running chat of notes, so you can reflect and
// track how it changes over time. Lives on the widget object, synced like the rest of the Space.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, dialog, confirmDialog, promptDialog } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia } from './media.js';
import { bubbleRow, dayRow, chatDayLabel, CHAT_GROUP_MS } from './sidechat.js';
import { loadMyVars, myVars, setMyVars, onMyVars } from '../data/myvars.js';
import { mountFreeView } from './freeview.js';

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
  const freeBusy = () => !!free?.busy();
  let finding = false, query = '', hit = 0; // the open chat's search bar
  const remember = () => store.set(memKey, { section, sub, open });

  const box = h('div', { class: 'vr' });
  root.append(box);

  // Your Variables live on your account (data/myvars.js), not on this object: the same in both Spaces,
  // and in the shared Space everyone sees only their own. What's still saved on the object from before
  // is "legacy" — offered once, never shown as yours until you bring it in.
  let ready = false;
  const acct = () => myVars() || { sections: null, entries: [] };
  let defaults = null;
  const sections = () => acct().sections || (defaults ||= defaultVariables().sections);
  const tops = () => sections().filter((s) => !s.parent);
  const kids = (id) => sections().filter((s) => s.parent === id);
  const secById = (id) => sections().find((s) => s.id === id);
  const entries = () => acct().entries || [];
  const inSec = (id) => entries().filter((x) => x.section === id);
  const countIn = (id) => inSec(id).length + kids(id).reduce((n, k) => n + inSec(k.id).length, 0);
  const pathOf = (id) => { const s = secById(id); if (!s) return ''; const p = s.parent && secById(s.parent); return p ? `${p.name} › ${s.name}` : s.name; };
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
    if (dragging || freeBusy()) { pending = true; return; }
    if (busy) {
      // Typing a note: refresh the messages in place, keep the composer (and your cursor) alone.
      const x = open && entries().find((e) => e.id === open);
      const list = box.querySelector('.vr-msgs');
      if (x && free && x.free?.on) { free.update(x); markFind(false); return; }
      if (x && list && !x.free?.on) {
        const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.replaceChildren(...msgRows(x));
        if (atEnd && !query) list.scrollTop = list.scrollHeight;
        markFind(false);
      } else pending = true;
      return;
    }
    pending = false;
    const t = tops();
    if (!t.some((s) => s.id === section)) section = t[0]?.id || null;
    if (sub && secById(sub)?.parent !== section) sub = null;
    const entry = open && entries().find((x) => x.id === open);
    if (open && !entry) open = null;
    const keep = box.querySelector('.vr-grid')?.scrollTop;
    free?.destroy(); free = null;
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
  function grid(t) {
    const tabs = h('div', { class: 'vr-tabs', role: 'tablist' },
      t.map((s) => h('button', {
        type: 'button', role: 'tab', class: ['vr-tab', s.id === section && 'is-on'], 'aria-selected': String(s.id === section), 'data-sec': s.id,
        onclick: () => { section = s.id; sub = null; remember(); render(); },
        ondblclick: () => renameSection(s),
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, s); },
      }, s.name.toUpperCase())),
      h('button', { type: 'button', class: 'vr-tab-add', title: 'Add', 'aria-label': 'Add a section or import', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 14)));

    const cur = here();
    const cats = sub ? [] : kids(section);
    const list = inSec(cur);
    const body = [];
    if (sub) {
      const s = secById(sub);
      body.push(h('div', { class: 'vr-crumb' },
        h('button', { type: 'button', class: 'vr-crumb-back', onclick: () => { sub = null; remember(); render(); } }, icon('chevronLeft', 14), 'SECTIONS'),
        h('span', { class: 'vr-crumb-name', style: { '--h': hue(s?.name || '') }, oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); if (s) sectionMenu({ x: e.clientX, y: e.clientY }, s); }, ondblclick: () => s && renameSection(s) }, (s?.name || '').toUpperCase())));
    }
    const tiles = cats.map((c) => h('button', {
      type: 'button', class: 'vr-cat', 'data-sec': c.id, style: { '--h': hue(c.name) },
      onclick: () => { sub = c.id; remember(); render(); },
      ondblclick: (e) => { e.preventDefault(); renameSection(c); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, c); },
    }, h('span', { class: 'vr-cat-name' }, c.name.toUpperCase()), h('small', {}, String(countIn(c.id)))));
    const cards = list.map((x) => card(x));
    cards.push(h('button', { type: 'button', class: 'vr-card vr-new', onclick: () => addEntry() }, icon('plus', 18), h('span', {}, 'Add')));
    const gridEl = h('div', { class: 'vr-grid' }, ...tiles, ...cards);
    gridEl.addEventListener('contextmenu', (e) => {
      if (e.target !== gridEl) return;
      e.preventDefault(); e.stopPropagation();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: `Add variable to ${secById(cur)?.name || 'here'}`, icon: 'plus', onSelect: () => addEntry() },
        !sub ? { label: `Add sub-section in ${secById(section)?.name || 'here'}`, icon: 'folder', onSelect: () => addSection(section) } : null,
        { label: 'Add section', icon: 'folder', onSelect: () => addSection(null) },
        '-',
        { label: 'Import from Variables file…', icon: 'upload', onSelect: importFile },
      ].filter(Boolean));
    });
    const old = store.get(`${memKey}.legacy`, null) ? [] : legacyNew();
    const banner = old.length ? h('div', { class: 'vr-legacy' },
      h('span', {}, `Variables are now private to each account. ${old.length} saved on this object from before ${old.length === 1 ? 'isn’t' : 'aren’t'} in yours.`),
      h('button', { type: 'button', class: 'btn btn-primary sm', onclick: bringIn }, 'Bring in'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { store.set(`${memKey}.legacy`, 'dismissed'); render(); } }, 'Not mine')) : null;
    return h('div', { class: 'vr-home' }, tabs, banner, ...body, gridEl,
      !list.length && !cats.length ? h('p', { class: 'vr-hint' }, 'A teacher, a committee, your family, the office — every influence gets its own space. Right-click here to add one.') : null);
  }

  function card(x) {
    const url = x.photo ? urlOf(x.photo, render) : null;
    const notes = x.notes?.length || 0;
    const more = h('button', { type: 'button', class: 'vr-card-more', 'aria-label': `Options for ${x.name}`, onclick: (e) => { e.stopPropagation(); entryMenu(e.currentTarget, x); } }, icon('more', 14));
    const name = h('span', { class: 'vr-name', title: 'Double-click to rename' }, x.name);
    const hh = hue(x.name);
    const node = h('div', {
      class: 'vr-card', role: 'button', tabindex: 0, 'aria-label': `Open ${x.name}`, 'data-id': x.id,
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openEntry(x.id); if (e.key === 'F2') renameInline(name, x); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); entryMenu({ x: e.clientX, y: e.clientY }, x); },
    },
      h('span', { class: ['vr-face', !x.photo && 'is-initials'], style: x.photo ? null : { background: `hsl(${hh},32%,26%)`, color: `hsl(${hh},60%,78%)` } },
        x.photo ? (url ? h('img', { src: url, alt: '', draggable: false }) : null) : initials(x.name)),
      name,
      notes ? h('span', { class: 'vr-count', title: `${notes} note${notes === 1 ? '' : 's'}` }, String(notes)) : null,
      more);
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); clearTimeout(node._open); renameInline(name, x); });
    node.addEventListener('pointerdown', (e) => dragCard(e, node, x));
    return node;
  }

  function openEntry(id) { open = id; draft = ''; finding = false; query = ''; hit = 0; remember(); render(); }

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
      if (ok && t && t !== x.name) patchEntry(x.id, () => ({ name: t.slice(0, 48) }));
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
      section ? { label: `New sub-section in ${secById(section)?.name}`, icon: 'folder', onSelect: () => addSection(section) } : null,
      '-',
      { label: 'Import from Variables file…', icon: 'upload', onSelect: importFile },
    ].filter(Boolean));
  }

  async function addSection(parent) {
    const name = await promptDialog(parent ? `New sub-section in ${secById(parent)?.name}` : 'New section', { placeholder: parent ? 'e.g. Student, Cadet Officer' : 'e.g. Gym, Church, Clients', ok: 'Add', maxLength: 32 });
    if (!name?.trim()) return;
    const dup = sections().some((x) => (x.parent || null) === (parent || null) && x.name.toLowerCase() === name.trim().toLowerCase());
    if (dup) { toast('There’s already a section with that name.', { tone: 'error' }); return; }
    const s = parent ? { id: uid(), name: name.trim(), parent } : { id: uid(), name: name.trim() };
    if (parent) { section = parent; sub = s.id; } else { section = s.id; sub = null; }
    remember();
    save({ sections: [...sections(), s] });
  }

  async function renameSection(s) {
    const name = await promptDialog('Rename section', { value: s.name, maxLength: 32 });
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
      { label: 'Add variable here', icon: 'plus', onSelect: () => { if (s.parent) { section = s.parent; sub = s.id; } else { section = s.id; sub = null; } remember(); render(); addEntry(); } },
      !s.parent ? { label: 'Add sub-section', icon: 'folder', onSelect: () => addSection(s.id) } : null,
      { label: 'Rename', icon: 'edit', onSelect: () => renameSection(s) },
      { label: prev, icon: 'chevronLeft', disabled: i === 0, onSelect: () => swap(i - 1) },
      { label: next, icon: 'chevronRight', disabled: i === siblings.length - 1, onSelect: () => swap(i + 1) },
      '-',
      { label: 'Delete section', icon: 'trash', danger: true, disabled: !s.parent && tops().length < 2, onSelect: () => deleteSection(s) },
    ].filter(Boolean));
  }

  async function deleteSection(s) {
    const ids = new Set([s.id, ...kids(s.id).map((k) => k.id)]);
    const inside = entries().filter((x) => ids.has(x.section));
    const subs = ids.size - 1;
    if ((inside.length || subs) && !(await confirmDialog(`Delete ${s.name}?`, [subs ? `${subs} sub-section${subs === 1 ? '' : 's'}` : '', inside.length ? `${inside.length} entr${inside.length === 1 ? 'y' : 'ies'} and their notes` : ''].filter(Boolean).join(' and ') + ' go with it.'))) return;
    if (ids.has(sub)) sub = null;
    save({ sections: sections().filter((x) => !ids.has(x.id)), entries: entries().filter((x) => !ids.has(x.section)) });
  }

  // Every section as "School › Student" for pickers.
  const allSecs = () => tops().flatMap((t) => [t, ...kids(t.id)]);

  async function addEntry() {
    const name = h('input', { class: 'input', placeholder: 'A person, a group, a commitment', maxlength: 48, 'aria-label': 'Name' });
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
    const secSel = h('select', { class: 'input', 'aria-label': 'Section' }, allSecs().map((s) => h('option', { value: s.id, selected: s.id === here() }, s.parent ? `   ${pathOf(s.id)}` : s.name)));
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
    const s = secById(x.section);
    if (s?.parent) { section = s.parent; sub = s.id; } else { section = x.section; sub = null; }
    remember();
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
      { label: 'Rename', icon: 'edit', kbd: 'F2', onSelect: () => { const n = nameEl(); if (n) renameInline(n, x); else promptDialog('Rename', { value: x.name, maxLength: 48 }).then((v) => { if (v?.trim()) patchEntry(x.id, () => ({ name: v.trim() })); }); } },
      { label: x.photo ? 'Replace profile picture' : 'Add a profile picture', icon: 'image', onSelect: async () => { const [f] = await pickMedia({ multiple: false, accept: 'image/*' }); if (f) setPhoto(x.id, f); } },
      x.photo ? { label: 'Remove picture', icon: 'eyeOff', onSelect: () => patchEntry(x.id, () => ({ photo: null })) } : null,
      { label: 'Duplicate', icon: 'copy', onSelect: () => { const list = entries(); const i = list.findIndex((y) => y.id === x.id); const copy = { ...x, id: uid(), name: `${x.name} copy`, notes: [], at: Date.now() }; setEntries([...list.slice(0, i + 1), copy, ...list.slice(i + 1)]); } },
      others.length ? { header: 'Move to' } : null,
      ...others.map((s) => ({ label: pathOf(s.id), icon: 'folderMove', onSelect: () => patchEntry(x.id, () => ({ section: s.id })) })),
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => { if (await confirmDialog(`Delete ${x.name}?`, x.notes?.length ? 'Its notes go with it.' : 'This can’t be undone from here.')) setEntries(entries().filter((y) => y.id !== x.id)); } },
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

  function chat(x) {
    const ta = h('textarea', {
      class: 'vr-input sc-input', rows: 1, placeholder: 'Enter your message', maxlength: 4000, 'aria-label': 'Write a note', value: draft,
      oninput: (e) => { draft = e.target.value; grow(e.target); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(x.id, e.target); } },
      onfocus: () => { busy = true; },
      onblur: () => { busy = false; if (pending) setTimeout(render, 0); },
    });
    const fvOn = !!x.free?.on;
    if (fvOn) {
      free = mountFreeView({
        entry: () => entries().find((e) => e.id === x.id) || x,
        flowRows: (list) => msgRows(x, list),
        one: (m) => bubble(x, m),
        save: (f) => patchEntry(x.id, () => ({ free: f })),
      });
    }
    const toggle = h('button', {
      type: 'button', class: ['vr-fv-toggle', fvOn && 'is-on'], 'aria-pressed': String(fvOn),
      title: fvOn ? 'Back to the normal column' : 'Free view: drag messages anywhere, link them, draw',
      onclick: () => patchEntry(x.id, (e) => ({ free: { pos: {}, links: [], ink: [], ...(e.free || {}), on: !fvOn } })),
    }, h('i'), 'FREE VIEW');
    const head = h('div', { class: 'vr-chat-head' },
      h('button', { class: 'vr-back', type: 'button', 'aria-label': 'Back to variables', onclick: () => { open = null; finding = false; query = ''; remember(); render(); } }, icon('chevronLeft', 16)),
      x.photo ? h('span', { class: 'vr-mini-face' }, urlOf(x.photo, render) ? h('img', { src: urlOf(x.photo), alt: '' }) : null) : null,
      h('span', { class: 'vr-chat-name' }, x.name),
      h('span', { class: 'vr-chat-sec' }, pathOf(x.section)),
      free ? free.tools : null,
      h('button', { class: ['vr-find-toggle', finding && 'is-on'], type: 'button', 'aria-label': 'Search this chat', 'aria-pressed': String(finding), title: 'Search this chat', onclick: () => (finding ? closeFind() : openFind()) }, icon('search', 15)),
      toggle,
      h('button', { class: 'vr-card-more', type: 'button', 'aria-label': 'Options', onclick: (e) => entryMenu(e.currentTarget, x) }, icon('more', 14)));
    const wrap = h('div', { class: ['vr-chat is-sc', fvOn && 'is-free'] }, head,
      finding ? findBar() : null,
      free ? free.el : h('div', { class: 'vr-msgs sc-list', role: 'log' }, msgRows(x)),
      h('div', { class: 'vr-compose sc-compose' },
        h('button', { class: ['sc-plus', sending && 'is-busy'], type: 'button', 'aria-label': 'Add a photo', disabled: sending, onclick: async () => { const fs = await pickMedia({ accept: 'image/*,video/*' }); if (fs.length) sendFiles(x.id, fs); } },
          sending ? h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')) : icon('plus', 18)),
        ta));
    wrap.addEventListener('paste', (e) => { const fs = mediaFiles(e.clipboardData); if (fs.length) { e.preventDefault(); sendFiles(x.id, fs); } });
    wrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); wrap.classList.add('is-drop'); } });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('is-drop'); });
    wrap.addEventListener('drop', (e) => { wrap.classList.remove('is-drop'); const fs = mediaFiles(e.dataTransfer); if (fs.length) { e.preventDefault(); e.stopPropagation(); sendFiles(x.id, fs); } });
    requestAnimationFrame(() => grow(ta));
    return wrap;
  }

  function bubble(x, m, cont = false) {
    const mine = !m.by || m.by === me?.id;
    return bubbleRow({ id: m.id, text: m.text, files: m.files, at: m.ts, edited: m.edited }, {
      cont, theirs: !mine, who: m.name || '',
      onAsset: render,
      onMenu: (e) => msgMenu({ x: e.clientX, y: e.clientY }, x, m),
    });
  }

  function msgMenu(anchor, x, m) {
    menu(anchor, [
      m.text ? { label: 'Copy', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(m.text); toast('Copied.', { ms: 1400 }); } catch {} } } : null,
      m.text ? { label: 'Edit', icon: 'edit', onSelect: async () => { const t = await promptDialog('Edit note', { value: m.text, maxLength: 4000 }); if (t?.trim()) patchEntry(x.id, (e) => ({ notes: (e.notes || []).map((y) => (y.id === m.id ? { ...y, text: t.trim(), edited: true } : y)) })); } } : null,
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => patchEntry(x.id, (e) => ({ notes: (e.notes || []).filter((y) => y.id !== m.id) })) },
    ].filter(Boolean));
  }

  const note = (p) => ({ id: uid(), by: me?.id || null, name: me?.username || '', ts: Date.now(), text: '', files: [], ...p });
  const pushNote = (id, n) => patchEntry(id, (e) => ({ notes: [...(e.notes || []), n].slice(-MAX_NOTES) }));

  function send(id, ta) {
    const text = ta.value.trim();
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
  const off = onMyVars(() => render());
  loadMyVars().then(() => {
    // Your account has no Variables yet: your personal Space's list becomes yours automatically.
    // (The shared object's old list could be anyone's, so that one waits for "Bring in".)
    const empty = !acct().entries.length && !acct().sections;
    if (empty && w.host?.personal && !store.get(`${memKey}.legacy`, null) && ((el.entries || []).length || (el.sections || []).length)) {
      setMyVars({ sections: el.sections?.length ? el.sections : null, entries: el.entries || [] });
      store.set(`${memKey}.legacy`, 'done');
    }
    ready = true;
    render();
  }).catch(() => { ready = true; render(); });

  return {
    update(next) {
      const legacyChanged = next.entries !== el.entries;
      el = next;
      if (legacyChanged && ready && !open) render();
    },
    destroy() { off(); free?.destroy(); box.remove(); },
  };
}
