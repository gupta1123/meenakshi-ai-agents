import { auditUserAction } from "@/lib/audit";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { requirePostingEnabled } from "@/lib/launch-control";
import { RulebookRequestError } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { postingDateProblem } from "@/lib/year-continuation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { retireObsoleteEvaluationReads } from "@/lib/evaluation/refresh-commands.mjs";
import { CdEvidenceSafetyError, requireCurrentCdCheck } from "@/lib/evaluation/cd-credit-note-safety";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const MAX_SELECTED = 25;

/**
 * Staff creates Cash Discount Credit Notes for up to 25 selected invoices at
 * once. Each one is queued exactly like the single "Create" button; results
 * that changed since the check are skipped and reported back.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const { company, userId } = access;
    await requirePostingEnabled(company.id);
    const dateProblem = await postingDateProblem(company.id);
    if (dateProblem) return jsonWithCors(request, { error: dateProblem }, { status: 409 });
    const body = await request.json().catch(() => ({})) as { candidateIds?: unknown };
    const candidateIds = [...new Set(Array.isArray(body?.candidateIds) ? body.candidateIds.filter((id): id is string => typeof id === "string" && isUuid(id)) : [])];
    if (!candidateIds.length) return jsonWithCors(request, { error: "Select at least one invoice." }, { status: 400 });
    if (candidateIds.length > MAX_SELECTED) return jsonWithCors(request, { error: `Select up to ${MAX_SELECTED} invoices at a time.` }, { status: 400 });
    const db = createSupabaseAdminClient();
    await requireCurrentCdCheck(db, company.id);
    await retireObsoleteEvaluationReads(db, { companyId: company.id });
    const batch = crypto.randomUUID();
    let queued = 0;
    const skipped: Array<{ candidateId: string; reason: string }> = [];
    // One at a time: each call locks its invoice and the connector picks them up in order.
    for (const candidateId of candidateIds) {
      const { error } = await db.rpc("enqueue_meenakshi_cd_credit_note", {
        p_company_id: company.id, p_candidate_id: candidateId, p_actor_id: userId, p_idempotency_key: `cd-bulk:${batch}:${candidateId}`,
      });
      if (error) skipped.push({ candidateId, reason: error.message }); else queued += 1;
    }
    await auditUserAction(access, {
      action: "cd_credit_notes_bulk_requested", entityType: "cash_discount_settlement",
      newValue: { requested: candidateIds.length, queued, skipped: skipped.length, candidateIds },
      metadata: { batch },
    });
    const message = queued ? `${queued} Credit Note${queued === 1 ? " is" : "s are"} queued for Tally.` : "No Credit Notes were queued.";
    return jsonWithCors(request, { queued, skipped: skipped.length, skippedReasons: skipped, message }, { status: queued ? 201 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError || error instanceof CdEvidenceSafetyError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not queue Cash Discount Credit Notes:", error);
    return jsonWithCors(request, { error: "Could not queue the selected Credit Notes." }, { status: 500 });
  }
}
