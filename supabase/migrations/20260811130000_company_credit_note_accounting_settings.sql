-- Company-level defaults for posting approved discounts into Tally.
-- This migration is intentionally created for manual application.

create table public.company_credit_note_accounting_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  gst_treatment public.gst_treatment not null default 'commercial_no_gst',
  cash_discount_voucher_type_id uuid,
  cash_discount_ledger_id uuid,
  turnover_discount_voucher_type_id uuid,
  turnover_discount_ledger_id uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (cash_discount_voucher_type_id, company_id)
    references public.tally_voucher_types(id, company_id) on delete restrict,
  foreign key (cash_discount_ledger_id, company_id)
    references public.tally_ledgers(id, company_id) on delete restrict,
  foreign key (turnover_discount_voucher_type_id, company_id)
    references public.tally_voucher_types(id, company_id) on delete restrict,
  foreign key (turnover_discount_ledger_id, company_id)
    references public.tally_ledgers(id, company_id) on delete restrict,
  check (
    (cash_discount_voucher_type_id is null and cash_discount_ledger_id is null)
    or (cash_discount_voucher_type_id is not null and cash_discount_ledger_id is not null)
  ),
  check (
    (turnover_discount_voucher_type_id is null and turnover_discount_ledger_id is null)
    or (turnover_discount_voucher_type_id is not null and turnover_discount_ledger_id is not null)
  ),
  check (cash_discount_voucher_type_id is not null or turnover_discount_voucher_type_id is not null)
);

create trigger company_credit_note_accounting_settings_set_updated_at
  before update on public.company_credit_note_accounting_settings
  for each row execute function public.set_updated_at();

comment on table public.company_credit_note_accounting_settings is
  'Current company-level Tally posting defaults. Rule versions snapshot these mappings during validation so historical posting remains reproducible.';

-- Existing rule versions keep their immutable mappings. Seed the company defaults
-- from the newest version of each rule type where a mapping already exists.
insert into public.company_credit_note_accounting_settings (
  company_id,
  gst_treatment,
  cash_discount_voucher_type_id,
  cash_discount_ledger_id,
  turnover_discount_voucher_type_id,
  turnover_discount_ledger_id
)
select
  company.id,
  'commercial_no_gst'::public.gst_treatment,
  cash_discount.credit_note_voucher_type_id,
  cash_discount.discount_ledger_id,
  turnover_discount.credit_note_voucher_type_id,
  turnover_discount.discount_ledger_id
from public.companies company
left join lateral (
  select version.credit_note_voucher_type_id, version.discount_ledger_id
  from public.scheme_versions version
  where version.company_id = company.id
    and version.scheme_type = 'cd'
    and version.credit_note_voucher_type_id is not null
    and version.discount_ledger_id is not null
  order by version.created_at desc
  limit 1
) cash_discount on true
left join lateral (
  select version.credit_note_voucher_type_id, version.discount_ledger_id
  from public.scheme_versions version
  where version.company_id = company.id
    and version.scheme_type = 'tod'
    and version.credit_note_voucher_type_id is not null
    and version.discount_ledger_id is not null
  order by version.created_at desc
  limit 1
) turnover_discount on true
where cash_discount.credit_note_voucher_type_id is not null
   or turnover_discount.credit_note_voucher_type_id is not null
on conflict (company_id) do nothing;

-- Draft business rules can now be created before accounting setup. Validation
-- snapshots the company mappings before a version can become active.
alter table public.scheme_versions
  alter column credit_note_voucher_type_id drop not null,
  alter column discount_ledger_id drop not null;

alter table public.company_credit_note_accounting_settings enable row level security;
revoke all on table public.company_credit_note_accounting_settings from anon, authenticated;
grant all on table public.company_credit_note_accounting_settings to service_role;
