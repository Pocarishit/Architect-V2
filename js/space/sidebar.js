// ARCHITECT — Desktop sidebar (Nov 23, from "Architect Systems Blueprint").
// A rail on the left gives direct access to the parts of Architect you use most, without hunting for them
// on the canvas. ARCHITECT still opens the full Space (pan and zoom as usual); the others open full views:
//   · VARIABLES — pick a category from the top row, pick one of its chats in the sidebar; the main pane is
//     that chat as a standard Variables chat object. The category map (its tiles, Free View) opens from its
//     preview at the bottom of the sidebar, compact or full screen. Each category has its own cover and is
//     SHARED (with your shared Space) or PRIVATE.
//   · PATH — your Path on the left, Fleeting Moments on the right (Story / Weekly) beside it.
//   · MORE — Settings, Profile, Custom.
//   · Custom views — your own sidebar shortcuts: pick the objects they open; they sit in a fixed layout
//     (no pan or zoom). Rename an object, hide just its title, or hide its whole header.
// Board objects (Fleeting Moments, Radio, …) are borrowed: their header and body move into the view and go
// back to the board when you leave it — one instance, never two. Path is mounted fresh (it's account data).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, promptDialog, confirmDialog, closeFloating } from '../core/ui.js';
import { store, uid } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';
import { setSurface } from '../board/editor.js';
import { mountPaths } from '../views/paths.js';
import { mountVariables } from './variables.js';
import { WIDGETS } from './widgets.js';
import { urlOf, pickMedia, uploadMedia } from './media.js';
import { bubbleRow, dayRow, chatDayLabel, CHAT_GROUP_MS } from './sidechat.js';
import { loadMyVars, myVars, setMyVars, onMyVars } from '../data/myvars.js';
import { startVarShare, foreignCats, onShared, shareCategory, unshareCategory, addSharedNote, removeSharedNote, setSharedSpace, syncShared } from '../data/varshare.js';

// Objects a custom view can hold.
const KINDS = ['path', 'fleeting', 'variables', 'timer', 'blueprints', 'chat', 'tts', 'radio'];
const label = (k) => (k === 'path' ? 'Path' : WIDGETS[k]?.label || k);
const hue = (t) => { let x = 0; for (const c of String(t).trim()) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };

/**
 * ctx: { page, me, editor(), host(), mode(), toggleSpace(), addWidget(kind), openSettings(tab), sharedSpaceId(), onView(id) }
 */
