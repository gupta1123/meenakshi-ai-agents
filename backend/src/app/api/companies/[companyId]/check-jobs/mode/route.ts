import { auditUserAction } from "@/lib/audit";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { describeServerReadiness } from "@/lib/check-jobs";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Does this company's Tally connector run on a PC (the page talks to it directly)
 * or on a server (the page queues checks in the cloud)? Database failures are
 * reported so the page cannot silently route a server check to a PC.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);

    const db=createSupabaseAdminClient();
    const {data:binding,error:be}=await db.from("tally_connector_company_bindings").select("connector_id").eq("company_id",access.company.id).eq("is_active",true).maybeSingle();
    if(be)throw be;
    if(!binding)return jsonWithCors(request,{mode:"pc",observedMode:null,modeMismatch:false,connectorOnline:false,lastSeenAt:null,readiness:"connector_offline",message:"No connector is linked."});
    const {data:modeRow,error:me}=await db.from("tally_connector_modes").select("mode").eq("connector_id",binding.connector_id).maybeSingle();if(me)throw me;
    const {data:connector,error:ce}=await db.from("tally_connectors").select("last_heartbeat_at,last_tally_reachable,last_company_loaded,last_company_name").eq("id",binding.connector_id).single();if(ce)throw ce;
    const {data:runtimeRow}=await db.from("tally_connectors").select("runtime").eq("id",binding.connector_id).maybeSingle();
    const runtime=runtimeRow?.runtime??{};
    // Every company the server has open, so a company is ready if it is among them, whichever port it is on.
    const {data:openRows,error:oe}=await db.from("tally_connector_company_observations").select("tally_company_guid,tally_company_name,tally_books_from").eq("connector_id",binding.connector_id).eq("is_available",true);if(oe)throw oe;
    const openCompanies=(openRows??[]).map((row)=>({guid:row.tally_company_guid as string,name:row.tally_company_name as string,booksFrom:row.tally_books_from as string|null}));
    const mode=modeRow?.mode==="server"?"server":"pc",observedMode=runtime.mode??null;
    const readiness=describeServerReadiness({lastSeenAt:connector.last_heartbeat_at,tallyReachable:connector.last_tally_reachable,
      companyLoaded:connector.last_company_loaded,activeCompanyName:connector.last_company_name,expectedCompanyName:access.company.tally_company_name??null,
      openCompanies,expectedCompany:{guid:access.company.tally_company_guid,name:access.company.tally_company_name,booksFrom:access.company.tally_books_from}});
    return jsonWithCors(request,{mode,observedMode,modeMismatch:observedMode!==null&&mode!==observedMode,
      runtime,connectorOnline:readiness.state!=="connector_offline",lastSeenAt:connector.last_heartbeat_at,readiness:readiness.state,
      message:observedMode!==null&&mode!==observedMode?"Website and connector modes differ. Finish server setup from the connector's menu.":readiness.message});

  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read Tally mode:", error);
    return jsonWithCors(request, { error: "Could not read the Tally mode." }, { status: 500 });
  }
}

/**
 * Administrators switch the company's connector between PC and server mode.
 * Blocked while checks are queued or running, because a switch would strand them.
 * The connector program must also be set to the same mode on its machine.
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const body = await request.json().catch(() => ({})) as { mode?: unknown };
    if (body.mode !== "pc" && body.mode !== "server") return jsonWithCors(request, { error: "mode must be pc or server." }, { status: 400 });
    const db = createSupabaseAdminClient();
    const { data, error } = await db.rpc("set_tally_connector_mode_v2", { p_company_id: access.company.id, p_mode: body.mode });
    if (error) {
      if (error.code === "P0001") return jsonWithCors(request, { error: error.message }, { status: 409 });
      throw error;
    }
    const changed = data as { connectorId: string; previousMode: string };
    await auditUserAction(access, {
      action: "tally_mode_changed", entityType: "tally_connector", entityId: changed.connectorId,
      previousValue: { mode: changed.previousMode }, newValue: { mode: body.mode },
    });
    return jsonWithCors(request, { mode: body.mode });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not change Tally mode:", error);
    return jsonWithCors(request, { error: "Could not change the Tally mode." }, { status: 500 });
  }
}
