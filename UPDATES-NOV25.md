# Architect — Nov 25 update

Source: *Architect Systems Blueprint* (Updates / Fixes board, third batch). Built on top of the live site as deployed on Nov 24.

Copy these files over your Architect folder (same paths), commit, and push. Vercel redeploys on its own. **No SQL to run.** `config.js` is not included, so your keys stay as they are.

## Variables
- **The map shows items right away.** The map always shows the space's chats and every subsection, nested ones included. It never shows the Free View layer, which is what left it as an empty dotted grid. It works the same in personal and shared spaces, and it refreshes when items are added, moved or deleted.
- **Map preview.** The square at the bottom of the sidebar draws the map as soon as the sidebar opens. Click it to open the map larger, or use the corner button for full screen.
- **Folding subsections and thumbnails.** Each subsection has a fold toggle, remembered on the device. A chat or subsection with an image shows it as a 20px thumbnail beside its name. Without an image there is no placeholder.
- **Shared spaces.**
  - Deletes are now tombstones. They are kept on your account (`architect_variables.data.gone`) and in the shared row, so they work across devices and across both people. Before, they were tracked per device in localStorage.
  - A member's edits now merge three ways against the latest shared copy. Before, they overwrote it, which dropped anything the owner added in the meantime.
  - A shared write that fails now retries.
  - People who joined your shared Space after you shared a category are now added to it. This was the bug where a category showed for one person and not the other.
- **Right-drag to pan.** You can hold the right button and drag from anywhere on an object to pan. The object's own menu no longer pops up after the drag. A plain right-click still opens the menu of whatever is under the pointer. Before, on macOS and Linux it opened the board's menu instead, because the board was holding the pointer.

## Board
- **Live cursors.**
  - Cursors are drawn above every object. Before, objects could cover them.
  - Your pointer is tracked at the window level, so widgets can't swallow it.
  - Your cursor is withdrawn when your pointer leaves the board, the tab is hidden, or the board is hidden behind your Personal Space or a sidebar view.
  - A peer's cursor goes as soon as they leave or disconnect.
- **Lock the frame, not the contents.**
  - A locked object can't be moved, resized or deleted.
  - You can still edit and format the text inside it.
  - Clicking inside a locked frame works like clicking the canvas.
  - Right-clicking an object's outer border, about 7px wide, opens the object menu with Lock and Unlock, even when its header is hidden or its inside has its own menu.
- **Updates & Fixes.**
  - The tab is now a regular Blueprint, `Architect SYSTEM Updates — HQ`, created once with its id kept in `prefs.updBoardId`. The notes from the old canvas move onto it.
  - Notes are sticky notes: yellow means to build, green means shipped. A picture connected to a note is that note's preview.
  - Push Update, Schedule and the run status are in the panel for the selected note.
  - The board's header has a full-screen button that opens the board as a full page.
- **Rail.**
  - Overview uses the dotted logo with the red dot, Variables an atom, and Path a compass.
  - More is pinned to the bottom of the rail.
  - The rail shows icons only.

## Fleeting Moments
- **Story only.** Weekly and the tab bar are removed (the Weekly code is still there, just not reachable).
- **Full screen.** The full-screen button keeps your scroll position and selection. Esc returns to the split view.
- **Set-Point labels.** The labels are 17–18px Doto, with faint hour marks.
- **Placing moments.**
  - A placement guide and a large clock show while you drag.
  - Moments snap to marks: Set-Points and quarter or half hours. Hold Alt to place a moment between marks.
  - Esc cancels a drag, and Ctrl+Z undoes the last move.
  - Ctrl-click selects several moments, and they move together keeping their time gaps.
  - Right-click a stack of overlapping cards to pick which one comes to the front.
- **Zoom.** Ctrl+wheel, a pinch, or the − / + buttons change the day's scale and the spacing between moments. Cards keep their size.

## Path
- **Set-Point bar.** One continuous bar replaces the separate tabs. It has thin dividers, a highlight on the selected segment, and a red dot on the live Set-Point. No faded preview of the next Set-Point.
- **Anytype sync.**
  - Items are de-duplicated per Anytype object in each Set-Point.
  - An undated item is pinned to the day it first arrived on (`prefs.anytypeDays`), so it doesn't carry into Tomorrow.
  - A re-keyed item keeps its checkmark.
  - The "ANYTYPE" tag is gone.
  - Synced items work with Ctrl/Shift-click, lasso selection, right-click, D and Del, and with mixed selections. Delete asks first and deletes in Anytype too when the link is two-way.
- **Sync delay.**
  - **Before:** the PC connector polls about every 45 s. After that, Path re-downloaded everything every 60 s and redrew. Worst case was about 1 m 45 s.
  - **Now:** Path checks every 6 s and downloads only the rows newer than the newest it has. It redraws only when something changed, and does a full read every 5 min.
  - The status line shows how long the last change took to appear after it reached the backend.
  - The connector's own ~45 s pass runs on the PC and is not part of this update.
- **Customize My View.** The button in the corner of the Path view, or a right-click on its divider, opens the same editor as My View. The layout is saved separately in `prefs.sbPathLayout`.

## Phone
- **Navigation.**
  - The bottom slider is removed.
  - The six-dot control beside the title opens the icon sidebar over the view. The sidebar is 1in wide, capped at 30% of the screen, and closes with a tap outside or Esc.
  - The sidebar has Overview (opens the board), Variables, Path, and More at the bottom.
  - Path and Fleeting Moments switch with the looping arrow, and only one title shows at a time.
- **Story.** The spine stays. A bare + and text field float at the bottom, and Enter posts a moment.

## Rollback
- Restore the files from the previous deploy.
- `css/nov25.css` can be deleted.
- No data migration needs undoing.
  - The new prefs (`updBoardId`, `sbPathLayout`, `anytypeDays`) and `gone` are ignored by older code.
  - The Updates board stays in Archives.
