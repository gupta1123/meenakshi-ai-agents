export type CashDiscountNarrationTerms = {
  mentioned: boolean;
  percentage: number | null;
  allowedDays: number | null;
  dayType: "working_days" | "calendar_days" | "unspecified" | null;
  confidence: "none" | "partial" | "high";
  sourceText: string;
};

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function parseCashDiscountNarration(value: unknown): CashDiscountNarrationTerms {
  const sourceText = normalized(typeof value === "string" ? value : "");
  if (!sourceText) return { mentioned: false, percentage: null, allowedDays: null, dayType: null, confidence: "none", sourceText };

  const mentioned = /\bcash\s*discount\b|\bc\s*\.?\s*d\s*\.?\b/i.test(sourceText);
  if (!mentioned) return { mentioned: false, percentage: null, allowedDays: null, dayType: null, confidence: "none", sourceText };

  const percentageMatch = sourceText.match(/(\d+(?:\.\d+)?)\s*%/i);
  const daysMatch = sourceText.match(/(?:within|in|before|upto|up\s*to)\s*(\d{1,3})\s*(working|business|calendar)?\s*days?/i)
    ?? sourceText.match(/(\d{1,3})\s*(working|business|calendar)?\s*days?\s*(?:cash\s*discount|c\s*\.?\s*d\s*\.?)/i);
  const dayWord = daysMatch?.[2]?.toLowerCase();
  const dayType = !daysMatch
    ? null
    : dayWord === "working" || dayWord === "business"
      ? "working_days"
      : dayWord === "calendar"
        ? "calendar_days"
        : "unspecified";
  const percentage = percentageMatch ? Number(percentageMatch[1]) : null;
  const allowedDays = daysMatch ? Number(daysMatch[1]) : null;

  return {
    mentioned,
    percentage: Number.isFinite(percentage) ? percentage : null,
    allowedDays: Number.isInteger(allowedDays) ? allowedDays : null,
    dayType,
    confidence: percentage !== null && allowedDays !== null ? "high" : "partial",
    sourceText,
  };
}

export function voucherNarration(source: Record<string, unknown>) {
  for (const key of ["narration", "NARRATION", "voucherNarration", "voucher_narration"]) {
    if (typeof source[key] === "string") return source[key] as string;
  }
  return "";
}
