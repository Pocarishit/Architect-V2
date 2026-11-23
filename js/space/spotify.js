// Radio × Spotify playlists (Nov 24).
// Paste a Spotify playlist (or album) link into Radio and it plays in Spotify's own player, right in the
// Radio. Each playlist is either
//   · PERSONAL — saved on your account only; nobody else sees it or hears it, or
//   · SHARED   — published to the people in your Shared Space (a shared_items row, kind 'spotify'), so they
//                can open and play it from their Radio.
// Playback is always yours alone: playing a shared playlist never starts it for anyone else, and switching
// the panel to Personal never changes what's shared. The Radio's live YouTube stream is left as it is.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, popover, closeFloating, confirmDialog, promptDialog, dialog } from '../core/ui.js';
import { store, uid } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { getPref, setPref, loadPrefs } from '../data/prefs.js';
import { listShared, createShared, addMember, removeShared, meId, nameOf } from '../data/shared.js';
import { parseMediaLink } from './radiolinks.js';
import { unfurl } from '../board/embed.js';

const KIND = 'spotify';
const MODE_KEY = 'architect.radio.spotMode';

/** A Spotify playlist / album / show link → { url, embed, what } or { error } or null (not Spotify). */
export function spotifyLink(raw) {
  const p = parseMediaLink(raw);
  if (!p || p.provider !== 'Spotify') return null;
  if (p.error) return { error: p.error };
  const what = (p.url.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(\w+)\//) || [])[1] || 'playlist';
  return { url: p.url.split('?')[0], embed: p.embed, what };
}
export const isSpotify = (raw) => !!spotifyLink(raw);

/* ---------------- data ---------------- */
const personal = () => (Array.isArray(getPref('spotifyLists', null)) ? getPref('spotifyLists', []) : []);
const savePersonal = (list) => setPref('spotifyLists', list.slice(0, 100));
let shared = [];
let sharedAt = 0;
const subs = new Set();
const emit = () => subs.forEach((f) => { try { f(); } catch {} });
async function loadSharedLists(force = false) {
  if (api.mode === 'local') return shared;
  if (!force && Date.now() - sharedAt < 20_000) return shared;
  try { shared = await listShared(KIND); sharedAt = Date.now(); emit(); } catch { /* table missing or offline: keep the last list */ }
  return shared;
}
async function titleOf(url) {
  try { const u = await unfurl(url); return (u?.title || '').replace(/\s*\|\s*Spotify\s*$/i, '').trim().slice(0, 120) || null; } catch { return null; }
}

export async function addPlaylist(raw, scope) {
  const s = spotifyLink(raw);
  if (!s) throw new Error('That isn’t a Spotify link.');
  if (s.error) throw new Error(s.error);
  await loadPrefs();
  const item = { id: uid(), url: s.url, embed: s.embed, what: s.what, title: null, at: Date.now() };
  if (scope === 'shared') {
    if (api.mode === 'local') throw new Error('Sharing needs Supabase sync.');
    if ((await loadSharedLists(true)).some((r) => r.data?.url === s.url)) return { item: shared.find((r) => r.data?.url === s.url).data, scope, row: shared.find((r) => r.data?.url === s.url) };
    let row;
    try { row = await createShared(KIND, { ...item, by: api.auth.current()?.user?.username || '' }); }
    catch (e) { throw new Error(/kind_check|check constraint/i.test(String(e?.message)) ? 'Sharing playlists needs one database update: run supabase/nov24.sql in the Supabase SQL editor.' : friendlyError(e)); }
    const spaceId = getPref('spaceId', null);
    const failed = [];
    if (spaceId) {
      let people = [];
      try { people = (await api.rpc('board_people', { b: spaceId })) || []; } catch {}
      for (const p of people) { if (p.user_id === meId()) continue; try { await addMember(row, p.username); } catch { failed.push(p.username); } }
    }
    shared = [...shared, row]; emit();
    if (failed.length) toast(`Shared — couldn’t add ${failed.join(', ')}.`, { ms: 3200 });
    titleOf(s.url).then((t) => { if (t) { row.data = { ...row.data, title: t }; api.db.update('shared_items', row.id, { data: row.data }).catch(() => {}); emit(); } });
    return { item: row.data, scope, row };
  }
  const have = personal().find((x) => x.url === s.url);
  if (have) return { item: have, scope };
  await savePersonal([item, ...personal()]);
  emit();
  titleOf(s.url).then((t) => { if (t) { savePersonal(personal().map((x) => (x.id === item.id ? { ...x, title: t } : x))).then(emit).catch(() => {}); } });
  return { item, scope };
}

/* ---------------- the panel ---------------- */
/** Ask Personal or Shared for a pasted Spotify link (from the Radio's own link boxes). */
export async function askScope() {
  const v = await dialog({
    title: 'Spotify playlist', width: 400,
    body: h('p', { class: 'dlg-text' }, 'Keep it personal (only you see and hear it), or share it with your Shared Space so others can open and play it from their Radio. Playback never starts for anyone else.'),
    actions: [{ label: 'Cancel', value: null }, { label: 'Personal', value: 'personal' }, { label: 'Shared', primary: true, value: 'shared' }],
  });
  return v || null;
}

/**
 * The Spotify button for a Radio's title bar. onPlay(item, scope) plays it in that Radio (yours only).
 */
export function spotifyButton({ onPlay }) {
  const btn = h('button', { class: 'wg-btn rd-spotbtn', type: 'button', title: 'Spotify playlists', 'aria-label': 'Spotify playlists', 'aria-haspopup': 'dialog' }, icon('music', 15));
  btn.addEventListener('click', () => open(btn));
  let panel = null;
  function open(anchor) {
    if (panel?.isConnected) { closeFloating(); return; }
    let mode = store.get(MODE_KEY, 'personal') === 'shared' ? 'shared' : 'personal';
    const input = h('input', { class: 'input sm', placeholder: 'Paste a Spotify playlist link', spellcheck: false, 'aria-label': 'Spotify playlist link',
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add(); } } });
    const seg = h('div', { class: 'seg seg-sm spot-seg', role: 'tablist' });
    const list = h('div', { class: 'spot-list' });
    const note = h('p', { class: 'spot-note' });
    async function add() {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      input.disabled = true;
      try {
        const r = await addPlaylist(v, mode);
        input.value = '';
        onPlay(r.item, mode);
        closeFloating();
      } catch (e) { toast(e.message || friendlyError(e), { tone: 'error', ms: 4000 }); }
      finally { input.disabled = false; }
    }
    function paint() {
      seg.replaceChildren(...[['personal', 'Personal'], ['shared', 'Shared']].map(([id, label]) => h('button', {
        type: 'button', role: 'tab', class: mode === id ? 'is-on' : null, 'aria-selected': String(mode === id),
        onclick: () => { mode = id; store.set(MODE_KEY, id); paint(); if (id === 'shared') loadSharedLists(true).then(paint); },
      }, label)));
      note.textContent = mode === 'personal' ? 'Only you see these, and only you hear them.' : 'Everyone in your Shared Space can open these from their Radio. Playing one never starts it for anyone else.';
      const rows = mode === 'personal'
        ? personal().map((x) => row(x, 'personal'))
        : shared.map((r) => row(r.data || {}, 'shared', r));
      list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'spot-empty' }, mode === 'personal' ? 'No personal playlists yet.' : 'Nothing shared yet.')]));
    }
    function row(x, scope, r = null) {
      const mine = !r || r.user_id === meId();
      const more = h('button', { type: 'button', class: 'icon-btn xs', 'aria-label': 'Playlist options', onclick: (e) => {
        e.stopPropagation();
        menu(e.currentTarget, scope === 'personal' ? [
          { label: 'Share with your Space', icon: 'users', onSelect: async () => { try { await addPlaylist(x.url, 'shared'); toast('Shared — it stays in Personal too.', { ms: 2200 }); } catch (er) { toast(er.message, { tone: 'error' }); } } },
          { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename playlist', { value: x.title || '', maxLength: 80 }); if (n?.trim()) { await savePersonal(personal().map((y) => (y.id === x.id ? { ...y, title: n.trim() } : y))); paint(); } } },
          { label: 'Open in Spotify', icon: 'external', onSelect: () => window.open(x.url, '_blank', 'noopener') },
          '-',
          { label: 'Remove', icon: 'trash', danger: true, onSelect: async () => { await savePersonal(personal().filter((y) => y.id !== x.id)); paint(); } },
        ] : [
          { label: 'Save to Personal', icon: 'plus', onSelect: async () => { await addPlaylist(x.url, 'personal'); toast('Saved to Personal.', { ms: 1600 }); } },
          { label: 'Open in Spotify', icon: 'external', onSelect: () => window.open(x.url, '_blank', 'noopener') },
          mine ? '-' : null,
          mine ? { label: 'Stop sharing', icon: 'trash', danger: true, onSelect: async () => {
            if (!(await confirmDialog('Stop sharing this playlist?', 'It disappears from everyone’s Shared list. Personal copies stay.', { ok: 'Stop sharing' }))) return;
            try { await removeShared(r); shared = shared.filter((y) => y.id !== r.id); paint(); } catch (er) { toast(friendlyError(er), { tone: 'error' }); }
          } } : null,
        ].filter(Boolean), { align: 'end' });
      } }, icon('more', 14));
      return h('div', { class: 'spot-row', role: 'button', tabindex: 0, onclick: () => { onPlay(x, scope); closeFloating(); },
        onkeydown: (e) => { if (e.key === 'Enter') { onPlay(x, scope); closeFloating(); } } },
        h('span', { class: 'spot-ic' }, icon('play', 12)),
        h('span', { class: 'spot-name' }, x.title || `Spotify ${x.what || 'playlist'}`),
        scope === 'shared' && r && !mine ? h('span', { class: 'spot-by' }, nameOf(r.user_id) || x.by || '') : null,
        more);
    }
    panel = h('div', { class: 'spot-panel' },
      h('div', { class: 'spot-head' }, h('b', {}, 'SPOTIFY'), seg),
      h('div', { class: 'spot-add' }, input, h('button', { type: 'button', class: 'btn btn-primary sm', onclick: add }, 'Add')),
      note, list);
    paint();
    loadSharedLists().then(() => { if (panel?.isConnected) paint(); });
    popover(anchor, panel, { align: 'end' });
    setTimeout(() => input.focus(), 40);
  }
  return btn;
}
