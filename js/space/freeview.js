// Free View — a Variables chat where messages stop being a locked column and become objects.
//   Move    drag a message by its handle anywhere in the chat; double-click the handle to send it back.
//   Link    drag from one message to another to connect them.
//   Pen     scribble. Arrow: scribble with an arrowhead at the end.
//   Erase   click a link or a drawing to remove it.
// Every message keeps its spot: one you pull out leaves an invisible placeholder in the column, so the
// rest never slide up to fill the gap (double-click its handle and it goes back into that same slot).
// New messages land at the end of the column — the bottom of the conversation — with a handle ready.
// Layout lives on the entry: free = { on, pos: { msgId: {x, y} }, links: [{ id, a, b }], ink: [{ id, pts, arrow }] }.
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu } from '../core/ui.js';
import { uid } from '../core/util.js';

const scrollMem = new Map(); // entry id → { left, top } so a repaint doesn't throw you back
const TOOLS = [
  ['move', 'Move', 'grip'],
  ['link', 'Link messages', 'connector'],
  ['pen', 'Draw', 'pen'],
  ['arrow', 'Draw an arrow', 'arrow'],
  ['erase', 'Erase links and drawings', 'eraser'],
];
let lastTool = 'move';

/**
 * @param {object} o
 *  entry(): latest entry · flowRows(list): column rows for these notes · one(m): a single message row
 *  save(free): store the layout · onMenu(e, m): a message's menu
 */
