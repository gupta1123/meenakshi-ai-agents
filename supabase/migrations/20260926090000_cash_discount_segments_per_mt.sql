-- Cash Discount v2 (docs/CD_LOGIC.md): one active rule divided into segments.
-- Each segment = one or more Tally customer groups + a window in working days
-- + a discount in ₹ per MT. A group (with its sub-groups) may belong to only
-- one segment of a rule. Existing percentage rules keep working unchanged.
--
-- Supersedes 20260925150000_allow_parallel_cash_discount_rules.sql, which must
-- NOT be run: one rule with exclusive segments replaces parallel CD rules.

-- 1. How a Cash Discount rule computes its discount.
alter table public.scheme_versions
  add column if not exists cd_discount_basis text not null default 'percentage_of_bill';

alter table public.scheme_versions
  drop constraint if exists scheme_versions_cd_discount_basis_check;
alter table public.scheme_versions
  add constraint scheme_versions_cd_discount_basis_check
  check (cd_discount_basis in ('percentage_of_bill', 'amount_per_tonne'));

-- 2. Per-MT CD rules carry days and rate on their segments, not on the version.
--    Replace the original (unnamed) scheme-type check to allow that.
do $$
declare
  v_constraint text;
begin
  select con.conname into v_constraint
  from pg_constraint con
  where con.conrelid = 'public.scheme_versions'::regclass
    and con.contype = 'c'
    and con.conname <> 'scheme_versions_scheme_type_settings_check'
    -- Postgres stores the literal as "(80)::numeric", so match on the column names.
    and pg_get_constraintdef(con.oid) like '%scheme_type%'
    and pg_get_constraintdef(con.oid) like '%near_eligibility_percent%'
    and pg_get_constraintdef(con.oid) like '%period_anchor_date%'
  limit 1;
  if v_constraint is null and exists (
    select 1 from pg_constraint
    where conrelid = 'public.scheme_versions'::regclass and conname = 'scheme_versions_scheme_type_settings_check'
  ) then
    -- Already replaced by an earlier run of this migration.
    return;
  end if;
  if v_constraint is null then
    raise exception 'scheme_versions scheme-type check was not found';
  end if;
  execute format('alter table public.scheme_versions drop constraint %I', v_constraint);
end;
$$;

alter table public.scheme_versions
  drop constraint if exists scheme_versions_scheme_type_settings_check;
alter table public.scheme_versions
  add constraint scheme_versions_scheme_type_settings_check check (
    (scheme_type = 'cd'
      and cd_discount_basis = 'percentage_of_bill'
      and discount_percentage is not null
      and discount_percentage > 0
      and discount_percentage <= 100
      and working_calendar_id is not null
      and allowed_working_days is not null
      and allowed_working_days >= 0
      and near_eligibility_percent = 80
      and period_months is null
      and period_anchor_date is null)
    or
    (scheme_type = 'cd'
      and cd_discount_basis = 'amount_per_tonne'
      and discount_percentage is null
      and working_calendar_id is not null
      and allowed_working_days is null
      and near_eligibility_percent = 80
      and period_months is null
      and period_anchor_date is null)
    or
    (scheme_type = 'tod'
      and discount_percentage is null
      and working_calendar_id is null
      and allowed_working_days is null
      and near_eligibility_percent is null
      and period_months is not null
      and period_months >= 1
      and period_anchor_date is not null)
  );

