// Shared Variables categories (Nov 23 — Desktop Sidebar).
// Your Variables are private to your account. A top-level category you switch to SHARED is published to
// the people in your shared Space as one `shared_items` row (kind 'varcat'): its name, cover, sub-sections,
// chats and their notes. Switch it back to PRIVATE and the row is deleted; your own copy never leaves.
//
// Who edits what:
//   · You (the owner) keep editing it exactly as before — in the Variables object or the sidebar. Every
//     15 seconds (and right after you change something) your copy is pushed to the shared row.
//   · Members see it in the sidebar's category row and can read its chats and add notes. Their notes land
//     in the shared row, and come into your own copy on the next sync.
//   · Notes are merged by id, so nobody's note overwrites anyone else's. A deleted note is remembered as
//     deleted (a tombstone), so it doesn't come back from someone else's copy.
// Side Chat and anything outside the shared category are never part of the payload.
import { api } from './api.js';
import { listShared, createShared, addMember, removeShared, meId } from './shared.js';
import { myVars, setMyVars, loadMyVars, onMyVars } from './myvars.js';
import { store } from '../core/util.js';

const KIND = 'varcat';
const POLL_MS = 15_000;
let items = [];          // every varcat row you can see
let timer = 0, pushT = 0, running = false;
let sharedSpaceId = null;
const subs = new Set();
const emit = () => { for (const fn of subs) { try { fn(items); } catch {} } };
const syncedKey = (id) => `architect.varshare.synced.${id}`;

export const sharedCats = () => items;
export const foreignCats = () => items.filter((it) => it.user_id !== meId());
export function onShared(fn) { subs.add(fn); return () => subs.delete(fn); }
export const setSharedSpace = (id) => { sharedSpaceId = id; };

/* ---------------- building and merging the payload ---------------- */
function subtree(secs, rootId) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) { grew = false; for (const s of secs) if (s.parent && ids.has(s.parent) && !ids.has(s.id)) { ids.add(s.id); grew = true; } }
  return ids;
}
/** The shareable copy of one category: no free-view layouts, nothing outside the category. */
export function payloadOf(catId, vars = myVars()) {
  const secs = vars?.sections || [];
  const cat = secs.find((s) => s.id === catId);
  if (!cat) return null;
  const ids = subtree(secs, catId);
  const clean = ({ free, share, ...rest }) => rest;
  return {
    v: 1, catId, owner: api.auth.current()?.user?.username || '',
    name: cat.name, img: cat.img || null,
    sections: secs.filter((s) => ids.has(s.id)).map(clean),
    entries: (vars.entries || []).filter((e) => ids.has(e.section)).map(({ free, ...e }) => ({ ...e, notes: e.notes || [] })),
    gone: [],
  };
}

const noteKey = (n) => (n.et || n.ts || 0);
function mergeNotes(a = [], b = [], gone = new Set()) {
  const m = new Map();
  for (const n of [...a, ...b]) {
    if (!n?.id || gone.has(n.id)) continue;
    const have = m.get(n.id);
    if (!have || noteKey(n) > noteKey(have)) m.set(n.id, n);
  }
  return [...m.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0)).slice(-600);
}
/** Combine two copies of a category. `structure` decides whose names, covers and order win (the owner's). */
export function mergeCat(structure, other) {
  const gone = new Set([...(structure.gone || []), ...(other.gone || [])]);
  const byId = new Map((other.entries || []).map((e) => [e.id, e]));
  const entries = (structure.entries || []).filter((e) => !gone.has(e.id)).map((e) => ({ ...e, notes: mergeNotes(e.notes, byId.get(e.id)?.notes, gone) }));
  return { ...structure, entries, gone: [...gone].slice(-2000) };
}

/* ---------------- your side: publish, push, pull ---------------- */
export async function shareCategory(catId) {
  await loadMyVars();
  const p = payloadOf(catId);
  if (!p) throw new Error('That category is gone.');
  const row = await createShared(KIND, p);
  // Everyone in the shared Space gets it.
  const failed = [];
  if (sharedSpaceId && api.mode !== 'local') {
    let people = [];
    try { people = (await api.rpc('board_people', { b: sharedSpaceId })) || []; } catch {}
    for (const person of people) {
      if (person.user_id === meId()) continue;
      try { await addMember(row, person.username); } catch { failed.push(person.username); }
    }
  }
  setSec(catId, { share: { item: row.id } });
  store.set(syncedKey(row.id), noteIds(p));
  items = [...items.filter((x) => x.id !== row.id), row];
  emit();
  return { row, failed };
}

