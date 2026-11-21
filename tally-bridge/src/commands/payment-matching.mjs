import Decimal from "decimal.js";
import { allocationCustomer, invoiceMatcher } from "./credit-note-matching.mjs";

export function paymentWindowStart(date) {
  const day = new Date(date + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function settlementAllocations(voucher, customers, includeJournals) {
  const journal = voucher.voucherKind === "other" && /journal|payment/i.test(voucher.voucherTypeName || "");
  if (voucher.status !== "posted" || !(["receipt", "payment"].includes(voucher.voucherKind) || (includeJournals && journal))) return [];
  return voucher.billAllocations.flatMap(allocation => {
    const owner = allocationCustomer(allocation, voucher, customers);
    if (!owner) return [];
    const isDebit = String(allocation.sourcePayload?.rawAmount || "").trim().startsWith("-");
    if (isDebit && (journal || allocation.allocationType !== "agst_ref")) return [];
    return [{ customerId: owner.customerId, allocationKey: allocation.allocationKey, receiptGuid: voucher.guid,
      receiptNumber: voucher.voucherNumber || null, receiptType: voucher.voucherTypeName || null, receiptDate: voucher.voucherDate,
      billReference: allocation.billReference || null, targetVoucherGuid: allocation.targetVoucherGuid || null,
      targetVoucherNumber: allocation.targetVoucherNumber || null, allocationType: allocation.allocationType, allocatedAmount: allocation.allocatedAmount }];
  });
}

export function advanceDraws(voucher, customerId, customers) {
  return voucher.billAllocations.filter(a => a.allocationType === "agst_ref" && a.billReference
    && String(a.sourcePayload?.rawAmount || "").trim().startsWith("-")
    && allocationCustomer(a, voucher, customers)?.customerId === customerId)
    .map(({ billReference, allocatedAmount, allocationKey }) => ({ billReference, allocatedAmount, allocationKey }));
}

export function matchPayments(invoices, allocations) {
  const matchInvoice = invoiceMatcher(invoices);
  const payments = new Map();
  const advances = new Map();
  const refKey = (customer, ref) => JSON.stringify([customer, ref.trim().toLowerCase()]);
  function append(invoice, payment) {
    if (!payments.has(invoice.tallyGuid)) payments.set(invoice.tallyGuid, []);
    payments.get(invoice.tallyGuid).push(payment);
  }
  for (const payment of allocations) {
    if (payment.allocationType === "agst_ref") {
      const matches = matchInvoice(payment, { customerId: payment.customerId });
      if (matches.length === 1) append(matches[0], payment);
    } else if (["advance", "new_ref"].includes(payment.allocationType) && payment.billReference) {
      const key = refKey(payment.customerId, payment.billReference);
      // Reused reference names cannot identify a single originating receipt.
      advances.set(key, advances.has(key) ? null : { payment, draws: [], total: new Decimal(0) });
    }
  }
  for (const invoice of invoices) {
    for (const draw of invoice.advanceDraws || []) {
      const advance = advances.get(refKey(invoice.customerId, draw.billReference));
      if (!advance || advance.payment.receiptDate > invoice.voucherDate) continue;
      advance.total = advance.total.plus(draw.allocatedAmount);
      advance.draws.push({ invoice, draw });
    }
  }
  for (const advance of advances.values()) {
    if (!advance || advance.total.gt(advance.payment.allocatedAmount)) continue;
    for (const { invoice, draw } of advance.draws) {
      append(invoice, { ...advance.payment, allocationKey: draw.allocationKey, allocatedAmount: draw.allocatedAmount,
        allocationType: "agst_ref", targetVoucherGuid: invoice.tallyGuid });
    }
  }
  return payments;
}
