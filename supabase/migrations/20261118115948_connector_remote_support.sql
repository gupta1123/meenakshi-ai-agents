-- Dedicated support operations never ingest vouchers or replace calculation snapshots.
alter table public.tally_connectors add column if not exists runtime jsonb not null default '{}'::jsonb;

create table public.tally_support_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  company_id uuid not null references public.companies(id),
  connector_id uuid not null references public.tally_connectors(id),
  requested_by uuid references public.profiles(id) on delete set null,
  operation text not null check(operation in ('diagnostic','recalculate','update','logs')),
  request jsonb not null,
  request_key text not null,
  status text not null default 'queued' check(status in ('queued','running','received','succeeded','failed','cancelled','interrupted')),
  attempts integer not null default 0,
  cancel_requested boolean not null default false,
  lease_expires_at timestamptz,
  result jsonb,
  progress jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(company_id,request_key)
);
create index tally_support_jobs_queue on public.tally_support_jobs(connector_id,created_at) where status='queued';
create index tally_support_jobs_history on public.tally_support_jobs(company_id,created_at desc);
alter table public.tally_support_jobs enable row level security;
revoke all on public.tally_support_jobs from public,anon,authenticated;
grant all on public.tally_support_jobs to service_role;

create function public.claim_tally_support_job(p_connector_id uuid)
returns setof public.tally_support_jobs language plpgsql set search_path='' as $$
begin
  perform 1 from public.tally_connectors where id=p_connector_id for update;
  -- A diagnostic has one attempt. A crashed read is visible, never automatically replayed.
  update public.tally_support_jobs set status='interrupted',error='Connector stopped before this operation finished. Start a new check.',
    finished_at=now(),lease_expires_at=null where connector_id=p_connector_id and status='running' and lease_expires_at<=now();
  if exists(select 1 from public.tally_support_jobs where connector_id=p_connector_id and status='running')
    or exists(select 1 from public.tally_check_jobs where connector_id=p_connector_id and status='running' and lease_expires_at>now())
    or exists(select 1 from public.tally_commands where connector_id=p_connector_id and status in ('sending','accepted') and lease_expires_at>now()) then return; end if;
  return query update public.tally_support_jobs set status='running',attempts=attempts+1,
    started_at=now(),lease_expires_at=now()+interval '90 seconds'
    where id=(select j.id from public.tally_support_jobs j
      join public.tally_connector_company_bindings b on b.company_id=j.company_id and b.connector_id=j.connector_id and b.is_active
      where j.connector_id=p_connector_id and j.status='queued' and not j.cancel_requested
      order by j.created_at for update of j skip locked limit 1)
    returning *;
end $$;

create function public.interrupt_connector_work(p_connector_id uuid)
returns void language plpgsql set search_path='' as $$
begin
  perform 1 from public.tally_connectors where id=p_connector_id for update;
  update public.tally_check_jobs set status='cancelled',cancel_requested=true,
    failure_reason='Interrupted by connector update. Run the check again.',finished_at=now(),updated_at=now(),
    locked_by=null,lease_expires_at=null
    where connector_id=p_connector_id and status in ('queued','running');
  -- A financial create is never automatically replayed after an update interrupted it.
  update public.tally_commands set status='dead_letter',failure_reason='Interrupted by connector update. Verify Tally before retrying a financial posting.',
    completed_at=now(),locked_by=null,lease_expires_at=null
    where connector_id=p_connector_id and status in ('sending','accepted');
end $$;
revoke all on function public.claim_tally_support_job(uuid) from public,anon,authenticated;
revoke all on function public.interrupt_connector_work(uuid) from public,anon,authenticated;
grant execute on function public.claim_tally_support_job(uuid) to service_role;
grant execute on function public.interrupt_connector_work(uuid) to service_role;

