import { withSupabase } from "@supabase/server";
import {
  bounded, ContractError, contractInvalid, createBudget, durableRpc, requireMatch, RpcFailure,
  type BackendClient, type Budget, type RpcRow, type ProviderResult,
  classifyHttpStatus, classifyPushError, UUID_PATTERN, REQUEST_MAX_BYTES,
} from "../_shared/notification-contract.ts";
import { loadVapidConfig, sendWebPush } from "../_shared/web-push.ts";

export const INVOCATION_BUDGET_MS = 45_000;
export const MAX_CONCURRENCY = 5;
export const MAX_BATCH = 25;
export const MAX_PROVIDER_TIMEOUT_MS = 8_000;
export const FINALIZATION_RESERVE_MS = 11_000;
const RECORD_RESERVE_MS = 4_000;
const BEGIN_RESERVE_MS = 4_000;
const SETTLE_RESERVE_MS = 7_000;

type WorkerOptions = {
  jobId?: string;
  budget?: Budget;
  readEnv?: (name: string) => string | undefined;
  send?: typeof sendWebPush;
  wallNow?: () => number;
};
type Tracked = { row: RpcRow; state: "prepared" | "begin_unknown" | "permit" | "done" | "released" };
type Reason = "yield" | "transient_backend" | "configuration_blocked";
function failureReason(error: unknown): Reason {
  if (error instanceof ContractError && ["durable_rpc_contract_invalid", "rpc_abort_api_unavailable"].includes(error.code)) {
    return "configuration_blocked";
  }
  if (error instanceof RpcFailure && error.dbCode === "EVENT_CONFLICT") return "configuration_blocked";
  return "transient_backend";
}
function string(row: RpcRow, key: string): string { return row[key] as string; }
function number(row: RpcRow, key: string): number { return row[key] as number; }
async function concurrent<T>(items: T[], fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
}
function sameState(rows: RpcRow[], jobId?: string, batchId?: string): { job?: RpcRow; attempts: RpcRow[] } {
  const jobs = rows.filter(r => r.row_kind === "job");
  const attempts = rows.filter(r => r.row_kind === "attempt");
  if (jobs.length > 1 || (attempts.length && jobs.length !== 1)) contractInvalid();
  const job = jobs[0];
  if (jobId && job) requireMatch(job, { job_id: jobId });
  for (const a of attempts) {
    requireMatch(a, { job_id: job!.job_id, event_id: job!.event_id });
    if (batchId) requireMatch(a, { batch_id: batchId });
  }
  return { job, attempts };
}

