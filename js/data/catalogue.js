// The Updates Catalogue: what changed in Architect, newest first. Shown in Settings → Updates.
// One entry per shipped update (the green notes on the "Architect SYSTEM Updates — HQ" board).
// area: the part of Architect it touches. Add new entries at the top.
export const CATALOGUE = [
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
