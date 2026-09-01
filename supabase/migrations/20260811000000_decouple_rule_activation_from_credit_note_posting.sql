-- Rule activation enables calculation only. Credit Note accounting and tax
-- approval are checked later, when Finance approves a posting to Tally.

alter function public.validate_meenakshi_scheme_version(uuid)
  rename to validate_meenakshi_scheme_version_with_posting_requirements;

create function public.validate_meenakshi_scheme_version(
  p_scheme_version_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  validation_result jsonb;
  activation_issues jsonb;
begin
  validation_result := public.validate_meenakshi_scheme_version_with_posting_requirements(p_scheme_version_id);

  select coalesce(jsonb_agg(issue), '[]'::jsonb)
  into activation_issues
  from jsonb_array_elements(coalesce(validation_result -> 'issues', '[]'::jsonb)) issue
  where issue ->> 'code' not in (
    'credit_note_voucher_type_unavailable',
    'discount_ledger_unavailable_or_taxable',
    'credit_note_tax_policy_missing'
  );

  return jsonb_set(
    jsonb_set(validation_result, '{issues}', activation_issues, true),
    '{valid}',
    to_jsonb(jsonb_array_length(activation_issues) = 0),
    true
  );
end;
$$;

create or replace function public.validate_scheme_version_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  validation_result jsonb;
begin
  if new.status <> 'active' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'Create a rule version as a draft, complete its conditions, then activate it';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(new.company_id::text),
    hashtext(new.scheme_type::text)
  );

  if not exists (
    select 1
    from public.schemes scheme
    where scheme.id = new.scheme_id
      and scheme.company_id = new.company_id
      and scheme.scheme_type = new.scheme_type
      and scheme.status = 'active'
  ) then
    raise exception 'The parent rule must be active before activating a rule version';
  end if;

  -- Accounting defaults may be attached to an already active rule immediately
  -- before a Finance-approved Credit Note is posted. They do not change who is
  -- eligible or how the discount is calculated.
  if old.status = 'active' then
    return new;
  end if;

  validation_result := public.validate_meenakshi_scheme_version(new.id);
  if coalesce((validation_result ->> 'valid')::boolean, false) is not true then
    raise exception 'Rule version cannot be activated: %', validation_result -> 'issues';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_meenakshi_scheme_version(uuid)
  from public, anon, authenticated;
revoke all on function public.validate_meenakshi_scheme_version_with_posting_requirements(uuid)
  from public, anon, authenticated;
grant execute on function public.validate_meenakshi_scheme_version(uuid)
  to service_role;
grant execute on function public.validate_meenakshi_scheme_version_with_posting_requirements(uuid)
  to service_role;

comment on function public.validate_meenakshi_scheme_version(uuid) is
  'Validates rule calculation readiness. Credit Note posting setup is intentionally checked only during Finance approval.';
comment on function public.validate_meenakshi_scheme_version_with_posting_requirements(uuid) is
  'Legacy full validation retained as the source for rule checks and filtered by the activation validator.';
