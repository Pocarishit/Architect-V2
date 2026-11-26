-- Architect — Nov 27 update (optional). Run once in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Lets either member of a shared Variables space delete it, whoever created it.
-- The app already works without this (a member's delete marks the space deleted and the owner's devices
-- remove it on their next sync); with it, the shared row is removed at once.
drop policy if exists "shared items: members delete varcat" on public.shared_items;
create policy "shared items: members delete varcat" on public.shared_items
  for delete to authenticated using (kind = 'varcat' and (user_id = auth.uid() or auth.uid() = any (members)));
