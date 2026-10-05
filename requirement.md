# Meenakshi Group - Cash Discount and Turnover Discount Requirements

**Status:** Implementation-ready requirements with explicit Meenakshi assumptions  
**Prepared:** 1 August 2026  
**Scope:** Meenakshi Group only  
**Implementation status:** Requirements only; no functionality is authorized by this document

## 1. Plain-language summary

Meenakshi Group wants Kalika to calculate two customer discount schemes using live Tally data:

1. **Cash Discount (CD):** a customer earns a discount when the required payment is made within a configured number of working days.
2. **Turnover Discount (TOD):** a customer earns a discount when its eligible purchases reach a configured tonnage threshold during a configured period.

Both schemes must apply only to selected **customer groups maintained in Tally**. Meenakshi will provide the Tally group names and the rule values.

Kalika must read the relevant sales, customer, group, receipt, and bill-allocation data from Tally, evaluate it against a configurable rulebook, show the result for review, create an approved **Credit Note** in Tally, verify the created voucher, and then send the customer a WhatsApp message.

## 2. Important terminology

| Term | Meaning in this requirement |
| --- | --- |
| CD | Cash Discount for payment made within the permitted working-day window. |
| TOD | Turnover Discount based on eligible quantity purchased during a period. |
| Customer | A Tally party/customer ledger. It is not a Kalika user or a Tally company. |
| Customer group | A Tally ledger group used to include or exclude customer ledgers from a scheme. |
| Rulebook | The Meenakshi configuration that defines scheme groups, dates, periods, thresholds, rates, and accounting treatment. |
| Against Reference | Tally bill-wise allocation proving that a receipt/payment was applied to a particular sales invoice. |
| Working day | A day counted after excluding configured weekly holidays and Meenakshi's configured holiday calendar. |
| Eligible value | The taxable product/steel value before GST, excluding separately charged freight and other non-product charges. |
| Eligible tonnage | Net qualifying sales quantity converted into tonnes for the TOD period. |

## 3. Business goals

The completed feature must:

- remove manual customer-by-customer filtering;
- use customer groups and transactions from the currently connected Tally company;
- make CD and TOD rules visible and auditable;
- calculate eligibility deterministically, without AI inference;
- use Tally Against Reference allocations when deciding whether an invoice has been paid;
- support one-month rules now and two-month, three-month, or other periods later;
- tell a customer exactly how much more must be paid to earn a CD benefit;
- create the correct Credit Note only after user approval;
- prevent duplicate Credit Notes and duplicate WhatsApp messages;
- preserve Tally as the source of truth for accounting data.

## 4. Scope and isolation

### 4.1 In scope

- Meenakshi-only feature enablement.
- Tally customer-group selection for both CD and TOD.
- A configurable CD and TOD rulebook.
- Sales invoice and sales-line reading from Tally.
- Receipt and Against Reference allocation reading from Tally.
- Working-day deadline calculation.
- Tonnage aggregation and TOD tier evaluation.
- Partial-payment and shortfall calculation.
- Review and approval screens.
- Credit Note creation and read-back verification in Tally.
- Credit Note PDF preparation if the existing verified Tally-document flow supports the voucher.
- WhatsApp follow-ups and Credit Note notifications.
- Audit history and idempotency.

### 4.2 Out of scope unless separately approved

- Changing the existing Cash Discounts behavior for other clients.
- Automatically creating or modifying Tally customer groups.
- Automatically moving customer ledgers between Tally groups.
- Automatically posting a Credit Note without a human approval step.
- Guessing discount rates, customer groups, tax treatment, unit conversions, or holiday dates.
- Treating an unallocated receipt, On Account amount, narration, or ledger balance as proof that a specific invoice was paid.
- Replacing Tally as the accounting system of record.

## 5. Difference from the current Kalika Cash Discounts flow

The existing project currently:

- reads Cash Discount terms mainly from individual sales-invoice narrations;
- supports a narrow set of narrated percentages and default day periods;
- reads open bills and receipt allocations from Tally;
- prepares **Debit Notes** for missed or reversed Cash Discounts;
- can create a Tally voucher, verify its PDF, and send it through WhatsApp.

The Meenakshi requirement is different:

- rules come from a **Meenakshi rulebook**, not from invoice narration;
- eligibility is limited by **Tally customer group**;
- TOD requires period-level sales quantity aggregation, not only open-bill analysis;
- earned CD and TOD benefits produce **Credit Notes**, not missed-discount Debit Notes;
- the working-day calendar and rule period must be configurable;
- existing non-Meenakshi behavior must continue unchanged.

