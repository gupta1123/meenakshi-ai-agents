-- Faster Turnover Discount page. Functions only: no table or index changes.
--
-- 1) proposal_latest_evaluations: the list used to download every saved
--    evaluation of every customer (about 18,000 rows) to keep the newest one,
--    then download the large payment-check JSON of each and summarise it in
--    Node. This returns just the newest evaluation, its run status and the
--    payment summary, in one query, using the existing unique index on
--    (proposal_id, evaluation_number).
-- 2) get_proposal_detail_light: the customer drawer payload was about 1.1 MB for
--    a customer with ~1,000 invoices (payment checks 750 KB, contributions
--    350 KB). The light version leaves those two lists out and returns their
--    counts; the lists are fetched only when the Payment check / Tally evidence
--    views are opened.

create or replace function public.proposal_latest_evaluations(
  p_company_id uuid,
  p_proposal_ids uuid[],
  p_with_payment boolean default false
)
returns table (
  proposal_id uuid,
  evaluation_id uuid,
  evaluation_run_id uuid,
  evaluation_number integer,
  source_fingerprint text,
  evaluated_at timestamptz,
  run_status text,
  run_completed_at timestamptz,
  payment_summary jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    p.id,
    e.id,
    e.evaluation_run_id,
    e.evaluation_number,
    e.source_fingerprint,
    e.evaluated_at,
    r.status::text,
    r.completed_at,
    case when p_with_payment and jsonb_typeof(e.formula_snapshot -> 'paymentChecks') = 'array' then (
      select jsonb_build_object(
        'total', count(*),
        'counted', count(*) filter (where c.counted),
        'late', count(*) filter (where not c.counted and c.reason = 'paid_after_due_date'),
        'partlyPaid', count(*) filter (where not c.counted and c.reason = 'partly_paid'),
        'unpaid', count(*) filter (where not c.counted and c.reason = 'not_paid'),
        'excludedTonnes', to_char(coalesce(sum(c.tonnes) filter (where not c.counted), 0), 'FM999999990.000'),
        'excluded', coalesce(jsonb_agg(jsonb_build_object(
            'voucherNumber', c.item -> 'voucherNumber',
            'invoiceDate', c.item -> 'invoiceDate',
            'dueDate', c.item -> 'dueDate',
            'paidInFullOn', c.item -> 'paidInFullOn',
            'daysTaken', c.item -> 'daysTaken',
            'invoiceAmount', coalesce(c.item -> 'invoiceAmount', '"0"'::jsonb),
            'paidTotal', coalesce(c.item -> 'paidTotal', '"0"'::jsonb),
            'tonnes', coalesce(c.item -> 'tonnes', '"0"'::jsonb),
            'reason', to_jsonb(c.reason)
          )) filter (where not c.counted), '[]'::jsonb)
      )
      from (
        select x as item,
          coalesce(case when jsonb_typeof(x -> 'counted') = 'boolean' then (x ->> 'counted')::boolean end, false) as counted,
          coalesce(nullif(x ->> 'reason', ''), 'not_paid') as reason,
          case when x ->> 'tonnes' ~ '^-?[0-9]+(\.[0-9]+)?$' then (x ->> 'tonnes')::numeric else 0 end as tonnes
        from jsonb_array_elements(e.formula_snapshot -> 'paymentChecks') x
      ) c
    ) end
  from unnest(p_proposal_ids) as p(id)
  join lateral (
    select pe.id, pe.evaluation_run_id, pe.evaluation_number, pe.source_fingerprint, pe.evaluated_at,
           case when p_with_payment then pe.formula_snapshot end as formula_snapshot
    from public.proposal_evaluations pe
    where pe.proposal_id = p.id and pe.company_id = p_company_id
    order by pe.evaluation_number desc
    limit 1
  ) e on true
  left join public.evaluation_runs r on r.id = e.evaluation_run_id and r.company_id = p_company_id;
$$;

revoke all on function public.proposal_latest_evaluations(uuid, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.proposal_latest_evaluations(uuid, uuid[], boolean) to service_role;

create or replace function public.get_proposal_detail_light(p_proposal_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_detail jsonb;
  v_snapshot jsonb;
  v_checks jsonb;
  v_contributions jsonb;
begin
  v_detail := public.get_proposal_detail(p_proposal_id, p_company_id);
  v_snapshot := v_detail -> 'latestEvaluation' -> 'formula_snapshot';
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then
    return v_detail;
  end if;
  v_checks := v_snapshot -> 'paymentChecks';
  v_contributions := v_snapshot -> 'contributions';
  v_snapshot := (v_snapshot - 'paymentChecks' - 'contributions') || jsonb_build_object(
    'light', true,
    'paymentCheckTotal', case when jsonb_typeof(v_checks) = 'array' then jsonb_array_length(v_checks) end,
    'paymentCheckCounted', case when jsonb_typeof(v_checks) = 'array'
      then (select count(*) from jsonb_array_elements(v_checks) c where c ->> 'counted' = 'true') end,
    'contributionTotal', case when jsonb_typeof(v_contributions) = 'array' then jsonb_array_length(v_contributions) end
  );
  return jsonb_set(v_detail, '{latestEvaluation,formula_snapshot}', v_snapshot);
end;
$$;

revoke all on function public.get_proposal_detail_light(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_proposal_detail_light(uuid, uuid) to service_role;

comment on function public.proposal_latest_evaluations(uuid, uuid[], boolean) is 'Newest evaluation + run status (+ TOD payment summary) per proposal in one query.';
comment on function public.get_proposal_detail_light(uuid, uuid) is 'get_proposal_detail without the paymentChecks/contributions lists (counts only).';
