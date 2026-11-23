// Anytype sync — the app side (Nov 23b, "Anytype sync for Architect" runbook).
// The phone and the desktop read the same private imports from Architect's backend after sign-in; neither
// ever talks to Anytype or to the Windows PC. The connector on the PC (connector/) does the reading.
//
//   · imports    anytype_items (read-only here), cached on the device as the last-good snapshot, so Path
//                still shows them offline or while the PC is asleep.
//   · checkmarks anytype_checks — Architect owns them, per Architect day. Saved on the device first, then
//                sent; while unsent they show as pending (never as synced) and survive a reload.
//   · status     anytype_runs + anytype_connectors → "Last imported…", "Waiting for desktop", or the error.
//   · two-way    (Nov 24, supabase/nov24-anytype.sql) Architect-side changes to a linked item — check / uncheck,
//                rename, add, delete — are queued in anytype_ops and applied in Anytype by the connector on the
//                PC; Anytype's own checkbox comes back with every import (fields.done + done_at), and the newer
//                side wins. "Remove from Path" only hides an item here (prefs.anytypeHidden), never in Anytype.
// Off by default (Settings → Integrations): production imports stay disabled until you turn them on.
import { api, configured } from './api.js';
import { getPref, setPref } from './prefs.js';
import { store } from '../core/util.js';

const me = () => api.auth.current()?.user?.id || 'anon';
const K = {
  snap: () => `architect.ax.snap.${me()}`,      // { items, runs, connectors, at }
  checks: () => `architect.ax.checks.${me()}`,  // { 'key|day': { done, at } } — what the server confirmed
  pending: () => `architect.ax.pending.${me()}`, // [{ key, day, done, at }] — not sent yet
  outbox: () => `architect.ax.outbox.${me()}`,   // [{ id, mapping_id, item_key, op, payload, at }] — ops not sent yet
};
const subs = new Set();
const emit = () => { for (const f of subs) { try { f(); } catch {} } };
export const onAnytype = (fn) => { subs.add(fn); return () => subs.delete(fn); };

/** Turned on in Settings → Integrations, and only with Supabase (local mode has no connector). */
export const anytypeOn = () => configured && !!getPref('anytypeSync', false);

let snap = null;
let loading = null;
let lastLoad = 0;
const snapshot = () => (snap ||= store.get(K.snap(), null) || { items: [], runs: [], connectors: [], at: 0 });

const missing = (e) => /relation .* does not exist|Could not find the table|42P01|PGRST205|permission denied/i.test(`${e?.code || ''} ${e?.message || e || ''}`);

/** Refresh the imports (at most every 20 s unless forced). Errors keep the last snapshot. */
export function loadImports({ force = false } = {}) {
  if (!anytypeOn()) return Promise.resolve(snapshot());
  if (loading) return loading;
  if (!force && Date.now() - lastLoad < 20_000) return Promise.resolve(snapshot());
  loading = (async () => {
    try {
      const [items, runs, connectors, mappings] = await Promise.all([
        api.db.select('anytype_items', { columns: 'key,mapping_id,dest_kind,dest_id,source_space_id,source_object_id,fields,sort,archived,updated_at', filters: { archived: false }, order: 'sort.asc' }),
        api.db.select('anytype_runs', { columns: 'mapping_id,status,message,last_attempt_at,last_success_at,item_count' }),
        api.db.select('anytype_connectors', { columns: 'id,name,last_seen_at,revoked_at' }),
        api.db.select('anytype_mappings', { columns: 'id,name,dest_kind,dest_id,enabled,paused,source_kind' }).catch(() => []),
      ]);
      await flushOps();
      let ops = [];
      try { ops = await api.db.select('anytype_ops', { columns: 'id,mapping_id,item_key,op,payload,status,message,created_at', order: 'created_at.asc' }); opsReady = true; }
      catch (e) { if (missing(e)) opsReady = false; }
      snap = { items, runs, connectors, mappings, ops, at: Date.now() };
      store.set(K.snap(), snap);
      lastLoad = Date.now();
      await flushChecks();
      await loadChecks();
    } catch (e) { if (missing(e)) snap = { ...snapshot(), setupNeeded: true }; }
    finally { loading = null; }
    emit();
    return snapshot();
  })();
  return loading;
}

/** Imported items for one Path column on a given Architect day (undated items show every day). Pending
 *  Architect-side changes show at once: a rename has its new title, a delete is gone, an add is there. */
export function importsFor(colId, day) {
  if (!anytypeOn()) return [];
  const hidden = hiddenMap();
  const ops = openOps();
  const gone = new Set(ops.filter((o) => o.op === 'delete').map((o) => o.item_key));
  const named = new Map(ops.filter((o) => o.op === 'rename').map((o) => [o.item_key, o.payload?.title]));
  const list = snapshot().items
    .filter((it) => it.dest_kind === 'path' && it.dest_id === colId && !it.archived && (!it.fields?.date || it.fields.date === day))
    .filter((it) => !hidden[it.key] && !gone.has(it.key))
    .map((it) => (named.has(it.key) ? { ...it, fields: { ...it.fields, title: named.get(it.key) }, pendingEdit: true } : it));
  const maps = new Set(mappingsFor(colId).map((m) => m.id));
  const adds = ops.filter((o) => o.op === 'add' && maps.has(o.mapping_id))
    .map((o) => ({ key: `op:${o.id}`, mapping_id: o.mapping_id, dest_kind: 'path', dest_id: colId, fields: { title: o.payload?.title || '' }, placeholder: true, failed: o.status === 'failed', message: o.message }));
  return [...list, ...adds];
}

