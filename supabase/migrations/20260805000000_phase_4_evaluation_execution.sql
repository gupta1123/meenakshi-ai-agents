-- Meenakshi Phase 4: durable CD/TOD evaluation execution.
--
-- This migration is append-only.  It deliberately keeps calculation logic in
-- the backend domain module and makes the database responsible for durable
-- leasing, period-version locks, cross-company integrity, and atomic snapshot
-- persistence.

alter table public.evaluation_runs
  add column if not exists request_context jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text,
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 5,
  add column if not exists tally_master_refresh_run_id uuid references public.tally_sync_runs(id) on delete set null,
  add column if not exists tally_voucher_refresh_run_id uuid references public.tally_sync_runs(id) on delete set null;

alter table public.scheme_versions
  add column if not exists tod_review_calendar_id uuid;

alter table public.scheme_versions
  add constraint scheme_versions_tod_review_calendar_company_fk
    foreign key (tod_review_calendar_id, company_id)
    references public.working_calendars (id, company_id) on delete restrict;

alter table public.evaluation_runs
  alter column scheme_version_id drop not null,
  alter column period_start drop not null,
  alter column period_end drop not null;

alter table public.evaluation_runs
  drop constraint if exists evaluation_runs_period_end_check,
  add constraint evaluation_runs_period_range_check
    check (
      (period_start is null and period_end is null)
      or (period_start is not null and period_end is not null and period_end >= period_start)
    ),
  add constraint evaluation_runs_attempt_limit_check
    check (attempts >= 0 and attempts <= max_attempts),
  add constraint evaluation_runs_lease_check
    check (
      (locked_by is null and locked_at is null and lease_expires_at is null)
      or (locked_by is not null and locked_at is not null and lease_expires_at is not null)
    ),
  add constraint evaluation_runs_evaluating_context_check
    check (
      status <> 'evaluating'
      or (scheme_version_id is not null and period_start is not null and period_end is not null)
    );

create unique index if not exists evaluation_runs_company_idempotency_idx
  on public.evaluation_runs (company_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists evaluation_runs_worker_idx
  on public.evaluation_runs (status, lease_expires_at, created_at)
  where status in ('queued', 'refreshing_tally', 'evaluating', 'failed');

create index if not exists evaluation_runs_correlation_idx
  on public.evaluation_runs (company_id, correlation_id, created_at desc);

alter table public.schemes
  add constraint schemes_id_company_unique unique (id, company_id);

create table public.tod_customer_period_rule_locks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  scheme_id uuid not null,
  scheme_version_id uuid not null,
  period_start date not null,
  period_end date not null,
  first_evaluation_run_id uuid references public.evaluation_runs(id) on delete set null,
  locked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, customer_id, scheme_id, period_start, period_end),
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (scheme_id, company_id)
    references public.schemes (id, company_id) on delete restrict,
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete restrict,
  check (period_end >= period_start)
);

create index tod_customer_period_rule_locks_lookup_idx
  on public.tod_customer_period_rule_locks (company_id, customer_id, period_start, period_end);

create function public.prevent_tod_customer_period_rule_lock_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'TOD customer-period rule locks are immutable';
  end if;
  if to_jsonb(new) <> to_jsonb(old) then
    raise exception 'TOD customer-period rule locks are immutable';
  end if;
  return new;
end;
$$;

create trigger tod_customer_period_rule_locks_immutable
  before update or delete on public.tod_customer_period_rule_locks
  for each row execute function public.prevent_tod_customer_period_rule_lock_mutation();

