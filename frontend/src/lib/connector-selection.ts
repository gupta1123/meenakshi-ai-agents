export type ConnectorIdentity = {
  id: string;
  machineFingerprint: string;
  status: string;
};

// Never choose an arbitrary historical session. Browser memory is only a hint:
// IDs must still belong to this workspace, and pairing verifies the machine.
export function selectReconnectConnector<T extends ConnectorIdentity>(
  connectors: T[],
  localId: string | null,
  rememberedId: string | null,
  boundId: string | null,
): T | null {
  const available = connectors.filter((connector) => connector.status !== "revoked");
  for (const id of [localId, rememberedId, boundId]) {
    const match = available.find((connector) => connector.id === id);
    if (match) return match;
  }
  return available.length === 1 ? available[0] : null;
}
