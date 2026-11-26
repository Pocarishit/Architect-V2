// Zones and Zone Cubes (Nov 26) — the Variables chat canvas (Free View).
//
// A zone is a named, colored section drawn on the canvas. Every message or attachment that touches it, even
// partly, belongs to it in full and is protected while it does: it can't be moved, edited or deleted on its
// own (batch actions included) — it can still be read and its text copied. Removing the zone releases them.
//
// Capture Zone moves the section off the canvas into the chat's Library as a Zone Cube. A cube carries the
// content itself (full messages, attachments, layout, the connectors between included items) — not a link
// back. From the Library a cube can be opened here (an overlay: nothing is posted, the canvas doesn't move),
// embedded in the chat (an outlined, view-only zone; Edit Mode moves it as one unit), presented (a spoken
// walkthrough in an order you can edit and that's saved with the cube), copied (then pasted where you want
// it), copied or moved to another chat, copied to a Blueprint, or exported.
//
// Shapes:
//   zone    { id, name, color, x, y, w, h, members?: [ids] }                (entry.free.zones)
//   embed   { id, cube, x, y, edit? }                                       (entry.free.embeds)
//   cube    { id, name, color, at, x, y, content, seq? }                    (entry.library.cubes)
//   content { w, h, items: [{ id, kind: 'msg'|'note'|'text'|'img', x, y, w, h, text, files?, path?,
//             by?, name?, ts? , raw }], links: [{ a, b, arrow }] }
import { confirmByName } from './nov27.js';
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, confirmDialog, promptDialog, closeFloating, popover } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { urlOf } from './media.js';

export const ZONE_COLORS = ['#4C8DFF', '#22B07D', '#F2A93B', '#E5484D', '#A66BFF', '#14B8C4', '#E879A6', '#8A8F98'];
export const zoneColor = (i) => ZONE_COLORS[((i % ZONE_COLORS.length) + ZONE_COLORS.length) % ZONE_COLORS.length];
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isImg = (f) => /^image\//.test(f?.type || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(f?.path || f?.name || '');

/* ---------------- the cube clipboard (Copy in the Library → Paste on a canvas) ---------------- */
const CLIP = 'architect.zone.clip';
export const setClip = (cube) => { store.set(CLIP, { at: Date.now(), cube }); toast(`“${cube.name}” copied — right-click the canvas and choose Paste section.`, { ms: 2600 }); };
export const getClip = () => store.get(CLIP, null)?.cube || null;

/* ---------------- geometry ---------------- */
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function curve(a, b) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  const side = (r, c, ux, uy) => (Math.abs(ux) * r.h > Math.abs(uy) * r.w
    ? { x: c.x + Math.sign(ux) * r.w / 2, y: c.y, nx: Math.sign(ux), ny: 0 }
    : { x: c.x, y: c.y + Math.sign(uy) * r.h / 2, nx: 0, ny: Math.sign(uy) });
  const p = side(a, ca, dx, dy), q = side(b, cb, -dx, -dy);
  const d = Math.max(30, Math.hypot(q.x - p.x, q.y - p.y) / 2.4);
  return { d: `M${p.x},${p.y} C${p.x + p.nx * d},${p.y + p.ny * d} ${q.x + q.nx * d},${q.y + q.ny * d} ${q.x},${q.y}`, end: q, from: { x: q.x + q.nx * d, y: q.y + q.ny * d } };
}
const head = (tip, from, sz = 8) => {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x), w = 0.45;
  return `M${tip.x - sz * Math.cos(a - w)},${tip.y - sz * Math.sin(a - w)} L${tip.x},${tip.y} L${tip.x - sz * Math.cos(a + w)},${tip.y - sz * Math.sin(a + w)}`;
};

/* ---------------- drawing a section (cube content) ---------------- */
// The captured layout, read-only: messages as bubbles, notes and text as cards, pictures, and the
// connectors between them — at their captured positions.
export function renderSection(content, { color = ZONE_COLORS[0], name = '', outline = true, onItem = null } = {}) {
  const c = content || { w: 400, h: 300, items: [], links: [] };
  const root = h('div', { class: ['zn-section', outline && 'has-outline'], style: { width: `${c.w}px`, height: `${c.h}px`, '--zc': color } });
  if (outline) root.append(h('span', { class: 'zn-section-name' }, name));
  const svg = s('svg', { class: 'zn-links', width: c.w, height: c.h, 'aria-hidden': 'true' });
  const by = new Map(c.items.map((it) => [it.id, it]));
  for (const l of c.links || []) {
    if (l.side) continue; // Show alongside links aren't drawn
    const a = by.get(l.a), b = by.get(l.b);
    if (!a || !b) continue;
    const cv = curve(a, b);
    svg.append(s('path', { d: cv.d }), l.arrow === false ? s('g') : s('path', { d: head(cv.end, cv.from) }));
  }
  root.append(svg);
  for (const it of c.items) {
    const box = h('div', { class: ['zn-item', `is-${it.kind}`], 'data-zid': it.id, style: { left: `${it.x}px`, top: `${it.y}px`, width: `${it.w}px`, minHeight: `${it.h}px` } });
    if (it.kind === 'img') {
      const u = it.path ? urlOf(it.path, () => { const im = box.querySelector('img'); const v = urlOf(it.path); if (im && v) im.src = v; }) : null;
      box.append(u ? h('img', { src: u, alt: '', draggable: false }) : h('span', { class: 'zn-ph' }, icon('image', 16)));
    } else {
      if (it.kind === 'msg' && it.name) box.append(h('span', { class: 'zn-who' }, it.name));
      if (it.text) box.append(h('div', { class: 'zn-text' }, it.text));
      for (const f of it.files || []) {
        if (isImg(f)) {
          const u = f.path ? urlOf(f.path, () => { const im = box.querySelector(`img[data-p="${CSS.escape(f.path)}"]`); const v = urlOf(f.path); if (im && v) im.src = v; }) : null;
          box.append(u ? h('img', { src: u, alt: f.name || '', 'data-p': f.path, draggable: false }) : h('span', { class: 'zn-file' }, icon('image', 14), f.name || 'Image'));
        } else box.append(h('span', { class: 'zn-file' }, icon('file', 14), f.name || 'Attachment'));
      }
    }
    if (onItem) box.addEventListener('click', () => onItem(it));
    root.append(box);
  }
  return root;
}

