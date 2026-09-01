import { createOrRecoverDebitNote } from "../tally/debit-notes.mjs";

export async function createDebitNote(command, context) {
  return createOrRecoverDebitNote(command, context);
}
