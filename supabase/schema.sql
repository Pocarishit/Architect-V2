-- Architect — Supabase schema
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it only creates what is missing and refreshes policies.

-- ─────────────────────────────────────────────
-- Shared trigger: keep updated_at current
-- ─────────────────────────────────────────────
create or replace function public.architect_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────
-- Paths (kanban)
-- ─────────────────────────────────────────────
create table if not exists public.path_columns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'Untitled',
  position    double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.path_tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  column_id   uuid not null references public.path_columns (id) on delete cascade,
  title       text not null default '',
  note        text not null default '',
  done        boolean not null default false,
  position    double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists path_columns_user_idx on public.path_columns (user_id, position);
create index if not exists path_tasks_user_idx   on public.path_tasks (user_id, column_id, position);

-- ─────────────────────────────────────────────
-- Blueprint (boards) + Archives (folders)
-- ─────────────────────────────────────────────
create table if not exists public.archive_folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  parent_id   uuid references public.archive_folders (id) on delete set null,
  name        text not null default 'New folder',
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.blueprints (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id   uuid references public.archive_folders (id) on delete set null,
  name        text not null default 'Untitled',
  pinned      boolean not null default false,
  data        jsonb not null default '{"v":1,"elements":[]}'::jsonb,
  preview     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists archive_folders_user_idx on public.archive_folders (user_id, parent_id);
create index if not exists blueprints_user_idx      on public.blueprints (user_id, folder_id, updated_at desc);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['path_columns', 'path_tasks', 'archive_folders', 'blueprints'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.architect_touch()', t || '_touch', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────
-- Row Level Security: every row belongs to exactly one user
-- ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['path_columns', 'path_tasks', 'archive_folders', 'blueprints'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "architect owner access" on public.%I', t);
    execute format(
      'create policy "architect owner access" on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────
-- Storage: private bucket for images / videos on boards
-- Files live under  <user id>/<file>  and only their owner can touch them.
-- ─────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('architect-media', 'architect-media', false)
on conflict (id) do nothing;

drop policy if exists "architect media read"   on storage.objects;
drop policy if exists "architect media insert" on storage.objects;
drop policy if exists "architect media update" on storage.objects;
drop policy if exists "architect media delete" on storage.objects;

create policy "architect media read" on storage.objects for select to authenticated
  using (bucket_id = 'architect-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "architect media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'architect-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "architect media update" on storage.objects for update to authenticated
  using (bucket_id = 'architect-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "architect media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'architect-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
