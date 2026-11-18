import {selectedSupportCustomerGuids} from "@/lib/support-customer-scope";
import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/security";
import { bridgeVersionIsOlder } from "@/lib/bridge";
import {
  loadLiveCdLocalBootstrap,
  loadLiveTodLocalBootstrap,
  type EvaluationRunRecord,
} from "@/lib/evaluation/evidence";
import {
  saveLocalCdResult,
  saveLocalTodResult,
  type SaveScope,
} from "@/lib/evaluation/save-local-results";
import { evaluateCashDiscountSettlements } from "@/lib/evaluation/cd-settlement.mjs";
import { evaluateLocalTurnoverDiscount } from "@/lib/evaluation/support-tod.mjs";
import { validateSupportEvidence } from "@/lib/connector-support-evidence";
import { stopEvaluationRun } from "@/lib/evaluation/cancel-run";

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const SUPPORT_MINIMUM = "0.6.0";
const iso = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
export async function supportConnector(companyId: string) {
  const db = createSupabaseAdminClient();
  const { data: binding, error } = await db
    .from("tally_connector_company_bindings")
    .select(
      "connector_id,expected_tally_company_guid,expected_tally_company_name",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!binding)
    throw new SupportError(
      "Connect this company to its Tally computer first.",
      409,
    );
  const { data: connector, error: ce } = await db
    .from("tally_connectors")
    .select(
      "id,bridge_version,last_heartbeat_at,last_company_name,last_error,runtime",
    )
    .eq("id", binding.connector_id)
    .single();
  if (ce)
    throw new SupportError(
      "Connector support needs its database migration before it can be used.",
      503,
    );
  return { connector, binding };
}
export async function prepareSupportRequest(
  companyId: string,
  userId: string,
  input: Record<string, unknown>,
) {
  const operation = String(input.operation ?? "");
  if (!["diagnostic", "recalculate", "logs", "update"].includes(operation))
    throw new SupportError("Choose a supported operation.");
  const { connector } = await supportConnector(companyId);
  if (
    !connector.bridge_version ||
    bridgeVersionIsOlder(connector.bridge_version, SUPPORT_MINIMUM)
  )
    throw new SupportError(
      "Install connector 0.6.0 once to enable remote support and future in-app updates.",
      409,
    );
  const db = createSupabaseAdminClient();
  const pauseMs = Math.max(
    1000,
    Math.min(10000, Number(input.pauseMs) || 2000),
  );
  if (operation === "update")
    return { operation, connector, request: { restart: true } };
  if (operation === "logs") {
    const days = Array.isArray(input.days)
      ? input.days.filter(iso).slice(0, 7)
      : [];
    return { operation, connector, request: { days } };
  }
  if (operation === "diagnostic") {
    if (!isUuid(input.customerId)) throw new SupportError("Choose a customer.");
    const { data: c, error } = await db
      .from("customers")
      .select("id,tally_ledger_guid,ledger_name")
      .eq("company_id", companyId)
      .eq("id", input.customerId)
      .single();
    if (error || !c?.tally_ledger_guid)
      throw new SupportError("Customer ledger not found.", 404);
    const type = String(input.type || "");
    if (!["opening_balance", "vouchers", "ledger_history"].includes(type))
      throw new SupportError("Choose a supported diagnostic.");
    const from = input.dateFrom,
      to = input.dateTo ?? from;
    if (!iso(from) || !iso(to) || from > to)
      throw new SupportError("Choose a valid date range.");
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days > (type === "opening_balance" ? 0 : type === "vouchers" ? 6 : 370))
      throw new SupportError(
        "Use one opening date, at most seven days for vouchers, or one financial year for ledger history.",
      );
    for (const key of ["voucherNumber", "billReference"])
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "string" || String(input[key]).length > 160)
      )
        throw new SupportError("Invalid voucher reference.");
    return {
      operation,
      connector,
      request: {
        type,
        dateFrom: from,
        dateTo: to,
        pauseMs,
        limit: Math.max(
          1,
          Math.min(
            type === "ledger_history" ? 2000 : 100,
            Math.floor(Number(input.limit) || 100),
          ),
        ),
        voucherNumber: input.voucherNumber || null,
        billReference: input.billReference || null,
        customer: {
          id: c.id,
          tallyLedgerGuid: c.tally_ledger_guid,
          ledgerName: c.ledger_name,
        },
      },
    };
  }
  const schemeType = input.schemeType;
  if (schemeType !== "cd" && schemeType !== "tod")
    throw new SupportError("Choose CD or TOD.");
  const today = new Date().toISOString().slice(0, 10),
    asOfDate = input.asOfDate ?? today;
  if (!iso(asOfDate) || asOfDate > today)
    throw new SupportError("Choose a calculation date on or before today.");
  const customerId = input.customerId,
    groupId = input.groupId;
  if ((customerId && !isUuid(customerId)) || (groupId && !isUuid(groupId)))
    throw new SupportError("Invalid customer/group.");
  const selected = new Set<string>();
  if (customerId) selected.add(String(customerId));
  if (groupId) {
    const { data: groups, error } = await db
      .from("customer_groups")
      .select("id,parent_group_id")
      .eq("company_id", companyId);
    if (error) throw error;
    const descendants = new Set([String(groupId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of groups ?? [])
        if (descendants.has(g.parent_group_id) && !descendants.has(g.id)) {
          descendants.add(g.id);
          changed = true;
        }
    }
    const { data: customers, error: ce } = await db
      .from("customers")
      .select("id")
      .eq("company_id", companyId)
      .in("current_customer_group_id", [...descendants]);
    if (ce) throw ce;
    for (const c of customers ?? []) selected.add(c.id);
  }
  const partial = Boolean(customerId || groupId);
  if(partial&&selected.size>250)throw new SupportError("Choose a smaller customer group (at most 250 ledgers) for a targeted calculation.");
  const guids=await selectedSupportCustomerGuids(db,companyId,[...selected]);
  const synthetic: EvaluationRunRecord = {
    id: "support-preview",
    company_id: companyId,
    requested_by: userId,
    request_context: {
      schemeType,
      batch: true,
      asOfDate,
      evaluatedOn: schemeType === "cd" ? asOfDate : today,
    },
    tally_master_refresh_run_id: null,
    tally_voucher_refresh_run_id: null,
  };
  let bodies: Array<Record<string, unknown>>;
  if (schemeType === "cd") {
    if (input.save === true && asOfDate !== today)
      throw new SupportError(
        "Use today's date to refresh the normal CD results. Earlier dates are available as diagnostic runs.",
      );
    const bootstrap = await loadLiveCdLocalBootstrap(
      synthetic,
      typeof input.ruleVersionId === "string" ? input.ruleVersionId : null,
    );
    const scope = bootstrap.voucherScope as Record<string, unknown> & {
      customers: Array<{ customerId: string }>;
    };
    const cs = scope.customers.filter(
      (c) => !partial || guids.has(c.customerId),
    );
    if (partial && cs.length > 250)
      throw new SupportError(
        "Choose a smaller customer group (at most 250 ledgers) for a targeted calculation.",
      );
    if (!cs.length)
      throw new SupportError("No selected customer belongs to this CD rule.");
    if (input.save === true && partial) {
      const { data: prior } = await db
        .from("evaluation_runs")
        .select("summary")
        .eq("company_id", companyId)
        .eq("status", "completed")
        .eq("summary->>cdDiscountBasis", "amount_per_tonne")
        .order("completed_at", { ascending: false })
        .limit(1);
      if (Number(prior?.[0]?.summary?.evidenceSchemaVersion) !== 2)
        throw new SupportError(
          "Run one full CD check with connector 0.6.0 before saving a partial refresh. A diagnostic run is available now.",
          409,
        );
    }
    bodies = [
      {
        ...bootstrap,
        voucherScope: {
          ...scope,
          customers: cs,
          diagnosticTargeted: partial,
          chunkDays: 7,
          pauseMs,
        },
        customerScope: partial ? cs.map((c) => c.customerId) : null,
      },
    ];
  } else {
    const bootstrap = await loadLiveTodLocalBootstrap(synthetic);
    bodies = bootstrap.batches
      .map((b) => ({
        ...b,
        evaluatedOn: today,
        customers: b.customers.filter(
          (c) => !partial || selected.has(c.customerId),
        ),
        voucherScope: {
          ...b.voucherScope,
          customers: b.customers.filter(
            (c) => !partial || selected.has(c.customerId),
          ),
          diagnosticTargeted: partial,
          chunkDays: 7,
          pauseMs,
        },
      }))
      .filter((b) => b.customers.length > 0);
    if (
      partial &&
      bodies.some(
        (body) =>
          (body.voucherScope as { customers: unknown[] }).customers.length >
          250,
      )
    )
      throw new SupportError(
        "Choose a smaller customer group (at most 250 ledgers) for a targeted calculation.",
      );
    if (!bodies.length)
      throw new SupportError("No selected customer belongs to the TOD period.");
  }
  const baseline: Array<Record<string, unknown>> = [];
  if (schemeType === "cd") {
    const { data: prior } = await db
      .from("evaluation_runs")
      .select("summary")
      .eq("company_id", companyId)
      .eq("status", "completed")
      .eq("scheme_version_id", (bodies[0].rule as { id: string }).id)
      .eq("summary->>cdDiscountBasis", "amount_per_tonne")
      .order("completed_at", { ascending: false })
      .limit(1);
    const summary = prior?.[0]?.summary ?? {};
    for (const r of [
      ...(summary.settlementResults ?? []),
      ...(summary.excludedInvoices ?? []),
    ])
      if (!partial || guids.has(r.customerId))
        baseline.push({
          key: r.invoiceGuid,
          status: r.status,
          amount: r.creditAmount ?? "0",
          paidByDeadline: r.paidByDeadline,
          onAccountCreditUsed: r.onAccountCreditUsed,
        });
  } else {
    for (const body of bodies) {
      const { data: prior, error } = await db
        .from("discount_proposals")
        .select("customer_id,status,calculated_discount_amount")
        .eq("company_id", companyId)
        .eq("scheme_type", "tod")
        .eq("period_start", body.periodStart)
        .eq("period_end", body.periodEnd)
        .limit(10000);
      if (error) throw error;
      for (const r of prior ?? [])
        if (!partial || selected.has(r.customer_id))
          baseline.push({
            key: r.customer_id + ":" + body.periodStart,
            status: r.status,
            amount: String(r.calculated_discount_amount ?? 0),
          });
    }
  }
  return {
    operation,
    connector,
    request: {
      schemeType,
      asOfDate,
      save: input.save === true,
      pauseMs,
      bodies,
      partial,
      baseline,
    },
  };
}
type SupportJob = {
  id: string;
  organization_id: string;
  company_id: string;
  requested_by: string;
  request: {
    bodies: Array<Record<string, unknown>>;
    schemeType: string;
    asOfDate: string;
    save: boolean;
    baseline?: Array<Record<string, unknown>>;
  };
};
export async function finishSupportCalculation(
  job: SupportJob,
  raw: Record<string, unknown>,
) {
  const calculations = raw.calculations;
  if (
    !Array.isArray(calculations) ||
    calculations.length !== job.request.bodies.length
  )
    throw new SupportError(
      "The connector returned incomplete calculation evidence.",
    );
  const results = [];
  for (let index = 0; index < calculations.length; index++) {
    const body = job.request.bodies[index],
      calculation = calculations[index];
    if (!calculation?.evidence)
      throw new SupportError("Calculation evidence is missing.");
    calculation.evidence = validateSupportEvidence(
      body,
      calculation.evidence,
      job.request.schemeType,
    );
    if (job.request.schemeType === "cd") {
      if (calculation.evidence.creditNoteMatchingVersion !== 1)
        throw new SupportError(
          "The connector did not check manual Credit Notes.",
        );
      calculation.evidence.customerScope = body.customerScope ?? null;
      const computed = evaluateCashDiscountSettlements(
        body.rule as Parameters<typeof evaluateCashDiscountSettlements>[0],
        String(body.evaluatedOn),
        calculation.evidence.invoices,
        calculation.evidence.customerCredits ?? [],
      );
      results.push({ ...calculation, ...computed });
    } else {
      const computed = evaluateLocalTurnoverDiscount(
        body.rule as Parameters<typeof evaluateLocalTurnoverDiscount>[0],
        String(body.evaluatedOn),
        String(body.periodStart),
        String(body.periodEnd),
        calculation.evidence.customerAggregates,
      );
      results.push({ ...calculation, ...computed });
    }
  }
  let saved = null;
  if (job.request.save) {
    const db = createSupabaseAdminClient();
    const { data: members, error } = await db
      .from("organization_memberships")
      .select("role")
      .eq("organization_id", job.organization_id)
      .eq("profile_id", job.requested_by);
    if (error) throw error;
    const roles = (members ?? []).map((r) => r.role);
    if (!roles.some((r) => ["administrator", "finance_approver"].includes(r)))
      throw new SupportError(
        "The requesting user can no longer save calculations.",
        403,
      );
    const scope: SaveScope = {
      userId: job.requested_by,
      roles,
      organization: { id: job.organization_id },
      company: { id: job.company_id },
    };
    const savedRuns = [];
    if (job.request.schemeType === "cd") {
      const answer = await saveLocalCdResult(
        scope,
        {
          evaluatedOn: job.request.bodies[0].evaluatedOn,
          evidence: results[0].evidence,
        },
        "support:" + job.id + ":0",
      );
      savedRuns.push(answer.evaluationRun.id);
    } else {
      const periods = new Set(
        job.request.bodies.map(
          (body) => body.periodStart + ":" + body.periodEnd,
        ),
      );
      if (periods.size !== 1)
        throw new SupportError(
          "Save one TOD period at a time. Captured evidence remains available.",
        );
      const first = results[0].evidence;
      const evidence = {
        ...first,
        customerAggregates: results.flatMap(
          (r) => r.evidence.customerAggregates,
        ),
        sourceFingerprint: results
          .map((r) => r.evidence.sourceFingerprint)
          .join(":"),
        chunks: results.reduce((n, r) => n + r.evidence.chunks, 0),
        vouchersScanned: results.reduce(
          (n, r) => n + r.evidence.vouchersScanned,
          0,
        ),
      };
      const key = "support:" + job.id + ":0";
      const { data: active, error } = await db
        .from("evaluation_runs")
        .select("id")
        .eq("company_id", job.company_id)
        .eq("request_context->>schemeType", "tod")
        .in("status", ["queued", "refreshing_tally", "evaluating"])
        .neq("idempotency_key", key)
        .limit(1);
      if (error) throw error;
      if (active?.length)
        throw new SupportError(
          "Another TOD save is still processing. Retry saving this captured evidence when it finishes.",
          409,
        );
      const answer = await saveLocalTodResult(
        scope,
        {
          asOfDate: job.request.asOfDate,
          evaluatedOn: job.request.bodies[0].evaluatedOn,
          evidence,
        },
        key,
      );
      savedRuns.push(answer.evaluationRun.id);
    }
    saved = { evaluationRunIds: savedRuns };
  }
  const baseline = new Map((job.request.baseline ?? []).map((r) => [r.key, r]));
  const comparison = [];
  for (let i = 0; i < results.length; i++)
    for (const row of results[i].results ?? results[i].rows ?? []) {
      const key =
        job.request.schemeType === "cd"
          ? row.invoiceGuid
          : row.customerId + ":" + job.request.bodies[i].periodStart;
      const before = baseline.get(key) as Record<string, unknown> | undefined;
      const after = {
        status: row.status,
        amount: String(row.creditAmount ?? row.calculatedDiscountAmount ?? "0"),
        paidByDeadline: row.paidByDeadline,
        onAccountCreditUsed: row.onAccountCreditUsed,
      };
      if (
        !before ||
        before.status !== after.status ||
        Number(before.amount) !== Number(after.amount) ||
        before.paidByDeadline !== after.paidByDeadline ||
        before.onAccountCreditUsed !== after.onAccountCreditUsed
      )
        comparison.push({
          key,
          invoiceNumber: row.invoiceNumber ?? null,
          customerName: row.customerName ?? row.customerLedgerName ?? null,
          before: before ?? null,
          after,
        });
    }
  return {
    calculations: results,
    saved,
    comparison,
    source: "connector_support",
    calculationVersion: 2,
  };
}
export const newSupportKey = () => randomUUID();

