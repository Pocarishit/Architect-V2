# Architect — Local API

Your own scripts (Raycast, Shortcuts, cron jobs, a terminal) can read and write the Space with a personal token.

1. Run `supabase/space.sql` once (and `supabase/nov12.sql` for updates + rollback).
2. In the Space: right-click → **Settings & API…** → **API** → name it → **Generate**. Copy the token (`arch_…`) — it's shown once. Only its SHA-256 hash is stored. Revoke any time.

## Calling it

One endpoint, one JSON body:

```bash
curl -X POST 'https://YOUR-PROJECT.supabase.co/rest/v1/rpc/architect_api' \
  -H 'apikey: YOUR_PUBLISHABLE_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"token":"arch_…","action":"whoami","payload":{}}'
```

The token acts as you. Canvas changes show up in open apps within ~15 seconds.

## Actions

| action | payload | does |
|---|---|---|
| `whoami` | — | your id, username, Space id |
| `objects.list` | — | every object on the Space canvas |
| `objects.add` | `{ "element": { "type": "sticky", "x": 0, "y": 0, "w": 200, "h": 200, "text": "Hi" } }` | add an object (id generated if missing) |
| `objects.update` | `{ "id": "…", "patch": { "x": 100 } }` | change an object |
| `objects.remove` | `{ "id": "…" }` | delete an object |
| `widgets.spawn` | `{ "title": "Clock", "html": "<b>…</b>", "x": 0, "y": 0, "w": 420, "h": 320 }` | custom widget (sandboxed HTML/JS) |
| `columns.list` | — | your Path columns |
| `tasks.list` | `{ "column_id"? }` | your Path tasks |
| `tasks.add` | `{ "column": "Morning" \| "column_id": "…", "title": "Ship #12", "note"?, "done"?, "private"?, "day"?: "2026-11-14" }` | add a task (`#12` links ticket #012; `day` plans it for that day's tab) |
| `tasks.update` | `{ "id": "…", "patch": { "done": true, "day"?: "2026-11-14" \| null } }` | change a task (`day: null` puts it on today's path) |
| `tasks.remove` | `{ "id": "…" }` | delete a task |
| `tickets.list` | — | tickets you can see |
| `tickets.add` | `{ "title": "…", "detail"?, "deadline"?, "labels"? }` | open a ticket |
| `tickets.update` | `{ "no": 12 \| "id": "…", "patch": { "status": "testing" } }` | change a ticket |
| `tickets.message` | `{ "no": 12, "body": "…" }` | post in a ticket's thread |
| `attempts.log` | `{ "no": 12, "outcome": "failed" \| "partial" \| "worked", "body": "…" }` | log an attempt (counts on the Tracker) |
| `attempts.list` | `{ "since"?, "until"? }` | your attempts |
| `style.get` | — | your custom CSS, JS and safe-mode flag |
| `style.set` | `{ "css": "…" }` | custom CSS theme |
| `script.set` | `{ "js": "…" }` | custom JS hotfix (runs on load with `architect = { api, toast }`) |
| `safe_mode.set` | `{ "on": true }` | switch custom CSS + JS off |
| `updates.push` | `{ "css"?: "…", "js"?: "…", "note"?: "fix the dock" }` | push an update — becomes the next version (v1, v2…) and goes live |
| `updates.list` | — | every version (number, note, when, size) and which one is live |
| `updates.current` | — | the live version's CSS + JS |
| `updates.rollback` | `{ "version"?: 3 }` | go back to that version (default: the one before the live one) |

## Updates and rollback

Every `updates.push` (and every `style.set` / `script.set`) is saved as a numbered version. The first one also keeps a **v0** snapshot of what you had before, so there's always a way back. The last 30 versions are kept.

```bash
# push a fix
… -d '{"token":"arch_…","action":"updates.push","payload":{"js":"architect.toast(\"hi\")","note":"say hi"}}'
# something broke? go back one version
… -d '{"token":"arch_…","action":"updates.rollback","payload":{}}'
```

The same history is in the app: right-click → **Settings & API… → Updates** — push, see every version, roll back or restore with one click. If a pushed script throws when the app loads, a toast offers **Roll back to vN** right there. From a custom script or the browser console: `architect.update({ css, js, note })`, `architect.rollback()`.

## Safe mode

If a custom script breaks the app, open it with `?safe` in the address (e.g. `https://your-app.vercel.app/?safe`) — custom CSS and JS are skipped — then fix or clear them in **Settings → Customize**, or call `safe_mode.set`.

Custom CSS/JS only ever applies to your own account. Treat the token like a password: whoever has it can change your Space and run script in your app.
