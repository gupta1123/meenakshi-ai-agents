import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; runId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, runId } = await context.params;
    if (!isUuid(companyId) || !isUuid(runId)) return jsonWithCors(request, { error: "Invalid calculation reference." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: runs, error } = await supabase.from("evaluation_runs")
      .select("id, idempotency_key, scheme_version_id, period_start, period_end, status, request_context, summary, created_at, completed_at")
      .eq("company_id", company.id)
      .or(`id.eq.${runId},idempotency_key.like.${runId}:%`)
      .order("created_at", { ascending: true });
    if (error) throw error;
    if (!runs?.length) return jsonWithCors(request, { error: "Calculation history was not found." }, { status: 404 });
    const customerIds = [...new Set(runs.map((run) => (run.request_context as Record<string, unknown> | null)?.customerId).filter((id): id is string => typeof id === "string" && isUuid(id)))];
    // A TOD run covers hundreds of customers; one .in() with every ID makes the
    // request URL exceed the header limit, so look names up in chunks.
    const names = new Map<string, string>();
    for (let index = 0; index < customerIds.length; index += 100) {
      const { data: customers, error: customerError } = await supabase.from("customers")
        .select("id, ledger_name").eq("company_id", company.id).in("id", customerIds.slice(index, index + 100));
      if (customerError) throw customerError;
      for (const customer of customers ?? []) names.set(customer.id, customer.ledger_name);
    }
    const results = runs.flatMap((run) => {
      const contextValue = run.request_context as Record<string, unknown> | null;
      const customerId = typeof contextValue?.customerId === "string" ? contextValue.customerId : null;
      if (!customerId) return [];
      const summary = run.summary && typeof run.summary === "object" ? run.summary as Record<string, unknown> : {};
      return [{
        id: run.id,
        customerId,
        customerName: names.get(customerId) ?? "Customer record",
        schemeVersionId: run.scheme_version_id,
        periodStart: run.period_start,
        periodEnd: run.period_end,
        outcome: typeof summary.outcome === "string" ? summary.outcome : "tracking",
        eligibleTonnes: String(summary.eligibleTonnes ?? "0"),
        calculatedDiscountAmount: String(summary.calculatedDiscountAmount ?? "0"),
        createdAt: run.created_at,
        completedAt: run.completed_at,
      }];
    });
    return jsonWithCors(request, { results }, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load calculation snapshot:", error);
    return jsonWithCors(request, { error: "Could not load this calculation snapshot." }, { status: 500 });
  }
}
