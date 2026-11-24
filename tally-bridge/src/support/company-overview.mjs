// Read-only support check: how many vouchers each month of whichever company is
// open in Tally holds. It reads no amounts, parties or ledgers (only the date of
// each voucher), in small windows with a pause between them. It does not need the
// open company to be the linked one, because it exists to find out what an open
// company contains.
import { recordRuntimeRead } from "../runtime-status.mjs";
import { buildCollectionExportXml, extractBlocks, getTagText, postTallyXml } from "../tally/xml.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_DAYS = 10;
const MAX_MONTHS = 36;
const addDays = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function validateCompanyOverview(input) {
  if (!DATE.test(String(input?.dateFrom)) || !DATE.test(String(input?.dateTo)) || input.dateFrom > input.dateTo)
    throw new Error("A valid date range is required.");
  const months = (Number(input.dateTo.slice(0, 4)) - Number(input.dateFrom.slice(0, 4))) * 12 + Number(input.dateTo.slice(5, 7)) - Number(input.dateFrom.slice(5, 7)) + 1;
  if (months > MAX_MONTHS) throw new Error(`Choose at most ${MAX_MONTHS} months.`);
  return { dateFrom: input.dateFrom, dateTo: input.dateTo, pauseMs: Math.max(1000, Math.min(10000, Number(input.pauseMs) || 2000)) };
}

export async function runCompanyOverview(input, context, deps = {}) {
  const request = validateCompanyOverview(input);
  const post = deps.post ?? postTallyXml;
  const pause = deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const counts = new Map();
  let windows = 0;
  for (let from = request.dateFrom; from <= request.dateTo; from = addDays(from, WINDOW_DAYS)) {
    if (context.isCancelled?.()) throw new Error("Company check stopped.");
    if (windows > 0) await pause(request.pauseMs);
    const to = addDays(from, WINDOW_DAYS - 1) > request.dateTo ? request.dateTo : addDays(from, WINDOW_DAYS - 1);
    const xml = buildCollectionExportXml({
      collectionName: "Meenakshi Support Voucher Dates", tallyType: "Voucher", fetchFields: "Date",
      companyName: context.activeCompany.name, dateFrom: from, dateTo: to,
    });
    const response = await post(context.config.tallyUrl, xml, { timeoutMs: 30_000, operation: "Count vouchers in a small window" });
    recordRuntimeRead();
    windows += 1;
    for (const block of extractBlocks(response, "VOUCHER")) {
      const date = getTagText(block, "DATE") ?? "";
      if (!/^\d{8}$/.test(date)) continue;
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      if (iso < from || iso > to) continue;
      counts.set(iso.slice(0, 7), (counts.get(iso.slice(0, 7)) ?? 0) + 1);
    }
    context.onProgress?.({ stage: "counting", done: windows });
  }
  const months = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, vouchers]) => ({ month, vouchers }));
  return {
    type: "company_overview",
    company: { name: context.activeCompany.name, guid: context.activeCompany.guid },
    dateFrom: request.dateFrom, dateTo: request.dateTo, windows,
    totalVouchers: months.reduce((sum, row) => sum + row.vouchers, 0),
    months,
  };
}
