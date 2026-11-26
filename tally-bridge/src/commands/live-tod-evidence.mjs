import { advanceDraws, matchPayments, paymentWindowStart, settlementAllocations } from "./payment-matching.mjs";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {BRIDGE_VERSION} from "../version.mjs";

import { syncVouchers } from "./sync-vouchers.mjs";
import { readContinuationAllocations } from "./continuation.mjs";
import { sourceSalesLedgerName } from "./voucher-ledgers.mjs";
import { allocationCustomer, creditNoteEvidence, customerForVoucher, matchCreditNotes } from "./credit-note-matching.mjs";

const MAX_CHUNKS = 60;
const MAX_MATCHING_VOUCHERS = 50_000;
const PAYMENT_TOLERANCE = new Decimal(1);

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function contributionSign(voucher) {
  if (voucher.voucherKind === "sales") return 1;
  if (voucher.voucherKind === "sales_return") return -1;
  if (voucher.voucherKind === "debit_note" && voucher.linkedSalesVoucherGuid) return 1;
  return 0;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}
function emptyAggregate(customerId, customerLedgerName) {
  return { customerId, customerLedgerName, matchingVouchers: 0, excludedInvoices: 0, eligibleTaxableValue: new Decimal(0), eligibleTonnes: new Decimal(0), missingUnits: new Set(), contributions: [], productContributions: new Map() };
}
function addDays(date, days) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function isoWeekday(date) { const day = new Date(`${date}T00:00:00.000Z`).getUTCDay(); return day === 0 ? 7 : day; }
function daysBetween(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000); }

/** Day N after the invoice (holidays count as days); if that day is a non-working weekday or holiday, move to the next working day. */
export function todPaymentDueDate(invoiceDate, check) {
  const holidays = new Set(check.holidays ?? []);
  const nonWorking = new Set((check.nonWorkingIsoWeekdays?.length ? check.nonWorkingIsoWeekdays : [7]).map(Number));
  const nominalDueDate = addDays(invoiceDate, Number(check.dueDays ?? 25));
  let dueDate = nominalDueDate;
  const shiftedFor = [];
  for (let guard = 0; guard < 60 && (nonWorking.has(isoWeekday(dueDate)) || holidays.has(dueDate)); guard += 1) {
    shiftedFor.push({ date: dueDate, reason: holidays.has(dueDate) ? "holiday" : "non_working_day" });
    dueDate = addDays(dueDate, 1);
  }
  return { nominalDueDate, dueDate, shiftedFor };
}

function applyContribution({ aggregate, voucher, voucherTaxableValue, voucherTonnes, productDeltas }) {
  for (const { line, lineValue, lineQuantity, lineTonnes } of productDeltas) {
    const productKey = `${normalized(line.stockItemName)}:${normalized(line.stockGroupName)}:${normalized(line.uomCode)}`;
    const product = aggregate.productContributions.get(productKey) ?? {
      productName: line.stockItemName || "Tally item",
      productGroupName: line.stockGroupName || null,
      sourceUom: line.uomCode || null,
      sourceQuantity: new Decimal(0),
      eligibleTonnes: new Decimal(0),
      eligibleTaxableValue: new Decimal(0),
    };
    product.sourceQuantity = product.sourceQuantity.plus(lineQuantity);
    product.eligibleTonnes = product.eligibleTonnes.plus(lineTonnes);
    product.eligibleTaxableValue = product.eligibleTaxableValue.plus(lineValue);
    aggregate.productContributions.set(productKey, product);
  }
  aggregate.matchingVouchers += 1;
  aggregate.eligibleTaxableValue = aggregate.eligibleTaxableValue.plus(voucherTaxableValue);
  aggregate.eligibleTonnes = aggregate.eligibleTonnes.plus(voucherTonnes);
  aggregate.contributions.push({ tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, voucherDate: voucher.voucherDate, voucherKind: voucher.voucherKind, tallyAlterId: voucher.alterId || null, linkedSalesVoucherGuid: voucher.linkedSalesVoucherGuid || null, sourceSalesLedgerName: sourceSalesLedgerName(voucher), taxableValueContribution: voucherTaxableValue.toFixed(), tonneContribution: voucherTonnes.toFixed() });
}

/**
 * Checks each period Sales invoice against its receipts; only invoices paid in full (GST-inclusive, ₹1 tolerance) by the due date count.
 * Credit Notes reduce what must be paid: our Cash Discount notes (by narration), and any other Credit Note
 * set against the bill in Tally (for example a manual discount note), for the amount set against it.
 */
