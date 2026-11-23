-- Architect — Nov 24 update, part 2: Anytype ⇄ Path, both ways. Run after anytype.sql (safe to run again).
-- Architect-side changes (check, rename, add, delete) are queued for the connector on your PC, which applies
-- them in Anytype; Anytype's own checkbox state rides along with every import.

/* =====================================================================
   2. Anytype ⇄ Path, both ways
   ===================================================================== */
do $$ begin
  if to_regclass('public.anytype_items') is null then
    raise exception 'Run supabase/anytype.sql first.';
  end if;
end $$;

-- Architect-side changes waiting for the connector on your PC.
create table if not exists public.anytype_ops (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mapping_id  uuid not null,
  item_key    text,                                   -- null for 'add'
  op          text not null check (op in ('check', 'rename', 'add', 'delete')),
  payload     jsonb not null default '{}'::jsonb,     -- check: { done } · rename / add: { title }
  status      text not null default 'pending' check (status in ('pending', 'taken', 'done', 'failed')),
  message     text not null default '',
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists anytype_ops_open on public.anytype_ops (user_id, status, created_at);
alter table public.anytype_ops enable row level security;
drop policy if exists "anytype ops: owner" on public.anytype_ops;
create policy "anytype ops: owner" on public.anytype_ops
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.anytype_ops from anon, authenticated;
grant select, insert, delete on public.anytype_ops to authenticated;
drop trigger if exists anytype_ops_touch on public.anytype_ops;
create trigger anytype_ops_touch before update on public.anytype_ops
  for each row execute function public.architect_touch();

-- Anytype's own checkbox on an import: when it flips, remember when (fields.done_at), so the app can tell
-- which side changed last.
create or replace function public.anytype__stamp_done() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.fields ? 'done' then
    if tg_op = 'INSERT' or (old.fields->'done') is distinct from (new.fields->'done') then
      new.fields := new.fields || jsonb_build_object('done_at', now());
    elsif old.fields ? 'done_at' then
      new.fields := new.fields || jsonb_build_object('done_at', old.fields->'done_at');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists anytype_items_done on public.anytype_items;
create trigger anytype_items_done before insert or update on public.anytype_items
  for each row execute function public.anytype__stamp_done();

-- anytype_publish, now also taking Anytype's checkbox state (fields.done, a boolean) — everything else as
-- in anytype.sql.
create or replace function public.anytype_publish(token text, p_mapping_id uuid, p_mapping_version int, items jsonb, complete boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  mp public.anytype_mappings;
  n_in int := jsonb_array_length(coalesce(items, '[]'::jsonb));
  n_new int := 0; n_changed int := 0; n_archived int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('anytype:' || p_mapping_id::text));
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
      jsonb_strip_nulls(jsonb_build_object(
        'title', left(nullif(trim(x->'fields'->>'title'), ''), 500),
        'body', case when 'body' = any(mp.allow_fields) then left(x->'fields'->>'body', 4000) end,
        'date', case when 'date' = any(mp.allow_fields) and (x->'fields'->>'date') ~ '^\d{4}-\d{2}-\d{2}$' then x->'fields'->>'date' end,
        'done', case when jsonb_typeof(x->'fields'->'done') = 'boolean' then x->'fields'->'done' end)) as f,
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

-- The connector picks up Architect-side changes for the mappings it owns (oldest first). Ops it took but
-- never acknowledged (PC slept mid-way) come back after 10 minutes.
create or replace function public.anytype_take_ops(token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.anytype_connectors := public.anytype__connector(token);
  out jsonb;
begin
  with picked as (
    select o.id from public.anytype_ops o
      join public.anytype_mappings m on m.id = o.mapping_id
     where o.user_id = c.user_id and m.connector_id = c.id and m.enabled and not m.paused
       and (o.status = 'pending' or (o.status = 'taken' and o.updated_at < now() - interval '10 minutes'))
     order by o.created_at limit 50
     for update of o skip locked
  ), marked as (
    update public.anytype_ops o set status = 'taken' from picked where o.id = picked.id returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'op', k.op, 'payload', k.payload, 'created_at', k.created_at,
      'mapping', jsonb_build_object('id', m.id, 'version', m.version, 'source_kind', m.source_kind, 'source_space_id', m.source_space_id,
                                    'source_id', m.source_id, 'section_block_id', m.section_block_id, 'section_name', m.section_name),
      'item', case when it.key is null then null else jsonb_build_object('key', it.key, 'source_object_id', it.source_object_id,
                                    'source_block_id', it.source_block_id, 'fields', it.fields, 'sort', it.sort) end)
      order by k.created_at), '[]'::jsonb)
    into out
    from marked k
    join public.anytype_mappings m on m.id = k.mapping_id
    left join public.anytype_items it on it.key = k.item_key and it.user_id = c.user_id;
  return out;
end $$;

create or replace function public.anytype_ack_op(token text, p_id uuid, ok boolean, p_message text default '', p_result jsonb default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare c public.anytype_connectors := public.anytype__connector(token);
begin
  update public.anytype_ops set status = case when ok then 'done' else 'failed' end,
    message = left(regexp_replace(coalesce(p_message, ''), '[[:cntrl:]]', ' ', 'g'), 300), result = p_result
   where id = p_id and user_id = c.user_id;
  -- keep the queue small: finished ops older than a week go
  delete from public.anytype_ops where user_id = c.user_id and status in ('done', 'failed') and updated_at < now() - interval '7 days';
end $$;

revoke all on function public.anytype_take_ops(text), public.anytype_ack_op(text, uuid, boolean, text, jsonb),
  public.anytype_publish(text, uuid, int, jsonb, boolean) from public;
grant execute on function public.anytype_take_ops(text), public.anytype_ack_op(text, uuid, boolean, text, jsonb),
  public.anytype_publish(text, uuid, int, jsonb, boolean) to anon, authenticated;

-- Rollback:
--   drop function if exists public.anytype_take_ops(text), public.anytype_ack_op(text, uuid, boolean, text, jsonb);
--   drop trigger if exists anytype_items_done on public.anytype_items; drop function if exists public.anytype__stamp_done();
--   drop table if exists public.anytype_ops;
--   then run anytype.sql again to restore the original anytype_publish.
