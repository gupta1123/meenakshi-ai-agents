begin;

alter table public.working_calendars
  add column if not exists organization_id uuid;

update public.working_calendars calendar
set organization_id = company.organization_id
from public.companies company
where company.id = calendar.company_id;

alter table public.working_calendars
  alter column organization_id set not null;

drop table if exists public._migration_global_calendar_selection;

create table public._migration_global_calendar_selection (
  organization_id uuid primary key,
  calendar_id uuid not null unique
);

insert into public._migration_global_calendar_selection (organization_id, calendar_id)
select ranked.organization_id, ranked.id
from (
  select
    calendar.organization_id,
    calendar.id,
    row_number() over (
      partition by calendar.organization_id
      order by
        exists (
          select 1
          from public.scheme_versions version
          where version.working_calendar_id = calendar.id
             or version.tod_review_calendar_id = calendar.id
        ) desc,
        calendar.is_active desc,
        calendar.created_at,
        calendar.id
    ) as position
  from public.working_calendars calendar
) ranked
where ranked.position = 1;

insert into public.working_calendar_non_working_weekdays (working_calendar_id, iso_weekday)
select distinct selection.calendar_id, weekday.iso_weekday
from public.working_calendars source_calendar
join public._migration_global_calendar_selection selection
  on selection.organization_id = source_calendar.organization_id
join public.working_calendar_non_working_weekdays weekday
  on weekday.working_calendar_id = source_calendar.id
on conflict (working_calendar_id, iso_weekday) do nothing;

insert into public.working_calendar_holidays (
  working_calendar_id,
  holiday_date,
  name,
  is_active,
  created_by,
  created_at,
  updated_at
)
select distinct on (selection.calendar_id, holiday.holiday_date)
  selection.calendar_id,
  holiday.holiday_date,
  holiday.name,
  holiday.is_active,
  holiday.created_by,
  holiday.created_at,
  holiday.updated_at
from public.working_calendars source_calendar
join public._migration_global_calendar_selection selection
  on selection.organization_id = source_calendar.organization_id
join public.working_calendar_holidays holiday
  on holiday.working_calendar_id = source_calendar.id
order by selection.calendar_id, holiday.holiday_date, holiday.is_active desc, holiday.updated_at desc
on conflict (working_calendar_id, holiday_date) do update
set is_active = public.working_calendar_holidays.is_active or excluded.is_active,
    updated_at = greatest(public.working_calendar_holidays.updated_at, excluded.updated_at);

alter table public.scheme_versions
  drop constraint scheme_versions_working_calendar_id_company_id_fkey,
  drop constraint scheme_versions_tod_review_calendar_company_fk;

update public.scheme_versions version
set working_calendar_id = selection.calendar_id
from public.working_calendars source_calendar
join public._migration_global_calendar_selection selection
  on selection.organization_id = source_calendar.organization_id
where version.working_calendar_id = source_calendar.id
  and version.working_calendar_id is distinct from selection.calendar_id;

update public.scheme_versions version
set tod_review_calendar_id = selection.calendar_id
from public.working_calendars source_calendar
join public._migration_global_calendar_selection selection
  on selection.organization_id = source_calendar.organization_id
where version.tod_review_calendar_id = source_calendar.id
  and version.tod_review_calendar_id is distinct from selection.calendar_id;

delete from public.working_calendars calendar
using public._migration_global_calendar_selection selection
where calendar.organization_id = selection.organization_id
  and calendar.id <> selection.calendar_id;

update public.working_calendars
set is_active = true;

alter table public.working_calendars
  drop constraint working_calendars_company_id_name_key,
  drop constraint working_calendars_id_company_id_key,
  drop constraint working_calendars_company_id_fkey,
  drop column company_id,
  add constraint working_calendars_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint working_calendars_one_per_organization_key unique (organization_id);

alter table public.scheme_versions
  add constraint scheme_versions_working_calendar_id_fkey
    foreign key (working_calendar_id) references public.working_calendars(id) on delete restrict,
  add constraint scheme_versions_tod_review_calendar_id_fkey
    foreign key (tod_review_calendar_id) references public.working_calendars(id) on delete restrict;

create or replace function public.validate_scheme_version_calendar_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  company_organization_id uuid;
begin
  select company.organization_id
  into company_organization_id
  from public.companies company
  where company.id = new.company_id;

  if new.working_calendar_id is not null and not exists (
    select 1
    from public.working_calendars calendar
    where calendar.id = new.working_calendar_id
      and calendar.organization_id = company_organization_id
  ) then
    raise exception 'The Cash Discount calendar must be the shared Meenakshi business calendar';
  end if;

  if new.tod_review_calendar_id is not null and not exists (
    select 1
    from public.working_calendars calendar
    where calendar.id = new.tod_review_calendar_id
      and calendar.organization_id = company_organization_id
  ) then
    raise exception 'The Turnover Discount review calendar must be the shared Meenakshi business calendar';
  end if;

  return new;
end;
$$;

create trigger scheme_versions_validate_calendar_scope
  before insert or update of company_id, working_calendar_id, tod_review_calendar_id
  on public.scheme_versions
  for each row execute function public.validate_scheme_version_calendar_scope();

do $$
declare
  function_definition text;
  updated_definition text;
begin
  select pg_get_functiondef('public.validate_scheme_version_activation()'::regprocedure)
  into function_definition;
  updated_definition := replace(
    function_definition,
    'and calendar.company_id = new.company_id',
    'and calendar.organization_id = (select company.organization_id from public.companies company where company.id = new.company_id)'
  );
  if updated_definition = function_definition then
    raise exception 'Could not update validate_scheme_version_activation for the shared calendar';
  end if;
  execute updated_definition;

  select pg_get_functiondef('public.validate_meenakshi_scheme_version(uuid)'::regprocedure)
  into function_definition;
  updated_definition := replace(
    function_definition,
    'and calendar.company_id = v_version.company_id',
    'and calendar.organization_id = (select company.organization_id from public.companies company where company.id = v_version.company_id)'
  );
  if updated_definition = function_definition then
    raise exception 'Could not update validate_meenakshi_scheme_version for the shared calendar';
  end if;
  execute updated_definition;
end;
$$;

comment on table public.working_calendars is
  'The single Meenakshi business calendar shared automatically by every connected Tally company in the organization.';

drop table public._migration_global_calendar_selection;

commit;
