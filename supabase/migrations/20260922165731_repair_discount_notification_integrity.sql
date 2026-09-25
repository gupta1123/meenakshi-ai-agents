-- Apply manually AFTER 20260922093000_debit_note_whatsapp_delivery.sql.
-- Restores immutable template/consent evidence and uses company-scoped Tally GUIDs.
-- Does not send, requeue, or rewrite any existing message.
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
  if new.event_type='cd_debit_note_created' then
    if new.proposal_id is not null or new.credit_note_posting_id is not null or new.cash_discount_debit_note_posting_id is null then
      raise exception 'Debit Note messages require only a Debit Note posting';
    end if;
    if not exists(
      select 1 from public.cash_discount_debit_note_postings p
      join public.cash_discount_recovery_candidates c on c.id=p.candidate_id and c.company_id=p.company_id
      join public.customers customer on customer.company_id=c.company_id and customer.tally_ledger_guid=c.customer_tally_guid
      join public.customer_contacts contact on contact.id=new.customer_contact_id and contact.company_id=p.company_id and contact.customer_id=customer.id and contact.is_active
      join public.companies company on company.id=p.company_id
      join public.whatsapp_templates template on template.id=new.whatsapp_template_id and template.organization_id=company.organization_id and template.event_type=new.event_type and template.is_active
      where p.id=new.cash_discount_debit_note_posting_id and p.company_id=new.company_id and p.status='created_verified'
    ) then raise exception 'Debit Note, WhatsApp template, and recipient must belong to the same active company and customer'; end if;
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

create or replace function public.enqueue_meenakshi_cd_debit_note_notification(
  p_company_id uuid, p_posting_id uuid, p_created_by uuid default null
) returns uuid language plpgsql set search_path = '' as $$
declare
  v_posting public.cash_discount_debit_note_postings;
  v_candidate public.cash_discount_recovery_candidates;
  v_company public.companies;
  v_customer public.customers;
  v_contact public.customer_contacts;
  v_template public.whatsapp_templates;
  v_message_id uuid;
begin
  select * into v_posting from public.cash_discount_debit_note_postings
    where id=p_posting_id and company_id=p_company_id and status='created_verified';
  if not found then return null; end if;
  select * into v_candidate from public.cash_discount_recovery_candidates
    where id=v_posting.candidate_id and company_id=p_company_id;
  if not found then return null; end if;
  select * into v_customer from public.customers where tally_ledger_guid=v_candidate.customer_tally_guid and company_id=p_company_id;
  if not found then return null; end if;
  select * into v_company from public.companies where id=p_company_id;
  select * into v_contact from public.customer_contacts
    where company_id=p_company_id and customer_id=v_customer.id and is_active
    order by is_primary desc, entered_at asc, id asc limit 1;
  if not found or not exists(select 1 from public.whatsapp_opt_ins o where o.company_id=p_company_id and o.customer_contact_id=v_contact.id and o.is_opted_in and o.revoked_at is null) then return null; end if;
  select * into v_template from public.whatsapp_templates
    where organization_id=v_company.organization_id and event_type='cd_debit_note_created' and is_active limit 1;
  if not found then return null; end if;
  insert into public.notification_messages(
    company_id, proposal_id, credit_note_posting_id, cash_discount_debit_note_posting_id,
    customer_contact_id, whatsapp_template_id, event_type, business_event_key,
    recipient_phone_e164, payload, opt_in_snapshot, status, scheduled_for, available_at, created_by
  ) values (
    p_company_id, null, null, v_posting.id, v_contact.id, v_template.id,
    'cd_debit_note_created', 'meenakshi:cd_debit_note:'||v_posting.id::text,
    v_contact.phone_e164,
    jsonb_build_object('customerName',coalesce(nullif(v_contact.contact_name,''),v_customer.ledger_name,'Customer'),'companyName',v_company.tally_company_name,'debitNoteNumber',v_posting.verified_voucher_number,'debitNoteDate',v_posting.debit_note_date,'debitNoteAmount',v_posting.verified_amount,'invoiceReference',coalesce(v_candidate.invoice_number,v_candidate.bill_reference,''),'eventType','cd_debit_note_created'),
    '{}'::jsonb,'queued',now(),now(),p_created_by
  ) on conflict (business_event_key) do update set updated_at=public.notification_messages.updated_at returning id into v_message_id;
  return v_message_id;
end $$;
revoke execute on function public.enqueue_meenakshi_cd_debit_note_notification(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_meenakshi_cd_debit_note_notification(uuid,uuid,uuid) to service_role;


commit;
