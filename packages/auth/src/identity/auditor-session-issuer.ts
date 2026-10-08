// @wardenx/auth · identity — mint a Better Auth `auditor`-class session from a redeemed magic link
// (M2 §2.2.4 / §7.7). This is the half of the auditor flow the batch-11 `auditor_magic_link` store left
// undone: the link was issued and consumable in SQL, but nothing turned a consumed link into a session.
//
// It lives in packages/auth because it must reach Better Auth's own context (`auth.$context`) — the
// `better-auth` import boundary (manifest VENDOR_ADAPTERS). It creates the session through Better Auth's
// `internalAdapter.createSession`, so the `databaseHooks.session.create.before` refusal of a suspended /
// deactivated user (GAP-001) runs, and signs the session cookie exactly as Better Auth does:
// `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))`. A signed cookie minted here is
// therefore resolved by the ordinary `auth.api.getSession` path with no auditor special case.
//
// Class-bound by construction: `sessionClass` is "auditor", `scope.engagementId` carries the engagement
// (what `AuditorEngagementReader` / `portal_engagement_scope` compare against), `engagement_start/end` bound
// the window (the `session_scope_chk` requirement) and the session NEVER outlives `engagement_end`.
import { createHmac } from "node:crypto";
import { AUDITOR_STAGE_ENROLMENT } from "./session-classes";

/** The cookie attributes Better Auth publishes for its session cookie (subset we serialise). */
interface CookieAttributes {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
  readonly path?: string;
  readonly domain?: string;
}

/** The slice of a Better Auth `$context` the issuer uses (structural — no better-auth type import). */
export interface AuditorIssuerAuthContext {
  readonly secret: string;
  readonly authCookies: {
    readonly sessionToken: { readonly name: string; readonly attributes: CookieAttributes };
  };
  readonly internalAdapter: {
    createSession(
      userId: string,
      dontRememberMe?: boolean,
      override?: Record<string, unknown>,
      overrideAll?: boolean,
    ): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: Date } | null>;
  };
}

/** What the issuer needs from a Better Auth instance (`createIdentityAuth(...)` satisfies it). */
export interface AuditorIssuerAuth {
  readonly $context: Promise<AuditorIssuerAuthContext>;
}

export interface IssueAuditorSessionInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly engagementId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  /** Injectable clock (tests). */
  readonly now?: Date;
}

export interface IssuedAuditorSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
  /** A complete `Set-Cookie` header value. */
  readonly setCookie: string;
}

export interface AuditorSessionIssuer {
  issue(input: IssueAuditorSessionInput): Promise<IssuedAuditorSession>;
}

/** Raised when the session cannot be created (inactive user, window already over, adapter fault). */
export class AuditorSessionIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditorSessionIssueError";
  }
}

/** Better Auth's signed-cookie value: `token.base64(HMAC-SHA256)` then URI-encoded. */
export function signSessionCookieValue(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

function serializeCookie(
  name: string,
  value: string,
  cookieOptions: CookieAttributes,
  maxAgeSec: number,
): string {
  const parts = [`${name}=${value}`, `Max-Age=${maxAgeSec}`, `Path=${cookieOptions.path ?? "/"}`];
  if (cookieOptions.domain) parts.push(`Domain=${cookieOptions.domain}`);
  if (cookieOptions.httpOnly !== false) parts.push("HttpOnly");
  if (cookieOptions.secure) parts.push("Secure");
  if (cookieOptions.sameSite) {
    const s = cookieOptions.sameSite.toLowerCase();
    parts.push(`SameSite=${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  }
  return parts.join("; ");
}

export function createAuditorSessionIssuer(auth: AuditorIssuerAuth): AuditorSessionIssuer {
  return {
    async issue(input) {
      const now = input.now ?? new Date();
      // The window must still be open: never mint a session whose end is already past.
      if (input.windowEnd.getTime() <= now.getTime()) {
        throw new AuditorSessionIssueError("the engagement window has ended");
      }
      const ctx = await auth.$context;
      const session = await ctx.internalAdapter.createSession(
        input.userId,
        false,
        {
          activeOrganizationId: input.organizationId,
          sessionClass: "auditor",
          // A freshly redeemed session is ENROLMENT-stage: it may reach only the enrolment routes until the
          // BAA is accepted and a second factor proven (apps/backend .../auditor-enrolment.ts upgrades it).
          scope: { engagementId: input.engagementId, auditorStage: AUDITOR_STAGE_ENROLMENT },
          engagementStart: input.windowStart,
          engagementEnd: input.windowEnd,
          // Bounded by the engagement window — `session-timeout` additionally enforces the 10-min idle.
          expiresAt: input.windowEnd,
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        },
        true,
      );
      if (!session) throw new AuditorSessionIssueError("session creation returned nothing");
      const maxAgeSec = Math.max(1, Math.floor((input.windowEnd.getTime() - now.getTime()) / 1000));
      const { name, attributes } = ctx.authCookies.sessionToken;
      return {
        sessionId: session.id,
        expiresAt: input.windowEnd,
        setCookie: serializeCookie(
          name,
          signSessionCookieValue(session.token, ctx.secret),
          attributes,
          maxAgeSec,
        ),
      };
    },
  };
}
