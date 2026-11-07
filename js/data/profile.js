// Profile faces (avatars). Stored in the private media bucket; profiles.avatar_path points at it.
// Local mode keeps the path in your prefs instead.
import { api } from './api.js';
import { loadPrefs, getPref, setPref } from './prefs.js';

const urls = new Map();   // user id → signed URL (or null)
let mine = null;

async function pathsFor(ids) {
  const me = api.auth.current()?.user?.id;
  const out = new Map();
  if (api.mode === 'local') {
    await loadPrefs();
    if (ids.includes(me)) out.set(me, getPref('avatarPath', null));
    return out;
  }
  try {
    const rows = await api.db.select('profiles', { columns: 'id,avatar_path', filters: { id: ids } });
    rows.forEach((r) => out.set(r.id, r.avatar_path || null));
  } catch {}
  return out;
}

/** Signed avatar URLs for these people: Map(id → url | null). */
export async function avatarsFor(ids) {
  const want = [...new Set(ids.filter(Boolean))].filter((id) => !urls.has(id));
  if (want.length) {
    const paths = await pathsFor(want);
    const list = [...paths.values()].filter(Boolean);
    let signed = {};
    if (list.length) { try { signed = await api.media.sign(list); } catch {} }
    want.forEach((id) => urls.set(id, paths.get(id) ? signed[paths.get(id)] || null : null));
  }
  return new Map(ids.map((id) => [id, urls.get(id) || null]));
}

export async function myAvatar() {
  const me = api.auth.current()?.user?.id;
  if (!me) return null;
  if (mine === null) mine = (await avatarsFor([me])).get(me) || '';
  return mine || null;
}

/** Upload a new face for yourself. Returns its URL. */
export async function setMyAvatar(file) {
  const me = api.auth.current()?.user?.id;
  const small = await shrink(file, 256);
  const { path, url } = await api.media.upload(small);
  if (api.mode === 'local') await setPref('avatarPath', path);
  else await api.db.update('profiles', me, { avatar_path: path });
  const signed = url || (await api.media.sign([path]))[path] || null;
  urls.set(me, signed);
  mine = signed || '';
  window.dispatchEvent(new CustomEvent('architect:avatar', { detail: { url: signed } }));
  return signed;
}

export async function clearMyAvatar() {
  const me = api.auth.current()?.user?.id;
  if (api.mode === 'local') await setPref('avatarPath', null);
  else await api.db.update('profiles', me, { avatar_path: null });
  urls.set(me, null);
  mine = '';
  window.dispatchEvent(new CustomEvent('architect:avatar', { detail: { url: null } }));
}

export function resetAvatars() { urls.clear(); mine = null; }

// Square-crop and downscale so faces stay tiny.
async function shrink(file, size) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.86));
    return blob ? new File([blob], 'avatar.webp', { type: 'image/webp' }) : file;
  } catch { return file; }
}
