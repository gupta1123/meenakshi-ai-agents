-- Restore the server-only Rulebook write functions used by the current API.
-- They create a separate, editable pending version and never mutate the active
-- rule or its configuration.

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
    period_months, period_anchor_date, tod_review_calendar_id, created_by
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

  insert into public.scheme_version_tiers (scheme_version_id, minimum_tonnes, discount_percentage)
  select v_version_id, minimum_tonnes, discount_percentage
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

create or replace function public.update_meenakshi_rule_draft(
  p_version_id uuid,
  p_company_id uuid,
  p_actor_id uuid,
  p_update jsonb,
  p_slabs jsonb default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_version public.scheme_versions%rowtype;
begin
  if jsonb_typeof(p_update) <> 'object' then
    raise exception 'Rule update must be an object';
  end if;

  select * into v_version
  from public.scheme_versions
  where id = p_version_id and company_id = p_company_id
  for update;
  if not found or v_version.status <> 'draft' then
    raise exception 'Only a pending rule update can be changed';
  end if;

  update public.scheme_versions
  set effective_from = case when p_update ? 'effective_from' then (p_update ->> 'effective_from')::date else effective_from end,
      effective_to = case when p_update ? 'effective_to' then nullif(p_update ->> 'effective_to', '')::date else effective_to end,
      rounding_method = case when p_update ? 'rounding_method' then (p_update ->> 'rounding_method')::public.rounding_method else rounding_method end,
      rounding_scale = case when p_update ? 'rounding_scale' then (p_update ->> 'rounding_scale')::smallint else rounding_scale end,
      requires_approval = case when p_update ? 'requires_approval' then (p_update ->> 'requires_approval')::boolean else requires_approval end,
      credit_note_voucher_type_id = case when p_update ? 'credit_note_voucher_type_id' then (p_update ->> 'credit_note_voucher_type_id')::uuid else credit_note_voucher_type_id end,
      discount_ledger_id = case when p_update ? 'discount_ledger_id' then (p_update ->> 'discount_ledger_id')::uuid else discount_ledger_id end,
      discount_percentage = case when p_update ? 'discount_percentage' then (p_update ->> 'discount_percentage')::numeric else discount_percentage end,
      working_calendar_id = case when p_update ? 'working_calendar_id' then (p_update ->> 'working_calendar_id')::uuid else working_calendar_id end,
      allowed_working_days = case when p_update ? 'allowed_working_days' then (p_update ->> 'allowed_working_days')::smallint else allowed_working_days end,
      near_eligibility_percent = case when p_update ? 'near_eligibility_percent' then (p_update ->> 'near_eligibility_percent')::numeric else near_eligibility_percent end,
      cd_invoice_treatment = case when p_update ? 'cd_invoice_treatment' then p_update ->> 'cd_invoice_treatment' else cd_invoice_treatment end,
      cd_narration_mode = case when p_update ? 'cd_narration_mode' then p_update ->> 'cd_narration_mode' else cd_narration_mode end,
      cd_check_narration = case when p_update ? 'cd_check_narration' then (p_update ->> 'cd_check_narration')::boolean else cd_check_narration end,
      period_months = case when p_update ? 'period_months' then (p_update ->> 'period_months')::smallint else period_months end,
      period_anchor_date = case when p_update ? 'period_anchor_date' then (p_update ->> 'period_anchor_date')::date else period_anchor_date end,
      tod_review_calendar_id = case when p_update ? 'tod_review_calendar_id' then (p_update ->> 'tod_review_calendar_id')::uuid else tod_review_calendar_id end,
      updated_at = now()
  where id = p_version_id and company_id = p_company_id;

  if p_slabs is not null then
    if v_version.scheme_type <> 'cd' or jsonb_typeof(p_slabs) <> 'array' or jsonb_array_length(p_slabs) = 0 then
      raise exception 'Cash Discount payment windows are required';
    end if;
    delete from public.scheme_version_cd_slabs where scheme_version_id = p_version_id;
    insert into public.scheme_version_cd_slabs (scheme_version_id, allowed_working_days, discount_percentage)
    select p_version_id, slab.allowed_working_days, slab.discount_percentage
    from jsonb_to_recordset(p_slabs) as slab(allowed_working_days smallint, discount_percentage numeric);
  end if;

  return jsonb_build_object('versionId', p_version_id);
end;
$$;

revoke all on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_create_meenakshi_rule_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  to service_role;

revoke all on function public.update_meenakshi_rule_draft(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_meenakshi_rule_draft(uuid, uuid, uuid, jsonb, jsonb)
  to service_role;
