"use client";

import { useState } from "react";

import { apiRequest, jsonBody } from "@/lib/api";
import { staffStatusLabel } from "@/lib/staff-status";

type Proposal = {
  id: string;
  scheme_type: "cd" | "tod";
  status: string;
  period_start: string | null;
  period_end: string | null;
  eligibility_deadline: string | null;
  calculated_discount_amount: string;
  reason_codes: string[];
  latestEvaluation: { id: string; evaluated_at: string; freshForApproval: boolean } | null;
  creditNotePosting: { id: string; status: string; discount_amount: string; credit_note_date: string; verified_voucher_number: string | null; verified_at: string | null; failure_reason: string | null; document?: { available: boolean; status: string } | null } | null;
};

type Props = {
  proposal: Proposal;
  token: string;
  base: string;
  canApprove: boolean;
  canRetry: boolean;
  launchMode: "review_only" | "posting_enabled";
  onRefresh: () => Promise<void>;
  onNotice: (value: string | null) => void;
  onError: (value: string | null) => void;
};

export function ProposalReviewCard({ proposal, token, base, canApprove, canRetry, launchMode, onRefresh, onNotice, onError }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const posting = proposal.creditNotePosting;

  async function run(path: string, body: Record<string, unknown>, message: string) {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      await apiRequest(token, path, { method: "POST", body: jsonBody(body) });
      onNotice(message);
      setReason("");
      await onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Review request failed.");
    } finally {
      setBusy(false);
    }
  }

  return <article className="review-card">
    <header>
      <div>
        <p className="card-label">{proposal.scheme_type.toUpperCase()} proposal</p>
        <h3>{proposal.period_start && proposal.period_end ? `${proposal.period_start} to ${proposal.period_end}` : "Invoice-level entitlement"}</h3>
        <p className="muted">Status: {staffStatusLabel(proposal.status)}{proposal.eligibility_deadline ? ` · deadline ${proposal.eligibility_deadline}` : ""}</p>
      </div>
      <strong className="review-amount">₹ {proposal.calculated_discount_amount}</strong>
    </header>
    <div className="review-details">
      <span>Latest evaluation: {proposal.latestEvaluation ? new Date(proposal.latestEvaluation.evaluated_at).toLocaleString() : "missing"}</span>
      <span>Fresh for approval: {proposal.latestEvaluation?.freshForApproval ? "yes" : "no — queue a live refresh"}</span>
      <span>Reasons: {proposal.reason_codes.length ? proposal.reason_codes.join(", ") : "none"}</span>
    </div>
    {posting ? <div className="posting-summary">
      <strong>Credit Note: {staffStatusLabel(posting.status)}</strong>
      <span>{posting.verified_voucher_number ? `Tally ${posting.verified_voucher_number}` : posting.failure_reason ?? "Awaiting bridge result"}</span>
      {posting.document?.available && <span>PDF verified</span>}
      {(posting.status === "failed" || posting.status === "correction_required") && canRetry && <>
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for audited retry" />
        <button disabled={busy || !reason.trim() || launchMode !== "posting_enabled"} onClick={() => void run(`${base}/credit-notes/${posting.id}/retry`, { reason }, "Credit Note retry queued.")}>Retry safely</button>
        {launchMode !== "posting_enabled" && <small className="muted">Posting is not enabled for this company. Retry remains blocked until Finance reconciliation is recorded.</small>}
      </>}
    </div> : <div className="review-actions">
      {canApprove ? <>
        <button className="secondary" disabled={busy || proposal.status !== "eligible"} onClick={() => void run(`${base}/evaluations/proposals/${proposal.id}/refresh`, {}, "Live Tally refresh queued. Wait for it to complete, refresh this queue, then approve within 15 minutes.")}>Refresh live evidence</button>
        <button disabled={busy || !proposal.latestEvaluation?.freshForApproval || proposal.status !== "eligible" || launchMode !== "posting_enabled"} onClick={() => void run(`${base}/evaluations/proposals/${proposal.id}/review`, { decision: "approve" }, "Finance approval recorded; Credit Note was queued for Tally.")}>Approve and queue Credit Note</button>
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required rejection reason" />
        <button className="secondary" disabled={busy || !proposal.latestEvaluation || !reason.trim()} onClick={() => void run(`${base}/evaluations/proposals/${proposal.id}/review`, { decision: "reject", proposalEvaluationId: proposal.latestEvaluation?.id, reason }, "Proposal rejected and returned for review.")}>Reject proposal</button>
        {launchMode !== "posting_enabled" && <small className="muted">Review-only mode permits evidence refresh and rejection, but blocks Credit Note approval and Tally retry.</small>}
      </> : <p className="muted">Only a Finance Approver can approve or reject a proposal.</p>}
    </div>}
  </article>;
}