// A miniature of the section for the Library: the items as tinted blocks with a hint of their first line,
// and the connectors — the real layout, small.
export function miniPreview(cube, W = 180, H = 112) {
  const c = cube.content || { w: 1, h: 1, items: [], links: [] };
  const k = Math.min(W / Math.max(1, c.w), H / Math.max(1, c.h));
  const ox = (W - c.w * k) / 2, oy = (H - c.h * k) / 2;
  const g = s('svg', { class: 'zn-mini', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', style: { '--zc': cube.color } });
  g.append(s('rect', { class: 'zn-mini-zone', x: ox, y: oy, width: c.w * k, height: c.h * k, rx: 4 }));
  const by = new Map(c.items.map((it) => [it.id, { ...it, x: ox + it.x * k, y: oy + it.y * k, w: it.w * k, h: it.h * k }]));
  for (const l of c.links || []) { if (l.side) continue; const a = by.get(l.a), b = by.get(l.b); if (a && b) g.append(s('path', { class: 'zn-mini-link', d: curve(a, b).d })); }
  for (const it of by.values()) {
    g.append(s('rect', { class: `zn-mini-it is-${it.kind}`, x: it.x, y: it.y, width: Math.max(2, it.w), height: Math.max(2, it.h), rx: 2 }));
    const line = (it.text || '').split('\n')[0];
    if (line && it.w > 18 && it.h > 6) g.append(s('rect', { class: 'zn-mini-line', x: it.x + 2, y: it.y + Math.min(it.h / 2, 4), width: Math.max(1, Math.min(it.w - 4, line.length * 2.4 * Math.max(0.6, k * 3))), height: Math.max(1, Math.min(2.2, it.h / 4)), rx: 1 }));
  }
  return g;
}

/* ---------------- overlays ---------------- */
function overlay(cls, onClose) {
  const layer = h('div', { class: ['zn-layer', cls], role: 'dialog', 'aria-modal': 'true' });
  const close = () => { window.removeEventListener('keydown', onKey, true); layer.remove(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.menu, .dlg, .pop')) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  return { layer, close };
}

// A pannable, zoomable view of one section (Open Here, Present).
function sectionViewport(content, opts) {
  const sec = renderSection(content, opts);
  const world = h('div', { class: 'zn-world' }, sec);
  const vp = h('div', { class: 'zn-vp' }, world);
  let cam = { x: 0, y: 0, z: 1 };
  const apply = () => { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; };
  const fit = (r = { x: 0, y: 0, w: content.w, h: content.h }, pad = 48, maxZ = 1.6) => {
    const W = vp.clientWidth || innerWidth, H = vp.clientHeight || innerHeight;
    const z = Math.min(maxZ, (W - pad * 2) / Math.max(1, r.w), (H - pad * 2) / Math.max(1, r.h));
    cam = { z, x: W / 2 - (r.x + r.w / 2) * z, y: H / 2 - (r.y + r.h / 2) * z };
    world.classList.add('is-anim'); apply(); setTimeout(() => world.classList.remove('is-anim'), 420);
  };
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const z1 = Math.min(4, Math.max(0.15, cam.z * Math.exp(-e.deltaY * 0.0025)));
      const px = e.clientX - r.left, py = e.clientY - r.top;
      cam = { z: z1, x: px - (px - cam.x) * (z1 / cam.z), y: py - (py - cam.y) * (z1 / cam.z) };
    } else cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY };
    apply();
  }, { passive: false });
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, .zn-text')) return;
    const sx = e.clientX, sy = e.clientY, c0 = { ...cam };
    vp.setPointerCapture(e.pointerId);
    const mv = (ev) => { cam = { ...c0, x: c0.x + ev.clientX - sx, y: c0.y + ev.clientY - sy }; apply(); };
    const up = () => { vp.removeEventListener('pointermove', mv); vp.removeEventListener('pointerup', up); };
    vp.addEventListener('pointermove', mv); vp.addEventListener('pointerup', up);
  });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  return { vp, sec, fit };
}

/** Open Here: the cube over the current chat. Nothing is posted and the canvas doesn't move; closing returns
 *  you to the same spot. */
export function openHere(cube, { onEmbed = null, onPresent = null } = {}) {
  const { layer, close } = overlay('is-open-here');
  const view = sectionViewport(cube.content, { color: cube.color, name: cube.name });
  layer.append(h('div', { class: 'zn-bar' },
    h('span', { class: 'zn-chip', style: { '--zc': cube.color } }, h('i'), cube.name),
    h('span', { class: 'zn-flex' }),
    onPresent ? h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); onPresent(); } }, icon('play', 13), 'Present') : null,
    onEmbed ? h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); onEmbed(); } }, icon('embed', 13), 'Embed in chat') : null,
    h('button', { type: 'button', class: 'btn sm', onclick: () => { setClip(cube); } }, icon('copy', 13), 'Copy'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16))), view.vp);
  requestAnimationFrame(() => view.fit());
  return close;
}

/* ---------------- Present: a spoken walkthrough ---------------- */
/** The suggested order: follow the connectors from the items nothing points to; whatever's left goes top to
 *  bottom, left to right. Branches are visited in reading order. */
