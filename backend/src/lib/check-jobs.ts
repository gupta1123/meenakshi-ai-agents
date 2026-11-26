import { createHash } from "node:crypto";
import { sameTallyCompany } from "@/lib/tally-company-identity";

/**
 * Pure helpers for server-mode check jobs (Cash Discount / Turnover Discount /
 * e-invoice reads queued for a Tally server connector). No database imports so
 * they can be unit tested.
 */

export const CHECK_JOB_KINDS = ["cd", "tod", "einvoice"] as const;
export type CheckJobKind = (typeof CHECK_JOB_KINDS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_PART = /^[A-Za-z0-9_.:-]{1,80}$/;

export class CheckJobRequestError extends Error {
  readonly status = 400;
}

export type CheckJobInput = { kind: CheckJobKind; scopeKey: string; request: Record<string, unknown> };

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function calculationJob(kind: "cd" | "tod", request: Record<string, unknown>): CheckJobInput {
  return { kind, scopeKey: `${kind}:${createHash("sha256").update(canonical(request)).digest("hex")}`, request };
}

export function isCheckJobKind(value: unknown): value is CheckJobKind {
  return typeof value === "string" && (CHECK_JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Turns the browser's body into a job. The scope key identifies "the same
 * request" so a second person asking for it joins the running one:
 *   cd:<schemeVersionId|all>       tod:<periodStart>:<periodEnd>[:<schemeVersionId>]
 *   einvoice:<credit|debit>:<date>:<voucherNumber>
 */
export function buildCheckJobInput(body: unknown): CheckJobInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!isCheckJobKind(b.kind)) throw new CheckJobRequestError("kind must be cd, tod or einvoice.");
  const part = (name: string, optional = false): string | null => {
    const v = b[name];
    if (v === undefined || v === null || v === "") {
      if (optional) return null;
      throw new CheckJobRequestError(`${name} is required.`);
    }
    if (typeof v !== "string" || !KEY_PART.test(v)) throw new CheckJobRequestError(`${name} is not valid.`);
    return v;
  };
  const date = (name: string): string => {
    const v = part(name)!;
    if (!DATE.test(v) || Number.isNaN(Date.parse(v))) throw new CheckJobRequestError(`${name} must be a date (YYYY-MM-DD).`);
    return v;
  };
  // The calculation input the page already builds for a PC connector (rule, dates, voucher scope, Tally company).
  const calculationBody = (): Record<string, unknown> => {
    const v = b.body;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new CheckJobRequestError("body is required.");
    if (JSON.stringify(v).length > MAX_BODY_BYTES) throw new CheckJobRequestError("body is too large.");
    return v as Record<string, unknown>;
  };
  // save: the server saves the result itself when the check finishes, so the
  // check completes even if the page is closed. TOD needs the as-of date it is saved under.
  if (b.kind === "cd") {
    const schemeVersionId = part("schemeVersionId", true);
    const save = b.save === true ? {} : null;
    return calculationJob("cd", { schemeVersionId, save, body: calculationBody() });
  }
  if (b.kind === "tod") {
    const periodStart = date("periodStart");
    const periodEnd = date("periodEnd");
    if (periodEnd < periodStart) throw new CheckJobRequestError("periodEnd must not be before periodStart.");
    const schemeVersionId = part("schemeVersionId", true);
    const save = b.saveAsOfDate === undefined || b.saveAsOfDate === null ? null : { asOfDate: date("saveAsOfDate") };
    return calculationJob("tod", { periodStart, periodEnd, schemeVersionId, save, body: calculationBody() });
  }
  // One note's e-invoice details (IRN, Ack, signed QR), read from Tally by the server connector.
  const noteKind = b.noteKind === "credit" || b.noteKind === "debit" ? b.noteKind : null;
  if (!noteKind) throw new CheckJobRequestError("noteKind must be credit or debit.");
  const noteDate = date("date");
  const voucherNumber = typeof b.voucherNumber === "string" ? b.voucherNumber.trim() : "";
  if (!voucherNumber || voucherNumber.length > 80 || /[\u0000-\u001f]/.test(voucherNumber)) throw new CheckJobRequestError("voucherNumber is not valid.");
  return { kind: "einvoice", scopeKey: `einvoice:${noteKind}:${noteDate}:${voucherNumber}`, request: { noteKind, date: noteDate, voucherNumber } };
}

/** Plain-language status for the page. */
export function describeJobStatus(status: string, queuePosition: number): string {
  switch (status) {
    case "queued": return queuePosition > 0 ? `Waiting — ${queuePosition} check${queuePosition === 1 ? "" : "s"} ahead.` : "Waiting for the Tally server.";
    case "running": return "Running on the Tally server.";
    case "succeeded": return "Finished.";
    case "cancelled": return "Stopped.";
    case "expired": return "Nobody picked this up in time. Start it again.";
    default: return "Failed.";
  }
}

export type ServerReadiness = "ready" | "connector_offline" | "tally_closed" | "company_not_open" | "wrong_company";

/**
 * Why a Tally server cannot take checks right now, in words for staff.
 * "Offline" = the connector program is not reporting (server off, rebooting, task stopped).
 * After a reboot someone must open Tally by hand, so the other cases are expected and common.
 */
export type OpenTallyCompany = { guid: string | null; name: string | null; booksFrom?: string | null };

export function describeServerReadiness(input: {
  lastSeenAt: string | null; tallyReachable: boolean | null; companyLoaded: boolean | null;
  activeCompanyName: string | null; expectedCompanyName: string | null; now?: number;
  /** Every company open on the server (a server can have several, e.g. one per financial year). */
  openCompanies?: OpenTallyCompany[];
  /** The linked company, with its Tally ID and financial year. */
  expectedCompany?: OpenTallyCompany;
}): { state: ServerReadiness; message: string | null } {
  const now = input.now ?? Date.now();
  if (!input.lastSeenAt || now - Date.parse(input.lastSeenAt) > 90_000) {
    return { state: "connector_offline", message: "The Tally server is not responding. Ask the person who looks after the server to check that it is on and the Meenakshi connector is running." };
  }
  if (input.tallyReachable === false) {
    return { state: "tally_closed", message: "Tally is not open on the server. Ask the person who looks after the server to open Tally Prime." };
  }
  if (input.openCompanies && input.expectedCompany?.guid && input.openCompanies.length > 0) {
    // The server may hold several companies at once; the linked one just has to be among them.
    if (input.openCompanies.some((open) => sameTallyCompany(input.expectedCompany!, open))) return { state: "ready", message: null };
    const names = input.openCompanies.map((open) => open.name).filter(Boolean).join(", ");
    const wanted = input.expectedCompanyName ?? input.expectedCompany.name ?? "the company";
    return { state: "wrong_company", message: `Tally on the server has ${names} open, but this needs ${wanted}. Ask them to open ${wanted}.` };
  }
  if (input.companyLoaded === false || !input.activeCompanyName) {
    return { state: "company_not_open", message: `Tally is open on the server but ${input.expectedCompanyName ?? "the company"} is not loaded. Ask them to open that company in Tally Prime.` };
  }
  if (input.expectedCompanyName && input.activeCompanyName.trim().toLowerCase() !== input.expectedCompanyName.trim().toLowerCase()) {
    return { state: "wrong_company", message: `Tally on the server has "${input.activeCompanyName}" open, but this needs ${input.expectedCompanyName}. Ask them to open ${input.expectedCompanyName}.` };
  }
  return { state: "ready", message: null };
}
