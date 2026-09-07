// Browser access is needed only by the administrator endpoint. Authentication
// still runs for every non-preflight request, including requests without Origin.
export const ADMIN_ORIGIN = "https://rodcomitet.budget2a.kriknexus.pro";
const ADMIN_HEADERS = ["authorization", "apikey", "content-type", "x-client-info"];

export function withAdminCors(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const headers = new Headers({ "vary": "Origin", "cache-control": "no-store" });
    if (origin !== null && origin !== ADMIN_ORIGIN) {
      return Response.json({ ok: false, error: "origin_not_allowed" }, { status: 403, headers });
    }
    if (origin === ADMIN_ORIGIN) headers.set("access-control-allow-origin", ADMIN_ORIGIN);
    if (req.method === "OPTIONS") {
      const requestedHeaders = (req.headers.get("access-control-request-headers") ?? "")
        .split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
      if (origin !== ADMIN_ORIGIN || req.headers.get("access-control-request-method") !== "POST" ||
        requestedHeaders.some(h => !ADMIN_HEADERS.includes(h))) {
        return Response.json({ ok: false, error: "preflight_not_allowed" }, { status: 403, headers });
      }
      headers.set("access-control-allow-methods", "POST");
      headers.set("access-control-allow-headers", ADMIN_HEADERS.join(", "));
      return new Response(null, { status: 204, headers });
    }
    const response = await handler(req);
    const result = new Response(response.body, response);
    // Preserve any other cache variation added by the auth layer.
    const vary = result.headers.get("vary");
    headers.set("vary", vary && !vary.split(",").some(v => v.trim().toLowerCase() === "origin")
      ? `${vary}, Origin` : vary || "Origin");
    for (const [name, value] of headers) result.headers.set(name, value);
    return result;
  };
}
