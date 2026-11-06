// Tracker: one entry per day across the metrics you choose (hours worked, money made, outreach…).
// The calendar shows effort as rings that fill toward each day's goal; a streak counts days in a row.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog } from '../core/ui.js';
import { uid, debounce, plural } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DEFAULT_METRICS = [
  { id: 'hours', name: 'Hours worked', unit: 'h', goal: 6, step: 0.5 },
  { id: 'money', name: 'Money made', unit: '$', goal: 0, step: 10, prefix: true },
  { id: 'outreach', name: 'Outreach', unit: 'people', goal: 20, step: 1 },
];

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayKey = () => keyOf(new Date());
const mondayIndex = (d) => (d.getDay() + 6) % 7;

function fmtVal(m, v) {
  if (v == null || v === '' || Number.isNaN(v)) return '—';
  const n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
  if (m.prefix) return `${m.unit}${n}`;
  return m.unit ? `${n}${m.unit.length <= 2 ? '' : ' '}${m.unit}` : n;
}

export function mountTracker(root) {
  let metrics = [];
  let days = new Map();         // 'YYYY-MM-DD' → { id, day, vals, note }
  let loading = true;
  let loadError = null;
  let cursor = new Date();      // month on screen
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  let picked = todayKey();      // day open in the log panel
  let focus = 'all';            // 'all' or a metric id — what the rings show

  const el = h('div', { class: 'view tracker' });
  root.append(el);

  async function load() {
    try {
      await loadPrefs();
      metrics = getPref('trackerMetrics', null) || DEFAULT_METRICS.map((m) => ({ ...m }));
      focus = getPref('trackerFocus', 'all') || 'all';
      if (focus !== 'all' && !metrics.some((m) => m.id === focus)) focus = 'all';
      const rows = await api.db.select('streak_days', { order: 'day.asc' });
      days = new Map(rows.map((r) => [String(r.day).slice(0, 10), { ...r, day: String(r.day).slice(0, 10), vals: r.vals || {} }]));
    } catch (e) {
      loadError = friendlyError(e);
    }
    loading = false;
    render();
  }

  /* ---------------- Scoring ---------------- */

  const val = (k, mid) => Number(days.get(k)?.vals?.[mid]) || 0;
  const active = (k) => metrics.some((m) => val(k, m.id) > 0) || !!days.get(k)?.note?.trim();
  // 0…1: how close the day came to its goals (for one metric, or the average across goals).
  function score(k, which = focus) {
    if (which !== 'all') {
      const m = metrics.find((x) => x.id === which);
      if (!m) return 0;
      const v = val(k, m.id);
      return m.goal > 0 ? Math.min(1, v / m.goal) : (v > 0 ? 1 : 0);
    }
    const goals = metrics.filter((m) => m.goal > 0);
    if (!goals.length) return active(k) ? 1 : 0;
    const s = goals.reduce((a, m) => a + Math.min(1, val(k, m.id) / m.goal), 0) / goals.length;
    return s || (active(k) ? 0.08 : 0);
  }
  const raw = (k) => (focus === 'all' ? score(k, 'all') : val(k, focus));
  const improved = (k) => active(k) && raw(k) > raw(keyOf(addDays(fromKey(k), -1))) && active(keyOf(addDays(fromKey(k), -1)));

  function streakInfo() {
    const t = new Date();
    let d = active(keyOf(t)) ? t : addDays(t, -1);
    let current = 0;
    while (active(keyOf(d))) { current++; d = addDays(d, -1); }
    let best = 0, run = 0, prev = null;
    const keys = [...days.keys()].filter(active).sort();
    for (const k of keys) {
      run = prev && keyOf(addDays(fromKey(prev), 1)) === k ? run + 1 : 1;
      best = Math.max(best, run);
      prev = k;
    }
    // Weeks in a row (Mon–Sun) with at least one active day, counting this week if it already has one.
    let weeks = 0;
    let wk = addDays(t, -mondayIndex(t));
    const weekActive = (start) => Array.from({ length: 7 }, (_, i) => keyOf(addDays(start, i))).some(active);
    if (!weekActive(wk)) wk = addDays(wk, -7);
    while (weekActive(wk)) { weeks++; wk = addDays(wk, -7); }
    return { current, best: Math.max(best, current), total: keys.length, weeks, todayDone: active(keyOf(t)) };
  }

  /* ---------------- Rendering ---------------- */

  function render() {
    el.replaceChildren(header(), loading ? loader() : loadError ? errorView() : main());
  }

  const loader = () => h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  const errorView = () => h('div', { class: 'empty' },
    h('p', { class: 'empty-text' }, loadError),
    h('p', { class: 'empty-text tk-hint' }, 'The tracker needs the new tables — re-run supabase/schema.sql in the Supabase SQL editor.'),
    h('button', { class: 'btn', onclick: () => { loading = true; loadError = null; render(); load(); } }, 'Try again'));

  function header() {
    return h('header', { class: 'view-head tk-head' },
      h('h1', { class: 'paths-title tk-title' }, 'Tracker'),
      h('div', { class: 'tk-head-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: editMetrics }, icon('edit', 14), h('span', {}, 'Metrics'))));
  }

  function main() {
    const s = streakInfo();
    return h('div', { class: 'tk-layout' },
      calCard(s),
      h('div', { class: 'tk-side' }, dayPanel(s), trends()));
  }

  const calCard = (s) => h('section', { class: 'tk-card tk-cal-card' }, calendarHead(s), focusChips(), calendar(s));

  function scoreBadge(k) {
    const sc = score(k, 'all');
    return h('div', { class: ['tk-log-score', sc >= 1 && 'is-goal'], style: { '--p': String(sc) }, title: 'Goal progress' },
      h('span', {}, `${Math.round(sc * 100)}`), h('small', {}, '%'));
  }

  // A blur → change can fire between mousedown and click; refreshing then would swap out
  // whatever was being clicked. So wait for the pointer to come back up.
  let pressing = false, deferred = false;
  const onDown = () => { pressing = true; };
  const onUp = () => { pressing = false; if (deferred) { deferred = false; setTimeout(refreshAround, 0); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);

  // Refresh everything except the inputs being typed into.
  function refreshAround() {
    if (loading || loadError) return;
    if (pressing) { deferred = true; return; }
    const s = streakInfo();
    el.querySelector('.tk-cal-card')?.replaceWith(calCard(s));
    el.querySelector('.tk-trends')?.replaceWith(trends());
    el.querySelector('.tk-log-score')?.replaceWith(scoreBadge(picked));
    const warn = el.querySelector('.tk-warn');
    if (warn && s.todayDone) warn.remove();
    metrics.forEach((m) => fieldRefs.get(m.id)?.update());
  }

  function calendarHead(s) {
    return h('div', { class: 'tk-cal-head' },
      h('div', { class: 'tk-month' },
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Previous month', onclick: () => shiftMonth(-1) }, icon('chevronLeft', 16)),
        h('h2', {}, `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Next month', onclick: () => shiftMonth(1) }, icon('chevronRight', 16))),
      h('div', { class: 'tk-stats' },
        stat('Your streak', plural(s.current, 'day')),
        stat('Week streak', plural(s.weeks, 'week')),
        stat('Best', plural(s.best, 'day')),
        stat('Active days', String(s.total))));
  }

  const stat = (label, value) => h('div', { class: 'tk-stat' }, h('span', { class: 'tk-stat-label' }, label), h('span', { class: 'tk-stat-val' }, value));

  function focusChips() {
    const chip = (id, label) => h('button', {
      class: ['tk-chip', focus === id && 'is-on'], type: 'button', 'aria-pressed': String(focus === id),
      onclick: () => { focus = id; setPref('trackerFocus', id); render(); },
    }, label);
    return h('div', { class: 'tk-chips', role: 'group', 'aria-label': 'Show on calendar' },
      chip('all', 'Overall'), metrics.map((m) => chip(m.id, m.name)));
  }

  function calendar(s) {
    const first = cursor;
    const lead = mondayIndex(first);
    const start = addDays(first, -lead);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const weeks = Math.ceil((lead + last.getDate()) / 7);
    const tk = todayKey();
    const cells = [];
    const rail = [];
    let currentWeekRow = -1;
    for (let w = 0; w < weeks; w++) {
      let count = 0, possible = 0;
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, w * 7 + d);
        const k = keyOf(date);
        const inMonth = date.getMonth() === first.getMonth();
        const future = k > tk;
        if (k === tk) currentWeekRow = w;
        if (!future) { possible++; if (active(k)) count++; }
        cells.push(dayCell(date, k, { inMonth, future, today: k === tk }));
      }
      rail.push({ count, possible, full: count === 7 });
    }
    const showFlame = currentWeekRow >= 0;
    return h('div', { class: 'tk-cal', style: { '--weeks': String(weeks) } },
      WD.map((d) => h('span', { class: 'tk-wd' }, d)),
      h('span', { class: 'tk-wd' }),
      cells,
      h('div', { class: 'tk-rail', style: { gridRow: `2 / span ${weeks}` } },
        rail.map((r, i) => {
          if (showFlame && i === currentWeekRow) {
            return h('div', { class: ['tk-rail-mark', 'is-flame', !s.todayDone && 'is-pending'], title: s.todayDone ? `${plural(s.current, 'day')} in a row` : 'Log today to keep your streak' },
              icon('flame', 16), h('b', {}, String(s.current)));
          }
          if (r.full) return h('div', { class: 'tk-rail-mark is-full', title: 'Every day this week' }, icon('check', 12, { weight: 2.6 }));
          if (r.count) return h('div', { class: 'tk-rail-mark is-part', title: `${r.count} of ${r.possible || 7} days` }, String(r.count));
          return h('div', { class: 'tk-rail-mark is-empty' });
        })));
  }

  function dayCell(date, k, { inMonth, future, today }) {
    const on = active(k);
    const sc = on ? score(k) : 0;
    const missed = !future && !on && inMonth && !today;
    return h('button', {
      class: ['tk-day', !inMonth && 'is-out', future && 'is-future', today && 'is-today', on && 'is-on', sc >= 1 && 'is-goal', missed && 'is-missed', picked === k && 'is-picked'],
      type: 'button',
      style: { '--p': String(sc) },
      'aria-label': `${date.toDateString()}${on ? `, ${Math.round(sc * 100)}% of goal` : future ? '' : ', nothing logged'}`,
      disabled: future,
      onclick: () => { picked = k; render(); },
    },
      h('span', { class: 'tk-day-ring' }),
      h('span', { class: 'tk-day-num' }, String(date.getDate())),
      on && improved(k) ? h('i', { class: 'tk-day-up', title: 'Better than the day before' }) : null);
  }

  function dayPanel(s) {
    const k = picked;
    const d = fromKey(k);
    const yk = keyOf(addDays(d, -1));
    const isToday = k === todayKey();
    const entry = days.get(k);
    const label = isToday ? 'Today' : k === keyOf(addDays(new Date(), -1)) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    fieldRefs.clear();
    return h('section', { class: 'tk-card tk-log' },
      h('header', { class: 'tk-log-head' },
        h('div', {},
          h('span', { class: 'tk-stat-label' }, d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })),
          h('h2', { class: 'tk-log-title' }, label)),
        scoreBadge(k)),
      isToday && !s.todayDone && s.current > 0
        ? h('p', { class: 'tk-warn' }, h('i'), `Log something today to keep your ${plural(s.current, 'day')} streak.`)
        : null,
      h('div', { class: 'tk-fields' }, metrics.map((m) => field(m, k, yk))),
      h('label', { class: 'tk-note' },
        h('span', { class: 'tk-stat-label' }, 'Note — what worked, what to fix'),
        h('textarea', { rows: 2, class: 'input', 'data-metric': '__note', placeholder: 'One line for tomorrow’s you', value: entry?.note || '', oninput: (e) => setNote(k, e.target.value) })));
  }

  const fieldRefs = new Map();

  function field(m, k, yk) {
    const v = days.get(k)?.vals?.[m.id];
    const delta = h('span', { class: 'tk-delta' });
    const bar = m.goal > 0 ? h('div', { class: 'tk-goal-bar' }) : null;
    const update = () => {
      const cur = val(k, m.id);
      const y = val(yk, m.id);
      const diff = cur - y;
      delta.className = ['tk-delta', diff > 0 && 'is-up', diff < 0 && 'is-down'].filter(Boolean).join(' ');
      delta.textContent = y || cur ? (diff === 0 ? 'Same as yesterday' : `${diff > 0 ? '▲' : '▼'} ${fmtVal(m, Math.abs(diff))} vs yesterday`) : '';
      bar?.style.setProperty('--p', String(Math.min(1, cur / m.goal)));
    };
    fieldRefs.set(m.id, { update });
    const input = h('input', {
      class: 'tk-input', type: 'number', inputmode: 'decimal', step: 'any', min: '0',
      value: v == null ? '' : String(v), placeholder: '0', 'data-metric': m.id, 'aria-label': m.name,
      oninput: (e) => setVal(k, m.id, e.target.value, false),
      onchange: (e) => setVal(k, m.id, e.target.value, true),
    });
    const bump = (dir) => {
      const next = Math.max(0, Math.round(((Number(input.value) || 0) + dir * (m.step || 1)) * 100) / 100);
      input.value = String(next);
      setVal(k, m.id, next, true);
    };
    update();
    return h('div', { class: 'tk-field' },
      h('div', { class: 'tk-field-top' }, h('span', { class: 'tk-field-name' }, m.name), delta),
      h('div', { class: 'tk-field-row' },
        h('button', { class: 'tk-step', type: 'button', 'aria-label': `Less ${m.name}`, onclick: () => bump(-1) }, icon('minus', 14)),
        h('label', { class: 'tk-input-wrap' }, m.prefix ? h('span', { class: 'tk-unit' }, m.unit) : null, input, !m.prefix && m.unit ? h('span', { class: 'tk-unit' }, m.unit) : null),
        h('button', { class: 'tk-step', type: 'button', 'aria-label': `More ${m.name}`, onclick: () => bump(1) }, icon('plus', 14))),
      bar ? h('div', { class: 'tk-goal' }, bar, h('span', {}, `Goal ${fmtVal(m, m.goal)}`)) : null);
  }

  // Last 14 days per metric as dot-matrix columns, with the 7-day average and personal best.
  function trends() {
    const t = new Date();
    const range = Array.from({ length: 14 }, (_, i) => keyOf(addDays(t, i - 13)));
    return h('section', { class: 'tk-card tk-trends' },
      h('header', { class: 'tk-trends-head' }, h('h2', { class: 'tk-section-title' }, 'Last 14 days'), h('span', { class: 'tk-stat-label' }, 'Better than yesterday')),
      metrics.map((m) => {
        const vals = range.map((k) => val(k, m.id));
        const max = Math.max(m.goal || 0, ...vals, 1);
        const last7 = vals.slice(-7);
        const avg = last7.reduce((a, b) => a + b, 0) / 7;
        const best = Math.max(0, ...[...days.keys()].map((k) => val(k, m.id)));
        const total = [...days.keys()].filter((k) => k.startsWith(keyOf(cursor).slice(0, 7))).reduce((a, k) => a + val(k, m.id), 0);
        return h('button', { class: ['tk-trend', focus === m.id && 'is-on'], type: 'button', onclick: () => { focus = focus === m.id ? 'all' : m.id; setPref('trackerFocus', focus); render(); } },
          h('div', { class: 'tk-trend-top' },
            h('span', { class: 'tk-field-name' }, m.name),
            h('span', { class: 'tk-trend-total' }, fmtVal(m, total)), h('span', { class: 'tk-stat-label' }, MONTHS[cursor.getMonth()].slice(0, 3))),
          h('div', { class: 'tk-bars', 'aria-hidden': 'true' },
            vals.map((v, i) => {
              const lit = Math.round((v / max) * 8);
              return h('div', { class: ['tk-bar', range[i] === todayKey() && 'is-today'] },
                Array.from({ length: 8 }, (_, j) => h('i', { class: 7 - j < lit ? 'on' : null })));
            })),
          h('div', { class: 'tk-trend-foot' },
            h('span', {}, `7-day avg ${fmtVal(m, avg)}`),
            h('span', {}, `Best ${fmtVal(m, best)}`)));
      }));
  }

  function shiftMonth(dir) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
    render();
  }

  /* ---------------- Saving ---------------- */

  const chains = new Map();
  const timers = new Map();

  function entryFor(k) {
    let e = days.get(k);
    if (!e) { e = { id: uid(), day: k, vals: {}, note: '', _new: true }; days.set(k, e); }
    return e;
  }

  function setVal(k, mid, raw, now) {
    const e = entryFor(k);
    const n = raw === '' || raw == null ? null : Math.max(0, Number(raw));
    if (n == null || Number.isNaN(n)) delete e.vals[mid]; else e.vals[mid] = n;
    queueSave(k, now ? 0 : 600);
    if (now) { softRefresh.cancel(); refreshAround(); }
    else softRefresh();
  }

  function setNote(k, text) {
    entryFor(k).note = text;
    queueSave(k, 700);
    softRefresh();
  }

  // Catch the rings and streaks up a moment after typing stops.
  const softRefresh = debounce(refreshAround, 450);

  function queueSave(k, ms) {
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => {
      timers.delete(k);
      const prev = chains.get(k) || Promise.resolve();
      const next = prev.then(() => persist(k)).catch((e) => toast(`Not saved — ${friendlyError(e)}`, { tone: 'error', ms: 5000 }));
      chains.set(k, next);
    }, ms));
  }

  async function persist(k) {
    const e = days.get(k);
    if (!e) return;
    const body = { vals: { ...e.vals }, note: e.note || '' };
    if (e._new) {
      const row = await api.db.insert('streak_days', { id: e.id, day: k, ...body });
      delete e._new;
      if (row?.id) e.id = row.id;
    } else {
      await api.db.update('streak_days', e.id, body);
    }
  }

  const flushAll = () => { for (const [k, t] of timers) { clearTimeout(t); timers.delete(k); persist(k).catch(() => {}); } };

  /* ---------------- Metrics editor ---------------- */

  async function editMetrics() {
    let list = metrics.map((m) => ({ ...m }));
    const rows = h('div', { class: 'tk-medit' });
    const paint = () => rows.replaceChildren(
      h('div', { class: 'tk-medit-row is-head' }, h('span', {}, 'Name'), h('span', {}, 'Unit'), h('span', {}, 'Daily goal'), h('span', {})),
      ...list.map((m, i) => h('div', { class: 'tk-medit-row' },
        h('input', { class: 'input', value: m.name, maxlength: 28, 'aria-label': 'Metric name', placeholder: 'e.g. Calls made', oninput: (e) => { m.name = e.target.value; } }),
        h('input', { class: 'input', value: m.unit || '', maxlength: 10, 'aria-label': 'Unit', placeholder: 'h, $, calls', oninput: (e) => { m.unit = e.target.value.trim(); m.prefix = /^[$€£¥₱₹]$/.test(m.unit); } }),
        h('input', { class: 'input', type: 'number', min: '0', step: 'any', value: m.goal ? String(m.goal) : '', 'aria-label': 'Daily goal', placeholder: 'None', oninput: (e) => { m.goal = Math.max(0, Number(e.target.value) || 0); } }),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `Remove ${m.name}`, disabled: list.length <= 1, onclick: () => { list.splice(i, 1); paint(); } }, icon('trash', 15)))),
      h('button', { class: 'btn sm tk-medit-add', type: 'button', onclick: () => { list.push({ id: uid().slice(0, 8), name: '', unit: '', goal: 0, step: 1 }); paint(); rows.querySelector('.tk-medit-row:last-of-type input')?.focus(); } }, icon('plus', 14), h('span', {}, 'Add metric')));
    paint();
    const ok = await dialog({
      title: 'Tracker metrics',
      width: 560,
      body: h('div', { class: 'stack' }, h('p', { class: 'tk-hint' }, 'What counts as effort for you. A goal fills the day’s ring; without one, any amount counts.'), rows),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save metrics', primary: true, value: true }],
    });
    if (!ok) return;
    const removed = metrics.filter((m) => !list.some((x) => x.id === m.id));
    if (removed.some((m) => [...days.values()].some((d) => d.vals?.[m.id]))) {
      const sure = await confirmDialog('Remove metrics?', `${removed.map((m) => m.name).join(', ')} will be hidden. Logged numbers stay saved and come back if you add the metric again with the same name.`, { ok: 'Remove' });
      if (!sure) return;
    }
    list = list.filter((m) => m.name.trim()).map((m) => ({ ...m, name: m.name.trim(), step: m.step || (m.unit === 'h' ? 0.5 : 1) }));
    // Re-adding a removed metric by name brings its history back.
    const old = getPref('trackerArchived', []) || [];
    list = list.map((m) => { const prev = [...old, ...removed].find((x) => x.name.toLowerCase() === m.name.toLowerCase() && !metrics.some((y) => y.id === m.id)); return prev ? { ...m, id: prev.id } : m; });
    if (!list.length) return;
    metrics = list;
    if (focus !== 'all' && !metrics.some((m) => m.id === focus)) focus = 'all';
    await setPref('trackerArchived', [...old.filter((o) => !metrics.some((m) => m.id === o.id)), ...removed]);
    await setPref('trackerMetrics', metrics);
    render();
  }

  render();
  load();

  return {
    destroy() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      softRefresh.cancel();
      flushAll();
      el.remove();
    },
  };
}
