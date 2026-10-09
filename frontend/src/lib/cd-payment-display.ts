/** Keep deadline evidence separate from later full settlement in UI copy. */
export function cdPaymentDisplay(row: {
  invoiceAmount: string;
  windowDeadline: string;
  payments?: Array<{ date: string; amount: string }>;
}) {
  const deadline = row.windowDeadline.slice(0, 10);
  const payments = [...(row.payments ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const onTime = payments.filter((payment) => payment.date.slice(0, 10) <= deadline);
  let total = 0;
  const settled = payments.find((payment) => {
    total += Number(payment.amount);
    return total >= Number(row.invoiceAmount) - 1;
  });
  return {
    lastOnTimeDate: onTime.at(-1)?.date.slice(0, 10) ?? null,
    settledDate: settled?.date.slice(0, 10) ?? null,
  };
}
