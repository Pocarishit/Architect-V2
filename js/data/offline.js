// Offline layer (Nov 23 — Anytype → Architect runbook, "one task, two views").
// Wraps api.db so Architect keeps working with no connection:
//   · Reads: every successful select/get is cached on this device (IndexedDB). With no connection the
//     cached copy comes back instead, with your unsynced edits applied on top, so a full reload offline
//     shows exactly what you left.
//   · Writes to Path (path_tasks, path_columns) and Blueprints (blueprints) are queued on this device
//     when the network is down, in order, and replayed when it's back.
//
// THE CONFLICT RULE (what happens when two devices edit while offline):
//   Path tasks and paths — per field, last to reconnect wins. Only the fields you actually changed are
//   sent, so if one device ticks a task done and the other moves its date, both changes survive. If both
//   change the same field, the device that reconnects last sets the final value.
//   Blueprints — per object, three-way. The board as it was when you went offline is the base. An object
//   you changed (or added, or deleted) offline takes your version; an object you didn't touch keeps
//   whatever is on the server now, so someone else's edits to other objects are never wiped.
//
// What never goes through here: Side Chat (side_chats / side_messages) is read-cached on this device
// only and is never queued into a shared payload; credentials are never cached (auth isn't db).
import { AppError } from '../core/util.js';

const QUEUED = new Set(['path_tasks', 'path_columns', 'blueprints']);
const NO_CACHE = new Set([]); // tables never cached (none today; Side Chat stays on-device either way)
const DB = 'architect-offline';
const FLUSH_MS = 20_000;

/* ---------------- IndexedDB, with a localStorage fallback ---------------- */
let dbp = null;
function idb() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      } catch (e) { reject(e); }
    }).catch(() => null);
  }
  return dbp;
}
function req(store, mode, fn) {
  return idb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(r?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }).catch(() => null);
}
const cacheGet = (k) => req('cache', 'readonly', (s) => s.get(k));
const cachePut = (k, v) => req('cache', 'readwrite', (s) => s.put(v, k));
const boxAll = () => req('outbox', 'readonly', (s) => s.getAll()).then((x) => x || []);
const boxAdd = (op) => req('outbox', 'readwrite', (s) => s.add(op));
const boxPut = (op) => req('outbox', 'readwrite', (s) => s.put(op));
const boxDel = (seq) => req('outbox', 'readwrite', (s) => s.delete(seq));

const isNetwork = (e) => e?.code === 'network' || /Failed to fetch|NetworkError|Can.t reach/i.test(String(e?.message || ''));
const offlineErr = () => new AppError('Can’t reach Supabase. Check your connection.', 'network');

/* ---------------- applying queued edits to cached reads ---------------- */
function matches(row, filters = {}) {
  return Object.entries(filters).every(([k, v]) => {
    if (v === null) return row[k] == null;
    if (Array.isArray(v)) return v.map(String).includes(String(row[k]));
    if (v && typeof v === 'object') return true; // gt etc.: leave the cached row in
    return String(row[k]) === String(v);
  });
}
function pickCols(row, columns) {
  if (!columns || columns === '*') return row;
  const out = {};
  for (const c of columns.split(',').map((x) => x.trim())) if (c in row) out[c] = row[c];
  return out;
}
function overlay(table, rows, ops, { filters, columns, single } = {}) {
  let list = (rows || []).map((r) => ({ ...r }));
  for (const op of ops) {
    if (op.table !== table) continue;
    if (op.kind === 'update') list = list.map((r) => (String(r.id) === String(op.id) ? { ...r, ...pickCols(op.patch, columns || '*') } : r));
    else if (op.kind === 'remove') { const gone = new Set(op.ids.map(String)); list = list.filter((r) => !gone.has(String(r.id))); }
    else if (op.kind === 'insert' && !single) {
      for (const row of op.rows) {
        if (!matches(row, filters)) continue;
        const i = list.findIndex((r) => String(r.id) === String(row.id));
        const shaped = pickCols(row, columns || '*');
        if (i >= 0) list[i] = { ...list[i], ...shaped }; else list.push(shaped);
      }
    }
  }
  return list;
}

