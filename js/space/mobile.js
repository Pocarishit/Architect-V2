// ARCHITECT on a phone (Nov 22) — its own interface, not a shrunken copy of the desktop.
// The board you built stays untouched where it is. The phone gives every part of it a full-screen view
// made for one hand, and a slider at the bottom of every screen moves between them:
//   Path · Fleeting Moments · Variables · Voice Chat · Radio · Blueprint
// Tap a label to jump straight there, or drag the gold knob to sweep through them in order; the knob's
// tag always names where you are.
//
// How the views are built:
//  · Path is its own live Path (all your setpoints, day tabs in full names, one setpoint at a time).
//  · Fleeting Moments, Variables, Voice Chat and Radio borrow the object that's on the board: its header
//    and body move into the phone view (one instance — Radio never plays twice) and go back home when
//    the phone view closes or the screen gets wide again.
//  · Blueprint lists every blueprint as a card with its diagram, ready to open or start a new one.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu } from '../core/ui.js';
import { store } from '../core/util.js';
import { go } from '../core/router.js';
import { mountPaths } from '../views/paths.js';
import { mountKind, WIDGETS } from './widgets.js';

export const STOPS = [
  { id: 'path', label: 'Path', tag: 'Path' },
  { id: 'moments', label: 'Moments', tag: 'Fleeting Moments', kind: 'fleeting' },
  { id: 'variables', label: 'Variables', tag: 'Variables', kind: 'variables' },
  { id: 'voice', label: 'Voice', tag: 'Voice Chat', kind: 'tts', pair: 'radio' },
  { id: 'radio', label: 'Radio', tag: 'Radio', kind: 'radio', pair: 'voice' },
  { id: 'blueprint', label: 'Blueprint', tag: 'Blueprint' },
];
const BY_ID = Object.fromEntries(STOPS.map((s) => [s.id, s]));

/**
 * ctx: { page, me, editor(), host(), mode(), toggleSpace(), addWidget(kind), menuItems(), showBoard() }
 */
