import { syncMasters } from "./sync-masters.mjs";
import { syncVouchers } from "./sync-vouchers.mjs";
import { fetchEvidence } from "./fetch-evidence.mjs";
import { createCreditNote } from "./create-credit-note.mjs";
import { verifyCreditNote } from "./verify-credit-note.mjs";
import { exportCreditNotePdf } from "./export-credit-note-pdf.mjs";
import { createDebitNote } from "./create-debit-note.mjs";

export async function executeCommand(command, context) {
  if (command.commandType === "sync_meenakshi_masters") return syncMasters(command, context);
  if (command.commandType === "sync_meenakshi_vouchers") return syncVouchers(command, context);
  if (command.commandType === "fetch_meenakshi_evidence") return fetchEvidence(command, context);
  if (command.commandType === "create_credit_note") return createCreditNote(command, context);
  if (command.commandType === "verify_credit_note") return verifyCreditNote(command, context);
  if (command.commandType === "export_credit_note_pdf") return exportCreditNotePdf(command, context);
  if (command.commandType === "create_debit_note") return createDebitNote(command, context);
  throw new Error(`Unsupported Meenakshi bridge command: ${command.commandType}`);
}