export function suggestSeq(content) {
  const items = content.items || [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = new Map(), inDeg = new Map(items.map((it) => [it.id, 0]));
  for (const l of content.links || []) {
    if (l.side || !byId.has(l.a) || !byId.has(l.b)) continue; // Show alongside never changes the order
    const [a, b] = l.arrow === false ? (byId.get(l.a).y <= byId.get(l.b).y ? [l.a, l.b] : [l.b, l.a]) : [l.a, l.b];
    (out.get(a) || out.set(a, []).get(a)).push(b);
    inDeg.set(b, (inDeg.get(b) || 0) + 1);
  }
  const reading = (a, b) => (Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x);
  const roots = items.filter((it) => !inDeg.get(it.id)).sort(reading);
  const seen = new Set(), order = [];
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id); order.push(id);
    for (const n of (out.get(id) || []).map((x) => byId.get(x)).filter(Boolean).sort(reading)) visit(n.id);
  };
  roots.forEach((r) => visit(r.id));
  items.slice().sort(reading).forEach((it) => visit(it.id));
  return order.map((id) => ({ id, skip: false }));
}
// Nov 27: Present reads only the body of a message — never the sender's name or a generated media label
// ("picture", "photo", "video", "attachment"). A picture is shown silently.
const MEDIA_LABEL = /^\s*[\[(]?\s*(a\s+)?(picture|photo|image|video|attachment|file|gif|sticker|voice note|audio)s?\s*[\])]?\s*[.:]?\s*$/i;
const speakable = (it) => {
  if (it.kind === 'img') return '';
  return String(it.text || '').split('\n').filter((ln) => !MEDIA_LABEL.test(ln)).join('\n').trim();
};

/** Present: first the order (preview, reorder, skip), then playback with text-to-speech. The order you set is
 *  saved with the cube (onSaveSeq) — it never changes the captured layout. */
