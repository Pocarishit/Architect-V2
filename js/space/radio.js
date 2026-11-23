// Radio: plays your YouTube playlist on the Space, as a live stream — whoever presses a control "has the
//   aux"; everyone else follows in real time (same song, same second). Nov 19: stream only, YouTube's own
//   controls inside the frame, the queue behind the title-bar burger. The state rides on the widget object,
//   so it syncs with the rest of the Space. Browsers block sound until you click once, hence "Tune in".
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, promptDialog, menu, popover, closeFloating } from '../core/ui.js';
import { store, uid } from '../core/util.js';
import { parseMediaLink, mountLinkPlayer } from './radiolinks.js';
import { spotifyButton, spotifyLink, askScope, addPlaylist } from './spotify.js';
import { unfurl } from '../board/embed.js';

let ytLoading = null;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytLoading) return ytLoading;
  ytLoading = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch {} resolve(window.YT); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => { ytLoading = null; reject(new Error('YouTube didn’t load. Check your connection.')); };
    document.head.append(tag);
  });
  return ytLoading;
}

// Accepts a playlist link, a video link inside a playlist, or a single video / live stream.
export function parseSource(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^(?!https?:)/, 'https://')); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (!/(^|\.)youtube\.com$|^youtu\.be$|youtube-nocookie\.com$/.test(host)) return null;
  const list = u.searchParams.get('list');
  let vid = null, m;
  if (host === 'youtu.be') vid = u.pathname.slice(1).split('/')[0];
  else if (u.pathname === '/watch') vid = u.searchParams.get('v');
  else if ((m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/))) vid = m[2];
  if (!list && !vid) return null;
  const v = vid && /^[\w-]{6,}$/.test(vid) ? vid : null;
  // Auto "Mix" lists (RD…) and your private Watch later / Liked lists can't play outside YouTube.
  if (list && /^(RD|WL$|LL$|LM$)/.test(list)) return v ? { list: null, vid: v, url: u.href, note: 'YouTube Mixes and private lists can’t play here — playing just this video. Use a public or unlisted playlist for the full radio.' } : { error: 'That’s a YouTube Mix or a private list — those can’t play outside YouTube. Make a public or unlisted playlist and paste that.' };
  return { list: list || null, vid: v, url: u.href };
}

const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

/* ---- the queue: the Radio's own playlist (video ids + titles), editable from the PLAYLIST menu ---- */
// Every video id in a YouTube playlist, read through a hidden player (no API key needed).
export async function readYouTubeList(list, { timeout = 12000 } = {}) {
  const YT = await loadYT();
  const host = h('div', { class: 'rd-probe', 'aria-hidden': 'true' }, h('div'));
  document.body.append(host);
  try {
    return await new Promise((resolve) => {
      let done = false, p = null;
      const finish = (ids) => { if (done) return; done = true; try { p?.destroy?.(); } catch {} resolve(ids || []); };
      setTimeout(() => finish(p?.getPlaylist?.() || []), timeout);
      p = new YT.Player(host.firstChild, {
        host: 'https://www.youtube-nocookie.com', width: 200, height: 120,
        playerVars: { listType: 'playlist', list, controls: 0, origin: location.origin },
        events: {
          onReady: () => {
            let tries = 0;
            const look = () => { const ids = p.getPlaylist?.() || []; if (ids.length || ++tries > 40) finish(ids); else setTimeout(look, 150); };
            look();
          },
          onError: () => finish(p?.getPlaylist?.() || []),
        },
      });
    });
  } finally { host.remove(); }
}

// A video's title (no API key): YouTube's oEmbed, then noembed as a fallback.
const titleCache = new Map();
export async function videoTitle(vid) {
  if (titleCache.has(vid)) return titleCache.get(vid);
  const url = `https://www.youtube.com/watch?v=${vid}`;
  let t = null;
  for (const api of [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, `https://noembed.com/embed?url=${encodeURIComponent(url)}`]) {
    try { const r = await fetch(api); if (r.ok) { const j = await r.json(); if (j?.title) { t = { title: j.title, author: j.author_name || '' }; break; } } } catch {}
  }
  titleCache.set(vid, t);
  return t;
}

// Nov 23b: a link from another platform (X, Threads, TikTok, Instagram, Facebook…) → a Radio queue item.
export function linkItem(raw) {
  const p = parseMediaLink(raw);
  if (!p) return null;
  if (p.error) return { error: p.error, provider: p.provider };
  return { id: uid(), ext: true, url: p.url, embed: p.embed, provider: p.provider, short: p.short, shape: p.shape, label: p.label, title: null };
}

