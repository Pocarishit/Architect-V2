// Your Variables — one copy per account, the same in your personal and shared Space.
// Lives in `architect_variables` (one row per user, owner-only: nobody else can read it).
// Every Variables object you open shows *your* sections and entries; in the shared Space each
// person sees their own. Changes reach the other Space instantly (same tab) and your other devices
// within seconds (polled while the tab is visible).
// If the table hasn't been created yet it still works, kept in this browser only.
// Nov 18: the same row also carries your personal Fleeting Ideas (`ideas`), so an idea you drop in one
// Space is the same idea in the other. Subscribers get the keys that changed, so Variables doesn't
// repaint every time an idea glides.
import { api, configured } from './api.js';
import { store } from '../core/util.js';

const TABLE = 'architect_variables';
const POLL_MS = 15_000;
const SAVE_MS = 450;

let uidKey = null;     // whose data is loaded
let data = null;       // { sections, entries, rev }
let row = null;        // remote row { id, ... }
let remote = true;
let loading = null;
let timer = 0, poller = 0, dirty = false, saving = Promise.resolve();
// Nov 27 — 'loading' | 'ok' | 'error' (couldn't reach your account yet: retrying) | 'local' (no table).
// While it isn't 'ok', nothing is saved, so a failed load on one device can never overwrite (or duplicate)
// what your account already has.
let status = 'loading', retryT = 0, retryN = 0;
export const myVarsStatus = () => status;
const subs = new Set();

