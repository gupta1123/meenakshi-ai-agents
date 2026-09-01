-- Prevent duplicate Cash Discount Debit Note requests from waiting indefinitely.
-- This migration is intentionally prepared for manual application.

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
  settings public.company_credit_note_accounting_settings;
  voucher_type public.tally_voucher_types;
  recovery_ledger public.tally_ledgers;
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
      raise exception using
        errcode = '55P03',
        message = 'This Debit Note is already being prepared. Wait a moment and refresh.';
  end;

  if not found then raise exception 'This recovery is no longer current. Run Cash Discount again.'; end if;
  if candidate.status = 'posting' then raise exception 'This Debit Note is already being prepared.'; end if;
  if candidate.status <> 'action_required' or candidate.remaining_recovery <= 0 then
    raise exception 'This recovery is not ready for a Debit Note';
  end if;

  select * into company from public.companies where id = p_company_id;
  select * into settings from public.company_credit_note_accounting_settings where company_id = p_company_id;
  if settings.cash_discount_debit_note_voucher_type_id is null or settings.cash_discount_recovery_ledger_id is null then
    raise exception 'Set up the Cash Discount Debit Note type and recovery ledger in Rulebook before preparing a Debit Note.';
  end if;

  select * into voucher_type
  from public.tally_voucher_types
  where id = settings.cash_discount_debit_note_voucher_type_id and company_id = p_company_id and is_available;
  select * into recovery_ledger
  from public.tally_ledgers
  where id = settings.cash_discount_recovery_ledger_id and company_id = p_company_id and is_available;
  if voucher_type.id is null or recovery_ledger.id is null then
    raise exception 'The configured Debit Note type or recovery ledger is no longer available in Tally.';
  end if;

  reference := 'MEENAKSHI-CD-RECOVERY-' || candidate.id::text;
  insert into public.cash_discount_debit_note_postings (
    company_id, candidate_id, idempotency_key, debit_note_date, amount, calculation_reference,
    debit_note_voucher_type_id, recovery_ledger_id, debit_note_snapshot, created_by
  ) values (
    p_company_id, candidate.id, p_idempotency_key, current_date, candidate.remaining_recovery, reference,
    voucher_type.id, recovery_ledger.id,
    jsonb_build_object(
      'company', jsonb_build_object('guid', company.tally_company_guid, 'name', company.tally_company_name),
      'voucherType', jsonb_build_object('guid', voucher_type.tally_voucher_type_guid, 'name', voucher_type.name),
      'party', jsonb_build_object('guid', candidate.customer_tally_guid, 'name', candidate.customer_name),
      'recoveryLedger', jsonb_build_object('guid', recovery_ledger.tally_ledger_guid, 'name', recovery_ledger.name),
      'debitNoteDate', current_date,
      'amount', candidate.remaining_recovery::text,
      'calculationReference', reference,
      'allocation', jsonb_build_object('type', 'agst_ref', 'reference', candidate.bill_reference),
      'sourceInvoice', jsonb_build_object('guid', candidate.invoice_tally_guid, 'number', candidate.invoice_number)
    ),
    p_actor_id
  ) returning * into posting;

  update public.cash_discount_recovery_candidates set status = 'posting' where id = candidate.id;
  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload, organization_id,
    company_id, correlation_id, idempotency_key, max_attempts
  ) values (
    'cd-debit-note:' || posting.id::text,
    'tally_debit_note_create',
    'cash_discount_debit_note_posting',
    posting.id,
    jsonb_build_object('debitNotePostingId', posting.id),
    company.organization_id,
    company.id,
    gen_random_uuid(),
    'cd-debit-note:' || posting.id::text,
    1
  );
  return posting;
end;
$$;

revoke execute on function public.enqueue_meenakshi_cd_debit_note(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.enqueue_meenakshi_cd_debit_note(uuid, uuid, uuid, text) to service_role;
