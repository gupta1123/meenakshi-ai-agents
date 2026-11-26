// Every Tally program on this PC and every company each one has open.
//
// A server can run several Tally programs at once (each on its own port), and
// each program can hold several companies (for example one per financial year).
// A web user asking about a company must reach the program that has THAT
// company open, whichever port it is on, without anyone telling us. This keeps
// a short-lived map of company -> port and answers "where is this company?".
import { companyKey, sameTallyCompany } from "./company-identity.mjs";
import { probeTallyCompanies } from "./company-probe.mjs";
import { localTallyUrls } from "./local-instances.mjs";

const clean = (value) => String(value ?? "").trim().toLowerCase();

export function createTallyInstances({
  configuredUrl, listUrls = localTallyUrls, probe = probeTallyCompanies,
  now = Date.now, ttlMs = 60_000, probeTimeoutMs = 3000,
} = {}) {
  let entries = [];
  let readAt = 0;
  let inflight = null;

  async function scan() {
    const urls = [...new Set([configuredUrl, ...(await listUrls().catch(() => []))].filter(Boolean))];
    const found = [];
    for (const url of urls) {
      const snapshot = await probe(url, { timeoutMs: probeTimeoutMs, redirect: "error" }).catch(() => null);
      if (!snapshot) continue;
      for (const company of snapshot.availableCompanies ?? [])
        found.push({ url, company: { name: company.name, guid: company.guid, booksFrom: company.booksFrom ?? null }, isActiveInTally: Boolean(company.isActive) });
    }
    entries = found;
    readAt = now();
    return entries;
  }

  async function all({ force = false } = {}) {
    if (!force && entries.length && now() - readAt < ttlMs) return entries;
    inflight ??= scan().finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * Where is the expected company? Null when it is not open anywhere. If the
   * record cannot tell years apart (no books-from yet) and several companies share
   * its GUID, only an exact name will do, so a wrong year is never picked by luck.
   */
  async function find(expected) {
    for (const force of [false, true]) {
      const list = await all({ force });
      let candidates = list.filter((entry) => sameTallyCompany(expected, entry.company));
      if (candidates.length > 1) candidates = candidates.filter((entry) => clean(entry.company.name) === clean(expected?.name));
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  return { all, find, companyKey };
}
