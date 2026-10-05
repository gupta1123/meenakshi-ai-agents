-- Live Cash Discount rules: customer-group eligibility, working-day slabs,
-- optional narration checks, and automatic Credit/Debit Note recommendations.
-- Created for manual application. Do not apply automatically.

alter table public.scheme_versions
  add column if not exists cd_check_narration boolean not null default true;

comment on column public.scheme_versions.cd_check_narration is
  'When enabled, the live Cash Discount calculation compares invoice narration with the active rule slabs.';

create table if not exists public.scheme_version_cd_slabs (
  id uuid primary key default gen_random_uuid(),
  scheme_version_id uuid not null references public.scheme_versions(id) on delete cascade,
  allowed_working_days smallint not null check (allowed_working_days >= 0 and allowed_working_days <= 366),
  discount_percentage numeric(9,4) not null check (discount_percentage > 0 and discount_percentage <= 100),
  created_at timestamptz not null default now(),
  unique (scheme_version_id, allowed_working_days)
);

create index if not exists scheme_version_cd_slabs_lookup_idx
  on public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days);

insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
select id, allowed_working_days, discount_percentage
from public.scheme_versions
where scheme_type = 'cd'
  and allowed_working_days is not null
  and discount_percentage is not null
on conflict (scheme_version_id, allowed_working_days) do nothing;

-- Preserve only the newest currently active CD version before enforcing one active rule.
with ranked_active_cd as (
  select id, row_number() over (partition by company_id order by effective_from desc, version_number desc, created_at desc) as position
  from public.scheme_versions
  where scheme_type = 'cd' and status = 'active'
)
update public.scheme_versions version
set status = 'retired', updated_at = now()
from ranked_active_cd ranked
where version.id = ranked.id and ranked.position > 1;

create unique index if not exists scheme_versions_one_active_cd_per_company_idx
  on public.scheme_versions (company_id)
  where scheme_type = 'cd' and status = 'active';

create or replace function public.prepare_single_active_meenakshi_cd_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.scheme_type = 'cd' and new.status = 'active' then
    if not exists (select 1 from public.scheme_version_cd_slabs slab where slab.scheme_version_id = new.id) then
      raise exception 'Cash Discount requires at least one payment window';
    end if;
    update public.scheme_versions
    set status = 'retired', updated_at = now()
    where company_id = new.company_id and scheme_type = 'cd' and status = 'active' and id <> new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists scheme_versions_single_active_cd on public.scheme_versions;
create trigger scheme_versions_single_active_cd
  before insert or update of status on public.scheme_versions
  for each row execute function public.prepare_single_active_meenakshi_cd_rule();

create or replace function public.validate_meenakshi_cd_slab()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  version_row public.scheme_versions;
begin
  select * into version_row from public.scheme_versions where id = coalesce(new.scheme_version_id, old.scheme_version_id);
  if not found or version_row.scheme_type <> 'cd' then raise exception 'Payment windows are only available for Cash Discount rules'; end if;
  if version_row.status <> 'draft' then raise exception 'Only a draft Cash Discount rule can be changed'; end if;
  if tg_op <> 'DELETE' and exists (
    select 1 from public.scheme_version_cd_slabs slab
    where slab.scheme_version_id = new.scheme_version_id
      and slab.id <> coalesce(new.id, gen_random_uuid())
      and ((slab.allowed_working_days < new.allowed_working_days and slab.discount_percentage < new.discount_percentage)
        or (slab.allowed_working_days > new.allowed_working_days and slab.discount_percentage > new.discount_percentage))
  ) then raise exception 'Later Cash Discount windows cannot offer a higher percentage'; end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists scheme_version_cd_slabs_validate on public.scheme_version_cd_slabs;
create trigger scheme_version_cd_slabs_validate
  before insert or update or delete on public.scheme_version_cd_slabs
  for each row execute function public.validate_meenakshi_cd_slab();

alter table public.company_credit_note_accounting_settings
  add column if not exists cash_discount_debit_note_voucher_type_id uuid,
  add column if not exists cash_discount_recovery_ledger_id uuid;

alter table public.company_credit_note_accounting_settings
  drop constraint if exists company_cd_debit_note_voucher_type_fk,
  drop constraint if exists company_cd_recovery_ledger_fk,
  drop constraint if exists company_cd_recovery_mapping_complete_check;

alter table public.company_credit_note_accounting_settings
  add constraint company_cd_debit_note_voucher_type_fk foreign key (cash_discount_debit_note_voucher_type_id, company_id) references public.tally_voucher_types(id, company_id) on delete restrict,
  add constraint company_cd_recovery_ledger_fk foreign key (cash_discount_recovery_ledger_id, company_id) references public.tally_ledgers(id, company_id) on delete restrict,
  add constraint company_cd_recovery_mapping_complete_check check ((cash_discount_debit_note_voucher_type_id is null and cash_discount_recovery_ledger_id is null) or (cash_discount_debit_note_voucher_type_id is not null and cash_discount_recovery_ledger_id is not null));

comment on column public.company_credit_note_accounting_settings.cash_discount_debit_note_voucher_type_id is 'Tally Debit Note type used when a previously deducted Cash Discount must be recovered.';
comment on column public.company_credit_note_accounting_settings.cash_discount_recovery_ledger_id is 'Tally ledger used for an approved Cash Discount recovery Debit Note.';

revoke all on function public.prepare_single_active_meenakshi_cd_rule() from public, anon, authenticated;
revoke all on function public.validate_meenakshi_cd_slab() from public, anon, authenticated;
grant execute on function public.prepare_single_active_meenakshi_cd_rule() to service_role;
grant execute on function public.validate_meenakshi_cd_slab() to service_role;

alter table public.scheme_version_cd_slabs enable row level security;
drop policy if exists scheme_version_cd_slabs_select_members on public.scheme_version_cd_slabs;
create policy scheme_version_cd_slabs_select_members on public.scheme_version_cd_slabs for select to authenticated using (
  exists (
    select 1 from public.scheme_versions version
    join public.companies company on company.id = version.company_id
    join public.organization_memberships membership on membership.organization_id = company.organization_id
    where version.id = scheme_version_cd_slabs.scheme_version_id and membership.profile_id = auth.uid()
  )
);

revoke insert, update, delete on public.scheme_version_cd_slabs from anon, authenticated;
