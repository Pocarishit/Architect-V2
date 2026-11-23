-- Architect — Anytype sync (Nov 23b, "Anytype sync for Architect" runbook)
-- Run once in Supabase → SQL Editor → New query → Run. Safe to re-run. Needs schema.sql (and pgcrypto,
-- which space.sql already uses).
--
-- How data moves: Anytype Desktop (your PC) → the Windows connector (connector/) → these tables → Architect
-- on desktop and phone. The phone never talks to Anytype or to your PC.
--
-- Who can do what:
--   · You (signed in): read your mappings, imports and run status; pause/resume or delete a mapping; revoke
--     a connector; remove imported items; record your own checkmarks. Nobody else can read any of it.
--   · A connector (its own revocable token, never your password and never the Anytype key): only the RPCs
--     below. It can save mappings for its owner and publish imported items for its owner's enabled,
--     current mappings — never goals, checkmarks, Path tasks, Variables, shared data or another account.
-- Anytype keys never reach this database.

create extension if not exists pgcrypto with schema extensions;

/* ---------------- tables ---------------- */

-- A paired connector (one per PC). The token is shown once to the connector and stored here hashed.
create table if not exists public.anytype_connectors (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  name              text not null default 'Windows PC',
  token_hash        text not null unique,
  prefix            text not null default '',
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  revoked_at        timestamptz,
  sync_requested_at timestamptz
);
create index if not exists anytype_connectors_user_idx on public.anytype_connectors (user_id);

