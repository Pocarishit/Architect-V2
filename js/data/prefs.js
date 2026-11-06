// Small per-user settings (custom titles, tracker metrics) kept in one row of `architect_prefs`.
// If that table hasn't been created yet, settings still work and live in this browser.
import { api } from './api.js';
import { store } from '../core/util.js';

const LOCAL = 'architect.prefs';
let data = null;
let row = null;
let remote = true;
let loading = null;
let saving = Promise.resolve();

export function loadPrefs() {
  if (data) return Promise.resolve(data);
  loading ||= (async () => {
    const local = store.get(LOCAL, {});
    try {
      const rows = await api.db.select('architect_prefs');
      row = rows[0] || null;
    } catch {
      remote = false;
    }
    data = { ...local, ...(row?.data || {}) };
    loading = null;
    return data;
  })();
  return loading;
}

export const getPref = (k, fallback = null) => (data && k in data ? data[k] : fallback);

export async function setPref(k, v) {
  await loadPrefs();
  data = { ...data, [k]: v };
  store.set(LOCAL, data);
  if (!remote) return;
  const snapshot = data;
  saving = saving.then(async () => {
    try {
      if (row) await api.db.update('architect_prefs', row.id, { data: snapshot });
      else row = await api.db.insert('architect_prefs', { data: snapshot });
    } catch {
      remote = false; // table missing — keep working locally
    }
  });
  return saving;
}

// Forget the cache on sign-out / account switch.
export function resetPrefs() { data = null; row = null; remote = true; }
