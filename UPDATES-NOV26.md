# Architect — Nov 26 update (Architect SYSTEM Updates — HQ)

Copy every file in this folder into the repo at the same paths, commit and push. Vercel redeploys.
`config.js` is not included; keep yours. The service worker version is now `architect-shell-2026-11-26`.

## New files
- `css/nov26.css`: sidebar icons and look, map card, zones, cubes, Library and Present
- `js/space/zones.js`: zone sections, Zone Cubes, Library map, Open Here, Present (TTS), Export
- `js/data/clock.js`: server-time offset for the shared timer
- `js/data/realtime.js`, `js/data/supabase.js`: changed (item 18) — supabase.js includes the Nov 22 R2 media changes

## What's in it
| # | Item | Where |
|---|------|-------|
| 1 | Fleeting zoom scales cards, text, timestamps, markers and spine; the time scale doesn't change | fleeting.js |
| 2 | Shared Story: both people use the same pool (deterministic choice); moments written before it was ready are moved in; private Moments stay private | ideapool.js, fleeting.js |
| 3 | Variables map card is the real map, scaled down, with no badge or frame; expand icon kept | sidebar.js, variables.js |
| 4 | Timer: corrects device clock skew (server Date header); remote start, pause, resume and reset repaint immediately | clock.js, timer.js |
| 5 | Delete space in each space's menu, with a named confirmation ("for everyone" when shared); persists across reloads | sidebar.js, myvars.js |
| 6 | Zones: Zone tool (Z); members protected from move, edit and delete (batch actions too) but still copyable; rename, recolor, resize, remove, Present, Export | freeview.js, variables.js |
| 7 | Capture Zone → Zone Cube: the content moves into the chat's Library; Open Here overlay; Copy then "Paste section" on a canvas; Copy or Move to another chat; Export (HTML); Present with an editable, saved order (pause, replay, previous, next) | zones.js |
| 8 | Embed in chat: view-only outlined zone; Edit Mode drags the outline; Return to Library | freeview.js |
| 9 | Library is a map canvas (pan, zoom, arrange; the arrangement is saved); each cube shows its name, color and a miniature | zones.js |
| 10 | Free View zoom no longer moves objects (the wall doesn't depend on zoom) | freeview.js |
| 11 | Inside a Variables object, right-drag pans its canvas and middle-drag pans the workspace; a plain right-click still opens the menu | variables.js, freeview.js, editor.js |
| 12 | Locked objects: right-drag and single right-click don't select; a double right-click on the border does, and the object stays locked | editor.js |
| 13 | Mobile Variables: the Ideas side chat, its tab and its button are removed (no data deleted; desktop unchanged) | sidechat.js, mobile.js |
| 14 | Sidebar icons: thinner and softer; the active icon gets a subtle accent | sidebar.js, nov26.css |
| 15 | Live cursors carry name and color on every move; they hide when the pointer leaves the canvas without marking the person offline; stale ones are cleared; `bye` on leave | collab.js, board.js |
| 16 | Free View toolbar follows the Blueprint's order, names and shortcuts, plus Zone (Z) and Library (B) | freeview.js |
| 17 | Settings → Personalize → Sidebar: color and PNG (choose, replace, remove), saved to your account | settings.js, sidebar.js |
| 18 | Fix "Token has expired" live-collab error: token pushed to the live channel every 30 s (was 4 min) and on tab focus/wake; an expired token refreshes and rejoins silently; expiry counted on the device clock; the collab.sql hint only shows for real permission errors | realtime.js, supabase.js, board.js |

## Not done / needs a check on the live site
- **Copy a cube to a Blueprint, or to another compatible object:** not built yet. You can copy and move cubes between chats, and export them.
- **Toolbar parity:** the Blueprint's Frame, Border, Add video/embed and Templates tools aren't in the chat canvas yet. Everything else matches.
- **Two-account checks:** live cursors, the shared Story, timer sync and deleting a shared space all depend on your Supabase realtime and permissions, and couldn't be run here. If cursors still don't show, hover the people pill; it now shows the realtime status and the reason.
- **Present voice:** uses the browser's built-in speech (`speechSynthesis`), so the voice depends on the device.
