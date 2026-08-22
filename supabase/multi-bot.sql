-- Multi-Bot group chat tables

create table if not exists public.agent_bots (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 64),
  role_description text not null default '' check (char_length(role_description) <= 500),
  system_prompt text not null default '' check (char_length(system_prompt) <= 8000),
  model text not null default 'x-preview-f-free' check (char_length(model) between 1 and 128),
  color text not null default '#4F46E5' check (color ~ '^#[0-9a-fA-F]{6}$'),
  avatar_emoji text not null default '🤖',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_bot_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists set_bot_updated_at on public.agent_bots;
create trigger set_bot_updated_at before update on public.agent_bots
for each row execute function public.set_bot_updated_at();

create table if not exists public.agent_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  bot_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_channels_bot_ids_valid check (jsonb_typeof(bot_ids) = 'array')
);

create or replace function public.set_channel_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists set_channel_updated_at on public.agent_channels;
create trigger set_channel_updated_at before update on public.agent_channels
for each row execute function public.set_channel_updated_at();

alter table public.agent_messages add column if not exists channel_id uuid references public.agent_channels(id);
alter table public.agent_messages add column if not exists bot_id uuid references public.agent_bots(id);

create index if not exists agent_messages_channel_created_idx
  on public.agent_messages (channel_id, created_at asc);

create index if not exists agent_messages_bot_idx on public.agent_messages (bot_id);

alter table public.agent_bots enable row level security;
alter table public.agent_channels enable row level security;
revoke all on public.agent_bots from anon, authenticated;
revoke all on public.agent_channels from anon, authenticated;
