import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function validDate(value: unknown) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const batch = body.batch !== false;
    if (!batch && !isUuid(body.customerId)) return jsonWithCors(request, { error: "customerId must be a UUID for a single-customer calculation." }, { status: 400 });
    if (body.asOfDate !== undefined && !validDate(body.asOfDate)) return jsonWithCors(request, { error: "asOfDate must use YYYY-MM-DD." }, { status: 400 });
    const evaluatedOn = validDate(body.evaluatedOn) ? body.evaluatedOn : new Date().toISOString().slice(0, 10);
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const asOfDate = typeof body.asOfDate === "string" ? body.asOfDate : evaluatedOn;
    const { data: activeRules, error: activeRuleError } = await supabase.from("scheme_versions")
      .select("id")
      .eq("company_id", company.id)
      .eq("scheme_type", "tod")
      .eq("status", "active")
      .lte("effective_from", asOfDate)
      .or(`effective_to.is.null,effective_to.gte.${asOfDate}`)
      .order("effective_from", { ascending: false })
      .limit(2);
    if (activeRuleError) throw activeRuleError;
    if (!activeRules?.length) return jsonWithCors(request, { error: "Turn on a Turnover Discount rule for this period before calculating customers." }, { status: 409 });
    if (activeRules.length > 1) return jsonWithCors(request, { error: "More than one Turnover Discount rule covers this date. Keep one current rule for each period before calculating customers." }, { status: 409 });
    const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
      p_organization_id: organization.id,
      p_company_id: company.id,
      p_actor_id: userId,
      p_request_context: batch
        ? { schemeType: "tod", batch: true, asOfDate: body.asOfDate ?? evaluatedOn, evaluatedOn }
        : { schemeType: "tod", customerId: body.customerId, asOfDate: body.asOfDate ?? evaluatedOn, evaluatedOn },
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return jsonWithCors(request, { evaluationRun: data }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not request Turnover Discount evaluation:", error);
    return jsonWithCors(request, { error: "Could not request Turnover Discount evaluation." }, { status: 500 });
  }
}
