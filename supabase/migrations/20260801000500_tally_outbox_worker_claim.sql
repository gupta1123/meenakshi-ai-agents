-- Meenakshi Phase 1: isolate Tally dispatch from future MSG91 consumers.
--
-- The generic claim function intentionally covers every integration event.
-- A Tally worker must never lease a MSG91 event and then be unable to return
-- it to pending, because outbox status transitions are deliberately strict.

create function public.claim_tally_integration_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.integration_outbox
language sql
set search_path = ''
as $$
  with candidates as (
    select outbox.id
    from public.integration_outbox outbox
    where outbox.event_type in (
        'tally_credit_note_create',
        'tally_credit_note_verify',
        'tally_credit_note_pdf',
        'tally_targeted_refresh'
      )
      and outbox.attempts < outbox.max_attempts
      and (
        (outbox.status in ('pending', 'failed') and outbox.available_at <= now())
        or (outbox.status = 'processing' and outbox.lease_expires_at < now())
      )
    order by outbox.available_at, outbox.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.integration_outbox outbox
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(10, p_lease_seconds)),
      attempts = outbox.attempts + 1,
      updated_at = now()
  from candidates
  where outbox.id = candidates.id
  returning outbox.*;
$$;

revoke all on function public.claim_tally_integration_outbox(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_tally_integration_outbox(text, integer, integer)
  to service_role;
