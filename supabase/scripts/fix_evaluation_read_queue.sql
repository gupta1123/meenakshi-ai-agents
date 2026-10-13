-- Apply once in the Supabase SQL editor. This preserves the existing RPC
-- signatures and permissions; it does not create or modify financial vouchers.
begin;

create or replace function public.claim_tally_commands(
  p_connector_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 90
)
returns setof public.tally_commands
language plpgsql
set search_path = ''
as $$
begin
  -- Serialize claims from multiple polling processes for this connector.
  perform pg_advisory_xact_lock(hashtextextended('tally-command:' || p_connector_id::text, 0));
  -- Repair obsolete retries even when an older deployed backend is polling.
  update public.tally_commands as command
  set status = 'dead_letter',
      failure_reason = 'Obsolete evaluation read: calculation is completed or uses local Tally evidence.',
      completed_at = now(), locked_at = null, locked_by = null,
      lease_expires_at = null, updated_at = now()
  from public.evaluation_runs as evaluation
  where command.connector_id = p_connector_id
    and command.command_type = 'fetch_meenakshi_evidence'
    and command.status in ('queued', 'failed', 'sending')
    and evaluation.company_id = command.company_id
    and evaluation.id::text = command.payload ->> 'evaluationRunId'
    and (
      evaluation.status in ('completed', 'completed_with_issues', 'cancelled')
      or (evaluation.status = 'failed' and evaluation.attempts >= evaluation.max_attempts)
      or evaluation.request_context ->> 'localFirst' = 'true'
    );

  return query
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
      and not exists (
        select 1 from public.tally_commands as active
        where active.connector_id = p_connector_id
          and active.status = 'sending'
          and active.lease_expires_at >= now()
      )
    order by case
      when command.command_type = 'verify_credit_note' then 0
      when command.command_type in ('create_credit_note', 'create_debit_note') then 1
      else 2
    end, command.available_at, command.created_at
    for update of command skip locked
    -- One command at a time, including when a caller asks for a larger batch.
    limit 1
  )
  update public.tally_commands as command
  set status = 'sending', locked_at = now(), locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      attempts = command.attempts + 1, updated_at = now()
  from candidates
  where command.id = candidates.id
  returning command.*;
end;
$$;

create or replace function public.claim_meenakshi_evaluation_runs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns setof public.evaluation_runs
language sql
set search_path = ''
as $$
  with candidates as (
    select evaluation.id
    from public.evaluation_runs as evaluation
    where evaluation.attempts < evaluation.max_attempts
      and (
        evaluation.status in ('queued', 'failed')
        or (evaluation.status in ('refreshing_tally', 'evaluating') and evaluation.lease_expires_at < now())
      )
      -- Local API saves own their initial queued row. Only TOD customer rows
      -- with attached local evidence need the evaluator worker afterwards.
      and (
        coalesce(evaluation.request_context ->> 'localFirst', 'false') <> 'true'
        or (evaluation.request_context ->> 'schemeType' = 'tod'
          and evaluation.summary -> 'liveTodEvidence' ->> 'mode' = 'live_tod_aggregate')
      )
    order by evaluation.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.evaluation_runs as evaluation
  set status = case when evaluation.status in ('queued', 'failed')
        then 'refreshing_tally'::public.evaluation_run_status else evaluation.status end,
      locked_at = now(), locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(5, p_lease_seconds)),
      attempts = evaluation.attempts + case when evaluation.status in ('queued', 'failed') then 1 else 0 end,
      error_summary = null, started_at = coalesce(evaluation.started_at, now()), updated_at = now()
  from candidates
  where evaluation.id = candidates.id
  returning evaluation.*;
$$;

create or replace function public.request_meenakshi_evaluation_refresh(
  p_evaluation_run_id uuid,
  p_worker_id text,
  p_master_scope jsonb,
  p_voucher_scope jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  evaluation public.evaluation_runs;
  company public.companies;
  master_run public.tally_sync_runs;
  voucher_run public.tally_sync_runs;
begin
  select * into evaluation from public.evaluation_runs
  where id = p_evaluation_run_id and locked_by = p_worker_id
    and lease_expires_at >= now()
  for update;
  if not found then raise exception 'Evaluation run is not leased by this worker'; end if;

  -- Recheck after locking: a local result may have arrived after the worker
  -- claimed the original row. It must not enqueue a second read in that race.
  if evaluation.request_context ->> 'localFirst' = 'true'
    or evaluation.status in ('completed', 'completed_with_issues', 'cancelled') then
    return jsonb_build_object('skipped', true, 'reason', 'Local or finished calculation does not need a refresh');
  end if;
  if evaluation.tally_master_refresh_run_id is not null and evaluation.tally_voucher_refresh_run_id is not null then
    return jsonb_build_object('masterSyncRunId', evaluation.tally_master_refresh_run_id,
      'voucherSyncRunId', evaluation.tally_voucher_refresh_run_id, 'alreadyRequested', true);
  end if;
  select * into company from public.companies where id = evaluation.company_id;
  insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
  values (evaluation.company_id, 'masters', 'queued', coalesce(p_master_scope, '{}'::jsonb) || jsonb_build_object('evaluationRunId', evaluation.id))
  returning * into master_run;
  insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
  values (evaluation.company_id, 'vouchers', 'queued', coalesce(p_voucher_scope, '{}'::jsonb) || jsonb_build_object('evaluationRunId', evaluation.id))
  returning * into voucher_run;
  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload,
    organization_id, company_id, correlation_id, idempotency_key
  ) values (
    'evaluation-refresh:' || evaluation.id::text, 'tally_targeted_refresh', 'evaluation_run', evaluation.id,
    jsonb_build_object('evaluationRunId', evaluation.id, 'masterSyncRunId', master_run.id,
      'voucherSyncRunId', voucher_run.id, 'masterScope', master_run.requested_scope, 'voucherScope', voucher_run.requested_scope),
    company.organization_id, evaluation.company_id, evaluation.correlation_id, 'evaluation-refresh:' || evaluation.id::text
  ) on conflict (event_key) do nothing;
  update public.evaluation_runs
  set status = 'refreshing_tally', tally_master_refresh_run_id = master_run.id,
      tally_voucher_refresh_run_id = voucher_run.id, tally_refresh_run_id = voucher_run.id, updated_at = now()
  where id = evaluation.id;
  return jsonb_build_object('masterSyncRunId', master_run.id, 'voucherSyncRunId', voucher_run.id, 'alreadyRequested', false);
end;
$$;

commit;
