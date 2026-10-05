-- Meenakshi Phase 5: Finance review, recoverable Credit Note posting,
-- independent read-back verification, and verified-PDF lifecycle.
--
-- This is append-only and assumes the Phase 1-4 migrations have been applied.
-- MSG91 delivery remains deliberately outside this migration.

-- A bridge must receive the immutable financial command rather than reconstruct
-- it from UI values.  The bridge still independently reads Tally before a
-- posting can become created_verified.
create function public.meenakshi_credit_note_command_payload(p_credit_note_posting_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  proposal public.discount_proposals;
  tally_posting jsonb;
begin
  select * into posting
  from public.credit_note_postings
  where id = p_credit_note_posting_id;
  if not found then raise exception 'Credit Note posting not found'; end if;

  select * into proposal from public.discount_proposals where id = posting.proposal_id;
  tally_posting := posting.credit_note_snapshot -> 'tallyPosting';
  if nullif(btrim(coalesce(tally_posting #>> '{company,guid}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{company,name}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{voucherType,guid}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{voucherType,name}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{party,guid}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{party,name}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{discountLedger,guid}', '')), '') is null
     or nullif(btrim(coalesce(tally_posting #>> '{discountLedger,name}', '')), '') is null then
    raise exception 'Credit Note posting is missing its immutable Tally master identity snapshot';
  end if;

  return jsonb_build_object(
    'creditNotePostingId', posting.id,
    'businessIdempotencyKey', posting.idempotency_key,
    'creditNote', jsonb_build_object(
      'company', tally_posting -> 'company',
      'voucherType', tally_posting -> 'voucherType',
      'party', tally_posting -> 'party',
      'discountLedger', tally_posting -> 'discountLedger',
      'creditNoteDate', posting.credit_note_date,
      'amount', posting.discount_amount::text,
      'gstTreatment', posting.gst_treatment::text,
      'calculationReference', posting.calculation_reference,
      'allocation', jsonb_build_object('type', posting.bill_allocation_type::text, 'reference', posting.tally_bill_reference),
      'schemeType', proposal.scheme_type::text,
      'snapshot', posting.credit_note_snapshot
    )
  );
end;
$$;

-- Replace the Phase 1 dispatcher only to enrich the existing Credit Note
-- command payload.  Sync command behavior is unchanged.
create or replace function public.dispatch_outbox_to_tally_command(
  p_outbox_id uuid,
  p_connector_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  outbox_record public.integration_outbox;
  company_record public.companies;
  command_id uuid;
  mapped_command_type text;
  command_payload jsonb;
  posting_id uuid;
  expected_company_guid text;
  expected_company_name text;
begin
  select * into outbox_record
  from public.integration_outbox outbox
  where outbox.id = p_outbox_id and outbox.status = 'processing'
  for update;
  if not found then raise exception 'Outbox event must be claimed before dispatch'; end if;

  select * into company_record from public.companies company where company.id = outbox_record.company_id;
  if not exists (
    select 1 from public.tally_connector_company_bindings binding
    join public.tally_connectors connector on connector.id = binding.connector_id
    where binding.connector_id = p_connector_id and binding.company_id = outbox_record.company_id
      and binding.organization_id = outbox_record.organization_id and binding.is_active
      and connector.status = 'paired'
  ) then raise exception 'No active paired connector is bound to the outbox company'; end if;

  mapped_command_type := case outbox_record.event_type
    when 'tally_credit_note_create' then 'create_credit_note'
    when 'tally_credit_note_verify' then 'verify_credit_note'
    when 'tally_credit_note_pdf' then 'export_credit_note_pdf'
    when 'tally_targeted_refresh' then 'fetch_meenakshi_evidence'
    else null
  end;
  if mapped_command_type is null then raise exception 'Outbox event % is not a Tally command', outbox_record.event_type; end if;

  posting_id := nullif(outbox_record.payload ->> 'creditNotePostingId', '')::uuid;
  command_payload := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf')
      then public.meenakshi_credit_note_command_payload(posting_id)
    else outbox_record.payload
  end;
  expected_company_guid := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf') then command_payload #>> '{creditNote,company,guid}'
    else company_record.tally_company_guid
  end;
  expected_company_name := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf') then command_payload #>> '{creditNote,company,name}'
    else company_record.tally_company_name
  end;

  insert into public.tally_commands (
    organization_id, company_id, connector_id, source_outbox_id, command_type,
    business_idempotency_key, correlation_id, expected_tally_company_guid,
    expected_tally_company_name, payload
  ) values (
    outbox_record.organization_id, outbox_record.company_id, p_connector_id,
    outbox_record.id, mapped_command_type, outbox_record.idempotency_key,
    outbox_record.correlation_id, expected_company_guid,
    expected_company_name, command_payload
  ) on conflict (company_id, business_idempotency_key)
  do update set updated_at = excluded.updated_at
  returning id into command_id;

  if mapped_command_type = 'create_credit_note' then
    update public.credit_note_postings
    set status = 'sending', updated_at = now(), failure_reason = null
    where id = posting_id and status = 'queued';

    insert into public.credit_note_posting_attempts (
      credit_note_posting_id, attempt_number, command_key, command_status,
      command_payload
    ) values (
      posting_id,
      coalesce((select max(attempt_number) + 1 from public.credit_note_posting_attempts where credit_note_posting_id = posting_id), 1),
      outbox_record.idempotency_key, 'sending', command_payload
    ) on conflict (command_key) do nothing;
  end if;

  update public.integration_outbox
  set status = 'completed', completed_at = now(), locked_at = null,
      locked_by = null, lease_expires_at = null
  where id = outbox_record.id;
  return command_id;
end;
$$;

create function public.reject_meenakshi_proposal_review(
  p_proposal_id uuid,
  p_proposal_evaluation_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  proposal public.discount_proposals;
  v_organization_id uuid;
  review_id uuid;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'A rejection reason is required'; end if;
  select * into proposal from public.discount_proposals where id = p_proposal_id for update;
  if not found then raise exception 'Proposal not found'; end if;
  select company.organization_id into v_organization_id from public.companies company where company.id = proposal.company_id;
  if not exists (
    select 1 from public.organization_memberships
    where membership.organization_id = v_organization_id
      and profile_id = p_actor_id and role = 'finance_approver'
  ) then raise exception 'Finance Approver role is required'; end if;
  if not exists (
    select 1 from public.proposal_evaluations evaluation
    where evaluation.id = p_proposal_evaluation_id and evaluation.proposal_id = proposal.id
      and evaluation.source_fingerprint = proposal.source_fingerprint
  ) then raise exception 'Rejection must use the latest frozen evaluation and Tally fingerprint'; end if;

  update public.proposal_reviews review
  set proposal_evaluation_id = p_proposal_evaluation_id, source_fingerprint = proposal.source_fingerprint,
      status = 'rejected', review_reason = btrim(p_reason), reviewed_by = p_actor_id, reviewed_at = now()
  where review.proposal_id = proposal.id and review.status = 'pending'
  returning id into review_id;
  if review_id is null then
    insert into public.proposal_reviews (
      proposal_id, proposal_evaluation_id, status, source_fingerprint,
      review_reason, reviewed_by, reviewed_at
    ) values (
      proposal.id, p_proposal_evaluation_id, 'rejected', proposal.source_fingerprint,
      btrim(p_reason), p_actor_id, now()
    ) returning id into review_id;
  end if;
  update public.discount_proposals set status = 'needs_review', updated_at = now() where id = proposal.id;
  insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
  values (v_organization_id, proposal.company_id, 'user', p_actor_id, 'proposal_review_rejected', 'proposal_review', review_id, p_correlation_id,
    jsonb_build_object('proposalId', proposal.id, 'reason', btrim(p_reason)));
  return review_id;
end;
$$;

create function public.record_meenakshi_credit_note_create_result(
  p_credit_note_posting_id uuid,
  p_connector_id uuid,
  p_result jsonb,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  v_organization_id uuid;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found then raise exception 'Credit Note posting not found'; end if;
  if posting.status <> 'sending' then raise exception 'Only a sending Credit Note can enter read-back verification'; end if;
  if nullif(btrim(coalesce(p_result ->> 'tallyGuid', '')), '') is null then
    raise exception 'Tally create result did not contain a Credit Note GUID';
  end if;
  select company.organization_id into v_organization_id from public.companies company where company.id = posting.company_id;

  update public.credit_note_postings set status = 'verification_pending', failure_reason = null, updated_at = now()
  where id = posting.id;
  update public.credit_note_posting_attempts set command_status = 'verified', connector_response = p_result, completed_at = now()
  where id = (select id from public.credit_note_posting_attempts where credit_note_posting_id = posting.id order by attempt_number desc limit 1);
  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    v_organization_id, posting.company_id, p_correlation_id,
    'credit-note-verify:' || posting.id::text,
    'credit-note-verify:' || posting.id::text,
    'tally_credit_note_verify', 'credit_note_posting', posting.id,
    jsonb_build_object('creditNotePostingId', posting.id)
  ) on conflict (event_key) do nothing;
  insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
  values (v_organization_id, posting.company_id, 'tally_connector', p_connector_id, 'credit_note_create_result_recorded', 'credit_note_posting', posting.id, p_correlation_id,
    jsonb_build_object('tallyGuid', p_result ->> 'tallyGuid'));
  return posting.id;
end;
$$;

create function public.complete_meenakshi_credit_note_verification(
  p_credit_note_posting_id uuid,
  p_connector_id uuid,
  p_result jsonb,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  company public.companies;
  tally_posting jsonb;
  voucher_id uuid;
  amount_text text;
  verified_amount numeric(19,2);
  mismatch_reason text;
  verified_reference text;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found then raise exception 'Credit Note posting not found'; end if;
  if posting.status <> 'verification_pending' then raise exception 'Only a verification_pending Credit Note can be verified'; end if;
  select * into company from public.companies where id = posting.company_id;
  tally_posting := posting.credit_note_snapshot -> 'tallyPosting';

  amount_text := coalesce(p_result ->> 'amount', '');
  if amount_text !~ '^-?[0-9]+(\\.[0-9]+)?$' then mismatch_reason := 'Tally read-back did not contain a valid numeric amount';
  else verified_amount := round(amount_text::numeric, 2); end if;
  verified_reference := nullif(btrim(coalesce(p_result ->> 'billReference', '')), '');
  if mismatch_reason is null and coalesce(p_result ->> 'companyGuid', '') <> coalesce(tally_posting #>> '{company,guid}', '') then mismatch_reason := 'Tally company GUID does not match the approved snapshot'; end if;
  if mismatch_reason is null and coalesce(p_result ->> 'voucherTypeGuid', '') <> coalesce(tally_posting #>> '{voucherType,guid}', '') then mismatch_reason := 'Tally Credit Note voucher type does not match the approved snapshot'; end if;
  if mismatch_reason is null and coalesce(p_result ->> 'partyLedgerGuid', '') <> coalesce(tally_posting #>> '{party,guid}', '') then mismatch_reason := 'Tally party ledger does not match the approved snapshot'; end if;
  if mismatch_reason is null and coalesce(p_result ->> 'discountLedgerGuid', '') <> coalesce(tally_posting #>> '{discountLedger,guid}', '') then mismatch_reason := 'Tally discount ledger does not match the approved snapshot'; end if;
  if mismatch_reason is null and verified_amount <> posting.discount_amount then mismatch_reason := 'Tally amount does not equal the approved amount'; end if;
  if mismatch_reason is null and coalesce(p_result ->> 'voucherDate', '') <> posting.credit_note_date::text then mismatch_reason := 'Tally Credit Note date does not match'; end if;
  if mismatch_reason is null and coalesce(p_result ->> 'billAllocationType', '') <> posting.bill_allocation_type::text then mismatch_reason := 'Tally bill allocation type does not match'; end if;
  if mismatch_reason is null and coalesce(posting.tally_bill_reference, '') <> coalesce(verified_reference, '') then mismatch_reason := 'Tally bill reference does not match'; end if;
  if mismatch_reason is null and coalesce((p_result ->> 'inventoryLineCount')::integer, -1) <> 0 then mismatch_reason := 'A commercial Credit Note must not contain inventory lines'; end if;
  if mismatch_reason is null and coalesce((p_result ->> 'unexpectedGstLedgerCount')::integer, -1) <> 0 then mismatch_reason := 'A commercial Credit Note must not contain GST ledger entries'; end if;
  if mismatch_reason is null and nullif(btrim(coalesce(p_result ->> 'ledgerEntriesHash', '')), '') is null then mismatch_reason := 'Tally read-back did not contain a ledger-entry hash'; end if;
  if mismatch_reason is null and nullif(btrim(coalesce(p_result ->> 'tallyGuid', '')), '') is null then mismatch_reason := 'Tally read-back did not contain a GUID'; end if;

  if mismatch_reason is not null then
    update public.credit_note_postings set status = 'correction_required', failure_reason = mismatch_reason, updated_at = now() where id = posting.id;
    update public.credit_note_posting_attempts set verification_response = p_result, failure_reason = mismatch_reason, completed_at = now()
    where id = (select id from public.credit_note_posting_attempts where credit_note_posting_id = posting.id order by attempt_number desc limit 1);
    insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
    values (company.organization_id, posting.company_id, 'tally_connector', p_connector_id, 'credit_note_verification_mismatch', 'credit_note_posting', posting.id, p_correlation_id,
      jsonb_build_object('reason', mismatch_reason));
    return jsonb_build_object('verified', false, 'status', 'correction_required', 'reason', mismatch_reason);
  end if;

  insert into public.tally_vouchers (
    company_id, tally_guid, tally_master_id, tally_alter_id, voucher_number,
    voucher_kind, voucher_type_id, voucher_date, party_customer_id, status,
    gross_amount, narration, source_payload
  ) values (
    posting.company_id, p_result ->> 'tallyGuid', nullif(p_result ->> 'masterId', ''), nullif(p_result ->> 'alterId', ''),
    nullif(p_result ->> 'voucherNumber', ''), 'credit_note', posting.credit_note_voucher_type_id,
    posting.credit_note_date, posting.customer_id, 'posted', verified_amount,
    posting.calculation_reference, p_result
  ) on conflict (company_id, tally_guid) do update
    set tally_master_id = excluded.tally_master_id, tally_alter_id = excluded.tally_alter_id,
        voucher_number = excluded.voucher_number, voucher_date = excluded.voucher_date,
        voucher_type_id = excluded.voucher_type_id, party_customer_id = excluded.party_customer_id,
        status = 'posted', gross_amount = excluded.gross_amount, source_payload = excluded.source_payload,
        last_seen_at = now(), updated_at = now()
  returning id into voucher_id;

  perform public.verify_credit_note_and_enqueue_pdf(
    posting.id, p_connector_id, voucher_id, p_result ->> 'tallyGuid',
    coalesce(nullif(p_result ->> 'voucherNumber', ''), p_result ->> 'tallyGuid'),
    verified_amount, posting.discount_ledger_id, posting.bill_allocation_type,
    posting.calculation_reference, p_result ->> 'ledgerEntriesHash', p_result, p_correlation_id
  );
  update public.credit_note_posting_attempts set verification_response = p_result, completed_at = now()
  where id = (select id from public.credit_note_posting_attempts where credit_note_posting_id = posting.id order by attempt_number desc limit 1);
  return jsonb_build_object('verified', true, 'status', 'created_verified', 'postingId', posting.id, 'tallyVoucherId', voucher_id);
end;
$$;

create function public.record_meenakshi_credit_note_failure(
  p_credit_note_posting_id uuid,
  p_connector_id uuid,
  p_command_type text,
  p_failure_reason text,
  p_correlation_id uuid default gen_random_uuid()
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  company public.companies;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found then return; end if;
  select * into company from public.companies where id = posting.company_id;
  if p_command_type = 'create_credit_note' and posting.status = 'sending' then
    update public.credit_note_postings set status = 'failed', failure_reason = left(p_failure_reason, 2000), updated_at = now() where id = posting.id;
  elsif p_command_type = 'verify_credit_note' and posting.status = 'verification_pending' then
    update public.credit_note_postings set status = 'correction_required', failure_reason = left(p_failure_reason, 2000), updated_at = now() where id = posting.id;
  elsif p_command_type = 'export_credit_note_pdf' then
    update public.credit_note_documents set status = 'failed', failure_reason = left(p_failure_reason, 2000), attempts = attempts + 1
    where credit_note_posting_id = posting.id and document_kind = 'credit_note_pdf';
  end if;
  update public.credit_note_posting_attempts set command_status = 'dead_letter', failure_reason = left(p_failure_reason, 2000), completed_at = now()
  where id = (select id from public.credit_note_posting_attempts where credit_note_posting_id = posting.id order by attempt_number desc limit 1);
  insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
  values (company.organization_id, posting.company_id, 'tally_connector', p_connector_id, 'credit_note_command_failed', 'credit_note_posting', posting.id, p_correlation_id,
    jsonb_build_object('commandType', p_command_type, 'reason', left(p_failure_reason, 2000)));
end;
$$;

create function public.retry_meenakshi_credit_note_posting(
  p_credit_note_posting_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  company public.companies;
  retry_number integer;
  retry_key text;
  outbox_id uuid;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'A retry reason is required'; end if;
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found then raise exception 'Credit Note posting not found'; end if;
  select * into company from public.companies where id = posting.company_id;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = company.organization_id and membership.profile_id = p_actor_id
      and membership.role in ('administrator', 'finance_approver')
  ) then raise exception 'Administrator or Finance Approver role is required'; end if;
  if posting.status not in ('failed', 'correction_required') then raise exception 'Only a failed or correction-required Credit Note can be retried'; end if;
  retry_number := coalesce((select max(attempt_number) + 1 from public.credit_note_posting_attempts where credit_note_posting_id = posting.id), 1);
  retry_key := posting.idempotency_key || ':retry:' || retry_number::text;
  update public.credit_note_postings set status = 'queued', failure_reason = null, updated_at = now() where id = posting.id;
  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    company.organization_id, posting.company_id, p_correlation_id,
    'credit-note-create-retry:' || posting.id::text || ':' || retry_number::text,
    retry_key, 'tally_credit_note_create', 'credit_note_posting', posting.id,
    jsonb_build_object('creditNotePostingId', posting.id, 'retryReason', btrim(p_reason), 'businessIdempotencyKey', posting.idempotency_key)
  ) returning id into outbox_id;
  insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
  values (company.organization_id, posting.company_id, 'user', p_actor_id, 'credit_note_retry_queued', 'credit_note_posting', posting.id, p_correlation_id,
    jsonb_build_object('reason', btrim(p_reason), 'retryNumber', retry_number));
  return outbox_id;
end;
$$;

create function public.record_meenakshi_credit_note_pdf_result(
  p_credit_note_posting_id uuid,
  p_connector_id uuid,
  p_result jsonb,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  company public.companies;
  size_text text;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found or posting.status <> 'created_verified' then raise exception 'A PDF can only be recorded for a created_verified Credit Note'; end if;
  select * into company from public.companies where id = posting.company_id;
  size_text := coalesce(p_result ->> 'fileSizeBytes', '');
  if nullif(btrim(coalesce(p_result ->> 'storagePath', '')), '') is null
     or coalesce(p_result ->> 'sha256Hex', '') !~ '^[0-9a-fA-F]{64}$'
     or size_text !~ '^[1-9][0-9]*$'
     or coalesce(p_result ->> 'tallyGuid', '') <> posting.verified_tally_guid then
    raise exception 'PDF result did not identify the verified Credit Note and file metadata';
  end if;
  update public.credit_note_documents set
    status = 'verified', storage_path = p_result ->> 'storagePath', sha256_hex = lower(p_result ->> 'sha256Hex'),
    mime_type = 'application/pdf', file_size_bytes = size_text::bigint,
    tally_voucher_guid = posting.verified_tally_guid, tally_master_id = nullif(p_result ->> 'masterId', ''),
    attached_at = now(), verified_at = now(), attempts = attempts + 1, failure_reason = null
  where credit_note_posting_id = posting.id and document_kind = 'credit_note_pdf';
  update public.credit_note_postings set document_storage_path = p_result ->> 'storagePath', updated_at = now() where id = posting.id;
  insert into public.audit_events (organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value)
  values (company.organization_id, posting.company_id, 'tally_connector', p_connector_id, 'credit_note_pdf_verified', 'credit_note_posting', posting.id, p_correlation_id,
    jsonb_build_object('storagePath', p_result ->> 'storagePath', 'sha256Hex', lower(p_result ->> 'sha256Hex')));
  return posting.id;
end;
$$;

-- Approval must be based on an explicit, targeted live refresh requested for
-- this proposal.  This DB-level check protects the invariant even if a future
-- API client bypasses the browser screen.  Fifteen minutes is intentionally
-- short: it is a review window, not a financial default.
create or replace function public.approve_proposal_and_enqueue_credit_note(
  p_proposal_id uuid,
  p_proposal_evaluation_id uuid,
  p_actor_id uuid,
  p_credit_note_date date,
  p_bill_allocation_type public.bill_allocation_type,
  p_tally_bill_reference text,
  p_calculation_reference text,
  p_credit_note_snapshot jsonb,
  p_idempotency_key text,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  proposal_record public.discount_proposals;
  version_record public.scheme_versions;
  evaluation_record public.proposal_evaluations;
  review_refresh_run public.evaluation_runs;
  organization_id uuid;
  posting_id uuid;
  posting_amount numeric(19,2);
begin
  select proposal.* into proposal_record
  from public.discount_proposals proposal
  where proposal.id = p_proposal_id
  for update;
  if not found then raise exception 'Proposal not found'; end if;

  select company.organization_id into organization_id
  from public.companies company where company.id = proposal_record.company_id;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_id
      and membership.profile_id = p_actor_id and membership.role = 'finance_approver'
  ) then raise exception 'Finance Approver role is required'; end if;

  select posting.id into posting_id from public.credit_note_postings posting where posting.proposal_id = p_proposal_id;
  if posting_id is not null then return posting_id; end if;
  if proposal_record.status not in ('eligible', 'pending_approval') then raise exception 'Only an eligible proposal may be approved'; end if;
  if exists (
    select 1 from public.processing_issues issue
    where issue.proposal_id = p_proposal_id and issue.status in ('open', 'in_progress')
  ) then raise exception 'Resolve all blocking proposal issues before approval'; end if;

  select evaluation.* into evaluation_record
  from public.proposal_evaluations evaluation
  where evaluation.id = p_proposal_evaluation_id
    and evaluation.proposal_id = p_proposal_id
    and evaluation.company_id = proposal_record.company_id
    and evaluation.source_fingerprint = proposal_record.source_fingerprint;
  if not found then raise exception 'Approval must use the latest frozen evaluation and Tally fingerprint'; end if;

  select * into review_refresh_run from public.evaluation_runs run
  where run.id = evaluation_record.evaluation_run_id
    and run.company_id = proposal_record.company_id;
  if not found
     or review_refresh_run.status <> 'completed'
     or review_refresh_run.request_context ->> 'reviewRefreshForProposal' <> proposal_record.id::text
     or review_refresh_run.completed_at is null
     or review_refresh_run.completed_at < now() - interval '15 minutes' then
    raise exception 'Approval requires a completed targeted Tally refresh from the last 15 minutes';
  end if;

  select version.* into version_record from public.scheme_versions version
  where version.id = proposal_record.scheme_version_id and version.status = 'active';
  if not found then raise exception 'Proposal rule version is no longer active'; end if;
  posting_amount := coalesce(proposal_record.posted_discount_amount, round(proposal_record.calculated_discount_amount, 2));
  if posting_amount is null or posting_amount <= 0 then raise exception 'Approved Credit Note amount must be positive'; end if;
  if p_bill_allocation_type = 'agst_ref' and nullif(btrim(p_tally_bill_reference), '') is null then
    raise exception 'Against Reference requires the exact Tally bill reference';
  end if;

  insert into public.proposal_reviews (
    proposal_id, proposal_evaluation_id, status, source_fingerprint, review_reason, reviewed_by, reviewed_at
  ) values (
    p_proposal_id, p_proposal_evaluation_id, 'approved', proposal_record.source_fingerprint,
    'Approved for Credit Note posting', p_actor_id, now()
  );
  insert into public.credit_note_postings (
    proposal_id, proposal_evaluation_id, company_id, customer_id, status, idempotency_key,
    credit_note_date, discount_amount, calculation_reference, credit_note_voucher_type_id,
    discount_ledger_id, bill_allocation_type, tally_bill_reference, gst_treatment,
    credit_note_snapshot, created_by
  ) values (
    p_proposal_id, p_proposal_evaluation_id, proposal_record.company_id, proposal_record.customer_id,
    'queued', p_idempotency_key, p_credit_note_date, posting_amount, p_calculation_reference,
    version_record.credit_note_voucher_type_id, version_record.discount_ledger_id,
    p_bill_allocation_type, p_tally_bill_reference, version_record.gst_treatment,
    p_credit_note_snapshot, p_actor_id
  ) returning id into posting_id;
  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    organization_id, proposal_record.company_id, p_correlation_id,
    'credit-note-create:' || posting_id::text, p_idempotency_key,
    'tally_credit_note_create', 'credit_note_posting', posting_id,
    jsonb_build_object('creditNotePostingId', posting_id)
  );
  update public.discount_proposals set status = 'sending_to_tally', updated_at = now() where id = p_proposal_id;
  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id,
    correlation_id, new_value
  ) values (
    organization_id, proposal_record.company_id, 'user', p_actor_id,
    'proposal_approved_and_credit_note_queued', 'credit_note_posting', posting_id,
    p_correlation_id, jsonb_build_object('proposalId', p_proposal_id, 'amount', posting_amount, 'reviewRefreshRunId', review_refresh_run.id)
  );
  return posting_id;
end;
$$;

revoke execute on function public.meenakshi_credit_note_command_payload(uuid) from public, anon, authenticated;
revoke all on function public.approve_proposal_and_enqueue_credit_note(uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.reject_meenakshi_proposal_review(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.record_meenakshi_credit_note_create_result(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.complete_meenakshi_credit_note_verification(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.record_meenakshi_credit_note_failure(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.retry_meenakshi_credit_note_posting(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.record_meenakshi_credit_note_pdf_result(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.meenakshi_credit_note_command_payload(uuid) to service_role;
grant execute on function public.approve_proposal_and_enqueue_credit_note(uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid) to service_role;
grant execute on function public.reject_meenakshi_proposal_review(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.record_meenakshi_credit_note_create_result(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function public.complete_meenakshi_credit_note_verification(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function public.record_meenakshi_credit_note_failure(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.retry_meenakshi_credit_note_posting(uuid, uuid, text, uuid) to service_role;
grant execute on function public.record_meenakshi_credit_note_pdf_result(uuid, uuid, jsonb, uuid) to service_role;

create index if not exists credit_note_postings_review_queue_idx
  on public.credit_note_postings (company_id, status, updated_at desc);
