-- Tally company, master-data, and canonical voucher snapshots.
-- Tally remains the accounting source of truth; these records are traceable copies.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  tally_company_guid text not null,
  tally_company_name text not null,
  code text not null,
  timezone text not null default 'Asia/Kolkata',
  is_active boolean not null default true,
  last_live_validation_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, tally_company_guid),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table public.tally_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  sync_kind public.sync_kind not null,
  status public.sync_status not null default 'queued',
  requested_scope jsonb not null default '{}'::jsonb,
  cursor_from text,
  cursor_to text,
  records_received integer not null default 0 check (records_received >= 0),
  records_applied integer not null default 0 check (records_applied >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  source_fingerprint text,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index tally_sync_runs_company_created_idx
  on public.tally_sync_runs (company_id, created_at desc);

create table public.customer_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_group_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  name text not null,
  parent_group_id uuid,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_group_guid),
  unique (id, company_id),
  foreign key (parent_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);

create index customer_groups_parent_idx on public.customer_groups (company_id, parent_group_id);

create table public.tally_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null,
  name text not null,
  tally_guid text,
  tally_master_id text,
  tally_alter_id text,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id)
);

create table public.stock_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_group_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  name text not null,
  parent_stock_group_id uuid,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_group_guid),
  unique (id, company_id),
  foreign key (parent_stock_group_id, company_id)
    references public.stock_groups (id, company_id) on delete restrict
);

create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_stock_item_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  name text not null,
  current_stock_group_id uuid,
  default_uom_id uuid,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_stock_item_guid),
  unique (id, company_id),
  foreign key (current_stock_group_id, company_id)
    references public.stock_groups (id, company_id) on delete restrict,
  foreign key (default_uom_id, company_id)
    references public.tally_units (id, company_id) on delete restrict
);

create index stock_items_group_idx on public.stock_items (company_id, current_stock_group_id);

create table public.tally_ledgers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_ledger_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  name text not null,
  parent_group_name text,
  gst_applicability text,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_ledger_guid),
  unique (id, company_id)
);

create table public.tally_voucher_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_voucher_type_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  name text not null,
  is_credit_note_type boolean not null default false,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_voucher_type_guid),
  unique (id, company_id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_ledger_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  ledger_name text not null,
  current_customer_group_id uuid,
  tax_identifier text,
  is_available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_ledger_guid),
  unique (id, company_id),
  foreign key (current_customer_group_id, company_id)
    references public.customer_groups (id, company_id) on delete restrict
);

create index customers_group_idx on public.customers (company_id, current_customer_group_id);

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  phone_e164 text not null,
  contact_name text,
  source text not null check (source in ('tally', 'controlled_manual_update')),
  is_primary boolean not null default false,
  is_active boolean not null default true,
  entered_by uuid,
  entered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict
);

create unique index customer_contacts_one_primary_idx
  on public.customer_contacts (customer_id)
  where is_primary and is_active;

create table public.whatsapp_opt_ins (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_contact_id uuid not null,
  is_opted_in boolean not null,
  source text not null,
  recorded_at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (customer_contact_id, recorded_at),
  foreign key (customer_contact_id, company_id)
    references public.customer_contacts (id, company_id) on delete restrict
);

create unique index whatsapp_opt_ins_one_current_idx
  on public.whatsapp_opt_ins (customer_contact_id)
  where is_opted_in and revoked_at is null;