-- 3. Segments.
create table if not exists public.scheme_version_cd_segments (
  id uuid primary key default gen_random_uuid(),
  scheme_version_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  label text not null check (length(btrim(label)) between 1 and 80),
  allowed_working_days smallint not null check (allowed_working_days between 1 and 60),
  amount_per_tonne numeric(12,2) not null check (amount_per_tonne > 0),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (id, scheme_version_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade
);
create index if not exists scheme_version_cd_segments_version_idx
  on public.scheme_version_cd_segments (scheme_version_id, sort_order);

-- A directly selected group can appear in only one segment of a version (PK).
-- Sub-group overlap between segments is checked at validation (section 5).
create table if not exists public.scheme_version_cd_segment_groups (
  scheme_version_id uuid not null,
  segment_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_group_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (scheme_version_id, customer_group_id),
  foreign key (segment_id, scheme_version_id)
    references public.scheme_version_cd_segments (id, scheme_version_id) on delete cascade,
  foreign key (customer_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);
create index if not exists scheme_version_cd_segment_groups_segment_idx
  on public.scheme_version_cd_segment_groups (segment_id);

alter table public.scheme_version_cd_segments enable row level security;
alter table public.scheme_version_cd_segment_groups enable row level security;
revoke all on public.scheme_version_cd_segments from anon, authenticated;
revoke all on public.scheme_version_cd_segment_groups from anon, authenticated;

-- 4. Keep the rule's customer groups = the union of its segment groups, so the
--    existing coverage refresh and cross-rule overlap check keep working.
create or replace function public.sync_cd_segment_group_to_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id, include_descendants)
    values (new.scheme_version_id, new.company_id, new.customer_group_id, true)
    on conflict do nothing;
    return new;
  end if;
  delete from public.scheme_version_customer_groups
  where scheme_version_id = old.scheme_version_id
    and customer_group_id = old.customer_group_id;
  return old;
end;
$$;

drop trigger if exists scheme_version_cd_segment_groups_sync on public.scheme_version_cd_segment_groups;
create trigger scheme_version_cd_segment_groups_sync
  after insert or delete on public.scheme_version_cd_segment_groups
  for each row execute function public.sync_cd_segment_group_to_rule();

-- 5. Validation: add per-MT CD checks on top of the existing validator.
create or replace function public.validate_meenakshi_scheme_version(
  p_scheme_version_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  validation_result jsonb;
  activation_issues jsonb;
  v_version record;
  v_extra jsonb := '[]'::jsonb;
begin
  validation_result := public.validate_meenakshi_scheme_version_with_posting_requirements(p_scheme_version_id);

  select coalesce(jsonb_agg(issue), '[]'::jsonb)
  into activation_issues
  from jsonb_array_elements(coalesce(validation_result -> 'issues', '[]'::jsonb)) issue
  where issue ->> 'code' not in (
    'credit_note_voucher_type_unavailable',
    'discount_ledger_unavailable_or_taxable',
    'credit_note_tax_policy_missing'
  );

  select id, company_id, scheme_type, cd_discount_basis into v_version
  from public.scheme_versions where id = p_scheme_version_id;

  if v_version.scheme_type = 'cd' and v_version.cd_discount_basis = 'amount_per_tonne' then
    if not exists (select 1 from public.scheme_version_cd_segments where scheme_version_id = v_version.id) then
      v_extra := v_extra || jsonb_build_array(jsonb_build_object('code', 'cd_segment_required', 'message', 'Add at least one segment with its customer groups, working days and ₹ per MT.'));
    end if;

    if exists (
      select 1 from public.scheme_version_cd_segments segment
      where segment.scheme_version_id = v_version.id
        and not exists (select 1 from public.scheme_version_cd_segment_groups member where member.segment_id = segment.id)
    ) then
      v_extra := v_extra || jsonb_build_array(jsonb_build_object('code', 'cd_segment_group_required', 'message', 'Every segment needs at least one Tally customer group.'));
    end if;

    -- A group (or one of its sub-groups) covered by two segments.
    if exists (
      with recursive covered as (
        select member.segment_id, member.customer_group_id
        from public.scheme_version_cd_segment_groups member
        where member.scheme_version_id = v_version.id
        union
        select covered.segment_id, child.id
        from public.customer_groups child
        join covered on child.parent_group_id = covered.customer_group_id
        where child.company_id = v_version.company_id
      )
      select 1 from covered
      group by customer_group_id
      having count(distinct segment_id) > 1
    ) then
      v_extra := v_extra || jsonb_build_array(jsonb_build_object('code', 'cd_segment_overlap', 'message', 'A customer group or one of its sub-groups is in more than one segment. Each group may belong to only one segment.'));
    end if;

    if not exists (select 1 from public.scheme_version_stock_items where scheme_version_id = v_version.id)
      and not exists (select 1 from public.scheme_version_stock_groups where scheme_version_id = v_version.id) then
      v_extra := v_extra || jsonb_build_array(jsonb_build_object('code', 'cd_products_required', 'message', 'Select the eligible products whose MT earns the Cash Discount.'));
    end if;

    if not exists (select 1 from public.scheme_version_unit_conversions where scheme_version_id = v_version.id) then
      v_extra := v_extra || jsonb_build_array(jsonb_build_object('code', 'cd_conversion_required', 'message', 'Confirm how the product quantity converts to MT.'));
    end if;
  end if;

  activation_issues := activation_issues || v_extra;
  return jsonb_set(
    jsonb_set(validation_result, '{issues}', activation_issues, true),
    '{valid}',
    to_jsonb(jsonb_array_length(activation_issues) = 0),
    true
  );
end;
$$;

revoke all on function public.validate_meenakshi_scheme_version(uuid) from public, anon, authenticated;
grant execute on function public.validate_meenakshi_scheme_version(uuid) to service_role;
revoke all on function public.sync_cd_segment_group_to_rule() from public, anon, authenticated;

-- 6. Editing an active rule creates a draft copy: carry the discount basis and
--    copy the segments with their groups. Otherwise unchanged from
--    20260922105914_preserve_tod_amount_basis_in_rule_drafts.sql.
create or replace function public.get_or_create_meenakshi_rule_draft(
  p_company_id uuid,
  p_scheme_id uuid,
  p_source_version_id uuid,
  p_actor_id uuid,
  p_terms jsonb,
  p_slabs jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_source public.scheme_versions%rowtype;
  v_existing_id uuid;
  v_version_id uuid;
  v_version_number integer;
  v_per_tonne boolean;
  v_segment record;
  v_new_segment_id uuid;
begin
  if jsonb_typeof(p_terms) <> 'object' then
    raise exception 'Rule terms must be an object';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_scheme_id::text));

  select * into v_source
  from public.scheme_versions
  where id = p_source_version_id
    and company_id = p_company_id
    and scheme_id = p_scheme_id
  for share;
  if not found or v_source.status <> 'active' then
    raise exception 'The current active rule could not be found';
  end if;

  select id into v_existing_id
  from public.scheme_versions
  where company_id = p_company_id
    and scheme_id = p_scheme_id
    and status = 'draft'
  order by created_at desc
  limit 1;
  if v_existing_id is not null then
    return jsonb_build_object('versionId', v_existing_id, 'replayed', true);
  end if;

  select coalesce(max(version_number), 0) + 1 into v_version_number
  from public.scheme_versions
  where scheme_id = p_scheme_id;

  v_per_tonne := v_source.scheme_type = 'cd' and v_source.cd_discount_basis = 'amount_per_tonne';

  insert into public.scheme_versions (
    company_id, scheme_id, scheme_type, version_number, status,
    effective_from, effective_to, discount_percentage, calculation_base,
    rounding_method, rounding_scale, gst_treatment,
    credit_note_voucher_type_id, discount_ledger_id, requires_approval,
    working_calendar_id, allowed_working_days, near_eligibility_percent,
    cd_invoice_treatment, cd_narration_mode, cd_check_narration,
    period_months, period_anchor_date, tod_review_calendar_id,
    tod_benefit_basis, cd_discount_basis, created_by
  ) values (
    p_company_id, p_scheme_id, v_source.scheme_type, v_version_number, 'draft',
    (p_terms ->> 'effective_from')::date,
    nullif(p_terms ->> 'effective_to', '')::date,
    case when v_source.scheme_type = 'cd' and not v_per_tonne then (p_terms ->> 'discount_percentage')::numeric else null end,
    coalesce(p_terms ->> 'calculation_base', v_source.calculation_base),
    coalesce(p_terms ->> 'rounding_method', v_source.rounding_method::text)::public.rounding_method,
    coalesce((p_terms ->> 'rounding_scale')::smallint, v_source.rounding_scale),
    coalesce(p_terms ->> 'gst_treatment', v_source.gst_treatment::text)::public.gst_treatment,
    v_source.credit_note_voucher_type_id, v_source.discount_ledger_id,
    coalesce((p_terms ->> 'requires_approval')::boolean, v_source.requires_approval),
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'working_calendar_id')::uuid else null end,
    case when v_source.scheme_type = 'cd' and not v_per_tonne then (p_terms ->> 'allowed_working_days')::smallint else null end,
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'near_eligibility_percent')::numeric else null end,
    case when v_source.scheme_type = 'cd' then coalesce(v_source.cd_invoice_treatment, 'deducted_upfront') else null end,
    case when v_source.scheme_type = 'cd' then coalesce(v_source.cd_narration_mode, 'informational') else null end,
    case when v_source.scheme_type = 'cd' then coalesce((p_terms ->> 'cd_check_narration')::boolean, v_source.cd_check_narration, true) else true end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'period_months')::smallint else null end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'period_anchor_date')::date else null end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'tod_review_calendar_id')::uuid else null end,
    case when v_source.scheme_type = 'tod' then coalesce(p_terms ->> 'tod_benefit_basis', v_source.tod_benefit_basis) else null end,
    v_source.cd_discount_basis,
    p_actor_id
  ) returning id into v_version_id;

  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id, include_descendants)
  select v_version_id, company_id, customer_group_id, include_descendants
  from public.scheme_version_customer_groups
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_stock_items (scheme_version_id, company_id, stock_item_id)
  select v_version_id, company_id, stock_item_id
  from public.scheme_version_stock_items
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_stock_groups (scheme_version_id, company_id, stock_group_id)
  select v_version_id, company_id, stock_group_id
  from public.scheme_version_stock_groups
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_unit_conversions (
    scheme_version_id, company_id, source_uom_id, tonnes_per_source_unit,
    is_builtin, approved_by, approved_at
  )
  select v_version_id, company_id, source_uom_id, tonnes_per_source_unit,
    is_builtin, approved_by, approved_at
  from public.scheme_version_unit_conversions
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_tiers (
    scheme_version_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne
  )
  select v_version_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne
  from public.scheme_version_tiers
  where scheme_version_id = v_source.id;

  if v_source.scheme_type = 'cd' and not v_per_tonne then
    if jsonb_typeof(p_slabs) = 'array' and jsonb_array_length(p_slabs) > 0 then
      insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
      select v_version_id, slab.allowed_working_days, slab.discount_percentage
      from jsonb_to_recordset(p_slabs) as slab(allowed_working_days smallint, discount_percentage numeric);
    else
      insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
      select v_version_id, allowed_working_days, discount_percentage
      from public.scheme_version_cd_slabs
      where scheme_version_id = v_source.id;
    end if;
  end if;

  if v_per_tonne then
    for v_segment in
      select * from public.scheme_version_cd_segments where scheme_version_id = v_source.id order by sort_order, created_at
    loop
      insert into public.scheme_version_cd_segments (scheme_version_id, company_id, label, allowed_working_days, amount_per_tonne, sort_order)
      values (v_version_id, v_segment.company_id, v_segment.label, v_segment.allowed_working_days, v_segment.amount_per_tonne, v_segment.sort_order)
      returning id into v_new_segment_id;
      insert into public.scheme_version_cd_segment_groups (scheme_version_id, segment_id, company_id, customer_group_id)
      select v_version_id, v_new_segment_id, company_id, customer_group_id
      from public.scheme_version_cd_segment_groups
      where segment_id = v_segment.id;
    end loop;
  end if;

  return jsonb_build_object('versionId', v_version_id, 'replayed', false);