/* ---------------- two-way (Nov 24) ---------------- */
let opsReady = true; // false until supabase/nov24-anytype.sql has been run
export const twoWayReady = () => opsReady;
/** Enabled mappings that feed this Path column. */
export const mappingsFor = (colId) => (snapshot().mappings || []).filter((m) => m.dest_kind === 'path' && m.dest_id === colId && m.enabled && !m.paused);
const outbox = () => store.get(K.outbox(), []) || [];
/** Ops not finished yet: sent ones (pending / taken / failed recently) and ones still on this device. */
function openOps() {
  const sent = (snapshot().ops || []).filter((o) => o.status === 'pending' || o.status === 'taken' || (o.status === 'failed' && Date.now() - Date.parse(o.created_at) < 86_400_000));
  const ids = new Set(sent.map((o) => o.id));
  return [...sent, ...outbox().filter((o) => !ids.has(o.id)).map((o) => ({ ...o, status: 'pending' }))];
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
function queue(op) {
  const o = { id: newId(), at: Date.now(), payload: {}, item_key: null, ...op };
  store.set(K.outbox(), [...outbox(), o].slice(-300));
  emit();
  flushOps().then(() => { requestSync(); loadImports({ force: true }); });
  return o;
}
let flushingOps = null;
async function flushOps() {
  if (flushingOps) return flushingOps;
  flushingOps = (async () => {
    let list = outbox();
    while (list.length && navigator.onLine !== false) {
      const o = list[0];
      try {
        await api.db.insert('anytype_ops', { id: o.id, mapping_id: o.mapping_id, item_key: o.item_key, op: o.op, payload: o.payload || {} });
        snap = { ...snapshot(), ops: [...(snapshot().ops || []), { ...o, status: 'pending', created_at: new Date(o.at).toISOString() }] };
      } catch (e) {
        if (missing(e)) { opsReady = false; break; }
        if (!/duplicate key|23505/.test(`${e?.code} ${e?.message}`)) break; // offline: keep it queued
      }
      list = outbox().filter((x) => x.id !== o.id);
      store.set(K.outbox(), list);
    }
  })().finally(() => { flushingOps = null; emit(); });
  return flushingOps;
}
/** Ask the connector(s) on the PC to sync now (they check every ~45 s). */
export async function requestSync() {
  const live = (snapshot().connectors || []).filter((c) => !c.revoked_at);
  await Promise.all(live.map((c) => api.db.update('anytype_connectors', c.id, { sync_requested_at: new Date().toISOString() }).catch(() => {})));
}
export function renameItem(it, title) {
  const t = String(title || '').trim().slice(0, 500);
  if (!t || t === it.fields?.title) return;
  queue({ mapping_id: it.mapping_id, item_key: it.key, op: 'rename', payload: { title: t } });
}
export function addItem(mappingId, title) {
  const t = String(title || '').trim().slice(0, 500);
  if (t) queue({ mapping_id: mappingId, op: 'add', payload: { title: t } });
}
/** Delete in Anytype and here (after the confirm in the Path menu). */
export function deleteItem(it) { queue({ mapping_id: it.mapping_id, item_key: it.key, op: 'delete' }); }
/** Drop a queued add / failed op from this device and the server. */
export async function dropOp(key) {
  const id = String(key).replace(/^op:/, '');
  store.set(K.outbox(), outbox().filter((o) => o.id !== id));
  snap = { ...snapshot(), ops: (snapshot().ops || []).filter((o) => o.id !== id) };
  emit();
  try { await api.db.remove('anytype_ops', id); } catch {}
}

/* "Remove from Path": hidden in Architect only — Anytype and the mapping stay as they are, and a sync or
   reload doesn't bring it back. Restore from Settings → Integrations. */
const hiddenMap = () => getPref('anytypeHidden', {}) || {};
export const hiddenCount = () => Object.keys(hiddenMap()).length;
export async function hideItem(it) {
  await setPref('anytypeHidden', { ...hiddenMap(), [it.key]: { title: it.fields?.title || '', at: Date.now() } });
  emit();
}
export async function restoreHidden(key = null) {
  const m = { ...hiddenMap() };
  if (key) delete m[key]; else for (const k of Object.keys(m)) delete m[k];
  await setPref('anytypeHidden', m);
  emit();
}
export const hiddenItems = () => Object.entries(hiddenMap()).map(([key, v]) => ({ key, ...v }));

/** One line for the Path: Last imported · Waiting for desktop · an error. Never blocks the Path. */
export function importStatus() {
  const s = snapshot();
  if (!anytypeOn()) return null;
  if (s.setupNeeded) return { tone: 'err', text: 'Anytype sync needs supabase/anytype.sql' };
  if (!s.runs.length && !s.items.length) return null;
  const live = s.connectors.filter((c) => !c.revoked_at);
  const seen = Math.max(0, ...live.map((c) => Date.parse(c.last_seen_at || 0) || 0));
  const success = Math.max(0, ...s.runs.map((r) => Date.parse(r.last_success_at || 0) || 0));
  const bad = s.runs.find((r) => r.status && !['ok', 'never'].includes(r.status));
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  if (!live.length) return { tone: 'err', text: 'Anytype connector disconnected — showing the last import' };
  if (bad) return { tone: 'err', text: `Anytype: ${STATUS[bad.status] || bad.status}${success ? ` · last good import ${ago(success)}` : ''}` };
  if (Date.now() - seen > 12 * 60_000) return { tone: 'wait', text: `Waiting for desktop${success ? ` · last imported ${ago(success)}` : ''}` };
  return { tone: 'ok', text: success ? `Last imported ${ago(success)}` : 'Connected — first import pending' };
}
export const STATUS = {
  error: 'import failed', missing_section: 'the section heading is missing', no_access: 'access to Anytype was revoked',
  partial: 'Anytype returned a partial read', too_many: 'too many items in the source', anytype_closed: 'Anytype isn’t running on the PC',
  stale: 'the mapping changed — waiting for a fresh read', unsupported: 'unsupported source', never: 'not run yet', ok: 'OK',
};

/* ---------------- checkmarks (Architect's, never Anytype's) ---------------- */
let confirmed = null;
const checksMap = () => (confirmed ||= store.get(K.checks(), {}) || {});
const pendingList = () => store.get(K.pending(), []) || [];

async function loadChecks() {
  const since = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
  const rows = await api.db.select('anytype_checks', { columns: 'item_key,day,done,updated_at', filters: { day: { gt: since } } });
  const m = {};
  for (const r of rows) m[`${r.item_key}|${r.day}`] = { done: !!r.done, at: Date.parse(r.updated_at) || 0 };
  confirmed = m;
  store.set(K.checks(), m);
}

/** { done, pending } for an imported item on an Architect day. With two-way sync, Anytype's own checkbox
 *  counts too: a change made in Anytype during this Architect day wins over an older Architect check.
 *  dayOf(ms) → the Architect day key of a moment. */
export function checkOf(key, day, { item = null, dayOf = null } = {}) {
  const p = pendingList().filter((x) => x.key === key && x.day === day).pop();
  if (p) return { done: !!p.done, pending: true };
  const c = checksMap()[`${key}|${day}`];
  const f = item?.fields;
  if (f && typeof f.done === 'boolean' && f.done_at && dayOf) {
    const at = Date.parse(f.done_at) || 0;
    if (at && dayOf(at) === day && (!c || at > (c.at || 0))) return { done: f.done, pending: false, fromAnytype: true };
  }
  return { done: !!c?.done, pending: false };
}

let flushing = null;
async function flushChecks() {
  if (flushing) return flushing;
  flushing = (async () => {
    let list = pendingList();
    while (list.length && navigator.onLine !== false) {
      const x = list[0];
      try {
        await api.rpc('anytype_set_check', { item_key: x.key, day: x.day, done: !!x.done });
        const m = checksMap(); m[`${x.key}|${x.day}`] = { done: !!x.done, at: x.at }; store.set(K.checks(), m);
        list = pendingList().filter((y) => !(y.key === x.key && y.day === x.day && y.at === x.at));
        store.set(K.pending(), list);
      } catch (e) { if (missing(e)) { store.set(K.pending(), []); } break; } // offline / server down: keep them queued
    }
  })().finally(() => { flushing = null; emit(); });
  return flushing;
}

/** Tick or untick an imported item for a day: saved on the device at once, sent when possible — and, with
 *  two-way sync, the same checkbox is set in Anytype. */
export function setCheck(key, day, done, it = null) {
  const list = pendingList().filter((x) => !(x.key === key && x.day === day));
  list.push({ key, day, done: !!done, at: Date.now() });
  store.set(K.pending(), list.slice(-500));
  emit();
  flushChecks();
  if (it?.mapping_id && opsReady && !String(key).startsWith('op:')) {
    // replace an unsent check for the same item instead of stacking them
    store.set(K.outbox(), outbox().filter((o) => !(o.op === 'check' && o.item_key === key)));
    queue({ mapping_id: it.mapping_id, item_key: key, op: 'check', payload: { done: !!done } });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (anytypeOn()) { flushChecks(); flushOps(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && anytypeOn()) loadImports(); });
}

/** anytype://object?objectId=…&spaceId=… opens the object in the Anytype app (desktop or phone). */
export const anytypeLink = (it) => `anytype://object?objectId=${encodeURIComponent(it.source_object_id)}&spaceId=${encodeURIComponent(it.source_space_id)}`;
