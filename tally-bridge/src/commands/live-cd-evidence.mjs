import { createHash } from "node:crypto";
import Decimal from "decimal.js";

import { syncVouchers } from "./sync-vouchers.mjs";
import { sourceSalesLedgerName } from "./voucher-ledgers.mjs";

const MAX_CHUNKS = 60;
const MAX_INVOICES = 10_000;

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

function selectedCustomers(scope, masterResult) {
  if (Array.isArray(scope.customers) && scope.customers.length) {
    return scope.customers
      .map((customer) => ({ customerId: customer?.customerId, ledgerName: String(customer?.ledgerName ?? "").trim() }))
      .filter((customer) => customer.customerId && customer.ledgerName);
  }
  const masters = masterResult?.masters ?? {};
  const groups = Array.isArray(masters.customerGroups) ? masters.customerGroups : [];
  const customers = Array.isArray(masters.customers) ? masters.customers : [];
  const selected = Array.isArray(scope.groups) ? scope.groups : [];
  const groupsByGuid = new Map(groups.map((group) => [normalized(group.guid), group]));
  const groupsByName = new Map(groups.map((group) => [normalized(group.name), group]));
  const selectedKeys = new Set(selected.flatMap((group) => [normalized(group?.tallyGuid), normalized(group?.name)]).filter(Boolean));
  function covered(customer) {
    const visited = new Set();
    let group = groupsByGuid.get(normalized(customer.customerGroupGuid))
      ?? groupsByName.get(normalized(customer.sourcePayload?.customerGroupName));
    while (group && !visited.has(normalized(group.guid || group.name))) {
      const key = normalized(group.guid || group.name);
      visited.add(key);
      if (selectedKeys.has(normalized(group.guid)) || selectedKeys.has(normalized(group.name))) return true;
      group = groupsByGuid.get(normalized(group.parentGuid))
        ?? groupsByName.get(normalized(group.sourcePayload?.parentName));
    }
    return false;
  }
  return customers.filter(covered).map((customer) => ({
    customerId: customer.guid,
    ledgerName: customer.ledgerName,
  }));
}

export async function fetchLiveCdEvidence(command, context, masterResult) {
  const scope = command.payload?.voucherScope && typeof command.payload.voucherScope === "object" ? command.payload.voucherScope : {};
  const eligibleCustomers = selectedCustomers(scope, masterResult);
  const customers = new Map(eligibleCustomers.map((row) => [normalized(row.ledgerName), row]));
  if (!scope.dateFrom || !scope.dateTo || !customers.size) throw new Error("Live Cash Discount evidence requires eligible customers and a bounded date range.");
  const invoices = [];
  const allocations = [];
  const debitNotes = [];
  let cursor = scope.dateFrom;
  let chunks = 0;
  let vouchersScanned = 0;
  while (cursor) {
    if (context.isCancelled?.()) throw new Error("This Cash Discount check was stopped.");
    if (chunks >= MAX_CHUNKS) throw new Error("The Cash Discount period is too large for one live calculation.");
    const result = await syncVouchers({ ...command, payload: { ...command.payload, syncRunId: command.payload.voucherSyncRunId, requestedScope: { ...scope, customers: eligibleCustomers, cursor } } }, context);
    chunks += 1;
    vouchersScanned += result.vouchers.length;
    for (const voucher of result.vouchers) {
      const customer = customers.get(normalized(voucher.partyLedgerName));
      if (customer && voucher.voucherKind === "sales" && voucher.status === "posted") {
        // Cash Discount invoices are already net of the granted discount.
        // Match Finora: calculate recovery from the live net bill amount,
        // without inventory valuation or stock-master dependencies.
        const grossAmount = new Decimal(voucher.grossAmount || 0).abs();
        const billReferences = voucher.billAllocations
          .filter((allocation) => allocation.allocationType === "new_ref")
          .map((allocation) => allocation.billReference)
          .filter(Boolean);
        invoices.push({ customerId: customer.customerId, customerLedgerName: customer.ledgerName, sourceSalesLedgerName: sourceSalesLedgerName(voucher), tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, billReferences, voucherDate: voucher.voucherDate, grossAmount: grossAmount.toFixed(), eligibleValue: grossAmount.toFixed(), narration: voucher.narration || "", inventoryLineCount: 0 });
        if (invoices.length > MAX_INVOICES) throw new Error("The Cash Discount calculation found too many Sales invoices. Shorten the active rule period.");
      }
      // Tally can carry an against-reference settlement in either a Receipt
      // or Payment voucher (for example after a reversal/correction). Finora
      // reads both, so the direct path must do the same.
      if (["receipt", "payment"].includes(voucher.voucherKind) && voucher.status === "posted") {
        for (const allocation of voucher.billAllocations) allocations.push({ receiptGuid: voucher.guid, receiptNumber: voucher.voucherNumber || null, receiptDate: voucher.voucherDate, billReference: allocation.billReference || null, targetVoucherGuid: allocation.targetVoucherGuid || null, allocationType: allocation.allocationType, allocatedAmount: allocation.allocatedAmount });
      }
      if (customer && voucher.voucherKind === "debit_note") {
        const amount = new Decimal(voucher.grossAmount || 0).abs().toFixed();
        for (const allocation of voucher.billAllocations.length ? voucher.billAllocations : [{ billReference: null, targetVoucherGuid: null }]) {
          debitNotes.push({
            tallyGuid: voucher.guid,
            voucherNumber: voucher.voucherNumber || null,
            voucherDate: voucher.voucherDate,
            customerLedgerName: customer.ledgerName,
            status: voucher.status,
            billReference: allocation.billReference || null,
            targetVoucherGuid: allocation.targetVoucherGuid || null,
            amount,
            narration: voucher.narration || "",
          });
        }
      }
    }
    cursor = result.cursorTo;
  }
  const paymentsByReference = new Map();
  for (const allocation of allocations) {
    if (allocation.allocationType !== "agst_ref") continue;
    const keys = [allocation.targetVoucherGuid, allocation.billReference].map(normalized).filter(Boolean);
    for (const key of keys) {
      const payments = paymentsByReference.get(key) ?? [];
      payments.push(allocation);
      paymentsByReference.set(key, payments);
    }
  }
  const invoiceResults = invoices.map((invoice) => ({
    ...invoice,
    payments: [...new Map(
      [invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])]
        .flatMap((reference) => paymentsByReference.get(normalized(reference)) ?? [])
        .map((payment) => [`${payment.receiptGuid}:${payment.billReference}:${payment.allocatedAmount}`, payment]),
    ).values()],
    debitNotes: debitNotes.filter((note) => {
      if (normalized(note.customerLedgerName) !== normalized(invoice.customerLedgerName)) return false;
      const references = new Set([invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean));
      return references.has(normalized(note.targetVoucherGuid)) || references.has(normalized(note.billReference)) || note.narration.includes(invoice.tallyGuid);
    }),
  }));
  const sourceFingerprint = createHash("sha256").update(canonicalJson(invoiceResults)).digest("hex");
  return { mode: "live_cd_batch", evaluationRunId: command.payload.evaluationRunId ?? null, ruleVersionId: scope.ruleVersionId ?? null, dateFrom: scope.dateFrom, dateTo: scope.dateTo, chunks, vouchersScanned, invoices: invoiceResults, sourceFingerprint };
}
