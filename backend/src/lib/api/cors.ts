import { NextResponse } from "next/server";

const DEVELOPMENT_ORIGINS = ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"];

function allowedOrigins() {
  return new Set(
    [process.env.FRONTEND_ORIGIN, ...DEVELOPMENT_ORIGINS]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.replace(/\/+$/, ""))
  );
}

function requestOrigin(request: Request) {
  return request.headers.get("origin")?.replace(/\/+$/, "") ?? null;
}

export function applyCorsHeaders(response: NextResponse, request: Request) {
  const origin = requestOrigin(request);
  if (origin && allowedOrigins().has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");
    response.headers.set("Access-Control-Allow-Credentials", "false");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Max-Age", "86400");
  }
  return response;
}

export function jsonWithCors(request: Request, body: unknown, init?: ResponseInit) {
  return applyCorsHeaders(NextResponse.json(body, init), request);
}

export function optionsWithCors(request: Request) {
  const origin = requestOrigin(request);
  if (!origin || !allowedOrigins().has(origin)) return new NextResponse(null, { status: 403 });
  return applyCorsHeaders(new NextResponse(null, { status: 204 }), request);
}
