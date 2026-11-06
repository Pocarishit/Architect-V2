-- ============================================================
-- Architect · Tracker accountability (partners + day comments)
-- Run once in Supabase → SQL Editor, after schema.sql (safe to run again).
-- Adding someone by username shares YOUR tracker with THEM.
-- They see yours once you add them; you see theirs once they add you.
-- ============================================================

-- ---------- Usernames (same as collab.sql — harmless if it already ran) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique
);
alter table public.profiles enable row level security;

create or replace function public.handle_new_user_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))))
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users for each row execute function public.handle_new_user_profile();

insert into public.profiles (id, username)
select id, lower(coalesce(raw_user_meta_data->>'username', split_part(email, '@', 1)))
from auth.users
on conflict do nothing;

drop policy if exists "profiles: self" on public.profiles;
create policy "profiles: self" on public.profiles
  for select to authenticated using (id = auth.uid());

-- ---------- Who can see whose tracker ----------
create table if not exists public.tracker_shares (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, viewer_id),
  check (owner_id <> viewer_id)
);
create index if not exists tracker_shares_viewer_idx on public.tracker_shares (viewer_id);
alter table public.tracker_shares enable row level security;

drop policy if exists "tracker shares: read own" on public.tracker_shares;
create policy "tracker shares: read own" on public.tracker_shares
  for select to authenticated using (owner_id = auth.uid() or viewer_id = auth.uid());

drop policy if exists "tracker shares: stop or leave" on public.tracker_shares;
create policy "tracker shares: stop or leave" on public.tracker_shares
  for delete to authenticated using (owner_id = auth.uid() or viewer_id = auth.uid());

grant select, delete on table public.tracker_shares to authenticated;

create or replace function public.can_view_tracker(o uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select o = auth.uid()
      or exists (select 1 from public.tracker_shares where owner_id = o and viewer_id = auth.uid());
$$;

create or replace function public.tracker_partner_of(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tracker_shares
    where (owner_id = auth.uid() and viewer_id = other) or (owner_id = other and viewer_id = auth.uid())
  );
$$;

-- Partners can see each other's usernames.
drop policy if exists "profiles: tracker partners" on public.profiles;
create policy "profiles: tracker partners" on public.profiles
  for select to authenticated using (public.tracker_partner_of(id));

-- Partners can read (never change) your tracker days and tracker settings.
drop policy if exists "streak days: partners read" on public.streak_days;
create policy "streak days: partners read" on public.streak_days
  for select to authenticated using (public.can_view_tracker(user_id));

drop policy if exists "prefs: partners read" on public.architect_prefs;
create policy "prefs: partners read" on public.architect_prefs
  for select to authenticated using (public.can_view_tracker(user_id));

-- ---------- Comments on a day ----------
-- user_id = who wrote it, owner_id = whose tracker day it's on.
create table if not exists public.tracker_comments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists tracker_comments_owner_idx on public.tracker_comments (owner_id, day);
alter table public.tracker_comments enable row level security;

drop policy if exists "comments: read" on public.tracker_comments;
create policy "comments: read" on public.tracker_comments
  for select to authenticated using (public.can_view_tracker(owner_id));

drop policy if exists "comments: write" on public.tracker_comments;
create policy "comments: write" on public.tracker_comments
  for insert to authenticated with check (user_id = auth.uid() and public.can_view_tracker(owner_id));

drop policy if exists "comments: delete" on public.tracker_comments;
create policy "comments: delete" on public.tracker_comments
  for delete to authenticated using (user_id = auth.uid() or owner_id = auth.uid());

grant select, insert, delete on table public.tracker_comments to authenticated;

-- ---------- Actions ----------
create or replace function public.share_tracker(uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  name text := lower(trim(uname));
begin
  select id into target from public.profiles where username = name;
  if target is null then
    raise exception 'No account called “%”.', uname using errcode = 'P0002';
  end if;
  if target = auth.uid() then
    raise exception 'That’s you.' using errcode = '22023';
  end if;
  insert into public.tracker_shares (owner_id, viewer_id) values (auth.uid(), target) on conflict do nothing;
  return json_build_object('user_id', target, 'username', name);
end $$;

-- Everyone connected to you: whether they see you, and whether you see them.
create or replace function public.tracker_partners()
returns table (user_id uuid, username text, sees_me boolean, i_see boolean)
language sql stable security definer set search_path = public as $$
  with links as (
    select viewer_id as other, true as sees_me, false as i_see from public.tracker_shares where owner_id = auth.uid()
    union all
    select owner_id, false, true from public.tracker_shares where viewer_id = auth.uid()
  )
  select l.other, p.username, bool_or(l.sees_me), bool_or(l.i_see)
  from links l left join public.profiles p on p.id = l.other
  group by l.other, p.username
  order by p.username;
$$;

create or replace function public.unshare_tracker(other uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.tracker_shares where owner_id = auth.uid() and viewer_id = other;
$$;

create or replace function public.leave_tracker(other uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.tracker_shares where owner_id = other and viewer_id = auth.uid();
$$;

grant execute on function public.share_tracker(text), public.tracker_partners(),
  public.unshare_tracker(uuid), public.leave_tracker(uuid), public.can_view_tracker(uuid), public.tracker_partner_of(uuid)
  to authenticated;
