# Architect update — 2026-11-28

Fixes the Variables outage and adds a scoped agent token API.

## Files

| Path in this zip | Repo path | Change |
|---|---|---|
| `js/data/myvars.js` | `js/data/myvars.js` | Replace. Only the two load blocks changed (newer local copy wins instead of being overwritten). |
| `js/data/myvars.js.patch` | — | Same change as a valid unified diff (`git apply js/data/myvars.js.patch`). Use this if `myvars.js` changed in the repo after Nov 25. |
| `supabase/variables.sql` | `supabase/variables.sql` | Replace. Adds the missing `GRANT`. |
| `supabase/agent.sql` | `supabase/agent.sql` | New. The grant fix + agent API. |
| `docs/AGENT_API.md` | `docs/AGENT_API.md` | New. Token contract and actions. |

Nothing is deleted or renamed. Paths mirror the repo, so you can copy the folder contents over the repo root.

## Ship order

1. **Supabase → SQL Editor → run `supabase/agent.sql`.** Safe to re-run. This alone ends the outage.
2. **Commit + push the files above** → Vercel deploys.
3. **Optional:** on the device that still shows your Variables, just make any small edit — the patched client pushes its newer copy up.
4. **Optional:** mint an agent token (see `docs/AGENT_API.md`).

## Before pushing

- Check the last commit on `js/data/myvars.js`. If it's the Nov 25 update or older → copy the file. If newer → use `git apply` with the patch instead.

## Heads-up

`agent.sql` sets default privileges so future `public` tables are readable/writable by signed-in users. Always enable RLS + a policy on every new table.

## Verify

- `GET /rest/v1/architect_variables?select=*` with a session → 200, not 403.
- A fresh browser shows the same Variables as your main one.
- An edit on one device shows on another within ~15 s.