export async function interruptConnectorWork(connectorId: string) {
  const db = createSupabaseAdminClient();
  const { data: commands, error: ce } = await db
    .from("tally_commands")
    .select("company_id,payload")
    .eq("connector_id", connectorId)
    .in("status", ["sending", "accepted"]);
  if (ce) throw ce;
  const { error } = await db.rpc("interrupt_connector_work", {
    p_connector_id: connectorId,
  });
  if (error) throw error;
  const { error: se } = await db
    .from("tally_support_jobs")
    .update({
      status: "interrupted",
      cancel_requested: true,
      lease_expires_at: null,
      finished_at: new Date().toISOString(),
      error: "Interrupted by connector update. Start a new operation.",
    })
    .eq("connector_id", connectorId)
    .neq("operation", "update")
    .in("status", ["queued", "running"]);
  if (se) throw se;
  for (const command of commands ?? []) {
    const payload = command.payload ?? {};
    if (isUuid(payload.syncRunId)) {
      const { error } = await db
        .from("tally_sync_runs")
        .update({
          status: "failed",
          error_summary: "Interrupted by connector update.",
          completed_at: new Date().toISOString(),
        })
        .eq("company_id", command.company_id)
        .eq("id", payload.syncRunId)
        .in("status", ["queued", "running"]);
      if (error) throw error;
    }
    if (isUuid(payload.evaluationRunId))
      await stopEvaluationRun({
        companyId: command.company_id,
        runId: payload.evaluationRunId,
        status: "cancelled",
        message: "Interrupted by connector update. Run the check again.",
      });
  }
}

export async function recoverSupportSaves(companyId: string) {
  const { error } = await createSupabaseAdminClient()
    .from("tally_support_jobs")
    .update({
      status: "failed",
      lease_expires_at: null,
      error:
        "Saving was interrupted. Replay or retry the captured evidence without reading Tally.",
    })
    .eq("company_id", companyId)
    .eq("status", "received")
    .lt("lease_expires_at", new Date().toISOString());
  if (error) throw error;
}
