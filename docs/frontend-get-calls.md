# Frontend GET Calls — Meenakshi

> Auto-generated 2026-09-22 from `frontend/src` scan (140 `apiRequest` sites, filtered to ~45 distinct GET templates). Backend base: `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:3001`).

## Method note
Frontend uses `apiRequest(token, path)` — defaults to `GET` unless `method` specified. `readCache` dedupes in-flight GETs (TTL 30s for `/rulebook/reference-data`, 5s for `/tally-health` & `/api/active-company`, otherwise infinity for same tick).

## All GET endpoints used by the frontend

| # | Path template | File(s) | Workspace / Purpose |
|---|---|---|---|
| 1 | `GET /api/bootstrap` | `auth-gate.tsx:76` | Auth gate — orgs + companies + roles for logged user |
| 2 | `GET /api/active-company?companyId=` | `auth-gate.tsx:152` | Switch active company |
| 3 | `GET /api/companies/:companyId/overview` | `workspace-session.tsx:72` | Home overview (used when `pathname === "/"`) |
| 4 | `GET /api/companies/:companyId/operations/health` | `global-tally-monitor.tsx:59`, `workspace.tsx:206` | Tally bridge health badge |
| 5 | `GET /api/companies/:companyId/tally-activity` | `global-tally-monitor.tsx:60` | Recent Tally activity feed |
| 6 | `GET /api/companies/:companyId/tally-health` | `tally-readiness.tsx:122` | Detailed Tally connection health |
| 7 | `GET /api/companies/:companyId/operations/detail?*` | `operations-alerts.tsx:43` | Operations alerts detail (filtered by query) |
| 8 | `GET /api/companies/:companyId/launch-control` | `workspace-session.tsx:77,88`, `workspace.tsx:207` | Feature launch control / mode |
| 9 | `GET /api/companies/:companyId/rulebook/reference-data` | `rulebook.tsx:146,181`, `workspace.tsx:209`, `workspace-session.tsx:78,89` (cached 30s) | Masters snapshot: customerGroups, ledgers, voucherTypes, units, stockItems/Groups, customers |
| 10 | `GET /api/companies/:companyId/rulebook/overview?*` | `rulebook.tsx:204` | Rulebook overview (schemes + versions + coverage counts) |
| 11 | `GET /api/companies/:companyId/schemes/:schemeId` | `rulebook.tsx:96` (prefetch cache) | Single scheme detail |
| 12 | `GET /api/companies/:companyId/scheme-versions/:versionId` | `rulebook.tsx:113`, `rule-editor.tsx:248` | Version detail + configuration (groups/stocks/conversions/tiers) |
| 13 | `GET /api/companies/:companyId/calendars` | `rulebook.tsx:240` | Working calendars |
| 14 | `GET /api/companies/:companyId/contacts` | `rulebook.tsx:243`, `workspace-session.tsx:87,97`, `workspace.tsx` | Customer contacts (phone + primary flag) |
| 15 | `GET /api/companies/:companyId/contacts/:contactId/opt-ins` | `rulebook-workspace.tsx:108` | WhatsApp opt-in history for contact |
| 16 | `GET /api/companies/:companyId/evaluations/proposals?schemeType=&activeOnly=&limit=` | `workspace-session.tsx:76,84`, `workspace.tsx:202`, `workspace.tsx:1033` | Proposals list — TOD/CD queue; `activeOnly=true` for turnover page |
| 17 | `GET /api/companies/:companyId/evaluations/proposals/:proposalId` | `workspace.tsx:1358` | Proposal detail + latest evaluation |
| 18 | `GET /api/companies/:companyId/evaluations/runs?schemeType=&limit=&fresh=&detail=` | `guided-evaluation-queue.tsx:80`, `workspace.tsx:401,823,1296` | Evaluation runs history (queue) |
| 19 | `GET /api/companies/:companyId/evaluations/runs/:runId` | `workspace.tsx:441,838,1285,1370` | Single run status poll (4s interval) |
| 20 | `GET /api/companies/:companyId/evaluations/runs/:runId/results` | `workspace.tsx:1158` | Batch results for a run |
| 21 | `GET /api/companies/:companyId/evaluations/cd/local-bootstrap?*` | `workspace.tsx:426` | CD local bootstrap (vouchers for date range) |
| 22 | `GET /api/companies/:companyId/evaluations/tod/local-bootstrap?*` | `workspace.tsx:952` | TOD local bootstrap (periods/customers) |
| 23 | `GET /api/companies/:companyId/vouchers?dateFrom=&dateTo=&voucherKind=sales` | `workspace.tsx:1279` | Sales vouchers lookup for CD evaluator drawer |
| 24 | `GET /api/companies/:companyId/credit-notes` | `workspace-session.tsx:85`, `workspace.tsx:203` | Credit note postings (posting status history) |
| 25 | `GET /api/companies/:companyId/credit-notes/:postingId/document` | `workspace.tsx:1457` | Verified PDF document link |
| 26 | `GET /api/companies/:companyId/cash-discount/recoveries?*` | `workspace-session.tsx:95`, `workspace.tsx:387` (`cache:no-store`) | CD recoveries + previousRuleRecoveries + history (debit note flow) |
| 27 | `GET /api/companies/:companyId/sync/runs/:runId` | `rulebook.tsx:177`, `tally-readiness.tsx:348`, `workspace.tsx:630,648,1402` | Sync run status (masters/vouchers/reconciliation) |
| 28 | `GET /api/companies/:companyId/notifications` | `workspace-session.tsx:86,96,103`, `workspace.tsx:204` | WhatsApp messages (delivery history) |
| 29 | `GET /api/companies/:companyId/notifications/health` | `workspace-session.tsx:104`, `workspace.tsx:205` | Notification health (retrying/terminalFailures) |
| 30 | `GET /api/companies/:companyId/notifications/test` | `messages-workspace.tsx:116,145` | Controlled notification tests |
| 31 | `GET /api/companies/:companyId/notifications/:messageId` | `messages-workspace.tsx:125` | Message detail drawer |
| 32 | `GET /api/companies/:companyId/notifications/cd-reminder-test` | `workspace.tsx:415` | CD reminder dry-run list |
| 33 | `GET /api/companies/:companyId/message-templates` | `workspace-session.tsx:105`, `workspace.tsx:210` | Approved MSG91 templates |
| 34 | `GET /api/companies/:companyId/message-templates?providerCatalog=true` | `messages-workspace.tsx:328` | Provider catalog for template mapping |
| 35 | `GET /api/connectors?organizationId=` | `tally-readiness.tsx:270` | List paired connectors for org |
| 36 | `GET /api/connectors/:connectorId/tally-companies` | `tally-readiness.tsx:285` | Tally companies visible to connector |
| 37 | `GET /api/companies/:companyId/notifications/cd-reminder-test` | `workspace.tsx:415` | (duplicate of 32, separate call site) |
| 38 | `GET /api/companies/:companyId/evaluations/proposals?schemeType=tod&limit=500` | `workspace.tsx:1033` | Saved proposals after TOD local-result |
| 39 | `GET /api/companies/:companyId/sync/runs/:syncRunId` (masters/vouchers) | `rulebook.tsx:177` et al | Poll master sync after trigger |

