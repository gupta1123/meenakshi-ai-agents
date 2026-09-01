-- Evaluation evidence, approval/posting workflows, MSG91 delivery, audit, and RLS.

create table public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  scheme_version_id uuid not null,
  evaluation_date date not null,
  period_start date not null,
  period_end date not null,
  status public.evaluation_run_status not null default 'queued',
  requested_by uuid,
  tally_refresh_run_id uuid references public.tally_sync_runs(id) on delete set null,
  source_fingerprint text,
  summary jsonb not null default '{}'::jsonb,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete restrict,
  check (period_end >= period_start)
);

create index evaluation_runs_scope_idx
  on public.evaluation_runs (company_id, scheme_version_id, period_start, period_end, created_at desc);

create table public.discount_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  scheme_version_id uuid not null,
  scheme_type public.scheme_type not null,
  source_sales_voucher_id uuid,
  period_start date,
  period_end date,
  entitlement_key text not null unique,
  status public.proposal_status not null default 'tracking',
  source_fingerprint text not null,
  last_live_refresh_at timestamptz not null,
  last_manual_change_by uuid,
  last_manual_change_at timestamptz,
  customer_group_id_used uuid,
  eligibility_deadline date,
  eligible_product_taxable_value numeric(19,4) not null default 0,
  eligible_tonnes numeric(20,6) not null default 0,
  achieved_tier_id uuid,
  next_tier_tonnes numeric(20,6),
  additional_tonnes_required numeric(20,6),
  invoice_amount_due numeric(19,4) not null default 0,
  amount_paid_by_deadline numeric(19,4) not null default 0,
  discounted_settlement_target numeric(19,4) not null default 0,
  shortfall_amount numeric(19,4) not null default 0,
  discount_percentage numeric(9,4),
  calculated_discount_amount numeric(19,4) not null default 0,
  posted_discount_amount numeric(19,2),
  reason_codes text[] not null default '{}',
  latest_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (scheme_version_id, company_id, scheme_type)
    references public.scheme_versions (id, company_id, scheme_type) on delete restrict,
  foreign key (source_sales_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict,
  foreign key (customer_group_id_used, company_id)
    references public.customer_groups (id, company_id) on delete restrict,
  check (
    (scheme_type = 'cd'
      and source_sales_voucher_id is not null
      and period_start is null
      and period_end is null)
    or
    (scheme_type = 'tod'
      and source_sales_voucher_id is null
      and period_start is not null
      and period_end is not null)
  ),
  check (period_end is null or period_start is null or period_end >= period_start),
  check (shortfall_amount >= 0),
  check (additional_tonnes_required is null or additional_tonnes_required >= 0)
);

create unique index discount_proposals_cd_entitlement_idx
  on public.discount_proposals (company_id, customer_id, source_sales_voucher_id, scheme_version_id)
  where scheme_type = 'cd';
create unique index discount_proposals_tod_entitlement_idx
  on public.discount_proposals (company_id, customer_id, period_start, period_end, scheme_version_id)
  where scheme_type = 'tod';
create index discount_proposals_review_queue_idx
  on public.discount_proposals (company_id, status, updated_at desc);
create index discount_proposals_customer_idx
  on public.discount_proposals (customer_id, scheme_type, period_start, period_end);

create function public.validate_discount_proposal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scheme_type = 'cd'
     and not exists (
       select 1
       from public.tally_vouchers voucher
       where voucher.id = new.source_sales_voucher_id
         and voucher.company_id = new.company_id
         and voucher.voucher_kind = 'sales'
     ) then
    raise exception 'A CD proposal must reference a Tally sales voucher in the same company';
  end if;

  return new;
end;
$$;

create trigger discount_proposals_validate
  before insert or update of source_sales_voucher_id, scheme_type, company_id
  on public.discount_proposals
  for each row execute function public.validate_discount_proposal();