The developer must not reuse the existing Debit Note action merely by changing its label to Credit Note. Credit Note payload, voucher type, ledgers, signs, bill allocations, verification, PDF, and duplicate controls must be implemented and tested as a distinct accounting action.

## 6. Source-of-truth requirements

### 6.1 Data that must come live from Tally

- active Tally company name;
- customer ledgers and their parent customer groups;
- nested group relationships, if Meenakshi uses nested groups;
- customer phone number and other available contact details;
- sales invoices and their dates;
- invoice party ledger;
- invoice reference/bill reference;
- sales inventory lines;
- stock item, stock group, quantity, unit, rate, and value;
- cancelled, optional, reversed, and altered voucher status where available;
- sales returns and existing Credit Notes relevant to the period;
- receipt vouchers, receipt dates, amounts, and bill allocations;
- existing Meenakshi CD/TOD Credit Notes for duplicate detection;
- voucher IDs, GUIDs, Master IDs, Alter IDs, and voucher numbers needed for verification.

### 6.2 Data Kalika may store

Kalika may store only what is required to operate and audit the workflow:

- rulebook configuration and version history;
- selected Tally group identifiers/names;
- holiday calendars;
- evaluation snapshots and calculation breakdowns;
- approval history;
- Tally command and created-voucher identifiers;
- WhatsApp delivery history;
- hashes/keys used to prevent duplicates.

Sales, receipt, customer, and outstanding data should be refreshed from Tally and should not silently fall back to stale database snapshots when a live evaluation or approval is requested.

## 7. End-to-end workflow

### 7.1 Configuration

1. An authorized user enables the Meenakshi CD/TOD module for the organization.
2. Kalika connects to the correct live Tally company.
3. Kalika refreshes customer groups, customer ledgers, stock items, units, voucher types, and required accounting ledgers.
4. The user creates or imports CD and TOD rules supplied by Meenakshi.
5. Each rule is linked to one or more Tally customer groups.
6. Kalika validates that every selected group and required ledger currently exists in the selected Tally company.
7. The rule is activated only after validation and approval.

### 7.2 Evaluation

1. The user selects an evaluation date or period and refreshes from Tally.
2. Kalika reads only customers belonging to the configured Tally groups.
3. For CD, Kalika reads invoices, receipts, and Against Reference allocations.
4. For TOD, Kalika reads eligible sales lines and converts their quantities to tonnes.
5. Kalika evaluates every customer against the rule version effective for that invoice or period.
6. Kalika shows qualified customers, customers close to qualifying, ineligible customers, missing data, and blocked calculations.

### 7.3 Approval, Tally posting, and communication

1. A user opens the calculation breakdown.
2. Kalika refreshes the relevant live Tally transactions again before approval.
3. If the result changed, Kalika invalidates the previous review and requires review again.
4. The user approves the proposed Credit Note.
5. Kalika queues a Credit Note command for the selected live Tally company.
6. The connector creates the Credit Note.
7. Kalika reads the voucher back from Tally and verifies its identity and amount.
8. If configured, Kalika prepares and verifies the official Tally Credit Note PDF.
9. Only after successful Tally verification does Kalika send the approved WhatsApp message.
10. The user can see the full posting and communication history after reopening the browser.

## 8. Rulebook requirements

CD and TOD must be separate rule types. A user must be able to enable one without enabling the other.

### 8.1 Common rule fields

Every rule must contain:

| Field | Requirement |
| --- | --- |
| Rule name | Human-readable unique name. |
| Scheme type | `Cash Discount` or `Turnover Discount`. |
| Tally company | Exact company for which the rule is valid. |
| Customer groups | One or more live Tally groups. No free-text-only group should be accepted. |
| Effective from | First date on which the rule may apply. |
| Effective to | Optional last date. |
| Discount type | Percentage for Meenakshi v1. |
| Discount rate | Rate supplied by Meenakshi. |
| Calculation base | Meenakshi v1 uses eligible product taxable value before GST, excluding separate freight and non-product charges. |
| Credit Note voucher type | Existing live Tally Credit Note voucher type. |
| Discount ledger | Existing live Tally ledger used in the Credit Note. |
| GST treatment | Meenakshi v1 uses a financial/commercial Credit Note without GST adjustment, as locked in section 14.2. |
| Approval required | Must default to `Yes`. |
| Active status | Draft, active, paused, or expired. |
| Rule version | Immutable version used for historical evaluations. |

Rules must not be edited retroactively after a Credit Note is created. Editing an active rule creates a new version with a new effective date.

