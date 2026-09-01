import { createClient } from "@supabase/supabase-js";

const companyId = process.argv[2];
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/i, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!companyId || !url || !key) throw new Error("Company id and Supabase service credentials are required.");
const database = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: runs, error } = await database.from("evaluation_runs")
  .select("id,status,created_at,updated_at,completed_at,error_summary,request_context,tally_master_refresh_run_id,tally_voucher_refresh_run_id,summary")
  .eq("company_id", companyId).order("created_at", { ascending: false }).limit(8);
if (error) throw error;
console.log(JSON.stringify((runs ?? []).map((run) => ({ ...run, summary: run.summary ? { ...run.summary, liveTodEvidence: run.summary.liveTodEvidence ? "[present]" : undefined } : null })), null, 2));
const syncIds = (runs ?? []).flatMap((run) => [run.tally_master_refresh_run_id, run.tally_voucher_refresh_run_id]).filter(Boolean);
if (syncIds.length) {
  const { data: syncs, error: syncError } = await database.from("tally_sync_runs").select("id,sync_kind,status,error_summary,records_received,completed_at").in("id", syncIds);
  if (syncError) throw syncError;
  console.log("SYNCS", JSON.stringify(syncs, null, 2));
}
const { data: commands, error: commandError } = await database.from("tally_commands").select("id,status,command_type,created_at,failure_reason,payload").eq("company_id", companyId).order("created_at", { ascending: false }).limit(6);
if (commandError) throw commandError;
console.log("COMMANDS", JSON.stringify(commands, null, 2));
if (process.argv.includes("--derive") && runs?.[0]) {
  const { deriveRefreshScope, loadLiveTodBatchContext } = await import("../src/lib/evaluation/evidence.ts");
  try {
    console.log("BATCH CONTEXT", JSON.stringify(await loadLiveTodBatchContext(runs[0]), null, 2));
    console.log("DERIVED SCOPE", JSON.stringify(await deriveRefreshScope(runs[0]), null, 2));
  } catch (cause) {
    console.error("DERIVE ERROR", cause);
    process.exitCode = 1;
  }
}
if (process.argv.includes("--config")) {
  const { data: versions, error: versionError } = await database.from("scheme_versions").select("*").eq("company_id", companyId).eq("scheme_type", "tod").order("version_number", { ascending: false });
  if (versionError) throw versionError;
  console.log("TOD VERSIONS", JSON.stringify(versions, null, 2));
  const versionId = versions?.find((version) => version.status === "active")?.id ?? versions?.[0]?.id;
  if (versionId) {
    for (const table of ["scheme_version_group_coverage", "scheme_version_stock_items", "scheme_version_stock_groups", "scheme_version_stock_group_coverage", "scheme_version_unit_conversions", "scheme_version_tiers"]) {
      const { data, error: tableError } = await database.from(table).select("*").eq("scheme_version_id", versionId);
      console.log(table, tableError ?? data);
    }
  }
}
if (process.argv.includes("--check-fanout")) {
  const { error: fanoutError } = await database.rpc("fanout_meenakshi_tod_batch_evaluation", { p_parent_run_id: "00000000-0000-4000-8000-000000000000", p_company_id: companyId, p_batch_result: {} });
  console.log("FANOUT CHECK", fanoutError?.message ?? "unexpectedly accepted test input");
}
