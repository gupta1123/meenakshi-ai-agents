-- Server mode for Cash Discount / Turnover Discount checks.
--
-- ADDITIVE ONLY: new tables and new functions. No existing table, column,
-- constraint or function is changed, so the deployed backend, the deployed
-- frontend and every PC connector keep working before and after this runs.
--
-- A connector with no row in tally_connector_modes is a PC connector, exactly
-- as today. Check jobs are only ever created for connectors marked 'server'.

-- 1. Which connectors run on a server (everything else is a PC connector).
create table if not exists public.tally_connector_modes (
  connector_id uuid primary key references public.tally_connectors(id) on delete cascade,
  mode text not null check (mode in ('pc', 'server')),
  updated_at timestamptz not null default now()
);

-- 2. The queue of checks a server connector runs on behalf of web users.
create table if not exists public.tally_check_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id uuid not null,
  kind text not null check (kind in ('cd', 'tod', 'einvoice')),
  -- Identifies "the same request": e.g. 'cd:<rule version>' or
  -- 'tod:<period start>:<period end>'. Asking again while one is active joins it.
  scope_key text not null check (length(scope_key) between 1 and 300),
  request jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  requested_by uuid references public.profiles(id) on delete set null,
  connector_id uuid references public.tally_connectors(id) on delete set null,
  locked_by text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  cancel_requested boolean not null default false,
  progress jsonb,
  result jsonb,
  failing_step text,
  failure_reason text,
  evaluation_run_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id)
    references public.companies(id, organization_id) on delete cascade,
  check (status <> 'running' or (locked_by is not null and lease_expires_at is not null))
);

-- At most one active job per company and request: the database itself stops
-- two people starting the same check twice.
create unique index if not exists tally_check_jobs_active_scope_idx
  on public.tally_check_jobs (company_id, scope_key)
  where status in ('queued', 'running');
create index if not exists tally_check_jobs_company_status_idx
  on public.tally_check_jobs (company_id, status, created_at);

alter table public.tally_connector_modes enable row level security;
alter table public.tally_check_jobs enable row level security;
revoke all on public.tally_connector_modes from anon, authenticated;
revoke all on public.tally_check_jobs from anon, authenticated;

-- 3. Ask for a check. Joins the identical active one instead of repeating it.
create or replace function public.request_tally_check_job(
  p_organization_id uuid,
  p_company_id uuid,
  p_kind text,
  p_scope_key text,
  p_request jsonb,
  p_requested_by uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_connector uuid;
  v_job public.tally_check_jobs;
  v_joined boolean := false;
begin
  select binding.connector_id into v_connector
  from public.tally_connector_company_bindings binding
  join public.tally_connectors connector on connector.id = binding.connector_id and connector.status = 'paired'
  where binding.company_id = p_company_id and binding.is_active
  limit 1;
  if v_connector is null then
    raise exception 'No Tally computer is connected for this company.' using errcode = 'P0001';
  end if;
  if coalesce((select mode from public.tally_connector_modes where connector_id = v_connector), 'pc') <> 'server' then
    raise exception 'This company uses a Tally computer connector, not a server.' using errcode = 'P0001';
  end if;

  insert into public.tally_check_jobs (organization_id, company_id, kind, scope_key, request, requested_by, connector_id)
  values (p_organization_id, p_company_id, p_kind, p_scope_key, p_request, p_requested_by, v_connector)
  on conflict (company_id, scope_key) where status in ('queued', 'running') do nothing
  returning * into v_job;

  if v_job.id is null then
    v_joined := true;
    select * into v_job from public.tally_check_jobs
    where company_id = p_company_id and scope_key = p_scope_key and status in ('queued', 'running');
    if v_job.id is null then
      -- It finished between the insert and the select; ask the caller to retry.
      raise exception 'The check just finished. Please try again.' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'joined', v_joined,
    'job', to_jsonb(v_job) - 'request',
    'queuePosition', (
      select count(*) from public.tally_check_jobs ahead
      where ahead.company_id = v_job.company_id and ahead.status in ('queued', 'running')
        and (ahead.status = 'running' or ahead.created_at < v_job.created_at) and ahead.id <> v_job.id
    )
  );
end;
$$;

