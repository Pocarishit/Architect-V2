-- Architect — Nov 29c fix: Variables not saving to your account.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Signed-in users need table privileges on the Variables tables; without them every read/write is
-- refused ("permission denied") and the app keeps your Variables on the device only.
-- Row-level security still applies: each person can only reach their own rows.

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

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.architect_variables to authenticated;
grant select, insert, update, delete on public.shared_items to authenticated;

notify pgrst, 'reload schema';
