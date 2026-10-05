-- Keep TOD updates singular and align rule coverage with the configured period.
-- This migration is intentionally prepared for manual application.

with ranked_drafts as (
  select id,
         row_number() over (partition by scheme_id order by created_at desc, id desc) as draft_rank
  from public.scheme_versions
  where status = 'draft'
)
update public.scheme_versions version
set status = 'retired', updated_at = now()
from ranked_drafts ranked
where version.id = ranked.id
  and ranked.draft_rank > 1;

alter table public.scheme_versions disable trigger scheme_versions_immutable;

update public.scheme_versions
set effective_from = period_anchor_date,
    effective_to = greatest(
      coalesce(effective_to, period_anchor_date),
      (period_anchor_date + make_interval(months => period_months) - interval '1 day')::date
    ),
    updated_at = now()
where scheme_type = 'tod'
  and status = 'active'
  and period_anchor_date is not null
  and period_months is not null
  and (
    effective_from <> period_anchor_date
    or effective_to is null
    or effective_to < (period_anchor_date + make_interval(months => period_months) - interval '1 day')::date
  );

alter table public.scheme_versions enable trigger scheme_versions_immutable;

with current_rules as (
  select scheme_id,
         period_anchor_date + make_interval(months => period_months) as next_period_start
  from public.scheme_versions
  where scheme_type = 'tod'
    and status = 'active'
    and period_anchor_date is not null
    and period_months is not null
)
update public.scheme_versions draft
set effective_from = current_rule.next_period_start::date,
    period_anchor_date = current_rule.next_period_start::date,
    effective_to = (current_rule.next_period_start + make_interval(months => draft.period_months) - interval '1 day')::date,
    updated_at = now()
from current_rules current_rule
where draft.scheme_id = current_rule.scheme_id
  and draft.scheme_type = 'tod'
  and draft.status = 'draft'
  and draft.period_months is not null
  and draft.effective_from < current_rule.next_period_start::date;

create unique index if not exists scheme_versions_one_draft_per_scheme_idx
  on public.scheme_versions (scheme_id)
  where status = 'draft';

create or replace function public.validate_tod_rule_period()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  first_period_end date;
begin
  if new.scheme_type <> 'tod' then return new; end if;
  if new.period_anchor_date is null or new.period_months is null then
    raise exception 'Turnover Discount rules require a period start and duration';
  end if;
  if new.effective_from <> new.period_anchor_date then
    raise exception 'Turnover Discount active period must start with its first calculation period';
  end if;
  first_period_end := (new.period_anchor_date + make_interval(months => new.period_months) - interval '1 day')::date;
  if new.effective_to is not null and new.effective_to < first_period_end then
    raise exception 'Turnover Discount active period must include one complete calculation period';
  end if;
  return new;
end;
$$;

drop trigger if exists scheme_versions_validate_tod_period on public.scheme_versions;
create trigger scheme_versions_validate_tod_period
  before insert or update of scheme_type, effective_from, effective_to, period_anchor_date, period_months
  on public.scheme_versions
  for each row execute function public.validate_tod_rule_period();