-- One-time pairing codes (10 minutes, single use). Only reachable through the functions below.
create table if not exists public.anytype_pairing (
  code_hash  text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- What feeds what: an Anytype source (a page section, a collection, or picked objects) → an Architect
-- destination. IDs are immutable; names are only for reading. v1: private destinations only.
create table if not exists public.anytype_mappings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  workspace        text not null default 'private' check (workspace = 'private'),
  connector_id     uuid references public.anytype_connectors (id) on delete set null,
  name             text not null default '',
  source_space_id  text not null,
  source_kind      text not null check (source_kind in ('section', 'collection', 'objects')),
  source_id        text not null,                 -- page id (section), collection id, or '' (objects)
  source_name      text not null default '',
  section_block_id text,                          -- the heading block, for a page section
  section_name     text not null default '',
  object_ids       text[] not null default '{}',  -- explicit picks (objects), or an allowlist
  allow_types      text[] not null default '{}',  -- object type keys allowed from a collection
  allow_fields     text[] not null default '{title}',
  date_property    text,                          -- a typed date property to map (optional)
  filters          jsonb not null default '{}'::jsonb,
  dest_kind        text not null check (dest_kind in ('path', 'variables', 'story')),
  dest_id          text not null,
  dest_name        text not null default '',
  version          int not null default 1,
  enabled          boolean not null default false,
  paused           boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists anytype_mappings_user_idx on public.anytype_mappings (user_id);

-- Imported records. The key is deterministic (mapping + source identity), never a title.
create table if not exists public.anytype_items (
  key              text primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  mapping_id       uuid not null references public.anytype_mappings (id) on delete cascade,
  dest_kind        text not null,
  dest_id          text not null,
  source_space_id  text not null,
  source_object_id text not null,
  source_block_id  text,
  fields           jsonb not null default '{}'::jsonb,   -- { title, body?, date? } — allowlisted
  fingerprint      text not null,
  sort             double precision not null default 0,
  mapping_version  int not null default 1,
  archived         boolean not null default false,
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists anytype_items_user_idx on public.anytype_items (user_id, dest_kind, archived);
create index if not exists anytype_items_mapping_idx on public.anytype_items (mapping_id);

-- Import status, separate from the device's own network status.
create table if not exists public.anytype_runs (
  mapping_id      uuid primary key references public.anytype_mappings (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  mapping_version int not null default 1,
  connector_id    uuid,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  status          text not null default 'never',
  message         text not null default '',
  item_count      int not null default 0
);

-- Checkmarks on imported Path items: Architect owns them, per local calendar day (Architect's day rules,
-- Second Wind included). An import never touches this table. Same flag on two devices: last write wins.
create table if not exists public.anytype_checks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_key   text not null,
  day        date not null,
  done       boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, item_key, day)
);

/* ---------------- access ---------------- */
alter table public.anytype_connectors enable row level security;
alter table public.anytype_pairing    enable row level security;
alter table public.anytype_mappings   enable row level security;
alter table public.anytype_items      enable row level security;
alter table public.anytype_runs       enable row level security;
alter table public.anytype_checks     enable row level security;

drop policy if exists "anytype connectors: owner" on public.anytype_connectors;
create policy "anytype connectors: owner" on public.anytype_connectors
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "anytype mappings: owner" on public.anytype_mappings;
create policy "anytype mappings: owner" on public.anytype_mappings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "anytype items: owner" on public.anytype_items;
create policy "anytype items: owner" on public.anytype_items
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "anytype runs: owner" on public.anytype_runs;
create policy "anytype runs: owner" on public.anytype_runs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "anytype checks: owner" on public.anytype_checks;
create policy "anytype checks: owner" on public.anytype_checks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- (anytype_pairing: no policies — functions only)

-- Column-level grants keep the app to the controls it needs: it can't write imports or mapping scope.
revoke all on public.anytype_connectors, public.anytype_pairing, public.anytype_mappings,
              public.anytype_items, public.anytype_runs, public.anytype_checks from anon, authenticated;
grant select, delete on public.anytype_connectors to authenticated;
grant update (name, revoked_at, sync_requested_at) on public.anytype_connectors to authenticated;
grant select, delete on public.anytype_mappings to authenticated;
grant update (enabled, paused) on public.anytype_mappings to authenticated;
grant select, delete on public.anytype_items to authenticated;
grant select on public.anytype_runs to authenticated;
grant select, insert, update, delete on public.anytype_checks to authenticated;

drop trigger if exists anytype_mappings_touch on public.anytype_mappings;
create trigger anytype_mappings_touch before update on public.anytype_mappings
  for each row execute function public.architect_touch();

/* ---------------- helpers ---------------- */
-- (dropped first so a re-run can change parameter names safely)
drop function if exists public.anytype_publish(text, uuid, int, jsonb, boolean);
drop function if exists public.anytype_report(text, uuid, int, text, text);

create or replace function public.anytype__hash(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(digest(convert_to(coalesce(t, ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- The connector behind a token (raises when unknown or revoked). Touches last_seen_at.
create or replace function public.anytype__connector(token text) returns public.anytype_connectors
language plpgsql security definer set search_path = public, extensions as $$
declare c public.anytype_connectors;
begin
  select * into c from public.anytype_connectors where token_hash = public.anytype__hash(token);
  if c.id is null or c.revoked_at is not null then
    raise exception 'connector_revoked' using errcode = '28000', hint = 'Pair the connector again from Architect → Settings → Integrations.';
  end if;
  update public.anytype_connectors set last_seen_at = now() where id = c.id;
  return c;
end $$;
revoke all on function public.anytype__connector(text) from public, anon, authenticated;

/* ---------------- pairing ---------------- */
-- From the signed-in app: a one-time code for the connector on this PC.
create or replace function public.anytype_pair_start() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid();
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  raw text := '';
  b bytea := gen_random_bytes(8);
  i int;
  exp timestamptz := now() + interval '10 minutes';
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  delete from public.anytype_pairing where user_id = me and (used_at is not null or expires_at < now());
  if (select count(*) from public.anytype_pairing where user_id = me) >= 5 then
    raise exception 'Too many pairing codes. Wait a few minutes.' using errcode = '54000';
  end if;
  for i in 0..7 loop raw := raw || substr(alphabet, 1 + (get_byte(b, i) % 32), 1); end loop;
  insert into public.anytype_pairing (code_hash, user_id, expires_at) values (public.anytype__hash(raw), me, exp);
  return jsonb_build_object('code', substr(raw, 1, 4) || '-' || substr(raw, 5, 4), 'expires_at', exp);
end $$;
revoke all on function public.anytype_pair_start() from public, anon;
grant execute on function public.anytype_pair_start() to authenticated;

-- From the connector: trade the code for its own revocable, narrowly scoped token (shown once).
create or replace function public.anytype_pair_finish(code text, name text default 'Windows PC') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  p public.anytype_pairing;
  tok text;
  cid uuid;
  norm text := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into p from public.anytype_pairing where code_hash = public.anytype__hash(norm) for update;
  if p.code_hash is null or p.used_at is not null or p.expires_at < now() then
    raise exception 'That pairing code is wrong or expired. Make a new one in Architect → Settings → Integrations.' using errcode = '28000';
  end if;
  update public.anytype_pairing set used_at = now() where code_hash = p.code_hash;
  tok := 'axc_' || translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into public.anytype_connectors (user_id, name, token_hash, prefix)
    values (p.user_id, left(coalesce(nullif(trim(name), ''), 'Windows PC'), 40), public.anytype__hash(tok), left(tok, 10))
    returning id into cid;
  return jsonb_build_object('token', tok, 'connector_id', cid,
    'username', (select username from public.profiles where id = p.user_id));
end $$;
revoke all on function public.anytype_pair_finish(text, text) from public;
grant execute on function public.anytype_pair_finish(text, text) to anon, authenticated;

/* ---------------- connector RPCs (token only) ---------------- */
create or replace function public.anytype_poll(token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c public.anytype_connectors := public.anytype__connector(token);
begin
  return jsonb_build_object('connector_id', c.id, 'name', c.name, 'sync_requested_at', c.sync_requested_at,
    'username', (select username from public.profiles where id = c.user_id));
end $$;

-- Where things can go: your Path columns (with their setpoint windows) and your private Variables
-- subsections. Names and ids only.
create or replace function public.anytype_destinations(token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  times jsonb := coalesce((select data->'pathTimes' from public.architect_prefs where user_id = c.user_id), '{}'::jsonb);
begin
  return jsonb_build_object(
    'path', coalesce((select jsonb_agg(jsonb_build_object('id', pc.id, 'title', pc.title, 'window', times->(pc.id::text)) order by pc.position)
                       from public.path_columns pc where pc.user_id = c.user_id), '[]'::jsonb),
    'variables', coalesce((select jsonb_agg(jsonb_build_object('id', s->>'id', 'name', s->>'name', 'parent', s->>'parent'))
                       from public.architect_variables v, jsonb_array_elements(coalesce(v.data->'sections', '[]'::jsonb)) s
                       where v.user_id = c.user_id), '[]'::jsonb),
    'adapters', jsonb_build_array('path'));
exception when undefined_table then
  return jsonb_build_object('path', '[]'::jsonb, 'variables', '[]'::jsonb, 'adapters', jsonb_build_array('path'));
end $$;

create or replace function public.anytype_list_mappings(token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c public.anytype_connectors := public.anytype__connector(token);
begin
  return coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object('run', to_jsonb(r)) order by m.created_at)
    from public.anytype_mappings m left join public.anytype_runs r on r.mapping_id = m.id
    where m.user_id = c.user_id), '[]'::jsonb);
end $$;

-- Create or edit a mapping (after the connector showed you its preview). A change to scope, fields or
-- destination bumps the version: publishes made for an older version are rejected.
create or replace function public.anytype_save_mapping(token text, m jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  cur public.anytype_mappings;
  out public.anytype_mappings;
  dk text := coalesce(m->>'dest_kind', '');
  did text := coalesce(m->>'dest_id', '');
  fields text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(m->'allow_fields', '["title"]'::jsonb)) x), '{title}');
  objs text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(m->'object_ids', '[]'::jsonb)) x), '{}');
  types text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(m->'allow_types', '[]'::jsonb)) x), '{}');
  changed boolean;
