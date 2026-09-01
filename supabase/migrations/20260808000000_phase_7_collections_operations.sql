-- Phase 7: operations controls for the Meenakshi Collections experience.
--
-- This migration is intentionally append-only.  It does not change historical
-- proposals, postings, messages, or the Phase 1--6 durable outbox workflow.

do $$
begin
  create type public.company_launch_mode as enum ('review_only', 'posting_enabled');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.company_launch_controls (
  company_id uuid primary key references public.companies(id) on delete restrict,
  mode public.company_launch_mode not null default 'review_only',
  reconciliation_period_from date,
  reconciliation_period_to date,
  reconciliation_reference text,
  reconciled_by uuid references public.profiles(id) on delete restrict,
  reconciled_at timestamptz,
  posting_enabled_at timestamptz,
  updated_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    mode = 'review_only'
    or (
      reconciliation_period_from is not null
      and reconciliation_period_to is not null
      and reconciliation_period_to >= reconciliation_period_from
      and nullif(btrim(coalesce(reconciliation_reference, '')), '') is not null
      and reconciled_by is not null
      and reconciled_at is not null
      and posting_enabled_at is not null
    )
  )
);

create index if not exists company_launch_controls_mode_idx
  on public.company_launch_controls (mode, updated_at desc);

create index if not exists integration_outbox_company_status_recent_idx
  on public.integration_outbox (company_id, status, created_at desc);
create index if not exists audit_events_company_correlation_recent_idx
  on public.audit_events (company_id, correlation_id, created_at desc)
  where correlation_id is not null;
create index if not exists discount_proposals_company_status_recent_idx
  on public.discount_proposals (company_id, status, updated_at desc);

drop trigger if exists company_launch_controls_set_updated_at on public.company_launch_controls;
create trigger company_launch_controls_set_updated_at
  before update on public.company_launch_controls
  for each row execute function public.set_updated_at();

alter table public.company_launch_controls enable row level security;
revoke all on table public.company_launch_controls from public, anon, authenticated;
grant all on table public.company_launch_controls to service_role;

comment on table public.company_launch_controls is
  'Company-scoped Meenakshi launch gate. Review-only is the implicit safe default when no row exists. Posting requires a recorded Finance reconciliation.';
