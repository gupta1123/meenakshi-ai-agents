export function canCreateCashDiscountNote(
  row: { status: string; creditAmount: string; gstDeadlinePassed: boolean; creditNoteReviewRequired?: boolean },
  candidate: { status: string } | null | undefined,
  note: { status: string } | null | undefined,
  requiresRecheck: boolean,
): boolean;
export function supportsCdSettlementChecks(version: string | null | undefined): boolean;
