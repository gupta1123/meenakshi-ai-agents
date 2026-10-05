import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function createConnectorControlToken() {
  return randomBytes(32).toString("base64url");
}

export function createPendingConnectorIdentity() {
  return {
    installationKey: `meenakshi-${randomUUID()}`,
    machineFingerprint: `pending:${randomUUID()}`,
  };
}

export function hashConnectorSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function secretsMatch(provided: string, storedHash: string | null | undefined) {
  if (!provided || !storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashConnectorSecret(provided), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() ?? request.headers.get("x-bridge-token")?.trim() ?? "";
}

export function readText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function requestIpHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim();
  return ip ? hashConnectorSecret(ip) : null;
}

const SENSITIVE_RESULT_KEY = /token|secret|authorization|password|cookie|raw_?xml/i;

function scrub(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrub(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 4_000) : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_RESULT_KEY.test(key))
      .slice(0, 100)
      .map(([key, item]) => [key, scrub(item, depth + 1)])
  );
}

export function safeBridgeResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cleaned = scrub(value, 0) as Record<string, unknown>;
  try {
    return JSON.stringify(cleaned).length <= 100_000 ? cleaned : { summary: "Result exceeded safe size limit." };
  } catch {
    return { summary: "Result could not be serialized." };
  }
}
