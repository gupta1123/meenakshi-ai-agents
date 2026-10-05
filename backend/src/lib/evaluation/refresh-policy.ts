import { isLiveTodAggregate } from "./live-tod";

type RefreshPolicyRun = {
  request_context: { schemeType?: unknown };
  summary?: { liveTodEvidence?: unknown } | null;
  tally_master_refresh_run_id?: string | null;
  tally_voucher_refresh_run_id?: string | null;
};

export function hasCompletedLocalTodEvidence(run: RefreshPolicyRun) {
  return run.request_context.schemeType === "tod"
    && isLiveTodAggregate(run.summary?.liveTodEvidence);
}

export function requiresTallyRefresh(run: RefreshPolicyRun) {
  if (hasCompletedLocalTodEvidence(run)) return false;
  return !run.tally_master_refresh_run_id || !run.tally_voucher_refresh_run_id;
}