export function present(cube, { onSaveSeq = null } = {}) {
  const content = cube.content;
  const known = new Set((content.items || []).map((it) => it.id));
  let seq = (cube.seq || []).filter((s1) => known.has(s1.id));
  for (const s1 of suggestSeq(content)) if (!seq.some((q) => q.id === s1.id)) seq.push(s1);
  const byId = new Map(content.items.map((it) => [it.id, it]));
  const { layer, close } = overlay('is-present', () => { try { speechSynthesis.cancel(); } catch {} });
  const view = sectionViewport(content, { color: cube.color, name: cube.name });
  const side = h('aside', { class: 'zn-seq' });
  const bar = h('div', { class: 'zn-bar' });
  layer.append(bar, h('div', { class: 'zn-present' }, view.vp, side));
  requestAnimationFrame(() => view.fit());

  let mode = 'plan', step = -1, paused = false, utter = null, silentT = 0;
  let rate = Math.min(2, Math.max(0.5, Number(store.get('zn.tts.rate', 1)) || 1));
  // Show alongside: what each message brings onto the screen with it (it isn't read).
  const along = new Map();
  for (const l of content.links || []) { if (!l.side || !byId.has(l.a) || !byId.has(l.b)) continue; (along.get(l.a) || along.set(l.a, []).get(l.a)).push(l.b); }
  const steps = () => seq.filter((q) => !q.skip && byId.has(q.id));
  const saveSeq = () => { cube.seq = seq.map((q) => ({ id: q.id, skip: !!q.skip })); onSaveSeq?.(cube.seq); };

  function paintPlan() {
    bar.replaceChildren(
      h('span', { class: 'zn-chip', style: { '--zc': cube.color } }, h('i'), cube.name),
      h('span', { class: 'zn-hint' }, 'Check the order — drag to reorder, untick to skip.'),
      h('span', { class: 'zn-flex' }),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { seq = suggestSeq(content); paintPlan(); saveSeq(); } }, icon('undo', 13), 'Suggested order'),
      h('button', { type: 'button', class: 'btn btn-primary sm', disabled: !steps().length, onclick: () => { saveSeq(); start(); } }, icon('play', 13), 'Play'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 16)));
    side.replaceChildren(h('ol', { class: 'zn-seq-list' }, ...seq.map((q, i) => {
      const it = byId.get(q.id);
      if (!it) return null;
      const row = h('li', { class: ['zn-seq-row', q.skip && 'is-skip'], draggable: 'true', 'data-i': i,
        onmouseenter: () => focusItem(it.id, false), onclick: (e) => { if (!e.target.closest('input, button')) focusItem(it.id, true); } },
        h('span', { class: 'zn-seq-grip', 'aria-hidden': 'true' }, icon('grip', 12)),
        h('input', { type: 'checkbox', checked: !q.skip, 'aria-label': 'Include this step', onchange: (e) => { q.skip = !e.target.checked; row.classList.toggle('is-skip', q.skip); saveSeq(); paintPlan(); } }),
        h('span', { class: 'zn-seq-text' }, (it.text || (it.kind === 'img' ? 'Picture' : 'Attachment')).split('\n')[0].slice(0, 80)),
        h('span', { class: 'zn-seq-move' },
          h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': 'Earlier', disabled: i === 0, onclick: () => { [seq[i - 1], seq[i]] = [seq[i], seq[i - 1]]; saveSeq(); paintPlan(); } }, icon('chevronUp', 12)),
          h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': 'Later', disabled: i === seq.length - 1, onclick: () => { [seq[i + 1], seq[i]] = [seq[i], seq[i + 1]]; saveSeq(); paintPlan(); } }, icon('chevronDown', 12))));
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/zn', String(i)); row.classList.add('is-drag'); });
      row.addEventListener('dragend', () => row.classList.remove('is-drag'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/zn')); if (!Number.isFinite(from) || from === i) return; const [m] = seq.splice(from, 1); seq.splice(i, 0, m); saveSeq(); paintPlan(); });
      return row;
    }).filter(Boolean)));
  }
  function focusItem(id, zoom) {
    view.sec.querySelectorAll('.zn-item.is-focus').forEach((n) => n.classList.remove('is-focus'));
    const n = view.sec.querySelector(`.zn-item[data-zid="${CSS.escape(id)}"]`);
    if (!n) return;
    n.classList.add('is-focus');
    view.sec.classList.add('has-focus');
    const it = byId.get(id);
    if (!zoom || !it) return;
    // The active message and whatever it shows alongside, framed together side by side.
    const group = [it, ...(along.get(id) || []).map((x) => byId.get(x)).filter(Boolean)];
    group.slice(1).forEach((g) => view.sec.querySelector(`.zn-item[data-zid="${CSS.escape(g.id)}"]`)?.classList.add('is-focus'));
    const x0 = Math.min(...group.map((g) => g.x)), y0 = Math.min(...group.map((g) => g.y));
    const x1 = Math.max(...group.map((g) => g.x + g.w)), y1 = Math.max(...group.map((g) => g.y + g.h));
    view.fit({ x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: y1 - y0 + 80 }, 60, group.length > 1 ? 1.4 : 1.8);
  }
  function paintPlay() {
    const list = steps();
    bar.replaceChildren(
      h('span', { class: 'zn-chip', style: { '--zc': cube.color } }, h('i'), cube.name),
      h('span', { class: 'zn-count' }, `${Math.max(1, step + 1)} / ${list.length}`),
      h('span', { class: 'zn-flex' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous', title: 'Previous (←)', disabled: step <= 0, onclick: () => go(step - 1) }, icon('chevronLeft', 16)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': paused ? 'Resume' : 'Pause', title: paused ? 'Resume (Space)' : 'Pause (Space)', onclick: togglePause }, icon(paused ? 'play' : 'pause', 16)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Replay this step', title: 'Replay (R)', onclick: () => go(step) }, icon('undo', 16)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next', title: 'Next (→)', disabled: step >= list.length - 1, onclick: () => go(step + 1) }, icon('chevronRight', 16)),
      speedCtl(),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { stopSpeech(); mode = 'plan'; view.sec.classList.remove('has-focus'); paintPlan(); view.fit(); } }, 'Edit order'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 16)));
    side.querySelectorAll('.zn-seq-row').forEach((r) => r.classList.remove('is-now'));
  }
  const stopSpeech = () => { clearTimeout(silentT); try { speechSynthesis.cancel(); } catch {} utter = null; };
  // Narration speed: changes apply right away (the current message restarts at the new speed); the
  // presentation itself carries on where it is.
  function speedCtl() {
    const val = h('b', { class: 'zn-rate-val' }, `${rate.toFixed(2).replace(/0$/, '')}×`);
    const inp = h('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: rate, 'aria-label': 'Narration speed' });
    inp.addEventListener('input', () => { rate = Number(inp.value); val.textContent = `${rate.toFixed(2).replace(/0$/, '')}×`; });
    inp.addEventListener('change', () => { store.set('zn.tts.rate', rate); if (mode === 'play' && !paused && utter) speak(byId.get(steps()[step]?.id)); });
    return h('label', { class: 'zn-rate', title: 'Narration speed' }, icon('speaker', 14), inp, val);
  }
  function speak(it) {
    stopSpeech();
    if (!it) return;
    const text = speakable(it);
    const next = () => { if (!paused) go(step + 1); };
    if (!text || !('speechSynthesis' in window)) { silentT = setTimeout(next, it.kind === 'img' ? 2200 : 1400); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.onend = () => { if (utter === u && !paused) setTimeout(() => { if (utter === u && !paused) go(step + 1); }, 450); };
    utter = u;
    speechSynthesis.speak(u);
  }
  function go(i) {
    const list = steps();
    if (i < 0 || i >= list.length) { if (i >= list.length) { stopSpeech(); paintPlay(); toast('End of the walkthrough.', { ms: 1600 }); } return; }
    step = i; paused = false;
    const it = byId.get(list[i].id);
    focusItem(it.id, true);
    paintPlay();
    speak(it);
  }
  function togglePause() {
    paused = !paused;
    clearTimeout(silentT);
    try { if (paused) speechSynthesis.pause(); else if (speechSynthesis.paused) speechSynthesis.resume(); else go(step); } catch {}
    paintPlay();
  }
  function start() { mode = 'play'; go(0); }
  layer.addEventListener('keydown', (e) => {
    if (mode !== 'play') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(step + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(step - 1); }
    else if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key.toLowerCase() === 'r') { e.preventDefault(); go(step); }
  });
  layer.tabIndex = -1;
  paintPlan();
  requestAnimationFrame(() => layer.focus());
  return close;
}

