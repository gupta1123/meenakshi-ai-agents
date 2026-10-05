-- WhatsApp sends were recorded as "suppressed" after MSG91 accepted them.
-- The claim function's suppression step also matched messages in 'sending'
-- whose lease was still live (i.e. being sent right now), so a message could
-- be sent and then overwritten as suppressed. Only messages whose lease has
-- expired are re-checked now. This also re-applies the Debit Note-aware
-- eligibility from 20260923120000 in case that manual migration was skipped.
begin;

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
    where (message.status in ('queued', 'failed') or (message.status = 'sending' and message.lease_expires_at < now()))
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
      and message.id not in (select id from suppressed)
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

-- Repair the Debit Note message that MSG91 accepted (request 752b7de7…) but
-- which was recorded as suppressed.
update public.notification_messages message
set status = 'sent',
    sent_at = coalesce(attempt.completed_at, attempt.attempted_at, now()),
    failure_reason = null,
    updated_at = now()
from public.notification_attempts attempt
where message.id = '0df51de6-2d14-47ed-9cfd-bc6aecb89cc8'
  and message.status = 'suppressed'
  and attempt.notification_message_id = message.id
  and attempt.status = 'sent'
  and attempt.provider_message_id = '752b7de79050462d8a13cadb9eb02340';

commit;
