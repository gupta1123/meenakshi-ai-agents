-- Smoke test for 20261105120000_server_check_jobs.sql.
-- Run inside a transaction that is ROLLED BACK (see backend/scripts/run-sql-rolled-back.mjs):
-- it creates a temporary connector and rebinds the Solution Nyx test company.
do $$
declare
  v_org uuid; v_co uuid; v_conn uuid; 
  r jsonb; j1 uuid; j2 uuid; n int; c public.tally_check_jobs; ok jsonb; fin boolean;
begin
  select id, organization_id into v_co, v_org from public.companies where code = 'SOLUTION_NYX';
  if v_co is null then raise exception 'test company missing'; end if;

  insert into public.tally_connectors (organization_id, installation_key, display_name, machine_fingerprint, control_token_hash, status, paired_at)
  values (v_org, 'smoke-' || gen_random_uuid(), 'Smoke test server', 'smoke-fp', 'x', 'paired', now())
  returning id into v_conn;
  -- Free the company's active binding (inside this rolled-back transaction) and bind the temporary connector.
  update public.tally_connector_company_bindings set is_active = false where company_id = v_co and is_active;
  insert into public.tally_connector_company_bindings (organization_id, company_id, connector_id, expected_tally_company_guid, expected_tally_company_name, is_active)
  values (v_org, v_co, v_conn, 'smoke-guid', 'Solution Nyx', true);

  -- 1. A PC connector (no mode row) cannot receive jobs.
  fin := false;
  begin
    perform public.request_tally_check_job(v_org, v_co, 'cd', 'cd:A', '{}'::jsonb, null);
  exception when sqlstate 'P0001' then fin := true; end;
  if not fin then raise exception 'expected the PC-mode refusal'; end if;
  select count(*) into n from public.claim_tally_check_job(v_conn, 'w1', 60);
  if n <> 0 then raise exception 'a PC connector must not claim jobs'; end if;

  -- 2. Server mode: first request queues, identical request joins it.
  insert into public.tally_connector_modes (connector_id, mode) values (v_conn, 'server');
  r := public.request_tally_check_job(v_org, v_co, 'cd', 'cd:A', '{"x":1}'::jsonb, null);
  j1 := (r -> 'job' ->> 'id')::uuid;
  if (r ->> 'joined')::boolean then raise exception 'first request should not join'; end if;
  if r -> 'job' ? 'request' then raise exception 'request body must not be returned'; end if;
  r := public.request_tally_check_job(v_org, v_co, 'cd', 'cd:A', '{"x":1}'::jsonb, null);
  if not (r ->> 'joined')::boolean or (r -> 'job' ->> 'id')::uuid <> j1 then raise exception 'identical request must join'; end if;

  -- 3. A different request queues behind it. (now() is fixed inside one transaction, so age job 1.)
  update public.tally_check_jobs set created_at = now() - interval '1 minute' where id = j1;
  r := public.request_tally_check_job(v_org, v_co, 'tod', 'tod:2026-04-01:2026-06-30', '{}'::jsonb, null);
  j2 := (r -> 'job' ->> 'id')::uuid;
  if (r ->> 'queuePosition')::int <> 1 then raise exception 'second job should be 1st in line, got %', r ->> 'queuePosition'; end if;

  -- 4. Claim: oldest first; company busy so the second is not handed out.
  select * into c from public.claim_tally_check_job(v_conn, 'w1', 60);
  if c.id <> j1 or c.status <> 'running' or c.attempts <> 1 then raise exception 'claim should return job 1 running'; end if;
  select count(*) into n from public.claim_tally_check_job(v_conn, 'w1', 60);
  if n <> 0 then raise exception 'only one running job per company'; end if;

  -- 5. Renew: wrong worker refused, right worker ok, cancel reaches the connector.
  ok := public.renew_tally_check_job(j1, 'other', 60, '{"batch":1}');
  if (ok ->> 'ok')::boolean then raise exception 'wrong worker must not renew'; end if;
  ok := public.renew_tally_check_job(j1, 'w1', 60, '{"batch":1}');
  if not (ok ->> 'ok')::boolean or (ok ->> 'cancelRequested')::boolean then raise exception 'renew failed'; end if;
  if public.cancel_tally_check_job(j1, v_co) <> 'running' then raise exception 'cancel of running job should flag it'; end if;
  ok := public.renew_tally_check_job(j1, 'w1', 60, null);
  if not (ok ->> 'cancelRequested')::boolean then raise exception 'connector must be told to stop'; end if;

  -- 6. Finish once; a second finish is refused; then the next job is handed out.
  fin := public.finish_tally_check_job(j1, 'w1', 'cancelled', null, null, 'Stopped by a user.', null);
  if not fin then raise exception 'finish failed'; end if;
  fin := public.finish_tally_check_job(j1, 'w1', 'succeeded', null, null, null, null);
  if fin then raise exception 'a finished job must not finish twice'; end if;
  select * into c from public.claim_tally_check_job(v_conn, 'w1', 60);
  if c.id <> j2 then raise exception 'next job should be handed out'; end if;

  -- 7. Lease lost: the job is retried, then failed after max attempts.
  update public.tally_check_jobs set lease_expires_at = now() - interval '1 minute' where id = j2;
  select * into c from public.claim_tally_check_job(v_conn, 'w2', 60);
  if c.id <> j2 or c.attempts <> 2 then raise exception 'lost lease should requeue and reclaim (attempts 2), got %', c.attempts; end if;
  update public.tally_check_jobs set lease_expires_at = now() - interval '1 minute' where id = j2;
  select * into c from public.claim_tally_check_job(v_conn, 'w3', 60);
  if c.id <> j2 or c.attempts <> 3 then raise exception 'third attempt expected'; end if;
  update public.tally_check_jobs set lease_expires_at = now() - interval '1 minute' where id = j2;
  select count(*) into n from public.claim_tally_check_job(v_conn, 'w4', 60);
  if n <> 0 then raise exception 'job past max attempts must not be reclaimed'; end if;
  if (select status from public.tally_check_jobs where id = j2) <> 'failed' then raise exception 'job should be failed'; end if;

  -- 8. Stale queued requests expire; queued cancel is immediate; a cancelled request can be asked for again.
  r := public.request_tally_check_job(v_org, v_co, 'cd', 'cd:B', '{}'::jsonb, null);
  j1 := (r -> 'job' ->> 'id')::uuid;
  update public.tally_check_jobs set created_at = now() - interval '31 minutes' where id = j1;
  select count(*) into n from public.claim_tally_check_job(v_conn, 'w1', 60);
  if n <> 0 or (select status from public.tally_check_jobs where id = j1) <> 'expired' then raise exception 'stale job should expire'; end if;
  r := public.request_tally_check_job(v_org, v_co, 'cd', 'cd:C', '{}'::jsonb, null);
  j1 := (r -> 'job' ->> 'id')::uuid;
  if public.cancel_tally_check_job(j1, v_co) <> 'cancelled' then raise exception 'queued cancel should be immediate'; end if;
  r := public.request_tally_check_job(v_org, v_co, 'cd', 'cd:C', '{}'::jsonb, null);
  if (r ->> 'joined')::boolean then raise exception 'a cancelled request must not be joined'; end if;

  raise notice 'server_check_jobs_smoke: ALL OK';
end;
$$;
