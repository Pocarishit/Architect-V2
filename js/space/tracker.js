// Tracker & Weekly — one widget, two views.
//   Calendar: a day turns "tried" once someone logs 3+ attempts (with a result) on the Ticket board.
//             Click a day to see exactly which attempts counted.
//   Weeks:    8 squares = 8 weeks toward the next environment. Click a week for its achievements.
// The weekly plan lives on the widget itself, so everyone in the Space sees and edits the same one.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { popover, closeFloating } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api } from '../data/api.js';
import { avatarsFor } from '../data/profile.js';

const DAY = 86_400_000;
const NEED = 3; // attempts that make a day count
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const OUT = { failed: 'Failed', partial: 'Partly', worked: 'Worked' };
const short = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function mountTrackerWidget(root, el0, w) {
  const me = api.auth.current()?.user;
  let el = el0;
  const memKey = `architect.tw.${el.id}`;
  const mem = store.get(memKey, {});
  let view = mem.view || 'calendar';           // per person, not shared
  let who = mem.who || me?.id;
  let month = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
  let openWeek = null;
  let people = [{ user_id: me?.id, username: me?.username || 'you' }];
  let faces = new Map();
  let attempts = [];
  let loadedRange = '';
  let loading = true;
  let error = null;
  const remember = () => store.set(memKey, { view, who });

  const box = h('div', { class: 'tw' });
  root.append(box);

  /* ---------- data ---------- */
  async function loadPeople() {
    if (api.mode === 'local' || !w.spaceId) return;
    try {
      const rows = (await api.rpc('board_people', { b: w.spaceId })) || [];
      if (rows.length) people = rows.map((r) => ({ user_id: r.user_id, username: r.username }));
      faces = await avatarsFor(people.map((p) => p.user_id));
      render();
    } catch {}
  }

  async function loadAttempts(force = false) {
    const from = new Date(month.getFullYear(), month.getMonth() - 1, 20);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 12);
    const range = `${keyOf(from)}|${keyOf(to)}`;
    if (!force && range === loadedRange) return;
    loadedRange = range;
    try {
      attempts = await fetchAttempts(from, to);
      error = null;
    } catch (e) { error = e?.message || 'Couldn’t load attempts.'; }
    loading = false;
    render();
  }

  async function fetchAttempts(from, to) {
    if (api.mode !== 'local') {
      try { return (await api.rpc('space_attempts', { since: from.toISOString(), until: to.toISOString() })) || []; }
      catch { /* space.sql not run yet: fall back to what you can read */ }
    }
    const [msgs, tickets] = await Promise.all([
      api.db.select('parasite_messages', { filters: { kind: 'attempt' } }),
      api.db.select('parasites', { columns: 'id,title,no,created_at' }).catch(() => []),
    ]);
    const order = [...tickets].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const byId = new Map(tickets.map((t) => [t.id, t]));
    return msgs.filter((m) => m.outcome && m.created_at >= from.toISOString() && m.created_at < to.toISOString()).map((m) => {
      const t = byId.get(m.parasite_id);
      return { id: m.id, user_id: m.user_id, created_at: m.created_at, outcome: m.outcome, body: m.body, ticket_id: m.parasite_id,
        ticket_no: t?.no || order.indexOf(t) + 1, ticket_title: t?.title || 'Ticket' };
    });
  }

  const dayMap = () => {
    const m = new Map();
    for (const a of attempts) {
      if (a.user_id !== who || !a.outcome) continue;
      const k = keyOf(new Date(a.created_at));
      (m.get(k) || m.set(k, []).get(k)).push(a);
    }
    return m;
  };

  /* ---------- render ---------- */
  function render(force = false) {
    const active = box.contains(document.activeElement) ? document.activeElement : null;
    if (!force && active?.matches('input, textarea')) { render.pending = true; return; }
    render.pending = false;
    const refocusAdd = !!active?.closest('.tw-add');
    box.replaceChildren(
      h('div', { class: 'tw-top' },
        h('div', { class: 'seg seg-sm tw-views', role: 'tablist' },
          [['calendar', 'Tracker'], ['weeks', 'Weekly']].map(([id, label]) => h('button', {
            type: 'button', role: 'tab', class: view === id ? 'is-on' : null, 'aria-selected': String(view === id),
            onclick: () => { view = id; openWeek = null; remember(); render(); },
          }, label))),
        view === 'calendar' ? peoplePicker() : null),
      view === 'calendar' ? calendar() : openWeek ? weekDetail(openWeek) : weeks());
    if (refocusAdd) box.querySelector('.tw-add input')?.focus();
  }

  function peoplePicker() {
    if (people.length < 2) return null;
    return h('div', { class: 'tw-people' }, people.map((p) => h('button', {
      type: 'button', class: ['tw-person', p.user_id === who && 'is-on'], title: p.username, 'aria-label': `Show ${p.username}`, 'aria-pressed': String(p.user_id === who),
      onclick: () => { who = p.user_id; remember(); render(); },
    }, faces.get(p.user_id) ? h('img', { src: faces.get(p.user_id), alt: '' }) : h('b', {}, (p.username || '?').slice(0, 1).toUpperCase()))));
  }

  function calendar() {
    const days = dayMap();
    const today = keyOf(new Date());
    const first = mondayOf(month);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      if (i >= 35 && d.getMonth() !== month.getMonth()) break;
      const k = keyOf(d);
      const n = (days.get(k) || []).length;
      const tried = n >= NEED;
      cells.push(h('button', {
        type: 'button',
        class: ['tw-day', d.getMonth() !== month.getMonth() && 'is-out', k === today && 'is-today', k > today && 'is-future', tried && 'is-tried', !tried && n && `is-p${Math.min(n, NEED - 1)}`],
        'aria-label': `${d.toDateString()}: ${n} attempt${n === 1 ? '' : 's'}${tried ? ', tried' : ''}`,
        onclick: (e) => dayPopup(e.currentTarget, d, days.get(k) || []),
      }, h('span', { class: 'tw-num' }, String(d.getDate())), tried ? h('i', { class: 'tw-mark', 'aria-hidden': 'true' }) : null));
    }
    // Month stats + current streak of tried days.
    const inMonth = [...days.entries()].filter(([k]) => parseKey(k).getMonth() === month.getMonth() && parseKey(k).getFullYear() === month.getFullYear());
    const triedDays = inMonth.filter(([, list]) => list.length >= NEED).length;
    const total = inMonth.reduce((n, [, list]) => n + list.length, 0);
    let streak = 0;
    for (let d = new Date(); ; d = new Date(d.getTime() - DAY)) {
      const n = (days.get(keyOf(d)) || []).length;
      if (n >= NEED) streak++;
      else if (keyOf(d) !== today) break; // today can still be earned
      if (streak > 400) break;
    }
    const name = people.find((p) => p.user_id === who)?.username || 'you';
    return h('div', { class: 'tw-cal' },
      h('div', { class: 'tw-month' },
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Previous month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); loadAttempts(); } }, icon('chevronLeft', 16)),
        h('span', { class: 'tw-month-name' }, month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Next month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); loadAttempts(); } }, icon('chevronRight', 16))),
      h('div', { class: 'tw-dow', 'aria-hidden': 'true' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => h('span', {}, x))),
      h('div', { class: ['tw-grid', loading && 'is-loading'] }, cells),
      error ? h('p', { class: 'tw-note is-error' }, error) : null,
      h('div', { class: 'tw-stats' },
        h('div', {}, h('b', {}, String(triedDays)), h('span', {}, 'Tried days')),
        h('div', {}, h('b', {}, String(streak)), h('span', {}, 'Streak')),
        h('div', {}, h('b', {}, String(total)), h('span', {}, 'Attempts'))),
      h('p', { class: 'tw-note' }, who === me?.id ? `A day counts once you log ${NEED} attempts with a result on the Ticket board.` : `${name}’s days — ${NEED}+ logged attempts each.`));
  }

  function dayPopup(anchor, d, list) {
    const body = h('div', { class: 'pop tw-pop' },
      h('div', { class: 'pop-label' }, `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} · ${list.length}/${NEED}`),
      list.length ? h('ol', { class: 'tw-attempts' }, list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((a) => h('li', {},
        h('div', { class: 'tw-att-top' },
          h('button', {
            type: 'button', class: 'tw-att-ticket', title: 'Open ticket',
            onclick: () => { closeFloating(); window.dispatchEvent(new CustomEvent('architect:open-ticket', { detail: { no: Number(a.ticket_no) } })); },
          }, `#${pad3(a.ticket_no)}`),
          h('span', { class: 'tw-att-title' }, a.ticket_title || 'Ticket'),
          h('span', { class: ['px-outcome-tag', `is-${a.outcome}`] }, OUT[a.outcome] || a.outcome)),
        a.body ? h('p', { class: 'tw-att-body' }, a.body) : null,
        h('span', { class: 'tw-att-time' }, new Date(a.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })))))
        : h('p', { class: 'pop-note' }, 'No attempts logged this day.'));
    popover(anchor, body, { side: 'bottom', align: 'center', gap: 8 });
  }
  const pad3 = (n) => String(Number(n) || 0).padStart(3, '0');

  /* ---------- weekly plan ---------- */
  const plan = () => ({ goal: el.goal || 'Rona’s Apartment', start: el.start || keyOf(mondayOf(new Date())), weeks: el.weeks || {} });
  const weekDates = (i) => { const s = parseKey(plan().start); const a = new Date(s.getFullYear(), s.getMonth(), s.getDate() + (i - 1) * 7); return [a, new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6)]; };
  const currentWeek = () => Math.floor((Date.now() - parseKey(plan().start).getTime()) / (7 * DAY)) + 1;
  const save = (patch) => w.patch(el.start ? patch : { start: plan().start, ...patch }); // pin week 1 the first time

  function weeks() {
    const p = plan();
    const cur = currentWeek();
    const doneWeeks = Array.from({ length: 8 }, (_, i) => p.weeks[i + 1] || []).filter((l) => l.length && l.every((x) => x.done)).length;
    const goalInput = h('input', {
      class: 'tw-goal', value: p.goal, maxlength: 60, 'aria-label': 'Where these 8 weeks lead', spellcheck: false,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
      onchange: (e) => { const v = e.target.value.trim() || 'Rona’s Apartment'; if (v !== p.goal) save({ goal: v }); },
      onblur: () => { if (render.pending) setTimeout(render, 0); },
    });
    return h('div', { class: 'tw-weeks' },
      h('div', { class: 'tw-goal-row' },
        h('span', { class: 'tk-stat-label' }, '8 weeks to'),
        goalInput,
        h('span', { class: 'tw-goal-n' }, `${doneWeeks}/8`)),
      h('div', { class: 'tw-squares' }, Array.from({ length: 8 }, (_, i) => {
        const n = i + 1;
        const list = p.weeks[n] || [];
        const done = list.filter((x) => x.done).length;
        const full = list.length && done === list.length;
        const [a, b] = weekDates(n);
        return h('button', {
          type: 'button', class: ['tw-sq', n === cur && 'is-now', n < cur && 'is-past', full && 'is-full'],
          style: { '--fill': list.length ? `${Math.round((done / list.length) * 100)}%` : '0%' },
          'aria-label': `Week ${n}, ${short(a)} to ${short(b)}: ${done} of ${list.length} achievements`,
          onclick: () => { openWeek = n; render(); },
        }, h('span', { class: 'tw-sq-n' }, `W${n}`), h('span', { class: 'tw-sq-d' }, short(a)), h('span', { class: 'tw-sq-c' }, list.length ? `${done}/${list.length}` : '—'));
      })),
      h('label', { class: 'tw-start' },
        h('span', {}, 'Week 1 starts'),
        h('input', { type: 'date', class: 'input sm', value: p.start, onchange: (e) => { if (e.target.value) save({ start: keyOf(mondayOf(parseKey(e.target.value))) }); } })));
  }

  function weekDetail(n) {
    const p = plan();
    const list = p.weeks[n] || [];
    const [a, b] = weekDates(n);
    const setList = (next) => save({ weeks: { ...p.weeks, [n]: next } });
    const input = h('input', {
      class: 'input sm', placeholder: 'Add an achievement — Enter', maxlength: 160, 'aria-label': 'New achievement',
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        e.preventDefault();
        const text = e.target.value.trim();
        e.target.value = '';
        setList([...list, { id: uid(), text, done: false }]);
      },
      onblur: () => { if (render.pending) setTimeout(render, 0); },
    });
    return h('div', { class: 'tw-week' },
      h('div', { class: 'tw-week-head' },
        h('button', { class: 'pback', type: 'button', onclick: () => { openWeek = null; render(); } }, icon('back', 14), 'Weeks'),
        h('span', { class: 'tw-week-name' }, `Week ${n}`),
        h('span', { class: 'tw-week-dates' }, `${short(a)} – ${short(b)}`)),
      list.length ? h('ul', { class: 'tw-ach' }, list.map((x) => h('li', { class: x.done ? 'is-done' : null },
        h('button', {
          type: 'button', class: 'pcheck', role: 'checkbox', 'aria-checked': String(!!x.done), 'aria-label': x.done ? 'Mark not done' : 'Mark done',
          onclick: () => setList(list.map((y) => (y.id === x.id ? { ...y, done: !y.done } : y))),
        }, icon('check', 12, { weight: 2.4 })),
        h('span', { class: 'tw-ach-text' }, x.text),
        h('button', {
          type: 'button', class: 'icon-btn xs', title: 'Reverse-engineer into a ticket', 'aria-label': 'Make a ticket from this',
          onclick: () => window.dispatchEvent(new CustomEvent('architect:new-ticket', { detail: { title: x.text, detail: `Week ${n} achievement toward ${p.goal}.` } })),
        }, icon('ticket', 14)),
        h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': 'Remove', onclick: () => setList(list.filter((y) => y.id !== x.id)) }, icon('close', 13)))))
        : h('p', { class: 'tw-note' }, 'What has to be true by the end of this week? Add it, then turn the hard parts into tickets.'),
      h('div', { class: 'tw-add' }, input));
  }

  /* ---------- live ---------- */
  render();
  loadPeople();
  loadAttempts();
  const onAttempt = () => loadAttempts(true);
  window.addEventListener('architect:attempt-logged', onAttempt);
  const poll = setInterval(() => { if (!document.hidden) loadAttempts(true); }, 60_000);

  return {
    update(next) {
      const changed = next.goal !== el.goal || next.start !== el.start || next.weeks !== el.weeks;
      el = next;
      // Typing the goal name: wait. Adding achievements: redraw and keep typing.
      if (changed && view === 'weeks') render(!document.activeElement?.classList.contains('tw-goal'));
    },
    destroy() { clearInterval(poll); window.removeEventListener('architect:attempt-logged', onAttempt); box.remove(); },
  };
}