/* ---------------- Export: the section as one standalone HTML page ---------------- */
export function exportSection(cube) {
  const c = cube.content;
  const by = new Map(c.items.map((it) => [it.id, it]));
  const paths = (c.links || []).filter((l) => !l.side).map((l) => { const a = by.get(l.a), b = by.get(l.b); if (!a || !b) return ''; const cv = curve(a, b); return `<path d="${cv.d}"/>${l.arrow === false ? '' : `<path d="${head(cv.end, cv.from)}"/>`}`; }).join('');
  const items = c.items.map((it) => {
    const files = (it.files || []).map((f) => `<div class="f">${esc(f.name || (isImg(f) ? 'Image' : 'Attachment'))}</div>`).join('');
    return `<div class="it ${it.kind}" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;min-height:${it.h}px">${it.name ? `<b>${esc(it.name)}</b>` : ''}${it.text ? `<p>${esc(it.text).replace(/\n/g, '<br>')}</p>` : ''}${it.kind === 'img' ? '<div class="f">Image</div>' : ''}${files}</div>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cube.name)}</title><style>
body{margin:0;background:#0d0d0d;color:#eee;font:14px/1.45 system-ui,sans-serif;padding:32px}
h1{font:700 15px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${cube.color}}
.z{position:relative;width:${c.w}px;height:${c.h}px;border:1px solid ${cube.color};border-radius:14px;background:${cube.color}14}
svg{position:absolute;inset:0;overflow:visible}path{fill:none;stroke:#9aa0a6;stroke-width:1.5}
.it{position:absolute;box-sizing:border-box;padding:8px 10px;border-radius:12px;background:#1c1c1e;border:1px solid #2c2c2e}
.it.note{background:#2b2615}.it.text{background:none;border:0}.it p{margin:2px 0;white-space:pre-wrap}.it b{font-size:11px;color:#aaa}
.f{font-size:12px;color:#aaa;margin-top:4px}
</style></head><body><h1>${esc(cube.name)}</h1><div class="z"><svg width="${c.w}" height="${c.h}">${paths}</svg>${items}</div>
<script type="application/json" id="architect-zone">${JSON.stringify({ name: cube.name, color: cube.color, content: c }).replace(/</g, '\\u003c')}</script></body></html>`;
  const a = h('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `${(cube.name || 'zone').replace(/[^\w\- ]+/g, '').trim() || 'zone'}.html` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- the Library: a map of the chat's Zone Cubes ---------------- */
/**
 * lib: { get(): { cubes, cam }, set(patch), name: chat name,
 *        embed(cube), others(): [{ id, name }], copyTo(cube, entryId, move), toBlueprint(cube) }
 */
export function openLibrary(lib) {
  const { layer, close } = overlay('is-library');
  const world = h('div', { class: 'zn-lib-world' });
  const vp = h('div', { class: 'zn-lib-vp has-grid' }, world);
  // Nov 27 — no header bar, no gesture help, no empty-state text: just the dot grid up to the top edge, with
  // Fit and Close in the top-right corner over the canvas. Pan / zoom gestures are unchanged.
  const bar = h('div', { class: 'zn-corner' },
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Fit everything', title: 'Fit', onclick: () => fit() }, icon('fit', 16)),
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16)));
  layer.setAttribute('aria-label', `${lib.name || 'Chat'} · Library`);
  layer.append(bar, vp);
  let cam = { x: 40, y: 40, z: 1, ...(lib.get().cam || {}) };
  const apply = () => { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; vp.style.backgroundPosition = `${cam.x}px ${cam.y}px`; vp.style.backgroundSize = `${22 * cam.z}px ${22 * cam.z}px`; };
  let camT = 0;
  const saveCam = () => { clearTimeout(camT); camT = setTimeout(() => lib.set({ cam: { x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z * 1000) / 1000 } }), 500); };
  function zoomBy(k, cx = vp.clientWidth / 2, cy = vp.clientHeight / 2) {
    const z1 = Math.min(3, Math.max(0.2, cam.z * k));
    cam = { z: z1, x: cx - (cx - cam.x) * (z1 / cam.z), y: cy - (cy - cam.y) * (z1 / cam.z) };
    apply(); saveCam();
  }
  function fit() {
    const cubes = lib.get().cubes || [];
    if (!cubes.length) { cam = { x: 40, y: 40, z: 1 }; apply(); return; }
    const xs = cubes.map((c) => c.x || 0), ys = cubes.map((c) => c.y || 0);
    const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) + 220 - Math.min(...xs), h: Math.max(...ys) + 190 - Math.min(...ys) };
    const z = Math.min(1.4, (vp.clientWidth - 80) / r.w, (vp.clientHeight - 80) / r.h);
    cam = { z, x: vp.clientWidth / 2 - (r.x + r.w / 2) * z, y: vp.clientHeight / 2 - (r.y + r.h / 2) * z };
    apply(); saveCam();
  }
  function paint() {
    const cubes = lib.get().cubes || [];
    world.replaceChildren(...cubes.map(cubeCard));
  }
  function cubeCard(cube) {
    const n = h('div', { class: 'zn-cube', tabindex: 0, 'data-cube': cube.id, style: { left: `${cube.x || 0}px`, top: `${cube.y || 0}px`, '--zc': cube.color } },
      h('div', { class: 'zn-cube-face' }, miniPreview(cube)),
      h('div', { class: 'zn-cube-foot' }, h('i'), h('span', {}, cube.name), h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': 'Cube options', onclick: (e) => { e.stopPropagation(); cubeMenu(e.currentTarget, cube); } }, icon('more', 14))));
    n.addEventListener('dblclick', () => openHere(cube, { onEmbed: () => { close(); lib.embed(cube); }, onPresent: () => present(cube, { onSaveSeq: (seq) => patchCube(cube.id, { seq }) }) }));
    n.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); cubeMenu({ x: e.clientX, y: e.clientY }, cube); });
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); n.dispatchEvent(new MouseEvent('dblclick')); } });
    n.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, x0 = cube.x || 0, y0 = cube.y || 0;
      let moved = false;
      n.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; n.classList.add('is-held');
        n.style.left = `${x0 + (ev.clientX - sx) / cam.z}px`; n.style.top = `${y0 + (ev.clientY - sy) / cam.z}px`;
      };
      const up = (ev) => {
        n.removeEventListener('pointermove', mv); n.removeEventListener('pointerup', up); n.classList.remove('is-held');
        if (moved) patchCube(cube.id, { x: Math.round(x0 + (ev.clientX - sx) / cam.z), y: Math.round(y0 + (ev.clientY - sy) / cam.z) });
      };
      n.addEventListener('pointermove', mv); n.addEventListener('pointerup', up);
    });
    return n;
  }
  function patchCube(id, p) {
    const cubes = (lib.get().cubes || []).map((c) => (c.id === id ? { ...c, ...p } : c));
    lib.set({ cubes });
    paint();
  }
  function cubeMenu(anchor, cube) {
    const others = lib.others?.() || [];
    menu(anchor, [
      { header: cube.name },
      { label: 'Open here', icon: 'eye', kbd: 'Dbl-click', onSelect: () => openHere(cube, { onEmbed: () => { close(); lib.embed(cube); }, onPresent: () => present(cube, { onSaveSeq: (seq) => patchCube(cube.id, { seq }) }) }) },
      { label: 'Embed in chat', icon: 'embed', onSelect: () => { close(); lib.embed(cube); } },
      { label: 'Present', icon: 'play', onSelect: () => present(cube, { onSaveSeq: (seq) => patchCube(cube.id, { seq }) }) },
      '-',
      { label: 'Copy (then paste on a canvas)', icon: 'copy', onSelect: () => setClip(cube) },
      others.length ? { label: 'Copy to another chat…', icon: 'copy', onSelect: () => pickChat(anchor, others, (id) => lib.copyTo(cube, id, false)) } : null,
      others.length ? { label: 'Move to another chat…', icon: 'folderMove', onSelect: () => pickChat(anchor, others, async (id) => { await lib.copyTo(cube, id, true); paint(); }) } : null,
      lib.toBlueprint ? { label: 'Copy to a Blueprint…', icon: 'frame', onSelect: () => lib.toBlueprint(cube) } : null,
      { label: 'Export (HTML)', icon: 'download', onSelect: () => exportSection(cube) },
      { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename cube', { value: cube.name, maxLength: 80 }); if (n?.trim()) patchCube(cube.id, { name: n.trim() }); } },
      '-',
      { label: 'Delete cube', icon: 'trash', danger: true, onSelect: async () => {
        // Nov 27: type the cube's name to enable Delete Zone Cube (you still confirm). Removing an embed from a
        // chat doesn't ask this — the cube stays in the Library.
        if (!(await confirmByName({ title: 'Delete Zone Cube', name: cube.name, message: 'The cube and the messages it holds are deleted. Embedded copies of it in this chat go too.', ok: 'Delete Zone Cube' }))) return;
        lib.set({ cubes: (lib.get().cubes || []).filter((c) => c.id !== cube.id) }, { dropEmbeds: cube.id });
        paint();
      } },
    ].filter(Boolean));
  }
  function pickChat(anchor, others, fn) {
    setTimeout(() => menu(anchor, [{ header: 'Which chat?' }, ...others.slice(0, 40).map((o) => ({ label: o.name, icon: 'chat', onSelect: () => fn(o.id) }))]), 0);
  }
  // pan the map
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zn-cube')) return;
    const sx = e.clientX, sy = e.clientY, c0 = { ...cam };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('is-panning');
    const mv = (ev) => { cam = { ...c0, x: c0.x + ev.clientX - sx, y: c0.y + ev.clientY - sy }; apply(); };
    const up = () => { vp.removeEventListener('pointermove', mv); vp.removeEventListener('pointerup', up); vp.classList.remove('is-panning'); saveCam(); };
    vp.addEventListener('pointermove', mv); vp.addEventListener('pointerup', up);
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY }; apply(); saveCam(); }
  }, { passive: false });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  paint(); apply();
  if (!lib.get().cam) requestAnimationFrame(fit);
  return { close, refresh: paint };
}

