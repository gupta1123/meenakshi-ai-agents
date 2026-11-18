import type { FrozenTodRule } from "./contracts";
import type { LiveTodBatchAggregate } from "./live-tod";
export function evaluateLocalTurnoverDiscount(
  rule: FrozenTodRule,
  evaluatedOn: string,
  periodStart: string,
  periodEnd: string,
  aggregates: LiveTodBatchAggregate["customerAggregates"],
): { rows: Array<Record<string, unknown>>; totals: Record<string, unknown> };
