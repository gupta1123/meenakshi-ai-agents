-- Let a WhatsApp message be a copy to a Meenakshi team member.
--
-- The message check required every recipient number to equal the customer's own
-- contact number, so a copy to a team member was rejected. A copy now records
-- which team member it is for (team_contact_id); for those messages the number
-- must match that team member instead. Everything else (customer opt-in,
-- template, document, proposal) is checked exactly as before, and the sending
-- worker is unchanged.
--
-- The existing function is patched in place so any later edits to it are kept.

begin;

alter table public.notification_messages
  add column if not exists team_contact_id uuid references public.team_contacts(id) on delete restrict;

do $patch$
declare
  v_def text;
  v_new text;
  v_old constant text := 'if not exists(select 1 from public.customer_contacts contact where contact.id=new.customer_contact_id and contact.company_id=new.company_id and contact.phone_e164=new.recipient_phone_e164';
  v_repl constant text := E'if new.team_contact_id is not null and not exists(select 1 from public.team_contacts team where team.id=new.team_contact_id and team.company_id=new.company_id and team.phone_e164=new.recipient_phone_e164) then\n    raise exception ''The recipient must match the selected team member'';\n  end if;\n  if new.team_contact_id is null and not exists(select 1 from public.customer_contacts contact where contact.id=new.customer_contact_id and contact.company_id=new.company_id and contact.phone_e164=new.recipient_phone_e164';
begin
  select pg_get_functiondef('public.validate_notification_message()'::regprocedure) into v_def;
  if position('team_contact_id' in v_def) > 0 then return; end if;
  v_new := replace(v_def, v_old, v_repl);
  if v_new = v_def then
    raise exception 'validate_notification_message has changed; the recipient check was not found, nothing was patched';
  end if;
  execute v_new;
end
$patch$;

commit;
