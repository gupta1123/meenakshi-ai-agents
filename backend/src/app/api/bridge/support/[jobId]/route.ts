import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { bridgeSupportAccess } from "@/lib/bridge-support";
import {
  SupportError,
  finishSupportCalculation,
} from "@/lib/connector-support";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/security";
type C = { params: Promise<{ jobId: string }> };
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
export async function POST(r: Request, c: C) {
  try {
    const { jobId } = await c.params;
    if (!isUuid(jobId)) throw new SupportError("Invalid support job.");
    const body = await r.json();
    const connector = await bridgeSupportAccess(r, body.connectorId);
    const db = createSupabaseAdminClient();
    const { data: job, error } = await db
      .from("tally_support_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("connector_id", connector.id)
      .single();
    if (error || !job) throw new SupportError("Operation not found.", 404);
    if (job.status === "succeeded" && job.attempts === body.attempt)
      return jsonWithCors(r, { ok: true });
    if (
      job.status === "received" &&
      job.attempts === body.attempt &&
      body.action === "progress"
    )
      return jsonWithCors(r, { ok: true });
    if (
      job.status !== "running" ||
      job.cancel_requested ||
      job.attempts !== body.attempt ||
      !job.lease_expires_at ||
      Date.parse(job.lease_expires_at) < Date.now()
    )
      throw new SupportError("Operation ownership expired.", 409);
    if (body.action === "progress") {
      if (body.progress && JSON.stringify(body.progress).length > 10000)
        throw new SupportError("Progress is too large.");
      const { data, error } = await db
        .from("tally_support_jobs")
        .update({
          lease_expires_at: new Date(Date.now() + 90000).toISOString(),
          ...(body.progress ? { progress: body.progress } : {}),
        })
        .eq("id", jobId)
        .eq("status", "running")
        .eq("attempts", body.attempt)
        .select("cancel_requested")
        .maybeSingle();
      if (error) throw error;
      return jsonWithCors(r, {
        ok: true,
        cancelRequested: !data || data.cancel_requested,
      });
    }
    if (body.action === "fail") {
      const { error } = await db
        .from("tally_support_jobs")
        .update({
          status: "failed",
          error: String(body.error || "Operation failed").slice(0, 1000),
          finished_at: new Date().toISOString(),
          lease_expires_at: null,
        })
        .eq("id", jobId)
        .eq("status", "running")
        .eq("attempts", body.attempt);
      if (error) throw error;
      return jsonWithCors(r, { ok: true });
    }
    if (
      body.action !== "finish" ||
      !body.result ||
      JSON.stringify(body.result).length > 24000000
    )
      throw new SupportError("Invalid support result.");
    // Fence a finish against cancellation, lease expiry and simultaneous completion.
    const { data: owned, error: oe } = await db
      .from("tally_support_jobs")
      .update({
        status: "received",
        result: body.result,
        lease_expires_at: new Date(Date.now() + 180000).toISOString(),
      })
      .eq("id", jobId)
      .eq("status", "running")
      .eq("cancel_requested", false)
      .eq("attempts", body.attempt)
      .gt("lease_expires_at", new Date().toISOString())
      .select("id")
      .maybeSingle();
    if (oe) throw oe;
    if (!owned)
      throw new SupportError(
        "Operation was stopped before its result arrived.",
        409,
      );
    try {
      const result =
        job.operation === "recalculate"
          ? await finishSupportCalculation(job, body.result)
          : body.result;
      const { error } = await db
        .from("tally_support_jobs")
        .update({
          status: "succeeded",
          result,
          lease_expires_at: null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("status", "received")
        .eq("attempts", body.attempt);
      if (error) throw error;
    } catch (error) {
      // Captured evidence survives a save error; retrying the save never reads Tally.
      await db
        .from("tally_support_jobs")
        .update({
          status: "failed",
          lease_expires_at: null,
          error:
            error instanceof Error ? error.message : "Could not save evidence.",
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("status", "received");
      throw error;
    }
    return jsonWithCors(r, { ok: true });
  } catch (e) {
    return jsonWithCors(
      r,
      {
        error:
          e instanceof Error
            ? e.message
            : "Could not finish support operation.",
      },
      { status: e instanceof SupportError ? e.status : 500 },
    );
  }
}
