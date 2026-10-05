-- A Credit Note may be created from any completed Tally calculation of the
-- proposal (full TOD run or single-customer refresh) up to 5 days old.
-- Previously only a targeted refresh from the last 15 minutes was accepted.
-- The created voucher is still read back from Tally and verified.
-- Patches only that check in the live function so the administrator-role and
-- historical-period changes from later migrations are preserved.

do $$
declare
  target_function regprocedure;
  function_definition text;
  old_check text := 'review_refresh_run.request_context ->> ''reviewRefreshForProposal'' <> proposal_record.id::text or ';
begin
  target_function := to_regprocedure(
    'public.approve_proposal_and_enqueue_credit_note(uuid,uuid,uuid,date,public.bill_allocation_type,text,text,jsonb,text,uuid)'
  );
  if target_function is null then
    raise exception 'approve_proposal_and_enqueue_credit_note function was not found';
  end if;

  select pg_get_functiondef(target_function) into function_definition;

  if position('interval ''15 minutes''' in function_definition) = 0 then
    raise exception 'Credit Note creation function has an unexpected freshness check';
  end if;

  function_definition := replace(function_definition, old_check, '');
  function_definition := replace(function_definition, 'interval ''15 minutes''', 'interval ''5 days''');
  function_definition := replace(
    function_definition,
    'Approval requires a completed targeted Tally refresh from the last 15 minutes',
    'This result was calculated more than 5 days ago. Check the latest Tally information, then create the Credit Note.'
  );

  execute function_definition;
end;
$$;

revoke execute on function public.approve_proposal_and_enqueue_credit_note(
  uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid
) from public, anon, authenticated;
grant execute on function public.approve_proposal_and_enqueue_credit_note(
  uuid, uuid, uuid, date, public.bill_allocation_type, text, text, jsonb, text, uuid
) to service_role;
