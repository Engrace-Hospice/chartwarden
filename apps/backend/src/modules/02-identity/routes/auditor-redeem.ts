// apps/backend/src/modules/02-identity/routes/auditor-redeem.ts — `POST /api/v1/auditors/redeem`.
//
// The public, unauthenticated half of the auditor flow (M2 §2.2.4 / §7.7): the emailed single-use link is
// redeemed into a scoped `auditor`-class ENROLMENT session (see ../auditor-redemption.ts for what that does);
// the auditor then accepts the BAA terms and proves a second factor through `./auditor-enrolment.ts` before the
// session can read anything. M3 owns the engagement and the enrolment route (`POST /engagements/:id/auditors`); M2 owns session
// mechanics, so redemption is an M2 route — the same split the AuditorSessionMinter seam records (D4).
//
// Auth column: `none` — the caller presents the one-time token, exactly like `POST /collaborators/consume`.
// There is therefore no `requirePermission` / `requireAbac` here: those guard an authenticated principal and
// there is none yet. The controls are: a 256-bit single-use token stored only as a sha-256 digest, constant
// time comparison, tenant scoping (the org id in the link is checked against RLS, so another tenant's token
// is simply "unknown"), per-IP and per-organization attempt budgets, and an audited, typed refusal for every
// failure of a real link. A replay is a 409, never a second session — the single-use token IS the
// idempotency control (an Idempotency-Key cache would have to replay a `Set-Cookie`, which it must not).
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RateLimitedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AuditorRedemptionDeps, redeemAuditorLink } from "../auditor-redemption";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** A 256-bit random token, base64url-encoded (43 chars) — see `generateAuditorToken`. */
const TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";

/** POST /api/v1/auditors/redeem — the emailed link's org id and one-time token. */
export const AuditorRedeemRequestSchema = Type.Object(
  {
    organizationId: Type.String({ pattern: UUID_PATTERN }),
    token: Type.String({ pattern: TOKEN_PATTERN }),
  },
  { additionalProperties: false },
);

/**
 * POST /api/v1/auditors/redeem (200) — the session metadata; the session cookie rides `Set-Cookie`. The session
 * is ENROLMENT-stage: it reaches only `/api/v1/auditors/enrolment/*` until the auditor accepts the BAA terms and
 * proves a second factor (M2 §7.7), at which point it becomes the read-only engagement session.
 */
export const AuditorRedeemResponseSchema = Type.Object({
  sessionClass: Type.Literal("auditor"),
  stage: Type.Literal("enrolment"),
  organizationId: Type.String(),
  engagementId: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
});
export type AuditorRedeemResponse = Static<typeof AuditorRedeemResponseSchema>;

/** A budgeted limiter (`createBudgetedRateLimiter` structurally). */
export interface AttemptLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export interface AuditorRedeemRouteDeps {
  readonly redemption: AuditorRedemptionDeps;
  /** Per client address. Absent ⇒ only the global SD-055 tier applies. */
  readonly ipLimiter?: AttemptLimiter;
  /** Per organization named in the link (distributed guessing against one tenant). */
  readonly orgLimiter?: AttemptLimiter;
}

function parseBody(raw: unknown): Static<typeof AuditorRedeemRequestSchema> {
  if (!Value.Check(AuditorRedeemRequestSchema, raw ?? {})) {
    const first = [...Value.Errors(AuditorRedeemRequestSchema, raw ?? {})][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return raw as Static<typeof AuditorRedeemRequestSchema>;
}

const ipOf = (request: FastifyRequest): string => request.ip || "unknown";

export function registerAuditorRedeemRoutes(
  app: FastifyInstance,
  deps: AuditorRedeemRouteDeps,
): void {
  app.post("/api/v1/auditors/redeem", async (request, reply) => {
    const body = parseBody(request.body);

    // Attempt budgets BEFORE any database work: a flood costs a Valkey INCR, not a query.
    for (const [limiter, key] of [
      [deps.ipLimiter, ipOf(request)],
      [deps.orgLimiter, body.organizationId],
    ] as const) {
      const verdict = await limiter?.consume(key);
      if (verdict && !verdict.allowed) {
        if (verdict.retryAfterSeconds !== undefined) {
          reply.header("Retry-After", String(verdict.retryAfterSeconds));
        }
        throw new RateLimitedError("too many auditor link attempts");
      }
    }

    const redeemed = await redeemAuditorLink(deps.redemption, {
      organizationId: body.organizationId,
      token: body.token,
      correlationId: request.context.correlationId,
      requestId: String(request.id),
      ...(request.context.ip ? { ip: request.context.ip } : {}),
      ...(request.context.userAgent ? { userAgent: request.context.userAgent } : {}),
    });

    reply.header("Cache-Control", "no-store");
    // MERGE with any cookie an earlier hook staged (the M1 CSRF plugin mints its double-submit cookie on every
    // request): a plain `reply.header("set-cookie", …)` would silently drop it.
    const staged = reply.getHeader("set-cookie");
    const stagedList =
      staged === undefined ? [] : Array.isArray(staged) ? staged.map(String) : [String(staged)];
    reply.header("set-cookie", [...stagedList, redeemed.setCookie]);
    return reply.code(200).send({
      sessionClass: "auditor",
      stage: "enrolment",
      organizationId: redeemed.organizationId,
      engagementId: redeemed.engagementId,
      expiresAt: redeemed.expiresAt.toISOString(),
    } satisfies AuditorRedeemResponse);
  });
}
