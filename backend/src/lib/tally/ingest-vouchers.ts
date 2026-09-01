import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type VoucherResult = {
  syncRunId?: unknown;
  activeCompany?: { guid?: unknown; name?: unknown };
  complete?: unknown;
  vouchers?: unknown;
  cursorFrom?: unknown;
  cursorTo?: unknown;
};

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function normalizeVoucherResult(result: VoucherResult) {
  return {
    syncRunId: result.syncRunId,
    activeCompany: result.activeCompany,
    complete: result.complete,
    cursorFrom: result.cursorFrom,
    cursorTo: result.cursorTo,
    vouchers: records(result.vouchers).map((voucher) => ({
      guid: voucher.guid,
      master_id: voucher.masterId,
      alter_id: voucher.alterId,
      voucher_number: voucher.voucherNumber,
      voucher_kind: voucher.voucherKind,
      voucher_type_guid: voucher.voucherTypeGuid,
      voucher_type_name: voucher.voucherTypeName,
      voucher_date: voucher.voucherDate,
      party_ledger_guid: voucher.partyLedgerGuid,
      party_ledger_name: voucher.partyLedgerName,
      linked_sales_voucher_guid: voucher.linkedSalesVoucherGuid,
      status: voucher.status,
      gross_amount: voucher.grossAmount,
      narration: voucher.narration,
      source_payload: object(voucher.sourcePayload),
      inventory_lines: records(voucher.inventoryLines).map((line) => ({
        line_number: line.lineNumber,
        stock_item_guid: line.stockItemGuid,
        stock_group_guid: line.stockGroupGuid,
        stock_item_name: line.stockItemName,
        stock_group_name: line.stockGroupName,
        uom_code: line.uomCode,
        quantity: line.quantity,
        taxable_product_value: line.taxableProductValue,
        freight_value: line.freightValue,
        non_product_value: line.nonProductValue,
        line_category: line.lineCategory,
        quantity_is_reliable: line.quantityIsReliable,
        source_payload: object(line.sourcePayload),
      })),
      bill_allocations: records(voucher.billAllocations).map((allocation) => ({
        allocation_key: allocation.allocationKey,
        bill_reference: allocation.billReference,
        allocation_type: allocation.allocationType,
        allocation_date: allocation.allocationDate,
        allocated_amount: allocation.allocatedAmount,
        target_voucher_guid: allocation.targetVoucherGuid,
        target_voucher_number: allocation.targetVoucherNumber,
        source_payload: object(allocation.sourcePayload),
      })),
    })),
  };
}

export async function applyVoucherSyncResult(input: { syncRunId: string; companyId: string; result: unknown }) {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) throw new Error("A voucher sync result object is required.");
  const result = input.result as VoucherResult;
  if (result.syncRunId !== input.syncRunId || result.complete !== true || !Array.isArray(result.vouchers)) {
    throw new Error("The voucher sync result is incomplete or belongs to a different sync run.");
  }
  if (!isUuid(input.syncRunId) || !isUuid(input.companyId)) throw new Error("Invalid voucher sync identifiers.");
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("apply_meenakshi_voucher_sync_result", {
    p_sync_run_id: input.syncRunId,
    p_company_id: input.companyId,
    p_result: normalizeVoucherResult(result),
  });
  if (error) throw error;
  const { data: reconciliation, error: reconciliationError } = await supabase.rpc("reconcile_meenakshi_verified_note_postings", {
    p_company_id: input.companyId,
  });
  if (reconciliationError) throw reconciliationError;
  const { data: targetedReconciliation, error: targetedReconciliationError } = await supabase.rpc("reconcile_meenakshi_targeted_note_sync", {
    p_company_id: input.companyId,
    p_sync_run_id: input.syncRunId,
  });
  if (targetedReconciliationError) throw targetedReconciliationError;
  const generalReconciliation = reconciliation as { creditNotesFlagged?: number; debitNotesFlagged?: number } | null;
  const targeted = targetedReconciliation as { creditNotesFlagged?: number; debitNotesFlagged?: number; skipped?: boolean } | null;
  return {
    ...(data as { syncRunId: string; recordsReceived: number; recordsApplied: number; fingerprint: string; alreadyApplied: boolean; nextSyncRunId?: string | null; nextCursor?: string | null }),
    reconciliation: {
      creditNotesFlagged: Number(generalReconciliation?.creditNotesFlagged ?? 0) + Number(targeted?.creditNotesFlagged ?? 0),
      debitNotesFlagged: Number(generalReconciliation?.debitNotesFlagged ?? 0) + Number(targeted?.debitNotesFlagged ?? 0),
      targeted: targeted?.skipped !== true,
    },
  };
}

export async function markVoucherSyncFailed(input: { syncRunId: string; companyId: string; failureReason: string }) {
  if (!isUuid(input.syncRunId) || !isUuid(input.companyId)) return;
  const { error } = await createSupabaseAdminClient()
    .from("tally_sync_runs")
    .update({ status: "failed", error_summary: input.failureReason.slice(0, 2_000), completed_at: new Date().toISOString() })
    .eq("id", input.syncRunId)
    .eq("company_id", input.companyId)
    .in("status", ["queued", "running"]);
  if (error) throw error;
}
