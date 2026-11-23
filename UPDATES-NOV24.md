# Architect — Nov 24 update

Source: *Architect Systems Blueprint* ("Updates / Fixes" board, second batch).

## Run once (Supabase SQL editor)
1. `supabase/nov24.sql` — Updates & Fixes runs (Push Update / Schedule) and shared Spotify playlists.
2. `supabase/nov24-anytype.sql` — Anytype ⇄ Path two-way sync (after `anytype.sql`).

Both are safe to re-run. On the PC: update the connector folder (`connector/`) and restart it
(`install-windows.ps1` again, or reboot) — it's v1.1.0. For Push Update, set up the runner once (`runner/README.md`).

## 1. My View — arrange and lock your layout
No top bar. A new view is a blank dot grid with a visible border. Right-click (or the + in the corner) to add any
object; drag it by its header, resize it from its corner. Fixed scale: no pan, zoom or growing past the border.
Lock / unlock with the padlock in the corner (or right-click the view's rail icon). Positions are fractions of the
workspace, so a layout keeps its shape on any window size; views saved before are converted once.
*js/space/sidebar.js*

## 2. Story — right-click drag pans
Hold the right mouse button and drag to pan in any direction. Scroll still works; a right-click that doesn't move
still opens the menu (on Windows the menu arrives after the button comes up; on macOS it's replayed if you didn't
drag). *js/space/fleeting.js*

## 3 + 6. Backgrounds — Personal Space and Shared Space
Settings → **Personalize**: square grid (crossed lines), dotted grid, graph paper, plain, or your PNG as **Fill**
or **Tile** (with a size control). Patterns and tiles follow the canvas as it pans and zooms. Saved in your prefs
(`spaceBg`), so the Shared Space background is yours alone — everyone keeps their own. The old `personalBg` still
counts until you pick something. *js/space/backgrounds.js, js/views/settings.js, js/views/space.js*

## 4. Updates & Fixes in Settings
The Updates tab is now a canvas of update notes (yellow = to build, green = shipped) and linked previews (paste a
screenshot, or + Preview; drag a note's right-edge dot onto a preview to link it). Select a note → **Push Update**
(now) or **Schedule** (later). Runs live in `architect_update_runs`; the **runner** on your PC (`runner/`, hidden,
no windows or focus stealing) picks them up, resumes the note's Claude session (or the one you linked with
`--session`) or starts fresh with the note, its previews and a `git pull`, reports the step / status / time left,
stops as **Blocked** with a question you answer in the panel, and writes the tested result on the note. Cancel any
time. The Catalogue and custom CSS / JS fold away under the canvas. *js/views/updates.js, runner/*

## 5. Anytype ⇄ Path — both ways
- Check / uncheck, rename (click the title), add (a Set-Point fed by Anytype sends new tasks to Anytype — toggle in
  the path's ··· → "New tasks go to Anytype") and **Delete from both** (with a confirm) are queued in `anytype_ops`
  and applied by the connector within ~20 s, then the mapping is re-read so both sides match — no duplicates.
- Anytype's own checkbox comes back with every import (`fields.done` + `done_at`); the newer side wins, per
  Architect day.
- Linked items' menu: Rename · **Remove from Path** (hidden here only — not deleted in Anytype, mapping untouched,
  stays hidden after syncs and reloads; restore in Settings → Integrations) · Open in Anytype · Sync now (asks the PC
  to sync now) · Anytype settings · Delete from both.
- Page sections are edited through Anytype's markdown body (a copy of the page is saved in the connector's
  `backups/` first, and every edit is read back to confirm it took); collections through object properties
  (`done`, `name`), new items are created as Tasks and added to the collection.
- **Note:** a page-section edit rewrites that page's body, so Anytype gives its blocks new ids — the items in that
  section come back as fresh imports (their Anytype checkbox state carries over). Unlinked Path items and daily goals
  are never touched.
- Gates: `connector/test/e2e.mjs` 25/25 with the new SQL; `connector/test/twoway.mjs` 14/14.

## 7. Blueprint window — one header
The window's own title bar is gone; the Blueprint header (name + save status) is the only header. Drag the window
by it (double-click → full screen). Full screen and close are at the header's right end and in ···; Ctrl+Esc still
closes. *js/space/window.js, js/board/board.js*

## 8. Variables — sidebar editing and Shared Space parity
- Right-click space tabs, subsections and chats: rename in place, Color…, add, Move to, delete, Undo.
- A subsection's **+** adds a chat directly into it; NEW CHAT is an inline field (no pop-up).
- Drag chats to reorder — a line shows exactly where it lands; drop on a subsection to move it in.
- Spaces shared with you: same controls, menus and Free View (`sharedSource` in *js/data/varshare.js*). Members'
  edits go into the shared row; the owner's sync merges three ways (yours / theirs / last synced) — one-sided
  changes win, the owner wins a tie.
- The map shows each subsection's variables in place, without opening it.
- Top tabs spaced farther apart; the duplicate title row under them is gone — Search, Free View and ··· are in the
  top bar.

## 9 + 10. Sidebar — icons only, no navigation highlight
No labels, no gold, no highlight when clicked. The open chat has a subtle neutral shadow in every theme.

## 11. Radio — Spotify playlists
Paste a Spotify playlist (♫ in the Radio header, or any Radio link box) → Personal or Shared. It plays in
Spotify's player for you alone; the live YouTube stream isn't touched and nobody else's Radio starts. Shared
playlists are `shared_items` rows (kind `spotify`) for the people in your Shared Space. *js/space/spotify.js*

## 12. Enter to talk — from any view
Enter anywhere (not while typing, not in a Blueprint) opens a small composer over the current view: type (read
aloud) or record a voice message. An open Variables chat (board or sidebar) is the destination; otherwise the
Voice chat. *js/space/saycomposer.js*

## 13. Variables — longer titles, Doto, colors, undo
Names up to 120 characters, wrapping instead of "…". Subsection names in Doto (sidebar + canvas). Color… on every
variable and subsection. Ctrl/⌘+Z / ⇧ or Ctrl+Y and **Undo** in the menus reverse Variables changes (renames,
colors, moves, resizes, reordering, Free View) without touching the Blueprint's undo. *js/data/myvars.js*

## 14. Organ chats → Variables
Right-click the Variables top bar → **New Organs space…** (name it). The Organ chats are its rows (drag to reorder,
right-click for rename / picture / **Sync with an Anytype object…** — picked from your Anytype connection's chats /
move / delete), with **Ideas** at the bottom. Same storage as before (your account or Anytype), private, never
shareable. The floating Side Chat launcher and panel are gone on desktop; phones keep the panel as a sheet from the
slider menu (with a close button).

## Files
New: `css/nov24.css`, `js/space/backgrounds.js`, `js/space/saycomposer.js`, `js/space/spotify.js`,
`js/views/updates.js`, `supabase/nov24.sql`, `supabase/nov24-anytype.sql`, `runner/*`,
`connector/test/twoway.mjs`, this file.
Changed: `index.html`, `sw.js`, `README.md`, `connector/architect-anytype.mjs`, `js/board/board.js`,
`js/data/anytype.js`, `js/data/catalogue.js`, `js/data/myvars.js`, `js/data/varshare.js`, `js/space/fleeting.js`,
`js/space/radio.js`, `js/space/sidebar.js`, `js/space/sidechat.js`, `js/space/variables.js`, `js/space/window.js`,
`js/views/integrations.js`, `js/views/paths.js`, `js/views/settings.js`, `js/views/shell.js`, `js/views/space.js`.

## Rollback
Each SQL file ends with its rollback. Front-end: re-upload the previous versions of the changed files.
