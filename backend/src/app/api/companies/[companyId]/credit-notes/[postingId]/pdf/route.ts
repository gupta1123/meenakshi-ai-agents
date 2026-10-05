import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { prepareCreditNoteDocument } from "@/lib/notes/verified-note-document.mjs";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Prepare a reference PDF from an already verified Tally Credit Note. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Credit Note posting id." }, { status: 400 });
    await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const document = await prepareCreditNoteDocument(createSupabaseAdminClient(), companyId, postingId);
    return jsonWithCors(request, { documentId: document.id, status: document.status });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not prepare Credit Note PDF:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare Credit Note PDF." }, { status: 500 });
  }
}
