import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { stopEvaluationRun } from "@/lib/evaluation/cancel-run";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string; runId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, runId } = await context.params;
    if (!isUuid(companyId) || !isUuid(runId)) return jsonWithCors(request, { error: "Invalid company or evaluation run id." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const evaluationRun = await stopEvaluationRun({ companyId: company.id, runId, status: "cancelled", message: "Stopped by the user." });
    if (!evaluationRun) return jsonWithCors(request, { error: "Evaluation run not found." }, { status: 404 });
    await appendMeenakshiAuditEvent({ organizationId: organization.id, companyId: company.id, actorType: "user", actorId: userId, action: "evaluation_stopped", entityType: "evaluation_run", entityId: runId, newValue: { status: evaluationRun.status } });
    return jsonWithCors(request, { evaluationRun });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not stop evaluation run:", error);
    return jsonWithCors(request, { error: "Could not stop this check." }, { status: 500 });
  }
}
