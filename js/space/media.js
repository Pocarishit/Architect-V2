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
export async function uploadMedia(file) {
  const kind = /^video\//.test(file.type) ? 'video' : /^image\//.test(file.type) ? 'photo' : null;
  if (!kind) throw new Error('Only photos and videos can go here.');
  const max = api.media?.maxBytes || 50 * 1024 * 1024;
  let up = file;
  if (kind === 'photo' && !/gif|svg/.test(file.type)) up = await shrink(file, 1800).catch(() => file);
  if (up.size > max) throw new Error(`${file.name || 'That file'} is over ${Math.round(max / 1048576)} MB.`);
  const dur = kind === 'video' ? await durationOf(file) : 0;
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