export function mountSidebar(ctx) {
  const { page, me } = ctx;
  const memKey = `architect.sb.view.${me.id}`;
  let cur = store.get(memKey, 'space');
  let ed = ctx.editor();
  let active = null;            // the mounted view: { id, root, destroy() }
  const offs = [];

  const rail = h('nav', { class: 'sb-rail', 'aria-label': 'Architect' });
  const stage = h('div', { class: 'sb-stage', 'data-surface': 'sidebar', hidden: true });
  const root = h('div', { class: 'sb' }, rail, stage);
  page.append(root);
  page.classList.add('has-sb');

  /* ---------------- custom views (saved on your account) ---------------- */
  const views = () => (Array.isArray(getPref('sbViews', null)) ? getPref('sbViews', []) : []);
  const saveViews = (list) => setPref('sbViews', list).catch((e) => toast(friendlyError(e), { tone: 'error' }));
  const viewById = (id) => views().find((v) => v.id === id);

  /* ---------------- the rail ---------------- */
  function item(id, ic, text, onClick, extra = {}) {
    return h('button', {
      type: 'button', class: ['sb-item', cur === id && 'is-on'], 'data-v': id, 'aria-current': cur === id ? 'page' : 'false', title: text,
      onclick: (e) => onClick(e.currentTarget), ...extra,
    }, icon(ic, 20), h('span', {}, text.toUpperCase()));
  }
  function paintRail() {
    rail.replaceChildren(
      item('space', 'grid', 'Architect', () => show('space')),
      item('variables', 'widget', 'Variables', () => show('variables')),
      item('path', 'toPaths', 'Path', () => show('path')),
      item('more', 'burger', 'More', (b) => moreMenu(b)),
      ...views().map((v) => item(`custom:${v.id}`, 'board', v.name || 'My view', () => show(`custom:${v.id}`), {
        oncontextmenu: (e) => { e.preventDefault(); viewMenu({ x: e.clientX, y: e.clientY }, v); },
      })));
  }

  function moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    menu({ x: r.right + 6, y: r.top }, [
      { label: 'Settings', icon: 'settings', onSelect: () => ctx.openSettings('members') },
      { label: 'Profile', icon: 'user', onSelect: () => ctx.openSettings('profile') },
      { label: 'Custom', icon: 'layers', onSelect: () => newView() },
      ...(views().length ? ['-', { header: 'Your views' }, ...views().map((v) => ({ label: v.name, icon: 'board', onSelect: () => show(`custom:${v.id}`) }))] : []),
    ]);
  }

  /* ---------------- switching ---------------- */
  function show(id) {
    if (id.startsWith('custom:') && !viewById(id.slice(7))) id = 'space';
    closeFloating();
    if (active && active.id === id) { if (id !== 'space') setSurface('sidebar'); return; }
    active?.destroy(); active = null;
    cur = id;
    store.set(memKey, id);
    stage.replaceChildren();
    const open = id !== 'space';
    stage.hidden = !open;
    page.classList.toggle('sb-open', open);
    if (open) {
      const v = h('section', { class: 'sbv', 'data-view': id });
      stage.append(v);
      const made = id === 'variables' ? variablesView(v) : id === 'path' ? pathView(v) : customView(v, viewById(id.slice(7)));
      active = { id, root: v, destroy: made.destroy };
      setSurface('sidebar');
    } else {
      active = { id, destroy() {} };
      setSurface(null);
    }
    paintRail();
    ctx.onView?.(id);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /* ---------------- borrowing a board object ---------------- */
  function objectFor(kind) {
    if (!ed) return null;
    const list = ed.els.filter((e) => e.type === 'widget' && e.kind === kind && !ed.isHidden(e));
    return list.find((e) => e.privateTo === me.id) || list.find((e) => e.owner === me.id) || list[0] || null;
  }
  const nodeOf = (el) => (el ? ed?.vp.querySelector(`.bp-world [data-eid="${CSS.escape(el.id)}"]`) : null);
  /** Move a board object's header + body into `box`. Returns giveBack(), or null if it isn't on the board. */
  function borrow(kind, box) {
    const el = objectFor(kind);
    const node = nodeOf(el);
    const head = node?.querySelector(':scope > .wg-head');
    const body = node?.querySelector(':scope > .wg-body');
    if (!head || !body) return null;
    box.append(head, body);
    node.classList.add('is-on-phone'); // same "lent out" state the phone uses
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => { if (node.isConnected) { node.append(head, body); node.classList.remove('is-on-phone'); } };
  }
  function missing(kind, box, retry) {
    box.replaceChildren(h('div', { class: 'sb-empty' },
      h('span', { class: 'sb-empty-ic' }, icon(WIDGETS[kind]?.icon || 'plus', 22)),
      h('p', {}, `No ${label(kind)} on this board yet.`),
      h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => { ctx.addWidget(kind); requestAnimationFrame(() => requestAnimationFrame(retry)); } }, icon('plus', 14), `Add ${label(kind)}`)));
  }

  // A panel that holds one object: a borrowed board object, or your Path.
  function objectPanel(kind, { title, hideTitle, hideHeader, menuItems } = {}) {
    const box = h('div', { class: ['el-widget sb-obj', hideHeader && 'no-head', hideTitle && 'no-title'], 'data-wkind': kind });
    let back = null, paths = null;
    const more = menuItems ? h('button', { class: 'wg-btn sb-obj-more', type: 'button', 'aria-label': `${title || label(kind)} options`, onclick: (e) => menu(e.currentTarget, menuItems(), { align: 'end' }) }, icon('more', 15)) : null;
    if (kind === 'path') {
      const t = h('span', { class: 'wg-title' }, (title || `${me.username}’s Path`).toUpperCase());
      const slot = h('span', { class: 'wg-slot' });
      const head = h('div', { class: 'wg-head' }, h('span', { class: 'wg-grip', 'aria-hidden': 'true' }), t, slot, h('span', { class: 'wg-space' }), more);
      const body = h('div', { class: 'wg-body' });
      box.append(head, body);
      paths = mountPaths(body, null, { embedded: true, owner: me.id, daySlot: slot });
    } else {
      const fill = () => {
        back?.(); back = null;
        box.replaceChildren();
        back = borrow(kind, box);
        if (!back) { missing(kind, box, fill); return; }
        const head = box.querySelector(':scope > .wg-head');
        if (title && head) { const t = head.querySelector('.wg-title'); if (t) { t.dataset.sbOwn = t.textContent; t.textContent = title.toUpperCase(); } }
        // The board's own ··· stays at home in spirit: the panel's menu takes its place while it's here.
        if (more && head) { head.querySelector(':scope > .wg-btn:last-child')?.classList.add('sb-hide'); head.append(more); }
      };
      fill();
      // The object was deleted or replaced on the board: follow it.
      const off = ed?.on('change', () => { if (!box.isConnected) return; const el = objectFor(kind); const holding = box.querySelector(':scope > .wg-body'); if (!el || !holding) fill(); });
      box._off = off;
    }
    return {
      el: box,
      destroy() {
        box._off?.();
        if (back) {
          const head = box.querySelector(':scope > .wg-head');
          const t = head?.querySelector('.wg-title');
          if (t?.dataset.sbOwn != null) { t.textContent = t.dataset.sbOwn; delete t.dataset.sbOwn; }
          head?.querySelector('.sb-hide')?.classList.remove('sb-hide');
          more?.remove();
          back();
        }
        try { paths?.destroy?.(); } catch {}
      },
    };
  }

  /* ================= PATH: Path left, Fleeting Moments right ================= */
  function pathView(v) {
    const left = objectPanel('path');
    const right = objectPanel('fleeting');
    v.classList.add('sbv-split');
    v.append(h('div', { class: 'sbv-cols' }, h('div', { class: 'sbv-col is-wide' }, left.el), h('div', { class: 'sbv-col' }, right.el)));
    return { destroy() { left.destroy(); right.destroy(); } };
  }

  /* ================= VARIABLES ================= */
  function variablesView(v) {
    v.classList.add('sbv-vars');
    const vmem = `architect.sb.vars.${me.id}`;
    const st = store.get(vmem, {}) || {};
    let cat = st.cat || null;      // a top-level section id, or "s:<sharedItemId>" for someone else's category
    let open = st.open || null;    // entry id
    let query = '';
    let mapMode = null;            // null | 'compact' | 'full'
    const remember = () => store.set(vmem, { cat, open });

    const acct = () => myVars() || { sections: null, entries: [] };
    const sections = () => acct().sections || [];
    const tops = () => sections().filter((s) => !s.parent);
    const kids = (id) => sections().filter((s) => s.parent === id);
    const entriesIn = (id) => (acct().entries || []).filter((e) => e.section === id);
    const foreign = () => foreignCats();
    const isForeign = () => String(cat || '').startsWith('s:');
    const foreignItem = () => foreign().find((x) => `s:${x.id}` === cat) || null;

    // The chat pane is a standard Variables object, driven from here.
    const chatHost = h('div', { class: 'sbv-chat' });
    const chatCtl = mountVariables(chatHost, { id: `sidebar-${me.id}`, kind: 'variables', sections: [], entries: [] }, { host: { personal: false }, sidebar: true });
    const side = h('aside', { class: 'sbv-side' });
    const top = h('div', { class: 'sbv-cats', role: 'tablist', 'aria-label': 'Categories' });
    const main = h('div', { class: 'sbv-main' }, top, chatHost);
    const mapLayer = h('div', { class: 'sbv-map', hidden: true });
    v.append(side, main, mapLayer);
    let mapCtl = null;

    function pickCat(id) {
      cat = id; open = null; query = '';
      const first = firstEntry();
      if (first) open = first.id;
      remember(); paint();
    }
    function firstEntry() {
      if (isForeign()) return foreignItem()?.data?.entries?.[0] || null;
      const ids = subtree(cat);
      return (acct().entries || []).find((e) => ids.has(e.section)) || null;
    }
    function subtree(id) {
      const out = new Set([id]); let grew = true;
      while (grew) { grew = false; for (const s of sections()) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; } }
      return out;
    }

    function cover(s, { foreignOwner } = {}) {
      const url = s.img ? urlOf(s.img, paint) : null;
      return h('span', { class: 'sbv-cover', style: { '--h': hue(s.name) } },
        url ? h('img', { src: url, alt: '', draggable: false }) : h('b', {}, (s.name || '?').trim().slice(0, 1).toUpperCase()),
        foreignOwner ? h('i', { class: 'sbv-owner', title: `Shared by ${foreignOwner}` }, foreignOwner.slice(0, 1).toUpperCase()) : null);
    }

    function paintTop() {
      const mine = tops().map((s) => h('button', {
        type: 'button', role: 'tab', class: ['sbv-cat', cat === s.id && 'is-on'], 'aria-selected': String(cat === s.id), title: s.share?.item ? `${s.name} · shared` : s.name,
        onclick: () => pickCat(s.id), oncontextmenu: (e) => { e.preventDefault(); catMenu({ x: e.clientX, y: e.clientY }, s); },
      }, cover(s)));
      const theirs = foreign().map((it) => h('button', {
        type: 'button', role: 'tab', class: ['sbv-cat is-theirs', cat === `s:${it.id}` && 'is-on'], 'aria-selected': String(cat === `s:${it.id}`), title: `${it.data?.name || 'Category'} · shared by ${it.data?.owner || 'a member'}`,
        onclick: () => pickCat(`s:${it.id}`),
      }, cover({ name: it.data?.name || '?', img: it.data?.img }, { foreignOwner: it.data?.owner || '?' })));
      const add = h('button', { type: 'button', class: 'sbv-cat-add', title: 'New category', 'aria-label': 'New category', onclick: () => newCategory() }, icon('plus', 16));
      const s = !isForeign() && sections().find((x) => x.id === cat);
      const shareBtn = s ? h('button', {
        type: 'button', class: ['sbv-share', s.share?.item && 'is-on'], 'aria-pressed': String(!!s.share?.item),
        title: s.share?.item ? 'Shared with your Space — click to make it private' : 'Private — click to share it with your Space',
        onclick: () => toggleShare(s),
      }, icon(s.share?.item ? 'users' : 'lock', 15), h('span', {}, s.share?.item ? 'SHARED' : 'PRIVATE'))
        : isForeign() ? h('span', { class: 'sbv-share is-ro' }, icon('users', 15), h('span', {}, `SHARED BY ${(foreignItem()?.data?.owner || '').toUpperCase()}`)) : null;
      top.replaceChildren(h('div', { class: 'sbv-cats-row' }, ...mine, ...theirs, add), h('span', { class: 'sbv-flex' }), shareBtn);
    }

    function paintSide() {
      const name = isForeign() ? (foreignItem()?.data?.name || 'Shared') : (sections().find((x) => x.id === cat)?.name || 'Variables');
      const search = h('input', { class: 'sbv-search', type: 'search', placeholder: 'Find a chat', value: query, 'aria-label': 'Find a chat',
        oninput: (e) => { query = e.target.value; paintList(); } });
      const catBtn = h('button', { type: 'button', class: 'sbv-catpick', onclick: (e) => catPicker(e.currentTarget) }, h('span', {}, name.toUpperCase()), icon('chevronDown', 13));
      const catMore = !isForeign() && cat ? h('button', { type: 'button', class: 'sbv-icon', 'aria-label': 'Category options', onclick: (e) => catMenu(e.currentTarget, sections().find((x) => x.id === cat)) }, icon('more', 15)) : null;
      list = h('div', { class: 'sbv-list', role: 'list' });
      side.replaceChildren(
        h('header', { class: 'sbv-side-head' }, h('span', { class: 'sbv-title' }, 'VARIABLES'), search),
        h('div', { class: 'sbv-catbar' }, catBtn, catMore),
        list,
        mapCard());
      paintList();
    }
    let list = null;
    function paintList() {
      if (!list) return;
      const q = query.trim().toLowerCase();
      const hit = (x) => !q || (x.name || '').toLowerCase().includes(q);
      const row = (x, depth = 0) => h('button', {
        type: 'button', role: 'listitem', class: ['sbv-row', open === x.id && 'is-on'], style: { '--d': depth },
        onclick: () => { open = x.id; remember(); paintList(); paintMain(); },
        oncontextmenu: isForeign() ? null : (e) => { e.preventDefault(); entryMenu({ x: e.clientX, y: e.clientY }, x); },
      }, h('span', { class: 'sbv-row-name' }, (x.name || 'Untitled').toUpperCase()), (x.notes || []).length ? h('em', {}, String((x.notes || []).length)) : null);
      const out = [];
      if (isForeign()) {
        const d = foreignItem()?.data || {};
        const secs = d.sections || [];
        const walk = (id, depth) => {
          for (const x of (d.entries || []).filter((e) => e.section === id && hit(e))) out.push(row(x, depth));
          for (const s of secs.filter((y) => y.parent === id)) { out.push(h('div', { class: 'sbv-group', style: { '--d': depth } }, s.name.toUpperCase())); walk(s.id, depth + 1); }
        };
        if (d.catId) walk(d.catId, 0);
      } else if (cat) {
        const walk = (id, depth) => {
          for (const x of entriesIn(id).filter(hit)) out.push(row(x, depth));
          for (const s of kids(id)) { out.push(h('div', { class: 'sbv-group', style: { '--d': depth } }, s.name.toUpperCase())); walk(s.id, depth + 1); }
        };
        walk(cat, 0);
        out.push(h('button', { type: 'button', class: 'sbv-row sbv-new', onclick: () => newChat() }, icon('plus', 13), h('span', {}, 'NEW CHAT')));
      }
      if (!out.length) out.push(h('p', { class: 'sbv-hint' }, q ? 'No chat matches.' : 'No chats here yet.'));
      list.replaceChildren(...out);
    }

    // The category map: this category's tiles and variables, as in the Variables object.
    function mapCard() {
      if (isForeign() || !cat) return h('span');
      const secs = kids(cat).slice(0, 6), ents = entriesIn(cat).slice(0, 6 - Math.min(6, secs.length));
      const preview = h('div', { class: 'sbv-map-prev' },
        ...secs.map((s) => h('span', { class: 'sbv-mini is-sec', style: { '--h': hue(s.name) } }, s.img && urlOf(s.img, paint) ? h('img', { src: urlOf(s.img), alt: '' }) : null)),
        ...ents.map((x) => h('span', { class: 'sbv-mini', style: { '--h': hue(x.name) } }, x.photo && urlOf(x.photo, paint) ? h('img', { src: urlOf(x.photo), alt: '' }) : null)));
      return h('section', { class: 'sbv-mapcard' },
        h('header', {}, h('span', {}, 'VARIABLES MAP'),
          h('button', { type: 'button', class: 'sbv-maplink', onclick: () => openMap('compact') }, 'Open map', icon('chevronRight', 12)),
          h('button', { type: 'button', class: 'sbv-icon', 'aria-label': 'Open the map full screen', title: 'Full screen', onclick: () => openMap('full') }, icon('fullscreen', 13))),
        h('button', { type: 'button', class: 'sbv-map-hit', 'aria-label': 'Open the category map', onclick: () => openMap('compact') }, preview));
    }
    function openMap(mode) {
      mapMode = mode;
      mapCtl?.destroy(); mapCtl = null;
      const body = h('div', { class: 'sbv-map-body' });
      const bar = h('header', { class: 'sbv-map-head' },
        h('span', {}, `${(sections().find((x) => x.id === cat)?.name || '').toUpperCase()} · MAP`),
        h('span', { class: 'sbv-flex' }),
        h('button', { type: 'button', class: 'sbv-icon', 'aria-label': mode === 'full' ? 'Compact' : 'Full screen', title: mode === 'full' ? 'Compact' : 'Full screen', onclick: () => openMap(mode === 'full' ? 'compact' : 'full') }, icon(mode === 'full' ? 'exitFullscreen' : 'fullscreen', 15)),
        h('button', { type: 'button', class: 'sbv-icon', 'aria-label': 'Close the map', onclick: closeMap }, icon('close', 15)));
      mapLayer.replaceChildren(h('div', { class: ['sbv-map-card', `is-${mode}`], 'data-wkind': 'variables' }, bar, body));
      mapLayer.hidden = false;
      mapLayer.classList.toggle('is-full', mode === 'full');
      mapCtl = mountVariables(body, { id: `sidebar-map-${me.id}`, kind: 'variables', sections: [], entries: [] }, { host: { personal: false } });
      mapCtl.show?.({ section: cat, sub: null, open: null });
      // Opening a variable from the map opens its chat in the main pane.
      const watch = setInterval(() => {
        const s = mapCtl?.state?.();
        if (!s?.open) return;
        open = s.open; cat = topOf(s.open) || cat; remember();
        mapCtl.show({ open: null });
        closeMap(); paint();
      }, 200);
      mapCtl._watch = watch;
    }
    function topOf(entryId) {
      const x = (acct().entries || []).find((e) => e.id === entryId);
      let s = x && sections().find((y) => y.id === x.section);
      const seen = new Set();
      while (s?.parent && !seen.has(s.id)) { seen.add(s.id); s = sections().find((y) => y.id === s.parent); }
      return s?.id || null;
    }
    function closeMap() { if (mapCtl?._watch) clearInterval(mapCtl._watch); mapCtl?.destroy(); mapCtl = null; mapMode = null; mapLayer.hidden = true; mapLayer.replaceChildren(); }
    const onEsc = (e) => { if (e.key === 'Escape' && mapMode && !document.querySelector('.dlg, .menu')) { e.preventDefault(); closeMap(); } };
    window.addEventListener('keydown', onEsc);

    /* ---------- the main pane ---------- */
    let sharedChat = null;
    function paintMain() {
      sharedChat?.destroy(); sharedChat = null;
      if (isForeign()) {
        chatHost.hidden = true;
        main.querySelector('.sbv-schat')?.remove();
        main.querySelector('.sbv-blank')?.remove();
        const it = foreignItem();
        const x = it?.data?.entries?.find((e) => e.id === open);
        if (!x) { main.append(blank('Pick a chat on the left.')); return; }
        sharedChat = mountSharedChat(it, x);
        main.append(sharedChat.el);
        return;
      }
      main.querySelector('.sbv-schat')?.remove();
      main.querySelector('.sbv-blank')?.remove();
      const x = open && (acct().entries || []).find((e) => e.id === open);
      chatHost.hidden = !x;
      if (!x) { main.append(blank(cat ? 'Pick a chat on the left — or make a new one.' : 'Make a category to start.')); return; }
      const st2 = chatCtl.state?.() || {};
      if (st2.open !== x.id) chatCtl.show({ section: topOf(x.id), sub: null, open: x.id });
    }
    const blank = (t) => h('div', { class: 'sbv-blank' }, h('span', { class: 'sbv-blank-ic' }, icon('chat', 22)), h('p', {}, t));

    function paint() {
      if (!isForeign() && !tops().some((s) => s.id === cat)) { cat = tops()[0]?.id || null; open = null; }
      if (isForeign() && !foreignItem()) { cat = tops()[0]?.id || null; open = null; }
      if (!open) { const f = firstEntry(); if (f) open = f.id; }
      remember();
      paintTop(); paintSide(); paintMain();
    }

    /* ---------- actions ---------- */
    function catPicker(anchor) {
      menu(anchor, [
        { header: 'Your categories' },
        ...tops().map((s) => ({ label: s.name, checked: s.id === cat, icon: s.share?.item ? 'users' : 'lock', onSelect: () => pickCat(s.id) })),
        ...(foreign().length ? ['-', { header: 'Shared with you' }, ...foreign().map((it) => ({ label: `${it.data?.name || 'Category'} · ${it.data?.owner || ''}`, checked: cat === `s:${it.id}`, icon: 'users', onSelect: () => pickCat(`s:${it.id}`) }))] : []),
        '-',
        { label: 'New category…', icon: 'plus', onSelect: newCategory },
      ]);
    }
    function catMenu(anchor, s) {
      if (!s) return;
      menu(anchor, [
        { header: s.name },
        { label: 'New chat', icon: 'plus', onSelect: () => { if (cat !== s.id) pickCat(s.id); newChat(); } },
        { label: 'New sub-section…', icon: 'folder', onSelect: () => newSub(s) },
        { label: 'Rename…', icon: 'edit', onSelect: () => rename(s) },
        { label: s.img ? 'Change cover' : 'Add a cover', icon: 'image', onSelect: () => setCover(s) },
        s.img ? { label: 'Remove cover', icon: 'eyeOff', onSelect: () => patchSec(s.id, { img: null }) } : null,
        { label: s.share?.item ? 'Make private' : 'Share with your Space', icon: s.share?.item ? 'lock' : 'users', onSelect: () => toggleShare(s) },
        { label: 'Open map', icon: 'grid', onSelect: () => { if (cat !== s.id) pickCat(s.id); openMap('compact'); } },
      ].filter(Boolean));
    }
    function entryMenu(anchor, x) {
      menu(anchor, [
        { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename chat', { value: x.name, maxLength: 48 }); if (n?.trim()) setMyVars({ entries: acct().entries.map((e) => (e.id === x.id ? { ...e, name: n.trim().slice(0, 48) } : e)) }); } },
        { label: 'Delete chat', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirmDialog(`Delete “${x.name}”?`, `Its ${(x.notes || []).length} notes go with it.`, { ok: 'Delete chat' }))) return;
          setMyVars({ entries: acct().entries.filter((e) => e.id !== x.id) });
          if (open === x.id) open = null;
        } },
      ]);
    }
    const patchSec = (id, p) => setMyVars({ sections: sections().map((x) => (x.id === id ? { ...x, ...p } : x)) });
    const ensureSecs = () => { if (!acct().sections) setMyVars({ sections: [] }); };
    async function newCategory() {
      const n = await promptDialog('New category', { placeholder: 'University, Family, Business…', maxLength: 40, ok: 'Create' });
      if (!n?.trim()) return;
      ensureSecs();
      const s = { id: uid(), name: n.trim().slice(0, 40) };
      setMyVars({ sections: [...sections(), s] });
      pickCat(s.id);
    }
    async function newSub(parent) {
      const n = await promptDialog(`New sub-section in ${parent.name}`, { maxLength: 40, ok: 'Create' });
      if (!n?.trim()) return;
      setMyVars({ sections: [...sections(), { id: uid(), name: n.trim().slice(0, 40), parent: parent.id }] });
    }
    async function newChat() {
      if (!cat || isForeign()) return;
      const n = await promptDialog('New chat', { placeholder: 'A person, a group, a commitment', maxLength: 48, ok: 'Create' });
      if (!n?.trim()) return;
      const x = { id: uid(), section: cat, name: n.trim().slice(0, 48), photo: null, notes: [], at: Date.now() };
      setMyVars({ entries: [...(acct().entries || []), x] });
      open = x.id; remember(); paint();
    }
    async function rename(s) {
      const n = await promptDialog('Rename category', { value: s.name, maxLength: 40 });
      if (n?.trim()) patchSec(s.id, { name: n.trim().slice(0, 40) });
    }
    async function setCover(s) {
      const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
      if (!f) return;
      try { const up = await uploadMedia(f); patchSec(s.id, { img: up.path }); }
      catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    }
    async function toggleShare(s) {
      try {
        if (s.share?.item) {
          if (!(await confirmDialog(`Make ${s.name} private?`, 'The people in your shared Space stop seeing it. Your own copy stays exactly as it is.', { ok: 'Make private', danger: false }))) return;
          await unshareCategory(s.id);
          toast(`${s.name} is private.`, { ms: 2000 });
        } else {
          setSharedSpace(ctx.sharedSpaceId?.() || null);
          const { failed } = await shareCategory(s.id);
          toast(failed.length ? `${s.name} is shared — couldn’t add ${failed.join(', ')}.` : `${s.name} is shared with your Space.`, { ms: 2600 });
        }
      } catch (e) { toast(/kind_check|check constraint/i.test(String(e?.message)) ? 'Sharing needs one database update: run supabase/nov23.sql in the Supabase SQL editor.' : friendlyError(e), { tone: 'error', ms: 6000 }); }
      paint();
    }

    /* ---------- a chat in someone else's shared category ---------- */
    function mountSharedChat(it, x) {
      let draft = '';
      const msgs = h('div', { class: 'vr-msgs sc-list', role: 'log', 'data-wheel': '' });
      const ta = h('textarea', { class: 'vr-input sc-input', rows: 1, placeholder: `Message ${x.name}`, maxlength: 4000,
        oninput: (e) => { draft = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
      const el = h('div', { class: 'sbv-schat vr-chat is-sc', 'data-wkind': 'variables' },
        h('div', { class: 'vr-chat-head' }, h('span', { class: 'vr-chat-name' }, x.name), h('span', { class: 'vr-chat-sec' }, `${it.data?.name || ''} · shared by ${it.data?.owner || ''}`)),
        msgs,
        h('div', { class: 'vr-compose sc-compose' },
          h('button', { class: 'sc-plus', type: 'button', 'aria-label': 'Add a photo', onclick: async () => {
            const fs = await pickMedia({ accept: 'image/*,video/*' });
            if (!fs.length) return;
            const files = [];
            for (const f of fs) { try { const up = await uploadMedia(f); files.push({ kind: up.kind, path: up.path, name: up.name }); } catch (e) { toast(friendlyError(e), { tone: 'error' }); } }
            if (files.length) await addSharedNote(it.id, x.id, note({ files }));
          } }, icon('plus', 18)),
          ta));
      const note = (p) => ({ id: uid(), by: me.id, name: me.username, ts: Date.now(), text: '', files: [], ...p });
      async function send() {
        const text = ta.value.trim();
        if (!text) return;
        ta.value = ''; draft = '';
        try { await addSharedNote(it.id, x.id, note({ text: text.slice(0, 4000) })); } catch (e) { toast(friendlyError(e), { tone: 'error' }); ta.value = text; }
      }
      function paintMsgs() {
        const cur2 = foreignCats().find((y) => y.id === it.id)?.data?.entries?.find((e) => e.id === x.id) || x;
        const rows = [];
        let last = null, lastDay = '';
        for (const m of cur2.notes || []) {
          const d = chatDayLabel(m.ts);
          if (d !== lastDay) { rows.push(dayRow(m.ts)); lastDay = d; last = null; }
          const cont = !!last && last.by === m.by && m.ts - last.ts < CHAT_GROUP_MS;
          const mine = m.by === me.id;
          rows.push(bubbleRow({ id: m.id, text: m.text, files: m.files, at: m.ts, edited: m.edited }, {
            cont, theirs: !mine, who: m.name || '', onAsset: paintMsgs,
            onMenu: (e) => menu({ x: e.clientX, y: e.clientY }, [
              m.text ? { label: 'Copy', icon: 'copy', onSelect: () => navigator.clipboard?.writeText(m.text).catch(() => {}) } : null,
              mine ? { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => removeSharedNote(it.id, x.id, m.id).catch((er) => toast(friendlyError(er), { tone: 'error' })) } : null,
            ].filter(Boolean)),
          }));
          last = m;
        }
        if (!rows.length) rows.push(h('p', { class: 'sbv-hint is-center' }, 'No messages yet'));
        const atEnd = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
        msgs.replaceChildren(...rows);
        if (atEnd) msgs.scrollTop = msgs.scrollHeight;
      }
      paintMsgs();
      requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
      const off = onShared(() => paintMsgs());
      return { el, destroy() { off(); el.remove(); } };
    }

    const offVars = onMyVars((d, keys) => { if (keys && keys.every((k) => k === 'ideas')) return; if (!document.activeElement?.closest?.('.sbv-side input')) paint(); else paintList(); });
    const offShared = onShared(() => { paintTop(); if (isForeign()) paintList(); });
    loadMyVars().then(() => { paint(); syncShared(); }).catch(() => paint());
    paint();
    return {
      destroy() {
        window.removeEventListener('keydown', onEsc);
        offVars(); offShared(); closeMap(); sharedChat?.destroy();
        try { chatCtl.destroy?.(); } catch {}
      },
    };
  }

  /* ================= CUSTOM VIEWS ================= */
  async function newView() {
    const n = await promptDialog('New sidebar view', { placeholder: 'My view', value: 'My view', maxLength: 24, ok: 'Create' });
    if (!n?.trim()) return;
    const v = { id: uid(), name: n.trim().slice(0, 24), items: [{ id: uid(), kind: 'path' }, { id: uid(), kind: 'fleeting' }] };
    await saveViews([...views(), v]);
    editing = true;
    show2(v.id);
  }
  let editing = false;
  const show2 = (id) => { active?.destroy(); active = null; cur = ''; show(`custom:${id}`); };
  function viewMenu(anchor, v) {
    menu(anchor, [
      { header: v.name },
      { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename view', { value: v.name, maxLength: 24 }); if (n?.trim()) { await saveViews(views().map((x) => (x.id === v.id ? { ...x, name: n.trim().slice(0, 24) } : x))); paintRail(); if (cur === `custom:${v.id}`) show2(v.id); } } },
      { label: 'Edit objects', icon: 'layers', onSelect: () => { editing = true; show2(v.id); } },
      { label: 'Delete view', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog(`Delete “${v.name}”?`, 'Only the shortcut goes — every object stays where it is.', { ok: 'Delete view' }))) return;
        await saveViews(views().filter((x) => x.id !== v.id));
        if (cur === `custom:${v.id}`) show('space'); else paintRail();
      } },
    ]);
  }

  function customView(root2, v) {
    root2.classList.add('sbv-custom');
    const panels = [];
    const save = (items) => saveViews(views().map((x) => (x.id === v.id ? { ...x, items } : x))).then(() => { v = viewById(v.id) || v; });
    const nameEl = h('button', { type: 'button', class: 'sbv-vname', title: 'Rename', onclick: async () => { const n = await promptDialog('Rename view', { value: v.name, maxLength: 24 }); if (n?.trim()) { await saveViews(views().map((x) => (x.id === v.id ? { ...x, name: n.trim().slice(0, 24) } : x))); v = viewById(v.id); nameEl.lastChild.textContent = v.name.toUpperCase(); paintRail(); } } },
      icon('layers', 16), h('span', {}, v.name.toUpperCase()));
    const addBtn = h('button', { type: 'button', class: 'btn sm sbv-add', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 13), 'ADD OBJECT');
    const doneBtn = h('button', { type: 'button', class: ['btn sm', editing ? 'sbv-done' : 'sbv-edit'], onclick: () => { editing = !editing; show2(v.id); } }, editing ? 'DONE' : 'EDIT');
    const head = h('header', { class: 'sbv-vhead' }, nameEl, h('span', { class: 'sbv-flex' }), editing ? addBtn : null, doneBtn);
    const row = h('div', { class: ['sbv-cols', editing && 'is-editing'] });
    root2.append(head, row);

    function addMenu(anchor) {
      const have = new Set((v.items || []).map((x) => x.kind));
      menu(anchor, [{ header: 'Add to this view' }, ...KINDS.map((k) => ({
        label: label(k), icon: k === 'path' ? 'toPaths' : WIDGETS[k]?.icon || 'widget', disabled: have.has(k),
        onSelect: async () => { await save([...(v.items || []), { id: uid(), kind: k }]); show2(v.id); },
      }))], { align: 'end' });
    }
    const patchItem = async (id, p) => { await save((v.items || []).map((x) => (x.id === id ? { ...x, ...p } : x))); show2(v.id); };
    for (const it of v.items || []) {
      const p = objectPanel(it.kind, {
        title: it.title, hideTitle: it.hideTitle, hideHeader: it.hideHeader,
        menuItems: () => [
          { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename object', { value: it.title || label(it.kind), maxLength: 32 }); if (n != null) patchItem(it.id, { title: n.trim() || null }); } },
          { label: it.hideTitle ? 'Show title' : 'Hide title', icon: 'type', onSelect: () => patchItem(it.id, { hideTitle: !it.hideTitle }) },
          { label: it.hideHeader ? 'Show header' : 'Hide header', icon: 'rect', onSelect: () => patchItem(it.id, { hideHeader: !it.hideHeader }) },
          { label: (it.flex || 1) > 1 ? 'Narrower' : 'Wider', icon: 'distH', onSelect: () => patchItem(it.id, { flex: (it.flex || 1) > 1 ? 1 : 2 }) },
          '-',
          { label: 'Remove from view', icon: 'close', danger: true, onSelect: async () => { await save((v.items || []).filter((x) => x.id !== it.id)); show2(v.id); } },
        ],
      });
      const col = h('div', { class: 'sbv-col', 'data-id': it.id, style: { flex: `${it.flex || 1} 1 0` } }, p.el);
      // A hidden header still needs a way back: in edit mode a small ··· floats on the panel.
      if (it.hideHeader && editing) col.append(h('button', { type: 'button', class: 'sbv-float-more', 'aria-label': 'Options', onclick: (e) => menu(e.currentTarget, [{ label: 'Show header', icon: 'rect', onSelect: () => patchItem(it.id, { hideHeader: false }) }, { label: 'Remove from view', icon: 'close', danger: true, onSelect: async () => { await save((v.items || []).filter((x) => x.id !== it.id)); show2(v.id); } }]) }, icon('more', 15)));
      if (editing) {
        const grip = h('span', { class: 'sbv-grip', title: 'Drag to reorder', 'aria-label': 'Drag to reorder' }, icon('grip', 15));
        col.prepend(grip);
        grip.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          col.classList.add('is-drag');
          const move = (ev) => {
            const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.sbv-col');
            if (!over || over === col || over.parentNode !== row) return;
            const r = over.getBoundingClientRect();
            row.insertBefore(col, ev.clientX > r.left + r.width / 2 ? over.nextSibling : over);
          };
          const up = async () => {
            window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
            col.classList.remove('is-drag');
            const order = [...row.querySelectorAll(':scope > .sbv-col')].map((n) => n.dataset.id);
            await save(order.map((id) => (v.items || []).find((x) => x.id === id)).filter(Boolean));
          };
          window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
        });
      }
      row.append(col);
      panels.push(p);
    }
    if (!(v.items || []).length) row.append(h('div', { class: 'sb-empty' }, h('p', {}, 'This view is empty.'), addBtn));
    return { destroy() { panels.forEach((p) => p.destroy()); } };
  }

  /* ---------------- life ---------------- */
  offs.push(startVarShare());
  setSharedSpace(ctx.sharedSpaceId?.() || null);
  paintRail();
  requestAnimationFrame(() => show(cur || 'space'));

  return {
    root,
    current: () => cur,
    show,
    // The Space switched (Tab) or reloaded its canvas: borrowed objects must come from the new board.
    rebind(next) {
      ed = next;
      const id = cur;
      if (id && id !== 'space') { active?.destroy(); active = null; cur = ''; show(id); }
    },
    destroy() {
      active?.destroy(); active = null;
      offs.forEach((f) => { try { f(); } catch {} });
      setSurface(null);
      page.classList.remove('has-sb', 'sb-open');
      root.remove();
    },
  };
}
