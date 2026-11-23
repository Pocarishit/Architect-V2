# Architect runner

Runs the updates you **Push** or **Schedule** from Architect → Settings → **Updates & Fixes** — on your PC, in the
background, with Claude Code. No terminal windows, pop-ups or focus stealing.

## Set up (once)

1. Run `supabase/nov24.sql` in the Supabase SQL editor.
2. Architect → Settings → **API** → name it "Runner" → **Generate** → copy the `arch_…` token.
3. On the PC that has your Architect folder and Claude Code (signed in):
   ```
   cd <your Architect folder>\runner
   node architect-runner.mjs setup --token arch_… --repo "<your Architect folder>"
   powershell -ExecutionPolicy Bypass -File install-windows.ps1
   ```
   Optional: `--session <id>` links an existing Claude session (the "linked Architect session") so runs continue
   it; `--push` lets runs commit and push (off by default — changes stay in the folder for you to review/upload).

## What a run does

1. **Resumes** the Claude session linked to the note (or the one you linked with `--session`); otherwise starts
   fresh with the note, its preview screenshots and the latest saved project (`git pull`).
2. Reports the current step, status and time left (based on your recent runs) to the panel in Settings.
3. If Claude needs a decision it stops as **Blocked**; answer in the panel and the run resumes with your answer.
4. Tests the change, then writes the **result** on the note.

Cancel from the panel at any time. A run is stopped after `maxMinutes` (90 by default — edit
`%APPDATA%\ArchitectRunner\config.json`). `node architect-runner.mjs status` shows the setup;
`install-windows.ps1 -Uninstall` removes the background task; `node architect-runner.mjs forget` deletes the token.

Runs use `--permission-mode acceptEdits` with the tools in `allowedTools` (Read, Edit, Write, Glob, Grep, Bash, TodoWrite):
the runner only works inside your Architect folder, but Bash is allowed so it can test — narrow `allowedTools`
in the config if you want it stricter.
