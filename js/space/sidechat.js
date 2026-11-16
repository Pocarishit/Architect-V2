// Side Chat — private chats that float at the edge of every page.
// A launcher sits on the screen edge (drag it anywhere along either side); it opens a
// panel you can move and resize. Each tab is one chat. Messages live on your Architect
// account by default (supabase/sidechat.sql, owner-only), or in Anytype when you
// connect it on this device (settings never leave this browser).
import { h, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, dialog, confirmDialog, promptDialog, closeFloating } from '../core/ui.js';
import { store, prefersReducedMotion, isMac } from '../core/util.js';
import { api, configured } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia } from './media.js';

export const DEFAULT_CHATS = ['Assimilation', 'Worldwright', 'Psyche', 'Allostasis', 'Behaviour'];
const GROUP_MS = 5 * 60_000;
const MAX_TEXT = 20000;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const k = (x) => x.toDateString();
  if (k(d) === k(now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (k(d) === k(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
const preview = (m) => (m.text ? m.text.replace(/\s+/g, ' ').slice(0, 140) : m.files?.length ? (m.files[0].kind === 'video' ? 'Video' : m.files[0].kind === 'photo' ? 'Photo' : 'Attachment') : 'Message');
const missingTable = (e) => ['42P01', 'PGRST205'].includes(e?.code) || /does not exist|Could not find the table/i.test(String(e?.message || ''));

/* ---------------- storage: your account (or this browser until the SQL is run) ---------------- */
function localDb(uidKey) {
  const KEY = `architect.sidechat.local.${uidKey}`;
  const all = () => store.get(KEY, { side_chats: [], side_messages: [] });
  const put = (d) => store.set(KEY, d);
  return {
    async select(t, { order, filters = {} } = {}) {
      let list = (all()[t] || []).filter((r) => Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)));
      if (order) { const [c, dir] = order.split('.'); const m = dir === 'desc' ? -1 : 1; list = list.sort((a, b) => (a[c] > b[c] ? m : a[c] < b[c] ? -m : 0)); }
      return list.map((r) => ({ ...r }));
    },
    async insert(t, input) {
      const d = all();
      const made = (Array.isArray(input) ? input : [input]).map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
      d[t] = [...(d[t] || []), ...made]; put(d);
      return Array.isArray(input) ? made : made[0];
    },
    async update(t, id, patch) { const d = all(); d[t] = (d[t] || []).map((r) => (r.id === id ? { ...r, ...patch } : r)); put(d); return true; },
    async remove(t, ids) { const s = new Set(ids); const d = all(); d[t] = (d[t] || []).filter((r) => !s.has(r.id)); put(d); },
    async removeWhere(t, f) { const d = all(); d[t] = (d[t] || []).filter((r) => !Object.entries(f).every(([k, v]) => String(r[k]) === String(v))); put(d); },
  };
}

function accountStore(me) {
  let db = api.db;
  let local = false;
  const fallback = localDb(me.id || 'anon');
  async function run(fn) {
    if (!local) {
      try { return await fn(db); } catch (e) { if (!configured || !missingTable(e)) throw e; local = true; db = fallback; }
    }
    return fn(db);
  }
  const fromRow = (r) => ({ id: r.id, text: r.body || '', files: Array.isArray(r.files) ? r.files : [], reply: r.reply_to || null, pinned: !!r.pinned, edited: !!r.edited, at: Date.parse(r.created_at) || Date.now() });
  const toRow = (chat, m) => ({ id: m.id, chat_id: chat.id, body: m.text || '', files: m.files || [], reply_to: m.reply || null, pinned: !!m.pinned, edited: !!m.edited, created_at: new Date(m.at).toISOString() });
  return {
    get local() { return local; },
    chats: () => run((d) => d.select('side_chats', { filters: me.id ? { user_id: me.id } : {}, order: 'position.asc' })),
    addChat: (row) => run((d) => d.insert('side_chats', row)),
    patchChat: (id, p) => run((d) => d.update('side_chats', id, p)),
    removeChat: (id) => run(async (d) => { await d.removeWhere('side_messages', { chat_id: id }); await d.remove('side_chats', [id]); }),
    // the messages half (Architect account)
    source: {
      kind: 'account', canReply: true, canUpload: true,
      async messages(chat) { return (await run((d) => d.select('side_messages', { filters: { chat_id: chat.id }, order: 'created_at.asc' }))).map(fromRow); },
      async send(chat, m) { return fromRow(await run((d) => d.insert('side_messages', toRow(chat, m)))); },
      edit: (chat, id, text) => run((d) => d.update('side_messages', id, { body: text, edited: true })),
      remove: (chat, ids) => run((d) => d.remove('side_messages', ids)),
      restore: (chat, msgs) => run((d) => d.insert('side_messages', msgs.map((m) => toRow(chat, m)))),
      pin: (chat, ids, v) => run((d) => Promise.all(ids.map((id) => d.update('side_messages', id, { pinned: v })))),
    },
  };
}

/* ---------------- Anytype (local API on this computer) ---------------- */
const ANY_KEY = (uidKey) => `architect.sidechat.anytype.${uidKey}`;
function anytypeSource(cfg, uidKey) {
  const base = String(cfg.base || '').replace(/\/+$/, '');
  const pinKey = (chat) => `architect.sidechat.anypins.${uidKey}.${chat.anytype_id}`;
  const pins = (chat) => new Set(store.get(pinKey(chat), []));
  async function call(path, { method = 'GET', body, form } = {}) {
    let r;
    try {
      r = await fetch(`${base}/v2/spaces/${encodeURIComponent(cfg.space)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.key}`, 'Anytype-Version': cfg.version || '2025-11-08', ...(form ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json' },
        body: form || (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout?.(15000),
      });
    } catch { throw new Error('Anytype isn’t answering. Open the Anytype app on this computer, then try again.'); }
    if (r.status === 401 || r.status === 403) throw new Error('Anytype refused the API key. Check it in Side Chat → Connect to Anytype.');
    if (!r.ok) throw new Error(`Anytype said ${r.status}.`);
    const raw = await r.text();
    return raw ? JSON.parse(raw) : {};
  }
  const chatPath = (chat) => {
    if (!chat.anytype_id) throw Object.assign(new Error('This chat isn’t linked to an Anytype chat yet.'), { code: 'unlinked' });
    return `/chats/${encodeURIComponent(chat.anytype_id)}/messages`;
  };
  const fromAny = (chat, m, pinned) => ({
    id: m.id,
    text: m.text ?? m.content?.text ?? m.message?.text ?? '',
    files: (m.attachments || []).length ? [{ kind: 'anytype', name: 'Attachment — open in Anytype' }] : [],
    reply: null, pinned: pinned.has(m.id), edited: !!(m.modified_at || m.edited), at: Date.parse(m.at || m.created_at || m.created_date) || Date.now(), order: m.order,
  });
  return {
    kind: 'anytype', canReply: false, canUpload: true,
    async messages(chat) {
      const path = chatPath(chat);
      const got = new Map();
      let before = '';
      for (let page = 0; page < 50; page++) {
        const r = await call(`${path}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        for (const m of r.messages || r.data || []) if (m?.id) got.set(m.id, m);
        if (!r.has_more || !r.next_before || r.next_before === before) break;
        before = r.next_before;
      }
      const p = pins(chat);
      return [...got.values()].map((m) => fromAny(chat, m, p)).sort((a, b) => a.at - b.at || String(a.order || '').localeCompare(String(b.order || '')));
    },
    async send(chat, m, { upload } = {}) {
      const body = { text: m.text || '' };
      if (upload) {
        const form = new FormData();
        form.append('file', upload, upload.name || 'file');
        const f = await call('/files', { method: 'POST', form });
        if (!f.id) throw new Error('Anytype didn’t accept the file.');
        body.attachments = [f.id];
      }
      const r = await call(chatPath(chat), { method: 'POST', body });
      const made = r.message || r.data?.message || (r.id ? r : null);
      return { ...m, id: made?.id || m.id, files: upload ? [{ kind: 'anytype', name: upload.name || 'Attachment' }] : [] };
    },
    edit: (chat, id, text) => call(`${chatPath(chat)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { text } }),
    async remove(chat, ids) { for (const id of ids) await call(`${chatPath(chat)}/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async restore(chat, msgs) { for (const m of msgs) if (m.text) await call(chatPath(chat), { method: 'POST', body: { text: m.text } }); },
    async pin(chat, ids, v) { const p = pins(chat); ids.forEach((id) => (v ? p.add(id) : p.delete(id))); store.set(pinKey(chat), [...p]); },
  };
}

/* a pixel smiley, drawn on the dot grid */
function smiley() {
  const dots = [[3, 2], [8, 2], [3, 3], [8, 3], [1, 7], [10, 7], [2, 8], [9, 8], [3, 9], [4, 9], [5, 9], [6, 9], [7, 9], [8, 9]];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('aria-hidden', 'true');
  for (const [x, y] of dots) { const r = document.createElementNS(ns, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1); r.setAttribute('fill', 'currentColor'); svg.append(r); }
  return svg;
}
const clockSvg = () => { const s = icon('clock', 11); s.classList.add('sc-clock'); return s; };

/** One chat message in the Side Chat style. Shared by Side Chat and Variables notes.
 *  m: { id, text, files, at, pinned, edited, status, error, reply }. theirs → left-hand grey bubble with a name. */
export function bubbleRow(m, { cont = false, theirs = false, who = '', onAsset, onQuote, onMenu, onDbl } = {}) {
  const files = (m.files || []).map((f) => {
    if (f.kind === 'anytype') return h('span', { class: 'sc-file is-any' }, icon('paperclip', 13), f.name || 'Attachment');
    const url = f.path ? urlOf(f.path, () => onAsset?.()) : null;
    return h('button', { type: 'button', class: ['sc-file', `is-${f.kind}`], 'aria-label': f.kind === 'video' ? 'Play video' : 'View photo', onclick: () => lightbox(f) },
      f.kind === 'photo' ? (url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'sc-file-ph' })) : h('span', { class: 'sc-file-vid' }, icon('play', 16), f.name || 'Video'));
  });
  const meta = h('span', { class: 'sc-meta', title: new Date(m.at).toLocaleString() },
    m.pinned ? icon('pin', 10) : null,
    m.edited ? h('span', {}, 'edited') : null,
    m.status === 'failed' ? h('span', { class: 'sc-fail', title: m.error || 'Not sent' }, '!') : m.status === 'sending' ? clockSvg() : null,
    h('time', {}, hhmm(m.at)));
  return h('div', {
    class: ['sc-msg', cont && 'is-cont', theirs && 'is-theirs', m.status && `is-${m.status}`, m.files?.length && !m.text && 'is-media'], 'data-id': m.id,
    style: { '--meta-w': `${40 + (m.pinned ? 14 : 0) + (m.edited ? 42 : 0) + (m.status ? 16 : 0)}px` },
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); onMenu?.(e); },
    ondblclick: (e) => onDbl?.(e),
  }, h('div', { class: 'sc-bubble' },
    theirs && who && !cont ? h('span', { class: 'sc-who' }, who) : null,
    m.reply ? h('button', { class: 'sc-quote', type: 'button', onclick: () => onQuote?.(m.reply.id) }, h('b', {}, m.reply.n > 1 ? `Reply to ${m.reply.n} messages` : 'Reply'), h('span', {}, m.reply.text)) : null,
    ...files,
    m.text ? h('span', { class: 'sc-text' }, m.text) : null,
    meta));
}
/** A day separator in the Side Chat style. */
export const dayRow = (t) => { const d = dayLabel(t); return h('div', { class: 'sc-day', 'data-day': d }, h('span', {}, d)); };
export { dayLabel as chatDayLabel, GROUP_MS as CHAT_GROUP_MS };

/* ============================================================ */
export function mountSideChat({ me }) {
  const uidKey = me?.id || 'anon';
  const K = { geo: 'architect.sidechat.geo', launch: 'architect.sidechat.launch', open: `architect.sidechat.open.${uidKey}`, active: `architect.sidechat.active.${uidKey}` };
  const acct = accountStore(me || {});
  // The Anytype connection lives on this device. It's kept under your account key and a device-wide
  // copy, so a refresh (or a session that loads before your account does) still finds it.
  const ANY_DEVICE = 'architect.sidechat.anytype';
  const anyCfg = () => store.get(ANY_KEY(uidKey), null) || store.get(ANY_DEVICE, null) || store.get(ANY_KEY('anon'), null);
  const saveAny = (c) => {
    store.set(ANY_KEY(uidKey), c);
    store.set(ANY_DEVICE, c);
    try { navigator.storage?.persist?.(); } catch {} // ask the phone not to clear it
  };
  { const c = anyCfg(); if (c && !store.get(ANY_KEY(uidKey), null)) saveAny(c); }
  let anySrc = null;
  const src = () => {
    const c = anyCfg();
    if (c?.on && c.key && c.space) { if (!anySrc || anySrc.cfg !== JSON.stringify(c)) anySrc = Object.assign(anytypeSource(c, uidKey), { cfg: JSON.stringify(c) }); return anySrc; }
    return acct.source;
  };

  let chats = [];
  let active = store.get(K.active, null);
  let open = false;
  let loaded = false;
  const cache = new Map();       // chat id → messages
  const errors = new Map();      // chat id → error text
  const pending = new Map();     // message id → { chatId, m, status, error, upload }
  const drafts = new Map();
  let picked = new Set();
  let anchorPick = null;
  let mode = null;               // { type: 'reply', ids } | { type: 'edit', id }
  const undo = [], redo = [];
  let poll = null;
  let lastSig = '';
  let pinCursor = 0;

  /* ---------- DOM ---------- */
  const launch = h('button', { class: 'sc-launch', type: 'button', 'aria-label': 'Open side chat', title: 'Side chat' }, smiley());
  const tabs = h('nav', { class: 'sc-tabs', role: 'tablist', 'aria-label': 'Chats' });
  const moreBtn = h('button', { class: 'sc-hbtn', type: 'button', 'aria-label': 'Side chat options', title: 'Options', onclick: (e) => optionsMenu(e.currentTarget) }, icon('more', 16));
  const minBtn = h('button', { class: 'sc-hbtn', type: 'button', 'aria-label': 'Collapse side chat', title: 'Collapse (Esc)', onclick: () => setOpen(false) }, icon('chevronDown', 16));
  const head = h('header', { class: 'sc-head' }, h('span', { class: 'sc-grip', 'aria-hidden': 'true' }), tabs, moreBtn, minBtn);
  const status = h('div', { class: 'sc-status', role: 'status', hidden: true });
  const pinbar = h('div', { class: 'sc-pinbar', hidden: true });
  const list = h('div', { class: 'sc-list', role: 'log', tabindex: -1, 'aria-label': 'Messages' });
  const chip = h('div', { class: 'sc-chip', 'aria-hidden': 'true' });
  const jump = h('button', { class: 'sc-jump', type: 'button', 'aria-label': 'Jump to latest', hidden: true, onclick: () => toBottom(true) }, icon('chevronDown', 16));
  const selCount = h('span', { class: 'sc-sel-n' });
  const selbar = h('div', { class: 'sc-selbar', hidden: true },
    h('button', { class: 'sc-sel-x', type: 'button', 'aria-label': 'Clear selection', onclick: () => setPicked(new Set()) }, icon('close', 14)), selCount,
    h('span', { class: 'sc-sel-acts' },
      h('button', { type: 'button', onclick: () => copyMsgs(chosen()) }, 'Copy'),
      h('button', { type: 'button', onclick: () => pinMsgs(chosen()) }, 'Pin'),
      h('button', { type: 'button', class: 'is-danger', onclick: () => deleteMsgs(chosen()) }, 'Delete')));
  const modeLabel = h('b', {});
  const modeText = h('span', { class: 'sc-mode-text' });
  const modebar = h('div', { class: 'sc-mode', hidden: true }, icon('chat', 13), h('span', { class: 'sc-mode-body' }, modeLabel, modeText),
    h('button', { class: 'sc-mode-x', type: 'button', 'aria-label': 'Cancel', onclick: () => clearMode() }, icon('close', 13)));
  const input = h('textarea', { class: 'sc-input', rows: 1, maxlength: MAX_TEXT, placeholder: 'Enter your message', 'aria-label': 'Message' });
  const plus = h('button', { class: 'sc-plus', type: 'button', 'aria-label': 'Add a photo or video', title: 'Add a photo or video', onclick: async () => { const fs = await pickMedia({}); if (fs.length) sendFiles(fs); } }, icon('plus', 18));
  const sendBtn = h('button', { class: 'sc-send', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', onclick: () => submit() }, icon('send', 15));
  const compose = h('div', { class: 'sc-compose' }, plus, input); // Enter sends — no send button
  const body = h('div', { class: 'sc-body' }, pinbar, list, chip, jump);
  const handles = ['w', 'e', 'sw', 'se'].map((d) => h('span', { class: `sc-rs sc-rs-${d}`, 'data-dir': d, 'aria-hidden': 'true' }));
  const panel = h('section', { class: 'sc-panel', role: 'dialog', 'aria-label': 'Side chat', 'data-noptr': '', hidden: true },
    head, status, body, selbar, h('div', { class: 'sc-foot' }, modebar, compose), ...handles);
  document.body.append(launch, panel);

  /* ---------- geometry ---------- */
  const sheet = () => innerWidth < 720;
  function placeLaunch() {
    const p = store.get(K.launch, { side: 'right', y: 0.5 });
    const y = Math.round(Math.max(70, Math.min(innerHeight - 56, p.y * innerHeight)));
    launch.style.top = `${y - 20}px`;
    launch.style.left = p.side === 'left' ? '10px' : '';
    launch.style.right = p.side === 'left' ? '' : '10px';
    launch.dataset.side = p.side;
  }
  function geo() {
    const g = store.get(K.geo, null);
    const w = Math.max(320, Math.min(innerWidth - 16, g?.w || 440));
    const hh = Math.max(300, Math.min(innerHeight - 16, g?.h || Math.min(600, innerHeight - 120)));
    const x = Number.isFinite(g?.x) ? g.x : innerWidth - w - 28;
    const y = Number.isFinite(g?.y) ? g.y : Math.max(64, innerHeight - hh - 28);
    return { w, h: hh, x: Math.max(8, Math.min(innerWidth - w - 8, x)), y: Math.max(8, Math.min(innerHeight - hh - 8, y)) };
  }
  function placePanel() {
    panel.classList.toggle('is-sheet', sheet());
    if (sheet()) { panel.style.cssText = ''; return; }
    const g = geo();
    Object.assign(panel.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
  }
  const saveGeo = () => { if (sheet()) return; const r = panel.getBoundingClientRect(); store.set(K.geo, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }); };
  const onResize = () => { placeLaunch(); if (open) placePanel(); };
  window.addEventListener('resize', onResize);
  placeLaunch();

  // drag the panel by its header
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sheet() || e.target.closest('button')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    panel.classList.add('is-moving');
    const move = (ev) => {
      panel.style.left = `${Math.max(8 - r.width + 120, Math.min(innerWidth - 120, ev.clientX - dx))}px`;
      panel.style.top = `${Math.max(8, Math.min(innerHeight - 44, ev.clientY - dy))}px`;
    };
    const up = () => { panel.classList.remove('is-moving'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveGeo(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // resize from the sides and bottom corners
  for (const hd of handles) hd.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sheet()) return;
    e.preventDefault(); e.stopPropagation();
    const d = hd.dataset.dir;
    const r = panel.getBoundingClientRect();
    panel.classList.add('is-moving');
    const move = (ev) => {
      let { left, top, width, height } = r;
      if (d.includes('e')) width = Math.max(320, Math.min(innerWidth - left - 8, ev.clientX - left));
      if (d.includes('w')) { const right = r.right; width = Math.max(320, Math.min(right - 8, right - ev.clientX)); left = right - width; }
      if (d.includes('s')) height = Math.max(300, Math.min(innerHeight - top - 8, ev.clientY - top));
      Object.assign(panel.style, { left: `${left}px`, width: `${width}px`, height: `${height}px` });
    };
    const up = () => { panel.classList.remove('is-moving'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveGeo(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // the launcher: click to open, drag to move it along either edge
  launch.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    launch.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      moved = true;
      launch.classList.add('is-drag');
      launch.style.left = `${Math.max(4, Math.min(innerWidth - 44, ev.clientX - 20))}px`;
      launch.style.right = '';
      launch.style.top = `${Math.max(60, Math.min(innerHeight - 50, ev.clientY - 20))}px`;
    };
    const up = (ev) => {
      launch.removeEventListener('pointermove', move); launch.removeEventListener('pointerup', up); launch.removeEventListener('pointercancel', up);
      launch.classList.remove('is-drag');
      if (moved) { store.set(K.launch, { side: ev.clientX < innerWidth / 2 ? 'left' : 'right', y: (ev.clientY) / innerHeight }); placeLaunch(); return; }
      setOpen(true);
    };
    launch.addEventListener('pointermove', move); launch.addEventListener('pointerup', up); launch.addEventListener('pointercancel', up);
  });

  /* ---------- open / close ---------- */
  function setOpen(v) {
    if (v === open) return;
    open = v;
    store.set(K.open, v);
    if (v) {
      placePanel();
      const lr = launch.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      panel.style.setProperty('--ox', `${lr.left + lr.width / 2 - pr.left}px`);
      panel.style.setProperty('--oy', `${lr.top + lr.height / 2 - pr.top}px`);
      panel.classList.remove('is-in');
      panel.hidden = false;
      launch.classList.add('is-away');
      // Start from the launcher on every screen: commit the closed state first, then animate open
      // (without this, desktop browsers merged both steps and the panel just appeared).
      void panel.offsetWidth;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (open) panel.classList.add('is-in'); }));
      start();
      if (!matchMedia('(hover: none)').matches) setTimeout(() => input.focus({ preventScroll: true }), 60);
    } else {
      closeFloating();
      panel.classList.remove('is-in');
      launch.classList.remove('is-away');
      stopPoll();
      setTimeout(() => { if (!open) panel.hidden = true; }, prefersReducedMotion() ? 0 : 190);
      if (panel.contains(document.activeElement)) launch.focus({ preventScroll: true });
    }
  }

  /* ---------- chats (tabs) ---------- */
  const chatById = (id) => chats.find((c) => c.id === id);
  const activeChat = () => chatById(active);
  async function ensureChats() {
    try {
      chats = await acct.chats();
      if (!chats.length) {
        const made = [];
        for (const [i, name] of DEFAULT_CHATS.entries()) made.push(await acct.addChat({ id: newId(), name, position: i }));
        chats = made;
      }
      loaded = true;
      if (!chatById(active)) active = chats[0]?.id || null;
      paintTabs();
      setStatus(acct.local && configured ? 'Saved on this device. Run supabase/sidechat.sql in Supabase to keep these chats on your account.' : '');
    } catch (e) {
      setStatus(e.message || 'Couldn’t load your chats.', true);
    }
  }
  function paintTabs() {
    const linked = src().kind === 'anytype';
    tabs.replaceChildren(...chats.map((c) => {
      const face = c.photo ? urlOf(c.photo, paintTabs) : null;
      return h('button', {
        class: ['sc-tab', c.id === active && 'is-on', linked && !c.anytype_id && 'is-unlinked'], type: 'button', role: 'tab', 'aria-selected': String(c.id === active), title: c.name,
        onclick: () => select(c.id),
        ondblclick: () => renameChat(c),
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); tabMenu({ x: e.clientX, y: e.clientY }, c); },
      }, c.photo ? h('span', { class: 'sc-face' }, face ? h('img', { src: face, alt: '' }) : null) : null, h('span', {}, c.name));
    }), h('button', { class: 'sc-tab sc-tab-add', type: 'button', 'aria-label': 'New chat', title: 'New chat', onclick: () => addChat() }, icon('plus', 13)));
    tabs.querySelector('.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function select(id) {
    if (id === active) return;
    drafts.set(active, input.value);
    active = id;
    store.set(K.active, id);
    input.value = drafts.get(id) || '';
    grow();
    clearMode(false);
    setPicked(new Set());
    pinCursor = 0;
    lastSig = '';
    paintTabs();
    paint(true);
    load(id);
    if (!matchMedia('(hover: none)').matches) input.focus({ preventScroll: true });
  }
  async function addChat() {
    const name = await promptDialog('New chat', { placeholder: 'Name', maxLength: 40, ok: 'Create' });
    if (!name) return;
    try {
      const c = await acct.addChat({ id: newId(), name, position: (chats.at(-1)?.position ?? -1) + 1 });
      chats.push(c);
      select(c.id);
    } catch (e) { toast(e.message, { tone: 'error' }); }
  }
  async function renameChat(c) {
    const name = await promptDialog('Rename chat', { value: c.name, maxLength: 40 });
    if (!name || name === c.name) return;
    c.name = name; paintTabs();
    acct.patchChat(c.id, { name }).catch((e) => toast(e.message, { tone: 'error' }));
  }
  async function setPhoto(c) {
    const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
    if (!f) return;
    try { const up = await uploadMedia(f); c.photo = up.path; paintTabs(); await acct.patchChat(c.id, { photo: up.path }); }
    catch (e) { toast(e.message, { tone: 'error' }); }
  }
  function moveChat(c, dir) {
    const i = chats.indexOf(c), j = i + dir;
    if (j < 0 || j >= chats.length) return;
    [chats[i], chats[j]] = [chats[j], chats[i]];
    chats.forEach((x, k) => { if (x.position !== k) { x.position = k; acct.patchChat(x.id, { position: k }).catch(() => {}); } });
    paintTabs();
  }
  async function deleteChat(c) {
    const n = cache.get(c.id)?.length;
    if (!(await confirmDialog(`Delete ${c.name}?`, src().kind === 'anytype' ? 'The tab goes away. The chat stays in Anytype.' : `${n ? `${n} message${n === 1 ? '' : 's'}` : 'Its messages'} go with it.`))) return;
    try {
      await acct.removeChat(c.id);
      chats = chats.filter((x) => x !== c);
      cache.delete(c.id);
      if (active === c.id) { active = null; select(chats[0]?.id || null); }
      paintTabs();
      if (!chats.length) paint(true);
    } catch (e) { toast(e.message, { tone: 'error' }); }
  }
  async function linkChat(c) {
    const v = await promptDialog(`Link ${c.name} to Anytype`, { value: c.anytype_id || '', label: 'Anytype chat ID', placeholder: 'bafyrei…', maxLength: 120, ok: 'Link' });
    if (v == null) return;
    c.anytype_id = v || null;
    acct.patchChat(c.id, { anytype_id: c.anytype_id }).catch(() => {});
    cache.delete(c.id); errors.delete(c.id); lastSig = '';
    paintTabs(); paint(true); load(c.id);
  }
  function tabMenu(at, c) {
    const i = chats.indexOf(c);
    menu(at, [
      { header: c.name },
      { label: 'Rename', icon: 'edit', onSelect: () => renameChat(c) },
      { label: c.photo ? 'Change picture' : 'Add picture', icon: 'image', onSelect: () => setPhoto(c) },
      c.photo ? { label: 'Remove picture', icon: 'close', onSelect: () => { c.photo = null; paintTabs(); acct.patchChat(c.id, { photo: null }).catch(() => {}); } } : null,
      src().kind === 'anytype' ? { label: c.anytype_id ? 'Change Anytype chat…' : 'Link to Anytype chat…', icon: 'link', onSelect: () => linkChat(c) } : null,
      '-',
      i > 0 ? { label: 'Move left', icon: 'chevronLeft', onSelect: () => moveChat(c, -1) } : null,
      i < chats.length - 1 ? { label: 'Move right', icon: 'chevronRight', onSelect: () => moveChat(c, 1) } : null,
      '-',
      { label: 'Delete chat', icon: 'trash', danger: true, onSelect: () => deleteChat(c) },
    ]);
  }
  function optionsMenu(anchor) {
    const any = src().kind === 'anytype';
    menu(anchor, [
      { header: 'Messages are kept in' },
      { label: 'Your Architect account', checked: !any, onSelect: () => useAnytype(false) },
      { label: any ? 'Anytype' : 'Anytype…', checked: any, onSelect: () => (anyCfg()?.key ? useAnytype(true) : connectAnytype()) },
      any || anyCfg()?.key ? { label: 'Anytype settings…', icon: 'settings', onSelect: connectAnytype } : null,
      '-',
      { label: 'New chat', icon: 'plus', onSelect: addChat },
      activeChat() ? { label: `Export ${activeChat().name}`, icon: 'download', onSelect: exportChat } : null,
      '-',
      { label: 'Reset position', icon: 'fit', onSelect: () => { store.set(K.geo, null); placePanel(); } },
    ], { align: 'end' });
  }

  /* ---------- Anytype connection ---------- */
  function useAnytype(on) {
    const c = anyCfg() || {};
    saveAny({ ...c, on });
    anySrc = null;
    cache.clear(); errors.clear(); pending.clear(); lastSig = '';
    undo.length = 0; redo.length = 0;
    clearMode(false); setPicked(new Set());
    paintTabs(); paint(true); load(active);
    toast(on ? 'Side Chat now reads and writes your Anytype chats.' : 'Side Chat is back on your Architect account.', { ms: 2600 });
  }
  async function connectAnytype() {
    const c = anyCfg() || {};
    const field = (label, inp, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), inp, hint ? h('span', { class: 'sc-hint' }, hint) : null);
    const baseI = h('input', { class: 'input', value: c.base || 'http://127.0.0.1:31009', spellcheck: false });
    const keyI = h('input', { class: 'input', type: 'password', value: c.key || '', placeholder: 'From Anytype → Settings → API Keys', autocomplete: 'off' });
    const spaceI = h('input', { class: 'input', value: c.space || '', placeholder: 'bafyrei…', spellcheck: false });
    const verI = h('input', { class: 'input', value: c.version || '2025-11-08', spellcheck: false });
    const links = chats.map((x) => [x, h('input', { class: 'input', value: x.anytype_id || '', placeholder: 'Chat ID', spellcheck: false })]);
    const err = h('p', { class: 'login-error', hidden: true });
    const ok = await dialog({
      title: 'Connect to Anytype',
      width: 480,
      body: h('div', { class: 'stack sc-anyform' },
        h('p', { class: 'sc-hint' }, 'Anytype has to be open on this computer. The key stays in this browser only.'),
        field('API address', baseI), field('API key', keyI), field('Space ID', spaceI),
        h('details', { class: 'sc-adv' }, h('summary', {}, 'API version'), verI),
        h('div', { class: 'sc-anylinks' }, h('span', { class: 'field-label' }, 'Chats'), ...links.map(([x, inp]) => h('label', { class: 'sc-anylink' }, h('span', {}, x.name), inp))),
        err),
      actions: [{ label: 'Cancel', value: null }, {
        label: 'Connect', primary: true, value: () => {
          if (!keyI.value.trim() || !spaceI.value.trim()) { err.hidden = false; err.textContent = 'Add the API key and the space ID.'; return undefined; }
          return true;
        },
      }],
    });
    if (!ok) return;
    saveAny({ on: true, base: baseI.value.trim() || 'http://127.0.0.1:31009', key: keyI.value.trim(), space: spaceI.value.trim(), version: verI.value.trim() || '2025-11-08' });
    for (const [x, inp] of links) {
      const v = inp.value.trim() || null;
      if (v !== (x.anytype_id || null)) { x.anytype_id = v; acct.patchChat(x.id, { anytype_id: v }).catch(() => {}); }
    }
    useAnytype(true);
  }

  /* ---------- loading + polling ---------- */
  async function start() {
    if (!loaded) await ensureChats();
    paint(true);
    load(active);
    stopPoll();
    poll = setInterval(() => { if (!document.hidden && !dragSel) load(active, true); }, src().kind === 'anytype' ? 4000 : 7000);
  }
  const stopPoll = () => { clearInterval(poll); poll = null; };
  const onFocus = () => { if (open) load(active, true); };
  window.addEventListener('focus', onFocus);
  async function load(id = active, quiet = false) {
    const chat = chatById(id);
    if (!chat) return;
    try {
      const msgs = await src().messages(chat);
      cache.set(id, msgs);
      errors.delete(id);
    } catch (e) {
      if (!quiet || !cache.has(id)) errors.set(id, e);
    }
    if (id === active) paint();
  }
  function setStatus(text, bad = false) { status.hidden = !text; status.textContent = text || ''; status.classList.toggle('is-bad', bad); }

  /* ---------- painting ---------- */
  const msgsOf = (id) => [...(cache.get(id) || []), ...[...pending.values()].filter((p) => p.chatId === id).map((p) => ({ ...p.m, status: p.status, error: p.error }))];
  const current = () => msgsOf(active);
  const find = (id) => current().find((m) => m.id === id);
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  function toBottom(smooth = false) { list.scrollTo({ top: list.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' }); }

  function paint(stick = false) {
    const chat = activeChat();
    const msgs = current();
    const err = errors.get(active);
    const sig = JSON.stringify([active, cache.has(active), loaded, err?.message, msgs.map((m) => [m.id, m.text, m.pinned, m.edited, m.status, m.files?.length])]);
    if (sig === lastSig && !stick) return;
    lastSig = sig;
    const wasBottom = atBottom();
    const anchor = wasBottom ? null : [...list.querySelectorAll('.sc-msg')].find((n) => n.offsetTop + n.offsetHeight > list.scrollTop);
    const anchorTop = anchor ? anchor.offsetTop - list.scrollTop : 0;
    const rows = [];
    let lastDay = '', prev = null;
    for (const m of msgs) {
      const d = dayLabel(m.at);
      if (d !== lastDay) { rows.push(h('div', { class: 'sc-day', 'data-day': d }, h('span', {}, d))); lastDay = d; prev = null; }
      rows.push(row(m, prev && m.at - prev.at < GROUP_MS));
      prev = m;
    }
    if (!rows.length) rows.push(empty(chat, err));
    else if (err && !msgs.length) rows.push(empty(chat, err));
    list.replaceChildren(...rows);
    paintPins();
    paintPicked();
    if (stick || wasBottom) toBottom();
    else if (anchor) { const n = list.querySelector(`.sc-msg[data-id="${CSS.escape(anchor.dataset.id)}"]`); if (n) list.scrollTop = n.offsetTop - anchorTop; }
    jump.hidden = atBottom();
    if (err && msgs.length) setStatus(err.message, true);
    else if (!err && status.classList.contains('is-bad')) setStatus('');
    plus.hidden = !src().canUpload;
    input.disabled = !chat;
  }
  function empty(chat, err) {
    if (!chat) return h('p', { class: 'sc-empty' }, loaded ? 'No chats yet.' : 'Loading…');
    if (err?.code === 'unlinked') return h('div', { class: 'sc-empty' }, h('p', {}, `${chat.name} isn’t linked to an Anytype chat yet.`), h('button', { class: 'btn sm', type: 'button', onclick: () => linkChat(chat) }, 'Link chat'));
    if (err) return h('div', { class: 'sc-empty' }, h('p', {}, err.message || 'Couldn’t load messages.'), h('button', { class: 'btn sm', type: 'button', onclick: () => load(active) }, 'Try again'));
    if (!cache.has(active)) return h('p', { class: 'sc-empty' }, h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')));
    return h('p', { class: 'sc-empty' }, `Nothing in ${chat.name} yet. Write the first line.`);
  }
  function row(m, cont) {
    return bubbleRow(m, {
      cont,
      onAsset: () => { lastSig = ''; paint(); },
      onQuote: (id) => reveal(id),
      onMenu: (e) => msgMenu(e, m),
      onDbl: (e) => { if (!e.target.closest('.sc-text') && src().canReply && !m.status) beginReply([m]); },
    });
  }
  function reveal(id) {
    const n = list.querySelector(`.sc-msg[data-id="${CSS.escape(id)}"]`);
    if (!n) { toast('That message is gone.', { ms: 1600 }); return; }
    n.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    n.classList.remove('is-flash'); void n.offsetWidth; n.classList.add('is-flash');
  }
  function paintPins() {
    const pins = current().filter((m) => m.pinned);
    pinbar.hidden = !pins.length;
    if (!pins.length) return;
    pinCursor = Math.min(pinCursor, pins.length - 1);
    const p = pins[pins.length - 1 - pinCursor];
    pinbar.replaceChildren(
      h('button', { class: 'sc-pin-go', type: 'button', title: 'Go to pinned message', onclick: () => { reveal(p.id); pinCursor = (pinCursor + 1) % pins.length; paintPins(); } },
        h('span', { class: 'sc-pin-ticks', 'aria-hidden': 'true' }, ...pins.slice(-4).map((_, i, a) => h('i', { class: i === a.length - 1 - Math.min(pinCursor, a.length - 1) ? 'is-on' : '' }))),
        h('span', { class: 'sc-pin-body' }, h('b', {}, pins.length > 1 ? `Pinned ${pins.length - pinCursor}/${pins.length}` : 'Pinned'), h('span', {}, preview(p)))),
      h('button', { class: 'sc-pin-x', type: 'button', 'aria-label': 'Unpin', title: 'Unpin', onclick: () => pinMsgs([p], false) }, icon('close', 13)));
  }

  /* ---------- floating date + jump button ---------- */
  let chipTimer = null;
  list.addEventListener('scroll', () => {
    jump.hidden = atBottom();
    const top = list.scrollTop;
    let day = null;
    for (const n of list.querySelectorAll('.sc-day')) { if (n.offsetTop - 4 <= top) day = n.dataset.day; else break; }
    const first = list.querySelector('.sc-day');
    if (!day || !first || first.offsetTop + first.offsetHeight > top) { chip.classList.remove('is-on'); return; }
    chip.textContent = day;
    chip.classList.add('is-on');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('is-on'), 1100);
  }, { passive: true });

  /* ---------- selection ---------- */
  function setPicked(next) { picked = next; paintPicked(); }
  function paintPicked() {
    for (const n of list.querySelectorAll('.sc-msg')) n.classList.toggle('is-picked', picked.has(n.dataset.id));
    selbar.hidden = !picked.size;
    selCount.textContent = `${picked.size} selected`;
    const all = chosen();
    const pinBtn = selbar.querySelector('.sc-sel-acts button:nth-child(2)');
    if (pinBtn) pinBtn.textContent = all.length && all.every((m) => m.pinned) ? 'Unpin' : 'Pin';
  }
  const chosen = () => current().filter((m) => picked.has(m.id));
  let dragSel = null;
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, .sc-text, .sc-file')) {
      const n = e.target.closest('.sc-msg');
      if (e.button === 0 && n && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); pickWith(n.dataset.id, e); }
      return;
    }
    const n = e.target.closest('.sc-msg');
    if (n && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); pickWith(n.dataset.id, e); return; }
    list.focus({ preventScroll: true });
    dragSel = { x: e.clientY, y0: e.clientY + list.scrollTop, id: e.pointerId, moved: false, box: null, base: e.shiftKey ? new Set(picked) : new Set(), start: n?.dataset.id };
  });
  function pickWith(id, e) {
    list.focus({ preventScroll: true });
    if (e.shiftKey && anchorPick) {
      const ids = current().map((m) => m.id);
      const a = ids.indexOf(anchorPick), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setPicked(new Set([...picked, ...ids.slice(lo, hi + 1)])); return; }
    }
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    anchorPick = id;
    setPicked(next);
  }
  const onMove = (e) => {
    if (!dragSel || e.pointerId !== dragSel.id) return;
    if (!dragSel.moved && Math.abs(e.clientY - dragSel.x) < 6) return;
    if (!dragSel.moved) { dragSel.moved = true; dragSel.box = h('div', { class: 'sc-marquee' }); body.append(dragSel.box); panel.classList.add('is-selecting'); }
    const br = body.getBoundingClientRect(), lr = list.getBoundingClientRect();
    const yNow = e.clientY + list.scrollTop;
    const top = Math.min(dragSel.y0, yNow), bot = Math.max(dragSel.y0, yNow);
    const vt = Math.max(lr.top, top - list.scrollTop), vb = Math.min(lr.bottom, bot - list.scrollTop);
    Object.assign(dragSel.box.style, { top: `${vt - br.top}px`, height: `${Math.max(0, vb - vt)}px` });
    const next = new Set(dragSel.base);
    for (const n of list.querySelectorAll('.sc-msg')) {
      const r = n.getBoundingClientRect();
      const t = r.top + list.scrollTop, b = r.bottom + list.scrollTop;
      if (b > top && t < bot) next.add(n.dataset.id);
    }
    setPicked(next);
    if (e.clientY < lr.top + 24) list.scrollTop -= 12; else if (e.clientY > lr.bottom - 24) list.scrollTop += 12;
  };
  const onUp = (e) => {
    if (!dragSel || e.pointerId !== dragSel.id) return;
    if (!dragSel.moved) { if (picked.size) setPicked(new Set()); if (dragSel.start) anchorPick = dragSel.start; }
    dragSel.box?.remove();
    panel.classList.remove('is-selecting');
    dragSel = null;
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  /* ---------- message actions ---------- */
  function msgMenu(e, m) {
    const temp = !picked.has(m.id);
    if (temp) setPicked(new Set([m.id]));
    const sel = chosen();
    const many = sel.length > 1;
    const failed = sel.filter((x) => x.status === 'failed');
    const real = sel.filter((x) => !x.status);
    const allPinned = real.length && real.every((x) => x.pinned);
    const at = { x: e.clientX, y: e.clientY };
    const n = many ? ` ${sel.length}` : '';
    const items = failed.length ? [
      { label: failed.length > 1 ? `Retry ${failed.length}` : 'Retry', icon: 'redo', onSelect: () => failed.forEach((x) => retry(x.id)) },
      { label: 'Discard', icon: 'trash', danger: true, onSelect: () => { failed.forEach((x) => pending.delete(x.id)); setPicked(new Set()); lastSig = ''; paint(); } },
    ] : [
      src().canReply && real.length ? { label: many ? `Reply to${n}` : 'Reply', icon: 'chat', onSelect: () => beginReply(real) } : null,
      !many && m.text && !m.status ? { label: 'Edit', icon: 'edit', onSelect: () => beginEdit(m) } : null,
      { label: many ? `Copy${n}` : 'Copy', icon: 'copy', onSelect: () => copyMsgs(sel) },
      real.length ? { label: allPinned ? (many ? `Unpin${n}` : 'Unpin') : (many ? `Pin${n}` : 'Pin'), icon: allPinned ? 'pinOff' : 'pin', onSelect: () => pinMsgs(real, !allPinned) } : null,
      !many ? { label: 'Select', icon: 'check', onSelect: () => { setPicked(new Set([m.id])); anchorPick = m.id; list.focus({ preventScroll: true }); } } : null,
      '-',
      real.length ? { label: many ? `Delete${n}` : 'Delete', icon: 'trash', danger: true, onSelect: () => deleteMsgs(real) } : null,
    ];
    menu(at, items.filter(Boolean), { onClose: () => { if (temp && picked.size === 1 && picked.has(m.id)) setPicked(new Set()); } });
  }
  async function copyMsgs(sel, quiet = false) {
    const text = sel.map((m) => m.text || preview(m)).join('\n\n');
    try { await navigator.clipboard.writeText(text); if (!quiet) toast(sel.length > 1 ? `Copied ${sel.length} messages.` : 'Copied.', { ms: 1400 }); }
    catch { toast('Couldn’t reach the clipboard.', { tone: 'error' }); }
  }
  async function deleteMsgs(sel, { record = true } = {}) {
    const chat = activeChat();
    sel = sel.filter((m) => !m.status);
    if (!chat || !sel.length) return;
    const ids = new Set(sel.map((m) => m.id));
    const before = cache.get(chat.id) || [];
    cache.set(chat.id, before.filter((m) => !ids.has(m.id)));
    setPicked(new Set()); paint();
    try {
      await src().remove(chat, [...ids]);
      if (record) { undo.push({ type: 'delete', chatId: chat.id, msgs: sel }); redo.length = 0; }
      toast(sel.length > 1 ? `Deleted ${sel.length} messages.` : 'Message deleted.', { ms: 4000, action: { label: 'Undo', onClick: () => history(true) } });
    } catch (e) {
      cache.set(chat.id, before); lastSig = ''; paint();
      toast(e.message, { tone: 'error' });
    }
  }
  async function pinMsgs(sel, value, { record = true } = {}) {
    const chat = activeChat();
    sel = sel.filter((m) => !m.status);
    if (!chat || !sel.length) return;
    const v = value ?? !sel.every((m) => m.pinned);
    const ids = sel.map((m) => m.id);
    const prevState = new Map(sel.map((m) => [m.id, m.pinned]));
    cache.set(chat.id, (cache.get(chat.id) || []).map((m) => (prevState.has(m.id) ? { ...m, pinned: v } : m)));
    pinCursor = 0; setPicked(new Set()); paint();
    try {
      await src().pin(chat, ids, v);
      if (record) { undo.push({ type: 'pin', chatId: chat.id, ids, value: v }); redo.length = 0; }
    } catch (e) { toast(e.message, { tone: 'error' }); load(chat.id); }
  }
  async function editMsg(m, text, { record = true } = {}) {
    const chat = activeChat();
    if (!chat) return;
    const old = m.text;
    cache.set(chat.id, (cache.get(chat.id) || []).map((x) => (x.id === m.id ? { ...x, text, edited: true } : x)));
    paint();
    try {
      await src().edit(chat, m.id, text);
      if (record) { undo.push({ type: 'edit', chatId: chat.id, id: m.id, before: old, after: text }); redo.length = 0; }
    } catch (e) { toast(e.message, { tone: 'error' }); load(chat.id); }
  }
  async function history(back) {
    const from = back ? undo : redo, to = back ? redo : undo;
    const op = from.at(-1);
    if (!op) { toast(back ? 'Nothing to undo.' : 'Nothing to redo.', { ms: 1200 }); return; }
    if (op.chatId !== active) { const c = chatById(op.chatId); toast(`Switch to ${c?.name || 'that chat'} to ${back ? 'undo' : 'redo'} that.`, { ms: 2200 }); return; }
    from.pop();
    const chat = activeChat();
    try {
      if (op.type === 'delete') {
        if (back) { await src().restore(chat, op.msgs); await load(chat.id); }
        else { await src().remove(chat, op.msgs.map((m) => m.id)); cache.set(chat.id, (cache.get(chat.id) || []).filter((m) => !op.msgs.some((x) => x.id === m.id))); paint(); }
      } else if (op.type === 'edit') {
        const t = back ? op.before : op.after;
        await src().edit(chat, op.id, t);
        cache.set(chat.id, (cache.get(chat.id) || []).map((x) => (x.id === op.id ? { ...x, text: t } : x))); paint();
      } else if (op.type === 'pin') {
        const v = back ? !op.value : op.value;
        await src().pin(chat, op.ids, v);
        cache.set(chat.id, (cache.get(chat.id) || []).map((x) => (op.ids.includes(x.id) ? { ...x, pinned: v } : x))); paint();
      }
      to.push(op);
    } catch (e) { from.push(op); toast(e.message, { tone: 'error' }); }
  }

  /* ---------- composer ---------- */
  function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; sendBtn.classList.toggle('is-ready', !!input.value.trim()); }
  input.addEventListener('input', grow);
  function beginReply(sel) {
    mode = { type: 'reply', ids: sel.map((m) => m.id) };
    modeLabel.textContent = sel.length > 1 ? `Replying to ${sel.length} messages` : 'Replying';
    modeText.textContent = sel.map(preview).join(' / ');
    modebar.hidden = false; panel.classList.add('is-mode');
    setPicked(new Set());
    input.focus();
  }
  function beginEdit(m) {
    if (mode?.type !== 'edit') drafts.set(`edit:${active}`, input.value);
    mode = { type: 'edit', id: m.id };
    modeLabel.textContent = 'Editing';
    modeText.textContent = preview(m);
    modebar.hidden = false; panel.classList.add('is-mode');
    input.value = m.text; grow();
    setPicked(new Set());
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function clearMode(restore = true) {
    if (mode?.type === 'edit') { input.value = restore ? (drafts.get(`edit:${active}`) || '') : ''; grow(); }
    mode = null; modebar.hidden = true; panel.classList.remove('is-mode');
  }
  function submit() {
    const text = input.value.trim();
    if (mode?.type === 'edit') {
      const m = find(mode.id);
      if (text && m && text !== m.text) editMsg(m, text.slice(0, MAX_TEXT));
      clearMode(); return;
    }
    if (!text || !activeChat()) return;
    let reply = null;
    if (mode?.type === 'reply') {
      const sel = mode.ids.map(find).filter(Boolean);
      if (sel.length) reply = { id: sel[0].id, n: sel.length, text: sel.map(preview).join(' / ').slice(0, 200) };
    }
    clearMode();
    input.value = ''; drafts.delete(active); grow();
    send({ text: text.slice(0, MAX_TEXT), reply });
  }
  async function send({ text = '', files = [], reply = null, upload = null }, again = null) {
    const chat = activeChat();
    if (!chat) return;
    const m = again?.m || { id: newId(), text, files, reply, pinned: false, edited: false, at: Date.now() };
    const p = again || { chatId: chat.id, m, upload };
    p.status = 'sending'; p.error = null;
    pending.set(m.id, p);
    lastSig = ''; paint(true);
    try {
      const saved = await src().send(chat, m, { upload: p.upload });
      pending.delete(m.id);
      const list0 = cache.get(chat.id) || [];
      if (!list0.some((x) => x.id === saved.id)) cache.set(chat.id, [...list0, saved]);
    } catch (e) {
      p.status = 'failed'; p.error = e.message || 'Not sent';
      toast(`Not sent: ${p.error}`, { tone: 'error', ms: 4000 });
    }
    if (active === chat.id) { lastSig = ''; paint(); }
  }
  function retry(id) { const p = pending.get(id); if (p) send({}, p); }
  async function sendFiles(fs) {
    if (!activeChat()) return;
    for (const f of fs) {
      if (src().kind === 'anytype') {
        if (f.size > 20 * 1048576) { toast(`${f.name} is over 20 MB.`, { tone: 'error' }); continue; }
        send({ text: '', files: [{ kind: 'anytype', name: f.name }], upload: f });
        continue;
      }
      const t = toast(`Uploading ${f.name || 'file'}…`, { ms: 0 });
      try { const up = await uploadMedia(f); send({ files: [{ kind: up.kind, path: up.path, name: up.name, dur: up.dur }] }); }
      catch (e) { toast(e.message, { tone: 'error' }); }
      finally { t.close(); }
    }
  }
  function exportChat() {
    const chat = activeChat();
    const msgs = cache.get(chat.id) || [];
    const text = msgs.map((m) => `[${new Date(m.at).toLocaleString()}] ${m.text || preview(m)}`).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `${chat.name.toLowerCase().replace(/[^\w]+/g, '-')}.txt` });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- keyboard, paste, drop — handled before the canvas sees them ---------- */
  const inPanel = (t) => t instanceof Node && panel.contains(t);
  const onKey = (e) => {
    if (!open || !inPanel(e.target) || document.querySelector('.menu, .popover, .dlg-overlay')) return;
    e.stopImmediatePropagation();
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.target === input) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); if (mode) clearMode(); else if (picked.size) setPicked(new Set()); else if (!input.value.trim()) setOpen(false); else input.blur(); return; }
      if (e.key === 'ArrowUp' && !input.value && !mode) { const last = [...current()].reverse().find((m) => m.text && !m.status); if (last) { e.preventDefault(); beginEdit(last); } }
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (mod && k === 'a') { e.preventDefault(); setPicked(new Set(current().filter((m) => !m.status).map((m) => m.id))); return; }
    if (mod && k === 'c' && picked.size) { if (String(getSelection() || '').trim()) return; e.preventDefault(); copyMsgs(chosen()); return; }
    if (mod && k === 'x' && picked.size) { e.preventDefault(); const s = chosen(); copyMsgs(s, true).then(() => deleteMsgs(s)); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); history(false); return; }
    if (mod && k === 'z') { e.preventDefault(); history(true); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && picked.size) { e.preventDefault(); deleteMsgs(chosen()); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (picked.size) setPicked(new Set()); else if (mode) clearMode(); else setOpen(false); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !input.disabled) input.focus({ preventScroll: true });
  };
  const onPaste = (e) => {
    if (!open || !inPanel(e.target)) return;
    e.stopImmediatePropagation();
    const fs = mediaFiles(e.clipboardData);
    if (fs.length) { e.preventDefault(); sendFiles(fs); }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('paste', onPaste, true);
  panel.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); panel.classList.add('is-drop'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-drop'); });
  panel.addEventListener('drop', (e) => { panel.classList.remove('is-drop'); const fs = mediaFiles(e.dataTransfer); e.preventDefault(); e.stopPropagation(); if (fs.length) sendFiles(fs); });

  // Warm up quietly so the first open is instant; come back open if it was open.
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => { ensureChats().then(() => { if (store.get(K.open, false)) setOpen(true); else if (active) load(active, true); }); }, { timeout: 4000 });

  return {
    open: () => setOpen(true),
    toggle: () => setOpen(!open),
    destroy() {
      stopPoll();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      launch.remove(); panel.remove();
    },
  };
}
