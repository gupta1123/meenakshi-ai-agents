-- Preserve the active TOD calculation basis while creating its editable copy.
-- Without this, the defaulting trigger temporarily treats amount-per-tonne
-- rules as percentage rules and rejects their copied tiers.

create or replace function public.get_or_create_meenakshi_rule_draft(
  p_company_id uuid,
  p_scheme_id uuid,
  p_source_version_id uuid,
  p_actor_id uuid,
  p_terms jsonb,
  p_slabs jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_source public.scheme_versions%rowtype;
  v_existing_id uuid;
  v_version_id uuid;
  v_version_number integer;
begin
  if jsonb_typeof(p_terms) <> 'object' then
    raise exception 'Rule terms must be an object';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_scheme_id::text));

  select * into v_source
  from public.scheme_versions
  where id = p_source_version_id
    and company_id = p_company_id
    and scheme_id = p_scheme_id
  for share;
  if not found or v_source.status <> 'active' then
    raise exception 'The current active rule could not be found';
  end if;

  select id into v_existing_id
  from public.scheme_versions
  where company_id = p_company_id
    and scheme_id = p_scheme_id
    and status = 'draft'
  order by created_at desc
  limit 1;
  if v_existing_id is not null then
    return jsonb_build_object('versionId', v_existing_id, 'replayed', true);
  end if;

  select coalesce(max(version_number), 0) + 1 into v_version_number
  from public.scheme_versions
  where scheme_id = p_scheme_id;

  insert into public.scheme_versions (
    company_id, scheme_id, scheme_type, version_number, status,
    effective_from, effective_to, discount_percentage, calculation_base,
    rounding_method, rounding_scale, gst_treatment,
    credit_note_voucher_type_id, discount_ledger_id, requires_approval,
    working_calendar_id, allowed_working_days, near_eligibility_percent,
    cd_invoice_treatment, cd_narration_mode, cd_check_narration,
    period_months, period_anchor_date, tod_review_calendar_id,
    tod_benefit_basis, created_by
  ) values (
    p_company_id, p_scheme_id, v_source.scheme_type, v_version_number, 'draft',
    (p_terms ->> 'effective_from')::date,
    nullif(p_terms ->> 'effective_to', '')::date,
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'discount_percentage')::numeric else null end,
    coalesce(p_terms ->> 'calculation_base', v_source.calculation_base),
    coalesce(p_terms ->> 'rounding_method', v_source.rounding_method::text)::public.rounding_method,
    coalesce((p_terms ->> 'rounding_scale')::smallint, v_source.rounding_scale),
    coalesce(p_terms ->> 'gst_treatment', v_source.gst_treatment::text)::public.gst_treatment,
    v_source.credit_note_voucher_type_id, v_source.discount_ledger_id,
    coalesce((p_terms ->> 'requires_approval')::boolean, v_source.requires_approval),
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'working_calendar_id')::uuid else null end,
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'allowed_working_days')::smallint else null end,
    case when v_source.scheme_type = 'cd' then (p_terms ->> 'near_eligibility_percent')::numeric else null end,
    case when v_source.scheme_type = 'cd' then coalesce(v_source.cd_invoice_treatment, 'deducted_upfront') else null end,
    case when v_source.scheme_type = 'cd' then coalesce(v_source.cd_narration_mode, 'informational') else null end,
    case when v_source.scheme_type = 'cd' then coalesce((p_terms ->> 'cd_check_narration')::boolean, v_source.cd_check_narration, true) else true end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'period_months')::smallint else null end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'period_anchor_date')::date else null end,
    case when v_source.scheme_type = 'tod' then (p_terms ->> 'tod_review_calendar_id')::uuid else null end,
    case when v_source.scheme_type = 'tod' then coalesce(p_terms ->> 'tod_benefit_basis', v_source.tod_benefit_basis) else null end,
    p_actor_id
  ) returning id into v_version_id;

  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id, include_descendants)
  select v_version_id, company_id, customer_group_id, include_descendants
  from public.scheme_version_customer_groups
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_stock_items (scheme_version_id, company_id, stock_item_id)
  select v_version_id, company_id, stock_item_id
  from public.scheme_version_stock_items
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_stock_groups (scheme_version_id, company_id, stock_group_id)
  select v_version_id, company_id, stock_group_id
  from public.scheme_version_stock_groups
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_unit_conversions (
    scheme_version_id, company_id, source_uom_id, tonnes_per_source_unit,
    is_builtin, approved_by, approved_at
  )
  select v_version_id, company_id, source_uom_id, tonnes_per_source_unit,
    is_builtin, approved_by, approved_at
  from public.scheme_version_unit_conversions
  where scheme_version_id = v_source.id;

  insert into public.scheme_version_tiers (
    scheme_version_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne
  )
  select v_version_id, minimum_tonnes, discount_percentage, discount_amount_per_tonne
  from public.scheme_version_tiers
  where scheme_version_id = v_source.id;

  if v_source.scheme_type = 'cd' then
    if jsonb_typeof(p_slabs) = 'array' and jsonb_array_length(p_slabs) > 0 then
      insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
      select v_version_id, slab.allowed_working_days, slab.discount_percentage
      from jsonb_to_recordset(p_slabs) as slab(allowed_working_days smallint, discount_percentage numeric);
    else
      insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
      select v_version_id, allowed_working_days, discount_percentage
      from public.scheme_version_cd_slabs
      where scheme_version_id = v_source.id;
    end if;
  end if;

  return jsonb_build_object('versionId', v_version_id, 'replayed', false);
end;
$$;

revoke all on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  to service_role;
