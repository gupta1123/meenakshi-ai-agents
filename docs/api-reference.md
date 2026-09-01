# Meenakshi API reference

**Audience:** backend and future frontend developers.  
**Current scope:** Phase 1 connector lifecycle, Phase 2 Tally synchronization, Phase 3 Rulebook configuration, Phase 4 durable evaluation, and Phase 5 Finance review/Credit Note lifecycle.

## Security boundary

- Browser/admin calls require a Supabase user access token in `Authorization: Bearer <access_token>`.
- Every organization/company configuration and broad sync request requires the `administrator` role.
- The browser must never receive or use the Supabase service-role key, a Tally bridge control token, raw Tally XML, or a Tally command-result credential.
- Tally bridge calls are made only by the local `tally-bridge` package on the Windows machine that can reach Tally Prime. They are not frontend calls.

## Local development values

| Value | Development value |
| --- | --- |
| Meenakshi API base URL | `http://localhost:3001` while `cd backend; npm run dev` is running |
| Tally bridge package | `tally-bridge/` |
| Tally HTTP/XML endpoint | Normally `http://localhost:9000` on the Tally machine |

Use the current Supabase project URL and its **publishable** key from the local environment. Do not add service-role credentials to a Postman collection, frontend environment, screenshot, or repository.

## Authentication

The frontend obtains a user token through Supabase Auth. In the temporary Postman-only development flow, use password sign-in:

```http
POST {supabase_url}/auth/v1/token?grant_type=password
apikey: {supabase_publishable_key}
Content-Type: application/json

{
  "email": "{test administrator email}",
  "password": "{test administrator password}"
}
```

Use only `apikey` and `Content-Type`; do not send `x-api-key`. Store the returned `access_token` locally for the remaining calls. The test-account provisioner is `backend/scripts/provision-test-access.mjs`; credentials are deliberately not repeated in this document.

## Browser/admin API

All examples below require:

```http
Authorization: Bearer {access_token}
```

### Load the current user scope

```http
GET /api/bootstrap
```

Returns enabled organizations, the caller's organization roles, and active companies. A frontend should use this response to choose `organizationId` and `companyId`; it must not hardcode IDs.

### Phase 5 — Finance review and Credit Notes

```http
GET /api/companies/{companyId}/evaluations/proposals
```

**Role:** Administrator or Finance Approver.  Returns finance-safe proposal summaries, latest frozen evaluation identifiers, and any linked Credit Note posting.

```http
POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/review
Content-Type: application/json

{ "decision": "approve" }
```

**Role:** Finance Approver only. The server derives the Credit Note amount, date, Tally voucher type, discount ledger, allocation mode, calculation reference, and immutable snapshot. It rejects a stale evaluation or a proposal with open issues. Success is `202` and returns `creditNotePostingId`.

```http
POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/review
Content-Type: application/json

{
  "decision": "reject",
  "proposalEvaluationId": "{latestProposalEvaluationId}",
  "reason": "Reason visible in the audit trail"
}
```

**Role:** Finance Approver only. The reason is required and the evaluation fingerprint must still be current.

```http
GET /api/companies/{companyId}/credit-notes
```

**Role:** Administrator or Finance Approver. Returns posting state, verified Tally identity, PDF location if verified, and correction reason if relevant.

```http
POST /api/companies/{companyId}/credit-notes/{creditNotePostingId}/retry
Content-Type: application/json

{ "reason": "Corrected the Tally voucher configuration and rechecked the evidence" }
```

**Role:** Administrator or Finance Approver. Allowed only for `failed` or `correction_required` postings. Retries preserve the original business idempotency identity and write a separate audited transport attempt.

### Register a controlled Tally company

```http
POST /api/companies
Content-Type: application/json

{
  "organizationId": "{organizationId}",
  "code": "TALLY_TEST",
  "tallyCompanyGuid": "{GUID returned by a read-only bridge probe}",
  "tallyCompanyName": "{exact name returned by the probe}",
  "timezone": "Asia/Kolkata"
}
```

