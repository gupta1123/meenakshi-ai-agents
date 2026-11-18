"use client";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, jsonBody } from "@/lib/api";
import { Button, InlineMessage } from "./ui";
import s from "./connector-support.module.css";
type Customer = { id: string; ledger_name: string };
type RuleChoice = { id: string; name: string; versionNumber: number };
type Group = { id: string; name: string };
type Runtime = {
  mode?: string;
  version?: string;
  pid?: number;
  startedAt?: string;
  activity?: string;
  reportedAt?: string;
  lastTallyReadAt?: string;
  windowsUser?: string;
  capabilities?: string[];
  startup?: { enabled?: boolean; state?: string };
};
type Job = {
  id: string;
  operation: string;
  status: string;
  request: { schemeType?: string; type?: string; save?: boolean };
  error?: string;
  created_at: string;
  result?: Result;
  progress?: Record<string, unknown>;
};
type Result = {
  type?: string;
  found?: boolean;
  ledgerOpening?: string;
  openingBillsTotal?: string;
  unallocatedOpeningCredit?: string;
  openingBills?: Array<{
    billReference: string;
    signedAmount: string;
    date: string;
  }>;
  rows?: Voucher[];
  complete?: boolean;
  calculations?: Array<{
    results?: CalcRow[];
    rows?: CalcRow[];
    totals?: Record<string, unknown>;
  }>;
  comparison?: Array<{
    key: string;
    invoiceNumber?: string;
    customerName?: string;
    before?: { status?: string; amount?: string };
    after: { status?: string; amount?: string };
  }>;
  saved?: { evaluationRunIds: string[] };
  logs?: string;
};
type Voucher = {
  tallyGuid: string;
  number: string;
  date: string;
  kind: string;
  amount: string;
  narration: string;
  allocations: Array<{
    billReference?: string;
    allocationType?: string;
    allocatedAmount?: string;
  }>;
};
type CalcRow = {
  windowDeadline?: string;
  onAccountCreditAvailable?: string;
  discountedTarget?: string;
  eligibleTonnes?: string;
  payments?: Array<{
    date: string;
    amount: string;
    counted: boolean;
    voucherNumber?: string;
  }>;
  creditNoteReferences?: Array<{
    voucherNumber?: string;
    amount: string;
    purpose: string;
  }>;
  paymentChecks?: Array<{
    voucherNumber?: string;
    invoiceDate: string;
    counted: boolean;
    reason: string;
    paidByDueDate: string;
  }>;
  invoiceGuid?: string;
  invoiceNumber?: string;
  customerName?: string;
  status: string;
  category?: string;
  invoiceAmount?: string;
  paidByDeadline?: string;
  creditAmount?: string;
  calculatedDiscountAmount?: string;
  onAccountCreditUsed?: string;
  reviewMessage?: string;
};
type Overview = {
  connector: {
    id: string;
    bridge_version: string;
    last_heartbeat_at: string;
    last_company_name?: string;
    last_error?: string;
    runtime: Runtime;
  };
  jobs: Job[];
};
const today = () => new Date().toISOString().slice(0, 10);
const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export function ConnectorSupportPanel({
  companyId,
  getToken,
}: {
  companyId: string;
  getToken: () => Promise<string | null>;
}) {
  const [overview, setOverview] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("opening_balance"),
    [search, setSearch] = useState(""),
    [customers, setCustomers] = useState<Customer[]>([]),
    [groups, setGroups] = useState<Group[]>([]);
  const [customerId, setCustomerId] = useState(""),
    [groupId, setGroupId] = useState(""),
    [dateFrom, setDateFrom] = useState(today()),
    [dateTo, setDateTo] = useState(today());
  const [reference, setReference] = useState(""),
    [pauseMs, setPauseMs] = useState("2000"),
    [save, setSave] = useState(false),
    [selected, setSelected] = useState<Job | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [filter, setFilter] = useState("");
  const [rules, setRules] = useState<RuleChoice[]>([]),
    [ruleVersionId, setRuleVersionId] = useState("");
  const base = "/api/companies/" + companyId + "/connector-support";
  const call = useCallback(
    async <T,>(path: string, body?: unknown) => {
      const token = await getToken();
      if (!token) throw new Error("Sign in to use connector support.");
      return apiRequest<T>(
        token,
        path,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              body: jsonBody(body),
              headers: { "Idempotency-Key": crypto.randomUUID() },
              timeoutMs: 120000,
            },
      );
    },
    [getToken],
  );
  const refresh = useCallback(async () => {
    try {
      setOverview(await call<Overview>(base));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load support.");
    }
  }, [call, base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (
      !overview?.jobs.some((j) =>
        ["queued", "running", "received"].includes(j.status),
      )
    )
      return;
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [overview, refresh]);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      void call<{
        masters: { customers: Customer[]; customerGroups: Group[] };
      }>(
        "/api/companies/" +
          companyId +
          "/rulebook/reference-data?q=" +
          encodeURIComponent(search) +
          "&limit=50",
      )
        .then((r) => {
          if (disposed) return;
          setCustomers(r.masters.customers);
          if (!search) setGroups(r.masters.customerGroups);
        })
        .catch(() => {});
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [call, companyId, search]);
  useEffect(() => {
    void call<{ rules: RuleChoice[] }>(
      "/api/companies/" + companyId + "/evaluations/cd/rules",
    )
      .then((r) => setRules(r.rules))
      .catch(() => {});
  }, [call, companyId]);
  const calculate = operation === "cd" || operation === "tod",
    maintenance = operation === "update" || operation === "logs";
  const open = useCallback(
    async (id: string) => {
      try {
        const r = await call<{ job: Job }>(base + "/" + id);
        setSelected(r.job);
        setResult(r.job.result ?? null);
        setError("");
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [base, call],
  );
  useEffect(() => {
    if (!selected) return;
    const latest = overview?.jobs.find((job) => job.id === selected.id);
    if (latest && latest.status !== selected.status) void open(selected.id);
  }, [overview, selected, open]);
  useEffect(() => {
    setSelected(null);
    setResult(null);
    setCustomerId("");
    setGroupId("");
  }, [companyId]);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      if (!calculate && !maintenance && !customerId)
        throw new Error("Select the customer ledger first.");
      const body = calculate
        ? {
            operation: "recalculate",
            schemeType: operation,
            ruleVersionId: ruleVersionId || undefined,
            customerId: customerId || undefined,
            groupId: groupId || undefined,
            asOfDate: dateTo,
            pauseMs: Number(pauseMs),
            save,
          }
        : maintenance
          ? { operation }
          : {
              operation: "diagnostic",
              type: operation,
              customerId,
              dateFrom,
              dateTo: operation === "opening_balance" ? dateFrom : dateTo,
              billReference: reference || undefined,
              pauseMs: Number(pauseMs),
            };
      const r = await call<{ job: Job }>(base, body);
      await refresh();
      await open(r.job.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changeJob = async (job: Job, action: string) => {
    setBusy(true);
    try {
      const r = await call<{ result?: Result }>(base + "/" + job.id, {
        action,
      });
      if (r.result) setResult(r.result);
      else await open(job.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runtime = overview?.connector.runtime ?? {},
    heartbeat = overview?.connector.last_heartbeat_at;
  const online = heartbeat && Date.now() - Date.parse(heartbeat) < 90000;
  const rows = (result?.calculations ?? [])
    .flatMap((c) => c.results ?? c.rows ?? [])
    .filter(
      (r) =>
        !filter ||
        JSON.stringify([r.invoiceNumber, r.customerName])
          .toLowerCase()
          .includes(filter.toLowerCase()),
    );
  return (
    <section className={s.root} aria-label="Remote connector support">
      <h3>Remote connector support</h3>
      <p>
        Inspect Tally evidence, compare calculations and manage this
        company&apos;s connector.
      </p>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <dl className={s.runtime}>
        <dt>Connection</dt>
        <dd>{online ? "Online" : "Not recently verified"}</dd>
        <dt>Running version</dt>
        <dd>{overview?.connector.bridge_version ?? "Unknown"}</dd>
        <dt>Actual mode</dt>
        <dd>{runtime.mode ?? "Not reported"}</dd>
        <dt>Background startup</dt>
        <dd>
          {runtime.startup?.enabled === true
            ? "Enabled"
            : runtime.startup?.enabled === false
              ? "Disabled"
              : "Not reported"}
        </dd>
        <dt>Tally company</dt>
        <dd>{overview?.connector.last_company_name ?? "Not reported"}</dd>
        <dt>Background process</dt>
        <dd>{runtime.pid ? "PID " + runtime.pid : "Not reported"}</dd>
        <dt>Windows user</dt>
        <dd>{runtime.windowsUser ?? "Not reported"}</dd>
        <dt>Last calculation / diagnostic read</dt>
        <dd>
          {runtime.lastTallyReadAt
            ? new Date(runtime.lastTallyReadAt).toLocaleString()
            : "Not reported"}
        </dd>
        <dt>Supported operations</dt>
        <dd>{runtime.capabilities?.join(", ") || "Not reported"}</dd>
        <dt>Recent connection error</dt>
        <dd>{overview?.connector.last_error || "None reported"}</dd>
        <dt>Activity</dt>
        <dd>{runtime.activity ?? "Not reported"}</dd>
      </dl>
      <div className={s.grid}>
        <label>
          Operation
          <select
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value);
              setSave(false);
            }}
          >
            <option value="opening_balance">
              Opening balance and opening bills
            </option>
            <option value="vouchers">Vouchers - up to 7 days</option>
            <option value="ledger_history">
              Customer ledger history - paced
            </option>
            <option value="cd">Cash Discount recalculation</option>
            <option value="tod">Turnover Discount recalculation</option>
            <option value="logs">Collect connector logs</option>
            <option value="update">Update connector remotely</option>
          </select>
        </label>
        {operation === "cd" && (
          <label>
            Cash Discount rule
            <select
              value={ruleVersionId}
              onChange={(e) => setRuleVersionId(e.target.value)}
            >
              <option value="">Default active rule</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} (version {r.versionNumber})
                </option>
              ))}
            </select>
          </label>
        )}
        {!maintenance && (
          <>
            <label>
              Find customer
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Type a ledger name"
              />
            </label>
            <label>
              Customer
              <select
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setGroupId("");
                }}
              >
                <option value="">
                  {calculate ? "All eligible customers" : "Choose customer"}
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.ledger_name}
                  </option>
                ))}
              </select>
            </label>
            {calculate && (
              <label>
                Customer group
                <select
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    setCustomerId("");
                  }}
                >
                  <option value="">All covered groups</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!calculate && (
              <label>
                {operation === "opening_balance"
                  ? "Books opening date"
                  : "From"}
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </label>
            )}
            {operation !== "opening_balance" && (
              <label>
                {calculate ? "Date within calculation period" : "To"}
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </label>
            )}
            {!calculate && operation !== "opening_balance" && (
              <label>
                Invoice / bill reference (optional)
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            )}
            <label>
              Pause between reads
              <select
                value={pauseMs}
                onChange={(e) => setPauseMs(e.target.value)}
              >
                <option value="2000">2 seconds</option>
                <option value="5000">5 seconds</option>
                <option value="10000">10 seconds</option>
              </select>
            </label>
          </>
        )}
      </div>
      {calculate && (
        <>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
            />
            Save to the normal calculation results
          </label>
          <p>
            {save
              ? "Selected customers are refreshed; unrelated results are preserved."
              : "Diagnostic run: current saved results remain unchanged."}{" "}
            CD includes the earlier credit history; TOD uses the customer&apos;s
            complete period.
          </p>
        </>
      )}
      {operation === "update" && (
        <p>
          Downloads the verified release and restarts the connector. Existing
          checks may be interrupted.
        </p>
      )}
      {operation === "opening_balance" && (
        <p>
          Use the opening date of the Tally books. The result separates
          bill-wise balances from unallocated credit.
        </p>
      )}
      <div className={s.actions}>
        <Button disabled={busy} onClick={() => void start()}>
          {busy
            ? "Working..."
            : operation === "update"
              ? "Start update"
              : "Start operation"}
        </Button>
        <Button
          className="button-secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh status
        </Button>
      </div>
      <div className={s.history}>
        {overview?.jobs.map((j) => (
          <div key={j.id}>
            <button onClick={() => void open(j.id)}>
              {j.operation}
              {j.request.schemeType
                ? " " + j.request.schemeType.toUpperCase()
                : ""}{" "}
              | {j.status} | {new Date(j.created_at).toLocaleString()}
            </button>
            {["queued", "running"].includes(j.status) && (
              <button onClick={() => void changeJob(j, "cancel")}>Stop</button>
            )}
          </div>
        ))}
      </div>
      {selected && (
        <section className={s.result}>
          <h4>Operation {selected.status}</h4>
          {selected.error && <p>{selected.error}</p>}
          <div className={s.actions}>
            <Button
              className="button-secondary"
              onClick={() => void open(selected.id)}
            >
              Refresh result
            </Button>
            {selected.operation === "recalculate" && selected.result && (
              <>
                <Button
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void changeJob(selected, "replay")}
                >
                  Replay captured evidence
                </Button>
                {selected.status === "failed" && selected.request.save && (
                  <Button
                    disabled={busy}
                    onClick={() => void changeJob(selected, "retry-save")}
                  >
                    Retry saving evidence
                  </Button>
                )}
              </>
            )}
            {result && (
              <Button
                className="button-secondary"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob(
                      [JSON.stringify({ job: selected.id, result }, null, 2)],
                      { type: "application/json" },
                    ),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "connector-evidence-" + selected.id + ".json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download evidence
              </Button>
            )}
          </div>
          {result?.found === false && (
            <p>
              The requested ledger was not returned. This is not a zero balance.
            </p>
          )}
          {result?.ledgerOpening !== undefined && (
            <>
              <dl className={s.runtime}>
                <dt>Ledger opening</dt>
                <dd>INR {money(result.ledgerOpening)}</dd>
                <dt>Opening bills total</dt>
                <dd>INR {money(result.openingBillsTotal)}</dd>
                <dt>Unallocated opening credit</dt>
                <dd>INR {money(result.unallocatedOpeningCredit)}</dd>
              </dl>
              <p>Positive amounts are credit; negative amounts are debit.</p>
              <table>
                <thead>
                  <tr>
                    <th>Opening bill</th>
                    <th>Signed amount</th>
                  </tr>
                </thead>
                <tbody>
                  {result.openingBills?.map((b, i) => (
                    <tr key={i}>
                      <td>{b.billReference}</td>
                      <td>INR {money(b.signedAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {result?.complete === false && (
            <InlineMessage tone="warning">
              The row limit was reached. Narrow the period before drawing
              conclusions.
            </InlineMessage>
          )}
          {result?.rows && (
            <table>
              <thead>
                <tr>
                  <th>Date / voucher</th>
                  <th>Amount</th>
                  <th>Allocation evidence</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((v) => (
                  <tr key={v.tallyGuid}>
                    <td>
                      {v.date}
                      <br />
                      {v.kind} {v.number}
                    </td>
                    <td>INR {money(v.amount)}</td>
                    <td>
                      <details>
                        <summary>{v.allocations.length} allocations</summary>
                        <p>{v.narration}</p>
                        {v.allocations.map((a, i) => (
                          <p key={i}>
                            {a.billReference || "(No bill reference)"} |{" "}
                            {a.allocationType} | INR {money(a.allocatedAmount)}
                          </p>
                        ))}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result?.comparison && (
            <>
              <h4>Changes from the saved result</h4>
              <p>{result.comparison.length} changed result(s).</p>
              <table>
                <thead>
                  <tr>
                    <th>Invoice / customer</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {result.comparison.slice(0, 200).map((c) => (
                    <tr key={c.key}>
                      <td>{c.invoiceNumber || c.customerName || c.key}</td>
                      <td>
                        {c.before?.status ?? "No saved row"}
                        <br />
                        INR {money(c.before?.amount)}
                      </td>
                      <td>
                        {c.after.status}
                        <br />
                        INR {money(c.after.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {result?.calculations && (
            <>
              <h4>Calculated results</h4>
              <input
                aria-label="Filter calculation results"
                placeholder="Find invoice or customer"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <p>{rows.length} result(s). Showing up to 200.</p>
              <table>
                <thead>
                  <tr>
                    <th>Invoice / customer</th>
                    <th>Status</th>
                    <th>Discount</th>
                    <th>Opening / on-account used</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((r, i) => (
                    <tr key={r.invoiceGuid ?? i}>
                      <td>{r.invoiceNumber || r.customerName}</td>
                      <td>
                        {r.status}
                        <br />
                        {r.reviewMessage}
                        <details>
                          <summary>Calculation evidence</summary>
                          {r.invoiceAmount !== undefined && (
                            <p>
                              Invoice: INR {money(r.invoiceAmount)}. Paid by{" "}
                              {r.windowDeadline}: INR {money(r.paidByDeadline)}.
                              Discounted target: INR {money(r.discountedTarget)}
                              . Eligible tonnes: {r.eligibleTonnes}.
                            </p>
                          )}
                          {r.onAccountCreditAvailable !== undefined && (
                            <p>
                              Unallocated credit available: INR{" "}
                              {money(r.onAccountCreditAvailable)}. Used: INR{" "}
                              {money(r.onAccountCreditUsed)}.
                            </p>
                          )}
                          {r.payments?.map((p, j) => (
                            <p key={j}>
                              {p.date} {p.voucherNumber} | INR {money(p.amount)}{" "}
                              | {p.counted ? "Counted" : "After deadline"}
                            </p>
                          ))}
                          {r.creditNoteReferences?.map((n, j) => (
                            <p key={j}>
                              Credit Note {n.voucherNumber}: INR{" "}
                              {money(n.amount)} | {n.purpose}
                            </p>
                          ))}
                          {r.paymentChecks?.map((p, j) => (
                            <p key={j}>
                              {p.invoiceDate} invoice {p.voucherNumber} |{" "}
                              {p.counted ? "Counted" : "Excluded"}:{" "}
                              {p.reason.replaceAll("_", " ")} | Paid by due
                              date: INR {money(p.paidByDueDate)}
                            </p>
                          ))}
                        </details>
                      </td>
                      <td>
                        INR{" "}
                        {money(r.creditAmount ?? r.calculatedDiscountAmount)}
                      </td>
                      <td>INR {money(r.onAccountCreditUsed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {result?.saved && (
            <p>Saved as {result.saved.evaluationRunIds.join(", ")}.</p>
          )}
          {result?.logs && <pre className={s.logs}>{result.logs}</pre>}
        </section>
      )}
    </section>
  );
}
