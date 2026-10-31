import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// Records that a Calculate click started. Never blocks the calculation: the
// page ignores a failure here.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scheme = body.scheme === "tod" ? "tod" : body.scheme === "cd" ? "cd" : null;
    if (!scheme) return jsonWithCors(request, { error: "Scheme must be cd or tod." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient().from("calculation_events").insert({
      company_id: company.id,
      scheme,
      period_start: isoDate(body.periodStart),
      period_end: isoDate(body.periodEnd),
      user_id: userId,
      connector_version: text(body.connectorVersion, 40),
    }).select("id").single();
    if (error) throw error;
    return jsonWithCors(request, { id: data.id });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("calculation event start failed", error instanceof Error ? error.message : error);
    return jsonWithCors(request, { error: "The activity record could not be saved." }, { status: 500 });
  }
}
