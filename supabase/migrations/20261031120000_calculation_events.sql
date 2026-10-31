-- One row per Cash Discount / Turnover Discount "Calculate" click, so a
-- failure anywhere (server, Tally read, calculation, save) leaves a plain
-- record: what started, how it ended, why, and where.
create table if not exists public.calculation_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  scheme text not null check (scheme in ('cd', 'tod')),
  period_start date,
  period_end date,
  user_id uuid,
  connector_version text,
  status text not null default 'started'
    check (status in ('started', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  failing_step text
    check (failing_step is null or failing_step in ('server_prepare', 'tally_read', 'calculation', 'save')),
  failure_reason text,
  step_timings jsonb not null default '{}'::jsonb,
  last_progress jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists calculation_events_company_started_idx
  on public.calculation_events (company_id, started_at desc);
create index if not exists calculation_events_status_idx
  on public.calculation_events (status, started_at desc);

-- Service role only: the backend writes and reads these; browsers never do.
alter table public.calculation_events enable row level security;
revoke all on public.calculation_events from anon, authenticated;
