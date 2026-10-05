-- Product-policy update confirmed on 25 Aug 2026:
--   1. An open Cash Discount invoice may receive a reminder before 80% payment.
--   2. A Turnover Discount customer may receive one update for each tier reached.
--
-- This deliberately does not enqueue historical rows on migration. A message
-- is created only by a future evaluation write, after a current approved
-- template and recorded customer consent are available.

alter table public.whatsapp_templates
  drop constraint if exists whatsapp_templates_event_type_check;
alter table public.whatsapp_templates
  add constraint whatsapp_templates_event_type_check
  check (event_type in ('cd_shortfall', 'cd_credit_note_created', 'tod_tier_reached', 'tod_credit_note_created'));

alter table public.notification_messages
  drop constraint if exists notification_messages_event_type_check;
alter table public.notification_messages
  add constraint notification_messages_event_type_check
  check (event_type in ('cd_shortfall', 'cd_credit_note_created', 'tod_tier_reached', 'tod_credit_note_created'));

-- Keep database validation as the final safeguard; API checks alone are not
-- sufficient because triggers and workers can also create notification rows.
create or replace function public.validate_notification_message()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  requires_send_validation boolean;
  is_currently_opted_in boolean;
  current_opt_in_snapshot jsonb;
  current_template_snapshot jsonb;
