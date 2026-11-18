import Decimal from "decimal.js";

export const CREDIT_NOTE_MATCHING_VERSION = 1;
export const normalized = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const cashDiscount = /\bcash\s*discount\b|\bc\s*\.?\s*d\.?\b/i;
const otherDiscount = /\b(?:turnover|trade|quantity)\s*discount\b|\b(?:tod|rate\s*(?:diff(?:erence)?|adjustment)|price\s*(?:diff(?:erence)?|adjustment)|rebate)\b/i;
const identity = (guid, name, customer) => guid && customer.tallyLedgerGuid
  ? normalized(guid) === normalized(customer.tallyLedgerGuid)
  : Boolean(name && normalized(name) === normalized(customer.ledgerName));

export function customerForVoucher(voucher, customers) {
  const direct = customers.filter((customer) => identity(voucher.partyLedgerGuid, voucher.partyLedgerName, customer));
  if (direct.length === 1) return direct[0];
  // A known party header must not be replaced by a different ledger in the voucher.
  if (voucher.partyLedgerName || voucher.partyLedgerGuid) return null;
  const found = customers.filter((customer) => (voucher.sourcePayload?.ledgerEntries ?? []).some((entry) => identity(entry.ledgerGuid, entry.ledgerName, customer)));
  return found.length === 1 ? found[0] : null;
}

export function allocationCustomer(allocation, voucher, customers) {
  if (allocation.ledgerGuid || allocation.ledgerName) {
    const found = customers.filter((customer) => identity(allocation.ledgerGuid, allocation.ledgerName, customer));
    return found.length === 1 ? found[0] : null;
  }
  return customerForVoucher(voucher, customers);
}

/** Keep only the fields needed to resume/link a note, not raw XML or inventory. */
export function creditNoteEvidence(voucher) {
  return { guid: voucher.guid, voucherNumber: voucher.voucherNumber, voucherDate: voucher.voucherDate, voucherKind: voucher.voucherKind, status: voucher.status, partyLedgerName: voucher.partyLedgerName, partyLedgerGuid: voucher.partyLedgerGuid, grossAmount: voucher.grossAmount, narration: voucher.narration, billAllocations: voucher.billAllocations, sourcePayload: { ledgerEntries: voucher.sourcePayload?.ledgerEntries ?? [] } };
}

export function creditNotePurpose(note) {
  if (note.voucherKind === "sales_return") return "sales_return";
  // Only the debit/expense side identifies the discount purpose. A customer's
  // name (for example "CD Traders") is not evidence of Cash Discount.
  const words = [note.narration, ...(note.sourcePayload?.ledgerEntries ?? []).filter((entry) => new Decimal(entry.amount || 0).lt(0)).map((entry) => entry.ledgerName)].join(" ");
  const cd = cashDiscount.test(words), other = otherDiscount.test(words);
  return cd && !other ? "cash_discount" : other && !cd ? "adjustment" : "unclear";
}

function containsReference(text, reference) {
  const escaped = String(reference).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A complete identifier, never INV/1 matching INV/10 or INV/1/2027.
  return reference && new RegExp(`(^|[^a-z0-9/\\-])${escaped}(?=$|[^a-z0-9/\\-])`, "i").test(text);
}

/** Customer-scoped bill references; a target GUID is authoritative if present. */
export function invoiceMatcher(invoices) {
  const guids = new Map(invoices.map((invoice) => [normalized(invoice.tallyGuid), invoice]));
  const byReference = new Map();
  for (const invoice of invoices) for (const reference of new Set([invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean))) {
    const key = `${invoice.customerId}|${reference}`;
    byReference.set(key, [...(byReference.get(key) ?? []), invoice]);
  }
  return (allocation, customer) => {
    if (!customer) return [];
    if (allocation.targetVoucherGuid) {
      const invoice = guids.get(normalized(allocation.targetVoucherGuid));
      return invoice?.customerId === customer.customerId ? [invoice] : [];
    }
    // Tally's BillAllocations.VoucherNumber can be the *source* receipt/note
    // number. Only NAME (the bill reference) identifies the target invoice.
    return byReference.get(`${customer.customerId}|${normalized(allocation.billReference)}`) ?? [];
  };
}

