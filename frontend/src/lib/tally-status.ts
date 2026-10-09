// A pending/failed status read is not evidence that the connector is offline.
export function tallyConnectionStatus(health: { status: string } | null, error: string | null = null) {
  return error ? "connection_check_failed" : health?.status ?? "checking";
}

export function tallyConnectionView(status: string) {
  if (status === "checking") return { connected: false, tone: "busy", title: "Checking Tally connection…", sub: "Waiting for connection status" };
  if (status === "connection_check_failed") return { connected: false, tone: "warn", title: "Could not check Tally", sub: "Refresh connection status" };
  if (status === "ready") return { connected: true, tone: "ok", title: "Tally connected", sub: "" };
  return { connected: false, tone: "bad", title: status === "company_mismatch" ? "Other company open in Tally" : "Tally not connected", sub: "Open Tally and the connector" };
}

export function savedPostingFailure(reason: string | null, companyName: string, failedAt?: string | null) {
  const date = failedAt ? new Date(failedAt) : null;
  const when = date && Number.isFinite(date.getTime())
    ? ` (${date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })})`
    : "";
  const prefix = `Previous Credit Note attempt failed${when}`;
  if (/active Tally company does not match/i.test(reason ?? "")) {
    return `${prefix}: a different company was active in Tally. Check the current connection and confirm ${companyName} is open before any new attempt.`;
  }
  return `${prefix}: ${reason ?? "Tally could not confirm this Credit Note."}`;
}
