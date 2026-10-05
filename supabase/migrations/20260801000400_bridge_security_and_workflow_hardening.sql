-- Meenakshi v1 hardening and missing runtime infrastructure.
-- Run only after 20260801000000 through 20260801000300.
-- This migration is intentionally not applied by this deliverable.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------------------
-- 1. Explicit, Finance-approved Credit Note tax policy
-- ---------------------------------------------------------------------------

create table public.company_credit_note_tax_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  gst_treatment public.gst_treatment not null,
  effective_from date not null,
  effective_to date,
  approval_reference text not null,
  approver_name_snapshot text not null,
  approved_by uuid,
  approved_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  check (effective_to is null or effective_to >= effective_from),
  check (length(btrim(approval_reference)) > 0),
  check (length(btrim(approver_name_snapshot)) > 0)
);

create index company_credit_note_tax_policies_lookup_idx
  on public.company_credit_note_tax_policies
  (company_id, gst_treatment, effective_from, effective_to);

create trigger company_credit_note_tax_policies_set_updated_at
  before update on public.company_credit_note_tax_policies
  for each row execute function public.set_updated_at();

comment on table public.company_credit_note_tax_policies is
  'Finance/CA-approved company policy. A scheme cannot activate until its complete effective period is covered by an approved tax treatment.';

-- ---------------------------------------------------------------------------
-- 2. Live recursive customer-group and stock-group coverage
-- ---------------------------------------------------------------------------

