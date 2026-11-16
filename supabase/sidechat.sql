-- Architect — Side Chat (private chats that live on your account)
-- Run once in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Only the owner can read or write these rows: no partner, board or share access.

create table if not exists public.side_chats (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default 'Chat' check (char_length(name) between 1 and 40),
  photo       text,
  position    double precision not null default 0,
  anytype_id  text,
  created_at  timestamptz not null default now()
);
create index if not exists side_chats_user_idx on public.side_chats (user_id, position);

create table if not exists public.side_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chat_id     uuid not null references public.side_chats (id) on delete cascade,
  body        text not null default '' check (char_length(body) <= 20000),
  files       jsonb not null default '[]'::jsonb,
  reply_to    jsonb,
  pinned      boolean not null default false,
  edited      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists side_messages_chat_idx on public.side_messages (chat_id, created_at);

alter table public.side_chats enable row level security;
alter table public.side_messages enable row level security;

drop policy if exists "side_chats: owner" on public.side_chats;
create policy "side_chats: owner" on public.side_chats
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "side_messages: owner" on public.side_messages;
create policy "side_messages: owner" on public.side_messages
  for all to authenticated using (user_id = auth.uid()) with check (
    user_id = auth.uid()
    and exists (select 1 from public.side_chats c where c.id = chat_id and c.user_id = auth.uid())
  );
