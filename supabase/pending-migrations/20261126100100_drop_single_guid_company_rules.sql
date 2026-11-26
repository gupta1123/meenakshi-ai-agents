-- Step B of two. DO NOT APPLY until the connector, backend and frontend that
-- understand (GUID, books-from) are deployed and step A is applied.
--
-- It removes the old "one company per GUID" rules so a second financial-year
-- company with the same GUID can be created. Until then, old code upserts rely
-- on these rules, which is why they are not dropped in step A.
--
-- After this step the old observation upsert (on connector_id, guid) no longer
-- has its conflict target, so the new backend (which upserts on the wider
-- index) must already be live.

begin;

do $$
declare
  v_name text;
begin
  -- companies: unique (organization_id, tally_company_guid)
  for v_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.companies'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
          = array['organization_id', 'tally_company_guid']
  loop
    execute format('alter table public.companies drop constraint %I', v_name);
  end loop;

  -- observations: unique (connector_id, tally_company_guid)
  for v_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.tally_connector_company_observations'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
          = array['connector_id', 'tally_company_guid']
  loop
    execute format('alter table public.tally_connector_company_observations drop constraint %I', v_name);
  end loop;
end
$$;

commit;
