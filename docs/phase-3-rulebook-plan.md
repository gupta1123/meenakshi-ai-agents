# Meenakshi Phase 3 — Rulebook, calendars, contacts, and production configuration

**Status:** Implemented locally — pending application of the Phase 3 migration and controlled-company QA  
**Depends on:** Phase 1 foundation and Phase 2 live Tally synchronization (controlled-company smoke test passed)  
**Scope:** Administrator configuration APIs and the Rulebook administration UI  
**Not in this phase:** CD/TOD calculations, proposal review/approval, Credit Note posting/PDFs, or MSG91 message sending

## Outcome

Phase 3 makes Meenakshi configurable safely. An administrator will be able to use fresh, company-scoped Tally master data to define and activate independently managed Cash Discount (CD) and Turnover Discount (TOD) rule versions, working calendars, approved UOM conversions, controlled contacts, and WhatsApp opt-ins.

The output is a validated and auditable rulebook that Phase 4 can evaluate deterministically. It will not calculate or grant a discount yet.

## Codebase structure

The existing folders keep one responsibility each:

```text
meenakshi/
  backend/                 authenticated API, authorization, validation, audit writes
  tally-bridge/            local Windows/Tally transport only; no rule business logic
  frontend/                sibling administrator web app for Rulebook configuration
  supabase/migrations/     append-only migrations only if a genuine schema gap is found
  docs/                    implementation and API documentation
  postman/                 API collection used during backend verification
  autodealer-workflow/     Kalika reference only — not part of the Meenakshi application
```

`backend/` remains the server-side authority. The new `frontend/` will only call authenticated Meenakshi APIs; it will never use the Supabase service-role key or write configuration tables directly. We will not alter the already-applied migrations. If implementation identifies a real missing field/constraint, it receives a new timestamped append-only migration.

### Planned implementation map

The Phase 3 implementation will add only these focused areas. There will be no `meenakshi/meenakshi`, `apps/api`, or copied Kalika folders.

```text
backend/
  src/
    app/api/companies/[companyId]/
      rulebook/reference-data/route.ts       latest usable Tally masters + sync readiness
      calendars/route.ts                     list/create calendars
      calendars/[calendarId]/route.ts        read/update/deactivate a draft calendar
      calendars/[calendarId]/holidays/route.ts
      schemes/route.ts                       list/create CD or TOD schemes
      schemes/[schemeId]/route.ts            rename, describe, pause/retire parent scheme
      schemes/[schemeId]/versions/route.ts   create a draft version
      scheme-versions/[versionId]/route.ts   read/update draft metadata
      scheme-versions/[versionId]/groups/route.ts
      scheme-versions/[versionId]/stocks/route.ts
      scheme-versions/[versionId]/conversions/route.ts
      scheme-versions/[versionId]/tiers/route.ts
      scheme-versions/[versionId]/validate/route.ts
      scheme-versions/[versionId]/activate/route.ts
      contacts/route.ts                      controlled contact list/create/update
      contacts/[contactId]/opt-ins/route.ts  record consent or revocation evidence
      credit-note-tax-policies/route.ts      Finance/CA policy evidence needed for activation
    lib/rulebook/
      shared.ts                              guards, parsing, freshness, audit, serializers

frontend/
  src/
    app/page.tsx                             authenticated Rulebook entry page
    components/MeenakshiRulebookApp.tsx      company status, calendars, rules, contacts
    lib/
      api.ts                                 authenticated calls to backend only
      supabase.ts                            browser session handling; no service role

docs/
  phase-3-rulebook-plan.md                  this design and implementation contract
  api-reference.md                          updated only after each API is verified

postman/
  Meenakshi-local.postman_collection.json           Phase 1/2 administrator API requests
  Meenakshi-phase-3-rulebook.postman_collection.json  Phase 3 administrator API requests
```

`tally-bridge/` is deliberately unchanged in Phase 3. It already provides the master freshness needed by the Rulebook; Phase 3 consumes its synchronized output and does not create a new Tally command.

## What I will build — Phase 3

### 1. Rulebook authorization and live configuration reference data

- Add one shared company-scoped Rulebook authorization layer for every Phase 3 endpoint.
- Permit only an organization `administrator` to create/change calendars, draft rules, activate/pause rules, update controlled contacts, or record opt-in evidence.
- Check that the Meenakshi feature is enabled, the selected company belongs to the caller's organization, and Phase 2 master sync is current before configuration can be activated.
- Provide read-only reference data from the latest synchronized Tally snapshots: customer groups and their hierarchy, customer ledgers, stock groups/items, UOMs, voucher types, and accounting ledgers.
- Never accept a browser-supplied Tally master identifier without confirming it belongs to the requested company and is currently available.

