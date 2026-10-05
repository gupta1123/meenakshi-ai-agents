export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export const apiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");

type ApiRequestInit = RequestInit & { timeoutMs?: number };

// React development checks and adjacent workspace components can ask for the
// same read at the same time. Share only in-flight GETs: this removes duplicate
// network/database work without serving stale data after a mutation.
type ReadCacheEntry = { request: Promise<unknown>; expiresAt: number };
const readCache = new Map<string, ReadCacheEntry>();

function readCacheTtl(path: string) {
  if (path.includes("/api/bootstrap")) return 30_000;
  if (path.includes("/rulebook/reference-data")) return 30_000;
  if (path.includes("/tally-health") || path.startsWith("/api/active-company")) return 5_000;
  if (path.includes("/launch-control") || path.includes("/contacts") || path.includes("/message-templates")) return 30_000;
  return 0;
}

export async function apiRequest<T>(token: string, path: string, init?: ApiRequestInit): Promise<T> {
  const { timeoutMs = 20_000, ...requestInit } = init ?? {};
  const method = (requestInit.method ?? "GET").toUpperCase();
  const canDeduplicate = method === "GET" && !requestInit.body && !requestInit.signal;
  const requestKey = canDeduplicate ? `${token}:${apiBaseUrl}${path}` : null;
  const cached = requestKey ? readCache.get(requestKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.request as Promise<T>;
  if (cached && cached.expiresAt <= Date.now()) readCache.delete(requestKey!);

  const request = (async () => {
  const headers = new Headers(requestInit.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (requestInit.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestInit.signal ? AbortSignal.any([requestInit.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${apiBaseUrl}${path}`, { ...requestInit, headers, signal });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
  })();

  if (requestKey) {
    const ttl = readCacheTtl(path);
    readCache.set(requestKey, { request, expiresAt: ttl ? Date.now() + ttl : Number.POSITIVE_INFINITY });
    void request.then(() => {
      if (!ttl && readCache.get(requestKey)?.request === request) readCache.delete(requestKey);
    }, () => {
      if (readCache.get(requestKey)?.request === request) readCache.delete(requestKey);
    });
  }
  return request;
}

export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}
