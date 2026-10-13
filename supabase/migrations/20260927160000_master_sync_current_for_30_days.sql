-- Tally master data (customers, groups, products) changes rarely. The rule
-- check in the database required a successful master sync from the last
-- 24 hours, so staff had to re-sync from Tally every day before changing or
-- activating a rule. Allow 30 days, matching the backend (TALLY_SYNC_STALE_MS).
--
-- Rewrites the interval in whichever function holds the rule check (the ones
-- raising master_sync_stale). Safe to run more than once.
do $$
declare
  fn record;
  v_def text;
  v_patched integer := 0;
begin
  for fn in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%master_sync_stale%'
  loop
    v_def := pg_get_functiondef(fn.oid);
    if v_def like '%interval ''24 hours''%' then
      execute replace(v_def, 'interval ''24 hours''', 'interval ''30 days''');
      v_patched := v_patched + 1;
    end if;
  end loop;
  raise notice 'Master-sync window set to 30 days in % function(s).', v_patched;
end;
$$;
