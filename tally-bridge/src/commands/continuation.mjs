import { syncVouchers } from "./sync-vouchers.mjs";
import { settlementAllocations } from "./payment-matching.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTINUATION_CHUNKS = 12;
const CHUNK_DAYS = 10;

/**
 * Receipts for last year's invoices are posted in the NEXT year's Tally company
 * once the books are split per financial year: a bill raised in March and paid in
 * April is settled in the new company, under the old invoice number. A check of
 * the old company alone would call such invoices unpaid.
 *
 * When the backend names that next-year company (scope.continuation), read only
 * its receipts/settlements for a bounded window after the year boundary and hand
 * them back as extra allocations. The normal matcher then ties them to the old
 * invoices by bill reference, exactly as it does for same-company receipts.
 *
 * It never guesses: if the next-year company is named but not open on the server,
 * the check stops and says so, because carrying on would repeat the wrong answer.
 */
export async function readContinuationAllocations({ command, scope, context, customers, includeJournals, makeScope, read = syncVouchers }) {
  const continuation = scope?.continuation;
  if (!continuation || typeof continuation !== "object") return { allocations: [], status: "none" };
  const { company, dateFrom, dateTo } = continuation;
  if (!company || !DATE.test(String(dateFrom)) || !DATE.test(String(dateTo)) || dateTo < dateFrom) return { allocations: [], status: "none" };
  // A PC connector has one Tally program and no router: it cannot reach another company.
  if (!context.resolveTarget) return { allocations: [], status: "unavailable_on_pc_connector", dateFrom, dateTo };
  const target = await context.resolveTarget(company).catch(() => null);
  if (!target) {
    throw Object.assign(new Error(`The next year's Tally company (${company.name || "unnamed"}) is not open on the server, so payments made after the year end cannot be checked. Open it in Tally, then check again.`), { failingStep: "tally_read" });
  }
  const source = { ...context, config: target.config, activeCompany: target.activeCompany };
  const allocations = [];
  let cursor = dateFrom;
  let chunks = 0;
  let vouchersScanned = 0;
  while (cursor) {
    await context.betweenWindows?.();
    if (context.isCancelled?.()) throw new Error("This check was stopped.");
    if (chunks >= MAX_CONTINUATION_CHUNKS) throw new Error("The next-year payment window is too large for one check.");
    const result = await read({ ...command, payload: { ...command.payload, syncRunId: command.payload?.voucherSyncRunId, requestedScope: makeScope({ cursor, dateFrom, dateTo, chunkDays: CHUNK_DAYS }) } }, source);
    chunks += 1;
    vouchersScanned += result.vouchers.length;
    for (const voucher of result.vouchers) allocations.push(...settlementAllocations(voucher, customers, includeJournals));
    cursor = result.cursorTo;
  }
  return { allocations, status: "read", dateFrom, dateTo, chunks, vouchersScanned };
}
