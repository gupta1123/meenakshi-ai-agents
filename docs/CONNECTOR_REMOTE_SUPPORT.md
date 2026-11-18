# Connector remote support (0.6.3)

## Deployment and first installation

Apply `supabase/migrations/20261118115948_connector_remote_support.sql` in the live SQL Editor before merging the application release. It adds private support jobs, runtime observations and the scoped CD snapshot RPC. Deploy the backend and website, then share `MeenakshiTallyConnectorSetup-0.6.3.exe` manually this time. No additional migration is required for 0.6.1, 0.6.2 or 0.6.3.

Leave **Set up as the shared Tally server** selected in the installer. Pair the company if the computer is not already paired. Setup configures local server mode and the Windows login task; the authenticated background worker completes the website routing handover. Check the connector window and the website for server mode, enabled startup and the expected Tally company. Pairing/settings live outside the installation directory and survive replacement.

Use the full 0.6.3 installer for this first client handover: it includes the acknowledged restart helper needed by future application updates. The earlier pilot installers are superseded.

The scheduled worker runs as the Windows user who paired the connector. It starts at that user's Windows login, and Tally must be open with the correct company. A hidden parent restarts failed workers with backoff from five seconds to one minute; a successful or configuration-error exit stops it. Windows task failure recovery remains enabled as a second layer. Setup and update stop the parent task before replacing or restarting the worker. Closing the website or connector status window does not stop the server worker. A server reboot still needs that Windows session and Tally company available.

## Support operations

The Tally connection page's Advanced section contains Remote connector support. Administrator/finance access is required; updates and private logs require administrator access. The company binding and paired device credential scope every request. There is no remote shell or arbitrary TDL operation.

- Opening balance reads one ledger by GUID and separates its ledger opening, bill-wise opening amounts and unallocated balance. Positive XML amounts are credits, negative amounts debits. Use the actual opening date of the Tally books. A missing ledger is reported as missing, never zero.
- Voucher inspection allows seven days; customer history allows one financial year in seven-day windows. Limits, one attempt and adjustable pauses keep reads bounded. A row limit produces an incomplete result warning.
- Diagnostics use their own queue and do not ingest vouchers or modify normal calculation snapshots. Support operations on one connector run sequentially.
- CD/TOD recalculations accept a customer, group or company. Selected groups are limited to 250 ledgers and split into small batches. Targeted reads resolve current ledger names by GUID and fail if an expected ledger is missing.
- CD includes the rule's earlier payment/credit history. TOD includes the complete calculation period and its payment look-ahead. A chosen historic CD date is diagnostic only; normal saved CD refreshes use today.
- Diagnostic calculations compare with a baseline captured at submission and retain evidence for replay. Saving uses the normal CD/TOD save paths and does not create Credit Notes. A partial CD save requires a prior full evidence-v2 result for that rule; unrelated rows retain their original source run and checked-at timestamp. TOD customer evaluations may continue processing in Calculation history after evidence is accepted.
- Replay re-evaluates captured evidence with the deployed backend calculation and the captured rule. It performs zero Tally reads. Failed saves can retry that same evidence with a permanent idempotency key. Captured evidence is retained before saving; stale interrupted saves become retryable when their status is read.

Every newly saved CD result retains compact excluded invoice details, including payments, credits, deadline, target, used/available on-account credit, connector/calculation version and source provenance. Ordinary dashboard/history responses omit the large excluded list. The invoice-specific settlement API can return an excluded invoice by GUID. Older saved results cannot retroactively supply discarded evidence.

Runtime observations report actual local mode/version, capabilities, Windows user, process/startup status, activity and the latest calculation/diagnostic read. Heartbeats during a support operation reuse the known company snapshot rather than adding Tally probes.

## Update experience and trust

The connector's three-dot menu offers **Update connector**. Check, download progress, verification and **Restart and update** appear in the existing window. A download does not replace the running files. After restart the stable launcher selects the verified release; a version that throws at startup or repeatedly fails to become ready falls back to the previous application release.

