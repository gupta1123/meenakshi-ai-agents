-- Current Cash Discount recovery actions and idempotent Debit Note posting.
-- This migration is intentionally created for manual application.
-- Raw Tally masters, invoices, receipts, and bridge responses are not stored.

create table public.cash_discount_recovery_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  rule_version_id uuid not null references public.scheme_versions(id) on delete restrict,
  source_run_id uuid not null references public.evaluation_runs(id) on delete restrict,
  source_fingerprint text not null,
  evaluated_on date not null,
  customer_tally_guid text not null,
  customer_name text not null,
  invoice_tally_guid text not null,
  invoice_number text,
  invoice_date date not null,
  bill_reference text not null,
  net_invoice_amount numeric(19,4) not null check (net_invoice_amount > 0),
  implied_gross_amount numeric(19,4) not null check (implied_gross_amount >= net_invoice_amount),
  amount_paid numeric(19,4) not null check (amount_paid >= 0),
  granted_discount_percentage numeric(9,4) not null check (granted_discount_percentage > 0 and granted_discount_percentage < 100),
  earned_discount_percentage numeric(9,4) not null check (earned_discount_percentage >= 0 and earned_discount_percentage < 100),
  recovery_required numeric(19,4) not null check (recovery_required >= 0),
  already_recovered numeric(19,4) not null check (already_recovered >= 0),
  remaining_recovery numeric(19,4) not null check (remaining_recovery >= 0),
  missed_window_working_days integer not null check (missed_window_working_days > 0),
  missed_window_deadline date not null,
  next_window_working_days integer,
  next_window_percentage numeric(9,4),
  status text not null check (status in ('action_required', 'review_required', 'posting', 'posted')),
  reason_code text not null,
  review_message text,
  narration_checked boolean not null default false,
  narration_mentioned boolean not null default false,
  narration_matches boolean not null default false,
  debit_note_references jsonb not null default '[]'::jsonb check (jsonb_typeof(debit_note_references) = 'array'),
  current_snapshot boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create unique index cash_discount_recovery_current_invoice_idx
  on public.cash_discount_recovery_candidates(company_id, invoice_tally_guid)
  where current_snapshot;
create index cash_discount_recovery_current_status_idx
  on public.cash_discount_recovery_candidates(company_id, status, updated_at desc)
  where current_snapshot;

create table public.cash_discount_debit_note_postings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  candidate_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'created_verified', 'failed', 'cancelled')),
  idempotency_key text not null,
  debit_note_date date not null,
  amount numeric(19,4) not null check (amount > 0),
  calculation_reference text not null,
  debit_note_voucher_type_id uuid not null,
  recovery_ledger_id uuid not null,
  debit_note_snapshot jsonb not null,
  verified_tally_guid text,
  verified_voucher_number text,
  verified_amount numeric(19,4),
  verified_at timestamptz,
  failure_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, idempotency_key),
  unique (id, company_id),
  foreign key (candidate_id, company_id) references public.cash_discount_recovery_candidates(id, company_id) on delete restrict,
  foreign key (debit_note_voucher_type_id, company_id) references public.tally_voucher_types(id, company_id) on delete restrict,
  foreign key (recovery_ledger_id, company_id) references public.tally_ledgers(id, company_id) on delete restrict
);

create index cash_discount_debit_note_posting_status_idx
  on public.cash_discount_debit_note_postings(company_id, status, created_at desc);

create trigger cash_discount_recovery_candidates_set_updated_at
  before update on public.cash_discount_recovery_candidates
  for each row execute function public.set_updated_at();
