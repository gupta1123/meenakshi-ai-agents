# CD/TOD result-only reset

The reset **archives visibility**, not accounting data. An append-only
`audit_events` marker (`discount_results_archived`) records a company-specific
cutoff. CD/TOD lists, calculation history, dashboard and overview ignore older
calculations. New calculations appear normally after the cutoff.

Rules, rule-version locks, settings, customers, Tally records, existing notes,
PDFs, messages and immutable calculation evidence are retained. Credit Notes
explicitly load archived proposal links. Duplicate-posting checks remain intact.
Old result buttons cannot create notes until the result is recalculated.

There is no public reset endpoint. Only the operator script can append the marker
using backend credentials. It never deletes/updates a row, enqueues a command,
calls Tally, or sends a message. No database migration is required.

## Procedure

1. Deploy the visibility-aware backend/frontend first. Do not calculate during reset.
2. Finish all cloud and local calculations and pending note operations. The connector
   may be closed without unpairing; Tally does not need to be connected.
3. Run `scripts/reset-discount-results.mjs prepare COMPANY_ID` with backend environment
   loaded. It backs up scoped results, rules/settings and accounting tables under
   the Git-ignored `.runtime-logs/result-reset-backups` directory.
4. Review the target company and backup manifest. Run `apply COMPANY_ID BACKUP_DIRECTORY`.
   The script refuses if scoped data changed, a job is active, or the backup is wrong.
5. Run `verify COMPANY_ID BACKUP_DIRECTORY`: all saved table hashes must be unchanged
   and visible result counts must be zero. Refresh the browser to discard old state.
6. Reconnect the connector and calculate again. Creation and messaging are separate
   actions; the reset never performs either.

History retained for accounting remains accessible through Credit Notes/audit views;
it is not permanently erased. Backup files contain private business data: do not
commit or share them. Do not disable immutable triggers or use TRUNCATE/CASCADE.
