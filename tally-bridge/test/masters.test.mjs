import test from "node:test";
import assert from "node:assert/strict";
import { filterCustomersInGroupTree, parseCustomerGroups, parseCustomers, parseStockItems } from "../src/tally/masters.mjs";

test("master parsers preserve Tally source identities and hierarchy references", () => {
  const groups = parseCustomerGroups("<ENVELOPE><GROUP NAME=\"Retail\"><GUID>grp-retail</GUID><MASTERID>12</MASTERID><ALTERID>4</ALTERID><PARENTGUID>grp-debtors</PARENTGUID></GROUP></ENVELOPE>");
  assert.deepEqual(groups[0], {
    guid: "grp-retail", masterId: "12", alterId: "4", name: "Retail", parentGuid: "grp-debtors",
    sourcePayload: { guid: "grp-retail", masterId: "12", alterId: "4", name: "Retail", parentGuid: "grp-debtors" },
  });
});

test("stock and customer parsers retain the references needed for later CD/TOD evidence", () => {
  const stockItems = parseStockItems("<ENVELOPE><STOCKITEM NAME=\"Steel Coil\"><GUID>item-1</GUID><PARENTGUID>stock-1</PARENTGUID><BASEUNITS>MT</BASEUNITS></STOCKITEM></ENVELOPE>");
  assert.equal(stockItems[0].stockGroupGuid, "stock-1");
  assert.equal(stockItems[0].uomCode, "MT");

  const customers = parseCustomers("<ENVELOPE><LEDGER NAME=\"ACME\"><GUID>cust-1</GUID><PARENTGUID>grp-retail</PARENTGUID><PARTYGSTIN>29ABCDE1234F1Z5</PARTYGSTIN><MOBILE>9999999999</MOBILE></LEDGER></ENVELOPE>");
  assert.equal(customers[0].customerGroupGuid, "grp-retail");
  assert.equal(customers[0].sourcePayload.phone, "9999999999");
});

test("customer filtering includes nested Sundry Debtors groups and excludes unrelated ledgers", () => {
  const groups = parseCustomerGroups(`
    <ENVELOPE>
      <GROUP NAME="Sundry Debtors"><GUID>debtors</GUID><PARENT>Current Assets</PARENT></GROUP>
      <GROUP NAME="Regional Receivables"><GUID>regional</GUID><PARENT>Sundry Debtors</PARENT></GROUP>
      <GROUP NAME="Pune Receivables"><GUID>pune</GUID><PARENT>Regional Receivables</PARENT></GROUP>
      <GROUP NAME="Sundry Creditors"><GUID>creditors</GUID><PARENT>Current Liabilities</PARENT></GROUP>
    </ENVELOPE>
  `);
  const customers = parseCustomers(`
    <ENVELOPE>
      <LEDGER NAME="Direct Customer"><GUID>customer-1</GUID><PARENT>Sundry Debtors</PARENT></LEDGER>
      <LEDGER NAME="Nested Customer"><GUID>customer-2</GUID><PARENT>Pune Receivables</PARENT></LEDGER>
      <LEDGER NAME="Supplier"><GUID>supplier-1</GUID><PARENT>Sundry Creditors</PARENT></LEDGER>
    </ENVELOPE>
  `);

  assert.deepEqual(
    filterCustomersInGroupTree(groups, customers, "Sundry Debtors").map((customer) => customer.ledgerName),
    ["Direct Customer", "Nested Customer"],
  );
});