### 8.2 CD-specific fields

- allowed payment period;
- period unit: working days;
- default Meenakshi value: four working days;
- weekly non-working days;
- holiday calendar;
- invoice date is Day 0;
- payment must reach the discounted settlement target for eligibility;
- near-eligibility follow-up threshold: 80% of the invoice amount due;
- discount base: eligible product taxable value before GST, excluding separate freight and non-product charges;
- a receipt on the final eligible working day is accepted;
- excess or advance payments count only after they are allocated Against Reference to the invoice.

### 8.3 TOD-specific fields

- customer group or band to which the threshold set applies;
- period length, such as one, two, or three months;
- period anchor/start date;
- eligible Tally stock items or stock groups;
- source unit and conversion to tonnes;
- one or more threshold tiers;
- discount percentage for every tier;
- value basis on which the achieved TOD rate is calculated;
- tier method: highest achieved tier applies to the full eligible product taxable value for the period;
- period close: end of the final calendar day in the configured period;
- review opens on the first working day after period end;
- sales return, cancellation, Debit Note, and later-adjustment treatment defined in section 12.5;
- Credit Note voucher date: the date on which Finance approves the proposal, never backdated automatically.

### 8.4 Example TOD tier structure

The following illustrates the required shape only. Meenakshi must provide the actual rates:

| Minimum eligible quantity | Discount rate | Status |
| ---: | ---: | --- |
| 100 tonnes | 1% | Example supplied in discussion |
| 200 tonnes | Client-supplied configuration | Required before production rule activation |
| 250 tonnes | Client-supplied configuration | Required before production rule activation |

The system must never invent the missing rates.

Different Tally customer groups may have different TOD threshold sets. For example, Group A may start at 100 tonnes while Group B starts at 200 tonnes. A/B/C are treated as configurable customer bands represented by Tally groups; the production group-to-threshold mapping is supplied as rule data by Meenakshi.

## 9. Tally customer-group behavior

1. Customer groups must be read from the selected live Tally company.
2. Rule configuration must use a searchable selection of live Tally groups.
3. CD and TOD may use different customer groups.
4. Only customer ledgers belonging to a selected group are eligible.
5. Child/nested Tally groups are included recursively.
6. If a configured group is renamed, deleted, or unavailable, the calculation must stop and ask for review.
7. Customer names must not be hardcoded in Kalika.
8. Each evaluation must store the group and customer membership snapshot used for the result.
9. A customer outside all configured groups must be shown as `Not in scheme`, not as a calculation error.
10. Eligibility uses the customer's current Tally group at evaluation time. The group membership is snapshotted when the period is reviewed; a later group change invalidates an unposted review but does not rewrite an already verified Credit Note.

## 10. Cash Discount calculation

### 10.1 Required inputs per invoice

- customer ledger;
- customer group;
- invoice number and date;
- invoice amount;
- discount calculation base;
- CD rate;
- computed working-day deadline;
- receipts allocated Against Reference to that invoice;
- receipt voucher dates;
- amount paid by the deadline;
- existing Credit Note, if any.

### 10.2 Core formula

```text
discount amount = eligible value x discount rate / 100
discounted settlement target = invoice amount due - discount amount
eligible payment = receipts allocated Against Reference on or before the deadline
shortfall = max(0, discounted settlement target - eligible payment)
```

All currency calculations must use decimal arithmetic and the configured rounding rule. Floating-point approximation must not be used for posted amounts.

### 10.3 Eligibility states

| State | Condition | System action |
| --- | --- | --- |
| Eligible | Against Reference payment by the deadline is at least the discounted settlement target. | Prepare Credit Note for approval. |
| Near eligibility | Payment is at or above the configured follow-up threshold but below the discounted target. | Show exact shortfall and prepare a WhatsApp follow-up; do not create a Credit Note. |
| Partially paid | Payment exists but is below the follow-up threshold. | Track the invoice; do not send the Meenakshi v1 shortfall WhatsApp. |
| Unpaid | No eligible Against Reference receipt exists. | Track as unpaid; no Credit Note. |
| Deadline expired | Required payment was not completed by the deadline. | Mark ineligible for that CD rule; do not create a Credit Note. |
| Needs review | Allocation, date, amount, rule, calendar, or customer group is ambiguous. | Block automatic action. |
| Already credited | A matching verified Credit Note already exists. | Show existing voucher; never create another. |

### 10.4 Meenakshi example: ₹2,00,000 invoice at 1%

