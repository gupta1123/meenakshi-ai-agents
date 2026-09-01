-- Run after 20260805000000_phase_4_evaluation_execution.sql has been applied.
-- This is deliberately fixture-free: it verifies the Phase 4 execution
-- boundary without inserting production-like customer or financial data.

begin;

do $$
begin
  if to_regclass('public.tod_customer_period_rule_locks') is null then
    raise exception 'Phase 4 TOD period-lock table is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'evaluation_runs'
      and column_name in (
        'request_context', 'idempotency_key', 'correlation_id',
        'locked_at', 'locked_by', 'lease_expires_at', 'attempts',
        'max_attempts', 'tally_master_refresh_run_id',
        'tally_voucher_refresh_run_id'
      )
    group by table_schema, table_name
    having count(*) = 10
  ) then
    raise exception 'Phase 4 evaluation-run execution fields are incomplete';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'scheme_versions'
      and column_name = 'tod_review_calendar_id'
  ) then
    raise exception 'Phase 4 TOD review-calendar field is missing';
  end if;

  if not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'create_meenakshi_evaluation_run',
        'claim_meenakshi_evaluation_runs',
        'request_meenakshi_evaluation_refresh',
        'lock_meenakshi_tod_customer_period',
        'persist_meenakshi_evaluation_result',
        'fail_meenakshi_evaluation_run'
      )
    group by namespace.nspname
    having count(*) = 6
  ) then
    raise exception 'One or more Phase 4 server-only RPCs are missing';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.create_meenakshi_evaluation_run(uuid, uuid, uuid, jsonb, text)',
    'execute'
  ) then
    raise exception 'Browser role must not execute the Phase 4 create-run RPC';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.create_meenakshi_evaluation_run(uuid, uuid, uuid, jsonb, text)',
    'execute'
  ) then
    raise exception 'service_role cannot execute the Phase 4 create-run RPC';
  end if;
end;
$$;

rollback;
