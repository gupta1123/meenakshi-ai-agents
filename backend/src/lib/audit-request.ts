/**
 * Pure helpers for the "who called which write endpoint" audit trail.
 * Kept free of database imports so they can be unit tested.
 */

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Write endpoints that are not a person's decision (progress pings, previews)
 * and would only add noise to the trail.
 */
const NOISY_ROUTE_PARTS = ["/calculation-events", "/notifications/previews"];

export type ApiWriteAudit = {
  method: string;
  /** Route with ids replaced by :id and the company prefix removed, e.g. /cash-discount/settlements/:id/credit-note */
  route: string;
  /** The last id in the path (the record acted on), when there is one. */
  entityId: string | null;
};

/** Returns null for reads and for routes that should not be audited. */
export function describeApiWrite(method: string, url: string): ApiWriteAudit | null {
  const upper = method.toUpperCase();
  if (READ_ONLY_METHODS.has(upper)) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "http://local").pathname;
  } catch {
    return null;
  }
  if (NOISY_ROUTE_PARTS.some((part) => pathname.includes(part))) return null;
  const ids = pathname.match(UUID) ?? [];
  const withoutApi = pathname.replace(/^\/api/, "");
  const withoutCompany = withoutApi.replace(/^\/companies\/[0-9a-f-]{36}/i, "");
  const route = (withoutCompany || withoutApi).replace(UUID, ":id") || "/";
  // The first id is the company; the last one is the record, if different.
  const entityId = ids.length > 1 ? ids[ids.length - 1].toLowerCase() : null;
  return { method: upper, route, entityId };
}

/** One role label for reports: administrator wins over finance_approver. */
export function primaryRole(roles: readonly string[]): string {
  if (roles.includes("administrator")) return "administrator";
  return roles[0] ?? "unknown";
}