### Not GET but present in scan (for completeness)
POST /api/companies/:companyId/sync/masters, /sync/vouchers, /evaluations/cd, /evaluations/tod, /evaluations/:scheme, /scheme-versions/:id/activate etc. are mutations — excluded from this MD per request.

## Calls per page (WorkspaceSession routing)

| Pathname | GETs fired in parallel (Promise.all) |
|---|---|
| `/` | `overview` |
| `/turnover-discount` | `proposals?schemeType=tod&activeOnly=true` + `launch-control` + `reference-data` |
| `/credit-notes` | `proposals?schemeType=tod` + `credit-notes` + `notifications` + `contacts` + `launch-control` + `reference-data` |
| `/debit-notes` | `cash-discount/recoveries` + `notifications` + `contacts` |
| `/messages` | `notifications` + `notifications/health` + `message-templates` (admin only) |
| `/rulebook` | (lazy — loads on interaction; `reference-data`, `overview`, `calendars`, `contacts` on demand) |
| `/tally` & `/cash-discount` | empty (handled by GlobalTallyMonitor + separate workspace) |
| Every page | `operations/health` + `tally-activity` (GlobalTallyMonitor, 5s poll) |

## Latency report
See `docs/frontend-get-latency-report.md` (generated after live run with `meenakshi.api.admin@example.test`).
