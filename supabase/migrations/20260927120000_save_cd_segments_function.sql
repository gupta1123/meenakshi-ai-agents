-- Save a draft Cash Discount rule's segments in one call and one transaction.
-- Before: the API made ~10 round trips (switch to per-MT, clear slabs,
-- segments and old groups, then insert each segment and its groups), and a
-- failure midway could leave a half-saved draft. Validation (groups under
-- Sundry Debtors, one segment per group) stays in the API.
--
-- p_segments: [{ "label": text, "allowedWorkingDays": int, "amountPerTonne": numeric, "customerGroupIds": [uuid] }]
create or replace function public.save_meenakshi_cd_segments(
  p_company_id uuid,
  p_version_id uuid,
  p_segments jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  segment jsonb;
  segment_index int := 0;
  new_segment_id uuid;
begin
  if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'Add at least one segment.';
  end if;

  -- Switch the draft to per-MT; days and rate now live on the segments.
  update public.scheme_versions
  set cd_discount_basis = 'amount_per_tonne', discount_percentage = null, allowed_working_days = null
  where id = p_version_id and company_id = p_company_id and status = 'draft' and scheme_type = 'cd';
  if not found then
    raise exception 'Only draft Cash Discount rules can be changed.';
  end if;

  delete from public.scheme_version_cd_slabs where scheme_version_id = p_version_id;
  delete from public.scheme_version_cd_segments where scheme_version_id = p_version_id;
  -- Groups picked before segments existed are replaced by the segment groups.
  delete from public.scheme_version_customer_groups where scheme_version_id = p_version_id;

  for segment in select value from jsonb_array_elements(p_segments) loop
    insert into public.scheme_version_cd_segments (scheme_version_id, company_id, label, allowed_working_days, amount_per_tonne, sort_order)
    values (
      p_version_id, p_company_id,
      segment ->> 'label',
      (segment ->> 'allowedWorkingDays')::smallint,
      (segment ->> 'amountPerTonne')::numeric,
      segment_index
    )
    returning id into new_segment_id;

    insert into public.scheme_version_cd_segment_groups (scheme_version_id, segment_id, company_id, customer_group_id)
    select p_version_id, new_segment_id, p_company_id, group_id::uuid
    from jsonb_array_elements_text(segment -> 'customerGroupIds') as group_id;

    segment_index := segment_index + 1;
  end loop;
end;
$$;

revoke all on function public.save_meenakshi_cd_segments(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_meenakshi_cd_segments(uuid, uuid, jsonb) to service_role;
