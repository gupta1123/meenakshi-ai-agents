# Server connector release acceptance

Confirmed 16 Nov 2026: full payment within the Cash Discount deadline earns the agreed discount; staff may issue its Credit Note. No automatic posting or messaging is introduced. The server connector uses the same CD/TOD business calculations as PC mode.

Release evidence must identify the reviewed commit, test data, expected answer, observed answer and any remaining limitation. Passing counts alone do not establish readiness.

- Identical requests join one job; different rules, dates, scopes and saving dates never share results.
- The intended company is verified by GUID before any Tally work.
- While reading for longer than three minutes, leases and online heartbeats stay current.
- Expired or superseded attempts cannot renew or finish; a Stop survives a connector restart.
- A lost upload response can be retried safely; a completed calculation is not changed to failed by a network interruption.
- Finished results survive closing all browsers and restarting the backend; a worker retries saving the same result with the same idempotency key.
- All TOD periods are queued together and saved together without a browser coordinator.
- Mode lookup failures block calculations. Cached pages recheck mode before starting work. Mode switching and new requests cannot strand each other's jobs.
- Existing PC-mode calculations and Credit Note posting still work. Retried Credit Notes are independently read back and do not create duplicates.
- Two users, two distinct calculations, a waiting Credit Note, an unavailable Tally, a connector crash and a backend restart are exercised through the connected stack.
- Hand-calculated CD/TOD examples are reconciled with actual Solution Nyx data. The client pilot additionally checks a real IRN.
- The Windows package includes server startup setup. Installation, logon, crash restart, Remote Desktop disconnect and single-instance ownership are checked before the client pilot.

Automated local tests must use an isolated database and mock transport. Real Tally checks are bounded to Solution Nyx. Client data, posting and notifications require the controlled pilot; the shared production database is not a test fixture.

## Local evidence, 17 Nov 2026

- The queue tests execute the original and recovery migrations in PGlite (PostgreSQL), with no production connection. They verify refusal in PC mode, request sharing, stale-attempt rejection, cancellation after a crash, idempotent completion, save recovery, mode-switch blocking and denied browser-role access.
- An HTTP integration test uses the actual request/claim/progress/finish handlers, SQL functions, connector API client, XML reader and CD evaluator. Its controlled Tally transport contains a ₹100,000 bill for 10 MT and ₹95,000 received within the three-day window: expected and observed CD are ₹5,000. Authentication, Supabase transport and financial snapshot persistence remain separate boundaries; this is not a hosted acceptance test.
- The repaired worker tests reject intentional removal of the Stop guard, renewal delayed to 20 minutes and removal of company verification. These faults formerly passed some tests.
- Browser-runner tests check failed mode lookups, rerouting an existing PC page and submitting every TOD period as one job. They execute the TypeScript runner, not browser UI automation.
- The 0.5.1 Windows payload was started headlessly against controlled HTTP endpoints. A duplicate runtime was refused; killing and restarting the process resumed polling. The hidden runner used the bundled Node runtime and propagated its exit code. These checks do not replace an actual logon or Remote Desktop disconnect test.
- Backend and frontend production builds pass, with existing unrelated lint warnings. Connector, database and frontend routing checks are included in CI.
- A read-only probe confirmed the local Tally company was Solution Nyx. The bounded 11-Aug-2026 query for Apex TMT Traders returned no vouchers, so it provides no financial reconciliation evidence.

Still required before client cutover: independent reconciliation of actual non-empty Tally data, multiple real user sessions, interrupted posting/read-back, a real IRN, a Windows logon/disconnect exercise and the client pilot. The owner deferred the pilot; no client machine has been changed.

## Release order

1. Review and apply `supabase/migrations/20261116182141_server_check_job_recovery.sql` using the established manual migration process. The original queue migration must already exist. Historical prototype results are deliberately not replayed.
2. Deploy the reviewed backend and its evaluation worker, then the frontend. The worker recovers result saves; it must be running. Keep companies in their existing mode during release verification.
3. For the scheduled pilot, install 0.5.1 and pair the server. With all Tally work settled, stop the old PC connector and move the active binding to the server installation. There must be one active binding per company. Enable background startup and select server mode.
4. Run a small period, reconcile the figures and verify one permitted posting and its read-back. Only then approve cutover.
5. To return to PC mode, settle/stop server work, remove its background task, switch mode and restore the old binding and PC connector. Keep the additive schema; do not roll back by deleting tables or financial history.
