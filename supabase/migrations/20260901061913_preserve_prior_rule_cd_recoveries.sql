-- Preserve unresolved Cash Discount recoveries when a new rule version is
-- activated.  They are historical evidence, not current postable actions:
-- the API only exposes them in a read-only previous-rule view and the Debit
-- Note RPC still accepts current_snapshot candidates only.

create index if not exists cash_discount_recovery_prior_rule_pending_idx
  on public.cash_discount_recovery_candidates (company_id, evaluated_on desc, remaining_recovery desc)
  where not current_snapshot
    and status in ('action_required', 'review_required');

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

  -- During a regular refresh for the same rule, remove obsolete unposted
  -- rows.  During a rule change, retain actionable/review rows from the
  -- former rule for finance review.  They cannot be posted because they are
  -- no longer in the current snapshot.
  delete from public.cash_discount_recovery_candidates candidate
  where candidate.company_id = p_company_id
    and not candidate.current_snapshot
    and not exists (
      select 1 from public.cash_discount_debit_note_postings posting
      where posting.candidate_id = candidate.id
    )
    and (
      candidate.rule_version_id = p_rule_version_id
      or candidate.status not in ('action_required', 'review_required')
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

revoke all on function public.replace_meenakshi_cd_recovery_snapshot(uuid, uuid, uuid, text, date, date, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_meenakshi_cd_recovery_snapshot(uuid, uuid, uuid, text, date, date, jsonb, jsonb)
  to service_role;
