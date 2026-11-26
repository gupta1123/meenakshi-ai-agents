// What makes two Tally companies "the same company".
//
// A Tally company split into one company per financial year keeps the SAME GUID
// for every year, and names change, so neither alone is enough. The identity is
// the GUID plus the books-from date (the financial year). The name is for
// people to read, not to decide on.
//
// A record that does not know its books-from date yet (an older company, or an
// older connector) is matched on the GUID alone, as before, so nothing that
// already works stops working.

const clean = (value) => String(value ?? "").trim().toLowerCase();

/** Tally sends 20250401; the product stores 2025-04-01. Anything else is "unknown". */
export function normalizeBooksFrom(value) {
  const text = String(value ?? "").trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

export function sameTallyCompany(expected, actual) {
  const expectedGuid = clean(expected?.guid);
  const actualGuid = clean(actual?.guid);
  if (!expectedGuid && !actualGuid) {
    // Neither side has a GUID (very old data): the name is all there is.
    return clean(expected?.name) !== "" && clean(expected?.name) === clean(actual?.name);
  }
  // A GUID on one side only never matches: that is a different or unidentified company.
  if (!expectedGuid || expectedGuid !== actualGuid) return false;
  const expectedFrom = normalizeBooksFrom(expected?.booksFrom);
  if (!expectedFrom) return true;
  const actualFrom = normalizeBooksFrom(actual?.booksFrom);
  // The record knows its year but the connector did not say: only the name is left to go on.
  if (!actualFrom) return clean(expected?.name) !== "" && clean(expected?.name) === clean(actual?.name);
  return expectedFrom === actualFrom;
}

export function companyKey(company) {
  return `${clean(company?.guid) || clean(company?.name)}|${normalizeBooksFrom(company?.booksFrom) ?? ""}`;
}
