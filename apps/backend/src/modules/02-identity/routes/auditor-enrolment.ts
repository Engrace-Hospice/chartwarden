// apps/backend/src/modules/02-identity/routes/auditor-enrolment.ts - `/api/v1/auditors/enrolment/*` (M2 §7.7).
//
// The five routes an ENROLMENT-stage auditor session may call (the authenticate hook allowlists exactly these;
// everything else, the engagement read included, is AUDITOR_ENROLMENT_REQUIRED until the ceremony finishes):
//
//   GET  /state         where the auditor is: terms to read, second-factor status, lockout
//   POST /baa           accept the versioned BAA / engagement terms
//   POST /totp/begin    first engagement only: a fresh authenticator secret (otpauth URI + manual key)
//   POST /totp/confirm  first engagement only: the first code - the factor is real, recovery codes shown ONCE
//   POST /verify        later engagements: present a TOTP code or a single-use recovery code
//
// Auth column: `session` (an auditor-class session). There is no permission key to require - an enrolment session
// deliberately holds NO role - so the gate is `requireAbac("auditor.enrolment", "auditor_enrolment_session")`, a
// pure predicate over the session-stamped class and engagement (the engagement is never taken from the request).
// Wrong codes are rate limited per client address and per user here, and locked out per factor in the database
// (auditor-second-factor-store.ts). Nothing here is cacheable: recovery codes ride one response only.
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { requireAbac } from "@chartwarden/auth";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerM2AbacPredicates } from "../abac-predicates";
import {
  type AuditorEnrolment,
  type EnrolmentActor,
  type EnrolmentResult,
  enrolmentRefusalError,
} from "../auditor-enrolment";
import type { AttemptLimiter } from "./auditor-redeem";

const TERMS_HASH_PATTERN = "^[0-9a-f]{64}$";
const TOTP_CODE_PATTERN = "^[0-9]{6}$";
/** A recovery code as shown (XXXXX-XXXXX-XXXXX-XXXXX) or typed without separators. */
const RECOVERY_CODE_PATTERN = "^[A-Za-z0-9 -]{16,32}$";

export const EnrolmentStateSchema = Type.Object({
  stage: Type.Union([Type.Literal("enrolment"), Type.Literal("active")]),
  engagementId: Type.String(),
  terms: Type.Object({
    version: Type.String(),
    title: Type.String(),
    text: Type.String(),
    sha256: Type.String(),
  }),
  baaAccepted: Type.Boolean(),
  secondFactor: Type.Union([
    Type.Literal("enrol"),
    Type.Literal("challenge"),
    Type.Literal("verified"),
  ]),
  totpPending: Type.Boolean(),
  lockedUntil: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  expiresAt: Type.String({ format: "date-time" }),
});
export type EnrolmentStateResponse = Static<typeof EnrolmentStateSchema>;

export const AcceptTermsRequestSchema = Type.Object(
  {
    termsVersion: Type.String({ minLength: 1, maxLength: 64 }),
    termsSha256: Type.String({ pattern: TERMS_HASH_PATTERN }),
    acceptedName: Type.String({ minLength: 2, maxLength: 120 }),
  },
  { additionalProperties: false },
);

export const BeginTotpResponseSchema = Type.Object({
  otpauthUri: Type.String(),
  manualEntryKey: Type.String(),
});

export const ConfirmTotpRequestSchema = Type.Object(
  { code: Type.String({ pattern: TOTP_CODE_PATTERN }) },
  { additionalProperties: false },
);

export const ConfirmTotpResponseSchema = Type.Object({
  recoveryCodes: Type.Array(Type.String()),
  state: EnrolmentStateSchema,
});

export const VerifyFactorRequestSchema = Type.Object(
  {
    totpCode: Type.Optional(Type.String({ pattern: TOTP_CODE_PATTERN })),
    recoveryCode: Type.Optional(Type.String({ pattern: RECOVERY_CODE_PATTERN })),
  },
  { additionalProperties: false },
);

export interface AuditorEnrolmentRouteDeps {
  readonly enrolment: AuditorEnrolment;
  /** Per client address. Absent => only the global SD-055 tier applies. */
  readonly ipLimiter?: AttemptLimiter;
  /** Per authenticated auditor user. */
  readonly userLimiter?: AttemptLimiter;
}

