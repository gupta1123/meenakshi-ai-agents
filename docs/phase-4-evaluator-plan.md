# Meenakshi Phase 4 — deterministic CD/TOD evaluation

**Status:** Implemented locally — standalone migration application and a controlled live-Tally end-to-end test are pending  
**Depends on:** Phase 1 authorization/connector lifecycle, Phase 2 paired bridge and current master/voucher sync, and Phase 3 immutable Rulebook configuration  
**Implementation status:** Local implementation is complete and verified by unit/type/lint checks. It is ready for standalone migration review/application and then a controlled live-Tally end-to-end test.  
**Scope:** Backend evaluator, targeted live-evidence refresh, durable execution, API contracts, tests, and the small append-only migration needed for execution safety  
**Not in this phase:** Finance review screens, approval, Credit Note posting/recovery/PDFs, MSG91 delivery, or a new end-user evaluation UI

## Outcome

Phase 4 turns approved Rulebook configuration plus current Tally evidence into a reproducible CD or TOD proposal. It does **not** authorize or post a Credit Note.

Every requested evaluation will:

1. obtain a fresh, company-bound evidence refresh from the paired local Tally bridge;
2. resolve the active immutable rule version from the refreshed customer-group evidence;
3. calculate CD or TOD using fixed-decimal arithmetic only;
4. save a current proposal plus a new immutable evaluation/evidence snapshot; and
5. return a run ID that can be polled without holding the browser open.

This keeps the calculation deterministic and makes Phase 5 approval safe: Finance will approve a frozen result only after a later fresh-fingerprint check.

## Preconditions and operating flow

The practical test flow is deliberately ordered. Staff do not enter arbitrary values in the Rulebook just to make the pages non-empty.

```text
1. Tally Prime is open with the intended controlled company.
2. Meenakshi bridge is paired and its heartbeat/company binding is healthy.
3. Masters and the required voucher date range are synchronized.
4. An administrator configures real test Rulebook data:
   - CD/TOD scheme and draft version;
   - covered customer groups;
   - CD calendar/rate and TOD stock/conversions/tiers;
   - finance/CA tax-policy evidence; then activates the version.
5. Phase 4 requests a fresh, narrow Tally refresh and evaluates it.
6. Phase 5 will show the resulting proposal to Finance for approval.
7. Only Phase 5 can build/verify a Credit Note; Phase 6 can message after verification.
```

The existing Rulebook UI remains a **configuration UI** in this phase. A user should create a calendar only for a CD rule, record contacts only where the customer has actually consented, and activate a rule only after all production configuration is known. Phase 4 receives its inputs from those saved records and from Tally; it will not add an evaluation form to the current UI yet.

## Folder structure

The implementation extends the current Meenakshi folders only. `autodealer-workflow/` remains a read-only Kalika reference and will not become part of the product.

```text
meenakshi/
  backend/
    src/
      app/api/companies/[companyId]/
        evaluations/
          cd/route.ts                         request one CD invoice evaluation
          tod/route.ts                        request one TOD customer-period evaluation
          runs/[runId]/route.ts               poll durable evaluation progress/result summary
          proposals/[proposalId]/route.ts     read current proposal and latest frozen evidence
      lib/
        evaluation/
          contracts.ts                        input/result/reason-code types; no database types leak in
          decimal.ts                          fixed-decimal configuration and explicit rounding helpers
          calendar.ts                         Day 0 / working-day and first-working-day-after-close logic
          groups.ts                           recursive live group coverage resolution
          fingerprint.ts                      canonical evidence fingerprinting
          cd.ts                               pure Cash Discount calculation
          tod.ts                              pure Turnover Discount calculation
          evaluate.ts                         scheme dispatch and shared outcome assembly
          evidence.ts                         server-only normalized database reads and frozen rule loader
          run-service.ts                      orchestration, authorization boundary, retries and audit
        tally/
          ...existing master/voucher contracts and ingestion remain the canonical Tally boundary
      worker/
        process-evaluation-runs.mjs           claims/evaluates jobs; browser never waits for a large period
      lib/evaluation/evaluation.test.mjs      deterministic CD/TOD calculation fixtures
  tally-bridge/
    src/
      commands/
        fetch-evidence.mjs                    bounded live master/voucher fetch, using existing XML readers
        dispatch.mjs                          adds only fetch_meenakshi_evidence dispatch
      tally/
        ...existing company probe, master, voucher and XML transport modules reused
  supabase/migrations/
    20260805000000_phase_4_evaluation_execution.sql
  supabase/tests/
    phase_4_evaluation_execution_smoke.sql   migration structure/security smoke check
  docs/
    phase-4-evaluator-plan.md                 this implementation contract
    api-reference.md                          verified Phase 4 endpoint contract
  postman/
    Meenakshi-phase-4-evaluations.postman_collection.json
```

