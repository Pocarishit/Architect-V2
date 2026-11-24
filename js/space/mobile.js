// ARCHITECT on a phone (Nov 22; one focused view + icon sidebar, Nov 25).
// The board you built stays untouched where it is. The phone shows one full-width view at a time:
//   · Path — your Path, or Fleeting Moments: the small looping arrow at the top right flips between them
//     (one title, never both; no tab bar, no split view);
//   · Variables.
// There's no bottom slider any more. The unboxed six-dot control beside the title opens the same icon-only
// sidebar as the desktop (its icons, in its order): Overview opens the board, Variables, Path, and More at
// the bottom. It's about an inch wide and lies over the view — it never squeezes it — and closes again
// with the same control, a tap outside it, or Esc.
//
// How the views are built:
//  · Path is its own live Path (one Set-Point bar, one task list).
//  · Fleeting Moments and Variables borrow the object that's on the board: its header and body move into
//    the phone view (one instance) and go back home when the phone view closes or the screen gets wide.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu } from '../core/ui.js';
import { store } from '../core/util.js';
import { mountPaths } from '../views/paths.js';
import { WIDGETS } from './widgets.js';
import { railIcon } from './sidebar.js';

export const STOPS = [
  { id: 'path', label: 'Path', tag: 'Path' },
  { id: 'moments', label: 'Moments', tag: 'Fleeting Moments', kind: 'fleeting', flip: 'path' },
  { id: 'variables', label: 'Variables', tag: 'Variables', kind: 'variables' },
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
  const root = h('div', { class: 'mob is-focused', role: 'application', 'aria-label': 'Architect' }, stage);

  /* ---------------- the icon sidebar (overlay) ---------------- */
  const side = h('nav', { class: 'mob-side', 'aria-label': 'Architect', hidden: true });
  const scrim = h('div', { class: 'mob-scrim', hidden: true, onclick: () => setSide(false) });
  root.append(scrim, side);
  let sideOpen = false;
  const sideItem = (id, ic, label, onClick, extra = '') => h('button', {
    type: 'button', class: ['mob-side-item', extra], 'data-v': id, title: label, 'aria-label': label,
    onclick: (e) => onClick(e.currentTarget),
  }, railIcon(ic));
  function paintSide() {
    side.replaceChildren(
      sideItem('space', 'logo', 'Overview', () => { setSide(false); ctx.showBoard(); }),
      sideItem('variables', 'atom', 'Variables', () => { setSide(false); show('variables'); }),
      sideItem('path', 'compass', 'Path', () => { setSide(false); show(cur === 'moments' ? 'moments' : 'path'); }),
      h('span', { class: 'mob-side-push', 'aria-hidden': 'true' }),
      sideItem('more', 'dots', 'More', (b) => moreMenu(b), 'is-more'));
  }
  function moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    menu({ x: r.right + 6, y: Math.max(12, r.top - 260) }, [
      { label: ctx.mode() === 'personal' ? 'Go to the Shared Space' : 'Go to your Personal Space', icon: 'home', onSelect: () => { setSide(false); ctx.toggleSpace(); } },
      { label: 'Side Chat', icon: 'chat', onSelect: () => { setSide(false); window.dispatchEvent(new CustomEvent('architect:sidechat-open', { detail: { ideas: false } })); } },
      { label: 'Ideas', icon: 'spark', onSelect: () => { setSide(false); window.dispatchEvent(new CustomEvent('architect:sidechat-open', { detail: { ideas: true } })); } },
      '-', ...ctx.menuItems().map((it) => (it && typeof it === 'object' && it.onSelect ? { ...it, onSelect: () => { setSide(false); it.onSelect(); } } : it)),
    ]);
  }
  function setSide(on) {
    sideOpen = !!on;
    side.hidden = !sideOpen; scrim.hidden = !sideOpen;
    root.classList.toggle('is-side-open', sideOpen);
    for (const v of views.values()) v.dots?.setAttribute('aria-expanded', String(sideOpen));
  }
  const onKey = (e) => { if (e.key === 'Escape' && sideOpen) { e.preventDefault(); setSide(false); } };
  window.addEventListener('keydown', onKey);
  paintSide();
  page.append(root);
  page.classList.add('is-mob');
  document.body.classList.add('is-mob');

  const idx = (id) => Math.max(0, STOPS.findIndex((s) => s.id === id));
  const paintRail = () => {};

  /* ---------------- views ---------------- */
  function frame(st) {
    // One small title in Doto, normal capitalization; the six dots beside it open the icon sidebar.
    const title = h('span', { class: 'mob-title' }, st.tag);
    const dots = h('button', { type: 'button', class: 'mob-dots', 'aria-label': 'Open the sidebar', 'aria-expanded': 'false', onclick: () => setSide(!sideOpen) }, icon('grip', 18));
    const flipTo = st.id === 'path' ? 'moments' : st.flip || null;
    const flip = flipTo ? h('button', { type: 'button', class: 'mob-flip', 'aria-label': `Switch to ${BY_ID[flipTo].tag}`, title: BY_ID[flipTo].tag, onclick: () => show(flipTo) }, icon('repeat', 15)) : null;
    const slot = h('div', { class: 'mob-slot' });
    const tools = h('div', { class: 'mob-tools' });
    const bar = h('div', { class: 'mob-topbar' }, dots, title, h('span', { class: 'mob-flex' }), flip);
    const head = h('header', { class: 'mob-head' }, h('div', { class: 'mob-head-row' }, tools), slot);
    const body = h('div', { class: 'mob-body' });
    const view = h('section', { class: 'mob-view', 'data-view': st.id, hidden: true }, bar, head, body);
    stage.append(view);
    return { view, head, title, slot, tools, body, dots, own: [...head.childNodes] };
  }
  function build(id) {
    const st = BY_ID[id];
    const v = frame(st);
    views.set(id, v);
    if (id === 'path') {
      v.ctl = mountPaths(v.body, null, { embedded: true, owner: me.id, daySlot: v.slot, phone: true });
      v.view.classList.add('is-path');
    } else borrow(id);
    return v;
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
  const onResize = () => { if (innerWidth >= 720 && sideOpen) setSide(false); };
  window.addEventListener('resize', onResize);

  return {
    root,
    rebind: (next) => bind(next),
    show,
    // "Open the board": every borrowed object goes home so the board is whole while you look at it.
    hide() {
      setSide(false);
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
      window.removeEventListener('keydown', onKey);
      for (const v of views.values()) { giveBack(v); try { v.ctl?.destroy?.(); } catch {} }
      root.remove();
      page.classList.remove('is-mob');
      document.body.classList.remove('is-mob');
    },
  };
}