export async function runWorker(admin: BackendClient, options: WorkerOptions = {}) {
  const budget = options.budget ?? createBudget(INVOCATION_BUDGET_MS);
  const wallNow = options.wallNow ?? Date.now;
  const send = options.send ?? sendWebPush;
  // Crypto/config is checked before acquire/prepare/any privileged mutation.
  let vapid: ReturnType<typeof loadVapidConfig>;
  try { vapid = loadVapidConfig(options.readEnv); }
  catch { throw new ContractError(503, "worker_configuration_invalid"); }
  if (options.jobId !== undefined && !UUID_PATTERN.test(options.jobId)) throw new ContractError(400, "invalid_job_id");
  const summary = { acquired: false, prepared: 0, permits: 0, sent: 0, expired: 0, retryable: 0,
    failed: 0, ambiguous: 0, released: 0, recoveryPending: false, settled: false };
  const initial = sameState(await durableRpc(admin, "get_notification_dispatch_state",
    options.jobId ? { p_job_id: options.jobId, p_limit: MAX_BATCH } : { p_limit: 1 }, budget, FINALIZATION_RESERVE_MS), options.jobId);
  if (!initial.job || ["completed", "blocked"].includes(string(initial.job, "job_stage"))) return summary;
  const jobId = string(initial.job, "job_id");
  const workerId = crypto.randomUUID();
  // Only one job and one batch per invocation. A lost acquire may hold a lease;
  // later invocations recover it after expiry, never invent a second identity.
  const [lease] = await durableRpc(admin, "acquire_notification_dispatch_job", {
    p_job_id: jobId, p_worker_id: workerId, p_operation_id: crypto.randomUUID(),
    p_expected_epoch: initial.job.lease_epoch, p_limit: MAX_BATCH,
  }, budget, FINALIZATION_RESERVE_MS);
  requireMatch(lease, { job_id: jobId });
  if (!["acquired", "existing_lease"].includes(string(lease, "disposition"))) return summary;
  requireMatch(lease, { event_id: initial.job.event_id });
  summary.acquired = true;
  const identity = { p_job_id: jobId, p_worker_id: workerId, p_lease_epoch: lease.lease_epoch };
  let reason: Reason = "yield";
  let failure: unknown = null;
  let halted = false;
  const tracked: Tracked[] = [];

  async function persist(item: Tracked, result: ProviderResult) {
    const a = item.row;
    const [row] = await durableRpc(admin, "record_notification_dispatch_result", {
      p_attempt_id: a.attempt_id, p_worker_id: workerId, p_send_epoch: lease.lease_epoch,
      p_claim_token: a.claim_token,
      p_operation_id: result.outcome === "ambiguous" ? a.ambiguity_operation_id : a.record_operation_id,
      p_outcome: result.outcome, p_http_status: result.httpStatus,
      p_retry_after_seconds: result.retryAfterSeconds, p_error_code: result.errorCode,
    }, budget, FINALIZATION_RESERVE_MS);
    requireMatch(row, { attempt_id: a.attempt_id });
    if (result.outcome !== "ambiguous") requireMatch(row, {
      attempt_stage: "result_recorded", provider_outcome: result.outcome,
    });
    if (result.outcome === "sent") summary.sent++;
    else if (result.outcome === "expired") summary.expired++;
    else if (result.outcome === "ambiguous") summary.ambiguous++;
    else if (row.delivery_status === "queued") summary.retryable++;
    else summary.failed++;
    item.state = "done";
  }
  async function process(item: Tracked) {
    if (halted) return;
    const timeout = Math.floor(Math.min(MAX_PROVIDER_TIMEOUT_MS, budget.remaining() -
      FINALIZATION_RESERVE_MS - RECORD_RESERVE_MS - BEGIN_RESERVE_MS));
    if (timeout < 1_000) { halted = true; return; }
    const a = item.row;
    // Mark uncertainty BEFORE issuing begin. A response error/malformed row may
    // follow a committed permit. Such attempts must NEVER go through release.
    item.state = "begin_unknown";
    try {
      const [permit] = await durableRpc(admin, "begin_notification_dispatch_send", {
        ...identity, p_attempt_id: a.attempt_id, p_operation_id: a.begin_operation_id, p_timeout_ms: timeout,
      }, budget, FINALIZATION_RESERVE_MS + RECORD_RESERVE_MS);
      requireMatch(permit, { attempt_id: a.attempt_id, claim_token: a.claim_token });
      if (!permit.permit_granted) {
        item.state = "done";
        summary.recoveryPending ||= permit.current_stage === "send_started";
        return;
      }
      item.state = "permit";
      summary.permits++;
      requireMatch(permit, { event_id: lease.event_id });
      // Clock skew can only shorten our local send window. Never use credentials
      // past the returned DB deadline, nor for a replay or recovery read.
      const sendMs = Math.floor(Math.min(timeout, Date.parse(string(permit, "send_deadline_at")) - wallNow() - 100,
        budget.remaining() - RECORD_RESERVE_MS - FINALIZATION_RESERVE_MS));
      let result: ProviderResult;
      if (sendMs < 1) {
        result = { outcome: "ambiguous", httpStatus: null, retryAfterSeconds: null, errorCode: "provider_timeout" };
      } else {
        try {
          const response = await bounded(signal => send({
            endpoint: string(permit, "endpoint"), p256dh: string(permit, "p256dh"), auth: string(permit, "auth"),
          }, { type: permit.event_type, title: permit.title, body: permit.body, url: permit.deep_link,
            eventId: permit.event_id }, vapid, sendMs, signal), sendMs);
          const retry = response.headers?.["retry-after"];
          result = classifyHttpStatus(response.statusCode, Array.isArray(retry) ? retry[0] : retry, wallNow());
        } catch (error) {
          result = error instanceof ContractError && error.code === "operation_response_unavailable"
            ? { outcome: "ambiguous", httpStatus: null, retryAfterSeconds: null, errorCode: "provider_timeout" }
            : classifyPushError(error, wallNow());
        }
      }
      await persist(item, result);
    } catch (error) {
      failure ??= error;
      if (reason !== "configuration_blocked") reason = failureReason(error);
      halted = true; summary.recoveryPending = true;
      // No begin retries and no second provider request. If record is unavailable
      // durable send_started survives; settle/future recovery marks ambiguity.
    }
  }
  try {
    const [batch] = await durableRpc(admin, "prepare_notification_dispatch_batch", {
      ...identity, p_batch_id: lease.batch_id,
    }, budget, FINALIZATION_RESERVE_MS);
    requireMatch(batch, { job_id: jobId, event_id: lease.event_id, batch_id: lease.batch_id });
    const state = sameState(await durableRpc(admin, "get_notification_dispatch_state", {
      p_job_id: jobId, p_batch_id: lease.batch_id, p_limit: MAX_BATCH,
    }, budget, FINALIZATION_RESERVE_MS), jobId, string(lease, "batch_id"));
    if (!state.job || state.attempts.length !== batch.batch_count) contractInvalid();
    requireMatch(state.job, { lease_epoch: lease.lease_epoch, lease_owner: workerId,
      batch_id: lease.batch_id, batch_prepared: true, batch_count: batch.batch_count });
    summary.prepared = number(batch, "batch_count");
    for (const row of state.attempts) {
      // Recovery reads confer no permit. Old/started/ambiguous/terminal attempts
      // are never sent, even if a row were to contain cached credentials.
      if (row.attempt_stage === "prepared") {
        requireMatch(row, { prepared_epoch: lease.lease_epoch, delivery_status: "sending",
          delivery_attempt_count: row.attempt_no });
        tracked.push({ row, state: "prepared" });
      } else if (row.attempt_stage === "send_started") {
        halted = true; summary.recoveryPending = true;
      }
    }
    for (let cursor = 0; cursor < tracked.length && !halted; cursor += MAX_CONCURRENCY) {
      await concurrent(tracked.slice(cursor, cursor + MAX_CONCURRENCY), process);
    }
  } catch (error) {
    // Takeover with old active attempts: settle performs recovery; a subsequent
    // invocation acquires the next epoch. Never prepare again in this lifecycle.
    if (!(error instanceof RpcFailure && error.dbCode === "RECOVERY_REQUIRED")) {
      failure ??= error;
      if (reason !== "configuration_blocked") reason = failureReason(error);
    }
    summary.recoveryPending = true;
  } finally {
    // Release only attempts for which begin was NEVER issued. All others are
    // handled by durable recovery, regardless of whether HTTP delivered a permit.
    await concurrent(tracked.filter(t => t.state === "prepared"), async item => {
      if (budget.remaining() <= SETTLE_RESERVE_MS) { summary.recoveryPending = true; return; }
      try {
        const [row] = await durableRpc(admin, "release_notification_dispatch_attempt", {
          ...identity, p_attempt_id: item.row.attempt_id,
          p_operation_id: item.row.release_operation_id, p_reason: "worker_budget",
        }, budget, SETTLE_RESERVE_MS);
        requireMatch(row, { attempt_id: item.row.attempt_id,
          released_attempt_count: number(item.row, "attempt_no") - 1 });
        item.state = "released"; summary.released++;
      } catch (error) {
        failure ??= error;
        if (reason !== "configuration_blocked") reason = failureReason(error);
        summary.recoveryPending = true;
      }
    });
    try {
      const [settled] = await durableRpc(admin, "settle_notification_dispatch_job", {
        ...identity, p_operation_id: lease.settle_operation_id, p_reason: reason,
      }, budget, 500);
      requireMatch(settled, { job_id: jobId });
      summary.settled = true;
      summary.recoveryPending ||= !["completed", "blocked"].includes(string(settled, "job_stage"));
    } catch (error) { failure ??= error; summary.recoveryPending = true; }
  }
  if (failure) throw new ContractError(502, "dispatch_recovery_required");
  return summary;
}