```text
Invoice amount                 ₹2,00,000
Discount at 1%                   ₹2,000
Discounted settlement target   ₹1,98,000
```

Scenarios:

- If ₹1,98,000 or more is paid Against Reference within the deadline, the customer is eligible for a ₹2,000 Credit Note.
- If ₹1,95,000 is paid, the shortfall is ₹3,000. The customer should be told: pay ₹3,000 by the displayed deadline to receive the ₹2,000 discount. No Credit Note is created yet.
- If ₹1,60,000 is paid, 80% of the invoice has been paid and the shortfall to the discounted target is ₹38,000. The 80% value is a follow-up trigger only; it does not itself create discount eligibility.
- If the customer paid the full ₹2,00,000 within the deadline, the discount remains ₹2,000; the excess over the discounted target must not increase the discount.

### 10.5 Against Reference rules

1. Only bill allocations that point to the exact invoice reference count toward CD eligibility.
2. On Account receipts do not count until allocated to the invoice.
3. A receipt narration mentioning an invoice is not sufficient when allocation data is available.
4. Multiple receipts allocated to the invoice must be aggregated.
5. One receipt split across invoices must count only the allocated amount for each invoice.
6. Reversed, cancelled, or altered receipts must be reflected on refresh.
7. Receipt voucher date is the payment date used for deadline eligibility.
8. The exact invoice reference, receipt vouchers, allocation amounts, and dates must be visible in the calculation breakdown.

## 11. Working-day calculation

1. The CD period must support a configurable number of working days.
2. Four working days is the initial Meenakshi requirement but must not be hardcoded globally.
3. Weekly holidays must be configurable because Saturday working rules may differ.
4. Meenakshi holidays must be maintained in a calendar with date, name, and active status.
5. The system must display the invoice date, counted working days, excluded dates, and final deadline.
6. The timezone must be `Asia/Kolkata` for date boundaries.
7. A receipt dated on the deadline counts.
8. Invoice date is Day 0. The next working day is Day 1, and a receipt dated on Day 4 is eligible.
9. Monday through Saturday are working days. Sunday and dates in the Meenakshi holiday calendar are excluded. An empty holiday calendar means only Sundays are excluded.

## 12. Turnover Discount calculation

### 12.1 Period handling

- One calendar month is the initial period.
- The rule engine must also support two-month, three-month, or other configured month lengths.
- Every period must have an explicit start and end date derived from the rule anchor.
- A rule change during a period must not rewrite the rule version already assigned to that period.
- TOD should remain `Tracking` until the period closes.

### 12.2 Eligible quantity

```text
eligible tonnes = sum(eligible invoiced quantity converted to tonnes)
                  - eligible sales returns/cancellations converted to tonnes
```

Requirements:

1. Only posted, non-cancelled sales vouchers in the period count.
2. Only stock items or stock groups selected in the TOD rule count.
3. Every source unit must have an explicit conversion to tonnes.
4. A missing or conflicting unit conversion must block that line and the final customer result.
5. Sales returns and cancellations must reduce the eligible quantity and value.
6. The calculation must show invoice-level and stock-line-level contributions.
7. Quantity must not be reconstructed from value/rate when Tally provides a reliable inventory quantity.

### 12.3 Tier evaluation

At period close, Kalika must:

1. total eligible tonnes per customer;
2. find the qualifying tier in the effective rule version;
3. apply the highest achieved tier to the full eligible product taxable value for the period;
4. show the next tier and additional tonnes required when useful;
5. prepare one TOD Credit Note proposal per customer, rule, and period;
6. block posting if the rule rate or calculation basis is missing.

The highest achieved tier applies to the full eligible product taxable value for the period. The Meenakshi v1 calculation is not slab-wise.

### 12.4 TOD payment condition

TOD eligibility is based on net invoiced eligible tonnage for the period and does not depend on receipt/payment status. Payment collection affects CD only. The review may show outstanding balances for information, but an outstanding amount does not block an otherwise valid TOD Credit Note.

### 12.5 Returns, Debit Notes, and later adjustments

- Cancelled sales invoices are excluded completely.
- Sales returns and linked Credit Notes reduce eligible product quantity and taxable value in the period to which the original sale belongs when they exist before TOD approval.
- A Debit Note linked to an eligible sale increases eligible product taxable value. It increases eligible quantity only when it contains approved eligible stock-item quantity that can be converted to tonnes.
- TOD is finalized for review on the first working day after the period ends. Approval always refreshes the relevant Tally vouchers before posting.
- Once a TOD Credit Note is verified in Tally, the closed result is immutable. A return, Debit Note, cancellation, or correction entered later is carried into the next open TOD period as a clearly labelled prior-period adjustment; it does not silently alter or recreate the issued Credit Note.
- The audit trail must link every adjustment to its source voucher and original period.

