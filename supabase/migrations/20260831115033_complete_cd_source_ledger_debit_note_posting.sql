-- Complete the Cash Discount Debit Note migration for databases that still
-- use the former, manually configured recovery-ledger function. The bridge
-- has always required the source Sales ledger, so persist that ledger with
-- each evaluated invoice and derive the Debit Note from it.

alter table public.cash_discount_recovery_candidates
  add column if not exists source_sales_ledger_name text;

alter table public.cash_discount_debit_note_postings
  alter column debit_note_voucher_type_id drop not null,
  alter column recovery_ledger_id drop not null;

create or replace function public.replace_meenakshi_cd_recovery_snapshot(
  p_company_id uuid,
  p_evaluation_run_id uuid,
  p_rule_version_id uuid,
  p_source_fingerprint text,
  p_period_start date,
  p_period_end date,
  p_candidates jsonb,
  p_summary jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' then
    raise exception 'Cash Discount candidates must be a JSON array';
  end if;
  if not exists (
    select 1 from public.evaluation_runs run
    where run.id = p_evaluation_run_id and run.company_id = p_company_id
  ) then
    raise exception 'Cash Discount run is unavailable';
  end if;
  if not exists (
    select 1 from public.scheme_versions version
    where version.id = p_rule_version_id
      and version.company_id = p_company_id
      and version.scheme_type = 'cd'
  ) then
    raise exception 'Cash Discount rule is unavailable';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':cd-snapshot', 0));
  update public.cash_discount_recovery_candidates
  set current_snapshot = false
  where company_id = p_company_id and current_snapshot;
  delete from public.cash_discount_recovery_candidates candidate
  where candidate.company_id = p_company_id
    and not candidate.current_snapshot
    and not exists (
      select 1 from public.cash_discount_debit_note_postings posting
      where posting.candidate_id = candidate.id
    );

  insert into public.cash_discount_recovery_candidates (
    company_id, rule_version_id, source_run_id, source_fingerprint, evaluated_on,
    customer_tally_guid, customer_name, source_sales_ledger_name, invoice_tally_guid,
    invoice_number, invoice_date, bill_reference, net_invoice_amount, implied_gross_amount,
    amount_paid, granted_discount_percentage, earned_discount_percentage, recovery_required,
    already_recovered, remaining_recovery, missed_window_working_days, missed_window_deadline,
    next_window_working_days, next_window_percentage, status, reason_code, review_message,
    narration_checked, narration_mentioned, narration_matches, debit_note_references
  )
  select
    p_company_id, p_rule_version_id, p_evaluation_run_id, p_source_fingerprint,
    (item ->> 'evaluatedOn')::date,
    item ->> 'customerTallyGuid', item ->> 'customerName',
    nullif(item ->> 'sourceSalesLedgerName', ''), item ->> 'invoiceTallyGuid',
    nullif(item ->> 'invoiceNumber', ''), (item ->> 'invoiceDate')::date,
    item ->> 'billReference', (item ->> 'netInvoiceAmount')::numeric,
    (item ->> 'impliedGrossAmount')::numeric, (item ->> 'amountPaid')::numeric,
    (item ->> 'grantedDiscountPercentage')::numeric, (item ->> 'earnedDiscountPercentage')::numeric,
    (item ->> 'recoveryRequired')::numeric, (item ->> 'alreadyRecovered')::numeric,
    (item ->> 'remainingRecovery')::numeric, (item ->> 'missedWindowWorkingDays')::integer,
    (item ->> 'missedWindowDeadline')::date, nullif(item ->> 'nextWindowWorkingDays', '')::integer,
    nullif(item ->> 'nextWindowPercentage', '')::numeric, item ->> 'status',
    item ->> 'reasonCode', nullif(item ->> 'reviewMessage', ''),
    coalesce((item #>> '{narration,checked}')::boolean, false),
    coalesce((item #>> '{narration,mentioned}')::boolean, false),
    coalesce((item #>> '{narration,matches}')::boolean, false),
    coalesce(item -> 'debitNoteReferences', '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) item;
  get diagnostics inserted_count = row_count;

  update public.evaluation_runs
  set status = 'completed', scheme_version_id = p_rule_version_id,
      period_start = p_period_start, period_end = p_period_end,
      source_fingerprint = p_source_fingerprint, summary = coalesce(p_summary, '{}'::jsonb),
      error_summary = null, completed_at = now(), locked_at = null, locked_by = null,
      lease_expires_at = null, updated_at = now()
  where id = p_evaluation_run_id and company_id = p_company_id;
  return inserted_count;
end;
$$;

create or replace function public.enqueue_meenakshi_cd_debit_note(
  p_company_id uuid,
  p_candidate_id uuid,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.cash_discount_debit_note_postings
language plpgsql
set search_path = ''
as $$
declare
  candidate public.cash_discount_recovery_candidates;
  company public.companies;
  posting public.cash_discount_debit_note_postings;
  reference text;
begin
  if coalesce(length(btrim(p_idempotency_key)), 0) = 0 then
    raise exception 'An idempotency key is required';
  end if;

  select * into posting
  from public.cash_discount_debit_note_postings
  where company_id = p_company_id and idempotency_key = p_idempotency_key;
  if found then return posting; end if;

  begin
    select * into candidate
    from public.cash_discount_recovery_candidates
    where id = p_candidate_id and company_id = p_company_id and current_snapshot
    for update nowait;
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = 'This Debit Note is already being prepared. Wait a moment and refresh.';
  end;

  if not found then raise exception 'This recovery is no longer current. Run Cash Discount again.'; end if;
  if candidate.status = 'posting' then raise exception 'This Debit Note is already being prepared.'; end if;
  if candidate.status <> 'action_required' or candidate.remaining_recovery <= 0 then
    raise exception 'This recovery is not ready for a Debit Note';
  end if;
  if coalesce(length(btrim(candidate.source_sales_ledger_name)), 0) = 0 then
    raise exception 'The original invoice Sales ledger is unavailable. Run Cash Discount again.';
  end if;

  select * into company from public.companies where id = p_company_id;
  if not found then raise exception 'The selected company is unavailable.'; end if;

  reference := left('DN-CD-' || coalesce(nullif(candidate.invoice_number, ''), candidate.id::text), 120);
  insert into public.cash_discount_debit_note_postings (
    company_id, candidate_id, idempotency_key, debit_note_date, amount, calculation_reference,
    debit_note_voucher_type_id, recovery_ledger_id, debit_note_snapshot, created_by
  ) values (
    p_company_id, candidate.id, p_idempotency_key, current_date, candidate.remaining_recovery,
    reference, null, null,
    jsonb_build_object(
      'company', jsonb_build_object('guid', company.tally_company_guid, 'name', company.tally_company_name),
      'voucherType', jsonb_build_object('name', 'Debit Note'),
      'party', jsonb_build_object('guid', candidate.customer_tally_guid, 'name', candidate.customer_name),
      'salesLedger', jsonb_build_object('name', candidate.source_sales_ledger_name),
      'debitNoteDate', current_date,
      'amount', candidate.remaining_recovery::text,
      'calculationReference', reference,
      'allocation', jsonb_build_object('type', 'new_ref', 'reference', reference),
      'sourceInvoice', jsonb_build_object(
        'guid', candidate.invoice_tally_guid,
        'number', candidate.invoice_number,
        'billReference', candidate.bill_reference
      )
    ),
    p_actor_id
  ) returning * into posting;

  update public.cash_discount_recovery_candidates
  set status = 'posting'
  where id = candidate.id;
  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload, organization_id,
    company_id, correlation_id, idempotency_key, max_attempts
  ) values (
    'cd-debit-note:' || posting.id::text,
    'tally_debit_note_create', 'cash_discount_debit_note_posting', posting.id,
    jsonb_build_object('debitNotePostingId', posting.id), company.organization_id,
    company.id, gen_random_uuid(), 'cd-debit-note:' || posting.id::text, 1
  );
  return posting;
end;
$$;

revoke execute on function public.replace_meenakshi_cd_recovery_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb)
  from public, anon, authenticated;
revoke execute on function public.enqueue_meenakshi_cd_debit_note(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.replace_meenakshi_cd_recovery_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb)
  to service_role;
grant execute on function public.enqueue_meenakshi_cd_debit_note(uuid,uuid,uuid,text)
  to service_role;
