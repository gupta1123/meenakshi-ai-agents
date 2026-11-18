import { recordRuntimeRead } from "../runtime-status.mjs";
import Decimal from "decimal.js";
import {
  buildCollectionExportXml,
  extractBlocks,
  getAttribute,
  getTagText,
  postTallyXml,
} from "../tally/xml.mjs";
import { parseVouchers } from "../tally/vouchers.mjs";

export const SUPPORT_PROTOCOL = 1;
export const SUPPORT_CAPABILITIES = [
  "opening_balance",
  "vouchers",
  "ledger_history",
  "logs",
  "recalculate",
  "file_updates",
];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const quoted = (v) =>
  '"' + String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const normalized = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();
const addDays = (v, n) =>
  new Date(Date.parse(v + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

export function validateDiagnostic(input) {
  if (
    !input ||
    !["opening_balance", "vouchers", "ledger_history"].includes(input.type)
  )
    throw new Error(
      "Choose an opening balance, voucher or ledger-history read.",
    );
  if (!input.customer?.ledgerName || !input.customer?.tallyLedgerGuid)
    throw new Error("A verified customer ledger is required.");
  if (
    !datePattern.test(input.dateFrom) ||
    !datePattern.test(input.dateTo) ||
    input.dateFrom > input.dateTo
  )
    throw new Error("A valid date range is required.");
  const days =
    (Date.parse(input.dateTo) - Date.parse(input.dateFrom)) / 86400000;
  if (
    days >
    (input.type === "ledger_history"
      ? 370
      : input.type === "opening_balance"
        ? 0
        : 6)
  )
    throw new Error("The requested read period is too large.");
  const pauseMs = Math.max(
    1000,
    Math.min(10000, Number(input.pauseMs) || 2000),
  );
  const limit = Math.max(
    1,
    Math.min(
      input.type === "ledger_history" ? 2000 : 100,
      Math.floor(Number(input.limit) || 100),
    ),
  );
  return { ...input, pauseMs, limit };
}

export async function runDiagnostic(input, context, deps = {}) {
  const request = validateDiagnostic(input);
  const post = deps.post ?? postTallyXml;
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cancelled = () => {
    if (context.isCancelled?.()) throw new Error("Diagnostic stopped.");
  };
  const customer = { ...request.customer };
  cancelled();
  if (request.type === "opening_balance") {
    const xml = buildCollectionExportXml({
      collectionName: "Meenakshi Support Opening Bills",
      tallyType: "Ledger",
      companyName: context.activeCompany.name,
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      fetchFields:
        "Name,GUID,OpeningBalance,BillAllocations.Name,BillAllocations.OpeningBalance,BillAllocations.BillDate,BillAllocations.BillType",
      formulae: [
        {
          name: "MeenakshiSupportLedger",
          formula: "$$IsEqual:$GUID:" + quoted(customer.tallyLedgerGuid),
        },
      ],
      filterNames: ["MeenakshiSupportLedger"],
    });
    const response = await post(context.config.tallyUrl, xml, {
      timeoutMs: 15000,
      operation: "Read one customer's opening bills",
    });
    recordRuntimeRead();
    cancelled();
    const block = extractBlocks(response, "LEDGER").find(
      (b) =>
        normalized(getTagText(b, "GUID")) ===
        normalized(customer.tallyLedgerGuid),
    );
    if (!block)
      return {
        type: request.type,
        found: false,
        complete: true,
        customer,
        asOf: request.dateFrom,
      };
    const bills = extractBlocks(block, "BILLALLOCATIONS.LIST");
    let root = block;
    for (const bill of bills) root = root.replace(bill, "");
    const amount = (xml) =>
      new Decimal(
        String(getTagText(xml, "OPENINGBALANCE") || "0").replace(
          /[^0-9.-]/g,
          "",
        ) || 0,
      );
    const opening = amount(root);
    const openingBills = bills.map((b) => ({
      billReference: getTagText(b, "NAME"),
      date: getTagText(b, "BILLDATE"),
      type: getTagText(b, "BILLTYPE"),
      signedAmount: amount(b).toFixed(2),
    }));
    const billTotal = bills.reduce((n, b) => n.plus(amount(b)), new Decimal(0));
    return {
      type: request.type,
      found: true,
      complete: true,
      customer: {
        ...customer,
        ledgerName:
          getAttribute(block.slice(0, block.indexOf(">") + 1), "NAME") ||
          customer.ledgerName,
      },
      asOf: request.dateFrom,
      signConvention: "Positive is credit; negative is debit.",
      ledgerOpening: opening.toFixed(2),
      openingBillsTotal: billTotal.toFixed(2),
      unallocatedOpeningCredit: opening.minus(billTotal).toFixed(2),
      openingBills,
      readCount: 1,
    };
  }
  const ledger = await runDiagnostic(
    { ...request, type: "opening_balance", dateTo: request.dateFrom },
    context,
    deps,
  );
  if (!ledger.found)
    return {
      type: request.type,
      found: false,
      complete: true,
      customer,
      rows: [],
      readCount: 1,
    };
  customer.ledgerName = ledger.customer.ledgerName;
  await pause(request.pauseMs);
  const rows = [];
  let readCount = 1,
    cursor = request.dateFrom,
    complete = true;
  while (cursor <= request.dateTo) {
    cancelled();
    const end = [addDays(cursor, 6), request.dateTo].sort()[0];
    const xml = buildCollectionExportXml({
      collectionName: "Meenakshi Support Vouchers",
      tallyType: "Voucher",
      companyName: context.activeCompany.name,
      dateFrom: cursor,
      dateTo: end,
      fetchFields:
        "Date,VoucherTypeName,VoucherNumber,GUID,PartyLedgerName,PartyLedgerGUID,IsCancelled,IsOptional,VoucherAmount,Amount,Narration,AllLedgerEntries.LedgerName,AllLedgerEntries.LedgerGUID,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount,AllLedgerEntries.BillAllocations.TargetVoucherGUID,LedgerEntries.LedgerName,LedgerEntries.Amount,LedgerEntries.BillAllocations.Name,LedgerEntries.BillAllocations.BillType,LedgerEntries.BillAllocations.Amount",
      formulae: [
        {
          name: "MeenakshiSupportParty",
          formula: "$$IsEqual:$LedgerName:" + quoted(customer.ledgerName),
        },
        {
          name: "MeenakshiSupportVoucher",
          formula: "$$FilterCount:AllLedgerEntries:MeenakshiSupportParty > 0",
        },
      ],
      filterNames: ["MeenakshiSupportVoucher"],
    });
    const xmlResult = await post(context.config.tallyUrl, xml, {
      timeoutMs: 15000,
      operation: "Read one customer's vouchers",
    });
    recordRuntimeRead();
    readCount++;
    cancelled();
    const vouchers = parseVouchers(xmlResult);
    for (const voucher of vouchers) {
      // Enforce the customer/date scope again if a Tally version ignores a filter.
      const entries=voucher.sourcePayload?.ledgerEntries??[];
      const names=[voucher.partyLedgerName,...entries.map(e=>e.ledgerName)].map(normalized);
      const guids=[voucher.partyLedgerGuid,...entries.map(e=>e.ledgerGuid)].map(normalized);
      if(!guids.includes(normalized(customer.tallyLedgerGuid))&&!names.includes(normalized(customer.ledgerName)))continue;
      if(voucher.voucherDate<cursor||voucher.voucherDate>end)continue;
      if (
        request.voucherNumber &&
        normalized(voucher.voucherNumber) !== normalized(request.voucherNumber)
      )
        continue;
      if (
        request.billReference &&
        !voucher.billAllocations.some(
          (a) =>
            normalized(a.billReference) === normalized(request.billReference),
        ) &&
        normalized(voucher.voucherNumber) !== normalized(request.billReference)
      )
        continue;
      rows.push({
        tallyGuid: voucher.guid,
        number: voucher.voucherNumber,
        date: voucher.voucherDate,
        kind: voucher.voucherKind,
        status: voucher.status,
        amount: voucher.grossAmount,
        narration: voucher.narration,
        allocations: voucher.billAllocations,
        ledgerEntries: voucher.sourcePayload?.ledgerEntries ?? [],
      });
      if (rows.length >= request.limit) {
        complete = false;
        break;
      }
    }
    context.onProgress?.({
      stage: "reading",
      dateFrom: cursor,
      dateTo: end,
      readCount,
      rows: rows.length,
    });
    if (!complete) break;
    cursor = addDays(end, 1);
    if (cursor <= request.dateTo) await pause(request.pauseMs);
  }
  return {
    type: request.type,
    customer,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    complete,
    limitReached: !complete,
    readCount,
    rows,
  };
}

/** Resolve targeted ledger names by identity; missing ledgers fail the calculation. */
export async function resolveSupportCustomers(customers, context, deps = {}) {
  const post = deps.post ?? postTallyXml,
    pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const resolved = [];
  for (let index = 0; index < customers.length; index += 25) {
    if (context.isCancelled?.()) throw new Error("Calculation stopped.");
    const batch = customers.slice(index, index + 25);
    const response = await post(
      context.config.tallyUrl,
      buildCollectionExportXml({
        collectionName: "Support Ledger Identities",
        tallyType: "Ledger",
        companyName: context.activeCompany.name,
        fetchFields: "Name,GUID",
        formulae: [
          {
            name: "SupportLedgerIdentity",
            formula: batch
              .map(
                (c) =>
                  "($$IsEqual:$GUID:" +
                  quoted(c.tallyLedgerGuid || c.customerId) +
                  ")",
              )
              .join(" OR "),
          },
        ],
        filterNames: ["SupportLedgerIdentity"],
      }),
      { timeoutMs: 15000, operation: "Resolve selected customer ledgers" },
    );
    recordRuntimeRead();
    const names = new Map(
      extractBlocks(response, "LEDGER").map((block) => [
        normalized(getTagText(block, "GUID")),
        getAttribute(block.slice(0, block.indexOf(">") + 1), "NAME"),
      ]),
    );
    for (const customer of batch) {
      const name = names.get(
        normalized(customer.tallyLedgerGuid || customer.customerId),
      );
      if (!name)
        throw new Error(
          "Selected ledger was not returned by Tally: " +
            customer.ledgerName +
            ". No result was saved.",
        );
      resolved.push({ ...customer, ledgerName: name });
    }
    context.onProgress?.({
      stage: "verifying_ledgers",
      done: resolved.length,
      total: customers.length,
    });
    await pause(context.pauseMs ?? 2000);
  }
  return resolved;
}
