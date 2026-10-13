-- The rule check requires a successful master sync from the last 24 hours,
-- but it read only the LATEST sync run. A sync that was stopped or failed
-- (which changes no data) therefore blocked rule activation even when a
-- successful sync from the last 24 hours existed.
--
-- Rewrite that check, in whichever function currently holds it, to look at
-- the latest COMPLETED master sync instead. Safe to run more than once.
do $$
declare
  fn record;
  v_def text;
  v_new text;
  v_pattern text := 'and sync\.sync_kind = ''masters''\s+order by sync\.created_at desc';
  v_replacement text := 'and sync.sync_kind = ''masters'' and sync.status = ''completed'' order by sync.completed_at desc nulls last';
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
    if v_def ~ v_pattern then
      v_new := regexp_replace(v_def, v_pattern, v_replacement, 'g');
      execute v_new;
      v_patched := v_patched + 1;
    end if;
  end loop;
  raise notice 'Master-sync check updated in % function(s).', v_patched;
end;
$$;
