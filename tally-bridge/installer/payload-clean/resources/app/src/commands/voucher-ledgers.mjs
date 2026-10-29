import Decimal from "decimal.js";

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }

export function sourceSalesLedgerName(voucher) {
  const party = normalized(voucher.partyLedgerName);
  const entries = Array.isArray(voucher.sourcePayload?.ledgerEntries) ? voucher.sourcePayload.ledgerEntries : [];
  const nonPartyEntries = entries.filter((entry) => normalized(entry.ledgerName) && normalized(entry.ledgerName) !== party);
  const salesSideEntries = nonPartyEntries.filter((entry) => entry.isDeemedPositive === false);
  return (salesSideEntries.length ? salesSideEntries : nonPartyEntries)
    .sort((left, right) => new Decimal(right.amount || 0).abs().comparedTo(new Decimal(left.amount || 0).abs()))[0]?.ledgerName ?? null;
}