**Role:** Administrator.  
**Success:** `201`, returning `company.id`.

Create a separate company record for each approved Tally company. Do not rewrite a demo/previous company's Tally GUID or name; its connector and accounting history may be retained for audit.

### Create and list connectors

```http
POST /api/connectors
Content-Type: application/json

{
  "organizationId": "{organizationId}",
  "installationKey": "{unique local installation label}",
  "displayName": "{human-readable bridge name}",
  "machineFingerprint": "{output of npm run machine-id}"
}
```

**Role:** Administrator.  
**Success:** `201`, returning `connector` and a one-time `controlToken`. Keep that token in the protected local bridge configuration only.

```http
GET /api/connectors?organizationId={organizationId}
```

Returns available connectors and their pairing/heartbeat state.

### Bind a connector to its approved company

```http
POST /api/connectors/{connectorId}/bindings
Content-Type: application/json

{
  "companyId": "{companyId}"
}
```

**Role:** Administrator.  
**Success:** `201`, returning the binding and the exact expected Tally name/GUID snapshot.

```http
GET /api/connectors/{connectorId}/bindings
```

Use this to display the active binding and the most recently observed company identity.

### Read Tally readiness

```http
GET /api/companies/{companyId}/tally-health
```

Important response states:

| State | Meaning | Frontend action |
| --- | --- | --- |
| `not_bound` | No connector is bound to the company. | Offer setup status; block sync/evaluation actions. |
| `awaiting_pairing` | Bound connector has not paired. | Show pairing instructions; block work. |
| `bridge_stale` | No recent heartbeat from the paired bridge. | Show reconnect warning; block work. |
| `company_mismatch` | Tally's open company differs from the approved binding. | Block work and show both identities. |
| `ready` | A paired bridge recently confirmed the expected Tally company. | Allow a permitted sync request. |

The response also contains `sync.masters` and `sync.vouchers`, each of which can be `required`, `queued`, `running`, `completed`, `failed`, or `stale`. A financial action must require `ready` plus fresh completed evidence.

### Request a full master sync

```http
POST /api/companies/{companyId}/sync/masters
Idempotency-Key: {stable key for this requested sync}
```

**Role:** Administrator. No request body.  
**Success:** `202`, returning `{ "syncRun": { ... } }` with initial `status: "queued"`.

The sync is read-only against Tally. It imports customer-group hierarchy, customer ledgers, UOMs, stock groups/items, voucher types, and accounting ledgers. It does not create or modify Tally records.

### Request a bounded voucher sync

```http
POST /api/companies/{companyId}/sync/vouchers
Idempotency-Key: {stable key for this requested range}
Content-Type: application/json

{
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD"
}
```

**Role:** Administrator.  
**Success:** `202`, returning `{ "syncRun": { ... } }`.

The API permits a request up to 370 days; the bridge divides date-based exports into safe command chunks. The first live test must be one known controlled day. A later frontend can also use the supported narrow scope:

```json
{ "customerId": "{customerId}" }
```

or:

```json
{ "voucherReference": "{exact voucher reference}" }
```

### Poll a sync run

```http
GET /api/companies/{companyId}/sync/runs/{syncRunId}
```

The response contains:

- `status`: `queued`, `running`, `completed`, `completed_with_errors`, or `failed`;
- `recordsReceived`, `recordsApplied`, and `recordsFailed`;
- `sourceFingerprint`, after a successful import;
- `errorSummary`, when a run cannot complete;
- `cursorFrom` and `cursorTo`, when further voucher chunks were scheduled.

Poll this endpoint from the future UI rather than querying database tables directly.

### List synced vouchers and retrieve a voucher ID

```http
GET /api/companies/{companyId}/vouchers?dateFrom=2026-07-22&dateTo=2026-07-22&voucherKind=sales
```

Available to an `administrator` or `finance_approver` for an authorized company. Supply either an ascending `dateFrom` / `dateTo` ISO-date range (maximum 370 days) or an exact `voucherNumber`. Optional filters are `voucherKind`, `customerId`, and `limit` (maximum 100).

