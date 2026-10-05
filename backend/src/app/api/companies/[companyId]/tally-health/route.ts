import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("get_tally_health", { p_company_id: companyId, p_user_id: user.id });
    if (error) throw error;
    if ((data as Record<string, unknown>)?.error === "forbidden") {
      return jsonWithCors(request, { error: "Forbidden" }, { status: 403 });
    }
    return jsonWithCors(request, data as Record<string, unknown>);
  } catch (error) {
    console.error("Error in GET /api/companies/[companyId]/tally-health:", error);
    return jsonWithCors(request, { error: "Could not load Tally health." }, { status: 500 });
  }
}
