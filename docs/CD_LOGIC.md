# Cash Discount (CD): core logic

**Status:** agreed rules, source of truth (client notes of 2026-09-25, `cdnotes.txt`). **Built 2026-09-26; active once migration `20260926090000_cash_discount_segments_per_mt.sql` is run and a per-MT rule is saved.** Legacy percentage rules keep their old behaviour until replaced. Section 9 lists what changes from the old implementation; section 11 maps the code.

## 1. The idea in one paragraph

The invoice goes out at **full price**. A customer who pays within their Cash Discount window may pay the invoice **minus the discount** (₹ per MT). When that happens, staff issue a **Credit Note** for the discount from the Cash Discount page so the bill closes. A customer who pays in full has not claimed the discount, so nothing is issued. Payments of more than 90% that fit neither case are shown to staff, who decide.

## 2. Rule setup

There is **one active Cash Discount rule**. It is divided into **segments**:

```
Cash Discount rule (one active version, effective from a date)
├── Segment A: 3 working days · ₹500/MT  → Tally groups: …
├── Segment B: 10 working days · ₹500/MT → Tally groups: …
└── any group in no segment → no Cash Discount
```

- **Segment:**
  - one or more Tally customer groups;
  - a window in **days** after the invoice;
  - a discount in **₹ per MT**.
- **Mutually exclusive:** a Tally group can be in only one segment. A sub-group can't be placed in a different segment from its parent. Activation is blocked otherwise.
- **Eligible products and MT conversions:** set on the rule, the same way as for TOD. Only eligible product lines count towards the MT.
- **Versions:** changing days, rate, groups or products creates a new version from an effective date. Each invoice uses:
  - the version active on its **invoice date**, and
  - the customer's group **on the invoice date**. Moving a customer between groups later doesn't change old invoices.
- **GST record:** the rule and its effective date are the written record that the discount was agreed before the sale. That's what allows a GST Credit Note (CGST Act s.15(3)(b)).

## 3. Discount amount per invoice

`discount = ₹/MT (segment) × MT of eligible products on the invoice`

MT uses the rule's unit conversions, the same as TOD. Round as set on the rule.

## 4. The window: days after the invoice

- Count **every day after the invoice date**, Sundays and holidays included.
- **Deadline** = invoice date + N days (N = 3 or 10). A payment **on** the deadline counts.
- **Only if the deadline itself** falls on a Sunday or a holiday in the company holiday calendar does it move to the next working day (and on again if that is also off).
- Examples (3 days):
  - Invoice Fri 3 Oct 2025: deadline Mon 6 Oct (Sun 5 still counts).
  - Invoice Thu 2 Oct 2025: day 3 is Sun 5 Oct, so the deadline moves to Mon 6 Oct.
  - Invoice Fri 17 Oct 2025: day 3 is Mon 20 Oct (Deepavali), so the deadline moves to Tue 21 Oct.

## 5. Payments that count

- **Receipts** with an *Agst Ref* allocation to the invoice, matched by invoice GUID, voucher number, or bill name. This is the same matching as TOD's 25-day check.
- **Journal** vouchers with an *Agst Ref* allocation to the invoice also count. This covers TDS booked separately against the bill. TDS booked inside the receipt is already included.
- Only amounts **received on or before the deadline** count for the categories below. All amounts are **GST-inclusive** (bill amounts).

## 6. Categories

The screen **shows** the categories in the client's order: Full payment, Short up to ₹10,000, Discounted payment. For each invoice, `received` is the total received by the deadline, and `invoice` is the bill amount.

| Category | Condition | Result |
|---|---|---|
| **Full payment** | received ≥ invoice − ₹1 | **No Credit Note.** Discount not claimed. Shown for information only. |
| **Discounted payment** | received is within ±₹1 of invoice − discount | **Credit Note for the discount, created by staff** from the Cash Discount page (never automatic). The bill closes at zero. |
| **Short up to ₹10,000** | invoice − received ≤ ₹10,000 (a flat limit, whatever the bill size), and neither of the above | **Staff decide.** The entry is shown with an option to create a Credit Note for **only what is short**, **capped at the discount**: min(invoice − received, discount). Nothing happens automatically. |
| **Not eligible** | short of the invoice by more than ₹10,000 at the deadline, or no payment by the deadline | No discount. Any shortfall stays in the customer's outstanding balance. |

**Evaluation order:** the system checks the exact matches first (Full, then Discounted), then the ₹10,000 band. A discounted payment is usually short by less than ₹10,000, so checking the ₹10,000 band first would swallow every discounted payment.

## 7. The Credit Note

