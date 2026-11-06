// Setpoints: paths you've given a daily time window (e.g. Morning 7:00–13:00).
// Each one runs a countdown while its window is open. A setpoint is "dominated" when every task in it
// is done before its timer ends. Results are logged per setpoint-day in `setpoint_log`; the setpoint-day
// starts with your first setpoint (so a 01:00–07:00 Second Wind belongs to the day before).
import { api } from './api.js';
import { getPref } from './prefs.js';
import { uid } from '../core/util.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const mins = (hhmm) => { const [a, b] = String(hhmm || '').split(':').map(Number); return (a || 0) * 60 + (b || 0); };

/** The window [start, end] ('HH:MM') of a path, or null if it isn't a setpoint. */
export function windowOf(col, times = getPref('pathTimes', {}) || {}) {
  const set = times[col.id];
  if (!set || set.none) return null;
  return [set.start || '00:00', set.end || '00:00'];
}

/** Setpoints in path order. */
export function setpointsOf(columns, times) {
  return [...columns].sort((a, b) => a.position - b.position).filter((c) => windowOf(c, times));
}

const lengthMins = (w) => { const d = (mins(w[1]) - mins(w[0]) + 1440) % 1440; return d || 1440; };

// Start of the setpoint-day, in minutes after midnight: the first setpoint's start.
export function dayStart(columns, times) {
  const first = setpointsOf(columns, times)[0];
  return first ? mins(windowOf(first, times)[0]) : 0;
}

/** Which setpoint-day a moment belongs to. */
export function spDayKey(date, startMins) {
  const m = date.getHours() * 60 + date.getMinutes();
  return keyOf(m < startMins ? new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1) : date);
}

/** Start/end of a setpoint's run within setpoint-day `k`. */
export function occurrence(col, k, startMins, times) {
  const w = windowOf(col, times);
  if (!w) return null;
  const [y, m, d] = k.split('-').map(Number);
  const s = mins(w[0]);
  const base = new Date(y, m - 1, d + (s < startMins ? 1 : 0));
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(s / 60), s % 60);
  return { start, end: new Date(start.getTime() + lengthMins(w) * 60_000) };
}

/** Live state of one setpoint: 'live' (running), 'next' (later today), 'done' (ended today). */
export function stateOf(col, columns, now = new Date(), times) {
  const w = windowOf(col, times);
  if (!w) return null;
  const startMins = dayStart(columns, times);
  const k = spDayKey(now, startMins);
  // Check the current setpoint-day and the one before (a window can spill past the day boundary).
  for (const day of [k, keyOf(new Date(now.getTime() - DAY))]) {
    const o = occurrence(col, day, startMins, times);
    if (o && now >= o.start && now < o.end) return { phase: 'live', day, ...o, left: o.end - now, total: o.end - o.start };
  }
  const o = occurrence(col, k, startMins, times);
  if (now < o.start) return { phase: 'next', day: k, ...o, left: o.end - o.start, until: o.start - now, total: o.end - o.start };
  return { phase: 'done', day: k, ...o, left: 0, total: o.end - o.start };
}

export function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

/* ---------------- Logging ---------------- */

const cache = new Map(); // `${day}|${colId}` → row
let remote = true;

async function upsert(day, col, total, done, of) {
  const key = `${day}|${col.id}`;
  let row = cache.get(key);
  if (row === undefined) {
    const rows = await api.db.select('setpoint_log', { filters: { day, col_id: col.id, user_id: api.auth.current()?.user?.id } });
    row = rows[0] || null;
    cache.set(key, row);
  }
  if (row && row.total === total && row.done === done && row.of === of && row.title === col.title) return;
  const body = { title: col.title, total, done, of };
  if (row) {
    await api.db.update('setpoint_log', row.id, body);
    cache.set(key, { ...row, ...body });
  } else {
    const made = await api.db.insert('setpoint_log', { id: uid(), day, col_id: col.id, ...body });
    cache.set(key, made || { day, col_id: col.id, ...body });
  }
}

/**
 * Record how every running setpoint stands right now. Only runs while a window is open, so finishing
 * tasks after a timer has ended never counts.
 */
export async function logSetpoints(columns, tasks, now = new Date()) {
  if (!remote) return;
  const sps = setpointsOf(columns);
  for (const col of sps) {
    const st = stateOf(col, columns, now);
    if (st?.phase !== 'live') continue;
    const list = tasks.filter((t) => t.column_id === col.id);
    try {
      await upsert(st.day, col, list.length, list.filter((t) => t.done).length, sps.length);
    } catch (e) {
      if (/setpoint_log|relation|does not exist|schema cache/i.test(e?.message || '')) remote = false; // table not created yet
    }
  }
}

/** Summary for one setpoint-day from its log rows. */
export function summarize(rows, fallbackCount = 0) {
  const of = Math.max(fallbackCount, ...rows.map((r) => r.of || 0), rows.length);
  const dominated = rows.filter((r) => r.total > 0 && r.done >= r.total).length;
  return { of, dominated };
}
