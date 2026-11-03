import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

const BUCKET = "connector-logs";
const MAX_BASE64_CHARS = 3_000_000; // about 2 MB of gzip
const KINDS = new Set(["manual", "failure", "crash"]);

/**
 * A connector sends its log text (gzip, base64) so we can read what happened on
 * the client's PC. Authenticated like the heartbeat; stored privately.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const machineFingerprint = readText(body.machineFingerprint, 500);
    const controlToken = readBridgeToken(request) || "";
    if (!isUuid(connectorId) || !machineFingerprint || !controlToken) {
      return jsonWithCors(request, { error: "Connector identity is required." }, { status: 400 });
    }
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    if (connector.machine_fingerprint !== machineFingerprint) {
      return jsonWithCors(request, { error: "Logs came from a different connector installation." }, { status: 409 });
    }
    const kind = readText(body.kind, 20) ?? "manual";
    if (!KINDS.has(kind)) return jsonWithCors(request, { error: "Unknown log upload type." }, { status: 422 });
    const encoded = typeof body.contentGzBase64 === "string" ? body.contentGzBase64 : "";
    if (!encoded || encoded.length > MAX_BASE64_CHARS) {
      return jsonWithCors(request, { error: "The log upload is empty or too large." }, { status: 413 });
    }
    const content = Buffer.from(encoded, "base64");
    const days = Array.isArray(body.days) ? body.days.map((day) => readText(day, 10)).filter((day): day is string => /^\d{4}-\d{2}-\d{2}$/.test(day ?? "")).slice(0, 14) : [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const storagePath = `${connector.id}/${stamp}-${kind}.log.gz`;

    const admin = createSupabaseAdminClient();
    let upload = await admin.storage.from(BUCKET).upload(storagePath, content, { contentType: "application/gzip" });
    if (upload.error && /bucket not found/i.test(upload.error.message)) {
      await admin.storage.createBucket(BUCKET, { public: false });
      upload = await admin.storage.from(BUCKET).upload(storagePath, content, { contentType: "application/gzip" });
    }
    if (upload.error) throw upload.error;

    const { data, error } = await admin.from("connector_log_uploads").insert({
      connector_id: connector.id,
      organization_id: connector.organization_id,
      kind,
      reason: readText(body.reason, 500) || null,
      bridge_version: readText(body.bridgeVersion, 40) || null,
      log_days: days,
      size_bytes: content.length,
      storage_path: storagePath,
    }).select("id").single();
    if (error) throw error;
    return jsonWithCors(request, { id: data.id });
  } catch (error) {
    console.error("Error in POST /api/bridge/logs:", error);
    return jsonWithCors(request, { error: "Could not store the connector logs." }, { status: 500 });
  }
}
