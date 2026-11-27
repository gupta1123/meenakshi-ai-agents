import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { creditNoteDateFor } from "@/lib/year-continuation";

/** A test voucher is always this amount. It is never taken from the request. */
export const TEST_VOUCHER_AMOUNT = "1.00";
export const TEST_VOUCHER_CONFIRMATION = "create one 1 rupee test credit note and delete it";
export const TEST_VOUCHER_PREFIX = "MEENAKSHI-TEST-";

type Row = Record<string, unknown>;

/**
 * The one test the connector may run that writes to Tally: create ONE Credit Note of Rs 1 for a named
 * customer in this company, read it back, delete exactly that voucher and read back again.
 * Everything the connector needs is decided here, from the company's own masters; the browser only
 * names the customer and repeats the confirmation sentence.
 */
export async function buildVoucherTest(companyId: string, input: Record<string, unknown>) {
  if (input.confirm !== TEST_VOUCHER_CONFIRMATION) throw new Error("Confirmation sentence is missing or wrong.");
  const customerId = String(input.customerId ?? "");
  const db = createSupabaseAdminClient();
  const [company, customer, voucherType, discountLedger] = await Promise.all([
    db.from("companies").select("id, tally_company_guid, tally_company_name, tally_books_from").eq("id", companyId).maybeSingle(),
    db.from("customers").select("id, tally_ledger_guid, ledger_name, is_available").eq("company_id", companyId).eq("id", customerId).maybeSingle(),
    db.from("tally_voucher_types").select("id, tally_voucher_type_guid, name").eq("company_id", companyId).eq("is_available", true).eq("name", "Credit Note").maybeSingle(),
    db.from("tally_ledgers").select("id, tally_ledger_guid, name").eq("company_id", companyId).eq("is_available", true).ilike("name", "%(Discount)%").order("name").limit(1).maybeSingle(),
  ]);
  for (const result of [company, customer, voucherType, discountLedger]) if (result.error) throw result.error;
  const c = company.data as Row | null, cu = customer.data as Row | null, vt = voucherType.data as Row | null, dl = discountLedger.data as Row | null;
  if (!c?.tally_company_guid || !c.tally_company_name || !c.tally_books_from) throw new Error("This company has no Tally identity or financial year recorded.");
  if (!cu?.tally_ledger_guid || !cu.ledger_name || cu.is_available === false) throw new Error("Customer ledger not found in this company.");
  if (!vt?.tally_voucher_type_guid) throw new Error("This company has no 'Credit Note' voucher type synced.");
  if (!dl?.tally_ledger_guid) throw new Error("This company has no '(Discount)' ledger synced to post the test against.");
  const reference = `${TEST_VOUCHER_PREFIX}${randomUUID().slice(0, 8).toUpperCase()}`;
  const creditNote = {
    company: { guid: c.tally_company_guid, name: c.tally_company_name },
    voucherType: { guid: vt.tally_voucher_type_guid, name: vt.name },
    party: { guid: cu.tally_ledger_guid, name: cu.ledger_name },
    creditNoteDate: creditNoteDateFor(String(c.tally_books_from)),
    amount: TEST_VOUCHER_AMOUNT,
    calculationReference: reference,
    allocation: { type: "on_account", reference },
    gstTreatment: "commercial_no_gst",
    sourceSalesLedgers: [{ id: dl.id, guid: dl.tally_ledger_guid, name: dl.name, amount: TEST_VOUCHER_AMOUNT }],
  };
  return { type: "voucher_test", creditNote, testReference: reference };
}
