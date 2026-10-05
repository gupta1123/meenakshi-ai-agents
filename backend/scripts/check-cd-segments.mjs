// Read-only: active MUIPL Cash Discount version and its segments.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: versions } = await db.from("scheme_versions").select("id, version_number, status, effective_from, cd_discount_basis").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").eq("scheme_type", "cd").order("created_at", { ascending: false }).limit(4);
for (const v of versions) {
  const { data: segs } = await db.from("scheme_version_cd_segments").select("id, label, allowed_working_days, amount_per_tonne").eq("scheme_version_id", v.id);
  const { data: members } = await db.from("scheme_version_cd_segment_groups").select("segment_id").eq("scheme_version_id", v.id);
  console.log(v.version_number, v.status, v.effective_from, v.cd_discount_basis, (segs ?? []).map((s) => `${s.label}: ${members.filter((m) => m.segment_id === s.id).length} groups`).join(" | "));
}
