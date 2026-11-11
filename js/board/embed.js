// Turn a pasted URL into something a board can hold: a video/embed player, an image, or a link card.

function parseTime(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(v);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

// Pulls a usable address out of whatever was pasted: "watch this https://… thanks", "<https://…>",
// "youtube.com/watch?v=…" or "www.site.com/page" (no https:// typed).
export function extractUrl(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 4000) return null;
  const full = t.match(/https?:\/\/[^\s<>"'`]+/i);
  let url = full ? full[0] : null;
  // No scheme typed: only when it clearly is an address ("www." or a common ending), so "notes.md" stays text.
  if (!url && !/\s/.test(t) && (/^www\.[a-z0-9-]+\.[a-z]{2,}/i.test(t) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|gg|tv|me|ai|so|xyz|ph|us|uk|ca|au|de|fr|jp|be|ly|to|fm|link|site|page|studio|design|music|video)(?:[/?#:][^\s]*)?$/i.test(t))) url = `https://${t}`;
  if (!url) return null;
  url = url.replace(/[)\].,;:!?'"»]+$/, (m) => (url.includes('(') && m.startsWith(')') ? m.slice(0, 1) : '')); // trailing punctuation from prose
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null; } catch { return null; }
}

export function parseUrl(raw) {
  let u;
  try { u = new URL(extractUrl(raw) || String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  const path = u.pathname;
  let m;

  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(path)) return { type: 'video', src: u.href, label: 'Video file', w: 560, h: 315 };
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(path)) return { type: 'image', src: u.href, label: 'Image' };

  // YouTube (watch, youtu.be, shorts, live, embed)
  let yt = null, shorts = false;
  if (host === 'youtu.be') yt = path.slice(1).split('/')[0];
  else if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    if (path === '/watch') yt = u.searchParams.get('v');
    else if ((m = path.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/))) { yt = m[2]; shorts = m[1] === 'shorts'; }
  }
  const ytList = (host.endsWith('youtube.com') || host === 'youtu.be') ? u.searchParams.get('list') : null;
  if (ytList && (!yt || path === '/playlist')) {
    return { type: 'embed', provider: 'YouTube', url: u.href, embed: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(ytList)}&rel=0&playsinline=1`, w: 640, h: 360, label: 'YouTube playlist' };
  }
  if (yt && /^[\w-]{6,}$/.test(yt)) {
    const t = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));
    return {
      type: 'embed', provider: 'YouTube', url: u.href,
      embed: `https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1${t ? `&start=${t}` : ''}`,
      w: shorts ? 315 : 640, h: shorts ? 560 : 360, label: shorts ? 'YouTube Short' : 'YouTube video',
    };
  }
  if (host === 'instagram.com' && (m = path.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/))) {
    return { type: 'embed', provider: 'Instagram', url: u.href, embed: `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/embed/captioned/`, w: 360, h: 620, label: 'Instagram post' };
  }
  if ((host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') && (m = path.match(/\/status(?:es)?\/(\d+)/))) {
    return { type: 'embed', provider: 'X', url: u.href, embed: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&theme=${document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}&dnt=true`, w: 420, h: 520, label: 'Post on X' };
  }
  if (host === 'soundcloud.com' && path.split('/').filter(Boolean).length >= 1) {
    return { type: 'embed', provider: 'SoundCloud', url: u.href, embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.href)}&color=%23D71921&visual=false&show_comments=false`, w: 460, h: /\/sets\//.test(path) ? 380 : 166, label: 'SoundCloud' };
  }
  if (host === 'music.apple.com') {
    return { type: 'embed', provider: 'Apple Music', url: u.href, embed: `https://embed.music.apple.com${path}${u.search}`, w: 460, h: u.searchParams.get('i') || /\/song\//.test(path) ? 175 : 450, label: 'Apple Music' };
  }
  if (host === 'codepen.io' && (m = path.match(/^\/([\w-]+)\/(?:pen|full|details)\/(\w+)/))) {
    return { type: 'embed', provider: 'CodePen', url: u.href, embed: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result&theme-id=dark`, w: 640, h: 420, label: 'CodePen' };
  }
  if (host.endsWith('canva.com') && (m = path.match(/^\/design\/([\w-]+)\/([\w-]+)/))) {
    return { type: 'embed', provider: 'Canva', url: u.href, embed: `https://www.canva.com/design/${m[1]}/${m[2]}/view?embed`, w: 640, h: 400, label: 'Canva design' };
  }
  if (host === 'miro.com' && (m = path.match(/^\/app\/board\/([\w=-]+)/))) {
    return { type: 'embed', provider: 'Miro', url: u.href, embed: `https://miro.com/app/live-embed/${m[1]}/`, w: 720, h: 450, label: 'Miro board' };
  }
  if (host.endsWith('vimeo.com') && (m = path.match(/(?:^|\/)(\d{6,})(?:\/|$)/))) {
    return { type: 'embed', provider: 'Vimeo', url: u.href, embed: `https://player.vimeo.com/video/${m[1]}`, w: 640, h: 360, label: 'Vimeo video' };
  }
  if (host.endsWith('loom.com') && (m = path.match(/\/(?:share|embed)\/([\w-]+)/))) {
    return { type: 'embed', provider: 'Loom', url: u.href, embed: `https://www.loom.com/embed/${m[1]}`, w: 640, h: 400, label: 'Loom video' };
  }
  if (host === 'streamable.com' && (m = path.match(/^\/(?:e\/)?(\w+)/))) {
    return { type: 'embed', provider: 'Streamable', url: u.href, embed: `https://streamable.com/e/${m[1]}`, w: 640, h: 360, label: 'Streamable video' };
  }
  if (host.endsWith('tiktok.com') && (m = path.match(/\/video\/(\d+)/))) {
    return { type: 'embed', provider: 'TikTok', url: u.href, embed: `https://www.tiktok.com/embed/v2/${m[1]}`, w: 325, h: 580, label: 'TikTok video' };
  }
  if (host === 'clips.twitch.tv' || (host.endsWith('twitch.tv') && /\/clip\//.test(path))) {
    const id = host === 'clips.twitch.tv' ? path.slice(1) : path.split('/clip/')[1];
    if (id) return { type: 'embed', provider: 'Twitch', url: u.href, embed: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(id)}&parent=${location.hostname}`, w: 640, h: 360, label: 'Twitch clip' };
  }
  if (host.endsWith('twitch.tv')) {
    if ((m = path.match(/^\/videos\/(\d+)/))) return { type: 'embed', provider: 'Twitch', url: u.href, embed: `https://player.twitch.tv/?video=${m[1]}&parent=${location.hostname}&autoplay=false`, w: 640, h: 360, label: 'Twitch video' };
    if ((m = path.match(/^\/([\w]+)\/?$/))) return { type: 'embed', provider: 'Twitch', url: u.href, embed: `https://player.twitch.tv/?channel=${m[1]}&parent=${location.hostname}&autoplay=false`, w: 640, h: 360, label: 'Twitch channel' };
  }
  if (host === 'open.spotify.com' && (m = path.match(/^\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/))) {
    const compact = m[1] === 'track' || m[1] === 'episode';
    return { type: 'embed', provider: 'Spotify', url: u.href, embed: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, w: 400, h: compact ? 152 : 380, label: `Spotify ${m[1]}` };
  }
  if (host === 'drive.google.com' && (m = path.match(/\/file\/d\/([\w-]+)/))) {
    return { type: 'embed', provider: 'Google Drive', url: u.href, embed: `https://drive.google.com/file/d/${m[1]}/preview`, w: 640, h: 400, label: 'Drive file' };
  }
  if (host === 'docs.google.com' && (m = path.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/))) {
    return { type: 'embed', provider: 'Google Docs', url: u.href, embed: `https://docs.google.com/${m[1]}/d/${m[2]}/preview`, w: 640, h: 480, label: 'Google file' };
  }
  if (host.endsWith('figma.com') && /^\/(file|design|proto|board)\//.test(path)) {
    return { type: 'embed', provider: 'Figma', url: u.href, embed: `https://www.figma.com/embed?embed_host=architect&url=${encodeURIComponent(u.href)}`, w: 640, h: 450, label: 'Figma file' };
  }
  if (/^google\.[a-z.]+$/.test(host) && path.startsWith('/maps')) {
    const place = (m = path.match(/\/maps\/(?:place|search)\/([^/]+)/)) ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : u.searchParams.get('q');
    if (place) return { type: 'embed', provider: 'Google Maps', url: u.href, embed: `https://www.google.com/maps?output=embed&q=${encodeURIComponent(place)}`, w: 560, h: 400, label: 'Map' };
  }
  return { type: 'link', url: u.href, host, label: 'Link' };
}

// A paste that is "just a link" (a bare address, or a link with a few words around it).
export function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const url = extractUrl(t);
  if (!url) return false;
  const rest = t.replace(/https?:\/\/[^\s<>"'`]+/i, '').trim();
  return rest.length <= 40 && !rest.includes('\n');
}

// Title / description / picture for a link card, from a public preview service (no account needed).
const unfurlCache = new Map();
export async function unfurl(url) {
  if (unfurlCache.has(url)) return unfurlCache.get(url);
  const job = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = await r.json();
      const d = j?.data;
      if (!d) return null;
      const clip = (x, n) => (x ? String(x).replace(/\s+/g, ' ').trim().slice(0, n) : '');
      return {
        title: clip(d.title, 140), desc: clip(d.description, 220),
        image: d.image?.url && /^https:/.test(d.image.url) ? d.image.url : '',
        logo: d.logo?.url && /^https:/.test(d.logo.url) ? d.logo.url : '',
        site: clip(d.publisher, 60),
      };
    } catch { return null; }
  })();
  unfurlCache.set(url, job);
  return job;
}

export const faviconFor = (host) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
