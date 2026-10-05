-- Additive multi-installation routing hardening.
--
-- This migration is intentionally NOT applied automatically. Apply it only
-- after deploying the API/frontend changes that scope live Tally resolution
-- to the company selected by the browser.

begin;

-- Keep historical connector assignments instead of forcing each company to
-- have only one binding row for its entire lifetime. At most one binding may
-- actively route commands for a company at any point in time.
alter table public.tally_connector_company_bindings
  drop constraint if exists tally_connector_company_bindings_company_id_key;

create unique index if not exists tally_connector_company_bindings_one_active_company_idx
  on public.tally_connector_company_bindings (company_id)
  where is_active;

create index if not exists tally_connector_company_bindings_active_connector_idx
  on public.tally_connector_company_bindings (connector_id, company_id)
  where is_active;

comment on index public.tally_connector_company_bindings_one_active_company_idx is
  'A company has one authoritative connector at a time; inactive rows preserve installation history.';

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
  v_binding_id uuid;
begin
  select company.organization_id, company.tally_company_guid, company.tally_company_name
  into v_organization_id, v_company_guid, v_company_name
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
    expected_tally_company_guid, expected_tally_company_name, is_active
  ) values (
    v_organization_id, p_company_id, p_connector_id,
    v_company_guid, v_company_name, true
  )
  on conflict (company_id, connector_id) do update
  set organization_id = excluded.organization_id,
      expected_tally_company_guid = excluded.expected_tally_company_guid,
      expected_tally_company_name = excluded.expected_tally_company_name,
      is_active = true,
      updated_at = now()
  returning id into v_binding_id;

  return v_binding_id;
end;
$$;

revoke all on function public.assign_tally_company_connector(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_tally_company_connector(uuid, uuid) to service_role;

commit;
