# Meenakshi Collections — UI acceptance checklist

Use this checklist after the backend, the Tally outbox worker, and the local Tally bridge are running. It tests the same completed workflow that was previously exercised through Postman, but from the staff UI.

## One-time local setup

1. Start the backend, Tally outbox worker, and notification worker as usual.
2. Start the configured local Tally bridge on the computer running Tally Prime, with the intended test company open.
3. Sign in as the test Administrator and choose the authorized test company.
4. Open **Tally Connection**. This is the only place that performs master/voucher synchronization. Do not expect a sync when changing between workspace tabs.
5. If the page shows **Synchronize master data**, choose **Sync master data**. Run the bridge until the page reports that master data is current.
6. Choose a small voucher date range that includes your test sales/receipt vouchers, choose **Sync voucher period**, and run the bridge until the page reports that vouchers are current.

Expected result: the top-right status is **Ready**. Moving between Overview, CD, TOD, Credit Notes, Messages, and Rulebook keeps the loaded company data. A full loading state should occur only after first sign-in, a company change, an explicit refresh/action, or a new Tally sync.

## Phase 1 — Access, feature gating, and company scope

Where: sign-in screen and company selector in the header.

1. Sign in as `meenakshi.api.admin@example.test`.
2. Confirm that only the authorized Meenakshi company is listed.
3. Refresh the browser; confirm the selected company remains selected and the existing history remains visible.
4. Sign out and sign in as the Finance Approver.

Expected result: unauthorized companies and feature-disabled organizations never appear. Finance sees the operational workspace but does not see the Rulebook or launch-control management.

## Phase 2 — Tally connection and global synchronization

Where: **Tally Connection**.

1. Confirm the four readiness steps: company selected, paired bridge, matching Tally company, and current masters/vouchers.
2. As Administrator, test **Sync master data** and then **Sync voucher period**. Run the bridge as each sync is queued.
3. Open Cash Discount after the sync completes.
4. Optional recovery test: use **Rotate bridge credential** or **Deactivate incorrect binding** only against the test connector.

Expected result: downstream pages stay blocked while readiness is not current. Once both syncs finish, every operational page unlocks without repeating the readiness check on every tab. Finance can observe readiness but cannot register, bind, rotate, deactivate, or sync.

## Phase 3 — Rulebook, calendar, contacts, and consent

Where: **Rulebook**; Administrator only.

1. Create or select a working calendar and add a test holiday.
2. Record commercial/no-GST tax-policy evidence.
3. Create a CD draft scheme, then create a draft version using live voucher type, ledger, group, and calendar masters.
4. Add group coverage; for a TOD draft add stock coverage, UOM conversion, and at least one tier.
5. Validate and activate only a complete test draft.
6. Add a controlled contact and record an opt-in with a source and evidence note.

Expected result: drafts can be edited; activated versions cannot. Missing masters, a missing calendar/conversion/tier, or overlapping coverage prevents activation. Controlled contacts and opt-in history are visible without writing a phone number back to Tally.

## Phase 4 — Evaluation

Where: **Cash Discount** and **Turnover Discount**.

### Cash Discount

1. Choose **Check Cash Discounts**.
2. Run **Check Cash Discounts now**. The check reads every invoice covered by the active rule.
3. Wait for the local connector or evaluation worker to finish, then compare the three result tabs: **Eligible invoices**, **Open reminders**, and **Recovery actions**.
4. To confirm that live data is refreshed, change a controlled receipt allocation/amount/date in Tally, save it, and run the check again. The affected invoice must move or update in the appropriate tab.

Expected result: invoices paid in full inside their discount window appear in **Eligible invoices**. Open invoices remain in **Open reminders**, while expired or inconsistent cases appear in **Recovery actions**. A check never creates a Debit Note automatically.

### Turnover Discount

1. Ensure there is an active TOD rule and a synced customer.
2. Open **Turnover Discount**, choose **Start evaluation**, then run **Calculate all eligible customers**.
3. Check the **Qualified** customer list. Change a controlled eligible Sales voucher in Tally, save it, and run the calculation again.