create table public.scheme_version_stock_group_coverage (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  stock_group_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (scheme_version_id, stock_group_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions(id, company_id) on delete cascade,
  foreign key (stock_group_id, company_id)
    references public.stock_groups(id, company_id) on delete restrict
);

create function public.refresh_scheme_version_stock_group_coverage(p_scheme_version_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select version.company_id
    into v_company_id
  from public.scheme_versions version
  where version.id = p_scheme_version_id;

  if v_company_id is null then
    return;
  end if;

  delete from public.scheme_version_stock_group_coverage coverage
  where coverage.scheme_version_id = p_scheme_version_id;

  insert into public.scheme_version_stock_group_coverage
    (scheme_version_id, company_id, stock_group_id)
  with recursive covered_groups as (
    select selected.stock_group_id
    from public.scheme_version_stock_groups selected
    join public.stock_groups root
      on root.id = selected.stock_group_id
     and root.company_id = selected.company_id
     and root.is_available
    where selected.scheme_version_id = p_scheme_version_id

    union

    select child.id
    from public.stock_groups child
    join covered_groups parent
      on child.parent_stock_group_id = parent.stock_group_id
    where child.company_id = v_company_id
      and child.is_available
  )
  select p_scheme_version_id, v_company_id, covered.stock_group_id
  from covered_groups covered
  on conflict do nothing;
end;
$$;

create function public.refresh_scheme_version_stock_group_coverage_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.refresh_scheme_version_stock_group_coverage(
    case when tg_op = 'DELETE' then old.scheme_version_id else new.scheme_version_id end
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger scheme_version_stock_groups_refresh_coverage
  after insert or update or delete on public.scheme_version_stock_groups
  for each row execute function public.refresh_scheme_version_stock_group_coverage_trigger();

create function public.refresh_company_rule_coverage(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  version_id uuid;
begin
  for version_id in
    select version.id
    from public.scheme_versions version
    where version.company_id = p_company_id
      and version.status in ('draft', 'validated', 'active')
  loop
    perform public.refresh_scheme_version_group_coverage(version_id);
    perform public.refresh_scheme_version_stock_group_coverage(version_id);
  end loop;
end;
$$;

create function public.refresh_company_rule_coverage_after_master_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sync_kind = 'masters'
     and new.status = 'completed'
     and old.status is distinct from new.status then
    perform public.refresh_company_rule_coverage(new.company_id);
  end if;
  return new;
end;
$$;

create trigger tally_sync_runs_refresh_rule_coverage
  after update of status on public.tally_sync_runs
  for each row execute function public.refresh_company_rule_coverage_after_master_sync();

-- Replace activation validation with serialized activation, current live coverage,
-- an explicit tax-policy approval, parent-scheme validation, and monotonic TOD tiers.
create or replace function public.validate_scheme_version_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'active' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'Create a rule version as draft/validated, configure its children, then activate it';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(new.company_id::text),
    hashtext(new.scheme_type::text)
  );

  if not exists (
    select 1
    from public.schemes scheme
    where scheme.id = new.scheme_id
      and scheme.company_id = new.company_id
      and scheme.scheme_type = new.scheme_type
      and scheme.status = 'active'
  ) then
    raise exception 'The parent scheme must be active before activating a rule version';
  end if;

  perform public.refresh_scheme_version_group_coverage(new.id);
  perform public.refresh_scheme_version_stock_group_coverage(new.id);

  if not exists (
    select 1
    from public.scheme_version_group_coverage coverage
    where coverage.scheme_version_id = new.id
  ) then
    raise exception 'An active rule version must select at least one live Tally customer group';
  end if;

  if exists (
    select 1
    from public.scheme_version_customer_groups selected
    join public.customer_groups tally_group
      on tally_group.id = selected.customer_group_id
     and tally_group.company_id = selected.company_id
    where selected.scheme_version_id = new.id
      and not tally_group.is_available
  ) then
    raise exception 'An active rule version cannot reference an unavailable customer group';
  end if;

  if not exists (
    select 1
    from public.tally_voucher_types voucher_type
    where voucher_type.id = new.credit_note_voucher_type_id
      and voucher_type.company_id = new.company_id
      and voucher_type.is_available
      and voucher_type.is_credit_note_type
  ) then
    raise exception 'An active rule version requires a live Credit Note voucher type';
  end if;

  if not exists (
    select 1
    from public.tally_ledgers ledger
    where ledger.id = new.discount_ledger_id
      and ledger.company_id = new.company_id
      and ledger.is_available
      and lower(coalesce(ledger.gst_applicability, '')) = 'not applicable'
  ) then
    raise exception 'An active commercial Credit Note rule requires a live discount ledger with GST set to Not Applicable';
  end if;

  if not exists (
    select 1
    from public.company_credit_note_tax_policies policy
    where policy.company_id = new.company_id
      and policy.gst_treatment = new.gst_treatment
      and policy.effective_from <= new.effective_from
      and (
        (new.effective_to is null and policy.effective_to is null)
        or (new.effective_to is not null and (policy.effective_to is null or policy.effective_to >= new.effective_to))
      )
  ) then
    raise exception 'An active rule version requires a Finance/CA-approved Credit Note tax policy covering its complete effective period';
  end if;

  if new.scheme_type = 'tod' then
    if not exists (
      select 1 from public.scheme_version_tiers tier
      where tier.scheme_version_id = new.id
    ) then
      raise exception 'An active TOD rule version requires at least one tier';
    end if;

    if exists (
      select 1
      from (
        select
          tier.discount_percentage,
          lag(tier.discount_percentage) over (order by tier.minimum_tonnes) as previous_percentage
        from public.scheme_version_tiers tier
        where tier.scheme_version_id = new.id
      ) ordered_tiers
      where ordered_tiers.previous_percentage is not null
        and ordered_tiers.discount_percentage < ordered_tiers.previous_percentage
    ) then
      raise exception 'TOD discount percentages cannot decrease at higher tonne thresholds';
    end if;

    if not exists (
      select 1 from public.scheme_version_stock_items selected
      where selected.scheme_version_id = new.id
    ) and not exists (
      select 1 from public.scheme_version_stock_group_coverage coverage
      where coverage.scheme_version_id = new.id
    ) then
      raise exception 'An active TOD rule version requires a live eligible stock item or stock group';
    end if;

    if exists (
      select 1
      from public.stock_items item
      where item.company_id = new.company_id
        and item.is_available
        and (
          exists (
            select 1
            from public.scheme_version_stock_items selected_item
            where selected_item.scheme_version_id = new.id
              and selected_item.stock_item_id = item.id
          )
          or exists (
            select 1
            from public.scheme_version_stock_group_coverage covered_group
            where covered_group.scheme_version_id = new.id
              and covered_group.stock_group_id = item.current_stock_group_id
          )
        )
        and not exists (
          select 1
          from public.scheme_version_unit_conversions conversion
          where conversion.scheme_version_id = new.id
            and conversion.source_uom_id = item.default_uom_id
        )
    ) then
      raise exception 'An active TOD rule version requires an approved tonne conversion for every selected stock item unit';
    end if;
  elsif not exists (
    select 1
    from public.working_calendars calendar
    where calendar.id = new.working_calendar_id
      and calendar.company_id = new.company_id
      and calendar.is_active
  ) then
    raise exception 'An active CD rule version requires an active working calendar';
  end if;

  if exists (
    select 1
    from public.scheme_versions other_version
    join public.scheme_version_group_coverage other_coverage
      on other_coverage.scheme_version_id = other_version.id
    join public.scheme_version_group_coverage new_coverage
      on new_coverage.scheme_version_id = new.id
     and new_coverage.customer_group_id = other_coverage.customer_group_id
    where other_version.id <> new.id
      and other_version.company_id = new.company_id
      and other_version.scheme_type = new.scheme_type
      and other_version.status = 'active'
      and daterange(
        other_version.effective_from,
        coalesce(other_version.effective_to + 1, 'infinity'::date),
        '[)'
      ) && daterange(
        new.effective_from,
        coalesce(new.effective_to + 1, 'infinity'::date),
        '[)'
      )
  ) then
    raise exception 'Active rule versions of the same scheme type cannot overlap for covered Tally customer groups';
  end if;

  return new;
end;
$$;

-- Sunday is now configuration, not global behavior. Seed ISO weekday 7 in the
-- Meenakshi calendar, but do not hardcode it into this function.
create or replace function public.working_day_breakdown(
  p_working_calendar_id uuid,
  p_start_date date,
  p_allowed_working_days integer
)
returns table (
  business_date date,
  is_working_day boolean,
  counted_working_day integer,
  exclusion_reason text,
  is_deadline boolean
)
language sql
stable
set search_path = ''
as $$
  with candidates as (
    select value::date as business_date
    from generate_series(
      p_start_date,
      p_start_date + greatest(366, p_allowed_working_days * 8 + 30),
      interval '1 day'
    ) as generated(value)
  ), annotated as (
    select
      candidate.business_date,
      case
        when candidate.business_date = p_start_date then false
        when exists (
          select 1
          from public.working_calendar_non_working_weekdays weekday
          where weekday.working_calendar_id = p_working_calendar_id
            and weekday.iso_weekday = extract(isodow from candidate.business_date)::smallint
        ) then false
        when exists (
          select 1
          from public.working_calendar_holidays holiday
          where holiday.working_calendar_id = p_working_calendar_id
            and holiday.holiday_date = candidate.business_date
            and holiday.is_active
        ) then false
        else true
      end as is_working_day,
      case
        when candidate.business_date = p_start_date then 'invoice_day_zero'
        when exists (
          select 1
          from public.working_calendar_holidays holiday
          where holiday.working_calendar_id = p_working_calendar_id
            and holiday.holiday_date = candidate.business_date
            and holiday.is_active
        ) then 'holiday'
        when exists (
          select 1
          from public.working_calendar_non_working_weekdays weekday
          where weekday.working_calendar_id = p_working_calendar_id
            and weekday.iso_weekday = extract(isodow from candidate.business_date)::smallint
        ) then 'weekly_holiday'
        else null
      end as exclusion_reason
    from candidates candidate
  ), counted as (
    select
      annotated.*,
      sum(case when annotated.is_working_day then 1 else 0 end)
        over (order by annotated.business_date)::integer as counted_working_day
    from annotated
  ), deadline as (
    select min(counted.business_date) as deadline_date
    from counted
    where counted.counted_working_day = p_allowed_working_days
  )
  select
    counted.business_date,
    counted.is_working_day,
    counted.counted_working_day,
    counted.exclusion_reason,
    counted.business_date = deadline.deadline_date
  from counted
  cross join deadline
  where counted.business_date <= deadline.deadline_date
  order by counted.business_date;
$$;

-- ---------------------------------------------------------------------------
-- 3. Paired Tally bridge, company binding, and durable command queue
-- ---------------------------------------------------------------------------

create table public.tally_connectors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  installation_key text not null,
  display_name text not null,
  machine_fingerprint text not null,
  control_token_hash text not null,
  status text not null default 'paired'
    check (status in ('pending_pairing', 'paired', 'revoked')),
  bridge_version text,
  last_heartbeat_at timestamptz,
  last_ip_hash text,
  paired_by uuid,
  paired_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, installation_key),
  unique (id, organization_id),
  check (
    (status = 'pending_pairing' and paired_at is null and revoked_at is null)
    or (status = 'paired' and paired_at is not null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create table public.tally_connector_company_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  company_id uuid not null,
  connector_id uuid not null,
  expected_tally_company_guid text not null,
  expected_tally_company_name text not null,
  observed_tally_company_guid text,
  observed_tally_company_name text,
  is_active boolean not null default true,
  last_validated_at timestamptz,
  last_mismatch_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, connector_id),
  unique (company_id) deferrable initially immediate,
  foreign key (company_id, organization_id)
    references public.companies(id, organization_id) on delete restrict,
  foreign key (connector_id, organization_id)
    references public.tally_connectors(id, organization_id) on delete restrict
);

alter table public.integration_outbox
  add column organization_id uuid,
  add column company_id uuid,
  add column correlation_id uuid not null default gen_random_uuid(),
  add column idempotency_key text,
  add column max_attempts integer not null default 8 check (max_attempts > 0),
  add column lease_expires_at timestamptz;

-- These are clean-install migrations; this assertion prevents silently creating
-- unscoped historical outbox data if someone applies the draft to a used DB.
do $$
begin
  if exists (select 1 from public.integration_outbox) then
    raise exception 'Hardening migration expects an empty integration_outbox; migrate existing rows explicitly first';
  end if;
end;
$$;

alter table public.integration_outbox
  alter column organization_id set not null,
  alter column company_id set not null,
  alter column idempotency_key set not null,
  add constraint integration_outbox_company_organization_fk
    foreign key (company_id, organization_id)
    references public.companies(id, organization_id) on delete restrict,
  add constraint integration_outbox_attempt_limit_check
    check (attempts <= max_attempts),
  add constraint integration_outbox_lock_check
    check (
      (status = 'processing' and locked_at is not null and locked_by is not null and lease_expires_at is not null)
      or (status <> 'processing')
    ),
  add constraint integration_outbox_company_idempotency_key
    unique (company_id, idempotency_key);

drop index if exists public.integration_outbox_worker_idx;
create index integration_outbox_worker_idx
  on public.integration_outbox (available_at, created_at)
  where status in ('pending', 'failed', 'processing');

create table public.tally_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  company_id uuid not null,
  connector_id uuid not null,
  source_outbox_id uuid references public.integration_outbox(id) on delete restrict,
  command_type text not null check (command_type in (
    'sync_meenakshi_masters', 'sync_meenakshi_vouchers',
    'fetch_meenakshi_evidence', 'create_credit_note',
    'verify_credit_note', 'export_credit_note_pdf'
  )),
  business_idempotency_key text not null,
  correlation_id uuid not null,
  expected_tally_company_guid text not null,
  expected_tally_company_name text not null,
  payload jsonb not null,
  status public.command_status not null default 'queued',
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts > 0),
  safe_result jsonb,
  failure_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, business_idempotency_key),
  unique (source_outbox_id),
  foreign key (company_id, organization_id)
    references public.companies(id, organization_id) on delete restrict,
  foreign key (connector_id, organization_id)
    references public.tally_connectors(id, organization_id) on delete restrict,
  check (attempts <= max_attempts),
  check (
    (status = 'sending' and locked_at is not null and locked_by is not null and lease_expires_at is not null)
    or status <> 'sending'
  )
);

