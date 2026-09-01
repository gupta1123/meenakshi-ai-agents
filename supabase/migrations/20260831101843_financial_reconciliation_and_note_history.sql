-- Keep verified financial postings visible and reconcile them against the
-- canonical Tally voucher snapshot. A reconciliation never creates a
-- replacement note: finance must review and explicitly decide the correction.

alter table public.cash_discount_debit_note_postings
  add column if not exists tally_debit_note_voucher_id uuid,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists reconciliation_reason text,
  add column if not exists reconciliation_snapshot jsonb;

alter table public.cash_discount_debit_note_postings
  drop constraint if exists cash_discount_debit_note_postings_status_check;
alter table public.cash_discount_debit_note_postings
  add constraint cash_discount_debit_note_postings_status_check
  check (status in ('queued', 'sending', 'created_verified', 'reconciliation_required', 'failed', 'cancelled'));

alter table public.cash_discount_debit_note_postings
  drop constraint if exists cash_discount_debit_note_postings_tally_voucher_company_fk;
alter table public.cash_discount_debit_note_postings
  add constraint cash_discount_debit_note_postings_tally_voucher_company_fk
  foreign key (tally_debit_note_voucher_id, company_id)
  references public.tally_vouchers (id, company_id) on delete restrict;

alter table public.credit_note_postings
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists reconciliation_reason text,
  add column if not exists reconciliation_snapshot jsonb;

create index if not exists cash_discount_debit_note_postings_tally_voucher_idx
  on public.cash_discount_debit_note_postings (company_id, tally_debit_note_voucher_id)
  where tally_debit_note_voucher_id is not null;

-- Older Debit Notes were verified by GUID before the app persisted the linked
-- Tally row. Link all rows that are already present in the local snapshot.
update public.cash_discount_debit_note_postings posting
set tally_debit_note_voucher_id = voucher.id
from public.tally_vouchers voucher
where posting.company_id = voucher.company_id
  and posting.verified_tally_guid = voucher.tally_guid
  and posting.tally_debit_note_voucher_id is null;

create or replace function public.record_meenakshi_debit_note_result(
  p_posting_id uuid,
  p_result jsonb,
  p_failure_reason text default null
)
returns public.cash_discount_debit_note_postings
language plpgsql
set search_path = ''
as $$
declare
  posting public.cash_discount_debit_note_postings;
  result_amount numeric;
  linked_voucher_id uuid;
begin
  select * into posting from public.cash_discount_debit_note_postings where id = p_posting_id for update;
  if not found then raise exception 'Cash Discount Debit Note posting not found'; end if;
  if p_failure_reason is null then
    if nullif(p_result ->> 'tallyGuid', '') is null then raise exception 'Verified Debit Note GUID is required'; end if;
    result_amount := nullif(p_result ->> 'amount', '')::numeric;
    if result_amount is null or abs(result_amount - posting.amount) > 0.01 then
      raise exception 'Verified Debit Note amount does not match the approved recovery';
    end if;
    select voucher.id into linked_voucher_id
    from public.tally_vouchers voucher
    where voucher.company_id = posting.company_id and voucher.tally_guid = p_result ->> 'tallyGuid';
  end if;
  update public.cash_discount_debit_note_postings
  set status = case when p_failure_reason is null then 'created_verified' else 'failed' end,
      tally_debit_note_voucher_id = case when p_failure_reason is null then linked_voucher_id else null end,
      verified_tally_guid = case when p_failure_reason is null then p_result ->> 'tallyGuid' else null end,
      verified_voucher_number = case when p_failure_reason is null then p_result ->> 'voucherNumber' else null end,
      verified_amount = case when p_failure_reason is null then nullif(p_result ->> 'amount', '')::numeric else null end,
      verified_at = case when p_failure_reason is null then now() else null end,
      failure_reason = p_failure_reason,
      last_reconciled_at = case when p_failure_reason is null then now() else null end,
      reconciliation_reason = null,
      reconciliation_snapshot = case when p_failure_reason is null then jsonb_build_object('checkedAt', now(), 'tallyGuid', p_result ->> 'tallyGuid') else null end
  where id = p_posting_id returning * into posting;
  update public.cash_discount_recovery_candidates
  set status = case when p_failure_reason is null then 'posted' else 'action_required' end,
      already_recovered = case when p_failure_reason is null then recovery_required else already_recovered end,
      remaining_recovery = case when p_failure_reason is null then 0 else remaining_recovery end
  where id = posting.candidate_id;
  return posting;
end;
$$;

alter table public.processing_issues
  drop constraint if exists processing_issues_issue_type_check;
alter table public.processing_issues
  add constraint processing_issues_issue_type_check check (issue_type in (
    'wrong_tally_company', 'tally_unavailable', 'configured_group_unavailable',
    'ambiguous_group_membership', 'no_active_rule', 'missing_rule_configuration',
    'missing_against_reference', 'ambiguous_payment_allocation',
    'missing_unit_conversion', 'source_changed_after_review',
    'possible_duplicate_credit_note', 'posting_verification_failed',
    'tally_note_missing_or_reversed', 'tod_tier_reduced_after_notification', 'other'
  ));

