import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
before(async () => {
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create table organizations(id uuid primary key);create table profiles(id uuid primary key);create table companies(id uuid primary key);create table tally_connectors(id uuid primary key);create table tally_connector_company_bindings(company_id uuid,connector_id uuid,is_active boolean);create table tally_check_jobs(id uuid,connector_id uuid,status text,lease_expires_at timestamptz,cancel_requested boolean,failure_reason text,finished_at timestamptz,updated_at timestamptz,locked_by text);create table tally_commands(id uuid,connector_id uuid,status text,failure_reason text,completed_at timestamptz,locked_by text,lease_expires_at timestamptz);",
  );
  await db.exec(
    await readFile(
      new URL(
        "../../../supabase/migrations/20261118115948_connector_remote_support.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
after(() => db.close());
async function fixture() {
  const org = randomUUID(),
    company = randomUUID(),
    connector = randomUUID();
  await db.query("insert into organizations values($1)", [org]);
  await db.query("insert into companies values($1)", [company]);
  await db.query("insert into tally_connectors(id) values($1)", [connector]);
  await db.query(
    "insert into tally_connector_company_bindings values($1,$2,true)",
    [company, connector],
  );
  const request = async (key) =>
    (
      await db.query(
        "insert into tally_support_jobs(organization_id,company_id,connector_id,operation,request,request_key) values($1,$2,$3,'diagnostic','{}',$4) returning *",
        [org, company, connector, key],
      )
    ).rows[0];
  const claim = async () =>
    (await db.query("select * from claim_tally_support_job($1)", [connector]))
      .rows[0];
  return { org, company, connector, request, claim };
}
test("support queue is single-flight and never automatically retries an interrupted diagnostic", async () => {
  const f = await fixture(),
    first = await f.request("a");
  await f.request("b");
  const claimed = await f.claim();
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.attempts, 1);
  assert.equal(await f.claim(), undefined);
  await db.query(
    "update tally_support_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
    [claimed.id],
  );
  const next = await f.claim();
  assert.notEqual(next.id, first.id);
  assert.equal(
    (
      await db.query("select status from tally_support_jobs where id=$1", [
        first.id,
      ])
    ).rows[0].status,
    "interrupted",
  );
});
test("a different connector cannot claim another company's operation", async () => {
  const a = await fixture(),
    b = await fixture();
  await a.request("private");
  assert.equal(await b.claim(), undefined);
});
test("update interruption retires uncertain financial commands rather than replaying them", async () => {
  const f = await fixture(),
    command = randomUUID(),
    check = randomUUID();
  await db.query(
    "insert into tally_commands(id,connector_id,status) values($1,$2,'sending')",
    [command, f.connector],
  );
  await db.query(
    "insert into tally_check_jobs(id,connector_id,status) values($1,$2,'running')",
    [check, f.connector],
  );
  await db.query("select interrupt_connector_work($1)", [f.connector]);
  assert.equal(
    (await db.query("select status from tally_commands where id=$1", [command]))
      .rows[0].status,
    "dead_letter",
  );
  assert.equal(
    (await db.query("select status from tally_check_jobs where id=$1", [check]))
      .rows[0].status,
    "cancelled",
  );
});
test("support table is not directly readable by anonymous or authenticated users", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    await assert.rejects(
      db.query("select * from tally_support_jobs"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select claim_tally_support_job($1)", [randomUUID()]),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});

test("a scoped CD refresh preserves another customer's current candidates", async () => {
  const f = await fixture();
  const columns =
    "rule_version_id source_run_id source_fingerprint evaluated_on customer_tally_guid customer_name source_sales_ledger_name invoice_tally_guid invoice_number invoice_date bill_reference net_invoice_amount implied_gross_amount amount_paid granted_discount_percentage earned_discount_percentage recovery_required already_recovered remaining_recovery missed_window_working_days missed_window_deadline next_window_working_days next_window_percentage status reason_code review_message debit_note_references candidate_kind settlement_category eligible_tonnes amount_per_tonne discount_amount segment_label";
  await db.exec(
    "create table if not exists cash_discount_recovery_candidates(id uuid primary key default gen_random_uuid(),company_id uuid,current_snapshot boolean default true," +
      columns
        .split(" ")
        .map((c) => c + " text")
        .join(",") +
      ");create table if not exists cash_discount_debit_note_postings(candidate_id uuid);create table if not exists scheme_versions(id uuid,company_id uuid,scheme_type text,cd_discount_basis text);create table if not exists evaluation_runs(id uuid,company_id uuid,status text,scheme_version_id uuid,period_start date,period_end date,source_fingerprint text,summary jsonb,error_summary text,completed_at timestamptz,locked_at timestamptz,locked_by text,lease_expires_at timestamptz,updated_at timestamptz);",
  );
  const run = randomUUID(),
    rule = randomUUID();
  await db.query("insert into evaluation_runs(id,company_id) values($1,$2)", [
    run,
    f.company,
  ]);
  await db.query(
    "insert into scheme_versions values($1,$2,'cd','amount_per_tonne')",
    [rule, f.company],
  );
  await db.query(
    "insert into cash_discount_recovery_candidates(company_id,customer_tally_guid) values($1,'selected'),($1,'unrelated')",
    [f.company],
  );
  await db.query(
    "select replace_meenakshi_cd_settlement_snapshot_scoped($1,$2,$3,'test','2025-04-01','2026-11-18','[]','{}',array['selected'])",
    [f.company, run, rule],
  );
  const remaining = (
    await db.query(
      "select customer_tally_guid,current_snapshot from cash_discount_recovery_candidates where company_id=$1",
      [f.company],
    )
  ).rows;
  assert.deepEqual(remaining, [
    { customer_tally_guid: "unrelated", current_snapshot: true },
  ]);
});
