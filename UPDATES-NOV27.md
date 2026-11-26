# Architect — Nov 27 update (Architect SYSTEM Updates)

Copy every file in this folder into the repo at the same paths, then commit and push. Vercel redeploys.
`config.js` isn't included, so keep yours. The service worker version is now `architect-shell-2026-11-27`.
Optional: run `supabase/nov27.sql` once in Supabase. Deleting shared spaces works without it, but with it the shared row is removed immediately.

## New files
- `css/nov27.css`: all the styling for this update
- `js/space/nov27.js`: configurable shortcuts, the Blueprint view, type-the-name confirm, squared corners where objects snap together
- `js/board/live27.js`: Reactions + Timer, Present Board, Record Talktrack, calls
- `supabase/nov27.sql`: optional, lets either member delete a shared Variables space

## What's in it
| Area | Item | Where |
|---|---|---|
| Path | Today plus exactly 5 upcoming day tabs, then a calendar button. Later dates open from the calendar and don't add tabs | paths.js |
| Path | The calendar uses the Fleeting Moments design (Doto month, arrows, weekday row, round days, today and selected highlighted). Picking a date opens that day's Path and Set-Points. "Pick a date…" was added to Plan for another day | paths.js, nov27.css |
| Path | The Path + Fleeting Moments split runs edge to edge with one thin draggable divider | nov27.css |
| Fleeting | ‹ TODAY › sits in the top bar as one group, and TODAY opens the calendar. The standalone calendar, image, − and + buttons and the second row are removed. The four-corner expand control replaces the pop-out icon | fleeting.js, widgets.js |
| Fleeting | Zoom-out stops once GM → NEW MORNING fits the view (desktop and phone) | fleeting.js |
| Fleeting | The empty-state text is removed; clicking the line and dropping media still work | fleeting.js |
| Canvas | Locked objects get no blue or dashed outline. Dragging over one pans; a still click selects it with the normal border | editor.js, nov27.css |
| Canvas | Snapped objects get squared corners wherever they touch (shared edges and junctions), so no gaps show. Moving an object away restores its corners | nov27.js |
| Canvas | Connectors route around objects by default and recalculate as things move. A per-connector "Allow intersections" option is in Connector style | geometry.js, contextbar.js |
| Canvas | Canvas menu order: Paste here, creation tools, Blueprints, then Settings… alone | space.js |
| Sidebar | Ghost-white icons: dotted A, ball-and-stick atom, flat compass cross in a ring. Icons look the same before and after you click them, in every theme | sidebar.js, nov27.css |
| Sidebar | New Blueprints (#) and Personal Space (home) buttons sit below Compass | sidebar.js |
| Sidebar | Hide / show toggle; when hidden, a button stays in the corner. Change password and Sign out moved to the sidebar's More menu | space.js, sidebar.js |
| Settings | New Shortcuts tab with configurable keys for Switch to Personal Space and Toggle Sidebar. Tab is no longer hardcoded; clashes are flagged and you pick which action keeps the key | nov27.js, settings.js, space.js |
| Blueprints | The Blueprint view is an opaque dot-grid canvas of preview cards with no header, just Fit and Close. Drag cards to arrange them; the layout is saved | nov27.js |
| Variables | Five text-only tabs, then a ⌄ for the rest. The ⌄ is highlighted while an overflow tab is open | variables.js |
| Variables sidebar | Spaces are uppercase Doto text tabs. The space title is in Doto with the dotted handle back. Subsections are bold uppercase Doto. Names stay on one line, the open chat has a row highlight, and indentation is clearer | sidebar.js, nov27.css |
| Variables sidebar | Drag the right edge to resize. The + New chat row is gone; right-click the background for the space menu, with New chat first | sidebar.js |
| Variables sidebar | The map preview shows the same Free View canvas (when the space has a Free View layout), fitted by zoom only | variables.js, freeview.js |
| Variables sidebar | Either member can delete a shared space. It disappears from both sidebars and stays gone after a reload | varshare.js, sidebar.js |
| Variables Library | No header or helper text; Fit and Close only. Deleting a Zone Cube requires typing its name | zones.js |
| Present (Zone Cube) | TTS speed slider. Only message bodies are read (no sender names or "picture" labels). Pictures show silently | zones.js |
| Present (Zone Cube) | New "Show alongside" connector type: link one or many selected messages to an object. The lines show only while linking. Present frames linked items side by side without changing the reading order | freeview.js, zones.js |
| Toolbar | Space toolbar order: Select, Sticky, Text, Arrow, Pen, Area, Shapes, + Insert (Image / Video / Objects). Undo / Redo sit in their own pill. Blueprints and Variables Free View use the same layout | board.js, freeview.js |
| Top bar | Space top bar: Reactions + Timer, Record / Call, Present Board, then your profile picture + ⌄ for the More menu (Invite People, set status, all the old options). Back/Saved, Search, Frames and the standalone Invite are removed | board.js, live27.js |
| Shared Space | One popover for reactions (they pop next to your cursor for everyone, then fade) and a shared countdown (set / start / pause / reset; everyone sees the same chip) | live27.js, collab.js |
| Shared Space | Record Talktrack: choose Current tab / Window / Full screen / Camera only, plus mic and camera. A circular camera bubble shows controls on hover. A compact strip has the timer, pause, stop, restart and discard. The finished video lands on the board | live27.js |
| Shared Space | Start a Call: Attach to Space (a joinable tile on the board that ends for everyone with the call) or Dock on Screen (bottom-left or bottom-right). Mic and camera toggles. Kept separate from Talktrack | live27.js |
| Shared Space | Present Board shows the whole canvas; viewers follow your pan and zoom and can stop following. It doesn't start calls or recordings | live27.js |
| Shared Space | Cursor labels show Active / Typing / Idle, or a custom status you set. Presence knows which view each person is in, and cursors only draw on the same view | collab.js, sidebar.js |
| Shared Space | Reciprocal invites: if you already share a Space with someone, inviting them takes you there. Duplicate Spaces with the same members resolve to the oldest one for everyone. Nothing is merged or deleted | space.js, settings.js |
| Mobile | Dragging (even on a selected object) only moves the view. A tap selects on release. After a pinch, everything is navigation until all fingers lift. Move with the Move handle and resize with the corners | editor.js |
| Mobile | Object headers use the desktop title size, with the handle beside the title and less space below | nov27.css |
| Mobile | The Set-Point bar sits right under the date row; full names wrap instead of being cut | nov27.css |
| Mobile | The Fleeting composer is see-through with a faint outline; the + is kept | nov27.css |
| Mobile / sync | Variables never shows defaults or an Add-only view when loading fails. It says it's retrying, never saves until your account is reached, and never creates a second row | myvars.js, variables.js |

## Not done / needs a check on the live site
- **Not built:** Zone Library as a shared hierarchical map (subsection → chat → zones) shared between both members. The Library is still per chat.
- **Not built:** the Variables chat dock separated from the Free View canvas (dragging the real bubble out). The chat column still sits on the canvas.
- **Partly done:** live cursors inside Variables, Blueprint and custom views. Presence shows the view, but cursors draw only on the main canvas. Shared Moments and voice-message sync are unchanged from Nov 26.
- **Partly done:** the full cross-device workspace sync item. Theme already follows your account and the Variables load is hardened. There's no pending / synced / failed indicator and no conflict UI yet.
- **Calls** are peer-to-peer with public STUN only (no TURN server), so they can fail on strict networks.
- **Talktrack** uses the browser's MediaRecorder, and long recordings take a while to upload.
- **Two-account checks** (reactions, timer, Present, calls, shared delete, reciprocal invites) need two real accounts. They were only smoke-tested in local mode.