-- A verified Credit Note may be made correction_required when its matched
-- Tally voucher is cancelled or reversed. This is deliberately the only new
-- outbound transition from a verified posting.
create or replace function public.validate_credit_note_posting_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status <> old.status and not (
    (old.status = 'pending_approval' and new.status in ('queued', 'failed', 'cancel_requested')) or
    (old.status = 'queued' and new.status in ('sending', 'failed', 'cancel_requested')) or
    (old.status = 'sending' and new.status in ('verification_pending', 'correction_required', 'failed')) or
    (old.status = 'verification_pending' and new.status in ('created_verified', 'correction_required', 'failed')) or
    (old.status = 'created_verified' and new.status = 'correction_required') or
    (old.status in ('correction_required', 'failed') and new.status in ('queued', 'cancel_requested', 'cancelled')) or
    (old.status = 'cancel_requested' and new.status in ('cancelled', 'failed'))
  ) then raise exception 'Invalid Credit Note posting status transition: % to %', old.status, new.status; end if;
  if new.gst_treatment <> 'commercial_no_gst' then raise exception 'TOD Credit Notes must use commercial_no_gst treatment'; end if;
  if exists (
    select 1 from public.discount_proposals proposal
    where proposal.id = new.proposal_id
      and ((proposal.scheme_type = 'tod' and new.bill_allocation_type <> 'new_ref')
        or (proposal.scheme_type = 'cd' and new.bill_allocation_type not in ('agst_ref', 'new_ref')))
  ) then raise exception 'TOD Credit Notes use New Ref; CD Credit Notes use Agst Ref or New Ref according to settlement state'; end if;
  if new.bill_allocation_type = 'agst_ref' and nullif(btrim(new.tally_bill_reference), '') is null then raise exception 'Against Reference requires a Tally bill reference'; end if;
  if new.status in ('queued','sending','verification_pending','created_verified') and not exists (
    select 1 from public.proposal_reviews review join public.discount_proposals proposal on proposal.id = review.proposal_id
    where review.proposal_id = new.proposal_id and review.status = 'approved' and review.source_fingerprint = proposal.source_fingerprint
  ) then raise exception 'Credit Note posting requires an approved review of current Tally evidence'; end if;
  if new.status = 'created_verified' then
    if new.tally_credit_note_voucher_id is null or new.verified_tally_guid is null or new.verified_voucher_number is null
       or new.verified_amount is null or new.verified_at is null or new.verification_snapshot is null
       or new.verified_discount_ledger_id is null or new.verified_bill_allocation_type is null
       or new.verified_calculation_reference is null or new.verified_ledger_entries_hash is null
       or not coalesce(new.verified_company_matches, false) or not coalesce(new.verified_party_matches, false)
       or not coalesce(new.verified_voucher_type_matches, false) or not coalesce(new.verified_no_inventory_lines, false)
       or not coalesce(new.verified_no_unexpected_gst, false) then
      raise exception 'A Credit Note cannot be created_verified until every structured Tally read-back check is stored and passed';
    end if;
    if new.verified_amount <> new.discount_amount or new.verified_discount_ledger_id <> new.discount_ledger_id
       or new.verified_bill_allocation_type <> new.bill_allocation_type
       or new.verified_calculation_reference <> new.calculation_reference then
      raise exception 'Verified Tally values must equal the approved posting values';
    end if;
    if not exists (
      select 1 from public.tally_vouchers voucher
      where voucher.id = new.tally_credit_note_voucher_id and voucher.company_id = new.company_id
        and voucher.voucher_kind = 'credit_note' and voucher.status = 'posted'
        and voucher.voucher_type_id = new.credit_note_voucher_type_id and voucher.party_customer_id = new.customer_id
        and voucher.voucher_date = new.credit_note_date and round(voucher.gross_amount, 2) = new.verified_amount
    ) then raise exception 'Verified Credit Note must match company, type, party, date, and amount in Tally'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.reconcile_meenakshi_verified_note_postings(p_company_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_credit_flagged integer := 0;
  v_debit_flagged integer := 0;
begin
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company is unavailable';
  end if;

  -- First bind any Debit Note that appeared in the latest Tally snapshot.
  update public.cash_discount_debit_note_postings posting
  set tally_debit_note_voucher_id = voucher.id,
      last_reconciled_at = now(),
      reconciliation_reason = null,
      reconciliation_snapshot = jsonb_build_object('checkedAt', now(), 'voucherStatus', voucher.status::text)
  from public.tally_vouchers voucher
  where posting.company_id = p_company_id
    and posting.company_id = voucher.company_id
    and posting.verified_tally_guid = voucher.tally_guid
    and posting.tally_debit_note_voucher_id is null
    and posting.status = 'created_verified';

  with invalid_credit as (
    select posting.id, posting.proposal_id, posting.customer_id, proposal.scheme_version_id,
           posting.tally_credit_note_voucher_id, voucher.status::text as voucher_status
    from public.credit_note_postings posting
    join public.discount_proposals proposal on proposal.id = posting.proposal_id and proposal.company_id = posting.company_id
    join public.tally_vouchers voucher
      on voucher.id = posting.tally_credit_note_voucher_id and voucher.company_id = posting.company_id
    where posting.company_id = p_company_id
      and posting.status = 'created_verified'
      and voucher.status <> 'posted'
  ), flagged as (
    update public.credit_note_postings posting
    set status = 'correction_required',
        failure_reason = 'The linked Tally Credit Note is ' || invalid_credit.voucher_status || '. Review before any correction.',
        reconciliation_reason = 'Linked Tally Credit Note is ' || invalid_credit.voucher_status,
        reconciliation_snapshot = jsonb_build_object('checkedAt', now(), 'voucherId', invalid_credit.tally_credit_note_voucher_id, 'voucherStatus', invalid_credit.voucher_status),
        last_reconciled_at = now(),
        updated_at = now()
    from invalid_credit
    where posting.id = invalid_credit.id
    returning posting.id, posting.company_id, posting.proposal_id, posting.customer_id, invalid_credit.scheme_version_id,
              posting.tally_credit_note_voucher_id, invalid_credit.voucher_status
  )
  insert into public.processing_issues (
    company_id, proposal_id, customer_id, scheme_version_id, tally_voucher_id,
    issue_key, issue_type, status, details
  )
  select company_id, proposal_id, customer_id, scheme_version_id, tally_credit_note_voucher_id,
    'note-reconciliation:credit:' || id::text, 'tally_note_missing_or_reversed', 'open',
    jsonb_build_object('postingType', 'credit_note', 'postingId', id, 'observedVoucherStatus', voucher_status,
      'message', 'The verified Tally Credit Note is no longer posted. No replacement was created.')
  from flagged
  on conflict (issue_key) do update set status = 'open', details = excluded.details, resolved_by = null, resolved_at = null, updated_at = now();
  get diagnostics v_credit_flagged = row_count;

  with invalid_debit as (
    select posting.id, posting.candidate_id, candidate.customer_name, candidate.invoice_number,
           posting.tally_debit_note_voucher_id, voucher.status::text as voucher_status
    from public.cash_discount_debit_note_postings posting
    join public.tally_vouchers voucher
      on voucher.id = posting.tally_debit_note_voucher_id and voucher.company_id = posting.company_id
    join public.cash_discount_recovery_candidates candidate on candidate.id = posting.candidate_id
    where posting.company_id = p_company_id
      and posting.status = 'created_verified'
      and voucher.status <> 'posted'
  ), flagged as (
    update public.cash_discount_debit_note_postings posting
    set status = 'reconciliation_required',
        failure_reason = 'The linked Tally Debit Note is ' || invalid_debit.voucher_status || '. Review before any correction.',
        reconciliation_reason = 'Linked Tally Debit Note is ' || invalid_debit.voucher_status,
        reconciliation_snapshot = jsonb_build_object('checkedAt', now(), 'voucherId', invalid_debit.tally_debit_note_voucher_id, 'voucherStatus', invalid_debit.voucher_status),
        last_reconciled_at = now(),
        updated_at = now()
    from invalid_debit
    where posting.id = invalid_debit.id
    returning posting.id, posting.company_id, posting.candidate_id, posting.tally_debit_note_voucher_id, invalid_debit.voucher_status
  )
  insert into public.processing_issues (
    company_id, customer_id, tally_voucher_id, issue_key, issue_type, status, details
  )
  select flagged.company_id, customer.id, flagged.tally_debit_note_voucher_id,
    'note-reconciliation:debit:' || flagged.id::text, 'tally_note_missing_or_reversed', 'open',
    jsonb_build_object('postingType', 'debit_note', 'postingId', flagged.id, 'observedVoucherStatus', flagged.voucher_status,
      'message', 'The verified Tally Debit Note is no longer posted. No replacement was created.')
  from flagged
  join public.cash_discount_recovery_candidates candidate on candidate.id = flagged.candidate_id
  left join public.customers customer on customer.company_id = flagged.company_id and customer.tally_ledger_guid = candidate.customer_tally_guid
  on conflict (issue_key) do update set status = 'open', details = excluded.details, resolved_by = null, resolved_at = null, updated_at = now();
  get diagnostics v_debit_flagged = row_count;

  update public.credit_note_postings
  set last_reconciled_at = now(), updated_at = now()
  where company_id = p_company_id and status = 'created_verified';
  update public.cash_discount_debit_note_postings
  set last_reconciled_at = now(), updated_at = now()
  where company_id = p_company_id and status = 'created_verified';

  return jsonb_build_object('creditNotesFlagged', v_credit_flagged, 'debitNotesFlagged', v_debit_flagged);
end;
$$;

revoke execute on function public.reconcile_meenakshi_verified_note_postings(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_meenakshi_verified_note_postings(uuid) to service_role;