const me = () => api.auth.current()?.user || null;
const localKey = () => `architect.myvars.${uidKey || 'anon'}`;
const missing = (e) => /relation .* does not exist|Could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || e || ''}`);
const emit = (keys = null) => { for (const fn of subs) { try { fn(data, keys); } catch {} } };

function reset() {
  past.length = 0; future.length = 0;
  clearTimeout(timer); clearInterval(poller);
  data = null; row = null; remote = true; loading = null; dirty = false; poller = 0;
  status = 'loading'; clearTimeout(retryT); retryN = 0;
}

// The newest row wins if an account ever ended up with more than one.
const pickRow = (rows) => (rows || []).slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
function scheduleRetry() {
  clearTimeout(retryT);
  const wait = [1500, 4000, 10_000, 20_000][Math.min(retryN++, 3)];
  retryT = setTimeout(async () => {
    if (!uidKey) return;
    try {
      const rows = await api.db.select(TABLE, { filters: { user_id: uidKey } });
      row = pickRow(rows);
      status = 'ok'; retryN = 0;
      // Reached your account: its data wins, unless you changed something meanwhile — then yours is saved.
      if (dirty) { clearTimeout(timer); timer = setTimeout(flush, 50); }
      else if (row?.data) {
        const r = normal(row.data);
        const l = data ? normal(data) : null;
        // Nov 27: keep a newer local copy (rev is Date.now()) instead of overwriting it with the stale row.
        if (!(l && (l.rev || 0) > (r.rev || 0))) { data = r; store.set(localKey(), r); }
      }
      emit();
    } catch { scheduleRetry(); emit(); }
  }, wait);
}

/** Load (once per account). Resolves to { data, fresh } — fresh: this account has never saved Variables. */
export function loadMyVars() {
  const id = me()?.id || null;
  if (uidKey !== id) { reset(); uidKey = id; }
  if (data) return Promise.resolve({ data, fresh: false });
  loading ||= (async () => {
    const local = store.get(localKey(), null);
    let fresh = false;
    try {
      const rows = await api.db.select(TABLE, id ? { filters: { user_id: id } } : {});
      row = pickRow(rows);
      const remoteData = row?.data ? normal(row.data) : null;
      const localData = local ? normal(local) : null;
      // Nov 27: rev is a Date.now() stamp. If this device kept working while the account was
      // unreachable, its copy is the newer one — keep it and push it up rather than lose the edits.
      if (remoteData && localData && (localData.rev || 0) > (remoteData.rev || 0)) {
        data = localData;
        dirty = true;
        timer = setTimeout(flush, 50);
      } else {
        data = remoteData || localData || null;
        if (!data) fresh = true;
      }
      status = 'ok';
    } catch (e) {
      if (!configured || missing(e)) { remote = false; status = 'local'; }
      else { status = 'error'; console.warn('Variables: your account couldn’t be reached yet — retrying', e); scheduleRetry(); }
      if (local) data = normal(local); else fresh = status === 'local';
    }
    data ||= { sections: null, entries: [], ideas: null, vfree: false, gone: [], rev: 0 };
    if (remote && !poller) {
      poller = setInterval(pull, POLL_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
      window.addEventListener('pagehide', flushNow);
    }
    loading = null;
    return { data, fresh };
  })();
  return loading;
}

const normal = (d) => ({
  sections: Array.isArray(d.sections) && d.sections.length ? d.sections : null,
  entries: Array.isArray(d.entries) ? d.entries : [],
  ideas: Array.isArray(d.ideas) ? d.ideas : null, // null: never saved (your old personal-Space ideas move in once)
  vfree: !!d.vfree, // Variables' object-level Free View is on (Nov 18)
  gone: Array.isArray(d.gone) ? d.gone : [], // ids you deleted (Nov 25): tombstones for shared categories
  rev: Number(d.rev) || 0,
});

/* Tombstones (Nov 25). Deleting a chat, a subsection or a note records its id on your account (not this
   device), so a shared copy can never bring it back — from any of your devices. Restoring it (undo)
   takes the id off again. */
const GONE_MAX = 4000;
function idsIn(d, withNotes = true) {
  const out = new Set();
  for (const s of d?.sections || []) if (s?.id) out.add(s.id);
  for (const e of d?.entries || []) {
    if (!e?.id) continue;
    out.add(e.id);
    if (withNotes) for (const n of e.notes || []) if (n?.id) out.add(n.id);
  }
  return out;
}
/** next.gone after an edit from prev to next: what disappeared is added, what came back is removed. */
export function nextGone(prev, next, gone = []) {
  const a = idsIn(prev), b = idsIn(next);
  const set = new Set(gone);
  for (const id of a) if (!b.has(id)) set.add(id);
  for (const id of b) set.delete(id);
  return [...set].slice(-GONE_MAX);
}

export const myVars = () => data;
export const myVarsRemote = () => remote;
export function onMyVars(fn) { subs.add(fn); return () => subs.delete(fn); }

/* Undo / redo (Nov 24): every change to your Variables (renames, colors, moves, resizes, reordering, Free View
   layouts, notes) can be stepped back with Ctrl/⌘+Z while you're in Variables — separately from the
   Blueprint's own undo. Changes that land within a moment of each other (a drag) undo together. */
const past = [], future = [];
let lastAt = 0, stepping = false;
const snapOf = (d) => ({ sections: d.sections, entries: d.entries, vfree: d.vfree });
function remember(patch) {
  const keys = Object.keys(patch);
  if (stepping || !data || keys.every((k) => k === 'ideas')) return;
  if (Date.now() - lastAt > 700 || !past.length) { past.push(snapOf(data)); if (past.length > 80) past.shift(); }
  lastAt = Date.now();
  future.length = 0;
}
function step(from, to) {
  if (!data || !from.length) return false;
  to.push(snapOf(data));
  const snap = from.pop();
  stepping = true;
  try { setMyVars(snap); } finally { stepping = false; }
  lastAt = 0;
  return true;
}
export const undoMyVars = () => step(past, future);
export const redoMyVars = () => step(future, past);
export const canUndoMyVars = () => past.length > 0;
export const canRedoMyVars = () => future.length > 0;

/** Replace (part of) your Variables. Every open Variables object repaints at once; the save is batched. */
export function setMyVars(patch) {
  if (!data) return;
  remember(patch);
  const touches = 'sections' in patch || 'entries' in patch;
  const gone = touches && !('gone' in patch) ? nextGone(data, { ...data, ...patch }, data.gone || []) : (patch.gone || data.gone || []);
  data = { ...data, ...patch, gone, rev: Date.now() };
  store.set(localKey(), data);
  dirty = true;
  emit(Object.keys(patch));
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_MS);
  if (!remote) { const at = Date.now(); setTimeout(() => saved(true, at), 0); } // kept on this device only: nothing is waiting
}

/** Save now (Nov 26: a deletion must survive an immediate reload). */
export function flushMyVars() { clearTimeout(timer); return flush(); }

// Nov 29: save results, so an open chat can show a message as sending / not sent (with Retry).
const saveSubs = new Set();
export function onMyVarsSaved(fn) { saveSubs.add(fn); return () => saveSubs.delete(fn); }
const saved = (ok, at = Date.now()) => { for (const fn of saveSubs) { try { fn(ok, at); } catch {} } };
export const myVarsDirty = () => dirty;
function flush() {
  if (!remote || !dirty) return saving;
  if (status !== 'ok') { clearTimeout(timer); timer = setTimeout(flush, 3000); return saving; }
  const snapshot = data;
  const at = Date.now(); // everything changed up to now is in this write
  dirty = false;
  saving = saving.then(async () => {
    try {
      if (!row) {
        // Never a second row for the same account: look again right before creating one.
        const again = await api.db.select(TABLE, { filters: { user_id: uidKey } }).catch(() => null);
        if (again === null) throw new Error('offline');
        row = pickRow(again);
      }
      if (row) { const ts = new Date().toISOString(); await api.db.update(TABLE, row.id, { data: snapshot, updated_at: ts }); row = { ...row, updated_at: ts }; }
      else row = await api.db.insert(TABLE, { data: snapshot });
      saved(true, at); // later edits report when their own write lands
    } catch (e) {
      if (missing(e)) { remote = false; saved(true, at); } else { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 4000); saved(false, at); }
    }
  });
  return saving;
}
function flushNow() {
  if (!remote || !dirty || !row || status !== 'ok') return;
  dirty = false;
  const at = Date.now();
  try { Promise.resolve(api.db.update(TABLE, row.id, { data, updated_at: new Date().toISOString() }, { keepalive: true })).then(() => saved(true, at), () => { dirty = true; saved(false, at); }); } catch {}
}

// Pick up edits made on your other devices.
async function pull() {
  if (!remote || !data || dirty || document.hidden || !uidKey) return;
  try {
    // Egress (Nov 22): ask "changed?" first; the whole row only comes down when it did.
    if (row?.updated_at && api.mode !== 'local') {
      const st = await api.db.select(TABLE, { columns: 'updated_at', filters: { user_id: uidKey } });
      if (st[0]?.updated_at === row.updated_at) return;
    }
    const rows = await api.db.select(TABLE, { filters: { user_id: uidKey } });
    const r = pickRow(rows);
    if (!r?.data || dirty) return;
    row = r;
    const next = normal(r.data);
    if (next.rev > (data.rev || 0)) { data = next; store.set(localKey(), data); emit(); }
  } catch {}
}

/** Your Variables as a data source (the same shape a shared category uses — data/varshare.js). */
export const myVarsSource = {
  foreign: false,
  get: () => data,
  set: (p) => setMyVars(p),
  on: (fn) => onMyVars(fn),
  load: () => loadMyVars(),
  undo: () => undoMyVars(),
  redo: () => redoMyVars(),
  canUndo: () => canUndoMyVars(),
  canRedo: () => canRedoMyVars(),
};
