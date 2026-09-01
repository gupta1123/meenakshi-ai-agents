import Decimal from "decimal.js";

import type { DecimalString, RoundingMethod } from "./contracts";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

export function decimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export function money(value: Decimal.Value, scale = 4, method: RoundingMethod = "half_up"): DecimalString {
  const mode = method === "half_even" ? Decimal.ROUND_HALF_EVEN : method === "truncate" ? Decimal.ROUND_DOWN : Decimal.ROUND_HALF_UP;
  return decimal(value).toDecimalPlaces(scale, mode).toFixed(scale);
}

export function quantity(value: Decimal.Value, scale = 6): DecimalString {
  return decimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
}

export function percentOf(value: Decimal.Value, percentage: Decimal.Value): Decimal {
  return decimal(value).mul(decimal(percentage)).div(100);
}

export function maxDecimal(left: Decimal.Value, right: Decimal.Value): Decimal {
  return Decimal.max(decimal(left), decimal(right));
}

export function nonNegative(value: Decimal.Value): Decimal {
  return Decimal.max(decimal(0), decimal(value));
}
