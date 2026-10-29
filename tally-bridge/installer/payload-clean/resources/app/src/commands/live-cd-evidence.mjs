import { createHash } from "node:crypto";
import Decimal from "decimal.js";

import { syncVouchers } from "./sync-vouchers.mjs";
import { sourceSalesLedgerName } from "./voucher-ledgers.mjs";
import { indexCdInvoiceReferences, isMatchedCdNewRefReceipt } from "../local-cd-settlement-evaluator.mjs";
import { matchCdCreditNote } from "./cd-credit-note-matching.mjs";

const MAX_CHUNKS = 60;
const MAX_INVOICES = 25_000;

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
  // Per-MT Cash Discount (docs/CD_LOGIC.md): MT of eligible products per
  // invoice, Journal settlements (e.g. TDS) and existing CD Credit Notes.
  const perMt = scope.cdDiscountBasis === "amount_per_tonne";
  const eligibleGuids = new Set((scope.eligibleStockItemGuids ?? []).map(normalized).filter(Boolean));
  const eligibleNames = new Set((scope.eligibleStockItemNames ?? []).map(normalized).filter(Boolean));
  const conversions = new Map((scope.unitConversions ?? []).map((item) => [normalized(item?.uomCode), new Decimal(String(item?.tonnesPerUnit ?? "0"))]));
  const creditNotes = [];
  const settlesBills = (voucher) => ["receipt", "payment"].includes(voucher.voucherKind)
    || (perMt && voucher.voucherKind === "other" && /journal|payment/i.test(String(voucher.voucherTypeName ?? "")));
  let cursor = scope.dateFrom;
  let chunks = 0;
  // Batches are 10 days (see sync-vouchers.mjs); report progress per batch.
  const totalChunks = Math.max(1, Math.ceil(((Date.parse(`${scope.dateTo}T00:00:00Z`) - Date.parse(`${scope.dateFrom}T00:00:00Z`)) / 86_400_000 + 1) / 10));
  context.onProgress?.({ done: 0, total: totalChunks, from: scope.dateFrom, to: scope.dateTo });
  let vouchersScanned = 0;
  while (cursor) {
    if (context.isCancelled?.()) throw new Error("This Cash Discount check was stopped.");
    if (chunks >= MAX_CHUNKS) throw new Error("The Cash Discount period is too large for one live calculation.");
    const result = await syncVouchers({ ...command, payload: { ...command.payload, syncRunId: command.payload.voucherSyncRunId, requestedScope: { ...scope, customers: eligibleCustomers, cursor } } }, context);
    chunks += 1;
    vouchersScanned += result.vouchers.length;
    context.onProgress?.({ done: chunks, total: Math.max(totalChunks, chunks), nextDate: result.cursorTo ?? null, vouchersScanned });
    for (const voucher of result.vouchers) {
      const customer = customers.get(normalized(voucher.partyLedgerName));
      // Only invoices dated within the rule (up to its end date) are checked.
      const invoiceInRule = !scope.invoiceDateTo || String(voucher.voucherDate ?? "").slice(0, 10) <= scope.invoiceDateTo;
      if (customer && voucher.voucherKind === "sales" && voucher.status === "posted" && invoiceInRule) {
        // Cash Discount invoices are already net of the granted discount.
        // Match Finora: calculate recovery from the live net bill amount,
        // without inventory valuation or stock-master dependencies.
        const grossAmount = new Decimal(voucher.grossAmount || 0).abs();
        const billReferences = voucher.billAllocations
          .filter((allocation) => allocation.allocationType === "new_ref" || (perMt && allocation.allocationType === "agst_ref"))
          .filter((allocation) => !allocation.sourcePayload?.ledgerName
            || normalized(allocation.sourcePayload.ledgerName) === normalized(customer.ledgerName))
          .map((allocation) => allocation.billReference)
          .filter(Boolean);
        let eligibleTonnes = new Decimal(0);
        const missingUnits = new Set();
        const productLines = [];
        if (perMt) {
          for (const line of voucher.inventoryLines ?? []) {
            const selected = eligibleGuids.has(normalized(line.stockItemGuid)) || eligibleNames.has(normalized(line.stockItemName));
            if (!selected || line.lineCategory !== "inventory") continue;
            const conversion = conversions.get(normalized(line.uomCode));
            if (!line.quantityIsReliable || !conversion || conversion.lte(0)) { missingUnits.add(line.uomCode || "Unknown unit"); continue; }
            const lineTonnes = new Decimal(line.quantity).abs().mul(conversion);
            eligibleTonnes = eligibleTonnes.plus(lineTonnes);
            productLines.push({ name: line.stockItemName || "Stock item", quantity: new Decimal(line.quantity).abs().toFixed(), unit: line.uomCode || "", tonnes: lineTonnes.toDecimalPlaces(6).toFixed() });
          }
        }
        // Retain zero-eligible-tonne invoices in evidence for reference
        // ambiguity checks. The evaluator still skips them for discounts.
        invoices.push({ customerId: customer.customerId, customerLedgerName: customer.ledgerName, sourceSalesLedgerName: sourceSalesLedgerName(voucher), tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, billReferences, voucherDate: voucher.voucherDate, grossAmount: grossAmount.toFixed(), eligibleValue: grossAmount.toFixed(), narration: voucher.narration || "", inventoryLineCount: 0, ...(perMt ? { eligibleTonnes: eligibleTonnes.toFixed(), missingUnits: [...missingUnits].sort(), productLines } : {}) });
        if (invoices.length > MAX_INVOICES) throw new Error("The Cash Discount calculation found too many Sales invoices. Set an earlier end date on the Cash Discount rule, or start it later.");
      }
      // Tally can carry an against-reference settlement in either a Receipt
      // or Payment voucher (for example after a reversal/correction). Finora
      // reads both, so the direct path must do the same.
      if (perMt && customer && voucher.voucherKind === "credit_note" && voucher.status === "posted") {
        creditNotes.push({ tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, voucherDate: voucher.voucherDate, customerLedgerName: customer.ledgerName, amount: new Decimal(voucher.grossAmount || 0).abs().toFixed(), narration: voucher.narration || "" });
      }
      if (settlesBills(voucher) && voucher.status === "posted") {
        for (const allocation of voucher.billAllocations) allocations.push({
          receiptGuid: voucher.guid, receiptNumber: voucher.voucherNumber || null,
          receiptType: voucher.voucherTypeName || null, receiptKind: voucher.voucherKind,
          receiptDate: voucher.voucherDate, allocationKey: allocation.allocationKey,
          billReference: allocation.billReference || null, targetVoucherGuid: allocation.targetVoucherGuid || null,
          allocationType: allocation.allocationType, allocatedAmount: allocation.allocatedAmount,
          customerLedgerName: allocation.sourcePayload?.ledgerName ?? null,
          rawAllocatedAmount: allocation.sourcePayload?.rawAmount ?? null,
          ledgerIsDeemedPositive: allocation.sourcePayload?.ledgerIsDeemedPositive ?? null,
        });
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
  const referenceOwners = indexCdInvoiceReferences(invoices);
  for (const allocation of allocations) {
    if (allocation.allocationType !== "agst_ref" && !(perMt && allocation.allocationType === "new_ref")) continue;
    const keys = [allocation.targetVoucherGuid, allocation.billReference].map(normalized).filter(Boolean);
    for (const key of keys) {
      const payments = paymentsByReference.get(key) ?? [];
      payments.push(allocation);
      paymentsByReference.set(key, payments);
    }
  }
  const creditNoteOwners = new Map(creditNotes.map((note) => [note.tallyGuid, matchCdCreditNote(note, invoices)]));
  const invoiceResults = invoices.map((invoice) => ({
    ...invoice,
    payments: [...new Map(
      [invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])]
        .flatMap((reference) => paymentsByReference.get(normalized(reference)) ?? [])
        .filter((payment) => payment.allocationType === "agst_ref" || isMatchedCdNewRefReceipt(invoice, payment, referenceOwners))
        .map((payment) => [payment.allocationKey || `${payment.receiptGuid}:${payment.billReference}:${payment.allocatedAmount}`, payment]),
    ).values()],
    debitNotes: debitNotes.filter((note) => {
      if (normalized(note.customerLedgerName) !== normalized(invoice.customerLedgerName)) return false;
      const references = new Set([invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean));
      // GST Debit Notes are On Account; they name the invoice in the narration.
      return references.has(normalized(note.targetVoucherGuid)) || references.has(normalized(note.billReference)) || note.narration.includes(invoice.tallyGuid)
        || Boolean(invoice.voucherNumber && note.narration.includes(`Inv No. ${invoice.voucherNumber} `));
    }),
    ...(perMt ? { creditNotes: creditNotes.filter((note) => creditNoteOwners.get(note.tallyGuid) === invoice.tallyGuid) } : {}),
  }));
  const sourceFingerprint = createHash("sha256").update(canonicalJson(invoiceResults)).digest("hex");
  return { mode: "live_cd_batch", evaluationRunId: command.payload.evaluationRunId ?? null, ruleVersionId: scope.ruleVersionId ?? null, dateFrom: scope.dateFrom, dateTo: scope.dateTo, chunks, vouchersScanned, invoices: invoiceResults, sourceFingerprint };
}
