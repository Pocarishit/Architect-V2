-- Architect — Variables fix + Agent access (2026-11-27)
-- Run once in Supabase -> SQL Editor -> New query -> Run. Safe to re-run.
--
-- 1. Fixes the Variables outage: architect_variables had RLS but no GRANT, so every device
--    without a local cache read an empty Variables and no save could land (42501).
-- 2. Adds a scoped token API so an agent can read and write one account's own rows,
--    the same shape as the Anytype connector (token arg, security definer, hashed token).

-- =====================================================================================
-- 1. The grant that was missing.
-- =====================================================================================
grant select, insert, update, delete on public.architect_variables to authenticated;

-- Future tables in public must never repeat this. Wrapped so a project whose owner role can't set
-- default privileges still gets the sweep below instead of aborting the script.
do $$ begin
  execute 'alter default privileges in schema public grant select, insert, update, delete on tables to authenticated';
exception when others then raise notice 'default privileges skipped: %', sqlerrm;
end $$;

-- And sweep what already exists — but only tables that have RLS enabled, since RLS is what
-- keeps one account's rows away from another's. A table with RLS off stays untouched.
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t.relname);
  end loop;
end $$;

-- =====================================================================================
-- 2. Agent tokens — one row per agent, hashed, revocable, scoped.
-- =====================================================================================
create table if not exists public.architect_agents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'Agent',
  token_hash   text not null unique,
  scopes       text[] not null default array['vars','path','boards','read'],
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists architect_agents_user_idx on public.architect_agents (user_id, revoked_at);

alter table public.architect_agents enable row level security;
drop policy if exists "architect_agents: owner" on public.architect_agents;
create policy "architect_agents: owner" on public.architect_agents
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.architect_agent_log (
  id        bigserial primary key,
  agent_id  uuid not null references public.architect_agents (id) on delete cascade,
  user_id   uuid not null,
  action    text not null,
  detail    jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now()
);

alter table public.architect_agent_log enable row level security;
drop policy if exists "architect_agent_log: owner" on public.architect_agent_log;
create policy "architect_agent_log: owner" on public.architect_agent_log
  for select to authenticated using (user_id = auth.uid());

create index if not exists architect_agent_log_agent_idx on public.architect_agent_log (agent_id, at desc);

