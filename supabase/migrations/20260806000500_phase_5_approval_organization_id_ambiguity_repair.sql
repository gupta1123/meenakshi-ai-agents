-- Meenakshi Phase 5 repair: avoid PL/pgSQL variable/column ambiguity while
-- approving a refreshed proposal. This is append-only because Phase 5 may
-- already be deployed.

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
  v_organization_id uuid;
  posting_id uuid;
  posting_amount numeric(19,2);
begin
  select proposal.* into proposal_record
  from public.discount_proposals proposal
  where proposal.id = p_proposal_id
  for update;
  if not found then raise exception 'Proposal not found'; end if;

  select company.organization_id into v_organization_id
  from public.companies company where company.id = proposal_record.company_id;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = v_organization_id
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
    v_organization_id, proposal_record.company_id, p_correlation_id,
    'credit-note-create:' || posting_id::text, p_idempotency_key,
    'tally_credit_note_create', 'credit_note_posting', posting_id,
    jsonb_build_object('creditNotePostingId', posting_id)
  );
  update public.discount_proposals set status = 'sending_to_tally', updated_at = now() where id = p_proposal_id;
  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id,
    correlation_id, new_value
  ) values (
    v_organization_id, proposal_record.company_id, 'user', p_actor_id,
    'proposal_approved_and_credit_note_queued', 'credit_note_posting', posting_id,
    p_correlation_id, jsonb_build_object('proposalId', p_proposal_id, 'amount', posting_amount, 'reviewRefreshRunId', review_refresh_run.id)
  );
  return posting_id;
end;
$$;