create table public.proposal_evaluations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  proposal_id uuid not null references public.discount_proposals(id) on delete restrict,
  evaluation_run_id uuid references public.evaluation_runs(id) on delete set null,
  evaluation_number integer not null check (evaluation_number > 0),
  outcome_status public.proposal_status not null,
  source_fingerprint text not null,
  rule_snapshot jsonb not null,
  customer_group_snapshot jsonb not null,
  calendar_snapshot jsonb,
  formula_snapshot jsonb not null,
  eligible_product_taxable_value numeric(19,4) not null default 0,
  eligible_tonnes numeric(20,6) not null default 0,
  invoice_amount_due numeric(19,4) not null default 0,
  amount_paid_by_deadline numeric(19,4) not null default 0,
  discounted_settlement_target numeric(19,4) not null default 0,
  shortfall_amount numeric(19,4) not null default 0,
  discount_percentage numeric(9,4),
  calculated_discount_amount numeric(19,4) not null default 0,
  posted_discount_amount numeric(19,2),
  reason_codes text[] not null default '{}',
  evaluated_by uuid,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (proposal_id, evaluation_number),
  unique (id, proposal_id),
  unique (id, company_id),
  foreign key (proposal_id, company_id)
    references public.discount_proposals (id, company_id) on delete restrict
);

create index proposal_evaluations_proposal_idx
  on public.proposal_evaluations (proposal_id, evaluated_at desc);

