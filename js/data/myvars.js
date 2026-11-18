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
const subs = new Set();

const me = () => api.auth.current()?.user || null;
const localKey = () => `architect.myvars.${uidKey || 'anon'}`;
const missing = (e) => /relation .* does not exist|Could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || e || ''}`);
const emit = (keys = null) => { for (const fn of subs) { try { fn(data, keys); } catch {} } };

function reset() {
  clearTimeout(timer); clearInterval(poller);
  data = null; row = null; remote = true; loading = null; dirty = false; poller = 0;
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
      row = rows[0] || null;
      if (row?.data) data = normal(row.data);
      else if (local) data = normal(local);
      else fresh = true;
    } catch (e) {
      remote = false;
      if (configured && !missing(e)) console.warn('Variables: falling back to this browser', e);
      if (local) data = normal(local); else fresh = true;
    }
    data ||= { sections: null, entries: [], ideas: null, vfree: false, rev: 0 };
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
  rev: Number(d.rev) || 0,
});

export const myVars = () => data;
export const myVarsRemote = () => remote;
export function onMyVars(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Replace (part of) your Variables. Every open Variables object repaints at once; the save is batched. */
export function setMyVars(patch) {
  if (!data) return;
  data = { ...data, ...patch, rev: Date.now() };
  store.set(localKey(), data);
  dirty = true;
  emit(Object.keys(patch));
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_MS);
}

function flush() {
  if (!remote || !dirty) return saving;
  const snapshot = data;
  dirty = false;
  saving = saving.then(async () => {
    try {
      if (row) await api.db.update(TABLE, row.id, { data: snapshot, updated_at: new Date().toISOString() });
      else row = await api.db.insert(TABLE, { data: snapshot });
    } catch (e) {
      if (missing(e)) remote = false; else { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 4000); }
    }
  });
  return saving;
}
function flushNow() {
  if (!remote || !dirty || !row) return;
  dirty = false;
  try { api.db.update(TABLE, row.id, { data, updated_at: new Date().toISOString() }, { keepalive: true }); } catch {}
}

// Pick up edits made on your other devices.
async function pull() {
  if (!remote || !data || dirty || document.hidden || !uidKey) return;
  try {
    const rows = await api.db.select(TABLE, { filters: { user_id: uidKey } });
    const r = rows[0];
    if (!r?.data || dirty) return;
    row = r;
    const next = normal(r.data);
    if (next.rev > (data.rev || 0)) { data = next; store.set(localKey(), data); emit(); }
  } catch {}
}
