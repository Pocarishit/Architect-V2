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

-- ---------- Shared countdowns + completion meters ----------
-- kind = 'countdown' | 'meter'. The creator and everyone in `members` can see and edit it.
create table if not exists public.shared_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- creator
  kind        text not null check (kind in ('countdown', 'meter')),
  data        jsonb not null default '{}'::jsonb,
  members     uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists shared_items_members_idx on public.shared_items using gin (members);
alter table public.shared_items enable row level security;

drop policy if exists "shared items: members read" on public.shared_items;
create policy "shared items: members read" on public.shared_items
  for select to authenticated using (user_id = auth.uid() or auth.uid() = any (members));
drop policy if exists "shared items: create" on public.shared_items;
create policy "shared items: create" on public.shared_items
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "shared items: members edit" on public.shared_items;
create policy "shared items: members edit" on public.shared_items
  for update to authenticated using (user_id = auth.uid() or auth.uid() = any (members))
  with check (user_id = auth.uid() or auth.uid() = any (members));
drop policy if exists "shared items: creator deletes" on public.shared_items;
create policy "shared items: creator deletes" on public.shared_items
  for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on table public.shared_items to authenticated;

drop trigger if exists shared_items_touch on public.shared_items;
create trigger shared_items_touch before update on public.shared_items
  for each row execute function public.architect_touch();

create or replace function public.shared_add(item uuid, uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  rec public.shared_items;
  target uuid;
begin
  select * into rec from public.shared_items where id = item;
  if rec.id is null or not (rec.user_id = auth.uid() or auth.uid() = any (rec.members)) then
    raise exception 'Not shared with you.' using errcode = '42501';
  end if;
  select id into target from public.profiles where username = lower(trim(uname));
  if target is null then raise exception 'No account called “%”.', uname using errcode = 'P0002'; end if;
  if target = rec.user_id or target = any (rec.members) then return row_to_json(rec); end if;
  update public.shared_items set members = array_append(members, target) where id = item returning * into rec;
  return row_to_json(rec);
end $$;

create or replace function public.shared_remove(item uuid, who uuid)
returns void language plpgsql security definer set search_path = public as $$
declare rec public.shared_items;
begin
  select * into rec from public.shared_items where id = item;
  if rec.id is null or not (who = auth.uid() or rec.user_id = auth.uid()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  update public.shared_items set members = array_remove(members, who) where id = item;
end $$;

create or replace function public.shared_people()
returns table (user_id uuid, username text)
language sql stable security definer set search_path = public as $$
  select distinct pr.id, pr.username
  from public.shared_items s
  cross join lateral unnest(array_append(s.members, s.user_id)) m
  join public.profiles pr on pr.id = m
  where s.user_id = auth.uid() or auth.uid() = any (s.members);
$$;

grant execute on function public.shared_add(uuid, text), public.shared_remove(uuid, uuid), public.shared_people() to authenticated;

-- ---------- Parasite tickets: a chat per problem ----------
create table if not exists public.parasite_messages (
  id           uuid primary key default gen_random_uuid(),
  parasite_id  uuid not null references public.parasites (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);
create index if not exists parasite_messages_ticket_idx on public.parasite_messages (parasite_id, created_at);
alter table public.parasite_messages enable row level security;

create or replace function public.on_parasite(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.parasites where id = p and (user_id = auth.uid() or auth.uid() = any (members)));
$$;

drop policy if exists "parasite messages: read" on public.parasite_messages;
create policy "parasite messages: read" on public.parasite_messages
  for select to authenticated using (public.on_parasite(parasite_id));
drop policy if exists "parasite messages: write" on public.parasite_messages;
create policy "parasite messages: write" on public.parasite_messages
  for insert to authenticated with check (user_id = auth.uid() and public.on_parasite(parasite_id));
drop policy if exists "parasite messages: delete own" on public.parasite_messages;
create policy "parasite messages: delete own" on public.parasite_messages
  for delete to authenticated using (user_id = auth.uid());
grant select, insert, delete on table public.parasite_messages to authenticated;
grant execute on function public.on_parasite(uuid) to authenticated;

-- ---------- Parasites as tickets: status, labels, attempts, history ----------
alter table public.parasites add column if not exists status text not null default 'open';
alter table public.parasites add column if not exists labels text[] not null default '{}';
update public.parasites set status = 'solved' where broken_at is not null and status = 'open';
alter table public.parasite_messages add column if not exists kind text not null default 'msg';   -- msg | attempt | event
alter table public.parasite_messages add column if not exists outcome text;                         -- failed | partial | worked
