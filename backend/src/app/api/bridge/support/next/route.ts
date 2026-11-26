import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { bridgeSupportAccess } from "@/lib/bridge-support";
import { SupportError } from "@/lib/connector-support";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
export async function GET(r: Request) {
  try {
    const c = await bridgeSupportAccess(
      r,
      new URL(r.url).searchParams.get("connectorId"),
    );
    const db = createSupabaseAdminClient();
    const { data, error } = await db.rpc("claim_tally_support_job", {
      p_connector_id: c.id,
    });
    if (error) throw new SupportError("Support queue is not ready.", 503);
    const job = data?.[0];
    if (!job) return jsonWithCors(r, { job: null });
    const { data: b, error: be } = await db
      .from("tally_connector_company_bindings")
      .select("expected_tally_company_guid,expected_tally_company_name,expected_tally_books_from")
      .eq("connector_id", c.id)
      .eq("company_id", job.company_id)
      .eq("is_active", true)
      .single();
    if (be || !b) throw new SupportError("Company binding unavailable.", 409);
    return jsonWithCors(r, {
      job: {
        ...job,
        expectedTallyCompany: {
          guid: b.expected_tally_company_guid,
          name: b.expected_tally_company_name,
          booksFrom: b.expected_tally_books_from ?? null,
        },
      },
    });
  } catch (e) {
    return jsonWithCors(
      r,
      {
        error:
          e instanceof Error ? e.message : "Could not claim support operation.",
      },
      { status: e instanceof SupportError ? e.status : 500 },
    );
  }
}
