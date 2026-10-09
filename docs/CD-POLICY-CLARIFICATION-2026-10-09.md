# CD policy clarification — 9 October 2026

User supplied Shubham's reply: “Yes for first. No for second.”
The questions were whether full payment on time earns a discount Credit Note,
and whether a small deadline shortfall later paid in full still earns one.

- Full payment by the inclusive deadline: retain the staff-created discount offer.
- Discounted/small-shortfall category later paid in full: retain deadline evidence,
  set new proposed credit to zero and show settled_late. Use the existing ₹1
  settlement tolerance and only payments through the evaluation date.
- Existing Credit Notes and posted audit history are retained; no reversal.
- Partial later payments are not treated as full settlement by this change.
- TOD quantities and tax policy are not changed by this clarification.

Both per-MT evaluators implement the same rule. Frontend selection rejects
zero-credit rows and explains later full settlement. Regression fixtures cover
on-time full payment, discounted and review cases, future/partial later receipts,
existing notes, and actual BKP 1418 / 3165 payment splits.

Connector release: 0.3.4. Install the new connector and use matching backend and
frontend source. Recalculate before using saved candidates. Building is not
deployment or installation; no Tally vouchers or old cases were deleted.

Local verification: 19 targeted connector/CD tests, 46 backend tests and
11 frontend tests pass; backend and frontend type checks pass. Installer 0.3.4
compiled successfully and its packaged evaluator SHA-256 matches source.
Live installation/recalculation and hosted deployment are not performed here.
