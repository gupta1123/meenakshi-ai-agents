-- One-time cleanup of Tally connector ("computer") entries left behind by
-- repeated setup attempts and reinstalls.
--
-- Revokes every connector that no company currently uses and that has had no
-- contact for 7 days (or never connected and is more than a day old).
-- A connector bound to a company is never touched, nor is one seen recently.
-- Rows are kept (status = 'revoked'), so history and audit stay intact.

update public.tally_connectors k
set status = 'revoked', revoked_at = now()
where k.status <> 'revoked'
  and (k.last_heartbeat_at is null or k.last_heartbeat_at < now() - interval '7 days')
  and k.created_at < now() - interval '1 day'
  and not exists (
    select 1 from public.tally_connector_company_bindings b
    where b.connector_id = k.id and b.is_active
  );