function checkPayments(pendingSales, allocations, paymentCheck, notes, customers) {
  const invoices = pendingSales.map(({ voucher, aggregate }) => ({ tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber, voucherDate: voucher.voucherDate, customerId: aggregate.customerId, advanceDraws: advanceDraws(voucher, aggregate.customerId, customers), billReferences: (voucher.billAllocations ?? []).filter((allocation) => allocation.allocationType === "new_ref" && allocationCustomer(allocation, voucher, customers)?.customerId === aggregate.customerId).map((allocation) => allocation.billReference) }));
  const notesByInvoice = matchCreditNotes(invoices, notes, customers);
  const paymentsByInvoice = matchPayments(invoices, allocations);
  const checks = [];
  for (const entry of pendingSales) {
    const { voucher } = entry;
    const payments = [...new Map((paymentsByInvoice.get(voucher.guid) ?? [])
      .map((payment) => [payment.allocationKey || `${payment.receiptGuid}:${payment.billReference}:${payment.allocatedAmount}`, payment])).values()]
      .sort((left, right) => left.receiptDate.localeCompare(right.receiptDate));
    // A discounted payment plus its Cash Discount Credit Note settles the
    // invoice (docs/CD_LOGIC.md §8): the Credit Note reduces what must be paid.
    const creditNotes = (notesByInvoice.get(voucher.guid) ?? []).filter((note) => note.purpose !== "sales_return" && new Decimal(note.amount).gt(0));
    const cashDiscountCredit = creditNotes.filter((note) => note.purpose === "cash_discount").reduce((total, note) => total.plus(note.amount), new Decimal(0));
    const otherNotes = creditNotes.filter((note) => note.purpose !== "cash_discount");
    const otherCredit = otherNotes.reduce((total, note) => total.plus(note.amount), new Decimal(0));
    const invoiceAmount = new Decimal(voucher.grossAmount || 0).abs().minus(cashDiscountCredit).minus(otherCredit);
    const { nominalDueDate, dueDate, shiftedFor } = todPaymentDueDate(voucher.voucherDate, paymentCheck);
    let paidTotal = new Decimal(0);
    let paidByDueDate = new Decimal(0);
    let paidInFullOn = null;
    for (const payment of payments) {
      const amount = new Decimal(payment.allocatedAmount || 0).abs();
      paidTotal = paidTotal.plus(amount);
      if (payment.receiptDate <= dueDate) paidByDueDate = paidByDueDate.plus(amount);
    }
    // An earned CD may be booked later; other adjustments settle on their own date.
    const settlementTarget = new Decimal(voucher.grossAmount || 0).abs().minus(cashDiscountCredit);
    let settled = new Decimal(0);
    const events = [...payments.map((payment) => ({ date: payment.receiptDate, amount: payment.allocatedAmount })), ...otherNotes.map((note) => ({ date: note.voucherDate, amount: note.amount }))].sort((a, b) => a.date.localeCompare(b.date));
    for (const event of events) {
      settled = settled.plus(new Decimal(event.amount).abs());
      if (!paidInFullOn && settled.gte(settlementTarget.minus(PAYMENT_TOLERANCE))) paidInFullOn = event.date;
    }
    if (!paidInFullOn && creditNotes.length && settlementTarget.lte(PAYMENT_TOLERANCE)) paidInFullOn = creditNotes.map((note) => note.voucherDate).sort().at(-1);
    const counted = Boolean(paidInFullOn && paidInFullOn <= dueDate);
    const reason = counted ? "paid_in_full_on_time" : paidInFullOn ? "paid_after_due_date" : paidTotal.gt(0) ? "partly_paid" : "not_paid";
    checks.push({
      customerId: entry.aggregate.customerId,
      customerLedgerName: entry.aggregate.customerLedgerName,
      tallyGuid: voucher.guid,
      voucherNumber: voucher.voucherNumber || null,
      invoiceDate: voucher.voucherDate,
      invoiceAmount: invoiceAmount.toFixed(),
      dueDays: Number(paymentCheck.dueDays ?? 25),
      nominalDueDate,
      dueDate,
      shiftedFor,
      paidInFullOn,
      daysTaken: paidInFullOn ? daysBetween(voucher.voucherDate, paidInFullOn) : null,
      paidByDueDate: paidByDueDate.toFixed(),
      paidTotal: paidTotal.toFixed(),
      payments: payments.map((payment) => ({ receiptNumber: payment.receiptNumber, receiptDate: payment.receiptDate, amount: new Decimal(payment.allocatedAmount || 0).abs().toFixed() })),
      ...(creditNotes.length ? { creditNotes: creditNotes.map((note) => ({ creditNoteNumber: note.voucherNumber, creditNoteDate: note.voucherDate, amount: note.amount })) } : {}),
      tonnes: entry.voucherTonnes.toFixed(),
      taxableValue: entry.voucherTaxableValue.toFixed(),
      counted,
      reason,
    });
    if (counted) applyContribution(entry);
    else entry.aggregate.excludedInvoices += 1;
  }
  return checks.sort((left, right) => `${left.customerLedgerName}:${left.invoiceDate}:${left.voucherNumber}`.localeCompare(`${right.customerLedgerName}:${right.invoiceDate}:${right.voucherNumber}`));
}