A **normal Credit Note**, the same kind as the TOD Credit Note:
- Accounting Invoice view.
- The Sales (Discount) ledger: **SGST + CGST** for Tamil Nadu customers (GSTIN starts 33), otherwise **IGST 18%**. The discount is GST-inclusive, so the taxable part is discount ÷ 1.18.
- Round Off.
- Party allocation **On Account**.
- Narration naming the invoice number and date, MT, ₹/MT and amount.
- **One Credit Note per invoice.** A second Credit Note for the same invoice is blocked by a permanent reference.
- **GST deadline:** warn if the Credit Note would be issued after **30 November** following the invoice's financial year (CGST Act s.34). After that date the GST part can't be adjusted.
- WhatsApp: sent from Credit Notes by staff, as for TOD. Never automatic.

## 8. Link to TOD

A **Discounted payment plus its Cash Discount Credit Note** settles the invoice in full. For TOD's 25-day rule, such an invoice counts as **100% paid**, provided the discounted payment was received within the 25 days.

## 9. Changes from the current implementation

| Today | New |
|---|---|
| Several parallel CD rules, with a rule selector on the page | One active rule with mutually exclusive segments; no selector |
| Discount is a **%** of the bill, deducted on the invoice up front | Discount is **₹ per MT**, and the invoice is at full price |
| Outcome is a **Debit Note** to recover a discount not earned | Outcome is a **Credit Note** to give the discount; **no CD Debit Notes** |
| Unpaid or late invoices listed for recovery | Late or short payment means simply no discount, and nothing is issued |
| Invoice selected by narration (CD / % text) | Invoice selected by customer group segment and eligible products |

Existing Cash Discount Debit Notes already created in Tally are kept as history; nothing is reversed.

**Rounding allowance (confirmed):** a payment still counts as "full" or "discounted" when it is within **₹1** of the expected amount. This covers paise rounding, e.g. ₹99,499.60 paid against ₹99,500.

**Short up to ₹10,000 (client rule, replaces the old 90% band):** the limit is a flat ₹10,000 because 10% of a large bill is a lot of money. The Credit Note never exceeds the agreed discount. Example: ₹91,000 paid on ₹1,00,000 leaves ₹9,000 short; with a ₹500 discount, the Credit Note is ₹500. On ₹10,00,000, paying ₹9,50,000 is ₹50,000 short, so it is not eligible.

## 10. Still to confirm

Nothing. All rules above are agreed.

## 11. Where the logic lives

| Part | File |
| --- | --- |
| Rule tables, validation, draft copy, settlement snapshot, Credit Note queue | `supabase/migrations/20260926090000_cash_discount_segments_per_mt.sql` |
| Save a draft's segments (overlap and Sundry Debtors checks) | `backend/src/app/api/companies/[companyId]/scheme-versions/[versionId]/cd-segments/route.ts` |
| Rule editor: segments, products, MT per unit | `frontend/src/components/collections/rule-editor.tsx` |
| Load a per-MT rule; connector scope (customers → segment, products, MT conversions) | `backend/src/lib/evaluation/evidence.ts` (`loadRule`, `loadLiveCdLocalBootstrap`) |
| Read Tally: invoices with MT, Receipt/Journal allocations, existing CD Credit Notes | `tally-bridge/src/commands/live-cd-evidence.mjs` |
| The calculation (categories, windows, amounts, GST deadline) | `tally-bridge/src/local-cd-settlement-evaluator.mjs`; identical copy `backend/src/lib/evaluation/cd-settlement.mjs` (a test fails if they differ) |
| Save the check (Credit Notes are created manually by staff) | `backend/src/lib/evaluation/live-cd.ts` (`completeCdSettlementRun`) |
| Page data / staff "Create Credit Note" | `backend/src/app/api/companies/[companyId]/cash-discount/settlements/...` |
| Cash Discount page (per-MT) | `frontend/src/components/collections/cash-discount-settlements.tsx` |
| GST split and narration | `backend/src/lib/notes/debit-note-gst.mjs` (`noteKind = credit_note`) |
| Create and verify the Credit Note in Tally | `tally-bridge/src/tally/debit-notes.mjs` (Credit Note mode of the Debit Note command) |
| PDF | `backend/src/lib/notes/verified-note-document.mjs` |
| TOD 25-day check counts the CD Credit Note | `tally-bridge/src/commands/live-tod-evidence.mjs` |
| Tests | `tally-bridge/test/cd-settlements.test.mjs` |

Cash Discount Credit Notes are stored with the Cash Discount Debit Notes (`cash_discount_debit_note_postings`, `note_kind = 'credit_note'`) and appear on the Debit Notes page labelled "Cash Discount Credit Note". WhatsApp is disabled for them until a Credit Note template for Cash Discount is approved in MSG91; the current `share_debit_memo` template describes a debit memo.
