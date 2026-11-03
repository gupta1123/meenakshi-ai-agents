// Read what connectors have sent us.
//   node scripts/connector-logs.mjs                 list recent uploads
//   node scripts/connector-logs.mjs show [n|id]     print the n-th newest (default 1) or a given id
//   node scripts/connector-logs.mjs prune           delete uploads older than 30 days
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const supabase = createClient(new URL(env.SUPABASE_URL).origin, env.SUPABASE_SECRET_KEY);
const BUCKET = "connector-logs";
const ist = (value) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
const [command = "list", argument] = process.argv.slice(2);

async function recent(limit = 15) {
  const { data, error } = await supabase.from("connector_log_uploads").select("*, tally_connectors(display_name)").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

if (command === "list") {
  const rows = await recent();
  if (!rows.length) console.log("No connector logs have been sent yet.");
  rows.forEach((row, index) => console.log(`${index + 1}. ${ist(row.created_at)} IST | ${row.kind.toUpperCase().padEnd(7)} | ${row.tally_connectors?.display_name ?? row.connector_id} | v${row.bridge_version ?? "?"} | ${Math.round(row.size_bytes / 1024)} KB | ${row.reason ?? ""} | ${row.id}`));
} else if (command === "show") {
  const rows = await recent(50);
  const row = /^\d+$/.test(argument ?? "1") ? rows[Number(argument ?? 1) - 1] : rows.find((item) => item.id === argument);
  if (!row) { console.log("No such upload. Run the script without arguments to list them."); process.exit(1); }
  const { data, error } = await supabase.storage.from(BUCKET).download(row.storage_path);
  if (error) throw error;
  console.log(`# ${ist(row.created_at)} IST | ${row.kind} | ${row.tally_connectors?.display_name ?? row.connector_id} | v${row.bridge_version ?? "?"}\n`);
  console.log(gunzipSync(Buffer.from(await data.arrayBuffer())).toString("utf8"));
} else if (command === "prune") {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase.from("connector_log_uploads").select("id, storage_path").lt("created_at", cutoff);
  if (error) throw error;
  if (data.length) {
    await supabase.storage.from(BUCKET).remove(data.map((row) => row.storage_path));
    await supabase.from("connector_log_uploads").delete().in("id", data.map((row) => row.id));
  }
  console.log(`Deleted ${data.length} upload(s) older than 30 days.`);
} else {
  console.log("Use: list | show [n|id] | prune");
}