create or replace function public.architect_agent__hash(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(digest(convert_to(coalesce(t, ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- The agent behind a token (raises when unknown or revoked). Touches last_seen_at.
create or replace function public.architect_agent__who(token text) returns public.architect_agents
language plpgsql security definer set search_path = public, extensions as $$
declare a public.architect_agents;
begin
  select * into a from public.architect_agents where token_hash = public.architect_agent__hash(token);
  if a.id is null or a.revoked_at is not null then
    raise exception 'agent_revoked' using errcode = '28000',
      hint = 'Mint a new token in Architect -> Settings -> Agent access.';
  end if;
  update public.architect_agents set last_seen_at = now() where id = a.id;
  return a;
end $$;
revoke all on function public.architect_agent__who(text) from public, anon, authenticated;

-- From the signed-in app: mint a token for an agent. The raw token is never stored, only its hash.
create or replace function public.architect_agent_mint(p_name text, p_token text, p_scopes text[] default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid();
  a  public.architect_agents;
  n  int;
begin
  if me is null then raise exception 'sign_in_first' using errcode = '28000'; end if;
  if length(coalesce(p_token, '')) < 32 then
    raise exception 'token_too_short' using errcode = '22023', hint = 'Use 32+ random characters.';
  end if;
  select count(*) into n from public.architect_agents where user_id = me and revoked_at is null;
  if n >= 10 then raise exception 'too_many_agents' using errcode = '54000', hint = 'Revoke one first.'; end if;
  insert into public.architect_agents (user_id, name, token_hash, scopes)
  values (me, coalesce(nullif(btrim(p_name), ''), 'Agent'), public.architect_agent__hash(p_token),
          coalesce(p_scopes, array['vars','path','boards','read']))
  on conflict (token_hash) do nothing
  returning * into a;
  if a.id is null then raise exception 'token_in_use' using errcode = '23505'; end if;
  return jsonb_build_object('id', a.id, 'name', a.name, 'scopes', a.scopes, 'created_at', a.created_at);
end $$;

create or replace function public.architect_agent_list() returns jsonb
language sql security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'scopes', scopes,
         'created_at', created_at, 'last_seen_at', last_seen_at)), '[]'::jsonb)
  from public.architect_agents where user_id = auth.uid() and revoked_at is null;
$$;

create or replace function public.architect_agent_revoke(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.architect_agents set revoked_at = now() where id = p_id and user_id = auth.uid() and revoked_at is null;
  return found;
end $$;

revoke all on function public.architect_agent_mint(text, text, text[]) from public, anon;
revoke all on function public.architect_agent_list() from public, anon;
revoke all on function public.architect_agent_revoke(uuid) from public, anon;
grant execute on function public.architect_agent_mint(text, text, text[]) to authenticated;
grant execute on function public.architect_agent_list() to authenticated;
grant execute on function public.architect_agent_revoke(uuid) to authenticated;

-- =====================================================================================
-- 3. The agent surface itself.
--    Everything is scoped to the token's own user_id; tables are never taken from input
--    except the read-only allowlist below.
-- =====================================================================================
create or replace function public.architect_agent_call(p_token text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a    public.architect_agents;
  me   uuid;
  act  text := lower(btrim(coalesce(p_action, '')));
  arg  jsonb := coalesce(p_args, '{}'::jsonb);
  res  jsonb;
  d    jsonb;
  tbl  text;
  filt text := '';
  q    text;
  lim  int;
  cid  uuid;
  bid  uuid;
  tid  uuid;
  k    text;
  w    text;
begin
  a := public.architect_agent__who(p_token);
  me := a.user_id;

  -- Audit: writes only, never the payload itself.
  if act not in ('me', 'vars.get', 'path.get', 'board.list', 'board.get', 'read') then
    insert into public.architect_agent_log (agent_id, user_id, action, detail)
    values (a.id, me, act,
            jsonb_build_object('keys', coalesce((select jsonb_agg(k) from jsonb_object_keys(arg) k), '[]'::jsonb)));
  end if;

  if act = 'me' then
    return jsonb_build_object('user_id', me, 'name', a.name, 'scopes', a.scopes);

  elsif act = 'vars.get' then
    select jsonb_build_object('data', v.data, 'updated_at', v.updated_at) into res
      from public.architect_variables v where v.user_id = me;
    return res;

  elsif act = 'vars.put' or act = 'vars.patch' then
    if not ('vars' = any (a.scopes)) then raise exception 'scope_missing: vars' using errcode = '42501'; end if;
    d := arg->'data';
    if d is null or jsonb_typeof(d) <> 'object' then raise exception 'data_object_required' using errcode = '22023'; end if;
    if act = 'vars.patch' then
      select coalesce(v.data, '{}'::jsonb) || d into d from public.architect_variables v where v.user_id = me;
      d := coalesce(d, arg->'data');
    end if;
    if arg ? 'if_rev' then
      if exists (select 1 from public.architect_variables v where v.user_id = me
                 and coalesce((v.data->>'rev')::bigint, 0) <> (arg->>'if_rev')::bigint) then
        raise exception 'rev_conflict' using errcode = '40001', hint = 'Read vars.get and retry.';
      end if;
    end if;
    d := d || jsonb_build_object('rev', (extract(epoch from clock_timestamp()) * 1000)::bigint);
    insert into public.architect_variables (user_id, data, updated_at)
    values (me, d, now())
    on conflict (user_id) do update set data = excluded.data, updated_at = now()
    returning jsonb_build_object('rev', data->'rev', 'updated_at', updated_at) into res;
    return res;

  elsif act = 'path.get' then
    return jsonb_build_object(
      'columns', coalesce((select jsonb_agg(to_jsonb(c) order by c.position, c.created_at) from public.path_columns c where c.user_id = me), '[]'::jsonb),
      'tasks',   coalesce((select jsonb_agg(to_jsonb(t) order by t.position, t.created_at) from public.path_tasks t where t.user_id = me), '[]'::jsonb));

  elsif act = 'path.column.add' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    insert into public.path_columns (user_id, title, position)
    values (me, coalesce(nullif(btrim(arg->>'title'), ''), 'Untitled'),
            coalesce((arg->>'position')::double precision, extract(epoch from now())::double precision))
    returning to_jsonb(path_columns) into res;
    return res;

  elsif act = 'path.column.update' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    cid := nullif(arg->>'id', '')::uuid;
    update public.path_columns c set
      title = coalesce(arg->>'title', c.title),
      position = coalesce((arg->>'position')::double precision, c.position),
      updated_at = now()
    where c.id = cid and c.user_id = me
    returning to_jsonb(c) into res;
    if res is null then raise exception 'column_not_found' using errcode = 'P0002'; end if;
    return res;

  elsif act = 'path.column.delete' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    delete from public.path_columns c
     where c.id = (arg->>'id')::uuid and c.user_id = me
     returning jsonb_build_object('deleted', true, 'id', c.id) into res;
    return coalesce(res, jsonb_build_object('deleted', false));

  elsif act = 'path.task.add' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    cid := nullif(arg->>'column_id', '')::uuid;
    if cid is null or not exists (select 1 from public.path_columns c where c.id = cid and c.user_id = me) then
      raise exception 'column_not_found' using errcode = '22023', hint = 'Pass a column_id from path.get.';
    end if;
    insert into public.path_tasks (user_id, column_id, title, note, done, position)
    values (me, cid, coalesce(nullif(btrim(arg->>'title'), ''), 'Untitled'), coalesce(arg->>'note', ''),
            coalesce((arg->>'done')::boolean, false),
            coalesce((arg->>'position')::double precision, extract(epoch from now())::double precision))
    returning to_jsonb(path_tasks) into res;
    return res;

  elsif act = 'path.task.update' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    tid := nullif(arg->>'id', '')::uuid;
    update public.path_tasks t set
      title = coalesce(arg->>'title', t.title),
      note = coalesce(arg->>'note', t.note),
      done = coalesce((arg->>'done')::boolean, t.done),
      position = coalesce((arg->>'position')::double precision, t.position),
      column_id = coalesce(nullif(arg->>'column_id', '')::uuid, t.column_id),
      updated_at = now()
    where t.id = tid and t.user_id = me
    returning to_jsonb(t) into res;
    if res is null then raise exception 'task_not_found' using errcode = 'P0002'; end if;
    return res;

  elsif act = 'path.task.delete' then
    if not ('path' = any (a.scopes)) then raise exception 'scope_missing: path' using errcode = '42501'; end if;
    delete from public.path_tasks t
     where t.id = (arg->>'id')::uuid and t.user_id = me
     returning jsonb_build_object('deleted', true, 'id', t.id) into res;
    return coalesce(res, jsonb_build_object('deleted', false));

  elsif act = 'board.list' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'folder_id', b.folder_id,
           'pinned', b.pinned, 'updated_at', b.updated_at) order by b.updated_at desc)
           from public.blueprints b where b.user_id = me), '[]'::jsonb);

  elsif act = 'board.get' then
    bid := nullif(arg->>'id', '')::uuid;
    select to_jsonb(b) into res from public.blueprints b where b.id = bid and b.user_id = me;
    return res;

  elsif act = 'board.put' then
    if not ('boards' = any (a.scopes)) then raise exception 'scope_missing: boards' using errcode = '42501'; end if;
    bid := nullif(arg->>'id', '')::uuid;
    if bid is null then
      insert into public.blueprints (user_id, name, folder_id, data, preview, pinned)
      values (me, coalesce(nullif(btrim(arg->>'name'), ''), 'Untitled'), nullif(arg->>'folder_id', '')::uuid,
              coalesce(arg->'data', '{"v":1,"elements":[]}'::jsonb), coalesce(arg->'preview', '[]'::jsonb),
              coalesce((arg->>'pinned')::boolean, false))
      returning to_jsonb(blueprints) into res;
    else
      update public.blueprints b set
        name = coalesce(arg->>'name', b.name),
        folder_id = coalesce(nullif(arg->>'folder_id', '')::uuid, b.folder_id),
        data = coalesce(arg->'data', b.data),
        preview = coalesce(arg->'preview', b.preview),
        pinned = coalesce((arg->>'pinned')::boolean, b.pinned),
        updated_at = now()
      where b.id = bid and b.user_id = me
      returning to_jsonb(b) into res;
    end if;
    if res is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;
    return res;

  elsif act = 'board.append' then
    if not ('boards' = any (a.scopes)) then raise exception 'scope_missing: boards' using errcode = '42501'; end if;
    bid := nullif(arg->>'id', '')::uuid;
    update public.blueprints b
       set data = jsonb_set(b.data, '{elements}',
             coalesce(b.data->'elements', '[]'::jsonb) || coalesce(arg->'elements', '[]'::jsonb)),
           updated_at = now()
     where b.id = bid and b.user_id = me
     returning jsonb_build_object('id', b.id, 'elements', jsonb_array_length(b.data->'elements')) into res;
    return res;

  elsif act = 'read' then
    if not ('read' = any (a.scopes)) then raise exception 'scope_missing: read' using errcode = '42501'; end if;
    tbl := arg->>'table';
    if tbl is null or not (tbl = any (array['architect_variables','path_columns','path_tasks','blueprints',
         'archive_folders','streak_days','architect_prefs'])) then
      raise exception 'table_not_allowed' using errcode = '22023',
        hint = 'architect_variables, path_columns, path_tasks, blueprints, archive_folders, streak_days, architect_prefs.';
    end if;
    if arg ? 'where' then
      for k, w in select * from jsonb_each_text(arg->'where') loop
        filt := filt || format(' and %I = %L', k, w);
      end loop;
    end if;
    lim := least(greatest(coalesce((arg->>'limit')::int, 200), 1), 1000);
    q := format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select * from public.%I where user_id = $1%s limit %s) x', tbl, filt, lim);
    execute q into res using me;
    return res;
  end if;

  raise exception 'unknown_action' using errcode = '22023',
    hint = 'me, vars.get, vars.put, vars.patch, path.get, path.column.add, path.column.update, path.column.delete, path.task.add, path.task.update, path.task.delete, board.list, board.get, board.put, board.append, read.';
end $$;

revoke all on function public.architect_agent_call(text, text, jsonb) from public;
grant execute on function public.architect_agent_call(text, text, jsonb) to anon, authenticated;