create table public.proposal_group_membership_snapshots (
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  customer_group_id uuid not null,
  is_covered_by_rule boolean not null,
  membership_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (proposal_evaluation_id, customer_group_id),
  foreign key (proposal_evaluation_id, company_id)
    references public.proposal_evaluations (id, company_id) on delete cascade,
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (customer_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);

create table public.proposal_working_day_breakdowns (
  proposal_evaluation_id uuid not null references public.proposal_evaluations(id) on delete cascade,
  business_date date not null,
  is_working_day boolean not null,
  counted_working_day integer not null,
  exclusion_reason text,
  is_deadline boolean not null default false,
  primary key (proposal_evaluation_id, business_date)
);

create table public.proposal_source_vouchers (
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_voucher_id uuid not null,
  contribution_type text not null check (contribution_type in ('sale', 'sales_return', 'debit_note', 'prior_period_adjustment', 'payment_evidence', 'existing_credit_note')),
  taxable_value_contribution numeric(19,4) not null default 0,
  tonne_contribution numeric(20,6) not null default 0,
  source_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (proposal_evaluation_id, tally_voucher_id, contribution_type),
  foreign key (proposal_evaluation_id, company_id)
    references public.proposal_evaluations (id, company_id) on delete cascade,
  foreign key (tally_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict
);

create table public.proposal_source_inventory_lines (
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_voucher_inventory_line_id uuid not null,
  tonnes_per_source_unit numeric(20,9),
  eligible_quantity numeric(20,6) not null default 0,
  eligible_tonnes numeric(20,6) not null default 0,
  eligible_taxable_value numeric(19,4) not null default 0,
  contribution_sign smallint not null check (contribution_sign in (-1, 1)),
  blocking_reason text,
  created_at timestamptz not null default now(),
  primary key (proposal_evaluation_id, tally_voucher_inventory_line_id),
  foreign key (proposal_evaluation_id, company_id)
    references public.proposal_evaluations (id, company_id) on delete cascade,
  foreign key (tally_voucher_inventory_line_id, company_id)
    references public.tally_voucher_inventory_lines (id, company_id) on delete restrict
);

create table public.proposal_payment_allocations (
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_bill_allocation_id uuid not null,
  receipt_voucher_date date not null,
  allocated_amount numeric(19,4) not null check (allocated_amount > 0),
  counts_for_cd boolean not null,
  evidence_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (proposal_evaluation_id, tally_bill_allocation_id),
  foreign key (proposal_evaluation_id, company_id)
    references public.proposal_evaluations (id, company_id) on delete cascade,
  foreign key (tally_bill_allocation_id, company_id)
    references public.tally_bill_allocations (id, company_id) on delete restrict
);

create function public.validate_proposal_payment_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.counts_for_cd
     and not exists (
       select 1
       from public.tally_bill_allocations allocation
       join public.tally_vouchers receipt on receipt.id = allocation.source_voucher_id
       where allocation.id = new.tally_bill_allocation_id
         and allocation.company_id = new.company_id
         and allocation.allocation_type = 'agst_ref'
         and receipt.voucher_kind = 'receipt'
         and receipt.status = 'posted'
     ) then
    raise exception 'Only posted receipt Against Reference allocations may count toward CD eligibility';
  end if;
  return new;
end;
$$;

create trigger proposal_payment_allocations_validate
  before insert or update on public.proposal_payment_allocations
  for each row execute function public.validate_proposal_payment_allocation();

create table public.proposal_prior_period_adjustments (
  id uuid primary key default gen_random_uuid(),
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_voucher_id uuid not null,
  original_period_start date not null,
  original_period_end date not null,
  taxable_value_adjustment numeric(19,4) not null,
  tonne_adjustment numeric(20,6) not null,
  reason text not null,
  created_at timestamptz not null default now(),
  foreign key (proposal_evaluation_id, company_id)
    references public.proposal_evaluations (id, company_id) on delete cascade,
  foreign key (tally_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict,
  check (original_period_end >= original_period_start)
);

create table public.processing_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  proposal_id uuid,
  customer_id uuid,
  scheme_version_id uuid,
  tally_voucher_id uuid,
  issue_key text not null unique,
  issue_type text not null check (issue_type in (
    'wrong_tally_company', 'tally_unavailable', 'configured_group_unavailable',
    'ambiguous_group_membership', 'no_active_rule', 'missing_rule_configuration',
    'missing_against_reference', 'ambiguous_payment_allocation',
    'missing_unit_conversion', 'source_changed_after_review',
    'possible_duplicate_credit_note', 'posting_verification_failed', 'other'
  )),
  status public.issue_status not null default 'open',
  details jsonb not null default '{}'::jsonb,
  assigned_to uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (proposal_id, company_id)
    references public.discount_proposals (id, company_id) on delete restrict,
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete restrict,
  foreign key (tally_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict,
  check (
    (resolved_at is null and resolved_by is null)
    or (resolved_at is not null and resolved_by is not null)
  )
);

create index processing_issues_queue_idx
  on public.processing_issues (company_id, status, created_at)
  where status in ('open', 'in_progress');

create table public.proposal_reviews (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.discount_proposals(id) on delete restrict,
  proposal_evaluation_id uuid not null,
  status public.review_status not null default 'pending',
  source_fingerprint text not null,
  review_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (proposal_evaluation_id, proposal_id)
    references public.proposal_evaluations (id, proposal_id) on delete restrict,
  check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewed_at is not null)
  )
);

create unique index proposal_reviews_one_pending_idx
  on public.proposal_reviews (proposal_id)
  where status = 'pending';

create function public.validate_proposal_review()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  proposal_record public.discount_proposals;
begin
  select * into proposal_record
  from public.discount_proposals
  where id = new.proposal_id;

  if not found then
    raise exception 'Proposal does not exist';
  end if;

  if new.source_fingerprint <> proposal_record.source_fingerprint then
    raise exception 'Proposal review must use the most recent live Tally fingerprint';
  end if;

  if not exists (
    select 1
    from public.proposal_evaluations evaluation
    where evaluation.id = new.proposal_evaluation_id
      and evaluation.proposal_id = new.proposal_id
      and evaluation.source_fingerprint = new.source_fingerprint
  ) then
    raise exception 'Proposal review must reference a matching current evaluation snapshot';
  end if;

  if new.status = 'approved'
     and proposal_record.last_manual_change_by = new.reviewed_by
     and proposal_record.last_manual_change_at > proposal_record.last_live_refresh_at then
    raise exception 'A user cannot approve a proposal they changed after its last live Tally refresh';
  end if;

  return new;
end;
$$;

create trigger proposal_reviews_validate
  before insert or update on public.proposal_reviews
  for each row execute function public.validate_proposal_review();

create table public.credit_note_postings (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique,
  proposal_evaluation_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  status public.credit_note_posting_status not null default 'pending_approval',
  idempotency_key text not null unique,
  credit_note_date date not null,
  discount_amount numeric(19,2) not null check (discount_amount > 0),
  calculation_reference text not null,
  credit_note_voucher_type_id uuid not null,
  discount_ledger_id uuid not null,
  bill_allocation_type public.bill_allocation_type not null,
  tally_bill_reference text,
  gst_treatment public.gst_treatment not null default 'commercial_no_gst',
  credit_note_snapshot jsonb not null,
  tally_credit_note_voucher_id uuid,
  verified_tally_guid text,
  verified_voucher_number text,
  verified_amount numeric(19,2),
  verified_at timestamptz,
  verification_snapshot jsonb,
  document_storage_path text,
  failure_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (proposal_id, company_id)
    references public.discount_proposals (id, company_id) on delete restrict,
  foreign key (proposal_evaluation_id, proposal_id)
    references public.proposal_evaluations (id, proposal_id) on delete restrict,
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (credit_note_voucher_type_id, company_id)
    references public.tally_voucher_types (id, company_id) on delete restrict,
  foreign key (discount_ledger_id, company_id)
    references public.tally_ledgers (id, company_id) on delete restrict,
  foreign key (tally_credit_note_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict
);

create index credit_note_postings_status_idx
  on public.credit_note_postings (company_id, status, created_at desc);

create function public.validate_credit_note_posting_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.discount_proposals proposal
    join public.scheme_versions version on version.id = proposal.scheme_version_id
    where proposal.id = new.proposal_id
      and version.credit_note_voucher_type_id = new.credit_note_voucher_type_id
      and version.discount_ledger_id = new.discount_ledger_id
      and version.gst_treatment = new.gst_treatment
  ) then
    raise exception 'Credit Note posting must use the exact voucher type, discount ledger, and GST treatment configured by its rule version';
  end if;

  if exists (
    select 1
    from public.discount_proposals proposal
    where proposal.id = new.proposal_id
      and (
        (proposal.scheme_type = 'tod' and new.bill_allocation_type <> 'new_ref')
        or (proposal.scheme_type = 'cd' and new.bill_allocation_type not in ('agst_ref', 'new_ref'))
      )
  ) then
    raise exception 'TOD Credit Notes use New Ref; CD Credit Notes use Agst Ref or New Ref according to invoice settlement state';
  end if;

  if new.status in ('queued', 'sending', 'verification_pending', 'created_verified')
     and not exists (
       select 1
       from public.proposal_reviews review
       join public.discount_proposals proposal on proposal.id = review.proposal_id
       where review.proposal_id = new.proposal_id
         and review.status = 'approved'
         and review.source_fingerprint = proposal.source_fingerprint
     ) then
    raise exception 'Credit Note posting requires an approved review of the current live Tally evidence';
  end if;

  if new.status = 'created_verified' then
    if new.tally_credit_note_voucher_id is null
       or new.verified_tally_guid is null
       or new.verified_voucher_number is null
       or new.verified_amount is null
       or new.verified_at is null
       or new.verification_snapshot is null then
      raise exception 'A Credit Note cannot be marked created_verified before Tally read-back verification is stored';
    end if;
    if new.verified_amount <> new.discount_amount then
      raise exception 'Verified Tally Credit Note amount must equal the approved posted discount amount';
    end if;
    if not exists (
      select 1
      from public.tally_vouchers voucher
      where voucher.id = new.tally_credit_note_voucher_id
        and voucher.company_id = new.company_id
        and voucher.voucher_kind = 'credit_note'
        and voucher.status = 'posted'
        and voucher.voucher_type_id = new.credit_note_voucher_type_id
        and voucher.party_customer_id = new.customer_id
        and voucher.voucher_date = new.credit_note_date
        and round(voucher.gross_amount, 2) = new.verified_amount
    ) then
      raise exception 'Verified Credit Note must match the expected company, type, party, date, and amount in Tally';
    end if;
  end if;
  return new;
end;
$$;

create trigger credit_note_postings_validate_transition
  before insert or update on public.credit_note_postings
  for each row execute function public.validate_credit_note_posting_transition();

create table public.credit_note_posting_attempts (
  id uuid primary key default gen_random_uuid(),
  credit_note_posting_id uuid not null references public.credit_note_postings(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  command_key text not null unique,
  command_status public.command_status not null default 'queued',
  command_payload jsonb not null,
  connector_response jsonb,
  verification_response jsonb,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_reason text,
  unique (credit_note_posting_id, attempt_number)
);

create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  event_type text not null check (event_type in ('cd_shortfall', 'cd_credit_note_created', 'tod_credit_note_created')),
  provider_template_id text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, event_type, provider_template_id)
);

