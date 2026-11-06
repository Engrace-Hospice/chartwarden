// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-routes.ts — a platform operator
// enters a tenant's onboarding data on its behalf (`/api/v1/platform/tenants/:orgSlug/…`): provider entities (CCN /
// NPI / EIN), service locations and the MAC submitter credential.
//
// EVERY WRITE is behind, in order: the permission (`tenant_onboarding_data.write_platform`), the
// `tenant_lifecycle_platform_ops` predicate (the exact `platform_ops` role), a FRESH step-up, the AI-actor block (a
// person acts for a tenant, never an AI principal) and `Idempotency-Key`; the body carries a required `reason`
// (8-500 characters after normalising: whitespace collapsed, control characters removed) that lands on the audit row beside the operator and the tenant. The service then
// accepts the write only while the tenant is provisioning or onboarding (409 `TENANT_NOT_ONBOARDING` otherwise).
// READS (masked: no EIN, no secret exists in any view) need the read permission + the same predicate, and are audited.
//
// Org and operator are server-side: the tenant is the PATH slug, the operator is the session, never the body.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { ChartWardenError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectAiActor } from "../../../../bootstrap/reject-ai-actor";
import type { OnboardingDataService, OnboardingOperator } from "./onboarding-data-service";
import {
  ONBOARDING_REASON_MAX,
  ONBOARDING_REASON_MIN,
  OnboardingClearinghousePutRequest,
  OnboardingClearinghouseVerifyRequest,
  OnboardingLocationCreateRequest,
  OnboardingLocationPatchRequest,
  OnboardingMacCredentialUpsertRequest,
  OnboardingMedicaidCredentialUpsertRequest,
  OnboardingProviderEntityCreateRequest,
  OnboardingProviderEntityPatchRequest,
  OnboardingReasonSchema,
  OnboardingResourceParamsSchema,
  normalizeReason,
} from "./onboarding-data-typebox";
import { OrgSlugParamsSchema, parse } from "./platform-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OnboardingDataRouteDeps {
  readonly service: OnboardingDataService;
  /** Per-user cap on the clearinghouse `verify` (a vendor call per request); fail-open. Absent = unlimited. */
  readonly clearinghouseVerifyRateLimit?: PreHandler;
}

const READ_KEY = "tenant_onboarding_data.read_platform";
const WRITE_KEY = "tenant_onboarding_data.write_platform";
const PLATFORM_OPS = "tenant_lifecycle_platform_ops";
/** ADR-0053 amendment 2026-11-06: the tenant's clearinghouse choice has its own pair of keys (platform_ops only). */
const CLEARINGHOUSE_READ_KEY = "tenant_clearinghouse.read_platform";
const CLEARINGHOUSE_WRITE_KEY = "tenant_clearinghouse.write_platform";
/** Owner decision D2: verifying the BAA a tenant recorded for its own vendor account is its own key (a separable duty). */
const CLEARINGHOUSE_VERIFY_BAA_KEY = "tenant_clearinghouse.verify_baa_platform";
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const OPS = (key: string): PreHandler => requireAbac(key, PLATFORM_OPS) as PreHandler;

/** `Idempotency-Key` presence (the 24h replay caching is the M1 global middleware; the other modules carry the same guard). */
const requireIdempotencyKey: PreHandler = async (request) => {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ChartWardenError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "an Idempotency-Key header is required on this route",
      400,
    );
  }
};

