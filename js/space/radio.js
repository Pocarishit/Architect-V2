// Radio: plays your YouTube playlist on the Space.
//   Playlist mode — everyone listens on their own (their own position, their own skips).
//   Stream mode   — live: whoever presses a control "has the aux"; everyone else follows in real time
//                   (same song, same second). The state rides on the widget object, so it syncs with
//                   the rest of the Space. Browsers block sound until you click once, hence "Tune in".
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, promptDialog, menu } from '../core/ui.js';
import { store } from '../core/util.js';

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
      { label: 'Change playlist…', icon: 'music', onSelect: () => setSource() },
      { label: 'Show video', icon: 'video', checked: !hideVideo(), onSelect: () => { store.set(`architect.radio.hide.${el.id}`, !hideVideo()); paint(); } },
      w.current().src ? { label: 'Open on YouTube', icon: 'external', onSelect: () => window.open(w.current().src, '_blank', 'noopener') } : null,
    ], { align: 'end' }) }, icon('settings', 14)));

  const st = () => w.current().st || {};
  const mode = () => w.current().mode || 'stream';
  const streaming = () => mode() === 'stream';
  const iControl = () => st().by === me.id;
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
        } else player.cuePlaylist?.({ listType: 'playlist', list: w.current().list, index: want, startSeconds: pos });
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
    w.live({ src: src.url, list: src.list, vid0: src.vid, st: { by: me.id, name: me.username, index: 0, vid: src.vid, t: 0, playing: false, at: Date.now() } });
    if (builtFor !== `${src.list}|${src.vid}`) build(true); // (the update above normally rebuilds it already)
  }

  /* ---- the YouTube player ---- */
  let builtFor = null;
  async function build(force = false) {
    const cur = w.current();
    const key = `${cur.list}|${cur.vid0}`;
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
    if (cur.list) { vars.listType = 'playlist'; vars.list = cur.list; }
    player = new YT.Player(holder.firstChild, {
      host: 'https://www.youtube-nocookie.com',
      width: '100%', height: '100%',
      videoId: cur.vid0 || undefined,
      playerVars: vars,
      events: {
        onReady: () => {
          if (destroyed || my !== gen) return;
          ready = true;
          player.setVolume?.(Number(vol.value));
          if (wantPlay) { wantPlay = false; act({ playing: true, t: 0 }); }
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
    artist.textContent = data.author || (cur.list ? 'YouTube playlist' : 'YouTube');
    const playing = ready && player.getPlayerState?.() === 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 22));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    shufBtn.classList.toggle('is-on', !!s.shuffle);
    loopBtn.classList.toggle('is-on', !!s.loop);
    modeSeg.replaceChildren(...[['playlist', 'Playlist'], ['stream', 'Stream']].map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: mode() === id ? 'is-on' : null, 'aria-selected': String(mode() === id),
      title: id === 'stream' ? 'Everyone hears what the controller plays, in real time' : 'Everyone listens on their own',
      onclick: () => { if (mode() === id) return; w.live({ mode: id, ...(id === 'stream' ? { st: { ...st(), ...currentPos(), by: me.id, name: me.username, at: Date.now() } } : {}) }); },
    }, label)));
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
      const key = `${next.list}|${next.vid0}`;
      if (next.src && key !== builtFor) {
        // You just set this link (from the Add menu): play it as soon as it loads.
        if (next.st?.by === me.id && Date.now() - (next.st.at || 0) < 30_000) { tunedIn = true; wantPlay = true; }
        build();
        return;
      }
      if (streaming() && tunedIn && !iControl() && next.st?.at) apply(next.st);
      else paint();
    },
    destroy() { destroyed = true; clearInterval(tick); try { player?.destroy?.(); } catch {} },
  };
}
