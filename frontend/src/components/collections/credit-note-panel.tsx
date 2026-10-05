"use client";

// One Credit Note, whichever scheme created it: what it is, why it was given,
// its amount split, the PDF, WhatsApp history, and a link to its calculation.
import { useEffect, useState } from "react";
import { Download, FileText, Send } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { readLocalNoteEInvoice } from "@/lib/local-tally";
import { userFacingError } from "@/lib/user-copy";

import { Button, Drawer, StatusBadge, formatDate, formatMoney } from "./ui";
import { accessToken } from "./workspace";
import { useCompany } from "./company-context";
import styles from "./cd-invoice-panel.module.css";

export type CreditNoteMessage = { status: string; at: string | null; recipient: string | null; failureReason: string | null };
export type CreditNotePanelNote = {
  scheme: "tod" | "cd";
  postingId: string;
  customer: string;
  amount: number;
  voucherNumber: string | null;
  status: string;
  noteDate: string | null;
  why: string | null;
  problem: string | null;
  fix: string | null;
  /** Cash Discount Credit Notes include 18% GST in the amount. */
  gstInclusive: boolean;
  messages: CreditNoteMessage[];
};

const SENT = ["sent", "delivered", "read", "whatsapp_sent"];
const day = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const messageLabel = (status: string) => status === "read" ? "Read" : status === "delivered" ? "Delivered" : SENT.includes(status) ? "Sent" : ["queued", "sending"].includes(status) ? "Sending…" : status === "suppressed" ? "Not sent" : status === "cancelled" ? "Cancelled" : "Failed";

