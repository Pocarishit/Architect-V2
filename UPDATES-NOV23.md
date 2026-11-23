# Architect — Nov 23 update

Source: *Architect Systems Blueprint* + the Anytype and Miro upgrade runbooks.

## 1. Desktop sidebar
A rail on the left of the Space (desktop only; phones keep their own interface).
- **ARCHITECT** opens the full Space (pan and zoom as usual).
- **VARIABLES**: pick a category from the top row and one of its chats on the left. The main pane is that chat as a standard Variables chat. **Variables map** (bottom left) opens the category map in a compact view or full screen. Each category has its own cover (⋯ → Add a cover). **SHARED / PRIVATE** shares it with the people in your shared Space.
- **PATH**: your Path on the left, Fleeting Moments on the right.
- **MORE**: Settings, Profile, Custom.
- **Custom** makes your own sidebar view. Use ADD OBJECT to pick what's in it. The objects sit in a fixed layout (no pan or zoom). Each object's ⋯ menu has Rename, Hide title, Hide header, Wider and Remove. In EDIT mode you can drag objects to reorder them. Right-click a view in the rail to rename or delete it.
- To hide the sidebar: Space menu → Show sidebar.

**Shared categories need one SQL run:** `supabase/nov23.sql`. Without it, the Share button shows a message telling you to run it.

## 2. One task, two views (Anytype runbook)
- Right-click a Path task → **Put on the board**. In any board you can also use right-click → **Add a Path task…**.
- The board stores only `{ type: 'task', taskId, x, y, w, h }`. Title, done, setpoint and date are read live from the task, so ticking the task, moving its date or changing its setpoint on either side updates both views.
- **Offline**: the app shell is cached on the device (`sw.js`), and Supabase reads are cached on the device (`js/data/offline.js`). Path and Blueprint edits made offline are saved on the device and replayed when the connection is back. A status pill shows "Offline · N changes saved on this device", then "Syncing…".
- **Conflict rule**:
  - *Path tasks*: per field, the last device to reconnect wins. Only the fields you changed are sent, so if one device ticks a task and another moves its date, both changes survive.
  - *Blueprints*: per object, three-way. Objects you changed offline take your version. Objects you didn't touch keep the server's version, so other people's edits aren't wiped.
- **Privacy**: Side Chat is never put in any shared payload. A shared category contains only that category's chats (tested).

## 3. Crowded-board benchmark (Miro runbook)
- Space menu → **Performance test (500 objects)**. It builds a disposable board with 500 objects. Each gesture (pan, zoom centred on the cursor, dragging a group of 50) gets a warm-up run and then 3 measured runs. You get p95 frame time and dropped frames, compared with your last run. The board is deleted afterwards.
- **Bottleneck found**: every zoom step changed `--iz` on the viewport. Every object on the board inherits that value, so all 500 were restyled on every frame.
- **Fix**: while the view moves, only the selection overlay gets `--iz`. The board's own badges and frame titles update when the view stops (`editor.js`, `applyCamera` / `settleCamera`).
- **Before → after** (headless Chrome, software rendering, same fixture, median of 3 runs over two sessions):
  - Zoom dropped frames: 60 → 26 and 75 → 38.
  - Style and layout time in zoom runs: 14–60 ms → 0–5 ms.
  - Pan and drag: unchanged.
  - p95 frame time is noisy without a GPU. Run the test on your PC for real numbers.
- **Checked after the fix**: selection handles keep their size while zooming, undo and redo work, a full reload keeps the board, switching Personal ↔ Shared works, and the phone layout works.

## Rollback
Every change is file-level:
- To roll back the sidebar: remove `js/space/sidebar.js` and the `mountSide` lines in `js/views/space.js`.
- To roll back offline: remove `withOffline(...)` in `js/data/api.js` and the service worker registration in `js/main.js`. Clearing site data removes the cached shell.
- To roll back the zoom fix: revert the two `--iz` hunks in `js/board/editor.js`.
