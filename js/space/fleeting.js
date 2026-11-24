// Fleeting Moments (was Fleeting Ideas) — Story and Weekly (the Tracker calendar opens from a button in
// Story). Nov 19: the Ideas canvas moved into Side Chat (its lightbulb), mounted from here with
// { only: 'ideas' } so it is the very same canvas; the widget's tabs sit beside its title.
//   Ideas    an influence canvas split in two: EXTERNAL (amber, left) and INTERNAL (violet, right).
//            Where an idea sits is its classification, and its glass takes that side's colour.
//            Two views: Mine (default — your own ideas, on your account, the same in every Space)
//            and Shared (the pool on the shared Space's object: ideas shared with you or made there).
//            Shared runs on its own axis (Nov 18): PRODUCE (teal, left) and CONSUME (coral, right) —
//            the pool read as what's being put out versus what's being taken in.
//            Grab one and it freezes; drop it on the canvas to park it, or on your Path to make it a task.
//   Story    the day as a timeline (GM → Afternoon → Nighttime → Second Wind → new morning).
//            Drop photos, paste videos, type narration; each fragment carries its Set-Point.
//   Tracker  the month: a ringed circle is a day that has a story, in the colour of how the day moved.
//   Weekly   one goal, one week at a time: a renamable week card of what's needed to be true.
// Everything lives on the widget object, so it syncs with the rest of the Space like any other object.
// Drift is computed from the clock (start point + speed × time), so everyone sees the same motion.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, popover, closeFloating, dialog, confirmDialog } from '../core/ui.js';
import { uid, store, prefersReducedMotion } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia, fmtDur } from './media.js';
import { avatarsFor } from '../data/profile.js';
import { getPref, setPref } from '../data/prefs.js';
import { loadMyVars, myVars, setMyVars, onMyVars } from '../data/myvars.js';
import { registerPool, poolReady, poolIdeas, setPoolIdeas, onPool, poolField, patchPool } from '../data/ideapool.js';

/* Who wrote a Story event: name + face, looked up once per person. */
const whoNames = new Map(), whoFaces = new Map();
let whoAsk = null;
function lookupWho(ids, onDone) {
  const want = [...new Set(ids.filter((id) => id && (!whoNames.has(id) || !whoFaces.has(id))))];
  if (!want.length || whoAsk) return;
  whoAsk = (async () => {
    try {
      if (api.mode !== 'local') {
        const rows = await api.db.select('profiles', { columns: 'id,username', filters: { id: want } });
        rows.forEach((r) => whoNames.set(r.id, r.username));
      }
    } catch {}
    try { (await avatarsFor(want)).forEach((url, id) => whoFaces.set(id, url)); } catch {}
    want.forEach((id) => { if (!whoNames.has(id)) whoNames.set(id, null); if (!whoFaces.has(id)) whoFaces.set(id, null); });
    whoAsk = null;
    onDone();
  })();
}

