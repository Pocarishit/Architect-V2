// Blueprint canvas engine: state, camera, rendering, gestures, keyboard, clipboard, history.
import { h, s, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { uid, clamp, store, prefersReducedMotion } from '../core/util.js';
import { createNode, updateNode, fitText } from './render.js';
import {
  TEXTUAL, CONNECTABLE, rectOf, unionRects, intersects, contains, pointIn,
  rectFromPoints, lineGeom, distToSeg, penPath, simplify, center, nearestSide, DIR_SIDE } from './geometry.js';
import { css } from './palette.js';
import { sanitize, hasRichMarkup } from './richtext.js';
import { looksLikeUrl, extractUrl } from './embed.js';

export const CLIP_MARK = 'ARCHITECT/BLUEPRINT/1\n';
const MIN_Z = 0.05;
// CSS zoom with standard (Chrome 128+ / Firefox 126+ / Safari) semantics.
const CHROME = Number((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1]) || 0;
const ZOOM_OK = typeof CSS !== 'undefined' && !!CSS.supports?.('zoom', '2') && (!CHROME || CHROME >= 128);
const MAX_Z = 8;

const DEFAULTS = {
  sticky: { w: 200, h: 200, fill: '#FFFFFF', text: '' },
  text: { w: 280, h: 34, text: '', color: 'auto', fontSize: 22, align: 'left' },
  shape: { w: 180, h: 120, kind: 'rect', fill: 'none', stroke: 'auto', strokeWidth: 2, text: '', fontSize: 16, align: 'center' },
  frame: { w: 800, h: 500, title: 'Frame', fill: 'none' },
  border: { w: 480, h: 320, shape: 'box', stroke: 'auto', strokeWidth: 2, dash: 'solid', radius: 18 },
  line: { stroke: 'auto', strokeWidth: 2, route: 'straight', startCap: 'none', endCap: 'arrow', dash: 'solid' },
};

// Style properties remembered per type, so the next element looks like the last one you styled.
const STYLE_KEYS = {
  // Font size is deliberately NOT carried over: after shrinking a group it made every new note microscopic.
  sticky: ['fill', 'font', 'align', 'bold', 'italic', 'color'],
  text: ['color', 'font', 'align', 'bold', 'italic', 'fill'],
  shape: ['fill', 'stroke', 'strokeWidth', 'dash', 'color', 'font', 'align', 'bold', 'italic'],
  line: ['stroke', 'strokeWidth', 'route', 'startCap', 'endCap', 'dash'],
  border: ['stroke', 'strokeWidth', 'dash'],
  frame: ['fill'],
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// Which canvas the keyboard belongs to: the Space (null) or a Blueprint window on top of it.
// A press anywhere decides; the window sets it when it opens.
let activeSurface = null;
export const getSurface = () => activeSurface;
export function setSurface(id) { activeSurface = id || null; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.menu, .popover, .dlg-overlay, .toasts')) return; // floating UI keeps the current surface
    activeSurface = e.target.closest('[data-surface]')?.dataset.surface || null;
  }, true);
}

export class Editor {
  constructor(host, { elements = [], camera = null, mediaUrl = () => null, me = null, mountWidget = null, surface = null } = {}) {
    this.host = host;
    this.surface = surface;           // null = the Space / a full page; an id = a Blueprint window
    this.mediaUrl = mediaUrl;
    this.me = me;                    // objects marked private to someone else are skipped entirely
    this.mountWidget = mountWidget;  // builds live modules (Paths, Tracker, Tickets…) inside 'widget' objects
    this.els = (elements || []).filter((e) => e && e.id && e.type)
      // Repair text boxes saved too narrow (older versions): let them hug their words again.
      .map((e) => (e.type === 'text' && !e.autoW && e.w < 60 ? { ...e, autoW: true } : e));
    this.byId = new Map(this.els.map((e) => [e.id, e]));
    this.sel = new Set();
    this.tool = 'select';
    this.opts = { shape: 'rect', line: 'arrow', pen: 'pen', penColor: 'auto', penWidth: 3, hlColor: '#F0B429', sticky: '#FFFFFF', ...store.get('architect.board.opts', {}) };
    this.lastStyle = store.get('architect.board.style', {});
    for (const t of Object.values(this.lastStyle)) if (t && typeof t === 'object') delete t.fontSize; // drop sizes saved by older versions
    this.prefs = { grid: true, snap: false, guides: true, ...store.get('architect.board.prefs', {}) };
    this.undoStack = [];
    this.redoStack = [];
    this.editingId = null;
    this.activeId = null;
    this.g = null;
    this.pointers = new Map();
    this.space = false;
    this.bindHover = null;
    this.lastPointer = null;
    this.presenting = false;
    this.handlers = {};
    this.nodes = new Map();
    this.cam = { x: 0, y: 0, z: 1 };
    this._anim = null;
    this.build();
    this.sync();
    this.initCamera(camera);
  }

  /* ================= events ================= */
  on(name, fn) { (this.handlers[name] ||= new Set()).add(fn); return () => this.handlers[name].delete(fn); }
  emit(name, data) { this.handlers[name]?.forEach((fn) => fn(data)); }

  /* ================= DOM ================= */
  build() {
    this.vp = h('div', { class: 'bp-viewport', tabindex: '0', 'aria-label': 'Board canvas', 'data-tool': 'select' });
    this.world = h('div', { class: 'bp-world' });
    this.frameLayer = h('div', { class: 'bp-layer' });
    this.elLayer = h('div', { class: 'bp-layer' });
    this.liveLayer = h('div', { class: 'bp-layer' });
    this.overlay = h('div', { class: 'bp-overlay' });
    this.world.append(this.frameLayer, this.elLayer, this.liveLayer, this.overlay);
    // Dot grid as an SVG pattern: CSS radial-gradient dots disappear in Firefox-based
    // browsers (Zen, Firefox) whenever the spacing lands on fractional pixels.
    const gid = `bp-dots-${Math.random().toString(36).slice(2, 8)}`;
    this.gridDot = s('circle', { cx: '1.25', cy: '1.25', r: '1.15', class: 'bp-grid-dot' });
    this.gridPattern = s('pattern', { id: gid, width: '24', height: '24', patternUnits: 'userSpaceOnUse' }, this.gridDot);
    this.grid = s('svg', { class: 'bp-grid', 'aria-hidden': 'true' }, s('defs', {}, this.gridPattern), s('rect', { width: '100%', height: '100%', fill: `url(#${gid})` }));
    this.vp.append(this.grid, this.world);
    this.host.append(this.vp);

    const L = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      (this._unbind ||= []).push(() => target.removeEventListener(type, fn, opts));
    };
    L(this.vp, 'pointerdown', (e) => this.onDown(e));
    L(this.vp, 'pointermove', (e) => this.onMove(e));
    L(this.vp, 'pointerup', (e) => this.onUp(e));
    L(this.vp, 'pointercancel', (e) => this.onUp(e, true));
    L(this.vp, 'lostpointercapture', (e) => { if (this.g && this.g.pointerId === e.pointerId) this.onUp(e, true); });
    L(this.vp, 'dblclick', (e) => this.onDblClick(e));
    // Widgets (Ticket board, Paths…) drag their own things; the canvas leaves them alone.
    const inWidget = (e) => (e.target instanceof Element && e.target.closest('.wg-body'));
    L(this.vp, 'dragstart', (e) => { if (!inWidget(e)) e.preventDefault(); });
    L(this.vp, 'contextmenu', (e) => this.onContextMenu(e));
    L(this.vp, 'wheel', (e) => this.onWheel(e), { passive: false });
    L(this.vp, 'dragover', (e) => { if (inWidget(e)) return; if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    L(this.vp, 'drop', (e) => {
      if (inWidget(e)) return;
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) {
        const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
        if (url && /^https?:\/\//.test(url.trim())) { e.preventDefault(); this.emit('url', { url: url.trim(), at: this.toWorld(e.clientX, e.clientY) }); }
        return;
      }
      e.preventDefault();
      this.emit('files', { files, at: this.toWorld(e.clientX, e.clientY) });
    });
    L(window, 'keydown', (e) => this.onKeyDown(e));
    L(window, 'keyup', (e) => this.onKeyUp(e));
    L(window, 'blur', () => { this.space = false; this.vp.classList.remove('is-space'); });
    L(document, 'paste', (e) => this.onPaste(e));
    L(document, 'copy', (e) => this.onCopy(e, false));
    L(document, 'cut', (e) => this.onCopy(e, true));

    this._ro = new ResizeObserver(() => { this.emit('camera', this.cam); });
    this._ro.observe(this.vp);
    document.fonts?.ready?.then(() => { if (this.vp.isConnected) this.refreshAll(); });
  }

  destroy() {
    for (const n of this.nodes.values()) { try { n._ctl?.destroy?.(); } catch {} }
    this.finishEditing();
    this._unbind?.forEach((f) => f());
    this._ro?.disconnect();
    cancelAnimationFrame(this._anim);
    cancelAnimationFrame(this._mvRaf);
    cancelAnimationFrame(this._whRaf);
    clearTimeout(this._movingT);
    this.vp.remove();
    this.handlers = {};
  }

  /* ================= camera ================= */
  rect() { return this.vp.getBoundingClientRect(); }
  toWorld(cx, cy) {
    const r = this.rect();
    return { x: (cx - r.left - this.cam.x) / this.cam.z, y: (cy - r.top - this.cam.y) / this.cam.z };
  }
  toScreen(p) {
    const r = this.rect();
    return { x: r.left + this.cam.x + p.x * this.cam.z, y: r.top + this.cam.y + p.y * this.cam.z };
  }
  viewCenter() { const r = this.rect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }

  applyCamera() {
    const { x, y, z } = this.cam;
    // While the view moves, promote the board to its own layer; drop it after so text re-sharpens.
    if (!this._moving) { this._moving = true; this.vp.classList.add('is-moving'); }
    clearTimeout(this._movingT);
    this._movingT = setTimeout(() => { this._moving = false; this.vp.classList.remove('is-moving'); this.settleCamera(); }, 160);
    if (this._zz === z) {
      // Panning at a settled zoom: just slide the already-sharp board.
      this.world.style.transform = `translate(${x / z}px, ${y / z}px)`;
    } else {
      this._zz = null;
      this.world.style.zoom = '';
      this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    }
    this.vp.style.setProperty('--iz', String(1 / z));
    let step = 24 * z;
    while (step < 14) step *= 4;
    while (step > 96) step /= 4;
    const mod = (v) => ((v % step) + step) % step;
    this.gridPattern.setAttribute('width', step);
    this.gridPattern.setAttribute('height', step);
    this.gridPattern.setAttribute('x', mod(x) - 1.25);
    this.gridPattern.setAttribute('y', mod(y) - 1.25);
    this.vp.classList.toggle('no-grid', !this.prefs.grid);
    if (this._lastZ !== z) { this._lastZ = z; this.renderOverlay(); }
    this.emit('camera', this.cam);
  }

  // Once the view stops, re-lay the board out at the real zoom (CSS zoom) instead of scaling a bitmap:
  // text, borders and widgets render natively sharp at any zoom. Translation snaps to device pixels.
  settleCamera() {
    if (!ZOOM_OK || this._zz === this.cam.z) return;
    const { x, y, z } = this.cam;
    const dpr = window.devicePixelRatio || 1;
    const rx = Math.round(x * dpr) / dpr, ry = Math.round(y * dpr) / dpr;
    this.world.style.zoom = String(z);
    this.world.style.transform = `translate(${rx / z}px, ${ry / z}px)`;
    this._zz = z;
  }

  setCamera(c, { animate = false } = {}) {
    const target = { x: c.x, y: c.y, z: clamp(c.z, MIN_Z, MAX_Z) };
    cancelAnimationFrame(this._anim);
    if (!animate || prefersReducedMotion()) { this.cam = target; this.applyCamera(); return; }
    const from = { ...this.cam };
    const t0 = performance.now();
    const dur = 420;
    // Interpolate in screen space around fixed world point so motion feels straight.
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const k = easeInOut(t);
      const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * k);
      this.cam = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, z };
      this.applyCamera();
      if (t < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  // The widget you clicked into: it gets the scroll wheel until you click somewhere else.
  setActiveWidget(node) {
    if (this.activeWidget === node) return;
    this.activeWidget?.classList.remove('is-active');
    this.activeWidget = node || null;
    this.activeWidget?.classList.add('is-active');
  }

  zoomAt(cx, cy, factor) {
    const r = this.rect();
    const z = clamp(this.cam.z * factor, MIN_Z, MAX_Z);
    const wx = (cx - r.left - this.cam.x) / this.cam.z;
    const wy = (cy - r.top - this.cam.y) / this.cam.z;
    this.cam = { x: cx - r.left - wx * z, y: cy - r.top - wy * z, z };
    this.applyCamera();
  }

  zoomBy(factor, animate = true) {
    const r = this.rect();
    const z = clamp(this.cam.z * factor, MIN_Z, MAX_Z);
    const c = this.viewCenter();
    this.setCamera({ x: r.width / 2 - c.x * z, y: r.height / 2 - c.y * z, z }, { animate });
  }

  zoomTo(z, animate = true) { this.zoomBy(z / this.cam.z, animate); }

  fitRect(rc, { pad = 80, maxZ = 1, animate = true } = {}) {
    if (!rc) return;
    const r = this.rect();
    const w = Math.max(rc.w, 1), hh = Math.max(rc.h, 1);
    const z = clamp(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / hh, maxZ), MIN_Z, MAX_Z);
    const c = center(rc);
    this.setCamera({ x: r.width / 2 - c.x * z, y: r.height / 2 - c.y * z, z }, { animate });
  }

