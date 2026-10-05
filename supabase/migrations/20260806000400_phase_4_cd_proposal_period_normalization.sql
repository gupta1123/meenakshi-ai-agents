-- Meenakshi Phase 4 repair: CD proposals are invoice-scoped, not period-scoped.
--
-- Cash Discount evaluations include the invoice date in their evaluation result
-- for auditability. `discount_proposals` deliberately represents a CD entitlement
-- through `source_sales_voucher_id` and reserves `period_start` / `period_end`
-- for TOD. Normalize the result before the existing proposal constraint is
-- evaluated, while `evaluation_runs` continues to retain the evaluation dates.

create or replace function public.normalize_meenakshi_cd_proposal_period()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scheme_type = 'cd' then
    new.period_start := null;
    new.period_end := null;
  end if;

  return new;
end;
$$;

drop trigger if exists discount_proposals_normalize_cd_period on public.discount_proposals;

create trigger discount_proposals_normalize_cd_period
  before insert or update of scheme_type, period_start, period_end
  on public.discount_proposals
  for each row execute function public.normalize_meenakshi_cd_proposal_period();

comment on function public.normalize_meenakshi_cd_proposal_period() is
  'Keeps CD proposals invoice-scoped. TOD alone owns discount proposal period_start and period_end.';
