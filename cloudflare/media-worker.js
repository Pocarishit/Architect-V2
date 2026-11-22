// Architect media on Cloudflare R2 (Nov 22).
// Paste this whole file into a Cloudflare Worker. It stores new photos, videos and voice notes in your
// R2 bucket and serves them back. R2 has no egress fees, so media no longer counts against Supabase.
//
// Worker settings (Cloudflare dashboard → your Worker → Settings):
//   Bindings  → R2 bucket   variable name: MEDIA          bucket: architect-media
//   Variables → SUPABASE_URL    = https://YOUR-PROJECT.supabase.co
//               SUPABASE_KEY    = your publishable / anon key (same one as in config.js)
//               ALLOWED_ORIGIN  = https://architect-compass.vercel.app   (comma-separate more sites)
//
// Routes:
//   PUT    /upload?ext=jpg   body = the file      header Authorization: Bearer <Supabase session token>
//   GET    /f/<key>          the file (supports Range, so videos can seek)
//   DELETE /f/<key>          your own files only
//
// Who can do what: only signed-in Architect users can upload (the token is checked with Supabase).
// Files are read by their link; every link contains a random id nobody can guess.

const MAX_BYTES = 100 * 1024 * 1024;
const users = new Map(); // token → { id, until } — so a burst of uploads checks Supabase once

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (req.method === 'PUT' && url.pathname === '/upload') return await upload(req, env, url, cors);
      if (url.pathname.startsWith('/f/')) {
        const key = decodeURIComponent(url.pathname.slice(3));
        if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(key)) return text('Not found', 404, cors);
        if (req.method === 'GET' || req.method === 'HEAD') return await serve(req, env, ctx, key, cors);
        if (req.method === 'DELETE') return await remove(req, env, key, cors);
      }
      if (url.pathname === '/') return text('Architect media is running.', 200, cors);
      return text('Not found', 404, cors);
    } catch (e) {
      return text(`Error: ${e?.message || e}`, 500, cors);
    }
  },
};

async function upload(req, env, url, cors) {
  const user = await whoIs(req, env);
  if (!user) return text('Sign in to upload.', 401, cors);
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return text('File is too large (100 MB max).', 413, cors);
  const ext = String(url.searchParams.get('ext') || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const key = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const type = req.headers.get('content-type') || 'application/octet-stream';
  await env.MEDIA.put(key, req.body, {
    httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { by: user.id },
  });
  return json({ key }, 200, cors);
}

async function serve(req, env, ctx, key, cors) {
  const range = req.headers.get('range');
  // Whole-file requests are kept in Cloudflare's edge cache, so popular files barely touch R2.
  const cache = caches.default;
  const cacheKey = new Request(new URL(req.url).toString(), { method: 'GET' });
  if (!range && req.method === 'GET') {
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);
  }
  const obj = await env.MEDIA.get(key, range ? { range: req.headers } : {});
  if (!obj) return text('Not found', 404, cors);
  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'public, max-age=31536000, immutable');
  if (range && obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? (obj.size - start);
    h.set('content-range', `bytes ${start}-${start + length - 1}/${obj.size}`);
    h.set('content-length', String(length));
    return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  const res = new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
  if (req.method === 'GET') ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function remove(req, env, key, cors) {
  const user = await whoIs(req, env);
  if (!user) return text('Sign in first.', 401, cors);
  if (!key.startsWith(`${user.id}/`)) return text('Not yours.', 403, cors);
  await env.MEDIA.delete(key);
  await caches.default.delete(new Request(new URL(req.url).toString(), { method: 'GET' }));
  return json({ ok: true }, 200, cors);
}

// Ask Supabase whose token this is (cached for 5 minutes).
async function whoIs(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const kept = users.get(token);
  if (kept && kept.until > Date.now()) return kept;
  const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u?.id) return null;
  const user = { id: u.id, until: Date.now() + 5 * 60_000 };
  users.set(token, user);
  if (users.size > 500) users.delete(users.keys().next().value);
  return user;
}

function corsHeaders(req, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'access-control-allow-origin': ok,
    'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, range',
    'access-control-expose-headers': 'content-length, content-range, etag',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
function withCors(res, cors) { const r = new Response(res.body, res); for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; }
const text = (s, status, cors) => new Response(s, { status, headers: { ...cors, 'content-type': 'text/plain; charset=utf-8' } });
const json = (o, status, cors) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });
