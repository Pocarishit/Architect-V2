// Turn a pasted URL into something a board can hold: a video/embed player, an image, or a link card.

function parseTime(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(v);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

export function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
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
  if (yt && /^[\w-]{6,}$/.test(yt)) {
    const t = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));
    return {
      type: 'embed', provider: 'YouTube', url: u.href,
      embed: `https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1${t ? `&start=${t}` : ''}`,
      w: shorts ? 315 : 640, h: shorts ? 560 : 360, label: shorts ? 'YouTube Short' : 'YouTube video',
    };
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

export function looksLikeUrl(text) {
  const t = String(text || '').trim();
  return /^https?:\/\/\S+$/i.test(t);
}
