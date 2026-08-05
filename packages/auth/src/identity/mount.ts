// @wardenx/auth · identity — mount Better Auth on Fastify (M2, AUTH-T02, ADR-0033).
//
// Bridges Fastify's request/reply to Better Auth's web-standard `handler(request: Request)`. We use the
// web handler (not toNodeHandler) so the bridge stays scoped to the /api/auth/* route — no global
// content-type-parser change — and is unit-testable with a stub handler (no DB / no better-auth needed
// to exercise the plumbing). The instance itself is created by createIdentityAuth(db) and is mounted
// only when a production DB client is present (composition root); slice/tests don't mount it.
import type { FastifyInstance, FastifyRequest } from "fastify";

/** The slice of a Better Auth instance the bridge needs (structural — `Auth` satisfies it). */
export interface MountableAuth {
  handler(request: Request): Promise<Response>;
}

export interface RegisterIdentityAuthOptions {
  /** Path prefix Better Auth serves under (must match the instance's basePath). Default `/api/auth`. */
  basePath?: string;
}

/** Convert a Fastify request to a web `Request` (Fastify-parsed JSON body is re-serialized). */
function toWebRequest(request: FastifyRequest): Request {
  const url = `${request.protocol}://${request.hostname}${request.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && request.body != null;
  return new Request(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
}

/** Mount Better Auth's handler at `${basePath}/*` on the Fastify host. */
export function registerIdentityAuth(
  app: FastifyInstance,
  auth: MountableAuth,
  opts: RegisterIdentityAuthOptions = {},
): void {
  const basePath = opts.basePath ?? "/api/auth";
  app.all(`${basePath}/*`, async (request, reply) => {
    const res = await auth.handler(toWebRequest(request));
    reply.status(res.status);
    // Forward headers; Set-Cookie must go as a list (Headers.forEach folds duplicates into one string).
    const setCookies = res.headers.getSetCookie?.() ?? [];
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
    });
    if (setCookies.length > 0) {
      // MERGE rather than overwrite: an earlier onRequest hook (the M1 CSRF plugin mints a
      // double-submit cookie on every request) may already have staged a set-cookie header on this
      // reply — a plain `reply.header("set-cookie", setCookies)` would silently drop it, so a login
      // response would carry the new session cookie but lose the CSRF cookie in the same round trip.
      const existing = reply.getHeader("set-cookie");
      const existingList =
        existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
      reply.header("set-cookie", [...existingList, ...setCookies]);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return reply.send(body.length > 0 ? body : null);
  });
}
