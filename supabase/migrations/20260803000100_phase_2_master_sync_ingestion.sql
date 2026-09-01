-- Meenakshi Phase 2: apply a completed full master export atomically.
-- The bridge submits normalized records; this function independently checks
-- the company identity and owns all availability changes.

create or replace function public.apply_meenakshi_master_sync_result(
  p_sync_run_id uuid,
  p_company_id uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  company_record public.companies;
  sync_record public.tally_sync_runs;
  received_count integer := 0;
  fingerprint text;
begin
  select * into company_record
  from public.companies company
  where company.id = p_company_id
    and company.is_active;
  if not found then
    raise exception 'Company is unavailable';
  end if;

  if coalesce(p_result -> 'activeCompany' ->> 'guid', '') <> company_record.tally_company_guid
     or lower(coalesce(p_result -> 'activeCompany' ->> 'name', '')) <> lower(company_record.tally_company_name) then
    raise exception 'Master sync active Tally company does not match the configured company';
  end if;
  if coalesce((p_result ->> 'complete')::boolean, false) is not true then
    raise exception 'Master availability can only change after a complete full export';
  end if;

  select * into sync_record
  from public.tally_sync_runs sync
  where sync.id = p_sync_run_id
    and sync.company_id = p_company_id
    and sync.sync_kind = 'masters'
  for update;
  if not found then
    raise exception 'Master sync run was not found';
  end if;
  if sync_record.status in ('completed', 'completed_with_errors') then
    return jsonb_build_object(
      'syncRunId', sync_record.id,
      'recordsReceived', sync_record.records_received,
      'recordsApplied', sync_record.records_applied,
      'fingerprint', sync_record.source_fingerprint,
      'alreadyApplied', true
    );
  end if;
  if sync_record.status = 'failed' then
    raise exception 'Failed master sync runs cannot be applied';
  end if;

  update public.tally_sync_runs
  set status = 'running', started_at = coalesce(started_at, now()), error_summary = null
  where id = p_sync_run_id;

  insert into public.customer_groups (
    company_id, tally_group_guid, tally_master_id, tally_alter_id, name,
    is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.name,
         true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,customerGroups}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, parent_guid text, source_payload jsonb)
  where coalesce(source.guid, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, tally_group_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      name = excluded.name,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  update public.customer_groups child
  set parent_group_id = parent.id
  from jsonb_to_recordset(coalesce(p_result #> '{masters,customerGroups}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, parent_guid text, source_payload jsonb)
  left join public.customer_groups parent
    on parent.company_id = p_company_id
   and parent.tally_group_guid = nullif(source.parent_guid, '')
  where child.company_id = p_company_id
    and child.tally_group_guid = source.guid;

  insert into public.tally_units (
    company_id, code, name, tally_guid, tally_master_id, tally_alter_id,
    is_available, last_seen_at, source_payload
  )
  select p_company_id, source.code, source.name, nullif(source.guid, ''), nullif(source.master_id, ''), nullif(source.alter_id, ''),
         true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,units}', '[]'::jsonb))
    as source(code text, name text, guid text, master_id text, alter_id text, source_payload jsonb)
  where coalesce(source.code, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, code) do update
  set name = excluded.name,
      tally_guid = excluded.tally_guid,
      tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  insert into public.stock_groups (
    company_id, tally_group_guid, tally_master_id, tally_alter_id, name,
    is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.name,
         true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,stockGroups}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, parent_guid text, source_payload jsonb)
  where coalesce(source.guid, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, tally_group_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      name = excluded.name,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  update public.stock_groups child
  set parent_stock_group_id = parent.id
  from jsonb_to_recordset(coalesce(p_result #> '{masters,stockGroups}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, parent_guid text, source_payload jsonb)
  left join public.stock_groups parent
    on parent.company_id = p_company_id
   and parent.tally_group_guid = nullif(source.parent_guid, '')
  where child.company_id = p_company_id
    and child.tally_group_guid = source.guid;

  insert into public.tally_ledgers (
    company_id, tally_ledger_guid, tally_master_id, tally_alter_id, name,
    parent_group_name, gst_applicability, is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.name,
         nullif(source.parent_group_name, ''), nullif(source.gst_applicability, ''), true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,ledgers}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, parent_group_name text, gst_applicability text, source_payload jsonb)
  where coalesce(source.guid, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, tally_ledger_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      name = excluded.name,
      parent_group_name = excluded.parent_group_name,
      gst_applicability = excluded.gst_applicability,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  insert into public.tally_voucher_types (
    company_id, tally_voucher_type_guid, tally_master_id, tally_alter_id, name,
    is_credit_note_type, is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.name,
         coalesce(source.is_credit_note_type, false), true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,voucherTypes}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, is_credit_note_type boolean, source_payload jsonb)
  where coalesce(source.guid, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, tally_voucher_type_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      name = excluded.name,
      is_credit_note_type = excluded.is_credit_note_type,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  insert into public.stock_items (
    company_id, tally_stock_item_guid, tally_master_id, tally_alter_id, name,
    current_stock_group_id, default_uom_id, is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.name,
         stock_group.id, unit.id, true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,stockItems}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, name text, stock_group_guid text, uom_code text, source_payload jsonb)
  left join public.stock_groups stock_group
    on stock_group.company_id = p_company_id and stock_group.tally_group_guid = nullif(source.stock_group_guid, '')
  left join public.tally_units unit
    on unit.company_id = p_company_id and unit.code = nullif(source.uom_code, '')
  where coalesce(source.guid, '') <> '' and coalesce(source.name, '') <> ''
  on conflict (company_id, tally_stock_item_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      name = excluded.name,
      current_stock_group_id = excluded.current_stock_group_id,
      default_uom_id = excluded.default_uom_id,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  insert into public.customers (
    company_id, tally_ledger_guid, tally_master_id, tally_alter_id, ledger_name,
    current_customer_group_id, tax_identifier, is_available, last_seen_at, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), source.ledger_name,
         customer_group.id, nullif(source.tax_identifier, ''), true, now(), coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result #> '{masters,customers}', '[]'::jsonb))
    as source(guid text, master_id text, alter_id text, ledger_name text, customer_group_guid text, tax_identifier text, source_payload jsonb)
  left join public.customer_groups customer_group
    on customer_group.company_id = p_company_id and customer_group.tally_group_guid = nullif(source.customer_group_guid, '')
  where coalesce(source.guid, '') <> '' and coalesce(source.ledger_name, '') <> ''
  on conflict (company_id, tally_ledger_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      ledger_name = excluded.ledger_name,
      current_customer_group_id = excluded.current_customer_group_id,
      tax_identifier = excluded.tax_identifier,
      is_available = true,
      last_seen_at = excluded.last_seen_at,
      source_payload = excluded.source_payload;

  -- A full, successful export is the only condition under which data absent
  -- from its source collection becomes unavailable.
  update public.customer_groups target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,customerGroups}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_group_guid
  );
  update public.tally_units target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,units}', '[]'::jsonb)) as source(code text)
    where source.code = target.code
  );
  update public.stock_groups target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,stockGroups}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_group_guid
  );
  update public.stock_items target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,stockItems}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_stock_item_guid
  );
  update public.tally_ledgers target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,ledgers}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_ledger_guid
  );
  update public.tally_voucher_types target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,voucherTypes}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_voucher_type_guid
  );
  update public.customers target set is_available = false
  where target.company_id = p_company_id and not exists (
    select 1 from jsonb_to_recordset(coalesce(p_result #> '{masters,customers}', '[]'::jsonb)) as source(guid text)
    where source.guid = target.tally_ledger_guid
  );

  received_count :=
    jsonb_array_length(coalesce(p_result #> '{masters,customerGroups}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,units}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,stockGroups}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,stockItems}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,ledgers}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,voucherTypes}', '[]'::jsonb)) +
    jsonb_array_length(coalesce(p_result #> '{masters,customers}', '[]'::jsonb));
  fingerprint := md5(p_result::text);

  update public.tally_sync_runs
  set status = 'completed', records_received = received_count, records_applied = received_count,
      records_failed = 0, source_fingerprint = fingerprint, error_summary = null,
      completed_at = now()
  where id = p_sync_run_id;

  return jsonb_build_object(
    'syncRunId', p_sync_run_id,
    'recordsReceived', received_count,
    'recordsApplied', received_count,
    'fingerprint', fingerprint,
    'alreadyApplied', false
  );
end;
$$;

revoke all on function public.apply_meenakshi_master_sync_result(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_meenakshi_master_sync_result(uuid, uuid, jsonb)
  to service_role;
