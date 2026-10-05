-- Match indexes to the hot evaluation-history and recovery-action reads.
-- This migration is intentionally prepared for manual application.

create index if not exists evaluation_runs_company_scheme_created_idx
  on public.evaluation_runs (
    company_id,
    ((request_context ->> 'schemeType')),
    created_at desc
  );

create index if not exists cash_discount_recovery_action_amount_idx
  on public.cash_discount_recovery_candidates (company_id, remaining_recovery desc)
  where current_snapshot
    and status in ('action_required', 'review_required', 'posting');
