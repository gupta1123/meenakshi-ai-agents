// Per-MT Cash Discount (docs/CD_LOGIC.md). Pure calculation shared, as an
// identical copy, by the connector (instant result) and the backend
// (backend/src/lib/evaluation/cd-settlement.mjs, which re-checks before saving).
//
// Invoices go out at full price. Per invoice, within its segment's window of
// N days after the invoice (every day counts; a deadline falling on a Sunday or
// holiday moves to the next working day):
//   Full payment          received ≥ invoice − ₹1                → Credit Note = discount (left as a credit)
//   Discounted payment    received within ±₹1 of invoice − discount → Credit Note = discount
//   Short up to ₹10,000   short of the invoice by ≤ ₹10,000, not the above → staff may give min(short, discount)
//   otherwise                                                     → no discount
// Exact matches are checked before the ₹10,000 band: a discounted payment is
// usually short by less than ₹10,000 and would otherwise be swallowed by it.
// (The category key stays "over_ninety_percent"; it was a 90% band before.)
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

const TOLERANCE = new Decimal(1);
// Client rule: a flat limit, whatever the bill size.
const MAX_SHORT_FOR_REVIEW = new Decimal(10000);

function decimal(value) { return new Decimal(String(value ?? "0")); }
function money(value) { return decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(value, days) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function invoiceReferences(invoice) {
  return [invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean);
}
function referenceKey(customer, reference) { return JSON.stringify([normalized(customer), normalized(reference)]); }

export function indexCdInvoiceReferences(invoices) {
  const owners = new Map();
  for (const invoice of invoices) {
    for (const reference of invoiceReferences(invoice)) {
      const key = referenceKey(invoice.customerLedgerName, reference);
      const ids = owners.get(key) ?? new Set();
      ids.add(invoice.tallyGuid);
      owners.set(key, ids);
    }
  }
  return owners;
}

// A Receipt can create the credit side of the same bill with New Ref instead
// of Agst Ref. Accept only a positive credit owned by the invoice's customer,
// with an exact, unambiguous invoice reference. Never guess from amounts,
// narration, an unrelated advance, or the voucher's top-level party alone.
export function isMatchedCdNewRefReceipt(invoice, payment, referenceOwners) {
  if (payment.allocationType !== "new_ref" || payment.receiptKind !== "receipt") return false;
  if (!normalized(invoice.customerLedgerName)
      || normalized(payment.customerLedgerName) !== normalized(invoice.customerLedgerName)) return false;
  if (payment.ledgerIsDeemedPositive === true || !String(payment.rawAllocatedAmount ?? "").trim()) return false;
  let rawAmount;
  let allocatedAmount;
  try {
    rawAmount = decimal(String(payment.rawAllocatedAmount).replaceAll(",", "").trim());
    allocatedAmount = decimal(payment.allocatedAmount);
  } catch { return false; }
  if (!rawAmount.isFinite() || rawAmount.lte(0) || !rawAmount.eq(allocatedAmount)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.receiptDate ?? "") || payment.receiptDate < invoice.voucherDate) return false;
  // An explicit target GUID takes precedence; do not fall back to a bill name
  // when the GUID says this payment belongs to a different invoice.
  const reference = normalized(payment.targetVoucherGuid || payment.billReference);
  if (!reference || !invoiceReferences(invoice).includes(reference)) return false;
  const owners = referenceOwners.get(referenceKey(invoice.customerLedgerName, reference));
  return owners?.size === 1 && owners.has(invoice.tallyGuid);
}

/**
 * The deadline is N days after the invoice date, counting every day (Sundays
 * and holidays included). Only when that last day is a Sunday / non-working
 * weekday or a holiday does it move to the next working day.
 */
