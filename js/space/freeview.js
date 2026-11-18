// Free View — a Variables chat (or a Variables object) where messages / tiles stop being a locked column
// and become objects on a canvas.
// Nov 19 rebuild:
//  · The toolbar is the Blueprint's toolbar: the same vertical pill, the same tool stack — Select, Hand,
//    Note, Text, Shapes, Connector, Draw, Grid, Lasso, Image — floating on the left of the canvas, and
//    collapsible (the chevron tucks the whole rail away; the small tab brings it back).
//  · No more grip: grab any object anywhere on it and drag. On a phone, press and hold a message in the
//    column for a beat to pick it up (so a normal swipe still scrolls); anything already on the canvas
//    moves straight away.
//  · Every pulled-out object (messages, photos, files, tiles, notes, text, images) resizes from all four
//    edges and all four corners.
//  · One wall, one open horizon: the right edge of the message area is a hard limit — nothing goes past
//    it, so there's never a scroll right into empty space. The left side is open: objects can go out past
//    the left edge and the canvas grows (and pans) that way to hold them.
// Every message keeps its spot: one you pull out leaves an invisible placeholder in the column, so the
// rest never slide up (right-click → "Back to the column" returns it to that same slot).
// Layout lives on the entry: free = { on, pos: { id: {x, y} }, size: { id: {w, h} },
//   links: [{ id, a, b, arrow }], shapes: [{ id, kind: 'box'|'ring'|'diamond'|'triangle', x, y, w, h }],
//   cards: [{ id, kind?: 'note'|'text'|'img', x, y, w, h, text, path }], ink: [{ id, pts, arrow }] }
// (older layouts stored size as a bare width — still read.)
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, confirmDialog, popover, closeFloating, toast } from '../core/ui.js';
import { uid, store } from '../core/util.js';

const scrollMem = new Map(); // entry id → { left, top } so a repaint doesn't throw you back
const selMem = new Map();    // entry id → the selection, so it survives the chat repainting after a save
const histMem = new Map();   // entry id → { undo: [], redo: [] } layout history, kept across repaints
const SHAPES = [['box', 'rect', 'Rectangle'], ['ring', 'ellipse', 'Ellipse'], ['diamond', 'diamond', 'Diamond'], ['triangle', 'triangle', 'Triangle']];
const KEYS = { v: 'move', h: 'hand', n: 'note', t: 'text', s: 'shape', l: 'link', p: 'pen', q: 'lasso' };
const MIN_W = 60, MAX_W = 1600, MIN_H = 32, MAX_H = 2400, NOTE_W = 210, TEXT_W = 220, IMG_W = 240;
const LEFT_PAD = 140; // room kept beyond the left-most object
const sizeOf = (v) => (v == null ? null : typeof v === 'number' ? { w: v } : v); // old saves: a bare width
const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const INTERACTIVE = 'button, a, input, textarea, select, audio, video, [contenteditable="true"], .vr-fv-h';
let lastTool = 'move';
let lastShape = 'box';
let lastLink = 'arrow';  // 'arrow' | 'line'
let lastPen = 'pen';     // 'pen' | 'eraser'

/**
 * @param {object} o
 *  entry(): latest entry · flowRows(list): column rows for these notes · one(m): a single message row
 *  save(free): store the layout · remove(msgIds, freePatch): delete messages from the chat (+ layout patch)
 *  idle(): a gesture ended without saving (lets the chat catch up on anything it held back)
 *  media: { pick, upload, url } — enables the Image tool (images placed only in free view)
 *  item / bubble / noun / home: what an object is called, for the object-level (grid) Free View
 */
