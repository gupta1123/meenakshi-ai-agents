-- Meenakshi Phase 5 repair: retain Phase 2 master/voucher dispatch mappings.
--
-- Phase 5 enriches Credit Note command payloads. Its dispatcher replacement
-- must also preserve the Phase 2 synchronization command mappings; otherwise
-- a live master/voucher outbox event is retried until dead-lettered without
-- ever reaching the paired bridge.
--
-- This is intentionally append-only because the Phase 5 migration has already
-- been applied to the controlled environment.

create or replace function public.dispatch_outbox_to_tally_command(
  p_outbox_id uuid,
  p_connector_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  outbox_record public.integration_outbox;
  company_record public.companies;
  command_id uuid;
  mapped_command_type text;
  command_payload jsonb;
  posting_id uuid;
  expected_company_guid text;
  expected_company_name text;
begin
  select * into outbox_record
  from public.integration_outbox outbox
  where outbox.id = p_outbox_id and outbox.status = 'processing'
  for update;
  if not found then raise exception 'Outbox event must be claimed before dispatch'; end if;

  select * into company_record from public.companies company where company.id = outbox_record.company_id;
  if not exists (
    select 1 from public.tally_connector_company_bindings binding
    join public.tally_connectors connector on connector.id = binding.connector_id
    where binding.connector_id = p_connector_id and binding.company_id = outbox_record.company_id
      and binding.organization_id = outbox_record.organization_id and binding.is_active
      and connector.status = 'paired'
  ) then raise exception 'No active paired connector is bound to the outbox company'; end if;

  mapped_command_type := case outbox_record.event_type
    when 'tally_masters_sync' then 'sync_meenakshi_masters'
    when 'tally_vouchers_sync' then 'sync_meenakshi_vouchers'
    when 'tally_credit_note_create' then 'create_credit_note'
    when 'tally_credit_note_verify' then 'verify_credit_note'
    when 'tally_credit_note_pdf' then 'export_credit_note_pdf'
    when 'tally_targeted_refresh' then 'fetch_meenakshi_evidence'
    else null
  end;
  if mapped_command_type is null then raise exception 'Outbox event % is not a Tally command', outbox_record.event_type; end if;

  posting_id := nullif(outbox_record.payload ->> 'creditNotePostingId', '')::uuid;
  command_payload := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf')
      then public.meenakshi_credit_note_command_payload(posting_id)
    else outbox_record.payload
  end;
  expected_company_guid := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf') then command_payload #>> '{creditNote,company,guid}'
    else company_record.tally_company_guid
  end;
  expected_company_name := case
    when mapped_command_type in ('create_credit_note', 'verify_credit_note', 'export_credit_note_pdf') then command_payload #>> '{creditNote,company,name}'
    else company_record.tally_company_name
  end;

  insert into public.tally_commands (
    organization_id, company_id, connector_id, source_outbox_id, command_type,
    business_idempotency_key, correlation_id, expected_tally_company_guid,
    expected_tally_company_name, payload
  ) values (
    outbox_record.organization_id, outbox_record.company_id, p_connector_id,
    outbox_record.id, mapped_command_type, outbox_record.idempotency_key,
    outbox_record.correlation_id, expected_company_guid,
    expected_company_name, command_payload
  ) on conflict (company_id, business_idempotency_key)
  do update set updated_at = excluded.updated_at
  returning id into command_id;

  if mapped_command_type = 'create_credit_note' then
    update public.credit_note_postings
    set status = 'sending', updated_at = now(), failure_reason = null
    where id = posting_id and status = 'queued';

    insert into public.credit_note_posting_attempts (
      credit_note_posting_id, attempt_number, command_key, command_status,
      command_payload
    ) values (
      posting_id,
      coalesce((select max(attempt_number) + 1 from public.credit_note_posting_attempts where credit_note_posting_id = posting_id), 1),
      outbox_record.idempotency_key, 'sending', command_payload
    ) on conflict (command_key) do nothing;
  end if;

  update public.integration_outbox
  set status = 'completed', completed_at = now(), locked_at = null,
      locked_by = null, lease_expires_at = null
  where id = outbox_record.id;
  return command_id;
end;
$$;

-- Guards this exact regression in the deployment smoke check. The function
-- definition must retain Phase 2 sync mappings alongside Phase 5 Credit Note
-- mappings whenever a later migration replaces the dispatcher.
do $$
declare
  definition text;
begin
  select pg_get_functiondef('public.dispatch_outbox_to_tally_command(uuid, uuid)'::regprocedure)
    into definition;
  if position('tally_masters_sync' in definition) = 0
     or position('sync_meenakshi_masters' in definition) = 0
     or position('tally_vouchers_sync' in definition) = 0
     or position('sync_meenakshi_vouchers' in definition) = 0 then
    raise exception 'Tally master/voucher dispatch mappings must remain enabled';
  end if;
end;
$$;
