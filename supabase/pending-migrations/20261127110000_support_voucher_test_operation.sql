-- Allows one more remote-support operation, 'voucher_test': create ONE Rs 1 Credit Note in a named
-- company, delete exactly that voucher and prove it is gone (administrators only, enforced in the app
-- and again in the connector). Additive: widens one CHECK list; no data changes.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.tally_support_jobs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%operation%' and pg_get_constraintdef(oid) ilike '%diagnostic%'
  loop
    execute format('alter table public.tally_support_jobs drop constraint %I', c.conname);
  end loop;
  alter table public.tally_support_jobs
    add constraint tally_support_jobs_operation_check
    check (operation in ('diagnostic','recalculate','update','logs','voucher_test'));
end $$;
