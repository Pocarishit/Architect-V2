// Minimal Supabase client over the REST APIs (Auth, PostgREST, Storage). No SDK needed.
import { AppError, uid, store } from '../core/util.js';
import { createSupabaseRealtime } from './realtime.js';

const SESSION_KEY = 'architect.sb.session';

export function createSupabaseBackend(cfg) {
  const base = String(cfg.supabaseUrl).trim().replace(/\/+$/, '');
  const key = String(cfg.supabaseKey).trim();
  const bucket = cfg.mediaBucket || 'architect-media';
  // New media goes to Cloudflare R2 through your media Worker when one is set in config.js (Nov 22).
  // Its paths start with "r2/"; everything uploaded before keeps working from Supabase Storage.
  const r2 = String(cfg.mediaWorker || '').trim().replace(/\/+$/, '');
  const r2Url = (path) => `${r2 || ''}/f/${path.slice(3).split('/').map(encodeURIComponent).join('/')}`;
  const domain = (cfg.authDomain || 'architect.local').replace(/^@/, '');

  let session = store.get(SESSION_KEY);
  const listeners = new Set();
  let refreshing = null;

  const usernameOf = (u) => u?.user_metadata?.username || String(u?.email || '').split('@')[0];
  const current = () => (session?.user ? { user: { id: session.user.id, username: usernameOf(session.user) } } : null);
  const emit = () => { const s = current(); listeners.forEach((fn) => fn(s)); };

  function setSession(next, { silent = false } = {}) {
    if (next && next.access_token) {
      // Nov 26: expiry is counted on this device's clock (from expires_in), so a PC clock that's off
      // can't make a token look fresh after it has really expired.
      if (next.expires_in) next.expires_at = Math.floor(Date.now() / 1000) + next.expires_in;
      else if (!next.expires_at) next.expires_at = Math.floor(Date.now() / 1000) + 3600;
      session = { access_token: next.access_token, refresh_token: next.refresh_token, expires_at: next.expires_at, user: next.user || session?.user };
    } else {
      session = null;
    }
    store.set(SESSION_KEY, session);
    if (!silent) emit();
  }

  // Keep tabs in sync (another tab may rotate the refresh token).
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY) return;
    const was = !!session;
    try { session = e.newValue ? JSON.parse(e.newValue) : null; } catch { session = null; }
    if (was !== !!session) emit();
  });

  async function refresh() {
    if (!session?.refresh_token) return false;
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetch(`${base}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { apikey: key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data?.access_token) { setSession(data, { silent: true }); return true; }
          if (res.status >= 400 && res.status < 500) setSession(null);
          return false;
        } catch {
          return false;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  async function ensureFresh() {
    if (session && session.expires_at - Date.now() / 1000 < 90) await refresh();
  }

  async function call(url, { method = 'GET', body, headers = {}, auth = true, retry = true, keepalive = false } = {}) {
    if (auth) {
      await ensureFresh();
      if (!session) throw new AppError('You are signed out. Sign in again.', 'signed_out', 401);
    }
    const hdr = { apikey: key, ...headers };
    if (auth && session) hdr.Authorization = `Bearer ${session.access_token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof Blob)) {
      hdr['Content-Type'] = hdr['Content-Type'] || 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers: hdr, body: payload, keepalive });
    } catch {
      throw new AppError('Can’t reach Supabase. Check your connection.', 'network');
    }
    if (res.status === 401 && auth && retry) {
      const ok = await refresh();
      if (ok) return call(url, { method, body, headers, auth, retry: false, keepalive });
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.msg || data.message || data.error_description || data.error)) || res.statusText || `HTTP ${res.status}`;
      const code = data && typeof data === 'object' ? (data.error_code || data.code || null) : null;
      throw new AppError(String(msg), code ? String(code) : null, res.status);
    }
    return data;
  }

  const emailOf = (username) => `${username}@${domain}`;
  const rest = (path, opts) => call(`${base}/rest/v1/${path}`, opts);
  const q = (params) => new URLSearchParams(params).toString();

  const backend = {
    mode: 'supabase',

    auth: {
      async init() {
        if (session && session.expires_at - Date.now() / 1000 < 90) await refresh();
        return current();
      },
      current,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async signIn(username, password) {
        const data = await call(`${base}/auth/v1/token?grant_type=password`, {
          method: 'POST', auth: false, body: { email: emailOf(username), password },
        });
        setSession(data, { silent: true });
        return current();
      },
      async signUp(username, password) {
        const data = await call(`${base}/auth/v1/signup`, {
          method: 'POST', auth: false, body: { email: emailOf(username), password, data: { username } },
        });
        if (data?.access_token) { setSession(data, { silent: true }); return current(); }
        throw new AppError('confirm_required', 'confirm_required');
      },
      async signOut() {
        try { if (session) await call(`${base}/auth/v1/logout`, { method: 'POST', retry: false }); } catch {}
        setSession(null);
      },
      async changePassword(password) {
        await call(`${base}/auth/v1/user`, { method: 'PUT', body: { password } });
      },
    },

    db: {
      async select(table, { columns = '*', order, filters = {}, limit } = {}) {
        const params = { select: columns };
        if (order) params.order = order;
        if (limit) params.limit = String(limit);
        for (const [k, v] of Object.entries(filters)) params[k] = v === null ? 'is.null' : Array.isArray(v) ? `in.(${v.join(',')})` : v && typeof v === 'object' && 'gt' in v ? `gt.${v.gt}` : `eq.${v}`;
        return (await rest(`${table}?${q(params)}`)) || [];
      },
      async get(table, id, columns = '*') {
        const rows = await rest(`${table}?${q({ select: columns, id: `eq.${id}` })}`);
        return rows?.[0] || null;
      },
      async insert(table, rows) {
        const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, user_id: session?.user?.id }));
        const out = await rest(table, { method: 'POST', body: list, headers: { Prefer: 'return=representation' } });
        return Array.isArray(rows) ? out : out?.[0];
      },
      async update(table, id, patch, { keepalive = false } = {}) {
        await rest(`${table}?${q({ id: `eq.${id}` })}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=minimal' }, keepalive });
        return true;
      },
      async removeWhere(table, filters) {
        const params = {};
        for (const [k, v] of Object.entries(filters)) params[k] = `eq.${v}`;
        await rest(`${table}?${q(params)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      },
      async remove(table, ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        if (!list.length) return;
        await rest(`${table}?${q({ id: `in.(${list.join(',')})` })}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      },
    },

    // Postgres functions (sharing).
    async rpc(name, args = {}) {
      return rest(`rpc/${name}`, { method: 'POST', body: args });
    },

    live: createSupabaseRealtime({
      base, key,
      token: async ({ force = false } = {}) => { if (force) await refresh(); else await ensureFresh(); return session?.access_token || null; },
    }),

    media: {
      maxBytes: 50 * 1024 * 1024,
      async upload(file) {
        const ext = (String(file.name || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
        if (r2) {
          await ensureFresh();
          if (!session) throw new AppError('You are signed out. Sign in again.', 'signed_out', 401);
          let res;
          try {
            res = await fetch(`${r2}/upload?ext=${ext}`, {
              method: 'PUT', body: file,
              headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': file.type || 'application/octet-stream' },
            });
          } catch { throw new AppError('Can’t reach the media server. Check your connection.', 'network'); }
          if (!res.ok) throw new AppError((await res.text().catch(() => '')) || `Upload failed (${res.status}).`, 'upload', res.status);
          const { key: k } = await res.json();
          const path = `r2/${k}`;
          return { path, url: r2Url(path) };
        }
        const path = `${session.user.id}/${uid()}.${ext}`;
        await call(`${base}/storage/v1/object/${bucket}/${path}`, {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'max-age=31536000, immutable' },
        });
        const urls = await backend.media.sign([path]);
        return { path, url: urls[path] };
      },
      // Egress (Nov 22): a signed link is kept on this device until a day before it expires. The same
      // link every visit means the browser serves photos, videos and voice notes from its own cache
      // instead of downloading them from Supabase again on every reload.
      async sign(paths) {
        const all = [...new Set(paths)].filter(Boolean);
        if (!all.length) return {};
        const KEY = 'architect.sb.signed';
        const now = Date.now();
        const kept = store.get(KEY, {}) || {};
        const map = {};
        const list = [];
        for (const p of all) {
          if (p.startsWith('r2/')) { map[p] = r2Url(p); continue; } // R2 links don't need signing
          const k = kept[p];
          if (k?.url && k.exp - now > 86_400_000) map[p] = k.url; else list.push(p);
        }
        if (list.length) {
          const res = await call(`${base}/storage/v1/object/sign/${bucket}`, {
            method: 'POST', body: { expiresIn: 60 * 60 * 24 * 7, paths: list },
          });
          for (const r of Array.isArray(res) ? res : []) {
            if (r?.signedURL && r.path) {
              map[r.path] = encodeURI(`${base}/storage/v1${r.signedURL}`);
              kept[r.path] = { url: map[r.path], exp: now + 7 * 86_400_000 };
            }
          }
          // keep the list tidy: drop expired links, cap the size
          for (const [p, k] of Object.entries(kept)) if (!k?.exp || k.exp < now) delete kept[p];
          const keys = Object.keys(kept);
          if (keys.length > 3000) keys.sort((a, b) => kept[a].exp - kept[b].exp).slice(0, keys.length - 3000).forEach((p) => delete kept[p]);
          try { store.set(KEY, kept); } catch {}
        }
        return map;
      },
    },
  };
  return backend;
}
