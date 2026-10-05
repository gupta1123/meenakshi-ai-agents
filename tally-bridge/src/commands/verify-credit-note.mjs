import { verifyCreditNote as readBackCreditNote } from "../tally/credit-notes.mjs";

export async function verifyCreditNote(command, context) {
  return readBackCreditNote(command, context);
}