/** Actual per-invoice allocations win. Narration is only an unambiguous fallback. */
export function matchCreditNotes(invoices, notes, customers) {
  const matchInvoice = invoiceMatcher(invoices);
  const result = new Map(invoices.map((invoice) => [invoice.tallyGuid, []]));
  const byCustomer = new Map();
  for (const invoice of invoices) byCustomer.set(invoice.customerId, [...(byCustomer.get(invoice.customerId) ?? []), invoice]);
  const seen = new Set();
  for (const note of notes) {
    if (!note.guid || seen.has(note.guid) || note.status !== "posted") continue;
    seen.add(note.guid);
    const purpose = creditNotePurpose(note);
    const matched = new Map();
    const add = (invoice, amount, matchedBy, reviewReason = null) => {
      const current = matched.get(invoice.tallyGuid);
      matched.set(invoice.tallyGuid, { invoice, amount: new Decimal(current?.amount ?? 0).plus(amount).toFixed(), matchedBy, reviewReason: reviewReason || current?.reviewReason || null });
    };
    const allocations = (note.billAllocations ?? []).filter((allocation) => allocation.allocationType === "agst_ref");
    for (const allocation of allocations) {
      const customer = allocationCustomer(allocation, note, customers);
      const matches = matchInvoice(allocation, customer);
      const amount = new Decimal(allocation.allocatedAmount || 0).abs();
      const negative = String(allocation.sourcePayload?.rawAmount ?? "").startsWith("-");
      for (const invoice of matches) {
        const early = note.voucherDate < invoice.voucherDate;
        add(invoice, matches.length === 1 && !negative && !early ? amount : 0, allocation.targetVoucherGuid ? "invoice_guid" : "bill_reference", early ? "Credit Note is dated before the linked invoice; review the adjustment." : matches.length > 1 ? "Bill reference identifies more than one invoice." : negative ? "Credit Note reverses a customer credit; review its allocation." : null);
      }
    }
    if (!allocations.length && purpose === "cash_discount") {
      const customer = customerForVoucher(note, customers);
      const possible = (byCustomer.get(customer?.customerId) ?? []).filter((invoice) => invoice.voucherDate <= note.voucherDate);
      const matches = possible.filter((invoice) => [invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])].some((ref) => containsReference(note.narration ?? "", ref)));
      if (matches.length === 1) {
        const entries = (note.sourcePayload?.ledgerEntries ?? []).filter((entry) => identity(entry.ledgerGuid, entry.ledgerName, customer));
        const amount = entries.length ? entries.reduce((total, entry) => total.plus(entry.amount || 0), new Decimal(0)) : new Decimal(note.grossAmount || 0).abs();
        add(matches[0], amount.gt(0) ? amount : 0, "narration", amount.gt(0) ? null : "Credit Note has no customer credit amount.");
      } else for (const invoice of matches.length ? matches : possible) add(invoice, 0, "unresolved", matches.length ? "Credit Note names more than one invoice without bill allocations." : "Cash Discount Credit Note has no clear invoice link.");
    }
    const total = [...matched.values()].reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    const customerCredits = (note.sourcePayload?.ledgerEntries ?? []).reduce((sum, entry) => sum.plus(Decimal.max(new Decimal(entry.amount || 0), 0)), new Decimal(0));
    const excessive = total.gt(Decimal.max(new Decimal(note.grossAmount || 0).abs(), customerCredits).plus("0.01"));
    for (const { invoice, amount, matchedBy, reviewReason } of matched.values()) result.get(invoice.tallyGuid).push({ tallyGuid: note.guid, voucherNumber: note.voucherNumber || null, voucherDate: note.voucherDate, amount: excessive ? "0" : amount, noteAmount: Decimal.max(new Decimal(note.grossAmount || 0).abs(), customerCredits).toFixed(), purpose, matchedBy, reviewReason: reviewReason || (excessive ? "Credit Note allocations exceed its total." : purpose === "unclear" ? "Check whether this Credit Note is Cash Discount or another adjustment." : purpose === "sales_return" ? "Sales return affects this invoice; review the eligible quantity before giving Cash Discount." : null) });
  }
  return result;
}
