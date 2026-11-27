-- Cash Discount Credit Notes: date inside the company's own financial year.
-- Replaces one function (same signature, same behaviour) so the note is dated today when today is
-- inside the company's year, and the last day of that year otherwise. A 2025-26 company cannot take
-- a note dated in 2026-27, and the note must be created in the year it was calculated from.
-- Additive: no table or data changes.

create or replace function public.enqueue_meenakshi_cd_credit_note(
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
  note_date date;
begin
  if coalesce(length(btrim(p_idempotency_key)), 0) = 0 then raise exception 'An idempotency key is required'; end if;
  select * into posting from public.cash_discount_debit_note_postings
  where company_id = p_company_id and idempotency_key = p_idempotency_key;
  if found then return posting; end if;

  begin
    select * into candidate from public.cash_discount_recovery_candidates
    where id = p_candidate_id and company_id = p_company_id and current_snapshot
    for update nowait;
  exception when lock_not_available then
    raise exception using errcode = '55P03', message = 'This Credit Note is already being prepared. Wait a moment and refresh.';
  end;
  if not found then raise exception 'This result is no longer current. Run Cash Discount again.'; end if;
  if candidate.candidate_kind <> 'settlement' then raise exception 'Only Cash Discount settlements get a Credit Note.'; end if;
  if candidate.status = 'posting' then raise exception 'This Credit Note is already being prepared.'; end if;
  if candidate.status not in ('action_required', 'review_required') or candidate.remaining_recovery <= 0 then
    raise exception 'This invoice is not ready for a Credit Note';
  end if;
  if exists (
    select 1 from public.cash_discount_debit_note_postings existing
    where existing.company_id = p_company_id and existing.note_kind = 'credit_note'
      and existing.status not in ('failed', 'cancelled')
      and existing.debit_note_snapshot #>> '{sourceInvoice,guid}' = candidate.invoice_tally_guid
  ) then
    raise exception 'A Cash Discount Credit Note already exists for this invoice.';
  end if;

  select * into company from public.companies where id = p_company_id;
  if not found then raise exception 'The selected company is unavailable.'; end if;
  -- A Credit Note belongs to the year it was calculated in: dated today when today is inside that
  -- company's financial year, otherwise the last day of that year (Tally refuses other dates).
  note_date := current_date;
  if company.tally_books_from is not null then
    note_date := least(note_date, (company.tally_books_from + interval '1 year' - interval '1 day')::date);
    note_date := greatest(note_date, company.tally_books_from);
  end if;

  reference := left('CN-CD-' || coalesce(nullif(candidate.invoice_number, ''), candidate.id::text), 120);
  insert into public.cash_discount_debit_note_postings (
    company_id, candidate_id, idempotency_key, debit_note_date, amount, calculation_reference,
    debit_note_voucher_type_id, recovery_ledger_id, debit_note_snapshot, created_by, note_kind
  ) values (
    p_company_id, candidate.id, p_idempotency_key, note_date, round(candidate.remaining_recovery, 2),
    reference, null, null,
    jsonb_build_object(
      'noteKind', 'credit_note',
      'company', jsonb_build_object('guid', company.tally_company_guid, 'name', company.tally_company_name),
      'voucherType', jsonb_build_object('name', 'Credit Note'),
      'party', jsonb_build_object('guid', candidate.customer_tally_guid, 'name', candidate.customer_name),
      'salesLedger', jsonb_build_object('name', coalesce(candidate.source_sales_ledger_name, '')),
      'debitNoteDate', note_date,
      'amount', round(candidate.remaining_recovery, 2)::text,
      'calculationReference', reference,
      'allocation', jsonb_build_object('type', 'on_account', 'reference', reference),
      'sourceInvoice', jsonb_build_object('guid', candidate.invoice_tally_guid, 'number', candidate.invoice_number, 'billReference', candidate.bill_reference),
      'cashDiscount', jsonb_build_object(
        'category', candidate.settlement_category, 'eligibleTonnes', candidate.eligible_tonnes,
        'amountPerTonne', candidate.amount_per_tonne, 'discountAmount', candidate.discount_amount,
        'invoiceDate', candidate.invoice_date, 'windowDeadline', candidate.missed_window_deadline,
        'segmentLabel', candidate.segment_label)
    ),
    p_actor_id, 'credit_note'
  ) returning * into posting;

  update public.cash_discount_recovery_candidates set status = 'posting' where id = candidate.id;
  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload, organization_id,
    company_id, correlation_id, idempotency_key, max_attempts
  ) values (
    'cd-credit-note:' || posting.id::text, 'tally_debit_note_create', 'cash_discount_debit_note_posting', posting.id,
    jsonb_build_object('debitNotePostingId', posting.id), company.organization_id,
    company.id, gen_random_uuid(), 'cd-credit-note:' || posting.id::text, 1
  );
  return posting;
end;
$$;

revoke execute on function public.enqueue_meenakshi_cd_credit_note(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.enqueue_meenakshi_cd_credit_note(uuid,uuid,uuid,text) to service_role;
