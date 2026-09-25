-- Tally may serialize an exact monetary value as either "1254000" or
-- "1254000.00". Compare source-ledger amounts numerically while retaining the
-- ledger GUID and name checks, so formatting alone cannot require correction.

do $$
declare
  target_function regprocedure;
  function_definition text;
  previous_check text := 'coalesce(p_result->''sourceSalesLedgerEvidence'',''[]''::jsonb) <> coalesce(tally_posting->''sourceSalesLedgers'',''[]''::jsonb)';
  normalized_check text := '(
    select coalesce(jsonb_agg(jsonb_build_object(
      ''guid'', entry->>''guid'', ''name'', entry->>''name'',
      ''amount'', round((entry->>''amount'')::numeric, 2)
    ) order by entry->>''guid''), ''[]''::jsonb)
    from jsonb_array_elements(coalesce(p_result->''sourceSalesLedgerEvidence'', ''[]''::jsonb)) entry
  ) <> (
    select coalesce(jsonb_agg(jsonb_build_object(
      ''guid'', entry->>''guid'', ''name'', entry->>''name'',
      ''amount'', round((entry->>''amount'')::numeric, 2)
    ) order by entry->>''guid''), ''[]''::jsonb)
    from jsonb_array_elements(coalesce(tally_posting->''sourceSalesLedgers'', ''[]''::jsonb)) entry
  )';
begin
  target_function := to_regprocedure(
    'public.complete_meenakshi_credit_note_verification(uuid,uuid,jsonb,uuid)'
  );
  if target_function is null then
    raise exception 'complete_meenakshi_credit_note_verification function was not found';
  end if;

  select pg_get_functiondef(target_function) into function_definition;
  if position(previous_check in function_definition) = 0 then
    if position('jsonb_array_elements(coalesce(p_result->''sourceSalesLedgerEvidence''' in function_definition) > 0 then
      return;
    end if;
    raise exception 'Credit Note verification function has an unexpected definition';
  end if;

  execute replace(function_definition, previous_check, normalized_check);
end;
$$;
