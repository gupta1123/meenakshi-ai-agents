# Turnover Discount (TOD): core logic

This document lists the rules the system uses to calculate Turnover Discount. It covers what already existed and what was added from the client meeting on 2026-09-25. Update it whenever a TOD rule changes.

## 1. Where the logic lives

| Step | File |
| --- | --- |
| Builds the Tally read scope (period, products, units, payment check) | `backend/src/lib/evaluation/evidence.ts` → `buildLiveTodVoucherScope` |
| Reads Tally and builds per-customer totals, including the payment check | `tally-bridge/src/commands/live-tod-evidence.mjs` → `fetchLiveTodEvidence` |
| Slab and discount (instant result in the browser) | `tally-bridge/src/local-tod-evaluator.mjs` → `evaluateLocalTurnoverDiscount` |
| Slab and discount (saved audit result, worker) | `backend/src/lib/evaluation/live-tod.ts` |
| Page: groups, customers, payment check view | `frontend/src/components/collections/workspace.tsx` → `TodResults`, `ProposalDrawer` |
| Rules with their customer groups | `GET /api/companies/:id/evaluations/rules-by-group` |

The browser result and the worker result use the same totals. The worker recalculates them and stores the audit trail (`formula_snapshot`).

## 2. Rule setup (existing)

A TOD rule version defines:
- **Customer groups** it covers. A customer is covered if its group, or a parent of its group, is selected.
- **Eligible products**: Tally stock items or stock groups. Only these lines count.
- **Unit conversions**: tonnes per Tally unit (e.g. 1 BAG = 0.05 t). A line whose unit has no conversion is not counted, and the customer goes to *Needs review* ("approved conversion missing").
- **Period**: an anchor date plus a length in months (e.g. quarterly). The calculation is per customer, per period.
- **Slabs (tiers)**: minimum tonnes, plus either a percentage of the eligible value or an amount per tonne (`tod_benefit_basis`).
- **Review calendar**: holidays and non-working weekdays. Sunday is the default.
- Rounding method and scale.

## 3. Calculation order

For each covered customer and period:

1. **Find the period's vouchers** (Sales invoices, Sales returns, and Debit Notes linked to a Sales invoice) dated inside the period.
2. **Payment check (new, from the meeting)**: keep only the Sales invoices that were **paid in full within 25 days** (section 4).
3. **Eligible lines**: from each voucher, take only eligible products with a known unit conversion.
   - Tonnes = quantity × tonnes-per-unit.
   - Value = the line's taxable product value.
4. **Signs**: Sales +1; Sales return −1 (always subtracted, whatever the payment status); Debit Note linked to a Sales invoice +1.
5. **Totals**: eligible tonnes and eligible value per customer. A negative total is shown as 0.
6. **Slab**: the highest slab whose minimum tonnes ≤ eligible tonnes, computed from the counted invoices only.
7. **Discount**:
   - percentage basis: eligible value × slab %;
   - per-tonne basis: eligible tonnes × ₹/MT.
   
   Then round as the rule says.
8. **Status**:
   - `needs_review`: a unit conversion is missing, or there is no review date;
   - `tracking`: the period has not reached its review date, or no slab is reached yet;
   - `eligible`: a slab is reached and the review date has passed.
   
   The review date is the first working day after the period end.

In short: **eligible invoices → tonnes from them → slab → discount.**

## 4. Payment check: 25 days (new)

The client's rules (meeting, 2026-09-25):

- **Only paid invoices count.** An unpaid or partly paid invoice adds nothing to tonnes or value.
- **100% paid**: the payment must cover the full invoice amount **including GST** (Tally bill amount). A ₹1 tolerance absorbs rounding.
- **Within 25 calendar days**: holidays count as days.
  - Due date = invoice date + 25 days.
  - If the due date is a non-working weekday (Sunday by default) or a holiday from the rule's review calendar, it moves to the next working day. The shift repeats if the next day is also off (e.g. Sunday followed by a holiday Monday → Tuesday).
