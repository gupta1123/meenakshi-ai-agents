-- Meenakshi repair: preserve a Phase 2 voucher sync when Tally voucher
-- numbers are repeated across voucher types. This is append-only because
-- 20260803000200_phase_2_voucher_sync_ingestion.sql has already been applied.
--
-- Tally's BILLALLOCATIONS.LIST can omit TARGETVOUCHERGUID and return only a
-- voucher number. Voucher numbers are not company-wide identifiers: for
-- example, a Purchase voucher and a Sales voucher can both be number "1".
-- Never turn that ambiguous source evidence into a guessed target link.

create or replace function public.apply_meenakshi_voucher_sync_result(
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
  next_cursor text;
  next_sync public.tally_sync_runs;
  company_organization_id uuid;
  next_scope jsonb;
  next_idempotency_key text;
begin
  select * into company_record
  from public.companies company
  where company.id = p_company_id and company.is_active;
  if not found then raise exception 'Company is unavailable'; end if;
  if coalesce(p_result -> 'activeCompany' ->> 'guid', '') <> company_record.tally_company_guid
     or lower(coalesce(p_result -> 'activeCompany' ->> 'name', '')) <> lower(company_record.tally_company_name) then
    raise exception 'Voucher sync active Tally company does not match the configured company';
  end if;
  if coalesce((p_result ->> 'complete')::boolean, false) is not true then
    raise exception 'Voucher synchronization requires a completed bridge result';
  end if;

  select * into sync_record
  from public.tally_sync_runs sync
  where sync.id = p_sync_run_id and sync.company_id = p_company_id and sync.sync_kind = 'vouchers'
  for update;
  if not found then raise exception 'Voucher sync run was not found'; end if;
  if sync_record.status in ('completed', 'completed_with_errors') then
    return jsonb_build_object('syncRunId', sync_record.id, 'recordsReceived', sync_record.records_received,
      'recordsApplied', sync_record.records_applied, 'fingerprint', sync_record.source_fingerprint, 'alreadyApplied', true);
  end if;
  if sync_record.status = 'failed' then raise exception 'Failed voucher sync runs cannot be applied'; end if;

  update public.tally_sync_runs
  set status = 'running', started_at = coalesce(started_at, now()), error_summary = null
  where id = p_sync_run_id;

  insert into public.tally_vouchers (
    company_id, tally_guid, tally_master_id, tally_alter_id, voucher_number,
    voucher_kind, voucher_type_id, voucher_date, party_customer_id, status,
    gross_amount, narration, last_seen_at, last_sync_run_id, source_payload
  )
  select p_company_id, source.guid, nullif(source.master_id, ''), nullif(source.alter_id, ''), nullif(source.voucher_number, ''),
         source.voucher_kind::public.tally_voucher_kind, voucher_type.id, source.voucher_date,
         customer.id, source.status::public.tally_voucher_status, source.gross_amount,
         nullif(source.narration, ''), now(), p_sync_run_id, coalesce(source.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(
    guid text, master_id text, alter_id text, voucher_number text, voucher_kind text,
    voucher_type_guid text, voucher_type_name text, voucher_date date, party_ledger_guid text, party_ledger_name text, status text,
    gross_amount numeric, narration text, linked_sales_voucher_guid text,
    inventory_lines jsonb, bill_allocations jsonb, source_payload jsonb
  )
  left join lateral (
    select candidate.id
    from public.tally_voucher_types candidate
    where candidate.company_id = p_company_id
      and (candidate.tally_voucher_type_guid = nullif(source.voucher_type_guid, '')
        or (nullif(source.voucher_type_guid, '') is null and candidate.name = nullif(source.voucher_type_name, '')))
    order by case when candidate.tally_voucher_type_guid = nullif(source.voucher_type_guid, '') then 0 else 1 end
    limit 1
  ) voucher_type on true
  left join lateral (
    select candidate.id
    from public.customers candidate
    where candidate.company_id = p_company_id
      and (candidate.tally_ledger_guid = nullif(source.party_ledger_guid, '')
        or (nullif(source.party_ledger_guid, '') is null and candidate.ledger_name = nullif(source.party_ledger_name, '')))
    order by case when candidate.tally_ledger_guid = nullif(source.party_ledger_guid, '') then 0 else 1 end
    limit 1
  ) customer on true
  where coalesce(source.guid, '') <> '' and source.voucher_date is not null
    and source.voucher_kind in ('sales', 'receipt', 'sales_return', 'debit_note', 'credit_note', 'other')
    and source.status in ('posted', 'cancelled', 'optional', 'reversed')
  on conflict (company_id, tally_guid) do update
  set tally_master_id = excluded.tally_master_id,
      tally_alter_id = excluded.tally_alter_id,
      voucher_number = excluded.voucher_number,
      voucher_kind = excluded.voucher_kind,
      voucher_type_id = excluded.voucher_type_id,
      voucher_date = excluded.voucher_date,
      party_customer_id = excluded.party_customer_id,
      status = excluded.status,
      gross_amount = excluded.gross_amount,
      narration = excluded.narration,
      last_seen_at = excluded.last_seen_at,
      last_sync_run_id = excluded.last_sync_run_id,
      source_payload = excluded.source_payload;

  update public.tally_vouchers voucher
  set linked_sales_voucher_id = linked.id
  from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text, linked_sales_voucher_guid text)
  left join public.tally_vouchers linked
    on linked.company_id = p_company_id and linked.tally_guid = nullif(source.linked_sales_voucher_guid, '')
  where voucher.company_id = p_company_id
    and voucher.tally_guid = source.guid;

  insert into public.tally_voucher_inventory_lines (
    company_id, voucher_id, line_number, stock_item_id, stock_group_id,
    stock_item_name_snapshot, stock_group_name_snapshot, source_uom_id, source_uom_code_snapshot,
    quantity, taxable_product_value, freight_value, non_product_value, line_category,
    quantity_is_reliable, source_payload, is_available
  )
  select p_company_id, voucher.id, line.line_number, stock_item.id, stock_group.id,
         nullif(line.stock_item_name, ''), nullif(line.stock_group_name, ''), unit.id, nullif(line.uom_code, ''),
         line.quantity, line.taxable_product_value, line.freight_value, line.non_product_value,
         line.line_category, coalesce(line.quantity_is_reliable, true), coalesce(line.source_payload, '{}'::jsonb), true
  from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text, inventory_lines jsonb)
  join public.tally_vouchers voucher on voucher.company_id = p_company_id and voucher.tally_guid = source.guid
  cross join lateral jsonb_to_recordset(coalesce(source.inventory_lines, '[]'::jsonb)) as line(
    line_number integer, stock_item_guid text, stock_group_guid text, stock_item_name text, stock_group_name text,
    uom_code text, quantity numeric, taxable_product_value numeric, freight_value numeric, non_product_value numeric,
    line_category text, quantity_is_reliable boolean, source_payload jsonb
  )
  left join lateral (
    select candidate.id
    from public.stock_items candidate
    where candidate.company_id = p_company_id
      and (candidate.tally_stock_item_guid = nullif(line.stock_item_guid, '')
        or (nullif(line.stock_item_guid, '') is null and candidate.name = nullif(line.stock_item_name, '')))
    order by case when candidate.tally_stock_item_guid = nullif(line.stock_item_guid, '') then 0 else 1 end
    limit 1
  ) stock_item on true
  left join lateral (
    select candidate.id
    from public.stock_groups candidate
    where candidate.company_id = p_company_id
      and (candidate.tally_group_guid = nullif(line.stock_group_guid, '')
        or (nullif(line.stock_group_guid, '') is null and candidate.name = nullif(line.stock_group_name, '')))
    order by case when candidate.tally_group_guid = nullif(line.stock_group_guid, '') then 0 else 1 end
    limit 1
  ) stock_group on true
  left join public.tally_units unit on unit.company_id = p_company_id and unit.code = nullif(line.uom_code, '')
  where line.line_number > 0
    and line.line_category in ('inventory', 'freight', 'non_product', 'other')
  on conflict (voucher_id, line_number) do update
  set stock_item_id = excluded.stock_item_id,
      stock_group_id = excluded.stock_group_id,
      stock_item_name_snapshot = excluded.stock_item_name_snapshot,
      stock_group_name_snapshot = excluded.stock_group_name_snapshot,
      source_uom_id = excluded.source_uom_id,
      source_uom_code_snapshot = excluded.source_uom_code_snapshot,
      quantity = excluded.quantity,
      taxable_product_value = excluded.taxable_product_value,
      freight_value = excluded.freight_value,
      non_product_value = excluded.non_product_value,
      line_category = excluded.line_category,
      quantity_is_reliable = excluded.quantity_is_reliable,
      source_payload = excluded.source_payload,
      is_available = true;

  update public.tally_voucher_inventory_lines line
  set is_available = false
  where line.company_id = p_company_id
    and exists (
      select 1 from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text)
      join public.tally_vouchers voucher on voucher.company_id = p_company_id and voucher.tally_guid = source.guid
      where voucher.id = line.voucher_id
    )
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text, inventory_lines jsonb)
      join public.tally_vouchers voucher on voucher.company_id = p_company_id and voucher.tally_guid = source.guid
      cross join lateral jsonb_to_recordset(coalesce(source.inventory_lines, '[]'::jsonb)) as expected(line_number integer)
      where voucher.id = line.voucher_id and expected.line_number = line.line_number
    );

  insert into public.tally_bill_allocations (
    company_id, source_voucher_id, target_voucher_id, tally_allocation_key, bill_reference,
    allocation_type, allocation_date, allocated_amount, is_available, source_payload
  )
  select p_company_id, source_voucher.id, target_voucher.id, allocation.allocation_key,
         nullif(allocation.bill_reference, ''), allocation.allocation_type::public.bill_allocation_type,
         allocation.allocation_date, allocation.allocated_amount, true, coalesce(allocation.source_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text, bill_allocations jsonb)
  join public.tally_vouchers source_voucher on source_voucher.company_id = p_company_id and source_voucher.tally_guid = source.guid
  cross join lateral jsonb_to_recordset(coalesce(source.bill_allocations, '[]'::jsonb)) as allocation(
    allocation_key text, bill_reference text, allocation_type text, allocation_date date, allocated_amount numeric,
    target_voucher_guid text, target_voucher_number text, source_payload jsonb
  )
  left join lateral (
    select candidate.id
    from public.tally_vouchers candidate
    where candidate.company_id = p_company_id
      and (
        candidate.tally_guid = nullif(allocation.target_voucher_guid, '')
        or (
          nullif(allocation.target_voucher_guid, '') is null
          and allocation.allocation_type = 'agst_ref'
          and candidate.voucher_kind = 'sales'
          and candidate.voucher_number = nullif(allocation.target_voucher_number, '')
          and 1 = (
            select count(*)
            from public.tally_vouchers possible
            where possible.company_id = p_company_id
              and possible.voucher_kind = 'sales'
              and possible.voucher_number = nullif(allocation.target_voucher_number, '')
          )
        )
      )
    order by case when candidate.tally_guid = nullif(allocation.target_voucher_guid, '') then 0 else 1 end,
             candidate.voucher_date desc, candidate.created_at desc
    limit 1
  ) target_voucher on true
  where coalesce(allocation.allocation_key, '') <> ''
    and allocation.allocation_date is not null
    and allocation.allocated_amount > 0
    and allocation.allocation_type in ('agst_ref', 'new_ref', 'on_account', 'advance', 'other')
  on conflict (source_voucher_id, tally_allocation_key) do update
  set target_voucher_id = excluded.target_voucher_id,
      bill_reference = excluded.bill_reference,
      allocation_type = excluded.allocation_type,
      allocation_date = excluded.allocation_date,
      allocated_amount = excluded.allocated_amount,
      is_available = true,
      source_payload = excluded.source_payload;

  update public.tally_bill_allocations allocation
  set is_available = false
  where allocation.company_id = p_company_id
    and exists (
      select 1 from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text)
      join public.tally_vouchers voucher on voucher.company_id = p_company_id and voucher.tally_guid = source.guid
      where voucher.id = allocation.source_voucher_id
    )
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text, bill_allocations jsonb)
      join public.tally_vouchers voucher on voucher.company_id = p_company_id and voucher.tally_guid = source.guid
      cross join lateral jsonb_to_recordset(coalesce(source.bill_allocations, '[]'::jsonb)) as expected(allocation_key text)
      where voucher.id = allocation.source_voucher_id and expected.allocation_key = allocation.tally_allocation_key
    );

  update public.tally_vouchers voucher
  set taxable_product_value = coalesce((
    select sum(line.taxable_product_value)
    from public.tally_voucher_inventory_lines line
    where line.voucher_id = voucher.id and line.is_available and line.line_category = 'inventory'
  ), 0)
  where voucher.company_id = p_company_id
    and exists (select 1 from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(guid text) where source.guid = voucher.tally_guid);

  received_count := jsonb_array_length(coalesce(p_result -> 'vouchers', '[]'::jsonb))
    + coalesce((select sum(jsonb_array_length(coalesce(source.inventory_lines, '[]'::jsonb)))
      from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(inventory_lines jsonb)), 0)
    + coalesce((select sum(jsonb_array_length(coalesce(source.bill_allocations, '[]'::jsonb)))
      from jsonb_to_recordset(coalesce(p_result -> 'vouchers', '[]'::jsonb)) as source(bill_allocations jsonb)), 0);
  fingerprint := md5(p_result::text);
  next_cursor := nullif(p_result ->> 'cursorTo', '');

  if next_cursor is not null then
    select organization_id into company_organization_id
    from public.companies where id = p_company_id;
    next_scope := sync_record.requested_scope || jsonb_build_object('cursor', next_cursor);
    next_idempotency_key := format('tally-voucher-chunk:%s:%s', p_sync_run_id, next_cursor);
    insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
    values (p_company_id, 'vouchers', 'queued', next_scope)
    returning * into next_sync;
    insert into public.integration_outbox (
      event_key, event_type, aggregate_type, aggregate_id, payload,
      organization_id, company_id, correlation_id, idempotency_key
    ) values (
      format('meenakshi-sync:%s:%s', p_company_id, next_idempotency_key),
      'tally_vouchers_sync', 'tally_sync_run', next_sync.id,
      jsonb_build_object('syncRunId', next_sync.id, 'syncKind', 'vouchers', 'requestedScope', next_scope),
      company_organization_id, p_company_id, gen_random_uuid(), next_idempotency_key
    );
  end if;

  update public.tally_sync_runs
  set status = 'completed', records_received = received_count, records_applied = received_count,
      records_failed = 0, cursor_from = nullif(p_result ->> 'cursorFrom', ''), cursor_to = nullif(p_result ->> 'cursorTo', ''),
      source_fingerprint = fingerprint, error_summary = null, completed_at = now()
  where id = p_sync_run_id;

  return jsonb_build_object('syncRunId', p_sync_run_id, 'recordsReceived', received_count,
    'recordsApplied', received_count, 'fingerprint', fingerprint, 'alreadyApplied', false,
    'nextSyncRunId', next_sync.id, 'nextCursor', next_cursor);
end;
$$;

revoke all on function public.apply_meenakshi_voucher_sync_result(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_meenakshi_voucher_sync_result(uuid, uuid, jsonb)
  to service_role;

do $$
declare
  definition text;
begin
  select pg_get_functiondef(procedure.oid) into definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'apply_meenakshi_voucher_sync_result'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_sync_run_id uuid, p_company_id uuid, p_result jsonb';

  if definition is null
     or position('allocation.allocation_type = ''agst_ref''' in definition) = 0
     or position('target_by_number' in definition) > 0 then
    raise exception 'Voucher allocation reference repair was not installed';
  end if;
end;
$$;
