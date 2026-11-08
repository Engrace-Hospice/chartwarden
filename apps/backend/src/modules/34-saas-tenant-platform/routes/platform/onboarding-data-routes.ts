// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-routes.ts — a platform operator
// enters a tenant's onboarding data on its behalf (`/api/v1/platform/tenants/:orgSlug/…`): provider entities (CCN /
// NPI / EIN), service locations and the MAC submitter credential.
//
// EVERY WRITE is behind, in order: the permission (`tenant_onboarding_data.write_platform`), the
// `tenant_lifecycle_platform_ops` predicate (the exact `platform_ops` role), a FRESH step-up, the AI-actor block (a
// person acts for a tenant, never an AI principal) and `Idempotency-Key`; the body carries a required `reason`
// (8-500 characters after normalising: whitespace collapsed, control characters removed) that lands on the audit row beside the operator and the tenant. The service then
// accepts the write only while the tenant is provisioning or onboarding (409 `TENANT_NOT_ONBOARDING` otherwise), with four named
// exceptions: the clearinghouse switch out of `outside` that names a billing mode and the signed-BAA upload (a live tenant's renewal),
// each on an explicit allowlist of statuses (provisioning, onboarding, active, at_risk, suspended), and the vendor-BAA verification and the
// notice withdrawal (any status, still locked and audited).
// READS (masked: no EIN, no secret exists in any view) need the read permission + the same predicate, and are audited.
//
// Org and operator are server-side: the tenant is the PATH slug, the operator is the session, never the body.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { ChartWardenError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TENANT_BAA_MAX_BYTES } from "../../../../bootstrap/onboarding-baa-document-port";
import { rejectAiActor } from "../../../../bootstrap/reject-ai-actor";
import type { OnboardingDataService, OnboardingOperator } from "./onboarding-data-service";
import {
  BAA_UPLOAD_BODY_LIMIT_BYTES,
  ONBOARDING_REASON_MAX,
  ONBOARDING_REASON_MIN,
  OnboardingBaaDocumentUploadRequest,
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
  /** Per-user cap on the signed-BAA upload (each one stores an object of up to 10 MiB); fail-open. Absent = unlimited. */
  readonly baaUploadRateLimit?: PreHandler;
}

const READ_KEY = "tenant_onboarding_data.read_platform";
const WRITE_KEY = "tenant_onboarding_data.write_platform";
const PLATFORM_OPS = "tenant_lifecycle_platform_ops";
/** ADR-0053 amendment 2026-11-06: the tenant's clearinghouse choice has its own pair of keys (platform_ops only). */
const CLEARINGHOUSE_READ_KEY = "tenant_clearinghouse.read_platform";
const CLEARINGHOUSE_WRITE_KEY = "tenant_clearinghouse.write_platform";
/** Owner decision D2: verifying the BAA a tenant recorded for its own vendor account is its own key (a separable duty). */
const CLEARINGHOUSE_VERIFY_BAA_KEY = "tenant_clearinghouse.verify_baa_platform";
/** Owner decision 2026-11-08: releasing the clearinghouse credentials a tenant still holds is its own key (a separable duty). */
const CLEARINGHOUSE_RELEASE_KEY = "tenant_clearinghouse.release_credential_platform";
/** An operator withdrawing a tenant's "filed outside ChartWarden" NOE / NOTR record is its own key (a separable duty). */
const NOTICE_WITHDRAW_KEY = "tenant_notice_filing.withdraw_platform";
/**
 * The signed BAA upload (onboarding step 3) has its own key, NOT `documents.upload`: the one route behind it files one document kind
 * (`tenant_baa`) for the tenant in the path, and the key reads or lists no document.
 */
const BAA_DOCUMENT_UPLOAD_KEY = "tenant_baa_document.upload_platform";
/**
 * Naming a billing service mode on the clearinghouse switch is a PRICING write (the mode is set through M35's own path), so it also takes
 * the pricing key the contract routes use: the clearinghouse key alone does not let an operator change what a tenant is billed.
 */
const PRICING_WRITE_KEY = "subscription.onboard_platform";
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