  contentRect() { return unionRects(this.els.map((e) => rectOf(e, this.byId))); }

  zoomToFit(animate = true) {
    const rc = this.contentRect();
    if (rc) this.fitRect(rc, { animate });
    else { const r = this.rect(); this.setCamera({ x: r.width / 2, y: r.height / 2, z: 1 }, { animate }); }
  }

  zoomToSelection() {
    const rc = unionRects(this.selected().map((e) => rectOf(e, this.byId)));
    if (rc) this.fitRect(rc, { maxZ: 2 });
  }

  initCamera(saved) {
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z) && saved.z > 0) {
      this.cam = { x: saved.x, y: saved.y, z: clamp(saved.z, MIN_Z, MAX_Z) };
      this.applyCamera();
    } else this.zoomToFit(false);
  }

  /* ================= rendering ================= */
  ctx() { return { byId: this.byId, editingId: this.editingId, activeId: this.activeId, mediaUrl: this.mediaUrl, mountWidget: this.mountWidget, me: this.me, pdfPage: (id, page, pages) => this.updateEls([id], pages ? { page, pages } : { page }, { commit: false }) }; }

  // Hidden to others, visible to self: someone else's private object doesn't exist on your screen.
  isHidden(el) { return !!el?.privateTo && el.privateTo !== this.me; }
  visibleEls() { return this.els.filter((e) => !this.isHidden(e)); }

  sync() {
    const ctx = this.ctx();
    const seen = new Set();
    const updatedText = [];
    let fi = 0, ei = 0;
    for (const el of this.els) {
      if (this.isHidden(el)) continue;
      seen.add(el.id);
      let node = this.nodes.get(el.id);
      if (node && node._type !== el.type) { node._ctl?.destroy?.(); node.remove(); node = null; } // turned into another type
      if (!node) { node = createNode(el); this.nodes.set(el.id, node); }
      const layer = el.type === 'frame' ? this.frameLayer : this.elLayer;
      const idx = el.type === 'frame' ? fi++ : ei++;
      if (layer.children[idx] !== node) layer.insertBefore(node, layer.children[idx] || null);
      if (node._el !== el || node._force || el.type === 'line') {
        const prev = node._el;
        if (prev && !node._force && el.type !== 'line' && el.type !== 'pen' && el.type !== 'border' && movedOnly(prev, el)) {
          // Dragging: only the position changed, so skip re-rendering text, media and auto-fit.
          node.style.left = `${el.x}px`;
          node.style.top = `${el.y}px`;
        } else {
          updateNode(node, el, ctx);
          if (el.type === 'text') updatedText.push(el.id);
        }
        node._el = el;
        node._force = false;
      }
      node.classList.toggle('is-selected', this.sel.has(el.id));
      node.classList.toggle('is-private', !!el.privateTo);
    }
    for (const [id, node] of this.nodes) if (!seen.has(id)) { node._ctl?.destroy?.(); node.remove(); this.nodes.delete(id); }
    if (updatedText.length) this.measureTexts(updatedText);
    this.renderOverlay();
  }

  measureTexts(ids) {
    const fixes = new Map();
    for (const id of ids) {
      const node = this.nodes.get(id);
      const el = this.byId.get(id);
      if (!node || !el) continue;
      const hgt = node.offsetHeight;
      const wid = el.autoW ? node.offsetWidth : el.w;
      if ((hgt && Math.abs(hgt - el.h) > 0.5) || Math.abs(wid - el.w) > 0.5) fixes.set(id, { h: hgt || el.h, w: wid });
    }
    if (!fixes.size) return;
    this.els = this.els.map((e) => (fixes.has(e.id) ? { ...e, ...fixes.get(e.id) } : e));
    this.byId = new Map(this.els.map((e) => [e.id, e]));
    for (const id of fixes.keys()) { const n = this.nodes.get(id); if (n) n._el = this.byId.get(id); }
    this.emit('change', { silent: true });
  }

  refreshAll() { for (const n of this.nodes.values()) n._force = true; this.sync(); }
  refreshMedia() {
    for (const el of this.els) if (el.type === 'image' || el.type === 'video' || el.type === 'pdf') { const n = this.nodes.get(el.id); if (n) n._force = true; }
    this.sync();
  }

  renderOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    const z = this.cam.z;
    const box = (r, cls) => h('div', { class: cls, style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } });
    const g = this.g;
    if (g?.marquee) o.append(box(g.marquee, 'ov-marquee'));
    for (const gl of this.guides || []) {
      o.append(h('div', { class: ['ov-guide', gl.axis === 'x' ? 'is-v' : 'is-h'], style: gl.axis === 'x'
        ? { left: `${gl.v}px`, top: `${gl.a}px`, height: `${gl.b - gl.a}px` }
        : { top: `${gl.v}px`, left: `${gl.a}px`, width: `${gl.b - gl.a}px` } }));
    }
    if (this.bindHover) {
      const t = this.byId.get(this.bindHover);
      if (t) o.append(box(rectOf(t, this.byId), 'ov-bind'));
    }
    if (this.presenting) return;
    const sel = this.selected();
    if (!sel.length) return;
    const busy = g && (g.moved || g.type === 'resize' || g.type === 'endpoint' || g.type === 'anchor');
    const handle = (d, r) => {
      const x = r.x + (d.includes('w') ? 0 : d.includes('e') ? r.w : r.w / 2);
      const y = r.y + (d.includes('n') ? 0 : d.includes('s') ? r.h : r.h / 2);
      return h('div', { class: `ov-h h-${d}`, 'data-handle': d, style: { left: `${x}px`, top: `${y}px` } });
    };
    if (sel.length === 1) {
      const el = sel[0];
      if (el.type === 'line') {
        const lg = lineGeom(el, this.byId);
        if (el.locked) { o.append(lockBadge(lg.bbox)); return; }
        const pt = (which, p) => h('div', { class: ['ov-pt', (which === 'a' ? el.a : el.b)?.id && 'is-bound'], 'data-handle': which, style: { left: `${p.x}px`, top: `${p.y}px` } });
        o.append(pt('a', lg.a), pt('b', lg.b));
        return;
      }
      const r = rectOf(el, this.byId);
      o.append(box(r, `ov-sel${el.locked ? ' is-locked' : ''}`));
      if (el.locked) { o.append(lockBadge(r)); return; }
      if (this.activeId === el.id && !busy) {
        // A playing video/embed takes every click, so it gets its own handle to move it by.
        o.append(h('div', { class: 'ov-grip', 'data-handle': 'grip', title: 'Drag to move', style: { left: `${r.x}px`, top: `${r.y}px` } }, icon('hand', 13), h('span', {}, 'Move')));
      }
      if (busy && g.type !== 'resize') return;
      if (this.editingId === el.id) return;
      const dirs = el.type === 'text' ? ['nw', 'ne', 'se', 'sw', 'e', 'w']
        : el.type === 'image' || el.type === 'video' || el.type === 'pdf' ? ['nw', 'ne', 'se', 'sw']
          : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      dirs.forEach((d) => o.append(handle(d, r)));
      // Connection dots: drag one to draw a connector, click one to add a connected item.
      if (CONNECTABLE.has(el.type) && !busy) {
        const off = 20 / z;
        const spots = { e: [r.x + r.w + off, r.y + r.h / 2], w: [r.x - off, r.y + r.h / 2], s: [r.x + r.w / 2, r.y + r.h + off], n: [r.x + r.w / 2, r.y - off] };
        for (const [d, [x, y]] of Object.entries(spots)) {
          o.append(h('div', { class: 'ov-qc', 'data-handle': `qc-${d}`, title: 'Drag to connect · click to add a connected item', style: { left: `${x}px`, top: `${y}px` } }));
        }
      }
    } else {
      for (const el of sel) if (el.type !== 'line') o.append(box(rectOf(el, this.byId), 'ov-sub'));
      const r = unionRects(sel.map((e) => rectOf(e, this.byId)));
      o.append(box(r, 'ov-sel'));
      if (!busy && sel.some((e) => !e.locked)) ['nw', 'ne', 'se', 'sw'].forEach((d) => o.append(handle(d, r)));
    }
    function lockBadge(r) {
      return h('div', { class: 'ov-lock', style: { left: `${r.x + r.w}px`, top: `${r.y}px` } }, icon('lock', 12));
    }
  }

  /* ================= state ================= */
  selected() { return [...this.sel].map((id) => this.byId.get(id)).filter(Boolean); }

  // A static copy of the whole board, laid out at 1:1 around its content — for PDF export.
  printable(pad = 64) {
    if (!this.els.length) return null;
    const rects = this.els.map((e) => {
      const r = { ...rectOf(e, this.byId) };
      const n = this.nodes.get(e.id);
      if (n && e.type !== 'line') { r.w = Math.max(r.w, n.offsetWidth); r.h = Math.max(r.h, n.offsetHeight); }
      return r;
    });
    const b = unionRects(rects);
    if (!b) return null;
    const world = h('div', { class: 'bp-world', style: { transform: `translate(${pad - b.x}px, ${pad - b.y}px)` } });
    const frames = this.frameLayer.cloneNode(true);
    const els = this.elLayer.cloneNode(true);
    world.append(frames, els);
    // Objects the speed-ups skipped drawing (off screen, mid-pan) must still land on paper:
    // un-hide every clone, and rebuild any object that isn't in the DOM at all right now.
    const cloned = new Set();
    world.querySelectorAll('[data-eid]').forEach((n) => {
      cloned.add(n.dataset.eid);
      n.removeAttribute('hidden');
      for (const prop of ['display', 'visibility', 'content-visibility', 'opacity']) n.style.removeProperty(prop);
    });
    const ctx = { ...this.ctx(), mountWidget: null, editingId: null, activeId: null };
    for (const el of this.els) {
      if (cloned.has(el.id) || this.isHidden(el) || el.type === 'widget') continue;
      try {
        const n = createNode(el);
        updateNode(n, el, ctx);
        (el.type === 'frame' ? frames : els).append(n);
      } catch {}
    }
    world.querySelectorAll('.is-selected, .is-live').forEach((n) => n.classList.remove('is-selected', 'is-live'));
    world.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    world.querySelectorAll('.el-shield').forEach((n) => n.remove());
    // Videos: freeze the current frame when the browser allows it; embeds: a labelled card.
    const liveVideos = [...this.elLayer.querySelectorAll('video')];
    world.querySelectorAll('video').forEach((v, i) => {
      const src = liveVideos[i];
      let still = null;
      try {
        if (src && src.readyState >= 2 && src.videoWidth) {
          const c = document.createElement('canvas');
          c.width = src.videoWidth; c.height = src.videoHeight;
          c.getContext('2d').drawImage(src, 0, 0);
          still = h('img', { class: 'el-media', src: c.toDataURL('image/jpeg', 0.9), alt: '' });
        }
      } catch {}
      v.replaceWith(still || h('div', { class: 'el-print-card' }, icon('video', 22), h('span', {}, 'Video')));
    });
    world.querySelectorAll('iframe').forEach((f) => {
      f.replaceWith(h('div', { class: 'el-print-card' }, icon('embed', 22), h('span', {}, f.title || 'Embed'), h('small', {}, f.dataset.src || f.src || '')));
    });
    const pid = `bp-dots-print-${Math.random().toString(36).slice(2, 8)}`;
    const mod = (v) => ((v % 24) + 24) % 24;
    const grid = s('svg', { class: 'bp-grid', 'aria-hidden': 'true' },
      s('defs', {}, s('pattern', { id: pid, width: '24', height: '24', x: String(mod(pad - b.x) - 1.25), y: String(mod(pad - b.y) - 1.25), patternUnits: 'userSpaceOnUse' },
        s('circle', { cx: '1.25', cy: '1.25', r: '1.15', class: 'bp-grid-dot' }))),
      s('rect', { width: '100%', height: '100%', fill: `url(#${pid})` }));
    const vp = h('div', { class: ['bp-viewport', 'bp-print', !this.prefs.grid && 'no-grid'] }, grid, world);
    return { content: vp, width: Math.ceil(b.w + pad * 2), height: Math.ceil(b.h + pad * 2) };
  }

  setEls(next, { commit = true, before } = {}) {
    const prev = this.els;
    if (next === prev) return;
    if (commit) this.pushUndo(before || prev);
    this.els = next;
    this.byId = new Map(next.map((e) => [e.id, e]));
    for (const id of [...this.sel]) if (!this.byId.has(id)) this.sel.delete(id);
    this.sync();
    this.emit('change', { commit });
  }

  commitFrom(before) { if (this.els !== before) { this.pushUndo(before); this.emit('change', { commit: true }); } }

  pushUndo(snapshot) {
    this.stamp(snapshot);
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  }

  restore(list) {
    this.els = list;
    this.byId = new Map(list.map((e) => [e.id, e]));
    for (const id of [...this.sel]) if (!this.byId.has(id)) this.sel.delete(id);
    if (this.activeId && !this.byId.has(this.activeId)) this.activeId = null;
    this.sync();
    this.emit('change', { commit: true });
    this.emit('selection');
    this.emit('history');
  }

  undo() {
    this.finishEditing();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.stamp(this.els));
    this.restore(this.withRemote(this.undoStack.pop()));
  }

  redo() {
    this.finishEditing();
    if (!this.redoStack.length) return;
    this.undoStack.push(this.stamp(this.els));
    this.restore(this.withRemote(this.redoStack.pop()));
  }

  /* ================= live collaboration ================= */
  // Every history snapshot records the remote-change counter at the time it was taken.
  // Undo then re-applies what other people did since, so it only rewinds your own edits.
  stamp(list) {
    (this._stamps ||= new WeakMap()).set(list, this._rseq || 0);
    return list;
  }

  withRemote(list) {
    const since = this._stamps?.get(list) ?? 0;
    if (!this._remote || since >= (this._rseq || 0)) return list;
    const out = [];
    const have = new Set();
    for (const e of list) {
      const r = this._remote.get(e.id);
      have.add(e.id);
      if (r && r.seq > since) { if (r.el) out.push(r.el); }
      else out.push(e);
    }
    for (const [id, r] of this._remote) if (r.el && r.born > since && !have.has(id)) out.push(r.el);
    return out;
  }

  // Apply edits that arrived from someone else: no history entry, no broadcast back.
  // replaceAll: the list is the whole board (used when joining).
  applyRemote({ up = [], del = [], order = null } = {}, { replaceAll = false } = {}) {
    const upMap = new Map((up || []).filter((e) => e && e.id && e.type).map((e) => [e.id, e]));
    const gone = new Set(del || []);
    if (replaceAll) for (const e of this.els) if (!upMap.has(e.id)) gone.add(e.id);
    if (!upMap.size && !gone.size && !order) return;
    if (this.editingId && gone.has(this.editingId)) this.cancelEditing();
    const seq = (this._rseq = (this._rseq || 0) + 1);
    const log = (this._remote ||= new Map());
    let next = [];
    for (const e of this.els) {
      if (gone.has(e.id)) continue;
      next.push(upMap.get(e.id) || e);
    }
    for (const [id, e] of upMap) {
      if (!this.byId.has(id)) next.push(e);
      const prev = log.get(id);
      log.set(id, { seq, el: e, born: this.byId.has(id) ? (prev?.born ?? 0) : seq });
    }
    for (const id of gone) log.set(id, { seq, el: null, born: log.get(id)?.born ?? 0 });
    if (replaceAll && !order) order = up.map((e) => e.id);
    if (order) {
      const pos = new Map(order.map((id, i) => [id, i]));
      next = next.map((e, i) => [e, i])
        .sort((a, b) => (pos.has(a[0].id) ? pos.get(a[0].id) : 1e9 + a[1]) - (pos.has(b[0].id) ? pos.get(b[0].id) : 1e9 + b[1]))
        .map((x) => x[0]);
    }
    // Ease remote moves so other people's drags glide instead of stepping.
    for (const [id, e] of upMap) {
      const old = this.byId.get(id);
      const node = this.nodes.get(id);
      if (old && node && (old.x !== e.x || old.y !== e.y) && old.w === e.w && old.h === e.h) {
        node.classList.add('is-remote');
        clearTimeout(node._rt);
        node._rt = setTimeout(() => node.classList.remove('is-remote'), 220);
      }
    }
    this.els = next;
    this.byId = new Map(next.map((e) => [e.id, e]));
    const selBefore = this.sel.size;
    for (const id of [...this.sel]) if (!this.byId.has(id)) this.sel.delete(id);
    if (this.activeId && !this.byId.has(this.activeId)) this.activeId = null;
    this.sync();
    this.emit('change', { remote: true });
    if (this.sel.size !== selBefore) this.emit('selection');
  }

  // Someone else is typing: show their words before they finish.
  showRemoteText(id, { html, title } = {}) {
    if (this.editingId === id) return;
    const node = this.nodes.get(id);
    const el = this.byId.get(id);
    if (!node || !el) return;
    if (el.type === 'frame') { if (node._title && title != null) node._title.textContent = title; return; }
    const t = node._text;
    if (!t || html == null) return;
    t.innerHTML = sanitize(html);
    t._key = null; // the next real update re-renders from data
    if (el.type === 'sticky') fitText(node, el);
  }

  // Drop the current edit without saving it (its element was deleted by someone else).
  cancelEditing() {
    const ed = this._edit;
    if (!ed) return;
    this._edit = null;
    this.editingId = null;
    ed.off();
    ed.target.contentEditable = 'false';
    ed.node.classList.remove('is-editing');
    window.getSelection()?.removeAllRanges();
  }

  updateEls(ids, patch, opts) {
    const set = new Set(ids);
    if (!set.size) return;
    this.setEls(this.els.map((e) => (set.has(e.id) ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e)), opts);
  }

  // Style change from the context bar; remembered for the next element of that type.
  applyStyle(ids, patch) {
    const els = ids.map((id) => this.byId.get(id)).filter(Boolean);
    for (const el of els) {
      const keys = STYLE_KEYS[el.type];
      if (!keys) continue;
      const rec = (this.lastStyle[el.type] ||= {});
      for (const k of Object.keys(patch)) if (keys.includes(k)) rec[k] = patch[k];
    }
    store.set('architect.board.style', this.lastStyle);
    this.updateEls(ids, patch);
    this.emit('selection');
  }

  addEls(list, { select = true, edit = false } = {}) {
    if (!list.length) return;
    this.setEls([...this.els, ...list]);
    if (select) this.select(list.map((e) => e.id));
    if (edit && list.length === 1) this.startEditing(list[0].id, { selectAll: true, fresh: true });
  }

  removeEls(ids, opts = {}) {
    const set = new Set(ids);
    if (!set.size) return;
    if (this.editingId && set.has(this.editingId)) this.finishEditing();
    if (this.activeId && set.has(this.activeId)) this.activeId = null;
    const next = [];
    for (const e of this.els) {
      if (set.has(e.id)) continue;
      if (e.type === 'line' && ((e.a?.id && set.has(e.a.id)) || (e.b?.id && set.has(e.b.id)))) {
        const g = lineGeom(e, this.byId);
        next.push({ ...e, a: e.a?.id && set.has(e.a.id) ? { x: g.a.x, y: g.a.y } : e.a, b: e.b?.id && set.has(e.b.id) ? { x: g.b.x, y: g.b.y } : e.b });
      } else next.push(e);
    }
    ids.forEach((id) => this.sel.delete(id));
    this.setEls(next, opts);
    this.emit('selection');
  }

  select(ids, { add = false } = {}) {
    const expanded = this.expandGroups(ids);
    this.sel = add ? new Set([...this.sel, ...expanded]) : new Set(expanded);
    this.syncSelection();
  }

  clearSel() {
    if (!this.sel.size) return;
    this.sel = new Set();
    this.syncSelection();
  }

  selectAll() { this.select(this.visibleEls().map((e) => e.id)); }

  syncSelection() {
    for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
    this.renderOverlay();
    this.emit('selection');
  }

  expandGroups(ids) {
    const groups = new Set(ids.map((id) => this.byId.get(id)?.group).filter(Boolean));
    if (!groups.size) return ids;
    return [...new Set([...ids, ...this.els.filter((e) => e.group && groups.has(e.group)).map((e) => e.id)])];
  }

  setTool(tool) {
    this.finishEditing();
    if (this.tool === tool) { this.emit('tool', tool); return; }
    this.tool = tool;
    this.vp.dataset.tool = tool;
    this.bindHover = null;
    this.renderOverlay();
    this.emit('tool', tool);
  }

  setOpt(key, value) {
    this.opts[key] = value;
    store.set('architect.board.opts', this.opts);
    this.emit('tool', this.tool);
  }

  setPref(key, value) {
    this.prefs[key] = value;
    store.set('architect.board.prefs', this.prefs);
    this.applyCamera();
    this.emit('prefs');
  }

  /* ================= element factory ================= */
  makeEl(type, rect, at) {
    const base = { ...(DEFAULTS[type] || {}), ...(this.lastStyle[type] || {}) };
    const el = { id: uid(), type, ...base };
    if (type === 'shape') el.kind = this.opts.shape || 'rect';
    if (type === 'sticky') el.fill = this.opts.sticky || base.fill;
    if (type === 'frame') {
      const n = this.els.filter((e) => e.type === 'frame').length + 1;
      el.title = `Frame ${n}`;
    }
    if (rect) Object.assign(el, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    else {
      const p = at || this.viewCenter();
      Object.assign(el, { x: p.x - el.w / 2, y: p.y - el.h / 2 });
    }
    if (this.prefs.snap && type !== 'line') { el.x = snap(el.x); el.y = snap(el.y); }
    return el;
  }

  // Free-standing helper for media/link elements made outside gestures.
  place(el, at) {
    const p = at || this.viewCenter();
    return { id: uid(), x: p.x - (el.w || 200) / 2, y: p.y - (el.h || 120) / 2, ...el };
  }

  frames() { return this.els.filter((e) => e.type === 'frame'); }

  // Where a hand-drawn line end may attach: boxes only (stickies, shapes, media), and only when
  // the pointer is really on them. Text blocks have wide invisible bounds, so lines drawn near
  // them used to snap onto them; text still connects through its connection dots.
  bindTarget(p, excludeId) {
    for (let i = this.els.length - 1; i >= 0; i--) {
      const e = this.els[i];
      if (e.id === excludeId || e.type === 'text' || !CONNECTABLE.has(e.type) || this.isHidden(e)) continue;
      if (pointIn(e, p, 0)) return e;
    }
    return null;
  }

  elementAt(p, excludeId) {
    const pad = 6 / this.cam.z;
    for (let i = this.els.length - 1; i >= 0; i--) {
      const e = this.els[i];
      if (e.id === excludeId || !CONNECTABLE.has(e.type) || this.isHidden(e)) continue;
      if (pointIn(e, p, pad)) return e;
    }
    return null;
  }

  /* ================= pointer gestures ================= */
  onDown(e) {
    if (!(e.target instanceof Element)) return;
    // Moving the screen never depends on what's under the pointer:
    // right-drag, middle-drag or Space+drag pan from anywhere — objects and widgets included.
    if ((e.button === 1 || e.button === 2 || (this.space && e.button === 0)) && e.pointerType !== 'touch' && !e.target.closest('[contenteditable="true"]')) {
      this.inWidget = false;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.editingId) this.finishEditing();
      const start = { cx: e.clientX, cy: e.clientY, p: this.toWorld(e.clientX, e.clientY), pointerId: e.pointerId };
      try { this.vp.setPointerCapture(e.pointerId); } catch {}
      if (e.button === 2) { start.right = true; start.target = e.target; } else e.preventDefault();
      this.beginPan(start);
      return;
    }
    this.inWidget = !!e.target.closest('.wg-body');
    this.setActiveWidget(this.inWidget ? e.target.closest('.el-widget') : null);
    if (this.inWidget && this.sel.size) this.clearSel();
    if (e.target.closest('[data-noptr]')) return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (e.target.closest('.is-live .el-media')) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch') this.trackTap(e);
    if (this.pointers.size === 2 && e.pointerType === 'touch') { this.startPinch(); return; }
    if (this.pointers.size > 1) return;

    if (this.editingId) this.finishEditing();
    if (this.activeId && !e.target.closest(`[data-eid="${this.activeId}"], [data-handle]`)) this.deactivate();
    if (document.activeElement !== this.vp && !isTypingTarget(document.activeElement)) this.vp.focus({ preventScroll: true });
    else if (isTypingTarget(document.activeElement)) { document.activeElement.blur(); this.vp.focus({ preventScroll: true }); }

    const p = this.toWorld(e.clientX, e.clientY);
    const start = { cx: e.clientX, cy: e.clientY, p, shift: e.shiftKey, alt: e.altKey, pointerId: e.pointerId, touch: e.pointerType === 'touch', link: e.target.closest('.el-txt a')?.href || null };
    if (e.button > 2) { this.pointers.delete(e.pointerId); return; }
    try { this.vp.setPointerCapture(e.pointerId); } catch {}

    // Right-drag pans the board; a right-click without dragging still opens the menu.
    if (e.button === 2) { start.right = true; start.target = e.target; this.beginPan(start); return; }
    if (e.button === 1 || this.space || this.tool === 'hand' || this.presenting) { e.preventDefault(); this.beginPan(start); return; }
    if (start.touch) this.armLongPress(start, e.target);

    const handle = e.target.closest('[data-handle]');
    const node = e.target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;

    switch (this.tool) {
      case 'select': this.downSelect(start, handle, el); break;
      case 'sticky': case 'text': case 'shape': case 'frame': this.beginCreate(start, this.tool); break;
      case 'border': if (this.opts.border === 'curve') this.beginPen(start, { border: true }); else this.beginCreate(start, 'border'); break;
      case 'line': this.beginLine(start); break;
      case 'pen': this.beginPen(start); break;
      case 'eraser': this.beginErase(start); break;
      default: this.beginPan(start);
    }
  }

  downSelect(start, handle, el) {
    if (handle) {
      const d = handle.dataset.handle;
      if (d.startsWith('qc-')) { this.beginAnchor(start, d.slice(3)); return; }
      if (d === 'a' || d === 'b') { this.beginEndpoint(start, d); return; }
      if (d === 'grip') { this.beginMove(start); return; }
      this.beginResize(start, d);
      return;
    }
    if (el) {
      start.el = el;
      start.wasSelected = this.sel.size === 1 && this.sel.has(el.id);
      if (start.shift) {
        const ids = this.expandGroups([el.id]);
        if (this.sel.has(el.id)) { ids.forEach((id) => this.sel.delete(id)); this.syncSelection(); return; }
        this.select(ids, { add: true });
      } else if (!this.sel.has(el.id)) { start.link = null; this.select([el.id]); }
      if (this.selected().every((x) => x.locked)) { if (start.link) window.open(start.link, '_blank', 'noopener'); return; }
      this.beginMove(start);
      return;
    }
    if (start.touch) { this.beginPan(start); return; }
    if (!start.shift) this.clearSel();
    this.beginMarquee(start);
  }

  // Two-finger tap = undo, three-finger tap = redo (phones and tablets).
  trackTap(e) {
    if (this.pointers.size === 1) this._tap = { t0: performance.now(), n: 1, moved: false, starts: new Map() };
    const tap = this._tap;
    if (!tap) return;
    tap.starts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap.n = Math.max(tap.n, this.pointers.size);
  }

  endTap(e, cancelled) {
    const tap = this._tap;
    if (!tap || e.pointerType !== 'touch' || this.pointers.size) return;
    this._tap = null;
    if (cancelled || tap.moved || tap.n < 2 || performance.now() - tap.t0 > 400) return;
    if (tap.n === 2) { this.undo(); this.emit('notice', 'Undo'); }
    else if (tap.n >= 3) { this.redo(); this.emit('notice', 'Redo'); }
    navigator.vibrate?.(8);
  }

  // Pointer moves are batched to one per frame; pen strokes keep every sample for smooth lines.
  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = this._tap?.starts.get(e.pointerId);
    if (st && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 10) this._tap.moved = true;
    if (this._lp && Math.hypot(e.clientX - this._lp.cx, e.clientY - this._lp.cy) > 8) this.cancelLongPress();
    if (this.g?.type === 'pen' && this.g.pointerId === e.pointerId) {
      const list = e.getCoalescedEvents?.() || [];
      for (const ce of list.length ? list : [e]) this.g.onMove(this.toWorld(ce.clientX, ce.clientY), ce);
      this.lastPointer = this.toWorld(e.clientX, e.clientY);
      return;
    }
    this._mv = e;
    if (!this._mvRaf) this._mvRaf = requestAnimationFrame(() => this.flushMove());
  }

  flushMove() {
    cancelAnimationFrame(this._mvRaf);
    this._mvRaf = 0;
    const e = this._mv;
    this._mv = null;
    if (!e) return;
    const p = this.toWorld(e.clientX, e.clientY);
    this.lastPointer = p;
    if (this.g?.type === 'pinch') { this.movePinch(); return; }
    if (this.g && this.g.pointerId === e.pointerId) { this.g.onMove?.(p, e); return; }
    if (!this.g && this.tool === 'line') {
      const t = this.bindTarget(p);
      const id = t?.id || null;
      if (id !== this.bindHover) { this.bindHover = id; this.renderOverlay(); }
    }
  }

  onUp(e, cancelled = false) {
    if (this._mv) this.flushMove();
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();
    this.endTap(e, cancelled);
    const g = this.g;
    if (!g) return;
    if (g.type === 'pinch') { if (this.pointers.size < 2) { this.g = null; this.emit('gesture', false); } return; }
    if (g.pointerId !== e.pointerId) return;
    this.g = null;
    try { this.vp.releasePointerCapture(e.pointerId); } catch {}
    this.vp.classList.remove('is-panning');
    document.body.classList.remove('bp-busy');
    g.onUp?.(this.toWorld(e.clientX, e.clientY), e, cancelled);
    this.renderOverlay();
    this.emit('gesture', false);
  }

  startGesture(g) {
    this.g = g;
    this.emit('gesture', true);
  }

  beginPan(start) {
    const cam0 = { ...this.cam };
    this.vp.classList.add('is-panning');
    cancelAnimationFrame(this._anim);
    const g = {
      type: 'pan', pointerId: start.pointerId, right: !!start.right, panned: false, pendingMenu: null,
      onMove: (p, e) => {
        if (!g.panned && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > 4) g.panned = true;
        this.cam = { ...cam0, x: cam0.x + (e.clientX - start.cx), y: cam0.y + (e.clientY - start.cy) };
        this.applyCamera();
      },
      onUp: () => {
        if (!g.right) return;
        if (g.panned) { this._rightPannedAt = performance.now(); return; }
        if (g.pendingMenu) this.openContextMenu(g.pendingMenu); // macOS/Linux fire contextmenu on press
      },
    };
    this.startGesture(g);
  }

  // Touch: hold still for half a second to open the menu.
  armLongPress(start, target) {
    this.cancelLongPress();
    const lp = { cx: start.cx, cy: start.cy };
    lp.timer = setTimeout(() => {
      this._lp = null;
      if (this.pointers.size !== 1) return;
      const g = this.g;
      if (g) {
        this.g = null;
        try { this.vp.releasePointerCapture(start.pointerId); } catch {}
        this.vp.classList.remove('is-panning');
        if (g.type === 'pan' || g.type === 'move') this.emit('gesture', false);
      }
      navigator.vibrate?.(12);
      this.openContextMenu({ clientX: start.cx, clientY: start.cy, target });
    }, 520);
    this._lp = lp;
  }

  cancelLongPress() {
    if (this._lp) { clearTimeout(this._lp.timer); this._lp = null; }
  }

  beginMarquee(start) {
    const base = new Set(this.sel);
    const g = {
      type: 'marquee', pointerId: start.pointerId, marquee: null,
      onMove: (p, e) => {
        if (!g.marquee && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
        g.marquee = rectFromPoints(start.p, p);
        const hits = [];
        for (const el of this.els) {
          if (this.isHidden(el)) continue;
          const r = rectOf(el, this.byId);
          if (el.type === 'frame' || el.type === 'border' || el.type === 'widget' ? contains(g.marquee, r) : intersects(g.marquee, r)) hits.push(el.id);
        }
        this.emit('marquee', g.marquee);
        this.sel = new Set([...base, ...this.expandGroups(hits)]);
        for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
        this.renderOverlay();
      },
      onUp: () => { this.emit('marquee', null); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginMove(start) {
    let ids = this.selected().filter((x) => !x.locked).map((x) => x.id);
    const before = this.els;
    const addFrameChildren = (list) => {
      const frames = list.map((id) => this.byId.get(id)).filter((x) => x?.type === 'frame');
      if (!frames.length) return list;
      const set = new Set(list);
      for (const el of this.els) {
        if (set.has(el.id) || el.type === 'frame' || el.locked) continue;
        const r = rectOf(el, this.byId);
        if (frames.some((f) => contains(f, r))) set.add(el.id);
      }
      return [...set];
    };
    ids = addFrameChildren(ids);
    // A line dragged on its own lets go of whatever it was attached to (that isn't moving with it),
    // so it moves as one piece instead of stretching back to its old anchors.
    const moving = new Set(ids);
    const detach = (el) => {
      if (el.type !== 'line' || (!el.a?.id && !el.b?.id)) return el;
      const geo = lineGeom(el, this.byId);
      const free = (end, pt) => (end?.id && !moving.has(end.id) ? { x: pt.x, y: pt.y } : end);
      return { ...el, a: free(el.a, geo.a), b: free(el.b, geo.b) };
    };
    let startPos = new Map(ids.map((id) => [id, detach(this.byId.get(id))]));
    const g = {
      type: 'move', pointerId: start.pointerId, moved: false,
      onMove: (p, e) => {
        if (!g.moved) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
          g.moved = true;
          document.body.classList.add('bp-busy');
          if (start.alt) {
            const clones = this.cloneEls(this.selected().map((x) => x.id), 0, 0);
            this.setEls([...this.els, ...clones], { commit: false });
            this.sel = new Set(clones.map((c) => c.id));
            ids = addFrameChildren(clones.map((c) => c.id));
            startPos = new Map(ids.map((id) => [id, this.byId.get(id)]));
            for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
          }
        }
        let dx = p.x - start.p.x, dy = p.y - start.p.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (this.prefs.snap) {
          const first = startPos.values().next().value;
          if (first && first.type !== 'line') { dx = snap(first.x + dx) - first.x; dy = snap(first.y + dy) - first.y; }
        }
        // Objects snap to each other: edges touch, edges / centres line up. Hold Ctrl/⌘ to drop freely.
        this.guides = null;
        if (this.prefs.guides !== false && !(e.ctrlKey || e.metaKey)) {
          g.snapBase ||= this.snapBase(startPos);
          if (g.snapBase) {
            const r = { ...g.snapBase.box, x: g.snapBase.box.x + dx, y: g.snapBase.box.y + dy };
            const hit = this.snapRect(r, g.snapBase.targets, { x: !(e.shiftKey && dx === 0), y: !(e.shiftKey && dy === 0) });
            dx += hit.dx; dy += hit.dy;
            this.guides = hit.guides;
          }
        }
        this.setEls(this.els.map((el) => (startPos.has(el.id) ? moved(startPos.get(el.id), dx, dy) : el)), { commit: false });
      },
      onUp: (p, e, cancelled) => {
        if (this.guides) { this.guides = null; this.renderOverlay(); }
        if (g.moved) this.commitFrom(before);
        else if (start.link) window.open(start.link, '_blank', 'noopener'); // click a link inside an already-selected item
        else if (!cancelled && !start.shift && !start.alt) this.clickToEdit(start);
        this.emit('selection');
      },
    };
    this.startGesture(g);
  }

  beginResize(start, dir) {
    const sel = this.selected().filter((x) => !x.locked);
    if (!sel.length) return;
    const before = this.els;
    const origin = new Map(sel.map((e) => [e.id, e]));
    const rects = new Map(sel.map((e) => [e.id, rectOf(e, this.byId)]));
    const ob = unionRects([...rects.values()]);
    const single = sel.length === 1 ? sel[0] : null;
    const corner = dir.length === 2;
    const aspectDefault = !single || single.type === 'image' || single.type === 'video' || single.type === 'pdf';
    const g = {
      type: 'resize', pointerId: start.pointerId,
      onMove: (p, e) => {
        document.body.classList.add('bp-busy');
        const dx = p.x - start.p.x, dy = p.y - start.p.y;
        let { x, y, w, h: hh } = ob;
        if (dir.includes('e')) w = ob.w + dx;
        if (dir.includes('w')) { w = ob.w - dx; x = ob.x + dx; }
        if (dir.includes('s')) hh = ob.h + dy;
        if (dir.includes('n')) { hh = ob.h - dy; y = ob.y + dy; }
        const min = 12;
        if (w < min) { if (dir.includes('w')) x = ob.x + ob.w - min; w = min; }
        if (hh < min) { if (dir.includes('n')) y = ob.y + ob.h - min; hh = min; }
        const keep = corner && (aspectDefault !== e.shiftKey) || (single?.type === 'text' && corner);
        if (keep) {
          const k = Math.max(w / (ob.w || 1), hh / (ob.h || 1));
          w = (ob.w || 1) * k; hh = (ob.h || 1) * k;
          if (dir.includes('w')) x = ob.x + ob.w - w;
          if (dir.includes('n')) y = ob.y + ob.h - hh;
        }
        this.guides = null;
        if (this.prefs.guides !== false && !keep && !(e.ctrlKey || e.metaKey)) {
          g.targets ||= this.snapTargets(new Set(sel.map((x) => x.id)));
          const hit = this.snapEdges({ x, y, w, h: hh }, dir, g.targets);
          ({ x, y, w } = hit.r); hh = hit.r.h;
          this.guides = hit.guides;
        }
        if (this.prefs.snap && !keep) {
          if (dir.includes('e')) w = snap(x + w) - x;
          if (dir.includes('s')) hh = snap(y + hh) - y;
          if (dir.includes('w')) { const nx = snap(x); w += x - nx; x = nx; }
          if (dir.includes('n')) { const ny = snap(y); hh += y - ny; y = ny; }
        }
        const sx = w / (ob.w || 1), sy = hh / (ob.h || 1);
        const mapPt = (pt) => ({ x: x + (pt.x - ob.x) * sx, y: y + (pt.y - ob.y) * sy });
        this.setEls(this.els.map((el) => {
          if (!origin.has(el.id)) return el;
          const r = rects.get(el.id);
          const nr = { x: x + (r.x - ob.x) * sx, y: y + (r.y - ob.y) * sy, w: r.w * sx, h: r.h * sy };
          // Always scale from the state at drag start: scaling the live value compounds every frame,
          // which squashed every font in a group down to the same minimum size.
          return resized(origin.get(el.id), nr, sx, sy, mapPt, single, corner);
        }), { commit: false });
      },
      onUp: () => { this.guides = null; this.commitFrom(before); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  /* ---- snapping objects to each other ---- */
  // What can be snapped to: everything visible except what's moving, lines and pen strokes.
  snapTargets(moving) {
    const R = this.vp.getBoundingClientRect();
    const a = this.toWorld(R.left, R.top), b = this.toWorld(R.right, R.bottom);
    const view = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    const pad = 400 / this.cam.z;
    const out = [];
    for (const el of this.els) {
      if (moving.has(el.id) || el.type === 'line' || el.type === 'pen' || this.isHidden(el)) continue;
      const r = rectOf(el, this.byId);
      if (!r || !isFinite(r.x) || !(r.w > 0) || !(r.h > 0)) continue;
      if (view && (r.x > view.x + view.w + pad || r.y > view.y + view.h + pad || r.x + r.w < view.x - pad || r.y + r.h < view.y - pad)) continue;
      out.push(r);
    }
    return out.slice(0, 600);
  }

  snapBase(startPos) {
    const list = [...startPos.values()].filter((el) => el.type !== 'line');
    if (!list.length) return null;
    return { box: unionRects(list.map((el) => rectOf(el, this.byId))), targets: this.snapTargets(new Set(startPos.keys())) };
  }

  // Finds the nearest edge/centre match on each axis within a few screen pixels.
  snapRect(r, targets, axes = { x: true, y: true }) {
    const thr = 7 / this.cam.z;
    const GAP = 24;
    let bx = null, by = null;
    const tryAxis = (axis, mine, t, theirs, kinds) => {
      for (const [mk, mv] of mine) for (const [tk, tv] of theirs) {
        if (kinds && !kinds(mk, tk)) continue;
        const d = tv - mv;
        if (Math.abs(d) > thr) continue;
        const cur = axis === 'x' ? bx : by;
        if (!cur || Math.abs(d) < Math.abs(cur.d) - 0.01) {
          const hit = { d, v: tv, t };
          if (axis === 'x') bx = hit; else by = hit;
        }
      }
    };
    const mineX = [['l', r.x], ['c', r.x + r.w / 2], ['r', r.x + r.w]];
    const mineY = [['t', r.y], ['c', r.y + r.h / 2], ['b', r.y + r.h]];
    for (const t of targets) {
      if (axes.x) {
        tryAxis('x', mineX, t, [['l', t.x], ['c', t.x + t.w / 2], ['r', t.x + t.w]]);
        // Side by side with a tidy gap.
        tryAxis('x', mineX, t, [['gl', t.x - GAP], ['gr', t.x + t.w + GAP]], (m, k) => (k === 'gl' && m === 'r') || (k === 'gr' && m === 'l'));
      }
      if (axes.y) {
        tryAxis('y', mineY, t, [['t', t.y], ['c', t.y + t.h / 2], ['b', t.y + t.h]]);
        tryAxis('y', mineY, t, [['gt', t.y - GAP], ['gb', t.y + t.h + GAP]], (m, k) => (k === 'gt' && m === 'b') || (k === 'gb' && m === 't'));
      }
    }
    const dx = bx ? bx.d : 0, dy = by ? by.d : 0;
    const guides = [];
    const fr = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
    if (bx) guides.push({ axis: 'x', v: bx.v, a: Math.min(fr.y, bx.t.y) - 12, b: Math.max(fr.y + fr.h, bx.t.y + bx.t.h) + 12 });
    if (by) guides.push({ axis: 'y', v: by.v, a: Math.min(fr.x, by.t.x) - 12, b: Math.max(fr.x + fr.w, by.t.x + by.t.w) + 12 });
    return { dx, dy, guides };
  }

  // Resizing: only the edges being dragged snap.
  snapEdges(r, dir, targets) {
    const thr = 7 / this.cam.z;
    const out = { ...r };
    const guides = [];
    const edge = (axis, pos) => {
      let best = null;
      for (const t of targets) {
        const vals = axis === 'x' ? [t.x, t.x + t.w / 2, t.x + t.w] : [t.y, t.y + t.h / 2, t.y + t.h];
        for (const v of vals) { const d = v - pos; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v, t }; }
      }
      return best;
    };
    const line = (axis, b) => guides.push(axis === 'x'
      ? { axis, v: b.v, a: Math.min(out.y, b.t.y) - 12, b: Math.max(out.y + out.h, b.t.y + b.t.h) + 12 }
      : { axis, v: b.v, a: Math.min(out.x, b.t.x) - 12, b: Math.max(out.x + out.w, b.t.x + b.t.w) + 12 });
    if (dir.includes('e')) { const b = edge('x', out.x + out.w); if (b) { out.w += b.d; line('x', b); } }
    if (dir.includes('w')) { const b = edge('x', out.x); if (b) { out.x += b.d; out.w -= b.d; line('x', b); } }
    if (dir.includes('s')) { const b = edge('y', out.y + out.h); if (b) { out.h += b.d; line('y', b); } }
    if (dir.includes('n')) { const b = edge('y', out.y); if (b) { out.y += b.d; out.h -= b.d; line('y', b); } }
    return { r: out, guides };
  }

  beginEndpoint(start, which) {
    const line = this.selected()[0];
    if (!line || line.type !== 'line') return;
    const before = this.els;
    const other = which === 'a' ? line.b : line.a;
    const g = {
      type: 'endpoint', pointerId: start.pointerId,
      onMove: (p) => {
        const t = this.bindTarget(p, line.id);
        const bindId = t && t.id !== other?.id ? t.id : null;
        this.bindHover = bindId;
        const end = bindId ? { id: bindId, x: p.x, y: p.y, side: nearestSide(this.byId.get(bindId), p) } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, [which]: end } : el)), { commit: false });
      },
      onUp: () => { this.bindHover = null; this.commitFrom(before); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginCreate(start, type) {
    const before = this.els;
    let made = null;
    const g = {
      type: 'create', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!made && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 6) return;
        // Text: a small wobble while clicking is still a click; only a real sideways drag sets a wrap width.
        if (!made && type === 'text' && Math.abs(e.clientX - start.cx) < 40) return;
        let r = rectFromPoints(start.p, p);
        if (type === 'sticky' || e.shiftKey) {
          const s2 = Math.max(r.w, r.h);
          r = { x: p.x < start.p.x ? start.p.x - s2 : start.p.x, y: p.y < start.p.y ? start.p.y - s2 : start.p.y, w: s2, h: s2 };
        }
        if (type === 'text') { r.h = made?.h || DEFAULTS.text.h; r.w = Math.max(r.w, 80); }
        r.w = Math.max(r.w, 20);
        r.h = Math.max(r.h, 20);
        if (!made) {
          made = this.makeEl(type, r);
          this.sel = new Set([made.id]);
          this.setEls([...this.els, made], { commit: false });
        } else {
          this.setEls(this.els.map((el) => (el.id === made.id ? { ...el, x: r.x, y: r.y, w: r.w, h: type === 'text' ? el.h : r.h } : el)), { commit: false });
        }
      },
      onUp: () => {
        if (!made) {
          made = this.makeEl(type, null, start.p);
          if (type === 'text') { made.x = start.p.x - 4; made.autoW = true; } // text starts where you click and hugs its words
          this.setEls([...this.els, made], { commit: false });
        }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([made.id]);
        this.setTool('select');
        this.syncSelection();
        if (type === 'sticky' || type === 'text' || type === 'frame') this.startEditing(made.id, { selectAll: true, fresh: true });
      },
    };
    this.startGesture(g);
  }

  beginLine(start) {
    const before = this.els;
    const t0 = this.bindTarget(start.p);
    const line = this.makeEl('line');
    delete line.x; delete line.y; delete line.w; delete line.h;
    line.endCap = this.opts.line === 'line' ? 'none' : (line.endCap && line.endCap !== 'none' ? line.endCap : 'arrow');
    line.a = t0 ? { id: t0.id, x: start.p.x, y: start.p.y } : { x: start.p.x, y: start.p.y };
    line.b = { x: start.p.x, y: start.p.y };
    let added = false;
    const g = {
      type: 'line', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!added) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
          added = true;
          this.setEls([...this.els, line], { commit: false });
        }
        const t = this.bindTarget(p, line.id);
        const bindId = t && t.id !== line.a.id ? t.id : null;
        this.bindHover = bindId;
        const b = bindId ? { id: bindId, x: p.x, y: p.y, side: nearestSide(this.byId.get(bindId), p) } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, b } : el)), { commit: false });
      },
      onUp: () => {
        this.bindHover = null;
        if (!added) {
          this.setEls([...this.els, { ...line, a: { x: start.p.x, y: start.p.y }, b: { x: start.p.x + 160, y: start.p.y } }], { commit: false });
        }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([line.id]);
        this.setTool('select');
        this.syncSelection();
      },
    };
    this.startGesture(g);
  }

  beginPen(start, { border = false } = {}) {
    const kind = border ? 'pen' : this.opts.pen === 'highlighter' ? 'highlighter' : 'pen';
    const color = border ? (this.lastStyle.border?.stroke || 'auto') : kind === 'highlighter' ? this.opts.hlColor : this.opts.penColor;
    const width = border ? (this.lastStyle.border?.strokeWidth || 2) : kind === 'highlighter' ? 18 : this.opts.penWidth;
    const opacity = kind === 'highlighter' ? 0.38 : 1;
    const pts = [[start.p.x, start.p.y]];
    const path = s('path', { d: penPath(pts), fill: 'none', stroke: css(color), 'stroke-width': width, opacity, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const svg = s('svg', { class: 'bp-live-svg' }, path);
    this.liveLayer.append(svg);
    const g = {
      type: 'pen', pointerId: start.pointerId,
      onMove: (p) => {
        const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) < 1.2 / this.cam.z) return;
        pts.push([p.x, p.y]);
        path.setAttribute('d', penPath(pts));
      },
      onUp: () => {
        svg.remove();
        if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]);
        const simp = simplify(pts, 0.6 / this.cam.z);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of simp) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
        const r2 = (v) => Math.round(v * 100) / 100;
        const el = border
          // A hand-drawn border: the stroke is smoothed and closed into a loop.
          ? { id: uid(), type: 'border', shape: 'curve', x: r2(x1), y: r2(y1), w: r2(Math.max(x2 - x1, 1)), h: r2(Math.max(y2 - y1, 1)),
            points: simplify(pts, 3 / this.cam.z).map(([x, y]) => [r2(x - x1), r2(y - y1)]), stroke: color, strokeWidth: width, dash: this.lastStyle.border?.dash || 'solid' }
          : { id: uid(), type: 'pen', x: r2(x1), y: r2(y1), w: r2(Math.max(x2 - x1, 1)), h: r2(Math.max(y2 - y1, 1)),
            points: simp.map(([x, y]) => [r2(x - x1), r2(y - y1)]), stroke: color, strokeWidth: width, opacity, kind };
        if (border && (el.w < 12 || el.h < 12)) return;
        this.setEls([...this.els, el]);
        if (border) { this.select([el.id]); this.setTool('select'); }
      },
    };
    this.startGesture(g);
  }

  beginErase(start) {
    const before = this.els;
    const test = (p) => {
      const rad = 8 / this.cam.z;
      const hit = [];
      for (const el of this.els) {
        if (el.type !== 'pen' || el.locked) continue;
        const sw = (el.strokeWidth || 3) / 2;
        if (!pointIn(el, p, rad + sw)) continue;
        const pts = el.points || [];
        for (let i = 0; i < pts.length; i++) {
          const a = { x: el.x + pts[i][0], y: el.y + pts[i][1] };
          const b = i + 1 < pts.length ? { x: el.x + pts[i + 1][0], y: el.y + pts[i + 1][1] } : a;
          if (distToSeg(p, a, b) <= rad + sw) { hit.push(el.id); break; }
        }
      }
      if (hit.length) { const set = new Set(hit); this.setEls(this.els.filter((e) => !set.has(e.id)), { commit: false }); }
    };
    test(start.p);
    this.startGesture({ type: 'erase', pointerId: start.pointerId, onMove: (p) => test(p), onUp: () => this.commitFrom(before) });
  }

  startPinch() {
    if (this.g && this.g.type !== 'pinch') {
      const g = this.g;
      this.g = null;
      g.onUp?.(this.lastPointer || { x: 0, y: 0 }, {}, true);
    }
    const [a, b] = [...this.pointers.values()];
    const r = this.rect();
    this.g = {
      type: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      cam0: { ...this.cam },
    };
    this.emit('gesture', true);
  }

  movePinch() {
    const g = this.g;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const r = this.rect();
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const z = clamp(g.cam0.z * (d / g.d0), MIN_Z, MAX_Z);
    const wx = (g.m0.x - g.cam0.x) / g.cam0.z, wy = (g.m0.y - g.cam0.y) / g.cam0.z;
    this.cam = { x: m.x - wx * z, y: m.y - wy * z, z };
    this.applyCamera();
  }

  // Scroll = move around · Ctrl/⌘ + scroll (or a trackpad pinch) = zoom.
  // Over a chat or list that can scroll, the wheel scrolls it — and keeps doing so for a moment
  // after it hits the end, so the canvas doesn't lurch away mid-scroll.
  onWheel(e) {
    if (e.target instanceof Element && e.target.closest('.is-live .el-media')) return;
    const zoom = e.ctrlKey || e.metaKey;
    // A widget only takes the wheel once you've clicked into it; hovering over one still moves the screen.
    // Lists marked data-wheel (chats) scroll on hover — no click needed.
    const inActive = e.target instanceof Element && !!e.target.closest('.wg-body') &&
      ((this.activeWidget && this.activeWidget.contains(e.target)) || !!e.target.closest('[data-wheel]'));
    if (inActive && !zoom) {
      const now = performance.now();
      if (scrollsInside(e.target, e.deltaY, e.deltaX)) { this._innerScroll = now + 400; return; }
      if (now < (this._innerScroll || 0)) { this._innerScroll = now + 400; e.preventDefault(); return; }
    }
    e.preventDefault();
    cancelAnimationFrame(this._anim);
    // Trackpads fire many wheel events per frame: add them up and apply once per frame.
    const w = (this._wh ||= { dx: 0, dy: 0, zoom: 0, cx: 0, cy: 0 });
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      w.zoom += -clamp(e.deltaY * unit, -60, 60) * 0.01;
      w.cx = e.clientX; w.cy = e.clientY;
    } else {
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      w.dx += dx; w.dy += dy;
    }
    if (this._whRaf) return;
    this._whRaf = requestAnimationFrame(() => {
      this._whRaf = 0;
      const q = this._wh;
      this._wh = null;
      if (!q) return;
      if (q.dx || q.dy) this.cam = { ...this.cam, x: this.cam.x - q.dx, y: this.cam.y - q.dy };
      if (q.zoom) this.zoomAt(q.cx, q.cy, Math.exp(clamp(q.zoom, -1.5, 1.5)));
      else this.applyCamera();
    });
  }

  // Pointer capture retargets click events to the viewport, so look up what is really under the pointer.
  targetAt(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    return t instanceof Element && this.vp.contains(t) ? t : (e.target instanceof Element ? e.target : null);
  }

  onDblClick(e) {
    const target = this.targetAt(e);
    if (!target) return;
    if (target.closest('[contenteditable="true"], [data-noptr]')) return;
    const node = target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;
    if (!el) {
      if (this.tool === 'select' && !this.presenting && !target.closest('[data-handle]')) {
        const made = this.makeEl('text', null, this.toWorld(e.clientX, e.clientY));
        made.x = this.toWorld(e.clientX, e.clientY).x - 4;
        made.autoW = true;
        this.addEls([made], { edit: true });
      }
      return;
    }
    if (el.type === 'video' || el.type === 'embed') { this.activate(el.id); return; }
    if (el.type === 'pdf') { this.emit('open-pdf', el); return; }
    if (this.presenting || el.locked) return;
    if (TEXTUAL.has(el.type) || el.type === 'frame') this.startEditing(el.id);
    else if (el.type === 'link' && el.url) window.open(el.url, '_blank', 'noopener');
  }

  onContextMenu(e) {
    const target = this.targetAt(e);
    if (!target || target.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    if (this.presenting) return;
    if (this.g?.type === 'pan' && this.g.right) { this.g.pendingMenu = { clientX: e.clientX, clientY: e.clientY, target }; return; }
    if (performance.now() - (this._rightPannedAt || 0) < 400) return; // Windows fires it after a right-drag
    if (e.pointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents) return; // long-press handles touch
    this.openContextMenu({ clientX: e.clientX, clientY: e.clientY, target });
  }

  openContextMenu(e) {
    const target = e.target;
    const node = target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;
    if (el && !this.sel.has(el.id)) this.select([el.id]);
    if (!el) this.clearSel();
    this.emit('contextmenu', { x: e.clientX, y: e.clientY, onElement: !!el, at: this.toWorld(e.clientX, e.clientY) });
  }

  /* ================= editing ================= */
  // The first click only selects. Clicking an already-selected note, text box, shape or frame title
  // (or double-clicking it) starts typing right where you clicked.
  clickToEdit(start) {
    const el = start.el && this.byId.get(start.el.id);
    if (!el || el.locked || this.presenting || this.sel.size !== 1 || !this.sel.has(el.id)) return;
    const editable = TEXTUAL.has(el.type) || el.type === 'shape' || el.type === 'frame';
    if (!editable || !start.wasSelected) return;
    this.startEditing(el.id);
    this.placeCaret(start.cx, start.cy);
  }

  placeCaret(cx, cy) {
    const target = this._edit?.target;
    if (!target) return;
    let range = null;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(cx, cy);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    } else if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(cx, cy);
    if (!range || !target.contains(range.startContainer)) return; // clicked padding: caret stays at the end
    range.collapse(true);
    const s2 = window.getSelection();
    s2.removeAllRanges();
    s2.addRange(range);
  }

  // fresh: the element was just created, so typing into it shouldn't add a second undo step.
  startEditing(id, { selectAll = false, fresh = false } = {}) {
    const el = this.byId.get(id);
    if (!el || el.locked) return;
    this.finishEditing();
    const node = this.nodes.get(id);
    const target = el.type === 'frame' ? node?._title : node?._text;
    if (!target) return;
    this.editingId = id;
    this.sel = new Set([id]);
    for (const [nid, n] of this.nodes) n.classList.toggle('is-selected', this.sel.has(nid));
    node.classList.add('is-editing');
    target.contentEditable = 'true';
    target.spellcheck = true;
    target.focus({ preventScroll: true });
    try { document.execCommand('styleWithCSS', false, true); } catch {}
    const range = document.createRange();
    range.selectNodeContents(target);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const onKey = (e) => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && el.type !== 'frame') { e.preventDefault(); this.emit('command', 'link'); return; }
      if ((e.metaKey || e.ctrlKey) && el.type !== 'frame' && this.editingKeys(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (el.type === 'frame' && e.key === 'Enter')) {
        e.preventDefault();
        this.finishEditing();
        this.vp.focus({ preventScroll: true });
      }
    };
    const onInput = () => {
      if (el.type === 'sticky') fitText(node, this.byId.get(id) || el);
      if (el.type === 'text') {
        const hgt = node.offsetHeight;
        const cur = this.byId.get(id);
        const wid = cur?.autoW ? node.offsetWidth : cur?.w;
        if (cur && (Math.abs(hgt - cur.h) > 0.5 || Math.abs(wid - cur.w) > 0.5)) {
          this.els = this.els.map((x) => (x.id === id ? { ...x, h: hgt, w: wid } : x));
          this.byId = new Map(this.els.map((x) => [x.id, x]));
          node._el = this.byId.get(id);
        }
      }
      this.renderOverlay();
      this.emit('typing', el.type === 'frame' ? { id, title: target.textContent } : { id, html: target.innerHTML });
    };
    const onPaste = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text);
    };
    const onBlur = () => { if (this.editingId === id && !this.holdEditing) this.finishEditing(); };
    const onSel = () => this.emit('textselection');
    document.addEventListener('selectionchange', onSel);
    target.addEventListener('keydown', onKey);
    target.addEventListener('input', onInput);
    target.addEventListener('paste', onPaste);
    target.addEventListener('blur', onBlur);
    requestAnimationFrame(() => { if (this.editingId === id) onInput(); });
    this._edit = { id, target, node, fresh, off: () => {
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('input', onInput);
      target.removeEventListener('paste', onPaste);
      target.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onSel);
    } };
    this.renderOverlay();
    this.emit('selection');
  }

  finishEditing() {
    const ed = this._edit;
    if (!ed) return;
    this._edit = null;
    this.editingId = null;
    ed.off();
    const { id, target, node, fresh } = ed;
    // innerText keeps line breaks typed into contentEditable; frame titles use textContent
    // because innerText would bake in the CSS uppercase transform.
    const raw = (node.classList.contains('el-frame') ? target.textContent : target.innerText).replace(/ /g, ' ').replace(/\u200B/g, '');
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    target.contentEditable = 'false';
    node.classList.remove('is-editing');
    window.getSelection()?.removeAllRanges();
    const el = this.byId.get(id);
    if (!el) return;
    if (el.type === 'text' && !text.trim()) {
      // An empty text box disappears. A brand-new one leaves no history entry.
      this.setEls(this.els.filter((e) => e.id !== id), { commit: !!(el.text || '').trim() });
      this.emit('selection');
      return;
    }
    const key = el.type === 'frame' ? 'title' : 'text';
    const value = el.type === 'frame' ? (text.trim() || 'Frame') : text;
    const cleaned = el.type === 'frame' ? '' : sanitize(target.innerHTML.replace(/\u200B/g, ''));
    const html = hasRichMarkup(cleaned) ? cleaned : undefined;
    if (value !== (el[key] || '') || html !== el.html) this.updateEls([id], { [key]: value, html }, { commit: !fresh });
    else { node._force = true; this.sync(); }
    this.emit('selection');
  }

  /* ================= text formatting ================= */
  isEditingText() {
    return !!this._edit && this.byId.get(this._edit.id)?.type !== 'frame';
  }

  queryText(cmd) {
    if (!this.isEditingText()) return false;
    try { return document.queryCommandState(cmd); } catch { return false; }
  }

  // While typing: applies to the selected words. Otherwise: to the whole text of each selected item.
  execText(cmd, value = null) {
    if (this.isEditingText()) {
      const s2 = window.getSelection();
      const caretOnly = s2.rangeCount && s2.getRangeAt(0).collapsed && this._edit.target.textContent.length;
      const LIST = cmd === 'insertUnorderedList' || cmd === 'insertOrderedList';
      if (caretOnly && !LIST && cmd !== 'createLink') {
        // Nothing highlighted: style the whole text, then put the caret back where it was.
        const keep = s2.getRangeAt(0).cloneRange();
        const all = document.createRange();
        all.selectNodeContents(this._edit.target);
        s2.removeAllRanges(); s2.addRange(all);
        document.execCommand(cmd, false, value);
        s2.removeAllRanges();
        try { s2.addRange(keep); } catch { const end = document.createRange(); end.selectNodeContents(this._edit.target); end.collapse(false); s2.addRange(end); }
      } else document.execCommand(cmd, false, value);
      this.emit('textselection');
      return;
    }
    const ids = this.selected().filter((e) => TEXTUAL.has(e.type) && !e.locked).map((e) => e.id);
    if (!ids.length) return;
    const before = this.els;
    for (const id of ids) {
      this.startEditing(id, { selectAll: true, fresh: true });
      document.execCommand(cmd, false, value);
      this.finishEditing();
    }
    this.commitFrom(before);
    this.select(ids);
  }

  toggleTextProp(prop) {
    const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' }[prop];
    if (this.isEditingText()) { if (cmd === 'strikeThrough') this.execText(cmd); else this.toggleInline(cmd); return; }
    const texty = this.selected().filter((e) => TEXTUAL.has(e.type) && !e.locked);
    if (!texty.length) return;
    this.applyStyle(texty.map((e) => e.id), { [prop]: !texty.every((e) => e[prop]) });
  }

  // Bold / italic / underline while typing, the way word processors do it — and the same in every browser:
  //  • words highlighted → toggle them;
  //  • caret inside a word → toggle that whole word (no need to select it to un-bold it);
  //  • caret at the end of a word or in a space → switch the style on/off for what you type next.
  toggleInline(cmd) {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !this._edit) return;
    const r = sel.getRangeAt(0);
    if (!this._edit.target.contains(r.startContainer)) return;
    if (!r.collapsed) { document.execCommand(cmd, false, null); this.emit('textselection'); return; }
    const word = wordAround(r);
    if (word) {
      sel.removeAllRanges(); sel.addRange(word);
      document.execCommand(cmd, false, null);
      const after = sel.getRangeAt(0).cloneRange();
      after.collapse(false);
      sel.removeAllRanges(); sel.addRange(after);
      this.emit('textselection');
      return;
    }
    const on = (() => { try { return document.queryCommandState(cmd); } catch { return false; } })();
    const style = {
      bold: `font-weight: ${on ? 400 : 700}`,
      italic: `font-style: ${on ? 'normal' : 'italic'}`,
      underline: `text-decoration: ${on ? 'none' : 'underline'}`,
    }[cmd];
    // An empty run holding an invisible character keeps the caret, so the next letters take its style.
    const span = document.createElement('span');
    span.setAttribute('style', style);
    span.textContent = '\u200B';
    r.insertNode(span);
    const caret = document.createRange();
    caret.setStart(span.firstChild, 1);
    caret.collapse(true);
    sel.removeAllRanges(); sel.addRange(caret);
    this.emit('textselection');
  }

  // Shortcuts while typing inside a note, text box or shape. Returns true when handled.
  editingKeys(e) {
    const raw = (cmd) => { document.execCommand(cmd, false, null); this.emit('textselection'); };
    const k = e.key.toLowerCase();
    if (!e.shiftKey && !e.altKey) {
      if (k === 'b') { this.toggleInline('bold'); return true; }
      if (k === 'i') { this.toggleInline('italic'); return true; }
      if (k === 'u') { this.toggleInline('underline'); return true; }
      if (k === '\\') { raw('removeFormat'); return true; }
    }
    if (e.shiftKey && !e.altKey) {
      if (e.code === 'KeyX') { raw('strikeThrough'); return true; }
      if (e.code === 'Digit7') { raw('insertOrderedList'); return true; }
      if (e.code === 'Digit8') { raw('insertUnorderedList'); return true; }
      if (e.code === 'KeyL' || e.code === 'KeyE' || e.code === 'KeyR') {
        this.setTextAlign({ KeyL: 'left', KeyE: 'center', KeyR: 'right' }[e.code], [this._edit.id]);
        return true;
      }
      if (e.code === 'Period' || e.code === 'Comma') { this.stepFontSize(e.code === 'Period' ? 1 : -1, [this._edit.id]); return true; }
    }
    return false;
  }

  // Element-level changes made while typing must not end the edit, so they patch the node in place.
  patchWhileEditing(ids, patch) {
    const ed = this._edit;
    if (!ed || !ids.includes(ed.id)) { this.applyStyle(ids, patch); return; }
    const before = this.els;
    const cur = this.byId.get(ed.id);
    const rec = (this.lastStyle[cur.type] ||= {});
    for (const k of Object.keys(patch)) if (STYLE_KEYS[cur.type]?.includes(k)) rec[k] = patch[k];
    store.set('architect.board.style', this.lastStyle);
    this.els = this.els.map((x) => (x.id === ed.id ? { ...x, ...patch } : x));
    this.byId = new Map(this.els.map((x) => [x.id, x]));
    const next = this.byId.get(ed.id);
    // Keep the live editable text (it holds what was typed); only restyle its container.
    const n = ed.node;
    if (patch.align) ed.target.style.textAlign = patch.align;
    if (patch.fontSize) ed.target.style.fontSize = `${patch.fontSize}px`;
    n._el = next;
    this.pushUndo(before);
    this.emit('change', { commit: true });
    requestAnimationFrame(() => ed.target.dispatchEvent(new Event('input')));
    this.emit('selection');
  }

  setTextAlign(align, ids = this.selected().filter((e) => TEXTUAL.has(e.type) && !e.locked).map((e) => e.id)) {
    if (ids.length) this.patchWhileEditing(ids, { align });
  }

  stepFontSize(dir, ids = this.selected().filter((e) => TEXTUAL.has(e.type) && !e.locked).map((e) => e.id)) {
    const SIZES = [12, 14, 16, 18, 22, 28, 36, 48, 64, 96, 144];
    const els = ids.map((id) => this.byId.get(id)).filter(Boolean);
    if (!els.length) return;
    // Auto-sized notes start from the size they're shown at.
    const shown = parseFloat(this.nodes.get(els[0].id)?._text?.style.fontSize);
    const base = els[0].fontSize ?? (Math.round(shown) || 22);
    const next = dir > 0 ? (SIZES.find((sz) => sz > base) ?? base + 24) : ([...SIZES].reverse().find((sz) => sz < base) ?? Math.max(4, base - 2));
    this.patchWhileEditing(els.map((e) => e.id), { fontSize: next });
  }

  // Copy the look of one item and paste it onto others (⌥⌘C / ⌥⌘V).
  copyStyle() {
    const el = this.selected()[0];
    if (!el || !STYLE_KEYS[el.type]) return false;
    const st = {};
    for (const k of STYLE_KEYS[el.type]) if (el[k] !== undefined) st[k] = el[k];
    this.styleClip = { type: el.type, st };
    return true;
  }

  pasteStyle() {
    const clip = this.styleClip;
    if (!clip) return false;
    const ids = this.selected().filter((e) => !e.locked && STYLE_KEYS[e.type]).map((e) => e.id);
    if (!ids.length) return false;
    this.updateEls(ids, (e) => {
      const out = {};
      for (const [k, v] of Object.entries(clip.st)) if (STYLE_KEYS[e.type].includes(k)) out[k] = v;
      return out;
    });
    this.emit('selection');
    return true;
  }

  // Tab / Shift+Tab walks through items, nearest-first by reading order, and keeps them in view.
  cycleSelection(dir) {
    const list = this.els.filter((e) => e.type !== 'line' && e.type !== 'pen')
      .map((e) => ({ e, r: rectOf(e, this.byId) }))
      .sort((a, b) => (Math.abs(a.r.y - b.r.y) > 40 ? a.r.y - b.r.y : a.r.x - b.r.x));
    if (!list.length) return;
    const cur = list.findIndex((x) => this.sel.has(x.e.id));
    const i = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
    this.select([list[i].e.id]);
    const r = list[i].r;
    const vr = this.rect();
    const a = this.toScreen({ x: r.x, y: r.y }), b = this.toScreen({ x: r.x + r.w, y: r.y + r.h });
    if (a.x < vr.left || a.y < vr.top || b.x > vr.right || b.y > vr.bottom) {
      const c = center(r);
      this.setCamera({ x: vr.width / 2 - c.x * this.cam.z, y: vr.height / 2 - c.y * this.cam.z, z: this.cam.z }, { animate: true });
    }
  }

  // ask() resolves to the URL typed by the person (or null).
  async addLink(ask) {
    const editing = this.isEditingText();
    let range = null;
    if (editing) {
      const s2 = window.getSelection();
      if (s2.rangeCount) range = s2.getRangeAt(0).cloneRange();
      this.holdEditing = true;
    }
    const raw = await ask();
    if (editing) {
      this.holdEditing = false;
      const ed = this._edit;
      if (!ed) return;
      ed.target.focus({ preventScroll: true });
      if (range) { const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(range); }
    }
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    if (editing && (!range || range.collapsed)) {
      const esc = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      document.execCommand('insertHTML', false, `<a href="${esc}">${esc}</a>`);
      return;
    }
    this.execText('createLink', url);
  }

  // Turn notes, text and shapes into each other, keeping their words and formatting.
  convert(type, kind = 'rect') {
    const ids = new Set(this.selected().filter((e) => TEXTUAL.has(e.type) && !e.locked && !(e.type === type && (type !== 'shape' || e.kind === kind))).map((e) => e.id));
    if (!ids.size) return;
    this.finishEditing();
    const conv = (e) => {
      const keep = {};
      for (const k of ['id', 'text', 'html', 'font', 'align', 'bold', 'italic', 'underline', 'strike', 'group']) if (e[k] !== undefined) keep[k] = e[k];
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      if (type === 'text') return { ...keep, type, x: e.x, y: e.y, w: Math.max(60, e.w), h: e.h, color: 'auto', fontSize: e.fontSize || 22, align: e.align || 'left' };
      if (type === 'sticky') {
        const sz = Math.max(160, Math.min(320, Math.max(e.w, e.h)));
        return { ...keep, type, x: cx - sz / 2, y: cy - sz / 2, w: sz, h: sz, fill: this.opts.sticky || '#FFFFFF', align: e.align || 'center' };
      }
      const w = Math.max(e.w, 140), hh = Math.max(e.h, 90);
      return { ...keep, type: 'shape', kind, x: cx - w / 2, y: cy - hh / 2, w, h: hh, fill: e.type === 'shape' ? e.fill : 'none', stroke: e.type === 'shape' ? e.stroke : 'auto', strokeWidth: e.strokeWidth ?? 2, fontSize: e.fontSize || 16, align: e.align || 'center' };
    };
    this.setEls(this.els.map((e) => (ids.has(e.id) ? conv(e) : e)));
    this.emit('selection');
  }

  activate(id) {
    this.activeId = id;
    const n = this.nodes.get(id);
    if (n) n._force = true;
    this.sync();
    this.emit('selection');
  }

  deactivate() {
    const id = this.activeId;
    if (!id) return;
    this.activeId = null;
    const n = this.nodes.get(id);
    if (n) n._force = true;
    this.sync();
    this.emit('selection');
  }

  /* ================= commands ================= */
  cloneEls(ids, dx = 24, dy = 24) {
    const set = new Set(ids);
    const map = new Map(ids.map((id) => [id, uid()]));
    const groupMap = new Map();
    const out = [];
    for (const el of this.els) {
      if (!set.has(el.id)) continue;
      const c = structuredClone(el);
      c.id = map.get(el.id);
      if (c.group) { if (!groupMap.has(c.group)) groupMap.set(c.group, uid()); c.group = groupMap.get(c.group); }
      if (c.type === 'line') {
        c.a = c.a?.id && map.has(c.a.id) ? { ...c.a, id: map.get(c.a.id) } : (() => { const g = lineGeom(el, this.byId); return { x: g.a.x + dx, y: g.a.y + dy }; })();
        c.b = c.b?.id && map.has(c.b.id) ? { ...c.b, id: map.get(c.b.id) } : (() => { const g = lineGeom(el, this.byId); return { x: g.b.x + dx, y: g.b.y + dy }; })();
      } else { c.x += dx; c.y += dy; }
      delete c.locked;
      out.push(c);
    }
    return out;
  }

  duplicate() {
    const ids = this.selected().map((e) => e.id);
    if (!ids.length) return;
    const clones = this.cloneEls(ids);
    this.setEls([...this.els, ...clones]);
    this.select(clones.map((c) => c.id));
  }

  deleteSelection() {
    const ids = this.selected().filter((e) => !e.locked).map((e) => e.id);
    if (ids.length) this.removeEls(ids);
  }

  serializeSelection() {
    const sel = this.selected();
    if (!sel.length) return null;
    // Resolve connector endpoints so a pasted copy keeps its shape.
    const els = sel.map((el) => {
      if (el.type !== 'line') return el;
      const g = lineGeom(el, this.byId);
      return { ...el, a: { ...el.a, x: g.a.x, y: g.a.y }, b: { ...el.b, x: g.b.x, y: g.b.y } };
    });
    return CLIP_MARK + JSON.stringify({ els });
  }

  copy() {
    const text = this.serializeSelection();
    if (!text) return false;
    this.clipboard = text;
    navigator.clipboard?.writeText(text).catch(() => {});
    return true;
  }

  onCopy(e, cut) {
    if (!this.vp.isConnected || this.offSurface || isTypingTarget(e.target) || isTypingTarget(document.activeElement) || this.editingId || this.inWidget) return;
    if (window.getSelection()?.toString()) return; // let normal text selection copy work
    const text = this.serializeSelection();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    this.clipboard = text;
    if (cut) this.deleteSelection();
  }

  onPaste(e) {
    if (!this.vp.isConnected || this.offSurface || isTypingTarget(e.target) || this.editingId || this.presenting || this.inWidget) return;
    if (document.querySelector('.dlg-overlay')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const at = this.pasteAnchor();
    const files = [...dt.files].filter((f) => /^(image|video)\//.test(f.type) || isPdf(f));
    if (files.length) { e.preventDefault(); this.emit('files', { files, at }); return; }
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_MARK)) { this.pasteSerialized(text, at); return; }
    const t = text.trim();
    if (looksLikeUrl(t)) { this.emit('url', { url: extractUrl(t), at }); return; }
    const el = this.makeEl('text', null, at);
    el.text = t.slice(0, 5000);
    el.w = Math.min(520, Math.max(160, Math.min(t.length, 60) * 11));
    this.addEls([el]);
  }

  pasteAnchor() {
    const lp = this.lastPointer;
    if (lp) {
      const sp = this.toScreen(lp);
      const r = this.rect();
      if (sp.x >= r.left && sp.x <= r.right && sp.y >= r.top && sp.y <= r.bottom) return lp;
    }
    return this.viewCenter();
  }

  pasteSerialized(text, at) {
    let data;
    try { data = JSON.parse(text.slice(CLIP_MARK.length)); } catch { return; }
    const list = (data?.els || []).filter((x) => x && x.id && x.type);
    if (!list.length) return;
    const map = new Map(list.map((x) => [x.id, uid()]));
    const groupMap = new Map();
    const rect = unionRects(list.map((x) => (x.type === 'line' ? { x: Math.min(x.a.x, x.b.x), y: Math.min(x.a.y, x.b.y), w: Math.abs(x.a.x - x.b.x), h: Math.abs(x.a.y - x.b.y) } : { x: x.x, y: x.y, w: x.w, h: x.h })));
    const c = center(rect);
    const dx = at.x - c.x, dy = at.y - c.y;
    const out = list.map((src) => {
      const el = structuredClone(src);
      el.id = map.get(src.id);
      delete el.locked;
      if (el.group) { if (!groupMap.has(el.group)) groupMap.set(el.group, uid()); el.group = groupMap.get(el.group); }
      if (el.type === 'line') {
        for (const k of ['a', 'b']) {
          const end = el[k];
          if (end.id && map.has(end.id)) el[k] = { ...end, id: map.get(end.id), x: end.x + dx, y: end.y + dy };
          else el[k] = { x: end.x + dx, y: end.y + dy };
        }
      } else { el.x += dx; el.y += dy; }
      return el;
    });
    this.addEls(out);
  }

  group() {
    const sel = this.selected();
    if (sel.length < 2) return;
    const gid = uid();
    this.updateEls(sel.map((e) => e.id), { group: gid });
    this.emit('selection');
  }

  ungroup() {
    const ids = new Set(this.selected().filter((e) => e.group).map((e) => e.id));
    if (!ids.size) return;
    this.setEls(this.els.map((e) => { if (!ids.has(e.id)) return e; const c = { ...e }; delete c.group; return c; }));
    this.emit('selection');
  }

  toggleLock() {
    const sel = this.selected();
    if (!sel.length) return;
    const lock = !sel.every((e) => e.locked);
    this.updateEls(sel.map((e) => e.id), { locked: lock });
    this.emit('selection');
  }

  bringToFront() {
    const set = this.sel;
    if (!set.size) return;
    this.setEls([...this.els.filter((e) => !set.has(e.id)), ...this.els.filter((e) => set.has(e.id))]);
  }

  sendToBack() {
    const set = this.sel;
    if (!set.size) return;
    this.setEls([...this.els.filter((e) => set.has(e.id)), ...this.els.filter((e) => !set.has(e.id))]);
  }

  align(kind) {
    const sel = this.selected().filter((e) => e.type !== 'line' && !e.locked);
    if (sel.length < 2) return;
    const r = unionRects(sel.map((e) => rectOf(e)));
    const patch = (e) => {
      switch (kind) {
        case 'left': return { x: r.x };
        case 'right': return { x: r.x + r.w - e.w };
        case 'center': return { x: r.x + r.w / 2 - e.w / 2 };
        case 'top': return { y: r.y };
        case 'bottom': return { y: r.y + r.h - e.h };
        case 'middle': return { y: r.y + r.h / 2 - e.h / 2 };
        default: return {};
      }
    };
    this.updateEls(sel.map((e) => e.id), (e) => movedTo(e, patch(e)));
  }

  distribute(axis) {
    const sel = this.selected().filter((e) => e.type !== 'line' && !e.locked);
    if (sel.length < 3) return;
    const key = axis === 'h' ? 'x' : 'y', size = axis === 'h' ? 'w' : 'h';
    const sorted = [...sel].sort((a, b) => a[key] - b[key]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const total = sorted.reduce((s2, e) => s2 + e[size], 0);
    const gap = (last[key] + last[size] - first[key] - total) / (sorted.length - 1);
    let cur = first[key];
    const pos = new Map();
    for (const e of sorted) { pos.set(e.id, cur); cur += e[size] + gap; }
    this.updateEls(sorted.map((e) => e.id), (e) => movedTo(e, { [key]: pos.get(e.id) }));
  }

  nudge(dx, dy) {
    const sel = this.selected().filter((e) => !e.locked);
    if (!sel.length) return;
    const before = this.els;
    const ids = new Set(sel.map((e) => e.id));
    this.setEls(this.els.map((e) => (ids.has(e.id) ? moved(e, dx, dy) : e)), { commit: false });
    clearTimeout(this._nudgeT);
    if (!this._nudgeBefore) this._nudgeBefore = before;
    this._nudgeT = setTimeout(() => { this.commitFrom(this._nudgeBefore); this._nudgeBefore = null; }, 400);
    this.emit('selection');
  }

  connectorFrom(src, b, side = null) {
    return {
      id: uid(), type: 'line', ...DEFAULTS.line, ...(this.lastStyle.line || {}),
      route: this.lastStyle.line?.route || 'curve',
      a: { id: src.id, x: src.x + src.w / 2, y: src.y + src.h / 2, ...(side ? { side } : {}) }, b,
    };
  }

  // Drag from a connection dot: the connector follows the pointer and snaps to whatever you drop it on.
  // A click without dragging adds a connected item on that side instead.
  beginAnchor(start, dir) {
    const src = this.selected()[0];
    if (!src || src.locked) return;
    const before = this.els;
    let line = null;
    this.startGesture({
      type: 'anchor', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!line) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 5) return;
          line = this.connectorFrom(src, { x: p.x, y: p.y }, DIR_SIDE[dir] || null);
          this.setEls([...this.els, line], { commit: false });
        }
        const t = this.elementAt(p, line.id);
        const bindId = t && t.id !== src.id ? t.id : null;
        if (bindId !== this.bindHover) this.bindHover = bindId;
        const b = bindId ? { id: bindId, x: p.x, y: p.y, side: nearestSide(this.byId.get(bindId), p) } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, b } : el)), { commit: false });
      },
      onUp: () => {
        this.bindHover = null;
        if (!line) { this.quickCreate(dir); return; }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([line.id]);
        this.syncSelection();
      },
    });
  }

  // Add a connected item on one side: a blank copy for notes, shapes and text; a sticky next to media.
  quickCreate(dir) {
    const src = this.selected()[0];
    if (!src) return;
    const gap = 90;
    let next;
    if (src.type === 'sticky' || src.type === 'shape' || src.type === 'text') {
      next = { ...structuredClone(src), id: uid(), text: '' };
      delete next.group; delete next.locked;
    } else {
      next = this.makeEl('sticky', { x: 0, y: 0, w: 200, h: 200 });
    }
    const cx = src.x + src.w / 2, cy = src.y + src.h / 2;
    if (dir === 'e') { next.x = src.x + src.w + gap; next.y = cy - next.h / 2; }
    else if (dir === 'w') { next.x = src.x - gap - next.w; next.y = cy - next.h / 2; }
    else if (dir === 's') { next.x = cx - next.w / 2; next.y = src.y + src.h + gap; }
    else { next.x = cx - next.w / 2; next.y = src.y - gap - next.h; }
    const line = this.connectorFrom(src, { id: next.id, x: next.x, y: next.y });
    this.setEls([...this.els, line, next]);
    this.sel = new Set([next.id]);
    this.syncSelection();
    this.startEditing(next.id, { fresh: true });
  }

  /* ================= keyboard ================= */
  get offSurface() { return (this.surface || null) !== activeSurface; }

  onKeyDown(e) {
    if (!this.vp.isConnected || this.offSurface) return;
    if (isTypingTarget(e.target) || document.querySelector('.dlg-overlay')) return;
    if (this.inWidget || (e.target instanceof Element && e.target.closest('.el-widget'))) return; // a widget is in use
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (this.presenting) {
      if (e.key === 'Escape') { e.preventDefault(); this.emit('present', 'exit'); }
      else if (['arrowright', 'arrowdown', ' ', 'pagedown', 'enter'].includes(k)) { e.preventDefault(); this.emit('present', 'next'); }
      else if (['arrowleft', 'arrowup', 'pageup', 'backspace'].includes(k)) { e.preventDefault(); this.emit('present', 'prev'); }
      return;
    }

    if (e.key === ' ' && !mod) {
      e.preventDefault();
      if (!this.space) { this.space = true; this.vp.classList.add('is-space'); }
      return;
    }
    if (mod && e.altKey) {
      if (e.code === 'KeyC') { e.preventDefault(); if (this.copyStyle()) this.emit('notice', 'Style copied'); }
      else if (e.code === 'KeyV') { e.preventDefault(); if (this.pasteStyle()) this.emit('notice', 'Style pasted'); }
      return;
    }
    if (mod && e.shiftKey && this.sel.size) {
      const map = { KeyX: () => this.toggleTextProp('strike'), KeyE: () => this.setTextAlign('center'), KeyR: () => this.setTextAlign('right'),
        Period: () => this.stepFontSize(1), Comma: () => this.stepFontSize(-1),
        BracketRight: () => this.bringToFront(), BracketLeft: () => this.sendToBack() };
      if (map[e.code]) { e.preventDefault(); map[e.code](); return; }
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (k === 'y') { e.preventDefault(); this.redo(); }
      else if (k === 'a') { e.preventDefault(); this.selectAll(); }
      else if (k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (k === 'g') { e.preventDefault(); if (e.shiftKey) this.ungroup(); else this.group(); }
      else if (k === 'l' && e.shiftKey) { e.preventDefault(); this.toggleLock(); }
      else if (k === 'f') { e.preventDefault(); this.emit('command', 'search'); }
      else if ((k === 'b' || k === 'i' || k === 'u') && this.sel.size) { e.preventDefault(); this.toggleTextProp({ b: 'bold', i: 'italic', u: 'underline' }[k]); }
      else if (k === 'k' && this.sel.size) { e.preventDefault(); this.emit('command', 'link'); }
      else if (k === '=' || k === '+') { e.preventDefault(); this.zoomBy(1.25); }
      else if (k === '-' || k === '_') { e.preventDefault(); this.zoomBy(0.8); }
      else if (k === '0') { this.zoomTo(1); } // no preventDefault: it also resets a zoomed browser
      else if (k === 'e') { e.preventDefault(); this.emit('command', 'export'); }
      else if (k === 'p') { e.preventDefault(); this.emit('command', 'export-pdf'); }
      return;
    }
    if (e.altKey) {
      // Align / distribute selected items (codes, so macOS Option characters don't get in the way).
      const map = e.shiftKey
        ? { KeyH: () => this.distribute('h'), KeyV: () => this.distribute('v') }
        : { KeyA: () => this.align('left'), KeyD: () => this.align('right'), KeyW: () => this.align('top'), KeyS: () => this.align('bottom'), KeyH: () => this.align('center'), KeyV: () => this.align('middle') };
      if (map[e.code] && this.sel.size > 1) { e.preventDefault(); map[e.code](); }
      return;
    }

    if (e.key === 'Tab' && document.activeElement === this.vp) { e.preventDefault(); this.cycleSelection(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F2') {
      const sel = this.selected();
      if (sel.length === 1 && (TEXTUAL.has(sel[0].type) || sel[0].type === 'frame')) { e.preventDefault(); this.startEditing(sel[0].id); }
      return;
    }

    if (e.key === 'Escape') {
      if (this.g) return;
      if (this.activeId) this.deactivate();
      else if (this.tool !== 'select') this.setTool('select');
      else this.clearSel();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
    if (e.key === 'Enter') {
      const sel = this.selected();
      if (sel.length === 1 && (TEXTUAL.has(sel[0].type) || sel[0].type === 'frame')) { e.preventDefault(); this.startEditing(sel[0].id); }
      return;
    }
    if (e.key.startsWith('Arrow')) {
      if (!this.sel.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      this.nudge(d[0], d[1]);
      return;
    }
    if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); this.zoomToFit(); return; }
    if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); this.zoomToSelection(); return; }
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { e.preventDefault(); this.emit('command', 'shortcuts'); return; }
    if (e.key === ']') { this.bringToFront(); return; }
    if (e.key === '[') { this.sendToBack(); return; }
    const tools = { v: 'select', h: 'hand', n: 'sticky', t: 'text', s: 'shape', l: 'line', p: 'pen', e: 'eraser', f: 'frame' };
    if (tools[k] && !e.shiftKey) {
      if (k === 'p') this.setOpt('pen', 'pen');
      this.setTool(tools[k]);
      return;
    }
    if (k === 'b' && !mod) { this.setOpt('border', e.shiftKey ? 'curve' : 'box'); this.setTool('border'); return; }
    if (k === 'r') { this.setOpt('shape', 'rect'); this.setTool('shape'); return; }
    if (k === 'o') { this.setOpt('shape', 'ellipse'); this.setTool('shape'); return; }
    if (k === 'a') { this.setOpt('line', 'arrow'); this.setTool('line'); return; }
    if (k === 'u') { this.emit('command', 'upload'); return; }
    if (k === 'k') { this.emit('command', 'embed'); return; }
    if (k === 'g') { this.setPref('grid', !this.prefs.grid); return; }
  }

  onKeyUp(e) {
    if (e.key === ' ') { this.space = false; this.vp.classList.remove('is-space'); }
  }
}