begin
  if tg_op = 'UPDATE' and (
    new.company_id <> old.company_id
    or new.proposal_id <> old.proposal_id
    or new.customer_contact_id <> old.customer_contact_id
    or new.whatsapp_template_id <> old.whatsapp_template_id
    or new.event_type <> old.event_type
    or new.business_event_key <> old.business_event_key
    or new.credit_note_posting_id is distinct from old.credit_note_posting_id
    or new.resend_of_notification_id is distinct from old.resend_of_notification_id
  ) then
    raise exception 'Message identity and frozen business evidence cannot change after creation';
  end if;

  if tg_op = 'UPDATE' and new.status <> old.status then
    if not (
      (old.status = 'queued' and new.status in ('sending', 'failed', 'suppressed', 'cancelled'))
      or (old.status = 'sending' and new.status in ('sent', 'failed', 'suppressed'))
      or (old.status = 'sent' and new.status in ('delivered', 'read', 'failed'))
      or (old.status = 'delivered' and new.status = 'read')
      or (old.status = 'failed' and new.status in ('queued', 'sending', 'suppressed', 'cancelled'))
    ) then
      raise exception 'Invalid notification status transition: % to %', old.status, new.status;
    end if;
  end if;

  requires_send_validation := tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and new.status = 'sending' and old.status <> 'sending');

  if requires_send_validation then
    if not exists (
      select 1
      from public.companies company
      join public.discount_proposals proposal
        on proposal.id = new.proposal_id and proposal.company_id = company.id
      join public.customer_contacts contact
        on contact.id = new.customer_contact_id
       and contact.company_id = company.id
       and contact.customer_id = proposal.customer_id
       and contact.is_active
      join public.whatsapp_templates template
        on template.id = new.whatsapp_template_id
       and template.organization_id = company.organization_id
       and template.event_type = new.event_type
       and template.is_active
      where company.id = new.company_id
    ) then
      raise exception 'Active template, recipient, proposal, and company must belong to the same organization and customer';
    end if;

    select true, jsonb_build_object(
      'optInId', opt_in.id, 'recordedAt', opt_in.recorded_at,
      'source', opt_in.source, 'evidence', opt_in.evidence
    ) into is_currently_opted_in, current_opt_in_snapshot
    from public.whatsapp_opt_ins opt_in
    where opt_in.customer_contact_id = new.customer_contact_id
      and opt_in.is_opted_in and opt_in.revoked_at is null
    order by opt_in.recorded_at desc
    limit 1;
    if not coalesce(is_currently_opted_in, false) then
      raise exception 'Sending a WhatsApp message requires a current recorded opt-in';
    end if;

    select jsonb_build_object(
      'templateId', template.id, 'provider', template.provider_name,
      'providerTemplateId', template.provider_template_id,
      'eventType', template.event_type, 'languageCode', template.language_code,
      'namespace', template.template_namespace, 'version', template.template_version,
      'componentSchema', template.component_schema
    ) into current_template_snapshot
    from public.whatsapp_templates template
    where template.id = new.whatsapp_template_id;
    if tg_op = 'INSERT' then
      new.opt_in_snapshot := current_opt_in_snapshot;
      new.template_snapshot := current_template_snapshot;
    end if;

    if new.event_type = 'cd_shortfall' and not exists (
      select 1 from public.discount_proposals proposal
      where proposal.id = new.proposal_id and proposal.company_id = new.company_id
        and proposal.scheme_type = 'cd'
        and proposal.status in ('unpaid', 'partially_paid', 'near_eligibility')
        and proposal.shortfall_amount > 0
        and proposal.eligibility_deadline >= current_date
    ) then
      raise exception 'Cash Discount reminders require a current open invoice with a positive amount still to settle';
    end if;

    if new.event_type = 'tod_tier_reached' and not exists (
      select 1 from public.discount_proposals proposal
      where proposal.id = new.proposal_id and proposal.company_id = new.company_id
        and proposal.scheme_type = 'tod'
        and proposal.status in ('tracking', 'eligible')
        and proposal.achieved_tier_id is not null
    ) then
      raise exception 'Turnover Discount tier messages require a current valid evaluation with a reached tier';
    end if;

    if new.event_type in ('cd_credit_note_created', 'tod_credit_note_created') and (
      new.credit_note_posting_id is null or not exists (
        select 1 from public.credit_note_postings posting
        where posting.id = new.credit_note_posting_id
          and posting.proposal_id = new.proposal_id
          and posting.company_id = new.company_id
          and posting.status = 'created_verified'
      )
    ) then
      raise exception 'Credit Note messages require a verified Tally Credit Note';
    end if;

    if new.resend_of_notification_id is not null and not exists (
      select 1 from public.notification_messages original
      where original.id = new.resend_of_notification_id
        and original.company_id = new.company_id
        and original.proposal_id = new.proposal_id
        and original.customer_contact_id = new.customer_contact_id
        and original.event_type = new.event_type
    ) then
      raise exception 'A resend must reference a message for the same company, proposal, recipient, and event';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enqueue_phase_6_notification(
  p_company_id uuid,
  p_proposal_id uuid,
  p_event_type text,
  p_credit_note_posting_id uuid default null,
  p_created_by uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  proposal_record public.discount_proposals;
  company_record public.companies;
  contact_record public.customer_contacts;
  template_record public.whatsapp_templates;
  posting_record public.credit_note_postings;
  customer_name text;
  invoice_reference text;
  event_key text;
  payload jsonb;
  message_id uuid;
begin
  select proposal.* into proposal_record
  from public.discount_proposals proposal
  where proposal.id = p_proposal_id and proposal.company_id = p_company_id;
  if not found then raise exception 'Proposal was not found for company'; end if;

  if p_event_type not in ('cd_shortfall', 'cd_credit_note_created', 'tod_tier_reached', 'tod_credit_note_created') then
    raise exception 'Unsupported notification event type';
  end if;
  if (p_event_type = 'cd_shortfall' and (
        proposal_record.scheme_type <> 'cd'
        or proposal_record.status not in ('unpaid', 'partially_paid', 'near_eligibility')
        or proposal_record.shortfall_amount <= 0
        or proposal_record.eligibility_deadline < current_date
      ))
     or (p_event_type = 'tod_tier_reached' and (
        proposal_record.scheme_type <> 'tod'
        or proposal_record.status not in ('tracking', 'eligible')
        or proposal_record.achieved_tier_id is null
      ))
     or (p_event_type = 'cd_credit_note_created' and proposal_record.scheme_type <> 'cd')
     or (p_event_type = 'tod_credit_note_created' and proposal_record.scheme_type <> 'tod') then
    return null;
  end if;

  select * into company_record from public.companies where id = p_company_id;
  select * into contact_record
  from public.customer_contacts contact
  where contact.company_id = p_company_id and contact.customer_id = proposal_record.customer_id
    and contact.is_active
  order by contact.is_primary desc, contact.entered_at asc, contact.id asc
  limit 1;
  if not found or not exists (
    select 1 from public.whatsapp_opt_ins opt_in
    where opt_in.company_id = p_company_id and opt_in.customer_contact_id = contact_record.id
      and opt_in.is_opted_in and opt_in.revoked_at is null
  ) then return null; end if;

  select * into template_record from public.whatsapp_templates template
  where template.organization_id = company_record.organization_id
    and template.event_type = p_event_type and template.is_active
  limit 1;
  if not found then return null; end if;

  select coalesce(nullif(contact_record.contact_name, ''), customer.ledger_name, 'Customer')
    into customer_name
  from public.customers customer where customer.id = proposal_record.customer_id and customer.company_id = p_company_id;
  select coalesce(voucher.voucher_number, voucher.tally_guid, proposal_record.source_sales_voucher_id::text, '')
    into invoice_reference
  from public.tally_vouchers voucher
  where voucher.id = proposal_record.source_sales_voucher_id and voucher.company_id = p_company_id;

  if p_event_type = 'cd_shortfall' then
    event_key := 'phase6:cd_shortfall:' || proposal_record.id::text;
    payload := jsonb_build_object(
      'customerName', customer_name, 'companyName', company_record.tally_company_name,
      'invoiceReference', coalesce(invoice_reference, ''),
      'paidAmount', proposal_record.amount_paid_by_deadline,
      'benefitAmount', proposal_record.calculated_discount_amount,
      'shortfallAmount', proposal_record.shortfall_amount,
      'eligibilityDeadline', proposal_record.eligibility_deadline,
      'eventType', p_event_type
    );
  elsif p_event_type = 'tod_tier_reached' then
    event_key := 'phase6:tod_tier_reached:' || proposal_record.id::text || ':' || proposal_record.achieved_tier_id::text;
    payload := jsonb_build_object(
      'customerName', customer_name, 'companyName', company_record.tally_company_name,
      'todTierId', proposal_record.achieved_tier_id,
      'todTierPercentage', proposal_record.discount_percentage,
      'todPeriodStart', proposal_record.period_start,
      'todPeriodEnd', proposal_record.period_end,
      'todTonnes', proposal_record.eligible_tonnes,
      'benefitAmount', proposal_record.calculated_discount_amount,
      'eventType', p_event_type
    );
  else
    select posting.* into posting_record from public.credit_note_postings posting
    where posting.id = p_credit_note_posting_id and posting.company_id = p_company_id
      and posting.proposal_id = proposal_record.id and posting.status = 'created_verified';
    if not found then return null; end if;
    event_key := 'phase6:credit_note:' || posting_record.id::text;
    payload := jsonb_build_object(
      'customerName', customer_name, 'companyName', company_record.tally_company_name,
      'creditNoteNumber', posting_record.verified_voucher_number,
      'creditNoteDate', posting_record.credit_note_date,
      'creditNoteAmount', posting_record.verified_amount,
      'invoiceReference', coalesce(invoice_reference, posting_record.tally_bill_reference, ''),
      'todPeriodStart', proposal_record.period_start,
      'todPeriodEnd', proposal_record.period_end,
      'todTonnes', proposal_record.eligible_tonnes,
      'todTierId', proposal_record.achieved_tier_id,
      'documentStoragePath', posting_record.document_storage_path,
      'eventType', p_event_type
    );
  end if;

  insert into public.notification_messages (
    company_id, proposal_id, credit_note_posting_id, customer_contact_id,
    whatsapp_template_id, event_type, business_event_key, recipient_phone_e164,
    payload, opt_in_snapshot, status, scheduled_for, available_at, created_by
  ) values (
    p_company_id, proposal_record.id, p_credit_note_posting_id, contact_record.id,
    template_record.id, p_event_type, event_key, contact_record.phone_e164,
    payload, '{}'::jsonb, 'queued', now(), now(), p_created_by
  ) on conflict (business_event_key) do update
    set updated_at = public.notification_messages.updated_at
  returning id into message_id;
  return message_id;
end;
$$;

create or replace function public.phase_6_enqueue_shortfall_reminder_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scheme_type = 'cd'
     and new.status in ('unpaid', 'partially_paid', 'near_eligibility')
     and new.shortfall_amount > 0
     and new.eligibility_deadline >= current_date then
    perform public.enqueue_phase_6_notification(new.company_id, new.id, 'cd_shortfall', null, null);
  end if;
  return new;
end;
$$;

drop trigger if exists phase_6_enqueue_shortfall_reminder on public.discount_proposals;
create trigger phase_6_enqueue_shortfall_reminder
  after insert or update of status, shortfall_amount, eligibility_deadline on public.discount_proposals
  for each row execute function public.phase_6_enqueue_shortfall_reminder_trigger();

create or replace function public.phase_6_enqueue_tod_tier_reached_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scheme_type = 'tod'
     and new.status in ('tracking', 'eligible')
     and new.achieved_tier_id is not null then
    perform public.enqueue_phase_6_notification(new.company_id, new.id, 'tod_tier_reached', null, null);
  end if;
  return new;
end;
$$;

drop trigger if exists phase_6_enqueue_tod_tier_reached on public.discount_proposals;
create trigger phase_6_enqueue_tod_tier_reached
  after insert or update of status, achieved_tier_id, discount_percentage, eligible_tonnes, calculated_discount_amount on public.discount_proposals
  for each row execute function public.phase_6_enqueue_tod_tier_reached_trigger();

-- Re-check policy immediately before a worker claims a queued row. This
-- prevents a delayed message from being sent after expiry, lost consent, or a
-- removed TOD tier.
create or replace function public.claim_phase_6_notification_messages(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 90
)
returns setof public.notification_messages
language sql
set search_path = ''
as $$
  with suppressed as (
    update public.notification_messages message
    set status = 'suppressed',
        failure_reason = 'Notification suppressed because consent or current business eligibility is no longer valid.',
        locked_at = null, locked_by = null, lease_expires_at = null, updated_at = now()
    where message.status in ('queued', 'failed', 'sending')
      and (
        not exists (
          select 1
          from public.companies company
          join public.discount_proposals proposal
            on proposal.id = message.proposal_id and proposal.company_id = company.id
          join public.customer_contacts contact
            on contact.id = message.customer_contact_id and contact.company_id = company.id
             and contact.customer_id = proposal.customer_id and contact.is_active
          join public.whatsapp_templates template
            on template.id = message.whatsapp_template_id
             and template.organization_id = company.organization_id
             and template.event_type = message.event_type and template.is_active
          where company.id = message.company_id
        )
        or not exists (
          select 1 from public.whatsapp_opt_ins opt_in
          where opt_in.company_id = message.company_id
            and opt_in.customer_contact_id = message.customer_contact_id
            and opt_in.is_opted_in and opt_in.revoked_at is null
        )
        or (message.event_type = 'cd_shortfall' and not exists (
          select 1 from public.discount_proposals proposal
          where proposal.id = message.proposal_id and proposal.company_id = message.company_id
            and proposal.scheme_type = 'cd'
            and proposal.status in ('unpaid', 'partially_paid', 'near_eligibility')
            and proposal.shortfall_amount > 0
            and proposal.eligibility_deadline >= current_date
        ))
        or (message.event_type = 'tod_tier_reached' and not exists (
          select 1 from public.discount_proposals proposal
          where proposal.id = message.proposal_id and proposal.company_id = message.company_id
            and proposal.scheme_type = 'tod'
            and proposal.status in ('tracking', 'eligible')
            and proposal.achieved_tier_id is not null
            and message.business_event_key = 'phase6:tod_tier_reached:' || proposal.id::text || ':' || proposal.achieved_tier_id::text
        ))
        or (message.event_type in ('cd_credit_note_created', 'tod_credit_note_created') and not exists (
          select 1 from public.credit_note_postings posting
          where posting.id = message.credit_note_posting_id and posting.proposal_id = message.proposal_id
            and posting.company_id = message.company_id and posting.status = 'created_verified'
        ))
      )
    returning message.id
  ), candidates as (
    select message.id
    from public.notification_messages message
    where message.attempt_count < message.max_attempts
      and (
        (message.status in ('queued', 'failed') and message.available_at <= now())
        or (message.status = 'sending' and message.lease_expires_at < now())
      )
    order by message.available_at, message.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.notification_messages message
  set status = 'sending', locked_at = now(), locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      attempt_count = message.attempt_count + 1, updated_at = now()
  from candidates
  where message.id = candidates.id
  returning message.*;
$$;

revoke execute on function public.enqueue_phase_6_notification(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.claim_phase_6_notification_messages(text, integer, integer) from public, anon, authenticated;
grant execute on function public.enqueue_phase_6_notification(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.claim_phase_6_notification_messages(text, integer, integer) to service_role;
