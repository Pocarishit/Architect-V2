-- ============================================================
-- Architect · Nov 7 update: setpoint log + Parasites (shared problem board)
-- Run once in Supabase → SQL Editor, after schema.sql and accountability.sql. Safe to run again.
-- (Countdowns and Completion Meters save to your account settings — no tables needed.)
-- ============================================================

-- ---------- Setpoint log: how each setpoint stood when its timer ended ----------
create table if not exists public.setpoint_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day         date not null,          -- the setpoint-day (starts with your first setpoint)
  col_id      text not null,          -- the path
  title       text not null default '',
  total       int  not null default 0,
  done        int  not null default 0,
  "of"        int  not null default 0, -- how many setpoints you had that day
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, day, col_id)
);
create index if not exists setpoint_log_user_day on public.setpoint_log (user_id, day);
alter table public.setpoint_log enable row level security;

drop policy if exists "setpoint log: owner" on public.setpoint_log;
create policy "setpoint log: owner" on public.setpoint_log
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Accountability partners can read it (needs accountability.sql).
drop policy if exists "setpoint log: partners read" on public.setpoint_log;
create policy "setpoint log: partners read" on public.setpoint_log
  for select to authenticated using (public.can_view_tracker(user_id));

grant select, insert, update, delete on table public.setpoint_log to authenticated;

drop trigger if exists setpoint_log_touch on public.setpoint_log;
create trigger setpoint_log_touch before update on public.setpoint_log
  for each row execute function public.architect_touch();

-- ---------- Parasites: problems a team breaks through together ----------
-- Each member marks themselves "demonstrated". The wall breaks when every member has.
create table if not exists public.parasites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- creator
  title       text not null default '',
  detail      text not null default '',
  deadline    date,
  members     uuid[] not null default '{}',   -- everyone besides the creator
  checks      jsonb not null default '{}'::jsonb, -- { "<user id>": true }
  broken_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists parasites_members_idx on public.parasites using gin (members);
alter table public.parasites enable row level security;

drop policy if exists "parasites: members read" on public.parasites;
create policy "parasites: members read" on public.parasites
  for select to authenticated using (user_id = auth.uid() or auth.uid() = any (members));

drop policy if exists "parasites: create" on public.parasites;
create policy "parasites: create" on public.parasites
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "parasites: members edit" on public.parasites;
create policy "parasites: members edit" on public.parasites
  for update to authenticated using (user_id = auth.uid() or auth.uid() = any (members))
  with check (user_id = auth.uid() or auth.uid() = any (members));

drop policy if exists "parasites: creator deletes" on public.parasites;
create policy "parasites: creator deletes" on public.parasites
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on table public.parasites to authenticated;

drop trigger if exists parasites_touch on public.parasites;
create trigger parasites_touch before update on public.parasites
  for each row execute function public.architect_touch();

-- Mark yourself (only yourself) demonstrated or not — atomic, so two people can tick at once.
create or replace function public.parasite_check(p uuid, val boolean)
returns json language plpgsql security definer set search_path = public as $$
declare
  rec public.parasites;
  everyone uuid[];
  all_in boolean;
begin
  select * into rec from public.parasites where id = p;
  if rec.id is null or not (rec.user_id = auth.uid() or auth.uid() = any (rec.members)) then
    raise exception 'Not on this problem.' using errcode = '42501';
  end if;
  update public.parasites
     set checks = case when val then checks || jsonb_build_object(auth.uid()::text, true)
                       else checks - auth.uid()::text end
   where id = p
   returning * into rec;
  everyone := array_append(rec.members, rec.user_id);
  select bool_and(coalesce((rec.checks ->> m::text)::boolean, false)) into all_in from unnest(everyone) m;
  update public.parasites set broken_at = case when all_in then coalesce(broken_at, now()) else null end
   where id = p returning * into rec;
  return row_to_json(rec);
end $$;

-- Add someone to a problem by username (any member can).
create or replace function public.parasite_add(p uuid, uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  rec public.parasites;
  target uuid;
begin
  select * into rec from public.parasites where id = p;
  if rec.id is null or not (rec.user_id = auth.uid() or auth.uid() = any (rec.members)) then
    raise exception 'Not on this problem.' using errcode = '42501';
  end if;
  select id into target from public.profiles where username = lower(trim(uname));
  if target is null then raise exception 'No account called “%”.', uname using errcode = 'P0002'; end if;
  if target = rec.user_id or target = any (rec.members) then return row_to_json(rec); end if;
  update public.parasites set members = array_append(members, target), broken_at = null where id = p returning * into rec;
  return row_to_json(rec);
end $$;

-- Leave a problem (or, as its creator, remove someone).
create or replace function public.parasite_remove(p uuid, who uuid)
returns void language plpgsql security definer set search_path = public as $$
declare rec public.parasites;
begin
  select * into rec from public.parasites where id = p;
  if rec.id is null or not (who = auth.uid() or rec.user_id = auth.uid()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  update public.parasites set members = array_remove(members, who), checks = checks - who::text where id = p;
end $$;

-- Usernames of everyone on the problems you're part of.
create or replace function public.parasite_people()
returns table (user_id uuid, username text)
language sql stable security definer set search_path = public as $$
  select distinct pr.id, pr.username
  from public.parasites p
  cross join lateral unnest(array_append(p.members, p.user_id)) m
  join public.profiles pr on pr.id = m
  where p.user_id = auth.uid() or auth.uid() = any (p.members);
$$;

grant execute on function public.parasite_check(uuid, boolean), public.parasite_add(uuid, text),
  public.parasite_remove(uuid, uuid), public.parasite_people() to authenticated;
