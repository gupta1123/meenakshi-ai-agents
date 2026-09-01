do $$
declare
  creation_function regprocedure;
  creation_definition text;
begin
  creation_function := to_regprocedure(
    'public.approve_proposal_and_enqueue_credit_note(uuid,uuid,uuid,date,public.bill_allocation_type,text,text,jsonb,text,uuid)'
  );
  if creation_function is null then
    raise exception 'Credit Note creation function is missing';
  end if;

  select pg_get_functiondef(creation_function) into creation_definition;
  if position('role = ''administrator''' in creation_definition) = 0
     or position('role = ''finance_approver''' in creation_definition) > 0 then
    raise exception 'Credit Note creation is not restricted to Administrators';
  end if;

  if has_function_privilege('anon', creation_function, 'execute')
     or has_function_privilege('authenticated', creation_function, 'execute')
     or not has_function_privilege('service_role', creation_function, 'execute') then
    raise exception 'Credit Note creation function grants are unsafe';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.credit_note_postings'::regclass
      and tgname = 'enqueue_verified_credit_note_notification'
      and not tgisinternal
  ) then
    raise exception 'Verified Credit Note WhatsApp trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_proc
    where oid = 'public.enqueue_verified_credit_note_notification()'::regprocedure
      and not prosecdef
  ) then
    raise exception 'Verified Credit Note notification trigger must use invoker security';
  end if;
end;
$$;
