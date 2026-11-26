-- Financial-year identity for Tally companies (step A of two: additive only).
--
-- A client can split one Tally company into one company per financial year.
-- Tally keeps the SAME GUID for each year, so a GUID alone no longer says which
-- year a company is. A company is now identified by (GUID, books-from date).
-- The name is only for display, because names change (and already did once).
--
-- This step ONLY ADDS: three nullable columns, three new unique indexes that are
-- wider than the existing rules, a backfill for Udyog, and an updated assign
-- function. It drops nothing, so every existing writer keeps working. The old
-- one-GUID rules are removed later by supabase/pending-migrations/
-- 20261126100100_drop_single_guid_company_rules.sql, only after the new code is live.

begin;

alter table public.companies
  add column if not exists tally_books_from date;
alter table public.tally_connector_company_observations
  add column if not exists tally_books_from date;
alter table public.tally_connector_company_bindings
  add column if not exists expected_tally_books_from date;

comment on column public.companies.tally_books_from is
  'Tally "books beginning from" date. With the GUID it identifies one financial-year company. Null = not yet known.';
comment on column public.tally_connector_company_observations.tally_books_from is
  'Books-from date of an open Tally company, as reported by the connector.';
comment on column public.tally_connector_company_bindings.expected_tally_books_from is
  'Books-from date the linked company must have; null = match on GUID (and name) only.';

-- The old rules stay until step B, so these are intentionally redundant for now.
create unique index if not exists companies_org_guid_books_from_idx
  on public.companies (organization_id, tally_company_guid, (coalesce(tally_books_from, date '0001-01-01')));

create unique index if not exists tally_connector_company_observations_guid_books_from_idx
  on public.tally_connector_company_observations (connector_id, tally_company_guid, (coalesce(tally_books_from, date '0001-01-01')));

-- Udyog's existing company record is the 2025-26 year (books from 1 April 2025),
-- confirmed from the live server on 26 Nov 2026.
update public.companies
set tally_books_from = date '2025-04-01'
where id = '963aa157-7c2e-4006-8efb-35902a30ec54'
  and tally_books_from is null;

update public.tally_connector_company_bindings
set expected_tally_books_from = date '2025-04-01'
where company_id = '963aa157-7c2e-4006-8efb-35902a30ec54'
  and expected_tally_books_from is null;

-- Copy the books-from date into the binding together with the GUID and name.
create or replace function public.assign_tally_company_connector(
  p_company_id uuid,
  p_connector_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_company_guid text;
  v_company_name text;
  v_books_from date;
  v_binding_id uuid;
begin
  select company.organization_id, company.tally_company_guid, company.tally_company_name, company.tally_books_from
  into v_organization_id, v_company_guid, v_company_name, v_books_from
  from public.companies as company
  join public.tally_connectors as connector
    on connector.id = p_connector_id
   and connector.organization_id = company.organization_id
   and connector.status <> 'revoked'
  where company.id = p_company_id
    and company.is_active;

  if v_organization_id is null then
    raise exception 'Company and connector must be active and belong to the same organization';
  end if;

  update public.tally_connector_company_bindings
  set is_active = false,
      updated_at = now()
  where company_id = p_company_id
    and is_active;

  insert into public.tally_connector_company_bindings (
    organization_id, company_id, connector_id,
    expected_tally_company_guid, expected_tally_company_name, expected_tally_books_from, is_active
  ) values (
    v_organization_id, p_company_id, p_connector_id,
    v_company_guid, v_company_name, v_books_from, true
  )
  on conflict (company_id, connector_id) do update
  set organization_id = excluded.organization_id,
      expected_tally_company_guid = excluded.expected_tally_company_guid,
      expected_tally_company_name = excluded.expected_tally_company_name,
      expected_tally_books_from = excluded.expected_tally_books_from,
      is_active = true,
      updated_at = now()
  returning id into v_binding_id;

  return v_binding_id;
end;
$$;

revoke all on function public.assign_tally_company_connector(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_tally_company_connector(uuid, uuid) to service_role;

commit;
