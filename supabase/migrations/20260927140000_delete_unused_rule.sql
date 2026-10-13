-- Delete a rule completely, but only one that was never used: every version is
-- still a draft (never active, never retired). Its own settings (groups,
-- products, conversions, slabs, segments, tiers) go with it by cascade.
--
-- Anything that records use of a rule (calculations, results, Credit Notes,
-- recovery results) references its version with ON DELETE RESTRICT, and the
-- scheme_versions trigger refuses active/retired/evaluated versions, so a
-- rule with history can never be removed through this function: the whole
-- call fails and nothing is deleted.
create or replace function public.delete_meenakshi_unused_rule(
  p_company_id uuid,
  p_scheme_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  -- Drafts may point at each other (replacement links); clear them first.
  update public.scheme_versions set superseded_by_version_id = null
  where scheme_id = p_scheme_id and company_id = p_company_id and superseded_by_version_id is not null;

  delete from public.scheme_versions where scheme_id = p_scheme_id and company_id = p_company_id;
  delete from public.schemes where id = p_scheme_id and company_id = p_company_id;
end;
$$;

revoke all on function public.delete_meenakshi_unused_rule(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_meenakshi_unused_rule(uuid, uuid) to service_role;
