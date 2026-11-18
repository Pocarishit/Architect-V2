// Free View — a Variables chat where messages stop being a locked column and become objects.
//   Select  drag a message by its handle anywhere. Drag on empty space for a selection window: everything
//           it catches moves together, goes back to the column together, or is cleared together.
//   Link    drag from one message to another to connect them (that's the arrow tool).
//   Box     draw a box around anything for emphasis.   Circle  the same, round.
//   Note    a quick text card that exists only here — never in the normal chat.
//   Erase   click a link, shape, note or old drawing to remove it.
//   Hand    drag to move around the canvas in any direction (also: middle mouse, or hold Space and drag).
// Pulled-out messages (photos and files included) and notes resize from their corner handle — in width
// and height together. The tools sit in a toolbar docked to the canvas's edge, like a Blueprint's.
// Every message keeps its spot: one you pull out leaves an invisible placeholder in the column, so the
// rest never slide up to fill the gap (double-click its handle and it goes back into that same slot).
// New messages land at the end of the column — the bottom of the conversation — with a handle ready.
// Layout lives on the entry: free = { on, pos: { msgId: {x, y} }, size: { msgId: {w, h} }, links: [{ id, a, b }],
//   shapes: [{ id, kind: 'box'|'ring', x, y, w, h }], cards: [{ id, x, y, w, h, text }], ink: [{ id, pts, arrow }] }
// (older layouts stored size as a bare width — still read.)
// (ink is from the old pen; it still shows and can be erased).
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, confirmDialog } from '../core/ui.js';
import { uid } from '../core/util.js';

const scrollMem = new Map(); // entry id → { left, top } so a repaint doesn't throw you back
const selMem = new Map();    // entry id → the selection, so it survives the chat repainting after a save
const TOOLS = [
  ['move', 'Select & move (V) — drag empty space to select', 'select'],
  ['hand', 'Move around (H · hold Space · middle mouse)', 'hand'],
  '-',
  ['link', 'Link messages', 'connector'],
  ['box', 'Draw a box', 'rect'],
  ['ring', 'Draw a circle', 'ellipse'],
  ['note', 'Add a note (only in free view)', 'sticky'],
  ['erase', 'Erase links, shapes and notes', 'eraser'],
];
const MIN_W = 120, MAX_W = 1600, MIN_H = 40, MAX_H = 2400, NOTE_W = 210;
const sizeOf = (v) => (v == null ? null : typeof v === 'number' ? { w: v } : v); // old saves: a bare width
let lastTool = 'move';

/**
 * @param {object} o
 *  entry(): latest entry · flowRows(list): column rows for these notes · one(m): a single message row
 *  save(free): store the layout · remove(msgIds, freePatch): delete messages from the chat (+ layout patch)
 *  idle(): a gesture ended without saving (lets the chat catch up on anything it held back)
 */
