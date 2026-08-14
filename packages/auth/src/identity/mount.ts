// @wardenx/auth · identity — mount Better Auth on Fastify (M2, AUTH-T02, ADR-0033).
//
// Bridges Fastify's request/reply to Better Auth's web-standard `handler(request: Request)`. We use the
// web handler (not toNodeHandler) so the bridge stays scoped to the /api/auth/* route — no global
// content-type-parser change — and is unit-testable with a stub handler (no DB / no better-auth needed
// to exercise the plumbing). The instance itself is created by createIdentityAuth(db) and is mounted
// only when a production DB client is present (composition root); slice/tests don't mount it.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  type CredentialThrottle,
  CredentialThrottleError,
  isGuardedSignInPath,
  outcomeOfStatus,
  usernameFromBody,
} from "./credential-throttle";

/** The slice of a Better Auth instance the bridge needs (structural — `Auth` satisfies it). */
export interface MountableAuth {
  handler(request: Request): Promise<Response>;
}

export interface RegisterIdentityAuthOptions {
  /** Path prefix Better Auth serves under (must match the instance's basePath). Default `/api/auth`. */
  basePath?: string;
  /**
   * AC-05 — the §5.3.1 brute-force guard. Absent ⇒ no per-username/per-IP failed-attempt budget
   * (only the global SD-055 per-minute tier applies), which is what production ran until now.
   *
   * It hangs here rather than on a separate preHandler because this bridge is the ONE place that
   * sees both the credential in the request and Better Auth's verdict in the response — the guard
   * needs both, and Better Auth's own hooks are version-coupled internals.
   */
  credentialThrottle?: CredentialThrottle;
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
  const throttle = opts.credentialThrottle;
  app.all(`${basePath}/*`, async (request, reply) => {
    // §5.3.1 — refuse a spent budget BEFORE the credential is checked, so a locked-out account
    // costs an attacker an Argon2id verification of nothing. Only the credential-checking paths are
    // guarded: sign-out, callbacks and session reads are not credential guesses.
    const guarded = throttle !== undefined && isGuardedSignInPath(request.url, basePath);
    const username = guarded ? usernameFromBody(request.body) : null;
    if (guarded) {
      try {
        await throttle.assertUnderBudget({ username, ip: request.ip || "unknown" });
      } catch (err) {
        if (err instanceof CredentialThrottleError)
          reply.header("Retry-After", String(err.retryAfterSeconds));
        throw err; // rendered by M1's error-handler as the canonical envelope
      }
    }
    const res = await auth.handler(toWebRequest(request));
    if (guarded) {
      await throttle.record({
        username,
        ip: request.ip || "unknown",
        outcome: outcomeOfStatus(res.status),
      });
    }
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
        existing === undefined
          ? []
          : Array.isArray(existing)
            ? existing.map(String)
            : [String(existing)];
      reply.header("set-cookie", [...existingList, ...setCookies]);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return reply.send(body.length > 0 ? body : null);
  });
}
