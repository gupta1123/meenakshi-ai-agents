import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { requestTallySync } from "@/lib/tally/sync-request";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// A targeted completed sync can prove absence from the exact Tally scope. It
// flags the verified Credit Note for finance review; it never recreates it.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Credit Note id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const supabase = createSupabaseAdminClient();
    const { data: posting, error: postingError } = await supabase
      .from("credit_note_postings")
      .select("id, customer_id, credit_note_date, verified_tally_guid, status")
      .eq("id", postingId).eq("company_id", company.id).maybeSingle();
    if (postingError) throw postingError;
    if (!posting || posting.status !== "created_verified" || !posting.verified_tally_guid) {
      return jsonWithCors(request, { error: "Only a verified Credit Note can be reconciled against Tally." }, { status: 409 });
    }
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, tally_ledger_guid, ledger_name, is_available")
      .eq("id", posting.customer_id).eq("company_id", company.id).maybeSingle();
    if (customerError) throw customerError;
    if (!customer || !customer.is_available) return jsonWithCors(request, { error: "The Credit Note customer is unavailable for a targeted Tally check." }, { status: 409 });

    const syncRun = await requestTallySync({
      organizationId: organization.id,
      companyId: company.id,
      syncKind: "vouchers",
      requestedScope: {
        purpose: "targeted_verified_note_reconciliation",
        creditNotePostingId: posting.id,
        customerId: customer.id,
        customerLedgerGuid: customer.tally_ledger_guid,
        customerLedgerName: customer.ledger_name,
        dateFrom: posting.credit_note_date,
        dateTo: posting.credit_note_date,
      },
      idempotencyKey,
      actorId: userId,
    });
    return jsonWithCors(request, { syncRun, message: "Targeted Tally verification started. No replacement Credit Note will be created." }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not start Credit Note reconciliation:", error);
    return jsonWithCors(request, { error: "Could not start the targeted Credit Note Tally check." }, { status: 500 });
  }
}
