# Phase 5 — Finance review and verified Credit Notes

## Outcome

Phase 5 turns a freshly evaluated eligible CD or TOD proposal into a Finance-approved, recoverable, independently verified **commercial no-GST Credit Note** in Tally. It deliberately does not send WhatsApp; MSG91 begins in Phase 6.

## What is implemented

1. A Finance Review queue in the frontend.
   - Administrators retain rulebook access.
   - Finance Approvers can log in to approve, reject with a reason, or retry a failed posting with a reason.
   - The browser has no editable amount, ledger, voucher type, allocation, or date fields.

2. Server-derived approval data.
   - Finance must first queue a proposal-specific Tally refresh. Only the completed immutable evaluation produced by that request is valid for 15 minutes; the database independently enforces this before approval.
   - The backend rebuilds the posting snapshot from the current proposal, latest frozen evaluation, active rule version, customer, and Tally master identities.
   - CD uses `Agst Ref` while the invoice is outstanding and deterministic `New Ref` otherwise.
   - TOD always uses deterministic period-level `New Ref`.
   - Approval calls the existing atomic `approve_proposal_and_enqueue_credit_note` database function.

3. Durable Credit Note lifecycle in the append-only migration:
   - `20260806000000_phase_5_review_and_credit_note_lifecycle.sql`
   - rejected review audit trail;
   - command payload created from the immutable posting snapshot;
   - create/recover → verification → verified PDF states;
   - mismatch/correction-required states;
   - explicit audited retry with a new transport idempotency key and the original business identity preserved.

4. Tally bridge commands.
   - `create_credit_note` first searches Tally by the immutable calculation reference; a matching existing voucher is recovered rather than recreated.
   - `verify_credit_note` independently reads Tally and checks company, voucher type, party ledger, discount ledger, date, amount, bill reference/allocation, no inventory lines, no GST ledgers, and a stable ledger-entry hash.
   - PDF result persistence is supported only after the bridge returns actual PDF metadata. The bridge intentionally refuses to fabricate a PDF. The final Tally HTTP/PDF export transport must be acceptance-tested against the installed Tally Prime edition before enabling retries for PDF export.

## Folder ownership

| Folder | Phase 5 responsibility |
| --- | --- |
| `backend/src/app/api/companies/.../evaluations/proposals` | Finance queue, targeted refresh, and approve/reject action |
| `backend/src/app/api/companies/.../credit-notes` | Posting list and audited retry |
| `backend/src/app/api/bridge/commands/[commandId]/result` | Handles create, verify, and PDF bridge outcomes |
| `backend/src/lib/credit-notes.ts` | Server-only snapshot and deterministic reference building |
| `tally-bridge/src/commands` | Create, verify, and PDF command boundary |
| `tally-bridge/src/tally/credit-notes.mjs` | Accounting-only XML and independent read-back parser |
| `frontend/src/components/ProposalReviewCard.tsx` | Finance queue actions |
| `supabase/migrations/20260806000000_phase_5_review_and_credit_note_lifecycle.sql` | Append-only lifecycle safeguards |

## Safe manual test order

1. Have a paired bridge, current master sync, current voucher sync, an active rule version, and an eligible proposal.
2. Sign in as the test Finance Approver.
3. `POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/refresh`. Run the existing evaluator, outbox worker, and bridge until that evaluation run is `completed`.
4. Refresh the queue and, within 15 minutes, `POST /api/companies/{companyId}/evaluations/proposals/{proposalId}/review` with `{ "decision": "approve" }`.
5. Run the existing outbox worker and bridge `once`/`start` commands. The create command may recover a previously-created matching Credit Note, but never creates a duplicate from a retry.
6. Confirm the posting reaches `verification_pending`, then `created_verified` only after read-back succeeds.
7. Confirm a mismatch moves it to `correction_required`; use the retry endpoint with a reason only after correcting Tally/configuration.
8. Do not mark PDF success until the bridge returns a real PDF path, SHA-256, file size, and matching Tally GUID.

## Migration

This migration is **not applied by the app**. Once the Phase 4 migration is confirmed in the shared Supabase project, give the Phase 5 SQL file to Payal for the normal migration process. Never run it against production without the team’s usual review.
