-- Architect — Nov 12 update. Safe to run more than once; keeps your data.
-- Run after the earlier files (schema, collab, accountability, nov7, space).
--   1. Paths: plan tasks for the next days (path_tasks.day).
--   2. Local API: push updates / fixes as numbered versions and roll back (updates.*).

-- ---------- 1. Paths: days ----------
alter table public.path_tasks add column if not exists day date;
create index if not exists path_tasks_day_idx on public.path_tasks (user_id, day);

-- ---------- 2. Updates with rollback ----------
-- Releases live in your prefs (architect_prefs.data.releases: [{ v, css, js, note, source, at }], last 30
-- plus the v0 "before the first update" snapshot). releaseActive is the version that's live.
create or replace function public.architect_push_release(me uuid, new_css text, new_js text, note text, src text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb;
  rels jsonb;
  v int;
  rel jsonb;
begin
  insert into public.architect_prefs (id, user_id, data) values (gen_random_uuid(), me, '{}'::jsonb)
  on conflict (user_id) do nothing;
  select data into d from public.architect_prefs where user_id = me for update;
  rels := case when jsonb_typeof(d->'releases') = 'array' then d->'releases' else '[]'::jsonb end;
  if jsonb_array_length(rels) = 0 then
    rels := jsonb_build_array(jsonb_build_object('v', 0, 'css', coalesce(d->>'customCss', ''), 'js', coalesce(d->>'customJs', ''),
      'note', 'Before the first update', 'source', 'snapshot', 'at', now()));
  end if;
  select coalesce(max((value->>'v')::int), 0) + 1 into v from jsonb_array_elements(rels);
  rel := jsonb_build_object('v', v, 'css', coalesce(new_css, d->>'customCss', ''), 'js', coalesce(new_js, d->>'customJs', ''),
    'note', left(coalesce(note, ''), 200), 'source', coalesce(src, 'api'), 'at', now());
  rels := rels || jsonb_build_array(rel);
  if jsonb_array_length(rels) > 30 then
    select jsonb_agg(value order by (value->>'v')::int) into rels from (
      select value from jsonb_array_elements(rels) where (value->>'v')::int = 0
      union all
      select value from (select value from jsonb_array_elements(rels) where (value->>'v')::int <> 0 order by (value->>'v')::int desc limit 29) newest
    ) kept;
  end if;
  update public.architect_prefs
     set data = data || jsonb_build_object('releases', rels, 'customCss', rel->>'css', 'customJs', rel->>'js', 'releaseActive', v)
   where user_id = me;
  return rel;
end $$;
-- Only the API function calls it (it takes a user id, so it must never be callable directly).
revoke all on function public.architect_push_release(uuid, text, text, text, text) from public, anon, authenticated;

-- The one endpoint: POST /rest/v1/rpc/architect_api { token, action, payload }
create or replace function public.architect_api(token text, action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid;
  space_id uuid;
  els jsonb;
  el jsonb;
  out jsonb;
  col uuid;
  tid uuid;
  pos double precision;
  p jsonb := coalesce(payload, '{}'::jsonb);
  d jsonb;
  rels jsonb;
  rel jsonb;
begin
  select user_id into me from public.api_tokens
   where token_hash = encode(digest(convert_to(coalesce(token, ''), 'UTF8'), 'sha256'), 'hex');
  if me is null then raise exception 'Invalid API token.' using errcode = '28000'; end if;
  update public.api_tokens set last_used_at = now()
   where token_hash = encode(digest(convert_to(token, 'UTF8'), 'sha256'), 'hex');

  -- Your Space: one you were invited to (the app's last pick first), else your own.
  select b.id into space_id from public.blueprints b
   where b.kind = 'space' and (b.user_id = me or exists (select 1 from public.blueprint_members m where m.board_id = b.id and m.user_id = me))
   order by (b.user_id = me) asc,
            (b.id::text = (select p.data->>'spaceId' from public.architect_prefs p where p.user_id = me limit 1)) desc nulls last,
            b.created_at limit 1;

  case action
  when 'whoami' then
    return jsonb_build_object('user_id', me, 'username', (select username from public.profiles where id = me), 'space_id', space_id);

  /* ----- canvas objects ----- */
  when 'objects.list' then
    if space_id is null then return '[]'::jsonb; end if;
    return (select coalesce(data->'elements', '[]'::jsonb) from public.blueprints where id = space_id);
  when 'objects.add', 'widgets.spawn' then
    if space_id is null then raise exception 'You have no Space yet — open Architect once.'; end if;
    el := coalesce(p->'element', p);
    if action = 'widgets.spawn' then
      el := jsonb_build_object('type', 'widget', 'kind', 'custom',
        'title', coalesce(p->>'title', 'Custom widget'), 'html', coalesce(p->>'html', ''),
        'x', coalesce((p->>'x')::numeric, 0), 'y', coalesce((p->>'y')::numeric, 0),
        'w', coalesce((p->>'w')::numeric, 420), 'h', coalesce((p->>'h')::numeric, 320));
    end if;
    el := jsonb_build_object('id', gen_random_uuid()::text, 'x', 0, 'y', 0, 'w', 240, 'h', 160) || el;
    if el->>'type' is null then raise exception 'An object needs a "type" (sticky, text, shape, widget…).'; end if;
    update public.blueprints set data = jsonb_set(coalesce(data, '{}'::jsonb), '{elements}', coalesce(data->'elements', '[]'::jsonb) || jsonb_build_array(el))
     where id = space_id;
    return el;
  when 'objects.update' then
    select coalesce(jsonb_agg(case when e->>'id' = p->>'id' then e || coalesce(p->'patch', '{}'::jsonb) else e end), '[]'::jsonb)
      into els from public.blueprints b, jsonb_array_elements(coalesce(b.data->'elements', '[]'::jsonb)) e where b.id = space_id;
    update public.blueprints set data = jsonb_set(data, '{elements}', els) where id = space_id;
    return (select e from jsonb_array_elements(els) e where e->>'id' = p->>'id');
  when 'objects.remove' then
    select coalesce(jsonb_agg(e), '[]'::jsonb) into els
      from public.blueprints b, jsonb_array_elements(coalesce(b.data->'elements', '[]'::jsonb)) e
     where b.id = space_id and e->>'id' <> p->>'id';
    update public.blueprints set data = jsonb_set(data, '{elements}', els) where id = space_id;
    return jsonb_build_object('removed', p->>'id');

  /* ----- Paths ----- */
  when 'columns.list' then
    return (select coalesce(jsonb_agg(to_jsonb(c) order by c.position), '[]'::jsonb) from public.path_columns c where c.user_id = me);
  when 'tasks.list' then
    return (select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]'::jsonb) from public.path_tasks t
            where t.user_id = me and (p->>'column_id' is null or t.column_id::text = p->>'column_id'));
  when 'tasks.add' then
    select id into col from public.path_columns where user_id = me
      and (id::text = p->>'column_id' or lower(title) = lower(p->>'column'))
      order by position limit 1;
    if col is null then raise exception 'No such path — pass "column_id" or "column" (its name).'; end if;
    select coalesce(max(position), 0) + 1024 into pos from public.path_tasks where column_id = col;
    insert into public.path_tasks (id, user_id, column_id, title, note, done, position, private, day)
    values (gen_random_uuid(), me, col, coalesce(p->>'title', 'Untitled'), coalesce(p->>'note', ''), coalesce((p->>'done')::boolean, false), pos, coalesce((p->>'private')::boolean, false), nullif(p->>'day', '')::date)
    returning to_jsonb(path_tasks.*) into out;
    return out;
  when 'tasks.update' then
    update public.path_tasks set
      title = coalesce(p->'patch'->>'title', title),
      note = coalesce(p->'patch'->>'note', note),
      done = coalesce((p->'patch'->>'done')::boolean, done),
      private = coalesce((p->'patch'->>'private')::boolean, private),
      day = case when p->'patch' ? 'day' then nullif(p->'patch'->>'day', '')::date else day end
     where id::text = p->>'id' and user_id = me
    returning to_jsonb(path_tasks.*) into out;
    if out is null then raise exception 'No task with that id.'; end if;
    return out;
  when 'tasks.remove' then
    delete from public.path_tasks where id::text = p->>'id' and user_id = me;
    return jsonb_build_object('removed', p->>'id');

  /* ----- Tickets + attempts ----- */
  when 'tickets.list' then
    return (select coalesce(jsonb_agg(to_jsonb(t) order by t.no), '[]'::jsonb) from public.parasites t
            where t.user_id = me or me = any (t.members) or public.space_mate_of(me, t.user_id));
  when 'tickets.add' then
    insert into public.parasites (id, user_id, title, detail, deadline, labels, status, members, checks)
    values (gen_random_uuid(), me, coalesce(p->>'title', 'Untitled problem'), coalesce(p->>'detail', ''), (p->>'deadline')::date,
            coalesce(array(select jsonb_array_elements_text(p->'labels')), '{}'), 'open', '{}', '{}')
    returning to_jsonb(parasites.*) into out;
    insert into public.parasite_messages (parasite_id, user_id, kind, body) values ((out->>'id')::uuid, me, 'event', 'opened this ticket (API)');
    return out;
  when 'tickets.update' then
    update public.parasites set
      title = coalesce(p->'patch'->>'title', title),
      detail = coalesce(p->'patch'->>'detail', detail),
      status = coalesce(p->'patch'->>'status', status),
      deadline = coalesce((p->'patch'->>'deadline')::date, deadline)
     where (id::text = p->>'id' or no::text = p->>'no') and (user_id = me or me = any (members) or public.space_mate_of(me, user_id))
    returning to_jsonb(parasites.*) into out;
    if out is null then raise exception 'No ticket with that id / no.'; end if;
    return out;
  when 'tickets.message', 'attempts.log' then
    select id into tid from public.parasites
     where (id::text = p->>'ticket_id' or no::text = p->>'ticket_no' or no::text = p->>'no') and (user_id = me or me = any (members) or public.space_mate_of(me, user_id)) limit 1;
    if tid is null then raise exception 'No ticket with that id / number you can see.'; end if;
    insert into public.parasite_messages (parasite_id, user_id, kind, outcome, body)
    values (tid, me, case when action = 'attempts.log' then 'attempt' else 'msg' end,
            case when action = 'attempts.log' then coalesce(p->>'outcome', 'failed') end, coalesce(p->>'body', ''))
    returning to_jsonb(parasite_messages.*) into out;
    return out;
  when 'attempts.list' then
    return (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.parasite_messages a
            where a.user_id = me and a.kind = 'attempt'
              and a.created_at >= coalesce((p->>'since')::timestamptz, now() - interval '7 days')
              and a.created_at < coalesce((p->>'until')::timestamptz, now() + interval '1 day'));

  /* ----- Your own look and behaviour ----- */
  when 'style.get' then
    return (select jsonb_build_object('css', coalesce(data->>'customCss', ''), 'js', coalesce(data->>'customJs', ''), 'safe_mode', coalesce((data->>'safeMode')::boolean, false))
            from public.architect_prefs where user_id = me);
  when 'style.set', 'script.set' then
    perform public.architect_push_release(me,
      case when action = 'style.set' then coalesce(p->>'css', '') end,
      case when action = 'script.set' then coalesce(p->>'js', '') end,
      coalesce(p->>'note', action || ' via API'), 'api');
    return (select jsonb_build_object('css', coalesce(data->>'customCss', ''), 'js', coalesce(data->>'customJs', ''), 'safe_mode', coalesce((data->>'safeMode')::boolean, false), 'version', data->'releaseActive')
            from public.architect_prefs where user_id = me);

  /* ----- Updates: push fixes as numbered versions, roll back any time ----- */
  when 'updates.push' then
    if not (p ? 'css' or p ? 'js') then raise exception 'Push needs "css" and/or "js".'; end if;
    return public.architect_push_release(me, p->>'css', p->>'js', p->>'note', 'api') - 'css' - 'js';
  when 'updates.list' then
    select data into d from public.architect_prefs where user_id = me;
    return jsonb_build_object('active', d->'releaseActive', 'releases',
      (select coalesce(jsonb_agg(jsonb_build_object('v', value->'v', 'note', value->'note', 'source', value->'source', 'at', value->'at',
                'css_chars', length(coalesce(value->>'css', '')), 'js_chars', length(coalesce(value->>'js', '')))
              order by (value->>'v')::int desc), '[]'::jsonb)
         from jsonb_array_elements(case when jsonb_typeof(d->'releases') = 'array' then d->'releases' else '[]'::jsonb end)));
  when 'updates.current' then
    return (select jsonb_build_object('version', data->'releaseActive', 'css', coalesce(data->>'customCss', ''), 'js', coalesce(data->>'customJs', ''), 'safe_mode', coalesce((data->>'safeMode')::boolean, false))
            from public.architect_prefs where user_id = me);
  when 'updates.rollback' then
    select data into d from public.architect_prefs where user_id = me for update;
    rels := case when jsonb_typeof(d->'releases') = 'array' then d->'releases' else '[]'::jsonb end;
    if p ? 'version' then
      select value into rel from jsonb_array_elements(rels) where (value->>'v')::int = (p->>'version')::int;
    else
      select value into rel from jsonb_array_elements(rels)
       where (value->>'v')::int < coalesce((d->>'releaseActive')::int, 2147483647)
       order by (value->>'v')::int desc limit 1;
    end if;
    if rel is null then raise exception 'Nothing to roll back to (see updates.list).'; end if;
    update public.architect_prefs set data = data || jsonb_build_object('customCss', coalesce(rel->>'css', ''), 'customJs', coalesce(rel->>'js', ''), 'releaseActive', (rel->>'v')::int)
     where user_id = me;
    return jsonb_build_object('active', (rel->>'v')::int, 'note', rel->'note', 'at', rel->'at');

  when 'safe_mode.set' then
    insert into public.architect_prefs (id, user_id, data) values (gen_random_uuid(), me, '{}'::jsonb)
    on conflict (user_id) do nothing;
    update public.architect_prefs set data = data || case action
        when 'style.set' then jsonb_build_object('customCss', coalesce(p->>'css', ''))
        when 'script.set' then jsonb_build_object('customJs', coalesce(p->>'js', ''))
        else jsonb_build_object('safeMode', coalesce((p->>'on')::boolean, true)) end
     where user_id = me
    returning jsonb_build_object('css', coalesce(data->>'customCss', ''), 'js', coalesce(data->>'customJs', ''), 'safe_mode', coalesce((data->>'safeMode')::boolean, false)) into out;
    return out;
  else
    raise exception 'Unknown action "%". See the API tab in Settings for the list.', action;
  end case;
end $$;
revoke all on function public.architect_api(text, text, jsonb) from public;
grant execute on function public.architect_api(text, text, jsonb) to anon, authenticated;