- **Paid-in-full date**: receipts matched to the invoice are sorted by date. The paid-in-full date is the date on which the running total reaches the invoice amount (minus ₹1). The invoice counts only if that date is on or before the due date.
- **Matching receipts to the invoice**: Receipt and Payment vouchers with an *Agst Ref* bill allocation, matched by the invoice's GUID, its voucher number, or its *New Ref* bill names. This is the same matching Cash Discount uses.
- **Reading window**: receipts can arrive after the period ends. Tally is read up to **period end + 45 days**, but never past the calculation date (`paymentCheck.readTo`). Invoices after the period end are not counted; they are read only for their receipts.
- **In-progress periods**: an invoice whose due date hasn't arrived yet and that isn't fully paid shows as *Not paid* or *Partly paid* and does not count yet. Recalculating later picks it up once it is paid.
- **All amounts are GST-inclusive** for the payment check. The slab value stays the taxable product value, as before.

Each invoice gets a payment-check row, stored in `formula_snapshot.paymentChecks` with fields `nominalDueDate`, `dueDate`, `shiftedFor`, `paidInFullOn`, `daysTaken`, `paidTotal`, `counted` and `reason` (`paid_in_full_on_time`, `paid_after_due_date`, `partly_paid`, `not_paid`). The customer panel shows this under **Payment check**.

The due-day count (25) and the extra read window (45) are constants in `evidence.ts` (`TOD_PAYMENT_DUE_DAYS`, `TOD_PAYMENT_READ_BEYOND_DAYS`).

Payment checks are required for new calculations. Missing `paymentCheck` scope or missing returned `paymentChecks` causes an error instead of counting unchecked Sales invoices. Historical snapshots remain unchanged.

Linked TDS settlement: posted Journal vouchers whose debit ledgers are explicitly TDS (or Tax Deducted at Source) may settle a bill through the customer's credit-side Agst Ref allocation. Use the journal date and the allocated amount, not the full journal total. Require the owning customer ledger to match the invoice; reject debit/reversal allocations, unrelated journals, On Account amounts and contradictory invoice GUIDs. An allocation is counted only once even when matched by both GUID and bill reference. Preserve separate `receiptTotal`, `tdsTotal` and `payments[].settlementKind` evidence; `paidTotal` is total settlement, not cash received. The 25-day deadline and ₹1 tolerance are unchanged.

## 5. Page layout (new)

- **Customer groups first**: the Turnover Discount results show only group cards at first, one per customer group, with customers, qualified count, tonnes and projected discount. The cards follow the selected status card above them. Clicking a group card opens the customer table for that group; **‹ Groups** goes back. Typing in the customer search skips the cards and searches all groups.
- **Rules per group**: each group card shows the active TOD rule and the Cash Discount rule(s) that cover it. A group can have more than one CD rule, and the CD page selects which rule to calculate.
- **Day calculation per invoice**: Customer → Payment check lists each invoice with its date, amount, tonnes, day 25, any Sunday/holiday shift, due date, paid-in-full date, days taken, and Counted / Paid late / Partly paid / Not paid.
- **Customer rows** (inside a group) show one line per customer:
  - Customer;
  - Slab (rate and threshold);
  - Tonnes counted, with a bar and "x t to next slab";
  - Invoices: "counted / total", plus the late / part-paid / unpaid counts and the tonnes left out;
  - Discount, with its formula;
  - a Status chip (Ready, Qualified, Tracking, Needs review, CN number) and an action.
  
  The period appears once, in the header. The row can be sorted by discount, tonnes, status or name. Clicking the red "late / unpaid" chip expands the excluded invoices in place; clicking the row opens the customer panel. The results list (`GET …/evaluations/proposals`) returns a `paymentSummary` per TOD row, built from the latest calculation's `paymentChecks`.

## 6. Credit Note from TOD (existing)

- Created only after the period has ended and the result is `eligible`. It is checked against Tally first; a check from the last 5 days is reused.
- The GST Credit Note is in invoice view:
  - the TN SGST/IGST Sales (Discount) ledger;
  - SGST + CGST for Tamil Nadu customers (GSTIN 33…), otherwise IGST 18%;
  - Round Off;
  - On Account;
  - a narration with the slab, quantity, value and amount.
- One Credit Note per customer, rule and period. A duplicate is blocked by a permanent reference.
- Nothing is sent on WhatsApp automatically. It is sent from Credit Notes.

## 7. Not decided yet (left unchanged)

These points from the meeting were unclear and are **not** implemented:
- whether a payment made net of a discount counts as "full" payment;
- the "90%" note;
- pending Cash Discount recovery affecting TOD;
- cardinality (how many rules a customer can have at once).
