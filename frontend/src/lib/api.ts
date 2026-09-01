export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export const apiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");

type ApiRequestInit = RequestInit & { timeoutMs?: number };

export async function apiRequest<T>(token: string, path: string, init?: ApiRequestInit): Promise<T> {
  const { timeoutMs = 20_000, ...requestInit } = init ?? {};
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
}

export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}