### 2. Working calendars

- Build calendar administration over the existing working-calendar tables: calendar name, weekly non-working days, active holiday dates, and holiday source/evidence.
- Create the Meenakshi calendar with Sunday as a configured non-working day and add only client-supplied active holidays. Sunday will be configuration, not a global hard-coded calculation rule.
- Show the calendar revision and the impact of a planned change before saving it.
- Preserve every revision. Later Phase 4 CD evaluations will capture the exact revision used and will be invalidated when an unposted evaluation's calendar changes.

### 3. Immutable CD and TOD rule versions

- Build logical schemes and editable **draft** versions. An administrator can edit only a draft.
- Activating or using a version makes it immutable. Any later business change creates a new draft/version; it never rewrites history.
- Keep CD and TOD fully independent: either can be configured, activated, paused, or left disabled without affecting the other.
- Capture common rule configuration: exact company, customer-group coverage, effective dates, discount rate, eligible pre-GST product-taxable-value basis, explicit rounding method/scale, approval requirement, commercial/no-GST treatment, Credit Note voucher type, and discount ledger.
- Maintain the existing Finance/CA-approved company Credit Note tax-policy evidence. Activation requires the policy to cover the rule version's complete effective period; an administrator cannot bypass this by selecting a voucher type or ledger alone.
- Capture CD-specific configuration: invoice-date Day 0, working-day count, selected calendar, and the 80% follow-up threshold. The threshold is explicitly **80% of the invoice amount due**, not 80% of a discounted settlement target.
- Capture TOD-specific configuration: period anchor/month length, eligible stock items/groups, UOM-to-tonne conversions, and non-overlapping quantity tiers. The later evaluator will apply the highest achieved tier rate to the full eligible value.

### 4. Group coverage, UOM conversion, and activation validation

- Display recursive customer-group coverage, including nested descendants, before a rule is activated.
- Reject overlapping coverage for the same scheme during intersecting effective dates. There is no hidden priority rule to choose between conflicting versions.
- Validate against a fresh successful master sync before activation:
  - selected customer groups and their descendants are available;
  - the Credit Note voucher type is live;
  - the selected discount ledger is live and has the required GST treatment;
  - CD has a current working calendar and complete day/threshold settings;
  - TOD has an eligible stock selection, each required approved UOM conversion, and valid non-overlapping tiers.
- For TOD drafts, store conversion records on the rule version. `MT`/`MTS` may be configured as 1 tonne and `KG` as 0.001 tonne only where those are the actual selected live UOMs; every other conversion needs explicit client approval. No conversion will be guessed later from value, rate, or narration.
- Return precise validation errors and a blocking-data list rather than allowing a partially configured active rule.

### 5. Controlled customer contacts and WhatsApp opt-ins

- Show synchronized customer contacts as evidence, but make any manual addition/change a controlled administrator action with its source and audit trail.
- Support one active, normalized primary contact per customer according to the existing schema safeguards.
- Record WhatsApp opt-in separately from the phone number, with source, timestamp, and evidence; support revocation.
- Treat missing or revoked opt-in as unavailable. This phase only records eligibility; it does not send a WhatsApp message.

### 6. Rulebook administration UI

- Create a clean sibling `frontend/` app only when implementation begins, keeping it separate from `backend/` and `tally-bridge/`.
- Add administrator pages for:
  - company and sync-readiness status;
  - working calendars and holidays;
  - CD and TOD scheme lists, draft/version history, and activation state;
  - Finance/CA Credit Note policy evidence needed before a version can activate;
  - group coverage preview and activation errors;
  - TOD stock/UOM/conversion/tier setup;
  - controlled contacts and opt-in evidence.
- The UI will clearly distinguish **Draft**, **Validated**, **Active**, **Paused**, and **Blocked by stale/missing master data**. It will show a read-only active-version history rather than an edit button.
- Keep operational calculation queues, finance approval, Credit Notes, PDFs, and Messages out of this UI until their later phases.

### 7. Backend API contracts, auditability, and tests

