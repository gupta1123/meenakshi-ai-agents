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
//
// On-account credit: money the customer has with us that is not set against
// any bill (opening on-account balance, or the "On Account" part of a receipt)
// counts as payment for an invoice that would otherwise miss out. It is used
// oldest invoice first, only up to what that invoice needs, and only credit
// that existed by the invoice's deadline. Each rupee is used once.
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

const TOLERANCE = new Decimal(1);
// Client rule: a flat limit, whatever the bill size.
const MAX_SHORT_FOR_REVIEW = new Decimal(10000);

function decimal(value) { return new Decimal(String(value ?? "0")); }
function money(value) { return decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(value, days) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }

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
function creditPools(customerCredits) {
  const pools = new Map();
  for (const credit of Array.isArray(customerCredits) ? customerCredits : []) {
    if (!credit?.customerId || !credit.date) continue;
    const pool = pools.get(credit.customerId) ?? { events: [], used: decimal(0) };
    pool.events.push({ date: String(credit.date), amount: decimal(credit.amount) });
    pools.set(credit.customerId, pool);
  }
  for (const pool of pools.values()) pool.events.sort((left, right) => left.date.localeCompare(right.date));
  return pools;
}

/** Credit free by `date`: the lowest running on-account balance from `date` on, less what is already used (credit spent later cannot be lent earlier). */
function freeCredit(pool, date) {
  let balance = decimal(0);
  for (const event of pool.events) if (event.date <= date) balance = balance.plus(event.amount);
  let lowest = balance;
  for (const event of pool.events) if (event.date > date) { balance = balance.plus(event.amount); if (balance.lt(lowest)) lowest = balance; }
  return Decimal.max(lowest.minus(pool.used), 0);
}

/**
 * @param customerCredits [{ customerId, date, amount, source }] on-account credit (+) and debit (−) from Tally; optional
 */
