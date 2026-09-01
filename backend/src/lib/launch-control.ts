import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { RulebookRequestError, readDate, readRequiredText } from "@/lib/rulebook/shared";

export type CompanyLaunchMode = "review_only" | "posting_enabled";

type LaunchControlRow = {
  company_id: string;
  mode: CompanyLaunchMode;
  reconciliation_period_from: string | null;
  reconciliation_period_to: string | null;
  reconciliation_reference: string | null;
  reconciled_by: string | null;
  reconciled_at: string | null;
  posting_enabled_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CompanyLaunchControl = {
  companyId: string;
  mode: CompanyLaunchMode;
  reconciliation: {
    periodFrom: string | null;
    periodTo: string | null;
    reference: string | null;
    reconciledBy: string | null;
    reconciledAt: string | null;
  };
  postingEnabledAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export function toLaunchControlResponse(companyId: string, row: LaunchControlRow | null): CompanyLaunchControl {
  return {
    companyId,
    mode: row?.mode ?? "review_only",
    reconciliation: {
      periodFrom: row?.reconciliation_period_from ?? null,
      periodTo: row?.reconciliation_period_to ?? null,
      reference: row?.reconciliation_reference ?? null,
      reconciledBy: row?.reconciled_by ?? null,
      reconciledAt: row?.reconciled_at ?? null,
    },
    postingEnabledAt: row?.posting_enabled_at ?? null,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getCompanyLaunchControl(companyId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("company_launch_controls")
    .select("company_id, mode, reconciliation_period_from, reconciliation_period_to, reconciliation_reference, reconciled_by, reconciled_at, posting_enabled_at, updated_by, created_at, updated_at")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  return toLaunchControlResponse(companyId, data as LaunchControlRow | null);
}

export async function requirePostingEnabled(companyId: string) {
  const control = await getCompanyLaunchControl(companyId);
  if (control.mode !== "posting_enabled") {
    throw new RulebookRequestError("Credit Note posting is not enabled for this company. Finance must record the selected-period reconciliation before posting can begin.", 409);
  }
  return control;
}

export function readLaunchControlChange(body: Record<string, unknown>) {
  const mode = body.mode;
  if (mode !== "review_only" && mode !== "posting_enabled") {
    throw new RulebookRequestError("mode must be review_only or posting_enabled.");
  }
  if (mode === "review_only") return { mode } as const;

  const periodFrom = readDate(body.reconciliationPeriodFrom, "reconciliationPeriodFrom");
  const periodTo = readDate(body.reconciliationPeriodTo, "reconciliationPeriodTo");
  if (!periodFrom || !periodTo) {
    throw new RulebookRequestError("A reconciliation period is required.");
  }
  if (periodTo < periodFrom) {
    throw new RulebookRequestError("reconciliationPeriodTo must not be before reconciliationPeriodFrom.");
  }
  return {
    mode,
    reconciliationPeriodFrom: periodFrom,
    reconciliationPeriodTo: periodTo,
    reconciliationReference: readRequiredText(body.reconciliationReference, "reconciliationReference", 500),
  } as const;
}