/* ---------------- three-way merge for a blueprint's objects ---------------- */
export function mergeElements(base, mine, theirs) {
  const B = new Map((base || []).map((e) => [e.id, e]));
  const M = new Map((mine || []).map((e) => [e.id, e]));
  const T = new Map((theirs || []).map((e) => [e.id, e]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  const seen = new Set();
  // Keep their order, then append anything only you have.
  for (const t of theirs || []) {
    seen.add(t.id);
    const b = B.get(t.id), m = M.get(t.id);
    if (!b) { out.push(m && !same(m, t) ? m : t); continue; }        // new on their side (or both)
    if (!m) { if (same(b, t)) continue; out.push(t); continue; }      // you deleted it: gone, unless they changed it since
    out.push(same(m, b) ? t : m);                                      // you changed it → yours; else theirs
  }
  for (const m of mine || []) {
    if (seen.has(m.id)) continue;
    if (B.has(m.id) && !T.has(m.id) && same(B.get(m.id), m)) continue; // they deleted it and you didn't touch it
    out.push(m);
  }
  return out;
}

/* ---------------- the wrapper ---------------- */
export function withOffline(api) {
  const raw = api.db;
  const subs = new Set();
  let state = { online: navigator.onLine !== false, pending: 0, syncing: false, lastError: null };
  const emit = (p) => { state = { ...state, ...p }; for (const fn of subs) { try { fn(state); } catch {} } };
  const forced = () => { try { return !!window.__architectOffline || localStorage.getItem('architect.offline.force') === '1'; } catch { return false; } };
  const down = () => forced() || navigator.onLine === false;
  let pendingOps = [];        // mirror of the outbox, for overlaying reads without waiting on IndexedDB
  let loaded = boxAll().then((ops) => { pendingOps = ops; emit({ pending: ops.length }); });

  async function call(fn) {
    if (down()) throw offlineErr();
    return fn();
  }

  const key = (...a) => JSON.stringify(a);
  const uidNow = () => api.auth.current()?.user?.id || null;

  async function read(cacheKey, table, run, shape) {
    await loaded;
    try {
      const out = await call(run);
      if (!NO_CACHE.has(table)) cachePut(cacheKey, { at: Date.now(), out });
      if (!state.online && !down()) { emit({ online: true }); flush(); }
      return pendingOps.some((o) => o.table === table) ? shape(out, pendingOps) : out;
    } catch (e) {
      if (!isNetwork(e)) throw e;
      if (state.online) emit({ online: false });
      const hit = await cacheGet(cacheKey);
      if (!hit) throw e;
      return shape(hit.out, pendingOps);
    }
  }

  async function enqueue(op) {
    op.at = Date.now();
    op.user = uidNow();
    // A run of saves to the same board collapses into one: the earliest base, the latest contents.
    const last = pendingOps[pendingOps.length - 1];
    if (op.table === 'blueprints' && op.kind === 'update' && last?.table === 'blueprints' && last.kind === 'update' && String(last.id) === String(op.id)) {
      last.patch = { ...last.patch, ...op.patch };
      last.at = op.at;
      await boxPut(last);
    } else {
      const seq = await boxAdd(op);
      if (seq != null) op.seq = seq;
      pendingOps.push(op);
    }
    emit({ pending: pendingOps.length, online: false });
  }

  async function write(table, kind, run, op) {
    await loaded;
    if (!QUEUED.has(table)) return call(run);
    // Anything already waiting goes first, so edits land in the order you made them.
    if (pendingOps.length || down()) {
      if (!down()) flush();
      await enqueue(await op());
      return null;
    }
    try { return await run(); } catch (e) {
      if (!isNetwork(e)) throw e;
      await enqueue(await op());
      return null;
    }
  }

  // The last server copy of a board's objects (what "base" means in the merge rule).
  async function baseOf(id) {
    const hit = await cacheGet(key('get', 'blueprints', String(id), '*'));
    return hit?.out?.data?.elements || null;
  }

  const db = {
    ...raw,
    select(table, opts = {}) {
      return read(key('select', table, opts), table, () => raw.select(table, opts), (rows, ops) => overlay(table, rows, ops, { filters: opts.filters, columns: opts.columns }));
    },
    get(table, id, columns = '*') {
      return read(key('get', table, String(id), columns), table, () => raw.get(table, id, columns), (row, ops) => {
        if (!row) return row;
        return overlay(table, [row], ops, { columns, single: true })[0] || null;
      });
    },
    insert(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      return write(table, 'insert', () => raw.insert(table, rows), () => ({ table, kind: 'insert', rows: list.map((r) => ({ user_id: uidNow(), created_at: new Date().toISOString(), ...r })) }))
        .then((out) => out ?? (Array.isArray(rows) ? list : list[0]));
    },
    update(table, id, patch, o) {
      return write(table, 'update', () => raw.update(table, id, patch, o), async () => {
        const op = { table, kind: 'update', id: String(id), patch: { ...patch, updated_at: new Date().toISOString() } };
        if (table === 'blueprints' && patch?.data?.elements) op.base = await baseOf(id);
        return op;
      }).then(() => true);
    },
    remove(table, ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).map(String);
      return write(table, 'remove', () => raw.remove(table, ids), () => ({ table, kind: 'remove', ids: list })).then(() => undefined);
    },
    removeWhere(table, filters) { return call(() => raw.removeWhere(table, filters)); },
  };

  /* ---------------- replay ---------------- */
  let flushing = null;
  function flush() {
    if (flushing || down()) return flushing;
    flushing = (async () => {
      await loaded;
      if (!pendingOps.length) { emit({ online: true, syncing: false }); return; }
      emit({ syncing: true });
      // Only your own queued edits go out (another account's stay put on a shared device until they sign in).
      const mine = () => pendingOps.find((o) => !o.user || o.user === uidNow());
      for (let op = mine(); op; op = mine()) {
        try {
          await replay(op);
          await drop(op);
        } catch (e) {
          if (isNetwork(e)) { emit({ online: false, syncing: false }); return; }
          console.warn('Offline edit could not be applied and was skipped', op, e);
          emit({ lastError: e?.message || String(e) });
          await drop(op);
        }
      }
      emit({ online: true, syncing: false, pending: pendingOps.length });
      window.dispatchEvent(new CustomEvent('architect:offline-synced'));
      window.dispatchEvent(new CustomEvent('architect:paths-changed', { detail: { owner: uidNow(), from: 'offline' } }));
    })().finally(() => { flushing = null; });
    return flushing;
  }
  async function drop(op) {
    pendingOps = pendingOps.filter((x) => x !== op);
    if (op.seq != null) await boxDel(op.seq);
    emit({ pending: pendingOps.length });
  }
  async function replay(op) {
    if (down()) throw offlineErr();
    if (op.kind === 'insert') {
      try { await raw.insert(op.table, op.rows.map(({ user_id, created_at, ...r }) => r)); }
      catch (e) { if (!/duplicate key|23505|already exists/i.test(`${e?.code} ${e?.message}`)) throw e; }
      return;
    }
    if (op.kind === 'remove') { await raw.remove(op.table, op.ids); return; }
    if (op.kind === 'update') {
      let patch = { ...op.patch };
      if (op.table === 'blueprints' && patch.data?.elements) {
        const server = await raw.get('blueprints', op.id);
        if (!server) return; // the board was deleted meanwhile
        const theirs = server.data?.elements || [];
        const base = op.base || theirs;
        const merged = mergeElements(base, patch.data.elements, theirs);
        patch = { ...patch, data: { ...(server.data || {}), ...patch.data, elements: merged } };
        delete patch.preview; // the board page re-draws its preview on the next save
      }
      delete patch.updated_at; // the database stamps its own time
      await raw.update(op.table, op.id, patch);
    }
  }

  window.addEventListener('online', () => { emit({ online: true }); flush(); });
  window.addEventListener('offline', () => emit({ online: false }));
  setInterval(() => { if (pendingOps.length && !document.hidden) flush(); }, FLUSH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pendingOps.length) flush(); });
  loaded.then(() => { if (pendingOps.length) flush(); });

  api.db = db;
  api.offline = {
    state: () => ({ ...state, online: state.online && !down() }),
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    flush,
    pending: () => pendingOps.slice(),
  };
  return api;
}