### 12.6 Unit conversion

- `MT` and `MTS` equal one tonne.
- `KG` equals `0.001` tonne.
- Any other Tally unit requires an explicit approved conversion in the TOD rule before activation.
- An unknown or conflicting conversion blocks the affected result; Kalika must not infer quantity from value and rate.

## 13. Interaction between CD and TOD

CD and TOD are independent benefits and may both apply to the same sale. Each is calculated on the original eligible product taxable value before GST; neither discount reduces the calculation base of the other. They always create separate Credit Note proposals and separate verified Tally vouchers so their rules, periods, and audit trails remain clear.

Two active rules of the same scheme may not overlap for the same Tally customer group and effective date. Rule activation must reject such an overlap instead of selecting a rate by priority or highest benefit.

## 14. Credit Note requirements

### 14.1 Before posting

Kalika must show:

- scheme and rule version;
- customer and Tally group;
- invoice reference for CD or period for TOD;
- source sales invoices;
- quantity/tonnage calculation for TOD;
- payment and Against Reference evidence for CD;
- calculation base, rate, discount amount, and rounding;
- Credit Note voucher date;
- Credit Note voucher type and accounting ledger from live Tally;
- GST treatment;
- duplicate check result;
- WhatsApp recipient and message preview.

### 14.2 Locked accounting treatment for Meenakshi v1

Meenakshi v1 uses a **financial/commercial Credit Note without GST adjustment**:

- discount is calculated on eligible product taxable value before GST;
- the original invoice GST and output-tax liability are not reduced;
- the Credit Note contains no CGST, SGST, or IGST reversal lines;
- the voucher is ledger-based/accounting mode, without stock-item or quantity entries;
- CD uses a live Tally ledger such as `Cash Discount Allowed`;
- TOD uses a separate live Tally ledger such as `Turnover Discount Allowed`;
- both ledgers must exist in the live Tally company under the accountant-approved expense group with GST applicability set to Not Applicable;
- Kalika selects and stores the exact live ledgers in the rule; it does not create or hardcode them.

This conservative treatment follows the GST distinction between a tax-adjusting post-supply discount under section 15(3) and a commercial credit note. A future tax-adjusting mode would require evidence that the scheme was established at or before supply, was specifically linked to relevant invoices, and that attributable recipient ITC was reversed. That mode is outside Meenakshi v1 and must not be inferred automatically.

Bill allocation behavior:

- for CD, use `Agst Ref` against the original invoice when an invoice balance remains to be closed by the Credit Note;
- if the original invoice was already fully settled, create the Credit Note as `New Ref` so it remains available for adjustment against a future sale, while retaining the original invoice in structured audit data and narration;
- for TOD, create one period-level `New Ref` per customer and rule period because the benefit spans multiple invoices; retain the full source-invoice list in Kalika's audit record and the rule/period reference in narration.

### 14.3 Tally payload

An approved Credit Note must include, as applicable:

- exact live Tally company;
- Credit Note voucher type;
- party ledger;
- discount ledger;
- amount and sign appropriate for a Credit Note;
- CD `Agst Ref` or `New Ref` allocation according to the settlement state;
- TOD period reference and source-invoice traceability;
- no GST tax-ledger lines for the Meenakshi v1 financial/commercial Credit Note;
- voucher date;
- rule name/version and calculation reference in narration;
- deterministic idempotency key.

### 14.4 Verification

Posting is complete only when Kalika reads the voucher back from Tally and confirms:

- voucher type;
- company;
- party ledger;
- voucher number and date;
- amount;
- reference/period;
- Master ID/GUID or equivalent identity;
- expected ledger entries.

If any verification fails, the state is `Correction required` or `Failed`; it must not be shown as created or sent.

## 15. WhatsApp requirements

### 15.1 Message types

At minimum, support:

1. **CD shortfall reminder:** amount already paid, discount available, exact additional amount required, and working-day deadline.
2. **CD Credit Note created:** discount amount, invoice reference, verified Credit Note number/date, and PDF if available.
3. **TOD Credit Note created:** period, eligible tonnes, achieved tier, discount amount, verified Credit Note number/date, and PDF if available.

TOD progress marketing messages are outside v1. The dashboard still shows current and next tiers to staff.

### 15.2 Sending rules

