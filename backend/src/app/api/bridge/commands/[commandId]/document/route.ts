import { createHash } from "node:crypto";

import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { CREDIT_NOTE_DOCUMENTS_BUCKET } from "@/lib/credit-note-documents";
import { isUuid, readBridgeToken, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ commandId: string }> };
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function postingIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).creditNotePostingId;
  return isUuid(value) ? value : null;
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Receive native PDF bytes from a paired Windows Tally bridge only. */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { commandId } = await context.params;
    const connectorId = readText(request.headers.get("x-connector-id"), 80);
    const controlToken = readBridgeToken(request);
    const tallyGuid = readText(request.headers.get("x-tally-voucher-guid"), 160);
    const attempt = Number(request.headers.get("x-command-attempt"));
    if (!isUuid(commandId) || !connectorId || !isUuid(connectorId) || !controlToken || !tallyGuid || !Number.isInteger(attempt) || attempt < 1) {
      return jsonWithCors(request, { error: "A command, paired bridge credential, and verified Tally voucher identity are required." }, { status: 400 });
    }
    if (!/^application\/pdf(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return jsonWithCors(request, { error: "Only application/pdf uploads are accepted." }, { status: 415 });
    }

    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return jsonWithCors(request, { error: "The bridge upload is not a supported PDF file." }, { status: 400 });
    }

    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid bridge credential." }, { status: 401 });
    const supabase = createSupabaseAdminClient();
    const { data: command, error: commandError } = await supabase.from("tally_commands")
      .select("id, company_id, connector_id, command_type, status, payload, attempts")
      .eq("id", commandId).eq("connector_id", connector.id).eq("status", "sending").eq("attempts", attempt).maybeSingle();
    if (commandError) throw commandError;
    if (!command || command.command_type !== "export_credit_note_pdf") {
      return jsonWithCors(request, { error: "This PDF upload is not currently leased to the paired bridge." }, { status: 409 });
    }
    const postingId = postingIdFromPayload(command.payload);
    if (!postingId) return jsonWithCors(request, { error: "The PDF export command is missing its Credit Note identity." }, { status: 409 });
    const { data: posting, error: postingError } = await supabase.from("credit_note_postings")
      .select("id, status, verified_tally_guid")
      .eq("id", postingId).eq("company_id", command.company_id).maybeSingle();
    if (postingError) throw postingError;
    if (!posting || posting.status !== "created_verified" || posting.verified_tally_guid !== tallyGuid) {
      return jsonWithCors(request, { error: "The uploaded PDF does not match the currently verified Credit Note." }, { status: 409 });
    }

    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `${command.company_id}/${postingId}/${sha256Hex}.pdf`;
    const { error: uploadError } = await supabase.storage.from(CREDIT_NOTE_DOCUMENTS_BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      cacheControl: "private, max-age=0",
      upsert: false,
    });
    // The exact content-addressed path makes a repeated upload after a lost
    // response harmless while preventing one voucher export from overwriting
    // another document.
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;
    return jsonWithCors(request, { storagePath, sha256Hex, fileSizeBytes: bytes.length });
  } catch (error) {
    console.error("Could not receive verified Tally Credit Note PDF:", error);
    return jsonWithCors(request, { error: "Could not receive the verified Tally Credit Note PDF." }, { status: 500 });
  }
}
