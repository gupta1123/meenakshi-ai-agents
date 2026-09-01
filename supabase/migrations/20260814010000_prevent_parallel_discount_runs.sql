create or replace function public.create_meenakshi_evaluation_run(
  p_organization_id uuid,
  p_company_id uuid,
  p_actor_id uuid,
  p_request_context jsonb,
  p_idempotency_key text
)
returns public.evaluation_runs
language plpgsql
set search_path = ''
as $$
declare
  existing_run public.evaluation_runs;
  created_run public.evaluation_runs;
  request_scheme_type public.scheme_type;
begin
  request_scheme_type := nullif(p_request_context ->> 'schemeType', '')::public.scheme_type;
  if request_scheme_type not in ('cd', 'tod') then
    raise exception 'Evaluation request context must contain schemeType cd or tod';
  end if;
  if coalesce(length(btrim(p_idempotency_key)), 0) = 0 then
    raise exception 'An evaluation idempotency key is required';
  end if;
  if not exists (
    select 1 from public.companies company
    where company.id = p_company_id
      and company.organization_id = p_organization_id
      and company.is_active
  ) then
    raise exception 'Company is unavailable to this organization';
  end if;

  select evaluation.* into existing_run
  from public.evaluation_runs evaluation
  where evaluation.company_id = p_company_id
    and evaluation.idempotency_key = p_idempotency_key;
  if found then return existing_run; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || request_scheme_type::text, 0));

  select evaluation.* into existing_run
  from public.evaluation_runs evaluation
  where evaluation.company_id = p_company_id
    and evaluation.request_context ->> 'schemeType' = request_scheme_type::text
    and evaluation.status in ('queued', 'refreshing_tally', 'evaluating')
  order by evaluation.created_at desc
  limit 1;
  if found then return existing_run; end if;

  insert into public.evaluation_runs (
    company_id, evaluation_date, status, requested_by, request_context,
    idempotency_key, correlation_id
  ) values (
    p_company_id, current_date, 'queued', p_actor_id,
    coalesce(p_request_context, '{}'::jsonb), p_idempotency_key,
    gen_random_uuid()
  ) returning * into created_run;

  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action,
    entity_type, entity_id, correlation_id, new_value
  ) values (
    p_organization_id, p_company_id, 'user', p_actor_id,
    'evaluation_requested', 'evaluation_run', created_run.id,
    created_run.correlation_id,
    jsonb_build_object('status', created_run.status, 'schemeType', request_scheme_type)
  );

  return created_run;
end;
$$;
