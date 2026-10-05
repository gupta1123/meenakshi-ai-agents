import { buildCollectionExportXml, postTallyXml } from "../tally/xml.mjs";
import { parseVouchers } from "../tally/vouchers.mjs";

const VOUCHER_FETCH_FIELDS = [
  "Date,EffectiveDate,VoucherTypeName,VoucherType,VoucherTypeGUID,VoucherNumber,GUID,MasterID,AlterID,IsCancelled,IsOptional,IsReversed,PartyLedgerName,PartyLedgerGUID,LinkedSalesVoucherGUID,VoucherAmount,Amount,Narration",
  "AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount,AllLedgerEntries.BillAllocations.TargetVoucherGUID,AllLedgerEntries.BillAllocations.VoucherNumber",
  "AllInventoryEntries.StockItemName,AllInventoryEntries.StockItemGUID,AllInventoryEntries.StockGroup,AllInventoryEntries.StockGroupGUID,AllInventoryEntries.ParentGUID,AllInventoryEntries.ActualQty,AllInventoryEntries.BilledQty,AllInventoryEntries.BaseUnits,AllInventoryEntries.Units,AllInventoryEntries.Amount",
  "InventoryEntries.StockItemName,InventoryEntries.StockItemGUID,InventoryEntries.StockGroup,InventoryEntries.StockGroupGUID,InventoryEntries.ParentGUID,InventoryEntries.ActualQty,InventoryEntries.BilledQty,InventoryEntries.BaseUnits,InventoryEntries.Units,InventoryEntries.Amount",
  "LedgerEntries.LedgerName,LedgerEntries.Amount,LedgerEntries.IsDeemedPositive,LedgerEntries.InventoryAllocations.StockItemName,LedgerEntries.InventoryAllocations.StockItemGUID,LedgerEntries.InventoryAllocations.StockGroup,LedgerEntries.InventoryAllocations.StockGroupGUID,LedgerEntries.InventoryAllocations.ParentGUID,LedgerEntries.InventoryAllocations.ActualQty,LedgerEntries.InventoryAllocations.BilledQty,LedgerEntries.InventoryAllocations.BaseUnits,LedgerEntries.InventoryAllocations.Units,LedgerEntries.InventoryAllocations.Amount",
].join(",");
// Cash Discount only needs invoice/payment/debit-note relationships. Keeping
// inventory and stock metadata out of this live query makes the XML response
// substantially smaller while preserving the fields used by live-cd-evidence.
const CASH_DISCOUNT_FETCH_FIELDS = [
  "Date,EffectiveDate,VoucherTypeName,VoucherType,VoucherTypeGUID,VoucherNumber,GUID,MasterID,AlterID,IsCancelled,IsOptional,IsReversed,PartyLedgerName,PartyLedgerGUID,LinkedSalesVoucherGUID,VoucherAmount,Amount,Narration",
  "AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount,AllLedgerEntries.BillAllocations.TargetVoucherGUID,AllLedgerEntries.BillAllocations.VoucherNumber",
].join(",");
// A per-MT Cash Discount rule needs product quantities, so it adds the
// inventory (and ledger inventory-allocation) fields back.
const CASH_DISCOUNT_PER_MT_FETCH_FIELDS = `${CASH_DISCOUNT_FETCH_FIELDS},${VOUCHER_FETCH_FIELDS.slice(VOUCHER_FETCH_FIELDS.indexOf("AllInventoryEntries."))}`;
// Cash Discount reads a whole rule period. Asking Tally for months at once
// freezes it, so read in short date windows with a pause between them.
const CASH_DISCOUNT_DAYS_PER_CHUNK = 10;
const CASH_DISCOUNT_PAUSE_MS = 400;
const MAX_DAYS_PER_CHUNK = 31;
const TARGETED_DAYS_PER_CHUNK = 92;
const CUSTOMER_BATCH_SIZE = 50;
const TARGETED_CUSTOMER_LIMIT = 250;

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueCustomerLedgerNames(scope) {
  const names = [
    ...(Array.isArray(scope.customers) ? scope.customers.map((customer) => customer?.ledgerName) : []),
    scope.customerLedgerName,
  ].map((name) => String(name ?? "").trim()).filter(Boolean);
  return [...new Map(names.map((name) => [normalized(name), name])).values()];
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function tallyFormulaString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function requestedLedgerFormula(ledgerNames) {
  return ledgerNames
    .map((ledgerName) => `($$IsEqual:$LedgerName:${tallyFormulaString(ledgerName)})`)
    .join(" OR ");
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function chunkScope(scope, maximumDays = MAX_DAYS_PER_CHUNK) {
  if (!scope.dateFrom || !scope.dateTo) return { scope, cursorFrom: null, cursorTo: null };
  const cursorFrom = typeof scope.cursor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(scope.cursor)
    ? scope.cursor
    : scope.dateFrom;
  const maximumEnd = addDays(cursorFrom, maximumDays - 1);
  const dateTo = maximumEnd < scope.dateTo ? maximumEnd : scope.dateTo;
  const cursorTo = dateTo < scope.dateTo ? addDays(dateTo, 1) : null;
  return { scope: { ...scope, dateFrom: cursorFrom, dateTo }, cursorFrom, cursorTo };
}

function matchesScope(voucher, scope) {
  if (scope.customerLedgerName && voucher.partyLedgerName?.toLowerCase() !== String(scope.customerLedgerName).toLowerCase()) return false;
  if (scope.voucherReference) {
    const reference = String(scope.voucherReference).toLowerCase();
    const hasReference = voucher.voucherNumber?.toLowerCase() === reference
      || voucher.billAllocations.some((allocation) => allocation.billReference?.toLowerCase() === reference);
    if (!hasReference) return false;
  }
  const requestedCustomers = uniqueCustomerLedgerNames(scope);
  if (requestedCustomers.length) {
    const requested = new Set(requestedCustomers.map(normalized));
    const voucherLedgers = [
      voucher.partyLedgerName,
      ...(Array.isArray(voucher.sourcePayload?.ledgerEntries) ? voucher.sourcePayload.ledgerEntries.map((entry) => entry.ledgerName) : []),
    ].map(normalized);
    if (!voucherLedgers.some((name) => requested.has(name))) return false;
  }
  return true;
}

async function exportVoucherBatch({ config, activeCompany, chunk, ledgerNames, batchIndex, cashDiscountFastPath, cashDiscountPerMt }) {
  const ledgerEntryFilterName = "MeenakshiRequestedLedger";
  const voucherFilterName = "MeenakshiRequestedVoucher";
  const targeted = ledgerNames.length > 0;
  const xml = buildCollectionExportXml({
    collectionName: targeted ? `Meenakshi Vouchers ${batchIndex + 1}` : "Meenakshi Vouchers",
    tallyType: "Voucher",
    fetchFields: cashDiscountPerMt ? CASH_DISCOUNT_PER_MT_FETCH_FIELDS : cashDiscountFastPath ? CASH_DISCOUNT_FETCH_FIELDS : VOUCHER_FETCH_FIELDS,
    companyName: activeCompany.name,
    dateFrom: chunk.scope.dateFrom,
    dateTo: chunk.scope.dateTo,
    formulae: targeted ? [
      { name: ledgerEntryFilterName, formula: requestedLedgerFormula(ledgerNames) },
      { name: voucherFilterName, formula: `$$FilterCount:AllLedgerEntries:${ledgerEntryFilterName} > 0` },
    ] : [],
    filterNames: targeted ? [voucherFilterName] : [],
  });
  return postTallyXml(config.tallyUrl, xml, { timeoutMs: targeted ? 45_000 : 90_000, operation: "Export Meenakshi vouchers" });
}

export async function syncVouchers(command, { config, activeCompany, isCancelled }) {
  const syncRunId = typeof command.payload?.syncRunId === "string" ? command.payload.syncRunId : "";
  const scope = command.payload?.requestedScope && typeof command.payload.requestedScope === "object" ? command.payload.requestedScope : {};
  const customerLedgerNames = uniqueCustomerLedgerNames(scope);
  const cashDiscountFastPath = scope.purpose === "live_cd_evaluation";
  const cashDiscountPerMt = cashDiscountFastPath && scope.cdDiscountBasis === "amount_per_tonne";
  const localLiveCalculation = cashDiscountFastPath || scope.purpose === "live_tod_evaluation";
  if (!syncRunId && !localLiveCalculation) throw new Error("Voucher sync command did not contain syncRunId.");
  const targeted = customerLedgerNames.length > 0 && customerLedgerNames.length <= TARGETED_CUSTOMER_LIMIT;
  // Cash Discount matches customers in memory but reads the period in short
  // windows; the caller loops on cursorTo until the period is complete.
  const chunk = chunkScope(scope, cashDiscountFastPath ? CASH_DISCOUNT_DAYS_PER_CHUNK : targeted ? TARGETED_DAYS_PER_CHUNK : MAX_DAYS_PER_CHUNK);
  if (cashDiscountFastPath && typeof scope.cursor === "string" && scope.cursor !== scope.dateFrom) {
    await new Promise((resolve) => setTimeout(resolve, CASH_DISCOUNT_PAUSE_MS));
  }
  const ledgerBatches = cashDiscountFastPath
    ? [[]]
    : customerLedgerNames.length && customerLedgerNames.length <= TARGETED_CUSTOMER_LIMIT
    ? chunkValues(customerLedgerNames, CUSTOMER_BATCH_SIZE)
    : [[]];
  const voucherByGuid = new Map();
  for (const [batchIndex, ledgerNames] of ledgerBatches.entries()) {
    if (isCancelled?.()) throw new Error("This Tally read was stopped.");
    const resultXml = await exportVoucherBatch({ config, activeCompany, chunk, ledgerNames, batchIndex, cashDiscountFastPath, cashDiscountPerMt });
    if (isCancelled?.()) throw new Error("This Tally read was stopped.");
    for (const voucher of parseVouchers(resultXml)) {
      if (matchesScope(voucher, chunk.scope)) voucherByGuid.set(voucher.guid, voucher);
    }
  }
  const vouchers = [...voucherByGuid.values()];
  return {
    syncRunId,
    activeCompany,
    complete: true,
    cursorFrom: chunk.cursorFrom,
    cursorTo: chunk.cursorTo,
    vouchers,
    queryMode: ledgerBatches[0]?.length ? "targeted" : "full",
    queryBatches: ledgerBatches.length,
    totals: {
      vouchers: vouchers.length,
      inventoryLines: vouchers.reduce((count, voucher) => count + voucher.inventoryLines.length, 0),
      billAllocations: vouchers.reduce((count, voucher) => count + voucher.billAllocations.length, 0),
    },
  };
}
