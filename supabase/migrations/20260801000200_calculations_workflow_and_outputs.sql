-- Configurable, versioned Meenakshi CD/TOD rulebook and working calendars.

create table public.working_calendars (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name text not null,
  is_active boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id)
);

create table public.working_calendar_non_working_weekdays (
  working_calendar_id uuid not null references public.working_calendars(id) on delete cascade,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  primary key (working_calendar_id, iso_weekday)
);

create table public.working_calendar_holidays (
  id uuid primary key default gen_random_uuid(),
  working_calendar_id uuid not null references public.working_calendars(id) on delete cascade,
  holiday_date date not null,
  name text not null,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (working_calendar_id, holiday_date)
);

create function public.bump_working_calendar_revision()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_calendar_id uuid;
begin
  if tg_op = 'DELETE' then
    v_calendar_id := old.working_calendar_id;
  else
    v_calendar_id := new.working_calendar_id;
  end if;

  update public.working_calendars
  set revision = revision + 1
  where id = v_calendar_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger working_calendar_weekday_revision
  after insert or update or delete on public.working_calendar_non_working_weekdays
  for each row execute function public.bump_working_calendar_revision();
create trigger working_calendar_holiday_revision
  after insert or update or delete on public.working_calendar_holidays
  for each row execute function public.bump_working_calendar_revision();

create table public.schemes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  scheme_type public.scheme_type not null,
  code text not null,
  name text not null,
  description text,
  status public.scheme_status not null default 'draft',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id, scheme_type)
);

create table public.scheme_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  scheme_id uuid not null,
  scheme_type public.scheme_type not null,
  version_number integer not null check (version_number > 0),
  status public.scheme_version_status not null default 'draft',
  effective_from date not null,
  effective_to date,
  discount_percentage numeric(9,4),
  calculation_base text not null check (calculation_base = 'eligible_product_taxable_value'),
  rounding_method public.rounding_method not null,
  rounding_scale smallint not null check (rounding_scale between 0 and 4),
  gst_treatment public.gst_treatment not null default 'commercial_no_gst',
  credit_note_voucher_type_id uuid not null,
  discount_ledger_id uuid not null,
  requires_approval boolean not null default true,
  -- CD settings: invoice date is always Day 0 and the target is invoice due less discount.
  working_calendar_id uuid,
  allowed_working_days smallint,
  near_eligibility_percent numeric(5,2),
  -- TOD settings: calendar periods are anchored at the configured start date.
  period_months smallint,
  period_anchor_date date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scheme_id, version_number),
  unique (id, company_id),
  unique (id, company_id, scheme_type),
  foreign key (scheme_id, company_id, scheme_type)
    references public.schemes (id, company_id, scheme_type) on delete restrict,
  foreign key (working_calendar_id, company_id)
    references public.working_calendars (id, company_id) on delete restrict,
  foreign key (credit_note_voucher_type_id, company_id)
    references public.tally_voucher_types (id, company_id) on delete restrict,
  foreign key (discount_ledger_id, company_id)
    references public.tally_ledgers (id, company_id) on delete restrict,
  check (effective_to is null or effective_to >= effective_from),
  check (
    (scheme_type = 'cd'
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
    (scheme_type = 'tod'
      and discount_percentage is null
      and working_calendar_id is null
      and allowed_working_days is null
      and near_eligibility_percent is null
      and period_months is not null
      and period_months >= 1
      and period_anchor_date is not null)
  )
);

create index scheme_versions_lookup_idx
  on public.scheme_versions (company_id, scheme_type, status, effective_from, effective_to);