const READ: readonly PreHandler[] = [P(READ_KEY), OPS(READ_KEY)];
const WRITE: readonly PreHandler[] = [
  P(WRITE_KEY),
  OPS(WRITE_KEY),
  requireStepUp(WRITE_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

const CLEARINGHOUSE_READ: readonly PreHandler[] = [
  P(CLEARINGHOUSE_READ_KEY),
  OPS(CLEARINGHOUSE_READ_KEY),
];
const CLEARINGHOUSE_WRITE: readonly PreHandler[] = [
  P(CLEARINGHOUSE_WRITE_KEY),
  OPS(CLEARINGHOUSE_WRITE_KEY),
  requireStepUp(CLEARINGHOUSE_WRITE_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

const CLEARINGHOUSE_VERIFY_BAA: readonly PreHandler[] = [
  P(CLEARINGHOUSE_VERIFY_BAA_KEY),
  OPS(CLEARINGHOUSE_VERIFY_BAA_KEY),
  requireStepUp(CLEARINGHOUSE_VERIFY_BAA_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

/** The operator, from the server-assembled session (never the body); 401 when the session has no membership. */
function operatorOf(request: FastifyRequest): OnboardingOperator {
  const ctx = request.context;
  const membershipId = ctx?.attributes?.membershipId;
  if (!ctx?.organizationId || !ctx.userId || typeof membershipId !== "string") {
    throw new UnauthorizedError();
  }
  return {
    userId: ctx.userId,
    membershipId,
    organizationId: ctx.organizationId,
    roles: ctx.roles,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
    request: {
      correlationId: ctx.correlationId ?? String(request.id),
      requestId: String(request.id),
      route: `${request.method} ${request.routeOptions.url ?? ""}`.trim(),
      ...(ctx.ip ? { sourceIp: ctx.ip } : {}),
      ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    },
  };
}

/**
 * The body without its `reason`, plus the reason normalised and checked. `minLength` counts the spaces and invisible
 * characters a padded reason is made of, so the NORMALISED length is what is enforced: a reason of "abcd    " is a 422,
 * not an audit row, and what reaches the tenant-visible audit trail has no control or format characters in it.
 */
function splitReason<B extends { reason: string }>(
  body: B,
): { reason: string; fields: Omit<B, "reason"> } {
  const { reason, ...fields } = body;
  const normalized = normalizeReason(reason);
  if (normalized.length < ONBOARDING_REASON_MIN || normalized.length > ONBOARDING_REASON_MAX) {
    throw new ValidationError("request validation failed", [
      {
        field: "reason",
        code: "INVALID",
        message: `reason must be ${ONBOARDING_REASON_MIN}-${ONBOARDING_REASON_MAX} characters after whitespace is collapsed and control characters are removed`,
      },
    ]);
  }
  return { reason: normalized, fields };
}

/** The optional `If-Match` version of an existing MAC credential: absent on a first create, an integer on an update. */
function optionalIfMatch(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const unquoted = value
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
  const parsed = Number.parseInt(unquoted, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== unquoted) {
    throw new ValidationError("request validation failed", [
      {
        field: "If-Match",
        code: "INVALID",
        message: "If-Match must be the credential's integer version",
      },
    ]);
  }
  return parsed;
}

/**
 * The tenant a platform route acts on, the scope its rate limiter counts under: every operator belongs to the one platform org, so
 * counting under the caller's own org would pool every tenant's (and every operator's) budget into a single bucket (re-review L7).
 */
export const targetTenantScopeOf = (request: FastifyRequest): string | undefined => {
  const slug = (request.params as { orgSlug?: unknown } | undefined)?.orgSlug;
  return typeof slug === "string" && slug.length > 0 ? slug : undefined;
};

const BAA_PIN_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The REQUIRED `If-Match` of the BAA verification: the `baa.recordedAt` the operator read, a UTC ISO timestamp (quoted, weak-prefixed
 * or bare). The verification applies to that record or to nothing, so a tenant that swaps its BAA between the operator's read and click
 * cannot get the new document verified unseen (re-review M1).
 */
function requiredBaaPin(request: FastifyRequest): { readonly recordedAt: string } {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) {
    throw new ChartWardenError(
      "IF_MATCH_REQUIRED",
      "an If-Match header naming the BAA record's recordedAt is required on this route",
      428,
    );
  }
  const recordedAt = value
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
  const real = BAA_PIN_ISO.test(recordedAt) && new Date(recordedAt).toISOString() === recordedAt;
  if (!real) {
    throw new ValidationError("request validation failed", [
      {
        field: "If-Match",
        code: "INVALID",
        message:
          "If-Match must be the BAA record's recordedAt, a UTC timestamp such as 2026-11-05T21:30:00.123Z",
      },
    ]);
  }
  return { recordedAt };
}

export function registerOnboardingDataRoutes(
  app: FastifyInstance,
  deps: OnboardingDataRouteDeps,
): void {
  const { service } = deps;
  const CLEARINGHOUSE_VERIFY: readonly PreHandler[] = deps.clearinghouseVerifyRateLimit
    ? [...CLEARINGHOUSE_WRITE, deps.clearinghouseVerifyRateLimit]
    : CLEARINGHOUSE_WRITE;
  const slugOf = (request: FastifyRequest): string =>
    parse(OrgSlugParamsSchema, request.params).orgSlug;
  const idParamsOf = (request: FastifyRequest) =>
    parse(OnboardingResourceParamsSchema, request.params);

  // ── provider entities ──
  app.get(
    "/api/v1/platform/tenants/:orgSlug/provider-entities",
    { preHandler: [...READ] },
    async (request) => service.listProviderEntities(operatorOf(request), slugOf(request)),
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/provider-entities",
    { preHandler: [...WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingProviderEntityCreateRequest, request.body),
      );
      return reply
        .code(201)
        .send(await service.createProviderEntity(op, slugOf(request), fields, reason));
    },
  );

  app.patch(
    "/api/v1/platform/tenants/:orgSlug/provider-entities/:id",
    { preHandler: [...WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { orgSlug, id } = idParamsOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingProviderEntityPatchRequest, request.body),
      );
      return service.updateProviderEntity(op, orgSlug, id, fields, reason);
    },
  );

  // ── locations ──
  app.get(
    "/api/v1/platform/tenants/:orgSlug/locations",
    { preHandler: [...READ] },
    async (request) => service.listLocations(operatorOf(request), slugOf(request)),
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/locations",
    { preHandler: [...WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(parse(OnboardingLocationCreateRequest, request.body));
      return reply
        .code(201)
        .send(await service.createLocation(op, slugOf(request), fields, reason));
    },
  );

  app.patch(
    "/api/v1/platform/tenants/:orgSlug/locations/:id",
    { preHandler: [...WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { orgSlug, id } = idParamsOf(request);
      const { reason, fields } = splitReason(parse(OnboardingLocationPatchRequest, request.body));
      return service.updateLocation(op, orgSlug, id, fields, reason);
    },
  );

  // ── MAC submitter credential (secret write-only, never returned) ──
  app.get(
    "/api/v1/platform/tenants/:orgSlug/mac-credentials",
    { preHandler: [...READ] },
    async (request) => service.listMacCredentials(operatorOf(request), slugOf(request)),
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/mac-credentials",
    { preHandler: [...WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingMacCredentialUpsertRequest, request.body),
      );
      const expectedVersion = optionalIfMatch(request);
      const res = await service.upsertMacCredential(
        op,
        slugOf(request),
        fields,
        reason,
        expectedVersion,
      );
      // Mirrors the tenant route: a first create answers 201, a version-checked update 200.
      return reply.code(expectedVersion === undefined ? 201 : 200).send(res);
    },
  );

  // ── state Medicaid trading-partner credential (secrets write-only, never returned) ──
  app.get(
    "/api/v1/platform/tenants/:orgSlug/state-medicaid-credentials",
    { preHandler: [...READ] },
    async (request) => service.listMedicaidCredentials(operatorOf(request), slugOf(request)),
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/state-medicaid-credentials",
    { preHandler: [...WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingMedicaidCredentialUpsertRequest, request.body),
      );
      return reply
        .code(201)
        .send(await service.upsertMedicaidCredential(op, slugOf(request), fields, reason));
    },
  );

  // ── the tenant's clearinghouse choice (credential write-only, never returned) ──
  app.get(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse",
    { preHandler: [...CLEARINGHOUSE_READ] },
    async (request) => service.getClearinghouse(operatorOf(request), slugOf(request)),
  );

  app.put(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse",
    { preHandler: [...CLEARINGHOUSE_WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingClearinghousePutRequest, request.body),
      );
      const { created, view } = await service.putClearinghouse(
        op,
        slugOf(request),
        fields,
        reason,
        optionalIfMatch(request),
      );
      // A first choice answers 201, a version-checked change 200.
      return reply.code(created ? 201 : 200).send(view);
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse/verify",
    { preHandler: [...CLEARINGHOUSE_VERIFY] },
    async (request) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(
        parse(OnboardingClearinghouseVerifyRequest, request.body),
      );
      return service.verifyClearinghouse(op, slugOf(request), fields, reason);
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse/activate",
    { preHandler: [...CLEARINGHOUSE_WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.activateClearinghouse(op, slugOf(request), reason);
    },
  );

  // POST baa/verify — the operator verifies the vendor BAA the tenant recorded for its own account. Not gated on the tenant's
  // onboarding status (a live tenant that changed vendor needs it too); the audit row names the operator, the org, the reason and the
  // record verified. `If-Match` is the record's recordedAt (see requiredBaaPin): verifying a record the operator did not read is a 409.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse/baa/verify",
    { preHandler: [...CLEARINGHOUSE_VERIFY_BAA] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.verifyClearinghouseBaa(op, slugOf(request), reason, requiredBaaPin(request));
    },
  );
}
