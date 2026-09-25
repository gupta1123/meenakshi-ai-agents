-- Company details printed at the top of Credit / Debit Note PDFs.
-- Tally's HTTP API does not return the company's address or GSTIN, so they
-- are stored once here. Blank values are simply left off the document.
alter table public.companies
  add column if not exists document_address text,
  add column if not exists document_gstin text,
  add column if not exists document_state text;

update public.companies
set document_state = coalesce(document_state, 'Tamil Nadu')
where id = '963aa157-7c2e-4006-8efb-35902a30ec54';

-- Fill in the real values (as printed on the company's tax invoices):
-- update public.companies
-- set document_address = '<street, area, Hosur, Tamil Nadu - 635110>',
--     document_gstin   = '<33XXXXXXXXXXXXX>'
-- where id = '963aa157-7c2e-4006-8efb-35902a30ec54';