Expected result: the customer list updates its eligible tonnes, achieved tier, and projected discount after the Tally change. A period with no active TOD configuration gives a clear empty/blocked state; it must not invent tier values.

## Phase 5 — Finance review and Credit Notes

Where: proposal **Open** drawer, then **Credit Notes**.

1. Sign in as the Finance Approver.
2. Open an eligible/current proposal. Confirm the protected calculation and review history are visible.
3. With launch mode still **Review-only**, try approval or a posting retry.
4. As Administrator, use Overview → **Manage launch control** only if you are deliberately running the reconciliation test: enter a valid period and reconciliation reference before enabling posting.
5. As Finance, approve the eligible test proposal. Keep the outbox worker and bridge running until it becomes `created_verified`.
6. Open **Credit Notes**. It opens on **All Credit Notes**; use the Verified filter to check voucher number, date, amount, safe Tally identity, verification time, and document state.

Expected result: Finance, not Administrator, has approval authority. Review-only blocks posting/retry with a plain-language reason. A successful posting reaches **Created and verified** only after the Tally read-back. The verified note remains visible after a reload and does not expose XML or storage paths.

## Phase 6 — WhatsApp events

Where: proposal drawer and **Messages**.

1. Open a current Near eligibility CD proposal and choose **Queue shortfall reminder**.
2. Open Messages. The page labels this as **WhatsApp queued** and explains that it is a shortfall reminder, not a Credit Note.
3. Run the notification worker with mock transport. Refresh Messages and use **View** to open the safe attempt timeline; choose **Render preview**.
4. For a verified Credit Note, check that the automatic event exists. If it was verified before opt-in/template setup, fix the prerequisites and use **Recover verified notification** from the proposal detail.
5. For a sent/failed message, test **Resend** with a required reason. Send the same request twice only when checking idempotency through Postman.

Expected result: no recipient or message text can be overridden in the browser. Without recorded opt-in or an approved template, the UI tells you why an event cannot be queued. A provider failure changes only message state; it never repeats Tally posting.

## Phase 7 — Operations, roles, and release gate

Where: **Overview**, **Tally Connection**, and both Administrator/Finance sign-ins.

1. Check Overview cards, the prioritized alert list, and any protected alert detail drawer.
2. Confirm the review-only notice correctly says that posting is off but evaluation/review/messages are still available.
3. Sign in as Finance: confirm Rulebook and launch-control administration are absent; operational tabs remain present because Finance must evaluate, review, view Credit Notes, preview/send guarded messages, and monitor readiness.
4. Sign in as Administrator: confirm rule, contact, template, connector recovery, and launch-control administration are available, but individual proposal approval is not.

Expected result: alerts expose only a safe correlation/detail summary. Changing company resets record-specific drawers and reloads the global workspace once for that new company. Production posting stays disabled until a Finance reconciliation reference is recorded.

## Postman-to-UI coverage

The UI now covers all normal staff workflow calls in the Phase 1–7 Postman collections:

- connector create/bind, health, master sync, voucher sync, and recovery;
- rulebook references, calendars/holidays, policy, schemes/versions, groups/stocks/conversions/tiers, contacts, and opt-ins;
- CD/TOD evaluation, polling, proposal detail, evidence refresh, approval/rejection, Credit Note lifecycle/retry/document;
- templates/catalog, shortfall/recovery events, queue/health/detail/preview/resend;
- operations health/detail and Administrator launch control.

These Postman calls remain deliberately API-only tests, not browser buttons:

- the initial test-company provisioning call;
- explicit list-binding and sync-run diagnostic reads, which are summarized in Tally Connection;
- negative authorization checks (Finance must receive `403` for connector recovery or launch control);
- duplicate/idempotency and deliberately invalid payload cases.

Keep those Postman checks in the regression suite; the UI must not offer buttons intended only to prove that access is denied.