create table public.scheme_version_customer_groups (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_group_id uuid not null,
  include_descendants boolean not null default true check (include_descendants),
  created_at timestamptz not null default now(),
  primary key (scheme_version_id, customer_group_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade,
  foreign key (customer_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);

create table public.scheme_version_group_coverage (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_group_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (scheme_version_id, customer_group_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade,
  foreign key (customer_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);

create table public.scheme_version_stock_items (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  stock_item_id uuid not null,
  primary key (scheme_version_id, stock_item_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade,
  foreign key (stock_item_id, company_id)
    references public.stock_items (id, company_id) on delete restrict
);

create table public.scheme_version_stock_groups (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  stock_group_id uuid not null,
  primary key (scheme_version_id, stock_group_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade,
  foreign key (stock_group_id, company_id)
    references public.stock_groups (id, company_id) on delete restrict
);

create table public.scheme_version_unit_conversions (
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  source_uom_id uuid not null,
  tonnes_per_source_unit numeric(20,9) not null check (tonnes_per_source_unit > 0),
  is_builtin boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (scheme_version_id, source_uom_id),
  foreign key (scheme_version_id, company_id)
    references public.scheme_versions (id, company_id) on delete cascade,
  foreign key (source_uom_id, company_id)
    references public.tally_units (id, company_id) on delete restrict,
  check (
    (is_builtin and approved_by is null and approved_at is null)
    or (not is_builtin and approved_by is not null and approved_at is not null)
  )
);

create table public.scheme_version_tiers (
  id uuid primary key default gen_random_uuid(),
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  minimum_tonnes numeric(20,6) not null check (minimum_tonnes >= 0),
  discount_percentage numeric(9,4) not null check (discount_percentage > 0 and discount_percentage <= 100),
  created_at timestamptz not null default now(),
  unique (scheme_version_id, minimum_tonnes)
);

create function public.refresh_scheme_version_group_coverage(p_scheme_version_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id
  from public.scheme_versions
  where id = p_scheme_version_id;

  if v_company_id is null then
    return;
  end if;

  delete from public.scheme_version_group_coverage
  where scheme_version_id = p_scheme_version_id;

  insert into public.scheme_version_group_coverage (scheme_version_id, company_id, customer_group_id)
  with recursive covered_groups as (
    select svg.customer_group_id
    from public.scheme_version_customer_groups svg
    where svg.scheme_version_id = p_scheme_version_id

    union

    select child.id
    from public.customer_groups child
    join covered_groups parent on child.parent_group_id = parent.customer_group_id
    where child.company_id = v_company_id
      and child.is_available
  )
  select p_scheme_version_id, v_company_id, customer_group_id
  from covered_groups
  on conflict do nothing;
end;
$$;

create function public.refresh_scheme_version_group_coverage_trigger()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_scheme_version_group_coverage(old.scheme_version_id);
    return old;
  end if;

  perform public.refresh_scheme_version_group_coverage(new.scheme_version_id);
  return new;
end;
$$;

create trigger scheme_version_customer_groups_refresh_coverage
  after insert or update or delete on public.scheme_version_customer_groups
  for each row execute function public.refresh_scheme_version_group_coverage_trigger();

create function public.validate_scheme_version_activation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'active' then
    return new;
  end if;

  perform public.refresh_scheme_version_group_coverage(new.id);

  if not exists (
    select 1 from public.scheme_version_group_coverage c
    where c.scheme_version_id = new.id
  ) then
    raise exception 'An active rule version must select at least one live Tally customer group';
  end if;

  if exists (
    select 1
    from public.scheme_version_customer_groups selected_group
    join public.customer_groups g on g.id = selected_group.customer_group_id
    where selected_group.scheme_version_id = new.id
      and not g.is_available
  ) then
    raise exception 'An active rule version cannot reference an unavailable customer group';
  end if;

  if not exists (
    select 1 from public.tally_voucher_types vt
    where vt.id = new.credit_note_voucher_type_id
      and vt.company_id = new.company_id
      and vt.is_available
      and vt.is_credit_note_type
  ) then
    raise exception 'An active rule version requires a live Credit Note voucher type';
  end if;

  if not exists (
    select 1 from public.tally_ledgers l
    where l.id = new.discount_ledger_id
      and l.company_id = new.company_id
      and l.is_available
      and lower(coalesce(l.gst_applicability, '')) = 'not applicable'
  ) then
    raise exception 'An active rule version requires a live discount ledger with GST set to Not Applicable';
  end if;

  if new.scheme_type = 'tod' then
    if not exists (select 1 from public.scheme_version_tiers t where t.scheme_version_id = new.id) then
      raise exception 'An active TOD rule version requires at least one tier';
    end if;
    if not exists (select 1 from public.scheme_version_stock_items i where i.scheme_version_id = new.id)
       and not exists (select 1 from public.scheme_version_stock_groups g where g.scheme_version_id = new.id) then
      raise exception 'An active TOD rule version requires an eligible stock item or stock group';
    end if;
    if exists (
      select 1
      from public.stock_items si
      where si.company_id = new.company_id
        and si.is_available
        and (
          exists (
            select 1 from public.scheme_version_stock_items selected_item
            where selected_item.scheme_version_id = new.id
              and selected_item.stock_item_id = si.id
          )
          or exists (
            select 1 from public.scheme_version_stock_groups selected_group
            where selected_group.scheme_version_id = new.id
              and selected_group.stock_group_id = si.current_stock_group_id
          )
        )
        and not exists (
          select 1
          from public.scheme_version_unit_conversions conversion
          where conversion.scheme_version_id = new.id
            and conversion.source_uom_id = si.default_uom_id
        )
    ) then
      raise exception 'An active TOD rule version requires an approved tonne conversion for every selected stock item unit';
    end if;
  elsif not exists (
    select 1 from public.working_calendars calendar
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
      and daterange(other_version.effective_from, coalesce(other_version.effective_to + 1, 'infinity'::date), '[)')
          && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)')
  ) then
    raise exception 'Active rule versions of the same scheme type cannot overlap for covered Tally customer groups';
  end if;

  return new;
end;
$$;

create trigger scheme_versions_validate_activation
  before insert or update of status, effective_from, effective_to, credit_note_voucher_type_id, discount_ledger_id
  on public.scheme_versions
  for each row execute function public.validate_scheme_version_activation();

create function public.working_day_breakdown(
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
set search_path = public
as $$
  with candidates as (
    select value::date as business_date
    from generate_series(
      p_start_date,
      p_start_date + greatest(366, p_allowed_working_days * 8 + 30),
      interval '1 day'
    ) as gs(value)
  ), annotated as (
    select
      c.business_date,
      case
        when c.business_date = p_start_date then false
        when exists (
          select 1 from public.working_calendar_non_working_weekdays w
          where w.working_calendar_id = p_working_calendar_id
            and w.iso_weekday = extract(isodow from c.business_date)::smallint
        ) then false
        when exists (
          select 1 from public.working_calendar_holidays h
          where h.working_calendar_id = p_working_calendar_id
            and h.holiday_date = c.business_date
            and h.is_active
        ) then false
        else true
      end as is_working_day,
      case
        when c.business_date = p_start_date then 'invoice_day_zero'
        when exists (
          select 1 from public.working_calendar_holidays h
          where h.working_calendar_id = p_working_calendar_id
            and h.holiday_date = c.business_date
            and h.is_active
        ) then 'holiday'
        when exists (
          select 1 from public.working_calendar_non_working_weekdays w
          where w.working_calendar_id = p_working_calendar_id
            and w.iso_weekday = extract(isodow from c.business_date)::smallint
        ) then 'weekly_holiday'
        else null
      end as exclusion_reason
    from candidates c
  ), counted as (
    select
      a.*,
      sum(case when a.is_working_day then 1 else 0 end) over (order by a.business_date)::integer as counted_working_day
    from annotated a
  ), deadline as (
    select min(business_date) as deadline_date
    from counted
    where counted_working_day = p_allowed_working_days
  )
  select
    c.business_date,
    c.is_working_day,
    c.counted_working_day,
    c.exclusion_reason,
    c.business_date = d.deadline_date
  from counted c
  cross join deadline d
  where c.business_date <= d.deadline_date
  order by c.business_date;
$$;

create function public.working_day_deadline(
  p_working_calendar_id uuid,
  p_start_date date,
  p_allowed_working_days integer
)
returns date
language sql
stable
set search_path = public
as $$
  select business_date
  from public.working_day_breakdown(p_working_calendar_id, p_start_date, p_allowed_working_days)
  where is_deadline
  limit 1;
$$;

create trigger working_calendars_set_updated_at before update on public.working_calendars
  for each row execute function public.set_updated_at();
create trigger working_calendar_holidays_set_updated_at before update on public.working_calendar_holidays
  for each row execute function public.set_updated_at();
create trigger schemes_set_updated_at before update on public.schemes
  for each row execute function public.set_updated_at();
create trigger scheme_versions_set_updated_at before update on public.scheme_versions
  for each row execute function public.set_updated_at();