export function workingDayDeadline(calendar, invoiceDate, days) {
  if (!Number.isInteger(days) || days < 1) throw new Error("Cash Discount days are invalid.");
  const holidays = new Set(calendar?.activeHolidayDates ?? []);
  const nonWorking = new Set((calendar?.nonWorkingIsoWeekdays?.length ? calendar.nonWorkingIsoWeekdays : [7]).map(Number));
  const isOff = (date) => holidays.has(date) || nonWorking.has(new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7);
  let deadline = addDays(invoiceDate, days);
  for (let guard = 0; isOff(deadline); guard += 1) {
    if (guard > 60) throw new Error("Could not calculate the Cash Discount deadline.");
    deadline = addDays(deadline, 1);
  }
  return deadline;
}

/** GST Credit Notes for an invoice must be issued by 30 November after its financial year (CGST Act s.34). */
export function gstCreditNoteLastDate(invoiceDate) {
  const [year, month] = invoiceDate.split("-").map(Number);
  const financialYearEnd = month >= 4 ? year + 1 : year;
  return `${financialYearEnd}-11-30`;
}

/**
 * @param rule { id, segments: [{ label, allowedWorkingDays, amountPerTonne }], customerSegments: { [customerId]: segmentIndex }, calendar }
 * @param evaluatedOn ISO date of the check
 * @param invoices connector invoices (per-MT evidence: eligibleTonnes, missingUnits, payments, creditNotes)
 */