- The customer phone number should come from the live Tally ledger when available.
- A user may enter a missing number only through the existing controlled contact-update flow.
- MSG91 is the provider and only Meta-approved MSG91 Utility templates are used for these transactional updates.
- A customer must have a recorded WhatsApp opt-in with source and timestamp. Without opt-in, Kalika shows `WhatsApp unavailable` and does not send.
- No `Credit Note created` message may be sent before the Tally voucher is verified.
- A shortfall message must not claim that a discount has already been granted.
- The message must use approved templates and display the exact deadline and amount.
- Retries must not send the same business event twice unless a user explicitly chooses resend.
- Delivery response, recipient, template, time, and related calculation/voucher must be audited.

## 16. User experience requirements

The Meenakshi Collections area should clearly separate:

- `Cash Discount`;
- `Turnover Discount`;
- `Rulebook`;
- `Credit Notes`;
- `Messages`.

### 16.1 Rulebook screen

Users need to:

- select live Tally customer groups;
- configure CD working days and discount rate;
- configure TOD periods and tier rows;
- select live Tally ledgers/voucher types;
- preview the rule in plain language;
- validate missing Tally masters;
- activate, pause, expire, or version a rule.

Example plain-language preview:

> Customers in **Meenakshi CD Group A** receive **1%** on the configured value when the discounted settlement amount is paid Against Reference within **4 working days**.

### 16.2 Evaluation screen

Every customer result should show:

- current status;
- scheme and rule;
- Tally customer group;
- relevant invoice or TOD period;
- paid amount and shortfall for CD;
- eligible tonnes, achieved tier, and next threshold for TOD;
- discount amount;
- warnings or missing evidence;
- next permitted action.

### 16.3 Minimum user-facing statuses

- Tracking
- Near eligibility
- Eligible
- Needs review
- Deadline expired
- Not in scheme
- Pending approval
- Sending to Tally
- Created and verified
- WhatsApp pending
- WhatsApp sent
- Failed
- Already credited

Internal command names and raw payloads must not be presented as the primary user explanation.

### 16.4 Roles and permissions

- **Administrator:** enables the Meenakshi module, maintains holidays and WhatsApp configuration, creates rule drafts, validates live Tally masters, and activates or versions rules.
- **Finance approver:** reviews calculation evidence and is the only role allowed to approve a Credit Note for Tally posting.
- **Finance approver or Administrator:** may retry a failed Tally command or deliberately resend a WhatsApp message. Every retry/resend requires an audit reason.
- A user may not approve a proposal they changed after its last live Tally refresh; the changed proposal must be refreshed and reviewed again.

## 17. Audit and duplicate prevention

### 17.1 Required audit data

For every calculation, store:

- organization and Tally company;
- evaluation timestamp;
- rule ID and immutable version;
- selected customer group and membership snapshot;
- source Tally voucher identifiers;
- Against Reference allocations used;
- working-day calendar version;
- quantity conversions;
- formulas and intermediate values;
- user corrections and approvals;
- created Tally voucher identity;
- WhatsApp status.

### 17.2 Idempotency keys

- CD: company + customer ledger + invoice reference + rule version.
- TOD: company + customer ledger + period start/end + rule version.

A browser retry, API retry, connector retry, rule refresh, or reopened session must not create another Credit Note for the same idempotency key.

If Tally already contains a matching Credit Note but Kalika has no local history, Kalika must recover and link the existing voucher rather than create a duplicate.

## 18. Validation and blocking conditions

The final Credit Note action must be blocked when:

- the wrong Tally company is active;
- the connector or Tally is unavailable;
- a configured customer group is missing;
- a customer-group membership is ambiguous;
- the rule is missing, inactive, overlapping ambiguously, or outside its effective dates;
- a required percentage, threshold, period, calendar, conversion, ledger, voucher type, or GST treatment is missing;
- an invoice/receipt allocation is not Against Reference for CD;
- source vouchers changed after review;
- TOD source lines contain an unresolved unit conversion;
- a possible duplicate Credit Note exists;
- calculation and proposed voucher totals do not reconcile.

Warnings may be used for non-blocking information, but accounting ambiguity must never be downgraded to a warning merely to allow posting.

## 19. Non-functional requirements

- All calculations must be deterministic and independently testable.
- The feature must handle at least one financial year of Meenakshi sales without browser timeouts.
- Large Tally reads should be chunked and resumable.
- Approval must refresh only the relevant customer/period rather than trusting an old scan.
- Dates must use `Asia/Kolkata` business-date semantics.
- Currency calculations must use decimal precision appropriate for Tally.
- Tonnage calculations must preserve sufficient precision and round only at the configured stage.
- The system must explain every eligibility result in plain language.
- Meenakshi-specific behavior must be protected by organization configuration and automated regression tests.
- Existing Bank Statements, Packet Matching, Purchase Voucher, and non-Meenakshi Cash Discount flows must remain unaffected.