create table public.notification_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  proposal_id uuid not null,
  credit_note_posting_id uuid,
  customer_contact_id uuid not null,
  whatsapp_template_id uuid not null references public.whatsapp_templates(id) on delete restrict,
  event_type text not null check (event_type in ('cd_shortfall', 'cd_credit_note_created', 'tod_credit_note_created')),
  business_event_key text not null unique,
  resend_of_notification_id uuid references public.notification_messages(id) on delete restrict,
  resend_reason text,
  recipient_phone_e164 text not null,
  payload jsonb not null,
  opt_in_snapshot jsonb not null,
  status public.notification_status not null default 'queued',
  scheduled_for timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failure_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_contact_id, company_id)
    references public.customer_contacts (id, company_id) on delete restrict,
  foreign key (proposal_id, company_id)
    references public.discount_proposals (id, company_id) on delete restrict,
  foreign key (credit_note_posting_id, company_id)
    references public.credit_note_postings (id, company_id) on delete restrict,
  check (
    (resend_of_notification_id is null and resend_reason is null)
    or (resend_of_notification_id is not null and resend_reason is not null)
  )
);

create index notification_messages_queue_idx
  on public.notification_messages (status, scheduled_for, created_at)
  where status in ('queued', 'failed');

create function public.validate_notification_message()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_currently_opted_in boolean;
begin
  if not exists (
    select 1
    from public.companies company
    join public.discount_proposals proposal
      on proposal.id = new.proposal_id and proposal.company_id = company.id
    join public.customer_contacts contact
      on contact.id = new.customer_contact_id
      and contact.company_id = company.id
      and contact.customer_id = proposal.customer_id
      and contact.is_active
    join public.whatsapp_templates template
      on template.id = new.whatsapp_template_id
      and template.organization_id = company.organization_id
      and template.event_type = new.event_type
      and template.is_active
    where company.id = new.company_id
  ) then
    raise exception 'WhatsApp template, recipient contact, and proposal must belong to the same active organization and customer';
  end if;

  select true into is_currently_opted_in
  from public.whatsapp_opt_ins wo
  where wo.customer_contact_id = new.customer_contact_id
    and wo.is_opted_in
    and wo.revoked_at is null;

  if coalesce(is_currently_opted_in, false) = false then
    raise exception 'WhatsApp message requires a recorded current customer opt-in';
  end if;

  if new.event_type in ('cd_credit_note_created', 'tod_credit_note_created') then
    if new.credit_note_posting_id is null
       or not exists (
         select 1 from public.credit_note_postings p
         where p.id = new.credit_note_posting_id
           and p.proposal_id = new.proposal_id
           and p.status = 'created_verified'
       ) then
      raise exception 'Credit Note WhatsApp messages require a verified Tally Credit Note';
    end if;
  end if;

  return new;