/* ---------------- small UI pieces for the canvas ---------------- */
export function colorPicker(anchor, current, onPick) {
  const grid = h('div', { class: 'zn-colors' }, ...ZONE_COLORS.map((c) => h('button', {
    type: 'button', class: ['zn-color', c === current && 'is-on'], style: { '--zc': c }, 'aria-label': `Color ${c}`, title: c,
    onclick: () => { closeFloating(); onPick(c); },
  })));
  const custom = h('input', { type: 'color', value: current || ZONE_COLORS[0], 'aria-label': 'Custom color', onchange: (e) => { closeFloating(); onPick(e.target.value); } });
  popover(anchor, h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Zone color'), grid, custom), { side: 'bottom', align: 'start', gap: 8 });
}
export { uid };

/* ---------------- Nov 28: the space's Library as one zoomable map ----------------
 * Every chat in the space is a folder holding the Zone Cubes captured from it; chats sit inside their
 * subsection. Zoom out to see a subsection's chats, out again to see the space's subsections; double-click a
 * chat or subsection to zoom into it. Cubes are arranged inside their own chat (they never move between chats
 * here). It reads and writes the space's own source, so a shared space's Library is the same for both members,
 * and only this space's chats appear (nothing from personal spaces).
 * spec: { name, root, sections(), entries(), patchEntry(id, fn), store(key, val?) }
 */
export function openSpaceLibrary(spec) {
  const { layer, close } = overlay('is-library is-spacelib', () => { offAuto(); });
  const world = h('div', { class: 'zn-lib-world zl-world' });
  const vp = h('div', { class: 'zn-lib-vp has-grid' }, world);
  const crumb = h('div', { class: 'zl-crumb' });
  const bar = h('div', { class: 'zn-corner' },
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Zoom out a level', title: 'Zoom out a level', onclick: () => up() }, icon('collapse', 16)),
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Fit everything', title: 'Fit', onclick: () => fitAll() }, icon('fit', 16)),
    h('button', { type: 'button', class: 'bpc-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16)));
  layer.setAttribute('aria-label', `${spec.name || 'Space'} · Library`);
  layer.append(vp, crumb, bar);
  const CW = 220, CH = 190, PAD = 28, FH = 54, GAP = 56, SH = 86, SGAP = 160;
  let cam = { x: 40, y: 40, z: 1, ...(spec.store('cam') || {}) };
  let focus = []; // breadcrumb: [{ kind, id, name, rect }]
  let rects = new Map(); // 'c:<entryId>' / 's:<sectionId>' → world rect
  const apply = () => {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    world.style.setProperty('--iz', String(1 / Math.min(1, cam.z)));
    vp.style.backgroundPosition = `${cam.x}px ${cam.y}px`; vp.style.backgroundSize = `${22 * cam.z}px ${22 * cam.z}px`;
    layer.classList.toggle('is-far', cam.z < 0.32);
  };
  let camT = 0;
  const saveCam = () => { clearTimeout(camT); camT = setTimeout(() => spec.store('cam', { x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z * 1000) / 1000 }), 400); };
  const zoomTo = (r, pad = 60, maxZ = 1.4) => {
    const z = Math.max(0.05, Math.min(maxZ, (vp.clientWidth - pad * 2) / r.w, (vp.clientHeight - pad * 2) / r.h));
    cam = { z, x: vp.clientWidth / 2 - (r.x + r.w / 2) * z, y: vp.clientHeight / 2 - (r.y + r.h / 2) * z };
    world.classList.add('is-gliding'); apply(); saveCam(); setTimeout(() => world.classList.remove('is-gliding'), 320);
  };
  function zoomBy(k, cx = vp.clientWidth / 2, cy = vp.clientHeight / 2) {
    const z1 = Math.min(3, Math.max(0.05, cam.z * k));
    cam = { z: z1, x: cx - (cx - cam.x) * (z1 / cam.z), y: cy - (cy - cam.y) * (z1 / cam.z) };
    apply(); saveCam();
  }
  // the hierarchy: subsections (any depth under the root, flattened in order) → their chats; chats right in
  // the root go under the space's own name.
  function groups() {
    const secs = spec.sections();
    const chatsIn = (id) => spec.entries().filter((e) => e.section === id && !e.kind);
    const root = spec.root;
    const list = [{ id: root, name: spec.name || 'General', depth: 0 }];
    const walk = (pid, depth) => {
      for (const q of secs.filter((x) => x.parent === pid)) { list.push({ id: q.id, name: q.name, depth }); walk(q.id, depth + 1); }
    };
    walk(root, 0);
    return list.map((g) => ({ ...g, chats: chatsIn(g.id) })).filter((g) => g.chats.length);
  }
  const folderSize = (cubes) => {
    const mx = Math.max(0, ...cubes.map((c) => (c.x || 0) + CW)), my = Math.max(0, ...cubes.map((c) => (c.y || 0) + CH));
    return { w: Math.max(360, mx + PAD * 2), h: Math.max(220, my + PAD * 2) + FH };
  };
  function paint() {
    rects = new Map();
    const gs = groups();
    const nodes = [];
    let gx = 0, gy = 0, rowH = 0;
    const maxRowW = 2600;
    for (const g of gs) {
      // lay the group's chats out in rows
      let cx = 40, cy = SH, cRowH = 0, gw = 0;
      const folders = [];
      for (const e of g.chats) {
        const cubes = e.library?.cubes || [];
        const fs = folderSize(cubes);
        if (cx > 40 && cx + fs.w > 1500) { cx = 40; cy += cRowH + GAP; cRowH = 0; }
        folders.push({ e, cubes, x: cx, y: cy, ...fs });
        cx += fs.w + GAP; cRowH = Math.max(cRowH, fs.h); gw = Math.max(gw, cx);
      }
      const gh = cy + cRowH + 40;
      gw = Math.max(gw - GAP + 40, 480);
      if (gx > 0 && gx + gw > maxRowW) { gx = 0; gy += rowH + SGAP; rowH = 0; }
      const gr = { x: gx, y: gy, w: gw, h: gh };
      rects.set(`s:${g.id}`, gr);
      const region = h('div', { class: 'zl-sec', 'data-sec': g.id, style: { left: `${gr.x}px`, top: `${gr.y}px`, width: `${gr.w}px`, height: `${gr.h}px` } },
        h('div', { class: 'zl-sec-name' }, g.name), h('div', { class: 'zl-sec-count' }, `${g.chats.length} chat${g.chats.length === 1 ? '' : 's'}`));
      for (const f of folders) {
        const fr = { x: gr.x + f.x, y: gr.y + f.y, w: f.w, h: f.h };
        rects.set(`c:${f.e.id}`, fr);
        region.append(folderEl(f, g));
      }
      nodes.push(region);
      gx += gw + SGAP; rowH = Math.max(rowH, gh);
    }
    if (!gs.length) nodes.push(h('div', { class: 'zl-empty' }, 'No Zone Cubes in this space yet — capture a zone in a chat’s Free View and it lands here, in that chat’s folder.'));
    world.replaceChildren(...nodes);
    paintCrumb();
  }
  function folderEl(f, g) {
    const n = h('div', { class: 'zl-folder', 'data-entry': f.e.id, style: { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` } },
      h('div', { class: 'zl-folder-head' }, icon('folder', 16), h('b', {}, f.e.name), h('span', {}, `${f.cubes.length} zone${f.cubes.length === 1 ? '' : 's'}`)),
      h('div', { class: 'zl-folder-body' }, ...f.cubes.map((c) => cubeEl(c, f.e))));
    n.dataset.sec = g.id; n.dataset.secName = g.name;
    return n;
  }
  function cubeEl(cube, e) {
    const n = h('div', { class: 'zn-cube', tabindex: 0, 'data-cube': cube.id, style: { left: `${PAD + (cube.x || 0)}px`, top: `${PAD + (cube.y || 0)}px`, '--zc': cube.color } },
      h('div', { class: 'zn-cube-face' }, miniPreview(cube)),
      h('div', { class: 'zn-cube-foot' }, h('i'), h('span', {}, cube.name)));
    const openIt = () => openHere(cube, { onPresent: () => present(cube, { onSaveSeq: (seq) => patchCube(e.id, cube.id, { seq }) }) });
    n.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openIt(); });
    n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); openIt(); } });
    n.addEventListener('contextmenu', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      menu({ x: ev.clientX, y: ev.clientY }, [
        { header: cube.name },
        { label: 'Open here', icon: 'eye', kbd: 'Dbl-click', onSelect: openIt },
        { label: 'Present', icon: 'play', onSelect: () => present(cube, { onSaveSeq: (seq) => patchCube(e.id, cube.id, { seq }) }) },
        { label: 'Copy (then paste on a canvas)', icon: 'copy', onSelect: () => setClip(cube) },
        { label: 'Rename…', icon: 'edit', onSelect: async () => { const nm = await promptDialog('Rename cube', { value: cube.name, maxLength: 80 }); if (nm?.trim()) patchCube(e.id, cube.id, { name: nm.trim() }); } },
      ]);
    });
    // arrange inside its own chat (it stays in that folder)
    n.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const sx = ev.clientX, sy = ev.clientY, x0 = cube.x || 0, y0 = cube.y || 0;
      let moved = false;
      n.setPointerCapture(ev.pointerId);
      const mv = (m) => {
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        moved = true; n.classList.add('is-held');
        n.style.left = `${PAD + Math.max(0, x0 + (m.clientX - sx) / cam.z)}px`; n.style.top = `${PAD + Math.max(0, y0 + (m.clientY - sy) / cam.z)}px`;
      };
      const upP = (m) => {
        n.removeEventListener('pointermove', mv); n.removeEventListener('pointerup', upP); n.classList.remove('is-held');
        if (moved) patchCube(e.id, cube.id, { x: Math.round(Math.max(0, x0 + (m.clientX - sx) / cam.z)), y: Math.round(Math.max(0, y0 + (m.clientY - sy) / cam.z)) });
      };
      n.addEventListener('pointermove', mv); n.addEventListener('pointerup', upP);
    });
    return n;
  }
  function patchCube(entryId, cubeId, p) {
    spec.patchEntry(entryId, (e) => ({ library: { ...(e.library || {}), cubes: (e.library?.cubes || []).map((c) => (c.id === cubeId ? { ...c, ...p } : c)) } }));
    paint();
  }
  function dive(step, go = true) {
    const key = `${step.kind}:${step.id}`;
    if (step.kind === 's') focus = [step]; else focus = [...focus.filter((f) => f.kind === 's'), step];
    paintCrumb();
    if (go && rects.has(key)) zoomTo(rects.get(key), 60, step.kind === 'c' ? 1.3 : 1);
  }
  function up() {
    focus.pop();
    const last = focus[focus.length - 1];
    if (last && rects.has(`${last.kind}:${last.id}`)) zoomTo(rects.get(`${last.kind}:${last.id}`)); else fitAll();
    paintCrumb();
  }
  function fitAll() {
    focus = []; paintCrumb();
    const all = [...rects.entries()].filter(([k]) => k.startsWith('s:')).map(([, r]) => r);
    if (!all.length) { cam = { x: 40, y: 40, z: 1 }; apply(); return; }
    const x0 = Math.min(...all.map((r) => r.x)), y0 = Math.min(...all.map((r) => r.y));
    const x1 = Math.max(...all.map((r) => r.x + r.w)), y1 = Math.max(...all.map((r) => r.y + r.h));
    zoomTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 60, 1);
  }
  function paintCrumb() {
    crumb.replaceChildren(
      h('button', { type: 'button', class: 'zl-crumb-btn', onclick: () => fitAll() }, `${spec.name || 'Space'} · Library`),
      ...focus.flatMap((f, i) => [h('span', { class: 'zl-crumb-sep' }, '›'), h('button', { type: 'button', class: 'zl-crumb-btn', onclick: () => { focus = focus.slice(0, i + 1); zoomTo(rects.get(`${f.kind}:${f.id}`) || { x: 0, y: 0, w: 800, h: 600 }); paintCrumb(); } }, f.name)]));
  }
  // pan / zoom (Ctrl/⌘ + wheel or pinch zooms; wheel pans)
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zn-cube')) return;
    const sx = e.clientX, sy = e.clientY, c0 = { ...cam };
    vp.setPointerCapture(e.pointerId); vp.classList.add('is-panning');
    const mv = (ev) => { cam = { ...c0, x: c0.x + ev.clientX - sx, y: c0.y + ev.clientY - sy }; apply(); };
    const upP = () => { vp.removeEventListener('pointermove', mv); vp.removeEventListener('pointerup', upP); vp.classList.remove('is-panning'); saveCam(); };
    vp.addEventListener('pointermove', mv); vp.addEventListener('pointerup', upP);
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY }; apply(); saveCam(); }
  }, { passive: false });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  // double-click a chat folder or a subsection to zoom into it (found under the pointer: the pan captures it)
  vp.addEventListener('dblclick', (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t.closest('.zn-cube')) return;
    const f = t.closest('.zl-folder'), sc = t.closest('.zl-sec');
    if (f) { const e0 = spec.entries().find((q) => q.id === f.dataset.entry); dive({ kind: 's', id: f.dataset.sec, name: f.dataset.secName }, false); dive({ kind: 'c', id: f.dataset.entry, name: e0?.name || 'Chat' }); }
    else if (sc) dive({ kind: 's', id: sc.dataset.sec, name: sc.querySelector('.zl-sec-name')?.textContent || '' });
  });
  // the other member's changes show up while it's open
  let sig = '';
  const sigOf = () => JSON.stringify(spec.entries().map((e) => [e.id, e.name, e.section, (e.library?.cubes || []).map((c) => [c.id, c.x, c.y, c.name])]));
  const auto = setInterval(() => { if (layer.querySelector('.is-held')) return; const s2 = sigOf(); if (s2 !== sig) { sig = s2; paint(); } }, 1500);
  const offAuto = () => clearInterval(auto);
  sig = sigOf();
  paint(); apply();
  if (!spec.store('cam')) requestAnimationFrame(fitAll);
  return { close, refresh: paint };
}
