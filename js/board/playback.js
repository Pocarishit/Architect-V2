// Play in sequence (Nov 22) — a frame (or a selection) plays its objects one after another.
// The camera flies to each object and rings it; a note with a voice note plays its clip, a note
// without one is read out loud (free browser voices), a video plays through, anything else holds for
// a beat. A small player at the bottom: back · play/pause · next · read-aloud · stop. Esc stops.
//
// Order: reading order — top row first, left to right — unless arrows join the objects, in which
// case the arrows lead (follow the chain from its start).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/ui.js';
import { store } from '../core/util.js';
import { rectOf } from './geometry.js';
import { playClip, startRecording, uploadMedia, canRecord, fmtDur } from '../space/media.js';
import { sayAloud } from '../space/chat.js';

const SKIP = new Set(['frame', 'line', 'pen', 'border']);
const READ = 'architect.play.read';
let active = null; // only one sequence plays at a time

const textOf = (el) => String(el.text || el.title || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Objects inside a frame, in play order. */
export function itemsInFrame(editor, frame) {
  const f = rectOf(frame, editor.byId);
  const inside = editor.els.filter((e) => {
    if (SKIP.has(e.type) || e.id === frame.id || editor.isHidden?.(e)) return false;
    const r = rectOf(e, editor.byId);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
  });
  const auto = order(editor, inside);
  // A frame remembers the order you set in the sidebar (frame.seq). Anything added since goes on the end.
  if (!Array.isArray(frame.seq) || !frame.seq.length) return auto;
  const byId = new Map(inside.map((e) => [e.id, e]));
  const kept = frame.seq.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const have = new Set(kept.map((e) => e.id));
  return [...kept, ...auto.filter((e) => !have.has(e.id))];
}

export function order(editor, list) {
  const rs = new Map(list.map((e) => [e.id, rectOf(e, editor.byId)]));
  // Reading order: group into rows (centers within half a typical height), then left to right.
  const hs = [...rs.values()].map((r) => r.h).sort((a, b) => a - b);
  const tol = Math.max(24, (hs[Math.floor(hs.length / 2)] || 80) * 0.5);
  const byY = [...list].sort((a, b) => (rs.get(a.id).y + rs.get(a.id).h / 2) - (rs.get(b.id).y + rs.get(b.id).h / 2));
  const rows = [];
  for (const e of byY) {
    const cy = rs.get(e.id).y + rs.get(e.id).h / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) <= tol) { row.items.push(e); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; }
    else rows.push({ cy, items: [e] });
  }
  const reading = rows.flatMap((r) => r.items.sort((a, b) => rs.get(a.id).x - rs.get(b.id).x));
  // Arrows lead when they join these objects.
  const ids = new Set(list.map((e) => e.id));
  const next = new Map(), hasIn = new Set();
  for (const l of editor.els) {
    if (l.type !== 'line') continue;
    const a = l.a?.id, b = l.b?.id;
    if (typeof a !== 'string' || typeof b !== 'string' || !ids.has(a) || !ids.has(b)) continue;
    if (!next.has(a)) next.set(a, b);
    hasIn.add(b);
  }
  if (!next.size) return reading;
  const out = [], seen = new Set();
  const walk = (id) => { while (id && !seen.has(id)) { seen.add(id); out.push(id); id = next.get(id); } };
  for (const e of reading) if (!hasIn.has(e.id)) walk(e.id);
  for (const e of reading) walk(e.id);
  const byId = new Map(list.map((e) => [e.id, e]));
  return out.map((id) => byId.get(id));
}

