import type { CustomerEvidence, CustomerGroupMembership, FrozenRuleBase, IsoDate } from "./contracts";

export type CoverageResult = {
  state: "covered" | "not_in_scheme" | "needs_review";
  coveredGroupId: string | null;
  memberships: CustomerGroupMembership[];
  reasonCodes: string[];
};

export function resolveRuleCoverage(rule: FrozenRuleBase, customer: CustomerEvidence, asOfDate: IsoDate): CoverageResult {
  if (!customer.isAvailable || !customer.currentCustomerGroupId) {
    return { state: "needs_review", coveredGroupId: null, memberships: customer.groupPath, reasonCodes: ["customer_group_unavailable"] };
  }
  if (asOfDate < rule.effectiveFrom || (rule.effectiveTo && asOfDate > rule.effectiveTo)) {
    return { state: "not_in_scheme", coveredGroupId: null, memberships: customer.groupPath, reasonCodes: ["rule_not_effective"] };
  }
  if (customer.groupPath.length === 0 || customer.groupPath.some((group) => !group.isAvailable)) {
    return { state: "needs_review", coveredGroupId: null, memberships: customer.groupPath, reasonCodes: ["customer_group_path_unavailable"] };
  }
  const matched = customer.groupPath.filter((group) => rule.selectedCustomerGroupIds.includes(group.customerGroupId));
  if (matched.length === 0) {
    return { state: "not_in_scheme", coveredGroupId: null, memberships: customer.groupPath, reasonCodes: ["customer_not_in_selected_group"] };
  }
  return { state: "covered", coveredGroupId: matched[0].customerGroupId, memberships: customer.groupPath, reasonCodes: [] };
}
