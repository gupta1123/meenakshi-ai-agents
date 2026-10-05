-- Fan one bounded live Tally scan into independently auditable customer evaluations.
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
  aggregate jsonb;
  child_run public.evaluation_runs;
  customer_id uuid;
  evidence jsonb;
  run_ids uuid[] := '{}';
  item_index integer := 0;
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

  for aggregate in select value from jsonb_array_elements(p_batch_result -> 'customerAggregates') loop
    customer_id := nullif(aggregate ->> 'customerId', '')::uuid;
    if not exists (select 1 from public.customers where id = customer_id and company_id = p_company_id and is_available) then
      raise exception 'Batch result contains an unavailable customer';
    end if;
    evidence := (p_batch_result - 'customerAggregates') || aggregate || jsonb_build_object('mode', 'live_tod_aggregate');
    if item_index = 0 then
      evidence := jsonb_set(evidence, '{evaluationRunId}', to_jsonb(parent_run.id::text));
      update public.evaluation_runs
      set request_context = (request_context - 'batch') || jsonb_build_object('customerId', customer_id),
          summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('evidenceMode', 'live_tod_aggregate', 'liveTodEvidence', evidence),
          status = 'queued',
          locked_at = null,
          locked_by = null,
          lease_expires_at = null,
          updated_at = now()
      where id = parent_run.id
      returning * into child_run;
    else
      insert into public.evaluation_runs (
        company_id, evaluation_date, status, requested_by, request_context,
        idempotency_key, correlation_id, tally_master_refresh_run_id,
        tally_voucher_refresh_run_id, summary
      ) values (
        p_company_id, parent_run.evaluation_date, 'queued', parent_run.requested_by,
        (parent_run.request_context - 'batch') || jsonb_build_object('customerId', customer_id),
        parent_run.id::text || ':' || customer_id::text, gen_random_uuid(),
        parent_run.tally_master_refresh_run_id, parent_run.tally_voucher_refresh_run_id,
        jsonb_build_object('evidenceMode', 'live_tod_aggregate', 'liveTodEvidence', evidence)
      ) returning * into child_run;
      evidence := jsonb_set(evidence, '{evaluationRunId}', to_jsonb(child_run.id::text));
      update public.evaluation_runs
      set summary = jsonb_build_object('evidenceMode', 'live_tod_aggregate', 'liveTodEvidence', evidence)
      where id = child_run.id;
      insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
      select company.organization_id, p_company_id, 'user', parent_run.requested_by, 'evaluation_requested', 'evaluation_run', child_run.id, child_run.correlation_id,
             jsonb_build_object('status', child_run.status, 'schemeType', 'tod', 'source', 'batch')
      from public.companies company where company.id = p_company_id;
    end if;
    run_ids := array_append(run_ids, child_run.id);
    item_index := item_index + 1;
  end loop;
  return jsonb_build_object('runsCreated', item_index, 'runIds', to_jsonb(run_ids));
end;
$$;

revoke all on function public.fanout_meenakshi_tod_batch_evaluation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fanout_meenakshi_tod_batch_evaluation(uuid, uuid, jsonb) to service_role;
