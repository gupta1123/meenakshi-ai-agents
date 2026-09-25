# Frontend GET Latency Report
Generated: 2026-09-22T16:30:27.570Z
API base: http://localhost:3001
Org: 257a170a-1d02-4e21-aa33-93efff94fb10 | Company: 963aa157-7c2e-4006-8efb-35902a30ec54 (MEENAKSHI UDYOG (INDIA) PVT LTD - (2025-2026))
User: meenakshi.api.admin@example.test (administrator)
Runs: 3 per endpoint, median reported. Cache: cold (120ms gap between runs, no frontend readCache here).

| Status | Median | Avg | Path |
|---|---|---|---|
| ✅ | 758ms | 1193ms | `GET /api/bootstrap` `/api/bootstrap` |
| ✅ | 1147ms | 1168ms | `GET /api/active-company` `/api/active-company?companyId=963aa157-7c2e-4006-8efb-35902a30ec54` |
| ✅ | 403ms | 645ms | `GET /api/companies/:id/overview` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/overview` |
| ✅ | 324ms | 890ms | `GET /api/companies/:id/operations/health` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/operations/health` |
| ✅ | 549ms | 833ms | `GET /api/companies/:id/tally-activity` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/tally-activity` |
| ✅ | 758ms | 758ms | `GET /api/companies/:id/tally-health` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/tally-health` |
| ⚠️ 400/400/400 | 1706ms | 1358ms | `GET /api/companies/:id/operations/detail` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/operations/detail?limit=5` |
| ✅ | 530ms | 641ms | `GET /api/companies/:id/launch-control` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/launch-control` |
| ✅ | 1105ms | 1012ms | `GET /api/companies/:id/rulebook/reference-data` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/rulebook/reference-data` |
| ✅ | 878ms | 1061ms | `GET /api/companies/:id/rulebook/overview` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/rulebook/overview` |
| ✅ | 482ms | 549ms | `GET /api/companies/:id/schemes` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/schemes` |
| ✅ | 717ms | 784ms | `GET /api/companies/:id/schemes/:schemeId` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/schemes/090c1d96-7cf4-4980-a134-25ad85ffcb5d` |
| ✅ | 1120ms | 1109ms | `GET /api/companies/:id/scheme-versions/:versionId` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/scheme-versions/94aa3a17-fe36-4523-8fdb-9856b63ceb64` |
| ✅ | 730ms | 1081ms | `GET /api/companies/:id/calendars` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/calendars` |
| ✅ | 525ms | 536ms | `GET /api/companies/:id/contacts` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/contacts` |
| ✅ | 505ms | 618ms | `GET /api/companies/:id/evaluations/proposals?schemeType=tod` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/evaluations/proposals?schemeType=tod&limit=5` |
| ✅ | 463ms | 469ms | `GET /api/companies/:id/evaluations/proposals?schemeType=tod&activeOnly` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/evaluations/proposals?schemeType=tod&activeOnly=true&limit=5` |
| ✅ | 358ms | 389ms | `GET /api/companies/:id/evaluations/runs` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/evaluations/runs?schemeType=tod&limit=5` |
| ✅ | 2844ms | 3382ms | `GET /api/companies/:id/evaluations/cd/local-bootstrap` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/evaluations/cd/local-bootstrap` |
| ⚠️ 422/422/422 | 505ms | 516ms | `GET /api/companies/:id/evaluations/tod/local-bootstrap` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/evaluations/tod/local-bootstrap` |
| ✅ | 494ms | 978ms | `GET /api/companies/:id/vouchers` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/vouchers?dateFrom=2025-04-01&dateTo=2025-04-30&voucherKind=sales` |
| ✅ | 508ms | 528ms | `GET /api/companies/:id/credit-notes` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/credit-notes` |
| ✅ | 908ms | 1137ms | `GET /api/companies/:id/cash-discount/recoveries` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/cash-discount/recoveries` |
| ✅ | 489ms | 490ms | `GET /api/companies/:id/notifications` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/notifications` |
| ✅ | 627ms | 1276ms | `GET /api/companies/:id/notifications/health` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/notifications/health` |
| ✅ | 2823ms | 2657ms | `GET /api/companies/:id/notifications/test` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/notifications/test` |
| ✅ | 857ms | 1445ms | `GET /api/companies/:id/message-templates` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/message-templates` |
| ✅ | 792ms | 1094ms | `GET /api/companies/:id/message-templates?providerCatalog` `/api/companies/963aa157-7c2e-4006-8efb-35902a30ec54/message-templates?providerCatalog=true` |
| ✅ | 514ms | 546ms | `GET /api/connectors?organizationId` `/api/connectors?organizationId=257a170a-1d02-4e21-aa33-93efff94fb10` |
| ✅ | 1198ms | 1597ms | `GET /api/connectors/:id/tally-companies` `/api/connectors/ab707de3-2b48-494e-b6dd-a9b94a8f0892/tally-companies` |

### Notes
- All calls authenticated with Supabase JWT `Authorization: Bearer <token>`.
- Dynamic IDs: schemeId=090c1d96-7cf4-4980-a134-25ad85ffcb5d, versionId=94aa3a17-fe36-4523-8fdb-9856b63ceb64, proposalId=none, runId=none, contactId=none, connectorId=ab707de3-2b48-494e-b6dd-a9b94a8f0892. Some endpoints skipped when no fixture exists.
- Backend: Next.js 15 Turbopack on localhost:3001 (pid 19676 at test time). Supabase: https://onjbqvqinbsojdptqixo.supabase.co.
