-- A proposal remains tied to the rule version used for its calculation.
-- Replacing that rule retires the old version; it must not invalidate an
-- already calculated proposal that still has current Tally evidence.

do $$
declare
  target_function regprocedure;
  function_definition text;
begin
  target_function := to_regprocedure(
    'public.approve_proposal_and_enqueue_credit_note(uuid,uuid,uuid,date,public.bill_allocation_type,text,text,jsonb,text,uuid)'
  );
  if target_function is null then
    raise exception 'approve_proposal_and_enqueue_credit_note function was not found';
  end if;

  select pg_get_functiondef(target_function)
  into function_definition;

  if position('where id = proposal_record.scheme_version_id and status = ''active''' in function_definition) = 0 then
    raise exception 'Credit Note approval function has an unexpected definition';
  end if;

  function_definition := replace(
    function_definition,
    'where id = proposal_record.scheme_version_id and status = ''active''',
    'where id = proposal_record.scheme_version_id and status in (''active'', ''retired'')'
  );
  function_definition := replace(
    function_definition,
    'Proposal rule version is no longer active',
    'Proposal rule version is unavailable'
  );

  execute function_definition;
end;
$$;
