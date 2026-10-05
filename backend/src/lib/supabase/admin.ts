import { createClient } from "@supabase/supabase-js";
import { getSupabaseUrl } from "@/lib/supabase/server";

function requireEnv(name: string, value?: string) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function buildSupabaseAdminClient(options?: { timeoutMs?: number }) {
  const fetchWithTimeout: typeof fetch | undefined = options?.timeoutMs
    ? (input, init = {}) => {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs!);
        const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
        return fetch(input, { ...init, signal });
      }
    : undefined;
  return createClient(
    getSupabaseUrl(),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY),
    {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(fetchWithTimeout ? { global: { fetch: fetchWithTimeout } } : {}),
    }
  );
}

type AdminClient = ReturnType<typeof buildSupabaseAdminClient>;
let adminClient: AdminClient | null = null;

export function createSupabaseAdminClient(): AdminClient {
  if (!adminClient) adminClient = buildSupabaseAdminClient();
  return adminClient;
}

export function createSupabaseAdminClientWithOptions(options?: { timeoutMs?: number }): AdminClient {
  return buildSupabaseAdminClient(options);
}
