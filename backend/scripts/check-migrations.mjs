// Read-only check of which recent migrations are visible in the database.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "");
const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const report = (name, ok, note = "") => console.log(`${ok === null ? "UNKNOWN" : ok ? "APPLIED" : "NOT APPLIED"}  ${name}${note ? `  (${note})` : ""}`);

const docCols = await supabase.from("companies").select("document_address,document_gstin,document_state").limit(1);
report("20260925120000_company_document_details", !docCols.error, docCols.error?.message);

const basis = await supabase.from("scheme_versions").select("cd_discount_basis").limit(1);
report("20260926090000_cash_discount_segments_per_mt", !basis.error, basis.error?.message);

const template = await supabase.from("whatsapp_templates").select("id").eq("provider_template_id", "share_debit_memo").eq("event_type", "cd_debit_note_created").limit(1);
report("20260925100000_register_share_debit_memo_template", template.error ? null : template.data.length > 0, template.error?.message);

// Automatic messages created after the manual-sending migration would indicate the triggers still exist.
const auto = await supabase.from("notification_messages").select("id,created_at,event_type").is("created_by", null).in("event_type", ["cd_shortfall", "tod_tier_reached"]).order("created_at", { ascending: false }).limit(1);
const cancelled = await supabase.from("notification_messages").select("id").eq("status", "cancelled").ilike("failure_reason", "Automatic WhatsApp sending was turned off%").limit(1);
report("20260923120000_manual_whatsapp_sending", cancelled.error ? null : cancelled.data.length > 0 ? true : null,
  cancelled.data?.length ? "found messages it cancelled" : `no direct evidence; latest automatic message: ${auto.data?.[0]?.created_at ?? "none"}`);
