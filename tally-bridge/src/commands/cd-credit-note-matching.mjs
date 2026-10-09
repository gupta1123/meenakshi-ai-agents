function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function shortNumber(value) {
  const part = normalized(value).split("/").at(-1);
  return /^\d+$/.test(part) ? part.replace(/^0+(?=\d)/, "") : null;
}

// Legacy manually entered notes use e.g. "Discount allowed ... B.No.192".
// Match explicit references, never just a customer/amount or a bare number.
// A shortened number must identify exactly one invoice for this customer in
// the evidence. Multi-bill narration is deliberately not apportioned here.
export function matchCdCreditNote(note, invoices) {
  const narration = String(note.narration ?? "");
  if (!/cash\s+discount|discount\s+allowed/i.test(narration)
      || /turnover|quarterly|\bTOD\b/i.test(narration)) return null;
  if (!(Number(note.amount) > 0)) return null;
  const mentions = [...narration.matchAll(/\b(?:inv(?:oice)?\s*(?:no\.?|number)|b\s*\.\s*no\.?|bill\s*(?:no\.?|number))\s*[:#-]?\s*([a-z0-9]+(?:[\/-][a-z0-9]+)*)/gi)];
  if (mentions.some((match) => /^\s*(?:,|&|and\b)\s*\d/i.test(narration.slice(match.index + match[0].length)))) return null;
  const references = mentions.map((match) => normalized(match[1]));
  const unique = [...new Set(references)];
  if (unique.length !== 1) return null;
  const reference = unique[0];
  const matched = invoices.filter((invoice) => {
    if (!normalized(note.customerLedgerName)
        || normalized(note.customerLedgerName) !== normalized(invoice.customerLedgerName)) return false;
    const refs = [invoice.voucherNumber, ...(invoice.billReferences ?? [])].map(normalized).filter(Boolean);
    return reference.includes("/") || !/^\d+$/.test(reference)
      ? refs.includes(reference)
      : refs.some((ref) => shortNumber(ref) === shortNumber(reference));
  });
  if (matched.length !== 1) return null;
  const invoice = matched[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(note.voucherDate ?? "") || note.voucherDate < invoice.voucherDate) return null;
  return invoice.tallyGuid;
}