end;
$$;

create trigger notification_messages_validate
  before insert or update on public.notification_messages
  for each row execute function public.validate_notification_message();

create table public.notification_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_message_id uuid not null references public.notification_messages(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  provider_message_id text,
  provider_response jsonb,
  status public.notification_status not null,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_reason text,
  unique (notification_message_id, attempt_number)
);

create unique index notification_attempts_provider_message_idx
  on public.notification_attempts (provider_message_id)
  where provider_message_id is not null;

create table public.integration_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null check (event_type in (
    'tally_credit_note_create', 'tally_credit_note_verify', 'tally_credit_note_pdf',
    'msg91_notification_send', 'tally_targeted_refresh'
  )),
  aggregate_type text not null,
  aggregate_id uuid not null,
  payload jsonb not null,
  status public.outbox_status not null default 'pending',
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index integration_outbox_worker_idx
  on public.integration_outbox (available_at, created_at)
  where status in ('pending', 'failed');

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  company_id uuid references public.companies(id) on delete restrict,
  actor_type public.audit_actor_type not null,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  correlation_id uuid,
  previous_value jsonb,
  new_value jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_entity_idx
  on public.audit_events (entity_type, entity_id, created_at desc);
create index audit_events_company_idx
  on public.audit_events (company_id, created_at desc)
  where company_id is not null;

