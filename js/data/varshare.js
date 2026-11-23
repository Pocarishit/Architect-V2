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
//   · Nov 24 — members with access edit it like their own: rename, recolor, add / delete / reorder chats and
//     sub-sections, Free View layouts. Their edits go into the shared row (sharedSource below); your next sync
//     merges them three ways (yours, theirs, and the last synced copy) — a change on one side wins, and when
//     both sides changed the same thing, yours (the owner's) does.
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
  const clean = ({ share, ...rest }) => rest; // Free View layouts travel too (Nov 24): shared Free View
  return {
    v: 1, catId, owner: api.auth.current()?.user?.username || '',
    name: cat.name, img: cat.img || null,
    sections: secs.filter((s) => ids.has(s.id)).map(clean),
    entries: (vars.entries || []).filter((e) => ids.has(e.section)).map((e) => ({ ...e, notes: e.notes || [] })),
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

/* ---------------- three-way merge of the structure (Nov 24) ---------------- */
const baseKey = (id) => `architect.varshare.base.${id}`;
const noNotes = ({ notes, ...rest }) => rest;
const sig = (x, strip) => (x ? JSON.stringify(strip ? strip(x) : x) : null);
function baseOf(cat) {
  return {
    secs: Object.fromEntries((cat.sections || []).map((x) => [x.id, sig(x)])),
    ents: Object.fromEntries((cat.entries || []).map((x) => [x.id, sig(x, noNotes)])),
    secOrder: (cat.sections || []).map((x) => x.id), entOrder: (cat.entries || []).map((x) => x.id),
  };
}
/** Merge two lists by id against the last synced copy: one-sided changes win, the owner wins a tie. */
function merge3(L = [], R = [], B = null, order = null, strip = null) {
  const lm = new Map(L.map((x) => [x.id, x])), rm = new Map(R.map((x) => [x.id, x]));
  const out = new Map();
  for (const id of new Set([...lm.keys(), ...rm.keys()])) {
    const l = lm.get(id), r = rm.get(id), b = B ? B[id] ?? null : null;
    if (l && r) { const lc = sig(l, strip) !== b, rc = sig(r, strip) !== b; out.set(id, !B || lc || !rc ? l : r); }
    else if (l) { if (B && b != null && sig(l, strip) === b) continue; out.set(id, l); } // they deleted it, you didn't touch it
    else if (r) { if (B && b != null) continue; out.set(id, r); }                          // you deleted it
  }
  const lo = L.map((x) => x.id), ro = R.map((x) => x.id);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const keep = (list) => list.filter((id) => out.has(id));
  const first = order && same(keep(lo), keep(order)) && !same(keep(ro), keep(order)) ? ro : lo; // only they reordered
  const ids = [...keep(first), ...[...out.keys()].filter((id) => !first.includes(id))];
  return ids.map((id) => out.get(id));
}

async function syncMine(it) {
  const vars = myVars();
  const sec = (vars?.sections || []).find((s) => s.share?.item === it.id);
  if (!sec) return; // shared from another device and then made private here: nothing to push
  const local = payloadOf(sec.id, vars);
  local.gone = tombstones(it.id, local);
  const remote = it.data || {};
  const base = store.get(baseKey(it.id), null);
  const gone = new Set([...(local.gone || []), ...(remote.gone || [])]);
  const rEnt = new Map((remote.entries || []).map((e) => [e.id, e]));
  const sections = merge3(local.sections, remote.sections || [], base?.secs, base?.secOrder);
  const entries = merge3(local.entries, remote.entries || [], base?.ents, base?.entOrder, noNotes)
    .filter((e) => !gone.has(e.id))
    .map((e) => ({ ...e, notes: mergeNotes((local.entries.find((x) => x.id === e.id) || e).notes, rEnt.get(e.id)?.notes, gone) }));
  const root = sections.find((x) => x.id === sec.id) || sec;
  const merged = { ...local, name: root.name, img: root.img || null, sections, entries, gone: [...gone].slice(-2000) };

  // Bring members' edits and notes into your own copy (only what's inside this category changes).
  const v2 = myVars();
  const inside = new Set(subtree(v2.sections || [], sec.id));
  const nextSecs = [
    ...(v2.sections || []).filter((x) => !inside.has(x.id)),
    ...sections.map((x) => { const mine = (v2.sections || []).find((y) => y.id === x.id); return mine?.share ? { ...x, share: mine.share } : x; }),
  ];
  const keepOrder = (v2.sections || []).map((x) => x.id);
  nextSecs.sort((a, b) => { const i = keepOrder.indexOf(a.id), j = keepOrder.indexOf(b.id); return (i < 0 ? 1e9 : i) - (j < 0 ? 1e9 : j); });
  const insideAfter = new Set(subtree(nextSecs, sec.id));
  const nextEnts = [...(v2.entries || []).filter((e) => !inside.has(e.section) && !insideAfter.has(e.section)), ...entries];
  if (JSON.stringify(nextSecs) !== JSON.stringify(v2.sections || []) || JSON.stringify(nextEnts) !== JSON.stringify(v2.entries || [])) {
    setMyVars({ sections: nextSecs, entries: nextEnts });
  }
  // Push the merged copy.
  if (JSON.stringify(merged) !== JSON.stringify(it.data)) {
    await api.db.update('shared_items', it.id, { data: merged });
    it.data = merged;
  }
  store.set(syncedKey(it.id), noteIds(merged));
  store.set(baseKey(it.id), baseOf(merged));
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
    for (const src of sources.values()) src._reapply?.();
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

/* ---------------- members: edit someone else's category like your own (Nov 24) ---------------- */
// The same shape as data/myvars.js's myVarsSource, so a Variables object (and the sidebar) can run on a
// shared category: get / set / on / load / undo / redo. Writes go to the shared row a moment later, keeping
// any notes others added meanwhile.
const sources = new Map();
export function sharedSource(itemId) {
  if (sources.has(itemId)) return sources.get(itemId);
  const row = () => items.find((x) => x.id === itemId) || null;
  const past = [], future = [];
  let lastAt = 0, stepping = false, t = 0, writing = Promise.resolve();
  let local = null; // your edit, until it's written (a poll in between mustn't undo it on screen)
  const cur = () => local || row()?.data || null;
  const get = () => { const d = cur(); return d ? { sections: d.sections || [], entries: d.entries || [], vfree: !!d.vfree } : null; };
  function set(patch) {
    const r = row();
    if (!r) return;
    const keys = Object.keys(patch);
    if (!stepping && !keys.every((k) => k === 'ideas')) {
      if (Date.now() - lastAt > 700 || !past.length) { past.push(get()); if (past.length > 60) past.shift(); }
      lastAt = Date.now(); future.length = 0;
    }
    const prev = cur() || {};
    // entries this edit removed become tombstones, so the owner's sync doesn't bring them back
    const removed = patch.entries ? (prev.entries || []).filter((e) => !patch.entries.some((x) => x.id === e.id)).map((e) => e.id) : [];
    local = { ...prev, ...(patch.sections ? { sections: patch.sections } : {}), ...(patch.entries ? { entries: patch.entries } : {}), ...('vfree' in patch ? { vfree: !!patch.vfree } : {}),
      gone: [...(prev.gone || []), ...removed].slice(-2000) };
    const root = (local.sections || []).find((x) => x.id === local.catId);
    if (root) { local.name = root.name; local.img = root.img || null; }
    r.data = local;
    emit();
    clearTimeout(t);
    t = setTimeout(() => { writing = writing.then(push).catch((e) => console.warn('Shared category edit', e)); }, 400);
  }
  async function push() {
    const r = row();
    if (!r) return;
    if (!local) return;
    const mine = local;
    const latest = (await api.db.get('shared_items', itemId))?.data || mine;
    const gone = new Set([...(latest.gone || []), ...(mine.gone || [])]);
    const theirs = new Map((latest.entries || []).map((e) => [e.id, e]));
    const entries = (mine.entries || []).filter((e) => !gone.has(e.id)).map((e) => ({ ...e, notes: mergeNotes(e.notes, theirs.get(e.id)?.notes, gone) }));
    const data = { ...latest, name: mine.name, img: mine.img, sections: mine.sections, entries, vfree: mine.vfree, gone: [...gone].slice(-2000) };
    await api.db.update('shared_items', itemId, { data });
    if (local === mine) local = null; // nothing newer was typed meanwhile
    (row() || r).data = local || data;
    emit();
  }
  const stepTo = (from, to) => { if (!from.length) return false; to.push(get()); const snap = from.pop(); stepping = true; try { set(snap); } finally { stepping = false; } lastAt = 0; return true; };
  const src = {
    foreign: true, itemId,
    get, set,
    on: (fn) => onShared(() => fn(get(), null)),
    load: async () => { if (!row()) await syncShared(); return { data: get(), fresh: false }; },
    undo: () => stepTo(past, future), redo: () => stepTo(future, past),
    canUndo: () => past.length > 0, canRedo: () => future.length > 0,
  };
  src._reapply = () => { const r = row(); if (r && local) r.data = local; };
  sources.set(itemId, src);
  return src;
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
