drop database if exists axtest;
create database axtest;
\c axtest
create schema auth; create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, extensions, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create table public.profiles (id uuid primary key references auth.users, username text);
grant select on public.profiles to authenticated;
create or replace function public.architect_touch() returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;
create table public.path_columns (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users, title text, position double precision default 0, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.architect_prefs (id uuid primary key default gen_random_uuid(), user_id uuid unique references auth.users, data jsonb not null default '{}');
create table public.architect_variables (id uuid primary key default gen_random_uuid(), user_id uuid unique references auth.users, data jsonb not null default '{}');
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
insert into public.profiles values ('11111111-1111-1111-1111-111111111111', 'hiru'), ('22222222-2222-2222-2222-222222222222', 'maveri');
insert into public.path_columns (id, user_id, title, position) values
 ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Morning', 1),
 ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Afternoon', 2),
 ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Morning', 1);
insert into public.architect_prefs (user_id, data) values ('11111111-1111-1111-1111-111111111111', '{"pathTimes":{"aaaaaaaa-0000-0000-0000-000000000001":{"start":"06:00","end":"13:00"}}}');
