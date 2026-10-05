# TOD live-refresh UX audit

Evidence reviewed on 27 Aug 2026:

- `01-tod-calculation-history.png` — Turnover Discount calculation history.
- `02-tally-day-book-25-aug.png` — Tally Day Book for 25 Aug.

## Scope and limitation

This is a focused audit of the calculation-history state. The in-app browser connection was unavailable, so the full customer-results and retry journeys could not be operated live.

## What is working

- The calculation period is visible and the top card gives qualified-customer and projected-discount totals.
- The history has timestamps, statuses and a next action.
- Tally readiness is visible to the tester.

## Highest-priority improvements

1. **Do not show failed data as Ready/Qualified (P0).** The top card says `Ready`, `7 Qualified` and a projected value while the newest history entries say that calculation did not finish. Label it as a non-persisted live preview, or show a blocking reconciliation error; do not enable any downstream Credit Note action until the save succeeds.
2. **Turn the technical mismatch into a useful explanation (P0).** Replace “The live Tally result does not match this evaluation and period” with an admin-oriented message such as: “7 customers are still linked to an older rule period. The current result cannot be saved yet.” Include an expandable technical reference for support.
3. **Summarize, rather than repeat, failed attempts (P1).** Ten individual history rows and seven nearly identical failure rows hide the one useful success. Group a batch as “1 saved, 7 need attention”, make the latest status dominant, and offer a targeted retry after the issue is repaired.
4. **Explain the two dates (P1).** The user reasonably confused the 25 Aug Day Book entry with the 27 Aug run. State: “Counting Tally sales dated 15 Aug–27 Aug; this monthly period closes 14 Sep.”
5. **Clarify live scan versus saved result (P1).** Use visible labels such as `Live Tally preview`, `Last saved result`, and `Last checked at`. The current screen mixes those states.

## Secondary improvements

- Rename compact top controls to `Customer results` and `Calculation history`, with the active context retained in the page heading.
- Put repeated retry controls behind a single batch action; give the user the failing-customer count before retrying.
- Increase contrast and size of references/subtext and retain text labels alongside coloured status badges.
- Provide a “Copy support details” action for a run reference instead of making users rely on browser/network tooling.

## Recommended validation flow

1. Enter or edit a Tally sale dated 25 Aug (inside the 15 Aug–14 Sep period).
2. Show the immediate result as a `Live Tally preview`.
3. After persistence, replace it with `Saved successfully` and show the customer-level list.
4. If a customer has an incompatible old lock, show the clear blocking message above and keep the saved-result total unchanged.

## Diagnosis behind the visible error

The successful run on 25 Aug was for one customer. The later batch reaches seven customers with old yearly May–Apr test locks; the active TOD is monthly (15 Aug–14 Sep). A Day Book entry dated 25 Aug is within the active period, so the calendar date is not the cause.
