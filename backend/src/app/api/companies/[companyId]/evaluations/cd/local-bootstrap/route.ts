import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { requireRequestUser } from "@/lib/api/request-auth";
import { loadLiveCdLocalBootstrap, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function cashDiscountRuleError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "No active Cash Discount rule is available.") {
    return "No active Cash Discount rule covers today. In Rulebook, activate the approved Cash Discount rule whose effective dates include today, then check again.";
  }
  if (message === "More than one active Cash Discount rule is available.") {
    return "More than one active Cash Discount rule covers today. Keep only the approved current version active before checking again.";
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const requested = url.searchParams.get("evaluatedOn") ?? today;
    const evaluatedOn = process.env.NODE_ENV === "development" && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;
    // A rule chosen on the page (several may be active) uses the direct path;
    // the single-rule RPC below cannot choose between rules.
    const requestedRuleVersionId = url.searchParams.get("ruleVersionId");
    const ruleVersionId = requestedRuleVersionId && isUuid(requestedRuleVersionId) ? requestedRuleVersionId : null;
    // Fast path: 1 RPC (was 3 hops sequential) — falls back if RPC not yet deployed
    // The get_cd_local_bootstrap RPC only understands percentage rules. A per-MT
    // rule sends customers per segment, which only loadLiveCdLocalBootstrap
    // builds, so skip the RPC shortcut while such a rule is active.
    const { data: perMtRule, error: perMtError } = await createSupabaseAdminClient()
      .from("scheme_versions").select("id")
      .eq("company_id", company.id).eq("scheme_type", "cd").eq("status", "active").eq("cd_discount_basis", "amount_per_tonne")
      .limit(1).maybeSingle();
    if (perMtError) throw perMtError;
    const user = ruleVersionId || perMtRule ? null : await requireRequestUser(request);
    if (user) {
      const supabase = createSupabaseAdminClient();
      const { data: rpcData, error: rpcError } = await supabase.rpc("get_cd_local_bootstrap", {
        p_company_id: company.id,
        p_user_id: user.id,
        p_evaluated_on: evaluatedOn,
      });
      const isMissingRpc = rpcError && (String((rpcError as { code?: string }).code) === "42883" || String(rpcError.message ?? "").includes("get_cd_local_bootstrap"));
      if (!isMissingRpc) {
        if (rpcError) throw rpcError;
        const rpc = rpcData as { evaluatedOn: string; rule: unknown; voucherScope: Record<string, unknown> } | null;
        if (rpc && (rpc as Record<string, unknown>).error) {
          const msg = String((rpc as Record<string, unknown>).error ?? "");
          const mapped = cashDiscountRuleError(new Error(msg));
          if (mapped) return jsonWithCors(request, { error: mapped }, { status: 409 });
        }
        if (rpc?.rule && rpc?.voucherScope) {
          return jsonWithCors(
            request,
            {
              evaluatedOn: rpc.evaluatedOn,
              expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid },
              rule: rpc.rule,
              voucherScope: { ...(rpc.voucherScope as Record<string, unknown>), evaluationRunId: null },
            },
            { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120", "X-Cache": "MISS-RPC" } }
          );
        }
      }
    }
    const syntheticRun: EvaluationRunRecord = {
      id: "local-preview",
      company_id: company.id,
      requested_by: null,
      request_context: { schemeType: "cd", batch: true, evaluatedOn },
      tally_master_refresh_run_id: null,
      tally_voucher_refresh_run_id: null,
    };
    const bootstrap = await loadLiveCdLocalBootstrap(syntheticRun, ruleVersionId);
    return jsonWithCors(request, {
      evaluatedOn: bootstrap.evaluatedOn,
      expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid },
      rule: bootstrap.rule,
      voucherScope: { ...bootstrap.voucherScope, evaluationRunId: null },
    }, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    const ruleError = cashDiscountRuleError(error);
    if (ruleError) return jsonWithCors(request, { error: ruleError }, { status: 409 });
    console.error("Could not prepare the local Cash Discount check:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare the local Cash Discount check." }, { status: 500 });
  }
}
