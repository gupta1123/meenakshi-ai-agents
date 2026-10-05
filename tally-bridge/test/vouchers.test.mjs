import test from "node:test";
import assert from "node:assert/strict";
import { parseVouchers } from "../src/tally/vouchers.mjs";
import { syncVouchers } from "../src/commands/sync-vouchers.mjs";

test("voucher parser preserves receipt allocations and inventory quantity without floating-point arithmetic", () => {
  const xml = [
    "<ENVELOPE><VOUCHER><GUID>receipt-1</GUID><DATE>20260803</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-1</VOUCHERNUMBER>",
    "<PARTYLEDGERNAME>ACME</PARTYLEDGERNAME><PARTYLEDGERGUID>cust-1</PARTYLEDGERGUID>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>ACME</LEDGERNAME><AMOUNT>-118000</AMOUNT><BILLALLOCATIONS.LIST><NAME>S-100</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-118000.25</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>",
    "</VOUCHER><VOUCHER><GUID>sales-1</GUID><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-100</VOUCHERNUMBER>",
    "<INVENTORYENTRIES.LIST><STOCKITEMNAME>Coil</STOCKITEMNAME><STOCKITEMGUID>item-1</STOCKITEMGUID><BILLEDQTY>10.500 MT</BILLEDQTY><AMOUNT>118000.25</AMOUNT></INVENTORYENTRIES.LIST></VOUCHER></ENVELOPE>",
  ].join("");
  const [receipt, sales] = parseVouchers(xml);
  assert.equal(receipt.voucherKind, "receipt");
  assert.equal(receipt.billAllocations[0].allocationType, "agst_ref");
  assert.equal(receipt.billAllocations[0].allocatedAmount, "118000.25");
  assert.equal(sales.inventoryLines[0].quantity, "10.500");
  assert.equal(sales.inventoryLines[0].uomCode, "MT");
  assert.equal(sales.inventoryLines[0].taxableProductValue, "118000.25");
});

test("voucher parser stores a Sales invoice amount as its positive monetary magnitude", () => {
  const xml = "<ENVELOPE><VOUCHER><GUID>sales-1</GUID><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERAMOUNT>-1000.00</VOUCHERAMOUNT></VOUCHER></ENVELOPE>";
  const [sales] = parseVouchers(xml);
  assert.equal(sales.grossAmount, "1000.00");
});

test("voucher parser reads Tally's standard all-inventory-entries export", () => {
  const xml = [
    "<ENVELOPE><VOUCHER><GUID>sales-2</GUID><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>",
    "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>TEST PRODUCT CD 2</STOCKITEMNAME><STOCKITEMGUID>item-2</STOCKITEMGUID><BILLEDQTY>1 Nos</BILLEDQTY><AMOUNT>-1000</AMOUNT></ALLINVENTORYENTRIES.LIST>",
    "</VOUCHER></ENVELOPE>",
  ].join("");
  const [sales] = parseVouchers(xml);
  assert.equal(sales.inventoryLines.length, 1);
  assert.equal(sales.inventoryLines[0].stockItemName, "TEST PRODUCT CD 2");
  assert.equal(sales.inventoryLines[0].taxableProductValue, "1000");
});

test("voucher parser reads inventory allocations nested below voucher-mode ledger entries", () => {
  const xml = [
    "<ENVELOPE><VOUCHER><GUID>sales-3</GUID><DATE>20260811</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>",
    "<LEDGERENTRIES.LIST><LEDGERNAME>Industrial Sales Account</LEDGERNAME><AMOUNT>50000</AMOUNT>",
    "<INVENTORYALLOCATIONS.LIST><STOCKITEMNAME>M S Scrap &amp; Sponge Iron</STOCKITEMNAME><BILLEDQTY>50.000 MTS</BILLEDQTY><AMOUNT>50000</AMOUNT></INVENTORYALLOCATIONS.LIST>",
    "</LEDGERENTRIES.LIST></VOUCHER></ENVELOPE>",
  ].join("");
  const [sales] = parseVouchers(xml);
  assert.equal(sales.inventoryLines.length, 1);
  assert.equal(sales.inventoryLines[0].stockItemName, "M S Scrap & Sponge Iron");
  assert.equal(sales.inventoryLines[0].quantity, "50.000");
  assert.equal(sales.inventoryLines[0].uomCode, "MTS");
  assert.equal(sales.sourcePayload.ledgerEntries[0].ledgerName, "Industrial Sales Account");
});

test("voucher parser identifies cancellations and sales returns distinctly", () => {
  const xml = "<ENVELOPE><VOUCHER><GUID>return-1</GUID><DATE>20260803</DATE><VOUCHERTYPENAME>Sales Return</VOUCHERTYPENAME><ISCANCELLED>Yes</ISCANCELLED></VOUCHER></ENVELOPE>";
  const [voucher] = parseVouchers(xml);
  assert.equal(voucher.voucherKind, "sales_return");
  assert.equal(voucher.status, "cancelled");
});

test("an inventory Credit Note is a sales return while a commercial Credit Note is not", () => {
  const xml = [
    "<ENVELOPE><VOUCHER><GUID>return-2</GUID><DATE>20260803</DATE><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>",
    "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Coil</STOCKITEMNAME><BILLEDQTY>10 MTS</BILLEDQTY><AMOUNT>-1000</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>",
    "<VOUCHER><GUID>discount-1</GUID><DATE>20260803</DATE><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME><VOUCHERAMOUNT>100</VOUCHERAMOUNT></VOUCHER></ENVELOPE>",
  ].join("");
  const [salesReturn, commercialCreditNote] = parseVouchers(xml);
  assert.equal(salesReturn.voucherKind, "sales_return");
  assert.equal(commercialCreditNote.voucherKind, "credit_note");
});

test("voucher sync chunks long date ranges without browser-driven polling", async () => {
  const originalFetch = globalThis.fetch;
  let requestXml = "";
  globalThis.fetch = async (_url, options) => {
    requestXml = String(options.body);
    return new Response("<ENVELOPE></ENVELOPE>", { status: 200 });
  };
  try {
    const result = await syncVouchers({ payload: { syncRunId: "sync-1", requestedScope: { dateFrom: "2026-04-01", dateTo: "2026-06-30" } } }, {
      config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" },
    });
    assert.match(requestXml, /<SVFROMDATE TYPE="Date">20260401<\/SVFROMDATE>/);
    assert.match(requestXml, /<SVTODATE TYPE="Date">20260501<\/SVTODATE>/);
    assert.match(requestXml, /AllInventoryEntries\.StockItemName/);
    assert.match(requestXml, /AllInventoryEntries\.BilledQty/);
    assert.equal(result.cursorTo, "2026-05-02");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voucher sync asks Tally only for vouchers touching eligible customer ledgers", async () => {
  const originalFetch = globalThis.fetch;
  let requestXml = "";
  globalThis.fetch = async (_url, options) => {
    requestXml = String(options.body);
    return new Response("<ENVELOPE></ENVELOPE>", { status: 200 });
  };
  try {
    const result = await syncVouchers({ payload: { syncRunId: "sync-2", requestedScope: {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      customers: [{ customerId: "customer-1", ledgerName: "Industrial Project Receivables" }],
    } } }, {
      config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" },
    });
    assert.match(requestXml, /<FILTER>MeenakshiRequestedVoucher<\/FILTER>/);
    assert.match(requestXml, /Industrial Project Receivables/);
    assert.equal(result.queryMode, "targeted");
    assert.equal(result.queryBatches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
