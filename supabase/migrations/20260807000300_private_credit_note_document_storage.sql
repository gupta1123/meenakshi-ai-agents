-- Native Tally Credit Note PDFs are uploaded only by the paired bridge through
-- the backend service-role client. Browser clients receive a short-lived signed
-- URL after company access is checked; no Storage object policy grants direct
-- authenticated or anonymous access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meenakshi-credit-note-documents',
  'meenakshi-credit-note-documents',
  false,
  26214400,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create function public.retry_meenakshi_credit_note_pdf_export(
  p_credit_note_posting_id uuid,
  p_actor_id uuid,
  p_correlation_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  posting public.credit_note_postings;
  document public.credit_note_documents;
  company public.companies;
  attempt_number integer;
  outbox_id uuid;
begin
  select * into posting from public.credit_note_postings where id = p_credit_note_posting_id for update;
  if not found or posting.status <> 'created_verified' then
    raise exception 'A native PDF can be requested only for a verified Credit Note';
  end if;
  select * into company from public.companies where id = posting.company_id;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = company.organization_id
      and membership.profile_id = p_actor_id
      and membership.role in ('administrator', 'finance_approver')
  ) then
    raise exception 'Administrator or Finance Approver role is required';
  end if;
  select * into document from public.credit_note_documents
  where credit_note_posting_id = posting.id and document_kind = 'credit_note_pdf'
  for update;
  if not found then raise exception 'Credit Note PDF record was not found'; end if;
  if document.status = 'verified' then raise exception 'This Credit Note already has a verified PDF'; end if;
  if document.status in ('pending', 'exporting', 'attached') then
    raise exception 'A native Credit Note PDF capture is already queued';
  end if;

  attempt_number := document.attempts + 1;
  update public.credit_note_documents
  set status = 'pending', failure_reason = null
  where id = document.id;
  insert into public.integration_outbox (
    organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    company.organization_id, posting.company_id, p_correlation_id,
    'credit-note-pdf:' || posting.id::text || ':' || attempt_number::text,
    posting.idempotency_key || ':pdf:' || attempt_number::text,
    'tally_credit_note_pdf', 'credit_note_posting', posting.id,
    jsonb_build_object('creditNotePostingId', posting.id)
  ) returning id into outbox_id;
  insert into public.audit_events (
    organization_id, company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, new_value
  ) values (
    company.organization_id, posting.company_id, 'user', p_actor_id,
    'credit_note_pdf_requested', 'credit_note_posting', posting.id, p_correlation_id,
    jsonb_build_object('attempt', attempt_number)
  );
  return outbox_id;
end;
$$;

revoke execute on function public.retry_meenakshi_credit_note_pdf_export(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.retry_meenakshi_credit_note_pdf_export(uuid, uuid, uuid) to service_role;
