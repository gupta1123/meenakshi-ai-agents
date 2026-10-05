-- Meenakshi Phase 2: durable master/voucher synchronization requests.
--
-- This migration is append-only. It extends the already-applied Phase 1
-- outbox/command model without changing historical migrations.

alter table public.integration_outbox
  drop constraint if exists integration_outbox_event_type_check;

alter table public.integration_outbox
  add constraint integration_outbox_event_type_check
  check (event_type in (
    'tally_credit_note_create',
    'tally_credit_note_verify',
    'tally_credit_note_pdf',
    'msg91_notification_send',
    'tally_targeted_refresh',
    'tally_masters_sync',
    'tally_vouchers_sync'
  ));

create or replace function public.claim_tally_integration_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.integration_outbox
language sql
set search_path = ''
as $$
  with candidates as (
    select outbox.id
    from public.integration_outbox outbox
    where outbox.event_type in (
        'tally_credit_note_create',
        'tally_credit_note_verify',
        'tally_credit_note_pdf',
        'tally_targeted_refresh',
        'tally_masters_sync',
        'tally_vouchers_sync'
      )
      and outbox.attempts < outbox.max_attempts
      and (
        (outbox.status in ('pending', 'failed') and outbox.available_at <= now())
        or (outbox.status = 'processing' and outbox.lease_expires_at < now())
      )
    order by outbox.available_at, outbox.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.integration_outbox outbox
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(10, p_lease_seconds)),
      attempts = outbox.attempts + 1,
      updated_at = now()
  from candidates
  where outbox.id = candidates.id
  returning outbox.*;
$$;

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
begin
  select * into outbox_record
  from public.integration_outbox outbox
  where outbox.id = p_outbox_id
    and outbox.status = 'processing'
  for update;

  if not found then
    raise exception 'Outbox event must be claimed before dispatch';
  end if;

  select * into company_record
  from public.companies company
  where company.id = outbox_record.company_id;

  if not exists (
    select 1
    from public.tally_connector_company_bindings binding
    join public.tally_connectors connector on connector.id = binding.connector_id
    where binding.connector_id = p_connector_id
      and binding.company_id = outbox_record.company_id
      and binding.organization_id = outbox_record.organization_id
      and binding.is_active
      and connector.status = 'paired'
  ) then
    raise exception 'No active paired connector is bound to the outbox company';
  end if;

  mapped_command_type := case outbox_record.event_type
    when 'tally_masters_sync' then 'sync_meenakshi_masters'
    when 'tally_vouchers_sync' then 'sync_meenakshi_vouchers'
    when 'tally_credit_note_create' then 'create_credit_note'
    when 'tally_credit_note_verify' then 'verify_credit_note'
    when 'tally_credit_note_pdf' then 'export_credit_note_pdf'
    when 'tally_targeted_refresh' then 'fetch_meenakshi_evidence'
    else null
  end;

  if mapped_command_type is null then
    raise exception 'Outbox event % is not a Tally command', outbox_record.event_type;
  end if;

  insert into public.tally_commands (
    organization_id, company_id, connector_id, source_outbox_id,
    command_type, business_idempotency_key, correlation_id,
    expected_tally_company_guid, expected_tally_company_name, payload
  ) values (
    outbox_record.organization_id, outbox_record.company_id, p_connector_id,
    outbox_record.id, mapped_command_type, outbox_record.idempotency_key,
    outbox_record.correlation_id, company_record.tally_company_guid,
    company_record.tally_company_name, outbox_record.payload
  )
  on conflict (company_id, business_idempotency_key)
  do update set updated_at = excluded.updated_at
  returning id into command_id;

  update public.integration_outbox
  set status = 'completed', completed_at = now(),
      locked_at = null, locked_by = null, lease_expires_at = null
  where id = outbox_record.id;

  return command_id;
end;
$$;

create or replace function public.request_meenakshi_tally_sync(
  p_organization_id uuid,
  p_company_id uuid,
  p_sync_kind public.sync_kind,
  p_requested_scope jsonb,
  p_idempotency_key text
)
returns public.tally_sync_runs
language plpgsql
set search_path = ''
as $$
declare
  existing_sync public.tally_sync_runs;
  created_sync public.tally_sync_runs;
  event_type text;
  correlation uuid := gen_random_uuid();
begin
  if p_sync_kind not in ('masters', 'vouchers') then
    raise exception 'Only masters and vouchers are valid explicit Meenakshi sync kinds';
  end if;
  if coalesce(length(btrim(p_idempotency_key)), 0) = 0 then
    raise exception 'A sync idempotency key is required';
  end if;
  if not exists (
    select 1 from public.companies company
    where company.id = p_company_id
      and company.organization_id = p_organization_id
      and company.is_active
  ) then
    raise exception 'Company is unavailable to this organization';
  end if;

  select sync.* into existing_sync
  from public.integration_outbox outbox
  join public.tally_sync_runs sync
    on sync.id = nullif(outbox.payload ->> 'syncRunId', '')::uuid
  where outbox.company_id = p_company_id
    and outbox.idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return existing_sync;
  end if;

  event_type := case p_sync_kind
    when 'masters' then 'tally_masters_sync'
    when 'vouchers' then 'tally_vouchers_sync'
  end;

  insert into public.tally_sync_runs (company_id, sync_kind, status, requested_scope)
  values (p_company_id, p_sync_kind, 'queued', coalesce(p_requested_scope, '{}'::jsonb))
  returning * into created_sync;

  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload,
    organization_id, company_id, correlation_id, idempotency_key
  ) values (
    format('meenakshi-sync:%s:%s', p_company_id, p_idempotency_key),
    event_type,
    'tally_sync_run',
    created_sync.id,
    jsonb_build_object(
      'syncRunId', created_sync.id,
      'syncKind', p_sync_kind,
      'requestedScope', created_sync.requested_scope
    ),
    p_organization_id,
    p_company_id,
    correlation,
    p_idempotency_key
  );

  return created_sync;
end;
$$;

revoke all on function public.request_meenakshi_tally_sync(uuid, uuid, public.sync_kind, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.request_meenakshi_tally_sync(uuid, uuid, public.sync_kind, jsonb, text)
  to service_role;
