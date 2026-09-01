-- MSG91 can retry a delivery-report webhook. Keep every provider event behind
-- an idempotency key so a repeated callback cannot alter message history twice.

create table public.msg91_delivery_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_key text not null unique,
  provider_message_id text,
  event_name text not null check (event_name in ('sent', 'delivered', 'read', 'failed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  notification_attempt_id uuid references public.notification_attempts(id) on delete set null,
  notification_message_id uuid references public.notification_messages(id) on delete set null,
  payload jsonb not null default '{}'::jsonb
);

create index msg91_delivery_events_message_idx
  on public.msg91_delivery_events (notification_message_id, occurred_at desc)
  where notification_message_id is not null;

alter table public.msg91_delivery_events enable row level security;
revoke all on table public.msg91_delivery_events from public, anon, authenticated;
grant all on table public.msg91_delivery_events to service_role;
