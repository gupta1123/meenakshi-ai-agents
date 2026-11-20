type Data = Record<string, unknown>;

/** Check returned evidence against the server-owned request before replay or save. */
export function validateSupportEvidence(
  body: Data,
  evidence: Data,
  scheme: string,
) {
  const scope = body.voucherScope as {
    customers: Array<{ customerId: string }>;
    dateFrom: string;
    dateTo: string;
    invoiceDateTo?: string;
  };
  const customers = new Set(scope.customers.map((c) => c.customerId));
  if (scheme === "cd") {
    if (
      evidence.mode !== "live_cd_batch" ||
      evidence.ruleVersionId !== (body.rule as { id: string }).id ||
      evidence.dateFrom !== scope.dateFrom ||
      evidence.dateTo !== scope.dateTo ||
      !Array.isArray(evidence.invoices) ||
      evidence.invoices.length > 25000 ||
      evidence.creditNoteMatchingVersion !== 2
    )
      throw new Error(
        "CD evidence does not match the requested rule and period.",
      );
    const seen = new Set();
    for (const invoice of evidence.invoices) {
      if (
        !customers.has(invoice.customerId) ||
        !invoice.tallyGuid ||
        seen.has(invoice.tallyGuid) ||
        invoice.voucherDate < scope.dateFrom ||
        invoice.voucherDate > (scope.invoiceDateTo ?? scope.dateTo)
      ) {
        throw new Error(
          "CD evidence contains an invoice outside the requested customer or period.",
        );
      }
      seen.add(invoice.tallyGuid);
    }
    if (
      (Array.isArray(evidence.customerCredits)
        ? evidence.customerCredits
        : []
      ).some((c) => !customers.has(c.customerId))
    )
      throw new Error("Credit evidence belongs to another customer.");
    return { ...evidence, customerScope: body.customerScope ?? null };
  }
  if (
    evidence.mode !== "live_tod_batch_aggregate" ||
    evidence.periodStart !== scope.dateFrom ||
    evidence.periodEnd !== scope.dateTo ||
    !Array.isArray(evidence.customerAggregates) ||
    evidence.customerAggregates.length !== customers.size ||
    new Set(evidence.customerAggregates.map((c) => c.customerId)).size !==
      customers.size ||
    evidence.customerAggregates.some((c) => !customers.has(c.customerId))
  ) {
    throw new Error(
      "TOD evidence does not match the requested customers and complete period.",
    );
  }
  return evidence;
}

/** Replace selected customers only; preserve other rows and their original provenance. */
export function mergeCdSnapshotRows(
  previous: Data | null,
  current: Data[],
  scope: string[] | null,
) {
  if (!scope) return current;
  if (!scope.length || new Set(scope).size !== scope.length)
    throw new Error("A partial refresh requires a unique customer scope.");
  if (previous?.evidenceSchemaVersion !== 2)
    throw new Error(
      "A full connector 0.6.0 CD check is required before saving a partial refresh.",
    );
  const selected = new Set(scope);
  if (current.some((row) => !selected.has(String(row.customerId))))
    throw new Error("A partial result contains another customer.");
  return [
    ...((previous.settlementResults ?? []) as Data[]),
    ...((previous.excludedInvoices ?? []) as Data[]),
  ]
    .filter((row) => !selected.has(String(row.customerId)))
    .concat(current);
}
