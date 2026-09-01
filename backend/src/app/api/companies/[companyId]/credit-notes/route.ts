import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().from("credit_note_postings")
      .select("id, proposal_id, proposal_evaluation_id, customer_id, status, credit_note_date, discount_amount, calculation_reference, bill_allocation_type, tally_bill_reference, verified_tally_guid, verified_voucher_number, verified_amount, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, created_at, updated_at")
      .eq("company_id", company.id).order("updated_at", { ascending: false }).limit(250);
    if (error) throw error;
    return jsonWithCors(request, { creditNotePostings: data ?? [] });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list Credit Note postings:", error);
    return jsonWithCors(request, { error: "Could not list Credit Note postings." }, { status: 500 });
  }
}
