// Radio — links beyond YouTube (Nov 23b).
// A pasted link from X, Threads, TikTok, Instagram, Facebook and other platforms becomes a queue item that
// plays in that platform's own embed player, with its native controls, fitted to the Radio panel.
// Links a platform won't play outside itself (short links, profiles, private or removed posts) show why
// and offer "Open original" instead of a blank or broken player.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

const dark = () => document.documentElement.dataset.theme !== 'light';
const enc = encodeURIComponent;

/**
 * A link → { provider, short, url, embed, shape, label } | { error, provider, url } | null (not a link we know).
 * shape: 'vertical' (9:16), 'wide' (16:9), 'post' (a card that scrolls), 'audio', 'file' (a plain video file).
 */
export function parseMediaLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^(?!https?:)/, 'https://')); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, '');
  const path = u.pathname;
  const url = u.href;
  let m;
  const ok = (provider, short, embed, shape, label) => ({ provider, short, url, embed, shape, label });
  const no = (provider, error) => ({ provider, url, error });

  if (/\.(mp4|webm|m4v|mov|ogv)$/i.test(path)) return ok('Video', 'MP4', url, 'file', 'Video file');

  // X / Twitter — a post (videos play inside it)
  if (['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com'].includes(host)) {
    if ((m = path.match(/\/status(?:es)?\/(\d+)/))) return ok('X', 'X', `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&theme=${dark() ? 'dark' : 'light'}&dnt=true`, 'post', 'Post on X');
    return no('X', 'That’s an X profile or page, not a post. Paste the link to a single post.');
  }
  // Threads
  if (host === 'threads.net' || host === 'threads.com') {
    if ((m = path.match(/^\/(@[\w.]+)\/post\/([\w-]+)/))) return ok('Threads', 'TH', `https://www.threads.net/${m[1]}/post/${m[2]}/embed`, 'post', 'Threads post');
    return no('Threads', 'That’s a Threads profile, not a post. Paste the link to a single post.');
  }
  // TikTok
  if (host.endsWith('tiktok.com')) {
    if ((m = path.match(/\/video\/(\d+)/)) || (m = path.match(/\/embed(?:\/v2)?\/(\d+)/)) || (m = path.match(/\/player\/v1\/(\d+)/))) {
      return ok('TikTok', 'TT', `https://www.tiktok.com/player/v1/${m[1]}?controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&music_info=1&description=1&rel=0`, 'vertical', 'TikTok video');
    }
    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || /^\/t\//.test(path)) return no('TikTok', 'That’s a TikTok short link. Open it, then copy the full link (it has /video/ in it) and paste that.');
    return no('TikTok', 'That TikTok link isn’t a single video.');
  }
  // Instagram
  if (host === 'instagram.com' || host === 'instagr.am') {
    if ((m = path.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/))) {
      const kind = m[1] === 'reels' ? 'reel' : m[1];
      return ok('Instagram', 'IG', `https://www.instagram.com/${kind}/${m[2]}/embed/`, kind === 'p' ? 'post' : 'vertical', kind === 'p' ? 'Instagram post' : 'Instagram reel');
    }
    if (/^\/stories\//.test(path)) return no('Instagram', 'Instagram stories can’t play outside Instagram.');
    return no('Instagram', 'That’s an Instagram profile, not a post or reel.');
  }
  // Facebook
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.com') {
    const video = host === 'fb.watch' || /\/videos?\/|\/watch\/?|\/reel\/|\/share\/(v|r)\//.test(path) || u.searchParams.has('v');
    const reel = /\/reel\/|\/share\/r\//.test(path);
    if (video) return ok('Facebook', 'FB', `https://www.facebook.com/plugins/video.php?href=${enc(url)}&show_text=false&autoplay=false&allowfullscreen=true`, reel ? 'vertical' : 'wide', reel ? 'Facebook reel' : 'Facebook video');
    if (/\/posts\/|\/permalink\.php|story_fbid|\/photo|\/share\/p\//.test(path + u.search)) return ok('Facebook', 'FB', `https://www.facebook.com/plugins/post.php?href=${enc(url)}&show_text=true`, 'post', 'Facebook post');
    return no('Facebook', 'That Facebook link isn’t a video or a post.');
  }
  // Vimeo
  if (host.endsWith('vimeo.com') && (m = path.match(/(?:^|\/)(\d{6,})(?:\/([\da-f]+))?/))) return ok('Vimeo', 'VM', `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ''}`, 'wide', 'Vimeo video');
  // Dailymotion
  if ((host === 'dailymotion.com' && (m = path.match(/\/video\/([\w]+)/))) || (host === 'dai.ly' && (m = path.match(/^\/([\w]+)/)))) return ok('Dailymotion', 'DM', `https://www.dailymotion.com/embed/video/${m[1]}`, 'wide', 'Dailymotion video');
  // Twitch (needs this site as its parent)
  if (host === 'clips.twitch.tv' || (host.endsWith('twitch.tv') && /\/clip\//.test(path))) {
    const id = host === 'clips.twitch.tv' ? path.slice(1).split('/')[0] : path.split('/clip/')[1]?.split('/')[0];
    if (id) return ok('Twitch', 'TW', `https://clips.twitch.tv/embed?clip=${enc(id)}&parent=${location.hostname}`, 'wide', 'Twitch clip');
  }
  if (host.endsWith('twitch.tv')) {
    if ((m = path.match(/^\/videos\/(\d+)/))) return ok('Twitch', 'TW', `https://player.twitch.tv/?video=${m[1]}&parent=${location.hostname}&autoplay=false`, 'wide', 'Twitch video');
    if ((m = path.match(/^\/([\w]+)\/?$/))) return ok('Twitch', 'TW', `https://player.twitch.tv/?channel=${m[1]}&parent=${location.hostname}&autoplay=false`, 'wide', `${m[1]} on Twitch`);
  }
  // Kick
  if (host === 'kick.com' && (m = path.match(/^\/([\w-]+)\/?$/))) return ok('Kick', 'KK', `https://player.kick.com/${m[1]}`, 'wide', `${m[1]} on Kick`);
  // Streamable
  if (host === 'streamable.com' && (m = path.match(/^\/(?:e\/)?(\w+)/))) return ok('Streamable', 'ST', `https://streamable.com/e/${m[1]}`, 'wide', 'Streamable video');
  // Reddit
  if ((host === 'reddit.com' || host === 'old.reddit.com') && (m = path.match(/^\/r\/([\w]+)\/comments\/([\w]+)/))) return ok('Reddit', 'RD', `https://embed.reddit.com/r/${m[1]}/comments/${m[2]}/?embed=true&theme=${dark() ? 'dark' : 'light'}`, 'post', 'Reddit post');
  if (host === 'redd.it' || host === 'v.redd.it') return no('Reddit', 'That’s a Reddit short link. Open it and paste the full post link instead.');
  // Audio
  if (host === 'soundcloud.com' && path.split('/').filter(Boolean).length >= 2) return ok('SoundCloud', 'SC', `https://w.soundcloud.com/player/?url=${enc(url)}&color=%23f2b733&visual=true&show_comments=false`, 'audio', 'SoundCloud');
  if (host === 'open.spotify.com' && (m = path.match(/^\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/))) return ok('Spotify', 'SP', `https://open.spotify.com/embed/${m[1]}/${m[2]}`, 'audio', `Spotify ${m[1]}`);
  return null;
}

