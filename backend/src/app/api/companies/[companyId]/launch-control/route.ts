import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { getCompanyLaunchControl, readLaunchControlChange, toLaunchControlResponse } from "@/lib/launch-control";
import { RulebookRequestError, appendRulebookAudit } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function errorResponse(request: Request, error: unknown, operation: string) {
  if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) {
    return jsonWithCors(request, { error: error.message }, { status: error.status });
  }
  console.error(`Could not ${operation}:`, error);
  return jsonWithCors(request, { error: `Could not ${operation}.` }, { status: 500 });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    return jsonWithCors(request, { launchControl: await getCompanyLaunchControl(company.id) });
  } catch (error) {
    return errorResponse(request, error, "load the launch control");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const change = readLaunchControlChange((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const previous = await getCompanyLaunchControl(scope.company.id);
    const now = new Date().toISOString();
    const launchControls = createSupabaseAdminClient().from("company_launch_controls");
    const result = change.mode === "posting_enabled"
      ? await launchControls
          .upsert({
            company_id: scope.company.id, mode: change.mode,
            reconciliation_period_from: change.reconciliationPeriodFrom,
            reconciliation_period_to: change.reconciliationPeriodTo,
            reconciliation_reference: change.reconciliationReference,
            reconciled_by: scope.userId, reconciled_at: now, posting_enabled_at: now, updated_by: scope.userId,
          }, { onConflict: "company_id" })
          .select("company_id, mode, reconciliation_period_from, reconciliation_period_to, reconciliation_reference, reconciled_by, reconciled_at, posting_enabled_at, updated_by, created_at, updated_at")
          .single()
      : await launchControls
          .upsert({ company_id: scope.company.id, mode: change.mode, updated_by: scope.userId, posting_enabled_at: null }, { onConflict: "company_id" })
          .select("company_id, mode, reconciliation_period_from, reconciliation_period_to, reconciliation_reference, reconciled_by, reconciled_at, posting_enabled_at, updated_by, created_at, updated_at")
          .single();
    const { data, error } = result;
    if (error) throw error;
    const launchControl = toLaunchControlResponse(scope.company.id, data);
    await appendRulebookAudit({
      scope,
      action: "company_launch_control_updated",
      entityType: "company_launch_control",
      entityId: scope.company.id,
      previousValue: previous as unknown as Record<string, unknown>,
      newValue: launchControl as unknown as Record<string, unknown>,
      metadata: { mode: launchControl.mode, reconciliationReference: launchControl.reconciliation.reference },
    });
    return jsonWithCors(request, { launchControl });
  } catch (error) {
    return errorResponse(request, error, "update the launch control");
  }
}
