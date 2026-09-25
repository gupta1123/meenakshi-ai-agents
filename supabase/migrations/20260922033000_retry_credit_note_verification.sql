-- Each posting attempt may re-read the same idempotently created Tally
-- voucher. Scope the verification event to the attempt so a prior completed
-- verification cannot suppress a later reconciliation check.

do $$
declare
  target_function regprocedure;
  function_definition text;
  previous_keys text := '''credit-note-verify:'' || posting.id::text,
    ''credit-note-verify:'' || posting.id::text,';
  attempt_keys text := '''credit-note-verify:'' || posting.id::text || '':'' ||
      (select max(attempt_number)::text from public.credit_note_posting_attempts where credit_note_posting_id = posting.id),
    ''credit-note-verify:'' || posting.id::text || '':'' ||
      (select max(attempt_number)::text from public.credit_note_posting_attempts where credit_note_posting_id = posting.id),';
begin
  target_function := to_regprocedure(
    'public.record_meenakshi_credit_note_create_result(uuid,uuid,jsonb,uuid)'
  );
  if target_function is null then
    raise exception 'record_meenakshi_credit_note_create_result function was not found';
  end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position(previous_keys in function_definition) > 0 then
    execute replace(function_definition, previous_keys, attempt_keys);
  elsif position('(select max(attempt_number)::text from public.credit_note_posting_attempts' in function_definition) = 0 then
    raise exception 'Credit Note create-result function has an unexpected definition';
  end if;
end;
$$;

insert into public.integration_outbox (
  organization_id, company_id, correlation_id, event_key, idempotency_key,
  event_type, aggregate_type, aggregate_id, payload
)
select
  company.organization_id,
  posting.company_id,
  gen_random_uuid(),
  'credit-note-verify:' || posting.id::text || ':' || coalesce(max_attempt.attempt_number, 1)::text,
  'credit-note-verify:' || posting.id::text || ':' || coalesce(max_attempt.attempt_number, 1)::text,
  'tally_credit_note_verify',
  'credit_note_posting',
  posting.id,
  jsonb_build_object('creditNotePostingId', posting.id)
from public.credit_note_postings posting
join public.companies company on company.id = posting.company_id
left join lateral (
  select max(attempt.attempt_number) as attempt_number
  from public.credit_note_posting_attempts attempt
  where attempt.credit_note_posting_id = posting.id
) max_attempt on true
where posting.status = 'verification_pending'
  and not exists (
    select 1
    from public.integration_outbox pending
    where pending.aggregate_id = posting.id
      and pending.event_type = 'tally_credit_note_verify'
      and pending.status in ('pending', 'processing')
  )
on conflict (event_key) do nothing;