## 20. Acceptance criteria

### 20.1 Customer groups

- Given a rule linked to Tally Group A, a ledger in Group A is evaluated and a ledger outside Group A is marked `Not in scheme`.
- Renaming/deleting Group A in Tally causes rule validation to fail clearly.
- No customer names are hardcoded.

### 20.2 CD

- For a ₹2,00,000 invoice at 1%, ₹1,98,000 paid Against Reference within the configured deadline produces a ₹2,000 Credit Note proposal.
- ₹1,95,000 paid produces a ₹3,000 shortfall and no Credit Note.
- ₹1,60,000 paid produces a ₹38,000 shortfall to the discounted target.
- An On Account receipt of ₹1,98,000 does not qualify until allocated to the invoice.
- Multiple valid allocations are summed correctly.
- A receipt after the deadline does not qualify.
- Four working days exclude configured non-working days and holidays.

### 20.3 TOD

- A customer below 100 tonnes does not qualify for the example tier.
- A customer at exactly 100 tonnes qualifies for the configured 100-tonne rate.
- Sales returns reduce the qualifying quantity and value.
- MT and another approved unit convert correctly to tonnes.
- A missing conversion blocks the result.
- One-, two-, and three-month rules produce the correct period boundaries.
- The same period cannot create a second TOD Credit Note.

### 20.4 Tally and WhatsApp

- The approved Credit Note is created in the correct live Tally company and verified by read-back.
- A failed or unverified Tally command is not shown as created.
- A Credit Note WhatsApp message is not sent before voucher verification.
- Repeating a request does not create a second voucher or duplicate message.
- Reopening the browser retains the calculation, approval, voucher, and message history.

## 21. Locked implementation assumptions

This section resolves the developer's pre-implementation questions. These are the Meenakshi v1 behaviors to implement; developers must not introduce alternative financial behavior without a separately approved requirement change.

| Area | Locked Meenakshi v1 behavior |
| --- | --- |
| Discount base | Both CD and TOD use eligible product/steel taxable value before GST. Separately charged freight and other non-product charges are excluded. |
| TOD tier method | The highest achieved tier rate applies to the full eligible product taxable value for the period. The calculation is not slab-wise. |
| Credit Note GST | Use a financial/commercial Credit Note without reducing original taxable value, GST, or output-tax liability. Do not create CGST, SGST, or IGST reversal lines. |
| Tally accounting mode | Use a ledger-based Credit Note with the live party ledger and scheme-specific discount ledger. Do not add stock-item/quantity lines. |
| Bill allocation | CD uses `Agst Ref` while the original invoice has an outstanding balance; if fully settled, use `New Ref`. TOD uses one period-level `New Ref`. |
| Rule overlap | Two active rules of the same scheme cannot overlap for the same customer group and effective dates. Activation must reject the overlap. |
| CD and TOD together | They may both apply, are calculated independently on the original eligible value, and create separate Credit Notes. |
| Returns/cancellations | Cancelled invoices are excluded. Returns reduce eligible value and quantity. Later adjustments are carried into the next open TOD period after a Credit Note is verified. |
| Debit Notes | A linked Debit Note increases eligible value; it increases quantity only when it contains an eligible inventory quantity with a valid conversion. |
| Customer group | Use the current live Tally group at evaluation, include child groups recursively, and snapshot membership at review. A pre-posting group change invalidates the review; a verified Credit Note remains unchanged. |
| CD deadline | Invoice date is Day 0. The next working day is Day 1. Day 4 is included. Monday-Saturday are working; Sunday and configured Meenakshi holidays are excluded. |
| CD payment evidence | Only receipts allocated `Against Reference` to the exact invoice count. `On Account`, narration text, or overall ledger balance does not qualify. |
| 80% condition | 80% of invoice amount due is only the shortfall-reminder trigger. It does not create eligibility. |
| Late CD payment | Payment completed after the deadline is ineligible for that CD rule and does not produce a Credit Note. |
| TOD payment condition | TOD depends on net eligible invoiced tonnage, not payment collection. |
| TOD close | A period ends on its final calendar day and opens for review on the first working day after period end. Posting requires a final live refresh. |
| Tally interface | Reuse the existing Kalika connector through Tally's local HTTP/XML interface and asynchronous bridge commands. Do not add an ODBC path. |
| WhatsApp | Reuse MSG91 with Meta-approved Utility templates. Send a Credit Note message only after Tally read-back verification and only with recorded customer opt-in. |
| Roles | Administrators configure/activate rules; Finance approvers approve Credit Notes; either role may retry/resend with an audited reason. |

