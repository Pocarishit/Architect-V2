// Days Countdown: a title, a deadline, and a dot-matrix hourglass that drains as time runs out.
// A single bit drops through the neck while it runs; at the deadline the top is empty.
import { h, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog, menu } from '../core/ui.js';
import { uid } from '../core/util.js';
import { store } from '../core/util.js';
import { listShared, createShared, mutate, addMember, removeShared, leaveShared, membersOf, nameOf, initial, meId, local, friendlyError } from '../data/shared.js';

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
  let items = [];          // shared_items rows (kind 'countdown'); item.data = { title, start, end }
  let loading = true;
  let loadError = null;
  let openId = store.get('architect.cd.open', null);
  const el = h('div', { class: 'view countdown' });
  root.append(el);
  const fail = (e) => toast(friendlyError(e), { tone: 'error', ms: 5000 });

  const sorted = () => [...items].sort((a, b) => (left(a.data) === 0) - (left(b.data) === 0) || new Date(a.data.end) - new Date(b.data.end));
  const currentIndex = () => { const list = sorted(); const i = list.findIndex((x) => x.id === openId); return i < 0 ? 0 : i; };
  const current = () => sorted()[currentIndex()] || null;

  async function load() {
    try {
      items = await listShared('countdown', 'countdowns');
      loadError = null;
    } catch (e) {
      loadError = friendlyError(e);
    }
    loading = false;
    render();
  }

  /* ---------------- Render ---------------- */

  function render() {
    el.replaceChildren(
      h('header', { class: 'view-head cd-head' },
        h('h1', { class: 'paths-title cd-title' }, 'Countdown'),
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New countdown'))),
      loading ? h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')))
        : loadError ? h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, loadError),
          h('p', { class: 'empty-text px-hint' }, 'Countdowns are shared now — run supabase/nov7.sql again in the Supabase SQL editor.'),
          h('button', { class: 'btn', onclick: () => { loading = true; render(); load(); } }, 'Try again'))
          : items.length ? stage()
            : h('div', { class: 'cd-empty' }, hourglass(1, false),
              h('p', {}, 'Name a deadline. The hourglass drains until it hits zero.'),
              h('button', { class: 'btn sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New countdown'))));
    const cd = current();
    lastTop = cd ? Math.round(PER * fraction(cd.data)) : null;
  }

  function digits(d) {
    const p = parts(left(d));
    return [
      h('span', { class: 'cd-unit' }, h('b', {}, String(p.d)), h('small', {}, p.d === 1 ? 'Day' : 'Days')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.h)), h('small', {}, 'Hrs')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.m)), h('small', {}, 'Min')),
      h('span', { class: 'cd-unit' }, h('b', {}, pad(p.s)), h('small', {}, 'Sec')),
    ];
  }

  // One countdown at a time, big. Quiet arrows at the sides switch between them.
  function stage() {
    const list = sorted();
    const i = currentIndex();
    const item = list[i];
    const d = item.data;
    const done = left(d) === 0;
    const end = new Date(d.end);
    const many = list.length > 1;
    return h('section', { class: ['cd-stage', done && 'is-done'], 'data-stage': '' },
      many ? h('button', { class: 'cd-nav is-prev', type: 'button', 'aria-label': 'Previous countdown', onclick: () => step(-1) }, icon('chevronLeft', 18)) : null,
      h('div', { class: 'cd-hero' },
        h('div', { class: 'cd-glass' }, hourglass(fraction(d), !done)),
        h('div', { class: 'cd-info' },
          h('header', { class: 'cd-card-top' },
            h('span', { class: 'tk-stat-label' }, end.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })),
            h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Countdown options', onclick: (e) => itemMenu(e.currentTarget, item) }, icon('more', 16))),
          h('h2', { class: 'cd-hero-title' }, d.title || 'Untitled'),
          done
            ? h('p', { class: 'cd-over' }, h('i'), 'Time’s up')
            : h('div', { class: 'cd-digits', 'data-digits': '', role: 'timer' }, digits(d)),
          h('div', { class: 'cd-bar', 'aria-hidden': 'true' }, h('i', { style: { '--p': String(1 - fraction(d)) } })),
          members(item))),
      many ? h('button', { class: 'cd-nav is-next', type: 'button', 'aria-label': 'Next countdown', onclick: () => step(1) }, icon('chevronRight', 18)) : null,
      many ? h('div', { class: 'cd-pager', role: 'tablist', 'aria-label': 'Countdowns' }, list.map((x, j) => h('button', {
        class: ['cd-pip', j === i && 'is-on', left(x.data) === 0 && 'is-over'], type: 'button', role: 'tab', 'aria-selected': String(j === i), 'aria-label': x.data.title || `Countdown ${j + 1}`,
        onclick: () => open(x.id),
      }))) : null);
  }

  function members(item) {
    const ids = membersOf(item);
    return h('div', { class: 'cd-people' },
      h('div', { class: 'cd-avatars' }, ids.map((id) => h('span', { class: 'tk-av', title: nameOf(id) }, initial(id)))),
      h('span', { class: 'cd-people-label' }, ids.length > 1 ? `${ids.length} counting down` : 'Only you'),
      h('button', { class: 'btn sm cd-share', type: 'button', onclick: () => share(item) }, icon('users', 14), h('span', {}, 'Share')));
  }

  function itemMenu(anchor, item) {
    const owner = item.user_id === meId();
    menu(anchor, [
      { label: 'Edit', icon: 'edit', onSelect: () => edit(item) },
      { label: 'Share with…', icon: 'users', onSelect: () => share(item) },
      '-',
      owner ? { label: 'Delete', icon: 'trash', danger: true, onSelect: () => remove(item) }
        : { label: 'Leave', icon: 'logout', danger: true, onSelect: () => leave(item) },
    ], { align: 'end' });
  }

  function open(id) { openId = id; store.set('architect.cd.open', id); render(); }
  function step(dir) {
    const list = sorted();
    if (list.length < 2) return;
    open(list[(currentIndex() + dir + list.length) % list.length].id);
  }

  /* ---------------- Actions ---------------- */

  async function edit(item) {
    const d = item?.data;
    const toLocal = (x) => { x = new Date(x); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
    const toTime = (x) => { x = new Date(x); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
    const title = h('input', { class: 'input', value: d?.title || '', maxlength: 60, placeholder: 'e.g. New environment', 'aria-label': 'Title' });
    const date = h('input', { class: 'input', type: 'date', value: d ? toLocal(d.end) : '', 'aria-label': 'Deadline date' });
    const time = h('input', { class: 'input', type: 'time', value: d ? toTime(d.end) : '23:59', 'aria-label': 'Deadline time' });
    const who = item ? null : h('input', { class: 'input', placeholder: local() ? 'Needs Supabase sync' : 'Usernames, comma separated (optional)', disabled: local(), autocapitalize: 'none', spellcheck: false, 'aria-label': 'Share with' });
    const err = h('p', { class: 'login-error', hidden: true });
    const ok = await dialog({
      title: item ? 'Edit countdown' : 'New countdown',
      body: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
        h('div', { class: 'ptime-fields' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Deadline'), date),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Time'), time)),
        who ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Count down with'), who) : null,
        err),
      actions: [{ label: 'Cancel', value: false }, {
        label: item ? 'Save' : 'Start', primary: true,
        value: () => {
          if (!date.value) { err.hidden = false; err.textContent = 'Pick a deadline.'; return undefined; }
          if (!item && new Date(`${date.value}T${time.value || '23:59'}`) <= new Date()) { err.hidden = false; err.textContent = 'The deadline has to be in the future.'; return undefined; }
          return true;
        },
      }],
    });
    if (!ok) return;
    const end = new Date(`${date.value}T${time.value || '23:59'}`).toISOString();
    try {
      if (item) {
        await mutate(item, (x) => { x.title = title.value.trim(); x.end = end; });
        render();
      } else {
        const made = await createShared('countdown', { title: title.value.trim(), start: new Date().toISOString(), end });
        items.push(made);
        open(made.id);
        for (const u of (who?.value || '').split(/[,\s]+/).filter(Boolean)) { try { await addMember(made, u); } catch (e) { fail(e); } }
        render();
      }
    } catch (e) { fail(e); load(); }
  }

  async function share(item) {
    if (local()) { toast('Sharing needs Supabase sync.'); return; }
    const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
    const ok = await dialog({
      title: 'Share countdown',
      body: h('div', { class: 'stack' },
        h('p', { class: 'px-hint' }, 'They’ll see this hourglass and can edit it too.'),
        h('div', { class: 'cd-avatars is-list' }, membersOf(item).map((id) => h('span', { class: 'cd-member' }, h('span', { class: 'tk-av' }, initial(id)), nameOf(id)))),
        input),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    if (!ok || !input.value.trim()) return;
    try { await addMember(item, input.value); render(); toast(`Shared with ${input.value.trim().replace(/^@/, '')}`); } catch (e) { fail(e); }
  }

  async function remove(item) {
    if (!(await confirmDialog(`Delete “${item.data.title || 'countdown'}”?`, 'It disappears for everyone it’s shared with.', { ok: 'Delete' }))) return;
    items = items.filter((x) => x.id !== item.id);
    render();
    try { await removeShared(item); } catch (e) { fail(e); load(); }
  }

  async function leave(item) {
    if (!(await confirmDialog(`Leave “${item.data.title || 'countdown'}”?`, 'You won’t see it anymore.', { ok: 'Leave' }))) return;
    items = items.filter((x) => x.id !== item.id);
    render();
    try { await leaveShared(item); } catch (e) { fail(e); load(); }
  }

  /* ---------------- Live ---------------- */

  // Every second: update the digits; redraw only when a grain of sand moves.
  let lastTop = null;
  const tick = setInterval(() => {
    if (loading || loadError || document.querySelector('.dlg')) return;
    const cd = current();
    if (!cd) return;
    const top = Math.round(PER * fraction(cd.data));
    const stageEl = el.querySelector('[data-stage]');
    if (!stageEl) return;
    if (top !== lastTop || (left(cd.data) === 0) !== stageEl.classList.contains('is-done')) { render(); return; }
    stageEl.querySelector('[data-digits]')?.replaceChildren(...digits(cd.data));
    stageEl.querySelector('.cd-bar i')?.style.setProperty('--p', String(1 - fraction(cd.data)));
  }, 1000);

  // Switch with ← / → or a swipe.
  const onKey = (e) => {
    if (isTypingTarget(e.target) || document.querySelector('.dlg, .menu')) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  window.addEventListener('keydown', onKey);
  let swipe = null;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && e.target.closest('.cd-stage')) swipe = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });

  // Pick up teammates' edits.
  const poll = setInterval(async () => {
    if (document.hidden || loading || document.querySelector('.dlg')) return;
    try { items = await listShared('countdown'); render(); } catch {}
  }, 45_000);

  render();
  load();
  return { destroy() { clearInterval(tick); clearInterval(poll); window.removeEventListener('keydown', onKey); el.remove(); } };
}
