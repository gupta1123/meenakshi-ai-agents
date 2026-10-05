import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { CREDIT_NOTE_DOCUMENTS_BUCKET, hasSafeCreditNoteDocumentPath, toSafeCreditNoteDocument, type CreditNoteDocumentRow } from "@/lib/credit-note-documents";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Credit Note id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: posting, error: postingError } = await supabase.from("credit_note_postings")
      .select("id, status").eq("id", postingId).eq("company_id", company.id).maybeSingle();
    if (postingError) throw postingError;
    if (!posting) return jsonWithCors(request, { error: "Credit Note was not found." }, { status: 404 });
    const { data, error } = await supabase.from("credit_note_documents")
      .select("id, status, storage_path, mime_type, file_size_bytes, attached_at, verified_at, failure_reason")
      .eq("credit_note_posting_id", postingId).eq("document_kind", "credit_note_pdf").maybeSingle();
    if (error) throw error;
    const row = data as CreditNoteDocumentRow | null;
    let document = toSafeCreditNoteDocument(row, true);
    // Existing deployments may use an approved external document service.
    // New bridge uploads go to our private bucket and receive a short-lived
    // URL only after company access is checked above.
    if (row?.status === "verified" && row.storage_path && hasSafeCreditNoteDocumentPath(row.storage_path) && !/^https:\/\//i.test(row.storage_path) && !document?.downloadUrl) {
      const { data: signed, error: signedError } = await supabase.storage
        .from(CREDIT_NOTE_DOCUMENTS_BUCKET)
        .createSignedUrl(row.storage_path, 5 * 60);
      if (signedError) throw signedError;
      if (signed?.signedUrl && document) document = { ...document, available: true, downloadUrl: signed.signedUrl };
    }
    return jsonWithCors(request, { creditNotePostingId: postingId, document });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load the verified Credit Note document:", error);
    return jsonWithCors(request, { error: "Could not load the verified Credit Note document." }, { status: 500 });
  }
}
