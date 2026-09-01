import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { parseVoucherSyncScope, readIdempotencyKey } from "@/lib/tally/contracts";
import { requestTallySync } from "@/lib/tally/sync-request";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = parseVoucherSyncScope(body);
    if (!parsed.scope) return jsonWithCors(request, { error: parsed.error }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    let requestedScope: Record<string, unknown> = parsed.scope;
    if (parsed.scope.customerId) {
      const { data: customer, error: customerError } = await createSupabaseAdminClient()
        .from("customers")
        .select("tally_ledger_guid, ledger_name, is_available")
        .eq("id", parsed.scope.customerId)
        .eq("company_id", company.id)
        .maybeSingle();
      if (customerError) throw customerError;
      if (!customer || !customer.is_available) return jsonWithCors(request, { error: "Customer is unavailable for voucher synchronization." }, { status: 404 });
      requestedScope = {
        ...parsed.scope,
        customerLedgerGuid: customer.tally_ledger_guid,
        customerLedgerName: customer.ledger_name,
      };
    }
    const syncRun = await requestTallySync({
      organizationId: organization.id,
      companyId: company.id,
      syncKind: "vouchers",
      requestedScope,
      idempotencyKey,
      actorId: userId,
    });
    return jsonWithCors(request, { syncRun }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not request Meenakshi voucher sync:", error);
    return jsonWithCors(request, { error: "Could not request voucher synchronization." }, { status: 500 });
  }
}