create function public.prevent_scheme_version_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('active', 'retired')
       or exists (select 1 from public.discount_proposals proposal where proposal.scheme_version_id = old.id) then
      raise exception 'Active or evaluated rule versions cannot be deleted';
    end if;
    return old;
  end if;

  if old.status in ('active', 'retired')
     or exists (
       select 1
       from public.discount_proposals proposal
       where proposal.scheme_version_id = old.id
     ) then
    if new.status = 'retired'
       and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
      return new;
    end if;
    raise exception 'Active or evaluated rule versions are immutable; create a new version instead';
  end if;
  return new;
end;
$$;

create function public.assert_scheme_version_child_mutable()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_scheme_version_id uuid;
begin
  if tg_op = 'DELETE' then
    v_scheme_version_id := old.scheme_version_id;
  else
    v_scheme_version_id := new.scheme_version_id;
  end if;

  if exists (
    select 1
    from public.scheme_versions version
    where version.id = v_scheme_version_id
      and (
        version.status in ('active', 'retired')
        or exists (
          select 1 from public.discount_proposals proposal
          where proposal.scheme_version_id = version.id
        )
      )
  ) then
    raise exception 'Rule version configuration is immutable after activation or evaluation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger scheme_versions_immutable
  before update or delete on public.scheme_versions
  for each row execute function public.prevent_scheme_version_mutation();
create trigger scheme_version_customer_groups_immutable
  before insert or update or delete on public.scheme_version_customer_groups
  for each row execute function public.assert_scheme_version_child_mutable();
create trigger scheme_version_stock_items_immutable
  before insert or update or delete on public.scheme_version_stock_items
  for each row execute function public.assert_scheme_version_child_mutable();
create trigger scheme_version_stock_groups_immutable
  before insert or update or delete on public.scheme_version_stock_groups
  for each row execute function public.assert_scheme_version_child_mutable();
create trigger scheme_version_unit_conversions_immutable
  before insert or update or delete on public.scheme_version_unit_conversions
  for each row execute function public.assert_scheme_version_child_mutable();
create trigger scheme_version_tiers_immutable
  before insert or update or delete on public.scheme_version_tiers
  for each row execute function public.assert_scheme_version_child_mutable();

create function public.prevent_snapshot_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Calculation and audit snapshots are append-only';
end;
$$;

