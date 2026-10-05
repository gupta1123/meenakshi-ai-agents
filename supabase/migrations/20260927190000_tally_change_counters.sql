-- Automatic master sync. Tally raises a company's master change counter
-- (AltMstId) whenever a customer, group, product or ledger is created or
-- edited. The connector reports it with its heartbeat; when it is ahead of the
-- counter recorded at the last successful master sync, the backend queues a
-- master sync by itself. The same numbers drive the "up to date" status.
create table if not exists public.tally_change_counters (
  company_id uuid primary key references public.companies(id) on delete cascade,
  observed_master_counter bigint,
  observed_at timestamptz,
  synced_master_counter bigint,
  synced_at timestamptz,
  last_auto_request_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.tally_change_counters enable row level security;
revoke all on public.tally_change_counters from anon, authenticated;
grant select, insert, update on public.tally_change_counters to service_role;