export function mountFreeView(o) {
  let x = o.entry();
  let tool = lastTool;
  let busy = false;
  const free = () => ({ on: true, pos: {}, links: [], ink: [], ...(x.free || {}) });

  const svg = s('svg', { class: 'vr-fv-svg', 'aria-hidden': 'true' });
  const board = h('div', { class: 'vr-fv-board' });
  const capture = h('div', { class: 'vr-fv-capture' });
  const scroller = h('div', { class: 'vr-msgs vr-fv', role: 'log' }, board);
  const tools = h('div', { class: 'vr-fv-tools', role: 'toolbar', 'aria-label': 'Free view tools' });

  const items = new Map(); // msg id → element (row)
  let flow = null;

  /* ---------------- build ---------------- */
  function build() {
    const f = free();
    const notes = x.notes || [];
    const pinned = notes.filter((m) => f.pos[m.id]);
    items.clear();
    // The column holds every message in order; the ones you've moved out stay as invisible
    // placeholders, so nothing slides up and new messages always arrive at the bottom.
    flow = h('div', { class: 'vr-fv-flow' }, o.flowRows(notes));
    for (const row of [...flow.querySelectorAll('.sc-msg[data-id]')]) {
      if (f.pos[row.dataset.id]) ghost(row);
      else { items.set(row.dataset.id, row); addGrip(row, row.dataset.id); }
    }
    const placed = pinned.map((m) => {
      const row = o.one(m);
      const wrap = h('div', { class: 'vr-fv-item', 'data-id': m.id, style: { left: `${f.pos[m.id].x}px`, top: `${f.pos[m.id].y}px` } }, row);
      items.set(m.id, row);
      addGrip(row, m.id);
      return wrap;
    });
    board.replaceChildren(svg, flow, ...placed, capture);
    board.dataset.tool = tool;
    paintTools();
    requestAnimationFrame(() => { size(); draw(); });
  }

  // Keep a message's slot in the column without showing it (or letting it be clicked / linked).
  function ghost(row) {
    row.classList.add('vr-fv-ghost');
    row.removeAttribute('data-id');
    row.setAttribute('aria-hidden', 'true');
    row.inert = true;
    return row;
  }

  function addGrip(row, id) {
    const grip = h('button', { type: 'button', class: 'vr-fv-grip', 'aria-label': 'Drag this message', title: 'Drag anywhere · double-click to send it back to the column' }, icon('grip', 12));
    grip.addEventListener('pointerdown', (e) => dragMsg(e, id));
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); unpin(id); });
    grip.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      menu({ x: e.clientX, y: e.clientY }, [
        free().pos[id] ? { label: 'Back to the column', icon: 'list', onSelect: () => unpin(id) } : null,
        { label: 'Remove its links', icon: 'connector', onSelect: () => save({ links: free().links.filter((l) => l.a !== id && l.b !== id) }) },
      ].filter(Boolean));
    });
    row.classList.add('has-grip');
    row.prepend(grip);
  }

  function paintTools() {
    tools.replaceChildren(...TOOLS.map(([id, label, ic]) => h('button', {
      type: 'button', class: ['vr-fv-tool', tool === id && 'is-on'], 'aria-label': label, title: label, 'aria-pressed': String(tool === id),
      onclick: () => setTool(id),
    }, icon(ic, 15))));
  }
  function setTool(t) { tool = lastTool = t; board.dataset.tool = t; paintTools(); }

  /* ---------------- geometry ---------------- */
  const scaleOf = () => { const r = board.getBoundingClientRect(); return r.width / (board.offsetWidth || 1) || 1; };
  function local(e) {
    const r = board.getBoundingClientRect(), k = scaleOf();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }
  function rectOf(id) {
    const el = items.get(id);
    if (!el?.isConnected) return null;
    const b = el.querySelector('.sc-bubble') || el;
    const r = b.getBoundingClientRect(), br = board.getBoundingClientRect(), k = scaleOf();
    return { x: (r.left - br.left) / k, y: (r.top - br.top) / k, w: r.width / k, h: r.height / k };
  }
  // The board grows to hold whatever you've pulled out, and never shrinks below the chat.
  function size() {
    let w = scroller.clientWidth, hgt = scroller.clientHeight;
    for (const node of board.querySelectorAll('.vr-fv-item')) { w = Math.max(w, node.offsetLeft + node.offsetWidth + 160); hgt = Math.max(hgt, node.offsetTop + node.offsetHeight + 160); }
    for (const k of free().ink) for (const [px, py] of k.pts) { w = Math.max(w, px + 80); hgt = Math.max(hgt, py + 80); }
    hgt = Math.max(hgt, flow.offsetHeight + 24);
    board.style.width = `${w}px`; board.style.height = `${hgt}px`;
    flow.style.width = `${scroller.clientWidth}px`;
    svg.setAttribute('width', w); svg.setAttribute('height', hgt);
  }

  // Edge-to-edge curve between two boxes.
  function curve(a, b) {
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    const side = (r, c, ux, uy) => (Math.abs(ux) * r.h > Math.abs(uy) * r.w
      ? { x: c.x + Math.sign(ux) * r.w / 2, y: c.y, nx: Math.sign(ux), ny: 0 }
      : { x: c.x, y: c.y + Math.sign(uy) * r.h / 2, nx: 0, ny: Math.sign(uy) });
    const p = side(a, ca, dx, dy), q = side(b, cb, -dx, -dy);
    const d = Math.max(30, Math.hypot(q.x - p.x, q.y - p.y) / 2.4);
    return { d: `M${p.x},${p.y} C${p.x + p.nx * d},${p.y + p.ny * d} ${q.x + q.nx * d},${q.y + q.ny * d} ${q.x},${q.y}`, end: q, from: { x: q.x + q.nx * d, y: q.y + q.ny * d } };
  }
  const head = (tip, from, size = 9) => {
    const a = Math.atan2(tip.y - from.y, tip.x - from.x), w = 0.45;
    return `M${tip.x - size * Math.cos(a - w)},${tip.y - size * Math.sin(a - w)} L${tip.x},${tip.y} L${tip.x - size * Math.cos(a + w)},${tip.y - size * Math.sin(a + w)}`;
  };
  const smooth = (pts) => {
    if (pts.length < 3) return pts.length ? `M${pts.map((p) => p.join(',')).join(' L')}` : '';
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      d += ` Q${x1},${y1} ${(x1 + x2) / 2},${(y1 + y2) / 2}`;
    }
    const [lx, ly] = pts[pts.length - 1];
    return `${d} L${lx},${ly}`;
  };

  function draw(live = null) {
    const f = free();
    const out = [];
    for (const l of f.links) {
      const a = rectOf(l.a), b = rectOf(l.b);
      if (!a || !b) continue;
      const c = curve(a, b);
      out.push(s('g', { class: 'vr-fv-link', 'data-link': l.id },
        s('path', { class: 'hit', d: c.d }),
        s('path', { d: c.d }),
        s('path', { d: head(c.end, c.from, 7) })));
    }
    for (const k of f.ink) {
      const d = smooth(k.pts);
      const n = k.pts.length;
      const tipFrom = n > 4 ? k.pts[n - 5] : k.pts[0];
      out.push(s('g', { class: 'vr-fv-ink', 'data-ink': k.id },
        s('path', { class: 'hit', d }),
        s('path', { d }),
        k.arrow && n > 1 ? s('path', { d: head({ x: k.pts[n - 1][0], y: k.pts[n - 1][1] }, { x: tipFrom[0], y: tipFrom[1] }, 11) }) : null));
    }
    if (live) out.push(live);
    svg.replaceChildren(...out);
  }

  /* ---------------- save ---------------- */
  function save(p) { o.save({ ...free(), ...p, on: true }); }
  function unpin(id) { const pos = { ...free().pos }; delete pos[id]; save({ pos }); }

  /* ---------------- drag a message ---------------- */
  function dragMsg(e, id) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const row = items.get(id);
    if (!row) return;
    const r0 = rectOf(id);
    const start = local(e);
    let wrap = row.closest('.vr-fv-item');
    const k0 = wrap ? { x: wrap.offsetLeft, y: wrap.offsetTop } : null;
    let moved = false, at = null;
    busy = true;
    const move = (ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
      if (!moved) {
        moved = true;
        if (!wrap) { // pull it out of the column, right where it is — its slot stays put
          const gx = row.querySelector('.vr-fv-grip')?.offsetWidth || 0;
          row.before(ghost(row.cloneNode(true)));
          wrap = h('div', { class: 'vr-fv-item', 'data-id': id, style: { left: `${r0.x - gx}px`, top: `${r0.y}px` } });
          board.insertBefore(wrap, capture);
          wrap.append(row);
        }
        wrap.classList.add('is-held');
      }
      const bx = (k0 ? k0.x : r0.x - (row.querySelector('.vr-fv-grip')?.offsetWidth || 0)) + p.x - start.x;
      const by = (k0 ? k0.y : r0.y) + p.y - start.y;
      at = { x: Math.max(0, Math.round(bx)), y: Math.max(0, Math.round(by)) };
      wrap.style.left = `${at.x}px`; wrap.style.top = `${at.y}px`;
      autoScroll(ev);
      draw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      busy = false;
      wrap?.classList.remove('is-held');
      if (moved && at) save({ pos: { ...free().pos, [id]: at } });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function autoScroll(ev) {
    const r = scroller.getBoundingClientRect(), edge = 36;
    if (ev.clientY > r.bottom - edge) scroller.scrollTop += 14;
    else if (ev.clientY < r.top + edge) scroller.scrollTop -= 14;
    if (ev.clientX > r.right - edge) scroller.scrollLeft += 14;
    else if (ev.clientX < r.left + edge) scroller.scrollLeft -= 14;
  }

  /* ---------------- link / draw / erase ---------------- */
  const msgAt = (e) => document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.('.sc-msg[data-id]')).find((n) => n && board.contains(n))?.dataset.id || null;

  capture.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (tool === 'link') return startLink(e);
    if (tool === 'pen' || tool === 'arrow') return startInk(e);
  });

  function startLink(e) {
    const a = msgAt(e);
    if (!a) return;
    busy = true;
    const ra = rectOf(a);
    const from = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
    const move = (ev) => {
      const p = local(ev);
      autoScroll(ev);
      draw(s('path', { class: 'vr-fv-live', d: `M${from.x},${from.y} L${p.x},${p.y}` }));
      for (const n of board.querySelectorAll('.sc-msg.is-target')) n.classList.remove('is-target');
      const b = msgAt(ev);
      if (b && b !== a) items.get(b)?.classList.add('is-target');
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      busy = false;
      for (const n of board.querySelectorAll('.sc-msg.is-target')) n.classList.remove('is-target');
      const b = ev.type === 'pointerup' ? msgAt(ev) : null;
      const links = free().links;
      if (b && b !== a && !links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) save({ links: [...links, { id: uid(), a, b }] });
      else draw();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function startInk(e) {
    busy = true;
    const arrow = tool === 'arrow';
    const pts = [];
    const add = (ev) => {
      const p = local(ev);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 2.5) pts.push([Math.round(p.x), Math.round(p.y)]);
    };
    add(e);
    const move = (ev) => {
      add(ev);
      autoScroll(ev);
      const n = pts.length;
      const live = s('g', { class: 'vr-fv-ink is-live' }, s('path', { d: smooth(pts) }),
        arrow && n > 2 ? s('path', { d: head({ x: pts[n - 1][0], y: pts[n - 1][1] }, { x: pts[Math.max(0, n - 5)][0], y: pts[Math.max(0, n - 5)][1] }, 11) }) : null);
      draw(live);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      busy = false;
      if (pts.length > 1) save({ ink: [...free().ink, { id: uid(), pts: pts.slice(0, 1500), arrow }] });
      else draw();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  // Erase: click a link or drawing. (Right-click one in any tool to delete it too.)
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-link], [data-ink]');
    if (!g || tool !== 'erase') return;
    e.preventDefault(); e.stopPropagation();
    removeMark(g);
  });
  svg.addEventListener('contextmenu', (e) => {
    const g = e.target.closest('[data-link], [data-ink]');
    if (!g) return;
    e.preventDefault(); e.stopPropagation();
    menu({ x: e.clientX, y: e.clientY }, [{ label: g.dataset.link ? 'Delete link' : 'Delete drawing', icon: 'trash', danger: true, onSelect: () => removeMark(g) }]);
  });
  function removeMark(g) {
    if (g.dataset.link) save({ links: free().links.filter((l) => l.id !== g.dataset.link) });
    else save({ ink: free().ink.filter((k) => k.id !== g.dataset.ink) });
  }

  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tool !== 'move') { e.preventDefault(); e.stopPropagation(); setTool('move'); }
  });
  scroller.addEventListener('scroll', () => scrollMem.set(x.id, { left: scroller.scrollLeft, top: scroller.scrollTop }), { passive: true });
  const ro = new ResizeObserver(() => { if (!busy) { size(); draw(); } });
  ro.observe(scroller);

  build();
  requestAnimationFrame(() => {
    const m = scrollMem.get(x.id);
    if (m) { scroller.scrollLeft = m.left; scroller.scrollTop = m.top; }
    else scroller.scrollTop = scroller.scrollHeight;
  });

  return {
    el: scroller,
    tools,
    busy: () => busy,
    update(next) {
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      x = next;
      const keep = { left: scroller.scrollLeft, top: scroller.scrollTop };
      build();
      requestAnimationFrame(() => { scroller.scrollLeft = keep.left; scroller.scrollTop = atEnd ? scroller.scrollHeight : keep.top; });
    },
    destroy() { ro.disconnect(); },
  };
}
