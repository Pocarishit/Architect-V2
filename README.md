# Architect

Personal system in black and white — now one shared canvas.

- **ARCHITECT SPACE** (home, `#/`) — one infinite canvas shared by everyone you invite. No tabs, no sidebars: **right-click** (or press **/**; long-press on phones) for the menu. Everything below lives on it as movable widgets.
- **Path** — one per person (“Maveri’s Path”, “Hiru’s Path”): your setpoint kanban. Pull a column out onto the canvas and snap it back. Write `#12` in a task to link ticket #012.
- **Tracker & Weekly** — a calendar where a day turns red after 3 logged attempts on the Ticket board (click a day to see them), and 8 squares = 8 weeks toward the next environment, each with its achievements.
- **Ticket board** — problems reverse-engineered from the week’s achievements: chat, files, attempts (failed / partly / worked), red badges for unread messages.
- **Blueprints** — deep boards with the dotted grid. Select things in the Space → **Convert to Blueprint** to collapse them into a portal.
- Privacy toggle, camera points, object shortcuts, faces on cursors, custom widgets, and a **Local API** (personal tokens + custom CSS / JS with safe mode — see `API.md`).
- **Chat**, **Voice chat** (messages read out loud for everyone) and **Radio** (your YouTube playlist — solo, or a live stream that follows whoever has the aux) objects.
- Themes: Dark, Light, Blueprint. Username + password login, everything saved to your own Supabase project.

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

---

## 1. Set up Supabase (about 5 minutes)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste and **Run** each file in `supabase/`, in this order: `schema.sql`, `collab.sql`, `accountability.sql`, `nov7.sql`, `space.sql`, `nov12.sql`. All are safe to run again and keep your data.
   This creates the tables, row-level security (each user only sees their own rows) and a private `architect-media` storage bucket.
3. **Authentication → Sign In / Providers → Email** → turn **Confirm email** **off** → Save.
   Usernames are stored as `username@architect.local`; no email is ever sent, so confirmation must be off.
4. **Project Settings → API Keys** (or the **Connect** button) → copy the **Project URL** and the **publishable** key (`sb_publishable_…`, or the legacy `anon` key).
5. Paste both into `config.js`:

   ```js
   supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
   supabaseKey: 'sb_publishable_…',
   ```

6. Open the app, choose **Create an account**, pick a username and password.
7. Optional but recommended once your account exists: **Authentication → Sign In / Providers** → turn off **Allow new users to sign up**, so nobody else can register on your instance.

Leave `config.js` empty and the app runs in **Local mode** (data stays in that browser only) — handy for trying it out.

## 2. Run it

It must be served over http (ES modules don't load from `file://`):

```bash
npx serve .          # or
python3 -m http.server 5173
```

## 3. Deploy (Vercel)

Push the folder to GitHub → **Vercel → Add New → Project** → import it → Framework preset **Other**, no build command, output directory `.` → Deploy.
Or from the folder: `npx vercel`. Routing uses `#/…` URLs, so no rewrites are needed.

---

## Using it

**The Space**
- Right-click empty canvas or press `/` → add notes, text, shapes, connectors, drawings, borders (box or smooth curve — clicking inside a border doesn’t select it), frames, media, and widgets. Also: camera points, invite, settings & API, show toolbar, theme, sign out.
- Drag a widget by its header; everything inside a widget works like a normal page (scroll, type, click).
- Right-click an object → **Hide from others** (only you see it; dashed outline + lock), **Assign shortcut…** (press it anywhere to fly to the object or open the blueprint), **Convert to Blueprint…**.
- **Save this view…** stores a camera point with a key (Alt+1…9 by default); manage them in **Camera points…**.
- Invite people from **Invite…** — anyone in the Space can invite by username. Their Path appears the first time they open it.
- Path tasks: `···` → **Hide from others** keeps a single task private. Paths of more than 10 tasks scroll inside.
- Note: hiding a canvas object hides it in everyone else’s app; the object is still stored in the shared board. Private Path tasks are private in the database.

**Paths**
- Day tabs (Today, Tomorrow, the next days) next to the title: plan ahead in any tab. When that day starts (your first setpoint), its plan becomes the path, and yesterday's setpoint tasks are cleared automatically (with Undo). Timeless paths are never cleared. `···` on a task → **Plan for another day…**
- `+` or **Add task**, type, `Enter` to add another, `Esc` to stop.
- Click a task to edit it; `···` for note, duplicate, move, delete.
- Drag tasks between paths. Double-click a path name to rename; `···` on a path to move, clear done, or delete it.
- Click the page title to rename it.
- `···` on a path → **Make setpoint…** gives it a daily window (e.g. 7:00–13:00). While it runs, its header shows an HH:MM:SS countdown; later setpoints show their length dimmed. Finish every task before the timer ends to **dominate** it — the Tracker counts it (e.g. 2/4) automatically. The setpoint day starts with your first setpoint.
- Select tasks: ⌘/Ctrl-click, Shift-click for a range, drag a lasso across empty space, the select-all icon on a path, or ⌘/Ctrl+A (hovered path; again for everything). Then Done / Move / Delete from the bar, or `Delete`. Deletes can be undone.
- Drag a selection to move it all at once. Drag a path by its header to reorder paths (on phones: long-press a tile, then drag).
- Download icon (top right) exports every path to one PDF page.
- A red **Now** marker shows on Morning / Afternoon (and Evening / Night if you add them) at the matching time of day.

**Getting around**
- **Ctrl+Esc** (or **Esc twice**) escapes whatever is open full size — a Blueprint, an expanded ticket, the full-page Path or Ticket board. On Windows, Ctrl+Esc opens the Start menu, so use Esc twice.
- Blueprints open as a **window** over the Space (drag the bar, resize from the corner, ⤢ for full screen). Turn it off in a Blueprint's `···` → **Blueprints open as a window**.
- Objects **snap to each other** as you drag or resize: edges touch, edges and centres line up (red guides). Hold Ctrl/⌘ to place freely; toggle in the Space menu → **Snap objects together**.
- Long menu sections (more than 5 actions) fold: click the section name.
- Phones and tablets get a dock along the bottom: Menu, Path, Tickets, Tracker, Blueprints, Add.
- **Enter** on the Space (nothing selected) → say something out loud through the Voice chat.
- Right-click any object → **Chat about this** starts a chat connected to it (dotted line). Chats scroll on hover, resize like any object and export as Markdown, text or JSON.

**Blueprint**
- Archives: new folders and boards, double-click a name (or `F2`) to rename, `···` to pin, move, duplicate, delete. Drag boards or folders onto a folder or breadcrumb to move them. `/` focuses search.
- Board tools: `V` select · `H`/Space pan · `N` sticky · `T` text · `S` shape (`R` rectangle, `O` ellipse) · `L` line / `A` arrow · `P` pen · `E` eraser · `F` frame · `U` upload · `K` video or link.
- Drag a connector from one item to another and it stays attached. The `+` dots on a selected sticky or shape add a connected copy (quick mind-mapping).
- Paste or drop images and videos straight onto the board. Paste a YouTube (videos and playlists) / Vimeo / Loom / TikTok / Instagram / X / Twitch / Spotify / SoundCloud / Apple Music / Google Drive / Figma / Canva / Miro / CodePen / Maps link to embed it — a link with words around it, or without https://, works too. Other links become cards with the page's title, description, picture and icon (or **Show the page instead**); double-click a video to play it.
- `⌘/Ctrl+Z` undo, `⌘/Ctrl+D` duplicate, `⌘/Ctrl+G` group, `⇧⌘/Ctrl+Shift+L` lock, `]` / `[` front/back, `⇧1` fit all, `⌘/Ctrl+F` find, `?` all shortcuts.
- Frames become slides: **Present** (top right) walks through them with the arrow keys.
- `···` → Export as PDF (`⌘/Ctrl+P`, whole board on one page — pick “Save as PDF”), or Export / Import as JSON.

**Tracker & Weekly**
- Tracker: switch people with the faces on top. A day fills red at 3+ attempts with a result (3 is the minimum); 1–2 attempts show a partial ring. Click any day for the attempts behind it.
- Weekly: 8 squares from the start date you pick; the current week has a red outline. Click a week to add / tick achievements, or turn one into a ticket.

## Notes

- **Forgot your password?** There's no email to reset it. While signed in you can change it from the account menu. If you're locked out, run this in the SQL Editor:
  ```sql
  update auth.users
  set encrypted_password = extensions.crypt('your-new-password', extensions.gen_salt('bf'))
  where email = 'yourusername@architect.local';
  ```
- **Upload size**: Supabase's default limit is 50 MB per file (Storage settings).
- Media is private: images and videos are served through signed links that only work for your account.
- Fonts (Doto, Space Grotesk, Space Mono) load from Google Fonts. Nothing's own typefaces are proprietary, so Doto stands in for the dot-matrix voice.

## Files

```
index.html            app entry
config.js             your Supabase URL + key
supabase/schema.sql   tables, security policies, storage bucket
css/                  base tokens, app views, board canvas
js/main.js            boot + routing
js/data/              Supabase REST client, local-mode backend
js/views/             login, shell, Space, Paths, Ticket board, Archives, Settings
js/space/             Space widgets (Path, Tracker & Weekly, Ticket board, Blueprints, portals, custom)
js/board/             canvas engine (rendering, toolbars, live collaboration)
API.md                the Local API (incl. updates + rollback)
```