There will be no extra `apps/api`, nested `meenakshi/`, copied Kalika module, or second connector. `backend/` remains the business authority; `tally-bridge/` only proves the active Tally company and transports XML.

## What I will build

### 1. Durable evaluator run lifecycle

`POST /evaluations/cd` and `POST /evaluations/tod` will validate the caller's organization/company access and create a durable evaluation request. They will return `202 Accepted` with an `evaluationRun` ID, not keep an HTTP request open while Tally or a large period is processing.

The background worker will move the run through this lifecycle:

```text
queued
  -> refreshing_tally      targeted live evidence requested from the paired bridge
  -> evaluating            immutable rule and normalized evidence loaded
  -> completed             one or more proposal snapshots written
  -> completed_with_issues evidence/rule ambiguity or a blocking data problem recorded
  -> failed                bridge/transport/unrecoverable system failure; retry remains auditable
```

The worker will claim runs with a lease, a retry limit, an idempotency key, correlation ID, and an audit event. Therefore refreshing a one-financial-year TOD period is a date-chunked background operation with progress, rather than a browser timeout.

The endpoint inputs are intentionally narrow:

| Request | Accepted identifiers | Not accepted |
| --- | --- | --- |
| CD evaluation | `salesVoucherId` | money, rate, deadline, group, or receipt totals supplied by the browser |
| TOD evaluation | `customerId`, `asOfDate` or a requested period start | stock totals, tonnes, tier/rate, or a chosen rule version supplied by the browser |

The server resolves the rule version, customer group, dates, rate, calendar, conversion, evidence, and source fingerprint. This prevents a browser request from changing a financial result.

### 2. Targeted fresh Tally evidence

Phase 2 already persists master/voucher snapshots and the outbox schema already reserves the `tally_targeted_refresh` → `fetch_meenakshi_evidence` command path. Phase 4 will complete that path; it will not add ODBC or replicate Kalika business rules.

For each evaluation, the server-only `run-service.ts` enqueues one `tally_targeted_refresh` event tied to the evaluation run. The bridge's `fetch-evidence.mjs` will:

- verify the selected local Tally company still matches its approved company binding;
- read the scoped customer/master data needed to prove group membership and rule references;
- read the invoice/payment evidence for CD, or bounded date/customer voucher evidence for TOD;
- use the existing Tally HTTP/XML transport, parsers, command polling, heartbeat and result-reporting patterns; and
- return normalized master/voucher data through the existing safe ingestion path.

The backend bridge-result handler will ingest those result records atomically, update the associated sync/evaluation status, and retain only safe command/result summaries. A wrong company, partial result, stale bridge, timeout, or failed command means **no successful refresh**. The worker records a processing issue/run failure rather than evaluating cached data as though it were live.

For long TOD periods, the command uses resumable date chunks. Each chunk has a cursor and deterministic idempotency key. The final evaluation starts only after every required chunk completes successfully.

### 3. Pure CD evaluator

`backend/src/lib/evaluation/cd.ts` will be a pure function: it receives a frozen CD rule and normalized evidence, and returns typed values, evidence contributions, reason codes, working-day rows, and an explanation. It will not call Supabase, HTTP, Next.js, or Tally.

The calculation rules are:

