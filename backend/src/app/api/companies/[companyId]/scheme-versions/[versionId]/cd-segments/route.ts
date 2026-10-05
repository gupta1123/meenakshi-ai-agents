import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readInteger, readPositiveDecimal, readRequiredText, readRequiredUuid, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, loadCustomerGroupTree, assertUnderSundryDebtors, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

type SegmentInput = { label: string; allowedWorkingDays: number; amountPerTonne: string; customerGroupIds: string[] };

function readSegments(value: unknown): SegmentInput[] {
  if (!Array.isArray(value) || !value.length) throw new RulebookRequestError("Add at least one segment.");
  if (value.length > 20) throw new RulebookRequestError("A Cash Discount rule can have at most 20 segments.");
  return value.map((raw, index) => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const groupIds = Array.isArray(row.customerGroupIds) ? row.customerGroupIds : [];
    if (!groupIds.length) throw new RulebookRequestError(`Segment ${index + 1} needs at least one customer group.`);
    return {
      label: readRequiredText(row.label, `segments[${index}].label`, 80),
      allowedWorkingDays: readInteger(row.allowedWorkingDays, `segments[${index}].allowedWorkingDays`, 1, 60),
      amountPerTonne: readPositiveDecimal(row.amountPerTonne, `segments[${index}].amountPerTonne`, { maxScale: 2 }),
      customerGroupIds: [...new Set(groupIds.map((id, groupIndex) => readRequiredUuid(id, `segments[${index}].customerGroupIds[${groupIndex}]`)))],
    };
  });
}

/**
 * Replace a draft Cash Discount rule's segments (docs/CD_LOGIC.md). Each segment:
 * customer groups + working-day window + ₹ per MT. A group, or any of its
 * sub-groups, may be in only one segment. Saving segments makes the draft a
 * per-MT rule (percentage slabs are removed).
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireDraftVersion(version);
    if (version.scheme_type !== "cd") throw new RulebookRequestError("Segments apply only to Cash Discount rules.");
    const [, body, groupsById] = await Promise.all([
      requireCurrentMasterSync(scope.company.id),
      request.json().catch(() => ({})) as Promise<Record<string, unknown>>,
      loadCustomerGroupTree(scope.company.id),
    ]);
    const segments = readSegments(body.segments);

    // Every group must be under Sundry Debtors. Load the group tree once and
    // check each group against it (one query instead of one per group).
    const allGroupIds = segments.flatMap((segment) => segment.customerGroupIds);
    for (const groupId of allGroupIds) assertUnderSundryDebtors(groupsById, groupId);
    const children = new Map<string, string[]>();
    for (const group of groupsById.values()) if (group.parent_group_id) children.set(group.parent_group_id, [...(children.get(group.parent_group_id) ?? []), group.id]);
    const owner = new Map<string, number>();
    segments.forEach((segment, index) => {
      const stack = [...segment.customerGroupIds];
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const previous = owner.get(id);
        if (previous !== undefined && previous !== index) {
          const name = groupsById.get(id)?.name ?? "A customer group";
          throw new RulebookRequestError(`${name} is in both "${segments[previous].label}" and "${segment.label}". Each group, including its sub-groups, may be in only one segment.`, 409);
        }
        owner.set(id, index);
        stack.push(...(children.get(id) ?? []));
      }
    });

    // One call, one transaction (migration 20260927120000_save_cd_segments_function.sql).
    const saved = await createSupabaseAdminClient().rpc("save_meenakshi_cd_segments", {
      p_company_id: scope.company.id,
      p_version_id: version.id,
      p_segments: segments,
    });
    if (saved.error) throw saved.error;

    await appendRulebookAudit({ scope, action: "scheme_version_cd_segments_saved", entityType: "scheme_version", entityId: version.id, newValue: { segments } });
    return jsonWithCors(request, { segments });
  } catch (error) {
    return rulebookErrorResponse(request, error, "save Cash Discount segments");
  }
}
