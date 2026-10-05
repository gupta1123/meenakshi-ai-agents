# Meenakshi Postman checks

Import `Meenakshi-local.postman_collection.json` for the Phase 1/2 connector and Tally-sync checks. Import `Meenakshi-phase-3-rulebook.postman_collection.json` once Phase 3's activation migration is applied. Import `Meenakshi-phase-4-evaluations.postman_collection.json` only after Phase 4's execution migration is applied and a real controlled rule is active. All collections are deliberately local development collections: they do not contain a Supabase service-role key, a password, or a live Tally credential.

## Set-up

In the imported collection, open **Variables** and set these blank values:

| Variable | Source |
| --- | --- |
| `api_base` | Already set to `http://localhost:3001`. Keep it when `npm run dev` is running on this PC. |
| `supabase_url` | Project URL from `backend/.env.local`, without `/rest/v1`. |
| `supabase_publishable_key` | Publishable key from `backend/.env.local`. Never use the secret/service-role key. |
| `admin_password` | Password for the dedicated non-production administrator test user. Keep it local. |
| `machine_fingerprint` | Output from `cd tally-bridge; npm run machine-id`. Set it only when creating a connector. |

The sign-in request saves `access_token`; Bootstrap saves `organization_id` and `company_id`; Create connector saves `connector_id` and the one-time `control_token`; sync requests save `sync_run_id`. The voucher lookup saves `sales_voucher_id` for a CD evaluation.

## Correct run order

1. Start the backend: `cd backend; npm run dev`.
2. Run requests 1, 2 and 3. Before bridge set-up, health should say `not_bound`.
3. Start a controlled Tally setup and obtain the machine fingerprint.
4. Register the approved Tally company from the read-only probe using request **6a**. This creates a separate company record; do not bind the demo company to a real, unrelated company.
5. Create the connector in request 4, then bind it using the `tally_test_company_id` returned by request 6a. The supplied binding request has a `companyId` body field: replace `{{company_id}}` with `{{tally_test_company_id}}` for this controlled Tally test.
6. Configure and pair the local bridge. Then start the outbox worker with `cd backend; npm run worker:tally-outbox:local`, and start the bridge with `cd tally-bridge; npm run start`.
7. Health should report `ready`. Queue master sync, wait for it to complete, then queue a one-day voucher sync.
8. Poll request 11 until the voucher sync status is `completed`, then run request 13. It retrieves the synced Sales vouchers and automatically saves the first posted voucher UUID as `sales_voucher_id`.

The connector bridge routes—pair, heartbeat, command claim, and command result—are intentionally executed by `tally-bridge`, not manually in Postman. Their credentials are stored outside the repository in the local bridge config file.

## Phase 3 Rulebook collection

Run the Phase 2 smoke test first. Then apply `supabase/migrations/20260804000000_phase_3_rulebook_activation.sql` through the normal migration process before importing the Phase 3 collection.

The collection first reads current master choices. Copy only the required master UUIDs into its blank variables, create a calendar and tax-policy evidence, create either a CD or TOD scheme/version, add its required coverage, then validate. Activate only after validation returns `valid: true` and the finance-approved production values have been confirmed.

## Phase 4 evaluation collection

Apply `supabase/migrations/20260805000000_phase_4_evaluation_execution.sql` only after the earlier migration chain is present. Start the API, the Tally outbox worker, the evaluation worker, and the paired bridge loop. Then set the Phase 4 collection's `access_token`, `company_id`, and either a known synced `sales_voucher_id` (CD) or `customer_id` (TOD). Queue one evaluation and poll its run until it completes. The browser/API never supplies money, rates, group coverage, conversion, or a rule version; those are resolved from fresh Tally evidence and active immutable configuration.
# Phase 5 finance review

Import `Meenakshi-phase-5-finance-review.postman_collection.json` after the Phase 5 migration has been applied. It deliberately contains blank variables only. Sign in through the existing local collection first, copy the short-lived user token into the Phase 5 collection, then use a **Finance Approver** token for the review calls. The collection queues a targeted refresh first; keep the Phase 4 evaluator, outbox worker, and bridge running, poll that run to `completed`, re-list the queue, and approve within 15 minutes.

# Phase 6 MSG91 notifications

Import `Meenakshi-phase-6-notifications.postman_collection.json` after applying `phase 6-old`, `20260807000100_phase_6_notification_safety_upgrade.sql`, and `20260807000200_phase_6_contact_order_repair.sql`, in that order. Use an **Administrator** token. It exercises controlled contact consent, approved template metadata, a current CD shortfall event, queue health, preview, attempts, and an audited resend. It does not expose arbitrary message text or a phone number.

# Phase 7 Collections operations

Import `Meenakshi-phase-7-operations.postman_collection.json` only after applying `20260808000000_phase_7_collections_operations.sql`. Set `access_token` to an Administrator token and `finance_access_token` to a Finance Approver token if you have one.

Run the first three requests before changing any state. They verify the safe default: health is readable, launch control is `review_only` when no record exists, and a Finance Approver cannot change it. The collection then demonstrates the required reconciliation metadata, enables posting with a recorded reference, reads the safe operational detail for a correlation if the dashboard returns one, and restores review-only mode. It contains no service-role key, Tally XML, MSG91 credential, or customer phone number.

Import `Meenakshi-phase-7-guided-workflow.postman_collection.json` as the Phase 7 extension. It covers Administrator-only connector recovery, Finance Approver role boundaries, a sanitized notification detail, and safe verified-document state. Its credential-rotation request is intentionally destructive to the old local credential, so run it only with a disposable/local connector and re-pair immediately.
