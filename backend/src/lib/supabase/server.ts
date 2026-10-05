import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function requireEnv(name: string, value?: string) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getSupabaseUrl() {
  return requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  ).replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    getSupabaseUrl(),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Route handlers can write refreshed auth cookies; Server Components cannot always do so.
          }
        },
      },
    }
  );
}