The response contains a safe operational view of synced vouchers. For a CD evaluation, use `vouchers[0].id` as `salesVoucherId`; raw Tally XML, narration, and bill-allocation evidence are deliberately not returned to the browser.

## Local Tally bridge API — never called by the frontend

The bridge config is stored outside the repository in `%APPDATA%\Meenakshi\TallyBridge\config.json`. It sends the `x-bridge-token` header; this token must never be exposed to the browser.

| Method and path | Called by | Purpose |
| --- | --- | --- |
| `POST /api/bridge/pair` | `npm run pair` | Converts a matching pending connector to `paired`. |
| `POST /api/bridge/heartbeat` | `npm run once` / `npm run start` | Reports the currently active Tally name/GUID and validates bindings. |
| `GET /api/bridge/commands/next?connectorId={id}` | `npm run start` | Claims one leased command for its own connector. |
| `POST /api/bridge/commands/{commandId}/result` | `npm run start` | Reports verified/failure result; successful Phase 2 results are atomically ingested. |

## Phase 3 Rulebook configuration API

Phase 3 is an administrator-only configuration surface. It requires the Phase 3 activation migration and a current successful master sync. It records configuration and approval evidence only; it does **not** calculate CD/TOD discounts, create Credit Notes, or send WhatsApp.

All calls require `Authorization: Bearer {access_token}` and use the Bootstrap `{companyId}`. Use live master UUIDs returned by the first endpoint; never invent UUIDs or send raw Tally XML from the browser.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/companies/{companyId}/rulebook/reference-data` | Current master-sync status and safe customer/group/stock/UOM/voucher/ledger choices. |
| `GET`, `POST` | `/api/companies/{companyId}/calendars` | List or create an explicit working calendar. |
| `PATCH` | `/api/companies/{companyId}/calendars/{calendarId}` | Rename or activate/deactivate a calendar. |
| `GET`, `POST`, `PATCH` | `/api/companies/{companyId}/calendars/{calendarId}/holidays` | List, add, or update a holiday. |
| `GET`, `POST` | `/api/companies/{companyId}/schemes` | List or create a CD/TOD logical scheme. |
| `GET`, `PATCH` | `/api/companies/{companyId}/schemes/{schemeId}` | Read a scheme, or pause/retire it. |
| `POST` | `/api/companies/{companyId}/schemes/{schemeId}/versions` | Create a CD or TOD draft version. |
| `GET`, `PATCH` | `/api/companies/{companyId}/scheme-versions/{versionId}` | Read/change a draft version only. |
| `GET`, `POST`, `DELETE` | `/api/companies/{companyId}/scheme-versions/{versionId}/groups` | Configure customer-group coverage. |
| `GET`, `POST`, `DELETE` | `/api/companies/{companyId}/scheme-versions/{versionId}/stocks` | Configure TOD stock item/group coverage. |
| `GET`, `POST`, `DELETE` | `/api/companies/{companyId}/scheme-versions/{versionId}/conversions` | Configure TOD UOM-to-tonne conversions. |
| `GET`, `POST`, `DELETE` | `/api/companies/{companyId}/scheme-versions/{versionId}/tiers` | Configure TOD tiers. |
| `POST` | `/api/companies/{companyId}/scheme-versions/{versionId}/validate` | Return every activation blocker. |
| `POST` | `/api/companies/{companyId}/scheme-versions/{versionId}/activate` | Revalidate and atomically activate the immutable version. |
| `GET`, `POST`, `PATCH` | `/api/companies/{companyId}/contacts` | List, create, or control a normalized customer contact. |
| `GET`, `POST` | `/api/companies/{companyId}/contacts/{contactId}/opt-ins` | Read or record an explicit WhatsApp opt-in/out event. |
| `GET`, `POST` | `/api/companies/{companyId}/credit-note-tax-policies` | Record commercial/no-GST Finance/CA evidence required for activation. |

### Configuration request bodies

```http
POST /api/companies/{companyId}/calendars
{ "name": "Meenakshi FY26 calendar", "nonWorkingWeekdays": [7] }
```

Weekdays use ISO numbers (`1` Monday through `7` Sunday); they are explicit configuration, never a financial default. Calendar revision history is retained, and a later evaluation snapshots the calendar used.

```http
POST /api/companies/{companyId}/schemes
{
  "schemeType": "cd",
  "code": "CD-FY26",
  "name": "Cash Discount FY26",
  "description": "Finance-approved configuration in progress"
}
```

The scheme code accepts uppercase letters, digits, hyphens, and underscores. Create a version only after choosing live Credit Note voucher type and Discount ledger IDs from reference data.

```http
POST /api/companies/{companyId}/schemes/{schemeId}/versions
{
  "effectiveFrom": "2026-04-01",
  "effectiveTo": "2027-03-31",
  "discountPercentage": "2.5000",
  "requiresApproval": true,
  "roundingMethod": "half_up",
  "roundingScale": 2,
  "creditNoteVoucherTypeId": "{creditNoteVoucherTypeId}",
  "discountLedgerId": "{discountLedgerId}",
  "workingCalendarId": "{calendarId}",
  "allowedWorkingDays": 10
}
```

This creates a CD version. It treats invoice date as Day 0 and holds the 80% invoice-amount-due follow-up threshold from the approved schema. Decimal financial fields must be strings; JavaScript never decides a financial value.

```http
POST /api/companies/{companyId}/schemes/{schemeId}/versions
{
  "effectiveFrom": "2026-04-01",
  "effectiveTo": "2027-03-31",
  "requiresApproval": true,
  "roundingMethod": "half_up",
  "roundingScale": 2,
  "creditNoteVoucherTypeId": "{creditNoteVoucherTypeId}",
  "discountLedgerId": "{discountLedgerId}",
  "periodMonths": 1,
  "periodAnchorDate": "2026-04-01",
  "todReviewCalendarId": "{calendarId}"
}
```

The second example is TOD. Add at least one customer group to every version. TOD also needs a stock item/group, a UOM conversion, and tiers before activation:

```http
POST /api/companies/{companyId}/scheme-versions/{versionId}/groups
{ "customerGroupId": "{customerGroupId}" }

