// Architect's app shell, cached on this device so Architect opens with no connection (Nov 23).
// Network first (you always get the newest deploy when online), the cached copy when offline or when the
// network hangs for more than 6 seconds. Supabase, R2 and other APIs are never touched here — your data's
// offline copy lives in js/data/offline.js.
const VERSION = 'architect-shell-2026-11-23b';
const SHELL = [
  "./",
  "assets/favicon.svg",
  "config.js",
  "css/app.css",
  "css/base.css",
  "css/board.css",
  "css/nov23b.css",
  "css/fleeting.css",
  "css/sections.css",
  "css/sidebar.css",
  "css/sidechat.css",
  "css/space.css",
  "css/tracker.css",
  "index.html",
  "js/board/bench.js",
  "js/board/board.js",
  "js/board/collab.js",
  "js/board/contextbar.js",
  "js/board/editor.js",
  "js/board/embed.js",
  "js/board/geometry.js",
  "js/board/palette.js",
  "js/board/pdf.js",
  "js/board/playback.js",
  "js/board/preview.js",
  "js/board/render.js",
  "js/board/richtext.js",
  "js/board/taskcard.js",
  "js/board/templates.js",
  "js/core/custom.js",
  "js/core/dom.js",
  "js/core/guard.js",
  "js/core/icons.js",
  "js/core/print.js",
  "js/core/router.js",
  "js/core/ui.js",
  "js/core/util.js",
  "js/data/anytype.js",
  "js/data/api.js",
  "js/data/catalogue.js",
  "js/data/ideapool.js",
  "js/data/local.js",
  "js/data/myvars.js",
  "js/data/offline.js",
  "js/data/prefs.js",
  "js/data/profile.js",
  "js/data/realtime.js",
  "js/data/releases.js",
  "js/data/setpoints.js",
  "js/data/shared.js",
  "js/data/supabase.js",
  "js/data/tasks.js",
  "js/main.js",
  "js/space/chat.js",
  "js/space/er.js",
  "js/space/fleeting.js",
  "js/space/freeview.js",
  "js/space/media.js",
  "js/space/mobile.js",
  "js/space/radio.js",
  "js/space/radiolinks.js",
  "js/space/sidebar.js",
  "js/space/sidechat.js",
  "js/space/timer.js",
  "js/space/tracker.js",
  "js/space/variables.js",
  "js/space/widgets.js",
  "js/space/window.js",
  "js/views/archive.js",
  "js/views/countdown.js",
  "js/views/integrations.js",
  "js/views/login.js",
  "js/views/meter.js",
  "js/views/parasites.js",
  "js/views/paths.js",
  "js/views/settings.js",
  "js/views/shell.js",
  "js/views/space.js",
  "js/views/tracker.js"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('architect-shell-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !FONTS.test(req.url)) return; // APIs and media: straight to the network
  if (same && url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? new Request('./') : req;
    try {
      const res = await Promise.race([fetch(req), timeout(6000)]);
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      throw err;
    }
  })());
});