export async function unshareCategory(catId) {
  const sec = (myVars()?.sections || []).find((s) => s.id === catId);
  const id = sec?.share?.item;
  setSec(catId, { share: null });
  if (!id) return;
  try { await removeShared({ id }); } catch {}
  items = items.filter((x) => x.id !== id);
  store.set(syncedKey(id), null);
  emit();
}

function setSec(id, patch) {
  const v = myVars();
  if (!v) return;
  const secs = v.sections || [];
  setMyVars({ sections: secs.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}
const noteIds = (p) => ({ notes: (p.entries || []).flatMap((e) => (e.notes || []).map((n) => n.id)), entries: (p.entries || []).map((e) => e.id) });

// What you deleted since the last sync becomes a tombstone so the shared copy doesn't bring it back.
function tombstones(itemId, p) {
  const last = store.get(syncedKey(itemId), null);
  if (!last) return [];
  const nowN = new Set(p.entries.flatMap((e) => (e.notes || []).map((n) => n.id)));
  const nowE = new Set(p.entries.map((e) => e.id));
  return [...(last.notes || []).filter((id) => !nowN.has(id)), ...(last.entries || []).filter((id) => !nowE.has(id))];
}

async function syncMine(it) {
  const vars = myVars();
  const sec = (vars?.sections || []).find((s) => s.share?.item === it.id);
  if (!sec) return; // shared from another device and then made private here: nothing to push
  const local = payloadOf(sec.id, vars);
  local.gone = tombstones(it.id, local);
  const merged = mergeCat(local, it.data || {});
  // Bring members' notes into your own copy.
  const incoming = new Map(merged.entries.map((e) => [e.id, e.notes]));
  const v2 = myVars();
  let changed = false;
  const entries = (v2.entries || []).map((e) => {
    const n = incoming.get(e.id);
    if (!n || JSON.stringify(n) === JSON.stringify(e.notes || [])) return e;
    changed = true;
    return { ...e, notes: n };
  });
  if (changed) setMyVars({ entries });
  // Push yours.
  const data = { ...merged, gone: merged.gone };
  if (JSON.stringify(data) !== JSON.stringify(it.data)) {
    await api.db.update('shared_items', it.id, { data });
    it.data = data;
  }
  store.set(syncedKey(it.id), noteIds(merged));
}

/** One sync round: read every varcat you can see; merge yours both ways. */
export async function syncShared() {
  if (running) return;
  running = true;
  try {
    await loadMyVars();
    let rows = [];
    try { rows = await listShared(KIND); } catch { return; }
    items = rows;
    for (const it of rows) if (it.user_id === meId()) { try { await syncMine(it); } catch (e) { console.warn('Shared category sync', e); } }
    emit();
  } finally { running = false; }
}

/* ---------------- members: add and remove notes in someone else's category ---------------- */
export async function addSharedNote(itemId, entryId, note) {
  const it = items.find((x) => x.id === itemId);
  if (!it) return;
  const latest = (await api.db.get('shared_items', itemId))?.data || it.data;
  const data = structuredClone(latest);
  const e = (data.entries || []).find((x) => x.id === entryId);
  if (!e) return;
  e.notes = [...(e.notes || []), note].slice(-600);
  await api.db.update('shared_items', itemId, { data });
  it.data = data;
  emit();
}
export async function removeSharedNote(itemId, entryId, noteId) {
  const it = items.find((x) => x.id === itemId);
  if (!it) return;
  const latest = (await api.db.get('shared_items', itemId))?.data || it.data;
  const data = structuredClone(latest);
  const e = (data.entries || []).find((x) => x.id === entryId);
  if (e) e.notes = (e.notes || []).filter((n) => n.id !== noteId);
  data.gone = [...(data.gone || []), noteId];
  await api.db.update('shared_items', itemId, { data });
  it.data = data;
  emit();
}

/** Start syncing (the sidebar calls this once you're signed in). */
export function startVarShare() {
  if (timer) return () => {};
  syncShared();
  timer = setInterval(() => { if (!document.hidden) syncShared(); }, POLL_MS);
  // Your edits to a shared category go out a moment after you make them.
  const off = onMyVars((d, keys) => {
    if (keys && keys.every((k) => k === 'ideas' || k === 'vfree')) return;
    if (!(myVars()?.sections || []).some((s) => s.share?.item)) return;
    clearTimeout(pushT);
    pushT = setTimeout(syncShared, 1500);
  });
  return () => { clearInterval(timer); timer = 0; clearTimeout(pushT); off(); };
}
