import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; proposalId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// Resolving this issue records a deliberate finance decision. It never sends a
// correction WhatsApp or recreates the earlier tier message.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, proposalId } = await context.params;
    if (!isUuid(companyId) || !isUuid(proposalId)) return jsonWithCors(request, { error: "Invalid company or proposal id." }, { status: 400 });
    const body = await request.json().catch(() => ({})) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) return jsonWithCors(request, { error: "Add a short review note before closing this issue." }, { status: 400 });

    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: issue, error: issueError } = await supabase
      .from("processing_issues")
      .select("id, details")
      .eq("company_id", company.id)
      .eq("proposal_id", proposalId)
      .eq("issue_type", "tod_tier_reduced_after_notification")
      .in("status", ["open", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (issueError) throw issueError;
    if (!issue) return jsonWithCors(request, { error: "There is no open TOD tier-drop review for this customer." }, { status: 404 });

    const priorDetails = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details) ? issue.details : {};
    const resolvedAt = new Date().toISOString();
    const { error: resolveError } = await supabase
      .from("processing_issues")
      .update({
        status: "resolved",
        resolved_by: userId,
        resolved_at: resolvedAt,
        details: { ...priorDetails, resolution: { decision: "no_customer_message", reason, resolvedAt } },
      })
      .eq("id", issue.id)
      .eq("company_id", company.id);
    if (resolveError) throw resolveError;

    return jsonWithCors(request, { status: "resolved", message: "Finance review recorded. No correction WhatsApp was sent." });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not resolve TOD tier-drop review:", error);
    return jsonWithCors(request, { error: "Could not record the TOD tier-drop review." }, { status: 500 });
  }
}