begin
  if dk <> 'path' then
    raise exception 'adapter_disabled' using errcode = '22023', hint = 'Only Path Set-Point mappings are enabled in this release.';
  end if;
  if not exists (select 1 from public.path_columns where id::text = did and user_id = c.user_id) then
    raise exception 'destination_not_yours' using errcode = '42501';
  end if;
  if coalesce(m->>'source_kind', '') not in ('section', 'collection', 'objects') then
    raise exception 'bad_source_kind' using errcode = '22023';
  end if;
  if coalesce(m->>'source_space_id', '') = '' or (m->>'source_kind' <> 'objects' and coalesce(m->>'source_id', '') = '') then
    raise exception 'missing_source' using errcode = '22023';
  end if;
  if m->>'source_kind' = 'section' and coalesce(m->>'section_block_id', '') = '' then
    raise exception 'missing_section' using errcode = '22023';
  end if;
  if not fields <@ array['title', 'body', 'date'] or not ('title' = any(fields)) then
    raise exception 'bad_fields' using errcode = '22023';
  end if;
  if m ? 'id' and (m->>'id') is not null then
    select * into cur from public.anytype_mappings where id::text = m->>'id' and user_id = c.user_id for update;
    if cur.id is null then raise exception 'mapping_not_found' using errcode = 'P0002'; end if;
    -- scope, fields or destination changed → a new version (older publishes are rejected)
    changed := (cur.source_space_id, cur.source_kind, cur.source_id, cur.section_block_id, cur.object_ids, cur.allow_types,
                cur.allow_fields, cur.date_property, cur.filters, cur.dest_kind, cur.dest_id)
      is distinct from (m->>'source_space_id', m->>'source_kind', coalesce(m->>'source_id', ''), nullif(m->>'section_block_id', ''), objs, types,
                fields, nullif(m->>'date_property', ''), coalesce(m->'filters', '{}'::jsonb), dk, did);
    update public.anytype_mappings set
      name = left(coalesce(m->>'name', cur.name), 80),
      connector_id = c.id,
      source_space_id = m->>'source_space_id', source_kind = m->>'source_kind', source_id = coalesce(m->>'source_id', ''),
      source_name = left(coalesce(m->>'source_name', ''), 120), section_block_id = nullif(m->>'section_block_id', ''),
      section_name = left(coalesce(m->>'section_name', ''), 120),
      object_ids = objs, allow_types = types,
      allow_fields = fields, date_property = nullif(m->>'date_property', ''), filters = coalesce(m->'filters', '{}'::jsonb),
      dest_kind = dk, dest_id = did, dest_name = left(coalesce(m->>'dest_name', ''), 80),
      enabled = coalesce((m->>'enabled')::boolean, cur.enabled),
      version = case when changed then cur.version + 1 else cur.version end
      where id = cur.id returning * into out;
  else
    insert into public.anytype_mappings (user_id, connector_id, name, source_space_id, source_kind, source_id, source_name,
      section_block_id, section_name, object_ids, allow_types, allow_fields, date_property, filters, dest_kind, dest_id, dest_name, enabled)
    values (c.user_id, c.id, left(coalesce(m->>'name', ''), 80), m->>'source_space_id', m->>'source_kind', coalesce(m->>'source_id', ''),
      left(coalesce(m->>'source_name', ''), 120), nullif(m->>'section_block_id', ''), left(coalesce(m->>'section_name', ''), 120),
      objs, types,
      fields, nullif(m->>'date_property', ''), coalesce(m->'filters', '{}'::jsonb), dk, did, left(coalesce(m->>'dest_name', ''), 80),
      coalesce((m->>'enabled')::boolean, true))
    returning * into out;
  end if;
  return to_jsonb(out);