/**
 * Play one link item in `box`. Shows a reason + "Open original" when the platform refuses or the page
 * never loads. Returns { destroy }.
 */
export function mountLinkPlayer(box, item, { autoplay = false } = {}) {
  const open = () => window.open(item.url, '_blank', 'noopener');
  const fail = h('div', { class: 'rd-fail', hidden: true },
    icon('external', 20),
    h('b', {}, 'Can’t play this here'),
    h('p', { class: 'rd-fail-why' }, ''),
    h('button', { type: 'button', class: 'rd-open', onclick: open }, icon('external', 13), 'Open original'));
  // soft: a banner along the bottom that leaves the player visible (it may still be fine).
  const showFail = (why, soft = false) => { fail.querySelector('.rd-fail-why').textContent = why; fail.classList.toggle('is-soft', soft); fail.hidden = false; };
  const orig = h('button', { type: 'button', class: 'rd-orig', title: `Open on ${item.provider || 'the original site'}`, onclick: open }, icon('external', 11), 'Open original');
  const wrap = h('div', { class: ['rd-ext', `is-${item.shape || 'wide'}`] });
  let timer = 0, onMsg = null;
  if (item.shape === 'file') {
    const v = h('video', { class: 'rd-ext-video', src: item.embed || item.url, controls: true, playsinline: true, preload: 'metadata', autoplay: autoplay || null });
    v.addEventListener('error', () => showFail('The video file couldn’t be loaded — it may have moved, or the site blocks playing it elsewhere.'));
    wrap.append(v);
  } else {
    let src = item.embed;
    if (autoplay && /vimeo|dailymotion|streamable|twitch|kick/.test(src)) src += `${src.includes('?') ? '&' : '?'}autoplay=1`;
    const frame = h('iframe', {
      class: 'rd-ext-frame', src, title: item.label || `${item.provider} player`, loading: 'eager',
      allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write', allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
    // A player that never loads (offline, refused in a frame): say why, over the player.
    // Platforms whose embeds talk to the page (X, Threads, TikTok, Instagram, Facebook, Reddit) also get a
    // quieter check: loaded but never said a word → probably private, removed or blocked outside the platform.
    let loaded = false, talked = false;
    const talks = /^(X|Threads|TikTok|Instagram|Facebook|Reddit)$/.test(item.provider);
    onMsg = (e) => { if (e.source === frame.contentWindow) talked = true; };
    window.addEventListener('message', onMsg);
    frame.addEventListener('load', () => {
      loaded = true; clearTimeout(timer);
      if (talks) timer = setTimeout(() => { if (!talked) showFail(`Nothing played? This ${item.provider} post may be private, removed, or blocked from playing outside ${item.provider}.`, true); }, 12000);
    });
    timer = setTimeout(() => { if (!loaded) showFail(`${item.provider} didn’t load. The post may be private, removed, or blocked from playing outside ${item.provider}.`); }, 15000);
    wrap.append(frame);
  }
  if (item.error) showFail(item.error);
  wrap.append(fail, orig);
  box.replaceChildren(wrap);
  box.hidden = false;
  return { destroy() { clearTimeout(timer); if (onMsg) window.removeEventListener('message', onMsg); box.replaceChildren(); box.hidden = true; } };
}
