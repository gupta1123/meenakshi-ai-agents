// Which Tally company is "the same company" as a registered one.
//
// A company split into one company per financial year keeps the SAME Tally ID
// for every year, so the year (books-from date) is part of the identity. A side
// that does not know its year yet is matched on the Tally ID alone, as before.
export type TallyCompanyIdentity = { guid?: string | null; name?: string | null; booksFrom?: string | null };

const clean = (value: unknown) => String(value ?? "").trim().toLowerCase();
const day = (value: unknown) => {
  const text = String(value ?? "").trim();
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text) ? text.slice(0, 10) : null;
};

export function sameTallyCompany(registered: TallyCompanyIdentity, detected: TallyCompanyIdentity) {
  const registeredGuid = clean(registered.guid), detectedGuid = clean(detected.guid);
  if (!registeredGuid && !detectedGuid) return clean(registered.name) !== "" && clean(registered.name) === clean(detected.name);
  if (!registeredGuid || registeredGuid !== detectedGuid) return false;
  const registeredFrom = day(registered.booksFrom);
  if (!registeredFrom) return true;
  const detectedFrom = day(detected.booksFrom);
  if (!detectedFrom) return clean(registered.name) !== "" && clean(registered.name) === clean(detected.name);
  return registeredFrom === detectedFrom;
}
