-- Activate a replacement rule atomically. The predecessor must be retired
-- before validation so it is not reported as an overlapping active rule.
-- When a replacement is backdated, keep the predecessor's historical dates;
-- only its lifecycle status changes.

alter table public.scheme_versions
  add column if not exists superseded_by_version_id uuid
  references public.scheme_versions(id) on delete restrict;

create index if not exists scheme_versions_superseded_by_idx
  on public.scheme_versions (superseded_by_version_id)
  where superseded_by_version_id is not null;

-- Some deployed databases predate the atomic replacement migration. Keep this
-- migration self-contained by installing its compatible immutability guard too.
create or replace function public.prevent_scheme_version_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('active', 'retired')
       or exists (select 1 from public.discount_proposals proposal where proposal.scheme_version_id = old.id) then
      raise exception 'Active or evaluated rule versions cannot be deleted';
    end if;
    return old;
  end if;

  if old.status in ('active', 'retired')
     or exists (select 1 from public.discount_proposals proposal where proposal.scheme_version_id = old.id) then
    if new.status = 'retired'
       and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
      return new;
    end if;
    if old.status = 'active'
       and new.status = 'retired'
       and new.superseded_by_version_id is not null
       and new.effective_to = (
         select replacement.effective_from - 1
         from public.scheme_versions replacement
         where replacement.id = new.superseded_by_version_id
           and replacement.company_id = old.company_id
           and replacement.scheme_type = old.scheme_type
       )
       and (to_jsonb(new) - 'status' - 'updated_at' - 'effective_to' - 'superseded_by_version_id')
         = (to_jsonb(old) - 'status' - 'updated_at' - 'effective_to' - 'superseded_by_version_id') then
      return new;
    end if;
    raise exception 'Active or evaluated rule versions are immutable; create a new version instead';
  end if;
  return new;
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
  v_superseded_ids uuid[] := array[]::uuid[];
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

  select coalesce(array_agg(distinct old_version.id), array[]::uuid[])
  into v_superseded_ids
  from public.scheme_versions old_version
  join public.scheme_version_group_coverage old_coverage
    on old_coverage.scheme_version_id = old_version.id
  join public.scheme_version_group_coverage new_coverage
    on new_coverage.scheme_version_id = v_version.id
   and new_coverage.customer_group_id = old_coverage.customer_group_id
  where old_version.id <> v_version.id
    and old_version.company_id = v_version.company_id
    and old_version.scheme_type = v_version.scheme_type
    and old_version.status = 'active'
    and daterange(
      old_version.effective_from,
      coalesce(old_version.effective_to + 1, 'infinity'::date),
      '[)'
    ) && daterange(
      v_version.effective_from,
      coalesce(v_version.effective_to + 1, 'infinity'::date),
      '[)'
    );

  -- A forward replacement closes the predecessor on the day before the new
  -- rule starts. A backdated replacement cannot safely shorten that historical
  -- interval, so retain its dates and retire only its lifecycle status.
  update public.scheme_versions old_version
  set status = 'retired',
      effective_to = case
        when old_version.effective_from < v_version.effective_from
          then v_version.effective_from - 1
        else old_version.effective_to
      end,
      superseded_by_version_id = case
        when old_version.effective_from < v_version.effective_from
          then v_version.id
        else old_version.superseded_by_version_id
      end
  where old_version.id = any(v_superseded_ids);

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
    raise exception 'The parent rule is unavailable';
  end if;

  select company.organization_id into v_organization_id
  from public.companies company
  where company.id = v_version.company_id
    and company.is_active;

  if v_organization_id is null then
    raise exception 'The company is unavailable';
  end if;

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
    (case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end)
      || jsonb_build_object('supersededVersionIds', to_jsonb(v_superseded_ids))
  );

  return jsonb_build_object(
    'schemeVersionId', v_version.id,
    'schemeId', v_version.scheme_id,
    'status', 'active',
    'alreadyActive', false,
    'supersededVersionIds', to_jsonb(v_superseded_ids),
    'validation', v_validation
  );
end;
$$;

revoke all on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb)
  to service_role;

comment on function public.activate_meenakshi_scheme_version(uuid, uuid, uuid, jsonb) is
  'Atomically retires overlapping predecessors, validates the replacement, activates it, and records the audit event.';
