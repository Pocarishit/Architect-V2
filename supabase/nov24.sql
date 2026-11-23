-- Architect — Nov 24 update. Run once in the Supabase SQL editor (safe to run again; keeps your data).
--   1. Updates & Fixes: the runs behind Push Update / Schedule (Settings → Updates & Fixes), and the
--      token-checked function the runner on your PC uses to pick them up and report progress.
--   · Radio: Spotify playlists can be shared with your Shared Space (shared_items kind 'spotify').
--   2. Anytype ⇄ Path two-way sync is in nov24-anytype.sql (run it after anytype.sql).
-- Needs: schema.sql and space.sql (api_tokens).

/* =====================================================================
   1. Updates & Fixes runs
   ===================================================================== */
create table if not exists public.architect_update_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note_id     text not null,
  title       text not null default '',
  note        jsonb not null default '{}'::jsonb,       -- { title, text, previews: [{ name, url, path }] } at push time
  status      text not null default 'queued' check (status in ('queued', 'running', 'blocked', 'done', 'failed', 'canceled')),
  step        text,                                      -- what it's doing now
  eta_at      timestamptz,                               -- estimated finish, when the runner has one
  need        text,                                      -- Blocked: the question for you
  answer      text,                                      -- your answer (the runner resumes with it)
  result      text,                                      -- written on the note after testing
  log         jsonb not null default '[]'::jsonb,        -- [{ at, text }] — the last steps
  session     text,                                      -- the Claude session this note's runs continue
  run_at      timestamptz not null default now(),        -- Push = now, Schedule = later
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists architect_update_runs_due on public.architect_update_runs (user_id, status, run_at);
alter table public.architect_update_runs enable row level security;
drop policy if exists "update runs: owner" on public.architect_update_runs;
create policy "update runs: owner" on public.architect_update_runs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.architect_update_runs from anon;
grant select, insert, update, delete on public.architect_update_runs to authenticated;
drop trigger if exists architect_update_runs_touch on public.architect_update_runs;
create trigger architect_update_runs_touch before update on public.architect_update_runs
  for each row execute function public.architect_touch();

-- The runner (runner/architect-runner.mjs) — authenticated with one of your API tokens (Settings → API).
--   next    → claims the next due run (queued, run_at ≤ now) and returns it, or null
--   report  { id, step?, eta_seconds?, status?: running|blocked, need?, session?, log? }
--   finish  { id, ok, result }
--   get     { id } → the run (to see a cancel or an answer)
create or replace function public.architect_runner(token text, action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid;
  p jsonb := coalesce(payload, '{}'::jsonb);
  r public.architect_update_runs;
  rid uuid;
begin
  select user_id into me from public.api_tokens
   where token_hash = encode(digest(convert_to(coalesce(token, ''), 'UTF8'), 'sha256'), 'hex');
  if me is null then raise exception 'Invalid API token.' using errcode = '28000'; end if;
  update public.api_tokens set last_used_at = now()
   where token_hash = encode(digest(convert_to(token, 'UTF8'), 'sha256'), 'hex');

  if action = 'next' then
    -- a runner that went quiet mid-run (PC off, crash): mark it so the note can be pushed again
    update public.architect_update_runs set status = 'failed', result = coalesce(result, 'The runner stopped responding.'), ended_at = now()
     where user_id = me and status = 'running' and updated_at < now() - interval '30 minutes';
    select * into r from public.architect_update_runs
     where user_id = me and status = 'queued' and run_at <= now()
     order by run_at, created_at limit 1 for update skip locked;
    if r.id is null then return 'null'::jsonb; end if;
    update public.architect_update_runs set status = 'running', started_at = coalesce(started_at, now()), step = 'Starting', need = null
     where id = r.id returning * into r;
    return to_jsonb(r) || jsonb_build_object('avg_seconds',
      (select round(avg(extract(epoch from (ended_at - started_at))))::int from (
         select started_at, ended_at from public.architect_update_runs
          where user_id = me and status = 'done' and started_at is not null and ended_at is not null
          order by ended_at desc limit 10) x));
  end if;

  rid := nullif(p->>'id', '')::uuid;
  select * into r from public.architect_update_runs where id = rid and user_id = me;
  if r.id is null then raise exception 'Run not found.' using errcode = 'P0002'; end if;

  if action = 'get' then
    return to_jsonb(r);
  elsif action = 'report' then
    if r.status in ('canceled', 'done', 'failed') then return to_jsonb(r); end if; -- canceled in the app: the runner stops
    update public.architect_update_runs set
      step = coalesce(left(p->>'step', 300), step),
      eta_at = case when p ? 'eta_seconds' then now() + make_interval(secs => greatest(0, (p->>'eta_seconds')::int)) else eta_at end,
      status = case when p->>'status' in ('running', 'blocked') then p->>'status' else status end,
      need = case when p->>'status' = 'blocked' then left(coalesce(p->>'need', 'The run needs your input.'), 2000) when p->>'status' = 'running' then null else need end,
      answer = case when p->>'status' = 'running' then null else answer end,
      session = coalesce(nullif(p->>'session', ''), session),
      log = case when p ? 'log' then (
        select coalesce(jsonb_agg(e), '[]'::jsonb) from (
          select e from jsonb_array_elements(log || jsonb_build_array(jsonb_build_object('at', now(), 'text', left(p->>'log', 300)))) e
          offset greatest(0, jsonb_array_length(log) + 1 - 40)) t) else log end
     where id = r.id returning * into r;
    return to_jsonb(r);
  elsif action = 'finish' then
    if r.status = 'canceled' then return to_jsonb(r); end if;
    update public.architect_update_runs set
      status = case when coalesce((p->>'ok')::boolean, false) then 'done' else 'failed' end,
      result = left(coalesce(p->>'result', ''), 4000), step = null, eta_at = null, need = null,
      session = coalesce(nullif(p->>'session', ''), session), ended_at = now()
     where id = r.id returning * into r;
    return to_jsonb(r);
  end if;
  raise exception 'Unknown runner action "%".', action;
end $$;
revoke all on function public.architect_runner(text, text, jsonb) from public;
grant execute on function public.architect_runner(text, text, jsonb) to anon, authenticated;

/* =====================================================================
   Radio: Spotify playlists shared with your Shared Space (shared_items kind 'spotify')
   ===================================================================== */
alter table public.shared_items drop constraint if exists shared_items_kind_check;
alter table public.shared_items add constraint shared_items_kind_check
  check (kind in ('countdown', 'meter', 'varcat', 'spotify'));

-- Anytype ⇄ Path two-way sync lives in nov24-anytype.sql (run it after anytype.sql).

-- Rollback (removes Push Update / Schedule; your canvas notes stay in your settings):
--   drop function if exists public.architect_runner(text, text, jsonb);
--   drop table if exists public.architect_update_runs;
