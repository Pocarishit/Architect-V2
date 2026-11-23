// Anytype sync — the app side (Nov 23b, "Anytype sync for Architect" runbook).
// The phone and the desktop read the same private imports from Architect's backend after sign-in; neither
// ever talks to Anytype or to the Windows PC. The connector on the PC (connector/) does the reading.
//
//   · imports    anytype_items (read-only here), cached on the device as the last-good snapshot, so Path
//                still shows them offline or while the PC is asleep.
//   · checkmarks anytype_checks — Architect owns them, per Architect day. Saved on the device first, then
//                sent; while unsent they show as pending (never as synced) and survive a reload.
//   · status     anytype_runs + anytype_connectors → "Last imported…", "Waiting for desktop", or the error.
// Off by default (Settings → Integrations): production imports stay disabled until you turn them on.
import { api, configured } from './api.js';
import { getPref } from './prefs.js';
import { store } from '../core/util.js';

const me = () => api.auth.current()?.user?.id || 'anon';
const K = {
  snap: () => `architect.ax.snap.${me()}`,      // { items, runs, connectors, at }
  checks: () => `architect.ax.checks.${me()}`,  // { 'key|day': { done, at } } — what the server confirmed
  pending: () => `architect.ax.pending.${me()}`, // [{ key, day, done, at }] — not sent yet
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
      const [items, runs, connectors] = await Promise.all([
        api.db.select('anytype_items', { columns: 'key,mapping_id,dest_kind,dest_id,source_space_id,source_object_id,fields,sort,archived,updated_at', filters: { archived: false }, order: 'sort.asc' }),
        api.db.select('anytype_runs', { columns: 'mapping_id,status,message,last_attempt_at,last_success_at,item_count' }),
        api.db.select('anytype_connectors', { columns: 'id,name,last_seen_at,revoked_at' }),
      ]);
      snap = { items, runs, connectors, at: Date.now() };
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

/** Imported items for one Path column on a given Architect day (undated items show every day). */
export function importsFor(colId, day) {
  if (!anytypeOn()) return [];
  return snapshot().items.filter((it) => it.dest_kind === 'path' && it.dest_id === colId && !it.archived && (!it.fields?.date || it.fields.date === day));
}

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

/** { done, pending } for an imported item on an Architect day. */
export function checkOf(key, day) {
  const p = pendingList().filter((x) => x.key === key && x.day === day).pop();
  if (p) return { done: !!p.done, pending: true };
  return { done: !!checksMap()[`${key}|${day}`]?.done, pending: false };
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

/** Tick or untick an imported item for a day: saved on the device at once, sent when possible. */
export function setCheck(key, day, done) {
  const list = pendingList().filter((x) => !(x.key === key && x.day === day));
  list.push({ key, day, done: !!done, at: Date.now() });
  store.set(K.pending(), list.slice(-500));
  emit();
  flushChecks();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (anytypeOn()) flushChecks(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && anytypeOn()) loadImports(); });
}

/** anytype://object?objectId=…&spaceId=… opens the object in the Anytype app (desktop or phone). */
export const anytypeLink = (it) => `anytype://object?objectId=${encodeURIComponent(it.source_object_id)}&spaceId=${encodeURIComponent(it.source_space_id)}`;
