-- Meenakshi Phase 2 repair: Tally collection exports may include a master
-- hierarchy by name even when the corresponding GUID is absent. Resolve
-- those references after the complete, immutable source snapshot is stored.

create or replace function public.reconcile_meenakshi_master_relationships(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.companies company
    where company.id = p_company_id and company.is_active
  ) then
    raise exception 'Company is unavailable';
  end if;

  update public.customer_groups child
  set parent_group_id = (
    select parent.id
    from public.customer_groups parent
    where parent.company_id = child.company_id
      and parent.is_available
      and (
        parent.tally_group_guid = nullif(child.source_payload ->> 'parentGuid', '')
        or (
          nullif(child.source_payload ->> 'parentGuid', '') is null
          and lower(btrim(parent.name)) = lower(btrim(nullif(child.source_payload ->> 'parentName', '')))
        )
      )
    order by case when parent.tally_group_guid = nullif(child.source_payload ->> 'parentGuid', '') then 0 else 1 end
    limit 1
  )
  where child.company_id = p_company_id;

  update public.stock_groups child
  set parent_stock_group_id = (
    select parent.id
    from public.stock_groups parent
    where parent.company_id = child.company_id
      and parent.is_available
      and (
        parent.tally_group_guid = nullif(child.source_payload ->> 'parentGuid', '')
        or (
          nullif(child.source_payload ->> 'parentGuid', '') is null
          and lower(btrim(parent.name)) = lower(btrim(nullif(child.source_payload ->> 'parentName', '')))
        )
      )
    order by case when parent.tally_group_guid = nullif(child.source_payload ->> 'parentGuid', '') then 0 else 1 end
    limit 1
  )
  where child.company_id = p_company_id;

  update public.stock_items item
  set current_stock_group_id = (
    select stock_group.id
    from public.stock_groups stock_group
    where stock_group.company_id = item.company_id
      and stock_group.is_available
      and (
        stock_group.tally_group_guid = nullif(item.source_payload ->> 'stockGroupGuid', '')
        or (
          nullif(item.source_payload ->> 'stockGroupGuid', '') is null
          and lower(btrim(stock_group.name)) = lower(btrim(nullif(item.source_payload ->> 'stockGroupName', '')))
        )
      )
    order by case when stock_group.tally_group_guid = nullif(item.source_payload ->> 'stockGroupGuid', '') then 0 else 1 end
    limit 1
  ),
  default_uom_id = (
    select unit.id
    from public.tally_units unit
    where unit.company_id = item.company_id
      and unit.is_available
      and lower(btrim(unit.code)) = lower(btrim(nullif(item.source_payload ->> 'uomCode', '')))
    limit 1
  )
  where item.company_id = p_company_id;

  update public.customers customer
  set current_customer_group_id = (
    select customer_group.id
    from public.customer_groups customer_group
    where customer_group.company_id = customer.company_id
      and customer_group.is_available
      and (
        customer_group.tally_group_guid = nullif(customer.source_payload ->> 'customerGroupGuid', '')
        or (
          nullif(customer.source_payload ->> 'customerGroupGuid', '') is null
          and lower(btrim(customer_group.name)) = lower(btrim(nullif(customer.source_payload ->> 'customerGroupName', '')))
        )
      )
    order by case when customer_group.tally_group_guid = nullif(customer.source_payload ->> 'customerGroupGuid', '') then 0 else 1 end
    limit 1
  )
  where customer.company_id = p_company_id;
end;
$$;

revoke all on function public.reconcile_meenakshi_master_relationships(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_meenakshi_master_relationships(uuid) to service_role;

-- Repair existing complete master snapshots immediately. Future master syncs
-- invoke the same routine from the backend ingestion path.
select public.reconcile_meenakshi_master_relationships(company.id)
from public.companies company
where company.is_active;
