import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readInteger, readPositiveDecimal, readRequiredText, readRequiredUuid, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, requireSundryDebtorsGroup, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
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
    await requireCurrentMasterSync(scope.company.id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const segments = readSegments(body.segments);

    // Every group must be under Sundry Debtors; collect the group tree once.
    let groupsById: Map<string, { id: string; name: string; parent_group_id: string | null; is_available: boolean }> | undefined;
    for (const groupId of segments.flatMap((segment) => segment.customerGroupIds)) groupsById = await requireSundryDebtorsGroup(scope.company.id, groupId);
    const children = new Map<string, string[]>();
    for (const group of groupsById?.values() ?? []) if (group.parent_group_id) children.set(group.parent_group_id, [...(children.get(group.parent_group_id) ?? []), group.id]);
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
          const name = groupsById?.get(id)?.name ?? "A customer group";
          throw new RulebookRequestError(`${name} is in both "${segments[previous].label}" and "${segment.label}". Each group, including its sub-groups, may be in only one segment.`, 409);
        }
        owner.set(id, index);
        stack.push(...(children.get(id) ?? []));
      }
    });

    const supabase = createSupabaseAdminClient();
    // Switch the draft to per-MT; days and rate now live on the segments.
    const switched = await supabase.from("scheme_versions")
      .update({ cd_discount_basis: "amount_per_tonne", discount_percentage: null, allowed_working_days: null })
      .eq("id", version.id).eq("status", "draft");
    if (switched.error) throw switched.error;
    const cleared = await Promise.all([
      supabase.from("scheme_version_cd_slabs").delete().eq("scheme_version_id", version.id),
      supabase.from("scheme_version_cd_segments").delete().eq("scheme_version_id", version.id),
    ]);
    for (const result of cleared) if (result.error) throw result.error;
    // Groups picked before segments existed are replaced by the segment groups.
    const oldGroups = await supabase.from("scheme_version_customer_groups").delete().eq("scheme_version_id", version.id);
    if (oldGroups.error) throw oldGroups.error;

    for (const [index, segment] of segments.entries()) {
      const inserted = await supabase.from("scheme_version_cd_segments").insert({
        scheme_version_id: version.id,
        company_id: scope.company.id,
        label: segment.label,
        allowed_working_days: segment.allowedWorkingDays,
        amount_per_tonne: segment.amountPerTonne,
        sort_order: index,
      }).select("id").single();
      if (inserted.error) throw inserted.error;
      const members = await supabase.from("scheme_version_cd_segment_groups").insert(segment.customerGroupIds.map((customerGroupId) => ({
        scheme_version_id: version.id,
        segment_id: inserted.data.id,
        company_id: scope.company.id,
        customer_group_id: customerGroupId,
      })));
      if (members.error) throw members.error;
    }

    await appendRulebookAudit({ scope, action: "scheme_version_cd_segments_saved", entityType: "scheme_version", entityId: version.id, newValue: { segments } });
    return jsonWithCors(request, { segments });
  } catch (error) {
    return rulebookErrorResponse(request, error, "save Cash Discount segments");
  }
}
