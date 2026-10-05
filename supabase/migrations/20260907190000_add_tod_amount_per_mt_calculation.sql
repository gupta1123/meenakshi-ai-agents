-- TOD can award either a percentage of eligible value (the legacy mode) or a
-- fixed amount per eligible tonne. Existing TOD rules remain untouched and
-- are interpreted as legacy percentage rules by the application.

alter table public.scheme_versions
  add column if not exists tod_benefit_basis text;

alter table public.scheme_versions
  drop constraint if exists scheme_versions_tod_benefit_basis_check;

alter table public.scheme_versions
  add constraint scheme_versions_tod_benefit_basis_check
  check (
    (scheme_type = 'tod' and (tod_benefit_basis is null or tod_benefit_basis in ('percentage_of_eligible_value', 'amount_per_eligible_tonne')))
    or (scheme_type = 'cd' and tod_benefit_basis is null)
  ) not valid;

alter table public.scheme_versions
  validate constraint scheme_versions_tod_benefit_basis_check;

-- Older server-side draft functions do not name this new column. Keep those
-- percentage TOD drafts and all Cash Discount drafts valid during rollout.
create or replace function public.default_meenakshi_tod_benefit_basis()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scheme_type = 'tod' and new.tod_benefit_basis is null then
    new.tod_benefit_basis := 'percentage_of_eligible_value';
  elsif new.scheme_type = 'cd' then
    new.tod_benefit_basis := null;
  end if;
  return new;
end;
$$;

drop trigger if exists scheme_versions_default_tod_benefit_basis on public.scheme_versions;
create trigger scheme_versions_default_tod_benefit_basis
before insert or update of scheme_type, tod_benefit_basis on public.scheme_versions
for each row execute function public.default_meenakshi_tod_benefit_basis();

alter table public.scheme_version_tiers
  add column if not exists discount_amount_per_tonne numeric(20,4);

alter table public.scheme_version_tiers
  alter column discount_percentage drop not null;

alter table public.scheme_version_tiers
  drop constraint if exists scheme_version_tiers_discount_amount_per_tonne_check;

alter table public.scheme_version_tiers
  add constraint scheme_version_tiers_discount_amount_per_tonne_check
  check (discount_amount_per_tonne is null or discount_amount_per_tonne > 0);

create or replace function public.validate_meenakshi_tod_tier_benefit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_basis text;
  v_rate numeric;
begin
  select tod_benefit_basis into v_basis
  from public.scheme_versions
  where id = new.scheme_version_id;

  if v_basis = 'amount_per_eligible_tonne' then
    if new.discount_amount_per_tonne is null or new.discount_amount_per_tonne <= 0 or new.discount_percentage is not null then
      raise exception 'A per-MT TOD tier requires a positive amount per tonne and no percentage';
    end if;
  elsif v_basis = 'percentage_of_eligible_value' then
    if new.discount_percentage is null or new.discount_percentage <= 0 or new.discount_amount_per_tonne is not null then
      raise exception 'A percentage TOD tier requires a positive percentage and no amount per tonne';
    end if;
  else
    raise exception 'TOD benefit basis is required before adding tiers';
  end if;
  v_rate := case when v_basis = 'amount_per_eligible_tonne' then new.discount_amount_per_tonne else new.discount_percentage end;
  if exists (
    select 1 from public.scheme_version_tiers tier
    where tier.scheme_version_id = new.scheme_version_id
      and tier.id is distinct from new.id
      and tier.minimum_tonnes < new.minimum_tonnes
      and (case when v_basis = 'amount_per_eligible_tonne' then tier.discount_amount_per_tonne else tier.discount_percentage end) > v_rate
  ) or exists (
    select 1 from public.scheme_version_tiers tier
    where tier.scheme_version_id = new.scheme_version_id
      and tier.id is distinct from new.id
      and tier.minimum_tonnes > new.minimum_tonnes
      and (case when v_basis = 'amount_per_eligible_tonne' then tier.discount_amount_per_tonne else tier.discount_percentage end) < v_rate
  ) then
    raise exception 'TOD tier benefits cannot decrease at a higher tonne threshold';
  end if;
  return new;
end;
$$;

drop trigger if exists scheme_version_tiers_validate_benefit on public.scheme_version_tiers;
create trigger scheme_version_tiers_validate_benefit
before insert or update of scheme_version_id, discount_percentage, discount_amount_per_tonne
on public.scheme_version_tiers
for each row execute function public.validate_meenakshi_tod_tier_benefit();

-- An existing set of tiers has one interpretation. Require an operator to
-- remove it before changing basis, rather than silently changing its meaning.
create or replace function public.prevent_meenakshi_tod_basis_change_with_tiers()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tod_benefit_basis is distinct from old.tod_benefit_basis
    and exists (select 1 from public.scheme_version_tiers where scheme_version_id = old.id) then
    raise exception 'Remove TOD tiers before changing its benefit basis';
  end if;
  return new;
end;
$$;

drop trigger if exists scheme_versions_prevent_tod_basis_change on public.scheme_versions;
create trigger scheme_versions_prevent_tod_basis_change
before update of tod_benefit_basis on public.scheme_versions
for each row execute function public.prevent_meenakshi_tod_basis_change_with_tiers();