### 21.1 Client-supplied production configuration

The following are data values to load during Meenakshi setup, not unresolved design questions:

- exact live Tally customer-group names for CD and TOD;
- CD percentage for each configured group;
- TOD threshold/rate rows for each configured group, including the client-supplied rates for 200 and 250 tonnes;
- exact eligible Tally stock items or stock groups;
- explicit conversion for any unit other than built-in `MT`, `MTS`, and `KG`;
- Meenakshi holiday dates;
- exact live Tally Credit Note voucher type, `Cash Discount Allowed` ledger, and `Turnover Discount Allowed` ledger;
- approved MSG91 Utility template IDs and the existing customer opt-in records.

The configuration UI must validate these values against live Tally/MSG91 data. A rule with a missing value remains `Draft`; this is ordinary configuration validation and does not give the developer permission to invent a value.

### 21.2 Research and product basis

- [CBIC section 15](https://cbic-gst.gov.in/hindi/CGST-bill-e.html) and [Circular 92/11/2019](https://cbic-gst.gov.in/pdf/circular-cgst-92.pdf) distinguish tax-adjusting discounts that satisfy statutory conditions from commercial/financial credit notes. Meenakshi v1 deliberately uses the conservative no-GST-adjustment path.
- CBIC Circular 105/24/2019 was withdrawn ab initio by [Circular 112/31/2019](https://cbic-gst.gov.in/pdf/circular-cgst-112.pdf) and is not used as a basis for this requirement.
- [Tally's documented Credit Note bill-reference behavior](https://help.tallysolutions.com/tally/sales-return-tally/) supports `Agst Ref` for adjustment against an outstanding invoice and `New Ref` when a new bill reference is required.
- [Tally's documented discount-ledger setup](https://help.tallysolutions.com/set-up-discount-ledger/) treats a discount ledger as an expense/discount ledger with GST applicability set to Not Applicable for this accounting treatment.
- [MSG91's approved-template flow](https://msg91.com/help/whatsapp/how-to-create-a-template-for-whatsapp) and the existing Kalika integration are reused for transactional Utility messages.

## 22. Developer handoff notes for this repository

Likely extension points in the current codebase:

- `apps/api/src/app/api/collections/dashboard/route.ts` currently evaluates narration-based CD and open bills. Meenakshi requires a rulebook evaluator and TOD period aggregation.
- `apps/api/src/app/api/collections/cash-discount-rules/route.ts` and `cash_discount_rules` provide an initial rule structure, but the current dashboard does not use those saved rules for calculations.
- `apps/tally-bridge/src/bridge.mjs` already reads open bills and receipt Against Reference allocations. TOD additionally requires period sales inventory lines, returns, and quantity/unit data.
- The current bridge command supports `create_debit_note`; Meenakshi requires a separate `create_credit_note` command and verification path.
- `apps/web/src/components/collections/CollectionsDashboardPage.tsx` can supply shared connection, approval, PDF, and WhatsApp patterns, but CD and TOD must be clear separate user workflows.
- Existing MSG91 WhatsApp and verified Tally-document behavior should be reused only after adapting the content and verification rules for Credit Notes.
- Any schema change should be delivered as a new Supabase migration for manual application; existing applied migrations must not be rewritten.

Recommended implementation boundary:

- introduce an organization-level Meenakshi feature flag/configuration;
- preserve the present flow for all other organizations;
- implement a deterministic rule engine with unit tests before wiring the UI;
- build Tally reads and Credit Note posting as explicit connector commands;
- keep posting and WhatsApp behind human approval and live revalidation.

## 23. Definition of done

This feature is done only when:

- every item in the acceptance criteria passes;
- all client-supplied production configuration is loaded, live-validated, and included in an approved rule version;
- CD and TOD calculations are independently reproducible from their audit snapshots;
- live Tally group membership and Against Reference evidence are used correctly;
- Credit Notes are created, read back, and verified in Tally;
- WhatsApp messages are sent only after the correct workflow state;
- duplicate actions are prevented across retries and sessions;
- Meenakshi users can understand why each customer qualified or did not qualify;
- automated regression tests confirm that existing client workflows are unchanged