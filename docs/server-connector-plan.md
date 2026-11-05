# Plan: connector on a Tally server, alongside the current PC connector

**Status:** plan only, nothing built. Written 2026-11-05.
**Goal:** the client's Tally runs permanently on a Windows server. One connector installed there serves every user from the web app. Nobody keeps a PC on or connects their own Tally. The current PC setup keeps working, unchanged.

## 1. How it works today, and what breaks

| Job | Today | On a server |
|---|---|---|
| Credit and Debit Note posting, master and voucher sync, PDF export | Backend queue. The connector claims one job at a time (90 s lease) and reports back. | Works as is. Install the connector on the server. |
| Cash Discount and Turnover Discount calculation | The browser calls the connector on the user's own PC (`127.0.0.1:3219`), the connector reads Tally and calculates, the browser saves the result. | Breaks. The user's PC has no connector. |
| Reading the e-invoice details of a note (`readLocalNoteEInvoice`) | Same browser-to-local-PC call. | Breaks. |

So the real work is moving calculations and the e-invoice read onto the backend queue, and making that queue safe when many people use it.

## 2. Design rules

1. **Per company, one mode.** Each connector is labelled `pc` or `server`. A company's page uses whichever connector the company is linked to. PC mode keeps the exact current code path.
2. **The queue decides, not the connector.** All Tally work for a company goes through one queue. The database already allows one active connector per company (`unique (company_id)` on the binding), and we keep that.
3. **One thing talks to Tally at a time, per company.** Credit Notes are short, so they go in between read windows. Reads run in the existing 10-day windows with pauses.
4. **Same request joins the running one.** The same company, scheme and period while a run is active attaches the new user to it. A different request waits, with its place in line shown.
5. **Jobs survive the browser.** Closing the page doesn't stop a server job. Reopening shows progress or the result. Stop is an explicit button.
6. **No guessing when offline.** If the server connector is offline, the page says so. No fallback to a user's PC and no result from stale data.
7. **Never post twice.** Posting keeps its permanent references, idempotency keys and check-Tally-first rule. A retry after a crash checks Tally before creating anything.

## 2a. Safety: local testing and the live deployment share one database

Local code, the deployed backend (Heroku), the deployed frontend (Netlify) and the client's connectors all use the same Supabase project. So anything I build or test locally can touch production data, and anything I put in the database is seen by the deployed code. These rules apply to every phase.

