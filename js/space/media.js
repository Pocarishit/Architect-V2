// Shared bits for widgets that hold photos and videos (Fleeting Ideas → Story, Variables).
// Files go to the private media bucket; widgets keep only the storage path.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../data/api.js';

const signed = new Map(); // storage path → signed URL (null while unknown/failed)
const waiting = new Set();
let batch = null;

/** Signed URL for a path, or null for now. onReady fires once it arrives. */
export function urlOf(path, onReady) {
  if (!path) return null;
  if (signed.has(path)) return signed.get(path);
  waiting.add(path);
  if (onReady) (urlOf.cbs ||= new Set()).add(onReady);
  batch ||= Promise.resolve().then(async () => {
    const list = [...waiting];
    waiting.clear();
    batch = null;
    try {
      const map = await api.media.sign(list);
      list.forEach((p) => signed.set(p, map[p] || null));
    } catch { list.forEach((p) => signed.set(p, null)); }
    const cbs = [...(urlOf.cbs || [])];
    urlOf.cbs = new Set();
    cbs.forEach((f) => { try { f(); } catch {} });
  });
  return null;
}

/** Photos are downscaled (long side 1800px) before upload; videos go up as they are. */
export async function uploadMedia(file, { dur: knownDur } = {}) {
  const kind = /^video\//.test(file.type) ? 'video' : /^image\//.test(file.type) ? 'photo' : /^audio\//.test(file.type) ? 'audio' : null;
  if (!kind) throw new Error('Only photos and videos can go here.');
  const max = api.media?.maxBytes || 50 * 1024 * 1024;
  let up = file;
  if (kind === 'photo' && !/gif|svg/.test(file.type)) up = await shrink(file, 1800).catch(() => file);
  if (up.size > max) throw new Error(`${file.name || 'That file'} is over ${Math.round(max / 1048576)} MB.`);
  const dur = knownDur || (kind === 'video' ? await durationOf(file) : 0);
  const { path, url } = await api.media.upload(up);
  signed.set(path, url || null);
  return { kind, path, name: file.name || '', dur };
}

async function shrink(file, long) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, long / Math.max(bmp.width, bmp.height));
  if (s === 1 && file.size < 1.5 * 1048576) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) return file;
  return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

function durationOf(file) {
  return new Promise((res) => {
    const v = document.createElement('video');
    const u = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(u); res(Number.isFinite(d) ? Math.round(d) : 0); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    v.src = u;
  });
}

export const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

/** Full-screen look at a photo or video. Click outside or Esc to close. */
export function lightbox(item) {
  const url = urlOf(item.path);
  if (!url) return;
  const media = item.kind === 'video'
    ? h('video', { class: 'lbx-media', src: url, controls: true, autoplay: true, playsinline: true })
    : h('img', { class: 'lbx-media', src: url, alt: item.text || '' });
  const close = () => { document.removeEventListener('keydown', onKey, true); ov.classList.remove('in'); setTimeout(() => ov.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const ov = h('div', { class: 'lbx', role: 'dialog', 'aria-label': item.kind === 'video' ? 'Video' : 'Photo', onclick: (e) => { if (e.target === ov) close(); } },
    media,
    item.text ? h('p', { class: 'lbx-cap' }, item.text) : null,
    h('button', { class: 'lbx-x', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18)));
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('in'));
}

/** Files from a paste or drop event (photos and videos only). */
export function mediaFiles(dt) {
  if (!dt) return [];
  const out = [];
  for (const it of dt.items || []) {
    if (it.kind === 'file' && /^(image|video)\//.test(it.type)) { const f = it.getAsFile(); if (f) out.push(f); }
  }
  if (!out.length) for (const f of dt.files || []) if (/^(image|video)\//.test(f.type)) out.push(f);
  return out;
}

export function pickMedia({ multiple = true, accept = 'image/*,video/*' } = {}) {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, multiple, style: 'position:fixed;left:-9999px' });
    inp.onchange = () => { res([...inp.files]); inp.remove(); };
    document.body.append(inp);
    inp.click();
    setTimeout(() => { if (!inp.files?.length) inp.remove(); }, 120_000);
  });
}

