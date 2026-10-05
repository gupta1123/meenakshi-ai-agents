alter table public.whatsapp_templates drop constraint if exists whatsapp_templates_event_type_check;
drop trigger if exists enqueue_verified_credit_note_notification on public.credit_note_postings;
alter table public.whatsapp_templates add constraint whatsapp_templates_event_type_check
  check (event_type in ('cd_shortfall','cd_credit_note_created','cd_debit_note_created','tod_tier_reached','tod_credit_note_created'));

alter table public.notification_messages drop constraint if exists notification_messages_event_type_check;
alter table public.notification_messages add constraint notification_messages_event_type_check
  check (event_type in ('cd_shortfall','cd_credit_note_created','cd_debit_note_created','tod_tier_reached','tod_credit_note_created'));
alter table public.notification_messages alter column proposal_id drop not null;
alter table public.notification_messages add column if not exists cash_discount_debit_note_posting_id uuid;
alter table public.notification_messages drop constraint if exists notification_messages_cd_debit_posting_fk;
alter table public.notification_messages add constraint notification_messages_cd_debit_posting_fk
  foreign key (cash_discount_debit_note_posting_id, company_id)
  references public.cash_discount_debit_note_postings(id, company_id) on delete restrict;
create index if not exists notification_messages_cd_debit_posting_idx
  on public.notification_messages(cash_discount_debit_note_posting_id);

create or replace function public.validate_notification_message()
returns trigger language plpgsql set search_path=public as $$
declare v_opted_in boolean;
begin
  if new.event_type='cd_debit_note_created' then
    if new.proposal_id is not null or new.credit_note_posting_id is not null or new.cash_discount_debit_note_posting_id is null then
      raise exception 'Debit Note messages require only a Debit Note posting';
    end if;
    if not exists(
      select 1 from public.cash_discount_debit_note_postings p
      join public.cash_discount_recovery_candidates c on c.id=p.candidate_id and c.company_id=p.company_id
      join public.customer_contacts contact on contact.id=new.customer_contact_id and contact.company_id=p.company_id and contact.customer_id=c.customer_id and contact.is_active
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
  select true into v_opted_in from public.whatsapp_opt_ins o where o.customer_contact_id=new.customer_contact_id and o.is_opted_in and o.revoked_at is null;
  if coalesce(v_opted_in,false)=false then raise exception 'WhatsApp message requires a recorded current customer opt-in'; end if;
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
  if not found or v_candidate.customer_id is null then return null; end if;
  select * into v_customer from public.customers where id=v_candidate.customer_id and company_id=p_company_id;
  select * into v_company from public.companies where id=p_company_id;
  select * into v_contact from public.customer_contacts
    where company_id=p_company_id and customer_id=v_candidate.customer_id and is_active
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
