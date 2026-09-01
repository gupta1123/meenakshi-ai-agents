"use client";

import { useEffect, useState } from "react";
import { Check, CheckCircle2, Plus, RefreshCw, Search, Trash2, Users } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";

import { useCompany } from "./company-context";
import type { ReferenceData, VersionDetail } from "./types";
import { Button, Drawer, IconButton, Skeleton, labelFor } from "./ui";
import { accessToken } from "./workspace";
import studio from "./rulebook-studio.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  detail: VersionDetail | null;
  reference: ReferenceData | null;
  refreshingReference?: boolean;
  onRefreshReference: () => Promise<void>;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
};

type SaveOperation = { path: string; body: Record<string, unknown>; label: string };
type SavedChoice = { key: string; label: string; path: string; body: Record<string, unknown>; removedMessage: string };
type PendingTier = { id: string; minimumTonnes: string; discountPercentage: string };

function newTier(): PendingTier {
  return { id: globalThis.crypto?.randomUUID?.() ?? `tier-${Date.now()}-${Math.random()}`, minimumTonnes: "", discountPercentage: "" };
}

function standardTonnesFactor(code: string | undefined) {
  const unit = String(code ?? "").trim().toUpperCase().replaceAll(".", "");
  if (["MT", "MTS", "TON", "TONNE", "TONNES"].includes(unit)) return "1";
  if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(unit)) return "0.001";
  if (["G", "GM", "GMS", "GRAM", "GRAMS"].includes(unit)) return "0.000001";
  if (["QTL", "QUINTAL", "QUINTALS"].includes(unit)) return "0.1";
  return null;
}

