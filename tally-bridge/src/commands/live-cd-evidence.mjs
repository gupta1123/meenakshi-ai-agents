import { advanceDraws, matchPayments, paymentWindowStart, settlementAllocations } from "./payment-matching.mjs";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {BRIDGE_VERSION} from "../version.mjs";

import { syncVouchers } from "./sync-vouchers.mjs";
import { readContinuationAllocations } from "./continuation.mjs";
import { buildCollectionExportXml, extractBlocks, getAttribute, getTagText, postTallyXml } from "../tally/xml.mjs";
import { sourceSalesLedgerName } from "./voucher-ledgers.mjs";
import { CREDIT_NOTE_MATCHING_VERSION, allocationCustomer, creditNoteEvidence, creditNotePurpose, customerForVoucher, matchCreditNotes } from "./credit-note-matching.mjs";

const MAX_CHUNKS = 400;
const MAX_INVOICES = 25_000;

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function tallyString(value) { return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
// Vouchers whose "On Account" part belongs to the customer's own ledger.
const ON_ACCOUNT_KINDS = new Set(["receipt", "payment", "sales", "sales_return", "credit_note", "debit_note"]);
const OPENING_LEDGER_BATCH = 25;

/**
 * Each customer's opening "On Account" balance (ledger opening less its
 * opening bills): + is credit the customer holds with us, − is a debit.
 * Tally XML gives credit as a positive amount and debit as a negative one.
 * One small Ledger request per batch of customers.
 */
async function openingOnAccount(customers, context) {
  const balances = new Map();
  for (let index = 0; index < customers.length; index += OPENING_LEDGER_BATCH) {
    if (context.isCancelled?.()) throw new Error("This Cash Discount check was stopped.");
    const batch = customers.slice(index, index + OPENING_LEDGER_BATCH);
    const xml = buildCollectionExportXml({
      collectionName: "Meenakshi Opening Bills",
      tallyType: "Ledger",
      fetchFields: "Name,OpeningBalance,BillAllocations.Name,BillAllocations.OpeningBalance",
      companyName: context.activeCompany?.name,
      formulae: [{ name: "MeenakshiOpeningLedger", formula: batch.map((customer) => `($$IsEqual:$Name:${tallyString(customer.ledgerName)})`).join(" OR ") }],
      filterNames: ["MeenakshiOpeningLedger"],
    });
    const response = await postTallyXml(context.config.tallyUrl, xml, { timeoutMs: 45_000, operation: "Read customer opening balances" });
    for (const ledgerXml of extractBlocks(response, "LEDGER")) {
      const name = getAttribute(ledgerXml.slice(0, ledgerXml.indexOf(">") + 1), "NAME") || getTagText(extractBlocks(ledgerXml, "NAME.LIST")[0] ?? "", "NAME");
      const amountOf = (xml) => new Decimal(String(getTagText(xml, "OPENINGBALANCE") ?? "").replace(/[^0-9.-]/g, "") || 0);
      const bills = extractBlocks(ledgerXml, "BILLALLOCATIONS.LIST");
      let withoutBills = ledgerXml;
      for (const bill of bills) withoutBills = withoutBills.replace(bill, "");
      const opening = amountOf(withoutBills);
      const billTotal = bills.reduce((total, bill) => total.plus(amountOf(bill)), new Decimal(0));
      balances.set(normalized(name), opening.minus(billTotal));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return balances;
}
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

function selectedCustomers(scope, masterResult) {
  if (Array.isArray(scope.customers) && scope.customers.length) {
    return scope.customers
      .map((customer) => ({ customerId: customer?.customerId, tallyLedgerGuid: customer?.tallyLedgerGuid || customer?.customerId, ledgerName: String(customer?.ledgerName ?? "").trim() }))
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
    tallyLedgerGuid: customer.guid,
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
  // On-account credit (+) and debit (−) per customer: money not set against any bill.
  const onAccount = [];
  const readFrom = paymentWindowStart(scope.dateFrom);
  let cursor = readFrom;
  let chunks = 0;
  let vouchersScanned = 0;
  // Resume after a crash or restart: the checkpoint holds everything read so far.
  const checkpoint = context.checkpoint ?? null;
  const saved = checkpoint?.load() ?? null;
  const crashes = new Map(Object.entries(saved?.crashes ?? {}));
  if (saved) {
    invoices.push(...saved.invoices); allocations.push(...saved.allocations); debitNotes.push(...saved.debitNotes); creditNotes.push(...saved.creditNotes); onAccount.push(...(saved.onAccount ?? []));
    cursor = saved.cursor; chunks = saved.chunks; vouchersScanned = saved.vouchersScanned;
    // A window that was being read when the connector last stopped is retried in smaller pieces.
    if (saved.inFlight) crashes.set(saved.inFlight, (crashes.get(saved.inFlight) ?? 0) + 1);
    context.onResume?.({ cursor, chunks, invoices: invoices.length, retriedWindow: saved.inFlight ?? null });
  }
  const requestedDays = Math.max(1,Math.min(10,Number(scope.chunkDays)||10));
  const windowDays = (at) => { const n = crashes.get(at) ?? 0; return n === 0 ? requestedDays : n === 1 ? Math.min(requestedDays,3) : n === 2 ? 1 : 0; };
  const persist = (inFlight) => checkpoint?.save({ cursor, chunks, vouchersScanned, invoices, allocations, debitNotes, creditNotes, onAccount, crashes: Object.fromEntries(crashes), inFlight });
  // Batches are 10 days (see sync-vouchers.mjs); report progress per batch.
  const totalChunks = Math.max(1, Math.ceil(((Date.parse(`${scope.dateTo}T00:00:00Z`) - Date.parse(`${scope.dateFrom}T00:00:00Z`)) / 86_400_000 + 1) / requestedDays));
  context.onProgress?.({ done: 0, total: totalChunks, from: scope.dateFrom, to: scope.dateTo });
  while (cursor) {
    if (context.isCancelled?.()) throw new Error("This Cash Discount check was stopped.");
    if (chunks >= MAX_CHUNKS) throw new Error("The Cash Discount period is too large for one live calculation.");
    const days = windowDays(cursor);
    if (days === 0) throw new Error(`Tally could not give the data for ${cursor} even one day at a time, and the connector stopped each time it tried. Ask support to look at that day in Tally.`);
    await context.betweenWindows?.(); // server mode: lets a waiting Credit Note run between read windows
    persist(cursor); // marks this window as "being read": if the connector dies now, the next try uses a smaller window
    const result = await syncVouchers({ ...command, payload: { ...command.payload, syncRunId: command.payload.voucherSyncRunId, requestedScope: { ...scope, dateFrom: readFrom, customers: eligibleCustomers, cursor, chunkDays: days } } }, context);
    chunks += 1;
    vouchersScanned += result.vouchers.length;
    context.onProgress?.({ done: chunks, total: Math.max(totalChunks, chunks), nextDate: result.cursorTo ?? null, vouchersScanned });
    for (const voucher of result.vouchers) {
      const customer = customerForVoucher(voucher, eligibleCustomers);
      allocations.push(...settlementAllocations(voucher, eligibleCustomers, perMt));
      if (voucher.voucherDate < scope.dateFrom) continue;
      // Only invoices dated within the rule (up to its end date) are checked.
      const invoiceInRule = !scope.invoiceDateTo || String(voucher.voucherDate ?? "").slice(0, 10) <= scope.invoiceDateTo;
      if (customer && voucher.voucherKind === "sales" && voucher.status === "posted" && invoiceInRule) {
        // Cash Discount invoices are already net of the granted discount.
        // Match Finora: calculate recovery from the live net bill amount,
        // without inventory valuation or stock-master dependencies.
        const grossAmount = new Decimal(voucher.grossAmount || 0).abs();
        const billReferences = voucher.billAllocations
          .filter((allocation) => allocation.allocationType === "new_ref" && allocationCustomer(allocation, voucher, eligibleCustomers)?.customerId === customer.customerId)
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
        // A per-MT rule pays only on eligible product tonnes: an invoice with no
        // eligible line (and no unit problem to report) can never earn it.
        if (perMt && eligibleTonnes.lte(0) && missingUnits.size === 0) continue;
        invoices.push({ customerId: customer.customerId, customerLedgerName: customer.ledgerName, sourceSalesLedgerName: sourceSalesLedgerName(voucher), tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, billReferences, advanceDraws: advanceDraws(voucher, customer.customerId, eligibleCustomers), voucherDate: voucher.voucherDate, grossAmount: grossAmount.toFixed(), eligibleValue: grossAmount.toFixed(), narration: voucher.narration || "", inventoryLineCount: 0, ...(perMt ? { eligibleTonnes: eligibleTonnes.toFixed(), missingUnits: [...missingUnits].sort(), productLines } : {}) });
        if (invoices.length > MAX_INVOICES) throw new Error("The Cash Discount calculation found too many Sales invoices. Set an earlier end date on the Cash Discount rule, or start it later.");
      }
      // Tally can carry an against-reference settlement in either a Receipt
      // or Payment voucher (for example after a reversal/correction). Finora
      // reads both, so the direct path must do the same.
      if (perMt && ["credit_note", "sales_return"].includes(voucher.voucherKind) && voucher.status === "posted") {
        creditNotes.push(creditNoteEvidence(voucher));
      }
      if (perMt && customer && voucher.status === "posted" && ON_ACCOUNT_KINDS.has(voucher.voucherKind)) {
        for (const allocation of voucher.billAllocations) {
          if (allocation.allocationType !== "on_account") continue;
          if (perMt && voucher.voucherKind === "credit_note" && creditNotePurpose(voucher) !== "adjustment") continue;
          if (allocationCustomer(allocation, voucher, eligibleCustomers)?.customerId !== customer.customerId) continue;
          const amount = new Decimal(allocation.allocatedAmount || 0).abs();
          const debit = String(allocation.sourcePayload?.rawAmount ?? "").trim().startsWith("-");
          onAccount.push({ customerId: customer.customerId, date: voucher.voucherDate, amount: (debit ? amount.neg() : amount).toFixed(), source: `${voucher.voucherTypeName || voucher.voucherKind} ${voucher.voucherNumber || ""}`.trim() });
        }
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
    persist(null);
  }
  // Receipts for this year's invoices posted in the next year's company (see continuation.mjs).
  const continued = await readContinuationAllocations({
    command, scope, context, customers: eligibleCustomers, includeJournals: perMt,
    makeScope: ({ cursor: at, dateFrom, dateTo, chunkDays }) => ({ ...scope, dateFrom, dateTo, customers: eligibleCustomers, cursor: at, chunkDays }),
  });
  allocations.push(...continued.allocations);
  const unresolvedInvoices = new Set();
  const paymentsByInvoice = matchPayments(invoices, allocations, unresolvedInvoices);
  const notesByInvoice = perMt ? matchCreditNotes(invoices, creditNotes, eligibleCustomers) : new Map();
  const invoiceResults = invoices.map(({ advanceDraws: _draws, ...invoice }) => ({
    ...invoice,
    ...(unresolvedInvoices.has(invoice.tallyGuid) ? { paymentMatchNeedsReview: true } : {}),
    payments: [...new Map(
      (paymentsByInvoice.get(invoice.tallyGuid) ?? [])
        .map((payment) => [payment.allocationKey || `${payment.receiptGuid}:${payment.billReference}:${payment.allocatedAmount}`, payment]),
    ).values()],
    debitNotes: debitNotes.filter((note) => {
      if (normalized(note.customerLedgerName) !== normalized(invoice.customerLedgerName)) return false;
      const references = new Set([invoice.tallyGuid, invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean));
      // GST Debit Notes are On Account; they name the invoice in the narration.
      return references.has(normalized(note.targetVoucherGuid)) || references.has(normalized(note.billReference)) || note.narration.includes(invoice.tallyGuid)
        || Boolean(invoice.voucherNumber && note.narration.includes(`Inv No. ${invoice.voucherNumber} `));
    }),
    ...(perMt ? { creditNotes: notesByInvoice.get(invoice.tallyGuid) ?? [] } : {}),
  }));
  // The ledger opening is the balance on the first day of the books (1 April),
  // so it only applies when the check starts then. Read it only for customers
  // with an invoice that payments alone did not clear.
  const customerCredits = [...onAccount];
  if (perMt && /-04-01$/.test(scope.dateFrom)) {
    const short = new Set(invoiceResults.filter((invoice) => invoice.payments
      .filter((payment) => payment.allocationType === "agst_ref")
      .reduce((total, payment) => total.plus(new Decimal(payment.allocatedAmount || 0).abs()), new Decimal(0))
      .lt(new Decimal(invoice.grossAmount).minus(1))).map((invoice) => invoice.customerId));
    const needed = eligibleCustomers.filter((customer) => short.has(customer.customerId));
    if(needed.length)await context.betweenWindows?.();
    const openings = needed.length ? await openingOnAccount(needed, context) : new Map();
    for (const customer of needed) {
      const balance = openings.get(normalized(customer.ledgerName));
      if (balance && !balance.isZero()) customerCredits.push({ customerId: customer.customerId, date: scope.dateFrom, amount: balance.toFixed(), source: "Opening on-account balance" });
    }
  }
  const sourceFingerprint = createHash("sha256").update(canonicalJson(customerCredits.length ? { invoices: invoiceResults, customerCredits } : invoiceResults)).digest("hex");
  return { mode: "live_cd_batch", connectorVersion:BRIDGE_VERSION, customerScope:scope.customerScope??null, creditNoteMatchingVersion: CREDIT_NOTE_MATCHING_VERSION, evaluationRunId: command.payload.evaluationRunId ?? null, ruleVersionId: scope.ruleVersionId ?? null, dateFrom: scope.dateFrom, dateTo: scope.dateTo, chunks, vouchersScanned, invoices: invoiceResults, customerCredits, ...(continued.status === "none" ? {} : { continuation: { status: continued.status, dateFrom: continued.dateFrom, dateTo: continued.dateTo, chunks: continued.chunks ?? 0, vouchersScanned: continued.vouchersScanned ?? 0 } }), sourceFingerprint };
}