1. Recursively resolve the customer's **live** group membership against selected customer groups. No coverage produces `not_in_scheme`; unavailable or ambiguous coverage produces `needs_review`.
2. Treat invoice date as Day 0. Count only the configured working days after it, using the selected calendar's configured non-working weekdays and active holidays. A receipt dated on the deadline counts. Persist every counted/excluded date.
3. Sum eligible product taxable value before GST; exclude freight/non-product lines. Use `numeric` values as strings and a fixed-decimal library in Node. Apply only the rule's explicit rounding method/scale.
4. Count only posted, non-cancelled Receipt allocations of `Agst Ref` against the exact sales bill reference on or before the deadline. Exclude narration matching, ledger balances, `On Account`, `New Ref`, and advances.
5. Compute invoice amount due, payment by deadline, discounted settlement target, shortfall, discount percentage, and calculated discount.
6. Set the outcome as `eligible`, `near_eligibility`, `partially_paid`, `unpaid`, `deadline_expired`, `needs_review`, `not_in_scheme`, or `already_credited`.

`near_eligibility` is only a follow-up signal: payments must be at least **80% of the invoice amount due**, while still below the discounted settlement target. It never creates a Credit Note in Phase 4.

### 4. Pure TOD evaluator

`backend/src/lib/evaluation/tod.ts` has the same pure boundary but calculates one customer-period entitlement.

1. On the first evaluation of a customer-period, resolve the effective active TOD version and lock it. Derive the period from its explicit anchor date and `period_months` value. A later rule version affects only future periods.
2. Keep a new proposal `tracking` through the final day of the period. Make it eligible for review on the first working day after the period closes.
3. Include only covered customer inventory lines for selected stock items/groups. Sum posted sales, subtract returns/cancellations, and add a linked Debit Note only if its own eligible inventory line and approved conversion are present.
4. Convert each UOM only using the approved conversion from the locked rule version. A missing or conflicting conversion blocks the affected line and resulting proposal; quantity is never inferred from amount or rate.
5. Choose the highest achieved tier and apply that rate to the **full net eligible taxable value**. Return achieved tier, next tier, and tonnes still needed.
6. Detect an already verified/recovered matching Credit Note as `already_credited`. A return after a verified TOD Credit Note becomes an explicit prior-period adjustment in the next open period, never a mutation of the verified period.

CD and TOD are independent: qualifying under one does not reduce the original eligible value for the other.

### 5. Fingerprint, explanation, and persistence boundary

The evaluator will canonicalize and hash only the relevant live facts: voucher GUID/Master ID/Alter ID/status/date, qualifying allocations, inventory lines/UOM conversions, customer group path, version configuration, calendar revision/holidays, and matched existing Credit Note identity. The exact typed inputs used to calculate are preserved as a snapshot.

The pure result becomes database state only through server-only `run-service.ts` orchestration and one SQL RPC. It will atomically:

- upsert the one allowed CD or TOD entitlement proposal;
- append the next immutable `proposal_evaluations` row;
- append its group, working-day, source-voucher, inventory-line, payment-allocation, and prior-period-adjustment evidence;
- retain a stable `entitlement_key` so retries cannot create a second proposal;
- update the evaluation run summary/status; and
- create or retain a `processing_issues` record for blocking evidence.

No browser role receives write access to these tables or RPCs. A new evaluation can update the current proposal's state/fingerprint but it never rewrites an older evaluation snapshot.

## Required Phase 4 migration

Yes — Phase 4 needs **one new append-only migration**. It is not a patch to the existing applied files:

`supabase/migrations/20260805000000_phase_4_evaluation_execution.sql`

It will contain only the execution gaps that do not exist in the current schema:

1. **Evaluation request/lease fields** on `evaluation_runs`: immutable request context, idempotency/correlation fields, lease/retry bookkeeping, and nullable pre-refresh rule/period values. A run receives its definitive rule version and period only after fresh Tally evidence has been loaded. A constraint will require them before evaluation can complete.
2. **TOD customer-period rule lock** table, with company-scoped foreign keys, immutable scheme-version/period identity, and a unique `(company, customer, logical scheme, period)` key. This prevents a later TOD version from rewriting a period that is already tracking/reviewed/verified.
3. **Server-only run RPCs**: claim/finish a leased evaluation run; create/reuse a retry-safe request; atomically persist a calculated result and its evidence snapshots; and lock/retrieve a TOD customer-period version.
4. **Safety constraints and indexes** for no cross-company references, one active worker lease per run, run polling, entitlement serialization, and targeted period scans.
5. **RLS/function grants**: revoke the new RPCs from browser roles and grant them only to `service_role`. The existing browser RLS posture is preserved.

