import { MeenakshiAccessError } from "@/lib/authorization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Old cached PC pages must not start local reads after a server cutover. */
export async function requireCurrentCheckPage(request: Request, companyId: string) {
  if (new URL(request.url).searchParams.get("serverCapable") === "1") return;
  const db = createSupabaseAdminClient();
  const { data: binding, error } = await db.from("tally_connector_company_bindings").select("connector_id").eq("company_id", companyId).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!binding) return;
  const answer = await db.from("tally_connector_modes").select("mode").eq("connector_id", binding.connector_id).maybeSingle();
  if (answer.error) throw answer.error;
  if (answer.data?.mode === "server") throw new MeenakshiAccessError("This company now uses its Tally server. Reload Meenakshi before calculating.", 409);
}