create trigger proposal_evaluations_immutable
  before update or delete on public.proposal_evaluations
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_group_membership_snapshots_immutable
  before update or delete on public.proposal_group_membership_snapshots
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_working_day_breakdowns_immutable
  before update or delete on public.proposal_working_day_breakdowns
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_source_vouchers_immutable
  before update or delete on public.proposal_source_vouchers
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_source_inventory_lines_immutable
  before update or delete on public.proposal_source_inventory_lines
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_payment_allocations_immutable
  before update or delete on public.proposal_payment_allocations
  for each row execute function public.prevent_snapshot_mutation();
create trigger proposal_prior_period_adjustments_immutable
  before update or delete on public.proposal_prior_period_adjustments
  for each row execute function public.prevent_snapshot_mutation();
create trigger audit_events_immutable
  before update or delete on public.audit_events
  for each row execute function public.prevent_snapshot_mutation();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, phone_e164)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', new.email),
    nullif(new.phone, '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create function public.has_organization_role(
  p_organization_id uuid,
  p_required_role public.organization_role
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.profile_id = auth.uid()
      and membership.role = p_required_role
  );
$$;

revoke all on function public.has_organization_role(uuid, public.organization_role) from public;
grant execute on function public.has_organization_role(uuid, public.organization_role) to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations', 'organization_features', 'profiles', 'organization_memberships',
    'companies', 'tally_sync_runs', 'customer_groups', 'tally_units', 'stock_groups',
    'stock_items', 'tally_ledgers', 'tally_voucher_types', 'customers', 'customer_contacts',
    'whatsapp_opt_ins', 'tally_vouchers', 'tally_voucher_inventory_lines',
    'tally_bill_allocations', 'tally_bill_reference_snapshots', 'working_calendars',
    'working_calendar_non_working_weekdays', 'working_calendar_holidays', 'schemes',
    'scheme_versions', 'scheme_version_customer_groups', 'scheme_version_group_coverage',
    'scheme_version_stock_items', 'scheme_version_stock_groups', 'scheme_version_unit_conversions',
    'scheme_version_tiers', 'evaluation_runs', 'discount_proposals', 'proposal_evaluations',
    'proposal_group_membership_snapshots', 'proposal_working_day_breakdowns',
    'proposal_source_vouchers', 'proposal_source_inventory_lines', 'proposal_payment_allocations',
    'proposal_prior_period_adjustments', 'processing_issues', 'proposal_reviews',
    'credit_note_postings', 'credit_note_posting_attempts', 'whatsapp_templates',
    'notification_messages', 'notification_attempts', 'integration_outbox', 'audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end;
$$;

create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy organization_memberships_select_own
  on public.organization_memberships for select to authenticated
  using (profile_id = auth.uid());

grant select on public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name, phone_e164) on public.profiles to authenticated;
grant select on public.organization_memberships to authenticated;
revoke all on table public.audit_events from anon, authenticated;

create trigger evaluation_runs_set_updated_at before update on public.evaluation_runs
  for each row execute function public.set_updated_at();
create trigger discount_proposals_set_updated_at before update on public.discount_proposals
  for each row execute function public.set_updated_at();
create trigger processing_issues_set_updated_at before update on public.processing_issues
  for each row execute function public.set_updated_at();
create trigger credit_note_postings_set_updated_at before update on public.credit_note_postings
  for each row execute function public.set_updated_at();
create trigger whatsapp_templates_set_updated_at before update on public.whatsapp_templates
  for each row execute function public.set_updated_at();
create trigger notification_messages_set_updated_at before update on public.notification_messages
  for each row execute function public.set_updated_at();
create trigger integration_outbox_set_updated_at before update on public.integration_outbox
  for each row execute function public.set_updated_at();

comment on table public.proposal_evaluations is
  'Immutable calculation snapshots: formula, source Tally evidence, group membership, calendar, and rule version.';
comment on table public.credit_note_postings is
  'A financial/commercial, no-GST Credit Note becomes created only after Tally read-back verification.';
comment on table public.notification_messages is
  'MSG91 business events. Credit Note notices require both verified Tally posting and customer opt-in.';