POST /api/companies/{companyId}/scheme-versions/{versionId}/stocks
{ "kind": "stockItem", "id": "{stockItemId}" }

POST /api/companies/{companyId}/scheme-versions/{versionId}/conversions
{ "sourceUomId": "{uomId}", "isBuiltin": false, "tonnesPerSourceUnit": "0.001000000" }

POST /api/companies/{companyId}/scheme-versions/{versionId}/tiers
{ "minimumTonnes": "100.000000", "discountPercentage": "1.2500" }
```

`kind` is `stockItem` or `stockGroup`. Built-in MT/MTS/KG uses `isBuiltin: true`; every other UOM needs a Finance-approved decimal conversion. Nested customer groups are resolved recursively and overlap is rejected on activation. TOD versions lock to their customer-period once tracking starts in Phase 4.

```http
POST /api/companies/{companyId}/credit-note-tax-policies
{
  "gstTreatment": "commercial_no_gst",
  "effectiveFrom": "2026-04-01",
  "effectiveTo": "2027-03-31",
  "approvalReference": "{finance-or-ca-reference}",
  "approverName": "{approver name}",
  "approvedAt": "2026-04-01T09:00:00.000Z"
}

POST /api/companies/{companyId}/contacts
{
  "customerId": "{customerId}",
  "phoneE164": "+919876543210",
  "contactName": "Accounts contact",
  "isPrimary": true
}

