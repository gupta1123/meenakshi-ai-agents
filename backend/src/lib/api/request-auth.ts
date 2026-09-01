import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { createSupabaseServerClient, getSupabaseUrl } from "@/lib/supabase/server";

type RequestUser = { id: string };

let tokenValidationClient: ReturnType<typeof createClient> | null = null;
const TOKEN_CACHE_TTL_MS = 15_000;
const tokenCache = new Map<string, { expiresAt: number; request: Promise<RequestUser | null> }>();

function requireEnv(name: string, value?: string) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getTokenValidationClient() {
  if (!tokenValidationClient) {
    tokenValidationClient = createClient(
      getSupabaseUrl(),
      requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return tokenValidationClient;
}

export async function requireRequestUser(request: Request): Promise<RequestUser | null> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const cacheKey = createHash("sha256").update(token).digest("base64url");
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.request;

    const validation = getTokenValidationClient().auth.getUser(token).then(({ data: { user }, error }) => {
      if (error || !user) return null;
      return { id: user.id };
    });
    tokenCache.set(cacheKey, { expiresAt: Date.now() + TOKEN_CACHE_TTL_MS, request: validation });
    if (tokenCache.size > 500) {
      const now = Date.now();
      for (const [key, entry] of tokenCache) {
        if (entry.expiresAt <= now || tokenCache.size > 400) tokenCache.delete(key);
      }
    }
    const user = await validation;
    if (user) return user;
    tokenCache.delete(cacheKey);
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { id: user.id } : null;
}
