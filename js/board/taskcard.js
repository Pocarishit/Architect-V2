// The Blueprint face of a Path task (Nov 23 — one task, two views).
// The board stores { type: 'task', taskId, x, y, w, h }: where the card sits and how big it is. Everything
// else — title, done, which setpoint it's in, its date — is read live from the task itself, so the card
// and your Path can never disagree. Tick it, change its date or move it to another setpoint from here and
// your Path shows it at once (and the other way round).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu } from '../core/ui.js';
import { watchTask, patchTask, columnOf, columnsOf, canEdit, taskOf } from '../data/tasks.js';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dayLabel(day) {
  if (!day) return 'Today';
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(`${day}T00:00:00`);
  const diff = Math.round((d - t) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const stop = (e) => e.stopPropagation();

export function updateTaskNode(node, el, ctx = {}) {
  if (node._taskId !== el.taskId) {
    node._off?.();
    node._taskId = el.taskId;
    node.replaceChildren();
    const check = h('button', { type: 'button', class: 'tc-check', role: 'checkbox', 'data-noptr': '', onpointerdown: stop });
    const title = h('span', { class: 'tc-title' });
    const col = h('button', { type: 'button', class: 'tc-chip tc-col', 'data-noptr': '', onpointerdown: stop }, h('span'), icon('chevronDown', 11));
    const date = h('input', { type: 'date', class: 'tc-date-in', tabindex: -1, 'aria-hidden': 'true' });
    const day = h('button', { type: 'button', class: 'tc-chip tc-day', 'data-noptr': '', onpointerdown: stop }, icon('calendar', 11), h('span'));
    const open = h('button', { type: 'button', class: 'tc-open', 'data-noptr': '', title: 'Show in your Path', 'aria-label': 'Show in your Path', onpointerdown: stop }, icon('toPaths', 13));
    node.append(
      h('div', { class: 'tc-head' }, h('span', { class: 'tc-kind' }, 'PATH TASK'), open),
      h('div', { class: 'tc-main' }, check, title),
      h('div', { class: 'tc-foot' }, col, day, date));
    node._parts = { check, title, col, day, date, open };
    let row;
    const paint = (t) => {
      row = t;
      node.classList.toggle('is-loading', t === undefined);
      node.classList.toggle('is-gone', t === null);
      const p = node._parts;
      if (!t) {
        p.title.textContent = t === null ? 'This task was deleted from Path' : 'Loading…';
        p.check.disabled = true; p.col.hidden = true; p.day.hidden = true; return;
      }
      const mine = canEdit(t);
      node.classList.toggle('is-done', !!t.done);
      node.classList.toggle('is-readonly', !mine);
      p.check.disabled = !mine;
      p.check.setAttribute('aria-checked', String(!!t.done));
      p.check.setAttribute('aria-label', t.done ? `Mark not done: ${t.title}` : `Mark done: ${t.title}`);
      p.check.replaceChildren(t.done ? icon('check', 12, { weight: 2.6 }) : '');
      p.title.textContent = t.title || 'Untitled';
      p.col.hidden = false; p.day.hidden = false;
      p.col.querySelector('span').textContent = (columnOf(t.column_id)?.title || 'Path').toUpperCase();
      p.day.querySelector('span').textContent = dayLabel(t.day).toUpperCase();
      p.day.classList.toggle('is-set', !!t.day);
      p.col.disabled = !mine; p.day.disabled = !mine;
    };
    check.addEventListener('click', (e) => { e.stopPropagation(); if (row && canEdit(row)) patchTask(row.id, { done: !row.done }); });
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!row || !canEdit(row)) return;
      menu(col, [{ header: 'Move to setpoint' }, ...columnsOf(row.user_id).map((c) => ({
        label: c.title, checked: String(c.id) === String(row.column_id),
        onSelect: () => { if (String(c.id) !== String(row.column_id)) patchTask(row.id, { column_id: c.id }); },
      }))]);
    });
    day.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!row || !canEdit(row)) return;
      const r = day.getBoundingClientRect();
      menu({ x: r.left, y: r.bottom + 4 }, [
        { header: 'Date' },
        { label: 'Today', checked: !row.day, onSelect: () => patchTask(row.id, { day: null }) },
        { label: 'Tomorrow', onSelect: () => { const d = new Date(); d.setDate(d.getDate() + 1); patchTask(row.id, { day: keyOf(d) }); } },
        { label: 'Pick a date…', icon: 'calendar', onSelect: () => { date.value = row.day || keyOf(new Date()); try { date.showPicker(); } catch { date.focus(); date.click(); } } },
      ]);
    });
    date.addEventListener('change', () => {
      if (!row || !date.value) return;
      const today = keyOf(new Date());
      patchTask(row.id, { day: date.value <= today ? null : date.value }); // Path keeps today's tasks undated
    });
    open.addEventListener('click', (e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('architect:show-task', { detail: { id: el.taskId } })); });
    // An export / print copy draws what's known now and doesn't keep listening.
    if (ctx.still) paint(taskOf(el.taskId)); else node._off = watchTask(el.taskId, paint);
  }
}