POST /api/companies/{companyId}/contacts/{contactId}/opt-ins
{
  "isOptedIn": true,
  "source": "written consent",
  "recordedAt": "2026-04-01T09:00:00.000Z",
  "evidence": { "reference": "{consent record}" }
}
```

Tally source phone/contact fields are read-only evidence. A human must deliberately normalize an E.164 contact and separately record consent; the API never guesses a country code or opt-in.

Call `/validate` before `/activate`. Validation returns all blockers. Activation runs the check again and atomically records the `scheme_version_activated` audit event; activated/evaluated versions cannot be edited. It blocks stale masters, unavailable source masters, missing tax evidence, overlap, incomplete TOD configuration, and changed source configuration.

Use the importable [Phase 3 Postman collection](../postman/Meenakshi-phase-3-rulebook.postman_collection.json) for safe local placeholders. It contains no service-role key, Tally bridge token, or password.

## Phase 4 evaluation API

Phase 4 is available only after the Phase 4 execution migration is applied, the bridge reports `ready`, and a controlled CD or TOD version is active. These calls queue a background job; they do not keep a browser request open while Tally reads a long period.

Every request requires `Authorization: Bearer {access_token}`, an `Idempotency-Key`, and either `administrator` or `finance_approver` access. The server, never the client, resolves the version, groups, calendar, payment allocations, stock lines, UOM conversions, tier, and calculation.

```http
POST /api/companies/{companyId}/evaluations/cd
Authorization: Bearer {access_token}
Idempotency-Key: cd:{salesVoucherId}:attempt-1
Content-Type: application/json

{ "salesVoucherId": "{salesVoucherId}", "evaluatedOn": "YYYY-MM-DD" }
```

This refreshes the invoice and relevant receipt allocation evidence from the bound Tally company, then applies the Day 0 calendar and 80%-of-invoice-due follow-up rule.

```http
POST /api/companies/{companyId}/evaluations/tod
Authorization: Bearer {access_token}
Idempotency-Key: tod:{customerId}:{asOfDate}:attempt-1
Content-Type: application/json

{ "customerId": "{customerId}", "asOfDate": "YYYY-MM-DD", "evaluatedOn": "YYYY-MM-DD" }
```

This locks the applicable immutable version for the customer-period at first evaluation and refreshes the bounded date/customer scope in resumable bridge chunks.

```http
GET /api/companies/{companyId}/evaluations/runs/{evaluationRunId}
Authorization: Bearer {access_token}
```

Poll this route. `refreshing_tally` is expected while bridge chunks run. A successful run reports `completed` or `completed_with_issues` and returns a `proposalId` when an entitlement snapshot exists. A `failed` run must never be treated as eligibility.

```http
GET /api/companies/{companyId}/evaluations/proposals/{proposalId}
Authorization: Bearer {access_token}
```

It returns finance-safe current values, latest summary snapshots, and open blocking issues, not raw Tally XML or raw source payloads. Phase 4 never approves, posts, exports, or messages a Credit Note.

Use the importable [Phase 4 Postman collection](../postman/Meenakshi-phase-4-evaluations.postman_collection.json) for a safe local flow.

## Phase 5 finance review and Credit Note lifecycle

Phase 5 begins only for an eligible proposal produced by Phase 4. A Finance Approver does not send an amount, ledger, voucher type, date, allocation, or arbitrary source evidence to the API.

Before approval, queue a proposal-specific targeted refresh:

```http
POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/refresh
Authorization: Bearer {finance_approver_access_token}
Content-Type: application/json

{}
```

This returns an `evaluationRun`. Keep the evaluator worker, outbox worker, and bridge running, then poll the normal Phase 4 evaluation-run endpoint. Approval is accepted only when that exact review refresh has completed, its frozen proposal evaluation still matches the proposal fingerprint, and it is less than 15 minutes old.

```http
POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/review
Authorization: Bearer {finance_approver_access_token}
Content-Type: application/json

{ "decision": "approve" }
```

The server derives the immutable Credit Note snapshot and queues the `create_credit_note` bridge command. It returns `202` with a `creditNotePostingId`; this is not proof that a Credit Note was created.

```http
POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/review
Authorization: Bearer {finance_approver_access_token}
Content-Type: application/json

{
  "decision": "reject",
  "proposalEvaluationId": "{latestProposalEvaluationId}",
  "reason": "Reason recorded in the finance audit trail"
}

