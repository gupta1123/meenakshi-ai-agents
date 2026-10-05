# Meenakshi Phase 2 — Tally bridge and live synchronization

**Status:** Approved to plan; implementation starts after this structure is accepted.  
**Scope:** Backend and local Windows Tally bridge only. No frontend, rule calculation, Credit Note posting, or MSG91 work in this phase.

## 1. Outcome

Phase 1 can register, pair, monitor, and queue work for a Meenakshi Tally connector. Phase 2 makes that connector useful: it will safely read live Tally master and voucher evidence and store company-scoped, auditable snapshots in the existing Meenakshi schema.

The result is a reliable data foundation for later rule configuration and CD/TOD evaluation. Tally remains the source of truth; Meenakshi does not treat an old local snapshot as fresh evidence.

## 2. Repository layout

Keep the repository top level intentionally small:

```text
meenakshi/
├── backend/                  # Next.js server APIs and the outbox dispatcher
├── tally-bridge/             # New Windows-only local Tally agent
├── supabase/                 # Applied schema migrations, SQL scripts, and SQL tests
├── docs/                     # Engineering/design documentation
├── autodealer-workflow/      # Kalika reference only — never modified for Meenakshi
├── implementation-plan.md    # Full product implementation plan
└── requirement.md            # Approved business requirements
```

There will be no `apps/api`, nested `meenakshi` folder, or copied Kalika project. `backend` remains the server. `tally-bridge` is a separate package because it must run on the Windows computer where Tally Prime is available.

### 2.1 Target backend layout

```text
backend/
├── src/
│   ├── app/api/
│   │   ├── companies/[companyId]/
│   │   │   ├── tally-health/route.ts             # Existing readiness endpoint
│   │   │   └── sync/
│   │   │       ├── masters/route.ts              # Request a master refresh
│   │   │       ├── vouchers/route.ts             # Request a bounded voucher refresh
│   │   │       └── runs/[syncRunId]/route.ts     # Read sync progress/result
│   │   └── bridge/                               # Existing pair/heartbeat/command APIs
│   ├── lib/
│   │   ├── tally/
│   │   │   ├── contracts.ts                      # Typed command/result contracts
│   │   │   ├── sync-request.ts                   # Server validation and outbox creation
│   │   │   ├── ingest-masters.ts                 # Atomic master snapshot upserts
│   │   │   ├── ingest-vouchers.ts                # Voucher/line/allocation upserts
│   │   │   ├── fingerprints.ts                   # Stable evidence fingerprints
│   │   │   └── sync-status.ts                    # Freshness/readiness calculation
│   │   ├── bridge.ts                             # Existing bridge authentication
│   │   ├── authorization.ts                      # Existing organization/role checks
│   │   └── audit.ts                              # Existing append-only audit helper
│   └── ...
├── worker/process-tally-outbox.mjs               # Existing durable dispatcher
└── scripts/                                      # Local provisioning/development helpers
```

### 2.2 Target local bridge layout

```text
tally-bridge/
├── package.json
├── README.md
├── src/
│   ├── bridge.mjs                 # CLI entry point, polling loop, command dispatch
│   ├── config.mjs                 # Local protected configuration and machine identity
│   ├── api-client.mjs             # Pair, heartbeat, claim command, report result
│   ├── commands/
│   │   ├── sync-masters.mjs
│   │   ├── sync-vouchers.mjs
│   │   └── fetch-evidence.mjs
│   └── tally/
│       ├── http-client.mjs        # Timeouts and Tally HTTP transport
│       ├── company-probe.mjs      # Active-company GUID/name lookup
│       ├── xml-builders.mjs       # Meenakshi export requests only
│       └── xml-parsers.mjs        # XML -> typed, normalized records
├── fixtures/
│   └── tally/                     # Sanitised controlled-company XML examples
└── test/                          # Parser, command, timeout, and company-match tests
```

## 3. Kalika reference boundary

Use `autodealer-workflow/apps/tally-bridge/src/bridge.mjs` only to understand the technical patterns below:

- protected local configuration and stable installation identity;
- pairing, heartbeat, serial command claim, lease handling, and result reporting;
- XML escaping, local Tally HTTP transport, export timeout handling, and error reporting.

Implement the Meenakshi bridge afresh in `tally-bridge/`. Do **not** copy Kalika data ownership, schemas, narration calculations, Debit Note payloads, Collections UI, or its master-sync assumptions. In particular, Meenakshi must export stock items and UOMs; Kalika's incomplete stock/unit export cannot be reused.

## 4. Command contracts

The server will queue only these Phase 2 commands. Each includes `companyId`, the expected Tally company GUID/name, a correlation ID, a business idempotency key, and the smallest required scope.

| Command | Requested by | Scope | Result required from bridge |
| --- | --- | --- | --- |
| `sync_meenakshi_masters` | Administrator | One company, full master scope | Active company identity, master counts, normalized records, source IDs, raw payload checksum, completion/failure state |
| `sync_meenakshi_vouchers` | Administrator; later evaluator | One company plus bounded date/customer/reference scope | Cursor/checkpoint, normalized vouchers/lines/allocations, altered/cancelled state, source IDs, totals, completion/failure state |
| `fetch_meenakshi_evidence` | Reserved for later evaluation/approval flows | Narrow customer/invoice or customer/period scope | Fresh matching master and voucher evidence, duplicate-Credit-Note matches, source fingerprint inputs |

