export function postingProgress(note, command) {
  if (!["queued", "sending"].includes(note.status)) return null;
  if (command?.status === "sending") {
    // CD imports and read-back verification are one connector command. Do not
    // invent a separate stage that the installed connector does not report.
    const verifying = command.command_type === "verify_credit_note";
    return { stage: verifying ? "verifying" : "creating", label: verifying ? "Verifying in Tally…" : "Creating and verifying…", queuedAt: note.created_at, startedAt: command.locked_at ?? null };
  }
  return { stage: "queued", label: "Waiting for Tally…", queuedAt: note.created_at, startedAt: null };
}
