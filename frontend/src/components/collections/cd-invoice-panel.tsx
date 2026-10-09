"use client";

// Review one per-MT Cash Discount invoice without obscuring the decision with audit detail.
import type { Calendar } from "./types";
import { savedPostingFailure } from "@/lib/tally-status";
import { cdPaymentDisplay } from "@/lib/cd-payment-display";
import { Button, Drawer, StatusBadge, formatMoney, formatTonnes } from "./ui";
import type { CdSettlementRow } from "./cash-discount-settlements";
import styles from "./cd-invoice-panel.module.css";

type CreditNote = { status: string; amount?: string | null; verified_voucher_number: string | null; verified_at?: string | null; updated_at?: string | null; failure_reason: string | null; whatsapp?: { status: string; sentAt: string | null } | null };

const CATEGORY_LABEL: Record<string, string> = {
  full_payment: "Paid in full on time",
  discounted_payment: "Discount earned",
  over_ninety_percent: "Needs review",
  awaiting_payment: "Payment window open",
  needs_review: "Needs review",
  not_eligible: "Not eligible",
};

const day = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`);
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const longDate = (value: string | null | undefined) => value ? day(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const money = (value: number) => formatMoney(Math.round(value * 100) / 100);
const shortDay = (value: string) => day(value).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

// Exact amount for the day chips; paise only when there are any.
const exact = (value: number) => money(value).replace(/\.00$/, "");
const addDays = (value: string, count: number) => { const date = day(value); date.setDate(date.getDate() + count); return iso(date); };

/**
 * Every day from the invoice date through the last payment, capped at seven
 * days after the deadline. Payments beyond the cap are listed separately.
 * All days count; Sundays and holidays are marked.
 */
function windowDays(row: CdSettlementRow, calendar: Calendar | null, until: string) {
  const offDays = new Set(calendar?.nonWorkingWeekdays ?? [7]);
  const holidays = new Map((calendar?.holidays ?? []).filter((holiday) => holiday.is_active).map((holiday) => [holiday.holiday_date.slice(0, 10), holiday.name]));
  const days: Array<{ date: string; label: string; kind: "invoice" | "working" | "off"; count: number | null; note: string | null }> = [];
  const end = day(until);
  let count = 0;
  for (let cursor = day(row.invoiceDate); cursor <= end && days.length < 50; cursor.setDate(cursor.getDate() + 1)) {
    const date = iso(cursor);
    const weekday = cursor.getDay() || 7;
    const holiday = holidays.get(date) ?? null;
    const isInvoice = date === row.invoiceDate.slice(0, 10);
    const off = !isInvoice && (offDays.has(weekday) || Boolean(holiday));
    if (!isInvoice) count += 1;
    days.push({ date, label: cursor.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" }), kind: isInvoice ? "invoice" : off ? "off" : "working", count: isInvoice ? 0 : count, note: holiday ?? (off ? cursor.toLocaleDateString("en-IN", { weekday: "long" }) : null) });
  }
  return days;
}

export function CdInvoicePanel({ row, note, calendar, canCreate, busy, companyName, onCreate, onClose }: {
  row: CdSettlementRow | null;
  note: CreditNote | undefined;
  calendar: Calendar | null;
  canCreate: boolean;
  busy: boolean;
  companyName: string;
  onCreate: () => void;
  onClose: () => void;
}) {
  if (!row) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const bill = Number(row.invoiceAmount);
  const paid = Number(row.paidByDeadline);
  const discount = Number(row.discountAmount);
  const target = Number(row.discountedTarget);
  const credit = Number(row.creditAmount);
  const owed = Math.max(0, bill - paid);
  const deadline = row.windowDeadline.slice(0, 10);
  const settledLate = row.status === "settled_late";
  const lastPaymentDate = [...(row.payments ?? [])].map((payment) => payment.date.slice(0, 10)).sort().at(-1) ?? null;
  const timelineEnd = lastPaymentDate && lastPaymentDate > deadline ? [lastPaymentDate, addDays(deadline, 7)].sort()[0] : deadline;
  const days = windowDays(row, calendar, timelineEnd);
  const laterPayments = (row.payments ?? []).filter((payment) => payment.date.slice(0, 10) > timelineEnd);
  const paidLater = Math.max(0, Number(row.paidToDate) - paid);
  // Why the deadline moved: off days from day N up to the deadline.
  const movedFor = days.slice(row.windowWorkingDays).filter((item) => item.kind === "off" && item.date <= deadline);
  const daysAfter = (value: string) => Math.round((day(value).getTime() - day(row.invoiceDate).getTime()) / 86_400_000);
  const payments = [...(row.payments ?? [])].sort((left, right) => left.date.localeCompare(right.date));
  const { lastOnTimeDate: paidOn, settledDate } = cdPaymentDisplay(row);
  // The discount is GST-inclusive: taxable part = credit ÷ 1.18.
  const taxable = Math.round((credit / 1.18) * 100) / 100;
  const gst = Math.round((credit - taxable) * 100) / 100;

  // One line of facts, then one line of meaning.
  const facts = paid > 0
    ? `${money(paid)} paid by the deadline, ${shortDay(deadline)}.${paidOn ? ` Last on-time payment: ${shortDay(paidOn)}.` : ""}`
    : `No payment by the deadline, ${shortDay(deadline)}`;
  const result = row.status === "settled_late" ? row.reviewMessage ?? "Balance paid after the deadline. No new Credit Note applies."
    : row.category === "full_payment"
    ? credit > 0 ? "The full bill was paid on time, so the discount is earned. The Credit Note leaves a credit for the next bill." : "The full bill was paid on time. Run the Cash Discount check again to work out its Credit Note."
    : row.category === "discounted_payment"
      ? "The discounted amount was paid on time. The Credit Note closes the bill."
      : row.category === "over_ninety_percent"
        ? `Paid on time but ${money(owed)} short of the bill (within the ₹10,000 limit), not the discounted amount. Review before creating the Credit Note.`
        : row.category === "awaiting_payment"
          ? `Pay ${money(Math.max(0, target - paid))} more by ${shortDay(deadline)} to earn the ${money(discount)} discount.`
          : row.category === "needs_review"
            ? row.reviewMessage ?? "Review this invoice before creating a Credit Note."
            : "The payment was late, or short of the bill by more than ₹10,000. No discount applies.";
  const failed = note?.status === "failed"
    ? savedPostingFailure(note.failure_reason, companyName, note.updated_at)
    : null;
  const created = note?.status === "created_verified";
  const whatsapp = note?.whatsapp ?? null;
  const whatsappLabel = !whatsapp ? "Not sent on WhatsApp yet"
    : ["sent", "delivered", "read"].includes(whatsapp.status) ? `Sent on WhatsApp${whatsapp.sentAt ? ` ${shortDay(whatsapp.sentAt)}` : ""}`
    : ["queued", "sending"].includes(whatsapp.status) ? "Sending on WhatsApp…"
    : "WhatsApp not delivered";

  return <Drawer open width="wide" onClose={onClose} title={row.customerName} description={`Invoice ${row.invoiceNumber ?? "—"} · ${longDate(row.invoiceDate)}${row.customerGroup ? ` · ${row.customerGroup}` : ""}`}>
    <div className={styles.panel}>
      {/* The answer first: result, amount, the one payment fact, and the Credit Note. */}
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <StatusBadge status={row.status === "settled_late" ? "not_started" : row.category === "discounted_payment" || row.category === "full_payment" ? "ready" : row.category === "over_ninety_percent" ? "needs_review" : "not_started"}>{row.status === "settled_late" ? "Balance paid later — no new credit" : CATEGORY_LABEL[row.category] ?? row.category}</StatusBadge>
          <span className={styles.heroAmount}><small>{row.status === "settled_late" ? "Credit Note" : credit > 0 ? "Credit Note" : "Discount on offer"}</small><strong>{money(row.status === "settled_late" ? 0 : credit > 0 ? credit : discount)}</strong></span>
        </div>
        <p className={styles.heroFacts}>{facts}</p>
        {settledLate && <p className={styles.heroFacts}>{money(paidLater)} paid after the deadline{settledDate ? `; bill fully paid on ${longDate(settledDate)}` : ""}.</p>}
        <p className={styles.heroContext}>{result}</p>
        {credit > 0 && <div className={styles.noteStatus}>
          {created ? <div className={styles.noteDone}>
              <strong>Credit Note {note!.verified_voucher_number ?? "created"} · {money(Number(note!.amount ?? credit))}</strong>
              <span>{note!.verified_at ? `Created in Tally ${shortDay(note!.verified_at)}` : "Created in Tally"} · <span data-sent={Boolean(whatsapp && ["sent", "delivered", "read"].includes(whatsapp.status))}>{whatsappLabel}</span></span>
            </div>
            : note && ["queued", "sending"].includes(note.status) ? <StatusBadge status="posting">Creating in Tally…</StatusBadge>
            : row.status === "credited" ? <StatusBadge status="created_verified">Already credited in Tally</StatusBadge>
            : <span className={row.gstDeadlinePassed ? styles.warn : styles.noteHint}>{row.gstDeadlinePassed ? `GST deadline passed (${longDate(row.gstLastDate)})` : `Not created · create by ${longDate(row.gstLastDate)}`}</span>}
          {canCreate && <Button disabled={busy} onClick={onCreate}>{busy ? "Queuing…" : `Create ${money(credit)} Credit Note`}</Button>}
        </div>}
      </header>

      {failed && <section className={styles.section} aria-label="Credit Note attempt history">
        <details className={styles.details}>
          <summary>Previous posting attempt <span>Historical record</span></summary>
          <p>This is a saved earlier attempt, not the current Tally connection status.{row.status === "credited" ? " The latest calculation already recognises a credit for this invoice; do not create another note." : " Check the current connection before any new posting."}</p>
          <p>{failed}</p>
        </details>
      </section>}

      <section className={styles.section} aria-labelledby="cd-calculation">
        <h3 id="cd-calculation">Calculation</h3>
        <dl className={styles.ledger}>
          <div><dt>Invoice total</dt><dd>{money(bill)}</dd></div>
          <div><dt>{settledLate ? "Calculated discount — not applied" : "Discount"} <small>{formatTonnes(row.eligibleTonnes)} MT × ₹{Number(row.amountPerTonne).toLocaleString("en-IN")}/MT</small></dt><dd>{settledLate ? "" : "− "}{money(discount)}</dd></div>
          {settledLate ? <>
            <div><dt>Total paid</dt><dd>{money(Number(row.paidToDate))}</dd></div>
            <div className={styles.ledgerTotal}><dt>Remaining invoice balance</dt><dd>{money(Math.max(0, bill - Number(row.paidToDate)))}</dd></div>
            <div><dt>New Credit Note</dt><dd>{money(0)}</dd></div>
          </> : <div className={styles.ledgerTotal}><dt>Amount due with discount</dt><dd>{money(target)}</dd></div>}
        </dl>
        {(row.productLines?.length ?? 0) > 0 && <details className={styles.details}>
          <summary>Products counted <span>{row.productLines!.length} line{row.productLines!.length === 1 ? "" : "s"} · {formatTonnes(row.eligibleTonnes)} MT</span></summary>
          <ul className={styles.lines}>
            {row.productLines!.map((line, index) => <li key={`${line.name}-${index}`}>
              <span>{line.name}<small>{Number(line.quantity).toLocaleString("en-IN")} {line.unit}</small></span>
              <strong>{formatTonnes(line.tonnes)} MT</strong>
            </li>)}
          </ul>
        </details>}
        {credit > 0 && <details className={styles.details}>
          <summary>GST breakdown <span>Included in {money(credit)}</span></summary>
          <dl className={styles.taxRows}>
            <div><dt>Taxable value</dt><dd>{money(taxable)}</dd></div>
            <div><dt>GST 18%</dt><dd>{money(gst)}</dd></div>
            <div><dt>Total</dt><dd>{money(credit)}</dd></div>
          </dl>
        </details>}
      </section>

      <section className={styles.section} aria-labelledby="cd-payment">
        <div className={styles.sectionHeading}>
          <h3 id="cd-payment">Payment window · {row.windowWorkingDays} days</h3>
          <span>Deadline {shortDay(deadline)}{movedFor.length ? ` · moved past ${movedFor.map((item) => item.note ?? "an off day").join(", ")}` : ""}</span>
        </div>
        <ol className={styles.days} aria-label="Payments by day">
          {days.map((item) => {
            const isDeadline = item.date === deadline;
            const received = payments.filter((payment) => payment.date.slice(0, 10) === item.date);
            const after = item.date > deadline;
            const tag = item.kind === "invoice" ? "Invoice" : isDeadline ? "Deadline" : after ? "Late" : item.kind === "off" ? item.note ?? "Off" : `Day ${item.count}`;
            return <li key={item.date} data-kind={item.kind} data-deadline={isDeadline} data-after={after}>
              <span>{item.label}</span>
              <small data-off={item.kind === "off" && !isDeadline}>{tag}</small>
              {received.map((payment, index) => <b key={`${payment.voucherNumber}-${index}`} className={styles.chip} data-counted={payment.counted} title={`${payment.voucherType ?? "Payment"} ${payment.voucherNumber ?? ""} · ${money(Number(payment.amount))}`}>+{exact(Number(payment.amount))}</b>)}
            </li>;
          })}
        </ol>
        {paidLater > 0 && <p className={styles.paymentMeta}><span>{money(paidLater)} paid after the deadline. Included in total paid, but not in paid-by-deadline.</span></p>}
        {laterPayments.map((payment, index) => <p className={styles.paymentMeta} key={`late-${payment.date}-${index}`}><span>{longDate(payment.date)} · {payment.voucherType ?? "Payment"} {payment.voucherNumber ?? ""} · {money(Number(payment.amount))} · after deadline</span></p>)}
        {payments.length > 0 ? <details className={styles.details}>
          <summary>Receipts <span>{payments.length} · {money(payments.reduce((sum, payment) => sum + Number(payment.amount), 0))}</span></summary>
          <ul className={styles.payments} aria-label="Payments against this invoice">
            {payments.map((payment, index) => <li key={`${payment.voucherNumber}-${payment.date}-${index}`} data-counted={payment.counted}>
              <div><strong>{payment.voucherType ?? "Payment"} {payment.voucherNumber ?? ""}</strong><small>{longDate(payment.date)} · day {daysAfter(payment.date)}</small></div>
              <div><strong>{money(Number(payment.amount))}</strong><span className={styles.verdict} data-counted={payment.counted}>{payment.counted ? "On time" : "Late"}</span></div>
            </li>)}
          </ul>
        </details> : row.paymentCount > 0
          // Results saved before payment details were kept: only the totals exist.
          ? <p className={styles.paymentMeta}><span>{row.paymentCount} payment{row.paymentCount === 1 ? "" : "s"} · {money(Number(row.paidToDate))}. Run the Cash Discount check again to see each payment on its day.</span></p>
          : <p className={styles.paymentMeta}><span>No payment against this invoice in Tally yet.</span></p>}
      </section>
    </div>
  </Drawer>;
}
