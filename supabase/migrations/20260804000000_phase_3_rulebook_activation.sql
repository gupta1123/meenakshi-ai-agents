-- Meenakshi Phase 3: provide one server-only, atomic Rulebook activation path.
-- The existing trigger remains the final database guard.  These functions give
-- the API a structured preflight result and ensure an allowed activation and
-- its audit record commit together.

create or replace function public.validate_meenakshi_scheme_version(
  p_scheme_version_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_version public.scheme_versions%rowtype;
  v_issues jsonb := '[]'::jsonb;
begin
  select * into v_version
  from public.scheme_versions version
  where version.id = p_scheme_version_id;

  if not found then
    return jsonb_build_object(
      'schemeVersionId', p_scheme_version_id,
      'valid', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'rule_version_not_found', 'message', 'Rule version was not found.'))
    );
  end if;

  if v_version.status not in ('draft', 'validated', 'active') then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'rule_version_not_activatable',
      'message', 'Only draft, validated, or already active rule versions can be validated.'
    ));
  end if;

  -- Coverage is derived from the currently synchronized Tally master graph.
  perform public.refresh_scheme_version_group_coverage(v_version.id);
  perform public.refresh_scheme_version_stock_group_coverage(v_version.id);

  if not exists (
    select 1
    from (
      select sync.status, sync.completed_at
      from public.tally_sync_runs sync
      where sync.company_id = v_version.company_id
        and sync.sync_kind = 'masters'
      order by sync.created_at desc
      limit 1
    ) latest_sync
    where latest_sync.status = 'completed'
      and latest_sync.completed_at >= now() - interval '24 hours'
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'master_sync_stale',
      'message', 'A successful full master sync from the last 24 hours is required before activation.'
    ));
  end if;

  if not exists (
    select 1
    from public.scheme_version_group_coverage coverage
    where coverage.scheme_version_id = v_version.id
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'customer_group_required',
      'message', 'Select at least one available Tally customer group.'
    ));
  end if;

  if exists (
    select 1
    from public.scheme_version_customer_groups selected
    join public.customer_groups tally_group
      on tally_group.id = selected.customer_group_id
     and tally_group.company_id = selected.company_id
    where selected.scheme_version_id = v_version.id
      and not tally_group.is_available
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'customer_group_unavailable',
      'message', 'A selected Tally customer group is no longer available.'
    ));
  end if;

  if not exists (
    select 1
    from public.tally_voucher_types voucher_type
    where voucher_type.id = v_version.credit_note_voucher_type_id
      and voucher_type.company_id = v_version.company_id
      and voucher_type.is_available
      and voucher_type.is_credit_note_type
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'credit_note_voucher_type_unavailable',
      'message', 'Select a live Tally Credit Note voucher type.'
    ));
  end if;

  if not exists (
    select 1
    from public.tally_ledgers ledger
    where ledger.id = v_version.discount_ledger_id
      and ledger.company_id = v_version.company_id
      and ledger.is_available
      and lower(coalesce(ledger.gst_applicability, '')) = 'not applicable'
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'discount_ledger_unavailable_or_taxable',
      'message', 'Select a live discount ledger with GST set to Not Applicable.'
    ));
  end if;

  if not exists (
    select 1
    from public.company_credit_note_tax_policies policy
    where policy.company_id = v_version.company_id
      and policy.gst_treatment = v_version.gst_treatment
      and policy.effective_from <= v_version.effective_from
      and (
        (v_version.effective_to is null and policy.effective_to is null)
        or (v_version.effective_to is not null and (policy.effective_to is null or policy.effective_to >= v_version.effective_to))
      )
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'credit_note_tax_policy_missing',
      'message', 'Finance/CA Credit Note tax-policy evidence must cover the complete rule period.'
    ));
  end if;

  if v_version.scheme_type = 'cd' then
    if not exists (
      select 1
      from public.working_calendars calendar
      where calendar.id = v_version.working_calendar_id
        and calendar.company_id = v_version.company_id
        and calendar.is_active
    ) then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code', 'working_calendar_unavailable',
        'message', 'Select an active working calendar for the CD rule.'
      ));
    end if;
  else
    if not exists (
      select 1
      from public.scheme_version_tiers tier
      where tier.scheme_version_id = v_version.id
    ) then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code', 'tod_tier_required',
        'message', 'Add at least one TOD quantity tier.'
      ));
    end if;

    if exists (
      select 1
      from (
        select
          tier.discount_percentage,
          lag(tier.discount_percentage) over (order by tier.minimum_tonnes) as previous_percentage
        from public.scheme_version_tiers tier
        where tier.scheme_version_id = v_version.id
      ) ordered_tiers
      where ordered_tiers.previous_percentage is not null
        and ordered_tiers.discount_percentage < ordered_tiers.previous_percentage
    ) then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code', 'tod_tier_rate_decreases',
        'message', 'TOD tier percentages cannot decrease at a higher tonne threshold.'
      ));
    end if;

    if not exists (
      select 1
      from public.scheme_version_stock_items item
      where item.scheme_version_id = v_version.id
    ) and not exists (
      select 1
      from public.scheme_version_stock_group_coverage coverage
      where coverage.scheme_version_id = v_version.id
    ) then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code', 'tod_stock_selection_required',
        'message', 'Select at least one live eligible stock item or stock group.'
      ));
    end if;

    if exists (
      select 1
      from public.stock_items item
      where item.company_id = v_version.company_id
        and item.is_available
        and (
          exists (
            select 1
            from public.scheme_version_stock_items selected_item
            where selected_item.scheme_version_id = v_version.id
              and selected_item.stock_item_id = item.id
          )
          or exists (
            select 1
            from public.scheme_version_stock_group_coverage covered_group
            where covered_group.scheme_version_id = v_version.id
              and covered_group.stock_group_id = item.current_stock_group_id
          )
        )
        and not exists (
          select 1
          from public.scheme_version_unit_conversions conversion
          join public.tally_units unit
            on unit.id = conversion.source_uom_id
           and unit.company_id = conversion.company_id
          where conversion.scheme_version_id = v_version.id
            and conversion.source_uom_id = item.default_uom_id
            and unit.is_available
        )
    ) then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code', 'tod_uom_conversion_required',
        'message', 'Add an approved tonne conversion for every selected stock item UOM.'
      ));
    end if;
  end if;

  if exists (
    select 1
    from public.scheme_versions other_version
    join public.scheme_version_group_coverage other_coverage
      on other_coverage.scheme_version_id = other_version.id
    join public.scheme_version_group_coverage new_coverage
      on new_coverage.scheme_version_id = v_version.id
     and new_coverage.customer_group_id = other_coverage.customer_group_id
    where other_version.id <> v_version.id
      and other_version.company_id = v_version.company_id
      and other_version.scheme_type = v_version.scheme_type
      and other_version.status = 'active'
      and daterange(
        other_version.effective_from,
        coalesce(other_version.effective_to + 1, 'infinity'::date),
        '[)'
      ) && daterange(
        v_version.effective_from,
        coalesce(v_version.effective_to + 1, 'infinity'::date),
        '[)'
      )
  ) then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code', 'customer_group_coverage_overlap',
      'message', 'Another active rule of the same type overlaps this customer-group coverage and effective period.'
    ));
  end if;

  return jsonb_build_object(
    'schemeVersionId', v_version.id,
    'schemeId', v_version.scheme_id,
    'schemeType', v_version.scheme_type,
    'valid', jsonb_array_length(v_issues) = 0,
    'issues', v_issues
  );
