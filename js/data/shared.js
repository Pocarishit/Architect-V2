// Countdowns and Completion Meters you share with other people (table `shared_items`).
// Each item is { id, user_id (creator), kind, data, members }. Edits re-read the latest copy first,
// so two people changing the same item rarely overwrite each other.
import { api, friendlyError } from './api.js';
import { getPref, setPref, loadPrefs } from './prefs.js';
import { uid } from '../core/util.js';

export const local = () => api.mode === 'local';
export const meId = () => api.auth.current()?.user?.id;

const names = new Map();
export const nameOf = (id) => (id === meId() ? 'You' : names.get(id) || 'member');
export const initial = (id) => (id === meId() ? api.auth.current()?.user?.username || 'Y' : names.get(id) || '?').slice(0, 1).toUpperCase();

async function loadNames() {
  if (local()) return;
  try { (await api.rpc('shared_people', {})).forEach((r) => names.set(r.user_id, r.username)); } catch {}
}

/** Items of one kind, oldest first. Moves anything still saved in your settings into the shared table once. */
export async function listShared(kind, legacyPref) {
  let rows = await api.db.select('shared_items', { order: 'created_at.asc', filters: { kind } });
  if (legacyPref) {
    await loadPrefs();
    const old = getPref(legacyPref, null);
    if (Array.isArray(old) && old.length) {
      const made = [];
      for (const d of old) made.push(await api.db.insert('shared_items', { id: uid(), kind, data: d, members: [] }));
      await setPref(legacyPref, []);
      rows = [...rows, ...made.filter(Boolean)];
    }
  }
  await loadNames();
  return rows;
}

export async function createShared(kind, data) {
  const row = { id: uid(), kind, data, members: [] };
  const made = await api.db.insert('shared_items', row);
  return { ...row, user_id: meId(), created_at: new Date().toISOString(), ...(made || {}) };
}

/** Apply fn to the latest data and save it. */
export async function mutate(item, fn) {
  let latest = item.data;
  try { latest = (await api.db.get('shared_items', item.id))?.data || item.data; } catch {}
  const next = structuredClone(latest);
  fn(next);
  item.data = next;
  await api.db.update('shared_items', item.id, { data: next });
  return item;
}

export async function addMember(item, uname) {
  const row = await api.rpc('shared_add', { item: item.id, uname: uname.replace(/^@/, '').trim() });
  Object.assign(item, row);
  await loadNames();
  return item;
}

export const removeShared = (item) => api.db.remove('shared_items', item.id);
export const leaveShared = (item) => api.rpc('shared_remove', { item: item.id, who: meId() });
export const membersOf = (item) => [item.user_id, ...(item.members || [])];
export { friendlyError };
