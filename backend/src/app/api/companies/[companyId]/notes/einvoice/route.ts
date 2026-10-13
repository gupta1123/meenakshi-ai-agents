import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const SOURCES = { tod_credit_note: "credit_note_postings", cash_discount_note: "cash_discount_debit_note_postings" } as const;

/**
 * Save a note's e-Invoice details (IRN, Ack No., Ack Date, signed QR) read
 * from Tally by the local connector, so its PDF prints them like Tally does.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const source = String(body.source ?? "") as keyof typeof SOURCES;
    const postingId = String(body.postingId ?? "");
    const irn = String(body.irn ?? "").trim().toLowerCase();
    const ackNo = String(body.ackNo ?? "").trim();
    const ackDate = typeof body.ackDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.ackDate) ? body.ackDate : null;
    const signedQr = String(body.signedQr ?? "").trim();
    if (!(source in SOURCES) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid note." }, { status: 400 });
    if (!/^[0-9a-f]{64}$/.test(irn) || !/^[0-9]{6,20}$/.test(ackNo) || signedQr.length < 50 || signedQr.length > 4000) {
      return jsonWithCors(request, { error: "The e-Invoice details from Tally are incomplete." }, { status: 400 });
    }
    const supabase = createSupabaseAdminClient();
    const { data: posting, error: postingError } = await supabase.from(SOURCES[source]).select("id, status").eq("id", postingId).eq("company_id", company.id).maybeSingle();
    if (postingError) throw postingError;
    if (!posting || posting.status !== "created_verified") return jsonWithCors(request, { error: "This note is not created in Tally." }, { status: 404 });
    const { error } = await supabase.from("note_einvoices").upsert({
      company_id: company.id, note_source: source, posting_id: postingId,
      irn, ack_no: ackNo, ack_date: ackDate, signed_qr: signedQr, read_from_tally_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: "note_source,posting_id" });
    if (error) throw error;
    return jsonWithCors(request, { saved: true });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not save the note e-Invoice:", error);
    return jsonWithCors(request, { error: "Could not save the e-Invoice details." }, { status: 500 });
  }
}
