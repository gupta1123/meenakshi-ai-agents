-- Register the approved MSG91 template "share_debit_memo" for Cash Discount
-- Debit Notes. It mirrors "share_credit_memo" (already used for Credit Notes):
--   header: Debit Note PDF (document)
--   body:   Dear {{1}}, Your debit memo {{2}} dated {{3}} has been generated.
--           Debit Amount: ₹{{4}} ... The {{5}} Team
insert into public.whatsapp_templates (
  organization_id, event_type, provider_template_id, name, is_active,
  provider_name, language_code, template_namespace, template_version, component_schema
)
select
  company.organization_id, 'cd_debit_note_created', 'share_debit_memo', 'share_debit_memo', true,
  'msg91', 'en', '2bf6cec8_61b1_4925_8632_49e9ddebff44', '1',
  '{"components":[
     {"type":"document","value":"documentUrl","component":"header_1","filenameValue":"documentName"},
     {"type":"text","value":"customerName","component":"body_1"},
     {"type":"text","value":"debitNoteNumber","component":"body_2"},
     {"type":"text","value":"debitNoteDate","component":"body_3"},
     {"type":"text","value":"debitNoteAmount","component":"body_4"},
     {"type":"text","value":"companyName","component":"body_5"}
   ]}'::jsonb
from public.companies company
where company.id = '963aa157-7c2e-4006-8efb-35902a30ec54'
  and not exists (
    select 1 from public.whatsapp_templates existing
    where existing.organization_id = company.organization_id
      and existing.event_type = 'cd_debit_note_created'
      and existing.is_active
  );