create function public.create_meenakshi_evaluation_run(
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
    select 1
    from public.companies company
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
  if found then
    return existing_run;
  end if;

  insert into public.evaluation_runs (
    company_id, evaluation_date, status, requested_by, request_context,
    idempotency_key, correlation_id
  ) values (
    p_company_id, current_date, 'queued', p_actor_id,
    coalesce(p_request_context, '{}'::jsonb), p_idempotency_key,
    gen_random_uuid()
  )
  returning * into created_run;

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

create function public.claim_meenakshi_evaluation_runs(
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
    from public.evaluation_runs evaluation
    where evaluation.attempts < evaluation.max_attempts
      and (
        (evaluation.status in ('queued', 'failed'))
        or (
          evaluation.status in ('refreshing_tally', 'evaluating')
          and evaluation.lease_expires_at < now()
        )
      )
    order by evaluation.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.evaluation_runs evaluation
  set status = case
        when evaluation.status in ('queued', 'failed') then 'refreshing_tally'::public.evaluation_run_status
        else evaluation.status
      end,
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(5, p_lease_seconds)),
      attempts = evaluation.attempts + case when evaluation.status in ('queued', 'failed') then 1 else 0 end,
      error_summary = null,
      started_at = coalesce(evaluation.started_at, now()),
      updated_at = now()
  from candidates
  where evaluation.id = candidates.id
  returning evaluation.*;
$$;

create function public.request_meenakshi_evaluation_refresh(
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
  select * into evaluation
  from public.evaluation_runs
  where id = p_evaluation_run_id
    and locked_by = p_worker_id
    and lease_expires_at >= now()
  for update;
  if not found then
    raise exception 'Evaluation run is not leased by this worker';
  end if;

  if evaluation.tally_master_refresh_run_id is not null
     and evaluation.tally_voucher_refresh_run_id is not null then
    return jsonb_build_object(
      'masterSyncRunId', evaluation.tally_master_refresh_run_id,
      'voucherSyncRunId', evaluation.tally_voucher_refresh_run_id,
      'alreadyRequested', true
    );
  end if;

  select * into company
  from public.companies
  where id = evaluation.company_id;

  insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
  values (
    evaluation.company_id,
    'masters',
    'queued',
    coalesce(p_master_scope, '{}'::jsonb) || jsonb_build_object('evaluationRunId', evaluation.id)
  )
  returning * into master_run;

  insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
  values (
    evaluation.company_id,
    'vouchers',
    'queued',
    coalesce(p_voucher_scope, '{}'::jsonb) || jsonb_build_object('evaluationRunId', evaluation.id)
  )
  returning * into voucher_run;

  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload,
    organization_id, company_id, correlation_id, idempotency_key
  ) values (
    'evaluation-refresh:' || evaluation.id::text,
    'tally_targeted_refresh',
    'evaluation_run', evaluation.id,
    jsonb_build_object(
      'evaluationRunId', evaluation.id,
      'masterSyncRunId', master_run.id,
      'voucherSyncRunId', voucher_run.id,
      'masterScope', master_run.requested_scope,
      'voucherScope', voucher_run.requested_scope
    ),
    company.organization_id,
    evaluation.company_id,
    evaluation.correlation_id,
    'evaluation-refresh:' || evaluation.id::text
  ) on conflict (event_key) do nothing;

  update public.evaluation_runs
  set status = 'refreshing_tally',
      tally_master_refresh_run_id = master_run.id,
      tally_voucher_refresh_run_id = voucher_run.id,
      tally_refresh_run_id = voucher_run.id,
      updated_at = now()
  where id = evaluation.id;

  return jsonb_build_object(
    'masterSyncRunId', master_run.id,
    'voucherSyncRunId', voucher_run.id,
    'alreadyRequested', false
  );
end;
$$;

create function public.lock_meenakshi_tod_customer_period(
  p_company_id uuid,
  p_customer_id uuid,
  p_scheme_id uuid,
  p_scheme_version_id uuid,
  p_period_start date,
  p_period_end date,
  p_evaluation_run_id uuid default null
)
returns public.tod_customer_period_rule_locks
language plpgsql
set search_path = ''
as $$
declare
  locked_period public.tod_customer_period_rule_locks;
begin
  if not exists (
    select 1
    from public.scheme_versions version
    where version.id = p_scheme_version_id
      and version.company_id = p_company_id
      and version.scheme_id = p_scheme_id
      and version.scheme_type = 'tod'
  ) then
    raise exception 'TOD lock must reference a TOD rule version from the same company and scheme';
  end if;

  insert into public.tod_customer_period_rule_locks (
    company_id, customer_id, scheme_id, scheme_version_id,
    period_start, period_end, first_evaluation_run_id
  ) values (
    p_company_id, p_customer_id, p_scheme_id, p_scheme_version_id,
    p_period_start, p_period_end, p_evaluation_run_id
  )
  on conflict (company_id, customer_id, scheme_id, period_start, period_end) do nothing;

  select * into locked_period
  from public.tod_customer_period_rule_locks
  where company_id = p_company_id
    and customer_id = p_customer_id
    and scheme_id = p_scheme_id
    and period_start = p_period_start
    and period_end = p_period_end;

  return locked_period;
end;
$$;

create function public.persist_meenakshi_evaluation_result(
  p_evaluation_run_id uuid,
  p_worker_id text,
  p_actor_id uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  evaluation public.evaluation_runs;
  company public.companies;
  proposal public.discount_proposals;
  evaluation_id uuid;
  next_evaluation_number integer;
  result_proposal jsonb := p_result -> 'proposal';
  result_evaluation jsonb := coalesce(p_result -> 'evaluation', '{}'::jsonb);
  issue jsonb;
  membership jsonb;
  voucher jsonb;
  line jsonb;
  allocation jsonb;
  adjustment jsonb;
  outcome public.proposal_status;
  run_status public.evaluation_run_status;
  has_issues boolean := coalesce((p_result ->> 'hasBlockingIssues')::boolean, false);
begin
  select * into evaluation
  from public.evaluation_runs
  where id = p_evaluation_run_id
    and locked_by = p_worker_id
    and lease_expires_at >= now()
  for update;
  if not found then
    raise exception 'Evaluation run is not leased by this worker';
  end if;

  select * into company
  from public.companies
  where id = evaluation.company_id;

  if result_proposal is null or result_proposal = 'null'::jsonb then
    run_status := 'completed_with_issues';
    update public.evaluation_runs
    set status = run_status,
        summary = coalesce(p_result -> 'summary', '{}'::jsonb),
        source_fingerprint = nullif(p_result ->> 'sourceFingerprint', ''),
        completed_at = now(),
        locked_at = null, locked_by = null, lease_expires_at = null,
        updated_at = now()
    where id = evaluation.id;
  else
    outcome := (result_proposal ->> 'status')::public.proposal_status;
    if outcome is null then
      raise exception 'Evaluation result proposal requires a status';
    end if;

    update public.evaluation_runs
    set scheme_version_id = nullif(result_proposal ->> 'schemeVersionId', '')::uuid,
        evaluation_date = coalesce(nullif(result_proposal ->> 'evaluationDate', '')::date, current_date),
        period_start = nullif(result_proposal ->> 'periodStart', '')::date,
        period_end = nullif(result_proposal ->> 'periodEnd', '')::date,
        status = 'evaluating',
        updated_at = now()
    where id = evaluation.id;

    insert into public.discount_proposals (
      company_id, customer_id, scheme_version_id, scheme_type,
      source_sales_voucher_id, period_start, period_end, entitlement_key,
      status, source_fingerprint, last_live_refresh_at, customer_group_id_used,
      eligibility_deadline, eligible_product_taxable_value, eligible_tonnes,
      achieved_tier_id, next_tier_tonnes, additional_tonnes_required,
      invoice_amount_due, amount_paid_by_deadline, discounted_settlement_target,
      shortfall_amount, discount_percentage, calculated_discount_amount,
      reason_codes, latest_evaluated_at
    ) values (
      evaluation.company_id,
      (result_proposal ->> 'customerId')::uuid,
      (result_proposal ->> 'schemeVersionId')::uuid,
      (result_proposal ->> 'schemeType')::public.scheme_type,
      nullif(result_proposal ->> 'sourceSalesVoucherId', '')::uuid,
      nullif(result_proposal ->> 'periodStart', '')::date,
      nullif(result_proposal ->> 'periodEnd', '')::date,
      result_proposal ->> 'entitlementKey',
      outcome,
      result_proposal ->> 'sourceFingerprint',
      now(),
      nullif(result_proposal ->> 'customerGroupIdUsed', '')::uuid,
      nullif(result_proposal ->> 'eligibilityDeadline', '')::date,
      coalesce(nullif(result_proposal ->> 'eligibleProductTaxableValue', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'eligibleTonnes', '')::numeric, 0),
      nullif(result_proposal ->> 'achievedTierId', '')::uuid,
      nullif(result_proposal ->> 'nextTierTonnes', '')::numeric,
      nullif(result_proposal ->> 'additionalTonnesRequired', '')::numeric,
      coalesce(nullif(result_proposal ->> 'invoiceAmountDue', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'amountPaidByDeadline', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'discountedSettlementTarget', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'shortfallAmount', '')::numeric, 0),
      nullif(result_proposal ->> 'discountPercentage', '')::numeric,
      coalesce(nullif(result_proposal ->> 'calculatedDiscountAmount', '')::numeric, 0),
      coalesce(array(select jsonb_array_elements_text(coalesce(result_proposal -> 'reasonCodes', '[]'::jsonb))), '{}'::text[]),
      now()
    )
    on conflict (entitlement_key) do update
    set status = case
          when public.discount_proposals.status in ('sending_to_tally', 'created_verified', 'whatsapp_pending', 'whatsapp_sent')
            then public.discount_proposals.status
          else excluded.status
        end,
        source_fingerprint = excluded.source_fingerprint,
        last_live_refresh_at = excluded.last_live_refresh_at,
        customer_group_id_used = excluded.customer_group_id_used,
        eligibility_deadline = excluded.eligibility_deadline,
        eligible_product_taxable_value = excluded.eligible_product_taxable_value,
        eligible_tonnes = excluded.eligible_tonnes,
        achieved_tier_id = excluded.achieved_tier_id,
        next_tier_tonnes = excluded.next_tier_tonnes,
        additional_tonnes_required = excluded.additional_tonnes_required,
        invoice_amount_due = excluded.invoice_amount_due,
        amount_paid_by_deadline = excluded.amount_paid_by_deadline,
        discounted_settlement_target = excluded.discounted_settlement_target,
        shortfall_amount = excluded.shortfall_amount,
        discount_percentage = excluded.discount_percentage,
        calculated_discount_amount = excluded.calculated_discount_amount,
        reason_codes = excluded.reason_codes,
        latest_evaluated_at = excluded.latest_evaluated_at,
        updated_at = now()
    returning * into proposal;

    select coalesce(max(snapshot.evaluation_number), 0) + 1
    into next_evaluation_number
    from public.proposal_evaluations snapshot
    where snapshot.proposal_id = proposal.id;

    insert into public.proposal_evaluations (
      company_id, proposal_id, evaluation_run_id, evaluation_number,
      outcome_status, source_fingerprint, rule_snapshot, customer_group_snapshot,
      calendar_snapshot, formula_snapshot, eligible_product_taxable_value,
      eligible_tonnes, invoice_amount_due, amount_paid_by_deadline,
      discounted_settlement_target, shortfall_amount, discount_percentage,
      calculated_discount_amount, posted_discount_amount, reason_codes, evaluated_by
    ) values (
      evaluation.company_id, proposal.id, evaluation.id, next_evaluation_number,
      outcome, result_proposal ->> 'sourceFingerprint',
      coalesce(result_evaluation -> 'ruleSnapshot', '{}'::jsonb),
      coalesce(result_evaluation -> 'customerGroupSnapshot', '{}'::jsonb),
      result_evaluation -> 'calendarSnapshot',
      coalesce(result_evaluation -> 'formulaSnapshot', '{}'::jsonb),
      coalesce(nullif(result_proposal ->> 'eligibleProductTaxableValue', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'eligibleTonnes', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'invoiceAmountDue', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'amountPaidByDeadline', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'discountedSettlementTarget', '')::numeric, 0),
      coalesce(nullif(result_proposal ->> 'shortfallAmount', '')::numeric, 0),
      nullif(result_proposal ->> 'discountPercentage', '')::numeric,
      coalesce(nullif(result_proposal ->> 'calculatedDiscountAmount', '')::numeric, 0),
      nullif(result_proposal ->> 'postedDiscountAmount', '')::numeric,
      coalesce(array(select jsonb_array_elements_text(coalesce(result_proposal -> 'reasonCodes', '[]'::jsonb))), '{}'::text[]),
      p_actor_id
    ) returning id into evaluation_id;

    for membership in select value from jsonb_array_elements(coalesce(result_evaluation -> 'groupMemberships', '[]'::jsonb)) loop
      insert into public.proposal_group_membership_snapshots (
        proposal_evaluation_id, company_id, customer_id, customer_group_id,
        is_covered_by_rule, membership_snapshot
      ) values (
        evaluation_id, evaluation.company_id, (membership ->> 'customerId')::uuid,
        (membership ->> 'customerGroupId')::uuid,
        coalesce((membership ->> 'isCoveredByRule')::boolean, false),
        coalesce(membership -> 'snapshot', '{}'::jsonb)
      );
    end loop;

    for voucher in select value from jsonb_array_elements(coalesce(result_evaluation -> 'sourceVouchers', '[]'::jsonb)) loop
      insert into public.proposal_source_vouchers (
        proposal_evaluation_id, company_id, tally_voucher_id, contribution_type,
        taxable_value_contribution, tonne_contribution, source_snapshot
      ) values (
        evaluation_id, evaluation.company_id, (voucher ->> 'tallyVoucherId')::uuid,
        voucher ->> 'contributionType',
        coalesce(nullif(voucher ->> 'taxableValueContribution', '')::numeric, 0),
        coalesce(nullif(voucher ->> 'tonneContribution', '')::numeric, 0),
        coalesce(voucher -> 'snapshot', '{}'::jsonb)
      );
    end loop;

    for line in select value from jsonb_array_elements(coalesce(result_evaluation -> 'sourceInventoryLines', '[]'::jsonb)) loop
      insert into public.proposal_source_inventory_lines (
        proposal_evaluation_id, company_id, tally_voucher_inventory_line_id,
        tonnes_per_source_unit, eligible_quantity, eligible_tonnes,
        eligible_taxable_value, contribution_sign, blocking_reason
      ) values (
        evaluation_id, evaluation.company_id, (line ->> 'tallyVoucherInventoryLineId')::uuid,
        nullif(line ->> 'tonnesPerSourceUnit', '')::numeric,
        coalesce(nullif(line ->> 'eligibleQuantity', '')::numeric, 0),
        coalesce(nullif(line ->> 'eligibleTonnes', '')::numeric, 0),
        coalesce(nullif(line ->> 'eligibleTaxableValue', '')::numeric, 0),
        coalesce(nullif(line ->> 'contributionSign', '')::smallint, 1),
        nullif(line ->> 'blockingReason', '')
      );
    end loop;

    for allocation in select value from jsonb_array_elements(coalesce(result_evaluation -> 'paymentAllocations', '[]'::jsonb)) loop
      insert into public.proposal_payment_allocations (
        proposal_evaluation_id, company_id, tally_bill_allocation_id,
        receipt_voucher_date, allocated_amount, counts_for_cd, evidence_snapshot
      ) values (
        evaluation_id, evaluation.company_id, (allocation ->> 'tallyBillAllocationId')::uuid,
        (allocation ->> 'receiptVoucherDate')::date,
        (allocation ->> 'allocatedAmount')::numeric,
        coalesce((allocation ->> 'countsForCd')::boolean, false),
        coalesce(allocation -> 'snapshot', '{}'::jsonb)
      );
    end loop;

    for adjustment in select value from jsonb_array_elements(coalesce(result_evaluation -> 'priorPeriodAdjustments', '[]'::jsonb)) loop
      insert into public.proposal_prior_period_adjustments (
        proposal_evaluation_id, company_id, tally_voucher_id, original_period_start,
        original_period_end, taxable_value_adjustment, tonne_adjustment, reason
      ) values (
        evaluation_id, evaluation.company_id, (adjustment ->> 'tallyVoucherId')::uuid,
        (adjustment ->> 'originalPeriodStart')::date,
        (adjustment ->> 'originalPeriodEnd')::date,
        (adjustment ->> 'taxableValueAdjustment')::numeric,
        (adjustment ->> 'tonneAdjustment')::numeric,
        adjustment ->> 'reason'
      );
    end loop;

    for line in select value from jsonb_array_elements(coalesce(result_evaluation -> 'workingDayBreakdown', '[]'::jsonb)) loop
      insert into public.proposal_working_day_breakdowns (
        proposal_evaluation_id, business_date, is_working_day, counted_working_day,
        exclusion_reason, is_deadline
      ) values (
        evaluation_id, (line ->> 'businessDate')::date,
        coalesce((line ->> 'isWorkingDay')::boolean, false),
        coalesce((line ->> 'countedWorkingDay')::integer, 0),
        nullif(line ->> 'exclusionReason', ''),
        coalesce((line ->> 'isDeadline')::boolean, false)
      );
    end loop;

    run_status := case when has_issues then 'completed_with_issues'::public.evaluation_run_status else 'completed'::public.evaluation_run_status end;
    update public.evaluation_runs
    set status = run_status,
        source_fingerprint = result_proposal ->> 'sourceFingerprint',
        summary = coalesce(p_result -> 'summary', '{}'::jsonb),
        completed_at = now(),
        locked_at = null, locked_by = null, lease_expires_at = null,
        updated_at = now()
    where id = evaluation.id;
  end if;

  for issue in select value from jsonb_array_elements(coalesce(p_result -> 'issues', '[]'::jsonb)) loop
    insert into public.processing_issues (
      company_id, proposal_id, customer_id, scheme_version_id, tally_voucher_id,
      issue_key, issue_type, status, details
    ) values (
      evaluation.company_id,
      proposal.id,
      nullif(issue ->> 'customerId', '')::uuid,
      nullif(issue ->> 'schemeVersionId', '')::uuid,
      nullif(issue ->> 'tallyVoucherId', '')::uuid,
      issue ->> 'issueKey',
      issue ->> 'issueType',
      'open',
      coalesce(issue -> 'details', '{}'::jsonb)
    )
    on conflict (issue_key) do update
    set details = excluded.details,
        updated_at = now();
  end loop;

  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action,
    entity_type, entity_id, correlation_id, new_value,
    metadata
  ) values (
    company.organization_id, evaluation.company_id, 'system', p_actor_id,
    'evaluation_persisted', 'evaluation_run', evaluation.id,
    evaluation.correlation_id,
    jsonb_build_object('status', run_status, 'proposalId', proposal.id, 'proposalEvaluationId', evaluation_id),
    jsonb_build_object('hasBlockingIssues', has_issues)
  );

  return jsonb_build_object(
    'evaluationRunId', evaluation.id,
    'proposalId', proposal.id,
    'proposalEvaluationId', evaluation_id,
    'status', run_status
  );
end;
$$;

create function public.fail_meenakshi_evaluation_run(
  p_evaluation_run_id uuid,
  p_worker_id text,
  p_error_summary text
)
returns public.evaluation_runs
language plpgsql
set search_path = ''
as $$
declare
  failed_run public.evaluation_runs;
begin
  update public.evaluation_runs
  set status = case when attempts >= max_attempts then 'failed'::public.evaluation_run_status else 'queued'::public.evaluation_run_status end,
      error_summary = left(coalesce(p_error_summary, 'Evaluation failed.'), 2000),
      locked_at = null, locked_by = null, lease_expires_at = null,
      completed_at = case when attempts >= max_attempts then now() else null end,
      updated_at = now()
  where id = p_evaluation_run_id
    and locked_by = p_worker_id
  returning * into failed_run;
  if not found then
    raise exception 'Evaluation run is not leased by this worker';
  end if;
  return failed_run;
end;
$$;

alter table public.tod_customer_period_rule_locks enable row level security;
revoke all on table public.tod_customer_period_rule_locks from public, anon, authenticated;
grant all on table public.tod_customer_period_rule_locks to service_role;

revoke all on function public.create_meenakshi_evaluation_run(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.claim_meenakshi_evaluation_runs(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.request_meenakshi_evaluation_refresh(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.lock_meenakshi_tod_customer_period(uuid, uuid, uuid, uuid, date, date, uuid)
  from public, anon, authenticated;
revoke all on function public.persist_meenakshi_evaluation_result(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_meenakshi_evaluation_run(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.create_meenakshi_evaluation_run(uuid, uuid, uuid, jsonb, text)
  to service_role;
grant execute on function public.claim_meenakshi_evaluation_runs(text, integer, integer)
  to service_role;
grant execute on function public.request_meenakshi_evaluation_refresh(uuid, text, jsonb, jsonb)
  to service_role;
grant execute on function public.lock_meenakshi_tod_customer_period(uuid, uuid, uuid, uuid, date, date, uuid)
  to service_role;
grant execute on function public.persist_meenakshi_evaluation_result(uuid, text, uuid, jsonb)
  to service_role;
grant execute on function public.fail_meenakshi_evaluation_run(uuid, text, text)
  to service_role;

comment on table public.tod_customer_period_rule_locks is
  'Immutable effective TOD version per customer, logical scheme, and closed/open period. Later rules cannot rewrite a tracked period.';
comment on function public.persist_meenakshi_evaluation_result(uuid, text, uuid, jsonb) is
  'Server-only Phase 4 transaction: updates current entitlement state and appends a frozen evaluation plus evidence snapshots.';