create index tally_commands_claim_idx
  on public.tally_commands (connector_id, available_at, created_at)
  where status in ('queued', 'failed', 'sending');
create index tally_commands_company_status_idx
  on public.tally_commands (company_id, status, created_at desc);

create trigger tally_connectors_set_updated_at
  before update on public.tally_connectors
  for each row execute function public.set_updated_at();
create trigger tally_connector_company_bindings_set_updated_at
  before update on public.tally_connector_company_bindings
  for each row execute function public.set_updated_at();
create trigger tally_commands_set_updated_at
  before update on public.tally_commands
  for each row execute function public.set_updated_at();

create function public.validate_tally_command_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> old.status and not (
    (old.status = 'queued' and new.status in ('sending', 'failed', 'dead_letter'))
    or (old.status = 'sending' and new.status in ('accepted', 'verified', 'failed', 'dead_letter'))
    or (old.status = 'accepted' and new.status in ('verified', 'failed', 'dead_letter'))
    or (old.status = 'failed' and new.status in ('queued', 'sending', 'dead_letter'))
  ) then
    raise exception 'Invalid Tally command transition: % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger tally_commands_validate_transition
  before update of status on public.tally_commands
  for each row execute function public.validate_tally_command_transition();

create function public.validate_integration_outbox_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> old.status and not (
    (old.status = 'pending' and new.status in ('processing', 'failed', 'dead_letter'))
    or (old.status = 'processing' and new.status in ('completed', 'failed', 'dead_letter'))
    or (old.status = 'failed' and new.status in ('processing', 'dead_letter'))
  ) then
    raise exception 'Invalid integration outbox transition: % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger integration_outbox_validate_transition
  before update of status on public.integration_outbox
  for each row execute function public.validate_integration_outbox_transition();

