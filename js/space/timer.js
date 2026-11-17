// Timer — one object, three modes, shared live with everyone in the Space.
//   Timer      set it, start it; a ring of 60 dots empties as it runs. Ends with a chime + red outline.
//   Stopwatch  counts up, with laps.
//   Setpoint   counts down to the end of the setpoint you're in (GM → Afternoon → Nighttime → Second Wind).
// State lives on the widget element as end-timestamps, so every screen shows the same time and it keeps
// running through reloads, tab sleep and offline. Mode tabs sit in the header, styled like Path's day tabs.
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { prefersReducedMotion } from '../core/util.js';
import { SETPOINTS } from './fleeting.js';

const DOTS = 60;
const MAX = 99 * 3600 + 59 * 60 + 59;
const DAY_START = 7 * 60; // the story/setpoint day runs 7AM → 7AM
const MODES = [['timer', 'Timer'], ['watch', 'Stopwatch'], ['setpoint', 'Setpoint']];
const PRESETS = [[15, '15M'], [60, '1H'], [120, '2H'], [240, '4H'], [600, '10H'], [1800, '30H']];
const pad = (n) => String(n).padStart(2, '0');
const split = (sec) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), Math.floor(sec % 60)];
const fmtWatch = (ms) => { const [hh, m, sec] = split(ms / 1000); return `${hh ? `${hh}:` : ''}${pad(m)}:${pad(sec)}.${pad(Math.floor((ms % 1000) / 10))}`; };
const clock12 = (d) => `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;

// Inline glyphs the shared icon set doesn't have.
const flag = () => s('svg', { viewBox: '0 0 24 24', width: 18, height: 18, class: 'ic', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  s('path', { d: 'M6 21V4M6 4h11l-2.2 4L17 12H6' }));
const solid = (d) => s('svg', { viewBox: '0 0 24 24', width: 22, height: 22, class: 'ic', fill: 'currentColor', 'aria-hidden': 'true' }, s('path', { d }));
const PLAY = 'M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z';
const PAUSE = 'M7 5h3.2v14H7zM13.8 5H17v14h-3.2z';

export function mountTimer(root, el0, w) {
  let el = el0;
  const st = () => ({ mode: 'timer', set: 25 * 60, end: null, left: 25 * 60, wStart: null, wAcc: 0, laps: [], ...(w.current().timer || el.timer || {}) });
  const save = (p) => w.patch({ timer: { ...st(), ...p } });

  /* ---------------- dom ---------------- */
  const ring = s('svg', { class: 'tmr-ring', viewBox: '-100 -100 200 200', 'aria-hidden': 'true' });
  const dots = Array.from({ length: DOTS }, (_, i) => {
    const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2;
    const c = s('circle', { cx: (Math.cos(a) * 92).toFixed(2), cy: (Math.sin(a) * 92).toFixed(2), r: 1.5 });
    ring.append(c);
    return c;
  });
  const label = h('div', { class: 'tmr-label' });
  const digits = h('div', { class: 'tmr-digits' });
  const sub = h('div', { class: 'tmr-sub' });
  const presets = h('div', { class: 'tmr-presets' });
  const goBtn = h('button', { type: 'button', class: 'tmr-go', onclick: () => toggle() });
  const resetBtn = h('button', { type: 'button', class: 'tmr-ghost', 'aria-label': 'Reset', title: 'Reset · R', onclick: () => reset() }, icon('undo', 18));
  const auxBtn = h('button', { type: 'button', class: 'tmr-ghost', onclick: () => aux() });
  const laps = h('ol', { class: 'tmr-laps' });
  const live = h('div', { class: 'tmr-sr', role: 'status', 'aria-atomic': 'true' });
  const box = h('div', { class: 'tmr', tabindex: 0, 'aria-label': 'Timer' },
    h('div', { class: 'tmr-stage' },
      h('div', { class: 'tmr-dial' }, ring, h('div', { class: 'tmr-core' }, label, digits, sub, presets))),
    h('div', { class: 'tmr-ctl' }, resetBtn, goBtn, auxBtn),
    laps, live);
  root.append(box);

  // Mode tabs live in the header, like Path's day tabs.
  const tabs = h('div', { class: 'pdays tmr-tabs', role: 'tablist', 'aria-label': 'Timer mode' });
  w.slot.replaceChildren(tabs);

  /* ---------------- derived ---------------- */
  const now = () => Date.now();
  const timerLeft = (t) => (t.end ? (t.end - now()) / 1000 : t.left);
  const isDone = (t) => t.mode === 'timer' && !!t.end && t.end <= now();
  const watchMs = (t) => (t.wAcc || 0) + (t.wStart ? now() - t.wStart : 0);
  function setpoint() {
    const d = new Date();
    const m = (d.getHours() * 60 + d.getMinutes() - DAY_START + 1440) % 1440 + d.getSeconds() / 60;
    const i = [...SETPOINTS].map((x, j) => j).reverse().find((j) => m >= SETPOINTS[j].from) ?? 0;
    const sp = SETPOINTS[i], next = SETPOINTS[(i + 1) % SETPOINTS.length];
    const endM = i + 1 < SETPOINTS.length ? next.from : 1440;
    const len = endM - sp.from;
    const leftSec = (endM - m) * 60;
    const at = new Date(d.getTime() + leftSec * 1000);
    return { sp, next, left: leftSec, frac: leftSec / (len * 60), at };
  }

  /* ---------------- paint ---------------- */
  let lastHtml = '', lastTabs = '', lastCtl = '', lastLaps = -1, lastPre = '', announced = -1, chimed = null;
  function paintRing(frac, head) {
    const lit = Math.round(Math.max(0, Math.min(1, frac)) * DOTS);
    for (let i = 0; i < DOTS; i++) {
      const c = dots[i];
      const cls = i === head ? 'is-head' : i < lit ? 'is-on' : '';
      if (c.getAttribute('class') !== cls) { c.setAttribute('class', cls); c.setAttribute('r', cls === 'is-head' ? 2.7 : cls ? 1.9 : 1.5); }
    }
  }
  // Builds the segments only when the layout changes (so a focused segment keeps focus while you type),
  // then just updates their numbers.
  function paintDigits(sec, editable, floor = false) {
    const [hh, m, ss] = split(Math.max(0, floor ? Math.floor(sec) : Math.ceil(sec)));
    const showH = true; // always HH:MM:SS — built for long sessions (up to 99h)
    const shape = `${editable}|${showH}`;
    if (shape !== lastHtml) {
      lastHtml = shape;
      const seg = (u) => h('span', { class: 'tmr-seg', 'data-u': u, ...(editable ? { tabindex: 0, role: 'spinbutton', 'aria-label': { h: 'Hours', m: 'Minutes', s: 'Seconds' }[u] } : {}) });
      const c = () => h('i', { class: 'tmr-colon' }, ':');
      digits.replaceChildren(...(showH ? [seg('h'), c()] : []), seg('m'), c(), seg('s'));
    }
    for (const [u, v] of [['h', hh], ['m', m], ['s', ss]]) {
      const n = digits.querySelector(`[data-u="${u}"]`);
      if (!n) continue;
      const t = pad(v);
      if (n.textContent !== t) n.textContent = t;
      if (editable) n.setAttribute('aria-valuenow', String(v));
    }
    digits.classList.toggle('is-edit', editable);
    digits.classList.toggle('is-long', showH);
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !box.isConnected) return;
    const t = st();
    const done = isDone(t);
    let running = false, text = '', subTxt = '';
    if (t.mode === 'timer') {
      const left = Math.max(0, timerLeft(t));
      const editable = !t.end && t.left === t.set;
      running = !!t.end && !done;
      paintDigits(left, editable);
      const frac = t.set ? left / t.set : 0;
      paintRing(done ? 0 : frac, running ? Math.max(0, Math.round(frac * DOTS) - 1) : -1);
      text = done ? 'Time' : running ? 'Running' : t.left < t.set ? 'Paused' : 'Set';
      if (running) { const e = new Date(t.end), today = new Date().toDateString() === e.toDateString(); subTxt = `ends ${today ? '' : `${e.toLocaleDateString(undefined, { weekday: 'short' })} `}${clock12(e)}`; }
      if (running) { const mLeft = Math.ceil(left / 60); if (mLeft !== announced) { announced = mLeft; live.textContent = `${mLeft} minute${mLeft === 1 ? '' : 's'} left`; } }
      if (done && chimed !== t.end) { chimed = t.end; if (now() - t.end < 15_000) { live.textContent = 'Time is up'; chime(); } }
    } else if (t.mode === 'watch') {
      const ms = watchMs(t);
      running = !!t.wStart;
      paintDigits(ms / 1000, false, true);
      const sec = Math.floor(ms / 1000) % 60;
      paintRing(ms ? (sec + 1) / DOTS : 0, running ? sec : -1);
      text = running ? 'Running' : ms ? 'Paused' : 'Stopwatch';
      subTxt = t.laps?.length ? `${t.laps.length} lap${t.laps.length === 1 ? '' : 's'}` : '';
    } else {
      const p = setpoint();
      running = true;
      paintDigits(p.left, false);
      paintRing(p.frac, Math.max(0, Math.round(p.frac * DOTS) - 1));
      text = p.sp.label;
      subTxt = `next · ${p.next.label} at ${clock12(p.at)}`;
    }
    if (label.textContent !== text) label.textContent = text;
    if (sub.textContent !== subTxt) sub.textContent = subTxt;
    box.classList.toggle('is-run', running && t.mode !== 'setpoint');
    box.classList.toggle('is-done', done);
    box.dataset.mode = t.mode;
    paintChrome(t, running, done);
  }

  function paintChrome(t, running, done) {
    const tk = t.mode;
    if (tk !== lastTabs) {
      lastTabs = tk;
      tabs.replaceChildren(...MODES.map(([id, name]) => h('button', {
        type: 'button', role: 'tab', class: ['pday', t.mode === id && 'is-on'], 'aria-selected': String(t.mode === id),
        onclick: () => { if (st().mode !== id) save({ mode: id }); },
      }, name)));
    }
    const pre = t.mode === 'timer' && !t.end ? 'show' : '';
    if (pre !== lastPre) {
      lastPre = pre;
      presets.replaceChildren(...(pre ? PRESETS.map(([m, txt]) => h('button', { type: 'button', class: ['tmr-pre'], onclick: () => setDuration(m * 60) }, txt)) : []));
    }
    const ck = `${t.mode}|${running}|${done}|${t.mode === 'timer' ? t.left === t.set && !t.end : !!(t.wAcc || t.wStart)}`;
    if (ck !== lastCtl) {
      lastCtl = ck;
      const setMode = t.mode === 'setpoint';
      goBtn.replaceChildren(done ? icon('check', 24, { weight: 2.2 }) : solid(running ? PAUSE : PLAY));
      goBtn.setAttribute('aria-label', done ? 'Dismiss' : running ? 'Pause' : 'Start');
      goBtn.title = `${goBtn.getAttribute('aria-label')} · Space`;
      if (t.mode === 'watch') { auxBtn.replaceChildren(flag()); auxBtn.setAttribute('aria-label', 'Lap'); auxBtn.title = 'Lap · L'; }
      else { auxBtn.replaceChildren(icon('plus', 18)); auxBtn.setAttribute('aria-label', 'Add one minute'); auxBtn.title = 'Add one minute · +'; }
      auxBtn.disabled = t.mode === 'watch' && !running;
      resetBtn.disabled = t.mode === 'timer' ? (t.left === t.set && !t.end) : !(t.wAcc || t.wStart);
      for (const b of [goBtn, auxBtn, resetBtn]) b.hidden = setMode;
    }
    const n = t.mode === 'watch' ? (t.laps?.length || 0) : 0;
    if (n !== lastLaps) {
      lastLaps = n;
      laps.hidden = !n;
      laps.replaceChildren(...(t.laps || []).slice(0, 50).map((l, i, all) => h('li', {},
        h('span', {}, `LAP ${pad((t.laps.length) - i)}`), h('span', {}, fmtWatch(l.d)), h('span', {}, fmtWatch(l.t)))));
    }
  }

  /* ---------------- actions ---------------- */
  function toggle() {
    const t = st();
    if (t.mode === 'setpoint') return;
    unlockAudio();
    if (t.mode === 'timer') {
      if (isDone(t)) { save({ end: null, left: t.set }); return; }
      if (t.end) save({ end: null, left: Math.max(0, timerLeft(t)) });
      else if (t.left > 0) save({ end: now() + t.left * 1000, by: w.me?.id || null });
    } else if (t.wStart) save({ wAcc: watchMs(t), wStart: null });
    else save({ wStart: now() });
  }
  function reset() {
    const t = st();
    if (t.mode === 'timer') save({ end: null, left: t.set });
    else if (t.mode === 'watch') save({ wStart: null, wAcc: 0, laps: [] });
  }
  function aux() {
    const t = st();
    if (t.mode === 'timer') {
      if (isDone(t)) save({ end: now() + 60_000 });
      else if (t.end) save({ end: t.end + 60_000 });
      else { const v = Math.min(MAX, t.left + 60); save(t.left === t.set ? { set: v, left: v } : { left: v }); }
    } else if (t.mode === 'watch' && t.wStart) {
      const ms = watchMs(t), prev = t.laps?.[0]?.t || 0;
      save({ laps: [{ t: ms, d: ms - prev }, ...(t.laps || [])].slice(0, 200) });
    }
  }
  function setDuration(sec) {
    const v = Math.max(0, Math.min(MAX, Math.round(sec)));
    save({ set: v, left: v, end: null });
  }
  const UNIT = { h: 3600, m: 60, s: 1 };
  function nudge(u, dir) {
    const t = st();
    if (t.mode !== 'timer' || t.end || t.left !== t.set) return;
    setDuration(Math.max(0, t.set + dir * UNIT[u]));
  }

  /* ---------------- input ---------------- */
  digits.addEventListener('wheel', (e) => {
    const u = e.target.closest?.('.tmr-seg')?.dataset.u;
    if (!u || !digits.classList.contains('is-edit')) return;
    e.preventDefault(); e.stopPropagation();
    nudge(u, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  let drag = null;
  digits.addEventListener('pointerdown', (e) => {
    const seg = e.target.closest?.('.tmr-seg');
    if (!seg || !digits.classList.contains('is-edit')) return;
    e.stopPropagation();
    drag = { u: seg.dataset.u, y: e.clientY };
    try { seg.setPointerCapture(e.pointerId); } catch {}
  });
  digits.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) >= 14) { nudge(drag.u, Math.sign(dy)); drag.y = e.clientY; }
  });
  const endDrag = () => { drag = null; };
  digits.addEventListener('pointerup', endDrag);
  digits.addEventListener('pointercancel', endDrag);
  let typed = '';
  digits.addEventListener('focusout', () => { typed = ''; });

  // Keys work while the Timer has focus (click it once). E is tracked so E+R never resets it.
  let eDown = false;
  box.addEventListener('keyup', (e) => { if (e.code === 'KeyE') eDown = false; });
  box.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = st();
    const seg = e.target.closest?.('.tmr-seg');
    if (seg && digits.classList.contains('is-edit')) {
      const u = seg.dataset.u;
      if (/^\d$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        typed = (typed + e.key).slice(-2);
        const [hh, m, ss] = split(t.set);
        const v = Math.min(Number(typed), u === 'h' ? 99 : 59);
        setDuration((u === 'h' ? v : hh) * 3600 + (u === 'm' ? v : m) * 60 + (u === 's' ? v : ss));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); nudge(u, e.key === 'ArrowUp' ? 1 : -1); return; }
    }
    if (e.code === 'KeyE') { eDown = true; return; }
    const k = e.key.toLowerCase();
    let hit = true;
    if (k === ' ' && !e.target.closest('button')) toggle();
    else if (k === 'r' && !eDown) reset();
    else if (k === 'l' && t.mode === 'watch') aux();
    else if ((k === '+' || k === '=') && t.mode === 'timer') aux();
    else if (k === '1' || k === '2' || k === '3') save({ mode: MODES[Number(k) - 1][0] });
    else if ((k === 'arrowup' || k === 'arrowdown') && t.mode === 'timer') nudge('m', k === 'arrowup' ? 1 : -1);
    else hit = false;
    if (hit) { e.preventDefault(); e.stopPropagation(); }
  });
  // A click anywhere in the body (not on a control) gives it keyboard focus.
  box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, .tmr-seg')) box.focus({ preventScroll: true }); });

  /* ---------------- sound: a WebAudio chime, no files, no paid services ---------------- */
  let ac = null;
  function unlockAudio() { try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); ac.resume?.(); } catch {} }
  function chime() {
    if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
    unlockAudio();
    if (!ac) return;
    let n = 0;
    const ring1 = () => {
      const t0 = ac.currentTime;
      [880, 1320].forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.18);
        g.gain.linearRampToValueAtTime(0.16, t0 + i * 0.18 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.6);
        o.connect(g).connect(ac.destination);
        o.start(t0 + i * 0.18); o.stop(t0 + i * 0.18 + 0.65);
      });
    };
    ring1();
    clearInterval(chimeT);
    chimeT = setInterval(() => { if (++n >= 4 || !isDone(st())) { clearInterval(chimeT); return; } ring1(); }, 1500);
  }
  let chimeT = 0;
  box.addEventListener('pointerdown', unlockAudio, { once: true });

  // If it finished while nobody was looking, show the finished state without a late chime.
  { const t = st(); if (isDone(t)) chimed = t.end; }
  if (prefersReducedMotion()) box.classList.add('is-still');
  let raf = requestAnimationFrame(frame);

  return {
    update(next) { el = next; },
    destroy() { cancelAnimationFrame(raf); clearInterval(chimeT); try { ac?.close(); } catch {} w.slot.replaceChildren(); box.remove(); },
  };
}
