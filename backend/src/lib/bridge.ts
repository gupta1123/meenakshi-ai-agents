import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { BRIDGE_HEARTBEAT_STALE_MS } from "@/lib/constants";
import { secretsMatch } from "@/lib/security";

export type TallyConnectorRow = {
  id: string; organization_id: string; installation_key: string; display_name: string; machine_fingerprint: string;
  control_token_hash: string; status: "pending_pairing" | "paired" | "revoked"; bridge_version: string | null;
  last_heartbeat_at: string | null; last_ip_hash: string | null; paired_by: string | null; paired_at: string | null;
  revoked_at: string | null; created_at: string; updated_at: string;
};

export const TALLY_CONNECTOR_SELECT = "id, organization_id, installation_key, display_name, machine_fingerprint, control_token_hash, status, bridge_version, last_heartbeat_at, last_ip_hash, paired_by, paired_at, revoked_at, created_at, updated_at";
export const MINIMUM_BRIDGE_VERSION = process.env.MEENAKSHI_MINIMUM_BRIDGE_VERSION ?? "0.2.0";

export function bridgeVersionIsOlder(value: string, minimum = MINIMUM_BRIDGE_VERSION) {
  const left = value.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const right = minimum.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return true;
    if (left[index] > right[index]) return false;
  }
  return false;
}

export function serializeTallyConnector(connector: TallyConnectorRow) {
  const heartbeatAt = connector.last_heartbeat_at ? new Date(connector.last_heartbeat_at).getTime() : 0;
  return {
    id: connector.id, organizationId: connector.organization_id, installationKey: connector.installation_key,
    displayName: connector.display_name, machineFingerprint: connector.machine_fingerprint, status: connector.status,
    bridgeVersion: connector.bridge_version, pairedAt: connector.paired_at, lastHeartbeatAt: connector.last_heartbeat_at,
    heartbeatStale: connector.status === "paired" && (!heartbeatAt || Date.now() - heartbeatAt > BRIDGE_HEARTBEAT_STALE_MS),
    revokedAt: connector.revoked_at, createdAt: connector.created_at, updatedAt: connector.updated_at,
  };
}

export async function authenticateMeenakshiBridge(connectorId: string, controlToken: string, options: { allowPending?: boolean } = {}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", connectorId).maybeSingle();
  if (error) throw error;
  const connector = data as unknown as TallyConnectorRow | null;
  if (!connector || connector.status === "revoked" || !secretsMatch(controlToken, connector.control_token_hash)) return null;
  if (!options.allowPending && connector.status !== "paired") return null;
  return connector;
}

export function tallyCompanyMatches(expectedGuid: string, expectedName: string, observedGuid: string | null, observedName: string | null) {
  const normalizedExpectedGuid = expectedGuid.trim().toLowerCase();
  const normalizedObservedGuid = observedGuid?.trim().toLowerCase() ?? "";
  // A Tally GUID is the immutable accounting identity. Company names are kept
  // for operators and audit history, but may legitimately change in Tally or
  // differ from an older imported record.
  if (normalizedExpectedGuid || normalizedObservedGuid) {
    return Boolean(normalizedExpectedGuid && normalizedObservedGuid) && normalizedExpectedGuid === normalizedObservedGuid;
  }

  const normalizedExpectedName = expectedName.trim().toLowerCase();
  const normalizedObservedName = observedName?.trim().toLowerCase() ?? "";
  return Boolean(normalizedExpectedName && normalizedObservedName) && normalizedExpectedName === normalizedObservedName;
}
