import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

function decimal(value) { return new Decimal(value); }
function money(value, scale = 4) { return decimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale); }
function nonNegative(value) { return Decimal.max(decimal(0), decimal(value)); }
function percentOf(value, percentage) { return decimal(value).mul(decimal(percentage)).div(100); }

function dateAtUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid ISO date: ${value}`);
  return date;
}

function workingDayDeadline(calendar, startDate, allowedWorkingDays) {
  if (!Number.isInteger(allowedWorkingDays) || allowedWorkingDays < 0) throw new Error("Cash Discount working days are invalid.");
  const holidays = new Set(calendar.activeHolidayDates);
  const nonWorking = new Set(calendar.nonWorkingIsoWeekdays);
  let cursor = dateAtUtc(startDate);
  let counted = 0;
  for (let guard = 0; guard < 3_000; guard += 1) {
    const businessDate = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay() || 7;
    if (guard > 0 && !holidays.has(businessDate) && !nonWorking.has(weekday)) counted += 1;
    if (counted === allowedWorkingDays) return businessDate;
    cursor = new Date(cursor.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("Could not calculate the Cash Discount payment deadline.");
}

// "CD 1.5%", "1.5% cash discount", "Less 2 percent C.D." qualify; "18% GST" or "CD" alone do not.
export function offersCashDiscount(narration) {
  const text = String(narration ?? "");
  return /\bcash\s*discount\b|\bc\s*\.?\s*d\s*\.?\b/i.test(text) && /%|\bper\s*cent(?:age)?\b/i.test(text);
}

export function parseCashDiscountNarration(value) {
  const sourceText = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!sourceText) return { mentioned: false, percentage: null, allowedDays: null, dayType: null };
  const mentioned = /\bcash\s*discount\b|\bc\s*\.?\s*d\s*\.?\b/i.test(sourceText);
  if (!mentioned) return { mentioned: false, percentage: null, allowedDays: null, dayType: null };
  const percentageMatch = sourceText.match(/(\d+(?:\.\d+)?)\s*%/i);
  const daysMatch = sourceText.match(/(?:within|in|before|upto|up\s*to)\s*(\d{1,3})\s*(working|business|calendar)?\s*days?/i)
    ?? sourceText.match(/(\d{1,3})\s*(working|business|calendar)?\s*days?\s*(?:cash\s*discount|c\s*\.?\s*d\s*\.?)/i);
  const dayWord = daysMatch?.[2]?.toLowerCase();
  return {
    mentioned,
    percentage: percentageMatch ? Number(percentageMatch[1]) : null,
    allowedDays: daysMatch ? Number(daysMatch[1]) : null,
    dayType: !daysMatch ? null : dayWord === "working" || dayWord === "business" ? "working_days" : dayWord === "calendar" ? "calendar_days" : "unspecified",
  };
}

function completionDate(invoiceAmount, payments, evaluatedOn) {
  let paid = decimal(0);
  for (const payment of [...payments]
    .filter((item) => item.allocationType === "agst_ref" && item.receiptDate <= evaluatedOn)
    .sort((left, right) => left.receiptDate.localeCompare(right.receiptDate) || left.receiptGuid.localeCompare(right.receiptGuid))) {
    paid = paid.plus(decimal(payment.allocatedAmount).abs());
    if (paid.greaterThanOrEqualTo(invoiceAmount)) return payment.receiptDate;
  }
  return null;
}

// Keep this calculation byte-for-byte equivalent in behaviour to the backend
// evaluator. The backend recalculates the submitted evidence before persisting;
// this local copy exists only to remove cloud latency from what the user sees.
export function evaluateLocalCashDiscount(rule, evaluatedOn, invoices) {
  const rows = [];
  const results = [];
  const slabs = [...rule.slabs].sort((left, right) => left.allowedWorkingDays - right.allowedWorkingDays || decimal(right.percentage).comparedTo(decimal(left.percentage)));
  const highestPercentage = slabs.reduce((highest, slab) => decimal(slab.percentage).greaterThan(highest) ? decimal(slab.percentage) : highest, decimal(0));

  for (const invoice of invoices) {
    const netInvoiceAmount = decimal(invoice.grossAmount).abs();
    if (netInvoiceAmount.lessThanOrEqualTo(0)) continue;
    // Only invoices whose narration offers Cash Discount count: it must mention
    // CD / cash discount together with a percentage ("%" or "percent"). The
    // rule percentage always applies; the narration only qualifies the invoice.
    if (!offersCashDiscount(invoice.narration)) continue;
    const narration = parseCashDiscountNarration(invoice.narration);
    const narrationSlab = narration.percentage === null ? null : slabs.find((slab) => decimal(slab.percentage).equals(narration.percentage));
    const narrationMatches = Boolean(narrationSlab)
      && (narration.allowedDays === null || narrationSlab.allowedWorkingDays === narration.allowedDays)
      && narration.dayType !== "calendar_days";
    const narrationConflict = rule.narrationMode === "required" && (!narration.mentioned || !narrationMatches);
    const grantedPercentage = highestPercentage;
    if (grantedPercentage.lessThanOrEqualTo(0) || grantedPercentage.greaterThanOrEqualTo(100)) continue;

    const impliedGrossAmount = netInvoiceAmount.div(decimal(1).minus(grantedPercentage.div(100)));
    const paidToDate = invoice.payments.filter((payment) => payment.allocationType === "agst_ref" && payment.receiptDate <= evaluatedOn)
      .reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const paidInFullOn = completionDate(netInvoiceAmount, invoice.payments, evaluatedOn);
    const windows = slabs.map((slab) => ({ ...slab, deadline: workingDayDeadline(rule.calendar, invoice.voucherDate, slab.allowedWorkingDays) }));
    const earnedWindow = paidInFullOn
      ? windows.filter((window) => paidInFullOn <= window.deadline).sort((left, right) => decimal(right.percentage).comparedTo(decimal(left.percentage)))[0] ?? null
      : windows.filter((window) => evaluatedOn <= window.deadline).sort((left, right) => decimal(right.percentage).comparedTo(decimal(left.percentage)))[0] ?? null;
    // Invoices paid in full after the deadline are not recovered and not listed.
    if (paidInFullOn && !earnedWindow) continue;
    const earnedPercentage = earnedWindow ? decimal(earnedWindow.percentage) : decimal(0);
    const recoveryRequired = nonNegative(percentOf(impliedGrossAmount, grantedPercentage.minus(earnedPercentage)));
    const postedDebitNotes = (invoice.debitNotes ?? []).filter((note) => note.status === "posted");
    const alreadyRecovered = postedDebitNotes.reduce((total, note) => total.plus(decimal(note.amount).abs()), decimal(0));
    const remainingRecovery = nonNegative(recoveryRequired.minus(alreadyRecovered));
    // Debit Notes are posted rounded to whole rupees (with GST), so a
    // difference under Rs.1 either way is rounding, not a new recovery.
    const overRecovered = alreadyRecovered.greaterThan(recoveryRequired.plus(decimal("1")));
    const missingSalesLedger = !String(invoice.sourceSalesLedgerName ?? "").trim();
    const finalDeadline = windows.at(-1).deadline;
    const openShortfall = nonNegative(netInvoiceAmount.minus(paidToDate));
    const needsRecovery = alreadyRecovered.greaterThan(0) ? remainingRecovery.greaterThanOrEqualTo(decimal("1")) : remainingRecovery.greaterThan(decimal("0.0049"));
    const needsReview = overRecovered || narrationConflict || (needsRecovery && missingSalesLedger);
    const status = needsReview ? "needs_review" : needsRecovery ? "recovery_due" : openShortfall.greaterThan(0) ? "payment_due" : "retained";
    const reviewMessage = overRecovered ? "Existing Debit Notes exceed the recovery now supported by the latest receipts. Review possible backdated payment or duplicate recovery."
      : narrationConflict ? "The invoice narration does not match the active Cash Discount rule. Review this invoice before posting."
        : needsRecovery && missingSalesLedger ? "The original invoice Sales ledger could not be identified from Tally. Refresh the calculation before posting." : null;
    const paymentsToDate = invoice.payments.filter((payment) => payment.allocationType === "agst_ref" && payment.receiptDate <= evaluatedOn);
    const latestPaymentDate = paymentsToDate.map((payment) => payment.receiptDate).sort().at(-1) ?? null;

    results.push({
      customerName: invoice.customerLedgerName,
      invoiceGuid: invoice.tallyGuid,
      invoiceNumber: invoice.voucherNumber,
      invoiceDate: invoice.voucherDate,
      invoiceAmount: money(netInvoiceAmount),
      amountPaid: money(paidToDate),
      outstandingAmount: money(openShortfall),
      discountPercentage: money(grantedPercentage),
      earnedDiscountPercentage: money(earnedPercentage),
      eligibilityDeadline: finalDeadline,
      status,
      paymentCount: paymentsToDate.length,
      latestPaymentDate,
      reviewMessage,
    });

    if (!needsRecovery && !overRecovered && !narrationConflict) continue;

    const missedWindow = [...windows].filter((window) => window.deadline < evaluatedOn && decimal(window.percentage).greaterThan(earnedPercentage))
      .sort((left, right) => right.allowedWorkingDays - left.allowedWorkingDays)[0] ?? windows.at(-1);
    const nextWindow = windows.filter((window) => window.deadline >= evaluatedOn && window.deadline > missedWindow.deadline && decimal(window.percentage).lessThan(decimal(missedWindow.percentage)))
      .sort((left, right) => left.allowedWorkingDays - right.allowedWorkingDays)[0] ?? null;
    const recoveryStatus = needsReview ? "review_required" : "action_required";
    const reasonCode = overRecovered ? "existing_debit_note_exceeds_recovery" : narrationConflict ? "cash_discount_narration_conflict" : missingSalesLedger ? "source_sales_ledger_unavailable" : earnedPercentage.equals(0) ? "final_payment_window_missed" : "higher_discount_window_missed";
    rows.push({
      customerTallyGuid: invoice.customerId, customerName: invoice.customerLedgerName, sourceSalesLedgerName: invoice.sourceSalesLedgerName,
      invoiceTallyGuid: invoice.tallyGuid, invoiceNumber: invoice.voucherNumber, invoiceDate: invoice.voucherDate,
      billReference: invoice.billReferences[0] || invoice.voucherNumber || invoice.tallyGuid,
      netInvoiceAmount: money(netInvoiceAmount), impliedGrossAmount: money(impliedGrossAmount), amountPaid: money(paidToDate),
      grantedDiscountPercentage: money(grantedPercentage), earnedDiscountPercentage: money(earnedPercentage), recoveryRequired: money(recoveryRequired),
      alreadyRecovered: money(alreadyRecovered), remainingRecovery: money(remainingRecovery), missedWindowWorkingDays: missedWindow.allowedWorkingDays,
      missedWindowDeadline: missedWindow.deadline, nextWindowWorkingDays: nextWindow?.allowedWorkingDays ?? null, nextWindowPercentage: nextWindow?.percentage ?? null,
      status: recoveryStatus, reasonCode, reviewMessage, narration: { checked: rule.checkNarration, mentioned: narration.mentioned, matches: narrationMatches },
      debitNoteReferences: postedDebitNotes.map((note) => ({ tallyGuid: note.tallyGuid, voucherNumber: note.voucherNumber, voucherDate: note.voucherDate, amount: money(decimal(note.amount).abs()) })),
    });
  }

  return {
    rows,
    results,
    totals: {
      invoicesChecked: invoices.length,
      actionRequired: rows.filter((row) => row.status === "action_required").length,
      reviewRequired: rows.filter((row) => row.status === "review_required").length,
      recoveryAmount: money(rows.filter((row) => row.status === "action_required").reduce((total, row) => total.plus(decimal(row.remainingRecovery)), decimal(0))),
      alreadyRecovered: money(rows.reduce((total, row) => total.plus(decimal(row.alreadyRecovered)), decimal(0))),
    },
  };
}
