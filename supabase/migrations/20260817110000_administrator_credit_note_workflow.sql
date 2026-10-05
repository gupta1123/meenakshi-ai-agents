-- The administrator owns the complete Credit Note workflow. A separate
-- Finance Approver is no longer required. The existing immutable review row
-- is retained as the administrator's auditable creation decision.

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

  select pg_get_functiondef(target_function) into function_definition;

  if position('role = ''finance_approver''' in function_definition) > 0 then
    function_definition := replace(function_definition, 'role = ''finance_approver''', 'role = ''administrator''');
    function_definition := replace(function_definition, 'Finance Approver role is required', 'Administrator role is required');
  elsif position('role = ''administrator''' in function_definition) = 0 then
    raise exception 'Credit Note creation function has an unexpected authorization definition';
  end if;

  function_definition := replace(
    function_definition,
    '''Approved for Credit Note posting''',
    '''Created by Administrator for Tally posting'''
  );
  function_definition := replace(
    function_definition,
    '''proposal_approved_and_credit_note_queued''',
    '''administrator_created_credit_note'''
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

-- A verified Tally Credit Note automatically creates its one idempotent
-- WhatsApp business event. If consent or an active template is missing, the
-- enqueue function returns no event and the UI shows the exact blocked state.
-- Notification infrastructure must never roll back an already verified
-- accounting voucher, so unexpected notification errors are audited instead.
create or replace function public.enqueue_verified_credit_note_notification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  notification_event_type text;
  notification_id uuid;
  v_organization_id uuid;
begin
  if new.status = 'created_verified' and old.status is distinct from 'created_verified' then
    select
      case proposal.scheme_type
        when 'cd' then 'cd_credit_note_created'
        when 'tod' then 'tod_credit_note_created'
      end,
      company.organization_id
    into notification_event_type, v_organization_id
    from public.discount_proposals proposal
    join public.companies company on company.id = proposal.company_id
    where proposal.id = new.proposal_id
      and proposal.company_id = new.company_id;

    if notification_event_type is not null then
      notification_id := public.enqueue_phase_6_notification(
        new.company_id,
        new.proposal_id,
        notification_event_type,
        new.id,
        new.created_by
      );

      insert into public.audit_events (
        organization_id, company_id, actor_type, actor_id, action,
        entity_type, entity_id, new_value
      ) values (
        v_organization_id, new.company_id, 'system', null,
        case when notification_id is null
          then 'credit_note_whatsapp_not_queued'
          else 'credit_note_whatsapp_queued'
        end,
        'credit_note_posting', new.id,
        jsonb_build_object(
          'notificationMessageId', notification_id,
          'eventType', notification_event_type
        )
      );
    end if;
  end if;
  return new;
exception when others then
  if v_organization_id is not null then
    insert into public.audit_events (
      organization_id, company_id, actor_type, actor_id, action,
      entity_type, entity_id, metadata
    ) values (
      v_organization_id, new.company_id, 'system', null,
      'credit_note_whatsapp_enqueue_failed', 'credit_note_posting', new.id,
      jsonb_build_object('error', sqlerrm)
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.enqueue_verified_credit_note_notification() from public, anon, authenticated;
grant execute on function public.enqueue_verified_credit_note_notification() to service_role;

drop trigger if exists phase_6_enqueue_verified_credit_note on public.credit_note_postings;
drop trigger if exists enqueue_verified_credit_note_notification on public.credit_note_postings;
create trigger enqueue_verified_credit_note_notification
  after update of status on public.credit_note_postings
  for each row execute function public.enqueue_verified_credit_note_notification();

comment on function public.enqueue_verified_credit_note_notification() is
  'Queues one consent-aware WhatsApp event after independent Tally verification without risking the verified accounting transaction.';
