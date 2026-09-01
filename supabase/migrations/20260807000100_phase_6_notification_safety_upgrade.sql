-- Phase 6 delta for installations that already applied `phase 6-old`.
-- Do not rerun the original Phase 6 migration. This file only replaces two
-- functions with the post-review contact/template safety improvements.

-- A resend retains the recipient and frozen business payload, but snapshots
-- the currently active approved template. This permits a legitimate resend
-- after a completed message's old template has been retired.
create or replace function public.resend_phase_6_notification(
  p_notification_message_id uuid,
  p_company_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_resend_key text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  original public.notification_messages;
  company_record public.companies;
  template_record public.whatsapp_templates;
  new_message_id uuid;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null or length(btrim(p_reason)) > 500 then
    raise exception 'A resend reason of at most 500 characters is required';
  end if;
  if nullif(btrim(coalesce(p_resend_key, '')), '') is null or length(p_resend_key) > 120 then
    raise exception 'A resend idempotency key is required';
  end if;

  select * into original
  from public.notification_messages
  where id = p_notification_message_id and company_id = p_company_id
  for update;
  if not found then raise exception 'Notification message was not found for company'; end if;
  if original.status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'Only sent, delivered, read, or failed messages may be resent';
  end if;

  select * into company_record from public.companies where id = p_company_id;
  select * into template_record
  from public.whatsapp_templates template
  where template.organization_id = company_record.organization_id
    and template.event_type = original.event_type
    and template.is_active
  limit 1;
  if not found then raise exception 'An active approved template is required before resending'; end if;

  insert into public.notification_messages (
    company_id, proposal_id, credit_note_posting_id, customer_contact_id,
    whatsapp_template_id, event_type, business_event_key, resend_of_notification_id,
    resend_reason, recipient_phone_e164, payload, opt_in_snapshot, status,
    scheduled_for, available_at, created_by
  ) values (
    original.company_id, original.proposal_id, original.credit_note_posting_id,
    original.customer_contact_id, template_record.id, original.event_type,
    'phase6:resend:' || original.id::text || ':' || btrim(p_resend_key), original.id,
    btrim(p_reason), original.recipient_phone_e164, original.payload, '{}'::jsonb,
    'queued', now(), now(), p_actor_id
  ) on conflict (business_event_key) do update
    set updated_at = public.notification_messages.updated_at
  returning id into new_message_id;

  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action, entity_type,
    entity_id, new_value, metadata
  ) values (
    company_record.organization_id, p_company_id, 'user', p_actor_id,
    'notification_resent', 'notification_message', new_message_id,
    jsonb_build_object('resendOfNotificationId', original.id, 'reason', btrim(p_reason)),
    jsonb_build_object('eventType', original.event_type, 'resendKey', btrim(p_resend_key))
  );
  return new_message_id;
end;
$$;

-- Before a worker acquires a lease, suppress stale items whenever the linked
-- customer contact or template has been deactivated, in addition to consent
-- revocation and changed CD/Credit Note eligibility.
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
            and proposal.scheme_type = 'cd' and proposal.status = 'near_eligibility'
            and proposal.shortfall_amount > 0
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

revoke execute on function public.resend_phase_6_notification(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.claim_phase_6_notification_messages(text, integer, integer) from public, anon, authenticated;
grant execute on function public.resend_phase_6_notification(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.claim_phase_6_notification_messages(text, integer, integer) to service_role;
