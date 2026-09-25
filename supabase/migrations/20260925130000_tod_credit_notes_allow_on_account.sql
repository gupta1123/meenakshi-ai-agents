-- GST Credit Notes (client style) credit the party On Account instead of a
-- New Ref. Allow 'on_account' for TOD Credit Notes; everything else in the
-- validation function is left exactly as it is.
do $$
declare
  target_function regprocedure;
  function_definition text;
begin
  target_function := to_regprocedure('public.validate_credit_note_posting_transition()');
  if target_function is null then
    raise exception 'validate_credit_note_posting_transition function was not found';
  end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position('proposal.scheme_type = ''tod'' and new.bill_allocation_type <> ''new_ref''' in function_definition) = 0 then
    raise exception 'Credit Note validation has an unexpected TOD allocation rule';
  end if;
  function_definition := replace(
    function_definition,
    'proposal.scheme_type = ''tod'' and new.bill_allocation_type <> ''new_ref''',
    'proposal.scheme_type = ''tod'' and new.bill_allocation_type not in (''new_ref'', ''on_account'')'
  );
  function_definition := replace(
    function_definition,
    'TOD Credit Notes use New Ref;',
    'TOD Credit Notes use New Ref or On Account;'
  );
  execute function_definition;
end;
$$;
