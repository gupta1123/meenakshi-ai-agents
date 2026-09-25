-- Apply manually AFTER 20260922165731_repair_discount_notification_integrity.sql.
--
-- WhatsApp messages are now sent only when an Administrator presses Send
-- (Credit Notes, Debit Notes and Cash Discount reminders). This migration:
--   1. removes the triggers that queued messages automatically;
--   2. cancels automatic messages that are still waiting in the queue;
--   3. lets the delivery worker claim Debit Note messages. The previous claim
--      function required a discount proposal, which Debit Note messages never
--      have, so every Debit Note message was suppressed before sending.
begin;

drop trigger if exists phase_6_enqueue_shortfall_reminder on public.discount_proposals;
drop trigger if exists phase_6_enqueue_tod_tier_reached on public.discount_proposals;
drop trigger if exists enqueue_verified_credit_note_notification on public.credit_note_postings;
drop trigger if exists phase_6_enqueue_verified_credit_note on public.credit_note_postings;

update public.notification_messages
set status = 'cancelled',
    failure_reason = 'Automatic WhatsApp sending was turned off. Send it again from Meenakshi if it is still needed.',
    updated_at = now()
where status = 'queued'
  and created_by is null
  and event_type in ('cd_shortfall', 'tod_tier_reached', 'cd_credit_note_created', 'tod_credit_note_created');

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
        (message.event_type <> 'cd_debit_note_created' and not exists (
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
        ))
        or (message.event_type = 'cd_debit_note_created' and not exists (
          select 1
          from public.cash_discount_debit_note_postings posting
          join public.companies company on company.id = posting.company_id
          join public.customer_contacts contact
            on contact.id = message.customer_contact_id and contact.company_id = posting.company_id and contact.is_active
          join public.whatsapp_templates template
            on template.id = message.whatsapp_template_id
             and template.organization_id = company.organization_id
             and template.event_type = message.event_type and template.is_active
          where posting.id = message.cash_discount_debit_note_posting_id
            and posting.company_id = message.company_id
            and posting.status = 'created_verified'
        ))
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

commit;