export function mountMobile(ctx) {
  const { page, me } = ctx;
  const memKey = 'architect.mob.stop';
  let cur = BY_ID[store.get(memKey, 'path')] ? store.get(memKey, 'path') : 'path';
  const views = new Map();   // stop id → { root, body, ctl?, borrowed? }
  let ed = ctx.editor();
  let offChange = null;

  const stage = h('div', { class: 'mob-stage' });
  const root = h('div', { class: 'mob', role: 'application', 'aria-label': 'Architect' }, stage);

  /* ---------------- the slider ---------------- */
  const rail = h('div', { class: 'mob-rail' }, h('i', { class: 'mob-line' }), h('i', { class: 'mob-fill' }));
  const knob = h('span', { class: 'mob-knob', role: 'slider', tabindex: 0, 'aria-label': 'View', 'aria-valuemin': 0, 'aria-valuemax': STOPS.length - 1 },
    h('span', { class: 'mob-tag' }));
  const stopBtns = STOPS.map((st, i) => h('button', {
    type: 'button', class: 'mob-stop', 'data-stop': st.id, 'aria-label': st.tag,
    onclick: () => show(st.id),
  }, h('i'), h('span', {}, st.label)));
  rail.append(...stopBtns, knob);
  const menuBtn = h('button', { class: 'mob-menu', type: 'button', 'aria-label': 'Menu' }, icon('more', 18));
  menuBtn.addEventListener('click', () => {
    const r = menuBtn.getBoundingClientRect();
    menu({ x: r.left, y: r.top - 8 }, [
      { label: ctx.mode() === 'personal' ? 'Go to the Shared Space' : 'Go to your Personal Space', icon: 'home', onSelect: () => ctx.toggleSpace() },
      { label: 'Open the board', icon: 'fit', onSelect: () => ctx.showBoard() },
      { label: 'Side Chat', icon: 'chat', onSelect: () => window.dispatchEvent(new CustomEvent('architect:sidechat-open', { detail: { ideas: false } })) },
      { label: 'Ideas', icon: 'spark', onSelect: () => window.dispatchEvent(new CustomEvent('architect:sidechat-open', { detail: { ideas: true } })) },
      '-', ...ctx.menuItems(),
    ], { side: 'top' });
  });
  const bar = h('nav', { class: 'mob-slider', 'aria-label': 'Views' }, menuBtn, h('div', { class: 'mob-track' }, rail));
  root.append(bar);
  page.append(root);
  page.classList.add('is-mob');
  document.body.classList.add('is-mob');

  const idx = (id) => Math.max(0, STOPS.findIndex((s) => s.id === id));
  const xOf = (i) => {
    const w = rail.clientWidth || 300;
    const pad = 26;
    return pad + (i * (w - pad * 2)) / (STOPS.length - 1);
  };
  function paintRail(id = cur, { live = false } = {}) {
    const i = idx(id);
    stopBtns.forEach((b, j) => {
      b.style.left = `${xOf(j)}px`;
      b.classList.toggle('is-on', j === i);
      b.classList.toggle('is-past', j < i);
      b.setAttribute('aria-current', j === i ? 'page' : 'false');
    });
    if (!live) knob.style.left = `${xOf(i)}px`;
    rail.querySelector('.mob-fill').style.width = `${(live ? parseFloat(knob.style.left) : xOf(i)) - xOf(0)}px`;
    knob.querySelector('.mob-tag').textContent = BY_ID[id].tag;
    knob.setAttribute('aria-valuenow', String(i));
    knob.setAttribute('aria-valuetext', BY_ID[id].tag);
  }

  // Drag the gold knob: it sweeps through the stops in order; the tag names the stop under it.
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    knob.setPointerCapture?.(e.pointerId);
    knob.classList.add('is-drag');
    const rr = rail.getBoundingClientRect();
    const near = (x) => {
      let best = 0, bd = Infinity;
      STOPS.forEach((_, j) => { const d = Math.abs(x - xOf(j)); if (d < bd) { bd = d; best = j; } });
      return STOPS[best].id;
    };
    let last = cur;
    const move = (ev) => {
      const x = Math.max(xOf(0), Math.min(xOf(STOPS.length - 1), ev.clientX - rr.left));
      knob.style.left = `${x}px`;
      const id = near(x);
      paintRail(id, { live: true });
      if (id !== last) { last = id; navigator.vibrate?.(4); }
    };
    const up = (ev) => {
      knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); knob.removeEventListener('pointercancel', up);
      knob.classList.remove('is-drag');
      show(near(Math.max(xOf(0), Math.min(xOf(STOPS.length - 1), ev.clientX - rr.left))));
    };
    knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
  });
  knob.addEventListener('keydown', (e) => {
    const i = idx(cur);
    if (e.key === 'ArrowRight') { e.preventDefault(); show(STOPS[Math.min(STOPS.length - 1, i + 1)].id); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(STOPS[Math.max(0, i - 1)].id); }
  });
  // A sideways swipe on the bar steps one view.
  let sw = null;
  bar.addEventListener('touchstart', (e) => { if (e.target.closest('.mob-knob')) return; const t = e.touches[0]; sw = { x: t.clientX, y: t.clientY }; }, { passive: true });
  bar.addEventListener('touchend', (e) => {
    if (!sw) return;
    const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    sw = null;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
    const i = idx(cur);
    show(STOPS[Math.max(0, Math.min(STOPS.length - 1, i + (dx < 0 ? 1 : -1)))].id);
  }, { passive: true });

  /* ---------------- views ---------------- */
  function frame(st) {
    const title = h('span', { class: 'mob-title' }, st.tag.toUpperCase());
    const slot = h('div', { class: 'mob-slot' });
    const tools = h('div', { class: 'mob-tools' });
    const head = h('header', { class: 'mob-head' }, h('div', { class: 'mob-head-row' }, title, tools), slot);
    const body = h('div', { class: 'mob-body' });
    const view = h('section', { class: 'mob-view', 'data-view': st.id, hidden: true }, head, body);
    stage.append(view);
    return { view, head, title, slot, tools, body, own: [...head.childNodes] };
  }
  // Voice Chat and Radio share a screen: two tabs at the top, one tap apart.
  function pairTabs(st) {
    return h('div', { class: 'mob-pair', role: 'tablist' }, ['voice', 'radio'].map((id) => h('button', {
      type: 'button', role: 'tab', class: ['mob-pair-tab', id === st.id && 'is-on'], 'aria-selected': String(id === st.id),
      onclick: () => show(id),
    }, BY_ID[id].tag)));
  }

  function build(id) {
    const st = BY_ID[id];
    const v = frame(st);
    views.set(id, v);
    if (st.pair) { v.title.replaceWith(pairTabs(st)); v.view.classList.add('is-pair'); }
    if (id === 'path') {
      v.ctl = mountPaths(v.body, null, { embedded: true, owner: me.id, daySlot: v.slot, phone: true });
      v.view.classList.add('is-path');
    } else if (id === 'blueprint') {
      // The board list as cards with their diagrams.
      if (store.get('architect.bs.view.mobile', null) == null) store.set('architect.bs.view.mobile', 'grid');
      const w = pseudoW(v, { id: 'mobile', kind: 'blueprints' });
      v.ctl = mountKind('blueprints', v.body, { id: 'mobile', kind: 'blueprints' }, w) || {};
      v.title.textContent = 'BLUEPRINT';
    } else borrow(id);
    return v;
  }

  // A widget handle for views that aren't on the board (Blueprint list): opens go full screen on a phone.
  function pseudoW(v, el) {
    const host = { ...(ctx.host() || {}), openBoard: (bid) => { if (bid) go(`board/${bid}`); }, addPortal: () => {} };
    return {
      el, spaceId: host.spaceId, me, tools: v.tools, slot: v.slot, host, mobile: true,
      setTitle() {}, setBadge() {}, current: () => el, patch() {}, live() {},
    };
  }

  // The object on the board that answers for this view.
  function objectFor(st) {
    if (!ed || !st.kind) return null;
    const list = ed.els.filter((e) => e.type === 'widget' && e.kind === st.kind && !ed.isHidden(e));
    return list.find((e) => e.privateTo === me.id) || list[0] || null;
  }
  function nodeOf(el) { return el ? ed?.vp.querySelector(`.bp-world [data-eid="${CSS.escape(el.id)}"]`) : null; }

  function borrow(id) {
    const v = views.get(id);
    const st = BY_ID[id];
    giveBack(v);
    const el = objectFor(st);
    const node = nodeOf(el);
    const head = node?.querySelector(':scope > .wg-head');
    const body = node?.querySelector(':scope > .wg-body');
    if (!el || !head || !body) {
      v.body.replaceChildren(h('div', { class: 'mob-empty' },
        h('span', { class: 'mob-empty-ic' }, icon(WIDGETS[st.kind]?.icon || 'plus', 22)),
        h('p', {}, `No ${st.tag} on this board yet.`),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { ctx.addWidget(st.kind); requestAnimationFrame(() => requestAnimationFrame(() => borrow(id))); } }, icon('plus', 14), `Add ${st.tag}`)));
      v.borrowed = null;
      return;
    }
    v.body.replaceChildren();
    // The object's own header (its tabs and tools) and body move in; the grip and ··· stay meaningless here.
    v.head.classList.add('has-wg');
    // Voice Chat ⇄ Radio: the two tabs take the title's place in the object's own header row.
    if (st.pair) { v.pairEl = pairTabs(st); head.prepend(v.pairEl); }
    v.head.replaceChildren(head);
    v.body.append(body);
    node.classList.add('is-on-phone');
    v.borrowed = { id: el.id, node, head, body };
    if (id === 'moments' || id === 'variables') v.view.classList.add(`is-${id}`);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  function giveBack(v) {
    const b = v?.borrowed;
    if (!b) return;
    v.borrowed = null;
    v.pairEl?.remove(); v.pairEl = null;
    if (b.node.isConnected) { b.node.append(b.head, b.body); b.node.classList.remove('is-on-phone'); }
    v.head.classList.remove('has-wg');
    v.head.replaceChildren(...v.own);
  }

  function show(id, { animate = true } = {}) {
    if (!BY_ID[id]) id = 'path';
    const prev = cur;
    cur = id;
    store.set(memKey, id);
    let v = views.get(id) || build(id);
    if (BY_ID[id].kind && !v.borrowed) borrow(id); // a view left empty earlier: the object may be here now
    v = views.get(id);
    for (const [k, x] of views) {
      const on = k === id;
      x.view.hidden = !on;
      x.view.classList.toggle('is-in', on);
    }
    if (animate && prev !== id) {
      const dir = idx(id) > idx(prev) ? 'from-r' : 'from-l';
      v.view.classList.remove('from-r', 'from-l');
      void v.view.offsetWidth;
      v.view.classList.add(dir);
    }
    paintRail(id);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /* ---------------- staying in step with the board ---------------- */
  function bind(next) {
    offChange?.();
    for (const v of views.values()) giveBack(v);
    ed = next;
    offChange = ed?.on('change', () => {
      for (const [id, v] of views) {
        const st = BY_ID[id];
        if (!st.kind) continue;
        const el = objectFor(st);
        // The object was deleted, or another one took its place: follow it.
        if ((v.borrowed && (!el || el.id !== v.borrowed.id || !v.borrowed.node.isConnected)) || (!v.borrowed && el)) borrow(id);
      }
    }) || null;
    for (const [id, v] of views) if (BY_ID[id].kind) borrow(id);
  }
  bind(ed);
  requestAnimationFrame(() => show(cur, { animate: false }));
  const onResize = () => paintRail(cur);
  window.addEventListener('resize', onResize);

  return {
    root,
    rebind: (next) => bind(next),
    show,
    // "Open the board": every borrowed object goes home so the board is whole while you look at it.
    hide() {
      offChange?.(); offChange = null;
      for (const v of views.values()) giveBack(v);
      root.hidden = true; page.classList.remove('is-mob'); document.body.classList.remove('is-mob');
    },
    reveal(next) {
      root.hidden = false; page.classList.add('is-mob'); document.body.classList.add('is-mob');
      bind(next || ed);
      show(cur, { animate: false });
    },
    destroy() {
      offChange?.();
      window.removeEventListener('resize', onResize);
      for (const v of views.values()) { giveBack(v); try { v.ctl?.destroy?.(); } catch {} }
      root.remove();
      page.classList.remove('is-mob');
      document.body.classList.remove('is-mob');
    },
  };
}