end $$;

-- Publish one complete, validated read of a mapping's scope — atomically (one transaction).
-- Changed items are upserted (unchanged ones only get last_seen_at), items missing from a complete read
-- are archived (history kept), and the run is marked successful only after everything is written.
create or replace function public.anytype_publish(token text, p_mapping_id uuid, p_mapping_version int, items jsonb, complete boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  mp public.anytype_mappings;
  n_in int := jsonb_array_length(coalesce(items, '[]'::jsonb));
  n_new int := 0; n_changed int := 0; n_archived int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('anytype:' || p_mapping_id::text)); -- one run per mapping at a time
  select * into mp from public.anytype_mappings m where m.id = p_mapping_id and m.user_id = c.user_id;
  if mp.id is null then raise exception 'mapping_not_found' using errcode = 'P0002'; end if;
  if not mp.enabled or mp.paused then raise exception 'mapping_disabled' using errcode = '55000'; end if;
  if mp.version <> p_mapping_version then raise exception 'stale_mapping' using errcode = '40001'; end if;
  if mp.dest_kind <> 'path' then raise exception 'adapter_disabled' using errcode = '22023'; end if;
  if n_in > 500 then raise exception 'too_many_items' using errcode = '54000', hint = 'Narrow the section or collection (500 items max).'; end if;

  create temporary table if not exists _ax_in (key text primary key, obj text, blk text, fields jsonb, fp text, sort double precision) on commit drop;
  truncate _ax_in;
  insert into _ax_in (key, obj, blk, fields, fp, sort)
  select distinct on (k) k, obj, blk, f, encode(digest(convert_to(f::text, 'UTF8'), 'sha256'), 'hex'), srt
  from (
    select
      public.anytype__hash(mp.id::text || '|' || mp.source_space_id || '|' || (x->>'source_object_id') || '|' || coalesce(x->>'source_block_id', '')) as k,
      left(x->>'source_object_id', 200) as obj,
      left(nullif(x->>'source_block_id', ''), 200) as blk,
      -- the field allowlist, enforced here: anything else the connector sends is dropped
      jsonb_strip_nulls(jsonb_build_object(
        'title', left(nullif(trim(x->'fields'->>'title'), ''), 500),
        'body', case when 'body' = any(mp.allow_fields) then left(x->'fields'->>'body', 4000) end,
        'date', case when 'date' = any(mp.allow_fields) and (x->'fields'->>'date') ~ '^\d{4}-\d{2}-\d{2}$' then x->'fields'->>'date' end)) as f,
      coalesce((x->>'sort')::double precision, ord) as srt
    from jsonb_array_elements(coalesce(items, '[]'::jsonb)) with ordinality as e(x, ord)
    where coalesce(x->>'source_object_id', '') <> ''
  ) q
  where f ? 'title'
  order by k, srt;

  with up as (
    insert into public.anytype_items as it (key, user_id, mapping_id, dest_kind, dest_id, source_space_id, source_object_id, source_block_id,
      fields, fingerprint, sort, mapping_version, archived, last_seen_at)
    select i.key, mp.user_id, mp.id, mp.dest_kind, mp.dest_id, mp.source_space_id, i.obj, i.blk, i.fields, i.fp, i.sort, mp.version, false, now()
    from _ax_in i
    on conflict (key) do update set
      fields = excluded.fields, fingerprint = excluded.fingerprint, sort = excluded.sort, dest_id = excluded.dest_id,
      mapping_version = excluded.mapping_version, archived = false, last_seen_at = now(), updated_at = now()
    where it.fingerprint is distinct from excluded.fingerprint or it.archived or it.sort is distinct from excluded.sort
       or it.dest_id is distinct from excluded.dest_id
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into n_new, n_changed from up;
  update public.anytype_items set last_seen_at = now() where key in (select key from _ax_in);

  if complete then
    update public.anytype_items set archived = true, updated_at = now()
     where anytype_items.mapping_id = mp.id and not archived and key not in (select key from _ax_in);
    get diagnostics n_archived = row_count;
  end if;

  insert into public.anytype_runs as r (mapping_id, user_id, mapping_version, connector_id, last_attempt_at, last_success_at, status, message, item_count)
  values (mp.id, mp.user_id, mp.version, c.id, now(), now(), 'ok', '', (select count(*) from _ax_in))
  on conflict (mapping_id) do update set mapping_version = excluded.mapping_version, connector_id = excluded.connector_id,
    last_attempt_at = now(), last_success_at = now(), status = 'ok', message = '', item_count = excluded.item_count;

  return jsonb_build_object('received', n_in, 'kept', (select count(*) from _ax_in), 'new', n_new, 'changed', n_changed, 'archived', n_archived);
end $$;

-- A failed or partial read: keep the last good import and record why (sanitized).
create or replace function public.anytype_report(token text, p_mapping_id uuid, p_mapping_version int, p_status text, p_message text default '')
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  mp public.anytype_mappings;
  st text := case when p_status in ('error', 'missing_section', 'no_access', 'partial', 'too_many', 'anytype_closed', 'stale', 'unsupported') then p_status else 'error' end;
begin
  select * into mp from public.anytype_mappings m where m.id = p_mapping_id and m.user_id = c.user_id;
  if mp.id is null then return; end if;
  insert into public.anytype_runs as r (mapping_id, user_id, mapping_version, connector_id, last_attempt_at, status, message)
  values (mp.id, mp.user_id, coalesce(p_mapping_version, mp.version), c.id, now(), st, left(regexp_replace(coalesce(p_message, ''), '[[:cntrl:]]', ' ', 'g'), 200))
  on conflict (mapping_id) do update set mapping_version = excluded.mapping_version, connector_id = excluded.connector_id,
    last_attempt_at = now(), status = excluded.status, message = excluded.message;
end $$;

-- From the app: record a checkmark on an imported Path item (yours only; last write wins).
create or replace function public.anytype_set_check(item_key text, day date, done boolean) returns void
language sql security invoker set search_path = public as $$
  insert into public.anytype_checks (user_id, item_key, day, done, updated_at)
  values (auth.uid(), item_key, day, done, now())
  on conflict (user_id, item_key, day) do update set done = excluded.done, updated_at = now();
$$;

revoke all on function public.anytype_poll(text), public.anytype_destinations(text), public.anytype_list_mappings(text),
  public.anytype_save_mapping(text, jsonb), public.anytype_publish(text, uuid, int, jsonb, boolean),
  public.anytype_report(text, uuid, int, text, text) from public;
grant execute on function public.anytype_poll(text), public.anytype_destinations(text), public.anytype_list_mappings(text),
  public.anytype_save_mapping(text, jsonb), public.anytype_publish(text, uuid, int, jsonb, boolean),
  public.anytype_report(text, uuid, int, text, text) to anon, authenticated;
revoke all on function public.anytype_set_check(text, date, boolean) from public, anon;
grant execute on function public.anytype_set_check(text, date, boolean) to authenticated;

-- Rollback (removes the feature and every import; Anytype itself is never touched):
--   drop function if exists public.anytype_set_check(text, date, boolean), public.anytype_report(text, uuid, int, text, text),
--     public.anytype_publish(text, uuid, int, jsonb, boolean), public.anytype_save_mapping(text, jsonb), public.anytype_list_mappings(text),
--     public.anytype_destinations(text), public.anytype_poll(text), public.anytype_pair_finish(text, text), public.anytype_pair_start(),
--     public.anytype__connector(text), public.anytype__hash(text);
--   drop table if exists public.anytype_checks, public.anytype_runs, public.anytype_items, public.anytype_mappings,
--     public.anytype_pairing, public.anytype_connectors;