export async function askSource(current = '') {
  const v = await promptDialog('Radio', { value: current, placeholder: 'YouTube playlist, or a link from X, TikTok, Instagram…', ok: 'Play', label: 'Playlist or video link' });
  if (v == null) return null;
  const src = parseSource(v);
  if (!src) {
    const it = linkItem(v);
    if (it && !it.error) return { url: it.url, ext: it };
    toast(it?.error || 'That isn’t a link the Radio can play.', { tone: 'error', ms: 5000 });
    return null;
  }
  if (src.error) { toast(src.error, { tone: 'error', ms: 7000 }); return null; }
  if (src.note) toast(src.note, { ms: 6000 });
  return src;
}

// w: widget helper (w.current(), w.live(patch), w.me, w.tools, w.setTitle)
export function mountRadio(body, el, w) {
  const me = w.me || {};
  let player = null, ready = false, tunedIn = false, destroyed = false;
  let gen = 0;                  // each (re)build of the YouTube player; stale ones bail out
  let wantPlay = false;         // Play pressed before the player was ready
  let errors = 0;               // unplayable tracks skipped in a row
  let applying = false;         // true while we're moving the player to match the shared state
  let lastVid = null;
  const volKey = 'architect.radio.vol';

  // Nov 19 — stream first, queue on demand. The video fills the widget edge to edge with YouTube's own
  // small overlay controls (pause, volume, time, settings, captions, fullscreen) inside the frame; no tabs,
  // no modes. The queue lives behind the burger in the widget's title bar.
  const stage = h('div', { class: 'rd-stage' });
  const holder = h('div', { class: 'rd-yt' });
  const tune = h('button', { class: 'rd-tune', type: 'button', onclick: () => tuneIn() }, icon('broadcast', 16), h('span', {}, 'Tune in'));
  const extBox = h('div', { class: 'rd-extbox', hidden: true }); // a link from another platform plays here
  const spotBox = h('div', { class: 'rd-extbox rd-spotbox', hidden: true }); // your own Spotify playlist (Nov 24)
  stage.append(holder, extBox, spotBox, tune);
  const title = h('span', { class: 'rd-title' }, 'Radio');
  const artist = h('span', { class: 'rd-artist' }, '');
  const live = h('span', { class: 'rd-live' });
  const caption = h('div', { class: 'rd-cap' }, h('span', { class: 'rd-cap-text' }, title, artist), live);
  const empty = h('button', { class: 'rd-empty', type: 'button', onclick: () => setSource() }, icon('music', 22), h('b', {}, 'Add a playlist or video'), h('span', {}, 'YouTube, Spotify, X, Threads, TikTok, Instagram, Facebook…'));
  const card = h('div', { class: 'rd is-stream' }, stage, caption);
  body.append(h('div', { class: 'rd-wrap' }, card, empty));

  // Title bar: the burger drops the queue.
  const burger = h('button', { class: 'wg-btn rd-burger', type: 'button', title: 'Queue', 'aria-label': 'Queue', 'aria-haspopup': 'dialog', onclick: (e) => openQueue(e.currentTarget) }, icon('burger', 15));
  w.tools.append(spotifyButton({ onPlay: (item, scope) => playSpotify(item, scope) }), burger);

  /* ---- Spotify (Nov 24): your own playback, never the shared stream ----
     A Spotify playlist plays in Spotify's player here for you alone; the live YouTube stream is paused on
     this screen only (nobody else's Radio changes). The × puts you back on the stream. */
  let spot = null, spotPlayer = null;
  const spotClose = h('button', { type: 'button', class: 'rd-spot-x', title: 'Back to the Radio stream', 'aria-label': 'Back to the Radio stream', onclick: () => stopSpotify() }, icon('close', 13));
  function playSpotify(item, scope) {
    spot = { ...item, scope };
    try { if (ready && player.getPlayerState?.() === 1) { applying = true; player.pauseVideo(); setTimeout(() => { applying = false; }, 600); } } catch {}
    spotPlayer?.destroy();
    spotPlayer = mountLinkPlayer(spotBox, { provider: 'Spotify', url: item.url, embed: item.embed, shape: 'audio', label: item.title || 'Spotify playlist' });
    spotBox.append(spotClose);
    paint();
  }
  function stopSpotify() { spot = null; spotPlayer?.destroy(); spotPlayer = null; paint(); }
  // A Spotify link pasted into the Radio's own boxes: Personal or Shared, then it plays (for you).
  async function spotifyFrom(raw) {
    const s = spotifyLink(raw);
    if (!s) return false;
    if (s.error) { toast(s.error, { tone: 'error', ms: 5000 }); return true; }
    const scope = await askScope();
    if (!scope) return true;
    try { const r = await addPlaylist(raw, scope); playSpotify(r.item, scope); } catch (e) { toast(e.message, { tone: 'error' }); }
    return true;
  }

  const st = () => w.current().st || {};
  const mode = () => 'stream'; // Nov 19: the Radio is always a live stream (Playlist mode retired)
  const streaming = () => mode() === 'stream';
  const iControl = () => st().by === me.id;
  const queue = () => (Array.isArray(w.current().queue) ? w.current().queue : []);
  // The YouTube player only ever holds the YouTube items; links from other platforms play in extBox.
  const qVids = () => queue().filter((q) => !q.ext && q.vid).map((q) => q.vid);
  const linkNow = (s = st()) => (s.link ? queue().find((q) => q.id === s.link && q.ext) || null : null);
  const qSig = () => qVids().join(',');
  const expected = (s = st()) => (s.playing ? (s.t || 0) + Math.max(0, Date.now() - (s.at || Date.now())) / 1000 : (s.t || 0));

  /* ---- state changes ---- */
  // Every control press: in Stream mode it becomes the shared state (you take the aux); in Playlist mode it's just you.
  function act(patch) {
    const base = { ...st(), ...(st().link && !('link' in patch) ? {} : currentPos()) };
    const next = { ...base, ...patch, by: me.id, name: me.username || 'Someone', at: Date.now() };
    if (streaming()) w.live({ st: next });
    else { local = next; w.live({ st: { ...st(), shuffle: next.shuffle, loop: next.loop } }); }
    apply(next, true);
  }
  let local = null; // Playlist mode: your own state
  function currentPos() {
    if (!ready) return {};
    try { return { index: player.getPlaylistIndex?.() ?? st().index ?? 0, vid: player.getVideoData?.()?.video_id || st().vid || null, t: player.getCurrentTime?.() || 0, playing: player.getPlayerState?.() === 1 }; } catch { return {}; }
  }
  function togglePlay() {
    if (!w.current().src) { setSource(); return; }
    tunedIn = true;
    if (!ready) { wantPlay = true; title.textContent = 'Loading…'; return; }
    const playing = player.getPlayerState?.() === 1;
    act({ playing: !playing, t: player.getCurrentTime?.() || 0 });
  }
  function step(d) {
    if (!ready) return;
    const n = (player.getPlaylist?.() || []).length;
    let i = player.getPlaylistIndex?.() ?? 0;
    if (n) i = st().shuffle && d > 0 ? pickRandom(n, i) : (i + d + n) % n;
    tunedIn = true;
    act({ index: i, vid: (player.getPlaylist?.() || [])[i] || null, t: 0, playing: true });
  }
  const pickRandom = (n, not) => { if (n < 2) return 0; let r; do r = Math.floor(Math.random() * n); while (r === not); return r; };

  // Move the player to match a state (the shared one in Stream mode, yours in Playlist mode).
  function apply(s, fromMe = false) {
    if (spot) { paint(); return; } // you're on your own Spotify playlist: the stream waits
    if (s && linkNow(s)) { syncExt(s); try { if (ready && player.getPlayerState?.() === 1) { applying = true; player.pauseVideo(); setTimeout(() => { applying = false; }, 600); } } catch {} paint(); return; }
    syncExt(s);
    if (!ready || !s) return;
    applying = true;
    try {
      const list = player.getPlaylist?.() || [];
      const want = s.vid && list.includes(s.vid) ? list.indexOf(s.vid) : (s.index ?? null);
      const curIdx = player.getPlaylistIndex?.();
      const pos = expected(s);
      if (want != null && want !== curIdx && list.length) {
        if (s.playing && tunedIn) {
          player.playVideoAt(want);
          if (pos > 2) setTimeout(() => { try { player.seekTo(expected(s), true); } catch {} }, 700);
        } else if (queue().length) player.cuePlaylist?.(qVids(), want, pos);
        else player.cuePlaylist?.({ listType: 'playlist', list: w.current().list, index: want, startSeconds: pos });
      } else {
        if (Math.abs((player.getCurrentTime?.() || 0) - pos) > (fromMe ? 0.4 : 2.5)) player.seekTo(pos, true);
        if (s.playing && tunedIn) player.playVideo(); else player.pauseVideo();
      }
    } catch (e) { console.warn(e); }
    setTimeout(() => { applying = false; }, 900);
    paint();
  }

  // "Tune in": join what's playing live.
  function tuneIn() {
    tunedIn = true;
    if (!ready) { wantPlay = !streaming(); paint(); return; }
    if (streaming() && st().at) apply(st());
    else act({ playing: true });
    paint();
  }

  async function setSource() {
    const src = await askSource(w.current().src || '');
    if (!src) return;
    if (src.ext?.provider === 'Spotify' && await spotifyFrom(src.url)) return;
    tunedIn = true;
    if (src.ext) { // a link from another platform starts a fresh queue
      w.live({ src: src.url, list: null, vid0: null, queue: [src.ext], st: { by: me.id, name: me.username, index: 0, vid: null, link: src.ext.id, t: 0, playing: true, at: Date.now() } });
      fillTitles(); apply(st(), true);
      return;
    }
    wantPlay = true; // you just picked it: start playing as soon as it's loaded
    const items = await itemsFor(src);
    if (!items.length) { toast('That playlist came back empty. Is it public or unlisted?', { tone: 'error', ms: 5000 }); return; }
    const wasQueue = builtFor === 'queue' && ready;
    if (wasQueue) loadedSig = items.map((q) => q.vid).join(','); // loaded right below, not by update()
    w.live({ src: src.url, list: src.list, vid0: items[0].vid, queue: items, st: { by: me.id, name: me.username, index: 0, vid: items[0].vid, link: null, t: 0, playing: false, at: Date.now() } });
    if (wasQueue) {
      wantPlay = false;
      try { applying = true; player.loadPlaylist(qVids(), 0, 0); } catch {}
      setTimeout(() => { applying = false; act({ playing: true, index: 0, vid: items[0].vid, t: 0 }); }, 700);
    } else if (builtFor !== keyOf(w.current())) build(true); // (the update above normally rebuilds it already)
    fillTitles();
  }

  // A link → queue items. Playlists come in whole; a single video is one item.
  async function itemsFor(src) {
    let vids = [];
    if (src.list) {
      const wait = toast('Pulling in the playlist…', { ms: 0 });
      try { vids = await readYouTubeList(src.list); } catch (e) { toast(e.message, { tone: 'error' }); }
      wait.close();
      if (src.vid && !vids.length) vids = [src.vid];
    } else if (src.vid) vids = [src.vid];
    return vids.map((vid) => ({ id: uid(), vid, title: null }));
  }

  // Titles fill in after the fact, a few at a time, and ride on the widget so everyone sees them.
  let filling = false;
  async function fillTitles() {
    if (filling) return;
    filling = true;
    try {
      for (let round = 0; round < 50; round++) {
        const missing = queue().filter((q) => !q.title && !q.noTitle).slice(0, 6);
        if (!missing.length || destroyed) break;
        const got = await Promise.all(missing.map(async (q) => [q.id, q.ext ? await linkTitle(q) : await videoTitle(q.vid)]));
        const by = new Map(got);
        w.live({ queue: queue().map((q) => (by.has(q.id) ? (by.get(q.id) ? { ...q, title: by.get(q.id).title, author: by.get(q.id).author } : { ...q, noTitle: true }) : q)) });
        paintQueue();
      }
    } finally { filling = false; }
  }

  async function linkTitle(q) {
    const u = await unfurl(q.url).catch(() => null);
    const t = (u?.title || '').trim();
    return t ? { title: t.slice(0, 120), author: q.provider } : null;
  }

  // The queue as it is now. A Radio from before the queue existed takes its list from the player once.
  function ensureQueue() {
    if (queue().length) return queue();
    let vids = [];
    try { vids = ready ? player.getPlaylist?.() || [] : []; } catch {}
    if (!vids.length && w.current().vid0) vids = [w.current().vid0];
    const items = vids.map((vid) => ({ id: uid(), vid, title: null }));
    if (items.length) {
      // The player already holds these songs: switch to the queue without rebuilding it.
      if (ready) { builtFor = 'queue'; loadedSig = vids.join(','); }
      w.live({ queue: items });
      fillTitles();
    }
    return items;
  }
  function setQueue(items, { keepPlaying = true } = {}) {
    const cur = keepPlaying ? currentPos() : {};
    const vid = cur.vid || st().vid;
    const idx = Math.max(0, items.findIndex((q) => q.vid === vid));
    w.live({ queue: items, vid0: items[0]?.vid || null, ...(items.length ? { st: { ...st(), index: idx, vid: items[idx]?.vid || null } } : {}) });
    syncQueue();
    paintQueue();
  }
  async function addLink(raw) {
    if (await spotifyFrom(raw)) return true;
    const src = parseSource(raw);
    let items;
    if (!src) {
      const it = linkItem(raw);
      if (!it) { toast('That isn’t a link the Radio can play.', { tone: 'error', ms: 3500 }); return false; }
      if (it.error) { toast(it.error, { tone: 'error', ms: 6000 }); return false; }
      if (!w.current().src) {
        tunedIn = true;
        w.live({ src: it.url, list: null, vid0: null, queue: [it], st: { by: me.id, name: me.username, index: 0, vid: null, link: it.id, t: 0, playing: true, at: Date.now() } });
        apply(st(), true);
      } else setQueue([...(queue().length ? queue() : ensureQueue()), it]);
      toast(`Added ${it.label || 'the link'}.`, { ms: 1800 });
      fillTitles();
      return true;
    }
    if (src.error) { toast(src.error, { tone: 'error', ms: 6000 }); return false; }
    const base = ensureQueue();
    items = await itemsFor(src);
    if (!items.length) { toast('Nothing to add from that link.', { tone: 'error' }); return false; }
    const fresh = !w.current().src;
    if (fresh) {
      tunedIn = true; wantPlay = true;
      w.live({ src: src.url, list: null, vid0: items[0].vid, queue: items, st: { by: me.id, name: me.username, index: 0, vid: items[0].vid, t: 0, playing: false, at: Date.now() } });
    } else setQueue([...queue().length ? queue() : base, ...items]);
    toast(items.length > 1 ? `Added ${items.length} videos.` : 'Added to the queue.', { ms: 1800 });
    fillTitles();
    return true;
  }
  function playItem(i) {
    const q = queue()[i];
    if (!q) return;
    tunedIn = true;
    if (q.ext) { act({ link: q.id, playing: true, t: 0 }); return; }
    if (!ready) return;
    const yi = Math.max(0, qVids().indexOf(q.vid));
    act({ link: null, index: yi, vid: q.vid, t: 0, playing: true });
  }

  // The link from another platform that's on (if any): one embed player, rebuilt only when it changes.
  let ext = null, extId = null;
  function syncExt(s = st()) {
    const q = linkNow(s);
    if (!q) {
      if (ext) { ext.destroy(); ext = null; extId = null; }
      holder.style.visibility = '';
      return;
    }
    holder.style.visibility = 'hidden';
    if (extId === q.id && ext) return;
    ext?.destroy();
    extId = q.id;
    ext = mountLinkPlayer(extBox, q, { autoplay: !!(s.playing && tunedIn) });
  }

  // Load the queue into the player in place (no rebuild), keeping the song that's on.
  let loadedSig = null;
  function syncQueue() {
    if (!queue().some((q) => !q.ext) && builtFor === 'queue' && !ready) { builtFor = null; build(true); return; } // first YouTube item joined a links-only queue
    if (!ready || !qVids().length) return;
    const sig = qSig();
    if (sig === loadedSig) return;
    loadedSig = sig;
    try {
      const pos = currentPos();
      const vids = qVids();
      const i = Math.max(0, vids.indexOf(pos.vid || st().vid));
      applying = true;
      if (pos.playing) player.loadPlaylist(vids, i, vids[i] === pos.vid ? pos.t || 0 : 0);
      else player.cuePlaylist(vids, i, vids[i] === pos.vid ? pos.t || 0 : 0);
      setTimeout(() => { applying = false; }, 900);
    } catch (e) { console.warn(e); }
  }

  /* ---- the queue panel (title-bar burger) ---- */
  let qPanel = null, qList = null;
  const thumb = (vid) => `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/mqdefault.jpg`;
  function openQueue(anchor) {
    if (qPanel?.isConnected) { closeFloating(); return; }
    ensureQueue();
    const input = h('input', { class: 'input rq-input', placeholder: 'YouTube, X, Threads, TikTok, Instagram, Facebook…', spellcheck: false, 'aria-label': 'Video or playlist link' });
    const addRow = h('div', { class: 'rq-row-add', hidden: true }, input);
    const add = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      input.disabled = true;
      const ok = await addLink(v);
      input.disabled = false;
      if (ok) { input.value = ''; addRow.hidden = true; } else input.focus();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') { e.preventDefault(); addRow.hidden = true; } });
    input.addEventListener('paste', () => setTimeout(() => { if (parseSource(input.value) || parseMediaLink(input.value)) add(); }, 0));
    const addBtn = h('button', { class: 'rq-addbtn', type: 'button', onclick: () => { addRow.hidden = !addRow.hidden; if (!addRow.hidden) input.focus(); } }, icon('plus', 13), h('span', {}, 'Add video'));
    const shuf = h('button', {
      class: ['rq-switch', st().shuffle && 'is-on'], type: 'button', role: 'switch', 'aria-checked': String(!!st().shuffle), 'aria-label': 'Shuffle',
      onclick: () => { act({ shuffle: !st().shuffle }); shuf.classList.toggle('is-on', !!st().shuffle); shuf.setAttribute('aria-checked', String(!!st().shuffle)); },
    }, h('i'));
    qList = h('ol', { class: 'rq-list', role: 'list' });
    const content = h('div', { class: 'rq is-v2' },
      h('div', { class: 'rq-head' }, h('b', {}, 'QUEUE'), h('span', { class: 'rq-count' })),
      qList,
      addBtn, addRow,
      h('div', { class: 'rq-foot' }, h('span', {}, 'SHUFFLE'), shuf),
      linkNow() ? h('button', { class: 'rq-yt', type: 'button', onclick: () => window.open(linkNow().url, '_blank', 'noopener') }, icon('external', 12), h('span', {}, `Open on ${linkNow().provider}`))
        : w.current().src && /youtu/.test(w.current().src) ? h('button', { class: 'rq-yt', type: 'button', onclick: () => window.open(w.current().src, '_blank', 'noopener') }, icon('external', 12), h('span', {}, 'Open on YouTube')) : null);
    content.addEventListener('pointerdown', (e) => e.stopPropagation());
    content.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    qPanel = content;
    popover(anchor, content, { class: 'rq-pop', side: 'bottom', align: 'end' });
    paintQueue();
  }

  function paintNowTime() {
    const t = qPanel?.querySelector('.rq-item.is-on .rq-dur');
    if (!t || !ready) return;
    try { const d = player.getDuration?.() || 0; if (d) t.textContent = fmt(d); } catch {}
  }

  function paintQueue() {
    if (!qPanel?.isConnected || !qList) return;
    const items = queue();
    const on = linkNow()?.id || currentPos().vid || st().vid;
    qPanel.querySelector('.rq-count').textContent = items.length ? `${items.length}` : '';
    if (qList.dataset.dragging) return;
    qList.replaceChildren(...(items.length ? items.map((q, i) => {
      const isOn = q.ext ? q.id === on : q.vid === on;
      const li = h('li', { class: ['rq-item', isOn && 'is-on'], 'data-id': q.id, title: 'Click to play · drag to reorder' },
        h('i', { class: 'rq-now-dot', 'aria-hidden': 'true' }),
        h('button', { class: 'rq-play', type: 'button', onclick: () => { if (!li.dataset.moved) playItem(i); } },
          q.ext ? h('span', { class: 'rq-thumb is-ext', title: q.provider }, q.short || '↗')
            : h('span', { class: 'rq-thumb' }, h('img', { src: thumb(q.vid), alt: '', loading: 'lazy', draggable: false, onerror: (e) => e.currentTarget.remove() })),
          h('span', { class: 'rq-text' },
            h('span', { class: 'rq-title' }, q.title || (q.ext ? q.label : q.noTitle ? q.vid : 'Loading…')),
            h('small', { class: 'rq-dur' }, q.author || (q.ext ? q.provider : '')))),
        isOn ? h('span', { class: 'rq-now' }, 'NOW') : null,
        h('button', { class: 'rq-x', type: 'button', 'aria-label': 'Remove from queue', title: 'Remove', onclick: () => setQueue(queue().filter((x) => x.id !== q.id)) }, icon('close', 13)));
      li.addEventListener('pointerdown', (e) => { if (!e.target.closest('.rq-x')) dragItem(e, li); });
      return li;
    }) : [h('li', { class: 'rq-empty' }, 'The queue is empty — add a video or a whole playlist.')]));
    paintNowTime();
  }

  function dragItem(e, li) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Window listeners, not pointer capture: moving the row in the list would drop the capture.
    // The drag only starts once the pointer travels, so a plain click still plays the song.
    let started = false;
    delete li.dataset.moved;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!started) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        started = true; li.dataset.moved = '1'; qList.dataset.dragging = '1'; li.classList.add('is-drag');
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.rq-item');
      if (!over || over === li || over.parentNode !== qList) return;
      const r = over.getBoundingClientRect();
      qList.insertBefore(li, ev.clientY > r.top + r.height / 2 ? over.nextSibling : over);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
      li.classList.remove('is-drag');
      delete qList.dataset.dragging;
      if (!started) return;
      setTimeout(() => { delete li.dataset.moved; }, 0);
      const order = [...qList.querySelectorAll('.rq-item')].map((n) => n.dataset.id);
      const by = new Map(queue().map((q) => [q.id, q]));
      const next = order.map((x) => by.get(x)).filter(Boolean);
      if (next.length === queue().length && next.map((q) => q.id).join() !== queue().map((q) => q.id).join()) setQueue(next);
      else paintQueue();
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
  }

  /* ---- the YouTube player ---- */
  let builtFor = null;
  // With a queue the player is built once and the queue is swapped in place; without one, by list/video.
  const keyOf = (c) => (Array.isArray(c.queue) && c.queue.length ? 'queue' : `${c.list}|${c.vid0}`);
  async function build(force = false) {
    const cur = w.current();
    const key = keyOf(cur);
    if (!cur.src || (!force && builtFor === key)) { paint(); return; }
    builtFor = key;
    const ytOnly = (Array.isArray(cur.queue) ? cur.queue : []).filter((x) => !x.ext);
    if (Array.isArray(cur.queue) && cur.queue.length && !ytOnly.length) { // only links from other platforms
      try { player?.destroy?.(); } catch {}
      player = null; ready = false; holder.replaceChildren(h('div')); syncExt(); paint(); return;
    }
    const my = ++gen;
    ready = false;
    errors = 0;
    paint();
    try { player?.destroy?.(); } catch {}
    player = null;
    holder.replaceChildren(h('div'));
    let YT;
    try { YT = await loadYT(); } catch (e) { if (my === gen) { title.textContent = 'Couldn’t reach YouTube'; artist.textContent = e.message; } return; }
    if (destroyed || my !== gen) return; // a newer link was set meanwhile
    const vars = { playsinline: 1, rel: 0, modestbranding: 1, controls: 1, fs: 1, iv_load_policy: 3, origin: location.origin };
    const q = ytOnly;
    const startAt = q.length ? Math.max(0, Math.min(q.length - 1, q.findIndex((x) => x.vid === cur.st?.vid))) : 0;
    if (q.length) vars.playlist = q.map((x) => x.vid).filter((_, i) => i !== startAt).join(',');
    else if (cur.list) { vars.listType = 'playlist'; vars.list = cur.list; }
    loadedSig = null;
    player = new YT.Player(holder.firstChild, {
      host: 'https://www.youtube-nocookie.com',
      width: '100%', height: '100%',
      videoId: q.length ? q[startAt].vid : cur.vid0 || undefined,
      playerVars: vars,
      events: {
        onReady: () => {
          if (destroyed || my !== gen) return;
          ready = true;
          try { player.setVolume?.(Number(store.get(volKey, 70))); } catch {}
          if (queue().length) {
            // Load the queue in its own order (the constructor can only start from one video).
            const vids = qVids();
            const i = Math.max(0, vids.indexOf(st().vid));
            loadedSig = qSig();
            applying = true;
            try { if (wantPlay) player.loadPlaylist(vids, i, 0); else player.cuePlaylist(vids, i, streaming() ? expected() : 0); } catch {}
            const play = wantPlay; wantPlay = false;
            setTimeout(() => {
              applying = false;
              if (destroyed || my !== gen) return;
              if (play) act({ playing: true, index: i, vid: vids[i], t: 0 });
              else if (streaming() && st().at) apply(st());
            }, 700);
          } else if (wantPlay) { wantPlay = false; act({ playing: true, t: 0 }); }
          else if (streaming() && st().at) apply(st());
          paint();
        },
        onStateChange: (e) => {
          if (destroyed || my !== gen) return;
          const vid = player.getVideoData?.()?.video_id || null;
          // The song changed on its own (end of track): whoever has the aux tells everyone.
          if (e.data === 1) errors = 0;
          // A press on YouTube's own controls (pointer over the frame, or the frame focused) takes the aux.
          const framed = document.activeElement?.tagName === 'IFRAME' && stage.contains(document.activeElement);
          if (!applying && (stage.matches(':hover') || framed) && (e.data === 1 || e.data === 2)) {
            tunedIn = true;
            w.live({ st: { ...st(), ...currentPos(), playing: e.data === 1, by: me.id, name: me.username || 'Someone', at: Date.now() } });
          }
          if (vid && vid !== lastVid) {
            const fromAuto = lastVid && !applying;
            lastVid = vid;
            if (fromAuto && streaming() && iControl()) w.live({ st: { ...st(), index: player.getPlaylistIndex?.() ?? 0, vid, t: 0, playing: true, at: Date.now() } });
          }
          if (e.data === 0) { // ended
            const n = (player.getPlaylist?.() || []).length;
            const i = player.getPlaylistIndex?.() ?? 0;
            if (st().shuffle && n > 1 && (!streaming() || iControl())) step(1);
            else if (st().loop && (i >= n - 1 || !n) && (!streaming() || iControl())) act({ index: 0, vid: (player.getPlaylist?.() || [])[0] || null, t: 0, playing: true });
          }
          paint();
        },
        // Unplayable track (deleted, private, or embedding turned off): skip it — but not forever.
        onError: (e) => {
          if (destroyed || my !== gen) return;
          errors++;
          const n = (player.getPlaylist?.() || []).length;
          if (n > 1 && errors < Math.min(n, 8) && (!streaming() || iControl())) { setTimeout(() => step(1), 800); return; }
          title.textContent = 'Can’t play this here';
          artist.textContent = { 2: 'The link looks broken.', 5: 'This video can’t play in a browser player.', 100: 'Video not found, or it’s private.', 101: 'The owner turned off playing on other sites.', 150: 'The owner turned off playing on other sites.' }[e?.data] || 'YouTube refused to play it.';
        },
      },
    });
  }

  /* ---- drawing ---- */
  function paint() {
    const cur = w.current();
    const has = !!cur.src;
    card.hidden = !has && !spot;
    empty.hidden = has || !!spot;
    burger.hidden = !has;
    w.setTitle('RADIO');
    card.classList.toggle('is-spotify', !!spot);
    if (spot) {
      holder.style.visibility = 'hidden'; extBox.hidden = true;
      title.textContent = spot.title || `Spotify ${spot.what || 'playlist'}`;
      artist.textContent = ` · Spotify · ${spot.scope === 'shared' ? 'Shared' : 'Personal'}`;
      live.replaceChildren(h('span', {}, 'Only you'));
      live.title = 'Spotify plays for you alone — nobody else’s Radio changes.';
      tune.hidden = true;
      return;
    }
    extBox.hidden = !linkNow(st());
    const s = st();
    const data = ready ? (player.getVideoData?.() || {}) : {};
    const n = queue().length;
    const lk = linkNow(s);
    syncExt(s);
    title.textContent = lk ? (lk.title || lk.label || lk.provider) : data.title || (has ? 'Loading…' : 'Radio');
    artist.textContent = lk ? ` · ${lk.provider}${n > 1 ? ` · ${n} in queue` : ''}` : n > 1 ? ` · Playlist · ${n} songs` : data.author ? ` · ${data.author}` : '';
    paintQueue();
    live.replaceChildren(...(s.by ? [h('i', { class: ['rd-dot', s.playing && 'is-on'] }), h('span', {}, s.by === me.id ? 'You' : (s.name || 'Live'))] : []));
    live.title = s.by ? (s.by === me.id ? 'You control the stream' : `${s.name || 'Someone'} controls the stream`) : '';
    tune.hidden = tunedIn || !has || !s.playing || !!lk;
  }

  // Drift correction: listeners follow whoever has the aux. Your volume is remembered.
  const tick = setInterval(() => {
    if (!ready || destroyed) return;
    try {
      const v = player.getVolume?.();
      if (Number.isFinite(v) && v !== store.get(volKey, 70)) store.set(volKey, v);
      const c = player.getCurrentTime?.() || 0;
      if (streaming() && tunedIn && !iControl() && !applying && st().at) {
        const s = st();
        const curVid = player.getVideoData?.()?.video_id;
        if ((s.vid && curVid && s.vid !== curVid) || Math.abs(c - expected(s)) > 3 || (s.playing !== (player.getPlayerState?.() === 1) && player.getPlayerState?.() !== 3)) apply(s);
      }
      if (qPanel?.isConnected) paintNowTime();
    } catch {}
  }, 1000);

  const onSpotReq = (e) => { if (e.detail?.id === el.id && e.detail.url) spotifyFrom(e.detail.url); };
  window.addEventListener('architect:radio-spotify', onSpotReq);

  build();
  paint();

  return {
    update(next) {
      const key = keyOf(next);
      if (next.src && key !== builtFor) {
        // You just set this link (from the Add menu): play it as soon as it loads.
        if (next.st?.by === me.id && Date.now() - (next.st.at || 0) < 30_000) { tunedIn = true; wantPlay = true; }
        build();
        return;
      }
      if (key === 'queue') syncQueue();
      if (streaming() && tunedIn && !iControl() && next.st?.at) apply(next.st);
      else paint();
    },
    destroy() { destroyed = true; clearInterval(tick); ext?.destroy(); spotPlayer?.destroy(); window.removeEventListener('architect:radio-spotify', onSpotReq); try { player?.destroy?.(); } catch {} },
  };
}
