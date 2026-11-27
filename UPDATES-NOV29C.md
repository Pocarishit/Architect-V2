# Nov 29c: Variables save to your account again

1. Supabase → SQL Editor → run `supabase/nov29c.sql` (safe to re-run). It gives signed-in users access to `architect_variables` (and `shared_items`). RLS still limits each person to their own rows.
2. Copy `js/data/myvars.js` and `sw.js` over the repo, then push. sw.js version: architect-shell-2026-11-29c.

- Before this, if your account couldn't be reached, Variables kept saving to the device only. On the next reload the older account copy then replaced those edits.
- Now edits saved on the device are newer than the account copy, so they are kept and uploaded as soon as the account is reachable. Nothing done locally is lost.