export function mountFreeView(o) {
  const ITEM = o.item || '.sc-msg';            // an item's element (carries data-id)
  const BUBBLE = o.bubble || '.sc-bubble';     // the part links attach to
  const noun = o.noun || 'message', home = o.home || 'the column';
  let x = o.entry();
  const TOOLS = ['move', 'hand', 'note', 'text', 'shape', 'link', 'pen', 'lasso'];
  let tool = TOOLS.includes(lastTool) ? lastTool : 'move';
  let busy = false;
  const free = () => ({ on: true, pos: {}, size: {}, links: [], ink: [], shapes: [], cards: [], ...(x.free || {}) });
  const sel = selMem.get(x.id) || { msgs: new Set(), cards: new Set(), shapes: new Set() };
  selMem.set(x.id, sel);
  const selCount = () => sel.msgs.size + sel.cards.size + sel.shapes.size;
  const isSel = (kind, id) => sel[kind].has(id);
  let shapeLive = null; // id → { x, y, w, h } while shapes are being moved
  let gridOn = store.get('vr.fv.grid', true) !== false; // the dot grid is on unless you turn it off
  let railOff = !!store.get('vr.fv.rail.off', false);

  const svg = s('svg', { class: 'vr-fv-svg', 'aria-hidden': 'true' });
  const world = h('div', { class: 'vr-fv-world' });        // layout space: x = 0 is the column's left edge
  const capture = h('div', { class: 'vr-fv-capture' });
  const board = h('div', { class: ['vr-fv-board', gridOn && 'has-grid'] }, world, capture);
  const scroller = h('div', { class: o.className || 'vr-msgs vr-fv', role: o.role || 'log', tabindex: -1 }, board);
  const tools = h('div', { class: 'vr-fv-rail', role: 'toolbar', 'aria-label': 'Free view tools', 'aria-orientation': 'vertical' });
  const railTab = h('button', { type: 'button', class: 'vr-fv-railtab', 'aria-label': 'Show tools', 'data-tip': 'Show tools', onclick: () => setRail(true) }, icon('chevronRight', 16));
  const selbar = h('div', { class: 'vr-fv-selbar', role: 'toolbar', 'aria-label': 'Selection' });
  const hist = histMem.get(x.id) || { undo: [], redo: [] };
  histMem.set(x.id, hist);
  const stage = h('div', { class: ['vr-fv-stage', o.stageClass, railOff && 'is-rail-off'] }, scroller, tools, railTab, selbar);

  const items = new Map(); // msg id → element (row)
  const cardEls = new Map(); // card id → element
  let flow = null;
  let L = 0; // how far the canvas extends past the column's left edge

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
      else { items.set(row.dataset.id, row); row.classList.add('is-fv-obj'); }
    }
    const placed = pinned.map((m) => {
      const row = o.one(m);
      const wrap = itemWrap(m.id, f.pos[m.id], f.size[m.id]);
      wrap.prepend(row);
      row.classList.add('is-fv-obj');
      items.set(m.id, row);
      return wrap;
    });
    const cards = f.cards.map((c) => cardEl(c));
    world.replaceChildren(svg, flow, ...placed, ...cards);
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
    node.classList.toggle('is-sized', !!z?.w);
    if (o.baseW) node.style.setProperty('--fv-k', z?.w ? String(Math.max(0.5, z.w / o.baseW)) : '1');
  }
  function itemWrap(id, at, sz) {
    const wrap = h('div', { class: 'vr-fv-item', 'data-id': id, style: { left: `${at.x}px`, top: `${at.y}px` } });
    applySize(wrap, sz);
    addHandles(wrap, { ratio: !!o.lockRatio, done: (r) => save({ pos: { ...free().pos, [id]: { x: r.x, y: r.y } }, size: { ...free().size, [id]: { w: r.w, h: r.h } } }) });
    return wrap;
  }

  // Four edges and four corners. Edges stretch one way; corners both (tiles and images keep their shape —
  // Shift flips that for one drag). Double-click any handle: original size.
  function addHandles(node, opts) {
    for (const d of DIRS) {
      const hd = h('span', { class: `vr-fv-h is-${d}`, 'data-dir': d, 'aria-hidden': 'true', style: { cursor: CURSOR[d] } });
      hd.addEventListener('pointerdown', (e) => resizeEl(e, node, d, opts));
      hd.addEventListener('dblclick', (e) => { e.stopPropagation(); opts.reset?.(); });
      node.append(hd);
    }
    if (!opts.reset && node.dataset.id) opts.reset = () => { const sz = { ...free().size }; delete sz[node.dataset.id]; save({ size: sz }); };
  }

  // Keep a message's slot in the column without showing it (or letting it be clicked / linked).
  function ghost(row) {
    row.classList.add('vr-fv-ghost');
    row.removeAttribute('data-id');
    row.setAttribute('aria-hidden', 'true');
    row.inert = true;
    return row;
  }

  /* ---------------- cards: notes, text and images (free-view-only) ---------------- */
  const kindOf = (c) => c.kind || 'note';
  function cardEl(c) {
    const k = kindOf(c);
    let node;
    if (k === 'img') {
      const url = o.media?.url?.(c.path, () => { const im = node?.querySelector('img'); const u = o.media.url(c.path); if (im && u) im.src = u; else if (u && node) node.replaceChildren(h('img', { src: u, alt: '', draggable: false }), ...node.querySelectorAll('.vr-fv-h')); });
      node = h('div', { class: 'vr-fv-note is-img', 'data-card': c.id, style: { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w || IMG_W}px`, ...(c.h ? { height: `${c.h}px` } : {}) } },
        url ? h('img', { src: url, alt: '', draggable: false }) : h('span', { class: 'vr-fv-img-ph' }, icon('image', 18)));
    } else {
      const text = h('div', { class: 'vr-fv-note-text' }, c.text || '');
      node = h('div', { class: ['vr-fv-note', k === 'text' && 'is-text', c.h && 'is-sized'], 'data-card': c.id, style: { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w || (k === 'text' ? TEXT_W : NOTE_W)}px`, ...(c.h ? { minHeight: `${c.h}px` } : {}) } },
        k === 'note' ? h('span', { class: 'vr-fv-note-tag' }, 'NOTE') : null, text);
      node.addEventListener('dblclick', (e) => { e.stopPropagation(); editCard(node, c.id); });
    }
    addHandles(node, {
      ratio: k === 'img', card: true,
      done: (r) => patchCard(c.id, { x: r.x, y: r.y, w: r.w, h: r.h }),
      reset: () => patchCard(c.id, { w: k === 'img' ? IMG_W : k === 'text' ? TEXT_W : NOTE_W, h: k === 'img' ? Math.round(IMG_W * ((c.h || IMG_W) / (c.w || IMG_W))) : undefined }),
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const many = isSel('cards', c.id) && selCount() > 1;
      const label = k === 'img' ? 'image' : k === 'text' ? 'text' : 'note';
      menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [
        k !== 'img' ? { label: `Edit ${label}`, icon: 'edit', onSelect: () => editCard(node, c.id) } : null,
        { label: 'Remove its links', icon: 'connector', onSelect: () => save({ links: free().links.filter((l) => l.a !== c.id && l.b !== c.id) }) },
        { label: `Delete ${label}`, icon: 'trash', danger: true, onSelect: () => removeCards([c.id]) },
      ].filter(Boolean));
    });
    cardEls.set(c.id, node);
    return node;
  }
  const patchCard = (id, p) => save({ cards: free().cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  function removeCards(ids) {
    const gone = new Set(ids);
    gone.forEach((id) => sel.cards.delete(id));
    save({ cards: free().cards.filter((c) => !gone.has(c.id)), links: free().links.filter((l) => !gone.has(l.a) && !gone.has(l.b)) });
  }

  function editCard(node, id, fresh = null) {
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
      if (fresh) {
        if (!t) { node.remove(); cardEls.delete(id); setTimeout(() => o.idle?.(), 0); return; }
        save({ cards: [...free().cards, { ...fresh, text: t }] });
        return;
      }
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

  // Note / Text: click where it goes and start typing. It only saves once you've written something.
  function addCard(at, kind) {
    const w = kind === 'text' ? TEXT_W : NOTE_W;
    const W = wall();
    const c = { id: uid(), kind, x: Math.round(Math.min(at.x - 12, W - w)), y: Math.max(0, Math.round(at.y - 14)), w, text: '' };
    const node = cardEl(c);
    world.append(node);
    setTool('move');
    editCard(node, c.id, c);
  }

  async function addImage(at = null) {
    if (!o.media) return;
    const [f] = await o.media.pick({ multiple: false, accept: 'image/*' });
    if (!f) return;
    let dim = { w: IMG_W, h: IMG_W };
    try {
      const bmp = await createImageBitmap(f);
      dim = { w: IMG_W, h: Math.round(IMG_W * (bmp.height / bmp.width)) || IMG_W };
      bmp.close?.();
    } catch {}
    try {
      const up = await o.media.upload(f);
      const p = at || viewCenter();
      const W = wall();
      const w = Math.min(dim.w, W);
      save({ cards: [...free().cards, { id: uid(), kind: 'img', path: up.path, x: Math.round(Math.min(p.x - w / 2, W - w)), y: Math.max(0, Math.round(p.y - dim.h / 2)), w, h: Math.round(dim.h * (w / dim.w)) }] });
    } catch (e) { toast(e?.message || 'That image didn’t upload.', { tone: 'error' }); }
  }

  /* ---------------- the toolbar: Blueprint's vertical pill ---------------- */
  const flyOpts = () => ({ side: 'right', align: 'start', gap: 10 }); // the rail is vertical everywhere, phones too
  function paintTools() {
    const btn = (key, ic, label, fn, extra = {}) => h('button', {
      type: 'button', class: ['bp-tool vr-fv-tool', extra.fly && 'has-fly', (extra.on ?? (key && tool === key)) && 'is-on'],
      'aria-label': label, 'data-tip': label, ...(key || extra.on != null ? { 'aria-pressed': String(!!(extra.on ?? tool === key)) } : {}),
      onclick: (e) => fn(e.currentTarget),
    }, icon(ic, 20));
    const sep = () => h('span', { class: 'bp-tsep' });
    const f = free();
    const laidOut = Object.keys(f.pos || {}).length || (f.links || []).length || (f.shapes || []).length || (f.cards || []).length || (f.ink || []).length;
    const shapeIc = (SHAPES.find((q) => q[0] === lastShape) || SHAPES[0])[1];
    const undoB = btn(null, 'undo', 'Undo (Ctrl+Z)', () => history(true)); undoB.disabled = !hist.undo.length;
    const redoB = btn(null, 'redo', 'Redo (Ctrl+Shift+Z)', () => history(false)); redoB.disabled = !hist.redo.length;
    const resetB = btn(null, 'list', `Everything back to ${home}`, () => resetAll()); resetB.disabled = !laidOut;
    tools.replaceChildren(...[
      btn(null, 'chevronLeft', 'Hide tools', () => setRail(false)),
      sep(),
      btn('move', 'select', 'Select (V)', () => setTool('move')),
      btn('hand', 'hand', 'Hand (H · hold Space)', () => setTool('hand')),
      sep(),
      btn('note', 'sticky', 'Note (N)', () => setTool('note')),
      btn('text', 'text', 'Text (T)', () => setTool('text')),
      btn('shape', shapeIc, 'Shapes (S)', () => flyFrom('shape', 'Shapes (S)', shapeFly), { fly: true }),
      btn('link', lastLink === 'line' ? 'line' : 'arrow', 'Connector (L)', () => flyFrom('link', 'Connector (L)', linkFly), { fly: true }),
      btn('pen', lastPen === 'eraser' ? 'eraser' : 'pen', 'Draw (P)', () => flyFrom('pen', 'Draw (P)', penFly), { fly: true }),
      sep(),
      btn(null, 'grid', 'Dot grid (G)', () => setGrid(!gridOn), { on: gridOn }),
      btn('lasso', 'lasso', 'Lasso select (Q)', () => setTool('lasso')),
      o.media ? btn(null, 'image', 'Add an image (U)', () => addImage()) : null,
      h('span', { class: 'bp-tspace' }),
      undoB, redoB,
      sep(),
      btn(null, 'home', 'Back to the start', () => scroller.scrollTo({ left: L, top: 0, behavior: 'smooth' })),
      resetB].filter(Boolean));
    paintSelbar();
  }
  function paintSelbar() {
    const n = selCount();
    stage.classList.toggle('has-sel', !!n);
    if (!n) { selbar.replaceChildren(); return; }
    const b = (ic, label, fn, cls) => h('button', { type: 'button', class: ['vr-fv-sb', cls], 'aria-label': label, 'data-tip': label, 'data-tip-pos': 'top', onclick: fn }, icon(ic, 15));
    selbar.replaceChildren(...[
      h('span', { class: 'vr-fv-count', title: `${n} selected` }, String(n)),
      sel.msgs.size ? b('list', `Back to ${home}`, () => unpinSel()) : null,
      !o.remove && !(sel.cards.size + sel.shapes.size) ? null : b('trash', 'Clear selected (Delete)', () => deleteSel(), 'is-danger'),
      b('close', 'Deselect (Esc)', () => clearSel())].filter(Boolean));
  }
  // Picking a tool repaints the rail, so its options open from the fresh button.
  function flyFrom(t, label, fly) {
    setTool(t);
    const a = [...tools.querySelectorAll('.bp-tool')].find((b) => b.getAttribute('aria-label') === label);
    if (a) fly(a);
  }
  function shapeFly(anchor) {
    const grid = h('div', { class: 'shape-grid' }, SHAPES.map(([k, ic, name]) => h('button', {
      type: 'button', class: ['tool-opt', lastShape === k && 'is-on'], 'aria-label': name, title: name,
      onclick: () => { lastShape = k; setTool('shape'); closeFloating(); },
    }, icon(ic, 20))));
    popover(anchor, h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Shapes — drag on the canvas'), grid), flyOpts());
  }
  function linkFly(anchor) {
    const opt = (v, ic, label) => h('button', { type: 'button', class: ['tool-opt wide', lastLink === v && 'is-on'], onclick: () => { lastLink = v; setTool('link'); closeFloating(); } }, icon(ic, 18), h('span', {}, label));
    popover(anchor, h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, `Drag from one ${noun} to another to connect`),
      h('div', { class: 'opt-col' }, opt('arrow', 'arrow', 'Arrow'), opt('line', 'line', 'Line'))), flyOpts());
  }
  function penFly(anchor) {
    const opt = (v, ic, label) => h('button', { type: 'button', class: lastPen === v ? 'is-on' : null, 'aria-label': label, title: label, onclick: () => { lastPen = v; setTool('pen'); closeFloating(); } }, icon(ic, 16), h('span', {}, label));
    popover(anchor, h('div', { class: 'pop' },
      h('div', { class: 'seg seg-sm' }, opt('pen', 'pen', 'Pen'), opt('eraser', 'eraser', 'Eraser')),
      h('p', { class: 'pop-note' }, lastPen === 'eraser' ? 'Drag over drawings, links, shapes and notes to erase them.' : 'Draw anywhere on the canvas.')), flyOpts());
  }
  function setTool(t) {
    tool = lastTool = t;
    board.dataset.tool = t === 'pen' && lastPen === 'eraser' ? 'erase' : t;
    scroller.dataset.tool = t;
    paintTools();
  }
  function setGrid(on) { gridOn = on; store.set('vr.fv.grid', on); board.classList.toggle('has-grid', on); paintTools(); }
  function setRail(on) {
    railOff = !on; store.set('vr.fv.rail.off', railOff);
    stage.classList.toggle('is-rail-off', railOff);
    closeFloating();
    requestAnimationFrame(() => { size(); draw(); });
  }

  function paintSel() {
    for (const [id, row] of items) row.classList.toggle('is-fv-picked', sel.msgs.has(id));
    for (const [id, node] of cardEls) node.classList.toggle('is-picked', sel.cards.has(id));
    for (const g of svg.querySelectorAll('[data-shape]')) g.classList.toggle('is-picked', sel.shapes.has(g.dataset.shape));
    paintSelbar();
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
    const gone = new Set([...sel.cards]);
    const patch = {
      cards: free().cards.filter((c) => !gone.has(c.id)),
      shapes: free().shapes.filter((c) => !sel.shapes.has(c.id)),
      links: free().links.filter((l) => !gone.has(l.a) && !gone.has(l.b)),
    };
    clearSel(false);
    if (msgs.length) o.remove(msgs, patch); else save(patch);
  }

  /* ---------------- geometry ---------------- */
  const scaleOf = () => { const r = board.getBoundingClientRect(); return r.width / (board.offsetWidth || 1) || 1; };
  function local(e) {
    const r = world.getBoundingClientRect(), k = scaleOf();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }
  const wall = () => flow?.offsetWidth || scroller.clientWidth; // the right edge nothing passes
  function viewCenter() {
    return { x: scroller.scrollLeft - L + scroller.clientWidth / 2, y: scroller.scrollTop + scroller.clientHeight / 2 };
  }
  function rectOf(id) {
    const card = cardEls.get(id);
    const el = card || items.get(id);
    if (!el?.isConnected) return null;
    const b = card ? el : el.querySelector(BUBBLE) || el;
    const r = b.getBoundingClientRect(), wr = world.getBoundingClientRect(), k = scaleOf();
    return { x: (r.left - wr.left) / k, y: (r.top - wr.top) / k, w: r.width / k, h: r.height / k };
  }
  const shapeOf = (sh) => shapeLive?.get(sh.id) || sh;
  // The wall stays put at the column's right edge; the canvas grows left (and down) to hold everything.
  function size() {
    if (!flow) return;
    const W = scroller.clientWidth;
    flow.style.width = `${W}px`;
    const nodes = [...world.querySelectorAll('.vr-fv-item, .vr-fv-note')];
    // Anything sitting past the wall (an older layout, or a narrower chat) is shown against it.
    for (const n of nodes) {
      const w = Math.min(n.offsetWidth, W);
      if (n.offsetLeft + w > W) n.style.left = `${W - w}px`;
    }
    let minX = 0, hgt = scroller.clientHeight;
    for (const n of nodes) { minX = Math.min(minX, n.offsetLeft); hgt = Math.max(hgt, n.offsetTop + n.offsetHeight + 160); }
    for (const k of free().ink) for (const [px, py] of k.pts) { minX = Math.min(minX, px); hgt = Math.max(hgt, py + 80); }
    for (const raw of free().shapes) { const sh = shapeOf(raw); minX = Math.min(minX, sh.x); hgt = Math.max(hgt, sh.y + sh.h + 80); }
    hgt = Math.max(hgt, flow.offsetHeight + 24);
    const nextL = minX < 0 ? Math.ceil(-minX + LEFT_PAD) : 0;
    if (nextL !== L) {
      const d = nextL - L;
      L = nextL;
      world.style.left = `${L}px`;
      board.style.width = `${W + L}px`;
      scroller.scrollLeft += d; // the view stays where it was while the canvas grows left
    } else board.style.width = `${W + L}px`;
    board.style.height = `${hgt}px`;
    world.style.height = `${hgt}px`;
    svg.setAttribute('width', W); svg.setAttribute('height', hgt);
    tools.classList.toggle('is-scroll', tools.scrollHeight > stage.clientHeight - 16); // short panels: the rail scrolls
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
  const head = (tip, from, sz = 9) => {
    const a = Math.atan2(tip.y - from.y, tip.x - from.x), w = 0.45;
    return `M${tip.x - sz * Math.cos(a - w)},${tip.y - sz * Math.sin(a - w)} L${tip.x},${tip.y} L${tip.x - sz * Math.cos(a + w)},${tip.y - sz * Math.sin(a + w)}`;
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
  function shapeSvg(sh, cls) {
    const w = Math.max(1, sh.w), hh = Math.max(1, sh.h);
    if (sh.kind === 'ring') return s('ellipse', { class: cls, cx: sh.x + w / 2, cy: sh.y + hh / 2, rx: w / 2, ry: hh / 2 });
    if (sh.kind === 'diamond') return s('path', { class: `${cls} is-fill`.trim(), d: `M${sh.x + w / 2},${sh.y} L${sh.x + w},${sh.y + hh / 2} L${sh.x + w / 2},${sh.y + hh} L${sh.x},${sh.y + hh / 2} Z` });
    if (sh.kind === 'triangle') return s('path', { class: `${cls} is-fill`.trim(), d: `M${sh.x + w / 2},${sh.y} L${sh.x + w},${sh.y + hh} L${sh.x},${sh.y + hh} Z` });
    return s('rect', { class: cls, x: sh.x, y: sh.y, width: w, height: hh, rx: 12, ry: 12 });
  }

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
        l.arrow === false ? null : s('path', { d: head(c.end, c.from, 7) })));
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
  function save(p, { record = true } = {}) {
    if (record) { hist.undo.push(JSON.parse(JSON.stringify(free()))); if (hist.undo.length > 60) hist.undo.shift(); hist.redo.length = 0; }
    o.save({ ...free(), ...p, on: true });
  }
  function history(back) {
    const from = back ? hist.undo : hist.redo, to = back ? hist.redo : hist.undo;
    const snap = from.pop();
    if (!snap) return;
    to.push(JSON.parse(JSON.stringify(free())));
    clearSel(false);
    save(snap, { record: false });
  }
  function resetAll() {
    clearSel(false);
    save({ pos: {}, size: {}, links: [], shapes: [], cards: [], ink: [] });
  }
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
  // After a drag, the click that ends it must not open what it landed on.
  function eatClick() {
    const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, true), 0);
  }

  // Pull a column message out onto the canvas, right where it is — its slot stays put.
  function pullOut(id) {
    const row = items.get(id);
    if (!row) return null;
    let wrap = row.closest('.vr-fv-item');
    if (wrap) return wrap;
    const r0 = rectOf(id);
    const rr = row.getBoundingClientRect(), wr = world.getBoundingClientRect(), k = scaleOf();
    row.before(ghost(row.cloneNode(true)));
    wrap = itemWrap(id, { x: Math.round((rr.left - wr.left) / k), y: Math.max(0, Math.round((rr.top - wr.top) / k)) }, null);
    world.append(wrap);
    wrap.prepend(row);
    if (r0 && o.lockRatio) applySize(wrap, null);
    return wrap;
  }
  const clampX = (xx, w) => Math.round(Math.min(xx, wall() - w)); // the wall on the right; open on the left
  const clampY = (yy) => Math.max(0, Math.round(yy));

  /* ---------------- grab anything, anywhere, and drag it ---------------- */
  function dragMsg(e, id) {
    const row = items.get(id);
    if (!row) return;
    const start = local(e);
    let wrap = row.closest('.vr-fv-item');
    let k0 = wrap ? { x: wrap.offsetLeft, y: wrap.offsetTop } : null;
    let moved = false, at = null;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!moved) {
        moved = true;
        if (!wrap) { wrap = pullOut(id); k0 = { x: wrap.offsetLeft, y: wrap.offsetTop }; }
        wrap.classList.add('is-held');
      }
      at = { x: clampX(k0.x + p.x - start.x, wrap.offsetWidth), y: clampY(k0.y + p.y - start.y) };
      wrap.style.left = `${at.x}px`; wrap.style.top = `${at.y}px`;
      autoScroll(ev);
      size(); draw();
    }, (ev, how) => {
      wrap?.classList.remove('is-held');
      if (moved && at) { eatClick(); save({ pos: { ...free().pos, [id]: at } }); }
      else if (how === 'up') selectOnly('msgs', id); // a plain click selects it (and still does its own thing)
    });
  }

  function dragCard(e, node, id) {
    const start = local(e);
    const k0 = { x: node.offsetLeft, y: node.offsetTop };
    let moved = false, at = null;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!moved) { moved = true; node.classList.add('is-held'); }
      at = { x: clampX(k0.x + p.x - start.x, node.offsetWidth), y: clampY(k0.y + p.y - start.y) };
      node.style.left = `${at.x}px`; node.style.top = `${at.y}px`;
      autoScroll(ev);
      size(); draw();
    }, (ev, how) => {
      node.classList.remove('is-held');
      if (moved && at) { eatClick(); patchCard(id, at); }
      else if (how === 'up') selectOnly('cards', id);
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
      shapeLive = new Map([[id, { ...sh0, x: clampX(sh0.x + p.x - start.x, sh0.w), y: clampY(sh0.y + p.y - start.y) }]]);
      autoScroll(ev);
      size(); draw();
    }, (ev, how) => {
      const done = shapeLive?.get(id);
      shapeLive = null;
      if (moved && done) save({ shapes: free().shapes.map((q) => (q.id === id ? done : q)) });
      else { if (how === 'up') selectOnly('shapes', id); draw(); }
    });
  }

  function dragGroup(e) {
    const start = local(e);
    const f = free();
    let moved = false;
    let msgs = []; // { id, wrap, x0, y0 }
    const cards = [...sel.cards].map((id) => ({ id, node: cardEls.get(id) })).filter((c) => c.node).map((c) => ({ ...c, x0: c.node.offsetLeft, y0: c.node.offsetTop }));
    const shapes = f.shapes.filter((q) => sel.shapes.has(q.id));
    let dx = 0, dy = 0;
    track((ev) => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!moved) {
        moved = true;
        // Column messages come out where they are first, so the group keeps its shape.
        msgs = [...sel.msgs].map((id) => { const wrap = pullOut(id); return wrap ? { id, wrap, x0: wrap.offsetLeft, y0: wrap.offsetTop } : null; }).filter(Boolean);
        msgs.forEach((m) => m.wrap.classList.add('is-held'));
        cards.forEach((c) => c.node.classList.add('is-held'));
      }
      dx = p.x - start.x; dy = p.y - start.y;
      // The group stops at the wall and the top; the left is open.
      const maxR = Math.max(...msgs.map((m) => m.x0 + m.wrap.offsetWidth), ...cards.map((c) => c.x0 + c.node.offsetWidth), ...shapes.map((q) => q.x + q.w), -Infinity);
      const minY = Math.min(...msgs.map((m) => m.y0), ...cards.map((c) => c.y0), ...shapes.map((q) => q.y), Infinity);
      dx = Math.round(Math.min(dx, wall() - maxR)); dy = Math.round(Math.max(dy, -minY));
      for (const m of msgs) { m.wrap.style.left = `${m.x0 + dx}px`; m.wrap.style.top = `${m.y0 + dy}px`; }
      for (const c of cards) { c.node.style.left = `${c.x0 + dx}px`; c.node.style.top = `${c.y0 + dy}px`; }
      shapeLive = new Map(shapes.map((q) => [q.id, { ...q, x: q.x + dx, y: q.y + dy }]));
      autoScroll(ev);
      size(); draw();
    }, () => {
      msgs.forEach((m) => m.wrap.classList.remove('is-held'));
      cards.forEach((c) => c.node.classList.remove('is-held'));
      const live = shapeLive; shapeLive = null;
      if (!moved) { draw(); return; }
      eatClick();
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

  /* ---------------- resize from any edge or corner ---------------- */
  function resizeEl(e, node, dir, { ratio = false, card = false, done }) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = local(e);
    const x0 = node.offsetLeft, y0 = node.offsetTop, w0 = node.offsetWidth, h0 = node.offsetHeight;
    const W = wall();
    let r = { x: x0, y: y0, w: w0, h: h0 };
    const corner = dir.length === 2;
    node.classList.add('is-sizing');
    track((ev) => {
      const p = local(ev);
      const dx = p.x - start.x, dy = p.y - start.y;
      let nw = w0, nh = h0;
      if (dir.includes('e')) nw = w0 + dx;
      if (dir.includes('w')) nw = w0 - dx;
      if (dir.includes('s')) nh = h0 + dy;
      if (dir.includes('n')) nh = h0 - dy;
      const keep = corner && (ev.shiftKey ? !ratio : ratio);
      if (keep) { const k = Math.max(nw / w0, nh / h0); nw = w0 * k; nh = h0 * k; }
      // Limits: a minimum size, the top edge, and the wall on the right.
      const maxW = dir.includes('w') ? Infinity : W - x0; // growing left is open; right stops at the wall
      nw = Math.max(MIN_W, Math.min(MAX_W, maxW, nw));
      if (dir.includes('n')) nh = Math.min(nh, y0 + h0);
      nh = Math.max(MIN_H, Math.min(MAX_H, nh));
      if (keep) nh = Math.max(MIN_H, h0 * (nw / w0));
      nw = Math.round(nw); nh = Math.round(nh);
      const nx = dir.includes('w') ? x0 + w0 - nw : x0;
      const ny = dir.includes('n') ? Math.max(0, y0 + h0 - nh) : y0;
      r = { x: Math.round(nx), y: Math.round(ny), w: nw, h: nh };
      node.style.left = `${r.x}px`; node.style.top = `${r.y}px`;
      if (card) {
        node.style.width = `${nw}px`;
        if (node.classList.contains('is-img')) node.style.height = `${nh}px`; else { node.style.minHeight = `${nh}px`; node.classList.add('is-sized'); }
      } else applySize(node, { w: nw, h: nh });
      autoScroll(ev);
      size(); draw();
    }, () => {
      node.classList.remove('is-sizing');
      if (r.w !== w0 || r.h !== h0 || r.x !== x0 || r.y !== y0) done(r); else draw();
    });
  }

  /* ---------------- move around: hand tool, middle mouse, or Space + drag ---------------- */
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
      if (moved) eatClick(); // a pan never doubles as a click on whatever it ended over
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

  /* ---------------- Select tool: objects, or a selection window on empty space ---------------- */
  board.addEventListener('pointerdown', (e) => {
    // Finish any note being typed first (the drags below hold focus still, so it wouldn't blur itself).
    const ae = document.activeElement;
    if (ae?.isContentEditable && world.contains(ae) && !ae.contains(e.target)) ae.blur();
    if (tool !== 'move' || e.button !== 0 || spaceHeld) return;
    // Controls inside an object do their own thing — except a photo / video, which is the object itself
    // (a click still opens it; a drag moves it).
    const ctl = e.target.closest(INTERACTIVE);
    if ((ctl && !ctl.matches('.sc-file')) || e.target.closest('[data-shape], [data-link], [data-ink]')) return;
    const card = e.target.closest('.vr-fv-note[data-card]');
    const row = card ? null : e.target.closest(`${ITEM}[data-id]`);
    if (card) {
      if (card.classList.contains('is-editing')) return;
      const id = card.dataset.card;
      e.preventDefault();
      if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSel('cards', id); return; }
      if (isSel('cards', id) && selCount() > 1) dragGroup(e); else dragCard(e, card, id);
      return;
    }
    if (row && board.contains(row)) {
      const id = row.dataset.id;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); eatClick(); toggleSel('msgs', id); return; }
      const inColumn = !row.closest('.vr-fv-item');
      if (e.pointerType === 'touch' && inColumn) { holdToLift(e, row, id); return; }
      if (e.pointerType !== 'touch') e.preventDefault(); // no text selection or image ghost while dragging
      if (isSel('msgs', id) && selCount() > 1) dragGroup(e); else dragMsg(e, id);
      return;
    }
    marquee(e);
  });

  // On a phone, the column still scrolls under a normal swipe: hold a beat and the message lifts.
  function holdToLift(e, row, id) {
    const sx = e.clientX, sy = e.clientY;
    let armed = false;
    const block = (ev) => { if (armed) ev.preventDefault(); };
    row.addEventListener('touchmove', block, { passive: false });
    const quit = () => { clearTimeout(t); row.removeEventListener('touchmove', block); window.removeEventListener('pointermove', early, true); window.removeEventListener('pointerup', quit, true); window.removeEventListener('pointercancel', quit, true); };
    const early = (ev) => { if (!armed && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) quit(); };
    const t = setTimeout(() => {
      armed = true;
      navigator.vibrate?.(10);
      row.classList.add('is-lifting');
      window.removeEventListener('pointermove', early, true);
      const up = () => { row.classList.remove('is-lifting'); row.removeEventListener('touchmove', block); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
      window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
      if (isSel('msgs', id) && selCount() > 1) dragGroup(e); else dragMsg(e, id);
    }, 280);
    window.addEventListener('pointermove', early, true);
    window.addEventListener('pointerup', quit, true);
    window.addEventListener('pointercancel', quit, true);
  }

  function marquee(e) {
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
      if (!shown) { shown = true; world.append(box); }
      const a = { l: Math.min(start.x, p.x), t: Math.min(start.y, p.y), r: Math.max(start.x, p.x), b: Math.max(start.y, p.y) };
      Object.assign(box.style, { left: `${a.l}px`, top: `${a.t}px`, width: `${a.r - a.l}px`, height: `${a.b - a.t}px` });
      const hits = (q) => q.x < a.r && q.x + q.w > a.l && q.y < a.b && q.y + q.h > a.t;
      pick(base, (q) => hits(q), (q) => q.x >= a.l && q.y >= a.t && q.x + q.w <= a.r && q.y + q.h <= a.b);
      autoScroll(ev);
    }, () => {
      box.remove();
      if (!shown && !add) clearSel(); // a plain click on empty space clears it
    });
  }
  // Fill the selection from a hit test: objects by `hit`, shapes only when `wraps` (a box around
  // messages comes along with them).
  function pick(base, hit, wraps) {
    sel.msgs = new Set(base.msgs); sel.cards = new Set(base.cards); sel.shapes = new Set(base.shapes);
    for (const id of items.keys()) { const r = rectOf(id); if (r && hit(r)) sel.msgs.add(id); }
    for (const [id, n] of cardEls) if (hit({ x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight })) sel.cards.add(id);
    for (const q of free().shapes) if (wraps(q)) sel.shapes.add(q.id);
    paintSel();
  }

  /* ---------------- the canvas tools (capture layer) ---------------- */
  const objAt = (e) => {
    for (const n of document.elementsFromPoint(e.clientX, e.clientY)) {
      const c = n.closest?.('.vr-fv-note[data-card]');
      if (c && world.contains(c)) return c.dataset.card;
      const m = n.closest?.(`${ITEM}[data-id]`);
      if (m && world.contains(m)) return m.dataset.id;
    }
    return null;
  };
  const elOf = (id) => cardEls.get(id) || items.get(id);

  capture.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || spaceHeld) return;
    e.preventDefault(); e.stopPropagation();
    if (tool === 'link') return startLink(e);
    if (tool === 'shape') return startShape(e);
    if (tool === 'note' || tool === 'text') return addCard(local(e), tool);
    if (tool === 'pen') return lastPen === 'eraser' ? startErase(e) : startInk(e);
    if (tool === 'lasso') return startLasso(e);
  });

  function startLink(e) {
    const a = objAt(e);
    if (!a) return;
    const ra = rectOf(a);
    const from = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
    const mark = (id, on) => elOf(id)?.classList.toggle('is-target', on);
    let last = null;
    track((ev) => {
      const p = local(ev);
      autoScroll(ev);
      draw(s('path', { class: 'vr-fv-live', d: `M${from.x},${from.y} L${p.x},${p.y}` }));
      const b = objAt(ev);
      if (last && last !== b) mark(last, false);
      if (b && b !== a) mark(b, true);
      last = b;
    }, (ev, how) => {
      if (last) mark(last, false);
      const b = how === 'up' ? objAt(ev) : null;
      const links = free().links;
      if (b && b !== a && !links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) save({ links: [...links, { id: uid(), a, b, arrow: lastLink !== 'line' }] });
      else draw();
    });
  }

  // Shapes: drag out the corner. Shift keeps it even.
  function startShape(e) {
    const kind = lastShape;
    const a = local(e);
    let sh = null;
    const W = wall();
    track((ev) => {
      const p = local(ev);
      const px = Math.min(p.x, W);
      let w = px - a.x, hgt = p.y - a.y;
      if (ev.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m; }
      const x0 = Math.min(a.x, a.x + w), y0 = Math.max(0, Math.min(a.y, a.y + hgt));
      sh = { id: 'live', kind, x: Math.round(x0), y: Math.round(y0), w: Math.round(Math.min(Math.abs(w), W - x0)), h: Math.round(Math.abs(hgt)) };
      autoScroll(ev);
      draw(s('g', { class: 'vr-fv-shape is-live' }, shapeSvg(sh, '')));
    }, (ev, how) => {
      if (how === 'up' && sh && sh.w > 8 && sh.h > 8) save({ shapes: [...free().shapes, { ...sh, id: uid() }] });
      else draw();
    });
  }

  function startInk(e) {
    const W = wall();
    const p0 = local(e);
    const pts = [[Math.round(Math.min(p0.x, W)), Math.round(Math.max(0, p0.y))]];
    track((ev) => {
      const p = local(ev);
      const q = [Math.round(Math.min(p.x, W)), Math.round(Math.max(0, p.y))];
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(q[0] - lx, q[1] - ly) < 2.5) return;
      pts.push(q);
      autoScroll(ev);
      draw(s('g', { class: 'vr-fv-ink is-live' }, s('path', { d: smooth(pts) })));
    }, (ev, how) => {
      if (how === 'up' && pts.length > 1) save({ ink: [...free().ink, { id: uid(), pts }] });
      else draw();
    });
  }

  // Eraser: sweep over drawings, links, shapes and notes. One save (and one undo) for the whole sweep.
  function startErase(e) {
    const hit = { ink: new Set(), links: new Set(), shapes: new Set(), cards: new Set() };
    const sweep = (ev) => {
      for (const n of document.elementsFromPoint(ev.clientX, ev.clientY)) {
        const g = n.closest?.('[data-ink], [data-link], [data-shape]');
        if (g && svg.contains(g)) {
          if (g.dataset.ink) hit.ink.add(g.dataset.ink); else if (g.dataset.link) hit.links.add(g.dataset.link); else hit.shapes.add(g.dataset.shape);
          g.classList.add('is-erasing');
        }
        const c = n.closest?.('.vr-fv-note[data-card]');
        if (c && world.contains(c)) { hit.cards.add(c.dataset.card); c.classList.add('is-erasing'); }
      }
    };
    capture.style.pointerEvents = 'none'; // let the hit test see what's underneath
    sweep(e);
    track((ev) => sweep(ev), () => {
      capture.style.pointerEvents = '';
      const n = hit.ink.size + hit.links.size + hit.shapes.size + hit.cards.size;
      if (!n) { draw(); return; }
      hit.shapes.forEach((id) => sel.shapes.delete(id)); hit.cards.forEach((id) => sel.cards.delete(id));
      const f = free();
      save({
        ink: f.ink.filter((k) => !hit.ink.has(k.id)),
        links: f.links.filter((l) => !hit.links.has(l.id) && !hit.cards.has(l.a) && !hit.cards.has(l.b)),
        shapes: f.shapes.filter((q) => !hit.shapes.has(q.id)),
        cards: f.cards.filter((c) => !hit.cards.has(c.id)),
      });
    });
  }

  // Lasso: draw a loop; whatever's centre falls inside it is selected.
  function startLasso(e) {
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = { msgs: new Set(add ? sel.msgs : []), cards: new Set(add ? sel.cards : []), shapes: new Set(add ? sel.shapes : []) };
    const p0 = local(e);
    const pts = [[p0.x, p0.y]];
    const inside = (px, py) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const centre = (q) => inside(q.x + q.w / 2, q.y + q.h / 2);
    track((ev) => {
      const p = local(ev);
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) < 3) return;
      pts.push([p.x, p.y]);
      autoScroll(ev);
      draw(s('path', { class: 'vr-fv-lasso', d: `M${pts.map((q) => q.join(',')).join(' L')} Z` }));
      if (pts.length > 3) pick(base, centre, centre);
    }, () => {
      draw();
      if (pts.length < 4 && !add) clearSel();
      else if (selCount()) setTool('move'); // straight into moving what you caught
    });
  }

  // In Select: drag a shape by its outline. Right-click a mark to delete it.
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-link], [data-ink], [data-shape]');
    if (!g || e.button !== 0) return;
    if (tool === 'move' && g.dataset.shape) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); toggleSel('shapes', g.dataset.shape); return; }
      if (sel.shapes.has(g.dataset.shape) && selCount() > 1) { e.preventDefault(); e.stopPropagation(); dragGroup(e); } else dragShape(e, g.dataset.shape);
    }
  });
  svg.addEventListener('contextmenu', (e) => {
    const g = e.target.closest('[data-link], [data-ink], [data-shape]');
    if (!g) return;
    e.preventDefault(); e.stopPropagation();
    const many = g.dataset.shape && sel.shapes.has(g.dataset.shape) && selCount() > 1;
    const link = g.dataset.link && free().links.find((l) => l.id === g.dataset.link);
    menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [
      link ? { label: link.arrow === false ? 'Make it an arrow' : 'Make it a line', icon: link.arrow === false ? 'arrow' : 'line', onSelect: () => save({ links: free().links.map((l) => (l.id === link.id ? { ...l, arrow: l.arrow === false } : l)) }) } : null,
      { label: g.dataset.link ? 'Delete link' : g.dataset.shape ? 'Delete shape' : 'Delete drawing', icon: 'trash', danger: true, onSelect: () => removeMark(g) },
    ].filter(Boolean));
  });
  function removeMark(g) {
    if (g.dataset.link) save({ links: free().links.filter((l) => l.id !== g.dataset.link) });
    else if (g.dataset.shape) { sel.shapes.delete(g.dataset.shape); save({ shapes: free().shapes.filter((q) => q.id !== g.dataset.shape) }); }
    else save({ ink: free().ink.filter((k) => k.id !== g.dataset.ink) });
  }

  // Right-click an object: its own options (the item's own menu still wins where it has one).
  world.addEventListener('contextmenu', (e) => {
    const row = e.target.closest(`${ITEM}[data-id]`);
    if (!row || e.defaultPrevented) return;
    const id = row.dataset.id;
    if (!free().pos[id] && !(isSel('msgs', id) && selCount() > 1)) return;
    e.preventDefault(); e.stopPropagation();
    const many = isSel('msgs', id) && selCount() > 1;
    menu({ x: e.clientX, y: e.clientY }, many ? selItems() : [
      { label: `Back to ${home}`, icon: 'list', onSelect: () => unpin(id) },
      free().size[id] ? { label: 'Original size', icon: 'fit', onSelect: () => { const sz = { ...free().size }; delete sz[id]; save({ size: sz }); } } : null,
      { label: 'Remove its links', icon: 'connector', onSelect: () => save({ links: free().links.filter((l) => l.a !== id && l.b !== id) }) },
    ].filter(Boolean));
  });

  scroller.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.stopPropagation(); history(!e.shiftKey); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); e.stopPropagation(); history(false); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (KEYS[k]) { e.preventDefault(); e.stopPropagation(); setTool(KEYS[k]); return; }
      if (k === 'g') { e.preventDefault(); e.stopPropagation(); setGrid(!gridOn); return; }
      if (k === 'u' && o.media) { e.preventDefault(); e.stopPropagation(); addImage(); return; }
    }
    if (e.key === 'Escape' && (tool !== 'move' || selCount())) { e.preventDefault(); e.stopPropagation(); if (tool !== 'move') setTool('move'); else clearSel(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selCount()) { e.preventDefault(); e.stopPropagation(); deleteSel(); }
  });
  scroller.addEventListener('scroll', () => scrollMem.set(x.id, { left: scroller.scrollLeft - L, top: scroller.scrollTop }), { passive: true });
  const ro = new ResizeObserver(() => { if (!busy) { size(); draw(); } });
  ro.observe(scroller);

  build();
  setTool(tool);
  requestAnimationFrame(() => {
    size();
    const m = scrollMem.get(x.id);
    if (m) { scroller.scrollLeft = m.left + L; scroller.scrollTop = m.top; }
    else { scroller.scrollLeft = L; if (!o.top) scroller.scrollTop = scroller.scrollHeight; }
  });

  return {
    el: stage,
    scroller,
    tools,
    busy: () => busy,
    update(next) {
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      x = next;
      const keep = { left: scroller.scrollLeft - L, top: scroller.scrollTop };
      build();
      setTool(tool);
      requestAnimationFrame(() => { size(); scroller.scrollLeft = keep.left + L; scroller.scrollTop = atEnd ? scroller.scrollHeight : keep.top; });
    },
    destroy() { ro.disconnect(); window.removeEventListener('keydown', onSpace, true); window.removeEventListener('keyup', onSpace, true); },
  };
}