export function CreditNotePanel({ note, companyId, onClose, onSend, onOpenCalculation, calculationLabel }: {
  note: CreditNotePanelNote | null;
  companyId: string;
  onClose: () => void;
  onSend: () => void;
  onOpenCalculation: (() => void) | null;
  calculationLabel: string;
}) {
  const { company } = useCompany();
  const [pdf, setPdf] = useState<{ state: "idle" | "loading" | "ready" | "error"; url?: string; error?: string }>({ state: "idle" });
  // e-Invoice read from Tally for this note: IRN shown, "none" = not e-invoiced yet, text = could not read.
  const [einvoice, setEinvoice] = useState<{ irn: string; ackNo: string } | "none" | string | null>(null);
  useEffect(() => { setPdf({ state: "idle" }); setEinvoice(null); }, [note?.postingId]);
  // Signed links expire after a few minutes; keep the PDF in the browser instead.
  useEffect(() => () => { if (pdf.url?.startsWith("blob:")) URL.revokeObjectURL(pdf.url); }, [pdf.url]);
  async function keepLocal(signedUrl: string) {
    const response = await fetch(signedUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not download the PDF. Try again.");
    return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: "application/pdf" }));
  }
  if (!note) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const created = note.status === "created_verified";
  const taxable = Math.round((note.amount / 1.18) * 100) / 100;
  const gst = Math.round((note.amount - taxable) * 100) / 100;

  // The PDF is read back from Tally on request, then shown here.
  async function loadPdf() {
    if (!note) return;
    setPdf({ state: "loading" });
    try {
      const token = await accessToken(); if (!token) return;
      // Print the IRN and QR like Tally: read them first (one company, one day in Tally).
      if (note.voucherNumber && note.noteDate) {
        try {
          const found = await readLocalNoteEInvoice({ expectedCompany: { guid: company.tally_company_guid, name: company.tally_company_name }, date: note.noteDate.slice(0, 10), voucherNumber: note.voucherNumber, kind: "credit" });
          if (found) {
            await apiRequest(token, `/api/companies/${companyId}/notes/einvoice`, { method: "POST", body: jsonBody({ source: note.scheme === "tod" ? "tod_credit_note" : "cash_discount_note", postingId: note.postingId, ...found }) });
            setEinvoice({ irn: found.irn, ackNo: found.ackNo });
          } else setEinvoice("none");
        } catch (cause) {
          setEinvoice(userFacingError(cause, "Tally could not be reached"));
        }
      }
      if (note.scheme === "cd") {
        const result = await apiRequest<{ downloadUrl: string }>(token, `/api/companies/${companyId}/debit-notes/${note.postingId}/document`, { method: "POST", timeoutMs: 120_000 });
        setPdf({ state: "ready", url: await keepLocal(result.downloadUrl) });
        return;
      }
      await apiRequest(token, `/api/companies/${companyId}/credit-notes/${note.postingId}/pdf`, { method: "POST", timeoutMs: 120_000 });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await apiRequest<{ document: { downloadUrl?: string | null; status?: string } | null }>(token, `/api/companies/${companyId}/credit-notes/${note.postingId}/document`, { cache: "no-store" });
        if (result.document?.downloadUrl) { setPdf({ state: "ready", url: await keepLocal(result.document.downloadUrl) }); return; }
        if (result.document?.status === "failed") break;
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      }
      setPdf({ state: "error", error: "The PDF is not ready yet. Keep Tally open and try again." });
    } catch (cause) {
      setPdf({ state: "error", error: userFacingError(cause, "Could not get the PDF from Tally. Keep Tally open and try again.") });
    }
  }

  return <Drawer open width="wide" onClose={onClose} title={note.customer} description={`${note.scheme === "tod" ? "Turnover Discount" : "Cash Discount"} Credit Note${note.voucherNumber ? ` ${note.voucherNumber}` : ""}${note.noteDate ? ` · ${day(note.noteDate)}` : ""}`}>
    <div className={styles.panel}>
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <StatusBadge status={created ? "created_verified" : note.problem ? "failed" : "posting"}>{created ? `CN ${note.voucherNumber ?? "created"}` : note.problem ? "Not created in Tally" : "Creating in Tally…"}</StatusBadge>
          <span className={styles.heroAmount}><small>Credit Note</small><strong>{formatMoney(note.amount)}</strong></span>
        </div>
        {note.why && <p className={styles.heroFacts}>{note.why}</p>}
        {note.problem && <p className={styles.error}>{note.problem}{note.fix ? ` ${note.fix}` : ""}</p>}
        {onOpenCalculation && <div className={styles.noteStatus}><span className={styles.noteHint}>How this amount was worked out</span><Button className="button-secondary" onClick={onOpenCalculation}>{calculationLabel}</Button></div>}
      </header>

      <section className={styles.section} aria-labelledby="cn-amount">
        <h3 id="cn-amount">Amount</h3>
        <dl className={styles.ledger}>
          {note.gstInclusive ? <>
            <div><dt>Taxable value</dt><dd>{formatMoney(taxable)}</dd></div>
            <div><dt>GST 18%</dt><dd>{formatMoney(gst)}</dd></div>
          </> : null}
          <div className={styles.ledgerTotal}><dt>Credit Note total</dt><dd>{formatMoney(note.amount)}</dd></div>
        </dl>
        {created && <p className={styles.paymentMeta}><span>Created in Tally as No. {note.voucherNumber ?? "—"}{note.noteDate ? ` on ${day(note.noteDate)}` : ""}.</span></p>}
      </section>

      {created && <section className={styles.section} aria-labelledby="cn-pdf">
        <div className={styles.sectionHeading}><h3 id="cn-pdf">Document</h3><span>Same layout as Tally's print</span></div>
        {/* A failed read is not shown: the PDF simply prints without the e-Invoice block. */}
        {einvoice && (typeof einvoice === "object" || einvoice === "none") && <p className={styles.paymentMeta}>{typeof einvoice === "object" ? <span>e-Invoice: IRN {einvoice.irn.slice(0, 16)}… · Ack No. {einvoice.ackNo}, printed with its QR code.</span>
          : einvoice === "none" ? <span>Not e-invoiced in Tally yet, so the PDF has no IRN or QR. Generate the e-Invoice in Tally, then show the PDF again.</span>
          : null}</p>}
        {pdf.state === "ready" && pdf.url ? <>
          <iframe className={styles.pdfFrame} src={pdf.url} title={`Credit Note ${note.voucherNumber ?? ""} PDF`} />
          <a className="button button-secondary" href={pdf.url} download={`Credit-Note-${note.voucherNumber ?? "document"}.pdf`}><Download size={14} />Download PDF</a>
        </> : <div className={styles.noteStatus}>
          <span className={pdf.state === "error" ? styles.warn : styles.noteHint}>{pdf.state === "error" ? pdf.error : "See the Credit Note exactly as the customer receives it."}</span>
          <Button className="button-secondary" disabled={pdf.state === "loading"} onClick={() => void loadPdf()}><FileText size={14} />{pdf.state === "loading" ? "Getting PDF from Tally…" : "Show PDF"}</Button>
        </div>}
      </section>}

      <section className={styles.section} aria-labelledby="cn-whatsapp">
        <div className={styles.sectionHeading}><h3 id="cn-whatsapp">WhatsApp</h3>{created && <Button className="button-secondary" onClick={onSend}><Send size={14} />{note.messages.length ? "Send again" : "Send"}</Button>}</div>
        {!created ? <p className={styles.paymentMeta}><span>Can be sent once the Credit Note is created in Tally.</span></p>
          : note.messages.length ? <ul className={styles.payments} aria-label="WhatsApp messages">
            {note.messages.map((message, index) => <li key={`${message.at}-${index}`} data-counted={SENT.includes(message.status) || ["queued", "sending"].includes(message.status)}>
              <div><strong>{message.recipient ?? "Number unavailable"}</strong><small>{message.at ? formatDate(message.at) : "Not sent yet"}{message.failureReason && !SENT.includes(message.status) ? ` · ${message.failureReason}` : ""}</small></div>
              <div><span className={styles.verdict} data-counted={SENT.includes(message.status) || ["queued", "sending"].includes(message.status)}>{messageLabel(message.status)}</span></div>
            </li>)}
          </ul>
          : <p className={styles.paymentMeta}><span>Not sent to the customer yet.</span></p>}
      </section>
    </div>
  </Drawer>;
}
