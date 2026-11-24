// The Updates Catalogue: what changed in Architect, newest first. Shown in Settings → Updates.
// One entry per shipped update (the green notes on the "Architect SYSTEM Updates — HQ" board).
// area: the part of Architect it touches. Add new entries at the top.
export const CATALOGUE = [
  {
    day: '2026-11-25', area: 'Variables', title: "The map shows everything right away",
    text: "The Variables map now shows a space’s chats and every subsection (nested ones too) as soon as it opens — no empty dotted grid, no opening each subsection first. The square preview at the bottom of the sidebar shows the same map before you click it; clicking opens it larger, full screen is optional. It refreshes as things are added, moved or deleted, in your own and in shared spaces.",
  },
  {
    day: '2026-11-25', area: 'Variables', title: "Fold subsections; pictures beside names",
    text: "Each subsection in the Variables sidebar has a toggle to fold it away or open it again. A chat or subsection with a picture shows it as a small thumbnail beside its name; without one, just the name.",
  },
  {
    day: '2026-11-25', area: 'Variables', title: "Shared spaces: delete anything, see the same thing",
    text: "Both people in a shared space have the same controls, Delete included, whoever made the object. Deletions are remembered on the shared copy and on your account (not per device), so nothing comes back, and an edit made while the other person was editing no longer drops theirs. People who join your shared Space later are added to the spaces you already shared.",
  },
  {
    day: '2026-11-25', area: 'Variables', title: "Right-drag pans over the Variables object",
    text: "Hold the right mouse button anywhere on the Variables object (or any object) and drag to pan the board. A plain right-click still opens the menu.",
  },
  {
    day: '2026-11-25', area: 'Space', title: "Live cursors are back",
    text: "Everyone on the same shared canvas sees the others’ pointers move live, with their name or profile picture, drawn above every object. A cursor goes when that person leaves the board, switches away or disconnects, and nothing from a private space is ever sent.",
  },
  {
    day: '2026-11-25', area: 'Blueprint', title: "Lock the frame, not the contents",
    text: "Locking an object keeps it from moving or resizing, but whatever is inside still works: click, type, edit, and use its own right-click menus. A locked frame no longer blocks clicks inside it. Right-click an object’s outer border to lock or unlock it, even when its header is hidden.",
  },
  {
    day: '2026-11-25', area: 'Settings', title: "Updates & Fixes is a real Blueprint",
    text: "The Updates & Fixes tab now uses the same canvas and toolbar as any Blueprint: pan, zoom, select, move and edit update notes (sticky notes) and linked previews (pictures connected to a note) with the usual controls and shortcuts. Push Update, Schedule and the run status stay beside the canvas for the selected note. Your existing notes moved onto it.",
  },
  {
    day: '2026-11-25', area: 'Sidebar', title: "New navigation icons",
    text: "Overview is the dotted Architect mark with its red dot, Variables an atom, Path a compass. The three-dot More button sits at the bottom of the rail. Icons only, no outlines or highlights.",
  },
  {
    day: '2026-11-25', area: 'Fleeting Moments', title: "Story only, full screen, easier editing",
    text: "Weekly is gone: Fleeting Moments opens straight to Story. Story can fill the screen and come back without losing your place. Set-Point names are larger, a placement guide and a large clock show where a moment will land, and moments snap to nearby time marks (hold Alt to place between them). Right-click a stack of cards to pick one. Ctrl-click to select several and move them together; Esc cancels a drag, Ctrl+Z undoes a move. Zoom (Ctrl + wheel, pinch, or − / +) changes how much of the day you see — never the cards.",
  },
  {
    day: '2026-11-25', area: 'Path', title: "One Set-Point bar",
    text: "The Set-Point pills are one continuous bar with thin dividers: the selected segment is highlighted, the red dot stays on the live Set-Point, and only the selected task list shows below — no faded previews of the others.",
  },
  {
    day: '2026-11-25', area: 'Anytype', title: "Synced items behave like Path items",
    text: "Items synced from Anytype stay on the day they belong to (no carrying into Tomorrow), edits update the same item without duplicates or losing its checkmark, and they get the same selection, right-click menu and batch actions as Path tasks — without the visible tag. Path now checks for changes every few seconds and downloads only what changed.",
  },
  {
    day: '2026-11-25', area: 'Path', title: "Customize My View for Path",
    text: "The Path view has the full Customize My View editor from the sidebar: show or hide titles and headers, start a blank dot-grid layout, add objects, drag them inside the border, lock positions. Path’s layout is saved separately from your other views.",
  },
  {
    day: '2026-11-25', area: 'Phone', title: "One focused view and an icon sidebar",
    text: "No bottom slider: the six-dot control beside the title opens the icon sidebar over the view. Path and Fleeting Moments flip with the small looping arrow at the top right. Story keeps its spine and gets a floating + and text field at the bottom; Enter posts the moment.",
  },
  {
    day: '2026-11-24', area: 'Sidebar', title: 'My View: arrange and lock your layout',
    text: 'A view has no top bar any more. A new view starts as a blank dot grid with a visible border; add any Architect object (right-click, or the + in the corner) and drag it into place by its header, resize it from its corner. The workspace stays at a fixed scale — no panning, zooming or growing past the border. Lock the layout to keep everything in place; unlock it to adjust.',
  },
  {
    day: '2026-11-24', area: 'Fleeting Moments', title: 'Story: pan with a right-click drag',
    text: 'Hold the right mouse button and drag to pan Story in any direction, left and right included, to reach cards beside the timeline. Scrolling works as before; a right-click that doesn’t move still opens the menu.',
  },
  {
    day: '2026-11-24', area: 'Space', title: 'Backgrounds for both Spaces',
    text: 'Settings → Personalize: pick a background for your Personal Space and for the Shared Space — the crossed-line square grid, a dotted grid, graph paper, plain, or your own PNG as Fill or Tile (with a size control). Patterns and tiles move with the canvas. Both are your preference only: in the Shared Space, everyone keeps their own background.',
  },
  {
    day: '2026-11-24', area: 'Settings', title: 'Updates & Fixes canvas',
    text: 'The Updates tab is now a canvas of update notes and linked previews, right in Settings. Select a note and Push Update to start it now, or Schedule it for later. The Architect runner on your PC resumes the linked Claude session (or starts one with the note and the latest project), in the background, and the panel shows the step, status and time left. If it needs you it shows as Blocked; the tested result is written on the note.',
  },
  {
    day: '2026-11-24', area: 'Anytype', title: 'Path ⇄ Anytype, both ways',
    text: 'Linked items now sync both ways: check, uncheck, rename, add or delete on either side and the other follows, without duplicates. Linked items get the usual Path menu — Rename, Remove from Path (hides it here only, and it stays hidden after a sync), Open in Anytype, Sync now, Anytype settings, and Delete from both (after a confirm). Unlinked Path tasks and goals are never touched.',
  },
  {
    day: '2026-11-24', area: 'Blueprint', title: 'One header on Blueprint windows',
    text: 'A Blueprint opened as a window has no extra title bar: its own header (board name and save status) is the only one. Drag the window by that header; full screen and close sit at its right end and in ···, and Ctrl+Esc still closes it.',
  },
  {
    day: '2026-11-24', area: 'Variables', title: 'Edit in the sidebar, shared spaces too',
    text: 'Right-click space tabs, subsections and chats in the sidebar to rename them in place, recolor, add, move or delete. A subsection’s + adds a chat straight into it, NEW CHAT is an inline field, and dragging a chat shows a line exactly where it will land. Spaces shared with you have the same controls and Free View. The map shows each subsection’s variables without opening it, and the duplicate title row is gone — Search, Free View and ··· sit in the top bar.',
  },
  {
    day: '2026-11-24', area: 'Sidebar', title: 'A quiet sidebar',
    text: 'Architect, Variables, Path and More are icons only, and nothing changes when you click them — no highlight, gold bar or tint. In the chat list the open chat has a subtle neutral shadow, the same in every theme.',
  },
  {
    day: '2026-11-24', area: 'Radio', title: 'Spotify playlists, personal or shared',
    text: 'Paste a Spotify playlist link into Radio and it plays in Spotify’s own player. Keep it Personal (only you see and hear it) or Shared (everyone in your Shared Space can open it from their Radio). Playback is always yours alone — nobody else’s Radio starts.',
  },
  {
    day: '2026-11-24', area: 'Voice chat', title: 'Enter to talk, from any view',
    text: 'Press Enter anywhere in Architect when you’re not typing: a small composer opens over what you’re doing. Type (read out loud) or record a voice message. If a Variables chat is open, the message goes into that chat and is read aloud there.',
  },
  {
    day: '2026-11-24', area: 'Variables', title: 'Longer names, Doto, colors and undo',
    text: 'Variable and subsection names can be much longer and wrap instead of being cut off. Subsection names use Doto in the sidebar and on the canvas. Right-click a variable or subsection to pick its color. Ctrl+Z (and Undo in the menus) reverses Variables changes — renames, colors, moves, resizes, reordering — without touching the Blueprint.',
  },
  {
    day: '2026-11-24', area: 'Variables', title: 'Organ chats moved into Variables',
    text: 'The Organ chats now live in an Organs space in Variables (right-click the top bar → New Organs space…). Each Organ is a chat in the sidebar; pick which Anytype object it syncs with from its menu. Their history stays private — never on shared boards or in shared spaces. The floating Side Chat launcher is gone on desktop; Ideas sits at the bottom of the Organs list.',
  },
  {
    day: '2026-11-23', area: 'Sidebar', title: 'Slimmer desktop sidebar',
    text: 'The rail is about an inch wide. Architect, Variables, Path and More each have a simple icon with the label underneath. Hovering no longer highlights; only the view you’re on turns amber, with a thin amber line at the left edge.',
  },
  {
    day: '2026-11-23', area: 'Variables', title: 'Tabs use the Path font',
    text: 'The section tabs (Money, Position, Network, Traits…) use the same font as the weekday tabs in Path. The dotted Variables title, the tab order and the selection styling are unchanged.',
  },
  {
    day: '2026-11-23', area: 'Variables', title: 'Desktop spaces, chats and map',
    text: 'Each space (Money, University…) has its own cover and can be private or shared. The chat sidebar uses the space’s name as its Doto header — the chevron switches spaces, the button beside it hides the sidebar. Right-click the top bar to add a space. The map is a plain square at the bottom: open it to see the space’s field, its name faint at the centre and its subsections as tiles.',
  },
  {
    day: '2026-11-23', area: 'Path', title: 'Adaptive layout and per-object zoom',
    text: 'In the Path view, Path fits its pane so every setpoint is visible (four across, two by two, or one column). Path and Fleeting Moments each keep their own zoom — set different scales, lock either one, or switch back to Auto Fit. Drag the gutter between them to resize the split.',
  },
  {
    day: '2026-11-23', area: 'Radio', title: 'Plays links beyond YouTube',
    text: 'Paste links from X, Threads, TikTok, Instagram, Facebook, Vimeo, Twitch, Dailymotion, Streamable, Reddit, SoundCloud or Spotify. Each plays in its own platform’s player with native controls. A private, removed or blocked post shows why, with an “Open original” button.',
  },
  {
    day: '2026-11-23', area: 'Space', title: 'Personal backgrounds and a shorter right-click menu',
    text: 'Settings → General → Personal Space background puts a PNG of your own behind your personal Space; the shared Space stays as it is. The right-click menu lost its Add heading, keeps one Border tool, and moves Chat, Radio, Timer, Path task, Say something out loud and Emergency Room under Widget…. Theme, Performance test and Keyboard shortcuts moved into Settings. “Show toolbar” now works whether or not the sidebar is open.',
  },
  {
    day: '2026-11-23', area: 'Anytype', title: 'Anytype → Path sync (beta)',
    text: 'Connect Anytype once on your PC, choose the page section or collection that feeds each Set-Point, and preview exactly what will be imported. Your phone reads the same imports after signing in — no IP address, key or shared Wi-Fi. Checkmarks and goals stay in Architect; refreshing an import never resets them or changes Anytype. Off by default: Settings → Integrations.',
  },
  {
    day: '2026-11-23', area: 'Sidebar', title: 'Desktop sidebar',
    text: 'A rail on the left: Architect (the canvas), Variables, Path (Path + Fleeting Moments) and More. Custom views hold the objects you pick in a fixed layout.',
  },
  {
    day: '2026-11-23', area: 'Offline', title: 'Works without a connection',
    text: 'The app shell and your data are cached on the device. Path and Blueprint edits made offline are saved and replayed when you’re back online.',
  },
  {
    day: '2026-11-23', area: 'Path', title: 'One task, two views',
    text: 'Put a Path task on any board as a live card — ticking, re-dating or moving it on either side updates both.',
  },
  {
    day: '2026-11-23', area: 'Backend', title: 'New Supabase project',
    text: 'Architect moved to a fresh Supabase project while the old one stays restricted.',
  },
  {
    day: '2026-11-22', area: 'Mobile', title: 'Its own phone interface',
    text: 'Full-screen views (Path, Fleeting Moments, Variables, Voice Chat + Radio, Blueprint) and a slider with a gold knob. The desktop board is untouched.',
  },
  {
    day: '2026-11-22', area: 'Media', title: 'Media on Cloudflare R2',
    text: 'New photos, videos and voice notes go to Cloudflare R2; Supabase keeps auth and the database.',
  },
  {
    day: '2026-11-22', area: 'Chat', title: 'Real voice messages',
    text: 'Voice notes in the Emergency Room chat play your actual voice and continue automatically. Boards get a Play frame that plays objects in sequence.',
  },
  {
    day: '2026-11-19', area: 'Fleeting Moments', title: 'Fleeting Ideas → Fleeting Moments',
    text: 'Story and Weekly stay; the ideas canvas moved into Side Chat (the lightbulb).',
  },
  {
    day: '2026-11-17', area: 'Space', title: 'Emergency Room and Timer',
    text: 'E + R opens the Emergency Room: one problem per room, chat on the left, board on the right. The Timer board counts in hours, minutes and seconds for long sessions.',
  },
  {
    day: '2026-11-16', area: 'Variables', title: 'Variables',
    text: 'Sections like School, Family, Business and Friends; every entry has its own notes chat. Private to each account.',
  },
  {
    day: '2026-11-08', area: 'Space', title: 'ARCHITECT SPACE',
    text: 'One shared, invite-only canvas replaced the tabs. Path, Tracker, Blueprints and more live on it as widgets; Tab switches between the shared and the personal Space.',
  },
];
