-- Architect — Variables on your account (Nov 17, patched 2026-11-27)
-- Run once in Supabase -> SQL Editor -> New query -> Run. Safe to re-run.
-- One row per person. Only the owner can read or write it: no partner, board or share access,
-- so in the shared Space everyone sees only their own.
--
-- 2026-11-27: the table shipped with RLS but no GRANT, so `authenticated` was refused with
-- 42501 ("permission denied for table architect_variables"). Every device without a local
-- copy showed empty Variables, and no save could land. The grant below is the fix.

create table if not exists public.architect_variables (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.architect_variables enable row level security;

drop policy if exists "architect_variables: owner" on public.architect_variables;
create policy "architect_variables: owner" on public.architect_variables
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The missing half: a policy decides WHICH rows, a grant decides whether you may touch the table.
grant select, insert, update, delete on public.architect_variables to authenticated;

create index if not exists architect_variables_user_idx on public.architect_variables (user_id);
