"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ListTree, Plus, Search, Trash2 } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { standardTonnesFactor } from "./guided-draft-setup";
import type { ReferenceData, Scheme, VersionDetail } from "./types";
import { Button, Drawer, IconButton, InlineMessage } from "./ui";
import { accessToken } from "./workspace";
import studio from "./rulebook-studio.module.css";

type CreatedRule = { schemeId: string; versionId: string; applied?: boolean };
type CashDiscountSlab = { days: number; percentage: string };
type TodTierEdit = { key: string; minimumTonnes: string; benefitValue: string };
type TodConversionEdit = { key: string; sourceUomId: string; tonnesPerSourceUnit: string; isBuiltin: boolean };
/** Cash Discount segment being edited (docs/CD_LOGIC.md). */
type SegmentEdit = { key: string; label: string; days: string; amount: string; groupIds: string[] };
type Props = {
  open: boolean;
  scheme: Scheme | null;
  source: VersionDetail | null;
  reference: ReferenceData | null;
  onClose: () => void;
  onSaved: (created: CreatedRule) => Promise<void>;
  onError: (message: string | null) => void;
};

const today = () => new Date().toISOString().slice(0, 10);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
function addMonths(date: string, months: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return isoDate(parsed);
}
function previousDay(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return isoDate(parsed);
}
const defaultSlabs: CashDiscountSlab[] = [
  { days: 7, percentage: "1.5" },
  { days: 15, percentage: "1" },
];

function normalizedSlabs(source: VersionDetail | null): CashDiscountSlab[] {
  const savedSlabs = source?.configuration.cdSlabs;
  if (!savedSlabs?.length) return defaultSlabs.map((slab) => ({ ...slab }));

  return savedSlabs.map((slab) => ({
    days: Number.isFinite(Number(slab.allowedWorkingDays)) ? Number(slab.allowedWorkingDays) : 0,
    percentage: slab.percentage == null ? "" : String(slab.percentage),
  }));
}

const rowKey = () => globalThis.crypto?.randomUUID?.() ?? `row-${Date.now()}-${Math.random()}`;
const emptySegment = (label = "", days = "3"): SegmentEdit => ({ key: rowKey(), label, days, amount: "500", groupIds: [] });

/** Saved segments; a legacy percentage rule becomes one segment with its groups and days. */
function normalizedSegments(source: VersionDetail | null): SegmentEdit[] {
  const saved = source?.configuration.cdSegments;
  if (saved?.length) return saved.map((segment) => ({ key: segment.id ?? rowKey(), label: segment.label, days: String(segment.allowedWorkingDays), amount: String(segment.amountPerTonne), groupIds: [...segment.customerGroupIds] }));
  if (source && source.version.schemeType === "cd") {
    return [{ key: rowKey(), label: "All customers", days: String(source.version.allowedWorkingDays ?? 3), amount: "", groupIds: source.configuration.customerGroups.map((group) => group.customer_group_id) }];
  }
  return [emptySegment("3 days", "3"), emptySegment("10 days", "10")];
}
const segmentSignature = (segments: SegmentEdit[]) => JSON.stringify(segments.map((segment) => [segment.label.trim(), Number(segment.days), Number(segment.amount), [...segment.groupIds].sort()]));
const emptyTier = (): TodTierEdit => ({ key: rowKey(), minimumTonnes: "", benefitValue: "" });
const clientTodTiers = (): TodTierEdit[] => [
  ["30", "250"],
  ["50", "350"],
  ["100", "400"],
  ["150", "424"],
  ["200", "450"],
].map(([minimumTonnes, benefitValue]) => ({ key: rowKey(), minimumTonnes, benefitValue }));
function shortDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function reviewFrequencyLabel(months: number) {
  if (months === 1) return "Monthly";
  if (months === 3) return "Quarterly";
  if (months === 6) return "Half-yearly";
  if (months === 12) return "Annually";
  return `Every ${months} months`;
}

function reviewPeriods(start: string, end: string, months: number) {
  if (!start || !Number.isFinite(months) || months < 1) return [];
  const periods: Array<{ start: string; end: string }> = [];
  let cursor = start;
  for (let index = 0; index < 12; index += 1) {
    const periodEnd = previousDay(addMonths(cursor, months));
    if (end && cursor > end) break;
    periods.push({ start: cursor, end: end && periodEnd > end ? end : periodEnd });
    if (!end || periodEnd >= end) break;
    cursor = addMonths(cursor, months);
  }
  return periods;
}