**Database changes (migrations)**
1. **Additive only.** New tables, new nullable columns, new functions. No drops, renames, type changes or stricter constraints on existing things. The deployed code must keep working before and after a migration.
2. **New functions, not edited ones.** Existing functions the deployed code calls (`claim_tally_commands`, `create_meenakshi_evaluation_run`, the Credit Note enqueue functions and so on) are left as they are. New behaviour goes into new functions.
3. **Defaults keep today's behaviour.** The new connector `mode` defaults to `pc` for every existing connector, so nothing existing changes meaning.
4. **New job types can't reach old connectors.** Calculation jobs are created only for connectors labelled `server`, and the claim step only hands a connector its own jobs. The client's PC connectors never see them.
5. **Order of release:** migration first (safe because it's additive), then backend, then frontend and connector. Rolling code back at any step is safe because the database is a superset.
6. **You apply every migration by hand**, as now, and I give the SQL first so you can read it.

**Local testing**
7. **Test data stays in the test company.** All server-mode tests use Solution Nyx (a different `company_id` from Meenakshi Udyog). Nothing is written under the client's company.
8. **Local workers stay off.** When I ran the app locally on 13 Oct, its workers ran against the real database. For tests, the notification worker is never started (no real WhatsApp), the tally worker only runs if Heroku's is stopped or tests use their own worker id, and the evaluation worker is off unless needed. WhatsApp tests go only to 7977925397.
9. **No Tally queries beyond tiny, bounded ones** on the client's live Tally, as before.
10. **A local server-mode connector is registered as a new, separate connector** bound only to Solution Nyx. It never takes over the client's binding. I check the client's connector, binding and heartbeat before and after each test to prove nothing moved.
11. **Clean up test rows** (jobs, runs) after tests, and only ones I created, identified by id.

**Code**
12. **Feature gated by mode.** The new frontend and backend paths run only when a company's connector is labelled `server`. Every existing company stays on the current code path.
13. **Old frontend and old connectors keep working against the new backend.** New routes are additions. Existing routes keep the same request and response shapes. A cached old browser tab must not break.
14. **The existing 57 backend tests, the connector tests and the typechecks must pass before any release**, plus new tests for each rule above.
15. **Nothing deploys until you say so.** Local first, then a pilot, as before.

**An extra option if you want more safety:** apply the risky migrations first to a throwaway copy of the database (a second Supabase project), test there, then apply to the live one. It costs time and a second project, so I'd use it only if a migration has to change something existing, which the rules above try to avoid.

## 3. Phases

### Phase 1: Backend queue and coordination (no behaviour change for PC mode)
- **Migration** (you apply it):
  - connector `mode` (`pc` or `server`);
  - new queued job types `run_cd_check`, `run_tod_check`, `read_note_einvoice`;
  - job progress and result storage (reuse `calculation_events` for history, add a job row for live progress and the result);
  - a per-company "who is using Tally" gate;
  - job expiry.
- **Routes:** create a job (or join the running identical one), read progress, stop, queue position.
- **Leases:** renewable for reads (the 90 s lease is too short for a read), and a job whose lease lapses goes back to the queue.
- **Priority:** posting jobs run between read windows.
- **Audit:** every job request logs who, role, company, scheme and period with the new audit helper.
- **Tests:** join-same-run, queue-different-run, lease expiry, expiry of old jobs, double Credit Note refused, the mode rules.

### Phase 2: Connector 0.5.0, server mode
- Claim calculation jobs from the queue and run the existing readers and evaluators (no new calculation logic).
- Keep per-batch checkpoints so a restart resumes. Renew the lease as it works. Report progress to the backend.
- Stay as a long-running program: start with Windows, restart after a crash, no window needed.
- Check Tally is open with the right company (GUID) before each job. Report "Tally not ready" clearly.
- Refuse to start in server mode if the company is already bound to a PC connector.
- Existing PC behaviour (local API, background jobs, log upload) stays as it is.

### Phase 3: Frontend
- Cash Discount, Turnover Discount and the e-invoice read check the company's connector mode:
  - `pc`: existing code, untouched;
  - `server`: ask the backend for a job, follow progress from the backend, show "waiting (2nd in line)", "Tally server offline since …", and a Stop button.
- Show who is running a check and the result's stamp (connector, version, time) to everyone.
- Cached old pages must fail safely if they try the local PC for a server company.
- Switching a company from PC to server is blocked while its queue has work.

### Rollout gate
1. Test on this PC first. Run the connector in server mode against **Solution Nyx**, with the browser on another machine or without a local connector.
2. Run the test matrix in section 4. Fix anything found.
3. Pilot with the client's server on a small period.
4. Keep PC mode available as the way back for any company.

## 4. Cases to test

**Who does the work**
- Two users, same company, scheme and period: one run, both see it.
- Two different calculations at once: the second waits.
- A calculation and a Credit Note at once: the note goes between windows.
- Two Credit Notes for different invoices: created one by one, each verified.
- The same Credit Note twice (double click, two users): refused.
- 25 bulk Credit Notes during a calculation: queued behind it.

**Failures**
- Connector killed mid-read: job requeued, resumes from checkpoint.
- Connector dies after Tally created a note but before reporting: retry finds it, no duplicate.
- Tally frozen or closed: clear failure, queue paused.
- Server reboot: connector and Tally return by themselves (setup task).
- Backend restarts during a job: job state survives.
- Browser closed: job continues, page recovers it.
- Old queued request: expires.

**Mixing modes**
- One company on a PC connector, another on the server: each correct.
- Switch PC to server with queued work: blocked.
- Both connectors for one company: refused with a message.
- Old cached tab: fails safely.

**Data and access**
- Server's Tally copy differs from the old PC: compare totals when switching.
- Two Tally companies on one server: reads the right one.
- Server clock and timezone (IST).
- Roles unchanged. Control token stays on the server, no browser-to-connector calls in server mode.
- Audit shows each request and result.

## 5. Open questions for the client
1. Is it Tally Prime running on a Windows server (not Tally Server software)? We assume yes.
2. Can we install the connector on that server and keep it running?
3. Does Tally stay open with the Meenakshi company loaded after a reboot or when people disconnect Remote Desktop?
4. Does the server's Tally data match what staff use now, and is its clock correct?
5. Who can log in to the server to install updates (connector updates are manual)?

## 6. Risks
- Calculation moves from "browser drives it" to "backend queue drives it". It is the largest change, which is why PC mode stays untouched and the rollout is gated.
- A server connector with nobody at the machine needs good alerts and logs. The log upload and crash reports already exist.
- Tally freezes under heavy reads (seen on 3 Nov). The one-at-a-time gate and paced windows help but do not remove it.