create or replace function public.replace_meenakshi_cd_settlement_snapshot_scoped(
  p_company_id uuid,
  p_evaluation_run_id uuid,
  p_rule_version_id uuid,
  p_source_fingerprint text,
  p_period_start date,
  p_period_end date,
  p_candidates jsonb,
  p_summary jsonb,
  p_customer_tally_guids text[]
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if coalesce(cardinality(p_customer_tally_guids),0)=0 then raise exception 'A partial refresh requires its customer scope'; end if;
  if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' then
    raise exception 'Cash Discount candidates must be a JSON array';
  end if;
  if not exists (select 1 from public.evaluation_runs run where run.id = p_evaluation_run_id and run.company_id = p_company_id) then
    raise exception 'Cash Discount run is unavailable';
  end if;
  if not exists (
    select 1 from public.scheme_versions version
    where version.id = p_rule_version_id and version.company_id = p_company_id
      and version.scheme_type = 'cd' and version.cd_discount_basis = 'amount_per_tonne'
  ) then
    raise exception 'Per-MT Cash Discount rule is unavailable';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':cd-snapshot', 0));
  update public.cash_discount_recovery_candidates set current_snapshot = false
  where company_id = p_company_id and current_snapshot and customer_tally_guid=any(p_customer_tally_guids);
  delete from public.cash_discount_recovery_candidates candidate
  where candidate.company_id = p_company_id and not candidate.current_snapshot
    and not exists (select 1 from public.cash_discount_debit_note_postings posting where posting.candidate_id = candidate.id);

  -- Settlement rows reuse the recovery columns: remaining_recovery = the Credit
  -- Note amount; missed_window_* = the segment's window; implied gross = invoice.
  insert into public.cash_discount_recovery_candidates (
    company_id, rule_version_id, source_run_id, source_fingerprint, evaluated_on,
    customer_tally_guid, customer_name, source_sales_ledger_name, invoice_tally_guid,
    invoice_number, invoice_date, bill_reference, net_invoice_amount, implied_gross_amount,
    amount_paid, granted_discount_percentage, earned_discount_percentage, recovery_required,
    already_recovered, remaining_recovery, missed_window_working_days, missed_window_deadline,
    next_window_working_days, next_window_percentage, status, reason_code, review_message,
    debit_note_references, candidate_kind, settlement_category, eligible_tonnes,
    amount_per_tonne, discount_amount, segment_label
  )
  select
    p_company_id, p_rule_version_id, p_evaluation_run_id, p_source_fingerprint,
    (item ->> 'evaluatedOn')::date, item ->> 'customerTallyGuid', item ->> 'customerName',
    nullif(item ->> 'sourceSalesLedgerName', ''), item ->> 'invoiceTallyGuid',
    nullif(item ->> 'invoiceNumber', ''), (item ->> 'invoiceDate')::date, item ->> 'billReference',
    (item ->> 'invoiceAmount')::numeric, (item ->> 'invoiceAmount')::numeric,
    (item ->> 'paidByDeadline')::numeric,
    least(greatest(round((item ->> 'discountAmount')::numeric * 100 / (item ->> 'invoiceAmount')::numeric, 4), 0.0001), 99.9999),
    0, (item ->> 'discountAmount')::numeric,
    coalesce((item ->> 'alreadyCredited')::numeric, 0), (item ->> 'creditAmount')::numeric,
    (item ->> 'windowWorkingDays')::integer, (item ->> 'windowDeadline')::date,
    null, null, item ->> 'status', item ->> 'category', nullif(item ->> 'reviewMessage', ''),
    coalesce(item -> 'creditNoteReferences', '[]'::jsonb), 'settlement', item ->> 'category',
    (item ->> 'eligibleTonnes')::numeric, (item ->> 'amountPerTonne')::numeric,
    (item ->> 'discountAmount')::numeric, nullif(item ->> 'segmentLabel', '')
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
revoke all on function public.replace_meenakshi_cd_settlement_snapshot_scoped(uuid,uuid,uuid,text,date,date,jsonb,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.replace_meenakshi_cd_settlement_snapshot_scoped(uuid,uuid,uuid,text,date,date,jsonb,jsonb,text[]) to service_role;
