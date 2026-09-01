import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { requestTallySync } from "@/lib/tally/sync-request";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// A one-day, one-customer sync is the only safe way to infer that a verified
// voucher is absent from Tally. It does not create a replacement Debit Note.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Debit Note id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const supabase = createSupabaseAdminClient();
    const { data: posting, error: postingError } = await supabase
      .from("cash_discount_debit_note_postings")
      .select("id, candidate_id, debit_note_date, verified_tally_guid, status")
      .eq("id", postingId).eq("company_id", company.id).maybeSingle();
    if (postingError) throw postingError;
    if (!posting || posting.status !== "created_verified" || !posting.verified_tally_guid) {
      return jsonWithCors(request, { error: "Only a verified Debit Note can be reconciled against Tally." }, { status: 409 });
    }
    const { data: candidate, error: candidateError } = await supabase
      .from("cash_discount_recovery_candidates")
      .select("customer_tally_guid")
      .eq("id", posting.candidate_id).eq("company_id", company.id).maybeSingle();
    if (candidateError) throw candidateError;
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, tally_ledger_guid, ledger_name, is_available")
      .eq("company_id", company.id).eq("tally_ledger_guid", candidate?.customer_tally_guid ?? "").maybeSingle();
    if (customerError) throw customerError;
    if (!customer || !customer.is_available) return jsonWithCors(request, { error: "The Debit Note customer is unavailable for a targeted Tally check." }, { status: 409 });

    const syncRun = await requestTallySync({
      organizationId: organization.id,
      companyId: company.id,
      syncKind: "vouchers",
      requestedScope: {
        purpose: "targeted_verified_note_reconciliation",
        debitNotePostingId: posting.id,
        customerId: customer.id,
        customerLedgerGuid: customer.tally_ledger_guid,
        customerLedgerName: customer.ledger_name,
        dateFrom: posting.debit_note_date,
        dateTo: posting.debit_note_date,
      },
      idempotencyKey,
      actorId: userId,
    });
    return jsonWithCors(request, { syncRun, message: "Targeted Tally verification started. No replacement Debit Note will be created." }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not start Debit Note reconciliation:", error);
    return jsonWithCors(request, { error: "Could not start the targeted Debit Note Tally check." }, { status: 500 });
  }
}
