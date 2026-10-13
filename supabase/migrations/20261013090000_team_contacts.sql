-- Meenakshi marketing / sales team members who can be copied ("CC") on the
-- WhatsApp messages sent to customers. One new table, no changes to existing
-- tables: a copy is queued as an ordinary notification_messages row that reuses
-- the customer's already opted-in contact and only changes the recipient number.

create table if not exists public.team_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  role_label text check (role_label is null or length(role_label) <= 80),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A number appears once per company among the people still active.
create unique index if not exists team_contacts_company_phone_active_key
  on public.team_contacts (company_id, phone_e164) where is_active;

alter table public.team_contacts enable row level security;
revoke all on public.team_contacts from public, anon, authenticated;
grant select, insert, update, delete on public.team_contacts to service_role;

comment on table public.team_contacts is 'Internal Meenakshi staff who can be copied on customer WhatsApp messages.';
