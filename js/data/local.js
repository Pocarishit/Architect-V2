// Local mode: same API as the Supabase backend, stored in this browser.
// Tables live in localStorage, media files in IndexedDB.
import { AppError, uid, store } from '../core/util.js';
import { createLocalRealtime } from './realtime.js';

const USERS = 'architect.local.users';
const SESSION = 'architect.local.session';

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* IndexedDB for media blobs */
let dbp = null;
function idb() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('architect-media', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function idbPut(k, v) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('files').objectStore('files').get(k);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export function createLocalBackend() {
  let session = store.get(SESSION);
  const listeners = new Set();
  const current = () => (session ? { user: { ...session.user } } : null);
  const emit = () => listeners.forEach((fn) => fn(current()));
  const objectUrls = new Map();

  const tkey = (t) => `architect.local.${session?.user?.id}.${t}`;
  const rows = (t) => store.get(tkey(t), []);
  const save = (t, list) => {
    try {
      localStorage.setItem(tkey(t), JSON.stringify(list));
    } catch {
      throw new AppError('This browser’s storage is full. Connect Supabase to keep more data.', 'quota');
    }
  };
  const need = () => { if (!session) throw new AppError('You are signed out.', 'signed_out', 401); };
  const pick = (row, columns) => {
    if (columns === '*') return { ...row };
    const out = {};
    for (const c of columns.split(',').map((x) => x.trim())) if (c in row) out[c] = row[c];
    return out;
  };
  const now = () => new Date().toISOString();

  return {
    mode: 'local',
    auth: {
      async init() { return current(); },
      current,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async signUp(username, password) {
        const users = store.get(USERS, {});
        if (users[username]) throw new AppError('That username is taken.', 'user_already_exists');
        const salt = uid();
        const id = uid();
        users[username] = { id, salt, hash: await sha(salt + password) };
        store.set(USERS, users);
        session = { user: { id, username } };
        store.set(SESSION, session);
        return current();
      },
      async signIn(username, password) {
        const u = store.get(USERS, {})[username];
        if (!u || (await sha(u.salt + password)) !== u.hash) throw new AppError('Wrong username or password.', 'invalid_credentials');
        session = { user: { id: u.id, username } };
        store.set(SESSION, session);
        return current();
      },
      async signOut() { session = null; store.set(SESSION, null); emit(); },
      async changePassword(password) {
        need();
        const users = store.get(USERS, {});
        const u = users[session.user.username];
        u.salt = uid();
        u.hash = await sha(u.salt + password);
        store.set(USERS, users);
      },
    },
    db: {
      async select(table, { columns = '*', order, filters = {} } = {}) {
        need();
        let list = rows(table).filter((r) => Object.entries(filters).every(([k, v]) => (v === null ? r[k] == null : Array.isArray(v) ? v.map(String).includes(String(r[k])) : String(r[k]) === String(v))));
        if (order) {
          const [col, dir] = order.split('.');
          const m = dir === 'desc' ? -1 : 1;
          list.sort((a, b) => (a[col] > b[col] ? m : a[col] < b[col] ? -m : 0));
        }
        return list.map((r) => pick(r, columns));
      },
      async get(table, id, columns = '*') {
        need();
        const r = rows(table).find((x) => x.id === id);
        return r ? pick(r, columns) : null;
      },
      async insert(table, input) {
        need();
        const list = rows(table);
        const made = (Array.isArray(input) ? input : [input]).map((r) => ({ id: uid(), created_at: now(), updated_at: now(), ...r, user_id: session.user.id }));
        list.push(...made);
        save(table, list);
        return Array.isArray(input) ? made.map((r) => ({ ...r })) : { ...made[0] };
      },
      async update(table, id, patch) {
        need();
        const list = rows(table);
        const r = list.find((x) => x.id === id);
        if (r) Object.assign(r, patch, { updated_at: now() });
        save(table, list);
        return true;
      },
      async remove(table, ids) {
        need();
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        save(table, rows(table).filter((r) => !set.has(r.id)));
      },
      async removeWhere(table, filters) {
        need();
        save(table, rows(table).filter((r) => !Object.entries(filters).every(([k, v]) => String(r[k]) === String(v))));
      },
    },
    async rpc() {
      throw new AppError('Sharing with other people needs Supabase. In local mode, open the board in a second tab to edit live.', 'local_only');
    },

    // Tabs in this browser share a live channel.
    live: createLocalRealtime(),

    media: {
      maxBytes: 200 * 1024 * 1024,
      async upload(file) {
        need();
        const path = `local/${uid()}`;
        await idbPut(path, file);
        const url = URL.createObjectURL(file);
        objectUrls.set(path, url);
        return { path, url };
      },
      async sign(paths) {
        const map = {};
        for (const p of new Set(paths)) {
          if (!p) continue;
          if (objectUrls.has(p)) { map[p] = objectUrls.get(p); continue; }
          const blob = await idbGet(p).catch(() => null);
          if (blob) { const u = URL.createObjectURL(blob); objectUrls.set(p, u); map[p] = u; }
        }
        return map;
      },
    },
  };
}