export function RuleEditor({ open, scheme, source, reference, onClose, onSaved, onError }: Props) {
  const { company } = useCompany();
  const updating = Boolean(scheme && source);
  const editingDraft = source?.version.status === "draft";
  const preparingUpdate = source?.version.status === "active";
  const [ruleType, setRuleType] = useState<"cd" | "tod">("cd");
  const [ruleName, setRuleName] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [slabs, setSlabs] = useState<CashDiscountSlab[]>(() => defaultSlabs.map((slab) => ({ ...slab })));
  const [checkNarration, setCheckNarration] = useState(true);
  const [periodMonths, setPeriodMonths] = useState("3");
  const [periodAnchorDate, setPeriodAnchorDate] = useState(today());
  const [todBenefitBasis, setTodBenefitBasis] = useState<"percentage_of_eligible_value" | "amount_per_eligible_tonne">("amount_per_eligible_tonne");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [expandedCustomerGroupIds, setExpandedCustomerGroupIds] = useState<string[]>([]);
  const [selectedStockTargets, setSelectedStockTargets] = useState<string[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [expandedStockGroupIds, setExpandedStockGroupIds] = useState<string[]>([]);
  const [pickerView, setPickerView] = useState<"customers" | "products" | null>(null);
  const [todTiers, setTodTiers] = useState<TodTierEdit[]>(clientTodTiers);
  const [todConversions, setTodConversions] = useState<TodConversionEdit[]>([]);
  // Cash Discount: segments, the segment whose groups are being picked, and MT per unit.
  const [segments, setSegments] = useState<SegmentEdit[]>(() => normalizedSegments(null));
  const [editingSegmentKey, setEditingSegmentKey] = useState<string | null>(null);
  const [unitFactors, setUnitFactors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const createAttempt = useRef<{ key: string; code: string } | null>(null);
  const [editorError, setEditorError] = useState<{ message: string; area: "period" | "benefit" | "general" } | null>(null);

  const sourceVersionId = source?.version.id ?? null;

  useEffect(() => {
    if (!open) return;
    createAttempt.current = null;

    const type = scheme?.schemeType ?? "cd";
    const months = source?.version.periodMonths ?? 3;
    setRuleType(type);
    setRuleName(scheme?.name ?? "");
    setEffectiveFrom(source?.version.effectiveFrom ?? today());
    setEffectiveTo(source?.version.effectiveTo ?? "");
    setSlabs(normalizedSlabs(source));
    setCheckNarration(source?.version.checkNarration ?? true);
    setPeriodMonths(String(months));
    setPeriodAnchorDate(source?.version.periodAnchorDate ?? source?.version.effectiveFrom ?? today());
    setTodBenefitBasis(source?.version.todBenefitBasis ?? "amount_per_eligible_tonne");
    setSelectedGroupIds(source?.configuration.customerGroups.map((group) => group.customer_group_id) ?? []);
    setGroupSearch("");
    setExpandedCustomerGroupIds([]);
    setSelectedStockTargets([
      ...(source?.configuration.stockItems.map((item) => `stockItem:${item.stock_item_id}`) ?? []),
      ...(source?.configuration.stockGroups.map((item) => `stockGroup:${item.stock_group_id}`) ?? []),
    ]);
    setStockSearch("");
    setExpandedStockGroupIds([]);
    setPickerView(null);
    setTodTiers(source?.configuration.tiers.length ? source.configuration.tiers.map((tier) => ({ key: tier.id, minimumTonnes: String(tier.minimum_tonnes), benefitValue: String(source.version.todBenefitBasis === "amount_per_eligible_tonne" ? tier.discount_amount_per_tonne ?? "" : tier.discount_percentage ?? "") })) : clientTodTiers());
    setTodConversions(source?.configuration.conversions.map((conversion) => ({ key: conversion.source_uom_id, sourceUomId: conversion.source_uom_id, tonnesPerSourceUnit: String(conversion.tonnes_per_source_unit), isBuiltin: conversion.is_builtin })) ?? []);
    setSegments(normalizedSegments(source ?? null));
    setEditingSegmentKey(null);
    setUnitFactors(Object.fromEntries(source?.configuration.conversions.map((conversion) => [conversion.source_uom_id, String(conversion.tonnes_per_source_unit)]) ?? []));
    setEditorError(null);
    onError(null);
  }, [open, sourceVersionId, scheme?.id, editingDraft, preparingUpdate]);

  async function submit(form: HTMLFormElement) {
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      setEditorError({ message: "The rule end date cannot be before its start date.", area: "period" });
      return;
    }
    if (ruleType === "cd") {
      const bad = segments.findIndex((segment) => !segment.label.trim() || !(Number(segment.days) >= 1 && Number(segment.days) <= 60 && Number.isInteger(Number(segment.days))) || !(Number(segment.amount) > 0) || !segment.groupIds.length);
      if (!segments.length || bad >= 0) {
        setEditorError({ message: segments.length ? `Complete segment ${bad + 1}: a name, 1–60 days, a ₹ per MT amount and at least one customer group.` : "Add at least one segment.", area: "general" });
        return;
      }
      if (!selectedStockTargets.length) {
        setEditorError({ message: "Select the eligible products whose MT earns the Cash Discount.", area: "general" });
        return;
      }
      if (cdConversionRows.some((row) => !(Number(row.factor) > 0))) {
        setEditorError({ message: "Enter how many MT each product unit weighs.", area: "general" });
        return;
      }
    } else if (!selectedGroupIds.length) {
      setEditorError({ message: "Select at least one customer group.", area: "general" });
      return;
    }
    if (ruleType === "tod") {
      const months = Number(periodMonths);
      const minimumEnd = previousDay(addMonths(periodAnchorDate, months));
      if (effectiveTo && effectiveTo < minimumEnd) {
        setEditorError({ message: `For a ${months}-month review, leave the end date blank or use ${minimumEnd} or later.`, area: "period" });
        return;
      }
      if (!selectedStockTargets.length) {
        setEditorError({ message: "Select at least one eligible product or product group.", area: "general" });
        return;
      }
      if (!todTiers.length || todTiers.some((tier) => !tier.minimumTonnes || !tier.benefitValue)) {
        setEditorError({ message: "Complete at least one valid discount level.", area: "benefit" });
        return;
      }
      if (todConversions.some((conversion) => !conversion.sourceUomId || !conversion.tonnesPerSourceUnit)) {
        setEditorError({ message: "Complete or remove each quantity conversion.", area: "general" });
        return;
      }
    }

    const token = await accessToken();
    if (!token) return;
    const fields = new FormData(form);
    setBusy(true);
    setEditorError(null);
    onError(null);
    try {
      const common = {
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        copyFromVersionId: preparingUpdate ? source?.version.id : undefined,
      };
      // Cash Discount drafts start as a legacy rule and become per-MT when their
      // segments are saved below; a per-MT draft takes no percentage slabs.
      const perMtDraft = source?.version.cdDiscountBasis === "amount_per_tonne";
      const businessTerms = ruleType === "cd"
        ? (editingDraft && perMtDraft ? {} : {
            slabs: [...slabs]
              .sort((left, right) => left.days - right.days)
              .map((slab) => ({ allowedWorkingDays: slab.days, percentage: slab.percentage })),
            checkNarration,
          })
        : {
            periodMonths: Number(periodMonths),
            periodAnchorDate,
            todBenefitBasis,
          };

      let newRule: { scheme: Scheme; version: { id: string } } | null = null;
      if (!scheme) {
        createAttempt.current ??= { key: globalThis.crypto.randomUUID(), code: `${ruleType.toUpperCase()}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}` };
        const generatedCode = createAttempt.current.code;
        const result = await apiRequest<{ scheme: Scheme; version: { id: string } }>(token, `/api/companies/${company.id}/schemes`, {
          method: "POST",
          headers: { "Idempotency-Key": createAttempt.current.key },
          timeoutMs: 60_000,
          body: jsonBody({
            schemeType: ruleType,
            code: generatedCode,
            name: fields.get("name"),
            description: null,
            initialRule: {
              ...common,
              copyFromVersionId: undefined,
              ...businessTerms,
            },
          }),
        });
        newRule = result;
      }

      if (editingDraft && source && ruleType === "tod" && source.version.todBenefitBasis !== todBenefitBasis) {
        await Promise.all(source.configuration.tiers.map((tier) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${source.version.id}/tiers`, { method: "DELETE", body: jsonBody({ tierId: tier.id }) })));
      }
      const result = newRule ?? (editingDraft && source
        ? await apiRequest<{ version: { id: string } }>(token, `/api/companies/${company.id}/scheme-versions/${source.version.id}`, {
            method: "PATCH",
            body: jsonBody({ ...common, copyFromVersionId: undefined, ...businessTerms }),
          })
        : await apiRequest<{ version: { id: string } }>(token, `/api/companies/${company.id}/schemes/${scheme!.id}/versions`, {
            method: "POST",
            body: jsonBody({ ...common, ...businessTerms }),
          }));
      const versionId = result.version.id;
      if (ruleType === "cd") {
        // Segments own the customer groups (and switch the draft to per-MT).
        await apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/cd-segments`, {
          method: "PUT",
          body: jsonBody({ segments: segments.map((segment) => ({ label: segment.label.trim(), allowedWorkingDays: Number(segment.days), amountPerTonne: segment.amount.trim(), customerGroupIds: segment.groupIds })) }),
        });
        const draft = await apiRequest<VersionDetail>(token, `/api/companies/${company.id}/scheme-versions/${versionId}`);
        const existingStocks = new Set([
          ...draft.configuration.stockItems.map((item) => `stockItem:${item.stock_item_id}`),
          ...draft.configuration.stockGroups.map((item) => `stockGroup:${item.stock_group_id}`),
        ]);
        const nextStocks = new Set(selectedStockTargets);
        await Promise.all([
          ...selectedStockTargets.filter((target) => !existingStocks.has(target)).map((target) => { const [kind, id] = target.split(":"); return apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/stocks`, { method: "POST", body: jsonBody({ kind, id }) }); }),
          ...[...existingStocks].filter((target) => !nextStocks.has(target)).map((target) => { const [kind, id] = target.split(":"); return apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/stocks`, { method: "DELETE", body: jsonBody({ kind, id }) }); }),
        ]);
        const nextUnits = new Set(cdConversionRows.map((row) => row.unitId));
        await Promise.all([
          ...draft.configuration.conversions.filter((item) => !nextUnits.has(item.source_uom_id)).map((item) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/conversions`, { method: "DELETE", body: jsonBody({ sourceUomId: item.source_uom_id }) })),
          // Only new or changed conversions; unchanged ones are already saved.
          ...cdConversionRows.filter((row) => { const saved = draft.configuration.conversions.find((item) => item.source_uom_id === row.unitId); return !saved || Number(saved.tonnes_per_source_unit) !== Number(row.factor); }).map((row) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/conversions`, { method: "POST", body: jsonBody({ sourceUomId: row.unitId, tonnesPerSourceUnit: row.factor, isBuiltin: row.factor === row.standard && (row.standard === "1" || row.standard === "0.001") }) })),
        ]);
      } else {
        const savedGroupIds = new Set(source?.configuration.customerGroups.map((group) => group.customer_group_id) ?? []);
        const nextGroupIds = new Set(selectedGroupIds);
        await Promise.all([
          ...selectedGroupIds.filter((id) => !savedGroupIds.has(id)).map((customerGroupId) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/groups`, { method: "POST", body: jsonBody({ customerGroupId }) })),
          ...[...savedGroupIds].filter((id) => !nextGroupIds.has(id)).map((customerGroupId) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/groups`, { method: "DELETE", body: jsonBody({ customerGroupId }) })),
        ]);
      }
      if (ruleType === "tod") {
        const draft = await apiRequest<VersionDetail>(token, `/api/companies/${company.id}/scheme-versions/${versionId}`);
        const existingStocks = new Set([
          ...draft.configuration.stockItems.map((item) => `stockItem:${item.stock_item_id}`),
          ...draft.configuration.stockGroups.map((item) => `stockGroup:${item.stock_group_id}`),
        ]);
        const nextStocks = new Set(selectedStockTargets);
        await Promise.all([
          ...selectedStockTargets.filter((target) => !existingStocks.has(target)).map((target) => { const [kind, id] = target.split(":"); return apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/stocks`, { method: "POST", body: jsonBody({ kind, id }) }); }),
          ...[...existingStocks].filter((target) => !nextStocks.has(target)).map((target) => { const [kind, id] = target.split(":"); return apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/stocks`, { method: "DELETE", body: jsonBody({ kind, id }) }); }),
          ...draft.configuration.tiers.map((tier) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/tiers`, { method: "DELETE", body: jsonBody({ tierId: tier.id }) })),
        ]);
        const existingConversions = new Map(draft.configuration.conversions.map((item) => [item.source_uom_id, item]));
        const nextConversionIds = new Set(todConversions.map((item) => item.sourceUomId));
        await Promise.all([
          ...[...existingConversions.keys()].filter((id) => !nextConversionIds.has(id)).map((sourceUomId) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/conversions`, { method: "DELETE", body: jsonBody({ sourceUomId }) })),
          ...todConversions.map((conversion) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/conversions`, { method: "POST", body: jsonBody({ sourceUomId: conversion.sourceUomId, tonnesPerSourceUnit: conversion.tonnesPerSourceUnit, isBuiltin: conversion.isBuiltin }) })),
          ...todTiers.map((tier) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/tiers`, { method: "POST", body: jsonBody(todBenefitBasis === "amount_per_eligible_tonne" ? { minimumTonnes: tier.minimumTonnes, amountPerTonne: tier.benefitValue } : { minimumTonnes: tier.minimumTonnes, discountPercentage: tier.benefitValue }) })),
        ]);
      }
      if (newRule) {
        await onSaved({ schemeId: newRule.scheme.id, versionId });
        return;
      }
      if (!scheme) throw new Error("The rule could not be identified. Refresh Rulebook before retrying.");
      // Rename only when the name changed (saves a request on every save).
      if (String(fields.get("name") ?? "").trim() !== scheme.name.trim()) {
        await apiRequest(token, `/api/companies/${company.id}/schemes/${scheme.id}`, {
          method: "PATCH",
          body: jsonBody({ name: fields.get("name"), description: scheme.description }),
        });
      }
      await apiRequest(token, `/api/companies/${company.id}/scheme-versions/${versionId}/activate`, {
        method: "POST",
        headers: { "Idempotency-Key": globalThis.crypto.randomUUID() },
      });
      await onSaved({ schemeId: scheme.id, versionId, applied: true });
    } catch (cause) {
      // A timeout does not roll back a server write. Reconcile this exact
      // generated reference instead of inviting a duplicate creation.
      if (!scheme && createAttempt.current) {
        try {
          const saved = await apiRequest<{ schemes: Scheme[] }>(token, `/api/companies/${company.id}/schemes`, { cache: "no-store" });
          const match = saved.schemes.find((item) => item.code === createAttempt.current?.code);
          if (match) {
            const detail = await apiRequest<{ versions: Array<{ id: string }> }>(token, `/api/companies/${company.id}/schemes/${match.id}`, { cache: "no-store" });
            if (detail.versions[0]) {
              await onSaved({ schemeId: match.id, versionId: detail.versions[0].id });
              return;
            }
          }
        } catch { /* Preserve the uncertain outcome; never claim rollback. */ }
      }
      const prefix = updating
        ? editingDraft ? "Could not save these changes." : "Could not start editing this rule."
        : "Could not confirm whether this rule was saved. Refresh Rulebook before trying again.";
      const message = userFacingError(cause, prefix);
      const area = /tier|benefit|calculated/i.test(message) ? "benefit" : /period|start|end date|active through/i.test(message) ? "period" : "general";
      setEditorError({ message, area });
    } finally {
      setBusy(false);
    }
  }

  const selectedType = scheme?.schemeType ?? ruleType;
  const sameSet = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const sameTiers = JSON.stringify(todTiers.map((item) => [Number(item.minimumTonnes), Number(item.benefitValue)]).sort()) === JSON.stringify((source?.configuration.tiers ?? []).map((item) => [Number(item.minimum_tonnes), Number(todBenefitBasis === "amount_per_eligible_tonne" ? item.discount_amount_per_tonne : item.discount_percentage)]).sort());
  const groups = reference?.masters.customerGroups.filter((group) => group.is_available) ?? [];
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const eligibleGroups = groups.filter((group) => {
    const visited = new Set<string>();
    let current = group;
    while (current && !visited.has(current.id)) {
      if ((current.name ?? current.ledger_name ?? current.code ?? "").trim().toLowerCase() === "sundry debtors") return true;
      visited.add(current.id);
      current = current.parent_group_id ? groupsById.get(current.parent_group_id)! : undefined!;
    }
    return false;
  });
  const eligibleGroupIds = new Set(eligibleGroups.map((group) => group.id));
  const customerChildren = new Map<string, typeof eligibleGroups>();
  for (const group of eligibleGroups) if (group.parent_group_id && eligibleGroupIds.has(group.parent_group_id)) customerChildren.set(group.parent_group_id, [...(customerChildren.get(group.parent_group_id) ?? []), group]);
  const customerRoots = eligibleGroups.filter((group) => !group.parent_group_id || !eligibleGroupIds.has(group.parent_group_id));
  const stockGroups = reference?.masters.stockGroups.filter((item) => item.is_available) ?? [];
  const stockItems = reference?.masters.stockItems.filter((item) => item.is_available) ?? [];
  const stockGroupIds = new Set(stockGroups.map((group) => group.id));
  const stockGroupChildren = new Map<string, typeof stockGroups>();
  const stockItemsByGroup = new Map<string, typeof stockItems>();
  for (const group of stockGroups) if (group.parent_group_id && stockGroupIds.has(group.parent_group_id)) stockGroupChildren.set(group.parent_group_id, [...(stockGroupChildren.get(group.parent_group_id) ?? []), group]);
  for (const item of stockItems) if (item.current_stock_group_id) stockItemsByGroup.set(item.current_stock_group_id, [...(stockItemsByGroup.get(item.current_stock_group_id) ?? []), item]);
  const stockRoots = stockGroups.filter((group) => !group.parent_group_id || !stockGroupIds.has(group.parent_group_id));
  const orphanStockItems = stockItems.filter((item) => !item.current_stock_group_id || !stockGroupIds.has(item.current_stock_group_id));
  const parsedPeriodMonths = Number(periodMonths);
  const periodSchedule = selectedType === "tod" ? reviewPeriods(effectiveFrom, effectiveTo, parsedPeriodMonths) : [];

  const labelOf = (item: { name?: string | null; ledger_name?: string | null; code?: string | null }, fallback: string) => item.name ?? item.ledger_name ?? item.code ?? fallback;
  const customerDescendants = (id: string): string[] => (customerChildren.get(id) ?? []).flatMap((child) => [child.id, ...customerDescendants(child.id)]);
  const stockDescendantTargets = (id: string): string[] => [
    ...(stockItemsByGroup.get(id) ?? []).map((item) => `stockItem:${item.id}`),
    ...(stockGroupChildren.get(id) ?? []).flatMap((group) => [`stockGroup:${group.id}`, ...stockDescendantTargets(group.id)]),
  ];
  const selectedCustomerAncestor = (group: typeof eligibleGroups[number]) => {
    let parentId = group.parent_group_id;
    while (parentId) {
      if (selectedGroupIds.includes(parentId)) return true;
      parentId = groupsById.get(parentId)?.parent_group_id ?? null;
    }
    return false;
  };
  const selectedStockAncestor = (groupId: string | null | undefined) => {
    let parentId = groupId;
    const byId = new Map(stockGroups.map((group) => [group.id, group]));
    while (parentId) {
      if (selectedStockTargets.includes(`stockGroup:${parentId}`)) return true;
      parentId = byId.get(parentId)?.parent_group_id ?? null;
    }
    return false;
  };
  // Cash Discount: the units used by the selected products, each needing an MT factor.
  const unitsById = new Map((reference?.masters.units ?? []).map((unit) => [unit.id, unit]));
  const coveredStockItemIds = new Set(selectedStockTargets.flatMap((target) => {
    const [kind, id] = target.split(":");
    return kind === "stockItem" ? [id] : stockDescendantTargets(id).filter((key) => key.startsWith("stockItem:")).map((key) => key.slice("stockItem:".length));
  }));
  const cdConversionRows = [...new Set(stockItems.filter((item) => coveredStockItemIds.has(item.id) && item.default_uom_id).map((item) => item.default_uom_id!))].map((unitId) => {
    const unit = unitsById.get(unitId);
    const standard = standardTonnesFactor(unit?.code ?? unit?.name) ?? "";
    return { unitId, label: labelOf(unit ?? {}, "Unit"), standard, factor: unitFactors[unitId] ?? standard };
  });
  // Cash Discount: a group is unavailable to this segment when another segment has it, a parent of it, or a sub-group of it.
  const isAncestorOf = (ancestorId: string, groupId: string) => {
    let current = groupsById.get(groupId)?.parent_group_id ?? null;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === ancestorId) return true;
      visited.add(current);
      current = groupsById.get(current)?.parent_group_id ?? null;
    }
    return false;
  };
  const takenByOtherSegment = (groupId: string) => {
    if (selectedType !== "cd" || !editingSegmentKey) return null;
    return segments.find((segment) => segment.key !== editingSegmentKey
      && segment.groupIds.some((id) => id === groupId || isAncestorOf(id, groupId) || isAncestorOf(groupId, id))) ?? null;
  };
  const openSegmentPicker = (segment: SegmentEdit) => { setEditingSegmentKey(segment.key); setSelectedGroupIds(segment.groupIds); setGroupSearch(""); setPickerView("customers"); };
  const closePicker = () => {
    if (editingSegmentKey) setSegments((current) => current.map((segment) => segment.key === editingSegmentKey ? { ...segment, groupIds: selectedGroupIds } : segment));
    setEditingSegmentKey(null);
    setPickerView(null);
  };
  const updateSegment = (key: string, patch: Partial<SegmentEdit>) => setSegments((current) => current.map((segment) => segment.key === key ? { ...segment, ...patch } : segment));
  const savedStockTargets = [...(source?.configuration.stockItems.map((item) => `stockItem:${item.stock_item_id}`) ?? []), ...(source?.configuration.stockGroups.map((item) => `stockGroup:${item.stock_group_id}`) ?? [])];
  const unchanged = updating && Boolean(source) && ruleName.trim() === scheme?.name
    && effectiveFrom === source?.version.effectiveFrom && (effectiveTo || null) === source?.version.effectiveTo
    && (selectedType === "cd"
      ? source?.version.cdDiscountBasis === "amount_per_tonne" && segmentSignature(segments) === segmentSignature(normalizedSegments(source))
        && sameSet(selectedStockTargets, savedStockTargets)
        && cdConversionRows.every((row) => Number(row.factor) === Number(source?.configuration.conversions.find((item) => item.source_uom_id === row.unitId)?.tonnes_per_source_unit ?? NaN))
      : sameSet(selectedGroupIds, source?.configuration.customerGroups.map((item) => item.customer_group_id) ?? [])
        && Number(periodMonths) === source?.version.periodMonths && periodAnchorDate === source?.version.periodAnchorDate
        && todBenefitBasis === source?.version.todBenefitBasis && sameTiers
        && sameSet(selectedStockTargets, savedStockTargets));

  const groupMatches = (group: typeof eligibleGroups[number], query: string): boolean => labelOf(group, "Customer group").toLowerCase().includes(query) || (customerChildren.get(group.id) ?? []).some((child) => groupMatches(child, query));
  const stockGroupMatches = (group: typeof stockGroups[number], query: string): boolean => labelOf(group, "Product group").toLowerCase().includes(query) || (stockItemsByGroup.get(group.id) ?? []).some((item) => labelOf(item, "Product").toLowerCase().includes(query)) || (stockGroupChildren.get(group.id) ?? []).some((child) => stockGroupMatches(child, query));

  function renderCustomerGroup(group: typeof eligibleGroups[number], depth = 0): ReactNode {
    const query = groupSearch.trim().toLowerCase();
    if (query && !groupMatches(group, query)) return null;
    const children = customerChildren.get(group.id) ?? [];
    const expanded = Boolean(query) || expandedCustomerGroupIds.includes(group.id);
    const covered = selectedCustomerAncestor(group);
    const checked = covered || selectedGroupIds.includes(group.id);
    const taken = checked ? null : takenByOtherSegment(group.id);
    return <div key={group.id} className="rule-tree-branch"><div className={`rule-tree-row ${checked ? "selected" : ""}${taken ? " is-taken" : ""}`} style={{ paddingLeft: `${6 + depth * 17}px` }} title={taken ? `Already in “${taken.label || "another segment"}”` : undefined}>{children.length ? <button type="button" className="rule-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${labelOf(group, "customer group")}`} onClick={() => setExpandedCustomerGroupIds((current) => expanded ? current.filter((id) => id !== group.id) : [...current, group.id])}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="rule-tree-toggle" />}<label><input type="checkbox" checked={checked} disabled={covered || Boolean(taken)} onChange={() => setSelectedGroupIds((current) => checked ? current.filter((id) => id !== group.id) : [...current.filter((id) => !customerDescendants(group.id).includes(id)), group.id])} /><span><strong>{labelOf(group, "Customer group")}</strong>{taken ? <small>In {taken.label || "another segment"}</small> : depth > 0 && <small>Subgroup</small>}</span></label></div>{expanded && children.map((child) => renderCustomerGroup(child, depth + 1))}</div>;
  }

  function renderStockGroup(group: typeof stockGroups[number], depth = 0): ReactNode {
    const query = stockSearch.trim().toLowerCase();
    if (query && !stockGroupMatches(group, query)) return null;
    const childGroups = stockGroupChildren.get(group.id) ?? [];
    const childItems = stockItemsByGroup.get(group.id) ?? [];
    const expanded = Boolean(query) || expandedStockGroupIds.includes(group.id);
    const covered = selectedStockAncestor(group.parent_group_id);
    const groupKey = `stockGroup:${group.id}`;
    const checked = covered || selectedStockTargets.includes(groupKey);
    return <div key={group.id} className="rule-tree-branch"><div className={`rule-tree-row ${checked ? "selected" : ""}`} style={{ paddingLeft: `${6 + depth * 17}px` }}><button type="button" className="rule-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${labelOf(group, "product group")}`} onClick={() => setExpandedStockGroupIds((current) => expanded ? current.filter((id) => id !== group.id) : [...current, group.id])}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><label><input type="checkbox" checked={checked} disabled={covered} onChange={() => setSelectedStockTargets((current) => checked ? current.filter((key) => key !== groupKey) : [...current.filter((key) => !stockDescendantTargets(group.id).includes(key)), groupKey])} /><span><strong>{labelOf(group, "Product group")}</strong><small>Product group</small></span></label></div>{expanded && <>{childGroups.map((child) => renderStockGroup(child, depth + 1))}{childItems.filter((item) => !query || labelOf(item, "Product").toLowerCase().includes(query)).map((item) => { const itemKey = `stockItem:${item.id}`; const itemCovered = checked || selectedStockAncestor(item.current_stock_group_id); const itemChecked = itemCovered || selectedStockTargets.includes(itemKey); return <div className={`rule-tree-row rule-tree-item ${itemChecked ? "selected" : ""}`} style={{ paddingLeft: `${23 + (depth + 1) * 17}px` }} key={item.id}><span className="rule-tree-toggle" /><label><input type="checkbox" checked={itemChecked} disabled={itemCovered} onChange={() => setSelectedStockTargets((current) => itemChecked ? current.filter((key) => key !== itemKey) : [...current, itemKey])} /><span><strong>{labelOf(item, "Product")}</strong><small>Product</small></span></label></div>; })}</>}</div>;
  }

  if (pickerView) return <Drawer
    open={open}
    onClose={onClose}
    onBack={closePicker}
    title={pickerView === "customers" ? editingSegmentKey ? `Customer groups · ${segments.find((segment) => segment.key === editingSegmentKey)?.label || "segment"}` : "Select customer groups" : "Select eligible products"}
    width="wide"
  >
    <div className="full-rule-picker">
      <div className="full-rule-picker-heading"><div><strong>{pickerView === "customers" ? `${selectedGroupIds.length} selected` : `${selectedStockTargets.length} selected`}</strong><p>{pickerView === "customers" ? editingSegmentKey ? "Selecting a parent group includes all its subgroups. Groups already in another segment can’t be chosen." : "Selecting a parent group includes all its subgroups." : "Selecting a product group includes all products and subgroups below it."}</p></div><Button type="button" onClick={closePicker}>Done</Button></div>
      {pickerView === "customers" ? <>
        <label className="group-search"><Search size={15} /><input autoFocus value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Find a customer group" /></label>
        <div className="rule-editor-group-list rule-tree full-rule-tree">{customerRoots.map((group) => renderCustomerGroup(group))}</div>
      </> : <>
        <label className="group-search"><Search size={15} /><input autoFocus value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="Find a product or product group" /></label>
        <div className="rule-editor-group-list tod-product-list rule-tree full-rule-tree">{stockRoots.map((group) => renderStockGroup(group))}{orphanStockItems.filter((item) => !stockSearch.trim() || labelOf(item, "Product").toLowerCase().includes(stockSearch.trim().toLowerCase())).map((item) => { const key = `stockItem:${item.id}`; const checked = selectedStockTargets.includes(key); return <div className={`rule-tree-row rule-tree-item ${checked ? "selected" : ""}`} key={item.id}><span className="rule-tree-toggle" /><label><input type="checkbox" checked={checked} onChange={() => setSelectedStockTargets((current) => checked ? current.filter((target) => target !== key) : [...current, key])} /><span><strong>{labelOf(item, "Product")}</strong><small>Product</small></span></label></div>; })}</div>
      </>}
    </div>
  </Drawer>;

  return <Drawer
    open={open}
    onClose={onClose}
    title={scheme ? `Edit ${selectedType === "cd" ? "Cash Discount" : "Turnover Discount"} rule` : "Create discount rule"}
    width="wide"
  >
    <form className={`form-stack rule-editor-form ${studio.ruleEditorForm}`} noValidate onSubmit={(event) => {
      event.preventDefault();
      void submit(event.currentTarget);
    }}>
      {editorError?.area === "general" && <InlineMessage tone="error">{editorError.message}</InlineMessage>}
      {!scheme &&
        <div className="rule-type-choice" role="radiogroup" aria-label="Discount type">
          <label className={selectedType === "cd" ? "selected" : ""}>
            <input type="radio" checked={selectedType === "cd"} onChange={() => setRuleType("cd")} />
            <strong>Cash Discount</strong>
            <span>Check invoice payment deadlines.</span>
          </label>
          <label className={selectedType === "tod" ? "selected" : ""}>
            <input type="radio" checked={selectedType === "tod"} onChange={() => setRuleType("tod")} />
            <strong>Turnover Discount</strong>
            <span>Check quantity achieved during a period.</span>
          </label>
        </div>
      }
      <div className="form-grid rule-editor-basics">
        <label className="rule-editor-rule-name">Rule name<input name="name" required value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder={selectedType === "cd" ? "Standard Cash Discount" : "Quarterly Turnover Discount"} /></label>
      </div>
      {!reference && <p className="muted-copy">Update company information from Tally before editing customer groups and eligible products.</p>}

      <section className="rule-editor-section rule-editor-period">
        <h3>Rule dates</h3>
        <div className="form-grid">
          <label>Rule applies from<input type="date" required value={effectiveFrom} onChange={(event) => { setEffectiveFrom(event.target.value); if (selectedType === "tod") setPeriodAnchorDate(event.target.value); }} /></label>
          <label><span>Rule applies until <small>(optional)</small></span><input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></label>
        </div>
        {editorError?.area === "period" && <InlineMessage tone="error">{editorError.message}</InlineMessage>}
      </section>

      {selectedType === "cd" ? <>
        <section className="rule-editor-section cd-segment-section">
          <div className="rule-editor-section-heading">
            <div><h3>Segments</h3><p>Each segment gives its customer groups a payment window and a discount per MT. A group can be in only one segment.</p></div>
            <Button type="button" className="button-secondary rule-editor-add" onClick={() => setSegments((current) => [...current, emptySegment()])}><Plus size={15} />Add segment</Button>
          </div>
          <div className="cd-segment-list">
            {segments.map((segment, index) => <div className="cd-segment-card" key={segment.key}>
              <div className="cd-segment-fields">
                <span className="cd-slab-index">{index + 1}</span>
                <label className="cd-segment-name"><span className="cd-segment-field-label">Segment name <span className="sr-only">{index + 1}</span></span><input value={segment.label} maxLength={80} placeholder="e.g. 3-day customers" onChange={(event) => updateSegment(segment.key, { label: event.target.value })} /></label>
                <label className="cd-segment-days"><span className="cd-segment-field-label">Days <span className="sr-only">for segment {index + 1}</span></span><input type="number" min="1" max="60" value={segment.days} onChange={(event) => updateSegment(segment.key, { days: event.target.value })} /></label>
                <label><span className="cd-segment-field-label">Discount per MT <span className="sr-only">for segment {index + 1}</span></span><div className="input-with-suffix"><input inputMode="decimal" value={segment.amount} placeholder="500" onChange={(event) => updateSegment(segment.key, { amount: event.target.value })} /><span>₹ / MT</span></div></label>
                <IconButton label={`Remove segment ${index + 1}`} disabled={segments.length === 1} onClick={() => setSegments((current) => current.filter((item) => item.key !== segment.key))}><Trash2 size={16} /></IconButton>
              </div>
              <div className="cd-segment-groups">
                <div className="rule-selected-summary" aria-label={`Customer groups in segment ${index + 1}`}>{segment.groupIds.map((id) => <span key={id}>{labelOf(groupsById.get(id) ?? {}, "Unavailable group")}</span>)}{!segment.groupIds.length && <span className="is-empty">No customer groups yet</span>}</div>
                <Button type="button" className="button-secondary rule-editor-add" onClick={() => openSegmentPicker(segment)}><ListTree size={14} />{segment.groupIds.length ? "Change groups" : "Choose groups"}</Button>
              </div>
            </div>)}
          </div>
          <p className="rule-editor-calendar-note">Every day counts from the invoice date; if the last day is a Sunday or a holiday, the deadline moves to the next working day. Invoices go out at full price; a Credit Note gives the discount when the customer pays the discounted amount within the window.</p>
        </section>

        <section className="rule-editor-section tod-edit-section">
          <div className="rule-editor-section-heading"><div><h3>Eligible products</h3><p>The discount is ₹ per MT of these products on the invoice.</p></div><Button type="button" className="button-secondary rule-editor-add" onClick={() => setPickerView("products")}><ListTree size={14} />View all</Button></div>
          <div className="rule-editor-group-picker">
            <label className="group-search"><Search size={15} /><input value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="Find a product or product group" /></label>
            <p className="rule-editor-group-note">Product groups include the products below them.</p><div className="rule-selected-summary" aria-label="Selected products">{selectedStockTargets.map((target) => { const [kind, id] = target.split(":"); const item = (kind === "stockGroup" ? stockGroups : stockItems).find((entry) => entry.id === id); return <span key={target}>{labelOf(item ?? {}, "Unavailable product")}</span>; })}{!selectedStockTargets.length && <span className="is-empty">No products selected</span>}</div>
            <div className="rule-editor-group-list tod-choice-list tod-product-list rule-tree">{stockRoots.map((group) => renderStockGroup(group))}{orphanStockItems.filter((item) => !stockSearch.trim() || labelOf(item, "Product").toLowerCase().includes(stockSearch.trim().toLowerCase())).map((item) => { const key = `stockItem:${item.id}`; const checked = selectedStockTargets.includes(key); return <div className={`rule-tree-row rule-tree-item ${checked ? "selected" : ""}`} key={item.id}><span className="rule-tree-toggle" /><label><input type="checkbox" checked={checked} onChange={() => setSelectedStockTargets((current) => checked ? current.filter((target) => target !== key) : [...current, key])} /><span><strong>{labelOf(item, "Product")}</strong><small>Product</small></span></label></div>; })}</div>
          </div>
        </section>

        {cdConversionRows.length > 0 && <section className="rule-editor-section">
          <div className="rule-editor-section-heading"><div><h3>MT per unit</h3><p>How much one Tally unit of these products weighs in MT.</p></div></div>
          <div className="cd-unit-list">{cdConversionRows.map((row) => <label key={row.unitId} className="cd-unit-row"><span>1 {row.label} =</span><div className="input-with-suffix"><input inputMode="decimal" value={row.factor} placeholder="e.g. 0.05" onChange={(event) => setUnitFactors((current) => ({ ...current, [row.unitId]: event.target.value }))} /><span>MT</span></div>{row.standard && row.factor === row.standard && <small>Standard</small>}</label>)}</div>
        </section>}
      </> : <div className="tod-editor-sections">
        <section className="rule-editor-section">
          <div className="rule-editor-section-heading"><div><h3>Review periods</h3><p>Each customer starts from zero again when a new period begins.</p></div></div>
          <div className="form-grid tod-period-grid">
            <label>Review frequency<select required value={periodMonths} onChange={(event) => setPeriodMonths(event.target.value)}><option value="1">Monthly</option><option value="3">Quarterly (3 months)</option><option value="6">Half-yearly (6 months)</option><option value="12">Annually (12 months)</option></select></label>
            <p className={studio.periodHint}><strong>{reviewFrequencyLabel(parsedPeriodMonths)}</strong><span> · One independent calculation and Credit Note opportunity per period.</span></p>
          </div>
          <div className="tod-period-schedule" aria-label="Generated review periods">
            <div className="tod-period-schedule-heading"><strong>{effectiveTo ? `${periodSchedule.length} review ${periodSchedule.length === 1 ? "period" : "periods"}` : "First review period"}</strong>{!effectiveTo && <span>Repeats until the rule is ended</span>}</div>
            <ol>{periodSchedule.map((period, index) => <li key={period.start}><span>{index + 1}</span><strong>{shortDate(period.start)} – {shortDate(period.end)}</strong>{index === 0 && <small>First period</small>}</li>)}</ol>
          </div>
          <fieldset className={studio.benefitChoice}><legend>Benefit calculation</legend><label className={todBenefitBasis === "amount_per_eligible_tonne" ? studio.benefitOptionSelected : studio.benefitOption}><input type="radio" name="todBenefitBasis" checked={todBenefitBasis === "amount_per_eligible_tonne"} onChange={() => { setTodBenefitBasis("amount_per_eligible_tonne"); setTodTiers((current) => current.map((tier) => ({ ...tier, benefitValue: "" }))); }} /><span><strong>Fixed amount per MT</strong><small>Apply the reached slab rate to the full eligible quantity.</small></span></label><label className={todBenefitBasis === "percentage_of_eligible_value" ? studio.benefitOptionSelected : studio.benefitOption}><input type="radio" name="todBenefitBasis" checked={todBenefitBasis === "percentage_of_eligible_value"} onChange={() => { setTodBenefitBasis("percentage_of_eligible_value"); setTodTiers((current) => current.map((tier) => ({ ...tier, benefitValue: "" }))); }} /><span><strong>Percentage of eligible sales value</strong><small>Apply the reached percentage to eligible sales value before GST.</small></span></label>{editorError?.area === "benefit" && <InlineMessage tone="error">{editorError.message}</InlineMessage>}</fieldset>
        </section>

        <section className="rule-editor-section tod-edit-section">
          <div className="rule-editor-section-heading"><h3>Customer groups</h3><Button type="button" className="button-secondary rule-editor-add" onClick={() => setPickerView("customers")}><ListTree size={14} />View all</Button></div>
          <div className="rule-editor-group-picker">
            <label className="group-search"><Search size={15} /><input value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Find a customer group" /></label>
            <p className="rule-editor-group-note">Selected groups include their subgroups.</p><div className="rule-selected-summary" aria-label="Selected customer groups">{selectedGroupIds.map((id) => <span key={id}>{labelOf(groupsById.get(id) ?? {}, "Unavailable group")}</span>)}{!selectedGroupIds.length && <span>No groups selected</span>}</div>
            <div className="rule-editor-group-list tod-choice-list rule-tree">{customerRoots.map((group) => renderCustomerGroup(group))}</div>
          </div>
        </section>

        <section className="rule-editor-section tod-edit-section">
          <div className="rule-editor-section-heading"><h3>Eligible products</h3><Button type="button" className="button-secondary rule-editor-add" onClick={() => setPickerView("products")}><ListTree size={14} />View all</Button></div>
          <div className="rule-editor-group-picker">
            <label className="group-search"><Search size={15} /><input value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="Find a product or product group" /></label>
            <p className="rule-editor-group-note">Product groups include the products below them.</p><div className="rule-selected-summary" aria-label="Selected products">{selectedStockTargets.map((target) => { const [kind, id] = target.split(":"); const item = (kind === "stockGroup" ? stockGroups : stockItems).find((entry) => entry.id === id); return <span key={target}>{labelOf(item ?? {}, "Unavailable product")}</span>; })}</div>
            <div className="rule-editor-group-list tod-choice-list tod-product-list rule-tree">{stockRoots.map((group) => renderStockGroup(group))}{orphanStockItems.filter((item) => !stockSearch.trim() || labelOf(item, "Product").toLowerCase().includes(stockSearch.trim().toLowerCase())).map((item) => { const key = `stockItem:${item.id}`; const checked = selectedStockTargets.includes(key); return <div className={`rule-tree-row rule-tree-item ${checked ? "selected" : ""}`} key={item.id}><span className="rule-tree-toggle" /><label><input type="checkbox" checked={checked} onChange={() => setSelectedStockTargets((current) => checked ? current.filter((target) => target !== key) : [...current, key])} /><span><strong>{labelOf(item, "Product")}</strong><small>Product</small></span></label></div>; })}</div>
          </div>
        </section>

        <section className="rule-editor-section">
          <div className="rule-editor-section-heading"><div><h3>Discount levels</h3><p>The highest level reached applies to the customer’s full eligible quantity for that period.</p></div><Button type="button" className="button-secondary rule-editor-add" onClick={() => setTodTiers((current) => [...current, emptyTier()])}><Plus size={15} />Add level</Button></div>
          <div className="tod-tier-list"><div className="tod-tier-header"><span /><span>Purchase at least</span><span>{todBenefitBasis === "amount_per_eligible_tonne" ? "Amount" : "Discount"}</span><span /></div>{todTiers.map((tier, index) => <div className="tod-tier-row" key={tier.key}><span className="cd-slab-index">{index + 1}</span><div className="input-with-suffix"><input aria-label={`Minimum MT, level ${index + 1}`} inputMode="decimal" value={tier.minimumTonnes} onChange={(event) => setTodTiers((current) => current.map((item) => item.key === tier.key ? { ...item, minimumTonnes: event.target.value } : item))} /><span>MT</span></div><div className="input-with-suffix"><input aria-label={`Benefit, level ${index + 1}`} inputMode="decimal" value={tier.benefitValue} onChange={(event) => setTodTiers((current) => current.map((item) => item.key === tier.key ? { ...item, benefitValue: event.target.value } : item))} /><span>{todBenefitBasis === "amount_per_eligible_tonne" ? "₹ / MT" : "%"}</span></div><IconButton label={`Remove discount level ${index + 1}`} disabled={todTiers.length === 1} onClick={() => setTodTiers((current) => current.filter((item) => item.key !== tier.key))}><Trash2 size={15} /></IconButton></div>)}</div>
        </section>
      </div>}

      <div className={studio.editorFooter}>
        {scheme && <span className={studio.applyNote}>Saving validates and applies the rule. Its previous version remains in history.</span>}
        <Button type="submit" disabled={busy || (preparingUpdate && unchanged) || Boolean(selectedType === "cd"
          ? !segments.length || segments.some((segment) => !segment.groupIds.length) || !selectedStockTargets.length
          : !selectedGroupIds.length || !selectedStockTargets.length || !todTiers.length)}>{busy ? scheme ? "Saving changes…" : "Creating…" : scheme ? "Save changes" : "Create rule"}</Button>
      </div>
    </form>
  </Drawer>;
}