create function public.claim_integration_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.integration_outbox
language sql
set search_path = ''
as $$
  with candidates as (
    select outbox.id
    from public.integration_outbox outbox
    where outbox.attempts < outbox.max_attempts
      and (
        (outbox.status in ('pending', 'failed') and outbox.available_at <= now())
        or (outbox.status = 'processing' and outbox.lease_expires_at < now())
      )
    order by outbox.available_at, outbox.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.integration_outbox outbox
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(10, p_lease_seconds)),
      attempts = outbox.attempts + 1,
      updated_at = now()
  from candidates
  where outbox.id = candidates.id
  returning outbox.*;
$$;

create function public.claim_tally_commands(
  p_connector_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 90
)
returns setof public.tally_commands
language sql
set search_path = ''
as $$
  with candidates as (
    select command.id
    from public.tally_commands command
    join public.tally_connectors connector
      on connector.id = command.connector_id
     and connector.status = 'paired'
    join public.tally_connector_company_bindings binding
      on binding.connector_id = command.connector_id
     and binding.company_id = command.company_id
     and binding.is_active
    where command.connector_id = p_connector_id
      and command.attempts < command.max_attempts
      and (
        (command.status in ('queued', 'failed') and command.available_at <= now())
        or (command.status = 'sending' and command.lease_expires_at < now())
      )
    order by command.available_at, command.created_at
    for update of command skip locked
    limit greatest(1, least(p_limit, 10))
  )
  update public.tally_commands command
  set status = 'sending',
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      attempts = command.attempts + 1,
      updated_at = now()
  from candidates
  where command.id = candidates.id
  returning command.*;
$$;

create function public.dispatch_outbox_to_tally_command(
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
begin
  select * into outbox_record
  from public.integration_outbox outbox
  where outbox.id = p_outbox_id
    and outbox.status = 'processing'
  for update;

  if not found then
    raise exception 'Outbox event must be claimed before dispatch';
  end if;

  select * into company_record
  from public.companies company
  where company.id = outbox_record.company_id;

  if not exists (
    select 1
    from public.tally_connector_company_bindings binding
    join public.tally_connectors connector on connector.id = binding.connector_id
    where binding.connector_id = p_connector_id
      and binding.company_id = outbox_record.company_id
      and binding.organization_id = outbox_record.organization_id
      and binding.is_active
      and connector.status = 'paired'
  ) then
    raise exception 'No active paired connector is bound to the outbox company';
  end if;

  mapped_command_type := case outbox_record.event_type
    when 'tally_credit_note_create' then 'create_credit_note'
    when 'tally_credit_note_verify' then 'verify_credit_note'
    when 'tally_credit_note_pdf' then 'export_credit_note_pdf'
    when 'tally_targeted_refresh' then 'fetch_meenakshi_evidence'
    else null
  end;

  if mapped_command_type is null then
    raise exception 'Outbox event % is not a Tally command', outbox_record.event_type;
  end if;

  insert into public.tally_commands (
    organization_id, company_id, connector_id, source_outbox_id,
    command_type, business_idempotency_key, correlation_id,
    expected_tally_company_guid, expected_tally_company_name, payload
  ) values (
    outbox_record.organization_id, outbox_record.company_id, p_connector_id,
    outbox_record.id, mapped_command_type, outbox_record.idempotency_key,
    outbox_record.correlation_id, company_record.tally_company_guid,
    company_record.tally_company_name, outbox_record.payload
  )
  on conflict (company_id, business_idempotency_key)
  do update set updated_at = excluded.updated_at
  returning id into command_id;

  update public.integration_outbox
  set status = 'completed', completed_at = now(),
      locked_at = null, locked_by = null, lease_expires_at = null
  where id = outbox_record.id;

  return command_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Explicit Credit Note verification and PDF evidence
-- ---------------------------------------------------------------------------

alter table public.credit_note_postings
  add column verification_schema_version smallint not null default 1,
  add column verified_company_matches boolean,
  add column verified_party_matches boolean,
  add column verified_voucher_type_matches boolean,
  add column verified_discount_ledger_id uuid,
  add column verified_bill_allocation_type public.bill_allocation_type,
  add column verified_no_inventory_lines boolean,
  add column verified_no_unexpected_gst boolean,
  add column verified_calculation_reference text,
  add column verified_ledger_entries_hash text,
  add constraint credit_note_postings_verified_discount_ledger_fk
    foreign key (verified_discount_ledger_id, company_id)
    references public.tally_ledgers(id, company_id) on delete restrict;

create table public.credit_note_documents (
  id uuid primary key default gen_random_uuid(),
  credit_note_posting_id uuid not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  document_kind text not null default 'credit_note_pdf'
    check (document_kind in ('credit_note_pdf')),
  status text not null default 'pending'
    check (status in ('pending', 'exporting', 'attached', 'verified', 'failed')),
  storage_path text,
  sha256_hex text,
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes > 0),
  tally_voucher_guid text,
  tally_master_id text,
  attached_at timestamptz,
  verified_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (credit_note_posting_id, document_kind),
  foreign key (credit_note_posting_id, company_id)
    references public.credit_note_postings(id, company_id) on delete restrict,
  check (sha256_hex is null or sha256_hex ~ '^[0-9a-f]{64}$'),
  check (mime_type is null or mime_type = 'application/pdf'),
  check (
    status not in ('attached', 'verified')
    or (
      storage_path is not null and sha256_hex is not null
      and mime_type = 'application/pdf' and file_size_bytes is not null
      and tally_voucher_guid is not null and attached_at is not null
    )
  ),
  check (status <> 'verified' or verified_at is not null)
);

