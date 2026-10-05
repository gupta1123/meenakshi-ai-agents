-- Run after all migrations, using the service role in a disposable test DB.
begin;

do $$
declare
  notification_factory text;
begin
  if to_regprocedure('public.claim_phase_6_notification_messages(text,integer,integer)') is null then
    raise exception 'Phase 6 notification claim function is missing';
  end if;
  if to_regprocedure('public.enqueue_phase_6_notification(uuid,uuid,text,uuid,uuid)') is null then
    raise exception 'Phase 6 notification event factory is missing';
  end if;
  select pg_get_functiondef('public.enqueue_phase_6_notification(uuid,uuid,text,uuid,uuid)'::regprocedure)
    into notification_factory;
  if position('contact.entered_at' in notification_factory) = 0
     or position('contact.created_at' in notification_factory) > 0 then
    raise exception 'Phase 6 notification contact ordering must use customer_contacts.entered_at';
  end if;
  if to_regprocedure('public.resend_phase_6_notification(uuid,uuid,uuid,text,text)') is null then
    raise exception 'Phase 6 audited resend function is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notification_messages'
      and column_name in ('available_at', 'locked_at', 'locked_by', 'lease_expires_at', 'attempt_count', 'max_attempts', 'provider_metadata')
    group by table_schema, table_name having count(*) = 7
  ) then
    raise exception 'Phase 6 notification operational columns are incomplete';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.notification_messages'::regclass) then
    raise exception 'notification_messages must retain row-level security';
  end if;
  if has_table_privilege('authenticated', 'public.notification_messages', 'select')
     or has_table_privilege('authenticated', 'public.notification_attempts', 'select')
     or has_table_privilege('authenticated', 'public.whatsapp_templates', 'select') then
    raise exception 'Phase 6 notification tables must remain server API only';
  end if;
end;
$$;

rollback;