- Add authenticated server APIs for rulebook reference data, calendars, schemes, draft versions, draft children (groups/stocks/conversions/tiers), validation, activation/pause, contacts, and opt-ins.
- Make activation a server-side operation that runs validation and records the final result atomically; the UI cannot bypass it.
- Write append-only audit events for calendar/configuration changes, validation, activation, pause, contact changes, and opt-in/revocation.
- Add API and domain tests for role enforcement, cross-company rejection, stale master-data blocking, nested group coverage, overlap rejection, immutable active versions, calendar revision handling, tier overlap, conversion blocking, contact controls, and opt-in revocation.
- Update the API reference and Postman collection with only non-secret examples needed by the future frontend.

## Implementation order (completed locally)

1. Implement server-side Rulebook authorization and read-only live master reference endpoints.
2. Implement calendar APIs and revision/audit behaviour.
3. Implement draft CD/TOD version APIs and child configuration APIs.
4. Add recursive coverage preview and server-side activation validation.
5. Implement controlled contacts and opt-in APIs.
6. Implement the Finance/CA Credit Note policy-evidence API required by the existing activation safeguard.
7. Verify the backend with Postman and automated tests using the controlled Tally company.
8. Scaffold the separate `frontend/` app and build the Rulebook administration screens against the verified APIs.

Backend validation comes first because a frontend form must not be the only place that enforces financial configuration rules.

## Inputs required before production activation

Engineering can build and test the workflow with the controlled Tally company, but no production scheme can be activated until Meenakshi supplies and the bridge validates:

- customer groups for CD/TOD coverage;
- CD rate and day-count settings;
- TOD period, tiers/rates, eligible stock selections, and any non-built-in UOM conversion factors;
- active holiday list;
- approved live Credit Note voucher type and discount ledgers/GST treatment;
- controlled contact corrections and WhatsApp opt-in evidence.

No client rate, tier, group, ledger, voucher type, conversion, holiday, contact, or opt-in will be invented in code or migrations.

## Migration audit

**Result: one small Phase 3 migration is required.** The deployed schema already contains every persistent Phase 3 concept and its core safety constraints:

| Phase 3 need | Existing deployed schema support |
| --- | --- |
| Calendar, weekly non-working days, holidays, and revisions | `working_calendars`, `working_calendar_non_working_weekdays`, `working_calendar_holidays`, revision triggers |
| Draft/active CD and TOD rules | `schemes`, `scheme_versions`, status enums, effective-date and CD/TOD shape constraints |
| Selected customer groups and recursive coverage | `scheme_version_customer_groups`, `scheme_version_group_coverage`, recursive refresh functions |
| Selected TOD stock items/groups, UOM conversions, and tiers | `scheme_version_stock_items`, `scheme_version_stock_groups`, recursive stock-group coverage, `scheme_version_unit_conversions`, `scheme_version_tiers` |
| Safe activation | `validate_scheme_version_activation()` checks live selected masters, calendar, tiers, UOM coverage, non-overlap, and Finance/CA tax-policy coverage |
| Immutable active/evaluated rule history | version and child immutability triggers |
| Controlled contacts and consent | `customer_contacts`, `whatsapp_opt_ins`, unique active-primary/current-consent indexes |
| Audit and browser isolation | append-only `audit_events`; RLS and grants restrict configuration/accounting tables to server APIs |

Phase 2 already retains the phone/contact values supplied by Tally in the synchronized customer source payload. Phase 3 will display that live evidence and require a controlled administrator confirmation/normalization before creating a `customer_contacts.phone_e164` record. This avoids incorrectly guessing a country code or treating an unverified Tally text value as WhatsApp consent.

The implementation audit identified one concrete service-boundary gap: the existing trigger validates activation, but the API otherwise cannot make validation, activation, and the audit insert one database transaction. This is supplied by:

```text
supabase/migrations/20260804000000_phase_3_rulebook_activation.sql
```

It adds two service-role-only functions: a structured validation preflight and an atomic activation function. It does not add production rule data or modify any prior migration.

Any later database gap will receive one additional append-only file named in this pattern:

```text
supabase/migrations/YYYYMMDDHHMMSS_phase_3_<specific_gap>.sql
```

It will contain only the identified database change, a safe backfill if needed, RLS/grant changes where relevant, and a corresponding test. We will not modify any `20260801...` or `20260803...` migration that is already applied.

## Definition of done

Phase 3 is complete when an administrator can create, validate, activate, pause, and inspect immutable CD/TOD rule versions using fresh Tally master data; configure a versioned working calendar; maintain controlled contacts/opt-ins; and see an auditable explanation for every blocked or allowed action. The local code has reached this state; it still needs the new migration applied and a controlled-company QA run before the next phase consumes frozen configuration for CD/TOD calculations.
