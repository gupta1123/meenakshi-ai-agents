-- Credit / Debit Note PDFs in the TallyPrime e-Invoice layout.
--
-- 1. note_einvoices: the IRN, Ack No., Ack Date and signed QR that Tally holds
--    for a note once it is e-invoiced (read from Tally by the local connector).
--    Kept apart from the posting rows, whose verified evidence is immutable.
-- 2. companies.document_cin / document_email: printed in the company block.
begin;

create table if not exists public.note_einvoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  note_source text not null check (note_source in ('tod_credit_note', 'cash_discount_note')),
  posting_id uuid not null,
  irn text not null check (irn ~ '^[0-9a-f]{64}$'),
  ack_no text not null check (ack_no ~ '^[0-9]{6,20}$'),
  ack_date date,
  signed_qr text not null check (length(signed_qr) between 50 and 4000),
  read_from_tally_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_source, posting_id)
);
alter table public.note_einvoices enable row level security;
revoke all on public.note_einvoices from anon, authenticated;
grant select, insert, update on public.note_einvoices to service_role;

alter table public.companies
  add column if not exists document_cin text,
  add column if not exists document_email text;

-- MEENAKSHI UDYOG (INDIA) PVT LTD, as printed on its Tally Credit Notes.
update public.companies
set document_cin = coalesce(document_cin, 'U27106TN2004PTCO53555'),
    document_email = coalesce(document_email, 'meenakshiudyogindia@gmail.com')
where document_gstin = '33AADCM9365L1Z1';

commit;
