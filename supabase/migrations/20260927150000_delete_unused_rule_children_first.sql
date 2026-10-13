-- Fix: deleting a never-used rule failed with "Payment windows are only
-- available for Cash Discount rules". Deleting a version removed its settings
-- by cascade, and the settings-table triggers (payment windows, group and
-- product coverage) then looked up a version that was already gone.
-- Now each settings table is cleared while its version still exists, and the
-- versions and rule are deleted last. Same rule as before: only drafts.
create or replace function public.delete_meenakshi_unused_rule(
  p_company_id uuid,
  p_scheme_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  version_ids uuid[];
begin
  perform 1 from public.schemes where id = p_scheme_id and company_id = p_company_id for update;
  if not found then
    raise exception 'This rule was not found.';
  end if;

  if exists (
    select 1 from public.scheme_versions
    where scheme_id = p_scheme_id and company_id = p_company_id and status <> 'draft'
  ) then
    raise exception 'This rule has been in use. Retire it instead; its history must be kept.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(id), '{}') into version_ids
  from public.scheme_versions where scheme_id = p_scheme_id and company_id = p_company_id;

  -- Settings first, while their versions still exist.
  delete from public.scheme_version_cd_segment_groups where scheme_version_id = any(version_ids);
  delete from public.scheme_version_cd_segments where scheme_version_id = any(version_ids);
  delete from public.scheme_version_cd_slabs where scheme_version_id = any(version_ids);
  delete from public.scheme_version_tiers where scheme_version_id = any(version_ids);
  delete from public.scheme_version_unit_conversions where scheme_version_id = any(version_ids);
  delete from public.scheme_version_stock_items where scheme_version_id = any(version_ids);
  delete from public.scheme_version_stock_groups where scheme_version_id = any(version_ids);
  delete from public.scheme_version_customer_groups where scheme_version_id = any(version_ids);
  delete from public.scheme_version_stock_group_coverage where scheme_version_id = any(version_ids);
  delete from public.scheme_version_group_coverage where scheme_version_id = any(version_ids);

  -- Drafts may point at each other (replacement links); clear them, then delete.
  update public.scheme_versions set superseded_by_version_id = null
  where id = any(version_ids) and superseded_by_version_id is not null;
  delete from public.scheme_versions where id = any(version_ids);
  delete from public.schemes where id = p_scheme_id and company_id = p_company_id;
end;
$$;

revoke all on function public.delete_meenakshi_unused_rule(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_meenakshi_unused_rule(uuid, uuid) to service_role;