function textField(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export function GuidedDraftSetupDrawer({ open, onClose, detail, reference, refreshingReference = false, onRefreshReference, onSaved, onError }: Props) {
  const { company } = useCompany();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [pendingGroupIds, setPendingGroupIds] = useState<string[]>([]);
  const [stockTarget, setStockTarget] = useState("");
  const [sourceUomId, setSourceUomId] = useState("");
  const [tonnesPerSourceUnit, setTonnesPerSourceUnit] = useState("");
  const [isBuiltinConversion, setIsBuiltinConversion] = useState(false);
  const [pendingTiers, setPendingTiers] = useState<PendingTier[]>([newTier()]);
  const [setupStep, setSetupStep] = useState<"groups" | "tod" | "review">("groups");

  useEffect(() => {
    setGroupSearch("");
    setPendingGroupIds([]);
    setStockTarget("");
    setSourceUomId("");
    setTonnesPerSourceUnit("");
    setIsBuiltinConversion(false);
    setPendingTiers([newTier()]);
    setSetupStep("groups");
  }, [open, detail?.version.id]);

  if (!detail) return null;

  const { configuration, version } = detail;
  const isTurnoverDiscount = version.schemeType === "tod";
  const groupNames = new Map(reference?.masters.customerGroups.map((item) => [item.id, labelFor(item)]) ?? []);
  const groups = reference?.masters.customerGroups.filter((item) => item.is_available) ?? [];
  const groupsById = new Map(groups.map((item) => [item.id, item]));
  const childGroupIds = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.parent_group_id) continue;
    childGroupIds.set(group.parent_group_id, [...(childGroupIds.get(group.parent_group_id) ?? []), group.id]);
  }
  const groupPath = (groupId: string) => {
    const path: string[] = [];
    const visited = new Set<string>();
    let current = groupsById.get(groupId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(labelFor(current));
      current = current.parent_group_id ? groupsById.get(current.parent_group_id) : undefined;
    }
    return path.join(" › ");
  };
  const descendantIds = (groupId: string) => {
    const result = new Set<string>([groupId]);
    const queue = [groupId];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const childId of childGroupIds.get(current) ?? []) if (!result.has(childId)) { result.add(childId); queue.push(childId); }
    }
    return result;
  };
  const debtorRootIds = groups.filter((group) => labelFor(group).trim().toLowerCase() === "sundry debtors").map((group) => group.id);
  const eligibleGroupIds = new Set<string>();
  for (const rootId of debtorRootIds) for (const id of descendantIds(rootId)) eligibleGroupIds.add(id);
  const eligibleGroups = groups.filter((group) => eligibleGroupIds.has(group.id));
  const availableCustomers = reference?.masters.customers.filter((item) => item.is_available) ?? [];
  const coveredCustomerIds = (groupIds: string[]) => {
    const coveredGroups = new Set<string>();
    for (const groupId of groupIds) for (const id of descendantIds(groupId)) coveredGroups.add(id);
    return new Set(availableCustomers.filter((customer) => customer.current_customer_group_id && coveredGroups.has(customer.current_customer_group_id)).map((customer) => customer.id));
  };
  const savedGroupIds = new Set(configuration.customerGroups.map((item) => item.customer_group_id));
  const savedCoveredGroupIds = new Set<string>();
  for (const groupId of savedGroupIds) for (const id of descendantIds(groupId)) savedCoveredGroupIds.add(id);
  const visibleGroups = eligibleGroups.filter((group) => {
    const query = groupSearch.trim().toLowerCase();
    return !query || groupPath(group.id).toLowerCase().includes(query);
  });
  const savedCustomerCount = coveredCustomerIds([...savedGroupIds]).size;
  const resultingCustomerCount = coveredCustomerIds([...savedGroupIds, ...pendingGroupIds]).size;
  const stockItemNames = new Map(reference?.masters.stockItems.map((item) => [item.id, labelFor(item)]) ?? []);
  const stockGroupNames = new Map(reference?.masters.stockGroups.map((item) => [item.id, labelFor(item)]) ?? []);
  const unitNames = new Map(reference?.masters.units.map((item) => [item.id, labelFor(item)]) ?? []);
  const unitsById = new Map(reference?.masters.units.map((item) => [item.id, item]) ?? []);
  const stockItemsById = new Map(reference?.masters.stockItems.map((item) => [item.id, item]) ?? []);
  const selectedStockItemId = stockTarget.startsWith("stockItem:") ? stockTarget.slice("stockItem:".length) : null;
  const selectedStockItem = selectedStockItemId ? stockItemsById.get(selectedStockItemId) : null;
  const selectedUnit = sourceUomId ? unitsById.get(sourceUomId) : null;
  const automaticFactor = standardTonnesFactor(selectedUnit?.code ?? selectedUnit?.name);
  const savedStockCount = configuration.stockItems.length + configuration.stockGroups.length;
  const savedGroups: SavedChoice[] = configuration.customerGroups.map((item) => ({
    key: `groups:${item.customer_group_id}`,
    label: `${groupNames.get(item.customer_group_id) ?? "Customer group"} · includes subgroups`,
    path: "groups",
    body: { customerGroupId: item.customer_group_id },
    removedMessage: "Customer group removed from this pending update.",
  }));
  const savedStock: SavedChoice[] = [
    ...configuration.stockItems.map((item) => ({ key: `stocks:item:${item.stock_item_id}`, label: `Product · ${stockItemNames.get(item.stock_item_id) ?? "Stock item"}`, path: "stocks", body: { kind: "stockItem", id: item.stock_item_id }, removedMessage: "Product removed from this pending update." })),
    ...configuration.stockGroups.map((item) => ({ key: `stocks:group:${item.stock_group_id}`, label: `Product group · ${stockGroupNames.get(item.stock_group_id) ?? "Stock group"}`, path: "stocks", body: { kind: "stockGroup", id: item.stock_group_id }, removedMessage: "Product group removed from this pending update." })),
  ];
  const savedConversions: SavedChoice[] = configuration.conversions.map((item) => ({ key: `conversions:${item.source_uom_id}`, label: `${unitNames.get(item.source_uom_id) ?? "Tally unit"} · ${item.tonnes_per_source_unit} tonnes`, path: "conversions", body: { sourceUomId: item.source_uom_id }, removedMessage: "Weight conversion removed from this pending update." }));
  const savedTiers: SavedChoice[] = configuration.tiers.map((item) => ({ key: `tiers:${item.id}`, label: `${item.minimum_tonnes} tonnes or more · ${item.discount_percentage}% discount`, path: "tiers", body: { tierId: item.id }, removedMessage: "Discount slab removed from this pending update." }));

  function selectStock(value: string) {
    setStockTarget(value);
    if (!value.startsWith("stockItem:")) {
      setSourceUomId("");
      setTonnesPerSourceUnit("");
      setIsBuiltinConversion(false);
      return;
    }
    const item = stockItemsById.get(value.slice("stockItem:".length));
    const unitId = item?.default_uom_id ?? "";
    const unit = unitId ? unitsById.get(unitId) : null;
    const factor = standardTonnesFactor(unit?.code ?? unit?.name);
    setSourceUomId(unitId);
    setTonnesPerSourceUnit(factor ?? "");
    setIsBuiltinConversion(Boolean(factor));
  }

  function updateTier(id: string, field: "minimumTonnes" | "discountPercentage", value: string) {
    setPendingTiers((current) => current.map((tier) => tier.id === id ? { ...tier, [field]: value } : tier));
  }

  async function saveAddedChoices(form: HTMLFormElement) {
    const token = await accessToken();
    if (!token) return;
    const fields = new FormData(form);
    const selectedStockTarget = textField(fields.get("stock"));
    const selectedSourceUomId = textField(fields.get("uom"));
    const selectedTonnesFactor = textField(fields.get("factor"));
    const isBuiltin = fields.get("builtin") === "true";
    const enteredTiers = pendingTiers.filter((tier) => tier.minimumTonnes || tier.discountPercentage);

    const savingGroups = setupStep === "groups";
    const savingTodDetails = setupStep === "tod";

    if (savingGroups && configuration.customerGroups.length === 0 && pendingGroupIds.length === 0) {
      onError("Choose at least one eligible customer group.");
      return;
    }

    if (isTurnoverDiscount && savingTodDetails && ((selectedSourceUomId && !selectedTonnesFactor) || (!selectedSourceUomId && selectedTonnesFactor))) {
      onError("Choose a Tally unit and enter its weight in tonnes together.");
      return;
    }
    if (isTurnoverDiscount && savingTodDetails && configuration.conversions.length === 0 && (!selectedSourceUomId || !selectedTonnesFactor)) {
      onError("Confirm how the selected product quantity should be converted to tonnes.");
      return;
    }
    if (isTurnoverDiscount && savingTodDetails && enteredTiers.some((tier) => !tier.minimumTonnes || !tier.discountPercentage)) {
      onError("Enter both the purchase quantity and discount for each level.");
      return;
    }
    if (isTurnoverDiscount && savingTodDetails && configuration.tiers.length === 0 && enteredTiers.length === 0) {
      onError("Add at least one discount level.");
      return;
    }

    const operations: SaveOperation[] = [];
    if (savingGroups) {
      for (const groupId of pendingGroupIds) {
        if (!configuration.customerGroups.some((item) => item.customer_group_id === groupId)) operations.push({ path: "groups", body: { customerGroupId: groupId }, label: "customer group" });
      }
    }
    if (isTurnoverDiscount && savingTodDetails && selectedStockTarget) {
      const [kind, id] = selectedStockTarget.split(":");
      const exists = kind === "stockItem" ? configuration.stockItems.some((item) => item.stock_item_id === id) : configuration.stockGroups.some((item) => item.stock_group_id === id);
      if (!exists) operations.push({ path: "stocks", body: { kind, id }, label: "product" });
    }
    if (isTurnoverDiscount && savingTodDetails && selectedSourceUomId && selectedTonnesFactor) {
      const existing = configuration.conversions.find((item) => item.source_uom_id === selectedSourceUomId);
      if (!existing || existing.tonnes_per_source_unit !== selectedTonnesFactor || existing.is_builtin !== isBuiltin) operations.push({ path: "conversions", body: { sourceUomId: selectedSourceUomId, tonnesPerSourceUnit: selectedTonnesFactor, isBuiltin }, label: "quantity conversion" });
    }
    if (isTurnoverDiscount && savingTodDetails) {
      for (const tier of enteredTiers) {
        const existing = configuration.tiers.find((item) => item.minimum_tonnes === tier.minimumTonnes);
        if (!existing || existing.discount_percentage !== tier.discountPercentage) operations.push({ path: "tiers", body: { minimumTonnes: tier.minimumTonnes, discountPercentage: tier.discountPercentage }, label: "discount level" });
      }
    }

    if (!operations.length) {
      setSetupStep(savingGroups && isTurnoverDiscount ? "tod" : "review");
      return;
    }

    setSaving(true);
    try {
      await Promise.all(operations.map((operation) => apiRequest(token, `/api/companies/${company.id}/scheme-versions/${version.id}/${operation.path}`, { method: "POST", body: jsonBody(operation.body) })));
      form.reset();
      setPendingGroupIds([]);
      setGroupSearch("");
      setStockTarget("");
      setSourceUomId("");
      setTonnesPerSourceUnit("");
      setIsBuiltinConversion(false);
      setPendingTiers([newTier()]);
      await onSaved(`${operations.map((operation) => operation.label).join(", ")} saved in this pending update.`);
      setSetupStep(savingGroups && isTurnoverDiscount ? "tod" : "review");
    } catch {
      onError("Could not save these choices.");
    } finally {
      setSaving(false);
    }
  }

  async function removeChoice(choice: SavedChoice) {
    const token = await accessToken();
    if (!token) return;
    setRemoving(choice.key);
    try {
      await apiRequest(token, `/api/companies/${company.id}/scheme-versions/${version.id}/${choice.path}`, { method: "DELETE", body: jsonBody(choice.body) });
      await onSaved(choice.removedMessage);
    } catch {
      onError("Could not remove this choice from the pending update.");
    } finally {
      setRemoving(null);
    }
  }

  return <Drawer open={open} onClose={onClose} title={`Update rule eligibility · Version ${version.versionNumber}`} description="Complete one step at a time. The live rule is unchanged until you check and apply this pending update." width="wide">
    {refreshingReference ? <div className="guided-draft-setup"><section className="draft-setup-overview"><div><p className="eyebrow">Reading Tally</p><h3>Loading the latest customers and products</h3><p>Keep Tally Prime and the Meenakshi connector open.</p></div></section><Skeleton lines={6} /></div> : <div className="guided-draft-setup">
      <section className="draft-setup-overview" aria-labelledby="draft-setup-status">
        <div><p className="eyebrow">Eligibility setup</p><h3 id="draft-setup-status">{setupStep === "groups" ? "Choose customer groups" : setupStep === "tod" ? "Set products and discount levels" : "Review your eligibility choices"}</h3><p>{setupStep === "groups" ? "Select the customers this rule applies to. You can add or remove groups before applying the update." : setupStep === "tod" ? "Choose the products that count, confirm their units, and set the Turnover Discount levels." : "Check the saved choices below, then return to the Rulebook to check and apply the update."}</p></div>
        <div className="draft-setup-checks" aria-label="Rule setup progress"><span className={configuration.customerGroups.length ? "complete" : ""}><CheckCircle2 size={15} />Customers</span>{isTurnoverDiscount && <><span className={savedStockCount ? "complete" : ""}><CheckCircle2 size={15} />Products</span><span className={configuration.conversions.length ? "complete" : ""}><CheckCircle2 size={15} />Weight conversion</span><span className={configuration.tiers.length ? "complete" : ""}><CheckCircle2 size={15} />Discount slabs</span></>}<Button type="button" className="button-secondary" onClick={() => void onRefreshReference()}><RefreshCw size={15} />Refresh from Tally</Button></div>
      </section>
      <div className={studio.editorJourney} aria-label="Rule update steps">
        <div className={studio.editorStep} data-active={setupStep === "groups"}><span>2</span><div><strong>Customer groups</strong><small>Who is covered</small></div></div>
        {isTurnoverDiscount && <div className={studio.editorStep} data-active={setupStep === "tod"}><span>3</span><div><strong>Eligibility</strong><small>Products and levels</small></div></div>}
        <div className={studio.editorStep} data-active={setupStep === "review"}><span>{isTurnoverDiscount ? "4" : "3"}</span><div><strong>Review</strong><small>Check and apply</small></div></div>
      </div>

      <section className="draft-setup-saved" aria-labelledby="saved-draft-setup">
        <div><p className="eyebrow">Current choices</p><h3 id="saved-draft-setup">Included in this pending update</h3><p>Use the remove icon beside any choice you no longer want.</p></div>
        <div className="saved-choice-groups"><SavedChoiceList title="Customer groups" choices={savedGroups} removing={removing} onRemove={removeChoice} />{isTurnoverDiscount && <><SavedChoiceList title="Products" choices={savedStock} removing={removing} onRemove={removeChoice} /><SavedChoiceList title="Weight conversions" choices={savedConversions} removing={removing} onRemove={removeChoice} /><SavedChoiceList title="Discount slabs" choices={savedTiers} removing={removing} onRemove={removeChoice} /></>}</div>
      </section>

      <form key={`${version.id}:${setupStep}:${configuration.customerGroups.length}:${savedStockCount}:${configuration.conversions.length}:${configuration.tiers.length}`} className="guided-draft-form" onSubmit={(event) => { event.preventDefault(); void saveAddedChoices(event.currentTarget); }}>
        <div className="guided-draft-fields">
          {setupStep === "groups" && <section><div className="guided-draft-step"><span>2</span><div><h3>Choose eligible customer groups</h3><p>Select one or more Tally groups. Every customer in each selected group and its subgroups will be included.</p></div></div>
            <div className="customer-group-picker">
              <label className="group-search"><Search size={16} /><input value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Search customer groups" aria-label="Search customer groups" /></label>
              <div className="group-picker-list" role="listbox" aria-multiselectable="true" aria-label="Eligible customer groups">
                {visibleGroups.length ? visibleGroups.map((group) => {
                  const alreadySaved = savedGroupIds.has(group.id);
                  const alreadyCovered = savedCoveredGroupIds.has(group.id);
                  const selected = pendingGroupIds.includes(group.id);
                  const customerCount = coveredCustomerIds([group.id]).size;
                  return <button key={group.id} type="button" role="option" aria-selected={alreadyCovered || selected} disabled={alreadyCovered} className={alreadyCovered ? "is-saved" : selected ? "is-selected" : ""} onClick={() => setPendingGroupIds((current) => {
                    if (current.includes(group.id)) return current.filter((id) => id !== group.id);
                    if (current.some((id) => descendantIds(id).has(group.id))) return current;
                    return [...current.filter((id) => !descendantIds(group.id).has(id)), group.id];
                  })}>
                    <span className="group-picker-check">{alreadyCovered || selected ? <Check size={15} /> : null}</span>
                    <span className="group-picker-copy"><strong>{labelFor(group)}</strong><small>{groupPath(group.id)}</small><em className={customerCount ? "" : "is-empty"}><Users size={13} />{customerCount ? `${customerCount} ${customerCount === 1 ? "customer" : "customers"} · includes subgroups` : "No customers currently · future customers in this group will be included"}</em></span>
                    {alreadyCovered && <span className="group-picker-status">{alreadySaved ? "Already included" : "Covered by parent"}</span>}
                  </button>;
                }) : <p className="group-picker-empty">{debtorRootIds.length ? "No customer groups match this search." : "Sundry Debtors was not found in the latest Tally information. Update company information before choosing customers."}</p>}
              </div>
              <div className="group-picker-summary"><span>{pendingGroupIds.length ? <><strong>{pendingGroupIds.length}</strong> new {pendingGroupIds.length === 1 ? "group" : "groups"} selected</> : <><strong>{savedGroupIds.size}</strong> {savedGroupIds.size === 1 ? "group" : "groups"} saved</>}</span><span><strong>{resultingCustomerCount}</strong> {resultingCustomerCount === 1 ? "customer" : "customers"} covered{pendingGroupIds.length && resultingCustomerCount > savedCustomerCount ? ` after saving (+${resultingCustomerCount - savedCustomerCount})` : ""}</span></div>
            </div>
          </section>}
          {setupStep === "tod" && isTurnoverDiscount && <>
            <section>
              <div className="guided-draft-step"><span>2</span><div><h3>Choose eligible products</h3><p>Select a product or product group whose sales should count towards this discount.</p></div></div>
              <label>Product or product group<select name="stock" value={stockTarget} onChange={(event) => selectStock(event.target.value)} required={savedStockCount === 0}><option value="">{savedStockCount ? "Choose another product" : "Choose a product"}</option>{reference?.masters.stockItems.filter((item) => item.is_available).map((item) => <option key={item.id} value={`stockItem:${item.id}`}>{labelFor(item)}</option>)}{reference?.masters.stockGroups.filter((item) => item.is_available).map((item) => <option key={item.id} value={`stockGroup:${item.id}`}>{labelFor(item)} (product group)</option>)}</select></label>
            </section>
            <section>
              <div className="guided-draft-step"><span>3</span><div><h3>Confirm the quantity</h3><p>Meenakshi calculates turnover discounts in tonnes. Standard Tally units are converted automatically.</p></div></div>
              {selectedStockItem && selectedUnit && automaticFactor ? <div className="quantity-conversion-card is-automatic"><CheckCircle2 size={18} /><div><strong>Automatic conversion</strong><p>Tally records {labelFor(selectedStockItem)} in {labelFor(selectedUnit)}. Meenakshi will convert it to tonnes automatically.</p></div><input type="hidden" name="uom" value={sourceUomId} /><input type="hidden" name="factor" value={tonnesPerSourceUnit} /><input type="hidden" name="builtin" value="true" /></div> : stockTarget ? <div className="quantity-conversion-card"><div><strong>Tell us how this quantity converts to tonnes</strong><p>{stockTarget.startsWith("stockGroup:") ? "Products in this group may use different units. Choose the unit used for this rule." : "This Tally unit does not have a standard tonnes conversion."}</p></div><div className="form-grid"><label>Unit used in Tally<select name="uom" value={sourceUomId} onChange={(event) => { const unitId = event.target.value; const unit = unitsById.get(unitId); const factor = standardTonnesFactor(unit?.code ?? unit?.name); setSourceUomId(unitId); setTonnesPerSourceUnit(factor ?? ""); setIsBuiltinConversion(Boolean(factor)); }}><option value="">Choose a unit</option>{reference?.masters.units.filter((item) => item.is_available).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>One {selectedUnit ? labelFor(selectedUnit) : "unit"} equals<input name="factor" value={tonnesPerSourceUnit} onChange={(event) => { setTonnesPerSourceUnit(event.target.value); setIsBuiltinConversion(false); }} inputMode="decimal" placeholder="Tonnes, e.g. 0.001" /></label><input type="hidden" name="builtin" value={String(isBuiltinConversion)} /></div></div> : <div className="quantity-conversion-card is-muted"><div><strong>{configuration.conversions.length ? "Quantity conversion already saved" : "Choose a product first"}</strong><p>{configuration.conversions.length ? "Choose another product only if you want to add more eligible products." : "The product's Tally unit will be detected automatically."}</p></div></div>}
            </section>
            <section>
              <div className="guided-draft-step"><span>4</span><div><h3>Set discount levels</h3><p>Add the discount customers earn when their eligible purchases reach each quantity.</p></div></div>
              <div className="discount-level-list">{pendingTiers.map((tier, index) => <div className="discount-level-row" key={tier.id}><span className="discount-level-number">{index + 1}</span><label>Purchase at least<input value={tier.minimumTonnes} onChange={(event) => updateTier(tier.id, "minimumTonnes", event.target.value)} inputMode="decimal" placeholder="e.g. 100 tonnes" /></label><label>Customer receives<div className="input-with-suffix"><input value={tier.discountPercentage} onChange={(event) => updateTier(tier.id, "discountPercentage", event.target.value)} inputMode="decimal" placeholder="e.g. 2.5" /><span>% off</span></div></label>{pendingTiers.length > 1 && <IconButton label={`Remove discount level ${index + 1}`} onClick={() => setPendingTiers((current) => current.filter((item) => item.id !== tier.id))}><Trash2 size={15} /></IconButton>}</div>)}</div>
              <Button type="button" className="button-secondary discount-level-add" onClick={() => setPendingTiers((current) => [...current, newTier()])}><Plus size={15} />Add another discount level</Button>
            </section>
          </>}
          {setupStep === "review" && <section className="draft-setup-overview"><div><p className="eyebrow">Next step</p><h3>Check the rule, then apply it</h3><p>The selections above are already saved. Return to the Rulebook, use <strong>Check rule</strong>, resolve any issues, then select <strong>Apply changes</strong>.</p></div><div className="drawer-actions"><Button type="button" className="button-secondary" onClick={() => setSetupStep("groups")}>Edit customer groups</Button>{isTurnoverDiscount && <Button type="button" className="button-secondary" onClick={() => setSetupStep("tod")}>Edit eligibility</Button>}<Button type="button" onClick={() => { onClose(); void onSaved("Eligibility setup is ready for the rule check."); }}>Finish setup</Button></div></section>}
        </div>
        {!reference && <p className="draft-setup-note">Update company information from Tally before changing this pending update.</p>}
        {setupStep !== "review" && <Button type="submit" disabled={!reference || saving}>{saving ? "Saving changes…" : setupStep === "groups" ? "Save customer groups and continue" : "Save eligibility and continue"}</Button>}
      </form>
    </div>}
  </Drawer>;
}

function SavedChoiceList({ title, choices, removing, onRemove }: { title: string; choices: SavedChoice[]; removing: string | null; onRemove: (choice: SavedChoice) => Promise<void> }) {
  return <section><h4>{title}</h4>{choices.length ? <div className="saved-choice-list">{choices.map((choice) => <div key={choice.key}><span>{choice.label}</span><IconButton label={`Remove ${choice.label}`} disabled={removing === choice.key} onClick={() => void onRemove(choice)}><Trash2 size={15} /></IconButton></div>)}</div> : <p>Nothing selected yet</p>}</section>;
}
