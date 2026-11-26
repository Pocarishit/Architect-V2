# Architect — Nov 28 update

Copy these files over the repo (same paths) and push. The service worker version is now `architect-shell-2026-11-28`, so clients pick up the new shell. There's no new SQL and no new files to add.

## Done
- **Toolbars:** a filled Select pointer and a grouped Shapes icon. The rail sits under the top bar; the active tool is shown light, and Undo/Redo are in their own pill. The space top bar is now Reactions/Timer · Camera · Present · people · profile, with undo/redo moved off it. Free View uses the same rail.
- **Sidebar:** hidden by default. Hover the left edge to reveal it; Pin/Unpin is in the sidebar toggle. The house icon is gone from the rail (Personal Space is now under ⋮ More). Blueprints opens inline inside the workspace, and the sidebar can still peek over it.
- **Variables sidebar:** chat names use the regular font in their saved capitalization, with an optional Bold in the chat's menu. Subsection labels are bold uppercase Doto. Rows are centred at 34px, nested chats get a guide line and there are dividers between groups. A selected row only changes its background. A new Library button sits in the space bar.
- **Locked objects:** no selection outline or lock badge. They keep their normal border.
- **Connectors:** an "Allow intersections" switch on the context bar (off means the connector routes around objects).
- **Show alongside:** a "Linking mode" banner with Done. You stay in linking mode until you press Done.
- **Talktrack:** setup is now a non-modal dark panel at the top right. The camera bubble previews live and can be placed before you record. The bubble is a bare circle with its controls on hover, and it remembers its position and size.
- **Calls:**
  - The header reads "● Live call ··· N participants". The controls are Mic · Camera · Leave call · End for all, and everyone gets End for all.
  - Leave no longer ends the call for the others.
  - An attached tile can be dragged by its header and resized from its corner, and its position and size sync to everyone.
  - The dock can be dragged and snaps to the bottom-left or bottom-right, and it's resizable.
  - Before joining you see a "Join call" tile or pill.
  - The Start a call dialog explains both options, with three buttons on one row.
- **Fleeting Moments:** Story is drawn straight onto the board background on the left, with no panel, frame or header. The title has ‹ TODAY › under it, and Today opens the calendar. "+ Add Moment" sits on the timeline at Now. The object isn't deleted: it's placed once to the left of everything, locked and sent to the back (Unlock it from its menu to move it).
- **Variables Free View chat dock:** the conversation and composer sit in a right-side dock outside the canvas, so pan and zoom move only the canvas. The dock has no header, outline or divider. The edge tab hides or shows it without resetting the canvas. Dragging a message out of the dock moves that bubble onto the canvas where you drop it. Placed messages appear only on the canvas, and Normal View still shows everything in order.
- **Space Library map** (the Library button in the Variables sidebar):
  - One zoomable map: subsections → chat folders → Zone Cubes.
  - Double-click a folder or subsection to zoom in. The breadcrumb, the zoom-out-a-level button and Fit work as before.
  - Drag a cube to arrange it inside its own chat.
  - The map reads and writes the space's own source, so both members see the same Library and it refreshes while open. Personal spaces never appear in it.

## Not verified / limits
- Two-person features were only smoke-tested on one local client, not between two accounts: synced tile move/resize, participant counts, Leave vs End for all, and the shared Library.
- Fleeting Moments is placed automatically the first time a board loads it. If it lands somewhere odd, unlock it and drag it.
- The Library map reuses the existing cube previews. Embedding a cube into a chat is still done from that chat's own Library (B).
