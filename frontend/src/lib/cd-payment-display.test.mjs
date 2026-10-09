import test from "node:test";
import assert from "node:assert/strict";
import { cdPaymentDisplay } from "./cd-payment-display.ts";

test("BKP 1418 separates the on-time payment date from late full settlement", () => {
  assert.deepEqual(cdPaymentDisplay({
    invoiceAmount: "312661", windowDeadline: "2025-05-12",
    payments: [{ date: "2025-05-23", amount: "7735" }, { date: "2025-05-09", amount: "294965" }, { date: "2025-05-10", amount: "9961" }],
  }), { lastOnTimeDate: "2025-05-10", settledDate: "2025-05-23" });
});

test("full on-time payment and inclusive deadline retain their actual dates", () => {
  assert.deepEqual(cdPaymentDisplay({ invoiceAmount: "100000", windowDeadline: "2025-05-12", payments: [{ date: "2025-05-12", amount: "100000" }] }),
    { lastOnTimeDate: "2025-05-12", settledDate: "2025-05-12" });
});

test("partial late payment is not labelled full settlement", () => {
  assert.deepEqual(cdPaymentDisplay({ invoiceAmount: "100000", windowDeadline: "2025-05-12", payments: [{ date: "2025-05-10", amount: "95000" }, { date: "2025-05-23", amount: "2000" }] }),
    { lastOnTimeDate: "2025-05-10", settledDate: null });
});

test("missing receipt detail does not invent an on-time date", () => {
  assert.deepEqual(cdPaymentDisplay({ invoiceAmount: "100000", windowDeadline: "2025-05-12" }),
    { lastOnTimeDate: null, settledDate: null });
});