/* ---------------- Set-Points: the story day runs 7AM → 7AM ---------------- */
export const SETPOINTS = [
  { id: 'gm', label: 'GM', from: 0, color: '#E9B949' },            // 7AM
  { id: 'afternoon', label: 'Afternoon', from: 360, color: '#E8913A' }, // 1PM
  { id: 'night', label: 'Nighttime', from: 720, color: '#6F96DB' },   // 7PM
  { id: 'second', label: 'Second Wind', from: 1080, color: '#9D6CF0' }, // 1AM
];
const DAY_START = 7 * 60;
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
/** The story day a moment belongs to: before 7AM still counts as the day before. */
export const storyKey = (d = new Date()) => keyOf(new Date(d.getTime() - DAY_START * 60_000));
const storyMin = (d = new Date()) => (d.getHours() * 60 + d.getMinutes() - DAY_START + 1440) % 1440;
export const spOf = (m) => [...SETPOINTS].reverse().find((s) => m >= s.from) || SETPOINTS[0];
const clockOf = (m) => { const t = (m + DAY_START) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const shortDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** A week named by when it really is: "November 16–22", or "Nov 30 – Dec 6" across a month. */
const weekRange = (key) => {
  const a = parseKey(key), b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
  const mo = (d, len) => d.toLocaleDateString(undefined, { month: len });
  return a.getMonth() === b.getMonth() ? `${mo(a, 'long')} ${a.getDate()}–${b.getDate()}` : `${mo(a, 'short')} ${a.getDate()} – ${mo(b, 'short')} ${b.getDate()}`;
};
const addWeeks = (key, n) => { const d = parseKey(key); return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n * 7)); };
/** Every Monday from start's week through deadline's week, plus any week that still holds tasks. */
const planWeeks = (p) => {
  const first = keyOf(mondayOf(parseKey(p.start))), last = keyOf(mondayOf(parseKey(p.deadline)));
  const out = new Set();
  for (let k = first, i = 0; k <= last && i < 260; k = addWeeks(k, 1), i++) out.add(k);
  for (const [k, v] of Object.entries(p.weeks)) if (v?.length) out.add(k);
  return [...out].sort();
};
// Glass ideas: each card gets its own hue and a slight tilt, derived from its id so everyone sees the same.
const GLASS_HUES = [268, 186, 38, 340, 146, 214, 14, 300, 52, 166];
const hashOf = (str) => { let x = 2166136261; for (const c of String(str)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
const glassOf = (id) => { const n = hashOf(id); return { hue: GLASS_HUES[n % GLASS_HUES.length], tilt: (((n >>> 8) % 61) - 30) / 10 }; };
// Influence colours: two families instead of a rainbow. Each idea keeps its own shade within the family.
const EXT_HUES = [30, 38, 24, 44, 34];      // amber — external
const INT_HUES = [266, 276, 258, 284, 270]; // violet — internal
// The shared pool's axis: teal produce, coral consume. Coral sits past 360 so a flip sweeps through blue
// and magenta instead of muddy greens and yellows.
const PRO_HUES = [174, 180, 168, 186, 176];  // teal — produce
const CON_HUES = [367, 372, 363, 376, 369];  // coral — consume
const shadesOf = (id) => {
  const n = hashOf(id);
  return { ext: EXT_HUES[n % EXT_HUES.length], int: INT_HUES[(n >>> 4) % INT_HUES.length], pro: PRO_HUES[(n >>> 8) % PRO_HUES.length], con: CON_HUES[(n >>> 12) % CON_HUES.length] };
};
// Each view's two sides: [left, right] labels. Mine reads influence; the shared pool reads output vs input.
const AXES = { mine: ['EXTERNAL', 'INTERNAL'], shared: ['PRODUCE', 'CONSUME'] };
const tf = (x, y, tilt = 0, lift = false) => `translate(${x}px, ${y}px) rotate(${lift ? 0 : tilt}deg)${lift ? ' scale(1.04)' : ''}`;
const fold = (v) => { v = ((v % 2) + 2) % 2; return v > 1 ? 2 - v : v; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Nov 25 — Weekly isn't used any more: Fleeting Moments is Story, with no tab bar.
const MOMENT_TABS = [['story', 'Story']];
const DEFAULT_GOAL = 'Rona’s Apartment';
// Weekly looks — yours alone (saved to your account prefs), so everyone can plan on their own backdrop.
const WK_THEMES = [
  ['default', 'Default', '#1c1c1c'],
  ['mono', 'Mono', '#000000'],
  ['paper', 'Paper', '#efefef'],
  ['graphite', 'Graphite', '#3a3a3a'],
  ['midnight', 'Midnight', '#14223f'],
  ['ember', 'Ember', '#3b2116'],
  ['moss', 'Moss', '#1f2e22'],
];

export function mountFleeting(root, el0, w, opts = {}) {
  let el = el0;
  const only = opts.only || null; // 'ideas' → just the ideas canvas (Side Chat)
  const TABS = only === 'ideas' ? [['ideas', 'Ideas']] : MOMENT_TABS;
  const me = api.auth.current()?.user;
  const memKey = `architect.fi.${el.id}`;
  const mem = store.get(memKey, {});
  // Tracker used to be a tab: anyone who left it open lands in Story with the calendar showing.
  let tab = only === 'ideas' ? 'ideas' : mem.tab === 'tracker' ? 'story' : TABS.some(([id]) => id === mem.tab) ? mem.tab : 'story';
  let cal = mem.tab === 'tracker' || !!mem.cal; // Story's calendar (the Tracker) is open
  let day = storyKey();
  let month = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
  let hold = 0;          // > 0 while dragging or editing: remote updates wait
  let pending = false;
  let uploads = [];      // story fragments still uploading (this device only)
  // Ideas view: 'mine' (default, private to you) or 'shared' (the pool).
  let ideaView = mem.iv === 'shared' ? 'shared' : 'mine';
  const personal = !!w.host?.personal;
  let mineReady = false;
  // Story's zoom (Nov 26: true visual zoom). Everything on the timeline — cards, text, times, marks, the spine —
  // grows or shrinks together; the time scale and every moment's position stay exactly as they are.
  let zoomT = Math.min(6, Math.max(0.35, Number(mem.zt) || 1));
  let full = false;                       // Story fills the screen
  const selFr = new Set();                // Ctrl-click selection of moments
  let frontId = null;                     // picked from a stack: drawn on top
  const undoMoves = [];                   // { day, list } before each move — Ctrl+Z
  const remember = () => store.set(memKey, { tab, cal, iv: ideaView, zt: zoomT });
  const view = () => (tab === 'story' && cal ? 'tracker' : tab);

  const tabsRow = h('div', { class: 'fi-tabs', role: 'tablist' });
  const aside = h('div', { class: 'fi-aside' });
  const stage = h('div', { class: 'fi-stage' });
  const input = h('input', {
    class: 'fi-input', type: 'text', maxlength: 400, spellcheck: true, 'aria-label': 'Type an idea',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } },
  });
  const attach = h('button', { class: 'fi-attach', type: 'button', title: 'Add photos or videos', 'aria-label': 'Add photos or videos', onclick: () => pickMedia().then((f) => addMediaToStory(f)) }, icon('image', 17));
  const composer = h('div', { class: 'fi-compose' }, input, attach);
  const box = h('div', { class: ['fi', only && `is-only-${only}`] }, h('div', { class: 'fi-top' }, w.slot || only ? null : tabsRow, aside), stage, composer);
  root.append(box);
  // Title beside the tabs (like Path): the tab strip rides in the widget header, right after the name.
  if (w.slot && !only) w.slot.replaceChildren(tabsRow);

  // Paste photos/videos straight into Story (or into Ideas → they land in today's story).
  box.addEventListener('paste', (e) => {
    const files = mediaFiles(e.clipboardData);
    if (!files.length && tab === 'ideas' && !e.target.closest?.('input, textarea, [contenteditable="true"]')) {
      const lines = String(e.clipboardData?.getData('text/plain') || '').split(/\r?\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
      if (lines.length) { e.preventDefault(); addIdeas(lines); paintIdeaSel(); }
      return;
    }
    if (!files.length) return;
    e.preventDefault();
    if (tab === 'ideas') { if (!only) { day = storyKey(); setTab('story'); } else return; }
    if (tab === 'story') addMediaToStory(files);
  });

  /* ---------------- shared state ---------------- */
  // Ideas come from one of two stores. Mine: your account (data/myvars.js). Shared: the pool — this
  // object's ideas in the shared Space, or (from your personal Space) the shared Space's object.
  const mineList = () => myVars()?.ideas || [];
  const poolGet = () => (personal ? poolIdeas() : (el.ideas || []));
  const poolSet = (list, live = false) => (personal ? setPoolIdeas(list, live) : (live ? w.live : w.patch)({ ideas: list }));
  const poolOk = () => !personal || poolReady();
  const ideas = () => (ideaView === 'shared' ? poolGet() : mineList());
  // Moments sync: in your personal Space, Story and Weekly are the shared Space's object (when it is
  // around), merged with anything this copy holds that the shared one doesn't have yet — nothing written
  // in either place goes missing, and every write lands on the one shared record.
  const moments = !only && personal;
  const sharedStory = () => (moments && poolReady() ? poolField('story') || {} : null);
  const storyAll = (k) => {
    const mine = el.story?.[k] || [];
    const sh = sharedStory();
    if (!sh) return mine;
    const theirs = sh[k] || [];
    if (!mine.length) return theirs;
    const ids = new Set(theirs.map((f) => f.id));
    return [...theirs, ...mine.filter((f) => !ids.has(f.id))].sort((a, b) => a.m - b.m);
  };
  const story = (k = day) => storyAll(k);
  // Weekly plan. Weeks are keyed by their Monday (YYYY-MM-DD) and run from start to the deadline,
  // so the columns generate themselves. Older plans keyed weeks 1..8 — those convert on read.
  const weekly = () => {
    const shw = moments && poolReady() ? poolField('weekly') : null;
    const wk = (shw && (shw.goal != null || Object.keys(shw.weeks || {}).length) ? shw : el.weekly) || {};
    const start = wk.start || keyOf(mondayOf(new Date()));
    const weeks = {};
    for (const [k, v] of Object.entries(wk.weeks || {})) {
      const key = /^\d{1,2}$/.test(k) ? addWeeks(start, Number(k) - 1) : k;
      weeks[key] = [...(weeks[key] || []), ...(v || [])];
    }
    const deadline = wk.deadline || keyOf(new Date(parseKey(start).getTime() + 55 * 86_400_000)); // default: 8 weeks
    return { goal: wk.goal ?? DEFAULT_GOAL, start, deadline, weeks, tray: wk.tray || [], titles: wk.titles || {} };
  };
  const setIdeas = (list, live = false) => {
    if (ideaView === 'shared') { if (poolOk()) poolSet(list, live); }
    else if (mineReady) setMyVars({ ideas: list });
  };
  const setStory = (k, list) => {
    const sh = sharedStory();
    if (sh) {
      patchPool({ story: { ...sh, [k]: list } });
      // this copy's own entries now live on the shared record: clear them here so they aren't merged twice
      if ((w.current().story || {})[k]?.length) w.patch({ story: { ...(w.current().story || {}), [k]: [] } });
      return;
    }
    w.patch({ story: { ...(w.current().story || {}), [k]: list } });
  };
  const setWeekly = (p) => {
    const cur = weekly();
    if (moments && poolReady()) { patchPool({ weekly: { ...cur, ...p } }); return; }
    w.patch({ weekly: { ...cur, ...p } });
  };

  /* ---------------- shell ---------------- */
  function setTab(id) {
    if (tab === id) return;
    tab = id; cal = false; remember();
    paint();
  }

  function paint() {
    tabsRow.hidden = TABS.length < 2;
    tabsRow.replaceChildren(...(TABS.length < 2 ? [] : TABS).map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: ['fi-tab', tab === id && 'is-on'], 'aria-selected': String(tab === id),
      onclick: () => setTab(id),
    }, label)));
    const v = view();
    box.dataset.tab = tab;
    // Story has no narration box any more: click the line where the moment happened. The ideas canvas keeps
    // its composer (in Side Chat) and also takes a click on open space.
    paintComposer();
    input.placeholder = tab === 'story' ? (day === storyKey() ? 'narrate this moment…' : `add to ${shortDate(parseKey(day))}…`) : 'type an idea…';
    if (phoneStory()) input.placeholder = '';
    input.setAttribute('aria-label', tab === 'story' ? 'Narrate a moment' : 'Type an idea');
    aside.replaceChildren(...(tab === 'story' ? [...(cal ? [] : dayNav()), ...(cal ? [] : [mediaBtn(), ...zoomBtns()]), calBtn(), fullBtn()] : tab === 'ideas' ? [viewSwitch()] : []));
    if (tab === 'ideas') input.placeholder = ideaView === 'shared' ? 'add to the shared pool…' : 'type an idea…';
    stopIdeas();
    stage.replaceChildren();
    stage.scrollTop = 0;
    stage.className = `fi-stage is-${v}`;
    if (v === 'ideas') mountIdeas();
    else if (v === 'story') {
      renderStory();
      // Today opens around the current moment; other days open at first light.
      if (day === storyKey()) stage.scrollTop = Math.max(0, (PT + (storyMin() / 1440) * Number(tl.dataset.th)) * zoomT - stage.clientHeight * 0.45);
    }
    else if (v === 'tracker') renderTracker();
    else renderWeekly();
  }

  // On a phone (Nov 25) Story keeps a composer floating just above the bottom edge: a bare + and a blank
  // field — Enter posts the moment at now. On the desktop Story has no composer (click the line instead).
  const phoneStory = () => view() === 'story' && !!box.closest('.mob-view');
  let composerPhone = null;
  function paintComposer() {
    const v = view();
    const ph = phoneStory();
    composer.hidden = v !== 'ideas' && !ph;
    attach.hidden = tab !== 'story';
    box.classList.toggle('is-phone-story', ph);
    if (ph !== composerPhone) {
      composerPhone = ph;
      attach.replaceChildren(icon(ph ? 'plus' : 'image', ph ? 20 : 17));
      if (ph) input.placeholder = '';
    }
  }
  const onWinResize = () => paintComposer();
  window.addEventListener('resize', onWinResize);

  // Ideas' view option: your own ideas, or the shared pool.
  function viewSwitch() {
    const opt = (id, label, ic, title) => h('button', {
      type: 'button', role: 'radio', class: ['fi-view', ideaView === id && 'is-on'], 'aria-checked': String(ideaView === id), title,
      onclick: () => setIdeaView(id),
    }, icon(ic, 13), h('span', {}, label));
    return h('div', { class: 'fi-views', role: 'radiogroup', 'aria-label': 'Ideas view' },
      opt('mine', 'Mine', 'lock', 'Your ideas — only you see them, in every Space'),
      opt('shared', 'Shared', 'users', 'The shared pool — ideas shared with you or made there'));
  }
  function setIdeaView(v) {
    if (ideaView === v) return;
    ideaView = v; remember();
    hist.length = 0; fut.length = 0; selIdeas.clear();
    if (v === 'shared' && personal && !poolReady()) w.host?.warmShared?.();
    paint();
  }

  // Story's side button: flips the stage between the day's timeline and the month calendar.
  function calBtn() {
    return h('button', {
      type: 'button', class: ['fi-nav', 'fi-cal-btn', cal && 'is-on'], 'aria-pressed': String(cal),
      'aria-label': cal ? 'Back to the story' : 'Open the tracker', title: cal ? 'Back to the story' : 'Tracker — the month at a glance',
      onclick: () => { cal = !cal; if (cal) { const d = parseKey(day); month = new Date(d.getFullYear(), d.getMonth(), 1); } remember(); paint(); },
    }, icon('calendar', 16));
  }

  function refresh() {
    if (hold > 0) { pending = true; return; }
    const a = document.activeElement;
    if (a && stage.contains(a) && a.matches('input, textarea, [contenteditable="true"]')) { pending = true; return; }
    pending = false;
    const v = view();
    if (v === 'ideas') syncIdeas();
    else if (v === 'story') renderStory();
    else if (v === 'tracker') renderTracker();
    else renderWeekly();
  }
  const release = () => { hold = Math.max(0, hold - 1); if (!hold && pending) setTimeout(refresh, 0); };
  stage.addEventListener('focusout', () => setTimeout(() => { if (pending && !stage.contains(document.activeElement)) refresh(); }, 0));

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (tab === 'story') { addFragment({ kind: 'text', text }); return; }
    if (ideaView === 'shared' ? !poolOk() : !mineReady) { input.value = text; toast('One moment — still opening your ideas.', { ms: 1800 }); return; }
    // A new idea slides in from the bottom and settles somewhere on the ice.
    const x = 0.1 + Math.random() * 0.8;
    commitIdeas([...ideas(), {
      id: uid(), text, by: me?.id || null, t0: Date.now(), parked: false, mv: me?.id || null,
      x, y: 1, vx: (Math.random() - 0.5) * 0.4, vy: -(0.9 + Math.random() * 1.1),
    }]);
  }

  /* ================= IDEAS ================= */
  let field = null;      // .fi-field
  const nodes = new Map(); // idea id → { node, w, h }
  let raf = 0;
  let io = null;
  let onScreen = true;
  let dragId = null;
  let groupIds = null;       // ids moving together in a group drag
  const selIdeas = new Set(); // selected ideas (selection window, click, Ctrl/⌘-click)
  const hist = [], fut = [];  // undo / redo for the Ideas tab
  // An undoable change to the ideas.
  const commitIdeas = (list) => { hist.push(ideas()); if (hist.length > 60) hist.shift(); fut.length = 0; setIdeas(list); };
  function undoIdeas(redo = false) {
    const from = redo ? fut : hist, to = redo ? hist : fut;
    if (!from.length) { toast(redo ? 'Nothing to redo.' : 'Nothing to undo.', { ms: 1400 }); return; }
    to.push(ideas());
    const prev = from.pop(), now = Date.now();
    setIdeas(prev.map((q) => ({ ...q, vx: 0, vy: 0, t0: now, x: motion(q, now).x, y: motion(q, now).y })));
  }
  function paintIdeaSel() { for (const [id, n] of nodes) n.node.classList.toggle('is-sel', selIdeas.has(id)); }

  function mountIdeas() {
    field = h('div', { class: 'fi-field', 'data-view': ideaView });
    // The split: external | internal in Mine, produce | consume in the shared pool. Purely visual — clicks
    // and the selection window pass straight through to the field.
    const [L, R] = AXES[ideaView] || AXES.mine;
    stage.append(h('div', { class: 'fi-zones', 'data-axis': ideaView, 'aria-hidden': 'true' },
      h('div', { class: 'fi-zone is-ext' }, h('span', { class: 'fi-zone-label' }, L)),
      h('div', { class: 'fi-zone is-int' }, h('span', { class: 'fi-zone-label' }, R))));
    stage.append(field);
    field.addEventListener('pointerdown', marquee);
    nodes.clear();
    syncIdeas();
    io = new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); }, { threshold: 0 });
    io.observe(field);
    // Shared-space speed: the ice only runs while something is actually gliding (or just changed).
    const gliding = (t) => ideas().some((i) => !i.parked && (i.vx || i.vy) && t - (i.t0 || 0) < 6000);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!onScreen || document.hidden) return;
      if (iceDirty || dragId || groupIds || gliding(Date.now())) { iceDirty = false; place(); }
    };
    raf = requestAnimationFrame(loop);
  }
  function stopIdeas() { cancelAnimationFrame(raf); raf = 0; io?.disconnect(); io = null; field = null; }

  function syncIdeas() {
    if (!field) return;
    iceDirty = true;
    const list = ideas();
    const live = new Set(list.map((i) => i.id));
    for (const [id, n] of nodes) if (!live.has(id)) { n.node.remove(); nodes.delete(id); }
    for (const id of [...selIdeas]) if (!live.has(id)) selIdeas.delete(id);
    for (const i of list) {
      let n = nodes.get(i.id);
      if (!n) {
        const g = glassOf(i.id), sh = shadesOf(i.id);
        const node = h('div', { class: 'fi-idea', tabindex: 0, 'data-id': i.id, style: { '--he': sh.ext, '--hi': sh.int, '--hp': sh.pro, '--hc': sh.con } });
        bindIdea(node, i.id);
        field.append(node);
        n = { node, w: 0, h: 0, tilt: 0 }; // Nov 19: ideas sit level, like Path items
        nodes.set(i.id, n);
      }
      if (n.node.textContent !== i.text) n.node.textContent = i.text;
      n.node.title = ideaView === 'shared'
        ? 'Left: produce · right: consume — drag across to flip it · drop on your Path to make it a task'
        : 'Left: external · right: internal — drag across to reclassify · drop on your Path to make it a task';
      n.node.classList.toggle('is-sel', selIdeas.has(i.id));
      n.w = n.node.offsetWidth; n.h = n.node.offsetHeight;
    }
    field.classList.toggle('is-empty', !list.length);
    field.querySelector('.fi-empty')?.remove();
    const waiting = ideaView === 'shared' ? !poolOk() : !mineReady;
    if (waiting) field.append(h('p', { class: 'fi-empty' }, ideaView === 'shared' ? 'Opening the shared pool…' : 'Loading your ideas…'));
    else if (!list.length) field.append(h('p', { class: 'fi-empty' }, ...(ideaView === 'shared'
      ? ['Nothing in the shared pool yet.', h('br'), 'Share one of yours, or type one here.']
      : ['Nothing drifting yet.', h('br'), 'Only you see these. Throw it in below.'])));
    place();
  }

  /* Ice: an idea rests where you leave it and only glides when it's thrown or bumped.
     Motion is a function of the clock (start + velocity, slowed by friction, bouncing off the edges),
     so everyone sees the same glide. Positions are 0..1 of the room the idea has to move in. */
  const ICE = 2.4;          // friction (1/s): a throw coasts for about a second and a half
  const STILL = 0.0015;     // below this speed it counts as resting
  function motion(i, t) {
    if (i.parked || prefersReducedMotion() || (!i.vx && !i.vy)) return { x: clamp01(i.x), y: clamp01(i.y), vx: 0, vy: 0 };
    const s = Math.max(0, (t - (i.t0 || 0)) / 1000);
    const e = Math.exp(-ICE * s), d = (1 - e) / ICE;
    const rx = (i.x || 0) + (i.vx || 0) * d, ry = (i.y || 0) + (i.vy || 0) * d;
    const flip = (r) => ((((r % 2) + 2) % 2) > 1 ? -1 : 1); // bouncing off a wall turns it around
    return { x: fold(rx), y: fold(ry), vx: (i.vx || 0) * e * flip(rx), vy: (i.vy || 0) * e * flip(ry) };
  }
  const posOf = (i, t) => { const m = motion(i, t); return { x: m.x, y: m.y }; };
  const moving = (m) => Math.hypot(m.vx, m.vy) > STILL;

  // Which side of the divider an idea's centre is on decides its colour (and so its classification).
  function sideTo(node, px, w, W) {
    const side = px + w / 2 < W / 2 ? 'ext' : 'int';
    if (node.dataset.side !== side) node.dataset.side = side;
  }

  const bumped = new Map(); // "a|b" → time, so one contact is one bump
  let iceDirty = true;
  function place() {
    if (!field) return;
    const W = field.clientWidth, H = field.clientHeight;
    const t = Date.now();
    const list = ideas();
    const boxes = [];
    for (const i of list) {
      const n = nodes.get(i.id);
      if (!n) continue;
      if (!n.w) { n.w = n.node.offsetWidth; n.h = n.node.offsetHeight; }
      if (i.id === dragId || groupIds?.has(i.id)) continue;
      const m = motion(i, t);
      const px = Math.round(m.x * Math.max(0, W - n.w)), py = Math.round(m.y * Math.max(0, H - n.h));
      const t2 = tf(px, py, n.tilt);
      if (n.node.style.transform !== t2) n.node.style.transform = t2; // resting ideas cost nothing per frame
      sideTo(n.node, px, n.w, W);
      boxes.push({ i, m, n, px, py, rx: Math.max(1, W - n.w), ry: Math.max(1, H - n.h) });
    }
    // Bumps: an idea you set moving knocks into the ones it touches (only the thrower's screen decides).
    const mine = boxes.filter((b) => b.i.mv === me?.id && moving(b.m));
    if (!mine.length) return;
    let next = null;
    for (const a of mine) {
      for (const b of boxes) {
        if (b === a) continue;
        const key = a.i.id < b.i.id ? `${a.i.id}|${b.i.id}` : `${b.i.id}|${a.i.id}`;
        const overlap = a.px < b.px + b.n.w && a.px + a.n.w > b.px && a.py < b.py + b.n.h && a.py + a.n.h > b.py;
        if (!overlap) { bumped.delete(key); continue; }
        if (bumped.has(key)) continue;
        bumped.set(key, t);
        // Push along the line between their centres, in pixels.
        const avx = a.m.vx * a.rx, avy = a.m.vy * a.ry;
        let nx = (b.px + b.n.w / 2) - (a.px + a.n.w / 2), ny = (b.py + b.n.h / 2) - (a.py + a.n.h / 2);
        const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
        const along = Math.max(0, avx * nx + avy * ny);
        if (along < 8) continue;
        const give = along * 0.9;
        const bvx = (b.m.vx * b.rx) + nx * give, bvy = (b.m.vy * b.ry) + ny * give;
        const keepX = (avx - nx * give * 0.75) * 0.6, keepY = (avy - ny * give * 0.75) * 0.6;
        next ||= new Map();
        next.set(a.i.id, { x: a.m.x, y: a.m.y, vx: keepX / a.rx, vy: keepY / a.ry, t0: t, parked: false, mv: me?.id || null });
        next.set(b.i.id, { x: b.m.x, y: b.m.y, vx: bvx / b.rx, vy: bvy / b.ry, t0: t, parked: false, mv: me?.id || null });
      }
    }
    if (next) setIdeas(ideas().map((q) => (next.has(q.id) ? { ...q, ...next.get(q.id) } : q)), true);
  }

  function bindIdea(node, id) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || node.isContentEditable || dragId) return;
      const idea = ideas().find((x) => x.id === id);
      if (!idea || !field) return;
      e.preventDefault();
      e.stopPropagation();
      node.focus({ preventScroll: true });
      if (e.ctrlKey || e.metaKey || e.shiftKey) { // Ctrl/⌘/Shift-click toggles it in the selection
        if (selIdeas.has(id)) selIdeas.delete(id); else selIdeas.add(id);
        paintIdeaSel();
        return;
      }
      if (selIdeas.has(id) && selIdeas.size > 1) { dragGroup(e, id); return; }
      const fr0 = field.getBoundingClientRect();
      const scale = fr0.width / (field.clientWidth || 1); // the canvas may be zoomed
      const W = field.clientWidth, H = field.clientHeight;
      const nw = node.offsetWidth, nh = node.offsetHeight;
      const rx = Math.max(1, W - nw), ry = Math.max(1, H - nh);
      // Freeze it exactly where it is on screen: grabbing stops the glide, the text doesn't move.
      const at = motion(idea, Date.now());
      let fx = at.x * rx, fy = at.y * ry;               // its top-left inside the field (unscaled px)
      const offX = (e.clientX - fr0.left) / scale - fx, offY = (e.clientY - fr0.top) / scale - fy;
      const tilt = nodes.get(id)?.tilt || 0;
      node.style.transform = tf(Math.round(fx), Math.round(fy), tilt, true);
      dragId = id; hold++;
      node.classList.add('is-held');
      let ghost = null, over = null, moved = false, done = false, frame = 0, last = null;
      const samples = [];   // recent pointer positions, for the throw
      const sx = e.clientX, sy = e.clientY;

      const showGhost = (on) => {
        if (on && !ghost) {
          ghost = node.cloneNode(true);
          ghost.className = 'fi-idea fi-ghost';
          ghost.removeAttribute('tabindex');
          Object.assign(ghost.style, { width: `${nw}px`, height: `${nh}px`, transformOrigin: '0 0' });
          ghost.style.setProperty('--fh', getComputedStyle(node).getPropertyValue('--fh').trim() || '268'); // keep its side colour off the field
          document.body.append(ghost);
        }
        if (ghost) ghost.hidden = !on;
        node.style.visibility = on ? 'hidden' : '';
      };
      // Ideas on air (Nov 19): the pill is written straight from the pointer event — no frame of lag —
      // and the field's box is measured a few times a second, not on every move.
      let frc = fr0, frcT = performance.now();
      const step = () => {
        frame = 0;
        const ev = last;
        if (!ev || done) return;
        if (performance.now() - frcT > 250) { frc = field.getBoundingClientRect(); frcT = performance.now(); }
        const fr = frc;
        const inside = ev.clientX >= fr.left && ev.clientX <= fr.right && ev.clientY >= fr.top && ev.clientY <= fr.bottom;
        fx = Math.max(0, Math.min(rx, (ev.clientX - fr.left) / scale - offX));
        fy = Math.max(0, Math.min(ry, (ev.clientY - fr.top) / scale - offY));
        node.style.transform = tf(Math.round(fx), Math.round(fy), tilt, true);
        sideTo(node, fx, nw, W);
        if (ghost) ghost.dataset.side = node.dataset.side;
        // Outside its box it becomes a floating copy you can drop on your Path.
        const col = inside ? null : pathColAt(ev.clientX, ev.clientY);
        showGhost(!inside);
        if (ghost && !inside) {
          ghost.style.transform = `translate(${ev.clientX - offX * scale}px, ${ev.clientY - offY * scale}px) scale(${scale})`;
          ghost.classList.toggle('is-to-path', !!col);
        }
        if (col !== over) { over?.classList.remove('fi-drop-on'); over = col; over?.classList.add('fi-drop-on'); }
      };
      const move = (ev) => {
        if (done) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        if (!moved) { moved = true; document.body.classList.add('fi-dragging'); }
        samples.push({ x: ev.clientX, y: ev.clientY, t: performance.now() });
        if (samples.length > 6) samples.shift();
        last = ev;
        step();
      };
      const finish = (ev, how) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('blur', onCancel);
        document.removeEventListener('visibilitychange', onHidden);
        node.removeEventListener('lostpointercapture', onCancel);
        try { node.releasePointerCapture(e.pointerId); } catch {}
        over?.classList.remove('fi-drop-on');
        node.classList.remove('is-held');
        document.body.classList.remove('fi-dragging');
        const cleanup = () => { ghost?.remove(); ghost = null; node.style.visibility = ''; dragId = null; release(); };
        const now = Date.now();
        // Dropped on your Path: it becomes a task.
        if (how === 'up' && moved && ev && pathColAt(ev.clientX, ev.clientY)) {
          const detail = { x: ev.clientX, y: ev.clientY, text: idea.text, handled: false, column: '' };
          window.dispatchEvent(new CustomEvent('architect:drop-task', { detail }));
          if (detail.handled) {
            commitIdeas(ideas().filter((x) => x.id !== id));
            toast(`Pinned to ${detail.column || 'your Path'}.`, { ms: 2200 });
            cleanup();
            return;
          }
        }
        // Everywhere else it stays on the ice where you let go — thrown if you flicked it.
        let vx = 0, vy = 0;
        if (how === 'up' && moved && samples.length > 1) {
          const a = samples[0], b = samples[samples.length - 1];
          const dt = (b.t - a.t) / 1000;
          if (dt > 0 && performance.now() - b.t < 90) {
            const px = (b.x - a.x) / dt / scale, py = (b.y - a.y) / dt / scale;
            const sp = Math.hypot(px, py);
            if (sp > 90) { const k = Math.min(1, 2600 / sp); vx = (px * k) / rx; vy = (py * k) / ry; }
          }
        }
        const x = clamp01(fx / rx), y = clamp01(fy / ry);
        const next = ideas().map((q) => (q.id === id ? { ...q, x, y, vx, vy, t0: now, parked: false, mv: me?.id || null } : q));
        if (moved) commitIdeas(next); else setIdeas(next, true);
        if (!moved && how === 'up') { selIdeas.clear(); selIdeas.add(id); paintIdeaSel(); } // a click selects it
        cleanup();
      };
      const onUp = (ev) => finish(ev, 'up');
      const onCancel = () => finish(last, 'cancel');
      const onHidden = () => { if (document.hidden) onCancel(); };
      try { node.setPointerCapture(e.pointerId); } catch {}
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('blur', onCancel);
      document.addEventListener('visibilitychange', onHidden);
      node.addEventListener('lostpointercapture', onCancel);
    });
    node.addEventListener('dblclick', () => editIdea(node, id));
    node.addEventListener('keydown', (e) => {
      if (node.isContentEditable) return;
      if (e.key === 'Enter') { e.preventDefault(); editIdea(node, id); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(selIdeas.size > 1 && selIdeas.has(id))) { e.preventDefault(); e.stopPropagation(); removeIdea(id); }
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const i = ideas().find((x) => x.id === id);
      if (!i) return;
      menu({ x: e.clientX, y: e.clientY }, [
        { label: 'Edit', icon: 'edit', onSelect: () => editIdea(node, id) },
        selIdeas.size > 1 && selIdeas.has(id) ? { label: `Copy ${selIdeas.size} ideas`, icon: 'copy', kbd: '⌘C', onSelect: copyIdeas } : { label: 'Copy', icon: 'copy', kbd: '⌘C', onSelect: () => { selIdeas.clear(); selIdeas.add(id); paintIdeaSel(); copyIdeas(); } },
        { label: 'Give it a nudge', icon: 'curve', onSelect: () => { const m = motion(i, Date.now()); const a = Math.random() * Math.PI * 2; setIdeas(ideas().map((x) => (x.id === id ? { ...x, x: m.x, y: m.y, vx: Math.cos(a) * 0.35, vy: Math.sin(a) * 0.35, t0: Date.now(), parked: false, mv: me?.id || null } : x))); } },
        { label: 'Add to today’s story', icon: 'note', onSelect: () => { addFragment({ kind: 'text', text: i.text }, storyKey()); setIdeas(ideas().filter((x) => x.id !== id)); toast('Added to today’s story.', { ms: 1800 }); } },
        ...poolItems(i),
        '-',
        selIdeas.size > 1 && selIdeas.has(id)
          ? { label: `Let ${selIdeas.size} go`, icon: 'trash', danger: true, kbd: 'Del', onSelect: deleteIdeas }
          : { label: 'Let it go', icon: 'trash', danger: true, kbd: 'Del', onSelect: () => removeIdea(id) },
      ]);
    });
  }

  /* ---- moving ideas between Mine and the shared pool (same id, same spot: the same idea) ---- */
  const pickIds = (id) => (selIdeas.size > 1 && selIdeas.has(id) ? new Set(selIdeas) : new Set([id]));
  function poolItems(i) {
    const ids = pickIds(i.id), n = ids.size, many = n > 1 ? ` ${n} ideas` : '';
    if (ideaView === 'mine') return [{ label: `Share${many} to the pool`, icon: 'share', onSelect: () => moveIdeas(ids, 'shared') }];
    const all = ideas().filter((q) => ids.has(q.id));
    const allMine = all.every((q) => q.by === me?.id);
    return [allMine
      ? { label: `Take${many || ' it'} back to Mine`, icon: 'lock', onSelect: () => moveIdeas(ids, 'mine') }
      : { label: `Copy${many} to Mine`, icon: 'copy', onSelect: () => moveIdeas(ids, 'mine', true) }];
  }
  function moveIdeas(ids, to, copy = false) {
    if (to === 'shared' && !poolOk()) { w.host?.warmShared?.(); toast('Opening the shared pool — try again in a moment.', { ms: 2600 }); return; }
    if (to === 'mine' && !mineReady) return;
    const from = ideas();
    const moving = from.filter((q) => ids.has(q.id)).map((q) => ({ ...q, by: q.by || me?.id || null }));
    if (!moving.length) return;
    if (to === 'shared') poolSet([...poolGet().filter((q) => !ids.has(q.id)), ...moving]);
    else setMyVars({ ideas: [...mineList().filter((q) => !ids.has(q.id)), ...moving.map((q) => (copy ? { ...q, id: uid(), by: me?.id || null } : q))] });
    if (!copy) { commitIdeas(from.filter((q) => !ids.has(q.id))); ids.forEach((x) => selIdeas.delete(x)); }
    const n = moving.length;
    toast(to === 'shared' ? `Shared ${n === 1 ? 'it' : n} to the pool.` : copy ? `Copied ${n === 1 ? 'it' : n} to Mine.` : `Back in Mine.`, { ms: 2000 });
  }

  function removeIdea(id) {
    selIdeas.delete(id);
    commitIdeas(ideas().filter((x) => x.id !== id));
  }

  const pinned = new Map(); // idea id → its top-left (field px) while it's being written
  function editIdea(node, id) {
    const i = ideas().find((x) => x.id === id);
    if (!i || node.isContentEditable) return;
    // Hold the pill's top-left where it is while you type: growing text widens it to the right, not both ways.
    if (!pinned.has(id) && field) {
      const n0 = nodes.get(id);
      const m0 = motion(i, Date.now());
      if (n0) pinned.set(id, { px: m0.x * Math.max(0, field.clientWidth - (n0.w || node.offsetWidth)), py: m0.y * Math.max(0, field.clientHeight - (n0.h || node.offsetHeight)) });
    }
    hold++; dragId = id;
    node.contentEditable = 'true';
    node.classList.add('is-editing');
    node.focus();
    document.getSelection()?.selectAllChildren(node);
    const done = (save) => {
      node.removeEventListener('blur', onBlur);
      node.removeEventListener('keydown', onKey);
      node.contentEditable = 'false';
      node.classList.remove('is-editing');
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      dragId = null;
      const pin = pinned.get(id); pinned.delete(id);
      let at = {};
      if (pin && field && save && text) {
        node.textContent = text;
        const W = field.clientWidth, H = field.clientHeight;
        at = { x: clamp01(pin.px / Math.max(1, W - node.offsetWidth)), y: clamp01(pin.py / Math.max(1, H - node.offsetHeight)), vx: 0, vy: 0 };
      }
      if (save && text && text !== i.text) {
        if (!i.text) setIdeas(ideas().map((x) => (x.id === id ? { ...x, text, ...at } : x))); // a fresh pill: one undo step, not two
        else commitIdeas(ideas().map((x) => (x.id === id ? { ...x, text, ...at } : x)));
      } else if (!i.text) { setIdeas(ideas().filter((x) => x.id !== id)); hist.pop(); } // left empty: it was never there
      else node.textContent = i.text;
      const n = nodes.get(id); if (n) { n.w = node.offsetWidth; n.h = node.offsetHeight; }
      release();
    };
    const onBlur = () => done(true);
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); node.blur(); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    node.addEventListener('blur', onBlur);
    node.addEventListener('keydown', onKey);
  }

  /* ---- selection window, group drag, keys ---- */
  // Drag on empty ice to draw a selection window; every idea it touches gets selected.
  function marquee(e) {
    if (e.button !== 0 || e.target !== field && !e.target.classList?.contains('fi-empty')) return;
    e.preventDefault(); e.stopPropagation();
    stage.focus({ preventScroll: true });
    const fr = field.getBoundingClientRect();
    const scale = fr.width / (field.clientWidth || 1);
    const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(selIdeas) : new Set();
    const sx = e.clientX, sy = e.clientY;
    const box = h('div', { class: 'fi-marquee' });
    let shown = false;
    const move = (ev) => {
      if (!shown && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!shown) { shown = true; field.append(box); }
      const a = { l: Math.min(sx, ev.clientX), t: Math.min(sy, ev.clientY), r: Math.max(sx, ev.clientX), b: Math.max(sy, ev.clientY) };
      Object.assign(box.style, { left: `${(a.l - fr.left) / scale}px`, top: `${(a.t - fr.top) / scale}px`, width: `${(a.r - a.l) / scale}px`, height: `${(a.b - a.t) / scale}px` });
      selIdeas.clear(); base.forEach((id) => selIdeas.add(id));
      for (const [id, n] of nodes) {
        const b = n.node.getBoundingClientRect();
        if (b.left < a.r && b.right > a.l && b.top < a.b && b.bottom > a.t) selIdeas.add(id);
      }
      paintIdeaSel();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      box.remove();
      if (!shown) {
        // Click to Idea: a plain click on open ice clears a selection, or — with nothing selected — births
        // a fresh pill right there, ready to type.
        const had = selIdeas.size;
        selIdeas.clear(); base.forEach((id) => selIdeas.add(id)); paintIdeaSel();
        if (!had && !base.size) newIdeaAt(sx, sy);
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function newIdeaAt(cx, cy) {
    if (ideaView === 'shared' ? !poolOk() : !mineReady) { toast('One moment — still opening your ideas.', { ms: 1800 }); return; }
    const fr = field.getBoundingClientRect();
    const scale = fr.width / (field.clientWidth || 1);
    const W = field.clientWidth, H = field.clientHeight;
    // Born under the cursor (Nov 22): the click point is the pill's top-left corner, dead on. A pill's
    // stored x/y is a fraction of the room left beside it, so it's worked out again once its real size is known.
    const px = Math.max(0, Math.min(W - 24, (cx - fr.left) / scale)), py = Math.max(0, Math.min(H - 24, (cy - fr.top) / scale));
    const pw = 150, ph = 36;
    const x = clamp01(px / Math.max(1, W - pw));
    const y = clamp01(py / Math.max(1, H - ph));
    const id = uid();
    pinned.set(id, { px, py });
    commitIdeas([...ideas(), { id, text: '', by: me?.id || null, t0: Date.now(), parked: true, mv: me?.id || null, x, y, vx: 0, vy: 0 }]);
    let tries = 0;
    const open = () => {
      const n = nodes.get(id);
      if (!n) { if (tries++ < 10) requestAnimationFrame(open); return; }
      n.node.style.transform = tf(Math.round(px), Math.round(py), n.tilt);
      editIdea(n.node, id);
    };
    requestAnimationFrame(open);
  }

  // Drag one of several selected ideas: they all move together (and can all land on your Path).
  function dragGroup(e, lead) {
    const fr0 = field.getBoundingClientRect();
    const scale = fr0.width / (field.clientWidth || 1);
    const W = field.clientWidth, H = field.clientHeight;
    const t0 = Date.now();
    const group = ideas().filter((q) => selIdeas.has(q.id)).map((q) => {
      const n = nodes.get(q.id);
      const rx = Math.max(1, W - (n?.node.offsetWidth || 0)), ry = Math.max(1, H - (n?.node.offsetHeight || 0));
      const m = motion(q, t0);
      return { q, n, rx, ry, x0: m.x * rx, y0: m.y * ry, fx: m.x * rx, fy: m.y * ry };
    });
    groupIds = new Set(group.map((g) => g.q.id));
    hold++;
    group.forEach((g) => { g.n?.node.classList.add('is-held'); if (g.n) g.n.node.style.transform = tf(Math.round(g.fx), Math.round(g.fy), g.n.tilt, true); });
    const sx = e.clientX, sy = e.clientY;
    let moved = false, over = null, last = null;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      if (!moved) { moved = true; document.body.classList.add('fi-dragging'); }
      last = ev;
      const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
      for (const g of group) {
        g.fx = Math.max(0, Math.min(g.rx, g.x0 + dx)); g.fy = Math.max(0, Math.min(g.ry, g.y0 + dy));
        if (g.n) { g.n.node.style.transform = tf(Math.round(g.fx), Math.round(g.fy), g.n.tilt, true); sideTo(g.n.node, g.fx, g.n.node.offsetWidth, W); }
      }
      const col = pathColAt(ev.clientX, ev.clientY);
      if (col !== over) { over?.classList.remove('fi-drop-on'); over = col; over?.classList.add('fi-drop-on'); }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      over?.classList.remove('fi-drop-on');
      document.body.classList.remove('fi-dragging');
      group.forEach((g) => g.n?.node.classList.remove('is-held'));
      groupIds = null;
      const now = Date.now();
      if (moved && ev?.type === 'pointerup' && pathColAt(ev.clientX, ev.clientY)) {
        const gone = new Set();
        let column = '';
        for (const g of group) {
          const detail = { x: ev.clientX, y: ev.clientY, text: g.q.text, handled: false, column: '' };
          window.dispatchEvent(new CustomEvent('architect:drop-task', { detail }));
          if (detail.handled) { gone.add(g.q.id); column = detail.column; }
        }
        if (gone.size) {
          commitIdeas(ideas().filter((q) => !gone.has(q.id)));
          gone.forEach((id) => selIdeas.delete(id));
          toast(`Pinned ${gone.size} to ${column || 'your Path'}.`, { ms: 2200 });
          release();
          return;
        }
      }
      if (moved) {
        const at = new Map(group.map((g) => [g.q.id, { x: clamp01(g.fx / g.rx), y: clamp01(g.fy / g.ry) }]));
        commitIdeas(ideas().map((q) => (at.has(q.id) ? { ...q, ...at.get(q.id), vx: 0, vy: 0, t0: now, parked: false, mv: me?.id || null } : q)));
      } else if (ev?.type === 'pointerup') { selIdeas.clear(); selIdeas.add(lead); paintIdeaSel(); }
      release();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  const selectedIdeas = () => ideas().filter((q) => selIdeas.has(q.id));
  async function copyIdeas() {
    const text = selectedIdeas().map((q) => q.text).join('\n');
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); toast(`Copied ${selIdeas.size} idea${selIdeas.size === 1 ? '' : 's'}.`, { ms: 1400 }); return true; }
    catch { toast('Couldn’t reach the clipboard.', { tone: 'error' }); return false; }
  }
  function deleteIdeas() {
    const n = selIdeas.size;
    if (!n) return;
    commitIdeas(ideas().filter((q) => !selIdeas.has(q.id)));
    selIdeas.clear();
    toast(`Let ${n} idea${n === 1 ? '' : 's'} go.`, { ms: 3200, action: { label: 'Undo', onClick: () => undoIdeas() } });
  }
  // New ideas from text (paste, or returning from the Path). at = { x, y } in 0..1 of the field.
  function addIdeas(texts, at = null) {
    const now = Date.now();
    const fresh = texts.map((text, i) => ({
      id: uid(), text, by: me?.id || null, t0: now, parked: false, mv: me?.id || null,
      x: clamp01((at ? at.x : 0.1 + Math.random() * 0.8) + (at ? (i % 4) * 0.04 : 0)),
      y: clamp01((at ? at.y : 0.15 + Math.random() * 0.6) + (at ? Math.floor(i / 4) * 0.08 + (i % 4) * 0.02 : 0)),
      vx: at ? 0 : (Math.random() - 0.5) * 0.3, vy: at ? 0 : (Math.random() - 0.5) * 0.3,
    }));
    commitIdeas([...ideas(), ...fresh]);
    selIdeas.clear(); fresh.forEach((q) => selIdeas.add(q.id));
    return fresh;
  }

  stage.addEventListener('keydown', (e) => {
    if (tab !== 'ideas' || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    let hit = true;
    if (mod && k === 'a') { ideas().forEach((q) => selIdeas.add(q.id)); paintIdeaSel(); }
    else if (mod && k === 'z') undoIdeas(e.shiftKey);
    else if (mod && k === 'y') undoIdeas(true);
    else if (mod && k === 'c' && selIdeas.size) copyIdeas();
    else if (mod && k === 'x' && selIdeas.size) copyIdeas().then((ok) => ok && deleteIdeas());
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selIdeas.size) deleteIdeas();
    else if (e.key === 'Escape' && selIdeas.size) { selIdeas.clear(); paintIdeaSel(); }
    else hit = false;
    if (hit) { e.preventDefault(); e.stopPropagation(); }
  });

  // A task sent back from the Path lands here as an idea.
  const onDropIdea = (e) => {
    const d = e.detail;
    if (!d || d.handled || !d.texts?.length || !box.isConnected || box.offsetParent === null) return;
    let at = null;
    if (d.x != null) {
      const hit = document.elementFromPoint(d.x, d.y)?.closest?.('.fi');
      if (hit !== box) return;
      if (tab === 'ideas' && field) { const fr = field.getBoundingClientRect(); at = { x: clamp01((d.x - fr.left) / fr.width - 0.05), y: clamp01((d.y - fr.top) / fr.height - 0.04) }; }
    }
    d.handled = true;
    addIdeas(d.texts, at);
    if (tab === 'ideas') paintIdeaSel();
  };
  window.addEventListener('architect:drop-idea', onDropIdea);

  // A Path column you can drop on: yours, under the pointer.
  function pathColAt(x, y) {
    const t = document.elementFromPoint(x, y);
    const col = t?.closest?.('[data-col]');
    return col && col.closest('.paths') && !col.closest('.paths.is-readonly') ? col : null;
  }

  /* ================= STORY ================= */
  function dayNav() {
    const today = storyKey();
    const d = parseKey(day);
    const step = (n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); const k = keyOf(x); if (k <= today) { day = k; paint(); } };
    return [
      h('button', { class: 'fi-nav', type: 'button', 'aria-label': 'Previous day', onclick: () => step(-1) }, icon('chevronLeft', 15)),
      h('button', { class: ['fi-day', day === today && 'is-today'], type: 'button', title: 'Back to today', onclick: () => { day = today; paint(); } },
        day === today ? 'TODAY' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()),
      h('button', { class: 'fi-nav', type: 'button', 'aria-label': 'Next day', disabled: day >= today, onclick: () => step(1) }, icon('chevronRight', 15)),
    ];
  }

  const PT = 44, PB = 52; // room for the GM / NEW MORNING labels
  let tl = null;

  // Nov 19 — Story opens to the sides: no hard borders. x is a fraction of the column (0..1 is the old
  // width) and can run past either side; the canvas grows sideways to hold whatever was pulled out, and
  // a faint connector keeps each off-spine entry tied to its point in the day.
  const X_MIN = -1.4, X_MAX = 2.4;
  const clampX = (v) => Math.min(X_MAX, Math.max(X_MIN, v));
  function renderStory() {
    const keep = stage.scrollTop;
    const keepLeft = tl && stage.contains(tl) ? stage.scrollLeft - (Number(tl.dataset.extl) || 0) : null;
    const list = [...story(), ...uploads.filter((u) => u.day === day)].sort((a, b) => a.m - b.m);
    // Nov 26: the day's length is fixed; zoom scales the whole timeline (cards, words, marks, spine) together.
    const H = Math.max(stage.clientHeight || 520, 1560);
    const TH = H - PT - PB;
    const yOf = (m) => PT + (m / 1440) * TH;
    const W0 = Math.max(260, (stage.clientWidth || 600) - 32);
    const xs = list.map((f) => f.x ?? 0.5);
    const lo = Math.min(0, ...xs.map((x) => x - 0.2)), hi = Math.max(1, ...xs.map((x) => x + 0.2));
    const extL = Math.round(-lo * W0), extR = Math.round((hi - 1) * W0);
    tl = h('div', { class: ['fi-tl', (extL || extR) && 'is-wide'], style: { height: `${H}px`, width: `${W0}px`, marginLeft: `${16 + extL}px`, marginRight: `${16 + extR}px` } },
      h('i', { class: 'fi-spine', style: { top: `${PT - 14}px`, bottom: `${PB - 18}px` } }),
      h('span', { class: 'fi-mark is-top fi-splabel', style: { top: `${PT - 34}px`, '--sp': SETPOINTS[0].color } }, 'GM'),
      ...SETPOINTS.slice(1).map((s) => h('i', { class: 'fi-tick', style: { top: `${yOf(s.from)}px`, '--sp': s.color }, title: `${s.label} · ${clockOf(s.from)}` })),
      // Set-Point names beside their marks, large in Doto (Nov 25).
      ...SETPOINTS.slice(1).map((s) => h('span', { class: 'fi-splabel', style: { top: `${yOf(s.from)}px`, '--sp': s.color } }, s.label)),
      // Faint time marks the moments snap to (hours; half hours once zoomed in).
      ...hourMarks(yOf),
      h('span', { class: 'fi-mark is-bottom', style: { top: `${PT + TH + 8}px` } }, 'NEW MORNING'),
      h('i', { class: 'fi-tick is-end', style: { top: `${PT + TH}px` } }));
    tl.dataset.th = TH;
    tl.dataset.extl = extL;
    if (day === storyKey()) { const now = storyMin(); tl.append(h('span', { class: 'fi-now', style: { top: `${yOf(now)}px`, '--sp': spOf(now).color }, title: `Now · ${clockOf(now)}` }, h('i'), h('b', {}, 'NOW'))); }
    if (!list.length) tl.append(h('p', { class: 'fi-story-empty' }, day === storyKey() ? 'Nothing told yet today.' : 'An untold day.', h('br'), 'Click anywhere on the line to tell a moment, or drop photos and videos on it.'));
    for (const f of list) tl.append(fragment(f, yOf));
    tl.append(guide, dragTime);
    applyZoom();
    lookupWho(list.map((f) => f.by), () => { if (tab === 'story') refresh(); });
    stage.replaceChildren(tl);
    stage.scrollTop = keep;
    stage.scrollLeft = extL + (keepLeft ?? 0);
    requestAnimationFrame(() => tl?.querySelectorAll('.fi-frag').forEach(connect));
  }

  // A mark every hour (every half hour once there's room); a new or moved moment snaps to the nearest one.
  const markStep = () => 60;
  function hourMarks(yOf) {
    const out = [];
    const st = markStep();
    for (let m = st; m < 1440; m += st) {
      if (SETPOINTS.some((s) => s.from === m)) continue;
      out.push(h('i', { class: ['fi-hmark', m % 60 && 'is-half'], style: { top: `${yOf(m)}px` } }, m % 60 ? null : h('em', {}, clockOf(m))));
    }
    return out;
  }
  // Snap to the nearest time mark (and Set-Point); Alt places it freely, between marks.
  const snapM = (m, free) => {
    if (free) return m;
    const st = markStep() / 2; // quarter / half hours: close marks without fighting the drag
    const marks = SETPOINTS.map((s) => s.from);
    const near = marks.find((x) => Math.abs(x - m) <= 8);
    return near != null ? near : Math.min(1439, Math.max(0, Math.round(m / st) * st));
  };
  // The placement guide: a line across the timeline where the moment will land, and a large clock.
  const guide = h('i', { class: 'fi-guide', hidden: true });
  const dragTime = h('span', { class: 'fi-dragtime', hidden: true });
  function showGuide(m, x) {
    if (!tl) return;
    const TH = Number(tl.dataset.th);
    const y = PT + (m / 1440) * TH;
    const sp = spOf(m);
    guide.hidden = false; dragTime.hidden = false;
    guide.style.top = `${y}px`; guide.style.setProperty('--sp', sp.color);
    dragTime.style.top = `${y}px`;
    dragTime.style.left = `${Math.min(92, Math.max(8, x * 100))}%`;
    dragTime.replaceChildren(h('b', {}, clockOf(m)), h('span', {}, sp.label));
    dragTime.style.setProperty('--sp', sp.color);
  }
  const hideGuide = () => { guide.hidden = true; dragTime.hidden = true; };

  function fragment(f, yOf) {
    const sp = spOf(f.m);
    const label = h('span', { class: 'fi-frag-sp' }, sp.label, h('em', {}, clockOf(f.m)));
    let content;
    if (f.kind === 'photo') {
      const url = urlOf(f.path, () => tab === 'story' && refresh());
      content = [h('span', { class: 'fi-polaroid' }, url ? h('img', { src: url, alt: f.text || '', loading: 'lazy', draggable: false }) : h('span', { class: 'fi-ph' })),
        f.text ? h('span', { class: 'fi-frag-text' }, f.text) : null];
    } else if (f.kind === 'video') {
      content = [h('span', { class: 'fi-play' }, icon('play', 20)),
        h('span', { class: 'fi-vid-meta' }, h('span', { class: 'fi-frag-text' }, f.text || (f.name || 'video').replace(/\.\w+$/, '')), f.dur ? h('small', {}, fmtDur(f.dur)) : null)];
    } else content = [h('span', { class: 'fi-frag-text' }, f.text)];
    const more = h('button', { class: 'fi-frag-more', type: 'button', 'aria-label': 'Fragment options', onclick: (e) => { e.stopPropagation(); fragMenu(e.currentTarget, f); } }, icon('more', 14));
    const card = h('div', { class: ['fi-card', `is-${f.kind}`, f.uploading && 'is-uploading'], style: { '--sp': sp.color } }, label, whoHead(f), ...content, f.uploading ? h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')) : more);
    const x = f.x ?? 0.5;
    const far = x < 0.1 || x > 0.9; // pulled out into the open space: it sits a touch askew, like a loose note
    if (far) card.style.rotate = `${(glassOf(f.id).tilt * 0.55).toFixed(2)}deg`;
    const node = h('div', { class: ['fi-frag', far && 'is-off', f.tl && 'is-tl', selFr.has(f.id) && 'is-sel', frontId === f.id && 'is-front'], 'data-id': f.id, style: { top: `${yOf(f.m)}px`, left: `${x * 100}%` } }, card);
    if (!f.uploading) bindFrag(node, card, label, f);
    return node;
  }

  // The head of a Story event: whose it is, at a glance.
  function whoHead(f) {
    const id = f.by || (f.uploading ? me?.id : null);
    const name = (id === me?.id ? me?.username : null) || f.byName || whoNames.get(id) || (id ? '…' : 'Someone');
    const face = id ? whoFaces.get(id) : null;
    return h('span', { class: ['fi-who', id === me?.id && 'is-me'], title: name },
      h('span', { class: 'fi-who-face' }, face ? h('img', { src: face, alt: '', draggable: false }) : String(name || '?').replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '?'),
      h('b', {}, name));
  }

  // Dotted line from the card to the spine, with a dot where it lands.
  function connect(node) {
    node.querySelector('.fi-link')?.remove();
    const card = node.querySelector('.fi-card');
    if (!tl || !card) return;
    const mid = tl.clientWidth / 2;
    const at = node.offsetLeft, half = card.offsetWidth / 2;
    const topLeft = node.classList.contains('is-tl'); // anchored by its corner, not its middle
    const left = topLeft ? at : at - half, right = topLeft ? at + half * 2 : at + half;
    let a = null;
    if (right < mid - 6) a = { cls: 'to-r', from: right - at, len: mid - right };   // card on the left: line runs right to the spine
    else if (left > mid + 6) a = { cls: 'to-l', from: mid - at, len: left - mid }; // card on the right
    if (!a) return;
    node.prepend(h('i', { class: ['fi-link', a.cls], style: { left: `${a.from}px`, width: `${a.len}px`, top: topLeft ? `${card.offsetHeight / 2}px` : '' } }));
  }

  function bindFrag(node, card, label, f) {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, [contenteditable="true"]')) return;
      e.preventDefault();
      // Ctrl/⌘-click: add to (or take out of) the selection, without moving anything.
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        if (selFr.has(f.id)) selFr.delete(f.id); else selFr.add(f.id);
        node.classList.toggle('is-sel', selFr.has(f.id));
        return;
      }
      if (!selFr.has(f.id) && selFr.size) { selFr.clear(); tl?.querySelectorAll('.fi-frag.is-sel').forEach((n) => n.classList.remove('is-sel')); }
      const TH = Number(tl.dataset.th);
      const tr = tl.getBoundingClientRect();
      const scale = tr.width / (tl.clientWidth || 1);
      const sx = e.clientX, sy = e.clientY;
      // Moving a selected moment moves the whole selection; the time between them stays the same.
      const group = selFr.has(f.id) && selFr.size > 1 ? story().filter((q) => selFr.has(q.id)) : [f];
      const starts = new Map(group.map((q) => [q.id, { m: q.m, x: q.x ?? 0.5, node: tl.querySelector(`.fi-frag[data-id="${CSS.escape(q.id)}"]`) }]));
      const lo = Math.min(...group.map((q) => q.m)), hi = Math.max(...group.map((q) => q.m));
      const x0 = f.x ?? 0.5, m0 = f.m;
      let moved = false, dm = 0, dxf = 0, cancelled = false;
      hold++;
      const place = () => {
        for (const [id, st] of starts) {
          if (!st.node) continue;
          const m = st.m + dm, x = clampX(st.x + dxf);
          st.node.style.left = `${x * 100}%`;
          st.node.style.top = `${PT + (m / 1440) * TH}px`;
          const c = st.node.querySelector('.fi-card'), lb = st.node.querySelector('.fi-frag-sp');
          const sp = spOf(m);
          c?.style.setProperty('--sp', sp.color);
          if (lb) { lb.firstChild.textContent = sp.label; lb.querySelector('em').textContent = clockOf(m); }
        }
      };
      const move = (ev) => {
        const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) { moved = true; starts.forEach((st) => { st.node?.classList.add('is-moving'); st.node?.querySelector('.fi-link')?.remove(); }); }
        dxf = clampX(x0 + dx / tl.clientWidth) - x0;
        const target = snapM(Math.round(Math.min(1439, Math.max(0, m0 + (dy / TH) * 1440))), ev.altKey);
        dm = Math.max(-lo, Math.min(1439 - hi, target - m0));
        place();
        showGuide(m0 + dm, x0 + dxf);
      };
      const end = () => {
        card.removeEventListener('pointermove', move);
        card.removeEventListener('pointerup', up);
        card.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', onEsc, true);
        starts.forEach((st) => st.node?.classList.remove('is-moving'));
        hideGuide();
      };
      // Esc while dragging puts everything back where it was.
      const onEsc = (ev) => {
        if (ev.key !== 'Escape' || !moved) return;
        ev.preventDefault(); ev.stopImmediatePropagation();
        cancelled = true; dm = 0; dxf = 0; place(); end();
        try { card.releasePointerCapture(e.pointerId); } catch {}
        release(); refresh();
      };
      const up = () => {
        if (cancelled) return;
        end();
        if (moved && (dm || dxf)) {
          const before = story();
          undoMoves.push({ day, list: before }); if (undoMoves.length > 40) undoMoves.shift();
          setStory(day, before.map((q) => (starts.has(q.id) ? { ...q, m: q.m + dm, x: Math.round(clampX((q.x ?? 0.5) + dxf) * 1000) / 1000 } : q)));
          release();
          return;
        }
        release();
        if (moved) { refresh(); return; }
        // Single click opens the photo/video; a double click edits the caption instead.
        if (f.kind === 'photo' || f.kind === 'video') { clearTimeout(card._open); card._open = setTimeout(() => lightbox(f), 240); }
      };
      window.addEventListener('keydown', onEsc, true);
      card.setPointerCapture(e.pointerId);
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerup', up);
      card.addEventListener('pointercancel', up);
    });
    card.addEventListener('dblclick', (e) => { clearTimeout(card._open); if (!e.target.closest('button')) editFrag(card, f); });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Cards stacked on top of each other: pick the one you mean — the others stay where they are.
      const stack = [...new Set(document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.('.fi-frag[data-id]')).filter((n) => n && tl?.contains(n)))];
      if (stack.length > 1) {
        const all = story();
        menu({ x: e.clientX, y: e.clientY }, [
          { header: `${stack.length} moments here` },
          ...stack.map((n) => all.find((q) => q.id === n.dataset.id)).filter(Boolean).map((q) => ({
            label: `${clockOf(q.m)} · ${(q.text || (q.kind === 'photo' ? 'Photo' : q.kind === 'video' ? 'Video' : 'Moment')).replace(/\s+/g, ' ').slice(0, 42)}`,
            icon: q.kind === 'photo' ? 'image' : q.kind === 'video' ? 'play' : 'note', checked: q.id === frontId,
            onSelect: () => { frontId = q.id; tl?.querySelectorAll('.fi-frag.is-front').forEach((x) => x.classList.remove('is-front')); tl?.querySelector(`.fi-frag[data-id="${CSS.escape(q.id)}"]`)?.classList.add('is-front'); },
          })),
          '-',
          { label: 'Options for the top one…', icon: 'more', onSelect: () => fragMenu({ x: e.clientX, y: e.clientY }, f) },
        ]);
        return;
      }
      fragMenu({ x: e.clientX, y: e.clientY }, f);
    });
  }

  // Ctrl+Z steps back the last move in Story (while you're working in it).
  let storyActive = false;
  box.addEventListener('pointerdown', () => { storyActive = true; }, true);
  const offActive = (e) => { if (!box.contains(e.target)) storyActive = false; };
  document.addEventListener('pointerdown', offActive, true);
  const onUndoKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    if (!storyActive || view() !== 'story' || !box.isConnected || e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    const last = undoMoves.pop();
    if (!last) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (last.day !== day) { day = last.day; }
    setStory(last.day, last.list);
    paint();
  };
  window.addEventListener('keydown', onUndoKey, true);
  // A click on open line clears the selection.
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.fi-frag') || !selFr.size) return;
    selFr.clear(); tl?.querySelectorAll('.fi-frag.is-sel').forEach((n) => n.classList.remove('is-sel'));
  });

  /* ---------- zoom and pan through the day (desktop and phone) ---------- */
  function zoomBtns() {
    return [
      h('button', { class: 'fi-nav fi-zoom', type: 'button', 'aria-label': 'Zoom out — more of the day', title: 'Zoom out (Ctrl + wheel)', onclick: () => setZoomT(zoomT / 1.35) }, icon('minus', 14)),
      h('button', { class: 'fi-nav fi-zoom', type: 'button', 'aria-label': 'Zoom in — more room between moments', title: 'Zoom in (Ctrl + wheel)', onclick: () => setZoomT(zoomT * 1.35) }, icon('plus', 14)),
    ];
  }
  // Keep the moment under the pointer (or the middle of the view) where it is while the scale changes.
  function applyZoom() { if (tl) tl.style.zoom = zoomT === 1 ? '' : String(zoomT); }
  function setZoomT(z, at = null) {
    z = Math.min(4, Math.max(0.4, z));
    if (!tl || Math.abs(z - zoomT) < 0.001) { zoomT = z; remember(); applyZoom(); return; }
    const sr = stage.getBoundingClientRect();
    const k = (sr.width / (stage.offsetWidth || 1)) || 1;       // the board's own zoom around the object
    const py = at?.y != null ? (at.y - sr.top) / k : stage.clientHeight / 2;
    const px = at?.x != null ? (at.x - sr.left) / k : stage.clientWidth / 2;
    // the point of the timeline under the pointer stays under the pointer
    const ux = (stage.scrollLeft + px) / zoomT, uy = (stage.scrollTop + py) / zoomT;
    zoomT = z; remember();
    applyZoom();
    stage.scrollLeft = Math.max(0, ux * zoomT - px);
    stage.scrollTop = Math.max(0, uy * zoomT - py);
  }
  stage.addEventListener('wheel', (e) => {
    if (view() !== 'story' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); e.stopPropagation();
    setZoomT(zoomT * Math.exp(-e.deltaY * 0.0022), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  // Two fingers pinch to zoom; one finger scrolls (pans) as usual.
  const touches = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || view() !== 'story') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoomT, y: (a.y + b.y) / 2 };
      e.stopPropagation();
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    clearTimeout(pinch.t);
    const z = pinch.z * (d / pinch.d);
    pinch.t = setTimeout(() => setZoomT(z, { x: (a.x + b.x) / 2, y: pinch?.y ?? (a.y + b.y) / 2 }), 16);
  });
  const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  stage.addEventListener('pointerup', endTouch);
  stage.addEventListener('pointercancel', endTouch);

  /* ---------- full screen (and back, without losing your place) ---------- */
  let fullHome = null;
  function fullBtn() {
    return h('button', { class: ['fi-nav', 'fi-full-btn', full && 'is-on'], type: 'button', 'aria-pressed': String(full), 'aria-label': full ? 'Back to the split view' : 'Full screen', title: full ? 'Back (Esc)' : 'Full screen — more room to arrange moments', onclick: () => setFull(!full) }, icon(full ? 'exitFullscreen' : 'fullscreen', 15));
  }
  function setFull(on) {
    if (on === full) return;
    const sr = stage.getBoundingClientRect();
    const k = (sr.width / (stage.offsetWidth || 1)) || 1;
    const TH0 = tl ? Number(tl.dataset.th) : 0;
    const mid = tl ? ((stage.scrollTop + stage.clientHeight / 2) / zoomT - PT) / (TH0 || 1) : null;
    full = on;
    if (on) {
      // Moved to the top of the page (the board may be zoomed or transformed): the same element, so
      // everything you were doing — selection, a card being written — stays as it is.
      fullHome = { parent: box.parentNode, next: box.nextSibling };
      const layer = h('div', { class: 'fi-full-layer' });
      document.body.append(layer);
      layer.append(box);
      box.classList.add('is-full');
    } else if (fullHome) {
      const layer = box.parentNode;
      if (fullHome.parent?.isConnected) fullHome.parent.insertBefore(box, fullHome.next && fullHome.next.parentNode === fullHome.parent ? fullHome.next : null);
      layer?.classList.contains('fi-full-layer') && layer.remove();
      box.classList.remove('is-full');
      fullHome = null;
    }
    void k;
    paint();
    if (mid != null && tl) { const TH1 = Number(tl.dataset.th); stage.scrollTop = Math.max(0, (PT + mid * TH1) * zoomT - stage.clientHeight / 2); }
  }
  const onFullEsc = (e) => {
    if (!full || e.key !== 'Escape' || hold > 0 || document.querySelector('.menu, .dlg, .lb')) return;
    e.preventDefault(); e.stopImmediatePropagation(); setFull(false);
  };
  window.addEventListener('keydown', onFullEsc, true);

  function fragMenu(anchor, f) {
    menu(anchor, [
      { label: f.kind === 'text' ? 'Edit' : f.text ? 'Edit caption' : 'Add a caption', icon: 'edit', onSelect: () => { const c = tl?.querySelector(`.fi-frag[data-id="${f.id}"] .fi-card`); if (c) editFrag(c, f); } },
      day === storyKey() ? { label: 'Move to now', icon: 'clock', onSelect: () => setStory(day, story().map((q) => (q.id === f.id ? { ...q, m: storyMin() } : q))) } : null,
      f.kind !== 'text' ? { label: f.kind === 'video' ? 'Play' : 'View', icon: f.kind === 'video' ? 'play' : 'eye', onSelect: () => lightbox(f) } : null,
      '-',
      { label: 'Remove from story', icon: 'trash', danger: true, onSelect: () => setStory(day, story().filter((q) => q.id !== f.id)) },
    ].filter(Boolean), { align: 'end' });
  }

  function mediaBtn() {
    return h('button', { class: 'fi-nav fi-media', type: 'button', title: 'Add photos or videos', 'aria-label': 'Add photos or videos', onclick: () => pickMedia().then((f) => addMediaToStory(f)) }, icon('image', 15));
  }
  // Click to Story: a left click on open line births a card right there — the time is where you
  // clicked, and so is the side. Empty when you leave it? It goes away again.
  let downAt = null;
  stage.addEventListener('pointerdown', (e) => { downAt = e.button === 0 && !stage.querySelector('[contenteditable="true"]') ? { x: e.clientX, y: e.clientY } : null; }, true);
  stage.addEventListener('click', (e) => {
    if (view() !== 'story' || !tl || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    if (e.target.closest('.fi-frag, button, a, input, [contenteditable="true"], .fi-story-empty button')) return;
    const r = tl.getBoundingClientRect();
    const TH = Number(tl.dataset.th);
    const k = r.width / (tl.clientWidth || 1); // the Space's zoom: screen px → timeline px
    const y = (e.clientY - r.top) / k;
    if (y < PT - 30 || y > PT + TH + 20) return;
    const m = snapM(Math.round(Math.min(1439, Math.max(0, ((y - PT) / TH) * 1440))), e.altKey); // Alt: between marks
    const x = clampX((e.clientX - r.left) / r.width);
    // Born under the cursor (Nov 22): the click is the new card's top-left corner, not its middle.
    const frag = addFragment({ kind: 'text', text: '', tl: true }, day, { m, x });
    requestAnimationFrame(() => {
      const card = tl?.querySelector(`.fi-frag[data-id="${frag.id}"] .fi-card`);
      if (card) editFrag(card, frag);
    });
  });

  // Nov 24 — hold the right mouse button and drag to pan Story in any direction (left/right included), so
  // cards beside the timeline are in reach without the horizontal scrollbar. Scrolling still works as
  // before; a right-click that doesn't move still opens the menu, a right-drag only pans.
  let rpan = null, eatMenuUntil = 0;
  const zoomK = () => (stage.getBoundingClientRect().width / (stage.offsetWidth || 1)) || 1;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || e.pointerType !== 'mouse' || view() !== 'story') return;
    if (e.target.closest('[contenteditable="true"], input, textarea')) return;
    rpan = { id: e.pointerId, x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop, k: zoomK(), moved: false, menu: null, raf: 0, nx: 0, ny: 0 };
    e.stopPropagation();
    window.addEventListener('pointermove', rpanMove, true);
    window.addEventListener('pointerup', rpanUp, true);
    window.addEventListener('pointercancel', rpanUp, true);
  });
  function rpanMove(e) {
    if (!rpan || e.pointerId !== rpan.id) return;
    const dx = e.clientX - rpan.x, dy = e.clientY - rpan.y;
    if (!rpan.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      rpan.moved = true;
      stage.classList.add('is-rpanning');
      try { stage.setPointerCapture(e.pointerId); } catch {}
    }
    e.preventDefault(); e.stopPropagation();
    rpan.nx = rpan.l - dx / rpan.k; rpan.ny = rpan.t - dy / rpan.k;
    if (!rpan.raf) rpan.raf = requestAnimationFrame(() => { if (!rpan) return; rpan.raf = 0; stage.scrollLeft = rpan.nx; stage.scrollTop = rpan.ny; });
  }
  function rpanUp(e) {
    if (!rpan || e.pointerId !== rpan.id) return;
    const p = rpan;
    rpan = null;
    window.removeEventListener('pointermove', rpanMove, true);
    window.removeEventListener('pointerup', rpanUp, true);
    window.removeEventListener('pointercancel', rpanUp, true);
    stage.classList.remove('is-rpanning');
    if (p.raf) { cancelAnimationFrame(p.raf); stage.scrollLeft = p.nx; stage.scrollTop = p.ny; }
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    if (p.moved) { eatMenuUntil = Date.now() + 400; return; } // Windows sends the menu after the button comes up
    // A plain right-click whose menu arrived while the button was still down (macOS): open it now.
    if (p.menu) p.menu.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.menu.x, clientY: p.menu.y, button: 2, buttons: 0 }));
  }
  stage.addEventListener('contextmenu', (e) => {
    if (rpan && e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); rpan.menu = { target: e.target, x: e.clientX, y: e.clientY }; return; }
    if (Date.now() < eatMenuUntil && e.isTrusted) { eatMenuUntil = 0; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  function editFrag(card, f) {
    let t = card.querySelector('.fi-frag-text');
    if (!t) { t = h('span', { class: 'fi-frag-text' }); card.append(t); }
    if (t.isContentEditable) return;
    hold++;
    t.contentEditable = 'true';
    t.focus();
    document.getSelection()?.selectAllChildren(t);
    const done = (save) => {
      t.removeEventListener('blur', onBlur);
      t.removeEventListener('keydown', onKey);
      t.contentEditable = 'false';
      const text = t.innerText.replace(/\n{3,}/g, '\n\n').trim();
      if (save && text !== (f.text || '') && (text || f.kind !== 'text')) setStory(day, story().map((q) => (q.id === f.id ? { ...q, text } : q)));
      else if ((save || !f.text) && !text && f.kind === 'text') setStory(day, story().filter((q) => q.id !== f.id)); // an empty card goes away
      release();
      if (!save) refresh();
    };
    const onBlur = () => done(true);
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); t.blur(); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    t.addEventListener('blur', onBlur);
    t.addEventListener('keydown', onKey);
  }

  // Where a new fragment lands: now (today) or after the last one (other days), on whichever side of
  // the spine has room, so cards don't pile on top of each other.
  function nextSpot(k, list) {
    const GAP = 110; // minutes of line a card needs on its side
    const m = k === storyKey() ? storyMin() : Math.min(1439, list.length ? Math.max(...list.map((q) => q.m)) + 75 : 30);
    // Busy stretches spread outwards instead of stacking: near columns first, then the open space.
    // Lanes are a card's width apart, so neighbours never overlap however narrow the widget is.
    const W0 = Math.max(260, (stage.clientWidth || 600) - 32);
    const step = Math.max(0.42, 300 / W0);
    const lane = (x) => list.some((q) => Math.abs((q.x ?? 0.5) - x) < step / 2 && Math.abs(q.m - m) < GAP);
    const last = [...list].sort((a, b) => b.m - a.m)[0];
    const leftFirst = !(last && (last.x ?? 0.5) < 0.5);
    const L = (k) => clampX(0.29 - k * step), R = (k) => clampX(0.71 + k * step);
    const order = [];
    for (let k = 0; k < 3; k++) order.push(...(leftFirst ? [L(k), R(k)] : [R(k), L(k)]));
    return { m, x: order.find((x) => !lane(x)) ?? order[0] };
  }

  function addFragment(f, k = day, at = null) {
    const list = story(k);
    const spot = at || nextSpot(k, list);
    const frag = { id: uid(), by: me?.id || null, byName: me?.username || null, at: Date.now(), ...spot, ...f };
    setStory(k, [...list, frag]);
    if (k !== day && tab === 'story') { day = k; paint(); }
    return frag;
  }

  async function addMediaToStory(files, at = null) {
    if (!files?.length) return;
    const k = day;
    let spot = at || nextSpot(k, story(k));
    for (const file of files) {
      const temp = { id: uid(), day: k, kind: /^video\//.test(file.type) ? 'video' : 'photo', text: '', name: file.name, uploading: true, ...spot };
      uploads.push(temp);
      if (tab === 'story' && day === k) refresh();
      try {
        const up = await uploadMedia(file);
        addFragment({ kind: up.kind, path: up.path, name: up.name, dur: up.dur, text: '' }, k, { m: temp.m, x: temp.x });
      } catch (e) { toast(e?.message ? `${e.message}` : friendlyError(e), { tone: 'error', ms: 5000 }); }
      uploads = uploads.filter((u) => u.id !== temp.id);
      if (tab === 'story') refresh();
      spot = { m: Math.min(1439, spot.m + 40), x: spot.x < 0.5 ? 0.71 : 0.29 };
    }
  }

  // Drop photos/videos where they belong on the line.
  stage.addEventListener('dragover', (e) => {
    if (view() !== 'story' && view() !== 'ideas') return; // not onto the open calendar
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    stage.classList.add('is-drop');
  });
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('is-drop'); });
  stage.addEventListener('drop', (e) => {
    stage.classList.remove('is-drop');
    const files = mediaFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    if (tab === 'ideas') { if (only) return; day = storyKey(); setTab('story'); addMediaToStory(files); return; }
    const r = tl.getBoundingClientRect();
    const scale = r.width / (tl.clientWidth || 1);
    const TH = Number(tl.dataset.th);
    const m = Math.round(Math.min(1439, Math.max(0, (((e.clientY - r.top) / scale - PT) / TH) * 1440)));
    const x = clampX((e.clientX - r.left) / r.width);
    addMediaToStory(files, { m, x });
  });

  /* ================= TRACKER ================= */
  function dominant(list) {
    if (!list.length) return null;
    const n = new Map();
    for (const f of list) { const s = spOf(f.m).id; n.set(s, (n.get(s) || 0) + 1); }
    return SETPOINTS.reduce((best, s) => ((n.get(s.id) || 0) > (n.get(best.id) || 0) ? s : best), SETPOINTS.find((s) => n.has(s.id)));
  }

  function renderTracker() {
    const today = storyKey();
    const first = mondayOf(month);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      if (i >= 28 && i % 7 === 0 && d.getMonth() !== month.getMonth()) break;
      const inMonth = d.getMonth() === month.getMonth();
      if (!inMonth) { cells.push(h('span', { class: 'fi-cal-gap' })); continue; }
      const k = keyOf(d);
      const list = story(k);
      const sp = dominant(list);
      const future = k > today;
      cells.push(h('button', {
        type: 'button', disabled: future,
        class: ['fi-cal-day', k === today && 'is-today', sp && 'is-told', future && 'is-future'],
        style: sp ? { '--sp': sp.color } : null,
        title: sp ? `${list.length} fragment${list.length === 1 ? '' : 's'} · mostly ${sp.label}` : k === today ? 'Today — still being written' : 'Untold',
        'aria-label': `${d.toDateString()}${sp ? `, told, mostly ${sp.label}` : ', untold'}`,
        onclick: () => { day = k; cal = false; remember(); paint(); },
      }, String(d.getDate())));
    }
    const told = cells.filter((c) => c.classList?.contains('is-told')).length;
    stage.replaceChildren(h('div', { class: 'fi-cal' },
      h('div', { class: 'fi-cal-head' },
        h('button', { class: 'fi-nav', type: 'button', 'aria-label': 'Previous month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderTracker(); } }, icon('chevronLeft', 18)),
        h('span', { class: 'fi-cal-month' }, month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase()),
        h('button', { class: 'fi-nav', type: 'button', 'aria-label': 'Next month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderTracker(); } }, icon('chevronRight', 18))),
      h('div', { class: 'fi-cal-dow', 'aria-hidden': 'true' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => h('span', {}, x))),
      h('div', { class: 'fi-cal-grid' }, cells),
      h('p', { class: 'fi-cal-hint' }, told ? 'click a day to read its story' : 'no stories this month yet — click a day to tell one'),
      h('div', { class: 'fi-cal-key', 'aria-hidden': 'true' }, SETPOINTS.map((s) => h('span', { style: { '--sp': s.color } }, h('i'), s.label)))));
  }

  /* ================= WEEKLY ================= */
  // One week at a time: the goal on top, one week card below. Arrows at the card's edges step weeks.
  // Every week has a renamable title (stored in weekly.titles by Monday key) and its list of
  // "what's needed to be true". Weeks with nothing in them simply show up blank.
  let viewWeek = null;     // Monday key of the week on screen (null → this week)
  let wkJump = false;      // the next Weekly render scrolls the focused week into view
  const sel = new Set();   // selected task ids (Weekly)
  let anchorId = null;     // for shift-click ranges
  const SLOT_HINTS = ['add a key requirement…', 'add another requirement…', 'add one more requirement…'];

  /** Which week to show: the one you stepped to, else this week clamped into the plan. */
  function weekOnScreen(p, keys) {
    if (viewWeek && keys.includes(viewWeek)) return viewWeek;
    const now = keyOf(mondayOf(new Date()));
    if (keys.includes(now)) return now;
    return now < keys[0] ? keys[0] : keys[keys.length - 1];
  }
  function stepWeek(d) {
    const keys = planWeeks(weekly());
    const i = keys.indexOf(weekOnScreen(weekly(), keys)) + d;
    if (i < 0 || i >= keys.length) return;
    viewWeek = keys[i]; sel.clear(); wkJump = true; renderWeekly();
  }

  function renderWeekly() {
    let p = weekly();
    const now = keyOf(mondayOf(new Date()));
    // The old "no week yet" tray is gone: anything still parked there joins this week.
    if (p.tray.length) {
      const into = keyOf(mondayOf(parseKey(p.deadline))) < now ? keyOf(mondayOf(parseKey(p.deadline))) : now;
      setWeekly({ weeks: { ...p.weeks, [into]: [...(p.weeks[into] || []), ...p.tray] }, tray: [] });
      p = weekly();
    }
    const keys = planWeeks(p);
    const first = keyOf(mondayOf(parseKey(p.start))), lastWk = keyOf(mondayOf(parseKey(p.deadline)));
    const k = weekOnScreen(p, keys);
    const idx = keys.indexOf(k);
    const n = Math.round((parseKey(k) - parseKey(first)) / (7 * 86_400_000)) + 1;
    const list = p.weeks[k] || [];
    const all = Object.values(p.weeks).flat().map((x) => x.id);
    for (const id of [...sel]) if (!all.includes(id)) sel.delete(id);
    const left = keys.filter((x) => x >= now && x <= lastWk).length;
    const daysLeft = Math.ceil((parseKey(p.deadline) - new Date(new Date().toDateString())) / 86_400_000);
    const a = parseKey(k), b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);

    // Nov 19 — the Weekly answers to the goal. The goal is the one thing you configure: click it and its
    // menu opens right there. The weeks run down a timeline and stay hands-on — double-click a title to
    // rename it, check requirements on their pills. The week in focus opens into a card that carries
    // nothing but its own content; the due date waits at the final week, where the scroll lands.
    const goalName = p.goal || 'Set a goal';
    const goal = h('button', {
      class: ['fi-goal', 'fi-wl-goal', !p.goal && 'is-unset'], type: 'button', 'aria-haspopup': 'menu', title: 'Goal options',
      onclick: (e) => goalMenu(e.currentTarget, p),
    }, `GOAL: ${goalName}`.toUpperCase());
    const leftTxt = daysLeft < 0 ? 'PAST DEADLINE' : left <= 1 ? 'LAST WEEK' : `${left} WEEKS LEFT`;
    const head = h('div', { class: 'fi-wl-head' }, goal, h('span', { class: ['fi-wl-left', daysLeft < 0 && 'is-over'] }, leftTxt));

    const nOf = (key) => Math.round((parseKey(key) - parseKey(first)) / (7 * 86_400_000)) + 1;
    const rows = keys.map((key) => {
      const items = p.weeks[key] || [];
      const doneN = items.filter((x) => x.done).length;
      const complete = items.length > 0 && doneN === items.length;
      const focus = key === k;
      // Gold belongs to the current week only. Past weeks read gray, filled with what got checked off.
      const state = key === now ? 'is-now' : key < now ? 'is-past' : 'is-future';
      const isDue = key === lastWk;
      const custom = p.titles?.[key] || '';
      const wkLabel = custom || weekRange(key);
      const node = h('span', { class: ['fi-wl-node', complete && 'is-done'], 'aria-hidden': 'true' }, complete ? icon('check', 10, { weight: 3 }) : null);
      const when = h('span', { class: 'fi-wl-when' }, weekRange(key));
      let body;
      if (focus) {
        const title = h('button', { class: 'fi-wk-name fi-wl-title', type: 'button', title: 'Double-click to rename', ondblclick: () => editWeekTitle(title, key, p) }, wkLabel.toUpperCase());
        const slots = Math.max(1, SLOT_HINTS.length - items.length);
        const hintAt = (i) => SLOT_HINTS[Math.min(items.length + i, SLOT_HINTS.length - 1)];
        body = h('section', { class: ['fi-wk', 'fi-wk-card', 'fi-wl-card', key === now && 'is-now'], 'data-wk': key, 'aria-label': wkLabel },
          title,
          h('p', { class: 'fi-wk-sub fi-wl-sub' }, key === now ? 'WHAT’S NEEDED TO BE TRUE THIS WEEK' : key < now ? 'WHAT WAS NEEDED TO BE TRUE THAT WEEK' : 'WHAT’S NEEDED TO BE TRUE THAT WEEK'),
          h('div', { class: 'fi-wk-list' }, items.map((x) => taskRow(x, key))),
          Array.from({ length: slots }, (_, i) => adder(key, hintAt(i), i === 0)),
          isDue ? h('span', { class: 'fi-wl-due is-in-card' }, `DUE ${shortDate(parseKey(p.deadline)).toUpperCase()}`) : null);
      } else {
        // One click opens the week; a double-click renames it on the spot (the open waits a beat for it).
        let openT = 0;
        const title = h('span', { class: 'fi-wl-bar-title' }, custom ? custom.toUpperCase() : '');
        body = h('div', {
          role: 'button', tabindex: 0, class: 'fi-wl-bar', 'data-wk': key, title: `${shortDate(parseKey(key))} – ${shortDate(new Date(parseKey(key).getTime() + 6 * 86_400_000))} · click to open · double-click to rename`,
          onclick: (e) => {
            if (e.target.closest('input')) return;
            clearTimeout(openT);
            if (e.detail > 1) return;
            openT = setTimeout(() => { viewWeek = key; sel.clear(); wkJump = true; renderWeekly(); }, 220);
          },
          ondblclick: (e) => { if (e.target.closest('input')) return; clearTimeout(openT); editWeekTitle(title, key, p); },
          onkeydown: (e) => { if (e.key === 'Enter' && !e.target.closest('input')) { e.preventDefault(); viewWeek = key; sel.clear(); wkJump = true; renderWeekly(); } },
        },
        h('span', { class: ['fi-wl-ring', complete && 'is-done'] }),
        title,
        key < now && items.length
          ? h('span', { class: 'fi-wl-past' }, items.slice(0, 4).map((x) => h('span', { class: ['fi-wl-pastitem', x.done && 'is-done'] }, h('i', {}, x.done ? icon('check', 9, { weight: 3 }) : null), x.text)))
          : null,
        items.length ? h('span', { class: 'fi-wl-count' }, `${doneN}/${items.length}`) : null,
        isDue ? h('span', { class: 'fi-wl-due' }, `DUE ${shortDate(parseKey(p.deadline)).toUpperCase()}`) : null);
      }
      return h('li', { class: ['fi-wl-row', state, complete && 'is-complete', focus && 'is-focus', isDue && 'is-due', key < now && items.length && 'has-past'], 'data-key': key }, when, node, body);
    });

    const look = weeklyLook();
    const bgUrl = look.bg ? urlOf(look.bg, () => tab === 'weekly' && refresh()) : null;
    const view = h('div', {
      class: ['fi-weekly', 'is-line', look.bg && 'has-bg'], 'data-wk-theme': look.theme || 'default',
      style: bgUrl ? { '--wk-img': `url("${bgUrl}")` } : null,
    },
      head,
      h('ol', { class: ['fi-wl', 'is-fog'], 'aria-label': 'Weeks', style: { '--wl-fill': `${Math.round(100 * Math.max(0, Math.min(1, (keys.filter((x) => x <= now).length) / Math.max(1, keys.length))))}%` } }, rows),
      selBar(p));
    // Background & theme live on a right-click of the empty Weekly space.
    view.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fi-task, input, [contenteditable="true"]')) return;
      e.preventDefault(); lookMenu({ x: e.clientX, y: e.clientY });
    });
    const keepTop = stage.querySelector('.fi-weekly.is-line') ? stage.scrollTop : null;
    stage.replaceChildren(view);
    if (keepTop != null && !wkJump) stage.scrollTop = keepTop;
    else requestAnimationFrame(() => view.querySelector('.fi-wl-row.is-focus')?.scrollIntoView({ block: 'center', behavior: wkJump && keepTop != null && !prefersReducedMotion() ? 'smooth' : 'auto' }));
    wkJump = false;
  }

  /* ---- the goal's own menu: the one place the plan is configured ---- */
  function goalMenu(anchor, p) {
    menu(anchor, [
      { label: 'Edit goal name', icon: 'edit', onSelect: () => { const b = stage.querySelector('.fi-wl-goal'); if (b) editGoal(b, p.goal); } },
      { label: 'Edit weeks', icon: 'list', onSelect: () => editWeeks() },
      { label: 'Add week', icon: 'plus', onSelect: () => addWeek() },
      { label: 'Set due date', icon: 'calendar', onSelect: () => datesPop(anchor, weekly()) },
      { label: 'Reset progress', icon: 'history', onSelect: () => resetProgress() },
      '-',
      { label: 'Delete goal', icon: 'trash', danger: true, onSelect: () => deleteGoal() },
    ], { align: 'end' });
  }
  function addWeek() {
    const p = weekly();
    const d = parseKey(p.deadline);
    setWeekly({ deadline: keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) });
    renderWeekly();
    toast('Added a week — the due date moved out by 7 days.', { ms: 2400 });
  }
  function resetProgress() {
    const p = weekly();
    const before = { weeks: p.weeks, tray: p.tray };
    if (!Object.values(p.weeks).flat().some((x) => x.done)) { toast('Nothing checked off yet.'); return; }
    setWeekly(eachList(p, (l) => l.map((y) => ({ ...y, done: false }))));
    renderWeekly();
    toast('Progress reset.', { ms: 4000, action: { label: 'Undo', onClick: () => { setWeekly(before); renderWeekly(); } } });
  }
  async function deleteGoal() {
    const p = weekly();
    if (!(await confirmDialog(`Delete ${p.goal ? `“${p.goal}”` : 'this goal'}?`, 'Its weeks, titles and requirements go with it.'))) return;
    const before = { ...p };
    const start = keyOf(mondayOf(new Date()));
    setWeekly({ goal: '', start, deadline: keyOf(new Date(parseKey(start).getTime() + 55 * 86_400_000)), weeks: {}, tray: [], titles: {} });
    viewWeek = null; sel.clear(); wkJump = true;
    renderWeekly();
    toast('Goal deleted.', { ms: 5000, action: { label: 'Undo', onClick: () => { setWeekly(before); renderWeekly(); } } });
  }
  // Rearrange weeks: each week (its title and its requirements) can swap places with a neighbour,
  // be renamed, or be cleared. The dates stay put — the content moves.
  async function editWeeks() {
    const p0 = weekly();
    const keys = planWeeks(p0);
    const first = keyOf(mondayOf(parseKey(p0.start)));
    let order = keys.map((key) => ({ key, title: p0.titles?.[key] || '', items: p0.weeks[key] || [] }));
    const list = h('ol', { class: 'fi-ew' });
    const paintList = () => list.replaceChildren(...order.map((o, i) => {
      const inp = h('input', { class: 'input sm fi-ew-title', value: o.title, maxlength: 40, placeholder: `Week ${i + 1}`, 'aria-label': `Week ${i + 1} title`, oninput: (e) => { o.title = e.target.value; } });
      const mv = (d) => { const j = i + d; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; paintList(); list.querySelectorAll('.fi-ew-title')[j]?.focus(); };
      return h('li', { class: 'fi-ew-row' },
        h('span', { class: 'fi-ew-when' }, weekRange(keys[i])),
        inp,
        h('span', { class: 'fi-ew-n' }, o.items.length ? `${o.items.length}` : '—'),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move up', disabled: i === 0, onclick: () => mv(-1) }, icon('chevronUp', 14)),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move down', disabled: i === order.length - 1, onclick: () => mv(1) }, icon('chevronDown', 14)));
    }));
    paintList();
    const ok = await dialog({
      title: 'Edit weeks', width: 520, className: 'fi-ew-dlg',
      body: h('div', { class: 'stack' }, h('p', { class: 'muted fi-ew-hint' }, 'Rename weeks or move a week’s requirements up and down the plan. Dates stay fixed.'), list),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: true }],
    });
    if (!ok) return;
    const weeks = {}, titles = {};
    order.forEach((o, i) => { const key = keys[i]; if (o.items.length) weeks[key] = o.items; const t = o.title.trim(); if (t) titles[key] = t; });
    setWeekly({ weeks, titles });
    renderWeekly();
  }

  function editWeekTitle(btn, k, p) {
    const cur = p.titles?.[k] || '';
    const inp = h('input', { class: 'fi-wk-name-input', value: cur, maxlength: 40, placeholder: btn.textContent, 'aria-label': 'Week title' });
    btn.replaceWith(inp);
    inp.focus(); inp.select();
    let gone = false;
    const done = (save) => {
      if (gone) return; gone = true;
      const v = inp.value.trim();
      if (save && v !== cur) { const t = { ...(weekly().titles || {}) }; if (v) t[k] = v; else delete t[k]; setWeekly({ titles: t }); }
      renderWeekly();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  /* ---- Weekly look: your own background image and theme ---- */
  function weeklyLook() { const v = getPref('weeklyLook', null); return v && typeof v === 'object' ? v : {}; }
  async function setLook(p) {
    await setPref('weeklyLook', { ...weeklyLook(), ...p });
    if (tab === 'weekly') renderWeekly();
  }
  function lookMenu(anchor) {
    const look = weeklyLook();
    menu(anchor, [
      { header: 'Theme' },
      ...WK_THEMES.map(([id, label, c]) => ({
        label, checked: (look.theme || 'default') === id,
        iconEl: h('span', { class: 'fi-swatch', style: { background: c } }),
        onSelect: () => setLook({ theme: id }),
      })),
      '-',
      { header: 'Background' },
      { label: look.bg ? 'Change background image…' : 'Set background image…', icon: 'image', onSelect: pickBg },
      look.bg ? { label: 'Remove background', icon: 'close', onSelect: () => setLook({ bg: null }) } : null,
    ].filter(Boolean), { align: 'end' });
  }
  async function pickBg() {
    const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
    if (!f) return;
    const wait = toast('Setting your background…', { ms: 0 });
    try { const up = await uploadMedia(f); await setLook({ bg: up.path }); }
    catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    finally { wait.close(); }
  }

  const listOf = (p, wk) => (wk === 'tray' ? p.tray : p.weeks[wk] || []);
  const withList = (p, wk, next) => (wk === 'tray' ? { tray: next } : { weeks: { ...p.weeks, [wk]: next } });
  // Apply fn to every list: fn(list, wk) → new list.
  const eachList = (p, fn) => {
    const weeks = {};
    for (const [k, v] of Object.entries(p.weeks)) weeks[k] = fn(v, k);
    return { weeks, tray: fn(p.tray, 'tray') };
  };

  function taskRow(x, wk) {
    const row = h('div', { class: ['fi-task', x.done && 'is-done', sel.has(x.id) && 'is-sel'], 'data-id': x.id, 'aria-selected': String(sel.has(x.id)) },
      h('button', {
        type: 'button', class: 'fi-check', role: 'checkbox', 'aria-checked': String(!!x.done), 'aria-label': x.done ? 'Mark not done' : 'Mark done',
        onclick: () => { const p = weekly(); setWeekly(withList(p, wk, listOf(p, wk).map((y) => (y.id === x.id ? { ...y, done: !y.done } : y)))); },
      }, icon('check', 12, { weight: 2.4 })),
      h('span', { class: 'fi-task-text' }, x.text));
    row.querySelector('.fi-task-text').addEventListener('dblclick', (e) => { sel.clear(); editTask(e.currentTarget, x, wk); });
    row.addEventListener('pointerdown', (e) => dragTask(e, row, x, wk));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!sel.has(x.id)) { sel.clear(); sel.add(x.id); anchorId = x.id; paintSel(); }
      selMenu({ x: e.clientX, y: e.clientY });
    });
    return row;
  }

  /* ---- batch selection: click = one, Ctrl/⌘-click = toggle, Shift-click = range ---- */
  function clickTask(ev, x, wk) {
    stage.focus({ preventScroll: true });
    if (ev.shiftKey && anchorId) {
      const order = [...stage.querySelectorAll('.fi-task')].map((r) => r.dataset.id);
      const a = order.indexOf(anchorId), b = order.indexOf(x.id);
      if (a >= 0 && b >= 0) { const [i, j] = a < b ? [a, b] : [b, a]; order.slice(i, j + 1).forEach((id) => sel.add(id)); }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (sel.has(x.id)) sel.delete(x.id); else sel.add(x.id);
      anchorId = x.id;
    } else {
      const only = sel.size === 1 && sel.has(x.id);
      sel.clear();
      if (!only) sel.add(x.id);
      anchorId = x.id;
    }
    paintSel();
  }

  function paintSel() {
    stage.querySelectorAll('.fi-task').forEach((r) => { const on = sel.has(r.dataset.id); r.classList.toggle('is-sel', on); r.setAttribute('aria-selected', String(on)); });
    const old = stage.querySelector('.fi-sel-bar');
    const next = selBar(weekly());
    if (old) old.replaceWith(next); else stage.querySelector('.fi-weekly')?.append(next);
  }

  function selBar(p) {
    const n = sel.size;
    if (!n) return h('div', { class: 'fi-sel-bar', hidden: true });
    const items = [...Object.values(p.weeks).flat(), ...p.tray].filter((x) => sel.has(x.id));
    const allDone = items.length && items.every((x) => x.done);
    const btn = (ic, label, fn, danger) => h('button', { type: 'button', class: ['fi-sel-btn', danger && 'is-danger'], onclick: fn }, icon(ic, 14), h('span', {}, label));
    return h('div', { class: 'fi-sel-bar', role: 'toolbar', 'aria-label': `${n} selected` },
      h('span', { class: 'fi-sel-n' }, `${n} SELECTED`),
      btn('check', allDone ? 'Not done' : 'Done', () => markSel(!allDone)),
      btn('folderMove', 'Move to', (e) => moveMenu(e.currentTarget)),
      btn('trash', 'Delete', deleteSel, true),
      h('button', { type: 'button', class: 'fi-sel-x', 'aria-label': 'Clear selection', onclick: () => { sel.clear(); paintSel(); } }, icon('close', 14)));
  }

  function selMenu(anchor) {
    const p = weekly();
    const items = [...Object.values(p.weeks).flat(), ...p.tray].filter((x) => sel.has(x.id));
    const allDone = items.length && items.every((x) => x.done);
    menu(anchor, [
      { header: `${sel.size} selected` },
      { label: allDone ? 'Mark not done' : 'Mark done', icon: 'check', onSelect: () => markSel(!allDone) },
      ...moveItems(),
      '-',
      { label: 'Delete', icon: 'trash', danger: true, kbd: 'Del', onSelect: deleteSel },
    ]);
  }

  function moveItems() {
    const p = weekly();
    const now = keyOf(mondayOf(new Date()));
    const first = keyOf(mondayOf(parseKey(p.start)));
    const n = (k) => Math.round((parseKey(k) - parseKey(first)) / (7 * 86_400_000)) + 1;
    return [{ header: 'Move to' },
      ...planWeeks(p).filter((k) => k >= now).map((k) => ({ label: `${p.titles?.[k] || (k === now ? 'This week' : `Week ${n(k)}`)} · ${shortDate(parseKey(k))}`, icon: 'calendar', onSelect: () => moveSel(k) }))];
  }
  function moveMenu(anchor) { menu(anchor, moveItems(), { side: 'top' }); }

  function markSel(done) { setWeekly(eachList(weekly(), (l) => l.map((y) => (sel.has(y.id) ? { ...y, done } : y)))); }
  function deleteSel() {
    const n = sel.size;
    const p = weekly();
    const before = { weeks: p.weeks, tray: p.tray };
    setWeekly(eachList(p, (l) => l.filter((y) => !sel.has(y.id))));
    sel.clear();
    toast(`Deleted ${n} task${n === 1 ? '' : 's'}.`, { ms: 4000, action: { label: 'Undo', onClick: () => setWeekly(before) } });
  }
  function moveSel(to, before = null) {
    const p = weekly();
    const moving = [...Object.values(p.weeks).flat(), ...p.tray].filter((y) => sel.has(y.id));
    const next = eachList(p, (l) => l.filter((y) => !sel.has(y.id)));
    const dest = [...(to === 'tray' ? next.tray : next.weeks[to] || [])];
    const i = before ? dest.findIndex((y) => y.id === before) : -1;
    dest.splice(i < 0 ? dest.length : i, 0, ...moving);
    if (to === 'tray') next.tray = dest; else next.weeks[to] = dest;
    setWeekly(next);
  }

  stage.tabIndex = -1;
  stage.addEventListener('keydown', (e) => {
    if (tab === 'weekly' && !e.target.closest('input, textarea, [contenteditable="true"]') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation(); stepWeek(e.key === 'ArrowLeft' ? -1 : 1); return;
    }
    if (tab !== 'weekly' || !sel.size || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteSel(); }
    else if (e.key === 'Escape') { e.stopPropagation(); sel.clear(); paintSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); stage.querySelectorAll('.fi-task').forEach((r) => sel.add(r.dataset.id)); paintSel(); }
  });
  // Click on empty space in Weekly clears the selection.
  stage.addEventListener('pointerdown', (e) => {
    if (tab === 'weekly' && sel.size && !e.target.closest('.fi-task, .fi-sel-bar, .menu')) { sel.clear(); paintSel(); }
  });

  // An outlined slot: click it, type, Enter adds the requirement to this week.
  function adder(wk, hint = 'add another requirement…', lead = true) {
    const inp = h('input', {
      class: 'fi-add-input', maxlength: 160, placeholder: `+ ${hint}`, 'aria-label': `Add a requirement to week ${wk}`,
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); return; }
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        e.preventDefault();
        const text = e.target.value.trim();
        e.target.value = '';
        const p = weekly();
        pending = false;
        setWeekly(withList(p, wk, [...listOf(p, wk), { id: uid(), text, done: false }]));
        renderWeekly();
        stage.querySelector(`.fi-wk-card[data-wk="${wk}"] .fi-add-input`)?.focus();
      },
    });
    return h('label', { class: ['fi-add', 'fi-slot', lead && 'is-lead'] }, inp);
  }

  function editTask(span, x, wk) {
    hold++;
    span.contentEditable = 'true';
    span.focus();
    document.getSelection()?.selectAllChildren(span);
    const done = (save) => {
      span.removeEventListener('blur', onBlur); span.removeEventListener('keydown', onKey);
      span.contentEditable = 'false';
      const text = span.textContent.replace(/\s+/g, ' ').trim();
      const p = weekly();
      if (save && text && text !== x.text) setWeekly(withList(p, wk, listOf(p, wk).map((y) => (y.id === x.id ? { ...y, text } : y))));
      else span.textContent = x.text;
      release();
    };
    const onBlur = () => done(true);
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); span.blur(); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    span.addEventListener('blur', onBlur); span.addEventListener('keydown', onKey);
  }

  function dragTask(e, row, x, wk) {
    if (e.button !== 0 || e.target.closest('button, [contenteditable="true"]')) return;
    const sx = e.clientX, sy = e.clientY;
    const r0 = row.getBoundingClientRect();
    const group = sel.has(x.id) && sel.size > 1; // dragging one of several selected tasks moves them all
    let ghost = null, over = null, before = null;
    hold++;
    const targetAt = (cx, cy) => document.elementFromPoint(cx, cy)?.closest?.('[data-wk]');
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!ghost) {
        ghost = row.cloneNode(true);
        ghost.classList.add('fi-task-ghost');
        if (group) ghost.append(h('span', { class: 'fi-ghost-n' }, String(sel.size)));
        Object.assign(ghost.style, { width: `${r0.width}px`, left: `${r0.left}px`, top: `${r0.top}px` });
        document.body.append(ghost);
        (group ? stage.querySelectorAll('.fi-task.is-sel') : [row]).forEach((r) => r.classList.add('is-lifted'));
        document.body.classList.add('fi-dragging');
      }
      ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) rotate(-1.5deg)`;
      const t = targetAt(ev.clientX, ev.clientY);
      if (t !== over) { over?.classList.remove('is-over'); over = t; over?.classList.add('is-over'); }
      before = null;
      if (over) {
        for (const r of over.querySelectorAll('.fi-task:not(.is-lifted)')) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) { before = r.dataset.id; break; }
        }
      }
    };
    const up = (ev) => {
      row.removeEventListener('pointermove', move); row.removeEventListener('pointerup', up); row.removeEventListener('pointercancel', up);
      over?.classList.remove('is-over');
      document.body.classList.remove('fi-dragging');
      ghost?.remove();
      stage.querySelectorAll('.fi-task.is-lifted').forEach((r) => r.classList.remove('is-lifted'));
      if (!ghost) { release(); if (ev.type === 'pointerup') clickTask(ev, x, wk); return; }
      if (over) {
        if (!group) { sel.clear(); sel.add(x.id); }
        hold = Math.max(0, hold - 1);
        moveSel(over.dataset.wk, before);
        if (!group) sel.clear();
        renderWeekly();
        return;
      }
      release();
    };
    row.setPointerCapture(e.pointerId);
    row.addEventListener('pointermove', move); row.addEventListener('pointerup', up); row.addEventListener('pointercancel', up);
  }

  function datesPop(anchor, p) {
    const startIn = h('input', { type: 'date', class: 'input sm', value: p.start, 'aria-label': 'Plan starts' });
    const dueIn = h('input', { type: 'date', class: 'input sm', value: p.deadline, 'aria-label': 'Deadline' });
    const preview = h('span', { class: 'fi-dates-left' });
    const calc = () => {
      const a = startIn.value || p.start, b = dueIn.value || p.deadline;
      const total = Math.max(0, Math.round((mondayOf(parseKey(b)) - mondayOf(parseKey(a))) / (7 * 86_400_000)) + 1);
      const left = Math.max(0, Math.round((mondayOf(parseKey(b)) - mondayOf(new Date())) / (7 * 86_400_000)) + 1);
      preview.textContent = b < a ? 'Deadline is before the start.' : `${total} week${total === 1 ? '' : 's'} in the plan · ${left} left`;
    };
    startIn.oninput = calc; dueIn.oninput = calc; calc();
    const save = () => {
      const a = startIn.value || p.start, b = dueIn.value || p.deadline;
      if (b < a) { toast('The deadline has to come after the start.', { tone: 'error' }); return; }
      closeFloating();
      setWeekly({ start: a, deadline: b });
      renderWeekly();
    };
    popover(anchor, h('div', { class: 'pop fi-dates' },
      h('div', { class: 'pop-label' }, 'Plan dates'),
      h('label', { class: 'fi-dates-row' }, h('span', {}, 'Starts'), startIn),
      h('label', { class: 'fi-dates-row' }, h('span', {}, 'Deadline'), dueIn),
      preview,
      h('button', { class: 'btn btn-primary sm', type: 'button', onclick: save }, 'Save')), { side: 'bottom', align: 'end', gap: 8 });
    requestAnimationFrame(() => dueIn.focus());
  }

  function editGoal(btn, current) {
    const inp = h('input', { class: 'fi-goal-input', value: current, maxlength: 60, 'aria-label': 'Goal' });
    btn.replaceWith(inp);
    inp.focus(); inp.select();
    let gone = false;
    const done = (save) => {
      if (gone) return; gone = true;
      const v = inp.value.trim();
      if (save && v && v !== current) setWeekly({ goal: v });
      wkJump = false;
      renderWeekly();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  /* ---------------- live ---------------- */
  const onResize = new ResizeObserver(() => {
    if (tab === 'ideas') { for (const n of nodes.values()) { n.w = n.node.offsetWidth; n.h = n.node.offsetHeight; } place(); }
    else if (tab === 'story' && hold === 0) refresh();
  });
  onResize.observe(stage);

  // The shared Space's object is the pool everyone's Shared view reads.
  const poolReg = personal ? null : registerPool({
    id: el.id,
    get: () => w.current()?.ideas || el.ideas || [],
    set: (list, live) => (live ? w.live : w.patch)({ ideas: list }),
    field: (k) => (w.current() || el)[k],
    patch: (p) => w.patch(p),
    priv: () => !!(w.current() || el).privateTo, // a hidden object is nobody else's Story
  });
  if (moments && !poolReady()) w.host?.warmShared?.(); // bring the shared record in so both Spaces agree
  const ideasShown = () => tab === 'ideas';
  const offPool = personal ? onPool(() => { adoptLocal(); if ((ideasShown() && ideaView === 'shared') || (moments && tab !== 'ideas')) refresh(); }) : () => {};
  /* Moments written in your personal Space before the shared record was open stayed on your own copy, so the
     other person never saw them. As soon as the shared record is there, they move onto it (once, by id) and
     leave this copy. Moments only ever leave a hidden ("Hide from others") object when you unhide it. */
  function adoptLocal() {
    if (!moments || !poolReady() || (w.current() || el).privateTo) return;
    const mineStory = (w.current() || el).story || {};
    const days = Object.keys(mineStory).filter((k) => (mineStory[k] || []).length);
    if (!days.length) return;
    const sh = poolField('story') || {};
    const next = { ...sh };
    for (const k of days) {
      const have = new Set((sh[k] || []).map((f) => f.id));
      next[k] = [...(sh[k] || []), ...mineStory[k].filter((f) => !have.has(f.id))].sort((a, b) => a.m - b.m);
    }
    patchPool({ story: next });
    w.patch({ story: Object.fromEntries(Object.keys(mineStory).map((k) => [k, []])) });
  }
  adoptLocal();
  const offMine = onMyVars((d, keys) => { if ((!keys || keys.includes('ideas')) && ideasShown() && ideaView === 'mine') refresh(); });
  if (personal && ideaView === 'shared' && !poolReady()) w.host?.warmShared?.();
  loadMyVars().then(() => {
    // Your personal Space's old ideas were always yours: they move into Mine once (merged by id).
    const legacyKey = `architect.fi.legacy.${el.id}`;
    const old = personal && !store.get(legacyKey, null) ? (el.ideas || []) : [];
    if (old.length) {
      const have = new Set(mineList().map((q) => q.id));
      setMyVars({ ideas: [...mineList(), ...old.filter((q) => !have.has(q.id))] });
    }
    if (personal) store.set(legacyKey, 'done');
    mineReady = true;
    if (ideasShown()) refresh();
  }).catch(() => { mineReady = true; if (ideasShown()) refresh(); });

  paint();

  return {
    update(next) {
      const changed = next.ideas !== el.ideas || next.story !== el.story || next.weekly !== el.weekly;
      const poolChanged = next.ideas !== el.ideas || next.story !== el.story || next.weekly !== el.weekly;
      el = next;
      if (poolChanged) poolReg?.changed();
      if (changed) refresh();
    },
    destroy() {
      if (full) setFull(false);
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('keydown', onUndoKey, true); window.removeEventListener('keydown', onFullEsc, true); document.removeEventListener('pointerdown', offActive, true);
      stopIdeas(); onResize.disconnect(); window.removeEventListener('architect:drop-idea', onDropIdea); poolReg?.off(); offPool(); offMine(); box.remove(); },
  };
}