const CLEARINGHOUSE_RELEASE: readonly PreHandler[] = [
  P(CLEARINGHOUSE_RELEASE_KEY),
  OPS(CLEARINGHOUSE_RELEASE_KEY),
  requireStepUp(CLEARINGHOUSE_RELEASE_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

const NOTICE_WITHDRAW: readonly PreHandler[] = [
  P(NOTICE_WITHDRAW_KEY),
  OPS(NOTICE_WITHDRAW_KEY),
  requireStepUp(NOTICE_WITHDRAW_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

/**
 * Refuses a declared Content-Length over the route's limit before the body is read or parsed (an `onRequest` hook, which runs ahead of
 * parsing), with the route's own typed 413. A body that declares no length is still bounded by `bodyLimit` while it streams.
 */
const refuseOversizedBaaUpload: PreHandler = async (request) => {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > BAA_UPLOAD_BODY_LIMIT_BYTES) {
    throw new ChartWardenError(
      "BAA_UPLOAD_TOO_LARGE",
      `the signed agreement can be at most ${TENANT_BAA_MAX_BYTES / (1024 * 1024)} MiB`,
      413,
    );
  }
};

const PRICING_WRITE: readonly PreHandler[] = [P(PRICING_WRITE_KEY), OPS(PRICING_WRITE_KEY)];

const BAA_DOCUMENT_UPLOAD: readonly PreHandler[] = [
  P(BAA_DOCUMENT_UPLOAD_KEY),
  OPS(BAA_DOCUMENT_UPLOAD_KEY),
  requireStepUp(BAA_DOCUMENT_UPLOAD_KEY) as PreHandler,
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

const RECORDED_AT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The `If-Match` of an action pinned to a record the operator read: that record's `recordedAt`, a UTC ISO timestamp (quoted,
 * weak-prefixed or bare), or null when the request named none. The action applies to that record or to nothing, so a tenant that
 * swaps its BAA (or re-records a filing) between the operator's read and click cannot get the new one acted on unseen (re-review
 * M1). `subject` names the record in the refusal message. A malformed pin is a 422 here.
 */
function recordedAtPinOrNull(
  request: FastifyRequest,
  subject: string,
): { readonly recordedAt: string | null } {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return { recordedAt: null };
  const recordedAt = value
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
  const real =
    RECORDED_AT_ISO.test(recordedAt) && new Date(recordedAt).toISOString() === recordedAt;
  if (!real) {
    throw new ValidationError("request validation failed", [
      {
        field: "If-Match",
        code: "INVALID",
        message: `If-Match must be the ${subject}'s recordedAt, a UTC timestamp such as 2026-11-05T21:30:00.123Z`,
      },
    ]);
  }
  return { recordedAt };
}

/** {@link recordedAtPinOrNull} for a route with no record to read first: a missing pin is the 428 right here. */
function requiredRecordedAtPin(
  request: FastifyRequest,
  subject: string,
): { readonly recordedAt: string } {
  const { recordedAt } = recordedAtPinOrNull(request, subject);
  if (recordedAt === null) {
    throw new ChartWardenError(
      "IF_MATCH_REQUIRED",
      `an If-Match header naming the ${subject}'s recordedAt is required on this route`,
      428,
    );
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
  const BAA_UPLOAD: readonly PreHandler[] = deps.baaUploadRateLimit
    ? [...BAA_DOCUMENT_UPLOAD, deps.baaUploadRateLimit]
    : BAA_DOCUMENT_UPLOAD;
  const slugOf = (request: FastifyRequest): string =>
    parse(OrgSlugParamsSchema, request.params).orgSlug;
  const idParamsOf = (request: FastifyRequest) =>
    parse(OnboardingResourceParamsSchema, request.params);

  // ── the tenant's active staff (the compliance officer picker) ──
  app.get("/api/v1/platform/tenants/:orgSlug/members", { preHandler: [...READ] }, async (request) =>
    service.listMembers(operatorOf(request), slugOf(request)),
  );

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
      // A body that names a billing service mode is also a pricing write: the pricing key (and the platform_ops predicate) as well.
      if (fields.billingServiceMode !== undefined) {
        for (const guard of PRICING_WRITE) await guard(request, reply);
      }
      const { created, view, billingModeConfirmed } = await service.putClearinghouse(
        op,
        slugOf(request),
        fields,
        reason,
        optionalIfMatch(request),
      );
      // A first choice answers 201, a version-checked change 200.
      // The mode the operator chose could not be confirmed after the vendor committed: said in the answer, not only in a log.
      return reply
        .code(created ? 201 : 200)
        .send(
          billingModeConfirmed === false ? { ...(view as object), billingModeConfirmed } : view,
        );
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
      return service.verifyClearinghouseBaa(
        op,
        slugOf(request),
        reason,
        requiredRecordedAtPin(request, "BAA record"),
      );
    },
  );

  // POST baa-document — the operator uploads the signed BAA for a tenant that is onboarding (step 3) or live (a renewal). The bytes go
  // through M22's own upload pipeline (type / size / magic-byte gate, scan, the tenant's bucket) on the tenant's RLS scope; the kind is
  // fixed server-side and no document is read or listed. The panel then records the BAA (the register row) with the returned document id.
  // Only in BAA_DOCUMENT_UPLOAD_STATUSES (409 otherwise). The body is the bytes, their type and the reason, nothing else. Rate-limited
  // per user per target tenant like the clearinghouse verify (each upload stores an object).
  app.post(
    "/api/v1/platform/tenants/:orgSlug/baa-document",
    {
      onRequest: [refuseOversizedBaaUpload],
      preHandler: [...BAA_UPLOAD],
      bodyLimit: BAA_UPLOAD_BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      const op = operatorOf(request);
      const {
        reason,
        fields: { contentBase64, mimeType },
      } = splitReason(parse(OnboardingBaaDocumentUploadRequest, request.body));
      const view = await service.uploadBaaDocument(
        op,
        slugOf(request),
        { contentBase64, mimeType },
        reason,
      );
      return reply.code(201).send(view);
    },
  );

  // GET notice-filings — what the tenant recorded as filed outside ChartWarden (the withdraw drawer's list; each row carries the
  // `recordedAt` the withdrawal pins). A read of notice metadata behind the onboarding read key; the withdrawal keeps its own key.
  app.get(
    "/api/v1/platform/tenants/:orgSlug/notice-filings",
    { preHandler: [...READ] },
    async (request) => service.listNoticeFilings(operatorOf(request), slugOf(request)),
  );

  // POST credentials/release — the operator releases every clearinghouse credential the tenant still holds EXCEPT its current one, so
  // another organization may seal it (an account moved to a new organization; a key retired by a rotation). A credential stays reserved
  // through a switch to `outside` and a rotation until this runs. Not gated on the tenant's onboarding status; refused (409
  // CLEARINGHOUSE_RESPONSES_PENDING) while the tenant's vendor responses may still arrive. The audit row names the operator, the tenant,
  // the reason and how many were released, never which.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/clearinghouse/credentials/release",
    { preHandler: [...CLEARINGHOUSE_RELEASE] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.releaseClearinghouseCredentials(op, slugOf(request), reason);
    },
  );

  // POST {noe,notr}-records/:id/withdraw-external-filing — the operator withdraws the tenant's "filed outside ChartWarden" record of
  // one notice: it returns to its pre-record state and can be recorded or submitted again; a breach stamp the watchdog set stays and the
  // one a withdrawn LATE record wrote itself goes with it (a NOTR reopens the prior election its record closed). Not gated on the tenant's onboarding status. Pinned: `If-Match` is the record's
  // `externalFiling.recordedAt` (see recordedAtPinOrNull); a record that changed since is a 409, and none at all is a 428 that is
  // raised by the service (only it can read the record), so both carry the current `recordedAt` in the error details. The audit row names the operator,
  // the tenant, the reason and the filed date withdrawn.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/noe-records/:id/withdraw-external-filing",
    { preHandler: [...NOTICE_WITHDRAW] },
    async (request) => {
      const op = operatorOf(request);
      const { orgSlug, id } = idParamsOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.withdrawNoticeExternalFiling(
        op,
        orgSlug,
        "noe",
        id,
        reason,
        recordedAtPinOrNull(request, "filing record"),
      );
    },
  );
  app.post(
    "/api/v1/platform/tenants/:orgSlug/notr-records/:id/withdraw-external-filing",
    { preHandler: [...NOTICE_WITHDRAW] },
    async (request) => {
      const op = operatorOf(request);
      const { orgSlug, id } = idParamsOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.withdrawNoticeExternalFiling(
        op,
        orgSlug,
        "notr",
        id,
        reason,
        recordedAtPinOrNull(request, "filing record"),
      );
    },
  );
}
