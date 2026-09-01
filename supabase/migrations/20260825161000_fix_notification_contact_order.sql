-- Repair the notification function installed by 20260825120000.
-- customer_contacts has entered_at, not created_at.  The bad reference prevents
-- a live TOD refresh from queuing its tier-reached notification.

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

revoke execute on function public.enqueue_phase_6_notification(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_phase_6_notification(uuid, uuid, text, uuid, uuid) to service_role;
