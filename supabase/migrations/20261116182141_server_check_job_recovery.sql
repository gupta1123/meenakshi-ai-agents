-- Additive recovery contract. Existing PC APIs and legacy SQL functions stay intact.
alter table public.tally_check_jobs
  add column save_state text check (save_state in ('pending','saving','saved','failed')),
  add column save_locked_by text,
  add column save_lease_expires_at timestamptz,
  add column save_attempts integer not null default 0,
  add column save_available_at timestamptz not null default now();

create or replace function public.request_tally_check_job_v2(
  p_organization_id uuid, p_company_id uuid, p_kind text, p_scope_key text, p_request jsonb, p_requested_by uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare v_connector uuid;
begin
  select connector.id into v_connector from public.tally_connectors connector
    join public.tally_connector_company_bindings binding on binding.connector_id = connector.id
    where binding.company_id = p_company_id and binding.is_active for update of connector;
  if v_connector is null then raise exception 'No Tally connector is linked to this company.'; end if;
  return public.request_tally_check_job(p_organization_id,p_company_id,p_kind,p_scope_key,p_request,p_requested_by);
end $$;

create or replace function public.set_tally_connector_mode_v2(p_company_id uuid, p_mode text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_connector uuid; v_previous text;
begin
  if p_mode not in ('pc','server') then raise exception 'Invalid Tally mode.'; end if;
  select connector.id into v_connector from public.tally_connectors connector
    join public.tally_connector_company_bindings binding on binding.connector_id = connector.id
    where binding.company_id = p_company_id and binding.is_active for update of connector;
  if v_connector is null then raise exception 'No Tally connector is linked to this company.'; end if;
  if exists(select 1 from public.tally_check_jobs where company_id=p_company_id and
      (status in ('queued','running') or save_state in ('pending','saving')))
    or exists(select 1 from public.tally_commands where company_id=p_company_id and status in ('queued','sending','failed')) then
    raise exception 'Tally work is still waiting or running. Finish or stop it before switching.';
  end if;
  select mode into v_previous from public.tally_connector_modes where connector_id=v_connector;
  insert into public.tally_connector_modes(connector_id,mode) values(v_connector,p_mode)
    on conflict(connector_id) do update set mode=excluded.mode,updated_at=now();
  return jsonb_build_object('connectorId',v_connector,'previousMode',coalesce(v_previous,'pc'),'mode',p_mode);
end $$;

create or replace function public.claim_tally_check_job_v2(p_connector_id uuid,p_worker_id text,p_lease_seconds integer default 180)
returns setof public.tally_check_jobs language plpgsql set search_path = '' as $$
begin
  perform 1 from public.tally_connectors where id=p_connector_id for update;
  -- Never resurrect a Stop request when its process dies before acknowledging it.
  update public.tally_check_jobs set status='cancelled',finished_at=now(),updated_at=now(),
    locked_by=null,lease_expires_at=null,failure_reason='Stopped by a user.'
    where connector_id=p_connector_id and status='running' and cancel_requested and lease_expires_at<=now();
  return query select * from public.claim_tally_check_job(p_connector_id,p_worker_id,p_lease_seconds);
end $$;

create or replace function public.renew_tally_check_job_v2(p_job_id uuid,p_worker_id text,p_attempt integer,p_lease_seconds integer,p_progress jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_job public.tally_check_jobs;
begin
  perform 1 from public.tally_connectors connector join public.tally_check_jobs job on job.connector_id=connector.id
    where job.id=p_job_id for update of connector;
  update public.tally_check_jobs set lease_expires_at=now()+make_interval(secs=>least(180,greatest(30,p_lease_seconds))),
    progress=coalesce(p_progress,progress),updated_at=now()
    where id=p_job_id and status='running' and locked_by=p_worker_id and attempts=p_attempt and lease_expires_at>now()
    returning * into v_job;
  if not found then return jsonb_build_object('ok',false,'cancelRequested',false); end if;
  update public.tally_connectors set last_heartbeat_at=now() where id=v_job.connector_id;
  return jsonb_build_object('ok',true,'cancelRequested',v_job.cancel_requested);
end $$;

create or replace function public.finish_tally_check_job_v2(p_job_id uuid,p_worker_id text,p_attempt integer,p_status text,p_result jsonb,p_failing_step text,p_failure_reason text)
returns boolean language plpgsql set search_path = '' as $$
declare v_job public.tally_check_jobs; v_save boolean;
begin
  if p_status not in ('succeeded','failed','cancelled') then raise exception 'Invalid check status.'; end if;
  select * into v_job from public.tally_check_jobs where id=p_job_id for update;
  if not found or v_job.attempts<>p_attempt then return false; end if;
  -- An acknowledgement may have been lost after committing the result.
  if v_job.status=p_status and v_job.status='succeeded' and v_job.result=p_result
    and p_worker_id like ('meenakshi-bridge:'||v_job.connector_id::text||':%') then return true; end if;
  if v_job.status<>'running' or v_job.locked_by is distinct from p_worker_id or v_job.lease_expires_at<=now() then return false; end if;
  if v_job.cancel_requested and p_status='succeeded' then p_status:='cancelled'; p_result:=null; end if;
  if p_status='succeeded' and p_result is null then raise exception 'A successful check requires a result.'; end if;
  v_save:=p_status='succeeded' and v_job.kind in ('cd','tod') and jsonb_typeof(v_job.request->'save')='object';
  update public.tally_check_jobs set status=p_status,result=p_result,failing_step=p_failing_step,
    failure_reason=left(p_failure_reason,1000),locked_by=null,lease_expires_at=null,finished_at=now(),updated_at=now(),
    save_state=case when v_save then 'pending' else null end,
    progress=coalesce(progress,'{}'::jsonb)||case when v_save then '{"save":{"state":"pending"}}'::jsonb else '{}'::jsonb end
    where id=p_job_id;
  return true;
end $$;

-- Saving is durably queued in the same transaction that accepts the result.
create or replace function public.claim_tally_check_save_v2(p_worker_id text)
returns setof public.tally_check_jobs language plpgsql set search_path = '' as $$
begin
  return query update public.tally_check_jobs set save_state='saving',save_locked_by=p_worker_id,
    save_lease_expires_at=now()+interval '3 minutes',save_attempts=save_attempts+1,updated_at=now()
    where id=(select id from public.tally_check_jobs where status='succeeded' and save_available_at<=now()
      and (save_state='pending' or (save_state='saving' and save_lease_expires_at<=now()))
      order by finished_at for update skip locked limit 1)
    returning *;
end $$;

create or replace function public.renew_tally_check_save_v2(p_job_id uuid,p_worker_id text,p_attempt integer)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.tally_check_jobs set save_lease_expires_at=now()+interval '3 minutes'
    where id=p_job_id and save_state='saving' and save_locked_by=p_worker_id and save_attempts=p_attempt and save_lease_expires_at>now();
  return found;
end $$;

create or replace function public.finish_tally_check_save_v2(p_job_id uuid,p_worker_id text,p_attempt integer,p_save jsonb,p_evaluation_run_id uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.tally_check_jobs set
    save_state=case when p_save->>'state'='saved' then 'saved' when save_attempts>=5 then 'failed' else 'pending' end,
    progress=coalesce(progress,'{}'::jsonb)||jsonb_build_object('save',
      case when p_save->>'state'='saved' or save_attempts>=5 then p_save else p_save||'{"state":"pending"}'::jsonb end),
    evaluation_run_id=coalesce(p_evaluation_run_id,evaluation_run_id),save_locked_by=null,save_lease_expires_at=null,
    save_available_at=now()+interval '30 seconds',updated_at=now()
    where id=p_job_id and save_state='saving' and save_locked_by=p_worker_id and save_attempts=p_attempt and save_lease_expires_at>now();
  return found;
end $$;

-- Historical prototype results are not replayed during deployment. Only results
-- accepted by finish_tally_check_job_v2 enter the new durable save queue.

revoke all on function public.request_tally_check_job_v2(uuid,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.set_tally_connector_mode_v2(uuid,text) from public,anon,authenticated;
revoke all on function public.claim_tally_check_job_v2(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.renew_tally_check_job_v2(uuid,text,integer,integer,jsonb) from public,anon,authenticated;
revoke all on function public.finish_tally_check_job_v2(uuid,text,integer,text,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.claim_tally_check_save_v2(text) from public,anon,authenticated;
revoke all on function public.renew_tally_check_save_v2(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.finish_tally_check_save_v2(uuid,text,integer,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.request_tally_check_job_v2(uuid,uuid,text,text,jsonb,uuid) to service_role;
grant execute on function public.set_tally_connector_mode_v2(uuid,text) to service_role;
grant execute on function public.claim_tally_check_job_v2(uuid,text,integer) to service_role;
grant execute on function public.renew_tally_check_job_v2(uuid,text,integer,integer,jsonb) to service_role;
grant execute on function public.finish_tally_check_job_v2(uuid,text,integer,text,jsonb,text,text) to service_role;
grant execute on function public.claim_tally_check_save_v2(text) to service_role;
grant execute on function public.renew_tally_check_save_v2(uuid,text,integer) to service_role;
grant execute on function public.finish_tally_check_save_v2(uuid,text,integer,jsonb,uuid) to service_role;
