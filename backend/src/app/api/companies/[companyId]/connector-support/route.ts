import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  requireMeenakshiCompanyAccess,
  MeenakshiAccessError,
} from "@/lib/authorization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/security";
import {
  prepareSupportRequest,
  supportConnector,
  SupportError,
  newSupportKey,
  interruptConnectorWork,
  recoverSupportSaves,
} from "@/lib/connector-support";
import { auditUserAction } from "@/lib/audit";
type Context = { params: Promise<{ companyId: string }> };
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
export async function GET(r: Request, c: Context) {
  try {
    const { companyId } = await c.params;
    if (!isUuid(companyId)) throw new SupportError("Invalid company.");
    await requireMeenakshiCompanyAccess(r, companyId, [
      "administrator",
      "finance_approver",
    ]);
    const status = await supportConnector(companyId);
    await recoverSupportSaves(companyId);
    const { data: jobs, error } = await createSupabaseAdminClient()
      .from("tally_support_jobs")
      .select(
        "id,operation,status,schemeType:request->>schemeType,diagnosticType:request->>type,savesResults:request->save,progress,error,attempts,created_at,started_at,finished_at",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error)
      throw new SupportError(
        "Apply the connector-support database migration first.",
        503,
      );
    return jsonWithCors(
      r,
      { ...status, jobs:(jobs??[]).map(({schemeType,diagnosticType,savesResults,...job})=>({...job,request:{schemeType,type:diagnosticType,save:savesResults===true}})) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return jsonWithCors(
      r,
      { error: e instanceof Error ? e.message : "Could not load support." },
      {
        status:
          e instanceof MeenakshiAccessError || e instanceof SupportError
            ? e.status
            : 500,
      },
    );
  }
}
export async function POST(r: Request, c: Context) {
  try {
    const { companyId } = await c.params;
    if (!isUuid(companyId)) throw new SupportError("Invalid company.");
    const access = await requireMeenakshiCompanyAccess(r, companyId, [
      "administrator",
      "finance_approver",
    ]);
    const input = await r.json();
    if (
      ["update", "logs", "voucher_test"].includes(input.operation) &&
      !access.roles.includes("administrator")
    )
      throw new SupportError("Administrator access is required.", 403);
    const prepared = await prepareSupportRequest(
      companyId,
      access.userId,
      input,
    );
    const key = r.headers.get("Idempotency-Key") || newSupportKey();
    if (key.length > 160) throw new SupportError("Invalid request key.");
    const db = createSupabaseAdminClient();
    if (prepared.operation === "update")
      await interruptConnectorWork(prepared.connector.id);
    const { data: job, error } = await db
      .from("tally_support_jobs")
      .upsert(
        {
          organization_id: access.organization.id,
          company_id: companyId,
          connector_id: prepared.connector.id,
          requested_by: access.userId,
          operation: prepared.operation,
          request: prepared.request,
          request_key: key,
        },
        { onConflict: "company_id,request_key", ignoreDuplicates: true },
      )
      .select("id,status")
      .maybeSingle();
    if (error) throw error;
    const existing =
      job ??
      (
        await db
          .from("tally_support_jobs")
          .select("id,status")
          .eq("company_id", companyId)
          .eq("request_key", key)
          .single()
      ).data;
    await auditUserAction(access, {
      action: "connector_support_requested",
      entityType: "tally_support_job",
      entityId: existing!.id,
      newValue: { operation: prepared.operation },
    });
    return jsonWithCors(r, { job: existing }, { status: 202 });
  } catch (e) {
    return jsonWithCors(
      r,
      {
        error:
          e instanceof Error ? e.message : "Could not start support operation.",
      },
      {
        status:
          e instanceof MeenakshiAccessError || e instanceof SupportError
            ? e.status
            : 500,
      },
    );
  }
}
