import { createHash } from "node:crypto";
import Decimal from "decimal.js";

import { syncVouchers } from "./sync-vouchers.mjs";
import { sourceSalesLedgerName } from "./voucher-ledgers.mjs";

const MAX_CHUNKS = 60;
const MAX_MATCHING_VOUCHERS = 50_000;

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function contributionSign(voucher) {
  if (voucher.voucherKind === "sales") return 1;
  if (voucher.voucherKind === "sales_return") return -1;
  if (voucher.voucherKind === "debit_note" && voucher.linkedSalesVoucherGuid) return 1;
  return 0;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}
function emptyAggregate(customerId, customerLedgerName) {
  return { customerId, customerLedgerName, matchingVouchers: 0, eligibleTaxableValue: new Decimal(0), eligibleTonnes: new Decimal(0), missingUnits: new Set(), contributions: [], productContributions: new Map() };
}

export async function fetchLiveTodEvidence(command, context) {
  const scope = command.payload?.voucherScope && typeof command.payload.voucherScope === "object" ? command.payload.voucherScope : {};
  const eligibleGuids = new Set((scope.eligibleStockItemGuids ?? []).map(normalized).filter(Boolean));
  const eligibleNames = new Set((scope.eligibleStockItemNames ?? []).map(normalized).filter(Boolean));
  const conversions = new Map((scope.unitConversions ?? []).map((item) => [normalized(item?.uomCode), new Decimal(String(item?.tonnesPerUnit ?? "0"))]));
  const requestedCustomers = Array.isArray(scope.customers) ? scope.customers : [{ customerId: scope.customerId, ledgerName: scope.customerLedgerName }];
  const aggregates = new Map(requestedCustomers.filter((item) => item?.customerId && item?.ledgerName).map((item) => [normalized(item.ledgerName), emptyAggregate(item.customerId, item.ledgerName)]));
  if (!scope.dateFrom || !scope.dateTo || !aggregates.size) throw new Error("Live Turnover Discount evidence requires eligible customers and a bounded date range.");
  if (!eligibleGuids.size && !eligibleNames.size) throw new Error("The active Turnover Discount rule has no eligible Tally products.");

  let cursor = scope.dateFrom;
  let chunks = 0;
  let vouchersScanned = 0;
  let totalMatchingVouchers = 0;
  while (cursor) {
    if (chunks >= MAX_CHUNKS) throw new Error("The requested Tally period is too large for one live calculation.");
    const result = await syncVouchers({ ...command, payload: { ...command.payload, syncRunId: command.payload.voucherSyncRunId, requestedScope: { ...scope, customerLedgerName: null, customers: null, cursor } } }, context);
    chunks += 1;
    vouchersScanned += result.vouchers.length;
    for (const voucher of result.vouchers) {
      const aggregate = aggregates.get(normalized(voucher.partyLedgerName));
      const sign = contributionSign(voucher);
      if (!aggregate || !sign || voucher.status !== "posted") continue;
      let voucherTaxableValue = new Decimal(0);
      let voucherTonnes = new Decimal(0);
      let matchedLineCount = 0;
      for (const line of voucher.inventoryLines) {
        const selected = eligibleGuids.has(normalized(line.stockItemGuid)) || eligibleNames.has(normalized(line.stockItemName));
        if (!selected || line.lineCategory !== "inventory") continue;
        matchedLineCount += 1;
        const conversion = conversions.get(normalized(line.uomCode));
        if (!line.quantityIsReliable || !conversion || conversion.lte(0)) { aggregate.missingUnits.add(line.uomCode || "Unknown unit"); continue; }
        const lineValue = new Decimal(line.taxableProductValue).mul(sign);
        const lineQuantity = new Decimal(line.quantity).mul(sign);
        const lineTonnes = new Decimal(line.quantity).mul(conversion).mul(sign);
        voucherTaxableValue = voucherTaxableValue.plus(lineValue);
        voucherTonnes = voucherTonnes.plus(lineTonnes);
        const productKey = `${normalized(line.stockItemName)}:${normalized(line.stockGroupName)}:${normalized(line.uomCode)}`;
        const product = aggregate.productContributions.get(productKey) ?? {
          productName: line.stockItemName || "Tally item",
          productGroupName: line.stockGroupName || null,
          sourceUom: line.uomCode || null,
          sourceQuantity: new Decimal(0),
          eligibleTonnes: new Decimal(0),
          eligibleTaxableValue: new Decimal(0),
        };
        product.sourceQuantity = product.sourceQuantity.plus(lineQuantity);
        product.eligibleTonnes = product.eligibleTonnes.plus(lineTonnes);
        product.eligibleTaxableValue = product.eligibleTaxableValue.plus(lineValue);
        aggregate.productContributions.set(productKey, product);
      }
      if (!matchedLineCount) continue;
      totalMatchingVouchers += 1;
      if (totalMatchingVouchers > MAX_MATCHING_VOUCHERS) throw new Error("The live calculation returned too many matching vouchers. Use a shorter rule period.");
      aggregate.matchingVouchers += 1;
      aggregate.eligibleTaxableValue = aggregate.eligibleTaxableValue.plus(voucherTaxableValue);
      aggregate.eligibleTonnes = aggregate.eligibleTonnes.plus(voucherTonnes);
      aggregate.contributions.push({ tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, voucherDate: voucher.voucherDate, voucherKind: voucher.voucherKind, tallyAlterId: voucher.alterId || null, linkedSalesVoucherGuid: voucher.linkedSalesVoucherGuid || null, sourceSalesLedgerName: sourceSalesLedgerName(voucher), taxableValueContribution: voucherTaxableValue.toFixed(), tonneContribution: voucherTonnes.toFixed() });
    }
    cursor = result.cursorTo;
  }

  const customerAggregates = [...aggregates.values()].map((aggregate) => {
    aggregate.contributions.sort((left, right) => `${left.voucherDate}:${left.tallyGuid}`.localeCompare(`${right.voucherDate}:${right.tallyGuid}`));
    const missingUnits = [...aggregate.missingUnits].sort();
    const productContributions = [...aggregate.productContributions.values()].map((product) => ({
      productName: product.productName,
      productGroupName: product.productGroupName,
      sourceUom: product.sourceUom,
      sourceQuantity: product.sourceQuantity.toFixed(),
      eligibleTonnes: product.eligibleTonnes.toFixed(),
      eligibleTaxableValue: product.eligibleTaxableValue.toFixed(),
    })).sort((left, right) => left.productName.localeCompare(right.productName));
    const sourceFingerprint = createHash("sha256").update(canonicalJson({ customerLedgerName: aggregate.customerLedgerName, dateFrom: scope.dateFrom, dateTo: scope.dateTo, contributions: aggregate.contributions, productContributions, missingUnits })).digest("hex");
    return { customerId: aggregate.customerId, customerLedgerName: aggregate.customerLedgerName, matchingVouchers: aggregate.matchingVouchers, eligibleTaxableValue: Decimal.max(aggregate.eligibleTaxableValue, 0).toFixed(), eligibleTonnes: Decimal.max(aggregate.eligibleTonnes, 0).toFixed(), missingUnits, contributions: aggregate.contributions, productContributions, sourceFingerprint };
  });
  if (!Array.isArray(scope.customers)) {
    return { mode: "live_tod_aggregate", evaluationRunId: command.payload.evaluationRunId ?? null, periodStart: scope.dateFrom, periodEnd: scope.dateTo, chunks, vouchersScanned, ...customerAggregates[0] };
  }
  const sourceFingerprint = createHash("sha256").update(canonicalJson(customerAggregates.map(({ customerId, sourceFingerprint: fingerprint }) => ({ customerId, fingerprint })))).digest("hex");
  return { mode: "live_tod_batch_aggregate", evaluationRunId: command.payload.evaluationRunId ?? null, periodStart: scope.dateFrom, periodEnd: scope.dateTo, chunks, vouchersScanned, matchingVouchers: totalMatchingVouchers, customerAggregates, sourceFingerprint };
}