-- 4. The server connector claims its next job. One running job per company.
create or replace function public.claim_tally_check_job(
  p_connector_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180
)
returns setof public.tally_check_jobs
language plpgsql
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if coalesce((select mode from public.tally_connector_modes where connector_id = p_connector_id), 'pc') <> 'server' then
    return;
  end if;
  -- One claim at a time per connector.
  perform pg_advisory_xact_lock(hashtext('tally_check_job:' || p_connector_id::text));

  -- Requests nobody picked up for 30 minutes are stale: drop them.
  update public.tally_check_jobs
  set status = 'expired', failure_reason = 'Nobody picked this check up in time. Start it again.',
      finished_at = now(), updated_at = now()
  where connector_id = p_connector_id and status = 'queued' and created_at < now() - interval '30 minutes';

  -- A running job whose connector stopped renewing: retry it, or give up.
  update public.tally_check_jobs
  set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      failing_step = case when attempts >= max_attempts then 'tally_read' else failing_step end,
      failure_reason = case when attempts >= max_attempts then 'The Tally server stopped answering during this check.' else failure_reason end,
      finished_at = case when attempts >= max_attempts then now() else null end,
      locked_by = null, lease_expires_at = null, updated_at = now()
  where connector_id = p_connector_id and status = 'running' and lease_expires_at < now();

  select job.id into v_job_id
  from public.tally_check_jobs job
  join public.tally_connector_company_bindings binding
    on binding.connector_id = job.connector_id and binding.company_id = job.company_id and binding.is_active
  where job.connector_id = p_connector_id and job.status = 'queued'
    and not exists (
      select 1 from public.tally_check_jobs busy
      where busy.company_id = job.company_id and busy.status = 'running'
    )
  order by job.created_at
  limit 1
  for update of job skip locked;

  if v_job_id is null then return; end if;

  return query
  update public.tally_check_jobs
  set status = 'running', locked_by = p_worker_id, attempts = attempts + 1,
      lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
      started_at = coalesce(started_at, now()), cancel_requested = false, updated_at = now()
  where id = v_job_id
  returning *;
end;
$$;

-- 5. The connector keeps its lease alive and reports progress.
create or replace function public.renew_tally_check_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer,
  p_progress jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cancel boolean;
begin
  update public.tally_check_jobs
  set lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
      progress = coalesce(p_progress, progress), updated_at = now()
  where id = p_job_id and status = 'running' and locked_by = p_worker_id
  returning cancel_requested into v_cancel;
  if not found then return jsonb_build_object('ok', false, 'cancelRequested', false); end if;
  return jsonb_build_object('ok', true, 'cancelRequested', v_cancel);
end;
$$;

-- 6. The connector (or the backend, on its behalf) ends a job.
create or replace function public.finish_tally_check_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_result jsonb,
  p_failing_step text,
  p_failure_reason text,
  p_evaluation_run_id uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'Invalid check job status %', p_status;
  end if;
  update public.tally_check_jobs
  set status = p_status, result = p_result, failing_step = p_failing_step,
      failure_reason = left(p_failure_reason, 1000), evaluation_run_id = p_evaluation_run_id,
      locked_by = null, lease_expires_at = null, finished_at = now(), updated_at = now()
  where id = p_job_id and status = 'running' and locked_by = p_worker_id;
  return found;
end;
$$;

-- 7. A person stops a check. Queued: gone now. Running: the connector is told.
create or replace function public.cancel_tally_check_job(
  p_job_id uuid,
  p_company_id uuid
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  update public.tally_check_jobs
  set status = 'cancelled', failure_reason = 'Stopped by a user.', finished_at = now(), updated_at = now()
  where id = p_job_id and company_id = p_company_id and status = 'queued'
  returning status into v_status;
  if found then return v_status; end if;
  update public.tally_check_jobs
  set cancel_requested = true, updated_at = now()
  where id = p_job_id and company_id = p_company_id and status = 'running'
  returning status into v_status;
  return coalesce(v_status, 'finished');
end;
$$;

revoke all on function public.request_tally_check_job(uuid, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.claim_tally_check_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.renew_tally_check_job(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.finish_tally_check_job(uuid, text, text, jsonb, text, text, uuid) from public, anon, authenticated;
revoke all on function public.cancel_tally_check_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_tally_check_job(uuid, uuid, text, text, jsonb, uuid) to service_role;
grant execute on function public.claim_tally_check_job(uuid, text, integer) to service_role;
grant execute on function public.renew_tally_check_job(uuid, text, integer, jsonb) to service_role;
grant execute on function public.finish_tally_check_job(uuid, text, text, jsonb, text, text, uuid) to service_role;
grant execute on function public.cancel_tally_check_job(uuid, uuid) to service_role;