create index credit_note_documents_status_idx
  on public.credit_note_documents (company_id, status, created_at);
create trigger credit_note_documents_set_updated_at
  before update on public.credit_note_documents
  for each row execute function public.set_updated_at();

create function public.validate_credit_note_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('attached', 'verified') and not exists (
    select 1
    from public.credit_note_postings posting
    where posting.id = new.credit_note_posting_id
      and posting.company_id = new.company_id
      and posting.status = 'created_verified'
      and posting.verified_tally_guid = new.tally_voucher_guid
  ) then
    raise exception 'A PDF can be attached only to the exact created_verified Tally Credit Note';
  end if;
  return new;
end;
$$;

create trigger credit_note_documents_validate
  before insert or update on public.credit_note_documents
  for each row execute function public.validate_credit_note_document();

create or replace function public.validate_credit_note_posting_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status <> old.status then
    if not (
      (old.status = 'pending_approval' and new.status in ('queued', 'failed', 'cancel_requested'))
      or (old.status = 'queued' and new.status in ('sending', 'failed', 'cancel_requested'))
      or (old.status = 'sending' and new.status in ('verification_pending', 'correction_required', 'failed'))
      or (old.status = 'verification_pending' and new.status in ('created_verified', 'correction_required', 'failed'))
      or (old.status in ('correction_required', 'failed') and new.status in ('queued', 'cancel_requested', 'cancelled'))
      or (old.status = 'cancel_requested' and new.status in ('cancelled', 'failed'))
    ) then
      raise exception 'Invalid Credit Note posting status transition: % to %', old.status, new.status;
    end if;
  end if;

  if not exists (
    select 1
    from public.discount_proposals proposal
    join public.scheme_versions version on version.id = proposal.scheme_version_id
    where proposal.id = new.proposal_id
      and version.credit_note_voucher_type_id = new.credit_note_voucher_type_id
      and version.discount_ledger_id = new.discount_ledger_id
      and version.gst_treatment = new.gst_treatment
  ) then
    raise exception 'Credit Note posting must use the voucher type, discount ledger, and GST treatment configured by its rule version';
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
    raise exception 'TOD Credit Notes use New Ref; CD Credit Notes use Agst Ref or New Ref according to settlement state';
  end if;

  if new.bill_allocation_type = 'agst_ref' and nullif(btrim(new.tally_bill_reference), '') is null then
    raise exception 'Against Reference Credit Notes require the exact Tally bill reference';
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
    raise exception 'Credit Note posting requires an approved review of current live Tally evidence';
  end if;

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
      raise exception 'Verified Credit Note must match company, type, party, date, and amount in Tally';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Review and notification lifecycle hardening
-- ---------------------------------------------------------------------------

alter table public.proposal_reviews
  add column invalidated_by uuid,
  add column invalidated_at timestamptz,
  add column invalidation_reason text,
  add constraint proposal_reviews_invalidation_fields_check check (
    (status <> 'invalidated' and invalidated_by is null and invalidated_at is null and invalidation_reason is null)
    or (status = 'invalidated' and invalidated_by is not null and invalidated_at is not null and nullif(btrim(invalidation_reason), '') is not null)
  );

create function public.validate_proposal_review_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status <> old.status then
    if not (
      (old.status = 'pending' and new.status in ('approved', 'rejected'))
      or (old.status = 'approved' and new.status = 'invalidated')
    ) then
      raise exception 'Invalid proposal review transition: % to %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

create trigger proposal_reviews_validate_transition
  before update on public.proposal_reviews
  for each row execute function public.validate_proposal_review_transition();

alter table public.whatsapp_templates
  add column provider_name text not null default 'msg91',
  add column language_code text not null default 'en',
  add column template_namespace text,
  add column template_version text not null default '1',
  add column component_schema jsonb not null default '{}'::jsonb;

alter table public.notification_messages
  add column template_snapshot jsonb not null default '{}'::jsonb,
  add column read_at timestamptz,
  add constraint notification_messages_delivery_timestamps_check check (
    (status not in ('sent', 'delivered', 'read') or sent_at is not null)
    and (status not in ('delivered', 'read') or delivered_at is not null)
    and (status <> 'read' or read_at is not null)
  );

create or replace function public.validate_notification_message()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  requires_send_validation boolean;
  is_currently_opted_in boolean;
  current_opt_in_snapshot jsonb;
  current_template_snapshot jsonb;
