import test from "node:test";
import assert from "node:assert/strict";
import {
  runDiagnostic,
  validateDiagnostic,
  resolveSupportCustomers,
} from "../src/support/diagnostics.mjs";
import { processSupportJob } from "../src/support/client.mjs";
const customer = {
  id: "customer",
  ledgerName: "Old ledger name",
  tallyLedgerGuid: "ledger-guid",
};
const context = {
  config: { tallyUrl: "http://localhost:9000" },
  activeCompany: { name: "Fixture company", guid: "company-guid" },
};
const ledger =
  '<ENVELOPE><LEDGER NAME="Renamed BKC"><GUID>ledger-guid</GUID><OPENINGBALANCE>15806.00</OPENINGBALANCE><BILLALLOCATIONS.LIST><NAME>Old bill</NAME><OPENINGBALANCE>-1573.00</OPENINGBALANCE></BILLALLOCATIONS.LIST></LEDGER></ENVELOPE>';
test("opening diagnostic separates net ledger balance from bill-wise and unallocated credit", async () => {
  const calls = [];
  const result = await runDiagnostic(
    {
      type: "opening_balance",
      customer,
      dateFrom: "2025-04-01",
      dateTo: "2025-04-01",
    },
    context,
    {
      post: async (...args) => {
        calls.push(args);
        return ledger;
      },
    },
  );
  assert.equal(result.ledgerOpening, "15806.00");
  assert.equal(result.openingBillsTotal, "-1573.00");
  assert.equal(result.unallocatedOpeningCredit, "17379.00");
  assert.equal(result.customer.ledgerName, "Renamed BKC");
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /OpeningBalance/);
  assert.equal(calls[0][2].timeoutMs, 15000);
});
test("unknown ledger is reported as missing rather than a zero balance", async () => {
  const result = await runDiagnostic(
    {
      type: "opening_balance",
      customer,
      dateFrom: "2025-04-01",
      dateTo: "2025-04-01",
    },
    context,
    { post: async () => "<ENVELOPE/>" },
  );
  assert.equal(result.found, false);
  assert.equal(result.ledgerOpening, undefined);
});
test("large scopes are refused and every history window is paced", async () => {
  assert.throws(
    () =>
      validateDiagnostic({
        type: "vouchers",
        customer,
        dateFrom: "2025-04-01",
        dateTo: "2025-05-01",
      }),
    /too large/,
  );
  const calls = [],
    pauses = [];
  const result = await runDiagnostic(
    {
      type: "ledger_history",
      customer,
      dateFrom: "2025-04-01",
      dateTo: "2025-04-20",
      pauseMs: 5000,
    },
    context,
    {
      post: async (url, xml) => {
        calls.push(xml);
        return xml.includes("Support Opening") ? ledger : "<ENVELOPE/>";
      },
      pause: async (ms) => pauses.push(ms),
    },
  );
  assert.equal(result.readCount, 4);
  assert.deepEqual(pauses, [5000, 5000, 5000]);
  assert.ok(calls.slice(1).every((xml) => xml.includes("Renamed BKC")));
  assert.equal(result.complete, true);
});
test("wrong-company support operations never reach Tally", async () => {
  let reads = 0;
  const actions = [];
  const api = async (c, p, body) => {
    if (!body)
      return {
        job: {
          id: "job",
          operation: "diagnostic",
          attempts: 1,
          expectedTallyCompany: { guid: "different" },
          request: {},
        },
      };
    actions.push(body);
    return {};
  };
  await processSupportJob(
    {},
    context.activeCompany,
    {},
    {
      api,
      diagnostic: async () => {
        reads++;
      },
    },
  );
  assert.equal(reads, 0);
  assert.equal(actions[0].action, "fail");
  assert.match(actions[0].error, /approved Tally company/);
});
test("support reads finish in the dedicated queue without invoking synchronization", async () => {
  const actions = [];
  let count = 0;
  const api = async (c, p, body) => {
    if (!body)
      return {
        job: {
          id: "job",
          operation: "diagnostic",
          attempts: 1,
          expectedTallyCompany: { guid: "company-guid" },
          request: {},
        },
      };
    actions.push(body);
    return {};
  };
  await processSupportJob(
    {},
    context.activeCompany,
    {},
    {
      api,
      diagnostic: async () => {
        count++;
        return { found: true };
      },
    },
  );
  assert.equal(count, 1);
  assert.equal(actions.at(-1).action, "finish");
  assert.deepEqual(actions.at(-1).result, { found: true });
});

test("targeted recalculation resolves renamed ledgers and fails if a selected ledger is missing",async()=>{
 const input=[{customerId:"ledger-guid",ledgerName:"Old name"}];
 const deps={post:async()=>'<ENVELOPE><LEDGER NAME="Current name"><GUID>ledger-guid</GUID></LEDGER></ENVELOPE>',pause:async()=>{}};
 const rows=await resolveSupportCustomers(input,context,deps);
 assert.equal(rows[0].ledgerName,"Current name");assert.equal(input[0].ledgerName,"Old name");
 await assert.rejects(resolveSupportCustomers(input,context,{...deps,post:async()=>"<ENVELOPE/>"}),/No result was saved/);
});
