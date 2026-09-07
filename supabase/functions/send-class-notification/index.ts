import { withSupabase } from "@supabase/server";
import { withAdminCors } from "../_shared/cors.ts";
import {
  buildEventDraft, ContractError, type NotificationRequest, parseNotificationRequest, REQUEST_MAX_BYTES,
  type BackendClient, createBudget, bounded, durableRpc, RpcFailure, UUID_PATTERN,
} from "../_shared/notification-contract.ts";

type SupabaseClientLike = { from: (table: string) => any };
function safeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
async function readRequest(req: Request): Promise<NotificationRequest> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_MAX_BYTES) {
    throw new ContractError(413, "request_too_large", "Request body is too large");
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  return parseNotificationRequest(req.method, req.headers.get("content-type"), bytes);
}

async function loadAuthoritativeSource(client: SupabaseClientLike, request: NotificationRequest) {
  if (request.eventType === "schedule" || request.eventType === "memo") {
    const { data, error } = await client
      .from("class_profile")
      .select("useful_info")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new ContractError(502, "source_read_failed", "Authoritative source could not be read");
    if (!data) throw new ContractError(404, "source_not_found", "Class profile was not found");
    return { usefulInfo: data.useful_info };
  }

  const { data, error } = await client
    .from("chat_messages")
    .select("id, body, is_pinned, archived_at")
    .eq("id", request.sourceId)
    .eq("is_pinned", true)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new ContractError(502, "source_read_failed", "Authoritative source could not be read");
  if (!data) throw new ContractError(404, "announcement_not_eligible", "Pinned active announcement was not found");
  return { announcement: data };
}


export async function handleAdminRequest(req: Request, ctx: {
  supabase: SupabaseClientLike & { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> };
  supabaseAdmin: BackendClient;
  userClaims?: { id?: string };
}): Promise<Response> {
  const budget = createBudget(12_000);
  try {
    const createdBy = ctx.userClaims?.id;
    if (!createdBy || !UUID_PATTERN.test(createdBy)) return safeJson(401, { ok: false, error: "authenticated_user_required" });
    const access = await bounded(() => ctx.supabase.rpc("can_access_budget"), Math.min(3_000, budget.remaining()));
    if (access.error) return safeJson(503, { ok: false, error: "authorization_unavailable" });
    if (access.data !== true) return safeJson(403, { ok: false, error: "class_access_required" });
    const admin = await bounded(() => ctx.supabase.rpc("is_admin"), Math.min(3_000, budget.remaining()));
    if (admin.error) return safeJson(503, { ok: false, error: "authorization_unavailable" });
    if (admin.data !== true) return safeJson(403, { ok: false, error: "administrator_required" });
    const request = await bounded(() => readRequest(req), Math.min(2_000, budget.remaining()));
    const authoritative = await bounded(() => loadAuthoritativeSource(ctx.supabase, request),
      Math.min(3_000, budget.remaining()));
    const draft = await buildEventDraft(request, authoritative);
    // The ONLY privileged mutation in this HTTP lifecycle. Payload and identity
    // come from authenticated DB sources; SQL compares exact duplicate fields.
    const [row] = await durableRpc(ctx.supabaseAdmin, "enqueue_notification_dispatch", {
      p_event_key: draft.eventKey, p_event_type: draft.eventType, p_title: draft.title, p_body: draft.body,
      p_source_entity: draft.sourceEntity, p_source_entity_id: draft.sourceEntityId,
      p_deep_link: draft.deepLink, p_created_by: createdBy,
    }, budget, 500);
    if (row.disposition === "created" && (row.job_stage !== "ready" || row.event_status !== "queued")) {
      throw new ContractError(502, "durable_rpc_contract_invalid");
    }
    const identity = { jobId: row.job_id, eventId: row.event_id, duplicate: row.disposition === "existing" };
    if (row.job_stage === "blocked") return safeJson(503, { ok: false, ...identity, error: "dispatch_blocked" });
    if (row.event_status === "failed") return safeJson(409, { ok: false, ...identity, error: "event_delivery_failed" });
    return safeJson(row.job_stage === "completed" ? 200 : 202, {
      ok: true, ...identity, jobStage: row.job_stage, eventStatus: row.event_status,
      accepted: true, alreadySent: row.job_stage === "completed" && row.event_status === "sent",
    });
  } catch (error) {
    if (error instanceof RpcFailure && ["EVENT_CONFLICT", "EVENT_WITHOUT_DISPATCH_JOB"].includes(error.dbCode ?? "")) {
      return safeJson(409, { ok: false, error: "event_conflict" });
    }
    return safeJson(error instanceof ContractError ? error.status : 500, {
      ok: false, error: error instanceof ContractError ? error.code : "notification_failed",
    });
  }
}
// JWT verification remains the pinned SDK's responsibility. Membership/admin
// authorization above is trusted DB state, never user_metadata.
export default { fetch: withAdminCors(withSupabase({ auth: "user", cors: "disabled" }, handleAdminRequest)) };
