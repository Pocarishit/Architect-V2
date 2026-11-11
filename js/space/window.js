// A Blueprint opened as a window over the Space ("compact"): not full screen, not another page.
// Drag it by its bar, resize from the corner, expand to full screen, Ctrl+Esc (or Esc twice) to close.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store, kbd } from '../core/util.js';
import { onEscapeFull } from '../core/guard.js';
import { mountBoard } from '../board/board.js';
import { setSurface } from '../board/editor.js';

const GEO = 'architect.bpWindow';
const MIN = { w: 520, h: 380 };

function defaultGeo() {
  const w = Math.min(1180, Math.round(innerWidth * 0.72));
  const hh = Math.min(780, Math.round(innerHeight * 0.76));
  return { x: Math.round((innerWidth - w) / 2), y: Math.round((innerHeight - hh) / 2), w, h: hh };
}

function fit(g) {
  const w = Math.max(MIN.w, Math.min(g.w, innerWidth - 16));
  const hh = Math.max(MIN.h, Math.min(g.h, innerHeight - 16));
  return { w, h: hh, x: Math.max(8, Math.min(g.x, innerWidth - w - 8)), y: Math.max(8, Math.min(g.y, innerHeight - hh - 8)) };
}

export function openBoardWindow(root, boardId, { onExpand, onClose } = {}) {
  const surface = `win-${boardId}`;
  let geo = fit(store.get(GEO, null) || defaultGeo());
  const name = h('span', { class: 'bpw-name' }, 'Blueprint');
  const body = h('div', { class: 'bpw-body' });
  const btn = (ic, label, fn) => h('button', { class: 'bpw-btn', type: 'button', 'aria-label': label, title: label, onclick: fn, 'data-noptr': '' }, icon(ic, 15));
  const bar = h('div', { class: 'bpw-bar' },
    h('span', { class: 'wg-grip', 'aria-hidden': 'true' }),
    name,
    h('span', { class: 'bpw-hint' }, kbd('Ctrl+Esc')),
    btn('expand', 'Full screen', () => expand()),
    btn('close', 'Close window', () => close()));
  const grip = h('div', { class: 'bpw-resize', 'aria-hidden': 'true' });
  const node = h('div', { class: 'bp-window', role: 'dialog', 'aria-label': 'Blueprint window', 'data-surface': surface }, bar, body, grip);
  root.append(node);
  const paint = () => { Object.assign(node.style, { left: `${geo.x}px`, top: `${geo.y}px`, width: `${geo.w}px`, height: `${geo.h}px` }); };
  paint();
  requestAnimationFrame(() => node.classList.add('in'));
  setSurface(surface);

  const board = mountBoard(body, boardId, {
    windowed: { surface, onExpand: () => expand(), onClose: () => close(), onName: (n) => { name.textContent = n || 'Blueprint'; } },
  });

  // Drag by the bar, resize from the corner (pointer events, so it works with touch too).
  const drag = (e, mode) => {
    if (e.button !== 0 || (mode === 'move' && e.target.closest('[data-noptr]'))) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, g: { ...geo } };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    node.classList.add('is-dragging');
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      geo = mode === 'move'
        ? fit({ ...start.g, x: start.g.x + dx, y: start.g.y + dy })
        : fit({ ...start.g, w: start.g.w + dx, h: start.g.h + dy });
      paint();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      node.classList.remove('is-dragging');
      store.set(GEO, geo);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  bar.addEventListener('pointerdown', (e) => drag(e, 'move'));
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-noptr]')) expand(); });
  grip.addEventListener('pointerdown', (e) => drag(e, 'size'));
  const onResize = () => { geo = fit(geo); paint(); };
  window.addEventListener('resize', onResize);

  const escOff = onEscapeFull(() => { close(); });
  let closed = false;
  function teardown() {
    if (closed) return false;
    closed = true;
    escOff();
    window.removeEventListener('resize', onResize);
    try { board.destroy(); } catch (e) { console.error(e); }
    setSurface(null);
    node.classList.remove('in');
    setTimeout(() => node.remove(), 160);
    return true;
  }
  function close() { if (teardown()) onClose?.(); }
  function expand() { if (teardown()) onExpand?.(); }

  return { close, boardId, node };
}