export function evaluateCashDiscountSettlements(rule, evaluatedOn, invoices) {
  const results = [];
  const candidates = [];
  const referenceOwners = indexCdInvoiceReferences(invoices);
  for (const invoice of invoices) {
    const segmentIndex = rule.customerSegments?.[invoice.customerId];
    const segment = segmentIndex === undefined ? null : rule.segments?.[segmentIndex];
    if (!segment) continue;
    const invoiceAmount = decimal(invoice.grossAmount).abs();
    if (invoiceAmount.lte(0)) continue;
    const tonnes = decimal(invoice.eligibleTonnes ?? "0");
    const missingUnits = Array.isArray(invoice.missingUnits) ? invoice.missingUnits : [];
    if (tonnes.lte(0) && !missingUnits.length) continue; // no eligible products on this invoice

    const discount = decimal(money(tonnes.mul(decimal(segment.amountPerTonne))));
    const deadline = workingDayDeadline(rule.calendar, invoice.voucherDate, Number(segment.allowedWorkingDays));
    // The evidence step has already matched these allocations to this invoice.
    const payments = (invoice.payments ?? [])
      .filter((payment) => payment.allocationType === "agst_ref"
        || isMatchedCdNewRefReceipt(invoice, payment, referenceOwners))
      .sort((left, right) => left.receiptDate.localeCompare(right.receiptDate));
    const paidByDeadline = payments.filter((payment) => payment.receiptDate <= deadline).reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const paidToDate = payments.filter((payment) => payment.receiptDate <= evaluatedOn).reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const alreadyCredited = (invoice.creditNotes ?? []).reduce((total, note) => total.plus(decimal(note.amount).abs()), decimal(0));
    const windowOpen = evaluatedOn <= deadline;
    const discountedTarget = invoiceAmount.minus(discount);

    let category;
    if (missingUnits.length) category = "needs_review";
    else if (paidByDeadline.gte(invoiceAmount.minus(TOLERANCE))) category = "full_payment";
    else if (paidByDeadline.minus(discountedTarget).abs().lte(TOLERANCE)) category = "discounted_payment";
    else if (paidByDeadline.gt(0) && invoiceAmount.minus(paidByDeadline).lte(MAX_SHORT_FOR_REVIEW)) category = "over_ninety_percent";
    else category = windowOpen ? "awaiting_payment" : "not_eligible";

    const short = Decimal.max(invoiceAmount.minus(paidByDeadline), 0);
    // Paying the full bill on time still earns the discount; the customer just
    // did not deduct it, so the Credit Note leaves a credit on their ledger.
    // Confirmed 9 Oct 2026: full payment ON TIME earns credit, but a
    // deadline shortfall subsequently cleared in full earns no new note.
    const settledLate = ["discounted_payment", "over_ninety_percent"].includes(category)
      && paidToDate.gte(invoiceAmount.minus(TOLERANCE));
    const creditAmount = settledLate ? decimal(0)
      : category === "discounted_payment" || category === "full_payment" ? discount
      : category === "over_ninety_percent" ? Decimal.min(short, discount)
      : decimal(0);
    const gstLastDate = gstCreditNoteLastDate(invoice.voucherDate);
    const credited = alreadyCredited.gt(0);
    const status = credited ? "credited"
      : settledLate ? "settled_late"
      : category === "discounted_payment" || category === "full_payment" ? "ready"
      : category === "over_ninety_percent" ? "review"
      : category;
    const reviewMessage = settledLate
      ? "The remaining balance was paid after the deadline. No new Cash Discount Credit Note applies."
      : category === "needs_review"
      ? `MT could not be worked out for unit${missingUnits.length === 1 ? "" : "s"} ${missingUnits.join(", ")}. Add the MT conversion to the rule.`
      : null;

    const row = {
      customerId: invoice.customerId,
      customerName: invoice.customerLedgerName,
      invoiceGuid: invoice.tallyGuid,
      invoiceNumber: invoice.voucherNumber ?? null,
      invoiceDate: invoice.voucherDate,
      billReference: invoice.billReferences?.[0] || invoice.voucherNumber || invoice.tallyGuid,
      sourceSalesLedgerName: invoice.sourceSalesLedgerName ?? null,
      segmentLabel: segment.label,
      windowWorkingDays: Number(segment.allowedWorkingDays),
      windowDeadline: deadline,
      windowOpen,
      invoiceAmount: money(invoiceAmount),
      eligibleTonnes: tonnes.toDecimalPlaces(6).toFixed(),
      amountPerTonne: money(segment.amountPerTonne),
      discountAmount: money(discount),
      discountedTarget: money(discountedTarget),
      paidByDeadline: money(paidByDeadline),
      paidToDate: money(paidToDate),
      alreadyCredited: money(alreadyCredited),
      creditAmount: money(creditAmount),
      category,
      status,
      gstLastDate,
      gstDeadlinePassed: evaluatedOn > gstLastDate,
      paymentCount: payments.length,
      latestPaymentDate: payments.at(-1)?.receiptDate ?? null,
      reviewMessage,
      creditNoteReferences: (invoice.creditNotes ?? []).map((note) => ({ tallyGuid: note.tallyGuid, voucherNumber: note.voucherNumber, voucherDate: note.voucherDate, amount: money(decimal(note.amount).abs()) })),
      // Shown in the invoice side panel: each payment and whether it counted.
      payments: payments.map((payment) => ({
        allocationType: payment.allocationType,
        voucherNumber: payment.receiptNumber ?? null,
        voucherType: payment.receiptType ?? null,
        date: payment.receiptDate,
        amount: money(decimal(payment.allocatedAmount).abs()),
        counted: payment.receiptDate <= deadline,
      })),
      productLines: Array.isArray(invoice.productLines) ? invoice.productLines : [],
    };
    results.push(row);
    if (!credited && creditAmount.gt(0) && !row.gstDeadlinePassed) {
      candidates.push({ ...row, status: category === "over_ninety_percent" ? "review_required" : "action_required" });
    }
  }
  const sum = (rows, field) => money(rows.reduce((total, row) => total.plus(decimal(row[field])), decimal(0)));
  const byCategory = (category) => results.filter((row) => row.category === category);
  return {
    results,
    candidates,
    totals: {
      invoicesChecked: results.length,
      fullPayment: byCategory("full_payment").length,
      discountedPayment: byCategory("discounted_payment").length,
      overNinetyPercent: byCategory("over_ninety_percent").length,
      awaitingPayment: byCategory("awaiting_payment").length,
      notEligible: byCategory("not_eligible").length,
      needsReview: byCategory("needs_review").length,
      credited: results.filter((row) => row.status === "credited").length,
      readyCreditAmount: sum(candidates.filter((row) => row.status === "action_required"), "creditAmount"),
      reviewCreditAmount: sum(candidates.filter((row) => row.status === "review_required"), "creditAmount"),
    },
  };
}