The bridge must reject a claimed command when its current live company does not exactly match the expected GUID and name. A failed request, timeout, or incomplete export returns an unresolved result; it never marks the sync complete.

## 5. Implementation sequence

### Step 1 — Preflight and typed contracts

- Add the separate `tally-bridge` package and development README.
- Define shared JSON command/result contracts in `backend/src/lib/tally/contracts.ts`; validate every bridge result server-side before database writes.
- Confirm the controlled Tally Prime test company, local HTTP/XML endpoint, active company GUID/name, and permitted test data.
- Add the three command types to the existing command queue without changing the pairing/security flow from Phase 1.

**Exit condition:** a paired bridge can claim a harmless company probe and report the actual active-company identity.

### Step 2 — Master exports and atomic ingestion

- Build XML exports/parsers for customer groups with parent relationships, customer ledgers, stock groups/items, UOMs, voucher types, and accounting ledgers.
- Create a `tally_sync_runs` row before dispatch. Store count, cursor, timestamps, status, source metadata, and errors.
- Ingest a completed master response transactionally into the existing master tables using company-scoped Tally GUID/Master ID keys.
- Preserve raw XML-derived payload data and `Alter ID` for every source record.
- Mark unseen masters unavailable only after a successful full master read. Partial or failed runs change no availability flags.

**Exit condition:** a full master sync can be repeated safely, retains hierarchy, and is visible as fresh/failed/stale through an authenticated status API.

### Step 3 — Resumable voucher exports and ingestion

- Build date-bounded XML exports for Sales, Receipts, Sales Returns, Debit Notes, and existing Credit Notes.
- Parse and store canonical voucher headers, ledger entries, inventory lines, bill allocations, voucher status, and raw payload.
- Retain `GUID`, `Master ID`, `Alter ID`, number, date, voucher type, party, company, and source status.
- Support a cursor/checkpoint and bounded chunks so a financial year is read through multiple bridge commands rather than one browser request.
- Support narrow customer/reference refreshes for the later CD/TOD evaluation and approval paths.

**Exit condition:** interrupted work resumes from its checkpoint; a source voucher cannot be duplicated by retrying a chunk.

### Step 4 — Source freshness and fingerprints

- Derive a stable fingerprint from the company identity, relevant group membership, voucher identities/Alter IDs/statuses, inventory lines, and bill allocations.
- Record the fingerprint and sync-run linkage with imported records.
- Extend company readiness to show last successful master/voucher sync, stale state, and incomplete/failed runs.
- Preserve enough source metadata for later Phase 4 evaluation and Phase 5 revalidation to independently recompute the same fingerprint.

**Exit condition:** changing a controlled Tally voucher or allocation causes the next sync to change the stored fingerprint.

### Step 5 — Reliability, tests, and operational proof

- Add sanitised XML fixtures for nested groups, master records, invoices, partial/split `Agst Ref` receipts, returns, Debit Notes, existing Credit Notes, cancellation, and altered vouchers.
- Test XML builders/parsers, company mismatch rejection, timeout/error handling, idempotent retry, atomic master availability behaviour, cursor resume, cross-company rejection, and fingerprint change detection.
- Run an end-to-end test against the controlled Tally company: pair -> master sync -> voucher chunk sync -> status/readiness verification.
- Document bridge setup, pairing, logs, one-time sync test, and expected recovery actions.

**Exit condition:** the bridge can run against the controlled company, and the server has fresh, company-scoped evidence without exposing a service key to the bridge or browser.

## 6. APIs added in this phase

All remain server-side and organization/company scoped:

- `POST /api/companies/:companyId/sync/masters`
- `POST /api/companies/:companyId/sync/vouchers`
- `GET /api/companies/:companyId/sync/runs/:syncRunId`
- expanded `GET /api/companies/:companyId/tally-health` with last master/voucher sync and stale/incomplete status.

Only an Administrator can request broad syncs. Later evaluator flows may request a narrow evidence refresh only through server-side workflow logic. Raw XML and bridge credentials are never returned to the browser.

## 7. Explicitly deferred

This phase does not add:

- CD/TOD rulebook, calendars, contact/opt-in configuration;
- discount calculations, proposals, approvals, or stale-review UX;
- Credit Note commands, posting, read-back, PDFs, or recovery;
- MSG91 messaging;
- end-user frontend screens.

Those depend on trusted live master/voucher snapshots and belong to Phases 3–6.

## 8. Definition of done

Phase 2 is complete only when:

- the new root-level `tally-bridge` runs independently of the backend on a Windows Tally machine;
- it pairs and validates the active Tally company before handling any command;
- master and voucher syncs are resumable, company-scoped, idempotent, and auditable;
- all required Tally identities, source states, lines, allocations, UOMs, and raw payloads are preserved;
- stale/failed/partial synchronization cannot be misrepresented as current evidence;
- controlled XML fixtures and a live controlled-company smoke test pass;
- Kalika behavior and files remain unchanged.