export function evaluateCashDiscountSettlements(rule, evaluatedOn, invoices, customerCredits = []) {
  const results = [];
  const candidates = [];
  const pools = creditPools(customerCredits);
  // Oldest invoice first, so credit goes to the earliest bill that needs it.
  const ordered = invoices.map((invoice, index) => ({ invoice, index }))
    .sort((left, right) => String(left.invoice.voucherDate).localeCompare(String(right.invoice.voucherDate)) || left.index - right.index);
  const order = new Map();
  for (const { invoice, index } of ordered) {
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
    const paidByPayments = payments.filter((payment) => payment.receiptDate <= deadline).reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const paidToDate = payments.filter((payment) => payment.receiptDate <= evaluatedOn).reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const notes = (invoice.creditNotes ?? []).filter((note) => note.voucherDate <= evaluatedOn);
    const cdNotes = notes.filter((note) => (!note.purpose || note.purpose === "cash_discount") && !note.reviewReason);
    const alreadyCredited = cdNotes.reduce((total, note) => total.plus(decimal(note.amount).abs()), decimal(0));
    const adjustments = notes.filter((note) => note.purpose === "adjustment" && !note.reviewReason);
    const adjustmentByDeadline = adjustments.filter((note) => note.voucherDate <= deadline).reduce((total, note) => total.plus(decimal(note.amount).abs()), decimal(0));
    const invoiceAmountDue = Decimal.max(invoiceAmount.minus(adjustmentByDeadline), 0);
    const windowOpen = evaluatedOn <= deadline;
    const discountedTarget = Decimal.max(invoiceAmountDue.minus(discount), 0);

    let category;
    if (missingUnits.length || invoice.paymentMatchNeedsReview) category = "needs_review";
    else if (paidByPayments.gte(invoiceAmountDue.minus(TOLERANCE))) category = "full_payment";
    else if (paidByPayments.minus(discountedTarget).abs().lte(TOLERANCE)) category = "discounted_payment";
    else if (paidByPayments.gt(0) && invoiceAmountDue.minus(paidByPayments).lte(MAX_SHORT_FOR_REVIEW)) category = "over_ninety_percent";
    else category = windowOpen ? "awaiting_payment" : "not_eligible";

    // Missed on payments alone and the window has closed: use free on-account credit.
    let creditUsed = decimal(0);
    let creditAvailable = decimal(0);
    const pool = pools.get(invoice.customerId);
    if (category === "not_eligible" && pool) {
      const free = freeCredit(pool, deadline);
      creditAvailable = free;
      const neededForDiscount = discountedTarget.minus(paidByPayments);
      if (free.gt(0) && neededForDiscount.gt(0) && free.gte(neededForDiscount.minus(TOLERANCE))) {
        creditUsed = Decimal.min(free, neededForDiscount);
        category = "discounted_payment";
      } else if (free.gt(0) && invoiceAmountDue.minus(paidByPayments.plus(free)).lte(MAX_SHORT_FOR_REVIEW)) {
        creditUsed = free;
        category = "over_ninety_percent";
      }
      pool.used = pool.used.plus(creditUsed);
    }
    const paidByDeadline = paidByPayments.plus(creditUsed);

    const short = Decimal.max(invoiceAmountDue.minus(paidByDeadline), 0);
    // Paying the full bill on time still earns the discount; the customer just
    // did not deduct it, so the Credit Note leaves a credit on their ledger.
    const creditAmount = category === "discounted_payment" || category === "full_payment" ? discount
      : category === "over_ninety_percent" ? Decimal.min(short, discount)
      : decimal(0);
    const gstLastDate = gstCreditNoteLastDate(invoice.voucherDate);
    const mismatchedCredit = alreadyCredited.gt(0) && alreadyCredited.minus(discount).abs().gt(TOLERANCE);
    const creditNoteReviewRequired = mismatchedCredit || notes.some((note) => note.reviewReason || ["unclear", "sales_return"].includes(note.purpose)) || (adjustments.length > 0 && invoiceAmountDue.lte(0));
    const credited = alreadyCredited.gt(0) && !creditNoteReviewRequired;
    const status = creditNoteReviewRequired ? "credit_note_review" : credited ? "credited"
      : category === "discounted_payment" || category === "full_payment" ? "ready"
      : category === "over_ninety_percent" ? "review"
      : category;
    const reviewMessage = creditNoteReviewRequired
      ? mismatchedCredit ? `Existing Cash Discount is ${money(alreadyCredited)}; the calculated discount is ${money(discount)}. Review the existing Credit Note before any further credit.`
        : notes.find((note) => note.reviewReason)?.reviewReason ?? "Credit Notes cover the invoice amount. Review the adjustment before giving Cash Discount."
      : invoice.paymentMatchNeedsReview ? "Tally has payment allocations for this bill that could not be matched uniquely. Review the receipts before issuing credit."
      : category === "needs_review"
      ? `MT could not be worked out for unit${missingUnits.length === 1 ? "" : "s"} ${missingUnits.join(", ")}. Add the MT conversion to the rule.`
      : creditUsed.gt(0) ? `Includes ₹${money(creditUsed)} of the customer's on-account credit (not set against any bill in Tally).`
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
      invoiceAmountDue: money(invoiceAmountDue),
      adjustmentByDeadline: money(adjustmentByDeadline),
      eligibleTonnes: tonnes.toDecimalPlaces(6).toFixed(),
      amountPerTonne: money(segment.amountPerTonne),
      discountAmount: money(discount),
      discountedTarget: money(discountedTarget),
      paidByDeadline: money(paidByDeadline),
      onAccountCreditUsed: money(creditUsed),
      onAccountCreditAvailable: money(creditAvailable),
      paidToDate: money(paidToDate),
      alreadyCredited: money(alreadyCredited),
      creditAmount: money(creditAmount),
      category: creditNoteReviewRequired ? "needs_review" : category,
      status,
      creditNoteReviewRequired,
      gstLastDate,
      gstDeadlinePassed: evaluatedOn > gstLastDate,
      paymentCount: payments.length,
      latestPaymentDate: payments.at(-1)?.receiptDate ?? null,
      reviewMessage,
      creditNoteReferences: notes.map((note) => ({ tallyGuid: note.tallyGuid, voucherNumber: note.voucherNumber, voucherDate: note.voucherDate, amount: money(decimal(note.amount).abs()), noteAmount: money(decimal(note.noteAmount ?? note.amount).abs()), purpose: note.purpose ?? "cash_discount", matchedBy: note.matchedBy ?? "narration", reviewReason: note.reviewReason ?? null })),
      // Shown in the invoice side panel: each payment and whether it counted.
      payments: payments.map((payment) => ({
        voucherNumber: payment.receiptNumber ?? null,
        voucherType: payment.receiptType ?? null,
        date: payment.receiptDate,
        amount: money(decimal(payment.allocatedAmount).abs()),
        counted: payment.receiptDate <= deadline,
      })).concat(creditUsed.gt(0) ? [{ voucherNumber: null, voucherType: "On-account credit", date: deadline, amount: money(creditUsed), counted: true }] : []),
      productLines: Array.isArray(invoice.productLines) ? invoice.productLines : [],
    };
    results.push(row);
    order.set(row, index);
    if (!alreadyCredited.gt(0) && !creditNoteReviewRequired && creditAmount.gt(0) && !row.gstDeadlinePassed) {
      const candidate = { ...row, status: category === "over_ninety_percent" ? "review_required" : "action_required" };
      candidates.push(candidate);
      order.set(candidate, index);
    }
  }
  // Back to the connector's order.
  results.sort((left, right) => order.get(left) - order.get(right));
  candidates.sort((left, right) => order.get(left) - order.get(right));
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