/** Play a list of element ids in sequence on this board. */
export function playSequence(editor, page, list, { title = 'Sequence', frameId = null, paused: startPaused = false } = {}) {
  active?.stop();
  let ids = [...list];
  if (!ids.length) { toast('Nothing in here to play yet.', { ms: 2000 }); return null; }
  const cam0 = { ...editor.cam };
  let i = -1, paused = false, stopped = false, cur = null, timer = 0, token = 0;
  let read = store.get(READ, true) !== false;
  const heard = new Set(); // positions already played this run

  const count = h('span', { class: 'pl-count' });
  const label = h('span', { class: 'pl-label' });
  const ppBtn = h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Pause', onclick: () => toggle() }, icon('pause', 16));
  const readBtn = h('button', { class: ['bp-icon', 'pl-read', read && 'is-on'], type: 'button', 'aria-pressed': String(read), 'aria-label': 'Read notes out loud', title: 'Read notes without a voice note out loud', onclick: () => {
    read = !read; store.set(READ, read);
    readBtn.classList.toggle('is-on', read); readBtn.setAttribute('aria-pressed', String(read));
  } }, icon('speaker', 16));
  const bar = h('i', { class: 'pl-bar' });
  const hud = h('div', { class: 'bp-hud bp-pill pl-hud', role: 'region', 'aria-label': `Playing ${title}` },
    h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Previous', onclick: () => go(i - 1) }, icon('chevronLeft', 18)),
    ppBtn,
    h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Next', onclick: () => go(i + 1) }, icon('chevronRight', 18)),
    h('span', { class: 'hud-sep' }), count, label, readBtn,
    h('span', { class: 'hud-sep' }),
    h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Stop', title: 'Stop (Esc)', onclick: () => stop() }, icon('close', 18)),
    bar);
  /* ---- the order sidebar (Nov 22): click a row to jump there; drag a row (or use ↑ ↓) to change the
     order. A frame keeps the new order, so next time it plays the same way. ---- */
  const rows = h('ol', { class: 'pl-rows', role: 'listbox', 'aria-label': 'Play order' });
  const side = h('aside', { class: 'pl-side', 'aria-label': 'Play order' },
    h('div', { class: 'pl-side-head' }, h('span', { class: 'pl-side-t' }, 'ORDER'), h('span', { class: 'pl-side-sub' }, frameId ? 'Drag to reorder · saved to the frame' : 'Drag to reorder')),
    rows,
    frameId ? h('button', { class: 'pl-side-reset', type: 'button', onclick: () => {
      const f = editor.byId.get(frameId);
      if (!f) return;
      editor.updateEls([frameId], { seq: undefined });
      const cur = ids[i];
      ids = itemsInFrame(editor, { ...f, seq: undefined }).map((e) => e.id);
      i = Math.max(0, ids.indexOf(cur));
      paintRows(); paintCount();
      toast('Back to reading order.', { ms: 1400 });
    } }, 'Reset to reading order') : null);
  function paintRows() {
    rows.replaceChildren(...ids.map((id, k) => {
      const el = editor.byId.get(id);
      const name = el ? (textOf(el) || ({ sticky: 'Note', image: 'Image', video: 'Video', widget: 'Object', shape: 'Shape' }[el.type] || 'Object')) : 'Removed';
      const up = h('button', { class: 'pl-mv', type: 'button', 'aria-label': 'Move up', disabled: k === 0, onclick: (e) => { e.stopPropagation(); move(k, k - 1); } }, icon('chevronUp', 13));
      const dn = h('button', { class: 'pl-mv', type: 'button', 'aria-label': 'Move down', disabled: k === ids.length - 1, onclick: (e) => { e.stopPropagation(); move(k, k + 1); } }, icon('chevronDown', 13));
      const row = h('li', { class: ['pl-row', k === i && 'is-on'], role: 'option', 'aria-selected': String(k === i), tabindex: 0, 'data-k': k,
        onclick: () => go(k),
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(k); }
          if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(k, k - 1, true); }
          if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(k, k + 1, true); }
        },
      },
      h('span', { class: 'pl-grip', 'aria-hidden': 'true' }, icon('grip', 12)),
      h('span', { class: 'pl-n' }, String(k + 1).padStart(2, '0')),
      h('span', { class: 'pl-name' }, name),
      el?.audio ? h('span', { class: 'pl-has-voice', title: 'Has a voice note' }, icon('mic', 12)) : null,
      h('span', { class: 'pl-mvs' }, up, dn));
      row.querySelector('.pl-grip').addEventListener('pointerdown', (e) => dragRow(e, k));
      return row;
    }));
    rows.querySelector('.pl-row.is-on')?.scrollIntoView({ block: 'nearest' });
    paintBadges();
  }
  // Small red numbered circles on the objects themselves, so you can see on the board which plays when.
  function paintBadges() {
    editor.vp.querySelectorAll('.pl-badge').forEach((b) => b.remove());
    if (stopped) return;
    ids.forEach((id, k) => {
      const n = nodeOf(id);
      if (!n) return;
      n.append(h('span', { class: ['pl-badge', k === i && 'is-on'], 'aria-hidden': 'true' }, String(k + 1)));
    });
  }
  const offChange = editor.on?.('change', () => requestAnimationFrame(() => {
    if (!stopped && ids.some((id) => { const n = nodeOf(id); return n && !n.querySelector(':scope > .pl-badge'); })) paintBadges();
  }));
  function move(from, to, focus = false) {
    if (to < 0 || to >= ids.length || from === to) return;
    const cur = ids[i];
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    i = ids.indexOf(cur);
    if (frameId && editor.byId.get(frameId)) editor.updateEls([frameId], { seq: [...ids] });
    paintRows(); paintCount();
    if (focus) rows.querySelector(`[data-k="${to}"]`)?.focus();
  }
  function dragRow(e, k) {
    e.preventDefault(); e.stopPropagation();
    const row = rows.children[k];
    const items = [...rows.children];
    const rects = items.map((r) => r.getBoundingClientRect());
    const y0 = e.clientY;
    let to = k;
    row.classList.add('is-drag');
    const mv = (ev) => {
      const dy = ev.clientY - y0;
      row.style.transform = `translateY(${dy}px)`;
      const cy = rects[k].top + rects[k].height / 2 + dy;
      to = rects.reduce((best, r, j) => (Math.abs(r.top + r.height / 2 - cy) < Math.abs(rects[best].top + rects[best].height / 2 - cy) ? j : best), k);
      items.forEach((r, j) => {
        if (j === k) return;
        const shift = k < to && j > k && j <= to ? -rects[k].height - 4 : k > to && j < k && j >= to ? rects[k].height + 4 : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const upH = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upH); window.removeEventListener('pointercancel', upH);
      items.forEach((r) => { r.style.transform = ''; });
      row.classList.remove('is-drag');
      if (to !== k) move(k, to); else paintRows();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', upH); window.addEventListener('pointercancel', upH);
  }
  function paintCount() {
    count.textContent = `${String(i + 1).padStart(2, '0')} / ${String(ids.length).padStart(2, '0')}`;
    bar.style.width = `${((i + 1) / ids.length) * 100}%`;
  }

  page.append(hud, side);
  page.classList.add('is-playing-seq');
  editor.finishEditing?.(); editor.clearSel?.();

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
    else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
  };
  window.addEventListener('keydown', onKey, true);

  const nodeOf = (id) => editor.vp.querySelector(`[data-eid="${CSS.escape(id)}"]`);
  function ring(id) {
    editor.vp.querySelectorAll('.is-seq-on').forEach((n) => n.classList.remove('is-seq-on'));
    nodeOf(id)?.classList.add('is-seq-on');
  }
  function halt() {
    clearTimeout(timer); timer = 0;
    cur?.stop(); cur = null;
    const v = editor.vp.querySelector('.is-seq-on video');
    if (v) { v.pause(); v.onended = null; }
  }
  async function go(n) {
    if (stopped) return;
    halt();
    if (n >= ids.length) { stop(true); return; }
    i = Math.max(0, n);
    const my = ++token;
    const el = editor.byId.get(ids[i]);
    if (!el) { go(i + 1); return; }
    paintCount();
    paintRows();
    label.textContent = textOf(el).slice(0, 40) || ({ sticky: 'Note', image: 'Image', video: 'Video', widget: 'Object' }[el.type] || 'Object');
    const r = rectOf(el, editor.byId);
    editor.fitRect(r, { pad: 90, maxZ: el.type === 'widget' ? 1.1 : 2.2 });
    ring(el.id);
    await new Promise((res) => setTimeout(res, 520)); // let the camera arrive
    if (my !== token || stopped) return;
    let done;
    if (paused) { cur = null; return; }
    heard.add(i); // parked on this one; ▶ plays it
    if (el.audio?.path) { cur = playClip(el.audio.path); done = cur.done; }
    else if (el.type === 'video') {
      const v = nodeOf(el.id)?.querySelector('video');
      if (v) {
        done = new Promise((res) => { v.onended = res; v.play().catch(res); });
        cur = { stop: () => v.pause(), pause: () => v.pause(), resume: () => v.play().catch(() => {}) };
      }
    } else if (read && textOf(el)) { cur = sayAloud(textOf(el)); done = cur.done; }
    if (!done) {
      // Nothing to hear: hold long enough to take it in.
      const words = textOf(el).split(' ').filter(Boolean).length;
      const ms = Math.min(9000, 2200 + words * 260);
      done = new Promise((res) => { const t0 = Date.now(); let left = ms; const tick = () => { if (stopped || my !== token) return res(); if (paused) { timer = setTimeout(tick, 200); return; } left -= Date.now() - (tick.t || t0); tick.t = Date.now(); if (left <= 0) res(); else timer = setTimeout(tick, 120); }; timer = setTimeout(tick, 120); });
    }
    await done;
    if (my !== token || stopped) return;
    cur = null;
    if (paused) return; // resume will move on
    timer = setTimeout(() => { if (my === token && !paused) go(i + 1); }, 450);
  }
  function setPaused(p) {
    paused = p;
    ppBtn.replaceChildren(icon(paused ? 'play' : 'pause', 16));
    ppBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }
  function toggle() {
    setPaused(!paused);
    if (paused) { cur?.pause(); return; }
    if (cur) cur.resume();
    else go(heard.has(i) ? i + 1 : i);
  }
  function stop(finished = false) {
    if (stopped) return;
    stopped = true; token++;
    halt();
    try { window.speechSynthesis?.cancel(); } catch {}
    window.removeEventListener('keydown', onKey, true);
    editor.vp.querySelectorAll('.is-seq-on').forEach((n) => n.classList.remove('is-seq-on'));
    editor.vp.querySelectorAll('.pl-badge').forEach((b) => b.remove());
    offChange?.();
    hud.classList.add('out'); side.classList.add('out'); setTimeout(() => { hud.remove(); side.remove(); }, 200);
    page.classList.remove('is-playing-seq');
    editor.setCamera(cam0, { animate: true });
    if (finished) toast(`Played ${ids.length} ${ids.length === 1 ? 'object' : 'objects'}.`, { ms: 1600 });
    if (active === api) active = null;
  }
  const api = { stop };
  active = api;
  if (startPaused) setPaused(true);
  go(0);
  return api;
}