begin
  if tg_op = 'UPDATE' and (
    new.company_id <> old.company_id
    or new.proposal_id <> old.proposal_id
    or new.customer_contact_id <> old.customer_contact_id
    or new.whatsapp_template_id <> old.whatsapp_template_id
    or new.event_type <> old.event_type
    or new.business_event_key <> old.business_event_key
    or new.credit_note_posting_id is distinct from old.credit_note_posting_id
    or new.resend_of_notification_id is distinct from old.resend_of_notification_id
  ) then
    raise exception 'Message identity and frozen business evidence cannot change after creation';
  end if;

  if tg_op = 'UPDATE' and new.status <> old.status then
    if not (
      (old.status = 'queued' and new.status in ('sending', 'failed', 'suppressed', 'cancelled'))
      or (old.status = 'sending' and new.status in ('sent', 'failed'))
      or (old.status = 'sent' and new.status in ('delivered', 'read', 'failed'))
      or (old.status = 'delivered' and new.status = 'read')
      or (old.status = 'failed' and new.status in ('queued', 'cancelled'))
    ) then
      raise exception 'Invalid notification status transition: % to %', old.status, new.status;
    end if;
  end if;

  requires_send_validation := tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and new.status = 'sending' and old.status <> 'sending');

  if requires_send_validation then
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
      raise exception 'Active template, recipient, proposal, and company must belong to the same organization and customer';
    end if;

    select
      true,
      jsonb_build_object(
        'optInId', opt_in.id,
        'recordedAt', opt_in.recorded_at,
        'source', opt_in.source,
        'evidence', opt_in.evidence
      )
    into is_currently_opted_in, current_opt_in_snapshot
    from public.whatsapp_opt_ins opt_in
    where opt_in.customer_contact_id = new.customer_contact_id
      and opt_in.is_opted_in
      and opt_in.revoked_at is null
    order by opt_in.recorded_at desc
    limit 1;

    if not coalesce(is_currently_opted_in, false) then
      raise exception 'Sending a WhatsApp message requires a current recorded opt-in';
    end if;

    select jsonb_build_object(
      'templateId', template.id,
      'provider', template.provider_name,
      'providerTemplateId', template.provider_template_id,
      'eventType', template.event_type,
      'languageCode', template.language_code,
      'namespace', template.template_namespace,
      'version', template.template_version,
      'componentSchema', template.component_schema
    )
    into current_template_snapshot
    from public.whatsapp_templates template
    where template.id = new.whatsapp_template_id;

    if tg_op = 'INSERT' then
      new.opt_in_snapshot := current_opt_in_snapshot;
      new.template_snapshot := current_template_snapshot;
    end if;

    if new.event_type = 'cd_shortfall' and not exists (
      select 1
      from public.discount_proposals proposal
      where proposal.id = new.proposal_id
        and proposal.scheme_type = 'cd'
        and proposal.status in ('near_eligibility', 'partially_paid')
        and proposal.shortfall_amount > 0
    ) then
      raise exception 'CD shortfall messages require a current near-eligibility or partially-paid proposal with a positive shortfall';
    end if;

    if new.event_type in ('cd_credit_note_created', 'tod_credit_note_created')
       and (
         new.credit_note_posting_id is null
         or not exists (
           select 1
           from public.credit_note_postings posting
           where posting.id = new.credit_note_posting_id
             and posting.proposal_id = new.proposal_id
             and posting.status = 'created_verified'
         )
       ) then
      raise exception 'Credit Note messages require a verified Tally Credit Note';
    end if;

    if new.resend_of_notification_id is not null and not exists (
      select 1
      from public.notification_messages original
      where original.id = new.resend_of_notification_id
        and original.company_id = new.company_id
        and original.proposal_id = new.proposal_id
        and original.customer_contact_id = new.customer_contact_id
        and original.event_type = new.event_type
    ) then
      raise exception 'A resend must reference a message for the same company, proposal, recipient, and event';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Atomic finance approval and durable outbox creation
-- ---------------------------------------------------------------------------