export async function handleWorkerRequest(req: Request, ctx: { supabaseAdmin: BackendClient }) {
  const budget = createBudget(INVOCATION_BUDGET_MS);
  try {
    if (req.method !== "POST") throw new ContractError(405, "method_not_allowed");
    if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ContractError(415, "json_required");
    if (Number(req.headers.get("content-length")) > REQUEST_MAX_BYTES) throw new ContractError(413, "request_too_large");
    const bytes = new Uint8Array(await bounded(() => req.arrayBuffer(), Math.min(2_000, budget.remaining())));
    if (bytes.length > REQUEST_MAX_BYTES) throw new ContractError(413, "request_too_large");
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ContractError(400, "invalid_json"); }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => k !== "jobId")) throw new ContractError(400, "invalid_request_fields");
    const jobId = (input as { jobId?: unknown }).jobId;
    if (Object.hasOwn(input, "jobId") && (typeof jobId !== "string" || !UUID_PATTERN.test(jobId))) {
      throw new ContractError(400, "invalid_job_id");
    }
    const result = await runWorker(ctx.supabaseAdmin, { jobId: jobId as string | undefined, budget });
    return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof ContractError ? error.code : "dispatch_failed" }, {
      status: error instanceof ContractError ? error.status : 500, headers: { "cache-control": "no-store" },
    });
  }
}
// Pinned SDK checks the apikey against configured backend secrets. No user-JWT,
// publishable-key or auth:none fallback. Production secret -> service_role
// capability must still be verified independently before any deployment.
export default { fetch: withSupabase({ auth: "secret" }, handleWorkerRequest) };
