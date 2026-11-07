-- ============================================================
-- Architect · Nov 8 update: the Architect Space
-- Run once in Supabase → SQL Editor, AFTER schema.sql, collab.sql, accountability.sql and nov7.sql.
-- Safe to run again.
--   1. The Space (one shared canvas; anyone in it can invite by username)
--   2. Space mates can see each other's Paths (except private tasks), avatars
--   3. Stable ticket numbers (#001…), the attempts feed for the Tracker, task ↔ ticket links
--   4. Personal API tokens + the architect_api endpoint (objects, tasks, tickets, attempts,
--      custom widgets, custom CSS / JS with safe mode)
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. The Space ----------
alter table public.blueprints add column if not exists kind text not null default 'board'; -- 'board' | 'space'

-- Anyone already in a Space can bring someone else in.
create or replace function public.space_invite(b text, uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  name text := lower(trim(uname));
begin
  if not public.can_access_board(b) or not exists (select 1 from public.blueprints where id::text = b and kind = 'space') then
    raise exception 'You’re not in this space.' using errcode = '42501';
  end if;
  select id into target from public.profiles where username = name;
  if target is null then raise exception 'No account called “%”.', uname using errcode = 'P0002'; end if;
  if exists (select 1 from public.blueprints where id::text = b and user_id = target) then
    return json_build_object('user_id', target, 'username', name);
  end if;
  insert into public.blueprint_members (board_id, user_id, added_by)
  select id, target, auth.uid() from public.blueprints where id::text = b
  on conflict do nothing;
  return json_build_object('user_id', target, 'username', name);
end $$;
grant execute on function public.space_invite(text, text) to authenticated;

-- True when `a` and `b` are in the same Space.
create or replace function public.space_mate_of(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  with people as (
    select bp.id, bp.user_id from public.blueprints bp where bp.kind = 'space'
    union all
    select m.board_id, m.user_id from public.blueprint_members m
      join public.blueprints bp on bp.id = m.board_id where bp.kind = 'space'
  )
  select a is not null and (a = b or exists (
    select 1 from people x join people y on x.id = y.id
    where x.user_id = a and y.user_id = b
  ));
$$;
-- True when you and `other` are in the same Space.
create or replace function public.space_mate(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.space_mate_of(auth.uid(), other);
$$;
grant execute on function public.space_mate(uuid), public.space_mate_of(uuid, uuid) to authenticated;

-- ---------- 2. Paths are visible to space mates; private tasks stay yours ----------
alter table public.path_tasks add column if not exists private boolean not null default false;

drop policy if exists "paths: space mates read columns" on public.path_columns;
create policy "paths: space mates read columns" on public.path_columns
  for select to authenticated using (public.space_mate(user_id));

drop policy if exists "paths: space mates read tasks" on public.path_tasks;
create policy "paths: space mates read tasks" on public.path_tasks
  for select to authenticated using (not private and public.space_mate(user_id));

-- Space mates' setpoint windows live in their settings row.
drop policy if exists "prefs: space mates read" on public.architect_prefs;
create policy "prefs: space mates read" on public.architect_prefs
  for select to authenticated using (public.space_mate(user_id));

-- Faces: your avatar lives in your media folder; space mates can already read it (shared board).
alter table public.profiles add column if not exists avatar_path text;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
grant update (avatar_path) on public.profiles to authenticated;

-- ---------- 3. Tickets: stable numbers, attempts feed, linked tasks ----------
create sequence if not exists public.parasite_no_seq;
alter table public.parasites add column if not exists no int;
do $$
begin
  if exists (select 1 from public.parasites where no is null) then
    with ordered as (select id, row_number() over (order by created_at) + coalesce((select max(no) from public.parasites), 0) as n
                     from public.parasites where no is null)
    update public.parasites p set no = o.n from ordered o where p.id = o.id;
  end if;
  perform setval('public.parasite_no_seq', coalesce((select max(no) from public.parasites), 0) + 1, false); -- next number = highest + 1
end $$;
alter table public.parasites alter column no set default nextval('public.parasite_no_seq');
grant usage on sequence public.parasite_no_seq to authenticated;

-- Everyone in the Space can see everyone's attempts — the tracker's honesty check.
create or replace function public.space_attempts(since timestamptz, until timestamptz)
returns table (id uuid, user_id uuid, username text, created_at timestamptz, outcome text, body text, ticket_id uuid, ticket_no int, ticket_title text)
language sql stable security definer set search_path = public as $$
  select m.id, m.user_id, pr.username, m.created_at, m.outcome, m.body, p.id, p.no, p.title
  from public.parasite_messages m
  join public.parasites p on p.id = m.parasite_id
  left join public.profiles pr on pr.id = m.user_id
  where m.kind = 'attempt' and m.created_at >= since and m.created_at < until
    and public.space_mate(m.user_id)
  order by m.created_at;
$$;
grant execute on function public.space_attempts(timestamptz, timestamptz) to authenticated;

-- Setpoint tasks that mention #<no> show up inside that ticket.
drop function if exists public.ticket_tasks(int);
create or replace function public.ticket_tasks(ticket_no int)
returns table (id uuid, user_id uuid, title text, done boolean, username text, column_title text)
language sql stable security definer set search_path = public as $$
  select t.id, t.user_id, t.title, t.done, pr.username, c.title
  from public.path_tasks t
  join public.path_columns c on c.id = t.column_id
  left join public.profiles pr on pr.id = t.user_id
  where t.title ~ ('#0*' || ticket_no::text || '([^0-9]|$)')
    and (t.user_id = auth.uid() or (not t.private and public.space_mate(t.user_id)));
$$;
grant execute on function public.ticket_tasks(int) to authenticated;

-- ---------- 4. Personal API ----------
create table if not exists public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null default 'Token',
  prefix       text not null default '',          -- first characters, to recognise it in the list
  token_hash   text not null unique,              -- sha-256 of the token; the token itself is never stored
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.api_tokens enable row level security;
drop policy if exists "api tokens: owner" on public.api_tokens;
create policy "api tokens: owner" on public.api_tokens
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.api_tokens to authenticated;

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
    insert into public.path_tasks (id, user_id, column_id, title, note, done, position, private)
    values (gen_random_uuid(), me, col, coalesce(p->>'title', 'Untitled'), coalesce(p->>'note', ''), coalesce((p->>'done')::boolean, false), pos, coalesce((p->>'private')::boolean, false))
    returning to_jsonb(path_tasks.*) into out;
    return out;
  when 'tasks.update' then
    update public.path_tasks set
      title = coalesce(p->'patch'->>'title', title),
      note = coalesce(p->'patch'->>'note', note),
      done = coalesce((p->'patch'->>'done')::boolean, done),
      private = coalesce((p->'patch'->>'private')::boolean, private)
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
  when 'style.set', 'script.set', 'safe_mode.set' then
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

-- ---------- 5. The Ticket board is shared with the whole Space ----------
-- Space mates see every ticket opened by someone in the Space, can talk on it and log attempts.
create or replace function public.on_parasite(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.parasites where id = p
                 and (user_id = auth.uid() or auth.uid() = any (members) or public.space_mate(user_id)));
$$;

drop policy if exists "parasites: space mates read" on public.parasites;
create policy "parasites: space mates read" on public.parasites
  for select to authenticated using (public.space_mate(user_id));
drop policy if exists "parasites: space mates edit" on public.parasites;
create policy "parasites: space mates edit" on public.parasites
  for update to authenticated using (public.space_mate(user_id)) with check (public.space_mate(user_id));

-- Space mates can add people (themselves included) to a ticket.
create or replace function public.parasite_add(p uuid, uname text)
returns json language plpgsql security definer set search_path = public as $$
declare
  rec public.parasites;
  target uuid;
begin
  select * into rec from public.parasites where id = p;
  if rec.id is null or not (rec.user_id = auth.uid() or auth.uid() = any (rec.members) or public.space_mate(rec.user_id)) then
    raise exception 'Not on this problem.' using errcode = '42501';
  end if;
  select id into target from public.profiles where username = lower(trim(uname));
  if target is null then raise exception 'No account called “%”.', uname using errcode = 'P0002'; end if;
  if target = rec.user_id or target = any (rec.members) then return row_to_json(rec); end if;
  update public.parasites set members = array_append(members, target), broken_at = null where id = p returning * into rec;
  return row_to_json(rec);
end $$;

-- "I can do it" from a space mate who isn't on the ticket yet adds them to it.
create or replace function public.parasite_check(p uuid, val boolean)
returns json language plpgsql security definer set search_path = public as $$
declare
  rec public.parasites;
  everyone uuid[];
  all_in boolean;
begin
  select * into rec from public.parasites where id = p;
  if rec.id is null or not (rec.user_id = auth.uid() or auth.uid() = any (rec.members) or public.space_mate(rec.user_id)) then
    raise exception 'Not on this problem.' using errcode = '42501';
  end if;
  if rec.user_id <> auth.uid() and not (auth.uid() = any (rec.members)) then
    update public.parasites set members = array_append(members, auth.uid()) where id = p;
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

-- Names for everyone on your tickets and in your Space.
create or replace function public.parasite_people()
returns table (user_id uuid, username text)
language sql stable security definer set search_path = public as $$
  select distinct pr.id, pr.username
  from public.parasites p
  cross join lateral unnest(array_append(p.members, p.user_id)) m
  join public.profiles pr on pr.id = m
  where p.user_id = auth.uid() or auth.uid() = any (p.members)
  union
  select pr.id, pr.username from public.profiles pr where public.space_mate(pr.id);
$$;
grant execute on function public.parasite_check(uuid, boolean), public.parasite_add(uuid, text), public.parasite_people() to authenticated;
