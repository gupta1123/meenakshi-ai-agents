/** Tally sends 20250401; the product stores 2025-04-01. Anything else means "unknown". */
export function normalizeBooksFrom(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (/^[0-9]{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text) ? text.slice(0, 10) : null;
}

export type TallyCompanyIdentity = { guid?: string | null; name?: string | null; booksFrom?: string | null };

/**
 * Are these the same Tally company? A company split into one company per
 * financial year keeps ONE GUID for every year, so the identity is the GUID plus
 * the books-from date. Names are for people to read and change over time.
 * A side that does not know its year yet is matched on the GUID alone (as before),
 * unless the other side knows its year and the connector did not report one, in
 * which case the name has to agree too.
 */
export function sameTallyCompany(expected: TallyCompanyIdentity, observed: TallyCompanyIdentity) {
  const clean = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const expectedGuid = clean(expected.guid), observedGuid = clean(observed.guid);
  if (!expectedGuid && !observedGuid) return clean(expected.name) !== "" && clean(expected.name) === clean(observed.name);
  if (!expectedGuid || expectedGuid !== observedGuid) return false;
  const expectedFrom = normalizeBooksFrom(expected.booksFrom);
  if (!expectedFrom) return true;
  const observedFrom = normalizeBooksFrom(observed.booksFrom);
  if (!observedFrom) return clean(expected.name) !== "" && clean(expected.name) === clean(observed.name);
  return expectedFrom === observedFrom;
}
