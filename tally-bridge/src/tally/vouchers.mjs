import { extractBlocks, getAttribute, getTagText } from "./xml.mjs";

function text(block, tagName) {
  return getTagText(block, tagName) || getAttribute(block, tagName) || "";
}

function decimalText(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "0";
}

function quantityText(value) {
  const normalized = decimalText(value);
  return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}

function absoluteDecimalText(value) {
  const normalized = decimalText(value);
  return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}

function dateText(value) {
  const compact = String(value ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim()) ? String(value).trim() : null;
}

function truthy(value) {
  return /^(yes|true|1)$/i.test(String(value ?? "").trim());
}

function voucherKind(voucherTypeName, inventoryLines) {
  const value = String(voucherTypeName).toLowerCase();
  if (/sales\s*return/.test(value)) return "sales_return";
  if (/credit\s*note/.test(value)) return inventoryLines.length ? "sales_return" : "credit_note";
  if (/debit\s*note/.test(value)) return "debit_note";
  if (/receipt/.test(value)) return "receipt";
  if (/sales/.test(value)) return "sales";
  return "other";
}

function voucherStatus(voucherXml) {
  if (truthy(text(voucherXml, "ISCANCELLED"))) return "cancelled";
  if (truthy(text(voucherXml, "ISOPTIONAL"))) return "optional";
  if (truthy(text(voucherXml, "ISREVERSED"))) return "reversed";
  return "posted";
}

function allocationType(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll(".", "");
  if (normalized.includes("agst") || normalized.includes("against")) return "agst_ref";
  if (normalized.includes("new ref")) return "new_ref";
  if (normalized.includes("on account")) return "on_account";
  if (normalized.includes("advance")) return "advance";
  return "other";
}

function parseInventoryLines(voucherXml) {
  // Tally's standard voucher export normally uses ALLINVENTORYENTRIES.LIST.
  // Voucher-mode entries nest INVENTORYALLOCATIONS.LIST below the sales ledger.
  const allInventoryEntries = extractBlocks(voucherXml, "ALLINVENTORYENTRIES.LIST");
  const inventoryEntries = extractBlocks(voucherXml, "INVENTORYENTRIES.LIST");
  const entryBlocks = allInventoryEntries.length > 0
    ? allInventoryEntries
    : inventoryEntries.length > 0
      ? inventoryEntries
      : extractBlocks(voucherXml, "INVENTORYALLOCATIONS.LIST");
  return entryBlocks.map((lineXml, index) => {
    const stockItemName = text(lineXml, "STOCKITEMNAME");
    const stockGroupName = text(lineXml, "STOCKGROUP") || text(lineXml, "PARENT");
    const uomCode = text(lineXml, "BILLEDQTY").replace(/^[-+]?\d+(?:\.\d+)?\s*/, "") || text(lineXml, "ACTUALQTY").replace(/^[-+]?\d+(?:\.\d+)?\s*/, "");
    const rawQuantity = text(lineXml, "BILLEDQTY") || text(lineXml, "ACTUALQTY");
    const taxableProductValue = decimalText(text(lineXml, "AMOUNT"));
    return {
      lineNumber: index + 1,
      stockItemGuid: text(lineXml, "STOCKITEMGUID"),
      stockGroupGuid: text(lineXml, "STOCKGROUPGUID") || text(lineXml, "PARENTGUID"),
      stockItemName,
      stockGroupName,
      uomCode,
      quantity: quantityText(rawQuantity),
      taxableProductValue: taxableProductValue.startsWith("-") ? taxableProductValue.slice(1) : taxableProductValue,
      freightValue: "0",
      nonProductValue: "0",
      lineCategory: "inventory",
      quantityIsReliable: Boolean(rawQuantity),
      sourcePayload: {
        stockItemName, stockGroupName, rawQuantity, amount: text(lineXml, "AMOUNT"),
      },
    };
  }).filter((line) => line.stockItemName || line.stockItemGuid);
}

