-- Persist one locally calculated TOD aggregate as auditable customer runs
-- without issuing per-customer INSERT/UPDATE/AUDIT statements.
-- This migration is intentionally created for manual application.

create or replace function public.fanout_meenakshi_tod_batch_evaluation(
  p_parent_run_id uuid,
  p_company_id uuid,
  p_batch_result jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  parent_run public.evaluation_runs;
  first_aggregate jsonb;
  first_customer_id uuid;
  first_evidence jsonb;
  child_ids uuid[] := '{}';
  run_ids uuid[];
  aggregate_count integer;
begin
  select * into parent_run
  from public.evaluation_runs
  where id = p_parent_run_id and company_id = p_company_id
  for update;

  if not found then raise exception 'Batch evaluation run is unavailable'; end if;
  if coalesce(parent_run.request_context ->> 'schemeType', '') <> 'tod'
     or coalesce((parent_run.request_context ->> 'batch')::boolean, false) is not true then
    raise exception 'Evaluation run is not a TOD batch request';
  end if;
  if p_batch_result ->> 'mode' <> 'live_tod_batch_aggregate'
     or jsonb_typeof(p_batch_result -> 'customerAggregates') <> 'array'
     or jsonb_array_length(p_batch_result -> 'customerAggregates') = 0 then
    raise exception 'Live TOD batch result is invalid';
  end if;

  aggregate_count := jsonb_array_length(p_batch_result -> 'customerAggregates');

  -- Validate the complete set before mutating the coordinator.
  if exists (
    select 1
    from jsonb_array_elements(p_batch_result -> 'customerAggregates') aggregate
    left join public.customers customer
      on customer.id = nullif(aggregate ->> 'customerId', '')::uuid
     and customer.company_id = p_company_id
     and customer.is_available
    where customer.id is null
  ) then
    raise exception 'Batch result contains an unavailable customer';
  end if;

  first_aggregate := p_batch_result -> 'customerAggregates' -> 0;
  first_customer_id := nullif(first_aggregate ->> 'customerId', '')::uuid;
  first_evidence := jsonb_set(
    (p_batch_result - 'customerAggregates')
      || first_aggregate
      || jsonb_build_object('mode', 'live_tod_aggregate'),
    '{evaluationRunId}',
    to_jsonb(parent_run.id::text)
  );

  -- The coordinator doubles as the first customer result.
  update public.evaluation_runs
  set request_context = (request_context - 'batch') || jsonb_build_object('customerId', first_customer_id),
      summary = coalesce(summary, '{}'::jsonb)
        || jsonb_build_object('evidenceMode', 'live_tod_aggregate', 'liveTodEvidence', first_evidence),
      status = 'queued',
      locked_at = null,
      locked_by = null,
      lease_expires_at = null,
      updated_at = now()
  where id = parent_run.id;

  -- Generate ids first so every evidence document contains its final run id,
  -- then insert every remaining customer in one statement and audit them in
  -- one statement inside the same transaction.
  with candidates as materialized (
    select
      gen_random_uuid() as id,
      gen_random_uuid() as correlation_id,
      aggregate.ordinality,
      aggregate.value as aggregate,
      nullif(aggregate.value ->> 'customerId', '')::uuid as customer_id
    from jsonb_array_elements(p_batch_result -> 'customerAggregates') with ordinality aggregate(value, ordinality)
    where aggregate.ordinality > 1
  ),
  inserted as (
    insert into public.evaluation_runs (
      id, company_id, evaluation_date, status, requested_by, request_context,
      idempotency_key, correlation_id, tally_master_refresh_run_id,
      tally_voucher_refresh_run_id, summary
    )
    select
      candidate.id,
      p_company_id,
      parent_run.evaluation_date,
      'queued',
      parent_run.requested_by,
      (parent_run.request_context - 'batch') || jsonb_build_object('customerId', candidate.customer_id),
      parent_run.id::text || ':' || candidate.customer_id::text,
      candidate.correlation_id,
      parent_run.tally_master_refresh_run_id,
      parent_run.tally_voucher_refresh_run_id,
      jsonb_build_object(
        'evidenceMode', 'live_tod_aggregate',
        'liveTodEvidence', jsonb_set(
          (p_batch_result - 'customerAggregates')
            || candidate.aggregate
            || jsonb_build_object('mode', 'live_tod_aggregate'),
          '{evaluationRunId}',
          to_jsonb(candidate.id::text)
        )
      )
    from candidates candidate
    order by candidate.ordinality
    returning id, correlation_id, status
  ),
  audited as (
    insert into public.audit_events (
      organization_id, company_id, actor_type, actor_id, action,
      entity_type, entity_id, correlation_id, new_value
    )
    select
      company.organization_id,
      p_company_id,
      'user',
      parent_run.requested_by,
      'evaluation_requested',
      'evaluation_run',
      inserted.id,
      inserted.correlation_id,
      jsonb_build_object('status', inserted.status, 'schemeType', 'tod', 'source', 'batch')
    from inserted
    join public.companies company on company.id = p_company_id
    returning entity_id
  )
  select coalesce(array_agg(inserted.id), '{}')
  into child_ids
  from inserted;

  run_ids := array_prepend(parent_run.id, child_ids);
  return jsonb_build_object('runsCreated', aggregate_count, 'runIds', to_jsonb(run_ids));
end;
$$;

revoke all on function public.fanout_meenakshi_tod_batch_evaluation(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fanout_meenakshi_tod_batch_evaluation(uuid, uuid, jsonb)
  to service_role;