/* ---------------- Voice notes (Nov 22) ----------------
   Your actual voice: the mic records a clip (free, in the browser), it goes up like any other media file,
   and everyone in the room hears it as you said it. */
export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** Start recording. Resolves to { stop() → Promise<{file, dur}|null>, cancel(), started }. */
export async function startRecording({ onTick } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
  const mime = types.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const started = Date.now();
  const tick = setInterval(() => onTick?.(Math.floor((Date.now() - started) / 1000)), 250);
  rec.start(250);
  const end = () => { clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); };
  return {
    started,
    stop: () => new Promise((res) => {
      if (rec.state === 'inactive') { end(); res(null); return; }
      rec.onstop = () => {
        end();
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        const dur = Math.max(1, Math.round((Date.now() - started) / 1000));
        if (blob.size < 800) { res(null); return; }
        const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        res({ file: new File([blob], `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type }), dur });
      };
      try { rec.stop(); } catch { end(); res(null); }
    }),
    cancel: () => { try { rec.onstop = null; rec.stop(); } catch {} end(); },
  };
}

// One clip plays at a time across the app.
let nowPlaying = null;
const clips = new Map(); // path → Audio
/** A voice note in a chat bubble: play/pause, a progress line, the length. */
export function voiceNote(f, { onAsset } = {}) {
  let audio = null;
  const btn = h('button', { type: 'button', class: 'vn-play', 'aria-label': 'Play voice message' }, icon('play', 14));
  const fill = h('i', { class: 'vn-fill' });
  const bars = h('span', { class: 'vn-bars', 'aria-hidden': 'true' }, ...Array.from({ length: 26 }, (_, i) => h('b', { style: { height: `${30 + Math.round(60 * Math.abs(Math.sin((i + 1) * 1.7 + (f.dur || 3))))}%` } })), fill);
  const time = h('span', { class: 'vn-time' }, fmtDur(f.dur || 0) || '0:00');
  const node = h('div', { class: 'vn', 'data-noptr': '' }, btn, bars, time);
  const paint = () => {
    const on = audio && !audio.paused;
    node.classList.toggle('is-playing', !!on);
    btn.replaceChildren(icon(on ? 'pause' : 'play', 14));
    btn.setAttribute('aria-label', on ? 'Pause voice message' : 'Play voice message');
  };
  function ensure() {
    if (audio) return audio;
    const url = urlOf(f.path, () => onAsset?.());
    if (!url) { node.classList.add('is-loading'); return null; }
    // One Audio per clip, so a chat that redraws mid-play keeps the same sound (and its controls).
    const fresh = !clips.has(f.path);
    audio = clips.get(f.path) || new Audio(url);
    clips.set(f.path, audio);
    // Play in sequence (Nov 22): a clip you started rolls straight into the next voice note below it.
    if (fresh) audio.addEventListener('ended', () => { if (audio._chain) playNextAfter(f.path); });
    audio.preload = 'auto';
    audio.addEventListener('timeupdate', () => {
      const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (f.dur || 1);
      fill.style.width = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
      time.textContent = fmtDur(Math.floor(audio.currentTime)) || '0:00';
    });
    audio.addEventListener('ended', () => { fill.style.width = '0%'; time.textContent = fmtDur(f.dur || 0) || '0:00'; if (nowPlaying === audio) nowPlaying = null; paint(); node.dispatchEvent(new CustomEvent('vn-ended', { bubbles: true })); });
    audio.addEventListener('pause', paint);
    audio.addEventListener('play', paint);
    return audio;
  }
  node.dataset.path = f.path;
  node.play = ({ chain = false } = {}) => {
    const a = ensure();
    if (!a) return Promise.reject(new Error('not ready'));
    a._chain = chain;
    if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
    nowPlaying = a;
    return a.play();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = ensure();
    if (!a) return;
    if (a.paused) node.play({ chain: true }).catch(() => {}); else a.pause();
  });
  // Tap along the line to jump.
  bars.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = ensure();
    if (!a) return;
    const r = bars.getBoundingClientRect();
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (f.dur || 0);
    if (d) a.currentTime = Math.max(0, Math.min(d, ((e.clientX - r.left) / r.width) * d));
    if (a.paused) node.play({ chain: true }).catch(() => {});
  });
  urlOf(f.path, () => { node.classList.remove('is-loading'); onAsset?.(); });
  if (clips.has(f.path)) { ensure(); paint(); }
  return node;
}

function playNextAfter(path) {
  const here = [...document.querySelectorAll('.vn')].find((n) => n.dataset.path === path && n.isConnected);
  const log = here?.closest('[role="log"], .er-list, .sc-list, .vr-list');
  if (!log) return;
  const all = [...log.querySelectorAll('.vn')];
  const next = all[all.indexOf(here) + 1];
  if (next?.play) { next.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); next.play({ chain: true }).catch(() => {}); }
}
/** Play every voice note in a chat from the top, one after another. */
export function playAllVoice(log) {
  const first = log?.querySelector('.vn');
  if (!first?.play) return false;
  first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  first.play({ chain: true }).catch(() => {});
  return true;
}

/** Play one clip to the end (sequence playback). { done: Promise, pause, resume, stop, audio }. */
export function playClip(path) {
  const url = urlOf(path);
  const a = clips.get(path) || (url ? new Audio(url) : null);
  if (!a) {
    // The link isn't signed yet: wait for it, then play.
    let stopped = false, inner = null;
    const done = new Promise((res) => {
      urlOf(path, () => { if (stopped) { res(); return; } inner = playClip(path); inner.done.then(res); });
      setTimeout(() => { if (!inner) res(); }, 8000);
    });
    return { done, pause: () => inner?.pause(), resume: () => inner?.resume(), stop: () => { stopped = true; inner?.stop(); } };
  }
  clips.set(path, a);
  if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
  nowPlaying = a;
  try { a.currentTime = 0; } catch {}
  let finish;
  const done = new Promise((res) => { finish = res; });
  const end = () => { a.removeEventListener('ended', end); a.removeEventListener('error', end); finish(); };
  a.addEventListener('ended', end); a.addEventListener('error', end);
  a.play().catch(() => end());
  return { audio: a, done, pause: () => a.pause(), resume: () => a.play().catch(() => {}), stop: () => { a.pause(); end(); } };
}

/** The little ▶ chip on a board note that carries a voice note. */
export function voiceChip(audio) {
  const t = h('span', { class: 'el-voice-t' }, fmtDur(audio.dur || 0) || '0:00');
  const ic = h('span', { class: 'el-voice-ic' }, icon('play', 11));
  const btn = h('button', { type: 'button', class: 'el-voice', 'data-noptr': '', 'aria-label': 'Play voice note', title: 'Play voice note' }, ic, t);
  let ctl = null;
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = clips.get(audio.path);
    if (a && !a.paused) { a.pause(); return; }
    ctl = playClip(audio.path);
    btn.classList.add('is-playing'); ic.replaceChildren(icon('pause', 11));
    const tick = setInterval(() => { const x = clips.get(audio.path); if (x) t.textContent = fmtDur(Math.floor(x.currentTime)) || '0:00'; }, 250);
    const stopUi = () => { clearInterval(tick); btn.classList.remove('is-playing'); ic.replaceChildren(icon('play', 11)); t.textContent = fmtDur(audio.dur || 0) || '0:00'; };
    ctl.done.then(stopUi);
    ctl.audio?.addEventListener('pause', stopUi, { once: true });
  });
  return btn;
}