function parseBillAllocations(voucherXml, voucherGuid, voucherDate) {
  return extractBlocks(voucherXml, "BILLALLOCATIONS.LIST").map((allocationXml, index) => {
    const billReference = text(allocationXml, "NAME");
    const billType = text(allocationXml, "BILLTYPE");
    const allocatedAmount = decimalText(text(allocationXml, "AMOUNT"));
    return {
      allocationKey: `${voucherGuid}:${index + 1}:${billReference}:${billType}`,
      billReference,
      allocationType: allocationType(billType),
      allocationDate: voucherDate,
      allocatedAmount: allocatedAmount.startsWith("-") ? allocatedAmount.slice(1) : allocatedAmount,
      targetVoucherGuid: text(allocationXml, "TARGETVOUCHERGUID") || text(allocationXml, "VOUCHERGUID"),
      targetVoucherNumber: text(allocationXml, "VOUCHERNUMBER"),
      sourcePayload: { billReference, billType, rawAmount: text(allocationXml, "AMOUNT") },
    };
  }).filter((allocation) => allocation.billReference && allocation.allocatedAmount !== "0");
}

function parseLedgerEntries(voucherXml) {
  const allLedgerEntries = extractBlocks(voucherXml, "ALLLEDGERENTRIES.LIST");
  const entryBlocks = allLedgerEntries.length > 0
    ? allLedgerEntries
    : extractBlocks(voucherXml, "LEDGERENTRIES.LIST");
  return entryBlocks.map((entryXml) => ({
    ledgerName: text(entryXml, "LEDGERNAME"),
    amount: decimalText(text(entryXml, "AMOUNT")),
    isDeemedPositive: truthy(text(entryXml, "ISDEEMEDPOSITIVE")),
  })).filter((entry) => entry.ledgerName || entry.amount !== "0");
}

export function parseVouchers(xml) {
  return extractBlocks(xml, "VOUCHER").map((voucherXml) => {
    const guid = text(voucherXml, "GUID");
    const voucherDate = dateText(text(voucherXml, "DATE"));
    const voucherTypeName = text(voucherXml, "VOUCHERTYPENAME") || text(voucherXml, "VOUCHERTYPE");
    const inventoryLines = parseInventoryLines(voucherXml);
    const ledgerEntries = parseLedgerEntries(voucherXml);
    return {
      guid,
      masterId: text(voucherXml, "MASTERID"),
      alterId: text(voucherXml, "ALTERID"),
      voucherNumber: text(voucherXml, "VOUCHERNUMBER"),
      voucherKind: voucherKind(voucherTypeName, inventoryLines),
      voucherTypeName,
      voucherTypeGuid: text(voucherXml, "VOUCHERTYPEGUID"),
      voucherDate,
      partyLedgerName: text(voucherXml, "PARTYLEDGERNAME"),
      partyLedgerGuid: text(voucherXml, "PARTYLEDGERGUID"),
      linkedSalesVoucherGuid: text(voucherXml, "LINKEDSALESVOUCHERGUID"),
      status: voucherStatus(voucherXml),
      // The database derives this total from decimal line values. JavaScript
      // never adds financial amounts using floating point.
      taxableProductValue: "0",
      // Tally's accounting sign reflects debit/credit direction. Meenakshi's
      // financial evidence stores the voucher's monetary magnitude; the
      // voucher kind retains the business direction.
      grossAmount: absoluteDecimalText(text(voucherXml, "VOUCHERAMOUNT") || text(voucherXml, "AMOUNT")),
      narration: text(voucherXml, "NARRATION"),
      inventoryLines,
      billAllocations: parseBillAllocations(voucherXml, guid, voucherDate),
      sourcePayload: {
        voucherTypeName,
        partyLedgerName: text(voucherXml, "PARTYLEDGERNAME"),
        ledgerEntries,
        inventoryLineCount: inventoryLines.length,
      },
    };
  }).filter((voucher) => voucher.guid && voucher.voucherDate && voucher.voucherTypeName);
}
