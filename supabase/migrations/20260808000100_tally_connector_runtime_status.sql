begin;

alter table public.tally_connectors
  add column if not exists tally_url text not null default 'http://localhost:9000',
  add column if not exists last_tally_reachable boolean,
  add column if not exists last_company_loaded boolean,
  add column if not exists last_company_name text,
  add column if not exists last_error text,
  add column if not exists last_tested_at timestamptz;

create table if not exists public.tally_connector_company_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connector_id uuid not null,
  tally_company_guid text not null,
  tally_company_name text not null,
  is_available boolean not null default false,
  is_active boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connector_id, tally_company_guid),
  foreign key (connector_id, organization_id)
    references public.tally_connectors(id, organization_id) on delete restrict
);

create index if not exists tally_connector_company_observations_live_idx
  on public.tally_connector_company_observations (connector_id, is_available, is_active desc, tally_company_name);

drop trigger if exists tally_connector_company_observations_set_updated_at
  on public.tally_connector_company_observations;
create trigger tally_connector_company_observations_set_updated_at
  before update on public.tally_connector_company_observations
  for each row execute function public.set_updated_at();

alter table public.tally_connector_company_observations enable row level security;
revoke all on table public.tally_connector_company_observations from anon, authenticated;
grant all on table public.tally_connector_company_observations to service_role;

commit;