Routine updates reuse the installed Electron runtime and unchanged application files. Each changed file is gzip compressed and addressed by its SHA-256. An Ed25519 signature covers the manifest and file hashes; the verification key is pinned in the bootstrap installed by the full installer. Application patches cannot replace the bootstrap, trust key, runtime, pairing or Windows helper scripts. A change to those requires a full installer.

The release scripts inspect the actual bundled Electron binary and sign its runtime major/version (currently 31.7.7), rather than inferring it from the development dependency. Installer packaging rejects a runtime/manifest mismatch. A future runtime change needs a separately published full installer URL, size and SHA-256 in the signed manifest. That fallback downloads in the same window and runs silently during restart. Application rollback preserves a previous application release; it does not restore an older Electron runtime after a full runtime installer replacement. Test and separately plan recovery for runtime upgrades.

Updates may terminate current work, as agreed. Check/support jobs are marked stopped/interrupted. In-flight ordinary commands are retired and dependent sync/evaluation runs are stopped. Uncertain financial postings require checking Tally before a retry; the updater never blindly replays them. Remote updates also restart an open connector status window. Restart helper start/completion/errors are recorded in the private daily connector log. An on-demand Windows task, `Meenakshi Tally Connector (restart)`, runs the helper independently of both the GUI and server task. It uses the same logged-in Windows user with limited privileges and no recurring trigger. The connector waits for a private acknowledgement before exiting. For remote updates, the helper waits for the worker to exit after its result is committed. Handoff records remain under the private configuration directory's `restart-handoffs` folder for support. The verified-download state reveals the Restart button even when it includes byte totals.

## Publishing a routine application update

1. Finish source changes and bump the bridge/shell versions and lockfiles; use a new version for each published release. Do not republish different bytes under a deployed version.
2. Run `node tally-bridge/scripts/build-application-update.mjs` on the release-signing machine. It writes `backend/connector-release.json` and `frontend/public/connector-updates/*.bin`.
3. Run connector/backend/frontend tests and production builds. The release-manifest test checks the signature, hashes, compressed blobs and exact correspondence to source. Build and smoke-test the Windows installer when bootstrap/runtime/helpers changed.
4. Commit the signed manifest, new content-addressed blobs and source together; deploy backend and website together. Retain blobs that deployed manifests still reference. The initial 0.6.0 baseline is small; future downloads depend on how many files actually change.
5. Test Update on a pilot computer, confirm its running version/heartbeat, then trigger further updates from support or the menu.

The signing private key is outside the repository at `%APPDATA%/Meenakshi/ReleaseSigning/connector-ed25519.pem` (or `MEENAKSHI_RELEASE_SIGNING_DIR`). Back it up securely. Never commit it, expose it to the website or silently rotate it; restoring that key is required to update existing installations. A trust-key change requires a separately trusted full installer.

The backend recomputes support results from captured evidence and captured rules, ignoring the connector's calculated totals. The central TOD evaluator has independent business-outcome tests, so its calculation can evolve without changing the installed Tally reader. Its normal save path still applies the authoritative backend proposal logic. The legacy CD evaluators retain their existing parity checks; rule configuration changes already travel with each server request.

## Client acceptance after manual installation

Confirm the expected device/company, actual server mode, enabled startup and 0.6.3 heartbeat. Close the browser and status window and verify the scheduled worker remains connected. Start a small opening-ledger diagnostic, then a seven-day voucher read; inspect the JSON evidence and cancellation/history. Run a diagnostic CD/TOD calculation before saving. For BKC, read the opening bill breakdown, replay the full customer credit history and investigate invoice 12115 and Credit Note 237 separately. Their business explanations remain unconfirmed until that source evidence is checked; matching an amount alone never establishes a manual TOD note's purpose/period.