create function public.approve_proposal_and_enqueue_credit_note(
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
  organization_id uuid;
  posting_id uuid;
  posting_amount numeric(19,2);
begin
  select proposal.* into proposal_record
  from public.discount_proposals proposal
  where proposal.id = p_proposal_id
  for update;

  if not found then
    raise exception 'Proposal not found';
  end if;

  select company.organization_id into organization_id
  from public.companies company
  where company.id = proposal_record.company_id;

  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = organization_id
      and membership.profile_id = p_actor_id
      and membership.role = 'finance_approver'
  ) then
    raise exception 'Finance Approver role is required';
  end if;

  select posting.id into posting_id
  from public.credit_note_postings posting
  where posting.proposal_id = p_proposal_id;

  if posting_id is not null then
    return posting_id;
  end if;

  if proposal_record.status not in ('eligible', 'pending_approval') then
    raise exception 'Only an eligible proposal may be approved';
  end if;

  if exists (
    select 1
    from public.processing_issues issue
    where issue.proposal_id = p_proposal_id
      and issue.status in ('open', 'in_progress')
  ) then
    raise exception 'Resolve all blocking proposal issues before approval';
  end if;

  if not exists (
    select 1
    from public.proposal_evaluations evaluation
    where evaluation.id = p_proposal_evaluation_id
      and evaluation.proposal_id = p_proposal_id
      and evaluation.source_fingerprint = proposal_record.source_fingerprint
  ) then
    raise exception 'Approval must use the latest frozen evaluation and Tally fingerprint';
  end if;

  select version.* into version_record
  from public.scheme_versions version
  where version.id = proposal_record.scheme_version_id
    and version.status = 'active';

  if not found then
    raise exception 'Proposal rule version is no longer active';
  end if;

  posting_amount := coalesce(
    proposal_record.posted_discount_amount,
    round(proposal_record.calculated_discount_amount, 2)
  );

  if posting_amount is null or posting_amount <= 0 then
    raise exception 'Approved Credit Note amount must be positive';
  end if;

  if p_bill_allocation_type = 'agst_ref'
     and nullif(btrim(p_tally_bill_reference), '') is null then
    raise exception 'Against Reference requires the exact Tally bill reference';
  end if;

  insert into public.proposal_reviews (
    proposal_id, proposal_evaluation_id, status, source_fingerprint,
    review_reason, reviewed_by, reviewed_at
  ) values (
    p_proposal_id, p_proposal_evaluation_id, 'approved',
    proposal_record.source_fingerprint, 'Approved for Credit Note posting',
    p_actor_id, now()
  );

  insert into public.credit_note_postings (
    proposal_id, proposal_evaluation_id, company_id, customer_id,
    status, idempotency_key, credit_note_date, discount_amount,
    calculation_reference, credit_note_voucher_type_id, discount_ledger_id,
    bill_allocation_type, tally_bill_reference, gst_treatment,
    credit_note_snapshot, created_by
  ) values (
    p_proposal_id, p_proposal_evaluation_id, proposal_record.company_id,
    proposal_record.customer_id, 'queued', p_idempotency_key,
    p_credit_note_date, posting_amount, p_calculation_reference,
    version_record.credit_note_voucher_type_id, version_record.discount_ledger_id,
    p_bill_allocation_type, p_tally_bill_reference, version_record.gst_treatment,
    p_credit_note_snapshot, p_actor_id
  )
  returning id into posting_id;

  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    organization_id, proposal_record.company_id, p_correlation_id,
    'credit-note-create:' || posting_id::text, p_idempotency_key,
    'tally_credit_note_create', 'credit_note_posting', posting_id,
    jsonb_build_object('creditNotePostingId', posting_id)
  );

  update public.discount_proposals
  set status = 'sending_to_tally', updated_at = now()
  where id = p_proposal_id;

  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action,
    entity_type, entity_id, correlation_id, new_value
  ) values (
    organization_id, proposal_record.company_id, 'user', p_actor_id,
    'proposal_approved_and_credit_note_queued', 'credit_note_posting',
    posting_id, p_correlation_id,
    jsonb_build_object('proposalId', p_proposal_id, 'amount', posting_amount)
  );

  return posting_id;
end;
$$;

create function public.verify_credit_note_and_enqueue_pdf(
  p_credit_note_posting_id uuid,
  p_connector_id uuid,
  p_tally_credit_note_voucher_id uuid,
  p_verified_tally_guid text,
  p_verified_voucher_number text,
  p_verified_amount numeric,
  p_verified_discount_ledger_id uuid,
  p_verified_bill_allocation_type public.bill_allocation_type,
  p_verified_calculation_reference text,
  p_verified_ledger_entries_hash text,
  p_verification_snapshot jsonb,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting_record public.credit_note_postings;
  organization_id uuid;
begin
  select posting.* into posting_record
  from public.credit_note_postings posting
  where posting.id = p_credit_note_posting_id
  for update;

  if not found then
    raise exception 'Credit Note posting not found';
  end if;

  if posting_record.status <> 'verification_pending' then
    raise exception 'Only a verification_pending posting can be verified';
  end if;

  select company.organization_id into organization_id
  from public.companies company
  where company.id = posting_record.company_id;

  if not exists (
    select 1
    from public.tally_connector_company_bindings binding
    join public.tally_connectors connector on connector.id = binding.connector_id
    where binding.connector_id = p_connector_id
      and binding.company_id = posting_record.company_id
      and binding.is_active
      and connector.status = 'paired'
  ) then
    raise exception 'Verification must come through the active paired connector for this company';
  end if;

  update public.credit_note_postings
  set status = 'created_verified',
      tally_credit_note_voucher_id = p_tally_credit_note_voucher_id,
      verified_tally_guid = p_verified_tally_guid,
      verified_voucher_number = p_verified_voucher_number,
      verified_amount = round(p_verified_amount, 2),
      verified_at = now(),
      verification_snapshot = p_verification_snapshot,
      verified_company_matches = true,
      verified_party_matches = true,
      verified_voucher_type_matches = true,
      verified_discount_ledger_id = p_verified_discount_ledger_id,
      verified_bill_allocation_type = p_verified_bill_allocation_type,
      verified_no_inventory_lines = true,
      verified_no_unexpected_gst = true,
      verified_calculation_reference = p_verified_calculation_reference,
      verified_ledger_entries_hash = p_verified_ledger_entries_hash,
      failure_reason = null,
      updated_at = now()
  where id = p_credit_note_posting_id;

  insert into public.credit_note_documents (
    credit_note_posting_id, company_id, status, tally_voucher_guid
  ) values (
    p_credit_note_posting_id, posting_record.company_id, 'pending', p_verified_tally_guid
  )
  on conflict (credit_note_posting_id, document_kind) do nothing;

  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    organization_id, posting_record.company_id, p_correlation_id,
    'credit-note-pdf:' || p_credit_note_posting_id::text,
    'credit-note-pdf:' || p_credit_note_posting_id::text,
    'tally_credit_note_pdf', 'credit_note_posting', p_credit_note_posting_id,
    jsonb_build_object('creditNotePostingId', p_credit_note_posting_id)
  )
  on conflict (event_key) do nothing;

  update public.discount_proposals
  set status = 'created_verified', updated_at = now()
  where id = posting_record.proposal_id;

  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action,
    entity_type, entity_id, correlation_id, new_value
  ) values (
    organization_id, posting_record.company_id, 'tally_connector', p_connector_id,
    'credit_note_verified_and_pdf_queued', 'credit_note_posting',
    p_credit_note_posting_id, p_correlation_id,
    jsonb_build_object(
      'tallyGuid', p_verified_tally_guid,
      'voucherNumber', p_verified_voucher_number,
      'amount', round(p_verified_amount, 2)
    )
  );

  return p_credit_note_posting_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Private auth trigger and explicit Data API privileges
