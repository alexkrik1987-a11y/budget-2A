import * as webPushNamespace from "web-push";
import { createECDH } from "node:crypto";
import { request as httpsRequest } from "node:https";

type WebPushApi = {
  generateRequestDetails?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      TTL: number;
      urgency: string;
      contentEncoding: string;
      timeout: number;
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
    },
  ) => { endpoint: string; method: string; headers: Record<string, string | number>; body: Uint8Array };
};

export type VapidConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export type ClaimedSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function decodeBase64Url(value: string, errorCode: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error(errorCode);
  }

  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    if (canonical !== value) throw new Error(errorCode);
    return bytes;
  } catch {
    throw new Error(errorCode);
  }
}

function validateVapidSubject(subject: string): void {
  try {
    const parsed = new URL(subject);
    if (parsed.protocol === "https:") {
      if (!parsed.hostname || parsed.username || parsed.password) throw new Error("invalid_vapid_subject");
      return;
    }
    if (parsed.protocol === "mailto:" && !parsed.search && !parsed.hash) {
      const address = decodeURIComponent(parsed.pathname);
      const parts = address.split("@");
      if (parts.length === 2 && parts.every((part) => part.length > 0 && !/[\s/?#]/u.test(part))) return;
    }
  } catch {
    // Return only the stable public error code below; never expose subject/key internals.
  }
  throw new Error("invalid_vapid_subject");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function validateVapidKeyPair(publicKeyValue: string, privateKeyValue: string): void {
  const publicKey = decodeBase64Url(publicKeyValue, "invalid_vapid_public_key");
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("invalid_vapid_public_key");
  }

  try {
    const pointValidator = createECDH("prime256v1");
    const unitScalar = new Uint8Array(32);
    unitScalar[31] = 1;
    pointValidator.setPrivateKey(unitScalar);
    pointValidator.computeSecret(publicKey);
  } catch {
    throw new Error("invalid_vapid_public_key");
  }

  const privateKey = decodeBase64Url(privateKeyValue, "invalid_vapid_private_key");
  if (privateKey.length !== 32) throw new Error("invalid_vapid_private_key");

  let derivedPublicKey: Uint8Array;
  try {
    const pairValidator = createECDH("prime256v1");
    pairValidator.setPrivateKey(privateKey);
    derivedPublicKey = new Uint8Array(pairValidator.getPublicKey(undefined, "uncompressed"));
  } catch {
    throw new Error("invalid_vapid_private_key");
  }

  if (!bytesEqual(publicKey, derivedPublicKey)) throw new Error("invalid_vapid_key_pair");
}

function resolveWebPushApi(): Required<WebPushApi> {
  const namespaceApi = webPushNamespace as unknown as WebPushApi;
  const defaultApi = (webPushNamespace as unknown as { default?: WebPushApi }).default;
  const generateRequestDetails = namespaceApi.generateRequestDetails ?? defaultApi?.generateRequestDetails;
  if (typeof generateRequestDetails !== "function") {
    throw new Error("web_push_api_unavailable");
  }
  return { generateRequestDetails };
}

export function loadVapidConfig(
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): VapidConfig {
  const subject = readEnv("VAPID_SUBJECT")?.trim() ?? "";
  const publicKey = readEnv("VAPID_PUBLIC_KEY")?.trim() ?? "";
  const privateKey = readEnv("VAPID_PRIVATE_KEY")?.trim() ?? "";

  validateVapidSubject(subject);
  validateVapidKeyPair(publicKey, privateKey);
  return { subject, publicKey, privateKey };
}

export async function sendWebPush(
  subscription: ClaimedSubscription,
  payload: Record<string, unknown>,
  vapid: VapidConfig,
  timeoutMs = 8_000,
  signal?: AbortSignal,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) {
    throw new Error("invalid_web_push_timeout");
  }
  signal?.throwIfAborted();
  const { generateRequestDetails } = resolveWebPushApi();
  // The pinned package does crypto/signing only. Own the HTTPS request so an
  // absolute timeout/AbortSignal destroys the request, not just its awaiter.
  const details = generateRequestDetails(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(payload),
    {
      TTL: 300,
      urgency: "normal",
      contentEncoding: "aes128gcm",
      timeout: timeoutMs,
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    },
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const request = httpsRequest(details.endpoint, {
        method: details.method, headers: details.headers, signal: controller.signal,
      }, response => {
        // Status/Retry-After suffice. Never retain or log provider response bodies.
        const result = { statusCode: response.statusCode ?? 0, headers: response.headers };
        response.destroy();
        resolve(result);
      });
      request.on("error", reject);
      request.end(details.body);
    });
  } catch (error) {
    // Deno's Node HTTPS layer reports cancellation as TypeError; normalize only
    // when our own signal proves this was an intentional timeout/abort.
    if (controller.signal.aborted) throw new DOMException("Push request aborted", "AbortError");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
