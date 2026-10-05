import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { deriveRefreshScope, type EvaluationRunRecord } from "@/lib/evaluation/evidence";

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

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    const requestedDate = typeof body.evaluatedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.evaluatedOn) ? body.evaluatedOn : today;
    const evaluatedOn = process.env.NODE_ENV === "development" ? requestedDate : today;
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: activeRun, error: activeRunError } = await supabase
      .from("evaluation_runs")
      .select("id, status, created_at")
      .eq("company_id", company.id)
      .contains("request_context", { schemeType: "cd" })
      .in("status", ["queued", "refreshing_tally", "evaluating"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeRunError) throw activeRunError;
    if (activeRun) {
      return jsonWithCors(request, { error: "A Cash Discount check is already in progress.", evaluationRun: activeRun }, { status: 409 });
    }
    const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
      p_organization_id: organization.id,
      p_company_id: company.id,
      p_actor_id: userId,
      p_request_context: { schemeType: "cd", batch: true, evaluatedOn },
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    const evaluationRun = data as EvaluationRunRecord & {
      correlation_id: string;
      status: string;
      created_at: string;
    };
    try {
      const [{ data: binding, error: bindingError }, scope] = await Promise.all([
        supabase.from("tally_connector_company_bindings")
          .select("connector_id, expected_tally_company_guid, expected_tally_company_name")
          .eq("company_id", company.id)
          .eq("is_active", true)
          .maybeSingle(),
        deriveRefreshScope(evaluationRun),
      ]);
      if (bindingError) throw bindingError;
      if (!binding) throw new Error("Connect the intended Tally company before checking Cash Discounts.");
      const commandPayload = {
        evaluationRunId: evaluationRun.id,
        voucherScope: scope.voucherScope,
        fastCashDiscount: true,
      };
      const { data: startedRun, error: runUpdateError } = await supabase.from("evaluation_runs").update({
        status: "refreshing_tally",
        started_at: new Date().toISOString(),
        error_summary: null,
        summary: { schemeType: "cd", liveOnly: true, evidenceMode: "finora_direct" },
      }).eq("id", evaluationRun.id).eq("company_id", company.id).select("*").single();
      if (runUpdateError) throw runUpdateError;
      const { data: command, error: commandError } = await supabase.from("tally_commands").upsert({
        organization_id: organization.id,
        company_id: company.id,
        connector_id: binding.connector_id,
        source_outbox_id: null,
        command_type: "fetch_meenakshi_evidence",
        business_idempotency_key: `evaluation-fast-cd:${evaluationRun.id}`,
        correlation_id: evaluationRun.correlation_id,
        expected_tally_company_guid: binding.expected_tally_company_guid || company.tally_company_guid,
        expected_tally_company_name: binding.expected_tally_company_name || company.tally_company_name,
        payload: commandPayload,
        status: "queued",
        available_at: new Date().toISOString(),
        max_attempts: 3,
      }, { onConflict: "company_id,business_idempotency_key" }).select("id, status, created_at").single();
      if (commandError) throw commandError;
      return jsonWithCors(request, { evaluationRun: startedRun, command }, { status: 202 });
    } catch (dispatchError) {
      const message = dispatchError instanceof Error ? dispatchError.message : "Could not start the direct Tally read.";
      await supabase.from("evaluation_runs").update({
        status: "failed",
        error_summary: message.slice(0, 2_000),
        summary: { schemeType: "cd", outcome: "failed", message },
        completed_at: new Date().toISOString(),
      }).eq("id", evaluationRun.id).eq("company_id", company.id);
      throw dispatchError;
    }
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    const ruleError = cashDiscountRuleError(error);
    if (ruleError) return jsonWithCors(request, { error: ruleError }, { status: 409 });
    console.error("Could not request Cash Discount evaluation:", error);
    return jsonWithCors(request, { error: "Could not request Cash Discount evaluation." }, { status: 500 });
  }
}
