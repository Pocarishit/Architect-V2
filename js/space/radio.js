// Radio: plays your YouTube playlist on the Space.
//   Playlist mode — everyone listens on their own (their own position, their own skips).
//   Stream mode   — live: whoever presses a control "has the aux"; everyone else follows in real time
//                   (same song, same second). The state rides on the widget object, so it syncs with
//                   the rest of the Space. Browsers block sound until you click once, hence "Tune in".
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, promptDialog, menu, popover, closeFloating } from '../core/ui.js';
import { store, uid } from '../core/util.js';

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

export async function askSource(current = '') {
  const v = await promptDialog('YouTube playlist', { value: current, placeholder: 'https://www.youtube.com/playlist?list=…', ok: 'Play', label: 'Playlist or video link' });
  if (v == null) return null;
  const src = parseSource(v);
  if (!src) { toast('That isn’t a YouTube playlist or video link.', { tone: 'error', ms: 3500 }); return null; }
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
  const hideVideo = () => !!store.get(`architect.radio.hide.${el.id}`, false);
  const volKey = 'architect.radio.vol';

  const stage = h('div', { class: 'rd-stage' });
  const holder = h('div', { class: 'rd-yt' });
  stage.append(holder);
  const title = h('div', { class: 'rd-title' }, 'Radio');
  const artist = h('div', { class: 'rd-artist' }, 'Add your YouTube playlist');
  const live = h('div', { class: 'rd-live' });
  const bar = h('input', { class: 'rd-bar', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position' });
  const tCur = h('span', {}, '0:00'), tDur = h('span', {}, '0:00');
  const ctl = (ic, label, fn, cls) => h('button', { class: ['rd-btn', cls], type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, cls === 'rd-play' ? 22 : 17));
  const playBtn = ctl('play', 'Play', () => togglePlay(), 'rd-play');
  const shufBtn = ctl('shuffle', 'Shuffle', () => act({ shuffle: !st().shuffle }), 'rd-tog');
  const loopBtn = ctl('repeat', 'Repeat', () => act({ loop: !st().loop }), 'rd-tog');
  const vol = h('input', { class: 'rd-vol', type: 'range', min: 0, max: 100, value: store.get(volKey, 70), 'aria-label': 'Volume' });
  const tune = h('button', { class: 'rd-tune', type: 'button', onclick: () => tuneIn() }, icon('broadcast', 16), h('span', {}, 'Tune in'));
  const modeSeg = h('div', { class: 'seg seg-sm rd-mode', role: 'tablist' });
  const empty = h('button', { class: 'rd-empty', type: 'button', onclick: () => setSource() }, icon('music', 22), h('b', {}, 'Add your YouTube playlist'), h('span', {}, 'Paste a playlist (or video) link'));

  const card = h('div', { class: 'rd' },
    stage,
    h('div', { class: 'rd-info' }, title, artist),
    h('div', { class: 'rd-ctl' }, shufBtn, ctl('skipPrev', 'Previous', () => step(-1)), playBtn, ctl('skipNext', 'Next', () => step(1)), loopBtn),
    h('div', { class: 'rd-time' }, tCur, bar, tDur),
    h('div', { class: 'rd-foot' }, modeSeg, live, h('span', { class: 'rd-volwrap' }, icon('speaker', 13), vol)),
    tune);
  body.append(h('div', { class: 'rd-wrap' }, card, empty));

  // Header tools: change playlist, show/hide video.
  w.tools.append(
    h('button', { class: 'wg-btn', type: 'button', title: 'Radio options', 'aria-label': 'Radio options', onclick: (e) => menu(e.currentTarget, [
      { label: 'Playlist & queue…', icon: 'list', onSelect: () => openQueue(w.tools) },
      { label: 'Replace playlist…', icon: 'music', onSelect: () => setSource() },
      { label: 'Show video', icon: 'video', checked: !hideVideo(), onSelect: () => { store.set(`architect.radio.hide.${el.id}`, !hideVideo()); paint(); } },
      w.current().src ? { label: 'Open on YouTube', icon: 'external', onSelect: () => window.open(w.current().src, '_blank', 'noopener') } : null,
    ], { align: 'end' }) }, icon('settings', 14)));

  const st = () => w.current().st || {};
  const mode = () => w.current().mode || 'stream';
  const streaming = () => mode() === 'stream';
  const iControl = () => st().by === me.id;
  const queue = () => (Array.isArray(w.current().queue) ? w.current().queue : []);
  const qVids = () => queue().map((q) => q.vid);
  const qSig = () => qVids().join(',');
  const expected = (s = st()) => (s.playing ? (s.t || 0) + Math.max(0, Date.now() - (s.at || Date.now())) / 1000 : (s.t || 0));

  /* ---- state changes ---- */
  // Every control press: in Stream mode it becomes the shared state (you take the aux); in Playlist mode it's just you.
  function act(patch) {
    const base = { ...st(), ...currentPos() };
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
    tunedIn = true;
    wantPlay = true; // you just picked it: start playing as soon as it's loaded
    const items = await itemsFor(src);
    if (!items.length) { toast('That playlist came back empty. Is it public or unlisted?', { tone: 'error', ms: 5000 }); return; }
    const wasQueue = builtFor === 'queue' && ready;
    if (wasQueue) loadedSig = items.map((q) => q.vid).join(','); // loaded right below, not by update()
    w.live({ src: src.url, list: src.list, vid0: items[0].vid, queue: items, st: { by: me.id, name: me.username, index: 0, vid: items[0].vid, t: 0, playing: false, at: Date.now() } });
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
        const got = await Promise.all(missing.map(async (q) => [q.id, await videoTitle(q.vid)]));
        const by = new Map(got);
        w.live({ queue: queue().map((q) => (by.has(q.id) ? (by.get(q.id) ? { ...q, title: by.get(q.id).title, author: by.get(q.id).author } : { ...q, noTitle: true }) : q)) });
        paintQueue();
      }
    } finally { filling = false; }
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
    const src = parseSource(raw);
    if (!src) { toast('That isn’t a YouTube video or playlist link.', { tone: 'error', ms: 3500 }); return false; }
    if (src.error) { toast(src.error, { tone: 'error', ms: 6000 }); return false; }
    const base = ensureQueue();
    const items = await itemsFor(src);
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
    if (!ready) return;
    const q = queue()[i];
    if (!q) return;
    tunedIn = true;
    act({ index: i, vid: q.vid, t: 0, playing: true });
  }

  // Load the queue into the player in place (no rebuild), keeping the song that's on.
  let loadedSig = null;
  function syncQueue() {
    if (!ready || !queue().length) return;
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

  /* ---- the PLAYLIST menu ---- */
  let qPanel = null, qList = null;
  function openQueue(anchor) {
    ensureQueue();
    const input = h('input', { class: 'input rq-input', placeholder: 'Paste a video or playlist link', spellcheck: false, 'aria-label': 'Video or playlist link' });
    const addBtn = h('button', { class: 'btn sm rq-add', type: 'button' }, icon('plus', 14), 'Add');
    const add = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      addBtn.disabled = true;
      const ok = await addLink(v);
      addBtn.disabled = false;
      if (ok) input.value = '';
      input.focus();
    };
    addBtn.addEventListener('click', add);
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') closeFloating(); });
    input.addEventListener('paste', () => setTimeout(() => { if (parseSource(input.value)) add(); }, 0));
    qList = h('ol', { class: 'rq-list', role: 'list' });
    const content = h('div', { class: 'rq' },
      h('div', { class: 'rq-head' }, h('b', {}, 'PLAYLIST'), h('span', { class: 'rq-count' })),
      h('div', { class: 'rq-row-add' }, input, addBtn),
      qList,
      h('p', { class: 'rq-hint' }, 'Drag ⠿ to reorder · click a song to play it'));
    content.addEventListener('pointerdown', (e) => e.stopPropagation());
    content.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    qPanel = content;
    popover(anchor, content, { class: 'rq-pop', side: 'bottom', align: 'end' });
    paintQueue();
    setTimeout(() => input.focus({ preventScroll: true }), 40);
  }

  function paintQueue() {
    if (!qPanel?.isConnected || !qList) return;
    const items = queue();
    const on = currentPos().vid || st().vid;
    qPanel.querySelector('.rq-count').textContent = items.length ? `${items.length} SONG${items.length === 1 ? '' : 'S'}` : '';
    if (qList.dataset.dragging) return;
    qList.replaceChildren(...(items.length ? items.map((q, i) => {
      const grip = h('span', { class: 'rq-grip', 'aria-label': 'Drag to reorder', title: 'Drag to reorder' }, icon('grip', 14));
      const li = h('li', { class: ['rq-item', q.vid === on && 'is-on'], 'data-id': q.id },
        grip,
        h('button', { class: 'rq-play', type: 'button', onclick: () => playItem(i), title: 'Play this' },
          h('span', { class: 'rq-n' }, q.vid === on ? icon('music', 12) : String(i + 1)),
          h('span', { class: 'rq-text' }, h('span', { class: 'rq-title' }, q.title || (q.noTitle ? q.vid : 'Loading…')), q.author ? h('small', {}, q.author) : null)),
        h('button', { class: 'rq-x', type: 'button', 'aria-label': 'Remove from queue', title: 'Remove', onclick: () => setQueue(queue().filter((x) => x.id !== q.id)) }, icon('close', 13)));
      grip.addEventListener('pointerdown', (e) => dragItem(e, li));
      return li;
    }) : [h('li', { class: 'rq-empty' }, 'The queue is empty. Paste a video or a whole playlist above.')]));
  }

  function dragItem(e, li) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    // Window listeners, not pointer capture: moving the row in the list would drop the capture.
    qList.dataset.dragging = '1';
    li.classList.add('is-drag');
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
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
    const vars = { playsinline: 1, rel: 0, modestbranding: 1, controls: 0, disablekb: 1, iv_load_policy: 3, origin: location.origin };
    const q = Array.isArray(cur.queue) ? cur.queue : [];
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
          player.setVolume?.(Number(vol.value));
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
    card.hidden = !has;
    empty.hidden = has;
    w.setTitle('RADIO');
    stage.classList.toggle('is-hidden', hideVideo());
    const s = st();
    const data = ready ? (player.getVideoData?.() || {}) : {};
    title.textContent = data.title || (has ? 'Loading…' : 'Radio');
    artist.textContent = data.author || (queue().length > 1 ? `Playlist · ${queue().length} songs` : cur.list ? 'YouTube playlist' : 'YouTube');
    const playing = ready && player.getPlayerState?.() === 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 22));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    shufBtn.classList.toggle('is-on', !!s.shuffle);
    loopBtn.classList.toggle('is-on', !!s.loop);
    modeSeg.replaceChildren(...[['playlist', 'Playlist'], ['stream', 'Stream']].map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: mode() === id ? 'is-on' : null, 'aria-selected': String(mode() === id),
      title: id === 'stream' ? 'Everyone hears what the controller plays, in real time' : 'Everyone listens on their own',
      onclick: (e) => {
        // PLAYLIST opens the playlist menu (switching to Playlist mode first if you were streaming).
        const btn = e.currentTarget;
        if (mode() !== id) w.live({ mode: id, ...(id === 'stream' ? { st: { ...st(), ...currentPos(), by: me.id, name: me.username, at: Date.now() } } : {}) });
        if (id === 'playlist') openQueue(btn);
      },
    }, id === 'playlist' ? [icon('list', 12), label] : label)));
    paintQueue();
    live.replaceChildren(...(streaming() ? [h('i', { class: ['rd-dot', s.playing && 'is-on'] }), h('span', {}, s.by ? (s.by === me.id ? 'You control it' : `${s.name || 'Someone'} controls`) : 'Live')] : []));
    tune.hidden = tunedIn || !has || !(streaming() && s.playing);
  }

  // Progress + drift correction.
  const tick = setInterval(() => {
    if (!ready || destroyed) return;
    try {
      const d = player.getDuration?.() || 0, c = player.getCurrentTime?.() || 0;
      if (document.activeElement !== bar) bar.value = d ? Math.round((c / d) * 1000) : 0;
      tCur.textContent = fmt(c); tDur.textContent = fmt(d);
      // Listeners drift back to the controller's position.
      if (streaming() && tunedIn && !iControl() && !applying && st().at) {
        const s = st();
        const curVid = player.getVideoData?.()?.video_id;
        if ((s.vid && curVid && s.vid !== curVid) || Math.abs(c - expected(s)) > 3 || (s.playing !== (player.getPlayerState?.() === 1) && player.getPlayerState?.() !== 3)) apply(s);
      }
    } catch {}
  }, 1000);

  bar.addEventListener('change', () => {
    if (!ready) return;
    const d = player.getDuration?.() || 0;
    const t = (Number(bar.value) / 1000) * d;
    act({ t, playing: player.getPlayerState?.() === 1 || st().playing });
  });
  vol.addEventListener('input', () => { store.set(volKey, Number(vol.value)); try { player?.setVolume?.(Number(vol.value)); } catch {} });
  for (const n of [bar, vol]) n.addEventListener('pointerdown', (e) => e.stopPropagation());

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
    destroy() { destroyed = true; clearInterval(tick); try { player?.destroy?.(); } catch {} },
  };
}
