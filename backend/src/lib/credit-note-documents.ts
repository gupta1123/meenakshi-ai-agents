export type CreditNoteDocumentRow = {
  id: string;
  status: string;
  storage_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  attached_at: string | null;
  verified_at: string | null;
  failure_reason: string | null;
};

export const CREDIT_NOTE_DOCUMENTS_BUCKET = "meenakshi-credit-note-documents";

export function hasSafeCreditNoteDocumentPath(storagePath: string | null) {
  const path = storagePath?.trim() ?? "";
  return Boolean(path) && !path.includes("..") && !path.startsWith("/") && !path.includes("\\");
}

function trustedDocumentUrl(storagePath: string | null) {
  const path = storagePath?.trim() ?? "";
  if (!hasSafeCreditNoteDocumentPath(path)) return null;
  if (/^https:\/\//i.test(path)) return path;
  const base = String(process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A browser-safe document response. Storage paths are never returned. */
export function toSafeCreditNoteDocument(row: CreditNoteDocumentRow | null, includeUrl = false) {
  if (!row) return null;
  const url = includeUrl && row.status === "verified" ? trustedDocumentUrl(row.storage_path) : null;
  return {
    id: row.id,
    status: row.status,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    attachedAt: row.attached_at,
    verifiedAt: row.verified_at,
    failureReason: row.failure_reason,
    // A relative path is held in the private Supabase Storage bucket. The
    // authenticated document endpoint signs it only when the user requests a
    // preview; the path itself is never exposed to the browser.
    available: row.status === "verified" && hasSafeCreditNoteDocumentPath(row.storage_path),
    ...(url ? { downloadUrl: url } : {}),
  };
}
