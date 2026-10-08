// @wardenx/auth · identity — minting a session for a REDEEMED magic link (M2 §3.6 / ADR-0026).
//
// ADR-0026: Better Auth is the SINGLE authentication surface; no module mints its own session tokens. A redeemed
// external-collaborator or funeral-home link has to end in a real `session` row plus a signed session cookie, and
// the only sanctioned way to produce those is Better Auth's own `internalAdapter.createSession` +
// `setSessionCookie`. This plugin exposes exactly that as a SERVER-ONLY endpoint:
//
//   * `createAuthEndpoint.serverOnly` — reachable through `auth.api.mintLinkSession(...)` from trusted server code
//     and NEVER registered on the HTTP router (better-call skips a SERVER_ONLY endpoint), so there is no URL a
//     client could POST a `userId` to. The caller (the Fastify redeem route) has already consumed the link
//     atomically and derived every input from the link row.
//   * the endpoint re-validates its own inputs (a closed class list, a uuid user, a pinned patient, a future
//     expiry) rather than trusting the caller, because it is the last gate before a credential exists.
//   * `session.create.before` (auth.ts) still runs, so a suspended / deactivated principal cannot be minted a
//     session even by a valid link.
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/** The two classes a redeemed link may mint. Portal classes are bound by sign-in, never by a link. */
export const LINK_SESSION_CLASSES = ["external_collaborator", "funeral_home"] as const;
export type LinkSessionClass = (typeof LINK_SESSION_CLASSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A link session never outlives the longest policy bound (funeral 72 h) plus a minute of slack. */
const MAX_LINK_SESSION_MS = (72 * 3600 + 60) * 1000;

/** What the trusted caller supplies after it has consumed the link. */
export interface LinkSessionMintInput {
  /** The credential-less principal `user` the session row belongs to. */
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionClass: LinkSessionClass;
  /** The ONE patient the session is pinned to (`session_scope_chk`). */
  readonly patientId: string;
  readonly expiresAt: Date;
}

/** The mint result: the new session id and the `Set-Cookie` header values to relay to the browser. */
export interface MintedLinkSession {
  readonly sessionId: string;
  readonly setCookies: readonly string[];
}

/** The seam the Fastify redeem route calls; built over a configured Better Auth instance. */
export interface LinkSessionMinter {
  mint(input: LinkSessionMintInput, requestHeaders: Headers): Promise<MintedLinkSession>;
}

interface MintBody {
  readonly userId?: unknown;
  readonly organizationId?: unknown;
  readonly sessionClass?: unknown;
  readonly patientId?: unknown;
  readonly expiresAtMs?: unknown;
}

function badInput(message: string): never {
  throw new APIError("BAD_REQUEST", { message, code: "LINK_SESSION_INVALID_INPUT" });
}

/** Better Auth plugin: the server-only link-session mint. Registered by `createIdentityAuth`. */
export const linkSessionPlugin = () =>
  ({
    id: "wardenx-link-session",
    endpoints: {
      mintLinkSession: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as MintBody;
        const { userId, organizationId, sessionClass, patientId, expiresAtMs } = body;
        if (typeof userId !== "string" || !UUID_RE.test(userId)) badInput("userId");
        if (typeof organizationId !== "string" || !UUID_RE.test(organizationId))
          badInput("organizationId");
        if (typeof patientId !== "string" || !UUID_RE.test(patientId)) badInput("patientId");
        if (
          typeof sessionClass !== "string" ||
          !(LINK_SESSION_CLASSES as readonly string[]).includes(sessionClass)
        )
          badInput("sessionClass");
        const nowMs = Date.now();
        if (
          typeof expiresAtMs !== "number" ||
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= nowMs ||
          expiresAtMs - nowMs > MAX_LINK_SESSION_MS
        )
          badInput("expiresAt");

        const user = await ctx.context.internalAdapter.findUserById(userId as string);
        if (!user) badInput("userId");
        const session = await ctx.context.internalAdapter.createSession(
          userId as string,
          false,
          {
            activeOrganizationId: organizationId,
            sessionClass,
            scope: { patientId },
            expiresAt: new Date(expiresAtMs as number),
          },
          // overrideAll: Better Auth otherwise lets the `session_class` DEFAULT ('staff') win over an override.
          true,
        );
        if (!session)
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "session could not be created",
            code: "LINK_SESSION_FAILED",
          });
        await setSessionCookie(ctx, { session, user: user as never });
        return ctx.json({ sessionId: session.id });
      }),
    },
  }) as const;

/** The structural slice of a Better Auth instance the minter needs (`auth.api.mintLinkSession`). */
export interface LinkSessionCapableAuth {
  // Better Auth types a body-schema-less endpoint's `body` as `undefined`; the endpoint validates `ctx.body` itself
  // (above), so the structural slice is deliberately argument-agnostic and the one call below re-types it.
  api: { mintLinkSession: (context: never) => Promise<unknown> };
}

type MintCall = (args: {
  body: Record<string, unknown>;
  headers: Headers;
  asResponse: true;
}) => Promise<Response>;

/** Build the {@link LinkSessionMinter} over a Better Auth instance that registered {@link linkSessionPlugin}. */
export function createLinkSessionMinter(auth: LinkSessionCapableAuth): LinkSessionMinter {
  return {
    async mint(input, requestHeaders) {
      const res = await (auth.api.mintLinkSession as unknown as MintCall)({
        body: {
          userId: input.userId,
          organizationId: input.organizationId,
          sessionClass: input.sessionClass,
          patientId: input.patientId,
          expiresAtMs: input.expiresAt.getTime(),
        },
        headers: requestHeaders,
        asResponse: true,
      });
      if (!res.ok) throw new Error(`link session mint refused (${res.status})`);
      const payload = (await res.json()) as { sessionId?: unknown };
      if (typeof payload.sessionId !== "string")
        throw new Error("link session mint returned no id");
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length === 0) throw new Error("link session mint set no cookie");
      return { sessionId: payload.sessionId, setCookies };
    },
  };
}
