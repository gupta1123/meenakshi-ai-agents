-- TOD Credit Notes use the standard Tally Credit Note voucher type and the
-- Sales ledger(s) captured from the qualifying source invoices. No separate
-- posting configuration is required. Legacy posting columns remain populated
-- with the automatically resolved primary source ledger for compatibility.

create or replace function public.approve_proposal_and_enqueue_credit_note(
  p_proposal_id uuid, p_proposal_evaluation_id uuid, p_actor_id uuid,
  p_credit_note_date date, p_bill_allocation_type public.bill_allocation_type,
  p_tally_bill_reference text, p_calculation_reference text,
  p_credit_note_snapshot jsonb, p_idempotency_key text,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid language plpgsql set search_path = '' as $$
declare
  proposal_record public.discount_proposals;
  version_record public.scheme_versions;
  evaluation_record public.proposal_evaluations;
  review_refresh_run public.evaluation_runs;
  v_organization_id uuid;
  posting_id uuid;
  posting_amount numeric(19,2);
  automatic_voucher_type_id uuid;
  primary_sales_ledger_id uuid;
begin
  select * into proposal_record from public.discount_proposals where id = p_proposal_id for update;
  if not found then raise exception 'Proposal not found'; end if;
  select organization_id into v_organization_id from public.companies where id = proposal_record.company_id;
  if not exists (select 1 from public.organization_memberships where organization_id = v_organization_id and profile_id = p_actor_id and role = 'finance_approver') then raise exception 'Finance Approver role is required'; end if;
  select id into posting_id from public.credit_note_postings where proposal_id = p_proposal_id;
  if posting_id is not null then return posting_id; end if;
  if proposal_record.status not in ('eligible', 'pending_approval') then raise exception 'Only an eligible proposal may be approved'; end if;
  if exists (select 1 from public.processing_issues where proposal_id = p_proposal_id and status in ('open', 'in_progress')) then raise exception 'Resolve all blocking proposal issues before approval'; end if;
  select * into evaluation_record from public.proposal_evaluations where id = p_proposal_evaluation_id and proposal_id = p_proposal_id and company_id = proposal_record.company_id and source_fingerprint = proposal_record.source_fingerprint;
  if not found then raise exception 'Approval must use the latest frozen evaluation and Tally fingerprint'; end if;
  select * into review_refresh_run from public.evaluation_runs where id = evaluation_record.evaluation_run_id and company_id = proposal_record.company_id;
  if not found or review_refresh_run.status <> 'completed' or review_refresh_run.request_context ->> 'reviewRefreshForProposal' <> proposal_record.id::text or review_refresh_run.completed_at is null or review_refresh_run.completed_at < now() - interval '15 minutes' then raise exception 'Approval requires a completed targeted Tally refresh from the last 15 minutes'; end if;
  select * into version_record from public.scheme_versions where id = proposal_record.scheme_version_id and status = 'active';
  if not found then raise exception 'Proposal rule version is no longer active'; end if;
  posting_amount := coalesce(proposal_record.posted_discount_amount, round(proposal_record.calculated_discount_amount, 2));
  if posting_amount is null or posting_amount <= 0 then raise exception 'Approved Credit Note amount must be positive'; end if;
  automatic_voucher_type_id := nullif(p_credit_note_snapshot #>> '{tallyPosting,voucherType,id}', '')::uuid;
  primary_sales_ledger_id := nullif(p_credit_note_snapshot #>> '{tallyPosting,sourceSalesLedgers,0,id}', '')::uuid;
  if automatic_voucher_type_id is null or primary_sales_ledger_id is null then raise exception 'Approved Credit Note snapshot is missing automatic Tally posting identities'; end if;
  insert into public.proposal_reviews (proposal_id, proposal_evaluation_id, status, source_fingerprint, review_reason, reviewed_by, reviewed_at)
  values (p_proposal_id, p_proposal_evaluation_id, 'approved', proposal_record.source_fingerprint, 'Approved for Credit Note posting', p_actor_id, now());
  insert into public.credit_note_postings (
    proposal_id, proposal_evaluation_id, company_id, customer_id, status, idempotency_key,
    credit_note_date, discount_amount, calculation_reference, credit_note_voucher_type_id,
    discount_ledger_id, bill_allocation_type, tally_bill_reference, gst_treatment,
    credit_note_snapshot, created_by
  ) values (
    p_proposal_id, p_proposal_evaluation_id, proposal_record.company_id, proposal_record.customer_id,
    'queued', p_idempotency_key, p_credit_note_date, posting_amount, p_calculation_reference,
    automatic_voucher_type_id, primary_sales_ledger_id, p_bill_allocation_type,
    p_tally_bill_reference, 'commercial_no_gst', p_credit_note_snapshot, p_actor_id
  ) returning id into posting_id;
  insert into public.integration_outbox (organization_id, company_id, correlation_id, event_key, idempotency_key, event_type, aggregate_type, aggregate_id, payload)
  values (v_organization_id, proposal_record.company_id, p_correlation_id, 'credit-note-create:' || posting_id, p_idempotency_key, 'tally_credit_note_create', 'credit_note_posting', posting_id, jsonb_build_object('creditNotePostingId', posting_id));
  update public.discount_proposals set status = 'sending_to_tally', updated_at = now() where id = p_proposal_id;
  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action, entity_type,
    entity_id, correlation_id, new_value
  ) values (
    v_organization_id, proposal_record.company_id, 'user', p_actor_id,
    'proposal_approved_and_credit_note_queued', 'credit_note_posting', posting_id,
    p_correlation_id, jsonb_build_object(
      'proposalId', p_proposal_id,
      'amount', posting_amount,
      'reviewRefreshRunId', review_refresh_run.id,
      'postingMode', 'automatic_source_sales_ledgers'
    )
  );
  return posting_id;
end;
$$;

create or replace function public.validate_credit_note_posting_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status <> old.status and not (
    (old.status = 'pending_approval' and new.status in ('queued', 'failed', 'cancel_requested')) or
    (old.status = 'queued' and new.status in ('sending', 'failed', 'cancel_requested')) or
    (old.status = 'sending' and new.status in ('verification_pending', 'correction_required', 'failed')) or
    (old.status = 'verification_pending' and new.status in ('created_verified', 'correction_required', 'failed')) or
    (old.status in ('correction_required', 'failed') and new.status in ('queued', 'cancel_requested', 'cancelled')) or
    (old.status = 'cancel_requested' and new.status in ('cancelled', 'failed'))
  ) then raise exception 'Invalid Credit Note posting status transition: % to %', old.status, new.status; end if;
  if new.gst_treatment <> 'commercial_no_gst' then raise exception 'TOD Credit Notes must use commercial_no_gst treatment'; end if;
  if exists (
    select 1 from public.discount_proposals proposal
    where proposal.id = new.proposal_id
      and (
        (proposal.scheme_type = 'tod' and new.bill_allocation_type <> 'new_ref')
        or (proposal.scheme_type = 'cd' and new.bill_allocation_type not in ('agst_ref', 'new_ref'))
      )
  ) then raise exception 'TOD Credit Notes use New Ref; CD Credit Notes use Agst Ref or New Ref according to settlement state'; end if;
  if new.bill_allocation_type = 'agst_ref' and nullif(btrim(new.tally_bill_reference), '') is null then raise exception 'Against Reference requires a Tally bill reference'; end if;
  if new.status in ('queued','sending','verification_pending','created_verified') and not exists (
    select 1 from public.proposal_reviews review join public.discount_proposals proposal on proposal.id = review.proposal_id
    where review.proposal_id = new.proposal_id and review.status = 'approved' and review.source_fingerprint = proposal.source_fingerprint
  ) then raise exception 'Credit Note posting requires an approved review of current Tally evidence'; end if;
  if new.status = 'created_verified' then
    if new.tally_credit_note_voucher_id is null
       or new.verified_tally_guid is null
       or new.verified_voucher_number is null
       or new.verified_amount is null
       or new.verified_at is null
       or new.verification_snapshot is null
       or new.verified_discount_ledger_id is null
       or new.verified_bill_allocation_type is null
       or new.verified_calculation_reference is null
       or new.verified_ledger_entries_hash is null
       or not coalesce(new.verified_company_matches, false)
       or not coalesce(new.verified_party_matches, false)
       or not coalesce(new.verified_voucher_type_matches, false)
       or not coalesce(new.verified_no_inventory_lines, false)
       or not coalesce(new.verified_no_unexpected_gst, false) then
      raise exception 'A Credit Note cannot be created_verified until every structured Tally read-back check is stored and passed';
    end if;
    if new.verified_amount <> new.discount_amount
       or new.verified_discount_ledger_id <> new.discount_ledger_id
       or new.verified_bill_allocation_type <> new.bill_allocation_type
       or new.verified_calculation_reference <> new.calculation_reference then
      raise exception 'Verified Tally values must equal the approved posting values';
    end if;
    if not exists (
      select 1 from public.tally_vouchers voucher
      where voucher.id = new.tally_credit_note_voucher_id
        and voucher.company_id = new.company_id
        and voucher.voucher_kind = 'credit_note'
        and voucher.status = 'posted'
        and voucher.voucher_type_id = new.credit_note_voucher_type_id
        and voucher.party_customer_id = new.customer_id
        and voucher.voucher_date = new.credit_note_date
        and round(voucher.gross_amount, 2) = new.verified_amount
    ) then raise exception 'Verified Credit Note must match company, type, party, date, and amount in Tally'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.meenakshi_credit_note_command_payload(p_credit_note_posting_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare posting public.credit_note_postings; proposal public.discount_proposals; tally_posting jsonb;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id;
  if not found then raise exception 'Credit Note posting not found'; end if;
  select * into proposal from public.discount_proposals where id = posting.proposal_id;
  tally_posting := posting.credit_note_snapshot -> 'tallyPosting';
  if nullif(btrim(coalesce(tally_posting #>> '{company,guid}', '')), '') is null
    or nullif(btrim(coalesce(tally_posting #>> '{company,name}', '')), '') is null
    or nullif(btrim(coalesce(tally_posting #>> '{voucherType,guid}', '')), '') is null
    or nullif(btrim(coalesce(tally_posting #>> '{voucherType,name}', '')), '') is null
    or nullif(btrim(coalesce(tally_posting #>> '{party,guid}', '')), '') is null
    or nullif(btrim(coalesce(tally_posting #>> '{party,name}', '')), '') is null
    or jsonb_typeof(tally_posting -> 'sourceSalesLedgers') <> 'array'
    or jsonb_array_length(tally_posting -> 'sourceSalesLedgers') = 0 then
    raise exception 'Credit Note posting is missing its immutable Tally identity snapshot';
  end if;
  return jsonb_build_object('creditNotePostingId', posting.id, 'businessIdempotencyKey', posting.idempotency_key,
    'creditNote', jsonb_build_object('company', tally_posting->'company', 'voucherType', tally_posting->'voucherType',
      'party', tally_posting->'party', 'sourceSalesLedgers', tally_posting->'sourceSalesLedgers',
      'creditNoteDate', posting.credit_note_date, 'amount', posting.discount_amount::text,
      'gstTreatment', posting.gst_treatment::text, 'calculationReference', posting.calculation_reference,
      'allocation', jsonb_build_object('type', posting.bill_allocation_type::text, 'reference', posting.tally_bill_reference),
      'schemeType', proposal.scheme_type::text, 'snapshot', posting.credit_note_snapshot));
end;
$$;

create or replace function public.complete_meenakshi_credit_note_verification(
  p_credit_note_posting_id uuid, p_connector_id uuid, p_result jsonb,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  posting public.credit_note_postings; company public.companies; tally_posting jsonb;
  voucher_id uuid; verified_amount numeric(19,2); mismatch_reason text; verified_reference text;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found then raise exception 'Credit Note posting not found'; end if;
  if posting.status <> 'verification_pending' then raise exception 'Only a verification_pending Credit Note can be verified'; end if;
  select * into company from public.companies where id = posting.company_id;
  tally_posting := posting.credit_note_snapshot -> 'tallyPosting';
  if coalesce(p_result->>'amount','') !~ '^-?[0-9]+(\.[0-9]+)?$' then mismatch_reason := 'Tally read-back amount is invalid'; else verified_amount := round((p_result->>'amount')::numeric,2); end if;
  verified_reference := nullif(btrim(coalesce(p_result->>'billReference','')), '');
  if mismatch_reason is null and p_result->>'companyGuid' <> tally_posting #>> '{company,guid}' then mismatch_reason := 'Tally company does not match'; end if;
  if mismatch_reason is null and p_result->>'voucherTypeGuid' <> tally_posting #>> '{voucherType,guid}' then mismatch_reason := 'Tally Credit Note type does not match'; end if;
  if mismatch_reason is null and p_result->>'partyLedgerGuid' <> tally_posting #>> '{party,guid}' then mismatch_reason := 'Tally customer ledger does not match'; end if;
  if mismatch_reason is null and (
    select coalesce(jsonb_agg(jsonb_build_object(
      'guid', entry->>'guid', 'name', entry->>'name',
      'amount', round((entry->>'amount')::numeric, 2)
    ) order by entry->>'guid'), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_result->'sourceSalesLedgerEvidence', '[]'::jsonb)) entry
  ) <> (
    select coalesce(jsonb_agg(jsonb_build_object(
      'guid', entry->>'guid', 'name', entry->>'name',
      'amount', round((entry->>'amount')::numeric, 2)
    ) order by entry->>'guid'), '[]'::jsonb)
    from jsonb_array_elements(coalesce(tally_posting->'sourceSalesLedgers', '[]'::jsonb)) entry
  ) then mismatch_reason := 'Tally source Sales ledger split does not match'; end if;
  if mismatch_reason is null and verified_amount <> posting.discount_amount then mismatch_reason := 'Tally amount does not equal the approved amount'; end if;
  if mismatch_reason is null and p_result->>'voucherDate' <> posting.credit_note_date::text then mismatch_reason := 'Tally Credit Note date does not match'; end if;
  if mismatch_reason is null and p_result->>'billAllocationType' <> posting.bill_allocation_type::text then mismatch_reason := 'Tally bill allocation type does not match'; end if;
  if mismatch_reason is null and coalesce(posting.tally_bill_reference,'') <> coalesce(verified_reference,'') then mismatch_reason := 'Tally bill reference does not match'; end if;
  if mismatch_reason is null and coalesce((p_result->>'inventoryLineCount')::integer,-1) <> 0 then mismatch_reason := 'Credit Note must not contain inventory lines'; end if;
  if mismatch_reason is null and coalesce((p_result->>'unexpectedGstLedgerCount')::integer,-1) <> 0 then mismatch_reason := 'Credit Note must not contain GST ledger entries'; end if;
  if mismatch_reason is null and nullif(btrim(coalesce(p_result->>'ledgerEntriesHash','')), '') is null then mismatch_reason := 'Tally read-back did not contain a ledger-entry hash'; end if;
  if mismatch_reason is null and nullif(btrim(coalesce(p_result->>'tallyGuid','')), '') is null then mismatch_reason := 'Tally read-back did not contain a GUID'; end if;
  if mismatch_reason is not null then
    update public.credit_note_postings set status='correction_required', failure_reason=mismatch_reason, updated_at=now() where id=posting.id;
    update public.credit_note_posting_attempts
    set verification_response=p_result, failure_reason=mismatch_reason, completed_at=now()
    where id=(select id from public.credit_note_posting_attempts where credit_note_posting_id=posting.id order by attempt_number desc limit 1);
    insert into public.audit_events (organization_id,company_id,actor_type,actor_id,action,entity_type,entity_id,correlation_id,new_value)
    values (company.organization_id,posting.company_id,'tally_connector',p_connector_id,'credit_note_verification_mismatch','credit_note_posting',posting.id,p_correlation_id,jsonb_build_object('reason',mismatch_reason));
    return jsonb_build_object('verified',false,'status','correction_required','reason',mismatch_reason);
  end if;
  insert into public.tally_vouchers (company_id,tally_guid,tally_master_id,tally_alter_id,voucher_number,voucher_kind,voucher_type_id,voucher_date,party_customer_id,status,gross_amount,narration,source_payload)
  values (posting.company_id,p_result->>'tallyGuid',nullif(p_result->>'masterId',''),nullif(p_result->>'alterId',''),nullif(p_result->>'voucherNumber',''),'credit_note',posting.credit_note_voucher_type_id,posting.credit_note_date,posting.customer_id,'posted',verified_amount,posting.calculation_reference,p_result)
  on conflict (company_id,tally_guid) do update
    set tally_master_id=excluded.tally_master_id,tally_alter_id=excluded.tally_alter_id,
        voucher_number=excluded.voucher_number,voucher_date=excluded.voucher_date,
        voucher_type_id=excluded.voucher_type_id,party_customer_id=excluded.party_customer_id,
        status='posted',gross_amount=excluded.gross_amount,source_payload=excluded.source_payload,
        last_seen_at=now(),updated_at=now()
  returning id into voucher_id;
  perform public.verify_credit_note_and_enqueue_pdf(posting.id,p_connector_id,voucher_id,p_result->>'tallyGuid',coalesce(nullif(p_result->>'voucherNumber',''),p_result->>'tallyGuid'),verified_amount,posting.discount_ledger_id,posting.bill_allocation_type,posting.calculation_reference,p_result->>'ledgerEntriesHash',p_result,p_correlation_id);
  update public.credit_note_posting_attempts set verification_response=p_result,completed_at=now()
  where id=(select id from public.credit_note_posting_attempts where credit_note_posting_id=posting.id order by attempt_number desc limit 1);
  return jsonb_build_object('verified',true,'status','created_verified','postingId',posting.id,'tallyVoucherId',voucher_id);
end;
$$;
