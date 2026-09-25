// Per-MT Cash Discount (docs/CD_LOGIC.md). Pure calculation shared, as an
// identical copy, by the connector (instant result) and the backend
// (backend/src/lib/evaluation/cd-settlement.mjs, which re-checks before saving).
//
// Invoices go out at full price. Per invoice, within its segment's window of
// N working days (Sundays and holidays skipped):
//   Full payment          received ≥ invoice − ₹1                → no Credit Note
//   Discounted payment    received within ±₹1 of invoice − discount → Credit Note = discount
//   More than 90%         received ≥ 90% of invoice, not the above  → staff may give min(short, discount)
//   otherwise                                                     → no discount
// Exact matches are checked before the 90% band: a discounted payment is
// almost always above 90% and would otherwise be swallowed by it.
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

const TOLERANCE = new Decimal(1);
const NINETY_PERCENT = new Decimal("0.9");

function decimal(value) { return new Decimal(String(value ?? "0")); }
function money(value) { return decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(value, days) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }

/** The Nth working day after the invoice date (Sundays / non-working weekdays and holidays skipped). */
export function workingDayDeadline(calendar, invoiceDate, workingDays) {
  if (!Number.isInteger(workingDays) || workingDays < 1) throw new Error("Cash Discount working days are invalid.");
  const holidays = new Set(calendar?.activeHolidayDates ?? []);
  const nonWorking = new Set((calendar?.nonWorkingIsoWeekdays?.length ? calendar.nonWorkingIsoWeekdays : [7]).map(Number));
  let cursor = invoiceDate;
  let counted = 0;
  for (let guard = 0; guard < 400; guard += 1) {
    cursor = addDays(cursor, 1);
    const weekday = new Date(`${cursor}T00:00:00.000Z`).getUTCDay() || 7;
    if (!holidays.has(cursor) && !nonWorking.has(weekday)) counted += 1;
    if (counted === workingDays) return cursor;
  }
  throw new Error("Could not calculate the Cash Discount deadline.");
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
      .filter((payment) => payment.allocationType === "agst_ref")
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
    else if (paidByDeadline.gte(invoiceAmount.mul(NINETY_PERCENT))) category = "over_ninety_percent";
    else category = windowOpen ? "awaiting_payment" : "not_eligible";

    const short = Decimal.max(invoiceAmount.minus(paidByDeadline), 0);
    const creditAmount = category === "discounted_payment" ? discount
      : category === "over_ninety_percent" ? Decimal.min(short, discount)
      : decimal(0);
    const gstLastDate = gstCreditNoteLastDate(invoice.voucherDate);
    const credited = alreadyCredited.gt(0);
    const status = credited ? "credited"
      : category === "discounted_payment" ? "ready"
      : category === "over_ninety_percent" ? "review"
      : category;
    const reviewMessage = category === "needs_review"
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
    };
    results.push(row);
    if (!credited && creditAmount.gt(0) && !row.gstDeadlinePassed) {
      candidates.push({ ...row, status: category === "discounted_payment" ? "action_required" : "review_required" });
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
