# Architect — Nov 29 update

Copy these files over the repo (same paths) and push. The service worker version is now `architect-shell-2026-11-29`. There's no SQL and no new files. This update includes the Nov 28 and Nov 28b changes, so if those weren't pushed yet, this covers them.

## Done
- **Connectors:** every visible object is now an obstacle, including sticky notes, images, media, cards, widgets and text. Rotated sticky notes used to be skipped; now their rotated outline counts. A connector reroutes whenever either end or anything in its path moves or resizes. Allow Intersections is still off by default and applies per connector.
- **Toolbars:** Blueprint boards and every Variables canvas (chats, the cube editor, the sections map) use the approved rail: Select, Sticky Note, Text, Arrow, Pen, dashed Area, grouped Shapes, + Insert, with Undo/Redo in their own pill below.
  - The extra buttons moved into the + Insert menu:
    - Blueprints: Image/PDF, Video/embed, Frame and Templates.
    - Variables: Image, Library, Lasso, Dot grid, Back to start and Everything back.
  - Hand is still H or hold Space.
- **Variables Map:** the chat's toolbar no longer shows through or catches clicks while the Map is open. The inline Map preview has no rail. Hiding the toolbar hides the whole rail, including Undo/Redo, and it stays hidden across the chat and the Map until you show it again.
- **Sidebar:**
  - New ghost-white icons: an orbital atom for Variables, a two-tone needle for Compass and a folded plan sheet for Blueprints. The dotted A is unchanged.
  - The show/hide button and the house icon are gone. The sidebar is hidden by default and appears when you move to the left edge; a sidebar that was pinned before goes back to hiding once.
  - The ⋮ menu now opens right beside the button, bottom-aligned and opening upward. The sidebar stays visible while that menu is open.
- **Section menu:** the labels are now "New sub-section", "Rename" and "Color", with no trailing dots.
- **Library cube preview:** the header bar is gone and the canvas runs to the top edge. Edit Zone, Present, Copy and Close sit in a small cluster in the top-right corner. The preview itself is view-only.
- **Edit Zone** (also in a cube's right-click menu in the Library): opens the cube on a normal Variables canvas over the Library.
  - You can select and move items, edit notes, connect items, and double-click a message to edit its text.
  - Changes save into the same cube as you go; Done or Esc closes it. Nothing gets pasted into the chat.
- **Present:**
  - A message with Show alongside links now shows with its linked items side by side on a stage over the canvas, all fully visible. The canvas isn't changed.
  - The same picture can appear beside several messages in turn.
  - Narration reads only the message text: no sender names or "Picture" labels, and images are shown silently.
- **Side Chat:**
  - A sent message appears right away, marked "Sending…" until it saves; if saving fails it's marked "Not sent" with Retry.
  - When collapsed, hovering its right edge opens it, and it stays open while you type or a menu is open.
  - Right-clicking an empty spot gives Customize Background (preset colours, a custom colour or an image) and Reset to Default. The background is saved per chat.
- **Variables multi-select:** selecting more than one object (including Select All) shows one box around the whole selection. Dragging a corner resizes everything together, so sizes and spacing scale as one. It's only a temporary selection, not a group.
- **Border tool:**
  - Choose Line or Box, Standard or Glass, then Color: preset swatches, a hex field and a custom picker, with a preview before you draw.
  - Glass uses a soft translucent edge; a Glass Box also gets a faint wash inside.
  - Each border keeps its own look. Selecting a border lets you change it from the rail menu, or use the Glass switch and Custom color on the context bar.
- **Fleeting Moments:**
  - **Path sidebar:** the panel is a normal scrollable timeline again, in muted neutrals. Nov 28 had accidentally shown it in board mode.
  - **Architect board:** Story is part of the background, in warm tones, with no zoom of its own; the board's pan and zoom drive it.
  - **Timeline (both):**
    - A thin line with hour marks and shorter quarter-hour ticks.
    - Larger, readable time labels and bigger Doto Set-Point names.
    - A ringed Now marker with Add Moment right beside it: a 44px outlined button with a visible keyboard focus ring.
    - Enter saves a moment, Esc cancels, and focus goes back to Add Moment either way.
  - **Moment Zone tool** (on the Architect toolbar): shows a dashed outline with handles. Drag it to move the zone and drag the corners to resize. Esc or picking another tool hides it completely, and the zone then stays anchored and ignores clicks.
  - **Moments anywhere:** right-click the board → Moment adds a card where you clicked, which you can drag like any object. The moment is also saved into today's Story.

## Checks I ran (on a local copy, signed out)
- An axe scan (WCAG A/AA) of Story on the board and in Path found 0 violations.
- A keyboard-only Add Moment flow worked on both, including focus returning after save and after cancel.
- A saved moment was still there after a reload.
- Lint and the bundle are clean, and desktop and phone load with no console errors.

## Not done / limits
- Not checked between two accounts, with a screen reader, or at browser zoom levels. Please spot-check on the live site.
- Edit Zone works from a chat's own Library. The space-wide Library map still offers only preview and Present.
- A Moment placed on the board is a separate card. Deleting it doesn't remove it from the Story, and editing one doesn't update the other.