create table public.tally_vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tally_guid text not null,
  tally_master_id text,
  tally_alter_id text,
  voucher_number text,
  voucher_kind public.tally_voucher_kind not null,
  voucher_type_id uuid,
  voucher_date date not null,
  party_customer_id uuid,
  linked_sales_voucher_id uuid,
  status public.tally_voucher_status not null default 'posted',
  currency_code char(3) not null default 'INR',
  taxable_product_value numeric(19,4) not null default 0,
  gross_amount numeric(19,4) not null default 0,
  narration text,
  last_seen_at timestamptz not null default now(),
  last_sync_run_id uuid references public.tally_sync_runs(id) on delete set null,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tally_guid),
  unique (id, company_id),
  foreign key (voucher_type_id, company_id)
    references public.tally_voucher_types (id, company_id) on delete restrict,
  foreign key (party_customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (linked_sales_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict
);

create index tally_vouchers_company_kind_date_idx
  on public.tally_vouchers (company_id, voucher_kind, voucher_date);
create index tally_vouchers_customer_date_idx
  on public.tally_vouchers (party_customer_id, voucher_date)
  where party_customer_id is not null;

create table public.tally_voucher_inventory_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  voucher_id uuid not null,
  line_number integer not null check (line_number > 0),
  stock_item_id uuid,
  stock_group_id uuid,
  stock_item_name_snapshot text,
  stock_group_name_snapshot text,
  source_uom_id uuid,
  source_uom_code_snapshot text,
  quantity numeric(20,6) not null default 0 check (quantity >= 0),
  taxable_product_value numeric(19,4) not null default 0,
  freight_value numeric(19,4) not null default 0,
  non_product_value numeric(19,4) not null default 0,
  line_category text not null check (line_category in ('inventory', 'freight', 'non_product', 'other')),
  quantity_is_reliable boolean not null default true,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (voucher_id, line_number),
  foreign key (voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict,
  foreign key (stock_item_id, company_id)
    references public.stock_items (id, company_id) on delete restrict,
  foreign key (stock_group_id, company_id)
    references public.stock_groups (id, company_id) on delete restrict,
  foreign key (source_uom_id, company_id)
    references public.tally_units (id, company_id) on delete restrict
);

create index tally_voucher_inventory_lines_stock_item_idx
  on public.tally_voucher_inventory_lines (company_id, stock_item_id)
  where stock_item_id is not null;

create table public.tally_bill_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  source_voucher_id uuid not null,
  target_voucher_id uuid,
  tally_allocation_key text not null,
  bill_reference text,
  allocation_type public.bill_allocation_type not null,
  allocation_date date not null,
  allocated_amount numeric(19,4) not null check (allocated_amount > 0),
  is_available boolean not null default true,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_voucher_id, tally_allocation_key),
  foreign key (source_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict,
  foreign key (target_voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict
);

create index tally_bill_allocations_target_idx
  on public.tally_bill_allocations (company_id, target_voucher_id, allocation_date)
  where target_voucher_id is not null;

create table public.tally_bill_reference_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  voucher_id uuid,
  tally_reference_key text not null,
  bill_reference text not null,
  reference_kind public.bill_allocation_type not null,
  reference_date date,
  original_amount numeric(19,4) not null default 0 check (original_amount >= 0),
  outstanding_amount numeric(19,4) not null default 0 check (outstanding_amount >= 0),
  balance_as_of timestamptz not null,
  last_sync_run_id uuid references public.tally_sync_runs(id) on delete set null,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (company_id, tally_reference_key, balance_as_of),
  foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete restrict,
  foreign key (voucher_id, company_id)
    references public.tally_vouchers (id, company_id) on delete restrict
);

create index tally_bill_reference_snapshots_open_idx
  on public.tally_bill_reference_snapshots (company_id, customer_id, balance_as_of desc)
  where outstanding_amount > 0;

create trigger companies_set_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
create trigger customer_groups_set_updated_at before update on public.customer_groups
  for each row execute function public.set_updated_at();
create trigger tally_units_set_updated_at before update on public.tally_units
  for each row execute function public.set_updated_at();
create trigger stock_groups_set_updated_at before update on public.stock_groups
  for each row execute function public.set_updated_at();
create trigger stock_items_set_updated_at before update on public.stock_items
  for each row execute function public.set_updated_at();
create trigger tally_ledgers_set_updated_at before update on public.tally_ledgers
  for each row execute function public.set_updated_at();
create trigger tally_voucher_types_set_updated_at before update on public.tally_voucher_types
  for each row execute function public.set_updated_at();
create trigger customers_set_updated_at before update on public.customers
  for each row execute function public.set_updated_at();
create trigger customer_contacts_set_updated_at before update on public.customer_contacts
  for each row execute function public.set_updated_at();
create trigger tally_vouchers_set_updated_at before update on public.tally_vouchers
  for each row execute function public.set_updated_at();
create trigger tally_voucher_inventory_lines_set_updated_at before update on public.tally_voucher_inventory_lines
  for each row execute function public.set_updated_at();
create trigger tally_bill_allocations_set_updated_at before update on public.tally_bill_allocations
  for each row execute function public.set_updated_at();
