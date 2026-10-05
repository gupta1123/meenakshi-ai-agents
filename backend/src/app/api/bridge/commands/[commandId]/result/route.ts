import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText, safeBridgeResult } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { applyMasterSyncResult, markMasterSyncFailed } from "@/lib/tally/ingest-masters";
import { applyVoucherSyncResult, markVoucherSyncFailed } from "@/lib/tally/ingest-vouchers";
import { isLiveTodAggregate, isLiveTodBatchAggregate } from "@/lib/evaluation/live-tod";
import { completeLiveCdRun, isLiveCdBatch } from "@/lib/evaluation/live-cd";
import { wakeEvaluationRunAfterTallyResult } from "@/lib/evaluation/wake-run";
import { prepareCreditNoteDocument, prepareDebitNoteDocument } from "@/lib/notes/verified-note-document.mjs";

type RouteContext = { params: Promise<{ commandId: string }> };
type CommandRow = { id: string; organization_id: string; company_id: string; connector_id: string; correlation_id: string; attempts: number; max_attempts: number; command_type: string; payload: Record<string, unknown> };
function retryAt(attempts: number) { return new Date(Date.now() + Math.min(15 * 2 ** Math.max(0, attempts - 1), 15 * 60) * 1_000).toISOString(); }

function localDiagnostic(error: unknown) {
  if (process.env.NODE_ENV !== "development") return "Could not record Tally command result.";
  if (error instanceof Error) return `Could not record Tally command result: ${error.message}`.slice(0, 2_000);
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const detail = [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ");
    if (detail) return `Could not record Tally command result: ${detail}`.slice(0, 2_000);
  }
  return "Could not record Tally command result.";
}

