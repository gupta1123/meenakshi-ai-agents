"use client";

import { ExternalLink, FileCheck2 } from "lucide-react";

import type { CreditNotePosting } from "./types";
import { Dialog, formatDate, formatMoney, StatusBadge } from "./ui";

export function VerifiedCreditNoteDocument({ open, downloadUrl, posting, onClose }: { open: boolean; downloadUrl: string | null; posting: CreditNotePosting | null; onClose: () => void }) {
  if (!posting || !downloadUrl) return null;
  return <Dialog open={open} onClose={onClose} width="wide" title="Credit Note PDF" description="PDF linked to a Credit Note verified in Tally.">
    <div className="verified-document">
      <div className="verified-document-summary">
        <div className="verified-document-icon"><FileCheck2 size={19} /></div>
        <div><StatusBadge status="verified" /><strong>Voucher {posting.verified_voucher_number ?? "verified"}</strong><small>{formatMoney(posting.verified_amount ?? posting.discount_amount)} · verified {formatDate(posting.verified_at)}</small></div>
      </div>
      <div className="pdf-frame"><iframe src={downloadUrl} title={`Verified Tally Credit Note voucher ${posting.verified_voucher_number ?? ""}`} /></div>
      <div className="verified-document-footer"><p>App-generated copies are labelled inside the PDF; they are not TallyPrime’s native printout.</p><a className="button button-secondary" href={downloadUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open in a new tab</a></div>
    </div>
  </Dialog>;
}