GET /api/companies/{companyId}/credit-notes
Authorization: Bearer {access_token}
```

To retry only a `failed` or `correction_required` posting after the actual Tally/configuration issue is fixed:

```http
POST /api/companies/{companyId}/credit-notes/{creditNotePostingId}/retry
Authorization: Bearer {access_token}
Content-Type: application/json

{ "reason": "Recorded reason for the audited retry" }
```

The bridge searches Tally before it creates a voucher, and then independently reads it back. A result is `created_verified` only after company, party, voucher type, discount ledger, amount, allocation/reference, no-inventory, no-GST, and ledger hash checks match. PDF status remains pending unless a real file location, SHA-256, size, and matching Tally GUID are returned.

## Phase 6 notifications

Phase 6 has no endpoint for arbitrary text or a browser-supplied phone number. The database creates an initial message only when the recorded E.164 contact has a current opt-in, an approved organization template is active, and the live business condition still passes.

`POST /api/companies/:companyId/notifications/credit-note-recovery` is the narrow recovery path for a Credit Note that was already `created_verified` before notification setup. It accepts only `creditNotePostingId`, derives the CD/TOD event from its own proposal, is available to an Administrator or Finance Approver, and remains idempotent. It cannot choose a recipient, template, or message text.

```http
GET /api/companies/{companyId}/notifications
GET /api/companies/{companyId}/notifications/health
GET /api/companies/{companyId}/notifications/{notificationMessageId}
POST /api/companies/{companyId}/notifications/previews

{ "notificationMessageId": "{notificationMessageId}" }
```

An Administrator or Finance Approver can recover a missed current CD shortfall event; the server derives all content from the proposal and returns a blocked reason when the condition, opt-in, or template is unavailable:

```http
POST /api/companies/{companyId}/notifications/shortfall

{ "proposalId": "{proposalId}" }
```

A resend is the only operator-created delivery event. It uses the original recipient and frozen business payload with the currently approved template, and needs both a human reason and (recommended) request idempotency key:

```http
POST /api/companies/{companyId}/notifications/{notificationMessageId}/resend
Idempotency-Key: {client-generated-uuid}

{ "reason": "Customer requested the verified Credit Note again." }
```

Administrators manage only approved MSG91 template metadata at `/api/companies/{companyId}/message-templates`. The `componentSchema` maps the exact approved MSG91 components to server-derived variables. Replacing an active template is blocked while it still has queued, retrying, or sending messages. Message list/detail responses are sanitized; use the protected preview endpoint for rendered approved-template components.

The independent worker claims delivery leases and must be run separately from the Tally outbox:

```powershell
cd backend
$env:MEENAKSHI_MSG91_TRANSPORT = 'mock' # local verification only
npm run worker:notifications:local
```

The mock supports `MEENAKSHI_MSG91_MOCK_RESULT=temporary_failure` and `permanent_failure`. Production requires server-only `MSG91_AUTHKEY` and `MSG91_WHATSAPP_NUMBER`; never add these variables to the frontend. If `phase 6-old` is already applied, apply the Phase 6 deltas in order: `20260807000100_phase_6_notification_safety_upgrade.sql`, then `20260807000200_phase_6_contact_order_repair.sql`.

## Phase 7 Collections operations and launch control

Apply the append-only migration `20260808000000_phase_7_collections_operations.sql` after the Phase 1–6 migration chain. It introduces no automatic posting: a company with no launch-control row is safely treated as `review_only`.

Both Administrators and Finance Approvers can read company-scoped launch state and operational health:

```http
GET /api/companies/{companyId}/launch-control
GET /api/companies/{companyId}/operations/health
Authorization: Bearer {access_token}
```

`GET /operations/health` returns safe readiness summaries, durable outbox/bridge/message counts, configuration gaps, stale-review counts, launch state, and prioritized next actions. It deliberately excludes Tally XML, command payloads, credentials, provider secrets, and customer phone data.

An Administrator can enable posting only with an explicit Finance reconciliation period and reference:

```http
PATCH /api/companies/{companyId}/launch-control
Authorization: Bearer {administrator_access_token}
Content-Type: application/json

