import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { safeOperationalSummary } from "@/lib/operations";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
type ActivityStatus = "queued" | "sending" | "accepted" | "verified" | "failed" | "dead_letter" | "completed" | "completed_with_issues" | "processing";

type TallyActivity = {
  id: string;
  kind: "sync" | "command";
  label: string;
  status: ActivityStatus;
  startedAt: string;
  completedAt: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  summary: string;
};

const commandLabels: Record<string, string> = {
  sync_meenakshi_masters: "Synchronize masters",
  sync_meenakshi_vouchers: "Synchronize vouchers",
  fetch_meenakshi_evidence: "Refresh live evidence",
  create_credit_note: "Create Credit Note",
  create_debit_note: "Create Debit Note",
  verify_credit_note: "Verify Credit Note",
  export_credit_note_pdf: "Export verified PDF",
};

function commandSummary(command: { command_type: string; status: string; failure_reason: string | null }) {
  if (command.command_type === "export_credit_note_pdf" && /pdf export is not configured/i.test(command.failure_reason ?? "")) {
    return "Native PDF export is not configured for this bridge yet.";
  }
  return safeOperationalSummary({ action: commandLabels[command.command_type] ?? "Tally command", status: command.status, failureReason: command.failure_reason });
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const [syncResult, commandResult] = await Promise.all([
      supabase.from("tally_sync_runs")
        .select("id, sync_kind, status, records_received, records_applied, records_failed, error_summary, created_at, started_at, completed_at")
        .eq("company_id", company.id).order("created_at", { ascending: false }).limit(8),
      supabase.from("tally_commands")
        .select("id, command_type, status, attempts, max_attempts, failure_reason, created_at, completed_at")
        .eq("company_id", company.id).order("created_at", { ascending: false }).limit(8),
    ]);
    if (syncResult.error || commandResult.error) throw syncResult.error ?? commandResult.error;

    const syncActivity: TallyActivity[] = (syncResult.data ?? []).map((run) => ({
      id: run.id,
      kind: "sync",
      label: `${run.sync_kind === "masters" ? "Master" : "Voucher"} data sync`,
      status: run.status as ActivityStatus,
      startedAt: run.started_at ?? run.created_at,
      completedAt: run.completed_at,
      attempts: null,
      maxAttempts: null,
      summary: run.error_summary
        ? safeOperationalSummary({ action: "Tally sync", status: run.status, failureReason: run.error_summary })
        : `${run.records_applied ?? 0} record(s) applied${run.records_failed ? `; ${run.records_failed} need attention` : ""}.`,
    }));
    const commandActivity: TallyActivity[] = (commandResult.data ?? []).map((command) => ({
      id: command.id,
      kind: "command",
      label: commandLabels[command.command_type] ?? "Tally command",
      status: command.status as ActivityStatus,
      startedAt: command.created_at,
      completedAt: command.completed_at,
      attempts: command.attempts,
      maxAttempts: command.max_attempts,
      summary: commandSummary(command),
    }));
    const activity = [...syncActivity, ...commandActivity]
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
      .slice(0, 10);
    return jsonWithCors(request, { companyId: company.id, generatedAt: new Date().toISOString(), activity });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load Tally activity:", error);
    return jsonWithCors(request, { error: "Could not load safe Tally activity." }, { status: 500 });
  }
}
