// Small per-user settings (custom titles, tracker metrics) kept in one row of `architect_prefs`.
// If that table hasn't been created yet, settings still work and live in this browser.
import { api } from './api.js';
import { store } from '../core/util.js';

const LOCAL = 'architect.prefs';
const localKey = () => `${LOCAL}.${api.auth.current()?.user?.id || 'anon'}`;
let data = null;
let row = null;
let remote = true;
let loading = null;
let saving = Promise.resolve();

export function loadPrefs() {
  if (data) return Promise.resolve(data);
  loading ||= (async () => {
    const local = store.get(localKey(), store.get(LOCAL, {}));
    try {
      // Filter to your own row: accountability partners can read each other's settings.
      const me = api.auth.current()?.user?.id;
      const rows = await api.db.select('architect_prefs', me ? { filters: { user_id: me } } : {});
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
  store.set(localKey(), data);
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

// Someone else's tracker settings (accountability partners).
export async function prefsOf(userId) {
  try {
    const rows = await api.db.select('architect_prefs', { filters: { user_id: userId } });
    return rows[0]?.data || {};
  } catch { return {}; }
}
