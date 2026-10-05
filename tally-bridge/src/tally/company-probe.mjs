import { buildCompanyCollectionXml, buildCurrentCompanyXml, extractBlocks, getAttribute, getTagText, postTallyXml } from "./xml.mjs";

function companyKey(company) {
  return company.guid?.trim().toLowerCase() || company.name?.trim().toLowerCase() || "";
}

function sameCompany(left, right) {
  if (left.guid && right.guid) return left.guid.trim().toLowerCase() === right.guid.trim().toLowerCase();
  return left.name.trim().toLowerCase() === right.name.trim().toLowerCase();
}

export async function probeTallyCompanies(tallyUrl) {
  const name = await probeCurrentCompanyName(tallyUrl);

  const companiesXml = await postTallyXml(tallyUrl, buildCompanyCollectionXml(), { operation: "Read Tally companies" });
  const seen = new Set();
  const companies = extractBlocks(companiesXml, "COMPANY").flatMap((companyXml) => {
    const company = {
      name: getTagText(companyXml, "NAME") || getAttribute(companyXml, "NAME"),
      guid: getTagText(companyXml, "GUID") || getAttribute(companyXml, "GUID"),
    };
    if (!company.name || !company.guid || seen.has(companyKey(company))) return [];
    seen.add(companyKey(company));
    return [{ name: company.name.trim(), guid: company.guid.trim() }];
  });
  const active = companies.find((company) => company.name.toLowerCase() === name.trim().toLowerCase());

  if (!active?.guid) throw new Error(`Tally returned active company "${name}" but no GUID was available for it.`);
  const availableCompanies = companies.map((company) => ({ ...company, isActive: sameCompany(company, active) }));
  return { activeCompany: active, availableCompanies };
}

export async function probeCurrentCompanyName(tallyUrl) {
  const currentXml = await postTallyXml(tallyUrl, buildCurrentCompanyXml(), { operation: "Read active Tally company" });
  const name = getTagText(currentXml, "RESULT") || getTagText(currentXml, "COMPANYNAME");
  if (!name) throw new Error("Tally did not identify the currently active company.");
  return name.trim();
}

export async function probeActiveCompany(tallyUrl) {
  const { activeCompany } = await probeTallyCompanies(tallyUrl);
  return activeCompany;
}

/**
 * Tally's master change counter (AltMstId) for the open company. It goes up
 * whenever a customer, group, product or ledger is created or edited, so a
 * master sync is needed only when it moved. A tiny read (about 0.25 s).
 * Collection names must be plain words (no hyphen) or Tally shows an error dialog.
 */
export async function probeMasterChangeCounter(tallyUrl, companyName) {
  const xml = [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Collection</TYPE><ID>Meenakshi Company Change Counter</ID></HEADER><BODY><DESC>",
    "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
    "<TDL><TDLMESSAGE><COLLECTION NAME=\"Meenakshi Company Change Counter\" ISMODIFY=\"No\">",
    "<TYPE>Company</TYPE><FETCH>Name,AltMstId</FETCH>",
    "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>",
  ].join("");
  const response = await postTallyXml(tallyUrl, xml, { timeoutMs: 10_000, operation: "Read the Tally change counter" });
  const wanted = String(companyName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  for (const block of extractBlocks(response, "COMPANY")) {
    const name = String(getAttribute(block, "NAME") ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const counter = Number(String(getTagText(block, "ALTMSTID") ?? "").trim());
    if ((!wanted || name === wanted) && Number.isFinite(counter) && counter > 0) return counter;
  }
  return null;
}
