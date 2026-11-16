// Fleeting Ideas — one object, four tabs.
//   Ideas    an open canvas: type at the bottom and the idea drifts around like a screensaver.
//            Grab one and it freezes; drop it on the canvas to park it, or on your Path to make it a task.
//   Story    the day as a timeline (GM → Afternoon → Nighttime → Second Wind → new morning).
//            Drop photos, paste videos, type narration; each fragment carries its Set-Point.
//   Tracker  the month: a ringed circle is a day that has a story, in the colour of how the day moved.
//   Weekly   one goal, eight week-columns of checkbox tasks; drag tasks between weeks.
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
const fold = (v) => { v = ((v % 2) + 2) % 2; return v > 1 ? 2 - v : v; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TABS = [['ideas', 'Ideas'], ['story', 'Story'], ['tracker', 'Tracker'], ['weekly', 'Weekly']];
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
  let tab = TABS.some(([id]) => id === mem.tab) ? mem.tab : 'ideas';
  let day = storyKey();
  let month = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
  let hold = 0;          // > 0 while dragging or editing: remote updates wait
  let pending = false;
  let uploads = [];      // story fragments still uploading (this device only)
  const remember = () => store.set(memKey, { tab });

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
    if (!files.length) return;
    e.preventDefault();
    if (tab === 'ideas') { day = storyKey(); setTab('story'); }
    if (tab === 'story') addMediaToStory(files);
  });

  /* ---------------- shared state ---------------- */
  const ideas = () => el.ideas || [];
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
    return { goal: wk.goal || DEFAULT_GOAL, start, deadline, weeks, tray: wk.tray || [] };
  };
  const setIdeas = (list, live = false) => (live ? w.live : w.patch)({ ideas: list });
  const setStory = (k, list) => w.patch({ story: { ...(w.current().story || {}), [k]: list } });
  const setWeekly = (p) => { const cur = weekly(); w.patch({ weekly: { ...cur, ...p } }); };

  /* ---------------- shell ---------------- */
  function setTab(id) {
    if (tab === id) return;
    tab = id; remember();
    paint();
  }

  function paint() {
    tabsRow.replaceChildren(...TABS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: ['fi-tab', tab === id && 'is-on'], 'aria-selected': String(tab === id),
      onclick: () => setTab(id),
    }, label)));
    box.dataset.tab = tab;
    composer.hidden = !(tab === 'ideas' || tab === 'story');
    attach.hidden = tab !== 'story';
    input.placeholder = tab === 'story' ? (day === storyKey() ? 'narrate this moment…' : `add to ${shortDate(parseKey(day))}…`) : 'type an idea…';
    input.setAttribute('aria-label', tab === 'story' ? 'Narrate a moment' : 'Type an idea');
    aside.replaceChildren(...(tab === 'story' ? dayNav() : []));
    stopIdeas();
    stage.replaceChildren();
    stage.scrollTop = 0;
    stage.className = `fi-stage is-${tab}`;
    if (tab === 'ideas') mountIdeas();
    else if (tab === 'story') {
      renderStory();
      // Today opens around the current moment; other days open at first light.
      if (day === storyKey()) stage.scrollTop = Math.max(0, PT + (storyMin() / 1440) * Number(tl.dataset.th) - stage.clientHeight * 0.45);
    }
    else if (tab === 'tracker') renderTracker();
    else renderWeekly();
  }

  function refresh() {
    if (hold > 0) { pending = true; return; }
    const a = document.activeElement;
    if (a && stage.contains(a) && a.matches('input, textarea, [contenteditable="true"]')) { pending = true; return; }
    pending = false;
    if (tab === 'ideas') syncIdeas();
    else if (tab === 'story') renderStory();
    else if (tab === 'tracker') renderTracker();
    else renderWeekly();
  }
  const release = () => { hold = Math.max(0, hold - 1); if (!hold && pending) setTimeout(refresh, 0); };
  stage.addEventListener('focusout', () => setTimeout(() => { if (pending && !stage.contains(document.activeElement)) refresh(); }, 0));

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (tab === 'story') { addFragment({ kind: 'text', text }); return; }
    // A new idea slides in from the bottom and settles somewhere on the ice.
    const x = 0.1 + Math.random() * 0.8;
    setIdeas([...ideas(), {
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

  function mountIdeas() {
    field = h('div', { class: 'fi-field' });
    stage.append(field);
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
    for (const i of list) {
      let n = nodes.get(i.id);
      if (!n) {
        const node = h('div', { class: 'fi-idea', tabindex: 0, 'data-id': i.id });
        bindIdea(node, i.id);
        field.append(node);
        n = { node, w: 0, h: 0 };
        nodes.set(i.id, n);
      }
      if (n.node.textContent !== i.text) n.node.textContent = i.text;
      n.node.title = 'Drag to move · flick to slide · drop on your Path to make it a task';
      n.w = n.node.offsetWidth; n.h = n.node.offsetHeight;
    }
    field.classList.toggle('is-empty', !list.length);
    field.querySelector('.fi-empty')?.remove();
    if (!list.length) field.append(h('p', { class: 'fi-empty' }, 'Nothing drifting yet.', h('br'), 'If it’s on your mind, throw it in below.'));
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
      if (i.id === dragId) continue;
      const m = motion(i, t);
      const px = Math.round(m.x * Math.max(0, W - n.w)), py = Math.round(m.y * Math.max(0, H - n.h));
      n.node.style.transform = `translate(${px}px, ${py}px)`;
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
      const fr0 = field.getBoundingClientRect();
      const scale = fr0.width / (field.clientWidth || 1); // the canvas may be zoomed
      const W = field.clientWidth, H = field.clientHeight;
      const nw = node.offsetWidth, nh = node.offsetHeight;
      const rx = Math.max(1, W - nw), ry = Math.max(1, H - nh);
      // Freeze it exactly where it is on screen: grabbing stops the glide, the text doesn't move.
      const at = motion(idea, Date.now());
      let fx = at.x * rx, fy = at.y * ry;               // its top-left inside the field (unscaled px)
      const offX = (e.clientX - fr0.left) / scale - fx, offY = (e.clientY - fr0.top) / scale - fy;
      node.style.transform = `translate(${Math.round(fx)}px, ${Math.round(fy)}px)`;
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
        node.style.transform = `translate(${Math.round(fx)}px, ${Math.round(fy)}px)`;
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
            setIdeas(ideas().filter((x) => x.id !== id));
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
        setIdeas(ideas().map((q) => (q.id === id ? { ...q, x, y, vx, vy, t0: now, parked: false, mv: me?.id || null } : q)), !moved);
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
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); removeIdea(id); }
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const i = ideas().find((x) => x.id === id);
      if (!i) return;
      menu({ x: e.clientX, y: e.clientY }, [
        { label: 'Edit', icon: 'edit', onSelect: () => editIdea(node, id) },
        { label: 'Give it a nudge', icon: 'curve', onSelect: () => { const m = motion(i, Date.now()); const a = Math.random() * Math.PI * 2; setIdeas(ideas().map((x) => (x.id === id ? { ...x, x: m.x, y: m.y, vx: Math.cos(a) * 0.35, vy: Math.sin(a) * 0.35, t0: Date.now(), parked: false, mv: me?.id || null } : x))); } },
        { label: 'Add to today’s story', icon: 'note', onSelect: () => { addFragment({ kind: 'text', text: i.text }, storyKey()); setIdeas(ideas().filter((x) => x.id !== id)); toast('Added to today’s story.', { ms: 1800 }); } },
        '-',
        { label: 'Let it go', icon: 'trash', danger: true, onSelect: () => removeIdea(id) },
      ]);
    });
  }

  function removeIdea(id) {
    const before = ideas();
    setIdeas(before.filter((x) => x.id !== id));
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
      if (save && text && text !== i.text) setIdeas(ideas().map((x) => (x.id === id ? { ...x, text } : x)));
      else node.textContent = i.text;
      const n = nodes.get(id); if (n) { n.w = node.offsetWidth; n.h = node.offsetHeight; }
      release();
    };
    const onBlur = () => done(true);
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); node.blur(); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    node.addEventListener('blur', onBlur);
    node.addEventListener('keydown', onKey);
  }

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
    if (tab !== 'story' && tab !== 'ideas') return;
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
        onclick: () => { day = k; setTab('story'); },
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
  let scrolledWeek = false;
  const weekDates = (start, n) => { const s = parseKey(start); const a = new Date(s.getFullYear(), s.getMonth(), s.getDate() + (n - 1) * 7); return [a, new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6)]; };

  let showArchive = false;
  const sel = new Set();   // selected task ids (Weekly)
  let anchorId = null;     // for shift-click ranges

  function renderWeekly() {
    const p = weekly();
    const now = keyOf(mondayOf(new Date()));
    const keys = planWeeks(p);
    const first = keyOf(mondayOf(parseKey(p.start))), lastWk = keyOf(mondayOf(parseKey(p.deadline)));
    const numOf = (k) => Math.round((parseKey(k) - parseKey(first)) / (7 * 86_400_000)) + 1;
    const all = [...Object.values(p.weeks).flat(), ...p.tray].map((x) => x.id);
    for (const id of [...sel]) if (!all.includes(id)) sel.delete(id);
    const past = keys.filter((k) => k < now);
    const shown = keys.filter((k) => k >= now || showArchive);
    const left = keys.filter((k) => k >= now && k <= lastWk).length;
    const daysLeft = Math.ceil((parseKey(p.deadline) - new Date(new Date().toDateString())) / 86_400_000);
    const keepX = stage.querySelector('.fi-wk-cols')?.scrollLeft;
    const goal = h('button', { class: 'fi-goal', type: 'button', title: 'Rename the goal', onclick: () => editGoal(goal, p.goal) }, `GOAL: ${p.goal}`.toUpperCase());
    const due = h('button', { class: ['fi-due', daysLeft < 0 && 'is-over'], type: 'button', title: 'Set the start and deadline', onclick: (e) => datesPop(e.currentTarget, p) },
      icon('hourglass', 13),
      `DUE ${shortDate(parseKey(p.deadline)).toUpperCase()} · `,
      h('b', {}, daysLeft < 0 ? 'PAST DEADLINE' : left === 1 ? 'LAST WEEK' : `${left} WEEKS LEFT`));
    const cols = h('div', { class: 'fi-wk-cols' }, shown.map((k) => {
      const list = p.weeks[k] || [];
      const a = parseKey(k), b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
      const n = numOf(k);
      const after = k > lastWk, before = k < first;
      return h('section', { class: ['fi-wk', k === now && 'is-now', k < now && 'is-past', after && 'is-after'], 'data-wk': k, 'aria-label': `Week ${n}${k === now ? ', this week' : ''}` },
        h('header', { class: 'fi-wk-head', title: `${shortDate(a)} – ${shortDate(b)}` },
          h('span', { class: 'fi-wk-row' },
            h('span', { class: 'fi-wk-n' }, before ? 'BEFORE' : `WK ${n}`),
            k === now ? h('span', { class: 'fi-wk-now' }, 'THIS WEEK')
              : h('span', { class: 'fi-wk-date' }, after ? 'AFTER DEADLINE' : k === lastWk ? `DUE · ${shortDate(a).toUpperCase()}` : shortDate(a).toUpperCase())),
          h('span', { class: 'fi-wk-dots', 'aria-label': `${list.filter((x) => x.done).length} of ${list.length} done` }, list.map((x) => h('i', { class: x.done ? 'is-done' : null })))),
        h('div', { class: 'fi-wk-list' }, list.map((x) => taskRow(x, k))),
        k < now ? null : adder(k));
    }));
    if (!shown.length) cols.append(h('p', { class: 'fi-wk-none' }, 'The deadline has passed. Set a new one to plan the next stretch.'));
    const anchor = parseKey(keys.find((k) => k >= now) || lastWk);
    const tray = h('section', { class: 'fi-wk-tray', 'data-wk': 'tray', 'aria-label': 'Tasks without a week' },
      h('span', { class: 'fi-tray-label' }, 'NO WEEK YET'),
      h('div', { class: 'fi-wk-list is-tray' }, p.tray.map((x) => taskRow(x, 'tray'))),
      adder('tray'));
    const pastDone = past.reduce((n, k) => n + (p.weeks[k] || []).length, 0);
    const archiveBtn = past.length ? h('button', {
      type: 'button', class: ['fi-archive', showArchive && 'is-open'], 'aria-expanded': String(showArchive),
      onclick: () => { showArchive = !showArchive; scrolledWeek = false; renderWeekly(); },
    }, icon(showArchive ? 'eyeOff' : 'history', 14), showArchive ? 'HIDE PAST WEEKS' : `ARCHIVE · ${past.length} WEEK${past.length === 1 ? '' : 'S'}${pastDone ? ` · ${pastDone} TASK${pastDone === 1 ? '' : 'S'}` : ''}`) : null;
    const look = weeklyLook();
    const bgUrl = look.bg ? urlOf(look.bg, () => tab === 'weekly' && refresh()) : null;
    const lookBtn = h('button', { class: 'fi-look-btn', type: 'button', title: 'Background & theme', 'aria-label': 'Weekly background and theme', onclick: (e) => lookMenu(e.currentTarget) }, icon('image', 14));
    stage.replaceChildren(h('div', {
      class: ['fi-weekly', look.bg && 'has-bg'], 'data-wk-theme': look.theme || 'default',
      style: bgUrl ? { '--wk-img': `url("${bgUrl}")` } : null,
    },
      h('div', { class: 'fi-wk-top' },
        h('div', { class: 'fi-wk-title' }, h('b', { class: 'fi-ms' }, 'MILESTONE'), h('span', { class: 'fi-ms-month' }, anchor.toLocaleDateString(undefined, { month: 'long' }))),
        h('div', { class: 'fi-wk-goalbox' }, goal, h('span', { class: 'fi-due-row' }, due, lookBtn))),
      archiveBtn ? h('div', { class: 'fi-wk-bar' }, archiveBtn) : null,
      cols, tray, selBar(p)));
    if (keepX != null && scrolledWeek) cols.scrollLeft = keepX;
    else if (showArchive) requestAnimationFrame(() => { const c = cols.querySelector('.fi-wk.is-now'); if (c) cols.scrollLeft = Math.max(0, c.offsetLeft - 8); });
    scrolledWeek = true;
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
      ...planWeeks(p).filter((k) => k >= now).map((k) => ({ label: `${k === now ? 'This week' : `Week ${n(k)}`} · ${shortDate(parseKey(k))}`, icon: 'calendar', onSelect: () => moveSel(k) })),
      { label: 'No week yet', icon: 'folder', onSelect: () => moveSel('tray') }];
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
    if (tab !== 'weekly' || !sel.size || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteSel(); }
    else if (e.key === 'Escape') { e.stopPropagation(); sel.clear(); paintSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); stage.querySelectorAll('.fi-task').forEach((r) => sel.add(r.dataset.id)); paintSel(); }
  });
  // Click on empty space in Weekly clears the selection.
  stage.addEventListener('pointerdown', (e) => {
    if (tab === 'weekly' && sel.size && !e.target.closest('.fi-task, .fi-sel-bar, .menu')) { sel.clear(); paintSel(); }
  });

  function adder(wk) {
    const inp = h('input', {
      class: 'fi-add-input', maxlength: 160, placeholder: wk === 'tray' ? 'a task without a week…' : 'add a task…', 'aria-label': wk === 'tray' ? 'Add a task without a week' : `Add a task to week ${wk}`,
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
        stage.querySelector(`[data-wk="${wk}"] .fi-add-input`)?.focus();
      },
    });
    return h('label', { class: 'fi-add' }, icon('plus', 13), inp);
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

  paint();

  return {
    update(next) {
      const changed = next.ideas !== el.ideas || next.story !== el.story || next.weekly !== el.weekly;
      el = next;
      if (changed) refresh();
    },
    destroy() { stopIdeas(); onResize.disconnect(); box.remove(); },
  };
}
