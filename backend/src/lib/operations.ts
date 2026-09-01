export type OperationsAlert = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  nextAction: string;
  createdAt: string;
  correlationId: string | null;
  detailTarget: { correlationId?: string; entityType?: string; entityId?: string };
};

export function countByStatus(rows: Array<{ status: string }>, statuses: string[]) {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<string, number>;
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

export function safeOperationalText(value: string | null | undefined, maxLength = 500) {
  if (!value) return null;
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (/<\/?[a-z][^>]*>/i.test(compact)) {
    return "Technical payload redacted. Open the protected server logs if an administrator needs further investigation.";
  }
  return compact
    .replace(/(?:bearer\s+|api[_ -]?key[=:]\s*|auth(?:orization)?[=:]\s*|authkey[=:]\s*|token[=:]\s*|secret[=:]\s*|password[=:]\s*)[^\s,;]+/gi, "[redacted credential]")
    .slice(0, maxLength);
}

export function safeOperationalSummary(input: { action?: string | null; status?: string | null; failureReason?: string | null }) {
  const failure = safeOperationalText(input.failureReason);
  if (failure) return failure;
  const action = input.action?.replace(/[_-]+/g, " ").trim();
  const status = input.status?.replace(/[_-]+/g, " ").trim();
  return [action, status].filter(Boolean).join(" · ") || "Operational activity recorded.";
}

export function buildOperationsAlerts(input: {
  now: string;
  tally: { status: string; lastMismatchAt?: string | null };
  outbox: { failed: number; deadLetter: number; oldestFailure?: { id: string; correlationId: string | null; createdAt: string; lastError: string | null } | null };
  commands: { failed: number; deadLetter: number; oldestFailure?: { id: string; correlationId: string | null; createdAt: string; failureReason: string | null } | null };
  messages: { retrying: number; terminalFailures: number };
  missingConfiguration: string[];
  staleProposalCount: number;
  launchMode: "review_only" | "posting_enabled";
}): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  const add = (alert: Omit<OperationsAlert, "id"> & { id: string }) => alerts.push(alert);
  if (input.tally.status === "company_mismatch") {
    add({ id: "tally-company-mismatch", severity: "critical", title: "Tally is bound to a different company", message: "Credit Note commands remain protected from the wrong Tally company.", nextAction: "Open Tally readiness and correct the company binding.", createdAt: input.tally.lastMismatchAt ?? input.now, correlationId: null, detailTarget: {} });
  } else if (input.tally.status !== "ready") {
    add({ id: `tally-${input.tally.status}`, severity: "warning", title: "Tally is not ready", message: "Bridge or synchronization readiness needs attention before any posting is enabled.", nextAction: "Check the connector heartbeat and run the required synchronization.", createdAt: input.now, correlationId: null, detailTarget: {} });
  }
  if (input.outbox.deadLetter > 0 || input.commands.deadLetter > 0) {
    const failure = input.outbox.oldestFailure ?? input.commands.oldestFailure ?? null;
    add({ id: "dead-letter-work", severity: "critical", title: "Dead-letter work needs review", message: `${input.outbox.deadLetter + input.commands.deadLetter} durable outbox or bridge command item(s) need an administrator review.`, nextAction: "Open the protected operational detail and resolve the recorded failure.", createdAt: failure?.createdAt ?? input.now, correlationId: failure?.correlationId ?? null, detailTarget: failure?.correlationId ? { correlationId: failure.correlationId } : { entityType: "integration_outbox", entityId: failure?.id } });
  } else if (input.outbox.failed > 0 || input.commands.failed > 0) {
    const failure = input.outbox.oldestFailure ?? input.commands.oldestFailure ?? null;
    add({ id: "retrying-durable-work", severity: "warning", title: "Durable work is retrying", message: `${input.outbox.failed + input.commands.failed} outbox or bridge command item(s) are waiting for retry.`, nextAction: "Confirm Tally readiness, then monitor the retry rather than sending a duplicate request.", createdAt: failure?.createdAt ?? input.now, correlationId: failure?.correlationId ?? null, detailTarget: failure?.correlationId ? { correlationId: failure.correlationId } : { entityType: "integration_outbox", entityId: failure?.id } });
  }
  if (input.messages.terminalFailures > 0) {
    add({ id: "terminal-message-failures", severity: "warning", title: "WhatsApp messages need follow-up", message: `${input.messages.terminalFailures} message(s) reached a terminal delivery failure.`, nextAction: "Review the authorized message history before deciding whether a separately audited resend is appropriate.", createdAt: input.now, correlationId: null, detailTarget: { entityType: "notification_message" } });
  } else if (input.messages.retrying > 0) {
    add({ id: "retrying-messages", severity: "info", title: "WhatsApp messages are retrying", message: `${input.messages.retrying} message(s) are waiting for a safe retry.`, nextAction: "Keep the notification worker running and monitor delivery history.", createdAt: input.now, correlationId: null, detailTarget: { entityType: "notification_message" } });
  }
  if (input.staleProposalCount > 0) {
    add({ id: "review-invalidated-proposals", severity: "warning", title: "Proposals need a fresh review", message: `${input.staleProposalCount} proposal(s) are marked as needing review or have invalidated evidence.`, nextAction: "Refresh Tally evidence and complete the Finance review before approval.", createdAt: input.now, correlationId: null, detailTarget: { entityType: "discount_proposal" } });
  }
  if (input.missingConfiguration.length > 0) {
    add({ id: "missing-configuration", severity: "warning", title: "Configuration is incomplete", message: `Missing: ${input.missingConfiguration.join(", ")}.`, nextAction: "An administrator should complete the Rulebook configuration before relying on the affected workflow.", createdAt: input.now, correlationId: null, detailTarget: {} });
  }
  if (input.launchMode === "review_only") {
    add({ id: "review-only", severity: "info", title: "Review-only mode is active", message: "Evaluations, evidence refresh, Finance review, messages, and reconciliation remain available; Tally Credit Note posting is disabled.", nextAction: "Record and sign off the selected-period Finance reconciliation before enabling posting.", createdAt: input.now, correlationId: null, detailTarget: { entityType: "company_launch_control" } });
  }
  return alerts;
}