create trigger cash_discount_debit_note_postings_set_updated_at
  before update on public.cash_discount_debit_note_postings
  for each row execute function public.set_updated_at();

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
  if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' then raise exception 'Cash Discount candidates must be a JSON array'; end if;
  if not exists (select 1 from public.evaluation_runs run where run.id = p_evaluation_run_id and run.company_id = p_company_id) then raise exception 'Cash Discount run is unavailable'; end if;
  if not exists (select 1 from public.scheme_versions version where version.id = p_rule_version_id and version.company_id = p_company_id and version.scheme_type = 'cd') then raise exception 'Cash Discount rule is unavailable'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':cd-snapshot', 0));
  update public.cash_discount_recovery_candidates set current_snapshot = false where company_id = p_company_id and current_snapshot;
  delete from public.cash_discount_recovery_candidates candidate
  where candidate.company_id = p_company_id and not candidate.current_snapshot
    and not exists (select 1 from public.cash_discount_debit_note_postings posting where posting.candidate_id = candidate.id);

  insert into public.cash_discount_recovery_candidates (
    company_id, rule_version_id, source_run_id, source_fingerprint, evaluated_on,
    customer_tally_guid, customer_name, invoice_tally_guid, invoice_number, invoice_date, bill_reference,
    net_invoice_amount, implied_gross_amount, amount_paid, granted_discount_percentage,
    earned_discount_percentage, recovery_required, already_recovered, remaining_recovery,
    missed_window_working_days, missed_window_deadline, next_window_working_days,
    next_window_percentage, status, reason_code, review_message, narration_checked,
    narration_mentioned, narration_matches, debit_note_references
  )
  select p_company_id, p_rule_version_id, p_evaluation_run_id, p_source_fingerprint,
    (item ->> 'evaluatedOn')::date,
    item ->> 'customerTallyGuid', item ->> 'customerName', item ->> 'invoiceTallyGuid',
    nullif(item ->> 'invoiceNumber', ''), (item ->> 'invoiceDate')::date, item ->> 'billReference',
    (item ->> 'netInvoiceAmount')::numeric, (item ->> 'impliedGrossAmount')::numeric,
    (item ->> 'amountPaid')::numeric, (item ->> 'grantedDiscountPercentage')::numeric,
    (item ->> 'earnedDiscountPercentage')::numeric, (item ->> 'recoveryRequired')::numeric,
    (item ->> 'alreadyRecovered')::numeric, (item ->> 'remainingRecovery')::numeric,
    (item ->> 'missedWindowWorkingDays')::integer, (item ->> 'missedWindowDeadline')::date,
    nullif(item ->> 'nextWindowWorkingDays', '')::integer, nullif(item ->> 'nextWindowPercentage', '')::numeric,
    item ->> 'status', item ->> 'reasonCode', nullif(item ->> 'reviewMessage', ''),
    coalesce((item #>> '{narration,checked}')::boolean, false),
    coalesce((item #>> '{narration,mentioned}')::boolean, false),
    coalesce((item #>> '{narration,matches}')::boolean, false),
    coalesce(item -> 'debitNoteReferences', '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) item;
  get diagnostics inserted_count = row_count;

  update public.evaluation_runs
  set status = 'completed', scheme_version_id = p_rule_version_id, period_start = p_period_start,
      period_end = p_period_end, source_fingerprint = p_source_fingerprint,
      summary = coalesce(p_summary, '{}'::jsonb), error_summary = null, completed_at = now(),
      locked_at = null, locked_by = null, lease_expires_at = null, updated_at = now()
  where id = p_evaluation_run_id and company_id = p_company_id;
  return inserted_count;
end;
$$;

create or replace function public.meenakshi_debit_note_command_payload(p_posting_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare posting public.cash_discount_debit_note_postings;
begin
  select * into posting from public.cash_discount_debit_note_postings where id = p_posting_id;
  if not found then raise exception 'Cash Discount Debit Note posting not found'; end if;
  return jsonb_build_object(
    'debitNotePostingId', posting.id,
    'businessIdempotencyKey', posting.idempotency_key,
    'debitNote', posting.debit_note_snapshot
  );
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
  settings public.company_credit_note_accounting_settings;
  voucher_type public.tally_voucher_types;
  recovery_ledger public.tally_ledgers;
  posting public.cash_discount_debit_note_postings;
  reference text;
begin
  if coalesce(length(btrim(p_idempotency_key)), 0) = 0 then raise exception 'An idempotency key is required'; end if;
  select * into posting from public.cash_discount_debit_note_postings where company_id = p_company_id and idempotency_key = p_idempotency_key;
  if found then return posting; end if;
  select * into candidate from public.cash_discount_recovery_candidates where id = p_candidate_id and company_id = p_company_id and current_snapshot for update;
  if not found then raise exception 'This recovery is no longer current. Run Cash Discount again.'; end if;
  if candidate.status <> 'action_required' or candidate.remaining_recovery <= 0 then raise exception 'This recovery is not ready for a Debit Note'; end if;
  select * into company from public.companies where id = p_company_id;
  select * into settings from public.company_credit_note_accounting_settings where company_id = p_company_id;
  if settings.cash_discount_debit_note_voucher_type_id is null or settings.cash_discount_recovery_ledger_id is null then raise exception 'Configure the Cash Discount Debit Note type and recovery ledger first'; end if;
  select * into voucher_type from public.tally_voucher_types where id = settings.cash_discount_debit_note_voucher_type_id and company_id = p_company_id and is_available;
  select * into recovery_ledger from public.tally_ledgers where id = settings.cash_discount_recovery_ledger_id and company_id = p_company_id and is_available;
  if voucher_type.id is null or recovery_ledger.id is null then raise exception 'The configured Debit Note masters are not available in Tally'; end if;
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
      'debitNoteDate', current_date, 'amount', candidate.remaining_recovery::text,
      'calculationReference', reference,
      'allocation', jsonb_build_object('type', 'agst_ref', 'reference', candidate.bill_reference),
      'sourceInvoice', jsonb_build_object('guid', candidate.invoice_tally_guid, 'number', candidate.invoice_number)
    ), p_actor_id
  ) returning * into posting;
  update public.cash_discount_recovery_candidates set status = 'posting' where id = candidate.id;
  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload, organization_id,
    company_id, correlation_id, idempotency_key, max_attempts
  ) values (
    'cd-debit-note:' || posting.id::text, 'tally_debit_note_create', 'cash_discount_debit_note_posting', posting.id,
    jsonb_build_object('debitNotePostingId', posting.id), company.organization_id,
    company.id, gen_random_uuid(), 'cd-debit-note:' || posting.id::text, 1
  );
  return posting;
end;
$$;

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
begin
  select * into posting from public.cash_discount_debit_note_postings where id = p_posting_id for update;
  if not found then raise exception 'Cash Discount Debit Note posting not found'; end if;
  if p_failure_reason is null then
    if nullif(p_result ->> 'tallyGuid', '') is null then raise exception 'Verified Debit Note GUID is required'; end if;
    result_amount := nullif(p_result ->> 'amount', '')::numeric;
    if result_amount is null or abs(result_amount - posting.amount) > 0.01 then
      raise exception 'Verified Debit Note amount does not match the approved recovery';
    end if;
  end if;
  update public.cash_discount_debit_note_postings
  set status = case when p_failure_reason is null then 'created_verified' else 'failed' end,
      verified_tally_guid = case when p_failure_reason is null then p_result ->> 'tallyGuid' else null end,
      verified_voucher_number = case when p_failure_reason is null then p_result ->> 'voucherNumber' else null end,
      verified_amount = case when p_failure_reason is null then nullif(p_result ->> 'amount', '')::numeric else null end,
      verified_at = case when p_failure_reason is null then now() else null end,
      failure_reason = p_failure_reason
  where id = p_posting_id returning * into posting;
  update public.cash_discount_recovery_candidates
  set status = case when p_failure_reason is null then 'posted' else 'action_required' end,
      already_recovered = case when p_failure_reason is null then recovery_required else already_recovered end,
      remaining_recovery = case when p_failure_reason is null then 0 else remaining_recovery end
  where id = posting.candidate_id;
  return posting;
end;
$$;

alter table public.integration_outbox drop constraint if exists integration_outbox_event_type_check;
alter table public.integration_outbox add constraint integration_outbox_event_type_check check (event_type in (
  'tally_credit_note_create', 'tally_credit_note_verify', 'tally_credit_note_pdf',
  'tally_debit_note_create', 'msg91_notification_send', 'tally_targeted_refresh',
  'tally_masters_sync', 'tally_vouchers_sync'
));
alter table public.tally_commands drop constraint if exists tally_commands_command_type_check;
alter table public.tally_commands add constraint tally_commands_command_type_check check (command_type in (
  'sync_meenakshi_masters', 'sync_meenakshi_vouchers', 'fetch_meenakshi_evidence',
  'create_credit_note', 'verify_credit_note', 'export_credit_note_pdf', 'create_debit_note'
));

create or replace function public.claim_tally_integration_outbox(p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 60)
returns setof public.integration_outbox language sql set search_path = '' as $$
  with candidates as (
    select outbox.id from public.integration_outbox outbox
    where outbox.event_type in ('tally_credit_note_create','tally_credit_note_verify','tally_credit_note_pdf','tally_debit_note_create','tally_targeted_refresh','tally_masters_sync','tally_vouchers_sync')
      and outbox.attempts < outbox.max_attempts
      and ((outbox.status in ('pending','failed') and outbox.available_at <= now()) or (outbox.status = 'processing' and outbox.lease_expires_at < now()))
    order by outbox.available_at, outbox.created_at for update skip locked limit greatest(1, least(p_limit, 100))
  )
  update public.integration_outbox outbox set status='processing', locked_at=now(), locked_by=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(10,p_lease_seconds)), attempts=outbox.attempts+1, updated_at=now()
  from candidates where outbox.id=candidates.id returning outbox.*;
$$;

create or replace function public.dispatch_outbox_to_tally_command(p_outbox_id uuid, p_connector_id uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  outbox_record public.integration_outbox; company_record public.companies; command_id uuid;
  mapped_command_type text; command_payload jsonb; posting_id uuid; expected_company_guid text; expected_company_name text;
begin
  select * into outbox_record from public.integration_outbox outbox where outbox.id=p_outbox_id and outbox.status='processing' for update;
  if not found then raise exception 'Outbox event must be claimed before dispatch'; end if;
  select * into company_record from public.companies company where company.id=outbox_record.company_id;
  if not exists (select 1 from public.tally_connector_company_bindings binding join public.tally_connectors connector on connector.id=binding.connector_id
    where binding.connector_id=p_connector_id and binding.company_id=outbox_record.company_id and binding.organization_id=outbox_record.organization_id and binding.is_active and connector.status='paired')
  then raise exception 'No active paired connector is bound to the outbox company'; end if;
  mapped_command_type := case outbox_record.event_type
    when 'tally_masters_sync' then 'sync_meenakshi_masters' when 'tally_vouchers_sync' then 'sync_meenakshi_vouchers'
    when 'tally_credit_note_create' then 'create_credit_note' when 'tally_credit_note_verify' then 'verify_credit_note'
    when 'tally_credit_note_pdf' then 'export_credit_note_pdf' when 'tally_debit_note_create' then 'create_debit_note'
    when 'tally_targeted_refresh' then 'fetch_meenakshi_evidence' else null end;
  if mapped_command_type is null then raise exception 'Outbox event % is not a Tally command',outbox_record.event_type; end if;
  if mapped_command_type='create_debit_note' then
    posting_id := nullif(outbox_record.payload->>'debitNotePostingId','')::uuid;
    command_payload := public.meenakshi_debit_note_command_payload(posting_id);
  elsif mapped_command_type in ('create_credit_note','verify_credit_note','export_credit_note_pdf') then
    posting_id := nullif(outbox_record.payload->>'creditNotePostingId','')::uuid;
    command_payload := public.meenakshi_credit_note_command_payload(posting_id);
  else command_payload := outbox_record.payload; end if;
  expected_company_guid := coalesce(command_payload #>> '{debitNote,company,guid}', command_payload #>> '{creditNote,company,guid}', company_record.tally_company_guid);
  expected_company_name := coalesce(command_payload #>> '{debitNote,company,name}', command_payload #>> '{creditNote,company,name}', company_record.tally_company_name);
  insert into public.tally_commands(organization_id,company_id,connector_id,source_outbox_id,command_type,business_idempotency_key,correlation_id,expected_tally_company_guid,expected_tally_company_name,payload)
  values(outbox_record.organization_id,outbox_record.company_id,p_connector_id,outbox_record.id,mapped_command_type,outbox_record.idempotency_key,outbox_record.correlation_id,expected_company_guid,expected_company_name,command_payload)
  on conflict(company_id,business_idempotency_key) do update set updated_at=excluded.updated_at returning id into command_id;
  if mapped_command_type='create_debit_note' then update public.cash_discount_debit_note_postings set status='sending',failure_reason=null where id=posting_id and status='queued'; end if;
  if mapped_command_type='create_credit_note' then
    update public.credit_note_postings set status='sending',updated_at=now(),failure_reason=null where id=posting_id and status='queued';
    insert into public.credit_note_posting_attempts(credit_note_posting_id,attempt_number,command_key,command_status,command_payload)
    values(posting_id,coalesce((select max(attempt_number)+1 from public.credit_note_posting_attempts where credit_note_posting_id=posting_id),1),outbox_record.idempotency_key,'sending',command_payload)
    on conflict(command_key) do nothing;
  end if;
  update public.integration_outbox set status='completed',completed_at=now(),locked_at=null,locked_by=null,lease_expires_at=null where id=outbox_record.id;
  return command_id;
end;
$$;

alter table public.cash_discount_recovery_candidates enable row level security;
alter table public.cash_discount_debit_note_postings enable row level security;
revoke all on table public.cash_discount_recovery_candidates, public.cash_discount_debit_note_postings from anon, authenticated;
grant all on table public.cash_discount_recovery_candidates, public.cash_discount_debit_note_postings to service_role;
revoke execute on function public.replace_meenakshi_cd_recovery_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.meenakshi_debit_note_command_payload(uuid) from public, anon, authenticated;
revoke execute on function public.enqueue_meenakshi_cd_debit_note(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.record_meenakshi_debit_note_result(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.replace_meenakshi_cd_recovery_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb) to service_role;
grant execute on function public.meenakshi_debit_note_command_payload(uuid) to service_role;
grant execute on function public.enqueue_meenakshi_cd_debit_note(uuid,uuid,uuid,text) to service_role;
grant execute on function public.record_meenakshi_debit_note_result(uuid,jsonb,text) to service_role;
