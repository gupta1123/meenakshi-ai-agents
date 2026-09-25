-- Several Cash Discount rules may be active for the same customers (the page
-- selects which rule to calculate; results are kept per rule). For Cash
-- Discount only, activation replaces just older versions of the SAME rule and
-- validation ignores other rules. Turnover Discount is unchanged.

do $$
declare
  target_function regprocedure;
  function_definition text;
  anchor text := 'and other_version.status = ''active''';
begin
  target_function := to_regprocedure('public.validate_meenakshi_scheme_version(uuid)');
  if target_function is null then raise exception 'validate_meenakshi_scheme_version was not found'; end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position(anchor in function_definition) = 0 then raise exception 'validate_meenakshi_scheme_version has an unexpected overlap check'; end if;
  function_definition := replace(function_definition, anchor,
    anchor || ' and (v_version.scheme_type <> ''cd'' or other_version.scheme_id = v_version.scheme_id)');
  execute function_definition;
end;
$$;

do $$
declare
  target_function regprocedure;
  function_definition text;
  anchor text := 'and old_version.status = ''active''';
begin
  target_function := to_regprocedure('public.activate_meenakshi_scheme_version(uuid,uuid,uuid,jsonb)');
  if target_function is null then raise exception 'activate_meenakshi_scheme_version was not found'; end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position(anchor in function_definition) = 0 then raise exception 'activate_meenakshi_scheme_version has an unexpected replacement rule'; end if;
  function_definition := replace(function_definition, anchor,
    anchor || ' and (v_version.scheme_type <> ''cd'' or old_version.scheme_id = v_version.scheme_id)');
  execute function_definition;
end;
$$;