/* ---------------- helpers ---------------- */
const snap = (v) => Math.round(v / 8) * 8;

function movedOnly(a, b) {
  for (const k in b) if (k !== 'x' && k !== 'y' && a[k] !== b[k]) return false;
  for (const k in a) if (!(k in b)) return false;
  return true;
}

function moved(el, dx, dy) {
  if (el.type === 'line') {
    return { ...el, a: el.a.id ? el.a : { x: el.a.x + dx, y: el.a.y + dy }, b: el.b.id ? el.b : { x: el.b.x + dx, y: el.b.y + dy } };
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}

function movedTo(el, patch) {
  return el.type === 'line' ? el : { ...el, ...patch };
}

function resized(el, nr, sx, sy, mapPt, single, corner) {
  if (el.type === 'line') {
    return { ...el, a: el.a.id ? el.a : mapPt(el.a), b: el.b.id ? el.b : mapPt(el.b) };
  }
  if (el.type === 'pen' || (el.type === 'border' && el.shape === 'curve')) {
    const kx = nr.w / (el.w || 1), ky = nr.h / (el.h || 1);
    return { ...el, ...nr, points: (el.points || []).map(([x, y]) => [Math.round(x * kx * 100) / 100, Math.round(y * ky * 100) / 100]) };
  }
  // Fine rounding and a low floor keep size differences intact even when a big group is shrunk a lot.
  const scaleFont = (f, k) => Math.max(1, Math.round(f * k * 100) / 100);
  if (el.type === 'text') {
    const out = { ...el, x: nr.x, y: nr.y, w: Math.max(4, nr.w), autoW: false };
    if (single && corner) out.fontSize = scaleFont(el.fontSize || 22, sx);
    else if (!single) out.fontSize = scaleFont(el.fontSize || 22, Math.min(sx, sy));
    return out;
  }
  if (el.type === 'widget') {
    // Live cards (chats, Paths, Tickets…) stay whole: whole pixels (fractional sizes blur and chop the
    // rounded edges) and a floor big enough for the header and some content.
    const minW = 220, minH = 120;
    const w = Math.max(minW, Math.round(nr.w)), hh = Math.max(minH, Math.round(nr.h));
    // If the left/top edge is the one being dragged, keep the opposite edge put when the floor kicks in.
    const x = nr.x !== el.x ? nr.x + nr.w - w : nr.x;
    const y = nr.y !== el.y ? nr.y + nr.h - hh : nr.y;
    return { ...el, x: Math.round(x), y: Math.round(y), w, h: hh };
  }
  const out = { ...el, ...nr };
  if (!single && el.fontSize && (el.type === 'shape' || el.type === 'sticky')) out.fontSize = scaleFont(el.fontSize, Math.min(sx, sy));
  return out;
}

// The word the caret is inside (letters on both sides), or null at a word's edge / in a space.
function wordAround(range) {
  const node = range.startContainer;
  if (node.nodeType !== 3) return null;
  const text = node.textContent;
  const at = range.startOffset;
  const isW = (c) => !!c && /[\p{L}\p{N}_'’-]/u.test(c);
  if (!isW(text[at - 1]) || !isW(text[at])) return null;
  let a = at, b = at;
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  const w = document.createRange();
  w.setStart(node, a);
  w.setEnd(node, b);
  return w;
}

// True when the wheel should scroll something inside a widget instead of moving the canvas.
function scrollsInside(target, dy, dx) {
  let n = target.closest('.wg-body');
  if (!n) return false;
  for (let el = target; el && el !== n.parentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      if ((dy < 0 && el.scrollTop > 0) || (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    }
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && dx) {
      if ((dx < 0 && el.scrollLeft > 0) || (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
    }
  }
  return false;
}
