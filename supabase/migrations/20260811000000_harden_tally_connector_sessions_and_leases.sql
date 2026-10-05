-- This migration is intentionally safe to apply after the existing connector
-- runtime migrations. It is not applied automatically by the application.

alter table public.tally_connectors
  add column if not exists session_generation bigint not null default 1
  check (session_generation > 0);

alter table public.tally_commands
  add column if not exists connector_session_generation bigint;

update public.tally_commands as command
set connector_session_generation = connector.session_generation
from public.tally_connectors as connector
where connector.id = command.connector_id
  and command.connector_session_generation is null;

alter table public.tally_commands
  alter column connector_session_generation set not null;

create or replace function public.set_tally_command_session_generation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select connector.session_generation
  into new.connector_session_generation
  from public.tally_connectors as connector
  where connector.id = new.connector_id;

  if new.connector_session_generation is null then
    raise exception 'Tally connector session was not found';
  end if;
  return new;
end;
$$;

drop trigger if exists tally_commands_set_session_generation on public.tally_commands;
create trigger tally_commands_set_session_generation
  before insert on public.tally_commands
  for each row execute function public.set_tally_command_session_generation();

create or replace function public.claim_tally_commands(
  p_connector_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 90
)
returns setof public.tally_commands
language sql
set search_path = ''
as $$
  with candidates as (
    select command.id
    from public.tally_commands as command
    join public.tally_connectors as connector
      on connector.id = command.connector_id
     and connector.status = 'paired'
     and connector.session_generation = command.connector_session_generation
    join public.tally_connector_company_bindings as binding
      on binding.connector_id = command.connector_id
     and binding.company_id = command.company_id
     and binding.is_active
    where command.connector_id = p_connector_id
      and command.attempts < command.max_attempts
      and (
        (command.status in ('queued', 'failed') and command.available_at <= now())
        or (command.status = 'sending' and command.lease_expires_at < now())
      )
    order by command.available_at, command.created_at
    for update of command skip locked
    limit greatest(1, least(p_limit, 10))
  )
  update public.tally_commands as command
  set status = 'sending',
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      attempts = command.attempts + 1,
      updated_at = now()
  from candidates
  where command.id = candidates.id
  returning command.*;
$$;

create or replace function public.rotate_meenakshi_connector_session(
  p_connector_id uuid,
  p_control_token_hash text,
  p_tally_url text
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_generation bigint;
begin
  update public.tally_connectors
  set control_token_hash = p_control_token_hash,
      status = 'pending_pairing',
      paired_at = null,
      last_heartbeat_at = null,
      tally_url = p_tally_url,
      session_generation = session_generation + 1,
      updated_at = now()
  where id = p_connector_id
    and status <> 'revoked'
  returning session_generation into next_generation;

  if next_generation is null then
    raise exception 'Connector was not found or has been revoked';
  end if;

  update public.tally_commands
  set status = 'dead_letter',
      failure_reason = 'Connector session changed while this command was running. Review before retrying.',
      completed_at = now(),
      locked_at = null,
      locked_by = null,
      lease_expires_at = null,
      updated_at = now()
  where connector_id = p_connector_id
    and status = 'sending';

  update public.tally_commands
  set connector_session_generation = next_generation,
      updated_at = now()
  where connector_id = p_connector_id
    and status in ('queued', 'failed');

  return next_generation;
end;
$$;

create table if not exists public.integration_worker_heartbeats (
  worker_name text primary key,
  worker_type text not null,
  status text not null check (status in ('running', 'degraded', 'stopped')),
  last_heartbeat_at timestamptz not null,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists integration_worker_heartbeats_type_idx
  on public.integration_worker_heartbeats (worker_type, last_heartbeat_at desc);

alter table public.integration_worker_heartbeats enable row level security;

revoke all on table public.integration_worker_heartbeats from anon, authenticated;
revoke all on function public.rotate_meenakshi_connector_session(uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_tally_command_session_generation() from public, anon, authenticated;
grant all on table public.integration_worker_heartbeats to service_role;
grant execute on function public.rotate_meenakshi_connector_session(uuid, text, text) to service_role;
grant execute on function public.set_tally_command_session_generation() to service_role;
grant execute on function public.claim_tally_commands(uuid, text, integer, integer) to service_role;