function creditNotePostingId(payload: Record<string, unknown>) {
  return typeof payload.creditNotePostingId === "string" && isUuid(payload.creditNotePostingId) ? payload.creditNotePostingId : null;
}
function debitNotePostingId(payload: Record<string, unknown>) {
  return typeof payload.debitNotePostingId === "string" && isUuid(payload.debitNotePostingId) ? payload.debitNotePostingId : null;
}
export function OPTIONS(request: Request) { return optionsWithCors(request); }
export async function POST(request: Request, context: RouteContext) {
  try {
    const { commandId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const controlToken = readBridgeToken(request) || readText(body.controlToken, 500) || "";
    const requestedStatus = readText(body.status, 40);
    const failureReason = readText(body.error ?? body.failureReason, 2_000);
    const attempt = Number(body.attempt);
    let safeResult = safeBridgeResult(body.result);
    if (!isUuid(commandId) || !isUuid(connectorId) || !controlToken || !Number.isInteger(attempt) || attempt < 1) return jsonWithCors(request, { error: "commandId, connectorId, bridge credential, and attempt are required." }, { status: 400 });
    if (requestedStatus !== "accepted" && requestedStatus !== "verified" && requestedStatus !== "failed") return jsonWithCors(request, { error: "status must be accepted, verified, or failed." }, { status: 400 });
    if (requestedStatus === "failed" && !failureReason) return jsonWithCors(request, { error: "A failed command requires an error message." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const supabase = createSupabaseAdminClient();
    const { data: command, error: commandError } = await supabase.from("tally_commands").select("id, organization_id, company_id, connector_id, correlation_id, attempts, max_attempts, command_type, payload").eq("id", commandId).eq("connector_id", connector.id).eq("status", "sending").eq("attempts", attempt).maybeSingle();
    if (commandError) throw commandError;
    if (!command) return jsonWithCors(request, { error: "Command is not currently leased to this bridge." }, { status: 409 });
    const row = command as unknown as CommandRow;
    // Re-running a create operation after an ambiguous network/Tally result
    // can create a second financial voucher.  Creation retries therefore
    // require a deliberate, separately audited user action.  The bridge
    // always attempts an exact read-back before it creates anything again.
    const terminalFinancialCreateFailure = requestedStatus === "failed"
      && ["create_credit_note", "create_debit_note"].includes(row.command_type);
    const exhausted = requestedStatus === "failed" && (row.attempts >= row.max_attempts || terminalFinancialCreateFailure);
    if (requestedStatus === "verified" && row.command_type === "sync_meenakshi_masters") {
      const syncRunId = typeof row.payload.syncRunId === "string" ? row.payload.syncRunId : "";
      const summary = await applyMasterSyncResult({ syncRunId, companyId: row.company_id, result: body.result });
      safeResult = { sync: summary };
    }
    if (requestedStatus === "failed" && exhausted && row.command_type === "sync_meenakshi_masters") {
      const syncRunId = typeof row.payload.syncRunId === "string" ? row.payload.syncRunId : "";
      await markMasterSyncFailed({ syncRunId, companyId: row.company_id, failureReason: failureReason ?? "Master sync failed." });
    }
    if (requestedStatus === "verified" && row.command_type === "sync_meenakshi_vouchers") {
      const syncRunId = typeof row.payload.syncRunId === "string" ? row.payload.syncRunId : "";
      const summary = await applyVoucherSyncResult({ syncRunId, companyId: row.company_id, result: body.result });
      safeResult = { sync: summary };
    }
    if (requestedStatus === "failed" && exhausted && row.command_type === "sync_meenakshi_vouchers") {
      const syncRunId = typeof row.payload.syncRunId === "string" ? row.payload.syncRunId : "";
      await markVoucherSyncFailed({ syncRunId, companyId: row.company_id, failureReason: failureReason ?? "Voucher sync failed." });
    }
    if (requestedStatus === "verified" && row.command_type === "fetch_meenakshi_evidence") {
      const fastCashDiscount = row.payload.fastCashDiscount === true;
      const masterSyncRunId = typeof row.payload.masterSyncRunId === "string" ? row.payload.masterSyncRunId : "";
      const voucherSyncRunId = typeof row.payload.voucherSyncRunId === "string" ? row.payload.voucherSyncRunId : "";
      const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
      const masterResult = result.masters;
      const voucherResult = result.vouchers;
      if ((!fastCashDiscount && (!masterSyncRunId || !voucherSyncRunId)) || !masterResult || !voucherResult) {
        throw new Error("Evidence refresh result did not include both master and voucher payloads.");
      }
      const evaluationRunId = typeof row.payload.evaluationRunId === "string" ? row.payload.evaluationRunId : null;
      if (isLiveCdBatch(voucherResult)) {
        if (!evaluationRunId || voucherResult.evaluationRunId !== evaluationRunId) throw new Error("Live Tally evidence does not belong to this Cash Discount calculation.");
        const completedAt = new Date().toISOString();
        const masterTotals = masterResult && typeof masterResult === "object" && !Array.isArray(masterResult)
          ? (masterResult as Record<string, unknown>).totals
          : null;
        const masterRecords = masterTotals && typeof masterTotals === "object" && !Array.isArray(masterTotals)
          ? Object.values(masterTotals as Record<string, unknown>).reduce<number>((total, value) => total + (Number(value) || 0), 0)
          : 0;
        if (!fastCashDiscount) {
          const [masterSync, voucherSync] = await Promise.all([
            supabase.from("tally_sync_runs").update({ status: "completed", records_received: masterRecords, records_applied: 0, records_failed: 0, error_summary: null, completed_at: completedAt }).eq("id", masterSyncRunId).eq("company_id", row.company_id),
            supabase.from("tally_sync_runs").update({ status: "completed", records_received: voucherResult.vouchersScanned, records_applied: 0, records_failed: 0, source_fingerprint: voucherResult.sourceFingerprint, error_summary: null, completed_at: completedAt }).eq("id", voucherSyncRunId).eq("company_id", row.company_id),
          ]);
          if (masterSync.error) throw masterSync.error;
          if (voucherSync.error) throw voucherSync.error;
        }
        const { data: evaluationRun, error: runError } = await supabase.from("evaluation_runs")
          .select("id, company_id, requested_by, request_context, tally_master_refresh_run_id, tally_voucher_refresh_run_id, summary")
          .eq("id", evaluationRunId).eq("company_id", row.company_id).maybeSingle();
        if (runError) throw runError;
        if (!evaluationRun) throw new Error("The Cash Discount calculation was not found while recording live Tally evidence.");
        const calculated = await completeLiveCdRun(evaluationRun, voucherResult);
        safeResult = { evaluationRunId, invoicesScanned: voucherResult.invoices.length, vouchersScanned: voucherResult.vouchersScanned, ...calculated.totals };
      } else if (isLiveTodBatchAggregate(voucherResult)) {
        const masters = masterResult && typeof masterResult === "object" && (masterResult as Record<string, unknown>).skipped === true
          ? { syncRunId: masterSyncRunId, recordsReceived: 0, recordsApplied: 0, alreadyApplied: false }
          : await applyMasterSyncResult({ syncRunId: masterSyncRunId, companyId: row.company_id, result: masterResult });
        if (!evaluationRunId || voucherResult.evaluationRunId !== evaluationRunId) throw new Error("Live Tally evidence does not belong to this batch evaluation.");
        const syncAt = new Date().toISOString();
        const [{ error: masterSyncError }, { error: syncError }] = await Promise.all([
          masterResult && typeof masterResult === "object" && (masterResult as Record<string, unknown>).skipped === true
            ? supabase.from("tally_sync_runs").update({ status: "completed", records_received: 0, records_applied: 0, records_failed: 0, source_fingerprint: null, error_summary: null, completed_at: syncAt }).eq("id", masterSyncRunId).eq("company_id", row.company_id)
            : Promise.resolve({ error: null }),
          supabase.from("tally_sync_runs").update({ status: "completed", records_received: voucherResult.vouchersScanned, records_applied: 0, records_failed: 0, source_fingerprint: voucherResult.sourceFingerprint, error_summary: null, completed_at: syncAt }).eq("id", voucherSyncRunId).eq("company_id", row.company_id),
        ]);
        if (masterSyncError || syncError) throw masterSyncError ?? syncError;
        const { data: fanout, error: fanoutError } = await supabase.rpc("fanout_meenakshi_tod_batch_evaluation", { p_parent_run_id: evaluationRunId, p_company_id: row.company_id, p_batch_result: voucherResult });
        if (fanoutError) throw fanoutError;
        safeResult = { evaluationRunId, masters, vouchers: { mode: voucherResult.mode, customers: voucherResult.customerAggregates.length, vouchersScanned: voucherResult.vouchersScanned, matchingVouchers: voucherResult.matchingVouchers, sourceFingerprint: voucherResult.sourceFingerprint }, fanout };
      } else if (isLiveTodAggregate(voucherResult)) {
        const masters = masterResult && typeof masterResult === "object" && (masterResult as Record<string, unknown>).skipped === true
          ? { syncRunId: masterSyncRunId, recordsReceived: 0, recordsApplied: 0, alreadyApplied: false }
          : await applyMasterSyncResult({ syncRunId: masterSyncRunId, companyId: row.company_id, result: masterResult });
        if (!evaluationRunId || voucherResult.evaluationRunId !== evaluationRunId) {
          throw new Error("Live Tally evidence does not belong to this evaluation.");
        }
        const completedAt = new Date().toISOString();
        const { error: syncError } = await supabase.from("tally_sync_runs").update({
          status: "completed",
          records_received: voucherResult.vouchersScanned,
          records_applied: 0,
          records_failed: 0,
          source_fingerprint: voucherResult.sourceFingerprint,
          error_summary: null,
          completed_at: completedAt,
        }).eq("id", voucherSyncRunId).eq("company_id", row.company_id);
        if (syncError) throw syncError;
        if (masterResult && typeof masterResult === "object" && (masterResult as Record<string, unknown>).skipped === true) {
          const { error: masterSyncError } = await supabase.from("tally_sync_runs").update({
            status: "completed",
            records_received: 0,
            records_applied: 0,
            records_failed: 0,
            source_fingerprint: null,
            error_summary: null,
            completed_at: completedAt,
          }).eq("id", masterSyncRunId).eq("company_id", row.company_id);
          if (masterSyncError) throw masterSyncError;
        }
        const { data: evaluationRun, error: runError } = await supabase.from("evaluation_runs")
          .select("summary")
          .eq("id", evaluationRunId)
          .eq("company_id", row.company_id)
          .maybeSingle();
        if (runError) throw runError;
        if (!evaluationRun) throw new Error("The evaluation was not found while recording live Tally evidence.");
        const priorSummary = evaluationRun.summary && typeof evaluationRun.summary === "object" && !Array.isArray(evaluationRun.summary)
          ? evaluationRun.summary as Record<string, unknown>
          : {};
        const { error: evidenceError } = await supabase.from("evaluation_runs").update({
          summary: { ...priorSummary, evidenceMode: "live_tod_aggregate", liveTodEvidence: voucherResult },
        }).eq("id", evaluationRunId).eq("company_id", row.company_id);
        if (evidenceError) throw evidenceError;
        safeResult = {
          evaluationRunId,
          masters,
          vouchers: {
            mode: voucherResult.mode,
            vouchersScanned: voucherResult.vouchersScanned,
            matchingVouchers: voucherResult.matchingVouchers,
            sourceFingerprint: voucherResult.sourceFingerprint,
          },
        };
      } else {
        const masters = await applyMasterSyncResult({ syncRunId: masterSyncRunId, companyId: row.company_id, result: masterResult });
        const vouchers = await applyVoucherSyncResult({ syncRunId: voucherSyncRunId, companyId: row.company_id, result: voucherResult });
        safeResult = { evaluationRunId, masters, vouchers };
      }
      if (evaluationRunId && !isLiveCdBatch(voucherResult)) {
        await wakeEvaluationRunAfterTallyResult({ companyId: row.company_id, evaluationRunId });
      }
    }
    if (requestedStatus === "failed" && exhausted && row.command_type === "fetch_meenakshi_evidence") {
      const fastCashDiscount = row.payload.fastCashDiscount === true;
      const masterSyncRunId = typeof row.payload.masterSyncRunId === "string" ? row.payload.masterSyncRunId : "";
      const voucherSyncRunId = typeof row.payload.voucherSyncRunId === "string" ? row.payload.voucherSyncRunId : "";
      if (!fastCashDiscount) {
        await Promise.all([
          markMasterSyncFailed({ syncRunId: masterSyncRunId, companyId: row.company_id, failureReason: failureReason ?? "Evidence master refresh failed." }),
          markVoucherSyncFailed({ syncRunId: voucherSyncRunId, companyId: row.company_id, failureReason: failureReason ?? "Evidence voucher refresh failed." }),
        ]);
      }
      const evaluationRunId = typeof row.payload.evaluationRunId === "string" ? row.payload.evaluationRunId : null;
      if (evaluationRunId) {
        if (fastCashDiscount) {
          const message = failureReason ?? "The live Cash Discount read failed.";
          const { error: runFailureError } = await supabase.from("evaluation_runs").update({
            status: "failed",
            error_summary: message,
            summary: { schemeType: "cd", outcome: "failed", liveOnly: true, message },
            completed_at: new Date().toISOString(),
            locked_at: null,
            locked_by: null,
            lease_expires_at: null,
          }).eq("id", evaluationRunId).eq("company_id", row.company_id);
          if (runFailureError) throw runFailureError;
        } else {
          await wakeEvaluationRunAfterTallyResult({ companyId: row.company_id, evaluationRunId });
        }
      }
    }
    const postingId = creditNotePostingId(row.payload);
    if (requestedStatus === "verified" && postingId && row.command_type === "create_credit_note") {
      const { data, error } = await supabase.rpc("record_meenakshi_credit_note_create_result", {
        p_credit_note_posting_id: postingId, p_connector_id: connector.id, p_result: safeBridgeResult(body.result) ?? {}, p_correlation_id: row.correlation_id,
      });
      if (error) throw error;
      safeResult = { creditNotePostingId: data, lifecycle: "verification_queued" };
    }
    if (requestedStatus === "verified" && postingId && row.command_type === "verify_credit_note") {
      const { data, error } = await supabase.rpc("complete_meenakshi_credit_note_verification", {
        p_credit_note_posting_id: postingId, p_connector_id: connector.id, p_result: safeBridgeResult(body.result) ?? {}, p_correlation_id: row.correlation_id,
      });
      if (error) throw error;
      safeResult = data as Record<string, unknown>;
    }
    if (requestedStatus === "verified" && postingId && row.command_type === "export_credit_note_pdf") {
      const { data, error } = await supabase.rpc("record_meenakshi_credit_note_pdf_result", {
        p_credit_note_posting_id: postingId, p_connector_id: connector.id, p_result: safeBridgeResult(body.result) ?? {}, p_correlation_id: row.correlation_id,
      });
      if (error) throw error;
      safeResult = { creditNotePostingId: data, lifecycle: "pdf_verified" };
    }
    if (requestedStatus === "failed" && exhausted && postingId && ["create_credit_note", "verify_credit_note", "export_credit_note_pdf"].includes(row.command_type)) {
      const { error } = await supabase.rpc("record_meenakshi_credit_note_failure", {
        p_credit_note_posting_id: postingId, p_connector_id: connector.id, p_command_type: row.command_type, p_failure_reason: failureReason ?? "Tally Credit Note command failed.", p_correlation_id: row.correlation_id,
      });
      if (error) throw error;
    }
    const debitPostingId = debitNotePostingId(row.payload);
    if (requestedStatus === "verified" && debitPostingId && row.command_type === "create_debit_note") {
      const { data, error } = await supabase.rpc("record_meenakshi_debit_note_result", {
        p_posting_id: debitPostingId,
        p_result: safeBridgeResult(body.result) ?? {},
        p_failure_reason: null,
      });
      if (error) throw error;
      safeResult = { debitNotePostingId: data, lifecycle: "created_verified" };
    }
    if (requestedStatus === "failed" && exhausted && debitPostingId && row.command_type === "create_debit_note") {
      const { error } = await supabase.rpc("record_meenakshi_debit_note_result", {
        p_posting_id: debitPostingId,
        p_result: {},
        p_failure_reason: failureReason ?? "Tally Debit Note command failed.",
      });
      if (error) throw error;
    }
    const nextStatus = exhausted ? "dead_letter" : requestedStatus;
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase.from("tally_commands").update({
      status: nextStatus, safe_result: safeResult, failure_reason: requestedStatus === "failed" ? failureReason : null,
      available_at: requestedStatus === "failed" && !exhausted ? retryAt(row.attempts) : now,
      completed_at: requestedStatus === "failed" && !exhausted ? null : now,
      locked_at: null, locked_by: null, lease_expires_at: null,
    }).eq("id", row.id).eq("connector_id", connector.id).eq("status", "sending").eq("attempts", attempt).select("id, status, attempts, available_at, completed_at").maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return jsonWithCors(request, { error: "Command state changed before the result was recorded." }, { status: 409 });
    if (requestedStatus === "verified" && row.command_type === "verify_credit_note" && postingId) {
      try { await prepareCreditNoteDocument(supabase, row.company_id, postingId); }
      catch (documentError) { console.error("Credit Note verified; reference PDF preparation needs retry:", documentError); }
    }
    if (requestedStatus === "verified" && row.command_type === "create_debit_note" && debitPostingId) {
      try { await prepareDebitNoteDocument(supabase, row.company_id, debitPostingId); }
      catch (documentError) { console.error("Debit Note verified; reference PDF preparation needs retry:", documentError); }
    }
    await appendMeenakshiAuditEvent({
      organizationId: row.organization_id, companyId: row.company_id, actorType: "tally_connector",
      action: nextStatus === "failed" || nextStatus === "dead_letter" ? "tally_command_failed" : nextStatus === "accepted" ? "tally_command_accepted" : "tally_command_completed",
      entityType: "tally_command", entityId: row.id, correlationId: row.correlation_id,
      newValue: { status: nextStatus, attempts: row.attempts }, metadata: { commandType: row.command_type, failureReason: failureReason ?? null },
    });
    return jsonWithCors(request, { command: updated });
  } catch (error) {
    console.error("Error in POST /api/bridge/commands/[commandId]/result:", error);
    return jsonWithCors(request, { error: localDiagnostic(error) }, { status: 500 });
  }
}
