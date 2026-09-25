# Cash Discount (CD): core logic

**Status:** agreed rules, source of truth (client notes of 2026-09-25, `cdnotes.txt`). **Not built yet.** Section 8 lists what changes from the current implementation.

## 1. The idea in one paragraph

The invoice goes out at **full price**. A customer who pays within their Cash Discount window may pay the invoice **minus the discount** (₹ per MT). When that happens, we issue a **Credit Note** for the discount so the bill closes. A customer who pays in full has not claimed the discount, so nothing is issued. Payments of more than 90% that fit neither case are shown to staff, who decide.

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
  - a window in **working days**;
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

## 4. The window: working days

- Count **working days after the invoice date**. **Sundays** and **holidays** from the rule's holiday calendar are not counted.
- **Deadline** = the Nth working day after the invoice date (N = 3 or 10). A payment **on** the deadline counts.
- Example: invoice Friday 3 Oct 2025, 3 working days. Sat 4 is day 1, Sun 5 is skipped, Mon 6 is day 2 (if it's not a holiday), Tue 7 is day 3, so the deadline is Tue 7 Oct.

## 5. Payments that count

- **Receipts** with an *Agst Ref* allocation to the invoice, matched by invoice GUID, voucher number, or bill name. This is the same matching as TOD's 25-day check.
- **Journal** vouchers with an *Agst Ref* allocation to the invoice also count. This covers TDS booked separately against the bill. TDS booked inside the receipt is already included.
- Only amounts **received on or before the deadline** count for the categories below. All amounts are **GST-inclusive** (bill amounts).

## 6. Categories

The screen **shows** the categories in the client's order: Full payment, More than 90%, Discounted payment. For each invoice, `received` is the total received by the deadline, and `invoice` is the bill amount.

| Category | Condition | Result |
|---|---|---|
| **Full payment** | received ≥ invoice − ₹1 | **No Credit Note.** Discount not claimed. Shown for information only. |
| **Discounted payment** | received is within ±₹1 of invoice − discount | **Credit Note for the discount, automatically.** The bill closes at zero. |
| **More than 90%** | received ≥ 90% of invoice, and neither of the above | **Staff decide.** The entry is shown with an option to create a Credit Note for **only what is short**, **capped at the discount**: min(invoice − received, discount). Nothing happens automatically. |
| **Not eligible** | received < 90% of invoice by the deadline, or no payment by the deadline | No discount. Any shortfall stays in the customer's outstanding balance. |

**Evaluation order:** the system checks the exact matches first (Full, then Discounted), then the 90% band. A discounted payment is almost always above 90% of the invoice, so checking the 90% band first would swallow every discounted payment.

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

**More than 90% cap (confirmed):** the Credit Note never exceeds the agreed discount. Example: 91% paid on ₹1,00,000 leaves ₹9,000 short; with a ₹500 discount, the Credit Note is ₹500.

## 10. Still to confirm

Nothing. All rules above are agreed.
