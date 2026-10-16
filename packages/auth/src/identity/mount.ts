// @wardenx/auth · identity — mount Better Auth on Fastify (M2, AUTH-T02, ADR-0033).
//
// Bridges Fastify's request/reply to Better Auth's web-standard `handler(request: Request)`. We use the
// web handler (not toNodeHandler) so the bridge stays scoped to the /api/auth/* route — no global
// content-type-parser change — and is unit-testable with a stub handler (no DB / no better-auth needed
// to exercise the plumbing). The instance itself is created by createIdentityAuth(db) and is mounted
// only when a production DB client is present (composition root); slice/tests don't mount it.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  type AuthAuditActor,
  type AuthAuditEvent,
  type AuthAuditSink,
  buildAccountLockedEvent,
  buildAuthAuditEvent,
  needsActor,
  relativeAuthPath,
} from "./auth-audit";
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
  /** Optional: resolves the acting session for audit attribution (Better Auth's `api` satisfies it). */
  readonly api?: {
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
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
  /**
   * GAP-002/GAP-004 - persists the M2 section 8.1 authentication events (login success/failure, lockout,
   * logout, 2FA, backup code, passkey, session revoke). Absent means no auth audit trail.
   */
  auditSink?: AuthAuditSink;
  /** Called when the sink rejects. Audit loss must be loud, but never fails (or unlocks) the auth request. */
  onAuditError?: (err: unknown, event: AuthAuditEvent) => void;
  /**
   * GAP-005 - runs BEFORE the handler for the endpoints that act on an existing session (`needsActor` paths) with the
   * resolved actor (null when anonymous). Throw a `WardenXError` to refuse - e.g. `two-factor/disable` for a role
   * whose MFA matrix requires a second factor. Absent means no pre-handler policy.
   */
  guard?: (input: { relativePath: string; actor: AuthAuditActor | null }) => Promise<void>;
  /**
   * GAP-003/005 - called after a SUCCESSFUL second-factor ceremony (TOTP verify, passkey sign-in, backup code) with
   * the session that ceremony produced, so the factor the session PROVED can be recorded (the MFA matrix tests
   * assurance, not enrolment). Awaited before the response is sent, so the client's next call sees it. A rejection
   * is reported to {@link onSecondFactorError} and never fails the sign-in: the session simply stays unproven and
   * the matrix refuses it (fail closed).
   */
  onSecondFactorVerified?: (input: {
    sessionId: string;
    userId: string;
    factor: "totp" | "webauthn";
  }) => Promise<void>;
  onSecondFactorError?: (err: unknown) => void;
}

/** Which proved factor a successful auth path establishes; backup codes count as a TOTP-grade factor. */
const PROVED_FACTOR_BY_PATH: Readonly<Record<string, "totp" | "webauthn">> = {
  "/passkey/verify-authentication": "webauthn",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "totp",
};

/** The request's cookies overlaid with the response's Set-Cookie values (the newly minted session wins). */
function cookieHeaderAfter(
  requestCookie: string | undefined,
  setCookies: readonly string[],
): string {
  const jar = new Map<string, string>();
  for (const pair of (requestCookie ?? "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
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

/** Resolve the acting session from the request's cookies; null when anonymous or unresolvable. */
async function resolveActor(
  auth: MountableAuth,
  request: FastifyRequest,
  cookieOverride?: string,
): Promise<AuthAuditActor | null> {
  if (!auth.api) return null;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    if (cookieOverride !== undefined) headers.set("cookie", cookieOverride);
    const snapshot = (await auth.api.getSession({ headers })) as {
      user?: { id?: unknown };
      session?: { id?: unknown; activeOrganizationId?: unknown };
    } | null;
    const userId = snapshot?.user?.id;
    const sessionId = snapshot?.session?.id;
    if (typeof userId !== "string" || typeof sessionId !== "string") return null;
    const organizationId = snapshot?.session?.activeOrganizationId;
    return {
      userId,
      sessionId,
      ...(typeof organizationId === "string" ? { organizationId } : {}),
    };
  } catch {
    return null; // attribution is best-effort; the event is still written, just without an actor
  }
}

/** Mount Better Auth's handler at `${basePath}/*` on the Fastify host. */
export function registerIdentityAuth(
  app: FastifyInstance,
  auth: MountableAuth,
  opts: RegisterIdentityAuthOptions = {},
): void {
  const basePath = opts.basePath ?? "/api/auth";
  const throttle = opts.credentialThrottle;
  const record = async (event: AuthAuditEvent | null): Promise<void> => {
    if (!opts.auditSink || event === null) return;
    try {
      await opts.auditSink(event);
    } catch (err) {
      opts.onAuditError?.(err, event);
    }
  };
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
        if (err instanceof CredentialThrottleError) {
          reply.header("Retry-After", String(err.retryAfterSeconds));
          await record(
            buildAccountLockedEvent({
              username,
              ip: request.ip || "unknown",
              userAgent: request.headers["user-agent"],
              retryAfterSeconds: err.retryAfterSeconds,
            }),
          );
        }
        throw err; // rendered by M1's error-handler as the canonical envelope
      }
    }
    const relativePath =
      opts.auditSink || opts.guard || opts.onSecondFactorVerified
        ? relativeAuthPath(request.url, basePath)
        : null;
    // Sign-out / revoke destroy the session the event is about: resolve the actor first.
    const actor =
      relativePath !== null && needsActor(relativePath) ? await resolveActor(auth, request) : null;
    if (relativePath !== null && opts.guard && needsActor(relativePath)) {
      await opts.guard({ relativePath, actor });
    }
    const res = await auth.handler(toWebRequest(request));
    if (guarded) {
      await throttle.record({
        username,
        ip: request.ip || "unknown",
        outcome: outcomeOfStatus(res.status),
      });
    }
    if (relativePath !== null && opts.auditSink) {
      const responseBody = await res
        .clone()
        .json()
        .catch(() => null);
      await record(
        buildAuthAuditEvent({
          relativePath,
          method: request.method,
          status: res.status,
          requestBody: request.body,
          responseBody,
          ip: request.ip || "unknown",
          userAgent: request.headers["user-agent"],
          actor,
        }),
      );
    }
    const provedFactor = PROVED_FACTOR_BY_PATH[relativePath ?? ""];
    if (
      provedFactor !== undefined &&
      opts.onSecondFactorVerified &&
      request.method.toUpperCase() === "POST" &&
      res.status >= 200 &&
      res.status < 300
    ) {
      try {
        const cookie = cookieHeaderAfter(
          request.headers.cookie,
          res.headers.getSetCookie?.() ?? [],
        );
        const session = await resolveActor(auth, request, cookie);
        if (session)
          await opts.onSecondFactorVerified({
            sessionId: session.sessionId,
            userId: session.userId,
            factor: provedFactor,
          });
      } catch (err) {
        opts.onSecondFactorError?.(err);
      }
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
      // Fastify appends array-valued Set-Cookie headers when `header()` is called again. Remove the
      // staged value first, then write the deliberately merged list once; otherwise the CSRF cookie
      // appears twice even though no cookie is lost.
      reply.removeHeader("set-cookie");
      reply.header("set-cookie", [...existingList, ...setCookies]);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return reply.send(body.length > 0 ? body : null);
  });
}
