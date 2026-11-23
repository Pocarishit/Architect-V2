-- Architect — Nov 23 update (Desktop Sidebar: shared Variables categories)
-- Run once in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Lets a Variables category be shared with the people in your shared Space (shared_items kind 'varcat').
-- Nothing else changes: the same member-only read/edit rules as Countdowns and Meters apply.

alter table public.shared_items drop constraint if exists shared_items_kind_check;
alter table public.shared_items add constraint shared_items_kind_check
  check (kind in ('countdown', 'meter', 'varcat'));

-- Keep updated_at honest on shared rows (used to skip unchanged rows).
drop trigger if exists shared_items_touch on public.shared_items;
create trigger shared_items_touch before update on public.shared_items
  for each row execute function public.architect_touch();