-- ---------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, phone_e164)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.email
    ),
    nullif(new.phone, '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

drop function if exists public.handle_new_user();
revoke all on function public.has_organization_role(uuid, public.organization_role)
  from public, anon, authenticated;
drop function public.has_organization_role(uuid, public.organization_role);

alter table public.company_credit_note_tax_policies enable row level security;
alter table public.scheme_version_stock_group_coverage enable row level security;
alter table public.tally_connectors enable row level security;
alter table public.tally_connector_company_bindings enable row level security;
alter table public.tally_commands enable row level security;
alter table public.credit_note_documents enable row level security;

revoke all on table public.company_credit_note_tax_policies from anon, authenticated;
revoke all on table public.scheme_version_stock_group_coverage from anon, authenticated;
revoke all on table public.tally_connectors from anon, authenticated;
revoke all on table public.tally_connector_company_bindings from anon, authenticated;
revoke all on table public.tally_commands from anon, authenticated;
revoke all on table public.credit_note_documents from anon, authenticated;
revoke all on table public.integration_outbox from anon, authenticated;

-- This is a server-API architecture. Make Data API exposure explicit for every
-- table, then grant back only the two browser-readable resources.
do $$
declare
  relation_name text;
begin
  for relation_name in
    select quote_ident(namespace.nspname) || '.' || quote_ident(class.relname)
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
  loop
    execute 'revoke all on table ' || relation_name || ' from anon, authenticated';
    execute 'grant all on table ' || relation_name || ' to service_role';
  end loop;
end;
$$;

grant select on public.profiles to authenticated;
grant update (display_name, phone_e164) on public.profiles to authenticated;
grant select on public.organization_memberships to authenticated;

do $$
declare
  routine_signature text;
begin
  for routine_signature in
    select proc.oid::regprocedure::text
    from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
  loop
    execute 'revoke execute on function ' || routine_signature || ' from public, anon, authenticated';
    execute 'grant execute on function ' || routine_signature || ' to service_role';
  end loop;
end;
$$;

grant usage, select on all sequences in schema public to service_role;

-- Public schema functions are server-only unless an explicit browser grant exists.
revoke execute on function public.claim_integration_outbox(text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_tally_commands(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.dispatch_outbox_to_tally_command(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.approve_proposal_and_enqueue_credit_note(
  uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid
) from public, anon, authenticated;
revoke execute on function public.verify_credit_note_and_enqueue_pdf(
  uuid, uuid, uuid, text, text, numeric, uuid, public.bill_allocation_type,
  text, text, jsonb, uuid
) from public, anon, authenticated;

grant execute on function public.claim_integration_outbox(text, integer, integer)
  to service_role;
grant execute on function public.claim_tally_commands(uuid, text, integer, integer)
  to service_role;
grant execute on function public.dispatch_outbox_to_tally_command(uuid, uuid)
  to service_role;
grant execute on function public.approve_proposal_and_enqueue_credit_note(
  uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid
) to service_role;
grant execute on function public.verify_credit_note_and_enqueue_pdf(
  uuid, uuid, uuid, text, text, numeric, uuid, public.bill_allocation_type,
  text, text, jsonb, uuid
) to service_role;

grant all on table public.company_credit_note_tax_policies to service_role;
grant all on table public.scheme_version_stock_group_coverage to service_role;
grant all on table public.tally_connectors to service_role;
grant all on table public.tally_connector_company_bindings to service_role;
grant all on table public.tally_commands to service_role;
grant all on table public.credit_note_documents to service_role;

-- Targeted indexes for foreign-key joins and worker paths not covered by a PK.
create index if not exists scheme_versions_scheme_idx
  on public.scheme_versions (scheme_id);
create index if not exists scheme_versions_calendar_idx
  on public.scheme_versions (working_calendar_id)
  where working_calendar_id is not null;
create index if not exists scheme_versions_voucher_type_idx
  on public.scheme_versions (credit_note_voucher_type_id);
create index if not exists scheme_versions_discount_ledger_idx
  on public.scheme_versions (discount_ledger_id);
create index if not exists proposal_reviews_evaluation_idx
  on public.proposal_reviews (proposal_evaluation_id);
create index if not exists credit_note_posting_attempts_posting_idx
  on public.credit_note_posting_attempts (credit_note_posting_id);
create index if not exists notification_messages_posting_idx
  on public.notification_messages (credit_note_posting_id)
  where credit_note_posting_id is not null;
create index if not exists notification_attempts_message_idx
  on public.notification_attempts (notification_message_id);

comment on table public.tally_commands is
  'Durable, company-scoped bridge commands with serial claim leases, idempotency, and safe results.';
comment on table public.credit_note_documents is
  'Checksum-backed PDF attachment evidence tied to a verified Tally Credit Note.';