end;
$$;

create or replace function public.activate_meenakshi_scheme_version(
  p_scheme_version_id uuid,
  p_actor_id uuid,
  p_correlation_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_version public.scheme_versions%rowtype;
  v_scheme public.schemes%rowtype;
  v_organization_id uuid;
  v_validation jsonb;
begin
  select * into v_version
  from public.scheme_versions version
  where version.id = p_scheme_version_id
  for update;
  if not found then
    raise exception 'Rule version was not found';
  end if;

  if v_version.status = 'active' then
    return jsonb_build_object(
      'schemeVersionId', v_version.id,
      'schemeId', v_version.scheme_id,
      'status', v_version.status,
      'alreadyActive', true
    );
  end if;
  if v_version.status not in ('draft', 'validated') then
    raise exception 'Only a draft or validated rule version can be activated';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(v_version.company_id::text),
    hashtext(v_version.scheme_type::text)
  );

  v_validation := public.validate_meenakshi_scheme_version(v_version.id);
  if coalesce((v_validation ->> 'valid')::boolean, false) is not true then
    raise exception 'Rule version cannot be activated: %', v_validation -> 'issues';
  end if;

  select * into v_scheme
  from public.schemes scheme
  where scheme.id = v_version.scheme_id
    and scheme.company_id = v_version.company_id
    and scheme.scheme_type = v_version.scheme_type
  for update;
  if not found or v_scheme.status = 'retired' then
    raise exception 'The parent scheme is unavailable';
  end if;

  select company.organization_id into v_organization_id
  from public.companies company
  where company.id = v_version.company_id
    and company.is_active;
  if v_organization_id is null then
    raise exception 'The company is unavailable';
  end if;

  -- The existing trigger re-runs the final validation after this update.
  update public.schemes
  set status = 'active'
  where id = v_scheme.id
    and status <> 'active';

  update public.scheme_versions
  set status = 'active'
  where id = v_version.id;

  insert into public.audit_events (
    organization_id,
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    correlation_id,
    previous_value,
    new_value,
    metadata
  ) values (
    v_organization_id,
    v_version.company_id,
    'user',
    p_actor_id,
    'scheme_version_activated',
    'scheme_version',
    v_version.id,
    p_correlation_id,
    jsonb_build_object('status', v_version.status, 'schemeStatus', v_scheme.status),
    jsonb_build_object('status', 'active', 'schemeStatus', 'active'),
    case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end
  );

  return jsonb_build_object(
    'schemeVersionId', v_version.id,
    'schemeId', v_version.scheme_id,
    'status', 'active',
    'alreadyActive', false,
    'validation', v_validation
  );
end;
$$;

revoke all on function public.validate_meenakshi_scheme_version(uuid)
  from public, anon, authenticated;
revoke all on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.validate_meenakshi_scheme_version(uuid)
  to service_role;
grant execute on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb)
  to service_role;

comment on function public.validate_meenakshi_scheme_version(uuid) is
  'Server-only Phase 3 preflight for a draft Rulebook version. It refreshes live master coverage and returns structured activation blockers.';
comment on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb) is
  'Server-only atomic Phase 3 activation. It revalidates, activates the parent scheme/version, and appends its audit event in one transaction.';