function parse<T extends ReturnType<typeof Type.Object>>(schema: T, raw: unknown): Static<T> {
  if (!Value.Check(schema, raw ?? {})) {
    const first = [...Value.Errors(schema, raw ?? {})][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return raw as Static<T>;
}

/** The enrolment actor, assembled ONLY from the authenticate hook's server-side stamps. */
function actorOf(request: FastifyRequest): EnrolmentActor {
  const ctx = request.context;
  const sessionId = ctx.attributes?.sessionId;
  const engagementId = ctx.attributes?.auditorEnrolmentEngagementId;
  if (
    !ctx.organizationId ||
    !ctx.userId ||
    typeof sessionId !== "string" ||
    typeof engagementId !== "string"
  ) {
    throw new UnauthorizedError();
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    sessionId,
    engagementId,
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    ...(ctx.ip ? { ip: ctx.ip } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  };
}

const ENROLMENT_GUARD = requireAbac("auditor.enrolment", "auditor_enrolment_session", {
  getTarget: (request: { context?: { attributes?: Record<string, unknown> } }) => ({
    engagementId: request.context?.attributes?.auditorEnrolmentEngagementId,
  }),
});

export function registerAuditorEnrolmentRoutes(
  app: FastifyInstance,
  deps: AuditorEnrolmentRouteDeps,
): void {
  const guard = [ENROLMENT_GUARD as unknown as (request: FastifyRequest) => Promise<void>];
  // The guard's predicate must exist whichever M2 mount ran first (idempotent, single-owner registry).
  registerM2AbacPredicates();

  async function budget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    for (const [limiter, key] of [
      [deps.ipLimiter, request.ip || "unknown"],
      [deps.userLimiter, request.context.userId],
    ] as const) {
      const verdict = await limiter?.consume(key);
      if (verdict && !verdict.allowed) {
        if (verdict.retryAfterSeconds !== undefined) {
          reply.header("Retry-After", String(verdict.retryAfterSeconds));
        }
        throw new RateLimitedError("too many auditor enrolment attempts");
      }
    }
  }

  /** Unwrap a result, or throw the typed envelope (setting Retry-After on a lockout). */
  function unwrap<T>(reply: FastifyReply, result: EnrolmentResult<T>): T {
    if (result.ok) return result.value;
    if (result.refusal.retryAfterSec !== undefined) {
      reply.header("Retry-After", String(result.refusal.retryAfterSec));
    }
    throw enrolmentRefusalError(result.refusal);
  }

  app.get("/api/v1/auditors/enrolment/state", { preHandler: guard }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return unwrap(reply, await deps.enrolment.getState(actorOf(request)));
  });

  app.post("/api/v1/auditors/enrolment/baa", { preHandler: guard }, async (request, reply) => {
    await budget(request, reply);
    const body = parse(AcceptTermsRequestSchema, request.body);
    reply.header("Cache-Control", "no-store");
    return unwrap(reply, await deps.enrolment.acceptTerms(actorOf(request), body));
  });

  app.post(
    "/api/v1/auditors/enrolment/totp/begin",
    { preHandler: guard },
    async (request, reply) => {
      await budget(request, reply);
      reply.header("Cache-Control", "no-store");
      return unwrap(reply, await deps.enrolment.beginTotp(actorOf(request)));
    },
  );

  app.post(
    "/api/v1/auditors/enrolment/totp/confirm",
    { preHandler: guard },
    async (request, reply) => {
      await budget(request, reply);
      const body = parse(ConfirmTotpRequestSchema, request.body);
      reply.header("Cache-Control", "no-store");
      return unwrap(reply, await deps.enrolment.confirmTotp(actorOf(request), body.code));
    },
  );

  app.post("/api/v1/auditors/enrolment/verify", { preHandler: guard }, async (request, reply) => {
    await budget(request, reply);
    const body = parse(VerifyFactorRequestSchema, request.body);
    if ((body.totpCode === undefined) === (body.recoveryCode === undefined)) {
      throw new ValidationError("request validation failed", [
        {
          field: "totpCode",
          code: "INVALID",
          message: "provide exactly one of totpCode or recoveryCode",
        },
      ]);
    }
    const presented =
      body.totpCode !== undefined
        ? ({ kind: "totp", code: body.totpCode } as const)
        : ({ kind: "recovery", code: body.recoveryCode ?? "" } as const);
    reply.header("Cache-Control", "no-store");
    return unwrap(reply, await deps.enrolment.presentFactor(actorOf(request), presented));
  });
}
