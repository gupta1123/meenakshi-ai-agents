-- Tally posts currency to two decimal places. Persist the same approved amount
-- and provide an idempotent retry for technical read-back failures.

create or replace function public.retry_meenakshi_cd_debit_note(
  p_posting_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting public.cash_discount_debit_note_postings;
  company public.companies;
  retry_number integer;
  outbox_id uuid;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'A retry reason is required'; end if;
  select * into posting from public.cash_discount_debit_note_postings where id = p_posting_id for update;
  if not found then raise exception 'Cash Discount Debit Note posting not found'; end if;
  select * into company from public.companies where id = posting.company_id;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = company.organization_id
      and membership.profile_id = p_actor_id
      and membership.role in ('administrator', 'finance_approver')
  ) then raise exception 'Administrator or Finance Approver role is required'; end if;
  if posting.status <> 'failed' then raise exception 'Only a failed Debit Note can be checked again'; end if;

  retry_number := 1 + (
    select count(*) from public.integration_outbox previous
    where previous.aggregate_id = posting.id and previous.event_type = 'tally_debit_note_create'
  );
  update public.cash_discount_debit_note_postings
  set status = 'queued', failure_reason = null, amount = round(amount, 2),
      debit_note_snapshot = jsonb_set(debit_note_snapshot, '{amount}', to_jsonb(round(amount, 2)::text)),
      updated_at = now()
  where id = posting.id;

  insert into public.integration_outbox (
    event_key, event_type, aggregate_type, aggregate_id, payload,
    organization_id, company_id, correlation_id, idempotency_key, max_attempts
  ) values (
    'cd-debit-note-retry:' || posting.id::text || ':' || retry_number::text,
    'tally_debit_note_create', 'cash_discount_debit_note_posting', posting.id,
    jsonb_build_object('debitNotePostingId', posting.id, 'retryReason', btrim(p_reason)),
    company.organization_id, company.id, p_correlation_id,
    'cd-debit-note:' || posting.id::text || ':retry:' || retry_number::text, 1
  ) returning id into outbox_id;
  return outbox_id;
end;
$$;

revoke execute on function public.retry_meenakshi_cd_debit_note(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.retry_meenakshi_cd_debit_note(uuid,uuid,text,uuid) to service_role;
