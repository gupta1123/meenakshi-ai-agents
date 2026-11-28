import { gunzipSync } from "node:zlib";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  requireMeenakshiCompanyAccess,
  MeenakshiAccessError,
} from "@/lib/authorization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/security";
import {
  SupportError,
  finishSupportCalculation,
  recoverSupportSaves,
} from "@/lib/connector-support";
type C = { params: Promise<{ companyId: string; jobId: string }> };
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
async function access(r: Request, c: C) {
  const p = await c.params;
  if (!isUuid(p.companyId) || !isUuid(p.jobId))
    throw new SupportError("Invalid job.");
  const scope = await requireMeenakshiCompanyAccess(r, p.companyId, [
    "administrator",
    "finance_approver",
  ]);
  return { ...p, scope };
}
export async function GET(r: Request, c: C) {
  try {
    const p = await access(r, c);
    await recoverSupportSaves(p.companyId);
    const db = createSupabaseAdminClient();
    if (new URL(r.url).searchParams.get("statusOnly") === "1") {
      const { data: job, error } = await db.from("tally_support_jobs")
        .select("id,status,error").eq("company_id", p.companyId).eq("id", p.jobId).maybeSingle();
      if (error) throw error;
      if (!job) throw new SupportError("Support job not found.", 404);
      return jsonWithCors(r, { job }, { headers: { "Cache-Control": "no-store" } });
    }
    const { data: job, error } = await db
      .from("tally_support_jobs")
      .select("*")
      .eq("company_id", p.companyId)
      .eq("id", p.jobId)
      .maybeSingle();
    if (error) throw error;
    if (!job) throw new SupportError("Support job not found.", 404);
    if (job.operation === "logs") {
      if (!p.scope.roles.includes("administrator"))
        throw new SupportError(
          "Administrator access is required to view logs.",
          403,
        );
      if (job.result?.id) {
        const { data: upload, error: ue } = await db
          .from("connector_log_uploads")
          .select("storage_path")
          .eq("id", job.result.id)
          .eq("connector_id", job.connector_id)
          .eq("organization_id", p.scope.organization.id)
          .single();
        if (ue) throw ue;
        const { data: blob, error: be } = await db.storage
          .from("connector-logs")
          .download(upload.storage_path);
        if (be) throw be;
        try {
          const text = gunzipSync(Buffer.from(await blob.arrayBuffer()), {
            maxOutputLength: 12000000,
          }).toString("utf8");
          job.result.logs =
            (text.length > 2000000
              ? "[Earlier lines omitted for display]\n"
              : "") + text.slice(-2000000);
        } catch {
          job.result.logs =
            "The uploaded log is too large to display. Open the log folder on the connector PC.";
        }
      }
    }
    return jsonWithCors(
      r,
      { job },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return jsonWithCors(
      r,
      { error: e instanceof Error ? e.message : "Could not load operation." },
      {
        status:
          e instanceof MeenakshiAccessError || e instanceof SupportError
            ? e.status
            : 500,
      },
    );
  }
}
export async function POST(r: Request, c: C) {
  try {
    const p = await access(r, c),
      input = await r.json(),
      db = createSupabaseAdminClient();
    const { data: job, error } = await db
      .from("tally_support_jobs")
      .select("*")
      .eq("company_id", p.companyId)
      .eq("id", p.jobId)
      .single();
    if (error || !job) throw new SupportError("Support job not found.", 404);
    if (
      ["logs", "update"].includes(job.operation) &&
      !p.scope.roles.includes("administrator")
    )
      throw new SupportError("Administrator access is required.", 403);
    if (input.action === "cancel") {
      const { error } = await db
        .from("tally_support_jobs")
        .update({
          cancel_requested: true,
          status: "cancelled",
          finished_at: new Date().toISOString(),
        })
        .eq("company_id", p.companyId)
        .eq("id", p.jobId)
        .in("status", ["queued", "running"]);
      if (error) throw error;
      return jsonWithCors(r, { ok: true });
    }
    if (
      !["replay", "retry-save"].includes(input.action) ||
      job.operation !== "recalculate" ||
      !job.result ||
      ["queued", "running", "received"].includes(job.status)
    )
      throw new SupportError(
        "Only a finished, captured calculation can be replayed.",
      );
    const saving = input.action === "retry-save";
    if (saving) {
      if (job.status !== "failed" || !job.request.save)
        throw new SupportError("Only a failed save can be retried.", 409);
      const { data: owned, error } = await db
        .from("tally_support_jobs")
        .update({
          status: "received",
          lease_expires_at: new Date(Date.now() + 180000).toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "failed")
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!owned)
        throw new SupportError("This save is already being retried.", 409);
    }
    try {
      const result = await finishSupportCalculation(
        { ...job, request: { ...job.request, save: saving } },
        job.result,
      );
      if (saving) {
        const { error } = await db
          .from("tally_support_jobs")
          .update({
            status: "succeeded",
            result,
            error: null,
            finished_at: new Date().toISOString(),
            lease_expires_at: null,
          })
          .eq("company_id", p.companyId)
          .eq("id", p.jobId)
          .eq("status", "received");
        if (error) throw error;
      }
      return jsonWithCors(r, { result, replayed: true, tallyReads: 0 });
    } catch (error) {
      if (saving)
        await db
          .from("tally_support_jobs")
          .update({
            status: "failed",
            lease_expires_at: null,
            error: error instanceof Error ? error.message : "Saving failed.",
          })
          .eq("id", job.id)
          .eq("status", "received");
      throw error;
    }
  } catch (e) {
    return jsonWithCors(
      r,
      { error: e instanceof Error ? e.message : "Could not change operation." },
      {
        status:
          e instanceof MeenakshiAccessError || e instanceof SupportError
            ? e.status
            : 500,
      },
    );
  }
}
