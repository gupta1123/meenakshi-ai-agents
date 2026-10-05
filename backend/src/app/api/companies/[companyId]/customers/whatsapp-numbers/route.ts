import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Mobile numbers recorded on each customer's ledger in Tally (LEDGERMOBILE /
 * LEDGERPHONE, read by the master sync), for picking a WhatsApp number.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().from("customers").select("id, ledger_name, source_payload")
      .eq("company_id", company.id).eq("is_available", true).limit(10000);
    if (error) throw error;
    const customers = (data ?? []).map((customer) => {
      const payload = (customer.source_payload ?? {}) as { mobiles?: unknown; phone?: unknown };
      const numbers = [...new Set([...(Array.isArray(payload.mobiles) ? payload.mobiles : []), payload.phone].map((value) => String(value ?? "").trim()).filter(Boolean))];
      return { id: customer.id, name: customer.ledger_name, numbers };
    }).filter((customer) => customer.numbers.length);
    // Tally often holds the salesperson's number on many customers; say how many share each.
    const digits = (value: string) => value.replace(/\D/g, "").slice(-10);
    const sharedBy: Record<string, number> = {};
    for (const customer of customers) for (const number of new Set(customer.numbers.map(digits))) sharedBy[number] = (sharedBy[number] ?? 0) + 1;
    return jsonWithCors(request, { customers, sharedBy }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list customer WhatsApp numbers:", error);
    return jsonWithCors(request, { error: "Could not list customer numbers." }, { status: 500 });
  }
}