end;
$$;

revoke all on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  to service_role;

-- 7. Per-MT results reuse the Cash Discount candidate + posting pipeline.
--    A "settlement" candidate is an invoice paid at the discounted amount
--    (action_required) or more than 90% (review_required); its note is a
--    Credit Note, posted through the same outbox/connector command as Debit
--    Notes with note_kind = 'credit_note'. Full payments are informational and
--    live only in the run summary.
alter table public.cash_discount_recovery_candidates
  add column if not exists candidate_kind text not null default 'recovery',
  add column if not exists settlement_category text,
  add column if not exists eligible_tonnes numeric(20,6),
  add column if not exists amount_per_tonne numeric(12,2),
  add column if not exists discount_amount numeric(19,4),
  add column if not exists segment_label text;
alter table public.cash_discount_recovery_candidates
  drop constraint if exists cash_discount_recovery_candidates_kind_check;
alter table public.cash_discount_recovery_candidates
  add constraint cash_discount_recovery_candidates_kind_check check (
    (candidate_kind = 'recovery' and settlement_category is null)
    or (candidate_kind = 'settlement' and settlement_category in ('discounted_payment', 'over_ninety_percent')
        and discount_amount is not null and discount_amount > 0)
  );

alter table public.cash_discount_debit_note_postings
  add column if not exists note_kind text not null default 'debit_note';
