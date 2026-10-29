import { syncMasters } from "./sync-masters.mjs";
import { syncVouchers } from "./sync-vouchers.mjs";
import { fetchLiveTodEvidence } from "./live-tod-evidence.mjs";
import { fetchLiveCdEvidence } from "./live-cd-evidence.mjs";

// Phase 4 uses one durable command so the backend can treat the master and
// voucher reads as one fresh-evidence operation.  The actual XML readers and
// parsers remain the tested Phase 2 implementations.
export async function fetchEvidence(command, context) {
  const fastCashDiscount = command.payload?.fastCashDiscount === true
    && command.payload?.voucherScope?.liveAggregation === "cd";
  const masterSyncRunId = typeof command.payload?.masterSyncRunId === "string" ? command.payload.masterSyncRunId : "";
  const voucherSyncRunId = typeof command.payload?.voucherSyncRunId === "string" ? command.payload.voucherSyncRunId : "";
  if (!fastCashDiscount && (!masterSyncRunId || !voucherSyncRunId)) throw new Error("Evidence refresh command requires masterSyncRunId and voucherSyncRunId.");

  const liveTod = command.payload?.voucherScope?.liveAggregation === true;
  // TOD already receives the eligible customer/product scope from the
  // rulebook snapshot. Its live calculation only needs the voucher stream;
  // refreshing all seven master collections here was redundant and added a
  // large Tally round-trip waterfall to every TOD run.
  const masterResult = liveTod || fastCashDiscount
    ? {
      syncRunId: masterSyncRunId || null,
      activeCompany: context.activeCompany,
      complete: true,
      skipped: true,
      masters: {},
      totals: {},
    }
    : await syncMasters({
      ...command,
      payload: { ...command.payload, syncRunId: masterSyncRunId },
    }, context);
  if (context.isCancelled?.()) throw new Error("This Tally read was stopped.");
  const voucherResult = command.payload?.voucherScope?.liveAggregation === "cd"
    ? await fetchLiveCdEvidence(command, context, masterResult)
    : liveTod
    ? await fetchLiveTodEvidence(command, context)
    : await syncVouchers({
    ...command,
    payload: {
      ...command.payload,
      syncRunId: voucherSyncRunId,
      requestedScope: command.payload?.voucherScope ?? {},
    },
    }, context);

  return {
    evaluationRunId: command.payload?.evaluationRunId ?? null,
    activeCompany: context.activeCompany,
    complete: true,
    masters: masterResult,
    vouchers: voucherResult,
  };
}