/** Record your voice onto a note; the clip plays from the note's ▶ chip and during Play. */
export async function recordOnto(editor, page, el) {
  if (!canRecord()) { toast('This browser can’t record audio.', { tone: 'error' }); return; }
  const time = h('span', { class: 'pl-rec-t' }, '0:00');
  let rec = null, gone = false;
  const close = () => { if (gone) return; gone = true; pill.remove(); window.removeEventListener('keydown', onKey, true); };
  const save = async () => {
    if (!rec) return;
    const r = rec; rec = null;
    close();
    const clip = await r.stop();
    if (!clip) { toast('That was too short to keep.', { ms: 1800 }); return; }
    const t = toast('Saving voice note…', { ms: 30000 });
    try {
      const up = await uploadMedia(clip.file, { dur: clip.dur });
      if (!editor.byId.get(el.id)) return;
      editor.updateEls([el.id], { audio: { path: up.path, dur: clip.dur } });
      toast('Voice note added — ▶ on the note plays it.', { ms: 2200 });
    } catch (e) { toast(e?.message || 'Couldn’t save the voice note.', { tone: 'error', ms: 4000 }); }
    finally { t?.close?.(); }
  };
  const cancel = () => { rec?.cancel(); rec = null; close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
  };
  const pill = h('div', { class: 'bp-pill pl-rec', role: 'status' },
    h('i', { class: 'pl-rec-dot', 'aria-hidden': 'true' }), time,
    h('span', { class: 'pl-rec-hint' }, 'Recording onto the note'),
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: cancel }, 'Cancel'),
    h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, icon('check', 14), 'Save'));
  page.append(pill);
  window.addEventListener('keydown', onKey, true);
  try {
    rec = await startRecording({ onTick: (s) => { time.textContent = fmtDur(s) || '0:00'; if (s >= 300) save(); } });
    if (gone) { rec.cancel(); rec = null; }
  } catch (e) {
    close();
    toast(e?.name === 'NotAllowedError' ? 'Allow the microphone to record a voice note.' : 'Couldn’t open the microphone.', { tone: 'error', ms: 4000 });
  }
}
