-- Send per-MT Cash Discount Credit Notes on WhatsApp as Credit Notes.
-- They are stored with Debit Notes (cash_discount_debit_note_postings,
-- note_kind = 'credit_note'), and both database checks only allowed that table
-- to send the "Debit Note" message type. Now a Cash Discount note is sent with
-- the Cash Discount Credit Note or Debit Note template matching its kind.
-- Does not send, requeue or change any existing message.
begin;

create or replace function public.validate_notification_message()
returns trigger language plpgsql set search_path=public as $$
declare v_opted_in boolean; v_consent jsonb; v_template jsonb;
begin
  if tg_op='UPDATE' and (
    new.company_id is distinct from old.company_id or new.proposal_id is distinct from old.proposal_id
    or new.customer_contact_id is distinct from old.customer_contact_id
    or new.recipient_phone_e164 is distinct from old.recipient_phone_e164
    or new.whatsapp_template_id is distinct from old.whatsapp_template_id
    or new.event_type is distinct from old.event_type
    or new.business_event_key is distinct from old.business_event_key
    or new.credit_note_posting_id is distinct from old.credit_note_posting_id
    or new.cash_discount_debit_note_posting_id is distinct from old.cash_discount_debit_note_posting_id
    or new.payload is distinct from old.payload
    or new.template_snapshot is distinct from old.template_snapshot
    or new.opt_in_snapshot is distinct from old.opt_in_snapshot
  ) then raise exception 'Message identity and frozen evidence cannot change'; end if;
  -- Allow delivery receipts and failures to be recorded after consent revocation.
  if tg_op='UPDATE' and not (new.status='sending' and old.status<>'sending') then return new; end if;
  -- Cash Discount notes (Debit Notes, and per-MT Credit Notes stored in the same
  -- table) are sent with the template matching what the note really is.
  if new.cash_discount_debit_note_posting_id is not null or new.event_type='cd_debit_note_created' then
    if new.proposal_id is not null or new.credit_note_posting_id is not null or new.cash_discount_debit_note_posting_id is null then
      raise exception 'Cash Discount note messages require only a Cash Discount note posting';
    end if;
    if new.event_type is distinct from (
      select case p.note_kind when 'credit_note' then 'cd_credit_note_created' else 'cd_debit_note_created' end
      from public.cash_discount_debit_note_postings p where p.id=new.cash_discount_debit_note_posting_id
    ) then raise exception 'The WhatsApp message type must match the note: Credit Note or Debit Note'; end if;
    if not exists(
      select 1 from public.cash_discount_debit_note_postings p
      join public.cash_discount_recovery_candidates c on c.id=p.candidate_id and c.company_id=p.company_id
      join public.customers customer on customer.company_id=c.company_id and customer.tally_ledger_guid=c.customer_tally_guid
      join public.customer_contacts contact on contact.id=new.customer_contact_id and contact.company_id=p.company_id and contact.customer_id=customer.id and contact.is_active
      join public.companies company on company.id=p.company_id
      join public.whatsapp_templates template on template.id=new.whatsapp_template_id and template.organization_id=company.organization_id and template.event_type=new.event_type and template.is_active
      where p.id=new.cash_discount_debit_note_posting_id and p.company_id=new.company_id and p.status='created_verified'
    ) then raise exception 'Cash Discount note, WhatsApp template, and recipient must belong to the same active company and customer'; end if;
  else
    if new.proposal_id is null or not exists(
      select 1 from public.companies company
      join public.discount_proposals proposal on proposal.id=new.proposal_id and proposal.company_id=company.id
      join public.customer_contacts contact on contact.id=new.customer_contact_id and contact.company_id=company.id and contact.customer_id=proposal.customer_id and contact.is_active
      join public.whatsapp_templates template on template.id=new.whatsapp_template_id and template.organization_id=company.organization_id and template.event_type=new.event_type and template.is_active
      where company.id=new.company_id
    ) then raise exception 'WhatsApp template, recipient contact, and proposal must belong to the same active organization and customer'; end if;
    if new.event_type in ('cd_credit_note_created','tod_credit_note_created') and (
      new.credit_note_posting_id is null or not exists(select 1 from public.credit_note_postings p where p.id=new.credit_note_posting_id and p.proposal_id=new.proposal_id and p.status='created_verified')
    ) then raise exception 'Credit Note WhatsApp messages require a verified Tally Credit Note'; end if;
  end if;
  if not exists(select 1 from public.customer_contacts contact where contact.id=new.customer_contact_id and contact.company_id=new.company_id and contact.phone_e164=new.recipient_phone_e164 and contact.is_active) then
    raise exception 'The recipient must match the selected active customer contact';
  end if;
  select true, jsonb_build_object('optInId',o.id,'recordedAt',o.recorded_at,'source',o.source,'evidence',o.evidence)
  into v_opted_in,v_consent from public.whatsapp_opt_ins o
  where o.company_id=new.company_id and o.customer_contact_id=new.customer_contact_id and o.is_opted_in and o.revoked_at is null
  order by o.recorded_at desc limit 1;
  if coalesce(v_opted_in,false)=false then raise exception 'WhatsApp message requires a recorded current customer opt-in'; end if;
  select jsonb_build_object('templateId',t.id,'provider',t.provider_name,'providerTemplateId',t.provider_template_id,
    'eventType',t.event_type,'languageCode',t.language_code,'namespace',t.template_namespace,
    'version',t.template_version,'componentSchema',t.component_schema) into v_template
  from public.whatsapp_templates t where t.id=new.whatsapp_template_id and t.is_active;
  if nullif(btrim(v_template->>'providerTemplateId'),'') is null then
    raise exception 'Configure the approved WhatsApp template before sending';
  end if;
  if tg_op='INSERT' then
    new.opt_in_snapshot:=v_consent;
    new.template_snapshot:=v_template;
  elsif nullif(btrim(new.template_snapshot->>'providerTemplateId'),'') is null then
    raise exception 'This message has no frozen template. Review and explicitly resend after configuration is repaired';
  end if;
  return new;
end $$;

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
        (message.cash_discount_debit_note_posting_id is null and not exists (
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
        or (message.cash_discount_debit_note_posting_id is not null and not exists (
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
        or (message.cash_discount_debit_note_posting_id is null and message.event_type in ('cd_credit_note_created', 'tod_credit_note_created') and not exists (
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
