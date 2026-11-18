import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken } from "@/lib/security";
import { SupportError } from "@/lib/connector-support";
export async function bridgeSupportAccess(r: Request, id: unknown) {
  if (!isUuid(id) || !readBridgeToken(r))
    throw new SupportError("Connector identity is required.", 400);
  const c = await authenticateMeenakshiBridge(id, readBridgeToken(r));
  if (!c) throw new SupportError("Invalid connector credential.", 401);
  return c;
}
