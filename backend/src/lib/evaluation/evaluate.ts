import { evaluateCashDiscount, type CdEvaluationInput } from "./cd";
import type { EvaluationResult } from "./contracts";
import { evaluateTurnoverDiscount, type TodEvaluationInput } from "./tod";

export function evaluateCd(input: CdEvaluationInput): EvaluationResult {
  return evaluateCashDiscount(input);
}

export function evaluateTod(input: TodEvaluationInput): EvaluationResult {
  return evaluateTurnoverDiscount(input);
}
