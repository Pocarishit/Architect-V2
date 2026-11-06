# Architect

Personal system in black and white.

- **Paths** — your kanban: Morning, Afternoon, Atemporal, Futures, Cache.
- **Themes** — Dark, Light and Blueprint (navy), from the theme button or account menu.
- **Tracker** — log daily effort (hours, money, outreach — your own metrics), with a streak calendar and 14-day trends.
- **Blueprint** — an infinite planning board (stickies, text, shapes, connectors, pen, frames, images, videos, embeds), with **Archives** for folders, renaming and pinning.
- Username + password login, everything saved to your own Supabase project.

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

---

## 1. Set up Supabase (about 5 minutes)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. (Already set up? Run it again — it adds the Tracker tables and keeps your data.)
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

**Paths**
- `+` or **Add task**, type, `Enter` to add another, `Esc` to stop.
- Click a task to edit it; `···` for note, duplicate, move, delete.
- Drag tasks between paths. Double-click a path name to rename; `···` on a path to move, clear done, or delete it.
- Click the page title to rename it.
- `···` on a path → **Time window…** sets when its red **Now** dot shows (times stay hidden), or **None**. Paths without a setting use their name (Morning, Afternoon, Evening, Night).
- Select tasks: ⌘/Ctrl-click, Shift-click for a range, drag a lasso across empty space, the select-all icon on a path, or ⌘/Ctrl+A (hovered path; again for everything). Then Done / Move / Delete from the bar, or `Delete`. Deletes can be undone.
- Drag a selection to move it all at once. Drag a path by its header to reorder paths (on phones: long-press a tile, then drag).
- Download icon (top right) exports every path to one PDF page.
- A red **Now** marker shows on Morning / Afternoon (and Evening / Night if you add them) at the matching time of day.

**Blueprint**
- Archives: new folders and boards, double-click a name (or `F2`) to rename, `···` to pin, move, duplicate, delete. Drag boards or folders onto a folder or breadcrumb to move them. `/` focuses search.
- Board tools: `V` select · `H`/Space pan · `N` sticky · `T` text · `S` shape (`R` rectangle, `O` ellipse) · `L` line / `A` arrow · `P` pen · `E` eraser · `F` frame · `U` upload · `K` video or link.
- Drag a connector from one item to another and it stays attached. The `+` dots on a selected sticky or shape add a connected copy (quick mind-mapping).
- Paste or drop images and videos straight onto the board. Paste a YouTube / Vimeo / Loom / TikTok / Twitch / Spotify / Google Drive / Figma / Maps link to embed it; double-click a video to play it.
- `⌘/Ctrl+Z` undo, `⌘/Ctrl+D` duplicate, `⌘/Ctrl+G` group, `⇧⌘/Ctrl+Shift+L` lock, `]` / `[` front/back, `⇧1` fit all, `⌘/Ctrl+F` find, `?` all shortcuts.
- Frames become slides: **Present** (top right) walks through them with the arrow keys.
- `···` → Export as PDF (`⌘/Ctrl+P`, whole board on one page — pick “Save as PDF”), or Export / Import as JSON.

**Tracker**
- Pick a day, enter your numbers (± steps them). Rings fill toward each metric's daily goal; a solid day means every goal was hit; a small dot means you beat the day before.
- Streak = days in a row with anything logged. The flame shows it on this week; a check marks a full week.
- **Metrics** edits names, units and daily goals.
- **Partners** (needs Supabase + `supabase/accountability.sql`): add someone by username to share your tracker with them, read-only. You see theirs once they add you. The Accountability card shows each partner's day and streak; open theirs to comment on any day. Comments on your days show under each day.
- Boards save automatically (status dot next to the name).

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
js/views/             login, shell, Paths, Archives
js/board/             Blueprint editor (canvas engine, rendering, toolbars, templates)
```
