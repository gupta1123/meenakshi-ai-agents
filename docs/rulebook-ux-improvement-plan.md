# Rulebook create and edit improvement plan

## Purpose

Make creating and editing Cash Discount (CD) and Turnover Discount (TOD) rules easy to follow, while preserving the existing safety rule: an active rule is never changed retrospectively.

## What is confusing today

1. The user begins in **Terms**, then is moved to a separate **eligibility** drawer for groups, products, conversions, and TOD tiers.
2. The app calls the working copy a **draft** and labels it **Unsaved changes**, even though the server has already saved it safely.
3. The active-rule screen has two separate actions: **Edit terms** and **Edit eligibility**. This makes changing customer groups feel like a different, hidden task.
4. The eligibility drawer shows all its setup controls at once. It is difficult to tell what must be completed next.
5. A new-rule request currently omits the required rule `code` field expected by the backend. Fix this before relying on the create flow.

## Product decision

Keep versioning internally, but do not make the administrator manage the word or concept **draft**.

When an active rule is edited, the user sees **Editing a pending update**. The live rule stays active until the administrator checks and applies the update. The internal immutable version and audit trail remain unchanged.

## Target flow

### Create rule

1. **Rule type and terms**
   - Choose CD or TOD.
   - Enter name, reference code, effective date, and commercial terms.
2. **Customer groups**
   - Search and select Tally customer groups.
   - Show selected groups and covered-customer count immediately.
3. **TOD-only eligibility**
   - Select products or product groups.
   - Confirm conversion to tonnes.
   - Add and order discount tiers.
4. **Review and apply**
   - Show one plain-language summary of terms, groups, products, conversions, tiers, dates, and validation issues.
   - Save as pending, then allow **Check rule** and **Apply rule**.

### Edit active rule

1. Click **Edit rule**.
2. Open the same stepper, pre-filled from the current active rule.
3. Allow direct editing of every appropriate field, including customer groups.
4. Show a fixed summary panel: **Live rule remains unchanged until you apply this update**.
5. On the review step, show a clear before/after change list.
6. Validate, then apply the pending update. Keep history available separately.

## UI changes

- Replace the two separate drawers with one stepper drawer or page.
- Use **Back**, **Save and continue**, and **Review changes**; do not show every setup section at once.
- Keep a compact selected-items summary visible throughout the flow.
- Place an **Edit customer groups** action in the same edit journey, not as a separate administration task.
- Replace user-facing `draft`/`unsaved changes` copy with `pending update`/`changes not applied yet`.
- Keep version history read-only in a separate expandable section.

## Implementation plan

1. **Foundation**
   - Fix the missing new-rule `code` field in the RuleEditor request.
   - Preserve the existing server-side version creation, validation, and audit APIs.
2. **Shared flow state**
   - Build one `RuleSetupFlow` component shared by create and edit.
   - Seed edit mode from the pending update when it exists, otherwise clone the active version internally.
3. **Stepper screens**
   - Move terms, groups, TOD products/conversions/tiers, and review into explicit steps.
   - Persist each completed step safely; leaving or returning must not lose selections.
4. **Scope editing**
   - Reuse the existing group add/remove endpoints against the pending version.
   - Show selected groups, inherited subgroup coverage, and customer count before continuing.
5. **Review and apply**
   - Build before/after summary from active and pending versions.
   - Surface validation errors beside the relevant step and provide a direct return link.
6. **Copy and history**
   - Rename visible draft language while retaining internal version status.
   - Keep applied/past versions in a separate history view.

## Acceptance tests

- Create a CD rule with a required reference code and customer groups.
- Create a TOD rule with groups, products, conversion, and multiple tiers.
- Edit an active CD rule and add/remove a customer group; confirm the live rule is unchanged before apply.
- Edit an active TOD rule and change a tier; confirm existing historical evaluations retain their original version.
- Leave the flow and return; confirm saved selections remain.
- Validate missing groups, missing TOD conversions, overlapping active dates, and incomplete tiers.
- Confirm only one pending update can exist per rule and that an applied update appears in history.

## Out of scope for this change

- Changing CD/TOD eligibility calculations.
- WhatsApp template approval and notification rules.
- Altering Tally customers, groups, vouchers, or historical data.
