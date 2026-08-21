create extension if not exists vector with schema extensions;

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null check (char_length(session_id) between 1 and 128),
  turn_id uuid,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null check (char_length(content) between 1 and 32768),
  created_at timestamptz not null default now()
);

alter table public.agent_messages
  add column if not exists turn_id uuid;

create index if not exists agent_messages_session_created_idx
  on public.agent_messages (session_id, created_at desc);

create unique index if not exists agent_messages_turn_role_unique_idx
  on public.agent_messages (turn_id, role)
  where turn_id is not null;

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 10000),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 1 and 128),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_tasks
  add column if not exists idempotency_key text,
  add column if not exists version bigint not null default 1;

create unique index if not exists agent_tasks_idempotency_key_unique_idx
  on public.agent_tasks (idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_tasks_status_created_idx
  on public.agent_tasks (status, created_at desc);

create index if not exists agent_tasks_due_at_pending_idx
  on public.agent_tasks (due_at, created_at)
  where status = 'pending';

create or replace function public.set_agent_task_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_agent_task_updated_at on public.agent_tasks;
create trigger set_agent_task_updated_at
before update on public.agent_tasks
for each row execute function public.set_agent_task_updated_at();

create or replace function public.claim_agent_task()
returns setof public.agent_tasks
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select queued.id
    from public.agent_tasks as queued
    where queued.status = 'pending'
      and (queued.due_at is null or queued.due_at <= now())
    order by queued.created_at asc
    for update skip locked
    limit 1
  )
  update public.agent_tasks as claimed
  set
    status = 'running',
    version = claimed.version + 1,
    updated_at = now()
  from candidate
  where claimed.id = candidate.id
  returning claimed.*;
end;
$$;

create table if not exists public.agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_knowledge_embedding_hnsw_idx
  on public.agent_knowledge
  using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists set_agent_knowledge_updated_at on public.agent_knowledge;
create trigger set_agent_knowledge_updated_at
before update on public.agent_knowledge
for each row execute function public.set_agent_task_updated_at();

create or replace function public.match_agent_knowledge(
  query_embedding extensions.vector(1024),
  match_threshold double precision default 0.70,
  match_count integer default 10,
  metadata_filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    knowledge.id,
    knowledge.content,
    knowledge.metadata,
    1 - (knowledge.embedding <=> query_embedding) as similarity
  from public.agent_knowledge as knowledge
  where knowledge.metadata @> metadata_filter
    and 1 - (knowledge.embedding <=> query_embedding) >= match_threshold
  order by knowledge.embedding <=> query_embedding
  limit greatest(1, least(match_count, 100));
$$;

alter table public.agent_messages enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_knowledge enable row level security;

revoke all on public.agent_messages from public, anon, authenticated;
revoke all on public.agent_tasks from public, anon, authenticated;
revoke all on public.agent_knowledge from public, anon, authenticated;
revoke all on function public.set_agent_task_updated_at() from public, anon, authenticated;
revoke all on function public.claim_agent_task() from public, anon, authenticated;
revoke all on function public.match_agent_knowledge(
  extensions.vector, double precision, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.match_agent_knowledge(
  extensions.vector, double precision, integer, jsonb
) to service_role;

grant execute on function public.claim_agent_task() to service_role;
grant select, insert, delete on public.agent_messages to service_role;
grant all on public.agent_tasks to service_role;
grant all on public.agent_knowledge to service_role;
