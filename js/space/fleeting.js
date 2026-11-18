// Fleeting Ideas — one object, three tabs (the Tracker calendar opens from a button in Story).
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
import { menu, toast, popover, closeFloating } from '../core/ui.js';
import { uid, store, prefersReducedMotion } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia, fmtDur } from './media.js';
import { avatarsFor } from '../data/profile.js';
import { getPref, setPref } from '../data/prefs.js';
import { loadMyVars, myVars, setMyVars, onMyVars } from '../data/myvars.js';
import { registerPool, poolReady, poolIdeas, setPoolIdeas, onPool } from '../data/ideapool.js';

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
const TABS = [['ideas', 'Ideas'], ['story', 'Story'], ['weekly', 'Weekly']];
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

export function mountFleeting(root, el0, w) {
  let el = el0;
  const me = api.auth.current()?.user;
  const memKey = `architect.fi.${el.id}`;
  const mem = store.get(memKey, {});
  // Tracker used to be a tab: anyone who left it open lands in Story with the calendar showing.
  let tab = mem.tab === 'tracker' ? 'story' : TABS.some(([id]) => id === mem.tab) ? mem.tab : 'ideas';
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
  const remember = () => store.set(memKey, { tab, cal, iv: ideaView });
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
  const box = h('div', { class: 'fi' }, h('div', { class: 'fi-top' }, tabsRow, aside), stage, composer);
  root.append(box);

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
    if (tab === 'ideas') { day = storyKey(); setTab('story'); }
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
  const story = (k = day) => el.story?.[k] || [];
  // Weekly plan. Weeks are keyed by their Monday (YYYY-MM-DD) and run from start to the deadline,
  // so the columns generate themselves. Older plans keyed weeks 1..8 — those convert on read.
  const weekly = () => {
    const wk = el.weekly || {};
    const start = wk.start || keyOf(mondayOf(new Date()));
    const weeks = {};
    for (const [k, v] of Object.entries(wk.weeks || {})) {
      const key = /^\d{1,2}$/.test(k) ? addWeeks(start, Number(k) - 1) : k;
      weeks[key] = [...(weeks[key] || []), ...(v || [])];
    }
    const deadline = wk.deadline || keyOf(new Date(parseKey(start).getTime() + 55 * 86_400_000)); // default: 8 weeks
    return { goal: wk.goal || DEFAULT_GOAL, start, deadline, weeks, tray: wk.tray || [], titles: wk.titles || {} };
  };
  const setIdeas = (list, live = false) => {
    if (ideaView === 'shared') { if (poolOk()) poolSet(list, live); }
    else if (mineReady) setMyVars({ ideas: list });
  };
  const setStory = (k, list) => w.patch({ story: { ...(w.current().story || {}), [k]: list } });
  const setWeekly = (p) => { const cur = weekly(); w.patch({ weekly: { ...cur, ...p } }); };

  /* ---------------- shell ---------------- */
  function setTab(id) {
    if (tab === id) return;
    tab = id; cal = false; remember();
    paint();
  }

  function paint() {
    tabsRow.replaceChildren(...TABS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: ['fi-tab', tab === id && 'is-on'], 'aria-selected': String(tab === id),
      onclick: () => setTab(id),
    }, label)));
    const v = view();
    box.dataset.tab = tab;
    composer.hidden = !(v === 'ideas' || v === 'story');
    attach.hidden = tab !== 'story';
    input.placeholder = tab === 'story' ? (day === storyKey() ? 'narrate this moment…' : `add to ${shortDate(parseKey(day))}…`) : 'type an idea…';
    input.setAttribute('aria-label', tab === 'story' ? 'Narrate a moment' : 'Type an idea');
    aside.replaceChildren(...(tab === 'story' ? [...(cal ? [] : dayNav()), calBtn()] : tab === 'ideas' ? [viewSwitch()] : []));
    if (tab === 'ideas') input.placeholder = ideaView === 'shared' ? 'add to the shared pool…' : 'type an idea…';
    stopIdeas();
    stage.replaceChildren();
    stage.scrollTop = 0;
    stage.className = `fi-stage is-${v}`;
    if (v === 'ideas') mountIdeas();
    else if (v === 'story') {
      renderStory();
      // Today opens around the current moment; other days open at first light.
      if (day === storyKey()) stage.scrollTop = Math.max(0, PT + (storyMin() / 1440) * Number(tl.dataset.th) - stage.clientHeight * 0.45);
    }
    else if (v === 'tracker') renderTracker();
    else renderWeekly();
  }

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
    const loop = () => { raf = requestAnimationFrame(loop); if (onScreen && !document.hidden) place(); };
    raf = requestAnimationFrame(loop);
  }
  function stopIdeas() { cancelAnimationFrame(raf); raf = 0; io?.disconnect(); io = null; field = null; }

  function syncIdeas() {
    if (!field) return;
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
        n = { node, w: 0, h: 0, tilt: g.tilt };
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
      n.node.style.transform = tf(px, py, n.tilt);
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
          document.body.append(ghost);
        }
        if (ghost) ghost.hidden = !on;
        node.style.visibility = on ? 'hidden' : '';
      };
      const step = () => {
        frame = 0;
        const ev = last;
        if (!ev || done) return;
        const fr = field.getBoundingClientRect();
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
        if (!frame) frame = requestAnimationFrame(step);
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

  function editIdea(node, id) {
    const i = ideas().find((x) => x.id === id);
    if (!i || node.isContentEditable) return;
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
      if (save && text && text !== i.text) commitIdeas(ideas().map((x) => (x.id === id ? { ...x, text } : x)));
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
      if (!shown) { selIdeas.clear(); base.forEach((id) => selIdeas.add(id)); paintIdeaSel(); } // a plain click on the ice clears it
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
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
    if (tab !== 'ideas') setTab('ideas'); else paintIdeaSel();
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

  function renderStory() {
    const keep = stage.scrollTop;
    const list = [...story(), ...uploads.filter((u) => u.day === day)].sort((a, b) => a.m - b.m);
    const H = Math.max(stage.clientHeight || 520, 1560);
    const TH = H - PT - PB;
    const yOf = (m) => PT + (m / 1440) * TH;
    tl = h('div', { class: 'fi-tl', style: { height: `${H}px` } },
      h('i', { class: 'fi-spine', style: { top: `${PT - 14}px`, bottom: `${PB - 18}px` } }),
      h('span', { class: 'fi-mark is-top', style: { top: `${PT - 34}px` } }, 'GM'),
      ...SETPOINTS.slice(1).map((s) => h('i', { class: 'fi-tick', style: { top: `${yOf(s.from)}px`, '--sp': s.color }, title: `${s.label} · ${clockOf(s.from)}` })),
      h('span', { class: 'fi-mark is-bottom', style: { top: `${PT + TH + 8}px` } }, 'NEW MORNING'),
      h('i', { class: 'fi-tick is-end', style: { top: `${PT + TH}px` } }));
    tl.dataset.th = TH;
    if (day === storyKey()) { const now = storyMin(); tl.append(h('span', { class: 'fi-now', style: { top: `${yOf(now)}px`, '--sp': spOf(now).color }, title: `Now · ${clockOf(now)}` }, h('i'), h('b', {}, 'NOW'))); }
    if (!list.length) tl.append(h('p', { class: 'fi-story-empty' }, day === storyKey() ? 'Nothing told yet today.' : 'An untold day.', h('br'), 'Type below, or drop photos and videos anywhere on the line.'));
    for (const f of list) tl.append(fragment(f, yOf));
    lookupWho(list.map((f) => f.by), () => { if (tab === 'story') refresh(); });
    stage.replaceChildren(tl);
    stage.scrollTop = keep;
    requestAnimationFrame(() => tl?.querySelectorAll('.fi-frag').forEach(connect));
  }

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
    const node = h('div', { class: 'fi-frag', 'data-id': f.id, style: { top: `${yOf(f.m)}px`, left: `${(f.x ?? 0.5) * 100}%` } }, card);
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
    const left = at - half, right = at + half;
    let a = null;
    if (right < mid - 6) a = { cls: 'to-r', from: half, len: mid - right };   // card on the left: line runs right to the spine
    else if (left > mid + 6) a = { cls: 'to-l', from: mid - at, len: left - mid }; // card on the right
    if (!a) return;
    node.prepend(h('i', { class: ['fi-link', a.cls], style: { left: `${a.from}px`, width: `${a.len}px` } }));
  }

  function bindFrag(node, card, label, f) {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, [contenteditable="true"]')) return;
      e.preventDefault();
      const TH = Number(tl.dataset.th);
      const tr = tl.getBoundingClientRect();
      const scale = tr.width / (tl.clientWidth || 1);
      const sx = e.clientX, sy = e.clientY;
      const x0 = f.x ?? 0.5, m0 = f.m;
      let moved = false, m = m0, x = x0;
      hold++;
      const move = (ev) => {
        const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        node.classList.add('is-moving');
        node.querySelector('.fi-link')?.remove();
        x = Math.min(0.92, Math.max(0.08, x0 + dx / tl.clientWidth));
        m = Math.round(Math.min(1439, Math.max(0, m0 + (dy / TH) * 1440)));
        node.style.left = `${x * 100}%`;
        node.style.top = `${PT + (m / 1440) * TH}px`;
        const sp = spOf(m);
        card.style.setProperty('--sp', sp.color);
        label.firstChild.textContent = sp.label;
        label.querySelector('em').textContent = clockOf(m);
      };
      const up = () => {
        card.removeEventListener('pointermove', move);
        card.removeEventListener('pointerup', up);
        card.removeEventListener('pointercancel', up);
        node.classList.remove('is-moving');
        if (moved) {
          setStory(day, story().map((q) => (q.id === f.id ? { ...q, m, x: Math.round(x * 1000) / 1000 } : q)));
          release();
          return;
        }
        release();
        // Single click opens the photo/video; a double click edits the caption instead.
        if (f.kind === 'photo' || f.kind === 'video') { clearTimeout(card._open); card._open = setTimeout(() => lightbox(f), 240); }
      };
      card.setPointerCapture(e.pointerId);
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerup', up);
      card.addEventListener('pointercancel', up);
    });
    card.addEventListener('dblclick', (e) => { clearTimeout(card._open); if (!e.target.closest('button')) editFrag(card, f); });
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); fragMenu({ x: e.clientX, y: e.clientY }, f); });
  }

  function fragMenu(anchor, f) {
    menu(anchor, [
      { label: f.kind === 'text' ? 'Edit' : f.text ? 'Edit caption' : 'Add a caption', icon: 'edit', onSelect: () => { const c = tl?.querySelector(`.fi-frag[data-id="${f.id}"] .fi-card`); if (c) editFrag(c, f); } },
      day === storyKey() ? { label: 'Move to now', icon: 'clock', onSelect: () => setStory(day, story().map((q) => (q.id === f.id ? { ...q, m: storyMin() } : q))) } : null,
      f.kind !== 'text' ? { label: f.kind === 'video' ? 'Play' : 'View', icon: f.kind === 'video' ? 'play' : 'eye', onSelect: () => lightbox(f) } : null,
      '-',
      { label: 'Remove from story', icon: 'trash', danger: true, onSelect: () => setStory(day, story().filter((q) => q.id !== f.id)) },
    ].filter(Boolean), { align: 'end' });
  }

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
      else if (save && !text && f.kind === 'text') setStory(day, story().filter((q) => q.id !== f.id));
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
    const busy = (side) => list.some((q) => ((q.x ?? 0.5) < 0.5) === (side === 'left') && Math.abs(q.m - m) < GAP);
    const last = [...list].sort((a, b) => b.m - a.m)[0];
    const prefer = last && (last.x ?? 0.5) < 0.5 ? 'right' : 'left';
    const side = !busy(prefer) ? prefer : !busy(prefer === 'left' ? 'right' : 'left') ? (prefer === 'left' ? 'right' : 'left') : prefer;
    return { m, x: side === 'left' ? 0.29 : 0.71 };
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
    if (tab === 'ideas') { day = storyKey(); setTab('story'); addMediaToStory(files); return; }
    const r = tl.getBoundingClientRect();
    const scale = r.width / (tl.clientWidth || 1);
    const TH = Number(tl.dataset.th);
    const m = Math.round(Math.min(1439, Math.max(0, (((e.clientY - r.top) / scale - PT) / TH) * 1440)));
    const x = Math.min(0.85, Math.max(0.15, (e.clientX - r.left) / r.width));
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
  const wkSwipe = { acc: 0, t: 0, lock: 0 };
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
    viewWeek = keys[i]; sel.clear(); renderWeekly();
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

    const goal = h('button', { class: 'fi-goal', type: 'button', title: 'Rename the goal', onclick: () => editGoal(goal, p.goal) }, `GOAL: ${p.goal}`.toUpperCase());
    const due = h('button', { class: ['fi-due', daysLeft < 0 && 'is-over'], type: 'button', title: 'Set the start and deadline', onclick: (e) => datesPop(e.currentTarget, p) },
      icon('hourglass', 13),
      `DUE ${shortDate(parseKey(p.deadline)).toUpperCase()} – `,
      h('b', {}, daysLeft < 0 ? 'PAST DEADLINE' : left === 1 ? 'LAST WEEK' : `${left} WEEKS LEFT`));

    const title = h('button', { class: 'fi-wk-name', type: 'button', title: 'Rename this week', onclick: () => editWeekTitle(title, k, p) },
      (p.titles?.[k] || `WEEK ${n}`).toUpperCase());
    const slots = Math.max(1, SLOT_HINTS.length - list.length);
    const hintAt = (i) => SLOT_HINTS[Math.min(list.length + i, SLOT_HINTS.length - 1)];
    const arrow = (d, label) => {
      const to = keys[idx + d];
      return h('button', {
        type: 'button', class: ['fi-wk-arrow', d < 0 ? 'is-prev' : 'is-next'], disabled: !to,
        'aria-label': label, title: to ? `${label} · ${shortDate(parseKey(to))}` : label,
        'data-wk': to || null, onclick: () => stepWeek(d),
      }, icon(d < 0 ? 'chevronLeft' : 'chevronRight', 24));
    };
    const card = h('section', {
      class: ['fi-wk', 'fi-wk-card', k === now && 'is-now', k < now && 'is-past', k > lastWk && 'is-after'],
      'data-wk': k, 'aria-label': `${p.titles?.[k] || `Week ${n}`}${k === now ? ', this week' : ''}`,
    },
      title,
      h('p', { class: 'fi-wk-sub' }, 'WHAT’S NEEDED TO BE TRUE'),
      h('div', { class: 'fi-wk-list' }, list.map((x) => taskRow(x, k))),
      Array.from({ length: slots }, (_, i) => adder(k, hintAt(i), i === 0)));
    // The week's dates live in the card's tooltip now; the screen is just the goal and this week.
    card.title = `${shortDate(a)} – ${shortDate(b)}${k === now ? ' · this week' : k > lastWk ? ' · after the deadline' : k === lastWk ? ' · due week' : k < now ? ' · past' : ''} · ← → or swipe to change week`;

    const look = weeklyLook();
    const bgUrl = look.bg ? urlOf(look.bg, () => tab === 'weekly' && refresh()) : null;
    const view = h('div', {
      class: ['fi-weekly', look.bg && 'has-bg'], 'data-wk-theme': look.theme || 'default',
      style: bgUrl ? { '--wk-img': `url("${bgUrl}")` } : null,
    },
      h('div', { class: 'fi-wk-top' }, goal, due),
      // The edge arrows only appear while you drag a requirement (drop on one to send it to that week).
      h('div', { class: 'fi-wk-stage' }, arrow(-1, 'Previous week'), card, arrow(1, 'Next week')),
      selBar(p));
    // Trackpad sideways scroll or a swipe steps weeks — no chevrons on screen.
    view.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return;
      e.preventDefault(); e.stopPropagation();
      const t = performance.now();
      if (t < wkSwipe.lock) return; // one gesture, one week (momentum scrolling keeps firing)
      if (t - wkSwipe.t > 300) wkSwipe.acc = 0;
      wkSwipe.t = t; wkSwipe.acc += e.deltaX;
      if (Math.abs(wkSwipe.acc) > 80) { const d = Math.sign(wkSwipe.acc); wkSwipe.acc = 0; wkSwipe.lock = t + 650; stepWeek(d); }
    }, { passive: false });
    view.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.target.closest('.fi-task, input, button')) return;
      const sx = e.clientX, sy = e.clientY;
      const up = (ev) => {
        view.removeEventListener('pointerup', up);
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepWeek(dx < 0 ? 1 : -1);
      };
      view.addEventListener('pointerup', up);
    });
    // Background & theme now live on a right-click of the empty Weekly space.
    view.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fi-task, input, [contenteditable="true"]')) return;
      e.preventDefault(); lookMenu({ x: e.clientX, y: e.clientY });
    });
    stage.replaceChildren(view);
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
  const poolReg = personal ? null : registerPool({ id: el.id, get: () => w.current()?.ideas || el.ideas || [], set: (list, live) => (live ? w.live : w.patch)({ ideas: list }) });
  const ideasShown = () => tab === 'ideas';
  const offPool = personal ? onPool(() => { if (ideasShown() && ideaView === 'shared') refresh(); }) : () => {};
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
      const poolChanged = next.ideas !== el.ideas;
      el = next;
      if (poolChanged) poolReg?.changed();
      if (changed) refresh();
    },
    destroy() { stopIdeas(); onResize.disconnect(); window.removeEventListener('architect:drop-idea', onDropIdea); poolReg?.off(); offPool(); offMine(); box.remove(); },
  };
}
