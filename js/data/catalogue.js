// The Updates Catalogue: what changed in Architect, newest first. Shown in Settings → Updates.
// One entry per shipped update (the green notes on the "Architect SYSTEM Updates — HQ" board).
// area: the part of Architect it touches. Add new entries at the top.
export const CATALOGUE = [
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
