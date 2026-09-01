# Meenakshi backend

Standalone backend for the Cash Discount and Turnover Discount module.

The Kalika project at `../autodealer-workflow` is reference-only. The existing
Meenakshi Supabase migrations remain at `../supabase`.

## Phase 6 notifications

If the earlier `phase 6-old` migration is already applied, apply these append-only Phase 6 repairs in order:

1. `../supabase/migrations/20260807000100_phase_6_notification_safety_upgrade.sql`
2. `../supabase/migrations/20260807000200_phase_6_contact_order_repair.sql`

Then run the notification worker separately from the Tally worker:

```powershell
npm run worker:notifications:local
```

For safe local verification, set `MEENAKSHI_MSG91_TRANSPORT=mock`. The mock supports `MEENAKSHI_MSG91_MOCK_RESULT=temporary_failure` or `permanent_failure` to exercise retries without sending WhatsApp.

Production requires server-only `MSG91_AUTHKEY` and `MSG91_WHATSAPP_NUMBER`. Optional `MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE` supplies a trusted public base for an already verified Credit Note PDF; without it no PDF link is added. Never put these variables in the frontend environment.

## Phase 7 launch and operations controls

Apply `../supabase/migrations/20260808000000_phase_7_collections_operations.sql` after the complete Phase 1–6 migration chain. Every company remains implicitly `review_only` until an Administrator records a selected reconciliation period and Finance reference through `PATCH /api/companies/:companyId/launch-control`.

`review_only` does not stop evaluation, evidence refresh, Finance rejection, messages, or reconciliation. It does block new Credit Note approval and retry before a durable outbox command is created. `GET /api/companies/:companyId/operations/health` and `/operations/detail` return company-scoped safe summaries only; payloads, raw XML, secrets, provider credentials, and phone data are deliberately excluded.
