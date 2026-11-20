/** A saved candidate alone is insufficient when an existing note needs review. */
export function canCreateCashDiscountNote(row, candidate, note, requiresRecheck) {
  return !requiresRecheck && !row.creditNoteReviewRequired && !["credited", "credit_note_review"].includes(row.status)
    && !row.gstDeadlinePassed && Number(row.creditAmount) > 0
    && Boolean(candidate && ["action_required", "review_required"].includes(candidate.status))
    && (!note || ["failed", "cancelled"].includes(note.status));
}

export function supportsManualCreditNotes(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) return false;
  const parts = version.split(".").map(Number), minimum = [0, 6, 4];
  for (let i = 0; i < 3; i += 1) { if (parts[i] !== minimum[i]) return parts[i] > minimum[i]; }
  return true;
}
