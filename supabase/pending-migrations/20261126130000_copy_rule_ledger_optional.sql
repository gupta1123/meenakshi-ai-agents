-- Replaces the function from 20261126120000: an unmatched legacy discount ledger no longer blocks the copy.
-- Copy a rule version into another company of the same Tally company (e.g. next financial year's
-- company), as a DRAFT. Additive: creates one function, changes no data and no existing object.
--
-- Why: when a Tally company is split per financial year, the new company starts with no rules.
-- The rule itself is business policy and does not change with the year, so it is copied exactly
-- (every setting, group, stock group, conversion, tier, slab and per-tonne segment). Only the
-- references to Tally masters (groups, ledgers, voucher types, units) are re-pointed to the target
-- company's own master rows, matched by Tally GUID and, failing that, by name.
-- The copy is a draft; it is activated through the normal Rulebook approval, so dates can be
-- reviewed first. Nothing is guessed: any master that cannot be matched stops the whole copy.

create or replace function public.copy_meenakshi_rule_to_company(
  p_source_version_id uuid,
  p_target_company_id uuid,
  p_actor uuid default null,
  p_discount_ledger_id uuid default null -- use when the rule's own ledger no longer exists in the target
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.scheme_versions;
  v_src_scheme public.schemes;
  v_src_company public.companies;
  v_dst_company public.companies;
  v_scheme_id uuid;
  v_version_number integer;
  v_new_id uuid := gen_random_uuid();
  v_row jsonb;
  v_ledger uuid;
  v_vtype uuid;
  v_seg record;
  v_new_seg uuid;
  v_missing text;
begin
  select * into v_src from public.scheme_versions where id = p_source_version_id;
  if not found then raise exception 'Source rule version not found.'; end if;
  select * into v_src_company from public.companies where id = v_src.company_id;
  select * into v_dst_company from public.companies where id = p_target_company_id;
  if v_dst_company.id is null then raise exception 'Target company not found.'; end if;
  if v_src_company.id = v_dst_company.id then raise exception 'Source and target are the same company.'; end if;
  if v_src_company.organization_id <> v_dst_company.organization_id
     or v_src_company.tally_company_guid is distinct from v_dst_company.tally_company_guid then
    raise exception 'Rules can only be copied between companies of the same Tally company.';
  end if;

  select * into v_src_scheme from public.schemes where id = v_src.scheme_id;

  -- Masters the rule points to, matched in the target company.
  if p_discount_ledger_id is not null then
    if not exists (select 1 from public.tally_ledgers where id = p_discount_ledger_id and company_id = p_target_company_id and is_available) then
      raise exception 'The chosen discount ledger is not an available ledger of the target company.';
    end if;
    v_ledger := p_discount_ledger_id;
  else
  select l.id into v_ledger from public.tally_ledgers l
   where l.company_id = p_target_company_id
     and (l.tally_ledger_guid = (select s.tally_ledger_guid from public.tally_ledgers s where s.id = v_src.discount_ledger_id)
          or l.name = (select s.name from public.tally_ledgers s where s.id = v_src.discount_ledger_id))
   order by (l.tally_ledger_guid = (select s.tally_ledger_guid from public.tally_ledgers s where s.id = v_src.discount_ledger_id)) desc nulls last
   limit 1;
  end if;
  -- The rule's discount ledger is a legacy field: credit notes are posted to the sales-discount ledger
  -- derived from each invoice, and activation no longer depends on it. When it cannot be matched (for
  -- example it was deleted from Tally) the copy carries it as empty instead of inventing one.
  select t.id into v_vtype from public.tally_voucher_types t
   where t.company_id = p_target_company_id
     and (t.tally_voucher_type_guid = (select s.tally_voucher_type_guid from public.tally_voucher_types s where s.id = v_src.credit_note_voucher_type_id)
          or t.name = (select s.name from public.tally_voucher_types s where s.id = v_src.credit_note_voucher_type_id))
   order by (t.tally_voucher_type_guid = (select s.tally_voucher_type_guid from public.tally_voucher_types s where s.id = v_src.credit_note_voucher_type_id)) desc nulls last
   limit 1;
  if v_src.credit_note_voucher_type_id is not null and v_vtype is null then
    raise exception 'The credit-note voucher type of this rule does not exist in the target company. Sync its masters first.';
  end if;

  -- Every group / stock group / unit the rule uses must exist in the target, or nothing is copied.
  with src as (
    select 'customer group' kind, g.id, g.tally_group_guid guid, g.name from public.customer_groups g
     where g.id in (select customer_group_id from public.scheme_version_customer_groups where scheme_version_id = v_src.id
                    union select customer_group_id from public.scheme_version_cd_segment_groups where scheme_version_id = v_src.id)
    union all
    select 'stock group', g.id, g.tally_group_guid, g.name from public.stock_groups g
     where g.id in (select stock_group_id from public.scheme_version_stock_groups where scheme_version_id = v_src.id)
    union all
    select 'stock item', i.id, i.tally_stock_item_guid, i.name from public.stock_items i
     where i.id in (select stock_item_id from public.scheme_version_stock_items where scheme_version_id = v_src.id)
    union all
    select 'unit', u.id, u.tally_guid, u.name from public.tally_units u
     where u.id in (select source_uom_id from public.scheme_version_unit_conversions where scheme_version_id = v_src.id)
  )
  select string_agg(s.kind || ' "' || s.name || '"', ', ') into v_missing from src s
   where not exists (
     select 1 from (
       select 'customer group' kind, tally_group_guid guid, name from public.customer_groups where company_id = p_target_company_id
       union all select 'stock group', tally_group_guid, name from public.stock_groups where company_id = p_target_company_id
       union all select 'stock item', tally_stock_item_guid, name from public.stock_items where company_id = p_target_company_id
       union all select 'unit', tally_guid, name from public.tally_units where company_id = p_target_company_id
     ) d where d.kind = s.kind and (d.guid = s.guid or d.name = s.name));
  if v_missing is not null then
    raise exception 'Not found in the target company: %. Sync its masters first.', v_missing;
  end if;

  -- Scheme: reuse the same code in the target company, or create it.
  select id into v_scheme_id from public.schemes where company_id = p_target_company_id and code = v_src_scheme.code;
  if v_scheme_id is null then
    insert into public.schemes (company_id, scheme_type, code, name, description, status, created_by)
    values (p_target_company_id, v_src_scheme.scheme_type, v_src_scheme.code, v_src_scheme.name, v_src_scheme.description, 'draft', p_actor)
    returning id into v_scheme_id;
  end if;
  select coalesce(max(version_number), 0) + 1 into v_version_number from public.scheme_versions where scheme_id = v_scheme_id;

  -- The version row: every setting copied as is; only identity and company references change.
  v_row := to_jsonb(v_src) || jsonb_build_object(
    'id', v_new_id, 'company_id', p_target_company_id, 'scheme_id', v_scheme_id,
    'version_number', v_version_number, 'status', 'draft',
    'discount_ledger_id', v_ledger, 'credit_note_voucher_type_id', v_vtype,
    'superseded_by_version_id', null, 'created_by', p_actor,
    'created_at', now(), 'updated_at', now());
  insert into public.scheme_versions select * from jsonb_populate_record(null::public.scheme_versions, v_row);

  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id, include_descendants)
  select v_new_id, p_target_company_id, d.id, s.include_descendants
    from public.scheme_version_customer_groups s
    join public.customer_groups sg on sg.id = s.customer_group_id
    join lateral (select id from public.customer_groups where company_id = p_target_company_id and (tally_group_guid = sg.tally_group_guid or name = sg.name)
                  order by (tally_group_guid = sg.tally_group_guid) desc nulls last limit 1) d on true
   where s.scheme_version_id = v_src.id;

  insert into public.scheme_version_stock_groups (scheme_version_id, company_id, stock_group_id)
  select v_new_id, p_target_company_id, d.id
    from public.scheme_version_stock_groups s
    join public.stock_groups sg on sg.id = s.stock_group_id
    join lateral (select id from public.stock_groups where company_id = p_target_company_id and (tally_group_guid = sg.tally_group_guid or name = sg.name)
                  order by (tally_group_guid = sg.tally_group_guid) desc nulls last limit 1) d on true
   where s.scheme_version_id = v_src.id;

  insert into public.scheme_version_stock_items (scheme_version_id, company_id, stock_item_id)
  select v_new_id, p_target_company_id, d.id
    from public.scheme_version_stock_items s
    join public.stock_items si on si.id = s.stock_item_id
    join lateral (select id from public.stock_items where company_id = p_target_company_id and (tally_stock_item_guid = si.tally_stock_item_guid or name = si.name)
                  order by (tally_stock_item_guid = si.tally_stock_item_guid) desc nulls last limit 1) d on true
   where s.scheme_version_id = v_src.id;

  insert into public.scheme_version_unit_conversions (scheme_version_id, company_id, source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at)
  select v_new_id, p_target_company_id, d.id, s.tonnes_per_source_unit, s.is_builtin, s.approved_by, s.approved_at
    from public.scheme_version_unit_conversions s
    join public.tally_units u on u.id = s.source_uom_id
    join lateral (select id from public.tally_units where company_id = p_target_company_id and (tally_guid = u.tally_guid or name = u.name)
                  order by (tally_guid = u.tally_guid) desc nulls last limit 1) d on true
   where s.scheme_version_id = v_src.id;

  insert into public.scheme_version_tiers (scheme_version_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne)
  select v_new_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne
    from public.scheme_version_tiers where scheme_version_id = v_src.id;

  insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
  select v_new_id, allowed_working_days, discount_percentage
    from public.scheme_version_cd_slabs where scheme_version_id = v_src.id;

  for v_seg in select * from public.scheme_version_cd_segments where scheme_version_id = v_src.id order by sort_order loop
    insert into public.scheme_version_cd_segments (scheme_version_id, company_id, label, allowed_working_days, amount_per_tonne, sort_order)
    values (v_new_id, p_target_company_id, v_seg.label, v_seg.allowed_working_days, v_seg.amount_per_tonne, v_seg.sort_order)
    returning id into v_new_seg;
    insert into public.scheme_version_cd_segment_groups (scheme_version_id, segment_id, company_id, customer_group_id)
    select v_new_id, v_new_seg, p_target_company_id, d.id
      from public.scheme_version_cd_segment_groups s
      join public.customer_groups sg on sg.id = s.customer_group_id
      join lateral (select id from public.customer_groups where company_id = p_target_company_id and (tally_group_guid = sg.tally_group_guid or name = sg.name)
                    order by (tally_group_guid = sg.tally_group_guid) desc nulls last limit 1) d on true
     where s.segment_id = v_seg.id;
  end loop;

  return v_new_id;
end;
$$;

revoke all on function public.copy_meenakshi_rule_to_company(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.copy_meenakshi_rule_to_company(uuid, uuid, uuid, uuid) to service_role;
