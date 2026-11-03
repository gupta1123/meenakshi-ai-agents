-- Logs a connector sends us: manually from its "Send logs" menu, or
-- automatically as a short report when a check fails or the connector stops
-- unexpectedly. The log text itself lives in the private Storage bucket
-- `connector-logs`; this table is the index. Uploads older than 30 days are
-- safe to delete (backend/scripts/connector-logs.mjs prune).
create table if not exists public.connector_log_uploads (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.tally_connectors(id) on delete cascade,
  organization_id uuid,
  kind text not null check (kind in ('manual', 'failure', 'crash')),
  reason text,
  bridge_version text,
  log_days text[] not null default '{}',
  size_bytes integer not null default 0,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists connector_log_uploads_connector_idx
  on public.connector_log_uploads (connector_id, created_at desc);

-- Service role only: the backend writes and reads these; browsers never do.
alter table public.connector_log_uploads enable row level security;
revoke all on public.connector_log_uploads from anon, authenticated;

-- Private bucket for the log files (no public access).
insert into storage.buckets (id, name, public)
values ('connector-logs', 'connector-logs', false)
on conflict (id) do nothing;
