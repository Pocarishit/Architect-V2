// Days Countdown: a title, a deadline, and a dot-matrix hourglass that drains as time runs out.
// A single bit drops through the neck while it runs; at the deadline the top is empty.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog, menu } from '../core/ui.js';
import { uid } from '../core/util.js';
import { friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';

const ROWS = [11, 9, 7, 5, 3, 1]; // top chamber, widest first; the bottom mirrors it
const W = 11;
const PER = ROWS.reduce((a, b) => a + b, 0); // dots per chamber
const pad = (n) => String(n).padStart(2, '0');

// Cells of a row, centre first — so sand piles up from the middle.
function rowCells(width) {
  const start = (W - width) / 2;
  const cols = Array.from({ length: width }, (_, i) => start + i);
  const mid = (W - 1) / 2;
  return cols.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
}

function left(cd, now = Date.now()) {
  return Math.max(0, new Date(cd.end).getTime() - now);
}
function fraction(cd, now = Date.now()) {
  const s = new Date(cd.start).getTime(), e = new Date(cd.end).getTime();
  if (!(e > s)) return now >= e ? 0 : 1;
  return Math.min(1, Math.max(0, (e - now) / (e - s)));
}
function parts(ms) {
  const t = Math.floor(ms / 1000);
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

/** The hourglass: 12 rows × 11 columns of dots plus the falling bit. */
function hourglass(frac, running) {
  const top = Math.round(PER * frac);  // sand still up top
  const bottom = PER - top;
  const on = new Set();
  // Top: sand rests at the narrow end, so the wide rows empty first.
  let n = top;
  for (let r = ROWS.length - 1; r >= 0 && n > 0; r--) for (const c of rowCells(ROWS[r])) { if (n-- > 0) on.add(`${r}:${c}`); }
  // Bottom: fills from the widest (lowest) row up.
  n = bottom;
  let surface = ROWS.length * 2 - 1;
  for (let i = 0; i < ROWS.length && n > 0; i++) {
    const r = ROWS.length * 2 - 1 - i;
    surface = r;
    for (const c of rowCells(ROWS[i])) { if (n-- > 0) on.add(`${r}:${c}`); }
  }
  const cells = [];
  ROWS.forEach((w, r) => rowCells(w).forEach((c) => cells.push([r, c])));
  ROWS.forEach((w, i) => rowCells(w).forEach((c) => cells.push([ROWS.length * 2 - 1 - i, c])));
  const fall = Math.max(1, surface - ROWS.length); // rows the bit drops below the neck
  return h('div', { class: ['hg', running && 'is-running', !top && 'is-empty'], role: 'img', 'aria-label': `${Math.round(frac * 100)}% of the time left`, style: { '--fall': String(fall) } },
    h('i', { class: 'hg-cap' }),
    h('div', { class: 'hg-grid' },
      cells.map(([r, c]) => h('i', { class: on.has(`${r}:${c}`) ? 'on' : null, style: { gridRow: String(r + 1), gridColumn: String(c + 1) } })),
      running && top ? h('b', { class: 'hg-bit', style: { gridRow: String(ROWS.length), gridColumn: String((W + 1) / 2) } }) : null),
    h('i', { class: 'hg-cap' }));
}

export function mountCountdown(root) {
  let list = [];
  let loading = true;
  const el = h('div', { class: 'view countdown' });
  root.append(el);

  async function load() {
    await loadPrefs();
    list = getPref('countdowns', []) || [];
    loading = false;
    render();
  }
  const save = () => setPref('countdowns', list).catch((e) => toast(friendlyError(e), { tone: 'error' }));
  const sorted = () => [...list].sort((a, b) => (left(a) === 0) - (left(b) === 0) || new Date(a.end) - new Date(b.end));

  function render() {
    el.replaceChildren(
      h('header', { class: 'view-head cd-head' },
        h('h1', { class: 'paths-title cd-title' }, 'Countdown'),
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New countdown'))),
      loading ? h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')))
        : list.length ? h('div', { class: 'cd-grid' }, sorted().map(card))
          : h('div', { class: 'cd-empty' }, hourglass(1, false),
            h('p', {}, 'Name a deadline. The hourglass drains until it hits zero.'),
            h('button', { class: 'btn sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New countdown'))));
    lastTops.clear();
    list.forEach((cd) => lastTops.set(cd.id, Math.round(PER * fraction(cd))));
  }

  function digits(cd) {
    const ms = left(cd);
    const p = parts(ms);
    return [
      h('span', { class: 'cd-unit' }, h('b', {}, String(p.d)), h('small', {}, p.d === 1 ? 'Day' : 'Days')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.h)), h('small', {}, 'Hrs')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.m)), h('small', {}, 'Min')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.s)), h('small', {}, 'Sec')),
    ];
  }

  function card(cd) {
    const ms = left(cd);
    const done = ms === 0;
    const end = new Date(cd.end);
    return h('article', { class: ['cd-card', done && 'is-done'], 'data-cd': cd.id },
      h('div', { class: 'cd-glass' }, hourglass(fraction(cd), !done)),
      h('div', { class: 'cd-info' },
        h('header', { class: 'cd-card-top' },
          h('span', { class: 'tk-stat-label' }, end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })),
          h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': 'Countdown options', onclick: (e) => menu(e.currentTarget, [
            { label: 'Edit', icon: 'edit', onSelect: () => edit(cd) },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: () => remove(cd) },
          ], { align: 'end' }) }, icon('more', 16))),
        h('h2', { class: 'cd-card-title' }, cd.title || 'Untitled'),
        done
          ? h('p', { class: 'cd-over' }, h('i'), 'Time’s up')
          : h('div', { class: 'cd-digits', 'data-digits': cd.id, role: 'timer' }, digits(cd)),
        h('div', { class: 'cd-bar', 'aria-hidden': 'true' }, h('i', { style: { '--p': String(1 - fraction(cd)) } }))));
  }

  async function edit(cd) {
    const toLocal = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
    const toTime = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
    const title = h('input', { class: 'input', value: cd?.title || '', maxlength: 60, placeholder: 'e.g. Launch day', 'aria-label': 'Title' });
    const date = h('input', { class: 'input', type: 'date', value: cd ? toLocal(cd.end) : '', 'aria-label': 'Deadline date' });
    const time = h('input', { class: 'input', type: 'time', value: cd ? toTime(cd.end) : '23:59', 'aria-label': 'Deadline time' });
    const err = h('p', { class: 'login-error', hidden: true });
    const ok = await dialog({
      title: cd ? 'Edit countdown' : 'New countdown',
      body: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
        h('div', { class: 'ptime-fields' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Deadline'), date),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Time'), time)),
        err),
      actions: [{ label: 'Cancel', value: false }, {
        label: cd ? 'Save' : 'Start', primary: true,
        value: () => {
          if (!date.value) { err.hidden = false; err.textContent = 'Pick a deadline.'; return undefined; }
          const end = new Date(`${date.value}T${time.value || '23:59'}`);
          if (!cd && end <= new Date()) { err.hidden = false; err.textContent = 'The deadline has to be in the future.'; return undefined; }
          return true;
        },
      }],
    });
    if (!ok || !date.value) return;
    const end = new Date(`${date.value}T${time.value || '23:59'}`).toISOString();
    if (cd) Object.assign(cd, { title: title.value.trim(), end });
    else list.push({ id: uid(), title: title.value.trim(), start: new Date().toISOString(), end });
    render();
    save();
  }

  async function remove(cd) {
    if (!(await confirmDialog(`Delete “${cd.title || 'countdown'}”?`, '', { ok: 'Delete' }))) return;
    list = list.filter((x) => x.id !== cd.id);
    render();
    save();
  }

  // Every second: update the digits; redraw an hourglass only when a dot moves.
  const lastTops = new Map();
  const tick = setInterval(() => {
    if (loading || document.querySelector('.dlg')) return;
    for (const cd of list) {
      const top = Math.round(PER * fraction(cd));
      const node = el.querySelector(`[data-cd="${cd.id}"]`);
      if (!node) continue;
      if (lastTops.get(cd.id) !== top || (left(cd) === 0) !== node.classList.contains('is-done')) {
        lastTops.set(cd.id, top);
        node.replaceWith(card(cd));
        continue;
      }
      const d = node.querySelector('[data-digits]');
      if (d) d.replaceChildren(...digits(cd));
      node.querySelector('.cd-bar i')?.style.setProperty('--p', String(1 - fraction(cd)));
    }
  }, 1000);

  render();
  load();
  return { destroy() { clearInterval(tick); el.remove(); } };
}
