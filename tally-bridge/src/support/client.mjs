import { runDiagnostic, resolveSupportCustomers } from "./diagnostics.mjs";
import { runVoucherTest } from "./voucher-test.mjs";
import { runCompanyOverview } from "./company-overview.mjs";
import { runTallyPorts } from "./tally-ports.mjs";
import { sameTallyCompany } from "../tally/company-identity.mjs";
import { runCheckJob } from "../server-jobs.mjs";
import { sendLogDays } from "../log-upload.mjs";
import { listLogDays } from "../connector-log.mjs";
import {
  recordRuntimeActivity,
  recordRuntimeHeartbeat,
} from "../runtime-status.mjs";
import { sendHeartbeat } from "../api-client.mjs";
import { BRIDGE_VERSION } from "../version.mjs";

export async function supportRequest(config, path, body) {
  const r = await fetch(
    config.apiBase.replace(/\/$/, "") + "/api/bridge/support" + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-bridge-token": config.controlToken,
        "content-type": "application/json",
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify({ ...body, connectorId: config.connectorId }),
          }),
      signal: AbortSignal.timeout(120000),
    },
  );
  const result = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(result.error || "Support request failed."), {
      status: r.status,
    });
  return result;
}

export async function processSupportJob(
  config,
  activeCompany,
  { update, snapshot, resolveTarget } = {},
  deps = {},
) {
  const api = deps.api ?? supportRequest;
  const { job } = await api(
    config,
    "/next?connectorId=" + encodeURIComponent(config.connectorId),
  );
  if (!job) return false;
  if (resolveTarget && job.expectedTallyCompany?.guid && ["diagnostic", "recalculate", "voucher_test"].includes(job.operation) && !["company_overview", "tally_ports"].includes(job.request?.type)) {
    // The Tally program that has the approved company open may be on another port.
    const target = await resolveTarget(job.expectedTallyCompany).catch(() => null);
    if (target) { config = target.config; activeCompany = target.activeCompany; }
  }
  let cancelled = false,
    pendingProgress = null,
    progressFlight = null,
    heartbeatAt = Date.now();
  const renew = () => {
    if (progressFlight) return progressFlight;
    const progress = pendingProgress;
    pendingProgress = null;
    progressFlight = api(config, "/" + job.id, {
      action: "progress",
      attempt: job.attempts,
      ...(progress ? { progress } : {}),
    })
      .then(async (r) => {
        cancelled ||= Boolean(r.cancelRequested);
        if (snapshot && Date.now() - heartbeatAt >= 20000) {
          heartbeatAt = Date.now();
          const cloud = await (deps.heartbeat ?? sendHeartbeat)(
            config,
            BRIDGE_VERSION,
            snapshot,
          ).catch(() => null);
          if (cloud) recordRuntimeHeartbeat(snapshot, cloud);
        }
      })
      .catch(() => {
        cancelled = true;
      })
      .finally(() => {
        progressFlight = null;
      });
    return progressFlight;
  };
  const context = {
    config,
    activeCompany,
    isCancelled: () => cancelled,
    onProgress: (progress) => {
      pendingProgress = progress;
      void renew();
    },
  };
  const timer = setInterval(() => {
    void renew();
  }, 10000);
  timer.unref?.();
  recordRuntimeActivity("Remote " + job.operation);
  try {
    let result;
    if (job.operation === "diagnostic" && job.request?.type === "company_overview") {
      // Read-only month counts of whichever company is open (no customer, no amounts).
      if (!activeCompany && !job.request.port) throw new Error("No Tally company is open.");
      result = await (deps.companyOverview ?? runCompanyOverview)(job.request, context);
    } else if (job.operation === "voucher_test") {
      result = await (deps.voucherTest ?? runVoucherTest)(job.request, context);
    } else if (job.operation === "diagnostic" && job.request?.type === "tally_ports") {
      result = await (deps.tallyPorts ?? runTallyPorts)(job.request, context);
    } else if (["diagnostic", "recalculate"].includes(job.operation)) {
      if (!activeCompany || !sameTallyCompany(job.expectedTallyCompany, activeCompany))
        throw new Error("The approved Tally company is not open.");
      if (job.operation === "diagnostic")
        result = await (deps.diagnostic ?? runDiagnostic)(job.request, context);
      else {
        const results = [];
        for (const body of job.request.bodies) {
          if (cancelled) throw new Error("Calculation stopped.");
          const customers = body.voucherScope.diagnosticTargeted
            ? await (deps.resolveCustomers ?? resolveSupportCustomers)(
                body.voucherScope.customers,
                { ...context, pauseMs: job.request.pauseMs },
              )
            : body.voucherScope.customers;
          results.push(
            await (deps.calculate ?? runCheckJob)(
              {
                kind: job.request.schemeType,
                expectedTallyCompany: job.expectedTallyCompany,
                request: {
                  body: {
                    ...body,
                    voucherScope: {
                      ...body.voucherScope,
                      customers,
                      evaluationRunId: job.id,
                    },
                  },
                },
              },
              {
                ...context,
                onProgress: context.onProgress,
                betweenWindows: () =>
                  new Promise((r) =>
                    setTimeout(r, job.request.pauseMs ?? 2000),
                  ),
              },
            ),
          );
        }
        result = { calculations: results };
      }
    } else if (job.operation === "logs") {
      result = await sendLogDays(
        config,
        job.request.days?.length
          ? job.request.days
          : listLogDays()
              .slice(0, 2)
              .map((d) => d.day),
      );
    } else if (job.operation === "update") {
      if (!update) throw new Error("This connector cannot stage an update.");
      result = await update(job.request);
    } else throw new Error("Unsupported support operation.");
    clearInterval(timer);
    if (progressFlight) await progressFlight;
    if (cancelled) throw new Error("Operation stopped.");
    const afterFinish = result?.afterFinish;
    if (afterFinish) delete result.afterFinish;
    await api(config, "/" + job.id, {
      action: "finish",
      attempt: job.attempts,
      result,
    });
    afterFinish?.();
  } catch (error) {
    await api(config, "/" + job.id, {
      action: "fail",
      attempt: job.attempts,
      error: error.message,
    }).catch(() => {});
  } finally {
    clearInterval(timer);
    recordRuntimeActivity("Waiting for work");
  }
  return true;
}
