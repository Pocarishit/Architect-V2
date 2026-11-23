// One task, two views (Nov 23). A Path task lives once, in path_tasks. A Blueprint card is only a
// reference to it ({ type: 'task', taskId } + its own x, y, w, h on the board), so ticking it done or
// moving its date on either side changes the one task, and both views show the same value.
// This module is the cards' shared copy of the tasks they show: one fetch for all cards on screen,
// refreshed when Path says it changed, when you come back to the tab, and every 20 seconds while any
// card is visible. Works offline through the offline layer (js/data/offline.js).
import { api } from './api.js';

const tasks = new Map();   // id → row (or null: deleted / not yours to see)
const columns = new Map(); // id → { id, title }
const watchers = new Map(); // id → Set(fn)
let want = new Set();
let timer = 0, poll = 0, inflight = null;
const me = () => api.auth.current()?.user?.id || null;
const FIELDS = 'id,user_id,column_id,title,note,done,day,position,private,updated_at';

function notify(id) { for (const fn of watchers.get(id) || []) { try { fn(tasks.get(id)); } catch {} } }

function schedule(ms = 30) {
  clearTimeout(timer);
  timer = setTimeout(fetchNow, ms);
}

async function fetchNow() {
  if (inflight) { await inflight; }
  const ids = [...watchers.keys()];
  if (!ids.length) return;
  inflight = (async () => {
    try {
      let rows;
      try { rows = await api.db.select('path_tasks', { columns: FIELDS, filters: { id: ids } }); }
      catch { rows = await api.db.select('path_tasks', { columns: 'id,user_id,column_id,title,note,done,position,updated_at', filters: { id: ids } }); }
      const seen = new Set(rows.map((r) => String(r.id)));
      const owners = new Set(rows.map((r) => r.user_id).filter(Boolean));
      if (owners.size) {
        try {
          const cols = await api.db.select('path_columns', { columns: 'id,title,user_id,position', filters: { user_id: [...owners] } });
          for (const c of cols) columns.set(String(c.id), c);
        } catch {}
      }
      for (const r of rows) {
        const prev = tasks.get(String(r.id));
        tasks.set(String(r.id), r);
        if (JSON.stringify(prev) !== JSON.stringify(r)) notify(String(r.id));
      }
      for (const id of ids) if (!seen.has(id) && tasks.get(id) !== null) { tasks.set(id, null); notify(id); }
    } catch { /* offline with nothing cached: cards keep what they show */ }
    finally { want = new Set(); }
  })();
  await inflight;
  inflight = null;
}

/** Follow one task. fn(row | null | undefined) — undefined while loading, null when it's gone. */
export function watchTask(id, fn) {
  id = String(id);
  if (!watchers.has(id)) watchers.set(id, new Set());
  watchers.get(id).add(fn);
  if (tasks.has(id)) fn(tasks.get(id)); else { want.add(id); schedule(); }
  if (!poll) poll = setInterval(() => { if (!document.hidden && watchers.size) fetchNow(); }, 20_000);
  return () => {
    const s = watchers.get(id);
    s?.delete(fn);
    if (s && !s.size) watchers.delete(id);
    if (!watchers.size) { clearInterval(poll); poll = 0; }
  };
}

export const taskOf = (id) => tasks.get(String(id));
export const columnOf = (id) => columns.get(String(id)) || null;
export const columnsOf = (owner) => [...columns.values()].filter((c) => c.user_id === owner).sort((a, b) => a.position - b.position);
export const canEdit = (t) => !!t && t.user_id === me();

/** Change the task from a card. Path widgets showing it refresh at once. */
export async function patchTask(id, patch) {
  id = String(id);
  const t = tasks.get(id);
  if (!t) return;
  tasks.set(id, { ...t, ...patch });
  notify(id);
  try {
    await api.db.update('path_tasks', id, patch);
  } finally {
    window.dispatchEvent(new CustomEvent('architect:paths-changed', { detail: { owner: t.user_id, from: 'taskcard' } }));
  }
}

/** Your tasks, for the "Add a Path task" picker. */
export async function myTasks() {
  const [cols, rows] = await Promise.all([
    api.db.select('path_columns', { columns: 'id,title,user_id,position', filters: { user_id: me() }, order: 'position.asc' }),
    api.db.select('path_tasks', { filters: { user_id: me() }, order: 'position.asc' }),
  ]);
  for (const c of cols) columns.set(String(c.id), c);
  for (const r of rows) tasks.set(String(r.id), r);
  return { cols, rows };
}

// Path changed (another widget, the offline replay, another tab): re-read what the cards show.
window.addEventListener('architect:paths-changed', (e) => { if (e.detail?.from !== 'taskcard' && watchers.size) schedule(120); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && watchers.size) schedule(60); });
