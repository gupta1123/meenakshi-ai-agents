const DEFAULT_TIMEOUT_MS = 60_000;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function cleanXmlText(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    // Tally may prefix displayed text with non-printing control characters
    // (for example, \u0004 before "Not Applicable"). Those are presentation
    // artefacts, not part of a ledger name or GST classification. Preserve
    // regular whitespace so it can be normalised by the next step.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getTagText(xml, tagName) {
  const safeTagName = escapeRegex(tagName);
  // Do not use a word boundary after the name here. Tally emits list wrappers
  // such as <NAME.LIST> that contain a real <NAME> child. A word boundary
  // treats the dot as a boundary, incorrectly returning "<NAME>..." instead
  // of the actual text and breaks master-to-voucher matching.
  const match = String(xml).match(new RegExp(`<${safeTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTagName}\\s*>`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

export function getAttribute(xml, name) {
  const match = String(xml).match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

export function extractBlocks(xml, tagName) {
  const safeTagName = escapeRegex(tagName);
  return [...String(xml).matchAll(new RegExp(`<${safeTagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTagName}\\s*>`, "gi"))].map((match) => match[0]);
}

export function getTagTexts(xml, tagName) {
  const safeTagName = escapeRegex(tagName);
  return [...String(xml).matchAll(new RegExp(`<${safeTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTagName}\\s*>`, "gi"))]
    .map((match) => cleanXmlText(match[1]))
    .filter(Boolean);
}

export function buildCurrentCompanyXml() {
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Function</TYPE><ID>$$CurrentCompany</ID></HEADER><BODY><DESC>",
    "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
    "</DESC></BODY></ENVELOPE>",
  ].join("");
}

export function buildCompanyCollectionXml() {
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Collection</TYPE><ID>Meenakshi Available Companies</ID></HEADER><BODY><DESC>",
    "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
    "<TDL><TDLMESSAGE><COLLECTION NAME=\"Meenakshi Available Companies\" ISMODIFY=\"No\">",
    "<TYPE>Company</TYPE><FETCH>Name,GUID,MasterID,AlterID</FETCH>",
    "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>",
  ].join("");
}

export function buildCollectionExportXml({ collectionName, tallyType, fetchFields, companyName, childOf, dateFrom, dateTo, formulae = [], filterNames = [] }) {
  const staticVariables = [
    companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "",
    dateFrom ? `<SVFROMDATE TYPE=\"Date\">${escapeXml(String(dateFrom).replaceAll("-", ""))}</SVFROMDATE>` : "",
    dateTo ? `<SVTODATE TYPE=\"Date\">${escapeXml(String(dateTo).replaceAll("-", ""))}</SVTODATE>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
  ].filter(Boolean).join("");
  const childFilter = childOf ? `<ADD>CHILD OF : ${escapeXml(childOf)}</ADD>` : "";
  for (const formula of formulae) {
    if (!formula || !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(formula.name || "")) || !String(formula.formula || "").trim()) {
      throw new Error("Invalid Tally formula name or expression.");
    }
  }
  const safeFormulae = formulae;
  const availableFormulaNames = new Set(safeFormulae.map((formula) => formula.name));
  for (const name of filterNames) {
    if (!availableFormulaNames.has(name)) throw new Error(`Tally filter ${name} has no matching formula.`);
  }
  const appliedFilterNames = filterNames;
  const collectionFilter = appliedFilterNames.length ? `<FILTER>${escapeXml(appliedFilterNames.join(","))}</FILTER>` : "";
  const formulaDefinitions = safeFormulae.map(
    ({ name, formula }) => `<SYSTEM TYPE="Formulae" NAME="${escapeXml(name)}" ISMODIFY="No">${escapeXml(String(formula).trim())}</SYSTEM>`,
  ).join("");
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
    `<TYPE>Collection</TYPE><ID>${escapeXml(collectionName)}</ID></HEADER><BODY><DESC>`,
    `<STATICVARIABLES>${staticVariables}</STATICVARIABLES>`,
    "<TDL><TDLMESSAGE>",
    `<COLLECTION NAME=\"${escapeXml(collectionName)}\" ISMODIFY=\"No\">`,
    `<TYPE>${escapeXml(tallyType)}</TYPE>${childFilter}${collectionFilter}<FETCH>${escapeXml(fetchFields)}</FETCH>`,
    `</COLLECTION>${formulaDefinitions}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`,
  ].join("");
}

export async function postTallyXml(tallyUrl, xml, { timeoutMs = DEFAULT_TIMEOUT_MS, operation = "Tally request" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(String(tallyUrl).replace(/\/+$/, ""), {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: xml,
      signal: controller.signal,
    });
    const responseXml = await response.text();
    const lineError = getTagText(responseXml, "LINEERROR");
    if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}.`);
    if (lineError) throw new Error(`${operation} failed: ${lineError}`);
    if (!/<(?:ENVELOPE|RESPONSE|COLLECTION|RESULT|LISTOF)/i.test(responseXml)) {
      throw new Error(`${operation} returned a non-XML response.`);
    }
    return responseXml;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${operation} timed out after ${timeoutMs / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
