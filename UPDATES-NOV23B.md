# Architect — Nov 23b update

Source: *Architect Systems Blueprint* ("Updates / Fixes" board) + *Anytype sync for Architect* runbook.

## Run once
- `supabase/anytype.sql` in the Supabase SQL editor (only needed for Anytype sync; safe to re-run).

## 1. Slimmer desktop sidebar
`--sb-w: 72px`. Architect, Variables, Path and More use simple line icons with the label underneath. No hover
highlight; the current view alone is amber (text, icon, a 2px line at the left edge). *css/nov23b.css, js/space/sidebar.js*

## 2. Variables tabs use the Path day-tab font
Space Mono 11px, regular, uppercase, .04em — the same as TODAY / TUESDAY. Title, order and selection styling unchanged.

## 3. Variables — desktop spaces, chats and map
- The chat sidebar's header is the active space's name in Doto; the chevron switches spaces (and holds the
  space's options); the button beside it hides/reopens the sidebar.
- Space tiles stay across the top; the + is gone — right-click the top bar → **New space…**.
- **Find a chat** removed; **New chat** stays (top of the list).
- The map is a plain dotted square at the bottom of the sidebar. Opening it shows the space's field: its name
  faint in Doto at the centre, subsections/variables as regular tiles around it, no tabs or other spaces.
  Full screen sits beside the close X on the canvas. Opening a variable there opens its chat in the main pane.

## 4. Personal background, a shorter right-click menu, Settings
- **Settings → General → Personal Space background**: upload a PNG; only the personal Space uses it (`personalBg` pref).
- Right-click menu: no "Add" heading/fold, one **Border** tool (⇧B still draws a curve), Chat / Radio / Timer /
  Path task / Say something out loud / Emergency Room are under **Widget…**, "Move around" removed.
- "Settings & API…" → **Settings…**. Theme, Performance test, Keyboard shortcuts, camera points and Snap moved to
  Settings → General.
- **Show toolbar** fixed: it always toggles the toolbar (every Space), and the toolbar sits clear of the rail.
- Settings → **Updates** is now the Updates Catalogue (searchable, *js/data/catalogue.js*); custom CSS/JS and its
  version history are under "Custom CSS & JS" in the same tab.
- Fix: picking a widget now closes the Add-a-widget dialog.

## 5. Path — adaptive layout + per-object zoom
- In the sidebar's Path view, Path lays its setpoints out to fit the pane: 4 across, 2 × 2, or 1 column.
- Each object in a view has its own zoom (hover → bottom-right control): −/+, presets, **Auto Fit**, **Lock**.
  Ctrl/⌘ + wheel over an object zooms only that object. Saved per object (`sbZoom` pref).
- Drag the gutter between Path and Fleeting Moments to resize (double-click resets; `sbSplit` pref).

## 6. Radio plays links beyond YouTube
X, Threads, TikTok, Instagram, Facebook, Vimeo, Dailymotion, Twitch, Kick, Streamable, Reddit, SoundCloud,
Spotify and direct video files play in their platform's own embed player, fitted to the panel (vertical, wide or
post). Short links, profiles and stories explain why they can't play. A player that never loads — or loads but
never responds (private/removed/blocked) — shows the reason with **Open original**; "Open original" is also on
hover. YouTube items keep the live shared stream; other links sync which item is on. *js/space/radiolinks.js*

## 7. Anytype → Path sync (beta, off by default)
Implementation notes required by the runbook:

- **Backend actually used:** Supabase (this repo's live backend; no Firebase). Tables + RPCs in
  `supabase/anytype.sql`: `anytype_connectors`, `anytype_pairing`, `anytype_mappings`, `anytype_items`,
  `anytype_runs`, `anytype_checks`. RLS owner-only; column grants limit the app to pause/resume/revoke/delete.
- **Connector auth:** the signed-in app issues a 10-minute single-use code (`anytype_pair_start`); the connector
  trades it for its own revocable token (`anytype_pair_finish`), stored in Windows DPAPI. Connector RPCs only:
  save mappings for its owner (Path destinations they own), publish imports for enabled/current mappings, report
  status. No service keys on clients, no secrets in URLs.
- **Publishing:** one transaction per read, advisory-locked per mapping; deterministic keys
  (mapping + space + object + block, never text); field allowlist enforced server-side; changed fingerprints
  only; archive after a complete read; stale versions and paused mappings rejected; 500-item cap.
- **App:** imports show in their Set-Point column (ANYTYPE tag), undated = every day. Checkmarks are Architect's,
  per Architect day (Second Wind rules included), saved on the device first and synced (last write wins),
  shown as pending until confirmed. Last-good snapshot cached on the device. Status line: Last imported /
  Waiting for desktop / specific error. *js/data/anytype.js, js/views/paths.js, js/views/integrations.js*
- **Connector:** `connector/` (Node 18+, no dependencies) — pairing, Anytype grant, local mapping editor with
  preview (127.0.0.1 only, host/origin/session-checked), background sync (startup, timer, Sync now, resume),
  backoff, scheduled task installer, `inspect` smoke test. See `connector/README.md`.
- **Release gates run (connector/test):** 25/25 e2e checks and the SQL gates pass against a mock Anytype with v2
  shapes and the real SQL in Postgres 16. Not yet verified against your real Anytype: block `type` names in v2
  (the parser accepts h1–h6 / header / heading and bullet / checkbox / numbered) — run
  `node architect-anytype.mjs inspect --object <GM page id> --ids` first and check the headings it lists. Also
  still to do on real devices: the GM-over-cellular gate and the Second Wind boundary check.
- **Scope in this release:** Path Set-Point adapter only. Variables-subsection and Story adapters are refused by
  the server (`adapter_disabled`) until they pass the same gates.
- **Rollback:** turn off Settings → Integrations → Anytype imports (hides everything instantly), or pause/delete
  mappings; uninstall the task + `forget` on the PC; full removal SQL is at the end of `supabase/anytype.sql`.
  Native Path tasks and goals are never touched.

## Files
New: `css/nov23b.css`, `js/data/anytype.js`, `js/data/catalogue.js`, `js/space/radiolinks.js`,
`js/views/integrations.js`, `supabase/anytype.sql`, `connector/*`, this file.
Changed: `index.html`, `sw.js`, `README.md`, `js/core/icons.js`, `js/space/sidebar.js`, `js/space/variables.js`,
`js/space/radio.js`, `js/views/space.js`, `js/views/settings.js`, `js/views/paths.js`.
