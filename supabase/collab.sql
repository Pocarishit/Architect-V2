-- ============================================================
-- Architect · Live collaboration on Blueprint boards
-- Run once in Supabase → SQL Editor (safe to run again).
-- Adds: usernames for invites, board members, access rules,
-- live channels (cursors + edits) and shared media access.
-- ============================================================

-- ---------- 1. Usernames (so you can invite people by name) ----------
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

-- Existing accounts
insert into public.profiles (id, username)
select id, lower(coalesce(raw_user_meta_data->>'username', split_part(email, '@', 1)))
from auth.users
on conflict do nothing;

-- ---------- 2. Board members ----------
-- board_id matches whatever type blueprints.id already uses.
do $$
declare t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
  from pg_attribute a
  where a.attrelid = 'public.blueprints'::regclass and a.attname = 'id' and not a.attisdropped;
  execute format($f$
    create table if not exists public.blueprint_members (
      board_id %s not null references public.blueprints(id) on delete cascade,
      user_id uuid not null references auth.users(id) on delete cascade,
      added_by uuid references auth.users(id) on delete set null,
      created_at timestamptz not null default now(),
      primary key (board_id, user_id)
    )$f$, t);
end $$;
create index if not exists blueprint_members_user_idx on public.blueprint_members (user_id);
alter table public.blueprint_members enable row level security;

-- ---------- 3. Helpers (security definer, so policies don't loop) ----------
create or replace function public.owns_board(b text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blueprints where id::text = b and user_id = auth.uid());
$$;

create or replace function public.is_board_member(b text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blueprint_members where board_id::text = b and user_id = auth.uid());
$$;

create or replace function public.can_access_board(b text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.owns_board(b) or public.is_board_member(b);
$$;

-- True when the signed-in person and `other` are on at least one board together.
create or replace function public.shares_board_with(other text)
returns boolean language sql stable security definer set search_path = public as $$
  with people as (
    select id::text as board, user_id from public.blueprints
    union all
    select board_id::text, user_id from public.blueprint_members
  )
  select exists (
    select 1 from people a join people b on a.board = b.board
    where a.user_id = auth.uid() and b.user_id::text = other
  );
$$;

-- ---------- 4. Access rules ----------
-- Profiles: yourself, and people you share a board with.
drop policy if exists "profiles: self and collaborators" on public.profiles;
create policy "profiles: self and collaborators" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_board_with(id::text));

-- Members: the board owner sees and removes everyone; members see themselves and can leave.
drop policy if exists "members: read" on public.blueprint_members;
create policy "members: read" on public.blueprint_members
  for select to authenticated
  using (user_id = auth.uid() or public.owns_board(board_id::text));

drop policy if exists "members: remove or leave" on public.blueprint_members;
create policy "members: remove or leave" on public.blueprint_members
  for delete to authenticated
  using (user_id = auth.uid() or public.owns_board(board_id::text));

-- Boards: members can open and edit (your existing owner rules stay as they are).
drop policy if exists "blueprints: members read" on public.blueprints;
create policy "blueprints: members read" on public.blueprints
  for select to authenticated
  using (public.is_board_member(id::text));

drop policy if exists "blueprints: members edit" on public.blueprints;
create policy "blueprints: members edit" on public.blueprints
  for update to authenticated
  using (public.is_board_member(id::text))
  with check (public.is_board_member(id::text));

-- Members may edit the content and name, but only the owner can move, pin or hand over a board.
create or replace function public.blueprints_member_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and old.user_id is distinct from auth.uid() then
    if new.user_id is distinct from old.user_id
       or new.folder_id is distinct from old.folder_id
       or new.pinned is distinct from old.pinned then
      raise exception 'Only the board owner can move or pin this board.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists blueprints_member_guard on public.blueprints;
create trigger blueprints_member_guard
  before update on public.blueprints for each row execute function public.blueprints_member_guard();

-- ---------- 5. Sharing actions ----------
create or replace function public.share_board(b text, uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  name text := lower(trim(uname));
begin
  if not public.owns_board(b) then
    raise exception 'Only the board owner can invite people.' using errcode = '42501';
  end if;
  select id into target from public.profiles where username = name;
  if target is null then
    raise exception 'No account called “%”.', uname using errcode = 'P0002';
  end if;
  if target = auth.uid() then
    raise exception 'That’s you — you already own this board.' using errcode = '22023';
  end if;
  insert into public.blueprint_members (board_id, user_id, added_by)
  select id, target, auth.uid() from public.blueprints where id::text = b
  on conflict do nothing;
  return json_build_object('user_id', target, 'username', name);
end $$;

create or replace function public.board_people(b text)
returns table (user_id uuid, username text, role text)
language sql stable security definer set search_path = public as $$
  select bp.user_id, p.username, 'owner'::text
  from public.blueprints bp left join public.profiles p on p.id = bp.user_id
  where bp.id::text = b and public.can_access_board(b)
  union all
  select m.user_id, p.username, 'editor'::text
  from public.blueprint_members m left join public.profiles p on p.id = m.user_id
  where m.board_id::text = b and public.can_access_board(b);
$$;

revoke all on function public.share_board(text, text) from public, anon;
revoke all on function public.board_people(text) from public, anon;
grant execute on function public.share_board(text, text) to authenticated;
grant execute on function public.board_people(text) to authenticated;
grant execute on function public.owns_board(text), public.is_board_member(text),
  public.can_access_board(text), public.shares_board_with(text) to authenticated;
grant select, delete on public.blueprint_members to authenticated;
grant select on public.profiles to authenticated;

-- ---------- 6. Live channels: only people on the board can join "board:<id>" ----------
drop policy if exists "architect: board channel read" on realtime.messages;
create policy "architect: board channel read" on realtime.messages
  for select to authenticated
  using (realtime.topic() like 'board:%' and public.can_access_board(substr(realtime.topic(), 7)));

drop policy if exists "architect: board channel write" on realtime.messages;
create policy "architect: board channel write" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() like 'board:%' and public.can_access_board(substr(realtime.topic(), 7)));

-- ---------- 7. Media: collaborators can see images and videos on shared boards ----------
-- Files live at <uploader id>/<file>. Change the bucket name if yours isn't 'architect-media'.
drop policy if exists "architect: collaborators read media" on storage.objects;
create policy "architect: collaborators read media" on storage.objects
  for select to authenticated
  using (bucket_id = 'architect-media' and public.shares_board_with((storage.foldername(name))[1]));
