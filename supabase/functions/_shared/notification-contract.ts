// Request/source canonicalization is shared; only durable RPC contracts are active.
export const REQUEST_MAX_BYTES = 2_048;
export const DELIVERY_BATCH_SIZE = 25;
export const DELIVERY_CONCURRENCY = 5;
export const FIXED_SOURCE_IDS = {
  schedule: "class_profile:useful_info.schedule",
  memo: "class_profile:useful_info.notes",
} as const;
export type EventType = "schedule" | "memo" | "announcement";
export type NotificationRequest = { eventType: EventType; sourceId: string; notify: true };
export type EventDraft = {
  eventKey: string; eventType: EventType; title: string; body: string;
  sourceEntity: "class_profile" | "chat_messages"; sourceEntityId: string;
  contentHash: string; deepLink: "/";
};
export class ContractError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = "Notification operation rejected") {
    super(message); this.name = "ContractError"; this.status = status; this.code = code;
  }
}
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
const DAY_LABELS: Record<(typeof DAYS)[number], string> = { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт" };
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function cleanText(value: unknown, maxLength: number): string {
  return Array.from(String(value ?? "").trim().replace(/\s+/gu, " "))
    .slice(0, maxLength)
    .join("");
}

export function validateNotificationRequest(value: unknown): NotificationRequest {
  if (!isRecord(value)) {
    throw new ContractError(400, "invalid_request", "Request body must be a JSON object");
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys.join(",") !== "eventType,notify,sourceId") {
    throw new ContractError(400, "invalid_request_fields", "Request fields do not match the contract");
  }
  if (value.notify !== true) {
    throw new ContractError(400, "notification_not_confirmed", "notify must be true");
  }
  if (value.eventType !== "schedule" && value.eventType !== "memo" && value.eventType !== "announcement") {
    throw new ContractError(400, "unsupported_event_type", "Unsupported event type");
  }
  if (typeof value.sourceId !== "string") {
    throw new ContractError(400, "invalid_source_id", "sourceId must be a string");
  }

  if (value.eventType === "schedule" && value.sourceId !== FIXED_SOURCE_IDS.schedule) {
    throw new ContractError(400, "invalid_source_id", "Invalid schedule source");
  }
  if (value.eventType === "memo" && value.sourceId !== FIXED_SOURCE_IDS.memo) {
    throw new ContractError(400, "invalid_source_id", "Invalid memo source");
  }
  if (value.eventType === "announcement" && !UUID_PATTERN.test(value.sourceId)) {
    throw new ContractError(400, "invalid_source_id", "Announcement sourceId must be a UUID");
  }

  return {
    eventType: value.eventType,
    sourceId: value.eventType === "announcement" ? value.sourceId.toLowerCase() : value.sourceId,
    notify: true,
  };
}

export function parseNotificationRequest(
  method: string,
  contentType: string | null,
  bytes: Uint8Array,
): NotificationRequest {
  if (method !== "POST") {
    throw new ContractError(405, "method_not_allowed", "Only POST is accepted");
  }
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ContractError(415, "json_required", "Content-Type must be application/json");
  }
  if (bytes.byteLength === 0) {
    throw new ContractError(400, "empty_request", "Request body is empty");
  }
  if (bytes.byteLength > REQUEST_MAX_BYTES) {
    throw new ContractError(413, "request_too_large", "Request body is too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContractError(400, "invalid_json", "Request body is not valid JSON");
  }
  return validateNotificationRequest(parsed);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new ContractError(500, "invalid_authoritative_content", "Authoritative content is not canonicalizable");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSchedule(usefulInfo: unknown): Record<(typeof DAYS)[number], string[]> {
  const info = isRecord(usefulInfo) ? usefulInfo : {};
  const schedule = isRecord(info.schedule) ? info.schedule : {};
  return Object.fromEntries(DAYS.map((day) => {
    const lessons = Array.isArray(schedule[day]) ? schedule[day] : [];
    return [day, lessons.map((lesson) => cleanText(lesson, 120)).filter(Boolean).slice(0, 12)];
  })) as Record<(typeof DAYS)[number], string[]>;
}

function normalizeNotes(usefulInfo: unknown): string[] {
  const info = isRecord(usefulInfo) ? usefulInfo : {};
  const notes = Array.isArray(info.notes) ? info.notes : [];
  return notes.map((note) => cleanText(note, 500)).filter(Boolean).slice(0, 20);
}

function truncateText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

export async function buildEventDraft(
  request: NotificationRequest,
  authoritative: { usefulInfo?: unknown; announcement?: unknown },
): Promise<EventDraft> {
  let canonicalContent: unknown;
  let title: string;
  let body: string;
  let sourceEntity: EventDraft["sourceEntity"];

  if (request.eventType === "schedule") {
    const schedule = normalizeSchedule(authoritative.usefulInfo);
    canonicalContent = schedule;
    title = "Расписание класса обновлено";
    const lines = DAYS
      .filter((day) => schedule[day].length > 0)
      .map((day) => `${DAY_LABELS[day]}: ${schedule[day].join(", ")}`);
    body = lines.length ? `Расписание: ${lines.join(" · ")}` : "Расписание класса обновлено.";
    sourceEntity = "class_profile";
  } else if (request.eventType === "memo") {
    const notes = normalizeNotes(authoritative.usefulInfo);
    canonicalContent = notes;
    title = "Памятки класса обновлены";
    body = notes.length ? notes.join(" • ") : "Памятки класса обновлены.";
    sourceEntity = "class_profile";
  } else {
    const announcement = isRecord(authoritative.announcement) ? authoritative.announcement : {};
    const id = typeof announcement.id === "string" ? announcement.id.toLowerCase() : "";
    const announcementBody = cleanText(announcement.body, 500);
    if (id !== request.sourceId || announcement.is_pinned !== true || announcement.archived_at != null || !announcementBody) {
      throw new ContractError(404, "announcement_not_eligible", "Pinned active announcement was not found");
    }
    canonicalContent = { id, body: announcementBody };
    title = "Объявление класса";
    body = announcementBody;
    sourceEntity = "chat_messages";
  }

  const canonicalContentJson = canonicalJson(canonicalContent);
  const contentHash = await sha256Hex(canonicalContentJson);
  const identityHash = await sha256Hex(canonicalJson({
    version: 1,
    eventType: request.eventType,
    sourceId: request.sourceId,
    content: canonicalContent,
  }));

  return {
    eventKey: `class_push:v1:${request.eventType}:${identityHash}`,
    eventType: request.eventType,
    title: truncateText(title, 160),
    body: truncateText(body, 500),
    sourceEntity,
    sourceEntityId: request.sourceId,
    contentHash,
    deepLink: "/",
  };
}

export function buildPushPayload(draft: EventDraft, eventId: string) {
  return {
    type: draft.eventType,
    title: draft.title,
    body: draft.body,
    url: draft.deepLink,
    eventId,
  };
}


// Exact pg RETURNS TABLE shapes. No coercion and no raw-row diagnostics.
type Check = (v: unknown) => boolean;
const text: Check = v => typeof v === "string" && v.length > 0;
const uuid: Check = v => typeof v === "string" && UUID_PATTERN.test(v);
const timestamp: Check = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Check =>
  v => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const nullable = (check: Check): Check => v => v === null || check(v);
const choices = (...values: unknown[]): Check => v => values.includes(v);
const jobStage = choices("ready", "leased", "waiting", "completed", "blocked");
const eventStatus = choices("queued", "sending", "sent", "failed");
const attemptStage = choices("prepared", "send_started", "result_recorded", "ambiguous", "released");
const deliveryStatus = choices("queued", "sending", "sent", "expired", "failed", "skipped");
const outcome = choices("sent", "expired", "retryable", "permanent_failure");
const idStage = { job_id: uuid, event_id: uuid, job_stage: jobStage };
const resultFields = { delivery_status: deliveryStatus, delivery_attempt_count: integer(0, 5),
  next_attempt_at: nullable(timestamp), event_status: eventStatus, job_stage: jobStage };
const stateShape = {
  row_kind: choices("job", "attempt"), ...idStage, event_status: eventStatus,
  lease_epoch: integer(0), lease_owner: nullable(uuid), lease_until: nullable(timestamp),
  next_run_at: nullable(timestamp), snapshot_at: nullable(timestamp), batch_id: nullable(uuid),
  batch_prepared: choices(true, false), batch_count: nullable(integer(0, 25)), settle_operation_id: nullable(uuid),
  attempt_id: nullable(uuid), delivery_id: nullable(uuid), attempt_stage: nullable(attemptStage),
  prepared_epoch: nullable(integer(1)), attempt_no: nullable(integer(1, 5)), claim_token: nullable(uuid),
  begin_operation_id: nullable(uuid), record_operation_id: nullable(uuid), ambiguity_operation_id: nullable(uuid),
  release_operation_id: nullable(uuid), send_owner: nullable(uuid), send_epoch: nullable(integer(1)),
  send_deadline_at: nullable(timestamp), ambiguity_after: nullable(timestamp),
  delivery_status: nullable(deliveryStatus), delivery_attempt_count: nullable(integer(0, 5)),
  delivery_next_attempt_at: nullable(timestamp), provider_outcome: nullable(outcome),
  result_recorded_at: nullable(timestamp), ambiguity_at: nullable(timestamp), released_at: nullable(timestamp),
};
const shapes = {
  enqueue_notification_dispatch: {
    disposition: choices("created", "existing"), ...idStage, event_status: eventStatus,
  },
  acquire_notification_dispatch_job: {
    disposition: choices("acquired", "existing_lease", "busy", "not_due", "terminal"),
    job_id: uuid, event_id: nullable(uuid), job_stage: nullable(jobStage), lease_epoch: nullable(integer(0)),
    lease_until: nullable(timestamp), batch_id: nullable(uuid), batch_limit: nullable(integer(1, 25)),
    settle_operation_id: nullable(uuid),
  },
  prepare_notification_dispatch_batch: {
    disposition: choices("prepared", "already_prepared"), ...idStage, batch_id: uuid,
    batch_count: integer(0, 25), snapshot_at: timestamp, event_status: eventStatus,
  },
  get_notification_dispatch_state: stateShape,
  begin_notification_dispatch_send: {
    permit_granted: choices(true, false), current_stage: attemptStage, attempt_id: uuid, claim_token: uuid,
    send_deadline_at: nullable(timestamp), endpoint: nullable(text), p256dh: nullable(text), auth: nullable(text),
    event_id: nullable(uuid), event_type: nullable(choices("schedule", "memo", "announcement")),
    title: nullable(text), body: nullable(text), deep_link: nullable(choices("/")),
  },
  record_notification_dispatch_result: {
    disposition: choices("recorded", "already_recorded", "ambiguity_recorded", "already_ambiguous",
      "already_resolved", "late_result_recorded"),
    attempt_id: uuid, attempt_stage: attemptStage, provider_outcome: nullable(outcome), ...resultFields,
  },
  release_notification_dispatch_attempt: {
    disposition: choices("released", "already_released"), attempt_id: uuid, attempt_stage: choices("released"),
    released_attempt_count: integer(0, 4), ...resultFields,
  },
  settle_notification_dispatch_job: {
    disposition: choices("settled", "already_settled", "already_terminal"),
    job_id: uuid, job_stage: jobStage, event_status: eventStatus, next_run_at: nullable(timestamp),
    queued_count: integer(0), sending_count: integer(0), sent_count: integer(0),
    expired_count: integer(0), failed_count: integer(0), skipped_count: integer(0), ambiguous_count: integer(0),
  },
};
export type DurableRpc = keyof typeof shapes;
export type RpcRow = Record<string, string | number | boolean | null>;
export function contractInvalid(): never { throw new ContractError(502, "durable_rpc_contract_invalid"); }
export function validateDurableResponse(name: DurableRpc, value: unknown): RpcRow[] {
  if (!Array.isArray(value) || (name === "get_notification_dispatch_state" ? value.length > 26 : value.length !== 1)) {
    return contractInvalid();
  }
  const shape: Record<string, Check> = shapes[name];
  const result = value.map(row => {
    if (!isRecord(row) || Object.keys(row).length !== Object.keys(shape).length ||
      Object.entries(shape).some(([key, check]) => !check(row[key]))) return contractInvalid();
    return row as RpcRow;
  });
  for (const row of result) {
    if (name === "acquire_notification_dispatch_job") {
      if (row.disposition !== "busy" && (row.event_id === null || row.job_stage === null || row.lease_epoch === null)) contractInvalid();
      if (row.disposition === "acquired" || row.disposition === "existing_lease") {
        if (row.job_stage !== "leased" || !integer(1)(row.lease_epoch) ||
          [row.lease_until, row.batch_id, row.batch_limit, row.settle_operation_id].includes(null)) contractInvalid();
      }
    }
    if (name === "begin_notification_dispatch_send") {
      const credentials = ["endpoint", "p256dh", "auth", "event_id", "event_type", "title", "body", "deep_link"];
      if (row.permit_granted) {
        if (row.current_stage !== "send_started" || row.send_deadline_at === null ||
          credentials.some(key => row[key] === null) || Array.from(row.title as string).length > 160 ||
          Array.from(row.body as string).length > 500) contractInvalid();
        try {
          const url = new URL(row.endpoint as string);
          if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) contractInvalid();
        } catch { contractInvalid(); }
      } else if (row.current_stage === "prepared" || credentials.some(key => row[key] !== null)) contractInvalid();
    }
    if (name === "record_notification_dispatch_result") {
      if (!["result_recorded", "ambiguous"].includes(row.attempt_stage as string) ||
        (row.attempt_stage === "ambiguous" && (row.provider_outcome !== null || row.delivery_status !== "failed")) ||
        (row.attempt_stage === "result_recorded" && row.provider_outcome === null)) contractInvalid();
    }
    if (name === "get_notification_dispatch_state") {
      const attemptKeys = Object.keys(stateShape).slice(Object.keys(stateShape).indexOf("attempt_id"));
      if (row.row_kind === "job") {
        if (attemptKeys.some(key => row[key] !== null)) contractInvalid();
      } else {
        for (const key of ["attempt_id", "delivery_id", "attempt_stage", "prepared_epoch", "attempt_no", "claim_token",
          "begin_operation_id", "record_operation_id", "ambiguity_operation_id", "release_operation_id",
          "delivery_status", "delivery_attempt_count", "batch_id"]) if (row[key] === null) contractInvalid();
        if (row.attempt_stage === "prepared" && [row.send_owner, row.send_epoch, row.send_deadline_at,
          row.ambiguity_after, row.result_recorded_at, row.ambiguity_at, row.released_at].some(v => v !== null)) contractInvalid();
        if (["send_started", "ambiguous", "result_recorded"].includes(row.attempt_stage as string) &&
          [row.send_owner, row.send_epoch, row.send_deadline_at, row.ambiguity_after].includes(null)) contractInvalid();
      }
    }
  }
  if (name === "get_notification_dispatch_state") {
    const keys = result.map(row => row.row_kind === "job" ? row.job_id : row.attempt_id);
    if (new Set(keys).size !== keys.length) contractInvalid();
  }
  return result;
}
export function requireMatch(row: RpcRow, expected: RpcRow): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) contractInvalid();
}

