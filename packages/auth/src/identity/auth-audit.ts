// @chartwarden/auth · identity — the authentication audit trail (M2 §8.1, GAP-002 / GAP-004).
//
// WHAT WAS MISSING. Better Auth's HTTP surface (sign-in, sign-out, password reset, 2FA, passkey,
// session revoke) wrote NO audit_event: only step-up, portal-session and link-redemption paths were
// audited. HIPAA 164.312(b) and M2 §8.1 / §16.2.1 require every authentication event, failed ones
// and account lockout included, to leave a trail.
//
// SHAPE. This module is pure: it maps (path, status, response body, resolved actor) onto a typed
// {@link AuthAuditEvent} and hands it to an injected {@link AuthAuditSink}. The sink (the backend's
// M4 audit writer) owns persistence, so `@chartwarden/auth` takes no dependency on the audit package.
// Nothing here ever carries a password, token, TOTP/backup code or raw email: the username is
// reduced to {@link credentialKey}'s SHA-256 prefix and the IP to a network prefix.
import { credentialKey } from "./credential-throttle";

/** The persisted event types (catalogued in @chartwarden/audit's M2 action catalog). */
export const AUTH_AUDIT_EVENTS = {
  loginSucceeded: "m2.auth.login_succeeded",
  loginFailed: "m2.auth.login_failed",
  accountLocked: "m2.auth.account_locked",
  logout: "m2.auth.logout",
  passwordReset: "m2.auth.password_reset",
  twoFactorEnrolled: "m2.auth.2fa_enrolled",
  twoFactorDisabled: "m2.auth.2fa_disabled",
  backupCodeUsed: "m2.auth.backup_code_used",
  passkeyRegistered: "m2.passkey.registered",
  passkeyRemoved: "m2.passkey.removed",
  sessionRevoked: "m2.session.revoked",
} as const;

export type AuthAuditEventType = (typeof AUTH_AUDIT_EVENTS)[keyof typeof AUTH_AUDIT_EVENTS];

/** One authentication event, ready for the sink. `context` never holds a secret. */
export interface AuthAuditEvent {
  readonly eventType: AuthAuditEventType;
  readonly outcome: "success" | "failure";
  readonly severity: "info" | "warn" | "critical";
  /** The acting / affected user, when known (a failed login against an unknown address has none). */
  readonly userId?: string;
  readonly sessionId?: string;
  /** The org the acting session is bound to, when it is (org-scoped trail); absent pre-org-binding. */
  readonly organizationId?: string;
  readonly ipPrefix: string;
  readonly userAgent?: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/** Persists one event. Rejections are the caller's to log; they never fail the auth request. */
export type AuthAuditSink = (event: AuthAuditEvent) => Promise<void>;

/** Who is acting on an authenticated auth endpoint, as resolved from the request's session. */
export interface AuthAuditActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId?: string;
}