The migration will not introduce a financial default, seed real customer/rule data, weaken immutable snapshots, or modify previous migration files. Before it is sent for application, it will be reviewed as a standalone SQL file and accompanied by a smoke test.

## API contract plan

After implementation and verification, the API reference/Postman collection will document these routes:

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/companies/{companyId}/evaluations/cd` | administrator or finance_approver | Queue a fresh CD invoice evaluation; `Idempotency-Key` required. |
| `POST` | `/api/companies/{companyId}/evaluations/tod` | administrator or finance_approver | Queue a fresh TOD customer-period evaluation; `Idempotency-Key` required. |
| `GET` | `/api/companies/{companyId}/evaluations/runs/{runId}` | organization member with company access | Poll run status, safe summary, issues, and next action. |
| `GET` | `/api/companies/{companyId}/evaluations/proposals/{proposalId}` | administrator or finance_approver | Read the current proposal and latest/selected immutable evaluation evidence. |

All calls retain the existing Bearer user token and company authorization. The current Rulebook configuration endpoints remain unchanged.

## Tests and acceptance checks

### Pure domain tests

- CD Day 0, configured Sunday/holiday exclusion, and receipt exactly on deadline.
- CD split `Agst Ref` payments, late receipts, `On Account`/advance exclusion, freight exclusion, explicit rounding, and 80% of invoice-due follow-up.
- TOD period anchoring, locked version continuity, review opening after period closure, tiers, item/group eligibility, KG/MT/custom UOM conversions, missing conversion blocks, returns/cancellations, linked Debit Notes, and next-period adjustments.
- Existing recovered Credit Note produces `already_credited` without a second entitlement.
- A changed source fact changes the fingerprint. Identical inputs produce the same pure result and explanation.

### Database, worker, bridge, and API tests

- The Phase 4 migration applies after the existing migration chain and its smoke test verifies locks, cross-company rejection, retry-safe requests, immutable snapshots, and RPC access restrictions.
- A crashed/retried worker cannot create duplicate CD/TOD proposals or duplicate snapshot numbers.
- A stale/wrong/offline bridge, failed XML response, or partial sync cannot produce a `completed` live evaluation.
- The bridge refuses a company mismatch before any master/voucher evidence is accepted.
- API authorization rejects unrelated organization/company access and requests without idempotency keys.
- One representative financial year is refreshed in date/customer chunks. The API returns progress rather than timing out, and the final outcome is reproducible after all chunks finish.

## Definition of done

Phase 4 is complete when a paired controlled Tally company with an active test CD/TOD version can produce a persisted, deterministic proposal/evaluation via API; the proof includes the exact live evidence, rule/calendar/group snapshot, calculation explanation, fingerprint, and test coverage. It is **not** complete merely because configuration forms exist or because a proposal page can be mocked.

The next implementation phase is Phase 5: separate Finance review queues and evidence drill-down, fresh approval-time recomputation, commercial no-GST Credit Note creation/recovery, independent Tally read-back verification, and PDF export.

## Manager-ready update

> **What I will build next — Phase 4: deterministic CD/TOD evaluator**
>
> I will build the Meenakshi backend evaluator on top of the paired Tally bridge, synced masters/vouchers, and immutable Rulebook versions. Each CD invoice or TOD customer-period request will first trigger a fresh, bounded Tally evidence refresh, then calculate the entitlement with fixed-decimal arithmetic and save an immutable evidence snapshot, source fingerprint, explanation, and one duplicate-safe proposal.
>
> CD will use Day 0 working-calendar deadlines and only posted `Agst Ref` receipt allocations; the 80% follow-up rule is based on invoice amount due. TOD will lock the applicable rule version when its customer-period begins, use only selected stock/UOM conversions, subtract returns, and apply the highest achieved tier to full eligible value. A change in later rules cannot rewrite a tracked period.
>
> This phase is backend/bridge/test work, not a Finance approval or Credit Note UI. I will extend the existing `backend/`, `tally-bridge/`, `docs/`, `postman/`, and `supabase/migrations/` folders only; Kalika remains reference-only. I will add one new append-only migration for durable evaluation jobs, the TOD period lock, and atomic result persistence. The output will be a safe evaluation API that Phase 5 can present to Finance for review and Credit Note posting.