// RPC HTTP abort bounds waiting, not the DB transaction. A lost response may
// have committed. Callers must use durable state/operation IDs, never blind sends.
export type RpcResult = { data: unknown; error: unknown };
export type BackendClient = {
  rpc: (name: string, args?: Record<string, unknown>) =>
    PromiseLike<RpcResult> & { abortSignal: (signal: AbortSignal) => PromiseLike<RpcResult> };
};
export type Budget = { now: () => number; deadlineAt: number; remaining: () => number };
export function createBudget(ms = 45_000, now: () => number = () => performance.now()): Budget {
  const deadlineAt = now() + ms;
  return { now, deadlineAt, remaining: () => Math.max(0, deadlineAt - now()) };
}
export class RpcFailure extends ContractError {
  readonly dbCode: string | null;
  constructor(dbCode: string | null = null) {
    super(502, "durable_rpc_failed"); this.dbCode = dbCode;
  }
}
export async function bounded<T>(operation: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms < 1) throw new ContractError(503, "invocation_budget_exhausted");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ContractError(504, "operation_response_unavailable"));
        }, Math.floor(ms));
      }),
    ]);
  } finally { clearTimeout(timer); }
}
export async function durableRpc(client: BackendClient, name: DurableRpc, args: Record<string, unknown>,
  budget: Budget, reserveMs = 0): Promise<RpcRow[]> {
  const ms = Math.min(["enqueue_notification_dispatch", "acquire_notification_dispatch_job",
    "prepare_notification_dispatch_batch", "settle_notification_dispatch_job"].includes(name) ? 6_000 : 4_000,
    budget.remaining() - reserveMs);
  let response: RpcResult;
  try {
    response = await bounded(signal => {
      const query = client.rpc(name, args);
      if (typeof query.abortSignal !== "function") throw new ContractError(503, "rpc_abort_api_unavailable");
      return query.abortSignal(signal);
    }, ms);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new RpcFailure();
  }
  if (!isRecord(response) || !Object.hasOwn(response, "data") || !Object.hasOwn(response, "error")) contractInvalid();
  if (response.error !== null) {
    const message = isRecord(response.error) ? response.error.message : null;
    const known = ["EVENT_CONFLICT", "EVENT_WITHOUT_DISPATCH_JOB", "RECOVERY_REQUIRED",
      "OPERATION_SUPERSEDED", "LEASE_NOT_CURRENT", "OPERATION_ARGUMENT_CONFLICT"];
    throw new RpcFailure(typeof message === "string" && known.includes(message) ? message : null);
  }
  return validateDurableResponse(name, response.data);
}
export type ProviderResult = {
  outcome: "sent" | "expired" | "retryable" | "permanent_failure" | "ambiguous";
  httpStatus: number | null; retryAfterSeconds: number | null; errorCode: string | null;
};
export function parseRetryAfter(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  // Preserve accepted provider seconds; the DB owns the 30..86400 scheduling clamp.
  const raw = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isSafeInteger(raw) && raw > 0 && raw <= 2147483647 ? raw : null;
}
export function classifyHttpStatus(status: unknown, retryAfter: unknown = null, now = Date.now()): ProviderResult {
  const base = { httpStatus: status as number, retryAfterSeconds: null, errorCode: null };
  if (typeof status === "number" && Number.isInteger(status)) {
    if (status >= 200 && status <= 299) return { ...base, outcome: "sent" };
    if (status === 404 || status === 410) return { ...base, outcome: "expired" };
    if (status === 429) return { ...base, outcome: "retryable", retryAfterSeconds: parseRetryAfter(retryAfter, now) };
    if (status >= 500 && status <= 599) return { ...base, outcome: "retryable" };
    if (status >= 400 && status <= 499) return { ...base, outcome: "permanent_failure" };
  }
  return { outcome: "ambiguous", httpStatus: null, retryAfterSeconds: null, errorCode: "provider_unknown_response" };
}
export function classifyPushError(error: unknown, now = Date.now()): ProviderResult {
  if (isRecord(error) && typeof error.statusCode === "number") {
    const headers = isRecord(error.headers) ? error.headers : {};
    const retry = headers["retry-after"] ?? headers["Retry-After"];
    return classifyHttpStatus(error.statusCode, Array.isArray(retry) ? retry[0] : retry, now);
  }
  const timeout = error instanceof Error && (error.name === "AbortError" ||
    (error as Error & { code?: string }).code === "ETIMEDOUT");
  return { outcome: "ambiguous", httpStatus: null, retryAfterSeconds: null,
    errorCode: timeout ? "provider_timeout" : "provider_reset" };
}