/** `/sign-in/email` etc. and the other credential-bearing endpoints, relative to the base path. */
const PASSWORD_SIGN_IN = new Set(["/sign-in/email", "/sign-in/username"]);
const PASSKEY_SIGN_IN = "/passkey/verify-authentication";
const TOTP_VERIFY = "/two-factor/verify-totp";
const BACKUP_VERIFY = "/two-factor/verify-backup-code";
const SESSION_REVOKE = new Set(["/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);

/** Endpoints whose event needs the acting user, so the bridge must resolve the session BEFORE the handler runs
 *  (sign-out and revoke destroy it; the 2FA / passkey routes act on it). */
const ACTOR_PATHS = new Set<string>([
  "/sign-out",
  "/two-factor/enable",
  "/two-factor/disable",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  ...SESSION_REVOKE,
]);

/** Strip the base path and query: `/api/auth/sign-out?x` -> `/sign-out`; null when outside the base. */
export function relativeAuthPath(url: string, basePath: string): string | null {
  const withoutQuery = url.split("?", 1)[0] ?? url;
  return withoutQuery.startsWith(`${basePath}/`) ? withoutQuery.slice(basePath.length) : null;
}

/** Whether the bridge must resolve the acting session before running the handler for this path. */
export function needsActor(relativePath: string): boolean {
  return ACTOR_PATHS.has(relativePath);
}

/** Coarsen an address to its network prefix (v4 /24, v6 /48) - enough to correlate, not to identify. */
export function ipPrefixOf(ip: string): string {
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0/24` : "unknown";
  }
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::/48`;
  return "unknown";
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** The user id a successful sign-in response names (`{ user: { id } }`, or `{ session: { userId } }`). */
function userIdFromSignInBody(body: unknown): string | undefined {
  const record = asRecord(body);
  return (
    stringField(asRecord(record.user), "id") ?? stringField(asRecord(record.session), "userId")
  );
}

/** What the bridge knows about one completed auth request. */
export interface AuthRequestFacts {
  /** Path relative to the auth base path (see {@link relativeAuthPath}). */
  readonly relativePath: string;
  readonly method: string;
  readonly status: number;
  /** Parsed JSON request body (never logged beyond the username hash). */
  readonly requestBody: unknown;
  /** Parsed JSON response body, or null when empty / not JSON. */
  readonly responseBody: unknown;
  readonly ip: string;
  readonly userAgent?: string;
  /** The session acting on the request, resolved before the handler ran (see {@link needsActor}). */
  readonly actor?: AuthAuditActor | null;
}

const isOk = (status: number) => status >= 200 && status < 300;
const isRefusal = (status: number) => status === 401 || status === 403;

/**
 * Map one completed auth request onto its audit event, or null when it is not an audited event
 * (session reads, callbacks, a 2xx password sign-in that is only awaiting its second factor, ...).
 * A 429/5xx/validation failure is deliberately NOT a `login_failed`: it is not a credential verdict.
 */
export function buildAuthAuditEvent(facts: AuthRequestFacts): AuthAuditEvent | null {
  const { relativePath: path, status, actor } = facts;
  if (facts.method.toUpperCase() !== "POST") return null;
  const base = {
    ipPrefix: ipPrefixOf(facts.ip),
    ...(facts.userAgent === undefined ? {} : { userAgent: facts.userAgent }),
  };
  const actorFields = actor
    ? {
        userId: actor.userId,
        sessionId: actor.sessionId,
        ...(actor.organizationId === undefined ? {} : { organizationId: actor.organizationId }),
      }
    : {};
  const event = (
    eventType: AuthAuditEventType,
    outcome: AuthAuditEvent["outcome"],
    severity: AuthAuditEvent["severity"],
    extra: Partial<AuthAuditEvent> & { context?: Record<string, unknown> } = {},
  ): AuthAuditEvent => ({
    eventType,
    outcome,
    severity,
    ...base,
    ...extra,
    context: extra.context ?? {},
  });

  if (PASSWORD_SIGN_IN.has(path)) {
    const username =
      stringField(asRecord(facts.requestBody), "email") ??
      stringField(asRecord(facts.requestBody), "username");
    const emailHash = username === undefined ? undefined : credentialKey(username);
    if (isOk(status)) {
      // A 2FA-gated account answers 200 `{ twoFactorRedirect: true }` with no session: not a login yet.
      if (asRecord(facts.responseBody).twoFactorRedirect === true) return null;
      const userId = userIdFromSignInBody(facts.responseBody);
      return event("m2.auth.login_succeeded", "success", "info", {
        ...(userId === undefined ? {} : { userId }),
        context: { factor: "password" },
      });
    }
    if (isRefusal(status))
      return event("m2.auth.login_failed", "failure", "warn", {
        context: { reason: "invalid_credentials", ...(emailHash ? { emailHash } : {}) },
      });
    return null;
  }
  if (path === PASSKEY_SIGN_IN || path === TOTP_VERIFY || path === BACKUP_VERIFY) {
    const factor =
      path === PASSKEY_SIGN_IN ? "passkey" : path === TOTP_VERIFY ? "totp" : "backup_code";
    if (isOk(status)) {
      const userId = userIdFromSignInBody(facts.responseBody);
      return event(
        path === BACKUP_VERIFY ? "m2.auth.backup_code_used" : "m2.auth.login_succeeded",
        "success",
        path === BACKUP_VERIFY ? "warn" : "info",
        { ...(userId === undefined ? {} : { userId }), context: { factor } },
      );
    }
    if (isRefusal(status) || status === 400)
      return event("m2.auth.login_failed", "failure", "warn", {
        context: { reason: "second_factor_invalid", factor },
      });
    return null;
  }
  if (!isOk(status)) return null;
  switch (path) {
    case "/sign-out":
      return event("m2.auth.logout", "success", "info", actorFields);
    case "/two-factor/enable":
      return event("m2.auth.2fa_enrolled", "success", "info", {
        ...actorFields,
        context: { method: "totp" },
      });
    case "/two-factor/disable":
      return event("m2.auth.2fa_disabled", "success", "warn", {
        ...actorFields,
        context: { method: "totp" },
      });
    case "/passkey/verify-registration":
      return event("m2.passkey.registered", "success", "info", actorFields);
    case "/passkey/delete-passkey": {
      const passkeyId = stringField(asRecord(facts.requestBody), "id");
      return event("m2.passkey.removed", "success", "warn", {
        ...actorFields,
        context: passkeyId === undefined ? {} : { passkeyId },
      });
    }
    default:
      if (SESSION_REVOKE.has(path))
        return event("m2.session.revoked", "success", "info", {
          ...actorFields,
          context: { scope: path.slice(1) },
        });
      return null;
  }
}

/** The lockout event: raised when the credential throttle refuses a sign-in because its budget is spent. */
export function buildAccountLockedEvent(input: {
  readonly username: string | null;
  readonly ip: string;
  readonly userAgent?: string;
  readonly retryAfterSeconds: number;
  readonly now?: () => Date;
}): AuthAuditEvent {
  const until = new Date(
    (input.now ?? (() => new Date()))().getTime() + input.retryAfterSeconds * 1000,
  );
  return {
    eventType: "m2.auth.account_locked",
    outcome: "failure",
    severity: "critical",
    ipPrefix: ipPrefixOf(input.ip),
    ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    context: {
      until: until.toISOString(),
      ...(input.username === null ? {} : { emailHash: credentialKey(input.username) }),
    },
  };
}

/** The password-reset event (Better Auth's `onPasswordReset` hands us the user; the HTTP body names none). */
export function buildPasswordResetEvent(userId: string): AuthAuditEvent {
  return {
    eventType: "m2.auth.password_reset",
    outcome: "success",
    severity: "warn",
    userId,
    ipPrefix: "unknown",
    context: {},
  };
}
