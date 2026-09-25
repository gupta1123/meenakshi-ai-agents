import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { prepareDebitNoteDocument, signedNoteDocumentUrl } from "@/lib/notes/verified-note-document.mjs";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Debit Note id." }, { status: 400 });
    await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const document = await prepareDebitNoteDocument(supabase, companyId, postingId);
    const downloadUrl = await signedNoteDocumentUrl(supabase, document.path);
    return jsonWithCors(request, { downloadUrl, voucherNumber: document.voucherNumber, source: "verified_tally_data", expiresInSeconds: 300 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not prepare Debit Note PDF:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare Debit Note PDF." }, { status: 500 });
  }
}
