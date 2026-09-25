-- Several Cash Discount rules can be active; each rule keeps its own latest
-- results (the page has a rule selector). Running one rule must not replace
-- another rule's results, and an invoice may not get a second Debit Note
-- from a different rule.

-- 1. One current result per invoice per rule (was: per company).
drop index if exists public.cash_discount_recovery_current_invoice_idx;
create unique index if not exists cash_discount_recovery_current_rule_invoice_idx
  on public.cash_discount_recovery_candidates(company_id, rule_version_id, invoice_tally_guid)
  where current_snapshot;

-- 2. Saving a rule's run replaces only that rule's (any version's) results.
do $$
declare
  target_function regprocedure;
  function_definition text;
  old_text text := 'set current_snapshot = false
  where company_id = p_company_id and current_snapshot;';
begin
  target_function := to_regprocedure('public.replace_meenakshi_cd_recovery_snapshot(uuid,uuid,uuid,text,date,date,jsonb,jsonb)');
  if target_function is null then raise exception 'replace_meenakshi_cd_recovery_snapshot was not found'; end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position(old_text in function_definition) = 0 then raise exception 'replace_meenakshi_cd_recovery_snapshot has an unexpected snapshot rule'; end if;
  function_definition := replace(function_definition, old_text, 'set current_snapshot = false
  where company_id = p_company_id and current_snapshot
    and rule_version_id in (
      select sibling.id from public.scheme_versions sibling
      where sibling.scheme_id = (select selected.scheme_id from public.scheme_versions selected where selected.id = p_rule_version_id)
    );');
  execute function_definition;
end;
$$;

-- 3. Block a second Debit Note for the same invoice from another rule.
do $$
declare
  target_function regprocedure;
  function_definition text;
  anchor text := 'if candidate.status = ''posting'' then raise exception ''This Debit Note is already being prepared.''; end if;';
begin
  target_function := to_regprocedure('public.enqueue_meenakshi_cd_debit_note(uuid,uuid,uuid,text)');
  if target_function is null then raise exception 'enqueue_meenakshi_cd_debit_note was not found'; end if;
  select pg_get_functiondef(target_function) into function_definition;
  if position(anchor in function_definition) = 0 then raise exception 'enqueue_meenakshi_cd_debit_note has an unexpected shape'; end if;
  function_definition := replace(function_definition, anchor, anchor || '
  if exists (
    select 1 from public.cash_discount_debit_note_postings other_posting
    join public.cash_discount_recovery_candidates other_candidate on other_candidate.id = other_posting.candidate_id
    where other_posting.company_id = p_company_id
      and other_candidate.invoice_tally_guid = candidate.invoice_tally_guid
      and other_candidate.id <> candidate.id
      and other_posting.status not in (''failed'', ''cancelled'')
  ) then
    raise exception ''This invoice already has a Debit Note from another Cash Discount rule.'';
  end if;');
  execute function_definition;
end;
$$;
