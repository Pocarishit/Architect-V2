// Completion Meter: a progress bar cut into weekly slices. Each slice holds the achievements to hit
// that week and a note on how much you evolved. A red marker shows where time is; the dots show what's done.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog, menu } from '../core/ui.js';
import { uid, debounce } from '../core/util.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';
import { api } from '../data/api.js';
import { listShared, createShared, addMember, removeShared, leaveShared, membersOf, nameOf, initial, meId, local, friendlyError } from '../data/shared.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const short = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const COLS = 6, ROWS = 4; // dots per slice

export function mountMeter(root) {
  let meters = [];
  let current = null;   // meter id
  let week = null;      // open slice index
  let loading = true;
  let loadError = null;
  const el = h('div', { class: 'view mtr' });
  root.append(el);

  const fail = (e) => toast(friendlyError(e), { tone: 'error' });
  // Each meter is a shared item; its row rides along (hidden) so saves know where to go.
  const wrap = (row) => { const m = { ...row.data, id: row.id }; Object.defineProperty(m, '_row', { value: row, enumerable: false, writable: true }); return m; };
  const saveMeter = (m) => { if (!m?._row) return; const { id, ...data } = m; m._row.data = data; return api.db.update('shared_items', m._row.id, { data }).catch(fail); };
  const save = () => saveMeter(meter());
  const saveSoon = debounce(save, 600);
  const meter = () => meters.find((m) => m.id === current) || meters[0] || null;

  async function load() {
    await loadPrefs();
    try {
      meters = (await listShared('meter', 'meters')).map(wrap);
      loadError = null;
    } catch (e) { loadError = friendlyError(e); }
    current = getPref('meterOpen', null);
    if (!meters.some((m) => m.id === current)) current = meters[0]?.id || null;
    loading = false;
    const m = meter();
    week = m ? timeInfo(m).weekIdx : null;
    render();
  }

  // Where time is: which week, and how far through the whole meter.
  function timeInfo(m) {
    const start = fromKey(m.start).getTime();
    const end = start + m.weeks * 7 * DAY;
    const now = Date.now();
    const frac = Math.min(1, Math.max(0, (now - start) / (end - start)));
    const weekIdx = now < start ? 0 : Math.min(m.weeks - 1, Math.floor((now - start) / (7 * DAY)));
    return { frac, weekIdx, before: now < start, after: now >= end };
  }
  const slice = (m, i) => (m.slices ||= {})[i] ||= { goals: [], note: '' };
  function totals(m) {
    let all = 0, done = 0;
    for (let i = 0; i < m.weeks; i++) { const g = m.slices?.[i]?.goals || []; all += g.length; done += g.filter((x) => x.done).length; }
    return { all, done, frac: all ? done / all : 0 };
  }

  /* ---------------- Render ---------------- */

  function render() {
    const m = meter();
    el.replaceChildren(
      h('header', { class: 'view-head mt-head' },
        h('h1', { class: 'paths-title mt-title' }, 'Completion Meter'),
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New meter'))),
      loading ? h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')))
        : loadError ? h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, loadError),
          h('p', { class: 'empty-text px-hint' }, 'Meters are shared now — run supabase/nov7.sql again in the Supabase SQL editor.'))
        : !m ? empty()
          : h('div', { class: 'mt-body' },
            meters.length > 1 ? h('div', { class: 'tk-chips' }, meters.map((x) => h('button', {
              class: ['tk-chip', x.id === m.id && 'is-on'], type: 'button',
              onclick: () => { current = x.id; week = timeInfo(x).weekIdx; setPref('meterOpen', x.id); render(); },
            }, x.title || 'Untitled'))) : null,
            overview(m),
            weekPanel(m)));
  }

  const empty = () => h('div', { class: 'cd-empty mt-empty' },
    h('div', { class: 'mt-demo', 'aria-hidden': 'true' }, Array.from({ length: 6 }, (_, i) => h('div', { class: 'mt-slice' }, h('div', { class: 'mt-dots' }, Array.from({ length: COLS * ROWS }, (_, j) => h('i', { class: i < 2 || (i === 2 && j % COLS < 3) ? 'on' : null })))))),
    h('p', {}, 'Pick a start day and how many weeks. Each week becomes a slice to fill with achievements.'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New meter')));

  function overview(m) {
    const t = timeInfo(m);
    const tot = totals(m);
    const start = fromKey(m.start);
    const end = addDays(start, m.weeks * 7 - 1);
    const diff = Math.round((tot.frac - t.frac) * 100);
    return h('section', { class: 'tk-card mt-card' },
      h('header', { class: 'mt-card-top' },
        h('div', {},
          h('span', { class: 'tk-stat-label' }, `${short(start)} → ${short(end)} · ${m.weeks} ${m.weeks === 1 ? 'week' : 'weeks'}`),
          h('h2', { class: 'mt-name' }, m.title || 'Untitled')),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Meter options', onclick: (e) => menu(e.currentTarget, [
          { label: 'Edit', icon: 'edit', onSelect: () => edit(m) },
          { label: 'Share with…', icon: 'users', onSelect: () => share(m) },
          '-',
          m._row?.user_id === meId() || !m._row
            ? { label: 'Delete meter', icon: 'trash', danger: true, onSelect: () => remove(m) }
            : { label: 'Leave meter', icon: 'logout', danger: true, onSelect: () => leave(m) },
        ], { align: 'end' }) }, icon('more', 16))),
      h('div', { class: 'mt-read' },
        readout('Completion', `${Math.round(tot.frac * 100)}`, '%', `${tot.done}/${tot.all} achievements`),
        readout('Time', `${Math.round(t.frac * 100)}`, '%', t.before ? 'Not started' : t.after ? 'Finished' : `Week ${t.weekIdx + 1} of ${m.weeks}`),
        tot.all ? readout('Pace', `${diff > 0 ? '+' : ''}${diff}`, '%', diff >= 0 ? 'Ahead of time' : 'Behind time', diff < 0 ? 'is-behind' : 'is-ahead') : null),
      bar(m, t),
      people(m));
  }

  function people(m) {
    const ids = m._row ? membersOf(m._row) : [meId()];
    return h('div', { class: 'cd-people mt-people' },
      h('div', { class: 'cd-avatars' }, ids.map((id) => h('span', { class: 'tk-av', title: nameOf(id) }, initial(id)))),
      h('span', { class: 'cd-people-label' }, ids.length > 1 ? `${ids.length} building this` : 'Only you'),
      h('button', { class: 'btn sm cd-share', type: 'button', onclick: () => share(m) }, icon('users', 14), h('span', {}, 'Share')));
  }

  async function share(m) {
    if (local()) { toast('Sharing needs Supabase sync.'); return; }
    const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
    const ok = await dialog({
      title: 'Share meter',
      body: h('div', { class: 'stack' },
        h('p', { class: 'px-hint' }, 'They see every week, tick achievements and write in “How we evolved” with you.'),
        h('div', { class: 'cd-avatars is-list' }, membersOf(m._row).map((id) => h('span', { class: 'cd-member' }, h('span', { class: 'tk-av' }, initial(id)), nameOf(id)))),
        input),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    if (!ok || !input.value.trim()) return;
    try { await addMember(m._row, input.value); render(); toast(`Shared with ${input.value.trim().replace(/^@/, '')}`); } catch (e) { fail(e); }
  }

  async function leave(m) {
    if (!(await confirmDialog(`Leave “${m.title}”?`, 'You won’t see it anymore.', { ok: 'Leave' }))) return;
    meters = meters.filter((x) => x.id !== m.id);
    current = meters[0]?.id || null;
    week = meters[0] ? timeInfo(meters[0]).weekIdx : null;
    render();
    try { await leaveShared(m._row); } catch (e) { fail(e); }
  }

  const readout = (label, big, unit, sub, cls) => h('div', { class: ['mt-readout', cls] },
    h('span', { class: 'tk-stat-label' }, label),
    h('span', { class: 'mt-big' }, big, h('small', {}, unit)),
    h('span', { class: 'mt-sub' }, sub));

  // The meter itself: one slice per week, dots lit by that week's achievements, a red line for "now".
  function bar(m, t) {
    const start = fromKey(m.start);
    return h('div', { class: 'mt-bar-wrap' },
      h('div', { class: 'mt-bar', style: { '--n': String(m.weeks) } },
        Array.from({ length: m.weeks }, (_, i) => {
          const g = m.slices?.[i]?.goals || [];
          const done = g.filter((x) => x.done).length;
          const lit = g.length ? Math.round((done / g.length) * COLS * ROWS) : 0;
          const ws = addDays(start, i * 7);
          const past = !t.before && (i < t.weekIdx || t.after);
          const state = g.length && done === g.length ? 'full' : past && g.length ? 'short' : '';
          return h('button', {
            class: ['mt-slice', week === i && 'is-open', i === t.weekIdx && !t.before && !t.after && 'is-now', state && `is-${state}`, past && 'is-past'],
            type: 'button', 'aria-label': `Week ${i + 1}: ${done} of ${g.length} achievements`, 'aria-pressed': String(week === i),
            onclick: () => { week = i; render(); },
          },
            h('div', { class: 'mt-dots' }, Array.from({ length: COLS * ROWS }, (_, j) => {
              // light column by column, bottom to top, left to right
              const col = j % COLS, row = Math.floor(j / COLS);
              const order = col * ROWS + (ROWS - 1 - row);
              return h('i', { class: order < lit ? 'on' : null });
            })),
            h('span', { class: 'mt-slice-label' }, h('b', {}, `W${i + 1}`), h('span', {}, g.length ? `${done}/${g.length}` : short(ws))));
        }),
        !t.before && !t.after ? h('i', { class: 'mt-now', style: { left: `${t.frac * 100}%` }, title: 'Today' }) : null));
  }

  function weekPanel(m) {
    if (week == null || week >= m.weeks) return null;
    const s = slice(m, week);
    const ws = addDays(fromKey(m.start), week * 7);
    const done = s.goals.filter((g) => g.done).length;
    const add = h('input', { class: 'input mt-add-input', placeholder: 'Add an achievement for this week', maxlength: 140, 'aria-label': 'New achievement',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addGoal(m, e.target.value); } } });
    return h('section', { class: 'tk-card mt-week' },
      h('header', { class: 'mt-week-top' },
        h('div', {},
          h('span', { class: 'tk-stat-label' }, `${short(ws)} – ${short(addDays(ws, 6))}`),
          h('h2', { class: 'mt-name' }, `Week ${week + 1}`)),
        h('div', { class: 'mt-week-nav' },
          h('span', { class: 'mt-week-count' }, h('b', {}, String(done)), `/${s.goals.length}`),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Previous week', disabled: week === 0, onclick: () => { week--; render(); } }, icon('chevronLeft', 16)),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Next week', disabled: week === m.weeks - 1, onclick: () => { week++; render(); } }, icon('chevronRight', 16)))),
      h('div', { class: 'mt-cols' },
        h('div', { class: 'mt-goals' },
          h('span', { class: 'tk-stat-label' }, 'Achievements'),
          s.goals.length ? h('ul', { class: 'mt-goal-list' }, s.goals.map((g) => h('li', { class: ['mt-goal', g.done && 'is-done'] },
            h('button', { class: 'pcheck', type: 'button', role: 'checkbox', 'aria-checked': String(!!g.done), 'aria-label': g.done ? 'Mark not done' : 'Mark done',
              onclick: () => { g.done = !g.done; render(); save(); } }, icon('check', 12, { weight: 2.4 })),
            h('span', { class: 'mt-goal-text' }, g.text),
            h('button', { class: 'icon-btn xs mt-goal-del', type: 'button', 'aria-label': 'Remove', onclick: () => { s.goals = s.goals.filter((x) => x.id !== g.id); render(); save(); } }, icon('close', 13)))))
            : h('p', { class: 'tk-talk-empty' }, 'Nothing set for this week yet.'),
          h('div', { class: 'mt-add' }, add,
            h('button', { class: 'icon-btn tk-talk-send', type: 'button', 'aria-label': 'Add achievement', onclick: () => addGoal(m, add.value) }, icon('plus', 16)))),
        h('label', { class: 'mt-evo' },
          h('span', { class: 'tk-stat-label' }, 'How we evolved'),
          h('textarea', { class: 'input', rows: 6, maxlength: 2000, placeholder: 'What changed this week — skills, speed, habits, what you can do now that you couldn’t.', value: s.note || '',
            oninput: (e) => { s.note = e.target.value; saveSoon(); } }))));
  }

  function addGoal(m, text) {
    text = String(text || '').trim();
    if (!text) return;
    slice(m, week).goals.push({ id: uid(), text, done: false });
    render();
    save();
    el.querySelector('.mt-add-input')?.focus();
  }

  async function edit(m) {
    const today = keyOf(new Date());
    const title = h('input', { class: 'input', value: m?.title || '', maxlength: 60, placeholder: 'e.g. Q1 Sprint', 'aria-label': 'Title' });
    const start = h('input', { class: 'input', type: 'date', value: m?.start || today, 'aria-label': 'Start day' });
    const weeks = h('input', { class: 'input', type: 'number', min: '1', max: '52', step: '1', value: String(m?.weeks || 6), 'aria-label': 'Weeks' });
    const ok = await dialog({
      title: m ? 'Edit meter' : 'New meter',
      body: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
        h('div', { class: 'ptime-fields' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Start day'), start),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Slices (weeks)'), weeks))),
      actions: [{ label: 'Cancel', value: false }, { label: m ? 'Save' : 'Create', primary: true, value: true }],
    });
    if (!ok) return;
    const n = Math.max(1, Math.min(52, Math.round(Number(weeks.value) || 1)));
    const body = { title: title.value.trim() || 'Untitled', start: start.value || today, weeks: n };
    if (m) {
      Object.assign(m, body);
      if (week != null && week >= n) week = n - 1;
      render();
      save();
    } else {
      try {
        const made = wrap(await createShared('meter', { ...body, slices: {} }));
        meters.push(made);
        current = made.id;
        setPref('meterOpen', made.id);
        week = timeInfo(made).weekIdx;
        render();
      } catch (e) { fail(e); }
    }
  }

  async function remove(m) {
    if (!(await confirmDialog(`Delete “${m.title}”?`, 'Its weeks, achievements and notes go with it.', { ok: 'Delete' }))) return;
    meters = meters.filter((x) => x.id !== m.id);
    current = meters[0]?.id || null;
    week = meters[0] ? timeInfo(meters[0]).weekIdx : null;
    render();
    try { await removeShared(m._row); } catch (e) { fail(e); }
  }

  render();
  load();
  // Move the "now" marker along as the day goes.
  const tick = setInterval(() => {
    const m = meter();
    if (!m || loading) return;
    const n = el.querySelector('.mt-now');
    if (n) n.style.left = `${timeInfo(m).frac * 100}%`;
  }, 60_000);
  const poll = setInterval(async () => {
    if (document.hidden || loading || loadError || document.querySelector('.dlg')) return;
    if (el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    try { meters = (await listShared('meter')).map(wrap); render(); } catch {}
  }, 30_000);
  return { destroy() { clearInterval(tick); clearInterval(poll); saveSoon.flush?.(); el.remove(); } };
}
