-- A normal incremental voucher refresh cannot prove that a historical Tally
-- voucher was deleted: the missing voucher simply is not returned.  This
-- function accepts only a completed, server-created, one-note reconciliation
-- scope and flags the posting when its verified GUID is absent from that
-- exact Tally result.  It never recreates a Debit Note or Credit Note.

create or replace function public.reconcile_meenakshi_targeted_note_sync(
  p_company_id uuid,
  p_sync_run_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_scope jsonb;
  v_credit_posting_id uuid;
  v_debit_posting_id uuid;
  v_customer_id uuid;
  v_date_from date;
  v_date_to date;
  v_credit_flagged integer := 0;
  v_debit_flagged integer := 0;
begin
  select sync.requested_scope
    into v_scope
  from public.tally_sync_runs sync
  where sync.id = p_sync_run_id
    and sync.company_id = p_company_id
    and sync.sync_kind = 'vouchers'
    and sync.status = 'completed';

  if not found or coalesce(v_scope ->> 'purpose', '') <> 'targeted_verified_note_reconciliation' then
    return jsonb_build_object('creditNotesFlagged', 0, 'debitNotesFlagged', 0, 'skipped', true);
  end if;

  if coalesce(v_scope ->> 'customerId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(v_scope ->> 'dateFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(v_scope ->> 'dateTo', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return jsonb_build_object('creditNotesFlagged', 0, 'debitNotesFlagged', 0, 'skipped', true);
  end if;

  v_customer_id := (v_scope ->> 'customerId')::uuid;
  v_date_from := (v_scope ->> 'dateFrom')::date;
  v_date_to := (v_scope ->> 'dateTo')::date;

  if coalesce(v_scope ->> 'creditNotePostingId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_credit_posting_id := (v_scope ->> 'creditNotePostingId')::uuid;
  end if;
  if coalesce(v_scope ->> 'debitNotePostingId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_debit_posting_id := (v_scope ->> 'debitNotePostingId')::uuid;
  end if;

  if v_credit_posting_id is not null then
    with missing_credit as (
      select posting.id, posting.proposal_id, posting.customer_id, proposal.scheme_version_id,
             posting.tally_credit_note_voucher_id, posting.verified_tally_guid
      from public.credit_note_postings posting
      join public.discount_proposals proposal
        on proposal.id = posting.proposal_id and proposal.company_id = posting.company_id
      where posting.id = v_credit_posting_id
        and posting.company_id = p_company_id
        and posting.status = 'created_verified'
        and posting.customer_id = v_customer_id
        and posting.credit_note_date between v_date_from and v_date_to
        and posting.verified_tally_guid is not null
        and not exists (
          select 1
          from public.tally_vouchers voucher
          where voucher.company_id = p_company_id
            and voucher.tally_guid = posting.verified_tally_guid
            and voucher.last_sync_run_id = p_sync_run_id
            and voucher.status = 'posted'
        )
    ), flagged as (
      update public.credit_note_postings posting
      set status = 'correction_required',
          failure_reason = 'The targeted Tally check did not find the verified Credit Note. It may have been deleted or reversed.',
          reconciliation_reason = 'The targeted completed Tally check did not find the verified Credit Note.',
          reconciliation_snapshot = jsonb_build_object('checkedAt', now(), 'syncRunId', p_sync_run_id, 'expectedTallyGuid', missing_credit.verified_tally_guid, 'result', 'missing'),
          last_reconciled_at = now(),
          updated_at = now()
      from missing_credit
      where posting.id = missing_credit.id
      returning posting.id, posting.company_id, posting.proposal_id, posting.customer_id,
                missing_credit.scheme_version_id, posting.tally_credit_note_voucher_id, missing_credit.verified_tally_guid
    )
    insert into public.processing_issues (
      company_id, proposal_id, customer_id, scheme_version_id, tally_voucher_id,
      issue_key, issue_type, status, details
    )
    select company_id, proposal_id, customer_id, scheme_version_id, tally_credit_note_voucher_id,
      'note-reconciliation:credit:' || id::text, 'tally_note_missing_or_reversed', 'open',
      jsonb_build_object('postingType', 'credit_note', 'postingId', id, 'expectedTallyGuid', verified_tally_guid,
        'message', 'A targeted completed Tally check did not find this verified Credit Note. No replacement was created.')
    from flagged
    on conflict (issue_key) do update
      set status = 'open', details = excluded.details, resolved_by = null, resolved_at = null, updated_at = now();
    get diagnostics v_credit_flagged = row_count;
  end if;

  if v_debit_posting_id is not null then
    with missing_debit as (
      select posting.id, posting.candidate_id, posting.tally_debit_note_voucher_id, posting.verified_tally_guid
      from public.cash_discount_debit_note_postings posting
      join public.cash_discount_recovery_candidates candidate on candidate.id = posting.candidate_id
      join public.customers customer
        on customer.company_id = posting.company_id
        and customer.tally_ledger_guid = candidate.customer_tally_guid
      where posting.id = v_debit_posting_id
        and posting.company_id = p_company_id
        and posting.status = 'created_verified'
        and customer.id = v_customer_id
        and posting.debit_note_date between v_date_from and v_date_to
        and posting.verified_tally_guid is not null
        and not exists (
          select 1
          from public.tally_vouchers voucher
          where voucher.company_id = p_company_id
            and voucher.tally_guid = posting.verified_tally_guid
            and voucher.last_sync_run_id = p_sync_run_id
            and voucher.status = 'posted'
        )
    ), flagged as (
      update public.cash_discount_debit_note_postings posting
      set status = 'reconciliation_required',
          failure_reason = 'The targeted Tally check did not find the verified Debit Note. It may have been deleted or reversed.',
          reconciliation_reason = 'The targeted completed Tally check did not find the verified Debit Note.',
          reconciliation_snapshot = jsonb_build_object('checkedAt', now(), 'syncRunId', p_sync_run_id, 'expectedTallyGuid', missing_debit.verified_tally_guid, 'result', 'missing'),
          last_reconciled_at = now(),
          updated_at = now()
      from missing_debit
      where posting.id = missing_debit.id
      returning posting.id, posting.company_id, posting.candidate_id,
                posting.tally_debit_note_voucher_id, missing_debit.verified_tally_guid
    )
    insert into public.processing_issues (
      company_id, customer_id, tally_voucher_id, issue_key, issue_type, status, details
    )
    select flagged.company_id, customer.id, flagged.tally_debit_note_voucher_id,
      'note-reconciliation:debit:' || flagged.id::text, 'tally_note_missing_or_reversed', 'open',
      jsonb_build_object('postingType', 'debit_note', 'postingId', flagged.id, 'expectedTallyGuid', flagged.verified_tally_guid,
        'message', 'A targeted completed Tally check did not find this verified Debit Note. No replacement was created.')
    from flagged
    join public.cash_discount_recovery_candidates candidate on candidate.id = flagged.candidate_id
    join public.customers customer
      on customer.company_id = flagged.company_id and customer.tally_ledger_guid = candidate.customer_tally_guid
    on conflict (issue_key) do update
      set status = 'open', details = excluded.details, resolved_by = null, resolved_at = null, updated_at = now();
    get diagnostics v_debit_flagged = row_count;
  end if;

  return jsonb_build_object('creditNotesFlagged', v_credit_flagged, 'debitNotesFlagged', v_debit_flagged, 'skipped', false);
end;
$$;

revoke all on function public.reconcile_meenakshi_targeted_note_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_meenakshi_targeted_note_sync(uuid, uuid) to service_role;
