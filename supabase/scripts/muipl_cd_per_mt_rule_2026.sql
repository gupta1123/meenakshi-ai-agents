-- MUIPL Cash Discount: new per-MT rule version from 1 Jan 2026.
--
-- Company : MEENAKSHI UDYOG (INDIA) PVT LTD - (2025-2026)
-- Segments: 3 working days  · ₹500/MT → Anuj, Ashok Raju, Jagadeshan, Madesh, Mohan, Neeraj
--           10 working days · ₹500/MT → Praveen Kumar, Rajasekar, Ramesh, Rangarajan, Ranuarora, Shahjahan
-- Products and MT conversion are copied from the active TOD rule.
-- Customers directly under Sundry Debtors (no sub-group) get no Cash Discount.
--
-- How to run: open a new Supabase SQL editor tab, paste this whole file,
-- make sure nothing is selected, and run. Supabase runs it in one
-- transaction, so any error rolls back everything.
-- Requires migration 20260926090000_cash_discount_segments_per_mt.sql.

-- 1. Let per-MT rules activate: they keep payment windows on their segments,
--    not in scheme_version_cd_slabs (same fix as section 9 of the migration).
create or replace function public.prepare_single_active_meenakshi_cd_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.scheme_type = 'cd' and new.status = 'active' then
    if new.cd_discount_basis = 'amount_per_tonne' then
      if not exists (select 1 from public.scheme_version_cd_segments segment where segment.scheme_version_id = new.id) then
        raise exception 'Cash Discount requires at least one segment';
      end if;
    elsif not exists (select 1 from public.scheme_version_cd_slabs slab where slab.scheme_version_id = new.id) then
      raise exception 'Cash Discount requires at least one payment window';
    end if;
    update public.scheme_versions
    set status = 'retired', updated_at = now()
    where company_id = new.company_id and scheme_type = 'cd' and status = 'active' and id <> new.id;
  end if;
  return new;
end;
$fn$;

-- 2. Create the new version, fill it, and activate it.
do $cd$
declare
  v_groups_3_days  text[] := array['Anuj', 'Ashok Raju', 'Jagadeshan', 'Madesh', 'Mohan', 'Neeraj'];
  v_groups_10_days text[] := array['Praveen Kumar', 'Rajasekar', 'Ramesh', 'Rangarajan', 'Ranuarora', 'Shahjahan'];
  v_rate    numeric := 500;
  v_from    date := date '2026-01-01';
  v_company uuid := '963aa157-7c2e-4006-8efb-35902a30ec54';
  v_old     public.scheme_versions;
  v_tod     uuid;
  v_new     uuid;
  v_seg_3   uuid;
  v_seg_10  uuid;
  v_missing text[];
  v_result  jsonb;
begin
  select * into v_old from public.scheme_versions
  where company_id = v_company and scheme_type = 'cd' and status = 'active'
  order by effective_from desc limit 1;
  if v_old.id is null then raise exception 'No active Cash Discount rule found'; end if;
  if v_old.cd_discount_basis = 'amount_per_tonne' then
    raise exception 'The active Cash Discount rule is already per MT (version %). Nothing to do.', v_old.version_number;
  end if;

  select id into v_tod from public.scheme_versions
  where company_id = v_company and scheme_type = 'tod' and status = 'active'
  order by effective_from desc limit 1;
  if v_tod is null then raise exception 'No active TOD rule to copy products from'; end if;

  select array_agg(n) into v_missing
  from unnest(v_groups_3_days || v_groups_10_days) n
  where not exists (select 1 from public.customer_groups g
                    where g.company_id = v_company and g.name = n and g.is_available);
  if v_missing is not null then raise exception 'Customer groups not found: %', v_missing; end if;

  insert into public.scheme_versions (
    company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to,
    discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment,
    credit_note_voucher_type_id, discount_ledger_id, requires_approval,
    working_calendar_id, allowed_working_days, near_eligibility_percent,
    cd_check_narration, cd_invoice_treatment, cd_narration_mode, cd_discount_basis, created_by
  ) values (
    v_company, v_old.scheme_id, 'cd',
    (select max(version_number) + 1 from public.scheme_versions where scheme_id = v_old.scheme_id),
    'draft', v_from, null,
    null, v_old.calculation_base, v_old.rounding_method, v_old.rounding_scale, v_old.gst_treatment,
    v_old.credit_note_voucher_type_id, v_old.discount_ledger_id, v_old.requires_approval,
    v_old.working_calendar_id, null, 80,
    v_old.cd_check_narration, v_old.cd_invoice_treatment, v_old.cd_narration_mode, 'amount_per_tonne', v_old.created_by
  ) returning id into v_new;

  insert into public.scheme_version_cd_segments (scheme_version_id, company_id, label, allowed_working_days, amount_per_tonne, sort_order)
  values (v_new, v_company, '3 working days', 3, v_rate, 1) returning id into v_seg_3;
  insert into public.scheme_version_cd_segments (scheme_version_id, company_id, label, allowed_working_days, amount_per_tonne, sort_order)
  values (v_new, v_company, '10 working days', 10, v_rate, 2) returning id into v_seg_10;

  insert into public.scheme_version_cd_segment_groups (scheme_version_id, segment_id, company_id, customer_group_id)
  select v_new, v_seg_3, v_company, g.id from public.customer_groups g
  where g.company_id = v_company and g.is_available and g.name = any(v_groups_3_days);
  insert into public.scheme_version_cd_segment_groups (scheme_version_id, segment_id, company_id, customer_group_id)
  select v_new, v_seg_10, v_company, g.id from public.customer_groups g
  where g.company_id = v_company and g.is_available and g.name = any(v_groups_10_days);

  insert into public.scheme_version_stock_groups (scheme_version_id, company_id, stock_group_id)
  select v_new, company_id, stock_group_id from public.scheme_version_stock_groups where scheme_version_id = v_tod;
  insert into public.scheme_version_stock_items (scheme_version_id, company_id, stock_item_id)
  select v_new, company_id, stock_item_id from public.scheme_version_stock_items where scheme_version_id = v_tod;
  insert into public.scheme_version_unit_conversions (scheme_version_id, company_id, source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at)
  select v_new, company_id, source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at
  from public.scheme_version_unit_conversions where scheme_version_id = v_tod;

  -- Retires the current version (kept in history), validates, activates.
  v_result := public.activate_meenakshi_scheme_version(v_new, v_old.created_by, null, '{"requestedFrom":"sql_per_mt_rule"}'::jsonb);
  raise notice 'Activated new Cash Discount version %: %', v_new, v_result;
end
$cd$;

-- 3. Check: should show the new version active with 2 segments and 12 groups.
select v.version_number, v.status, v.effective_from, v.cd_discount_basis,
       s.label, s.allowed_working_days, s.amount_per_tonne,
       string_agg(g.name, ', ' order by g.name) as customer_groups
from public.scheme_versions v
join public.scheme_version_cd_segments s on s.scheme_version_id = v.id
join public.scheme_version_cd_segment_groups sg on sg.segment_id = s.id
join public.customer_groups g on g.id = sg.customer_group_id
where v.company_id = '963aa157-7c2e-4006-8efb-35902a30ec54' and v.scheme_type = 'cd' and v.status = 'active'
group by v.version_number, v.status, v.effective_from, v.cd_discount_basis, s.label, s.allowed_working_days, s.amount_per_tonne, s.sort_order
order by s.sort_order;
