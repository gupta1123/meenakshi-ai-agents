import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// Now 1 RPC (was 6-7 PostgREST hops). DB migration 20260923000000_active_company_rpc must be applied.
export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const requestedCompanyId = new URL(request.url).searchParams.get("companyId")?.trim() ?? "";
    if (requestedCompanyId && !isUuid(requestedCompanyId)) {
      return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    }
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("get_active_company", {
      p_user_id: user.id,
      p_company_id: requestedCompanyId || null,
    });
    if (error) throw error;
    return jsonWithCors(request, data as Record<string, unknown>);
  } catch (error) {
    console.error("Error in GET /api/active-company:", error);
    return jsonWithCors(request, { error: "Could not resolve the active Tally company." }, { status: 500 });
  }
}