export async function fetchLiveTodEvidence(command, context) {
  const scope = command.payload?.voucherScope && typeof command.payload.voucherScope === "object" ? command.payload.voucherScope : {};
  const eligibleGuids = new Set((scope.eligibleStockItemGuids ?? []).map(normalized).filter(Boolean));
  const eligibleNames = new Set((scope.eligibleStockItemNames ?? []).map(normalized).filter(Boolean));
  const conversions = new Map((scope.unitConversions ?? []).map((item) => [normalized(item?.uomCode), new Decimal(String(item?.tonnesPerUnit ?? "0"))]));
  const requestedCustomers = Array.isArray(scope.customers) ? scope.customers : [{ customerId: scope.customerId, tallyLedgerGuid: scope.customerLedgerGuid, ledgerName: scope.customerLedgerName }];
  const aggregates = new Map(requestedCustomers.filter((item) => item?.customerId && item?.ledgerName).map((item) => [normalized(item.ledgerName), emptyAggregate(item.customerId, item.ledgerName)]));
  if (!scope.dateFrom || !scope.dateTo || !aggregates.size) throw new Error("Live Turnover Discount evidence requires eligible customers and a bounded date range.");
  if (!eligibleGuids.size && !eligibleNames.size) throw new Error("The active Turnover Discount rule has no eligible Tally products.");
  // Without paymentCheck (older backends) every period Sales invoice counts, as before.
  const paymentCheck = scope.paymentCheck && typeof scope.paymentCheck === "object" ? scope.paymentCheck : null;
  const readTo = paymentCheck?.readTo && paymentCheck.readTo > scope.dateTo ? paymentCheck.readTo : scope.dateTo;

  const readFrom = paymentCheck ? paymentWindowStart(scope.dateFrom) : scope.dateFrom;
  let cursor = readFrom;
  let chunks = 0;
  let vouchersScanned = 0;
  let totalMatchingVouchers = 0;
  const pendingSales = [];
  const allocations = [];
  // Cash Discount Credit Notes by "<customer>|<invoice number>", read from our
  // narration "Being Cash Discount allowed against Inv No. <n> dt. …".
  const creditNotes = [];
  while (cursor) {
    await context.betweenWindows?.();
    if (context.isCancelled?.()) throw new Error("This Turnover Discount check was stopped.");
    if (chunks >= MAX_CHUNKS) throw new Error("The requested Tally period is too large for one live calculation.");
    const result = await syncVouchers({ ...command, payload: { ...command.payload, syncRunId: command.payload.voucherSyncRunId, requestedScope: { ...scope, dateFrom: readFrom, customerLedgerName: null, customers: scope.diagnosticTargeted ? requestedCustomers : null, dateTo: readTo, cursor } } }, context);
    chunks += 1;
    context.onProgress?.({ done: chunks, nextDate: result.cursorTo, vouchersScanned: vouchersScanned + result.vouchers.length });
    vouchersScanned += result.vouchers.length;
    for (const voucher of result.vouchers) {
      if (paymentCheck) allocations.push(...settlementAllocations(voucher, requestedCustomers, true));
      if (voucher.voucherDate < scope.dateFrom) continue;
      if (paymentCheck && voucher.voucherKind === "credit_note" && voucher.status === "posted") {
        creditNotes.push(creditNoteEvidence(voucher));
      }
      // Vouchers after the period are read only for their receipts and Cash Discount Credit Notes.
      if (voucher.voucherDate > scope.dateTo) continue;
      const customer = customerForVoucher(voucher, requestedCustomers);
      const aggregate = customer ? aggregates.get(normalized(customer.ledgerName)) : null;
      const sign = contributionSign(voucher);
      if (!aggregate || !sign || voucher.status !== "posted") continue;
      let voucherTaxableValue = new Decimal(0);
      let voucherTonnes = new Decimal(0);
      let matchedLineCount = 0;
      const productDeltas = [];
      for (const line of voucher.inventoryLines) {
        const selected = eligibleGuids.has(normalized(line.stockItemGuid)) || eligibleNames.has(normalized(line.stockItemName));
        if (!selected || line.lineCategory !== "inventory") continue;
        matchedLineCount += 1;
        const conversion = conversions.get(normalized(line.uomCode));
        if (!line.quantityIsReliable || !conversion || conversion.lte(0)) { aggregate.missingUnits.add(line.uomCode || "Unknown unit"); continue; }
        const lineValue = new Decimal(line.taxableProductValue).mul(sign);
        const lineQuantity = new Decimal(line.quantity).mul(sign);
        const lineTonnes = new Decimal(line.quantity).mul(conversion).mul(sign);
        voucherTaxableValue = voucherTaxableValue.plus(lineValue);
        voucherTonnes = voucherTonnes.plus(lineTonnes);
        productDeltas.push({ line, lineValue, lineQuantity, lineTonnes });
      }
      if (!matchedLineCount) continue;
      totalMatchingVouchers += 1;
      if (totalMatchingVouchers > MAX_MATCHING_VOUCHERS) throw new Error("The live calculation returned too many matching vouchers. Use a shorter rule period.");
      const entry = { aggregate, voucher, voucherTaxableValue, voucherTonnes, productDeltas };
      // Sales wait for the payment check; returns and linked debit notes always count.
      if (paymentCheck && voucher.voucherKind === "sales") pendingSales.push(entry);
      else applyContribution(entry);
    }
    cursor = result.cursorTo;
  }
  // Receipts posted in the next financial year's company for this year's invoices (see continuation.mjs).
  const continued = paymentCheck
    ? await readContinuationAllocations({
      command, scope, context, customers: requestedCustomers, includeJournals: true,
      makeScope: ({ cursor: at, dateFrom, dateTo }) => ({ ...scope, dateFrom, customerLedgerName: null, customers: scope.diagnosticTargeted ? requestedCustomers : null, dateTo, cursor: at }),
    })
    : { allocations: [], status: "none" };
  allocations.push(...continued.allocations);
  const paymentChecks = paymentCheck ? checkPayments(pendingSales, allocations, paymentCheck, creditNotes, requestedCustomers) : null;

  const customerAggregates = [...aggregates.values()].map((aggregate) => {
    aggregate.contributions.sort((left, right) => `${left.voucherDate}:${left.tallyGuid}`.localeCompare(`${right.voucherDate}:${right.tallyGuid}`));
    const missingUnits = [...aggregate.missingUnits].sort();
    const productContributions = [...aggregate.productContributions.values()].map((product) => ({
      productName: product.productName,
      productGroupName: product.productGroupName,
      sourceUom: product.sourceUom,
      sourceQuantity: product.sourceQuantity.toFixed(),
      eligibleTonnes: product.eligibleTonnes.toFixed(),
      eligibleTaxableValue: product.eligibleTaxableValue.toFixed(),
    })).sort((left, right) => left.productName.localeCompare(right.productName));
    const customerChecks = paymentChecks ? paymentChecks.filter((check) => check.customerId === aggregate.customerId) : null;
    const extra = customerChecks ? { paymentChecks: customerChecks, excludedInvoices: aggregate.excludedInvoices } : {};
    const sourceFingerprint = createHash("sha256").update(canonicalJson({ customerLedgerName: aggregate.customerLedgerName, dateFrom: scope.dateFrom, dateTo: scope.dateTo, contributions: aggregate.contributions, productContributions, missingUnits, ...extra })).digest("hex");
    return { customerId: aggregate.customerId, customerLedgerName: aggregate.customerLedgerName, matchingVouchers: aggregate.matchingVouchers, eligibleTaxableValue: Decimal.max(aggregate.eligibleTaxableValue, 0).toFixed(), eligibleTonnes: Decimal.max(aggregate.eligibleTonnes, 0).toFixed(), missingUnits, contributions: aggregate.contributions, productContributions, ...extra, sourceFingerprint };
  });
  if (!Array.isArray(scope.customers)) {
    return { mode: "live_tod_aggregate", evaluationRunId: command.payload.evaluationRunId ?? null, periodStart: scope.dateFrom, periodEnd: scope.dateTo, chunks, vouchersScanned, ...customerAggregates[0] };
  }
  const sourceFingerprint = createHash("sha256").update(canonicalJson(customerAggregates.map(({ customerId, sourceFingerprint: fingerprint }) => ({ customerId, fingerprint })))).digest("hex");
  return { mode: "live_tod_batch_aggregate", connectorVersion:BRIDGE_VERSION, evaluationRunId: command.payload.evaluationRunId ?? null, periodStart: scope.dateFrom, periodEnd: scope.dateTo, chunks, vouchersScanned, ...(continued.status === "none" ? {} : { continuation: { status: continued.status, dateFrom: continued.dateFrom, dateTo: continued.dateTo, chunks: continued.chunks ?? 0, vouchersScanned: continued.vouchersScanned ?? 0 } }), matchingVouchers: totalMatchingVouchers, customerAggregates, sourceFingerprint };
}
