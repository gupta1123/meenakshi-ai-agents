import { createClient } from "@supabase/supabase-js";

// Backend REST configuration commonly ends with `/rest/v1`, but Supabase Auth
// requires the project root URL. Normalizing here prevents an Auth request
// such as `/rest/v1/auth/v1/token`, which Supabase rejects as an invalid path.
const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const url = configuredUrl?.replace(/\/rest\/v1\/?$/, "");
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const frontendConfigurationError = !url || !key
  ? "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in frontend/.env.local."
  : null;

export const supabase = url && key ? createClient(url, key) : null;