{
  "mode": "posting_enabled",
  "reconciliationPeriodFrom": "2026-08-01",
  "reconciliationPeriodTo": "2026-08-31",
  "reconciliationReference": "FIN-RECON-2026-08"
}
```

To immediately return to the safe default:

```http
PATCH /api/companies/{companyId}/launch-control
Authorization: Bearer {administrator_access_token}
Content-Type: application/json

{ "mode": "review_only" }
```

In `review_only`, evaluations, evidence refresh, rejection, messages, and reconciliation stay available. Proposal approval and Credit Note retry return `409` with “Credit Note posting is not enabled for this company.” Already verified Credit Notes remain visible and immutable.

For a selected safe correlation or entity, use:

```http
GET /api/companies/{companyId}/operations/detail?correlationId={correlationId}
GET /api/companies/{companyId}/operations/detail?entityType=integration_outbox&entityId={outboxId}
Authorization: Bearer {access_token}
```

This returns only sanitized command, outbox, and audit summaries; it never selects payload/XML columns, phone data, or credentials.

### Guided-workflow recovery and safe documents

Connector registration, binding, credential rotation, and binding deactivation are Administrator-only. Rotation intentionally changes the connector to `pending_pairing` and returns a one-time token only in that response:

```http
POST /api/connectors/{connectorId}/rotate-credential
Authorization: Bearer {administrator_access_token}

PATCH /api/connectors/{connectorId}/bindings/{bindingId}
Authorization: Bearer {administrator_access_token}
Content-Type: application/json

{ "isActive": false }
```

The second request is only for an incorrect company binding. It is audited and permits a correct rebind; it never changes a historical verified Credit Note.

Administrators and Finance Approvers can read the safe verified-document state below. The response never contains `document_storage_path`; `downloadUrl` is present only when the server has verified-document URL configuration.

```http
GET /api/companies/{companyId}/credit-notes/{creditNotePostingId}/document
Authorization: Bearer {access_token}
```

## Operational commands

```powershell
# Backend API
cd backend
npm run dev

# Phase 3 Rulebook frontend (separate terminal)
cd ..\frontend
copy .env.example .env.local
# Set only NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
# and NEXT_PUBLIC_API_BASE_URL in .env.local, then:
npm run dev

# Durable outbox dispatcher — leave running during a sync
npm run worker:tally-outbox:local

# Phase 4 evaluator worker — leave running while a CD/TOD run is pending
npm run worker:evaluations:local

# From the tally-bridge folder: pair and verify the open Tally company.
# The browser generates this one-time command after connector registration.
cd ..\tally-bridge
npm.cmd run connect -- --api-base http://localhost:3001 --connector-id <connector-uuid> --installation-key <installation-key> --control-token <one-time-token> --tally-url http://localhost:9000

# Continuous heartbeat and command processing during a sync
npm.cmd run start
```

## Controlled Phase 2 smoke-test sequence

1. Sign in and call Bootstrap.
2. Run a local bridge `probe`; confirm the intended controlled Tally company name and GUID.
3. Register that identity as a separate Meenakshi company.
4. Create, pair, and bind its connector.
5. Run the generated `npm.cmd run connect` command; Tally health must return `status: "ready"` and matching expected/observed identities.
6. Start the outbox worker and bridge loop.
7. Request a master sync; poll until `completed`; health must show `sync.masters.status: "current"`.
8. Request a one-day voucher sync; poll until `completed`; health must show `sync.vouchers.status: "current"`.
9. Retain the sync-run IDs and terminal logs for the test record. A failure or `stale` state is not a successful sync.

## Phase 3 entry gate

Phase 3 must not begin merely because the bridge paired. It begins when the controlled smoke test has both a successful master sync and a successful bounded voucher sync, and Tally health reports `ready` with fresh current evidence for both.

Once that gate passes, Phase 3 is backend plus frontend configuration work: CD/TOD rule versions, calendars, group/stock eligibility, UOM conversions, tiers, controlled contacts, and WhatsApp opt-ins. It still does not calculate discounts or create Credit Notes; those begin in Phases 4 and 5.
