import test from "node:test";
import assert from "node:assert/strict";
import { buildCollectionExportXml, buildCompanyCollectionXml, cleanXmlText, extractBlocks, getAttribute, getTagText } from "../src/tally/xml.mjs";

test("company export requests the identity fields required for exact company matching", () => {
  const xml = buildCompanyCollectionXml();
  assert.match(xml, /<TYPE>Company<\/TYPE>/);
  assert.match(xml, /Name,GUID,MasterID,AlterID/);
});

test("XML helpers retain and decode Tally company identity", () => {
  const xml = "<ENVELOPE><COMPANY NAME=\"Meenakshi &amp; Co\"><GUID>guid-1</GUID></COMPANY></ENVELOPE>";
  const [company] = extractBlocks(xml, "COMPANY");
  assert.equal(getAttribute(company, "NAME"), "Meenakshi & Co");
  assert.equal(getTagText(company, "GUID"), "guid-1");
  assert.equal(cleanXmlText("  A&amp;B  "), "A&B");
  assert.equal(cleanXmlText("\u0004Not Applicable"), "Not Applicable");
});

test("XML helpers read a real child tag instead of Tally's dotted list wrapper", () => {
  const xml = "<LEDGER><NAME.LIST TYPE=\"String\"><NAME>TEST CUSTOMER CD 2</NAME></NAME.LIST><GUID>customer-2</GUID></LEDGER>";
  assert.equal(getTagText(xml, "NAME"), "TEST CUSTOMER CD 2");
});

test("collection exports include validated Tally-side filters", () => {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi Vouchers",
    tallyType: "Voucher",
    fetchFields: ["GUID"],
    filterNames: ["MeenakshiRequestedVoucher"],
    formulae: [{ name: "MeenakshiRequestedVoucher", formula: "$$FilterCount:AllLedgerEntries:MeenakshiRequestedLedger > 0" }],
  });
  assert.match(xml, /<FILTER>MeenakshiRequestedVoucher<\/FILTER>/);
  assert.match(xml, /<SYSTEM TYPE="Formulae" NAME="MeenakshiRequestedVoucher"/);
  assert.throws(() => buildCollectionExportXml({ collectionName: "Bad", tallyType: "Voucher", formulae: [{ name: "bad name", formula: "$Name" }] }), /Invalid Tally formula name/);
});
