import { createOrRecoverCreditNote } from "../tally/credit-notes.mjs";

export async function createCreditNote(command, context) {
  return createOrRecoverCreditNote(command, context);
}