export function disposeTaskNode(node) { node._off?.(); node._off = null; node._taskId = null; }

/* ---------------- putting a task on a board ---------------- */
export function taskEl(taskId, at) {
  return { id: crypto.randomUUID?.() || `t${Date.now()}${Math.random().toString(36).slice(2)}`, type: 'task', taskId: String(taskId), x: Math.round(at.x - 140), y: Math.round(at.y - 56), w: 280, h: 112 };
}

/** "Add a Path task…": pick one of your tasks; the board gets a live card for it. */
export async function pickTask(editor, at, { dialog, toast, myTasks }) {
  let data;
  try { data = await myTasks(); } catch (e) { toast(e?.message || 'Couldn’t load your Path.', { tone: 'error' }); return; }
  const onBoard = new Set(editor.els.filter((e) => e.type === 'task').map((e) => String(e.taskId)));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Find a task', autofocus: true });
  const list = h('div', { class: 'tcp-list' });
  let chosen = null;
  const paint = () => {
    const needle = q.value.trim().toLowerCase();
    list.replaceChildren(...data.cols.map((c) => {
      const rows = data.rows.filter((t) => String(t.column_id) === String(c.id) && (!needle || (t.title || '').toLowerCase().includes(needle)));
      if (!rows.length) return null;
      return h('section', { class: 'tcp-col' }, h('h4', { class: 'tcp-head' }, c.title.toUpperCase()),
        rows.map((t) => h('button', {
          type: 'button', class: ['tcp-row', t.done && 'is-done', onBoard.has(String(t.id)) && 'is-on'],
          onclick: () => { chosen = t; list.closest('form')?.requestSubmit(); },
        }, h('i', { class: 'tcp-dot' }), h('span', {}, t.title || 'Untitled'), onBoard.has(String(t.id)) ? h('em', {}, 'ON BOARD') : null)));
    }).filter(Boolean));
    if (!list.children.length) list.append(h('p', { class: 'dlg-text' }, data.rows.length ? 'No task matches.' : 'Your Path has no tasks yet.'));
  };
  q.addEventListener('input', paint);
  paint();
  const res = await dialog({
    title: 'Add a Path task',
    width: 460,
    className: 'tcp-dlg',
    body: h('div', { class: 'stack' }, h('p', { class: 'dlg-text' }, 'The card on the board is your task itself: tick it or change its date here or in your Path, and both show it.'), q, list),
    actions: [{ label: 'Cancel', value: null }, { label: 'Add', primary: true, value: () => chosen || undefined }],
  });
  if (!res) return;
  const el = taskEl(res.id, at);
  editor.addEls([el]);
  return el;
}
