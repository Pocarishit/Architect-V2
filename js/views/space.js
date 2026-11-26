// ARCHITECT SPACE — one shared infinite canvas that replaces the tabs.
// Everything (Paths, Tracker, Ticket board, Blueprints) lives on it as movable objects.
// No chrome: right-click or press "/" for the menu. Invite-only: members invite by username.
import { icon } from '../core/icons.js';
import { menu, toast, dialog, promptDialog, confirmDialog, closeFloating } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { h, isTypingTarget } from '../core/dom.js';
import { api, friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';
import { mountBoard } from '../board/board.js';
import { makePreview } from '../board/preview.js';
import { rectOf, unionRects } from '../board/geometry.js';
import { createWidgetHost, WIDGETS, editCustom } from '../space/widgets.js';
import { defaultVariables, readVariablesHtml, countPeople, mergeVariables } from '../space/variables.js';
import { loadMyVars, myVars, setMyVars } from '../data/myvars.js';
import { themeItems, changePassword } from './shell.js';
import { openSettings } from './settings.js';
import { openBoardWindow } from '../space/window.js';
import { getSurface } from '../board/editor.js';
import { onEscapeFull } from '../core/guard.js';
import { go } from '../core/router.js';
import { askSource } from '../space/radio.js';
import { labelOf } from '../space/chat.js';
import { openEmergencyRoom, comboWatcher } from '../space/er.js';
import { mountMobile } from '../space/mobile.js';
import { mountSidebar } from '../space/sidebar.js';
import { openBlueprintsCanvas, watchJoins, actionFor, appKey, comboOf as comboKey } from '../space/nov27.js';
import { startBench } from '../board/bench.js';
import { pickTask, taskEl } from '../board/taskcard.js';
import { myTasks } from '../data/tasks.js';
import { bgOf, paintBg, moveBg } from '../space/backgrounds.js';
import { openSayComposer, enterOpensComposer } from '../space/saycomposer.js';

export function mountSpace(root) {
  const me = api.auth.current()?.user;
  const page = h('div', { class: 'space-host' });
  root.append(page);
  page.append(h('div', { class: 'bp-loading' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i'))));
  document.body.classList.add('is-board', 'is-space');

  let t = null;         // the board page's tools (editor, addFiles, …) for the Space on screen
  let spaceId = null;
  let destroyed = false;
  let lastPointer = null;
  const offs = [];
  const editor = () => t?.editor || null;
  const pathCtl = new Map(); // Path widget id → its controls (New path…)
  const register = (id, ctl) => { if (ctl) pathCtl.set(id, ctl); else pathCtl.delete(id); };
  const ttsCtl = new Map(); // Voice chat widget id → its controls (send)
  const registerTts = (id, ctl) => { if (ctl) ttsCtl.set(id, ctl); else ttsCtl.delete(id); };
  // Two worlds: the shared Space (everyone you're with) and your personal one. Tab flips between them.
  let mode = 'shared';
  const ids = { shared: null, personal: null };
  // Each Space stays mounted once opened; Tab just swaps which one is shown (no reload, no refetch).
  const slots = { shared: null, personal: null }; // { el, board, t, offs }
  let switching = false;

  /* ---------------- find (or make) your Space ---------------- */
  (async () => {
    try {
      await loadPrefs();
      await openMode(getPref('spaceMode', 'shared') === 'personal' ? 'personal' : 'shared', { first: true });
    } catch (e) {
      if (!destroyed) problem(e);
    }
  })();

  async function idFor(m) {
    if (!ids[m]) ids[m] = m === 'shared' ? await resolveSpace() : await resolvePersonal();
    return ids[m];
  }

  async function openMode(m, { first = false } = {}) {
    const id = await idFor(m);
    if (destroyed) return;
    closeFloating();
    bpWin?.close(); bpWin = null;
    page.querySelector(':scope > .bp-loading')?.remove();
    page.querySelector('.say-bar, .say-pop')?.remove();
    park(slots[mode]);
    mode = m; spaceId = id;
    page.dataset.mode = m;
    let slot = slots[m];
    if (slot) {
      // Already loaded: just show it again.
      slot.el.style.display = '';
      if (slot.t) slot.t.editor.surface = null;
      t = slot.t;
      if (t) mountDock(); // the dock's buttons point at the canvas on screen
    } else {
      t = null;
      slot = mountSlot(m, id);
    }
    if (!first) flash(m === 'personal' ? 'Personal space' : 'Shared space');
    if (getPref('spaceMode', 'shared') !== m) setPref('spaceMode', m).catch(() => {});
  }

  function mountSlot(m, id) {
    const slot = slots[m] = { el: null, board: null, t: null, offs: [], host: null };
    const before = page.lastElementChild;
    slot.host = { editor: () => slot.t?.editor || null, spaceId: id, personal: m === 'personal', me, openBoard, snapBack, detach, detachTicketCol, snapTicketCol, popTicket, snapTicket, expandTicket, poppedTickets, openMenuFor, reveal, addPortal, register, registerTts, warmShared };
    slot.board = mountBoard(page, id, {
      space: true,
      mountWidget: createWidgetHost(slot.host),
      extendMenu,
      onInvite: () => settings('members'),
      objects: (at) => widgetPicker(at),
      onReady: (tools) => onReady(tools, slot, m),
    });
    slot.el = page.lastElementChild !== before ? page.lastElementChild : null;
    if (slot.el) page.prepend(slot.el); // keep the dock and overlays above every canvas
    return slot;
  }

  // Fleeting Ideas' Shared view in your personal Space needs the shared pool, which lives on the shared
  // Space's object: load that Space quietly in the background (hidden and parked) if it isn't open yet.
  let warming = null;
  function warmShared() {
    if (slots.shared || mode === 'shared') return warming || Promise.resolve();
    warming ||= (async () => {
      try {
        const id = await idFor('shared');
        if (destroyed || slots.shared) return;
        const slot = mountSlot('shared', id);
        if (mode !== 'shared') park(slot);
      } catch (e) { console.warn('Shared Space did not load in the background', e); }
      finally { warming = null; }
    })();
    return warming;
  }

  // Side Chat's ideas canvas asks for the shared pool the same way.
  const onWarm = () => { warmShared(); };
  window.addEventListener('architect:warm-shared', onWarm);

  // Hide a Space without unloading it. 'parked' keeps its keyboard, copy and paste handlers asleep.
  function park(slot) {
    if (!slot?.el) return;
    slot.el.style.display = 'none';
    if (slot.t) slot.t.editor.surface = 'parked';
  }

  async function toggleSpace() {
    if (switching) return;
    switching = true;
    try { await openMode(mode === 'shared' ? 'personal' : 'shared'); }
    catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    finally { switching = false; }
  }

  function flash(text) {
    page.querySelector('.space-flash')?.remove();
    const tag = h('div', { class: 'space-flash', role: 'status' }, h('span', {}, text), appKey('personal') ? h('small', {}, `${appKey('personal')} to switch`) : null);
    page.append(tag);
    setTimeout(() => tag.classList.add('out'), 1100);
    setTimeout(() => tag.remove(), 1600);
  }

  // Yours alone: no members, never in the API's shared Space.
  async function resolvePersonal() {
    const rows = await api.db.select('blueprints', { columns: 'id,user_id,kind,created_at', filters: { kind: 'personal', user_id: me.id }, order: 'created_at.asc' });
    if (rows[0]) return rows[0].id;
    const id = uid();
    await api.db.insert('blueprints', {
      id, name: 'Personal Space', kind: 'personal', folder_id: null, pinned: false, preview: [],
      data: { v: 1, elements: [widgetEl('path', { x: -730, y: -420, owner: me.id, ownerName: me.username, detached: [] }), widgetEl('blueprints', { x: 790, y: -420 })] },
    });
    return id;
  }

  async function resolveSpace() {
    let rows;
    try {
      rows = await api.db.select('blueprints', { columns: 'id,user_id,name,kind,created_at', filters: { kind: 'space' }, order: 'created_at.asc' });
    } catch (e) {
      const err = new Error('The Space needs one more database update. Run supabase/space.sql in the Supabase SQL editor, then reload.');
      err.cause = e;
      throw err;
    }
    const saved = getPref('spaceId', null);
    // Once someone invites you, their Space wins over the solo one you may have started.
    const savedRow = rows.find((r) => r.id === saved);
    const invited = rows.find((r) => r.user_id !== me.id);
    let pick = (savedRow && savedRow.user_id !== me.id ? savedRow : invited) || savedRow || rows[0];
    // Nov 27 — two people who invited each other end up with two Spaces with the same members. Everyone picks
    // the same one: the oldest Space with exactly the same people. Spaces with different people stay separate,
    // and nothing is merged or deleted.
    if (rows.length > 1 && api.mode !== 'local') {
      try {
        const sig = new Map();
        await Promise.all(rows.map(async (r) => {
          const ppl = await Promise.race([api.rpc('board_people', { b: r.id }), new Promise((res) => setTimeout(() => res(null), 2500))]).catch(() => null);
          if (Array.isArray(ppl)) sig.set(r.id, ppl.map((x) => x.user_id).filter(Boolean).sort().join(','));
        }));
        const mine = pick && sig.get(pick.id);
        if (mine && mine.includes(',')) {
          const twins = rows.filter((r) => sig.get(r.id) === mine).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
          if (twins[0] && twins[0].id !== pick.id) pick = twins[0];
        } else if (!mine || !mine.includes(',')) {
          // You're alone in the one you'd open, but you share another: open the shared one (the oldest).
          const shared = rows.filter((r) => (sig.get(r.id) || '').includes(',')).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
          if (shared[0]) pick = shared[0];
        }
      } catch { /* offline: the usual choice */ }
    }
    if (pick && savedRow && pick.id !== savedRow.id) setTimeout(() => toast('You joined a shared Space.', { ms: 3500 }), 1200);
    if (pick) { if (pick.id !== saved) setPref('spaceId', pick.id).catch(() => {}); return pick.id; }
    const id = uid();
    await api.db.insert('blueprints', { id, name: 'Architect Space', kind: 'space', folder_id: null, pinned: false, data: { v: 1, elements: starter() }, preview: [] });
    setPref('spaceId', id).catch(() => {});
    return id;
  }

  // First layout: your Path on top, Fleeting Ideas / Variables / Blueprints below it.
  function starter() {
    return [
      widgetEl('path', { x: -730, y: -420, owner: me.id, ownerName: me.username, detached: [] }),
      widgetEl('fleeting', { x: -730, y: 160, ...fleetingData() }),
      widgetEl('variables', { x: 90, y: 160, ...defaultVariables() }),
      widgetEl('blueprints', { x: 610, y: 160 }),
    ];
  }
  const fleetingData = (old) => ({ ideas: [], story: {}, weekly: { goal: old?.goal || 'Rona’s Apartment', start: old?.start || mondayKey(), weeks: old?.weeks || {}, tray: [] } });

  // Nov 16 update: the Ticket board and Tracker & Weekly became tabs of Fleeting Ideas.
  // Old objects come off the canvas once; the weekly plan carries over. Ticket data stays in the database.
  function migrate(ed) {
    const OLD = ['tickets', 'tracker', 'ticketcol', 'ticket'];
    const old = ed.els.filter((e) => e.type === 'widget' && OLD.includes(e.kind));
    if (!old.length) return;
    const tracker = old.find((e) => e.kind === 'tracker');
    const spot = old.find((e) => e.kind === 'tickets') || tracker || old[0];
    const next = ed.els.filter((e) => !old.includes(e));
    const add = [];
    if (!next.some((e) => e.type === 'widget' && e.kind === 'fleeting')) add.push(widgetEl('fleeting', { x: spot.x, y: spot.y, ...fleetingData(tracker) }));
    if (!next.some((e) => e.type === 'widget' && e.kind === 'variables')) {
      const f = add[0] || spot;
      add.push(widgetEl('variables', { x: f.x + (WIDGETS.fleeting.w) + 60, y: f.y, ...defaultVariables() }));
    }
    ed.setEls([...next, ...add], { commit: false });
    toast('Ticket board and Tracker are now Fleeting Ideas.', { ms: 4000 });
  }

  // The custom-code Variables widget (v59) keeps its people in HTML and its chats in `variableChats`.
  // Offer once to bring both into the built-in Variables object; the old widget is left alone.
  async function importCustomVariables(ed) {
    const custom = ed.els.find((e) => e.type === 'widget' && e.kind === 'custom' && !e.nativeImported && /data-target=/.test(e.html || ''));
    if (!custom) return;
    const skip = `architect.vr.skipImport.${custom.id}`;
    if (store.get(skip, false)) return;
    const plan = readVariablesHtml(custom.html);
    const people = plan ? countPeople(plan) : 0;
    if (!people) return;
    const chats = Object.fromEntries((Array.isArray(custom.variableChats) ? custom.variableChats : []).map((c) => [c.id, c]));
    const notes = Object.values(chats).reduce((n, c) => n + (c.messages?.length || 0), 0);
    await new Promise((r) => setTimeout(r, 900));
    if (!ed.vp?.isConnected) return;
    const yes = await confirmDialog('Move Variables into the built-in object?',
      `${people} ${people === 1 ? 'person' : 'people'}${notes ? ` and ${notes} chat message${notes === 1 ? '' : 's'}` : ''} from your custom Variables widget go into Variables, with their pictures and sub-sections. The custom widget stays until you delete it.`,
      { ok: 'Move them in', danger: false });
    if (!yes) { store.set(skip, true); return; }
    let target = ed.els.find((e) => e.type === 'widget' && e.kind === 'variables');
    if (!target) {
      target = widgetEl('variables', { x: custom.x + (custom.w || 460) + 60, y: custom.y, ...defaultVariables() });
      ed.addEls([target], { select: false });
    }
    const progress = toast(`Moving Variables… 0/${people}`, { ms: 0 });
    try {
      // Variables live on your account now, so the import goes there (not onto the object).
      await loadMyVars();
      const cur = myVars() || {};
      const out = await mergeVariables({ sections: cur.sections || defaultVariables().sections, entries: cur.entries || [] }, plan, { chats, onStep: (n) => progress.update(`Moving Variables… ${n}/${people}`) });
      setMyVars({ sections: out.sections, entries: out.entries });
      ed.updateEls([custom.id], { nativeImported: true });
      progress.close();
      toast(`Variables: ${out.added} new ${out.added === 1 ? 'entry' : 'entries'}${out.notes ? `, ${out.notes} notes` : ''}.`, { ms: 4000 });
      ed.fitRect(ed.byId.get(target.id), { maxZ: 1, pad: 60 });
    } catch (e) {
      progress.close();
      toast(friendlyError(e), { tone: 'error', ms: 5000 });
    }
  }

  function widgetEl(kind, extra = {}) {
    const d = WIDGETS[kind];
    return { id: uid(), type: 'widget', kind, w: d.w, h: d.h, x: 0, y: 0, ...extra };
  }

  function problem(e) {
    page.replaceChildren(h('div', { class: 'bp-problem' },
      h('p', { class: 'empty-text' }, e?.message || friendlyError(e)),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Reload')));
  }

  /* ---------------- once the canvas is up ---------------- */
  function onReady(tools, slot, m) {
    slot.t = tools;
    const ed = tools.editor;
    if (mode === m) t = tools;
    else ed.surface = 'parked'; // you tabbed away while it was loading
    tools.page.classList.toggle('show-chrome', !!getPref('spaceChrome', false));
    applyBg(m);
    migrate(ed);
    importCustomVariables(ed);
    // Everyone gets their own Path on the shared canvas.
    if (!ed.els.some((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id)) {
      const rc = ed.els.length ? unionRects(ed.els.map((e) => rectOf(e, ed.byId))) : { x: 0, y: 0, w: 0, h: 0 };
      const el = widgetEl('path', { x: rc.x + rc.w + 120, y: rc.y, owner: me.id, ownerName: me.username, detached: [] });
      ed.addEls([el], { select: false });
      if (ed.els.length > 1) toast('Your Path was added to the Space.', { ms: 3000 });
    }
    // Phones: start on your own Path instead of the whole Space.
    const mine = ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id);
    if (mine && innerWidth < 720 && !localStorage.getItem(`architect.cam.${ids[m]}`)) ed.fitRect(mine, { maxZ: 1, pad: 12, animate: false });
    if (!getPref('spaceHinted', false)) {
      const touch = matchMedia('(hover: none)').matches;
      setTimeout(() => toast(touch ? 'Long-press the canvas for the menu.' : 'Right-click or press / for the menu.', { ms: 5000 }), 800);
      setPref('spaceHinted', true).catch(() => {});
    }
    // Ticket cards come and go (dragged out, deleted, undone): keep the board's faded copies in step.
    let lastPop = [...poppedTickets()].sort().join();
    slot.offs.push(ed.on('change', () => { const sig = [...poppedTickets()].sort().join(); if (sig !== lastPop) { lastPop = sig; ticketsMoved(); } }));
    slot.offs.push(watchJoins(ed));
    if (mode === m) mountDock();
    sweepDeadKeys();
    // An old Paths / Ticket board link brought you here: fly to your Path.
    try { const f = sessionStorage.getItem('architect.focus'); if (f && mode === m) { sessionStorage.removeItem('architect.focus'); setTimeout(() => focusKind(f), 60); } } catch {}
    // "Open as a window" from a full-page Blueprint lands back here with the window open.
    let pending = null;
    try { pending = sessionStorage.getItem('architect.openWin'); sessionStorage.removeItem('architect.openWin'); } catch {}
    if (pending) openBoard(pending, { window: true });
    // Pull a detached column back home when you drop it on its Path.
    const vp = ed.vp;
    const onUp = () => setTimeout(checkSnap, 0);
    vp.addEventListener('pointerup', onUp);
    slot.offs.push(() => vp.removeEventListener('pointerup', onUp));
  }

  function checkSnap() {
    const ed = editor();
    if (!ed) return;
    const sel = ed.selected();
    if (sel.length !== 1 || sel[0].type !== 'widget') return;
    const col = sel[0];
    const inside = (home) => { const cx = col.x + col.w / 2, cy = col.y + 40; return home && cx > home.x && cx < home.x + home.w && cy > home.y && cy < home.y + home.h; };
    if (col.kind === 'column' && col.owner === me.id) {
      if (inside(ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === col.owner))) snapBack(col.id);
    } else if (col.kind === 'ticketcol') {
      if (inside(ed.byId.get(col.home) || ed.els.find((e) => e.type === 'widget' && e.kind === 'tickets'))) snapTicketCol(col.id);
    }
  }

  /* ---------------- widget actions ---------------- */
  function detach(pathId, colId, at) {
    const ed = editor();
    const pathEl = ed?.byId.get(pathId);
    if (!pathEl) return;
    const p = at ? ed.toWorld(at.clientX, at.clientY) : { x: pathEl.x + pathEl.w + 60 + 165, y: pathEl.y + 260 };
    const col = widgetEl('column', { owner: pathEl.owner, ownerName: pathEl.ownerName, colId });
    col.x = p.x - col.w / 2; col.y = p.y - 20;
    ed.setEls([...ed.els.map((e) => (e.id === pathId ? { ...e, detached: [...new Set([...(e.detached || []), colId])] } : e)), col]);
    ed.select([col.id]);
  }

  // Ticket board columns (Open / Working on it / Testing / Solved) come out the same way.
  function detachTicketCol(boardWidgetId, status, at) {
    const ed = editor();
    const home = ed?.byId.get(boardWidgetId);
    if (!home) return;
    const p = at ? ed.toWorld(at.clientX, at.clientY) : { x: home.x + home.w + 60 + 150, y: home.y + 260 };
    const col = widgetEl('ticketcol', { status, home: boardWidgetId });
    col.x = p.x - col.w / 2; col.y = p.y - 20;
    ed.setEls([...ed.els.map((e) => (e.id === boardWidgetId ? { ...e, detached: [...new Set([...(e.detached || []), status])] } : e)), col]);
    ed.select([col.id]);
  }

  function snapTicketCol(colWidgetId) {
    const ed = editor();
    const col = ed?.byId.get(colWidgetId);
    if (!col) return;
    ed.setEls(ed.els
      .filter((e) => e.id !== colWidgetId)
      .map((e) => (e.type === 'widget' && e.kind === 'tickets' && (e.id === col.home || (e.detached || []).includes(col.status)) ? { ...e, detached: (e.detached || []).filter((x) => x !== col.status) } : e)));
    toast('Snapped back into the Ticket board.', { ms: 1800 });
  }

  // Single tickets pulled out onto the canvas.
  const CARD = { w: 270, h: 168 }, OPEN = { w: 960, h: 600 };
  const poppedTickets = () => new Set((editor()?.els || []).filter((e) => e.type === 'widget' && e.kind === 'ticket').map((e) => e.ticketId));
  const ticketsMoved = () => window.dispatchEvent(new CustomEvent('architect:tickets-popped'));

  function popTicket(ticketId, at) {
    const ed = editor();
    if (!ed) return;
    const p = at ? ed.toWorld(at.clientX, at.clientY) : ed.viewCenter();
    const existing = ed.els.find((e) => e.type === 'widget' && e.kind === 'ticket' && e.ticketId === ticketId);
    if (existing) {
      ed.updateEls([existing.id], { x: p.x - existing.w / 2, y: p.y - 22 });
      ed.select([existing.id]);
      return;
    }
    const el = widgetEl('ticket', { ticketId, open: false });
    el.x = p.x - el.w / 2; el.y = p.y - 22;
    ed.addEls([el]);
    ticketsMoved();
  }

  function snapTicket(id) {
    const ed = editor();
    if (!ed?.byId.get(id)) return;
    ed.removeEls([id]);
    ticketsMoved();
  }

  // Expanding keeps the card's top-left corner where it is and grows the ticket out from it.
  function expandTicket(id, open) {
    const ed = editor();
    const el = ed?.byId.get(id);
    if (!el || !!el.open === !!open) return;
    const size = open ? OPEN : CARD;
    ed.updateEls([id], { open: !!open, w: size.w, h: size.h, cardW: open ? el.w : undefined, cardH: open ? el.h : undefined, ...(open ? {} : { w: el.cardW || CARD.w, h: el.cardH || CARD.h }) });
    ticketEsc.get(id)?.(); ticketEsc.delete(id);
    if (open) ticketEsc.set(id, onEscapeFull(() => { if (!editor()?.byId.get(id)?.open) return false; expandTicket(id, false); }));
    if (open) {
      const next = ed.byId.get(id);
      const r = ed.rect();
      const tl = ed.toScreen({ x: next.x, y: next.y }), br = ed.toScreen({ x: next.x + next.w, y: next.y + next.h });
      if (tl.x < r.left || tl.y < r.top || br.x > r.right || br.y > r.bottom || ed.cam.z < 0.6) {
        camBefore.set(id, { ...ed.cam });
        ed.fitRect(next, { maxZ: 1, pad: 40 });
      }
    } else if (camBefore.has(id)) {
      ed.setCamera(camBefore.get(id), { animate: true }); // back to where you were before it opened
      camBefore.delete(id);
    }
  }
  const camBefore = new Map();
  const ticketEsc = new Map(); // expanded ticket → its Ctrl+Esc handler

  function snapBack(colWidgetId) {
    const ed = editor();
    const col = ed?.byId.get(colWidgetId);
    if (!col) return;
    ed.setEls(ed.els
      .filter((e) => e.id !== colWidgetId)
      .map((e) => (e.type === 'widget' && e.kind === 'path' && e.owner === col.owner ? { ...e, detached: (e.detached || []).filter((x) => x !== col.colId) } : e)));
    toast('Snapped back into your Path.', { ms: 1800 });
  }

  /* ---------------- phones & tablets: a dock instead of hunting for long-press ---------------- */
  // The dock is yours to arrange: pick which buttons sit in it and in what order (saved to your account).
  const DOCK_DEFAULT = ['path', 'ideas', 'variables', 'blueprints', 'add'];
  const DOCK_MAX = 6;
  function dockCatalog(ed) {
    const small = () => innerWidth < 720;
    const widget = (kind, test = () => true) => ed.els.find((e) => e.type === 'widget' && e.kind === kind && !ed.isHidden(e) && test(e));
    const fly = (el) => { if (!el) return false; ed.select([el.id]); ed.fitRect(el, { maxZ: 1, pad: small() ? 8 : 40 }); return true; };
    const flyOrAdd = (kind, test) => () => { if (!fly(widget(kind, test))) addWidget(kind); };
    return {
      path: { icon: 'toPaths', label: 'Path', run: flyOrAdd('path', (e) => e.owner === me.id) },
      ideas: { icon: 'spark', label: 'Ideas', run: flyOrAdd('fleeting') },
      variables: { icon: 'users', label: 'Variables', run: flyOrAdd('variables') },
      blueprints: { icon: 'frame', label: 'Blueprints', run: flyOrAdd('blueprints') },
      chat: { icon: 'chat', label: 'Chat', run: flyOrAdd('chat') },
      radio: { icon: 'radio', label: 'Radio', run: flyOrAdd('radio') },
      voice: { icon: 'speaker', label: 'Voice', run: () => sayBar() },
      archives: { icon: 'folder', label: 'Archives', run: () => go('blueprint') },
      space: { icon: 'home', label: mode === 'personal' ? 'Shared' : 'Personal', run: () => toggleSpace() },
      fit: { icon: 'fit', label: 'Fit all', run: () => ed.zoomToFit() },
      views: { icon: 'target', label: 'Views', run: () => cameraDialog() },
      add: { icon: 'plus', label: 'Add', run: (b) => { const r = b.getBoundingClientRect(); const all = spaceItems(ed.viewCenter()); const from = all.findIndex((i) => i?.header === 'Add'); menu({ x: r.right, y: r.top - 8 }, all.slice(from, all.indexOf('-', from)), { side: 'top', align: 'end' }); } },
    };
  }
  const dockItems = (cat) => {
    const saved = getPref('dockItems', null);
    const list = (Array.isArray(saved) ? saved : DOCK_DEFAULT).filter((k) => cat[k]);
    return [...new Set(list)].slice(0, DOCK_MAX);
  };

  // View mode (phones): objects go untouchable so a finger only ever moves the canvas. Lives for the
  // session and follows you between the shared and personal Space.
  let viewMode = false;
  function setViewMode(on) {
    viewMode = !!on;
    for (const sl of Object.values(slots)) sl?.t?.editor?.setViewOnly?.(viewMode);
    page.classList.toggle('is-viewmode', viewMode);
    const b = page.querySelector('.sd-view');
    if (b) { b.classList.toggle('is-on', viewMode); b.setAttribute('aria-pressed', String(viewMode)); b.querySelector('span').textContent = viewMode ? 'Viewing' : 'View'; }
    navigator.vibrate?.(8);
    toast(viewMode ? 'View mode — look around, nothing moves.' : 'View mode off — the board is interactive again.', { ms: 1800 });
  }

  function mountDock() {
    page.querySelector('.space-dock')?.remove();
    const ed = editor();
    ed?.setViewOnly?.(viewMode);
    if (phone()) { unmountSidebar(); page.querySelector('.sb-reveal')?.remove(); mountPhone(ed); return; }
    mountSide(ed);
    paintSidebarReveal();
    const cat = dockCatalog(ed);
    let suppress = false; // a long-press opened the customizer: the release isn't a tap
    const item = (ic, label, fn, extra = {}) => h('button', { class: 'sd-btn', type: 'button', 'aria-label': label, onclick: (e) => { if (suppress) { suppress = false; return; } fn(e.currentTarget); }, ...extra }, icon(ic, 20), h('span', {}, label));
    const menuBtn = item('more', 'Menu', (b) => {
      const r = b.getBoundingClientRect();
      menu({ x: r.left, y: r.top - 8 }, [{ label: 'Customize navigation bar…', icon: 'settings', onSelect: customizeDock }, '-', ...spaceItems(ed.viewCenter())], { side: 'top' });
    });
    const viewBtn = item('eye', viewMode ? 'Viewing' : 'View', () => setViewMode(!viewMode), {
      class: ['sd-btn sd-view', viewMode && 'is-on'], 'aria-pressed': String(viewMode), 'aria-label': 'View mode: touch nothing, just move around',
    });
    const dock = h('nav', { class: 'space-dock', 'aria-label': 'Space' }, menuBtn, viewBtn,
      ...dockItems(cat).map((k) => item(cat[k].icon, cat[k].label, cat[k].run, { 'data-dock': k })));
    // Hold the bar to rearrange it.
    let hold = null;
    dock.addEventListener('pointerdown', (e) => { clearTimeout(hold); const sx = e.clientX, sy = e.clientY; hold = setTimeout(() => { hold = null; suppress = true; setTimeout(() => { suppress = false; }, 900); navigator.vibrate?.(12); customizeDock(); }, 650); dock._hold = { sx, sy }; });
    dock.addEventListener('pointermove', (e) => { if (hold && dock._hold && Math.hypot(e.clientX - dock._hold.sx, e.clientY - dock._hold.sy) > 8) { clearTimeout(hold); hold = null; } });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) dock.addEventListener(t, () => { clearTimeout(hold); hold = null; });
    dock.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(hold); hold = null; customizeDock(); });
    page.append(dock);
  }

  /* ================= Desktop sidebar (Nov 23) =================
     A rail on the left: ARCHITECT (this canvas), VARIABLES, PATH, MORE and your own views (space/sidebar.js).
     The canvas stays mounted underneath; a view covers it and borrows the board objects it shows. */
  let side = null;
  function mountSide(ed) {
    if (!ed) return;
    if (side) { side.rebind(ed); return; }
    side = mountSidebar({
      page, me,
      editor: () => editor(),
      host: () => slots[mode]?.host || null,
      mode: () => mode,
      toggleSpace: () => toggleSpace(),
      addWidget: (kind) => addWidget(kind, editor()?.viewCenter()),
      openSettings: (tab) => settings(tab),
      sharedSpaceId: () => ids.shared,
      openBlueprints: () => openBlueprintsCanvas({ openBoard: (id) => openBoard(id), host: page }),
      toggleSidebar: () => toggleSidebar(),
      signOut: () => api.auth.signOut(),
      changePassword: () => changePassword(),
    });
  }
  function unmountSidebar() { side?.destroy(); side = null; }
  // Nov 27 — hide / show the sidebar. Hidden, it collapses completely (the canvas takes the space) and a small
  // toggle stays in the corner; showing it again restores the view it was on.
  function paintSidebarReveal() {
    page.querySelector('.sb-reveal')?.remove();
    if (page) return; // Nov 28: the edge reveals the sidebar now
    const k = appKey('sidebar');
    page.append(h('button', { type: 'button', class: 'sb-reveal', title: `Show sidebar${k ? ` (${k})` : ''}`, 'aria-label': 'Show sidebar', onclick: () => toggleSidebar() }, sideIcon()));
  }
  function sideIcon() {
    const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('width', '20'); sv.setAttribute('height', '20');
    sv.setAttribute('fill', 'none'); sv.setAttribute('stroke', 'currentColor'); sv.setAttribute('stroke-width', '1.4');
    sv.setAttribute('stroke-linecap', 'round'); sv.setAttribute('stroke-linejoin', 'round'); sv.setAttribute('aria-hidden', 'true');
    sv.innerHTML = '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M9.5 5v14"/>';
    return sv;
  }
  async function toggleSidebar() {
    if (phone()) return;
    // Nov 28: the sidebar hides itself by default; this pins it open (or lets it auto-hide again).
    const on = getPref('sbPinned', false) === true;
    await setPref('sbPinned', !on).catch(() => {});
    side?.applyPin?.();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  offs.push(() => unmountSidebar());

  /* ================= Mobile (Nov 22) =================
     On a phone Architect is its own interface (space/mobile.js): full-screen views — Path, Fleeting
     Moments, Variables, Voice Chat, Radio, Blueprint — and a slider with a gold knob at the bottom. The
     board stays untouched behind it; "Open the board" in the menu shows it, a pill brings you back. */
  const phone = () => innerWidth < 720;
  let mob = null;
  let boardPill = null;
  function mountPhone(ed) {
    if (!ed) return;
    if (mob) { mob.rebind(ed); return; }
    mob = mountMobile({
      page, me,
      editor: () => editor(),
      host: () => slots[mode]?.host || null,
      mode: () => mode,
      toggleSpace: () => toggleSpace(),
      addWidget: (kind) => addWidget(kind, editor()?.viewCenter()),
      menuItems: phoneMenu,
      showBoard,
    });
  }
  function unmountPhone() {
    boardPill?.remove(); boardPill = null;
    mob?.destroy(); mob = null;
  }
  // Peek at the board itself, then come back with one tap.
  function showBoard() {
    if (!mob) return;
    mob.hide();
    boardPill?.remove();
    boardPill = h('button', { class: 'mob-back-pill', type: 'button', onclick: () => { boardPill?.remove(); boardPill = null; mob?.reveal(editor()); } }, icon('chevronLeft', 15), 'Back to views');
    page.append(boardPill);
    editor()?.zoomToFit(false);
  }
  function phoneMenu() {
    return [
      { header: mode === 'personal' ? 'Personal space' : 'Shared space' },
      { label: 'Invite…', icon: 'share', onSelect: async () => openSettings({ tab: 'members', spaceId: await idFor('shared') }) },
      { label: 'Settings…', icon: 'settings', onSelect: () => settings() },
      '-',
      { header: 'Theme' },
      ...themeItems(),
      '-',
      { label: 'Change password', icon: 'key', onSelect: changePassword },
      { label: 'Sign out', icon: 'logout', onSelect: () => api.auth.signOut() },
    ];
  }
  let wasPhone = phone();
  const onPhoneResize = () => {
    const p2 = phone();
    if (p2 === wasPhone) return;
    wasPhone = p2;
    if (!p2) unmountPhone();
    mountDock();
  };
  window.addEventListener('resize', onPhoneResize);

  // Choose and order the dock's buttons. Drag ⠿ to reorder; the switch puts a button in the bar.
  async function customizeDock() {
    closeFloating();
    const ed = editor();
    if (!ed) return;
    const cat = dockCatalog(ed);
    const on = new Set(dockItems(cat));
    let order = [...dockItems(cat), ...Object.keys(cat).filter((k) => !on.has(k))];
    const list = h('ol', { class: 'dockc-list' });
    const count = h('span', { class: 'dockc-count' });
    const paint = () => {
      count.textContent = `${on.size} / ${DOCK_MAX} IN THE BAR`;
      list.replaceChildren(...order.map((k) => {
        const grip = h('span', { class: 'dockc-grip', 'aria-label': 'Drag to reorder' }, icon('grip', 15));
        const sw = h('button', {
          type: 'button', role: 'switch', class: ['dockc-switch', on.has(k) && 'is-on'], 'aria-checked': String(on.has(k)), 'aria-label': `Show ${cat[k].label} in the bar`,
          onclick: () => {
            if (on.has(k)) on.delete(k);
            else if (on.size >= DOCK_MAX) { toast(`The bar holds ${DOCK_MAX} buttons — turn one off first.`, { ms: 2600 }); return; }
            else on.add(k);
            paint();
          },
        }, h('i'));
        const li = h('li', { class: ['dockc-item', on.has(k) && 'is-on'], 'data-k': k }, grip, h('span', { class: 'dockc-ic' }, icon(cat[k].icon, 17)), h('span', { class: 'dockc-label' }, cat[k].label), sw);
        grip.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          li.classList.add('is-drag');
          // Window listeners, not pointer capture: moving the row would drop the capture.
          const move = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            ev.preventDefault();
            const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.dockc-item');
            if (!over || over === li || over.parentNode !== list) return;
            const r = over.getBoundingClientRect();
            list.insertBefore(li, ev.clientY > r.top + r.height / 2 ? over.nextSibling : over);
          };
          const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
            li.classList.remove('is-drag');
            order = [...list.querySelectorAll('.dockc-item')].map((n) => n.dataset.k);
          };
          window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
        });
        return li;
      }));
    };
    paint();
    const ok = await dialog({
      title: 'Navigation bar',
      width: 420,
      className: 'dockc-dlg',
      body: h('div', { class: 'dockc' }, h('p', { class: 'dlg-text' }, 'Pick what sits in the bar and drag ⠿ to put it in the order you use. Menu always stays first.'), count, list),
      actions: [{ label: 'Reset', value: 'reset' }, { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: 'save' }],
    });
    if (!ok) return;
    const next = ok === 'reset' ? DOCK_DEFAULT : order.filter((k) => on.has(k));
    await setPref('dockItems', next).catch(() => {});
    mountDock();
    toast(ok === 'reset' ? 'Navigation bar reset.' : 'Navigation bar saved.', { ms: 1800 });
  }

  function focusKind(kind) {
    const ed = editor();
    if (!ed) return;
    const el = ed.els.find((e) => e.type === 'widget' && e.kind === kind && !ed.isHidden(e) && (kind !== 'path' || e.owner === me.id));
    if (el) { ed.select([el.id]); ed.fitRect(el, FILL.has(kind) ? { maxZ: 2.5, pad: innerWidth < 720 ? 6 : 24 } : { maxZ: 1, pad: innerWidth < 720 ? 8 : 40 }); }
  }

  /* ---------------- Blueprints: a window over the Space, or full screen ---------------- */
  let bpWin = null;
  function openBoard(boardId, { window: asWindow } = {}) {
    if (!boardId) return;
    if (innerWidth < 720) { go(`board/${boardId}`); return; } // a phone opens blueprints full screen
    const useWindow = asWindow ?? getPref('bpCompact', true) !== false;
    if (!useWindow) { go(`board/${boardId}`); return; }
    if (bpWin?.boardId === boardId) return;
    bpWin?.close();
    bpWin = openBoardWindow(page, boardId, {
      onClose: () => { bpWin = null; },
      onExpand: () => { bpWin = null; go(`board/${boardId}`); },
    });
  }

  function reveal(id) {
    const ed = editor();
    const el = ed?.byId.get(id);
    if (!el) return;
    const r = ed.rect();
    const s = ed.toScreen({ x: el.x, y: el.y });
    const e2 = ed.toScreen({ x: el.x + el.w, y: el.y + el.h });
    const visible = s.x >= r.left - 20 && s.y >= r.top - 20 && e2.x <= r.right + 20 && e2.y <= r.bottom + 20 && ed.cam.z > 0.45;
    if (!visible) ed.fitRect(el, { maxZ: 1, pad: 60 });
  }

  function addPortal(b, nearId) {
    const ed = editor();
    if (!ed) return;
    const near = ed.byId.get(nearId);
    const el = widgetEl('portal', { boardId: b.id, name: b.name, preview: b.preview || [] });
    const p = near ? { x: near.x + near.w + 40, y: near.y } : ed.viewCenter();
    el.x = p.x; el.y = p.y;
    ed.addEls([el]);
  }

  function openMenuFor(id, anchor) {
    const ed = editor();
    if (!ed) return;
    if (!ed.sel.has(id)) ed.select([id]);
    const r = anchor.getBoundingClientRect();
    ed.emit('contextmenu', { x: r.left, y: r.bottom + 4, onElement: true, at: ed.toWorld(r.left, r.bottom) });
  }

  function addWidget(kind, at) {
    const ed = editor();
    if (!ed) return;
    if (kind === 'path' && ed.els.some((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id)) {
      const mine = ed.els.find((e) => e.type === 'widget' && e.kind === 'path' && e.owner === me.id);
      ed.select([mine.id]); ed.fitRect(mine, { maxZ: 1 });
      toast('Your Path is already on the canvas.');
      return;
    }
    const extra = kind === 'path' ? { owner: me.id, ownerName: me.username, detached: [] }
      : kind === 'fleeting' ? fleetingData()
      : kind === 'variables' ? defaultVariables()
        : kind === 'custom' ? { title: 'Widget', html: '<h3 style="margin:0 0 6px;font-family:Space Mono,monospace">Hello</h3>\n<p>Edit me from the widget’s ✎ button.</p>' } : {};
    const el = widgetEl(kind, extra);
    const p = at || ed.viewCenter();
    el.x = p.x - el.w / 2; el.y = p.y - el.h / 2;
    ed.addEls([el]);
    if (kind === 'custom') editCustom({ current: () => ed.byId.get(el.id) || el, patch: (x) => ed.updateEls([el.id], x) });
    if (kind === 'radio') askSource().then((src) => {
      // A Spotify playlist plays for you alone (Personal or Shared list, Nov 24) — not as the live stream.
      if (src?.ext?.provider === 'Spotify') { setTimeout(() => window.dispatchEvent(new CustomEvent('architect:radio-spotify', { detail: { id: el.id, url: src.url } })), 120); return; }
      if (src && ed.byId.get(el.id)) ed.updateEls([el.id], { src: src.url, list: src.list, vid0: src.vid, mode: 'stream', st: { by: me.id, name: me.username, index: 0, vid: src.vid, t: 0, playing: false, at: Date.now() } });
    });
    return el;
  }

  /* ---------------- chats connected to objects ---------------- */
  function chatAbout(target) {
    const ed = editor();
    if (!ed || !target) return;
    const existing = ed.els.find((e) => e.type === 'widget' && e.kind === 'chat' && e.about === target.id && !ed.isHidden(e));
    if (existing) { ed.select([existing.id]); reveal(existing.id); return; }
    const rc = rectOf(target, ed.byId);
    const chat = widgetEl('chat', { about: target.id, messages: [] });
    chat.x = rc.x + rc.w + 80; chat.y = rc.y;
    ed.setEls([...ed.els, chat, connect(chat, target)]);
    ed.select([chat.id]);
    reveal(chat.id);
  }
  function connect(chat, target) {
    const rc = rectOf(target, editor().byId);
    return { ...editor().connectorFrom(chat, { id: target.id, x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 }), route: 'curve', dash: 'dotted', startCap: 'none', endCap: 'dot', chatLink: true };
  }
  function attachChat(chat, target) {
    const ed = editor();
    const keep = ed.els.filter((e) => !(e.type === 'line' && e.chatLink && e.a?.id === chat.id));
    ed.setEls([...keep.map((e) => (e.id === chat.id ? { ...e, about: target.id } : e)), connect({ ...chat, about: target.id }, target)]);
    toast(`Chat connected to “${labelOf(target)}”.`, { ms: 2200 });
  }

  /* ---------------- Voice chat: Enter to talk from any view (Nov 24) ----------------
     A small composer over whatever's on screen (the canvas or a sidebar view): typed messages are read out
     loud, the mic sends your voice. An open Variables chat is the destination when there is one. */
  function sayBar() {
    openSayComposer({
      host: page,
      voiceChat: () => {
        const ed = editor();
        const ctl = [...ttsCtl.entries()].find(([id]) => ed?.byId.get(id) && !ed.isHidden(ed.byId.get(id)))?.[1];
        if (ctl) return ctl;
        if (!ed) return null;
        const el = addWidget('tts', ed.viewCenter());
        toast('Voice chat added to the Space.', { ms: 2200 });
        return { send: (t, files) => setTimeout(() => ttsCtl.get(el.id)?.send(t, files), 80) };
      },
    });
  }

  /* ---------------- menus ---------------- */
  // Right-click on an object adds privacy, shortcuts and Blueprint conversion; on empty space, the Space menu.
  function extendMenu(items, { onElement, world, sel }) {
    if (!onElement) {
      return [items[0], '-', ...spaceItems(world)]; // Paste here, then the Space menu
    }
    const extra = [];
    const mineOrPublic = mode === 'shared' && sel.every((e) => !e.privateTo || e.privateTo === me.id);
    if (mineOrPublic) {
      const allPrivate = sel.every((e) => e.privateTo === me.id);
      extra.push({ label: allPrivate ? 'Show to others' : 'Hide from others', icon: allPrivate ? 'eye' : 'eyeOff', onSelect: () => setPrivate(sel, !allPrivate) });
    }
    if (sel.length === 1) {
      const el = sel[0];
      const key = (getPref('objectKeys', {}) || {})[el.id];
      extra.push({ label: key ? `Shortcut: ${key}` : 'Assign shortcut…', icon: 'keyboard', onSelect: () => assignObjectKey(el) });
      if (el.type === 'widget' && el.kind === 'path' && el.owner === me.id && pathCtl.get(el.id)) extra.push({ label: 'New path…', icon: 'plus', onSelect: () => pathCtl.get(el.id)?.addColumn() });
      if (el.type === 'widget' && el.kind === 'ticket') {
        extra.push({ label: el.open ? 'Collapse to card' : 'Open ticket', icon: el.open ? 'collapse' : 'external', onSelect: () => expandTicket(el.id, !el.open) });
        extra.push({ label: 'Put back on the Ticket board', icon: 'ticket', onSelect: () => snapTicket(el.id) });
      }
      if (el.type === 'widget' && el.kind === 'ticketcol') extra.push({ label: 'Snap back into Ticket board', icon: 'collapse', onSelect: () => snapTicketCol(el.id) });
      if (el.type === 'widget' && el.kind === 'column' && el.owner === me.id) extra.push({ label: 'Snap back into Path', icon: 'collapse', onSelect: () => snapBack(el.id) });
      if (el.type === 'widget' && el.kind === 'portal') {
        extra.push({ label: 'Open as a window', icon: 'layers', onSelect: () => openBoard(el.boardId, { window: true }) });
        extra.push({ label: 'Open full screen', icon: 'expand', onSelect: () => openBoard(el.boardId, { window: false }) });
      }
      if (el.type === 'widget' && el.kind === 'custom') extra.push({ label: 'Edit widget…', icon: 'code', onSelect: () => editCustom({ current: () => editor().byId.get(el.id) || el, patch: (x) => editor().updateEls([el.id], x) }) });
    }
    const chats = sel.filter((e) => e.type === 'widget' && e.kind === 'chat');
    const others = sel.filter((e) => e.type !== 'line' && !(e.type === 'widget' && (e.kind === 'chat' || e.kind === 'tts')));
    if (chats.length === 1 && others.length === 1) extra.push({ label: 'Connect chat to this', icon: 'link', onSelect: () => attachChat(chats[0], others[0]) });
    else if (sel.length === 1 && others.length === 1) extra.push({ label: 'Chat about this', icon: 'chat', onSelect: () => chatAbout(others[0]) });
    if (sel.length === 1 && sel[0].type === 'widget' && sel[0].kind === 'chat' && sel[0].about) extra.push({ label: 'Disconnect chat', icon: 'close', onSelect: () => {
      const c = sel[0];
      editor().setEls(editor().els.filter((e) => !(e.type === 'line' && e.chatLink && e.a?.id === c.id)).map((e) => (e.id === c.id ? { ...e, about: null } : e)));
    } });
    const convertible = sel.filter((e) => e.type !== 'widget');
    if (convertible.length) extra.push({ label: 'Convert to Blueprint…', icon: 'frame', onSelect: () => toBlueprint(convertible) });
    const at = items.findIndex((x) => x === '-');
    return [...items.slice(0, at), '-', ...extra, ...items.slice(at)];
  }

  /* ---------------- Blueprint shortcuts: one press in the menu opens the board ---------------- */
  // Kept warm in the background so the (synchronous) menu can list them instantly, from either space.
  let bpShortcuts = [];
  async function loadShortcuts() {
    try {
      const rows = await api.db.select('blueprints', { columns: 'id,name,kind,pinned,updated_at', order: 'updated_at.desc' })
        .catch(() => api.db.select('blueprints', { columns: 'id,name,pinned,updated_at', order: 'updated_at.desc' }));
      bpShortcuts = rows
        .filter((b) => !['space', 'personal', 'er', 'er-chat'].includes(b.kind))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
        .slice(0, 12);
    } catch { /* offline — keep the last list */ }
  }
  loadShortcuts();
  window.addEventListener('architect:blueprints-changed', loadShortcuts);
  const bpPoll = setInterval(() => { if (!document.hidden) loadShortcuts(); }, 90_000);
  offs.push(() => { window.removeEventListener('architect:blueprints-changed', loadShortcuts); clearInterval(bpPoll); });
  function shortcutItems() {
    if (!bpShortcuts.length) return [];
    return [
      { header: 'Blueprints' },
      ...bpShortcuts.map((b) => ({ label: b.name || 'Untitled', icon: b.pinned ? 'pin' : 'frame', onSelect: () => openBoard(b.id) })),
      '-',
    ];
  }

  function spaceItems(world) {
    const ed = editor();
    const at = world || ed?.viewCenter();
    const tool = (name, opt) => () => { if (opt) ed.setOpt(...opt); ed.setTool(name); toast('Drag on the canvas', { ms: 1200 }); };
    // Nov 23b: a shorter menu that fits on a desktop screen — no "Add" heading (and no fold), one Border
    // tool, the standalone objects under Widget…, no "Move around" section; Theme, Performance test and
    // Keyboard shortcuts live in Settings.
    // Nov 27: Paste here (added by the board) stays on top, then the creation tools, then your Blueprints,
    // then Settings… alone. Switching to your personal space lives on the sidebar (and its shortcut); Invite
    // is in the top bar's More menu; the toolbar and sidebar have their own toggles.
    const bps = shortcutItems().filter((x) => x !== '-');
    return [
      { label: 'Sticky note', icon: 'sticky', kbd: 'N', onSelect: () => ed.addEls([ed.makeEl('sticky', null, at)], { edit: true }) },
      { label: 'Text', icon: 'text', kbd: 'T', onSelect: () => ed.addEls([ed.makeEl('text', null, at)], { edit: true }) },
      { label: 'Shape', icon: 'rect', kbd: 'S', onSelect: tool('shape') },
      { label: 'Connector', icon: 'arrow', kbd: 'L', onSelect: tool('line') },
      { label: 'Draw', icon: 'pen', kbd: 'P', onSelect: tool('pen') },
      { label: 'Border', icon: 'borderBox', kbd: 'B', onSelect: tool('border', ['border', 'box']) },
      { label: 'Frame', icon: 'frame', kbd: 'F', onSelect: tool('frame') },
      { label: 'Image or video', icon: 'image', kbd: 'U', onSelect: () => t.pickFiles() },
      { label: 'Video or link', icon: 'video', kbd: 'K', onSelect: () => t.openEmbed() },
      { label: 'Widget…', icon: 'widget', onSelect: () => widgetPicker(at) },
      ...(bps.length ? ['-', ...bps] : []),
      '-',
      { label: 'Settings…', icon: 'settings', onSelect: () => settings() },
    ];
  }

  async function widgetPicker(at) {
    const ed = editor();
    const choose = (kind) => addWidget(kind, at);
    const opts = ['path', 'fleeting', 'variables', 'timer', 'blueprints', 'chat', 'tts', 'radio', 'custom'];
    // A pick closes the dialog (through its Cancel button, so focus and the promise settle as usual).
    const row = (ic, label, hint, fn, kbd) => h('button', { type: 'button', class: 'wpick-row', onclick: (e) => { e.currentTarget.closest('.dlg')?.querySelector('.dlg-actions button')?.click(); fn(); } },
      h('span', { class: 'wpick-ic' }, icon(ic, 18)),
      h('span', { class: 'wpick-text' }, h('b', {}, label), hint ? h('small', {}, hint) : null),
      kbd ? h('kbd', { class: 'wpick-kbd' }, kbd) : null);
    // Nov 23b: the standalone objects that used to crowd the right-click menu live here.
    const extra = [
      row('toPaths', 'Path task…', 'One of your tasks, live on the board', () => setTimeout(() => pickTask(ed, at, { dialog, toast, myTasks }), 180)),
      row('speaker', 'Say something out loud', 'Everyone in the Space hears it', () => setTimeout(sayBar, 180), 'Enter'),
      row('flame', 'Emergency Room', 'One problem, one room', () => setTimeout(openER, 180), 'E+R'),
    ];
    dialog({
      title: 'Add a widget',
      width: 460,
      body: h('div', { class: 'wpick' }, opts.map((k) => row(WIDGETS[k].icon, WIDGETS[k].label, WIDGETS[k].hint, () => choose(k))), h('div', { class: 'wpick-sep', role: 'separator' }), ...extra),
      actions: [{ label: 'Cancel', value: null }],
    });
  }

  /* ---------------- Settings (Nov 23b) ----------------
     One place for what left the right-click menu: Theme, Performance test, Keyboard shortcuts, camera
     points — plus the personal Space background and the Anytype integration. */
  function setChrome(on) {
    for (const sl of Object.values(slots)) sl?.t?.page.classList.toggle('show-chrome', !!on);
    setPref('spaceChrome', !!on).catch(() => {});
  }
  async function settings(tab) {
    openSettings({
      tab, spaceId: await idFor('shared'),
      actions: {
        shortcuts: () => t?.showShortcuts(),
        bench: () => startBench({ api, uid, go }).catch((e) => toast(friendlyError(e), { tone: 'error' })),
        saveView: () => saveCameraPoint(),
        cameraPoints: () => cameraDialog(),
        snap: () => editor()?.prefs.guides !== false,
        setSnap: (on) => editor()?.setPref('guides', !!on),
        toolbar: () => !!getPref('spaceChrome', false),
        setToolbar: (on) => setChrome(on),
        personalBg: () => applyPersonalBg(),
      },
    });
  }

  /* ---------------- Space backgrounds (Nov 24) ----------------
     Each Space has its own background, chosen in Settings → Personalize — a built-in pattern or your own
     PNG (Fill / Tile). It's your preference only: in the shared Space, everyone keeps their own. Patterns
     and tiles follow the canvas as it pans and zooms. */
  const bgCam = new Map(); // space → camera unsubscribe
  function applyPersonalBg() { applyBg('personal'); applyBg('shared'); }
  async function applyBg(m) {
    const tools = slots[m]?.t;
    const page2 = tools?.page;
    if (!page2) return;
    page2.classList.remove('has-personal-bg');
    const bg = bgOf(m);
    const ed = tools.editor;
    await paintBg(page2, bg, ed?.cam);
    bgCam.get(m)?.();
    bgCam.delete(m);
    const follows = bg.kind === 'pattern' && bg.pattern !== 'plain' || bg.kind === 'image' && bg.layout === 'tile';
    if (follows && ed?.on) {
      let raf = 0;
      bgCam.set(m, ed.on('camera', (c) => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; moveBg(page2, c || ed.cam); }); }));
    }
  }
  const onBgChange = () => applyPersonalBg();
  window.addEventListener('architect:space-bg', onBgChange);
  offs.push(() => { window.removeEventListener('architect:space-bg', onBgChange); bgCam.forEach((f) => { try { f(); } catch {} }); bgCam.clear(); });

  /* ---------------- privacy ---------------- */
  function setPrivate(sel, on) {
    const ids = sel.map((e) => e.id);
    editor().updateEls(ids, { privateTo: on ? me.id : null });
    toast(on ? 'Hidden from everyone else in the Space.' : 'Visible to the Space again.', { ms: 2200 });
  }

  /* ---------------- camera points + object shortcuts ---------------- */
  const points = () => getPref('cameraPoints', []) || [];
  const objKeys = () => getPref('objectKeys', {}) || {};

  function viewNow() {
    const ed = editor();
    const c = ed.viewCenter();
    return { cx: Math.round(c.x), cy: Math.round(c.y), z: +ed.cam.z.toFixed(3) };
  }
  function goTo(p) {
    const ed = editor();
    const r = ed.rect();
    ed.setCamera({ x: r.width / 2 - p.cx * p.z, y: r.height / 2 - p.cy * p.z, z: p.z }, { animate: true });
  }
  async function saveCameraPoint() {
    const used = new Set(points().map((p) => p.key));
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Alt+${n}`).find((k) => !used.has(k)) || null;
    const name = await promptDialog('Save this view', { value: `View ${points().length + 1}`, ok: 'Save', label: 'Name' });
    if (!name) return;
    await setPref('cameraPoints', [...points(), { id: uid(), name, key: free, ...viewNow() }]);
    toast(free ? `Saved — press ${free} to come back.` : 'Saved.', { ms: 2600 });
  }

  function cameraDialog() {
    const body = h('div', { class: 'cam-list' });
    const paint = () => {
      const list = points();
      body.replaceChildren(
        ...(list.length ? list.map((p) => h('div', { class: 'cam-row' },
          h('button', { type: 'button', class: 'cam-go', onclick: () => { goTo(p); } }, icon('target', 15), h('span', {}, p.name)),
          keyButton(p.key, async (key) => { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, key } : key && x.key === key ? { ...x, key: null } : x))); paint(); }),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Update to this view', 'aria-label': 'Update to this view', onclick: async () => { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, ...viewNow() } : x))); toast('Updated.'); } }, icon('fit', 14)),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Rename', 'aria-label': 'Rename', onclick: async () => { const n = await promptDialog('Rename view', { value: p.name, ok: 'Save' }); if (n) { await setPref('cameraPoints', points().map((x) => (x.id === p.id ? { ...x, name: n } : x))); paint(); } } }, icon('edit', 14)),
          h('button', { type: 'button', class: 'icon-btn xs', title: 'Delete', 'aria-label': 'Delete', onclick: async () => { await setPref('cameraPoints', points().filter((x) => x.id !== p.id)); paint(); } }, icon('trash', 14))))
          : [h('p', { class: 'dlg-text' }, 'No camera points yet. Save a view to jump back to it with a key.')]),
        h('button', { type: 'button', class: 'btn sm cam-add', onclick: async () => { await saveCameraPoint(); paint(); } }, icon('plus', 14), 'Save current view'));
    };
    paint();
    dialog({ title: 'Camera points', width: 520, body, actions: [{ label: 'Done', primary: true, value: true }] });
  }

  // A button that records the next key combo you press.
  function keyButton(current, onSet) {
    const b = h('button', { type: 'button', class: ['kbd-rec', !current && 'is-empty'], title: 'Click, then press a key combo · Backspace clears' }, current || 'Set key');
    b.addEventListener('click', () => {
      b.textContent = 'Press keys…';
      b.classList.add('is-rec');
      const onKey = (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        b.classList.remove('is-rec');
        if (e.key === 'Escape') { b.textContent = current || 'Set key'; return; }
        const key = e.key === 'Backspace' || e.key === 'Delete' ? null : comboOf(e);
        if (key && !e.altKey && !e.ctrlKey && !e.metaKey && /^[A-Z0-9]$/.test(key.replace(/^Shift\+/, ''))) toast('Tip: plain letters also drive canvas tools — Alt+key is safer.', { ms: 3200 });
        b.textContent = key || 'Set key';
        b.classList.toggle('is-empty', !key);
        onSet(key);
      };
      window.addEventListener('keydown', onKey, true);
    });
    return b;
  }

  async function assignObjectKey(el) {
    const keys = objKeys();
    let chosen = keys[el.id] || null;
    const ok = await dialog({
      title: 'Object shortcut',
      width: 420,
      body: h('div', { class: 'stack' },
        h('p', { class: 'dlg-text' }, el.type === 'widget' && el.kind === 'portal' ? 'Press it anywhere in the Space to open this blueprint.' : 'Press it anywhere in the Space to fly to this object.'),
        keyButton(chosen, (k) => { chosen = k; })),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }],
    });
    if (!ok) return;
    const next = { ...objKeys() };
    for (const [id, k] of Object.entries(next)) if (k === chosen) delete next[id];
    if (chosen) next[el.id] = chosen; else delete next[el.id];
    const kinds = { ...keyKinds() };
    for (const id of Object.keys(kinds)) if (!next[id]) delete kinds[id];
    if (chosen) kinds[el.id] = kindOf(el);
    await setPref('objectKeys', next);
    setPref('objectKeyKinds', kinds).catch(() => {});
    if (chosen) toast(`${chosen} now opens it — in whichever space you’re in.`);
  }

  // Universal shortcuts: the same key does the same jump in every space. A key belongs to a kind of
  // object (Path, Variables, Fleeting Ideas, Timer…); pressing it jumps to that object in the space
  // you're standing in. It never switches spaces.
  const keyKinds = () => getPref('objectKeyKinds', {}) || {};
  const kindOf = (el) => (el.type === 'widget' ? `widget:${el.kind}` : el.type === 'frame' && el.title ? `frame:${el.title}` : `el:${el.id}`);
  const FILL = new Set(['fleeting', 'timer']); // objects that open big: they fill the screen
  function focusObject(ed, id) {
    const el = ed?.byId.get(id);
    if (!el || ed.isHidden(el)) return false;
    if (el.type === 'widget' && el.kind === 'portal') { openBoard(el.boardId); return true; }
    ed.select([id]);
    const big = el.type === 'widget' && FILL.has(el.kind);
    const cam = big ? fitCam(ed, rectOf(el, ed.byId), { pad: innerWidth < 720 ? 6 : 24, maxZ: 2.5, floor: 0 }) : readableCam(ed, el);
    ed.setCamera(cam, { animate: true });
    spotlight(ed, el, cam);
    return true;
  }

  /* ---- Shortcut with a spotlight (Nov 22) ----
     The zoom comes from the object itself: big enough to read, not just to fit. A small tile arrives large;
     a big section settles at its own scale (never shrunk past readable) and lines up from its top edge. */
  function fitCam(ed, rc, { pad = 60, maxZ = 1, floor = 0 } = {}) {
    const r = ed.rect();
    const w = Math.max(rc.w, 1), hh = Math.max(rc.h, 1);
    const fit = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / hh);
    const z = Math.max(floor, Math.min(fit, maxZ));
    const cx = rc.x + w / 2;
    // Taller than the screen at this zoom: start at its top instead of its middle.
    const cy = hh * z > r.height - pad * 2 ? rc.y + (r.height / 2 - pad) / z : rc.y + hh / 2;
    return { x: r.width / 2 - cx * z, y: r.height / 2 - cy * z, z };
  }
  function readableCam(ed, el) {
    const rc = boxOf(el, ed);
    const small = innerWidth < 720;
    const pad = small ? 14 : 72;
    // Notes and tiles: up to 2.6× so their text is comfortable. Widgets read at 1:1 or a little more.
    const maxZ = el.type === 'widget' ? 1.25 : el.type === 'frame' ? 1.6 : 2.6;
    // Readable floor: never zoom a section out past this just to cram it in.
    const floor = el.type === 'widget' ? (small ? 0.55 : 0.8) : el.type === 'frame' ? 0.45 : 0.7;
    return fitCam(ed, rc, { pad, maxZ, floor });
  }
  // The space a (possibly tilted) object really covers.
  function boxOf(el, ed) {
    const rc = rectOf(el, ed.byId);
    const a = (Number(el.rot) || 0) * Math.PI / 180;
    if (!a) return rc;
    const c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    const w = rc.w * c + rc.h * sn, hh = rc.w * sn + rc.h * c;
    return { x: rc.x + rc.w / 2 - w / 2, y: rc.y + rc.h / 2 - hh / 2, w, h: hh };
  }

  // Everything outside the target falls into shadow. The shade follows the object while the camera flies
  // in, then lifts the moment you pan or zoom away (or press Escape, or jump somewhere else).
  let spotOff = null;
  function spotlight(ed, el, target) {
    spotOff?.();
    const vp = ed.vp;
    const node = vp.querySelector(`[data-eid="${CSS.escape(el.id)}"]`);
    if (!node) return;
    const shade = h('div', { class: 'spot-shade', 'aria-hidden': 'true' }, h('i', { class: 'spot-hole' }));
    const hole = shade.firstChild;
    vp.append(shade);
    const radius = el.type === 'widget' ? 18 : 6;
    const place = () => {
      const vr = vp.getBoundingClientRect(), nr = node.getBoundingClientRect();
      const m = 10;
      Object.assign(hole.style, { left: `${nr.left - vr.left - m}px`, top: `${nr.top - vr.top - m}px`, width: `${nr.width + m * 2}px`, height: `${nr.height + m * 2}px`, borderRadius: `${radius + m}px` });
    };
    place();
    requestAnimationFrame(() => shade.classList.add('in'));
    const settleAt = performance.now() + 520;
    const near = (c) => Math.abs(c.x - target.x) < 2 && Math.abs(c.y - target.y) < 2 && Math.abs(c.z / target.z - 1) < 0.004;
    let gone = false;
    let offChange = null;
    const lift = () => {
      if (gone) return;
      gone = true;
      offCam(); offChange?.(); window.removeEventListener('keydown', onKey, true);
      shade.classList.remove('in'); shade.classList.add('out');
      setTimeout(() => shade.remove(), 320);
      if (spotOff === lift) spotOff = null;
    };
    const offCam = ed.on('camera', (c) => {
      if (!node.isConnected) { lift(); return; }
      if (performance.now() > settleAt && !near(c)) { lift(); return; }
      place();
    });
    const onKey = (e) => { if (e.key === 'Escape') lift(); };
    window.addEventListener('keydown', onKey, true);
    // The object itself can move (a teammate drags it): keep the hole on it.
    offChange = ed.on('change', () => { if (!gone) { if (!ed.byId.get(el.id)) lift(); else requestAnimationFrame(place); } });
    spotOff = lift;
  }
  // The object in this space that answers to a key: the same object if it's here, else its counterpart.
  function counterpart(ed, id) {
    if (!ed) return null;
    const same = ed.byId.get(id);
    if (same && !ed.isHidden(same)) return same.id;
    let kind = keyKinds()[id];
    if (!kind) { // keys saved before kinds were recorded: learn the kind from whichever space holds it
      for (const s of Object.values(slots)) {
        const e = s?.t?.editor?.byId.get(id);
        if (e) { kind = kindOf(e); setPref('objectKeyKinds', { ...keyKinds(), [id]: kind }).catch(() => {}); break; }
      }
    }
    if (!kind || kind.startsWith('el:')) return null;
    const [t, k] = kind.split(/:(.*)/s);
    const list = ed.els.filter((e) => !ed.isHidden(e) && (t === 'widget' ? e.type === 'widget' && e.kind === k : e.type === 'frame' && e.title === k));
    // Your own Path first; otherwise the first one on the canvas.
    return (list.find((e) => e.owner === me.id) || list[0])?.id || null;
  }
  // Nov 22: no more "That shortcut's object isn't in this space." pills. A shortcut that works opens; one
  // whose object can't be reached in either space is cleared out quietly (from Personal and Shared alike).
  function openObject(id) {
    const target = counterpart(editor(), id);
    if (target && focusObject(editor(), target)) return true;
    if (deadKey(id)) dropKeys([id]);
    return false;
  }
  // Dead = no counterpart in any space that's loaded, and both spaces have been looked at.
  function deadKey(id) {
    if (!slots.shared?.t || !slots.personal?.t) {
      // Only one space is loaded: an object-only key (not a kind) that isn't here can't be anywhere else
      // either if it was never recorded in the other space — keep it until both are known.
      return false;
    }
    return !Object.values(slots).some((sl) => counterpart(sl?.t?.editor, id));
  }
  function dropKeys(list) {
    if (!list.length) return;
    const keys = { ...objKeys() }, kinds = { ...keyKinds() };
    for (const id of list) { delete keys[id]; delete kinds[id]; }
    setPref('objectKeys', keys).catch(() => {});
    setPref('objectKeyKinds', kinds).catch(() => {});
  }
  // Sweep once both spaces are up (the shared one warms in the background).
  function sweepDeadKeys() {
    if (!slots.shared?.t || !slots.personal?.t) return;
    dropKeys(Object.keys(objKeys()).filter(deadKey));
  }

  /* ---------------- Emergency Room (E + R) ---------------- */
  let er = null;
  const erCombo = comboWatcher();
  function openER() {
    if (er?.open || !editor()) return;
    closeFloating();
    bpWin?.close(); bpWin = null;
    page.querySelector('.say-bar, .say-pop')?.remove();
    er = openEmergencyRoom(page, { me, spaceId: () => ids.shared || (mode === 'shared' ? spaceId : null), onClose: () => { er = null; } });
  }
  offs.push(() => { er?.close(); erCombo.off(); });

  // One task, two views (Nov 23): "Put on the board" from a Path task adds its live card beside your Path;
  // the card's ↗ flies back to the task in your Path.
  const onTaskToBoard = (e) => {
    const ed = editor();
    const id = e.detail?.id;
    if (!ed || !id) return;
    const have = ed.els.find((x) => x.type === 'task' && String(x.taskId) === String(id));
    if (have) { ed.select([have.id]); ed.fitRect(rectOf(have, ed.byId), { maxZ: 1, pad: 160 }); toast('That task is already on the board.', { ms: 1800 }); return; }
    const path = ed.els.find((x) => x.type === 'widget' && x.kind === 'path' && x.owner === me.id);
    const n = ed.els.filter((x) => x.type === 'task').length;
    const at = path ? { x: path.x + path.w + 200, y: path.y + 80 + (n % 6) * 130 } : ed.viewCenter();
    const el = taskEl(id, at);
    ed.addEls([el]);
    ed.fitRect(rectOf(el, ed.byId), { maxZ: 1, pad: 200 });
  };
  const onShowTask = (e) => {
    focusKind('path');
    const id = e.detail?.id;
    setTimeout(() => {
      const n = page.querySelector(`[data-task="${CSS.escape(String(id))}"]`);
      if (!n) { toast('That task isn’t on today’s Path — it may be planned for another day.', { ms: 2600 }); return; }
      n.scrollIntoView({ block: 'center', behavior: 'smooth' });
      n.classList.add('is-flash'); setTimeout(() => n.classList.remove('is-flash'), 1600);
    }, 500);
  };
  window.addEventListener('architect:task-to-board', onTaskToBoard);
  window.addEventListener('architect:show-task', onShowTask);
  offs.push(() => { window.removeEventListener('architect:task-to-board', onTaskToBoard); window.removeEventListener('architect:show-task', onShowTask); });

  const onPointer = (e) => { lastPointer = { x: e.clientX, y: e.clientY }; };
  window.addEventListener('pointermove', onPointer, { passive: true });
  offs.push(() => window.removeEventListener('pointermove', onPointer));

  const onKeyDown = (e) => {
    // Toggle Sidebar works from every view, not only the canvas (but never while typing or in a dialog).
    if (!isTypingTarget(e.target) && !document.querySelector('.dlg') && actionFor(comboKey(e)) === 'sidebar') { e.preventDefault(); e.stopPropagation(); toggleSidebar(); return; }
    const ed = editor();
    if (!ed || getSurface() || isTypingTarget(e.target) || document.querySelector('.dlg') || ed.editingId) return;
    if (e.target instanceof Element && e.target.closest('.wg-body')) return;
    // Nov 27: Personal Space and Toggle Sidebar use the keys chosen in Settings → Shortcuts (Tab is only the default).
    const act = actionFor(comboKey(e));
    if (act === 'personal') { e.preventDefault(); e.stopPropagation(); toggleSpace(); return; }
    // E then R (or both together): walk into the Emergency Room.
    if (erCombo.test(e)) { e.preventDefault(); e.stopPropagation(); openER(); return; }
    const combo = comboOf(e);
    const p = points().find((x) => x.key && x.key === combo);
    if (p) { e.preventDefault(); e.stopPropagation(); goTo(p); return; }
    const obj = Object.entries(objKeys()).find(([, k]) => k === combo);
    if (obj && openObject(obj[0])) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const at = lastPointer || { x: innerWidth / 2, y: innerHeight / 2 };
      menu({ x: at.x, y: at.y }, spaceItems(ed.toWorld(at.x, at.y)));
    }
  };
  window.addEventListener('keydown', onKeyDown, true);
  offs.push(() => window.removeEventListener('keydown', onKeyDown, true));
  // Enter to talk — on the canvas and in every sidebar view (a Blueprint keeps Enter for editing text).
  const onEnter = (e) => {
    if (!enterOpensComposer(e)) return;
    const surf = getSurface();
    if (surf && surf !== 'sidebar') return;
    const ed = editor();
    if (!surf && ed && (ed.sel.size || ed.editingId)) return;
    e.preventDefault(); e.stopPropagation();
    sayBar();
  };
  window.addEventListener('keydown', onEnter, true);
  offs.push(() => window.removeEventListener('keydown', onEnter, true));

  /* ---------------- group → Blueprint ---------------- */
  async function toBlueprint(list) {
    const ed = editor();
    const ids = new Set(ed.expandGroups ? ed.expandGroups(list.map((e) => e.id)) : list.map((e) => e.id));
    // Bring connectors whose both ends are inside along.
    for (const e of ed.els) if (e.type === 'line' && e.a?.id && e.b?.id && ids.has(e.a.id) && ids.has(e.b.id)) ids.add(e.id);
    const els = ed.els.filter((e) => ids.has(e.id) && e.type !== 'widget');
    if (!els.length) return;
    const name = await promptDialog('Convert to Blueprint', { value: els.find((e) => e.type === 'frame')?.title || 'New blueprint', ok: 'Convert', label: 'Name' });
    if (!name) return;
    const rc = unionRects(els.map((e) => rectOf(e, ed.byId)));
    const dx = -rc.x, dy = -rc.y;
    const shift = (p) => (p && p.x != null ? { ...p, x: p.x + dx, y: p.y + dy } : p);
    const moved = els.map((e) => (e.type === 'line' ? { ...e, a: shift(e.a), b: shift(e.b) } : { ...e, x: e.x + dx, y: e.y + dy, privateTo: undefined }));
    const byId = new Map(moved.map((e) => [e.id, e]));
    const row = { id: uid(), name, kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: moved }, preview: makePreview(moved, byId) };
    try {
      await api.db.insert('blueprints', row);
    } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); return; }
    // Everyone in the Space can open it.
    if (api.mode !== 'local') {
      try {
        const people = (await api.rpc('board_people', { b: spaceId })) || [];
        for (const p of people) if (p.user_id !== me.id) await api.rpc('share_board', { b: row.id, uname: p.username }).catch(() => {});
      } catch {}
    }
    const portal = widgetEl('portal', { boardId: row.id, name, preview: row.preview });
    portal.x = rc.x + rc.w / 2 - portal.w / 2;
    portal.y = rc.y + rc.h / 2 - portal.h / 2;
    ed.setEls([...ed.els.filter((e) => !ids.has(e.id)), portal]);
    ed.select([portal.id]);
    window.dispatchEvent(new CustomEvent('architect:blueprints-changed'));
    toast(`“${name}” is a Blueprint now — open it from the portal.`, { ms: 3200 });
  }

  return {
    focus: (kind) => { try { sessionStorage.removeItem('architect.focus'); } catch {} focusKind(kind); },
    destroy() {
      destroyed = true;
      window.removeEventListener('architect:warm-shared', onWarm);
      window.removeEventListener('resize', onPhoneResize);
      unmountPhone();
      spotOff?.();
      bpWin?.close(); bpWin = null;
      ticketEsc.forEach((off) => off()); ticketEsc.clear();
      offs.forEach((f) => { try { f(); } catch {} });
      for (const slot of Object.values(slots)) {
        if (!slot) continue;
        slot.offs.forEach((f) => { try { f(); } catch {} });
        slot.board?.destroy();
      }
      page.remove();
      document.body.classList.remove('is-space');
    },
  };
}

function mondayKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// "Alt+1", "Ctrl+Shift+K", "G" — layout-independent for letters and digits.
export function comboOf(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}