export function mountFreeView(o) {
  // Nov 18: also runs at the object level, where the "messages" are subsection tiles and variable cards
  // and the "column" is the grid. These options say what an item is and what it's called.
  const ITEM = o.item || '.sc-msg';            // an item's element (carries data-id)
  const BUBBLE = o.bubble || '.sc-bubble';     // the part links attach to
  const noun = o.noun || 'message', home = o.home || 'the column';
  let x = o.entry();
  let tool = TOOLS.some((t) => t[0] === lastTool) ? lastTool : 'move';
  let busy = false;
  const free = () => ({ on: true, pos: {}, size: {}, links: [], ink: [], shapes: [], cards: [], ...(x.free || {}) });
  const sel = selMem.get(x.id) || { msgs: new Set(), cards: new Set(), shapes: new Set() };
  selMem.set(x.id, sel);
  const selCount = () => sel.msgs.size + sel.cards.size + sel.shapes.size;
  const isSel = (kind, id) => sel[kind].has(id);
  let shapeLive = null; // id → { x, y, w, h } while shapes are being moved

  const svg = s('svg', { class: 'vr-fv-svg', 'aria-hidden': 'true' });
  const board = h('div', { class: 'vr-fv-board' });
  const capture = h('div', { class: 'vr-fv-capture' });
  const scroller = h('div', { class: o.className || 'vr-msgs vr-fv', role: o.role || 'log', tabindex: -1 }, board);
  // A real toolbar, docked to the canvas's left edge (Blueprint-style) — not floating over the content.
  const tools = h('div', { class: 'vr-fv-dock', role: 'toolbar', 'aria-label': 'Free view tools', 'aria-orientation': 'vertical' });
  const stage = h('div', { class: ['vr-fv-stage', o.stageClass] }, scroller, tools);

  const items = new Map(); // msg id → element (row)
  const cardEls = new Map(); // card id → element
  let flow = null;

  /* ---------------- build ---------------- */
  function build() {
    const f = free();
    const notes = x.notes || [];
    const live = new Set(notes.map((m) => m.id));
    for (const id of [...sel.msgs]) if (!live.has(id)) sel.msgs.delete(id);
    for (const id of [...sel.cards]) if (!f.cards.some((c) => c.id === id)) sel.cards.delete(id);
    for (const id of [...sel.shapes]) if (!f.shapes.some((c) => c.id === id)) sel.shapes.delete(id);
    const pinned = notes.filter((m) => f.pos[m.id]);
    items.clear(); cardEls.clear();
    // The column holds every message in order; the ones you've moved out stay as invisible
    // placeholders, so nothing slides up and new messages always arrive at the bottom.
    flow = h('div', { class: 'vr-fv-flow' }, o.flowRows(notes));
    for (const row of [...flow.querySelectorAll(`${ITEM}[data-id]`)]) {
      if (f.pos[row.dataset.id]) ghost(row);
      else { items.set(row.dataset.id, row); addGrip(row, row.dataset.id); }
    }
    const placed = pinned.map((m) => {
      const row = o.one(m);
      const wrap = itemWrap(m.id, f.pos[m.id], f.size[m.id]);
      wrap.prepend(row);
      items.set(m.id, row);
      addGrip(row, m.id);
      return wrap;
    });
    const cards = f.cards.map((c) => cardEl(c));
    board.replaceChildren(svg, flow, ...placed, ...cards, capture);
    board.dataset.tool = tool;
    paintTools();
    paintSel();
    requestAnimationFrame(() => { size(); draw(); });
  }

  // Sized items take the width and a minimum height: content that needs more (a long name) still grows it.
  function applySize(node, sz) {
    const z = sizeOf(sz);
    node.style.width = z?.w ? `${z.w}px` : '';
    node.style.minHeight = z?.h ? `${z.h}px` : '';
    if (o.baseW) node.style.setProperty('--fv-k', z?.w ? String(Math.max(0.6, z.w / o.baseW)) : '1');
  }
  function itemWrap(id, at, sz) {
    const wrap = h('div', { class: ['vr-fv-item', sz && 'is-sized'], 'data-id': id, style: { left: `${at.x}px`, top: `${at.y}px` } });
    applySize(wrap, sz);
    const grab = h('span', { class: 'vr-fv-size', title: o.lockRatio ? 'Drag to resize (Shift: free)' : 'Drag to resize (Shift: keep shape)', 'aria-hidden': 'true' });
    grab.addEventListener('pointerdown', (e) => resizeEl(e, wrap, (nz) => save({ size: { ...free().size, [id]: nz } })));
    grab.addEventListener('dblclick', (e) => { e.stopPropagation(); const sz = { ...free().size }; delete sz[id]; save({ size: sz }); });
    wrap.append(grab);
    return wrap;
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
    const grip = h('button', { type: 'button', class: 'vr-fv-grip', 'aria-label': `Drag this ${noun}`, title: `Drag anywhere · click to select · double-click to send it back to ${home}` }, icon('grip', 12));
    grip.addEventListener('click', (e) => e.stopPropagation()); // never opens what it's sitting on
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); toggleSel('msgs', id); return; }
      if (isSel('msgs', id) && selCount() > 1) dragGroup(e);
      else dragMsg(e, id);
    });
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); unpin(id); });
    grip.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const many = isSel('msgs', id) && selCount() > 1;
      menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [
        free().pos[id] ? { label: `Back to ${home}`, icon: 'list', onSelect: () => unpin(id) } : null,
        free().size[id] ? { label: 'Original size', icon: 'fit', onSelect: () => { const sz = { ...free().size }; delete sz[id]; save({ size: sz }); } } : null,
        { label: 'Remove its links', icon: 'connector', onSelect: () => save({ links: free().links.filter((l) => l.a !== id && l.b !== id) }) },
      ].filter(Boolean));
    });
    row.classList.add('has-grip');
    row.prepend(grip);
  }

  /* ---------------- notes (free-view-only text cards) ---------------- */
  function cardEl(c) {
    const text = h('div', { class: 'vr-fv-note-text' }, c.text || '');
    const grab = h('span', { class: 'vr-fv-size', title: 'Drag to resize', 'aria-hidden': 'true' });
    const node = h('div', { class: 'vr-fv-note', 'data-card': c.id, style: { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w || NOTE_W}px`, ...(c.h ? { minHeight: `${c.h}px` } : {}) } },
      h('span', { class: 'vr-fv-note-tag' }, 'NOTE'), text, grab);
    grab.addEventListener('pointerdown', (e) => resizeEl(e, node, (nz) => patchCard(c.id, nz), { ratio: false }));
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || text.isContentEditable || e.target === grab) return;
      if (tool === 'erase') { e.preventDefault(); e.stopPropagation(); removeCards([c.id]); return; }
      if (tool !== 'move') return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); toggleSel('cards', c.id); return; }
      if (isSel('cards', c.id) && selCount() > 1) { dragGroup(e); return; }
      dragCard(e, node, c);
    });
    node.addEventListener('dblclick', (e) => { e.stopPropagation(); editCard(node, c.id); });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const many = isSel('cards', c.id) && selCount() > 1;
      menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [
        { label: 'Edit note', icon: 'edit', onSelect: () => editCard(node, c.id) },
        { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => removeCards([c.id]) },
      ]);
    });
    cardEls.set(c.id, node);
    return node;
  }
  const patchCard = (id, p) => save({ cards: free().cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  function removeCards(ids) {
    const gone = new Set(ids);
    gone.forEach((id) => sel.cards.delete(id));
    save({ cards: free().cards.filter((c) => !gone.has(c.id)) });
  }

  function editCard(node, id, fresh = false) {
    const text = node.querySelector('.vr-fv-note-text');
    if (!text || text.isContentEditable) return;
    busy = true;
    node.classList.add('is-editing');
    text.contentEditable = 'true';
    text.focus();
    if (!fresh) document.getSelection()?.selectAllChildren(text);
    const before = text.innerText;
    const done = (keep) => {
      text.removeEventListener('blur', onBlur); text.removeEventListener('keydown', onKey);
      text.contentEditable = 'false';
      node.classList.remove('is-editing');
      busy = false;
      const t = keep ? text.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000) : before.trim();
      if (!t) { removeCards([id]); return; }
      if (t !== before.trim()) patchCard(id, { text: t }); else setTimeout(() => o.idle?.(), 0);
    };
    const onBlur = () => done(true);
    const onKey = (e) => {
      e.stopPropagation(); // keep the canvas shortcuts out of your typing
      if (e.key === 'Escape') { e.preventDefault(); text.blur(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); text.blur(); }
    };
    text.addEventListener('blur', onBlur); text.addEventListener('keydown', onKey);
  }

  function addCard(at) {
    const c = { id: uid(), x: Math.max(0, Math.round(at.x - 12)), y: Math.max(0, Math.round(at.y - 12)), w: NOTE_W, text: '' };
    const node = cardEl(c);
    board.insertBefore(node, capture);
    setTool('move');
    // It only saves once you've written something; an empty note just disappears.
    const text = node.querySelector('.vr-fv-note-text');
    busy = true;
    node.classList.add('is-editing');
    text.contentEditable = 'true';
    text.focus();
    const done = () => {
      text.removeEventListener('blur', done); text.removeEventListener('keydown', onKey);
      busy = false;
      const t = text.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
      if (!t) { node.remove(); cardEls.delete(c.id); setTimeout(() => o.idle?.(), 0); return; }
      save({ cards: [...free().cards, { ...c, text: t }] });
    };
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); text.blur(); } };
    text.addEventListener('blur', done); text.addEventListener('keydown', onKey);
  }

  /* ---------------- toolbar + selection ---------------- */
  function paintTools() {
    const n = selCount();
    const btn = (label, ic, fn, cls = '', on = null) => h('button', {
      type: 'button', class: ['vr-fv-tool', cls, on && 'is-on'], 'aria-label': label, 'data-tip': label, title: label, ...(on == null ? {} : { 'aria-pressed': String(on) }), onclick: fn,
    }, icon(ic, 17));
    const sep = () => h('span', { class: 'vr-fv-tsep', 'aria-hidden': 'true' });
    tools.replaceChildren(
      ...TOOLS.map((t) => (t === '-' ? sep() : btn(t[1], t[2], () => setTool(t[0]), '', tool === t[0]))),
      ...(n ? [
        sep(),
        h('span', { class: 'vr-fv-count', title: `${n} selected` }, String(n)),
        sel.msgs.size ? btn(`Back to ${home}`, 'list', () => unpinSel()) : null,
        !o.remove && !(sel.cards.size + sel.shapes.size) ? null : btn('Clear selected (Delete)', 'trash', () => deleteSel(), 'is-danger'),
        btn('Deselect (Esc)', 'close', () => clearSel()),
      ].filter(Boolean) : []));
  }
  function setTool(t) { tool = lastTool = t; board.dataset.tool = t; scroller.dataset.tool = t; paintTools(); }

  function paintSel() {
    for (const [id, row] of items) row.classList.toggle('is-fv-picked', sel.msgs.has(id));
    for (const [id, node] of cardEls) node.classList.toggle('is-picked', sel.cards.has(id));
    for (const g of svg.querySelectorAll('[data-shape]')) g.classList.toggle('is-picked', sel.shapes.has(g.dataset.shape));
    paintTools();
  }
  function toggleSel(kind, id) { if (sel[kind].has(id)) sel[kind].delete(id); else sel[kind].add(id); paintSel(); }
  function selectOnly(kind, id) { clearSel(false); sel[kind].add(id); paintSel(); }
  function clearSel(paint = true) { sel.msgs.clear(); sel.cards.clear(); sel.shapes.clear(); if (paint) paintSel(); }
  function selItems() {
    return [
      sel.msgs.size ? { label: `Back to ${home} (${sel.msgs.size})`, icon: 'list', onSelect: unpinSel } : null,
      o.remove || sel.cards.size + sel.shapes.size ? { label: `Clear ${o.remove ? selCount() : sel.cards.size + sel.shapes.size} selected`, icon: 'trash', danger: true, kbd: 'Del', onSelect: deleteSel } : null,
    ].filter(Boolean);
  }
  function unpinSel() {
    const pos = { ...free().pos }, sz = { ...free().size };
    for (const id of sel.msgs) { delete pos[id]; delete sz[id]; }
    save({ pos, size: sz });
  }
  async function deleteSel() {
    // Where items can't be deleted from here (tiles and variables), Delete clears only notes and shapes.
    const msgs = o.remove ? [...sel.msgs] : [];
    if (!o.remove && !(sel.cards.size + sel.shapes.size)) return;
    if (msgs.length && !(await confirmDialog(`Delete ${msgs.length} ${noun}${msgs.length === 1 ? '' : 's'}?`, `${msgs.length === 1 ? 'It leaves' : 'They leave'} the chat too, not just free view.`))) return;
    const patch = {
      cards: free().cards.filter((c) => !sel.cards.has(c.id)),
      shapes: free().shapes.filter((c) => !sel.shapes.has(c.id)),
    };
    clearSel(false);
    if (msgs.length) o.remove(msgs, patch); else save(patch);
  }

  /* ---------------- geometry ---------------- */
  const scaleOf = () => { const r = board.getBoundingClientRect(); return r.width / (board.offsetWidth || 1) || 1; };
  function local(e) {
    const r = board.getBoundingClientRect(), k = scaleOf();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }
  function rectOf(id) {
    const el = items.get(id);
    if (!el?.isConnected) return null;
    const b = el.querySelector(BUBBLE) || el;
    const r = b.getBoundingClientRect(), br = board.getBoundingClientRect(), k = scaleOf();
    return { x: (r.left - br.left) / k, y: (r.top - br.top) / k, w: r.width / k, h: r.height / k };
  }
  const shapeOf = (sh) => shapeLive?.get(sh.id) || sh;
  // The board grows to hold whatever you've pulled out, and never shrinks below the chat.
  function size() {
    let w = scroller.clientWidth, hgt = scroller.clientHeight;
    for (const node of board.querySelectorAll('.vr-fv-item, .vr-fv-note')) { w = Math.max(w, node.offsetLeft + node.offsetWidth + 160); hgt = Math.max(hgt, node.offsetTop + node.offsetHeight + 160); }
    for (const k of free().ink) for (const [px, py] of k.pts) { w = Math.max(w, px + 80); hgt = Math.max(hgt, py + 80); }
    for (const sh of free().shapes) { w = Math.max(w, sh.x + sh.w + 80); hgt = Math.max(hgt, sh.y + sh.h + 80); }
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
  const shapeSvg = (sh, cls) => (sh.kind === 'ring'
    ? s('ellipse', { class: cls, cx: sh.x + sh.w / 2, cy: sh.y + sh.h / 2, rx: Math.max(1, sh.w / 2), ry: Math.max(1, sh.h / 2) })
    : s('rect', { class: cls, x: sh.x, y: sh.y, width: Math.max(1, sh.w), height: Math.max(1, sh.h), rx: 12, ry: 12 }));

  function draw(live = null) {
    const f = free();
    const out = [];
    for (const raw of f.shapes) {
      const sh = shapeOf(raw);
      out.push(s('g', { class: ['vr-fv-shape', sel.shapes.has(sh.id) && 'is-picked'].filter(Boolean).join(' '), 'data-shape': sh.id }, shapeSvg(sh, 'hit'), shapeSvg(sh, '')));
    }
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
  function unpin(id) { const pos = { ...free().pos }, sz = { ...free().size }; delete pos[id]; delete sz[id]; save({ pos, size: sz }); }

  // One pointer-drag helper: move(ev) on every move, up(ev, how) once at the end.
  function track(move, up) {
    busy = true;
    const mv = (ev) => move(ev);
    const end = (ev) => {
      window.removeEventListener('pointermove', mv, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      busy = false;
      up(ev, ev.type === 'pointerup' ? 'up' : 'cancel');
      setTimeout(() => o.idle?.(), 0);
    };
    window.addEventListener('pointermove', mv, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  // Pull a column message out onto the board, right where it is — its slot stays put.
  function pullOut(id) {
    const row = items.get(id);
    if (!row) return null;
    let wrap = row.closest('.vr-fv-item');
    if (wrap) return wrap;
    const r0 = rectOf(id);
    const g = row.querySelector('.vr-fv-grip');
    const gx = g && getComputedStyle(g).position !== 'absolute' ? g.offsetWidth : 0;
    row.before(ghost(row.cloneNode(true)));
    wrap = itemWrap(id, { x: Math.max(0, Math.round(r0.x - gx)), y: Math.max(0, Math.round(r0.y)) }, null);
    board.insertBefore(wrap, capture);
    wrap.prepend(row);
    return wrap;
  }

  /* ---------------- drag one message ---------------- */
  function dragMsg(e, id) {
    e.preventDefault(); e.stopPropagation();
    const row = items.get(id);
    if (!row) return;
    const start = local(e);
    let wrap = row.closest('.vr-fv-item');
    let k0 = wrap ? { x: wrap.offsetLeft, y: wrap.offsetTop } : null;
    let moved = false, at = null;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
      if (!moved) {
        moved = true;
        if (!wrap) { wrap = pullOut(id); k0 = { x: wrap.offsetLeft, y: wrap.offsetTop }; }
        wrap.classList.add('is-held');
      }
      at = { x: Math.max(0, Math.round(k0.x + p.x - start.x)), y: Math.max(0, Math.round(k0.y + p.y - start.y)) };
      wrap.style.left = `${at.x}px`; wrap.style.top = `${at.y}px`;
      autoScroll(ev);
      draw();
    }, (ev, how) => {
      wrap?.classList.remove('is-held');
      if (moved && at) save({ pos: { ...free().pos, [id]: at } });
      else if (how === 'up') selectOnly('msgs', id); // a click on the handle selects it
    });
  }

  function dragCard(e, node, c) {
    e.preventDefault(); e.stopPropagation();
    const start = local(e);
    const k0 = { x: node.offsetLeft, y: node.offsetTop };
    let moved = false, at = null;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
      if (!moved) { moved = true; node.classList.add('is-held'); }
      at = { x: Math.max(0, Math.round(k0.x + p.x - start.x)), y: Math.max(0, Math.round(k0.y + p.y - start.y)) };
      node.style.left = `${at.x}px`; node.style.top = `${at.y}px`;
      autoScroll(ev);
    }, (ev, how) => {
      node.classList.remove('is-held');
      if (moved && at) patchCard(c.id, at);
      else if (how === 'up') selectOnly('cards', c.id);
    });
  }

  function dragShape(e, id) {
    const sh0 = free().shapes.find((q) => q.id === id);
    if (!sh0) return;
    e.preventDefault(); e.stopPropagation();
    const start = local(e);
    let moved = false;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
      moved = true;
      shapeLive = new Map([[id, { ...sh0, x: Math.max(0, Math.round(sh0.x + p.x - start.x)), y: Math.max(0, Math.round(sh0.y + p.y - start.y)) }]]);
      autoScroll(ev);
      draw();
    }, (ev, how) => {
      const done = shapeLive?.get(id);
      shapeLive = null;
      if (moved && done) save({ shapes: free().shapes.map((q) => (q.id === id ? done : q)) });
      else { if (how === 'up') selectOnly('shapes', id); draw(); }
    });
  }

  /* ---------------- drag the whole selection ---------------- */
  function dragGroup(e) {
    e.preventDefault(); e.stopPropagation();
    const start = local(e);
    const f = free();
    let moved = false;
    let msgs = []; // { id, wrap, x0, y0 }
    const cards = [...sel.cards].map((id) => ({ id, node: cardEls.get(id) })).filter((c) => c.node).map((c) => ({ ...c, x0: c.node.offsetLeft, y0: c.node.offsetTop }));
    const shapes = f.shapes.filter((q) => sel.shapes.has(q.id));
    let dx = 0, dy = 0;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
      if (!moved) {
        moved = true;
        // Column messages come out where they are first, so the group keeps its shape.
        msgs = [...sel.msgs].map((id) => { const wrap = pullOut(id); return wrap ? { id, wrap, x0: wrap.offsetLeft, y0: wrap.offsetTop } : null; }).filter(Boolean);
        msgs.forEach((m) => m.wrap.classList.add('is-held'));
        cards.forEach((c) => c.node.classList.add('is-held'));
      }
      dx = p.x - start.x; dy = p.y - start.y;
      // Never let the group slide past the top-left edge.
      const minX = Math.min(...msgs.map((m) => m.x0), ...cards.map((c) => c.x0), ...shapes.map((q) => q.x), Infinity);
      const minY = Math.min(...msgs.map((m) => m.y0), ...cards.map((c) => c.y0), ...shapes.map((q) => q.y), Infinity);
      dx = Math.round(Math.max(dx, -minX)); dy = Math.round(Math.max(dy, -minY));
      for (const m of msgs) { m.wrap.style.left = `${m.x0 + dx}px`; m.wrap.style.top = `${m.y0 + dy}px`; }
      for (const c of cards) { c.node.style.left = `${c.x0 + dx}px`; c.node.style.top = `${c.y0 + dy}px`; }
      shapeLive = new Map(shapes.map((q) => [q.id, { ...q, x: q.x + dx, y: q.y + dy }]));
      autoScroll(ev);
      draw();
    }, () => {
      msgs.forEach((m) => m.wrap.classList.remove('is-held'));
      cards.forEach((c) => c.node.classList.remove('is-held'));
      const live = shapeLive; shapeLive = null;
      if (!moved) { draw(); return; }
      const pos = { ...free().pos };
      for (const m of msgs) pos[m.id] = { x: m.x0 + dx, y: m.y0 + dy };
      const cardAt = new Map(cards.map((c) => [c.id, { x: c.x0 + dx, y: c.y0 + dy }]));
      save({
        pos,
        cards: free().cards.map((c) => (cardAt.has(c.id) ? { ...c, ...cardAt.get(c.id) } : c)),
        shapes: free().shapes.map((q) => live?.get(q.id) || q),
      });
    });
  }

  /* ---------------- resize (pulled-out messages, tiles, photos, files, notes) ---------------- */
  // The corner grows width and height together. Tiles keep their shape (o.lockRatio); messages and notes
  // follow the pointer freely. Shift flips that for one drag.
  function resizeEl(e, node, done, { ratio = !!o.lockRatio } = {}) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = local(e);
    const w0 = node.offsetWidth, h0 = node.offsetHeight;
    let w = w0, hh = h0;
    node.classList.add('is-sizing', 'is-sized');
    track((ev) => {
      const p = local(ev);
      const keep = ev.shiftKey ? !ratio : ratio;
      let nw = w0 + p.x - start.x, nh = h0 + p.y - start.y;
      if (keep) { const k = Math.max(nw / w0, nh / h0); nw = w0 * k; nh = h0 * k; }
      w = Math.round(Math.max(MIN_W, Math.min(MAX_W, nw)));
      hh = Math.round(Math.max(MIN_H, Math.min(MAX_H, keep ? h0 * (w / w0) : nh)));
      applySize(node, { w, h: hh });
      autoScroll(ev);
      draw();
    }, () => {
      node.classList.remove('is-sizing');
      if (w !== w0 || hh !== h0) done({ w, h: hh }); else draw();
    });
  }

  /* ---------------- move around: hand tool, middle mouse, or Space + drag ---------------- */
  // Drag the canvas any way you like — diagonals and circles included, not one axis at a time.
  let spaceHeld = false;
  const onSpace = (e) => {
    if (e.code !== 'Space' || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (!stage.isConnected || !stage.matches(':hover')) return;
    if (e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); if (!spaceHeld) { spaceHeld = true; scroller.classList.add('is-panready'); } }
    else { spaceHeld = false; scroller.classList.remove('is-panready'); }
  };
  window.addEventListener('keydown', onSpace, true);
  window.addEventListener('keyup', onSpace, true);
  scroller.addEventListener('pointerdown', (e) => {
    const handy = (e.button === 0 && (tool === 'hand' || spaceHeld)) || e.button === 1;
    if (!handy) return;
    if (e.button === 0 && tool === 'hand' && !spaceHeld && e.target.closest('button, a, input, textarea, [contenteditable="true"]')) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, l0 = scroller.scrollLeft, t0 = scroller.scrollTop;
    const k = scaleOf();
    let moved = false;
    scroller.classList.add('is-panning');
    track((ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      scroller.scrollLeft = l0 - (ev.clientX - sx) / k;
      scroller.scrollTop = t0 - (ev.clientY - sy) / k;
    }, () => {
      scroller.classList.remove('is-panning');
      // A pan never doubles as a click on whatever it ended over.
      if (moved) { const eat = (c) => { c.stopPropagation(); c.preventDefault(); }; window.addEventListener('click', eat, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', eat, true), 0); }
    });
  }, true);
  scroller.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  function autoScroll(ev) {
    const r = scroller.getBoundingClientRect(), edge = 36;
    if (ev.clientY > r.bottom - edge) scroller.scrollTop += 14;
    else if (ev.clientY < r.top + edge) scroller.scrollTop -= 14;
    if (ev.clientX > r.right - edge) scroller.scrollLeft += 14;
    else if (ev.clientX < r.left + edge) scroller.scrollLeft -= 14;
  }

  /* ---------------- selection window ---------------- */
  board.addEventListener('pointerdown', (e) => {
    if (tool !== 'move' || e.button !== 0 || spaceHeld) return;
    if (e.target.closest(`${ITEM}[data-id]`) || e.target.closest('.vr-fv-note, .vr-fv-size, button, a, input, textarea, [contenteditable="true"], [data-shape], [data-link], [data-ink]')) return;
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    const start = local(e);
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = { msgs: new Set(add ? sel.msgs : []), cards: new Set(add ? sel.cards : []), shapes: new Set(add ? sel.shapes : []) };
    const box = h('div', { class: 'vr-fv-marquee' });
    let shown = false;
    track((ev) => {
      const p = local(ev);
      if (!shown && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!shown) { shown = true; board.append(box); }
      const a = { l: Math.min(start.x, p.x), t: Math.min(start.y, p.y), r: Math.max(start.x, p.x), b: Math.max(start.y, p.y) };
      Object.assign(box.style, { left: `${a.l}px`, top: `${a.t}px`, width: `${a.r - a.l}px`, height: `${a.b - a.t}px` });
      const hits = (q) => q.x < a.r && q.x + q.w > a.l && q.y < a.b && q.y + q.h > a.t;
      sel.msgs = new Set(base.msgs); sel.cards = new Set(base.cards); sel.shapes = new Set(base.shapes);
      for (const id of items.keys()) { const r = rectOf(id); if (r && hits(r)) sel.msgs.add(id); }
      for (const [id, n] of cardEls) if (hits({ x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight })) sel.cards.add(id);
      // A shape joins when the window wraps all of it (so a box around messages comes along with them).
      for (const q of free().shapes) if (q.x >= a.l && q.y >= a.t && q.x + q.w <= a.r && q.y + q.h <= a.b) sel.shapes.add(q.id);
      autoScroll(ev);
      paintSel();
    }, () => {
      box.remove();
      if (!shown && !add) clearSel(); // a plain click on empty space clears it
    });
  });

  /* ---------------- link / shapes / notes / erase ---------------- */
  const msgAt = (e) => document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.(`${ITEM}[data-id]`)).find((n) => n && board.contains(n))?.dataset.id || null;

  capture.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (tool === 'link') return startLink(e);
    if (tool === 'box' || tool === 'ring') return startShape(e);
    if (tool === 'note') return addCard(local(e));
  });

  function startLink(e) {
    const a = msgAt(e);
    if (!a) return;
    const ra = rectOf(a);
    const from = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
    track((ev) => {
      const p = local(ev);
      autoScroll(ev);
      draw(s('path', { class: 'vr-fv-live', d: `M${from.x},${from.y} L${p.x},${p.y}` }));
      for (const n of board.querySelectorAll(`${ITEM}.is-target`)) n.classList.remove('is-target');
      const b = msgAt(ev);
      if (b && b !== a) items.get(b)?.classList.add('is-target');
    }, (ev, how) => {
      for (const n of board.querySelectorAll(`${ITEM}.is-target`)) n.classList.remove('is-target');
      const b = how === 'up' ? msgAt(ev) : null;
      const links = free().links;
      if (b && b !== a && !links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) save({ links: [...links, { id: uid(), a, b }] });
      else draw();
    });
  }

  // Box / circle: drag out its corner. Shift keeps it square / round.
  function startShape(e) {
    const kind = tool === 'ring' ? 'ring' : 'box';
    const a = local(e);
    let sh = null;
    track((ev) => {
      const p = local(ev);
      let w = p.x - a.x, hgt = p.y - a.y;
      if (ev.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m; }
      sh = { id: 'live', kind, x: Math.round(Math.min(a.x, a.x + w)), y: Math.round(Math.min(a.y, a.y + hgt)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(hgt)) };
      autoScroll(ev);
      draw(s('g', { class: 'vr-fv-shape is-live' }, shapeSvg(sh, '')));
    }, (ev, how) => {
      if (how === 'up' && sh && sh.w > 8 && sh.h > 8) save({ shapes: [...free().shapes, { ...sh, id: uid() }] });
      else draw();
    });
  }

  // In Select: drag a shape by its outline. Erase: click a link, shape or drawing.
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-link], [data-ink], [data-shape]');
    if (!g || e.button !== 0) return;
    if (tool === 'erase') { e.preventDefault(); e.stopPropagation(); removeMark(g); return; }
    if (tool === 'move' && g.dataset.shape) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); toggleSel('shapes', g.dataset.shape); return; }
      if (sel.shapes.has(g.dataset.shape) && selCount() > 1) dragGroup(e); else dragShape(e, g.dataset.shape);
    }
  });
  svg.addEventListener('contextmenu', (e) => {
    const g = e.target.closest('[data-link], [data-ink], [data-shape]');
    if (!g) return;
    e.preventDefault(); e.stopPropagation();
    const many = g.dataset.shape && sel.shapes.has(g.dataset.shape) && selCount() > 1;
    menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [{ label: g.dataset.link ? 'Delete link' : g.dataset.shape ? 'Delete shape' : 'Delete drawing', icon: 'trash', danger: true, onSelect: () => removeMark(g) }]);
  });
  function removeMark(g) {
    if (g.dataset.link) save({ links: free().links.filter((l) => l.id !== g.dataset.link) });
    else if (g.dataset.shape) { sel.shapes.delete(g.dataset.shape); save({ shapes: free().shapes.filter((q) => q.id !== g.dataset.shape) }); }
    else save({ ink: free().ink.filter((k) => k.id !== g.dataset.ink) });
  }

  scroller.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'v' || e.key === 'h')) { e.preventDefault(); e.stopPropagation(); setTool(e.key === 'h' ? 'hand' : 'move'); return; }
    if (e.key === 'Escape' && (tool !== 'move' || selCount())) { e.preventDefault(); e.stopPropagation(); if (tool !== 'move') setTool('move'); else clearSel(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selCount()) { e.preventDefault(); e.stopPropagation(); deleteSel(); }
  });
  scroller.addEventListener('scroll', () => scrollMem.set(x.id, { left: scroller.scrollLeft, top: scroller.scrollTop }), { passive: true });
  const ro = new ResizeObserver(() => { if (!busy) { size(); draw(); } });
  ro.observe(scroller);

  build();
  setTool(tool);
  requestAnimationFrame(() => {
    const m = scrollMem.get(x.id);
    if (m) { scroller.scrollLeft = m.left; scroller.scrollTop = m.top; }
    else if (!o.top) scroller.scrollTop = scroller.scrollHeight;
  });

  return {
    el: stage,
    scroller,
    tools,
    busy: () => busy,
    update(next) {
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      x = next;
      const keep = { left: scroller.scrollLeft, top: scroller.scrollTop };
      build();
      setTool(tool);
      requestAnimationFrame(() => { scroller.scrollLeft = keep.left; scroller.scrollTop = atEnd ? scroller.scrollHeight : keep.top; });
    },
    destroy() { ro.disconnect(); window.removeEventListener('keydown', onSpace, true); window.removeEventListener('keyup', onSpace, true); },
  };
}