alter table public.cash_discount_debit_note_postings
  drop constraint if exists cash_discount_debit_note_postings_note_kind_check;
alter table public.cash_discount_debit_note_postings
  add constraint cash_discount_debit_note_postings_note_kind_check check (note_kind in ('debit_note', 'credit_note'));
-- One live Cash Discount Credit Note per invoice.
create unique index if not exists cash_discount_credit_note_one_per_invoice
  on public.cash_discount_debit_note_postings (company_id, (debit_note_snapshot #>> '{sourceInvoice,guid}'))
  where note_kind = 'credit_note' and status not in ('failed', 'cancelled');

create or replace function public.replace_meenakshi_cd_settlement_snapshot(
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
  where company_id = p_company_id and current_snapshot;
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

-- Queue the Cash Discount Credit Note for one settlement candidate.
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

  reference := left('CN-CD-' || coalesce(nullif(candidate.invoice_number, ''), candidate.id::text), 120);
  insert into public.cash_discount_debit_note_postings (
    company_id, candidate_id, idempotency_key, debit_note_date, amount, calculation_reference,
    debit_note_voucher_type_id, recovery_ledger_id, debit_note_snapshot, created_by, note_kind
  ) values (
    p_company_id, candidate.id, p_idempotency_key, current_date, round(candidate.remaining_recovery, 2),
    reference, null, null,
    jsonb_build_object(
      'noteKind', 'credit_note',
      'company', jsonb_build_object('guid', company.tally_company_guid, 'name', company.tally_company_name),
      'voucherType', jsonb_build_object('name', 'Credit Note'),
      'party', jsonb_build_object('guid', candidate.customer_tally_guid, 'name', candidate.customer_name),
      'salesLedger', jsonb_build_object('name', coalesce(candidate.source_sales_ledger_name, '')),
      'debitNoteDate', current_date,
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

revoke execute on function public.replace_meenakshi_cd_settlement_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.enqueue_meenakshi_cd_credit_note(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.replace_meenakshi_cd_settlement_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb) to service_role;
grant execute on function public.enqueue_meenakshi_cd_credit_note(uuid,uuid,uuid,text) to service_role;

comment on table public.scheme_version_cd_segments is
  'Cash Discount v2 segments: working-day window and ₹ per MT for a set of customer groups (docs/CD_LOGIC.md).';
comment on table public.scheme_version_cd_segment_groups is
  'Customer groups of a Cash Discount segment. A group belongs to one segment per rule version.';

-- 9. A per-MT rule keeps its payment windows on its segments, not in
--    scheme_version_cd_slabs. The single-active-rule trigger from
--    20260812000000 only knew slabs, so it blocked every per-MT activation.
create or replace function public.prepare_single_active_meenakshi_cd_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.scheme_type = 'cd' and new.status = 'active' then
    if new.cd_discount_basis = 'amount_per_tonne' then
      if not exists (select 1 from public.scheme_version_cd_segments segment where segment.scheme_version_id = new.id) then
        raise exception 'Cash Discount requires at least one segment';
      end if;
    elsif not exists (select 1 from public.scheme_version_cd_slabs slab where slab.scheme_version_id = new.id) then
      raise exception 'Cash Discount requires at least one payment window';
    end if;
    update public.scheme_versions
    set status = 'retired', updated_at = now()
    where company_id = new.company_id and scheme_type = 'cd' and status = 'active' and id <> new.id;
  end if;
  return new;
end;
$$;
