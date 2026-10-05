# WhatsApp message test matrix

Last updated: 24 August 2026

## Purpose

This is the agreed check-list for deciding whether a WhatsApp message should be sent. A message must be sent only when all of these are true:

1. The company is in the relevant business state.
2. The customer has an active WhatsApp consent record.
3. An active, approved WhatsApp template is mapped to that event.
4. The message is not already recorded as sent for that event.

## Cash Discount (CD)

| Company / business state | Expected result | WhatsApp action |
| --- | --- | --- |
| Near eligibility: customer has paid part of an invoice and can still qualify by paying the remaining shortfall before the deadline | Eligible for a CD reminder | Send `cd_shortfall` once, using `meenakshi_cd_shortfall_v1` with: customer name, paid amount, shortfall amount, deadline. |
| Fully qualified for discount | No shortfall remains | Do **not** send the CD-shortfall reminder. Send a Cash Discount Credit Note message only after the credit note is verified and posted in Tally, if that separate business message is approved. |
| Discount window expired / recovery action required | Customer can no longer qualify for this discount | Do **not** send the CD-shortfall template. A separate, manager-approved recovery template would be required before messaging. |
| Data exception, missing amount, missing deadline, or customer does not have consent | Needs review | Do not send a WhatsApp message. |

### Current live Tally snapshot — 24 August 2026

This section was calculated read-only from the company currently open in Tally, **Solution Nyx**, using the active rules. It replaces the earlier screen-only list.

#### CD: 86 invoices checked

| CD category | Count | Companies / invoices | Correct WhatsApp decision |
| --- | ---: | --- | --- |
| Already qualified (paid by the 4-working-day deadline) | 4 invoices | Apex Rebar Projects (invoices 55, 60 and 65); Bharath Rebar Projects (invoice 72). | Do **not** send `cd_shortfall`; there is no shortfall. A later Credit Note confirmation would need its own approved template. |
| Near eligibility (at least 80% paid, deadline still open) | **0 invoices** | None in the live calculation. | No CD reminder can be sent today because there is no eligible CD-shortfall case. |
| Still tracking / below the 80% threshold | 42 invoices | The invoices dated 19–24 August are still within their payment windows, but none has reached the 80% payment threshold. | Do **not** send yet. Recalculate after a payment is posted; send only if it becomes `near_eligibility`. |
| Recovery required (deadline missed) | 40 invoices | Apex Rebar Projects (7), Balaji Rebar Projects (4), Bharath Rebar Projects (2), Central India Rebar Projects (1), Deccan Rebar Projects (2), and 12 other companies with two invoices each: Central India Steel, Eastern Steel, Kaveri Rebar, Narmada Steel, Pioneer Steel, Surya Steel, Crystal Rebar, Ganesh Rebar, Mahaveer Rebar, Omkar Rebar, Sai Rebar, and Triveni Rebar. | Do **not** send `cd_shortfall`. These are debit-note/recovery cases, not discount-reminder cases. |
| Review required | 0 invoices | None. | No action. |

The controlled WhatsApp delivery to Apex Rebar Projects was a technical test only. It proves the MSG91 route and template delivery; it does **not** prove that Apex is eligible for a CD reminder.

#### TOD: 40 customers checked for 15 August–14 September 2026

| TOD category | Count | Companies | Correct WhatsApp decision |
| --- | ---: | --- | --- |
| Tier reached at 2% | 7 | Narmada Rebar, Narmada Steel, Kaveri Rebar, Mahaveer Rebar, Mahavir Rebar, Indus Steel, Mahaveer Steel. | Per Shubham's policy, send one `tod_tier_reached` message for this 2% tier and period **after** a real approved template and event are implemented. |
| Tier reached at 3% | 7 | Omkar Rebar, Orion Rebar, Orion Steel, Pioneer Rebar, Pioneer Steel, Sai Rebar, Shakti Rebar. | Same: one tier-reached message once implementation is ready. |
| Tier reached at 5% | 7 | Surya Steel, Triveni Rebar, Triveni Steel, Shakti Steel, Vidarbha Rebar, Vidarbha Steel, Surya Rebar. | Same: one tier-reached message once implementation is ready. |
| No tier reached yet | 19 | Seven are 5 tonnes short; seven are 20 tonnes short; five have not recorded eligible tonnes. | Do not send a TOD message yet. |
| Needs review | 0 | None. | No action. |

"Tier reached" is the correct meaning of **eligible** for TOD. The present code does not yet send at that point—it only knows the later `tod_credit_note_created` event—so none of the 21 TOD messages should be sent until the required event/template work is complete.

## Turnover Discount (TOD)

| Company / business state | Expected result | WhatsApp action |
| --- | --- | --- |
| Any TOD tier/slab reached during the current period | Customer has qualified for that tier | **Send a TOD tier-reached message once for that tier and period.** This is the manager-confirmed policy. |
| Higher TOD tier reached later in the same period | Customer has qualified for a new tier | Send a new TOD tier-reached message once for the newly reached tier; do not resend on every calculation. |
| Turnover threshold not met, or the evaluation is still in progress | No tier reached | Do not send a WhatsApp message. |
| TOD credit note has been verified and posted in Tally | Credit note is complete | A separate `tod_credit_note_created` message may be sent if the business wants a second confirmation. |
| Credit note is draft, rejected, failed, or needs review | Not ready to notify the customer | Do not send a WhatsApp message. |
| Customer has no WhatsApp consent or no active approved TOD template | Sending is blocked | Do not send a WhatsApp message. |

## Template details to verify

The active CD template is `meenakshi_cd_shortfall_v1` (English) with four variables:

| Template variable | Meenakshi data field |
| --- | --- |
| `body_1` | `customerName` |
| `body_2` | `paidAmount` (number only; the MSG91 template adds `₹`) |
| `body_3` | `shortfallAmount` (number only; the MSG91 template adds `₹`) |
| `body_4` | `eligibilityDeadline` |

## Implementation still required for the manager-confirmed TOD policy

The currently approved, live MSG91 template is only the CD shortfall template. The other visible CD/TOD mappings use local mock template IDs and cannot be used for a real WhatsApp delivery.

Before sending real TOD messages, the team must:

1. Obtain or approve a real MSG91 WhatsApp template for `tod_tier_reached`.
2. Confirm its exact wording and variables (recommended: customer name, reached percentage, projected discount, period end).
3. Add the `tod_tier_reached` event to Meenakshi and record one delivery per customer, tier, and period.
4. Verify its recipient consent and exact message preview with a controlled test number before enabling normal sends.

## What to check before any future live test

1. Choose one company that is actually shown as `near_eligibility` for CD, or has reached a TOD tier once the TOD-tier template is ready.
2. Confirm its consent is active in **Rulebook → Contacts & consent**.
3. Confirm the correct event template is active in **Messages → Approved WhatsApp templates**.
4. Check the message preview and its four/five values match the approved template.
5. Send once only, then verify both the delivery record in Meenakshi and the received WhatsApp message.

The controlled test has one permitted correction retest for the currency-format fix. It still sends only to the configured test number and is blocked permanently after that retest.
