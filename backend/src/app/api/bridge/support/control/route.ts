import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { bridgeSupportAccess } from "@/lib/bridge-support";
import { SupportError, interruptConnectorWork } from "@/lib/connector-support";
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
export async function POST(r: Request) {
  try {
    const body = await r.json();
    const c = await bridgeSupportAccess(r, body.connectorId);
    if (body.action !== "interrupt")
      throw new SupportError("Unsupported control.");
    await interruptConnectorWork(c.id);
    return jsonWithCors(r, { ok: true });
  } catch (e) {
    return jsonWithCors(
      r,
      { error: e instanceof Error ? e.message : "Could not interrupt work." },
      { status: e instanceof SupportError ? e.status : 500 },
    );
  }
}
