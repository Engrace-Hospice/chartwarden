import {
  type GuardRequest,
  carriesPlatformAuthority,
  requireAbac,
  requirePermission,
  requireRole,
} from "@chartwarden/auth";
// apps/backend/src/modules/22-documents/extraction/review-workspace-routes.ts — the DocLens review screen's
// routes (§5.1 INTAKE.ReviewSideBySide; F-237).
//
//   GET  /api/v1/intake/uploads                       the intake work queue (no values)
//   GET  /api/v1/intake/uploads/:id/workspace         one batch for review (decrypted values — PHI; SUD values
//                                                     + evidence redacted without the Part 2 need-to-know)
//   GET  /api/v1/intake/uploads/:id/pages/:page/image the page image the boxes are drawn on (PHI; 403 for a
//                                                     Part 2 batch without the need-to-know)
//   POST /api/v1/intake/uploads/:id/sud-review        §7.4 W4 step 6: confirm / reject a SUD detection
//
// Authorization is the server's: `intake.read` for the queue, `intake.review` for everything that shows
// values or decides; the SUD resolution additionally needs the high-risk licence (the
// `extraction_reviewer_eligible` predicate's `sudReview` arm) and refuses AI principals. ADR-0115 permits a
// human tenant administrator to read SUD evidence on the workspace/page routes only. Every PHI read carries
// an `auditRead` declaration, so the host's read-audit hook records who looked at which batch.
import {
  type PreHandler,
  pageQuery,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import { ForbiddenError, UnauthorizedError } from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "../routes/documents-typebox";
import type { ReviewWorkspaceService, SupportReadScope } from "./review-workspace";
import type { SudContentAccess } from "./sud-content-gate";

const Box = Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]);
const SudStatus = Type.Union([
  Type.Literal("not_detected"),
  Type.Literal("detected"),
  Type.Literal("confirmed"),
  Type.Literal("rejected"),
]);
const IdentityDocStatus = Type.Union([
  Type.Literal("match"),
  Type.Literal("possible"),
  Type.Literal("mismatch"),
  Type.Literal("unverified"),
]);
const IdentityBatchStatus = Type.Union([
  Type.Literal("match"),
  Type.Literal("possible"),
  Type.Literal("mismatch"),
  Type.Literal("unverified"),
  Type.Literal("no_target"),
]);
const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);
/** F-238 — a records-request code on the fax names another referral / patient (code + kind only). */
export const RecordsRequestConflictSchema = Type.Union([
  Type.Object({
    code: Type.String(),
    kind: Type.Union([
      Type.Literal("code_names_another_referral"),
      Type.Literal("code_names_another_patient"),
    ]),
  }),
  Type.Null(),
]);

export const ReviewQueueQuerySchema = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")])),
  ...pageQuery(),
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  sudStatus: Type.Optional(SudStatus),
});

export const ReviewQueueResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
      status: Type.String(),
      sourceChannel: Type.String(),
      patientId: Nullable(Type.String()),
      patientName: Nullable(Type.String()),
      sudStatus: SudStatus,
      recordsRequestConflict: RecordsRequestConflictSchema,
      pageCount: Type.Union([Type.Integer(), Type.Null()]),
      documentCount: Type.Union([Type.Integer(), Type.Null()]),
      candidates: Type.Object({
        total: Type.Integer(),
        lowConfidence: Type.Integer(),
        highRisk: Type.Integer(),
        visionDisagreed: Type.Integer(),
      }),
      review: Type.Union([
        Type.Object({ id: Type.String(), status: Type.String(), decided: Type.Integer() }),
        Type.Null(),
      ]),
    }),
  ),
  nextCursor: Nullable(Type.String()),
  hasMore: Type.Boolean(),
});

export const ReviewWorkspaceResponseSchema = Type.Object({
  batch: Type.Object({
    id: Type.String(),
    status: Type.String(),
    sourceChannel: Type.String(),
    uploadedAt: Type.String({ format: "date-time" }),
    documentId: Type.String(),
    patientId: Nullable(Type.String()),
    patientName: Nullable(Type.String()),
    // F-238 — the referral these records are for, and the worst unresolved per-document identity verdict.
    referralId: Nullable(Type.String()),
    identityStatus: Type.Union([IdentityBatchStatus, Type.Null()]),
    recordsRequestConflict: RecordsRequestConflictSchema,
  }),
  sud: Type.Object({
    status: SudStatus,
    detectorRef: Nullable(Type.String()),
    resolvedAt: Nullable(Type.String()),
    resolvedByMembershipId: Nullable(Type.String()),
    // GAP-067 — the SUD evidence and SUD-candidate values were withheld from this viewer.
    contentRedacted: Type.Boolean(),
    indicators: Type.Array(
      Type.Object({
        page: Type.Integer(),
        category: Type.String(),
        ruleId: Type.String(),
        term: Type.String(),
        bbox: Box,
      }),
    ),
  }),
  pages: Type.Array(
    Type.Object({
      page: Type.Integer(),
      width: Type.Number(),
      height: Type.Number(),
      documentType: Nullable(Type.String()),
      confidence: Type.Union([Type.Number(), Type.Null()]),
      needsHumanClassification: Type.Boolean(),
    }),
  ),
  // F-238 — the documents the fax splitter found (one per classified_page row).
  documents: Type.Array(
    Type.Object({
      pageFrom: Type.Integer(),
      pageTo: Type.Integer(),
      documentType: Type.String(),
      title: Nullable(Type.String()),
      date: Nullable(Type.String()),
      duplicateOfPage: Type.Union([Type.Integer(), Type.Null()]),
      boundary: Nullable(Type.String()),
      // F-238 — two-identifier check of this document against the patient / referral.
      identity: Type.Object({
        status: Type.Union([IdentityDocStatus, Type.Null()]),
        disagreeing: Type.Array(Type.String()),
        resolution: Type.Union([
          Type.Literal("same_patient"),
          Type.Literal("other_patient"),
          Type.Null(),
        ]),
      }),
    }),
  ),
  jobs: Type.Array(
    Type.Object({
      id: Type.String(),
      documentType: Type.String(),
      status: Type.String(),
      pageFrom: Type.Integer(),
      pageTo: Type.Integer(),
      failureReason: Nullable(Type.String()),
    }),
  ),
  review: Type.Union([
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      reviewerMembershipId: Type.String(),
      isMine: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  candidates: Type.Array(
    Type.Object({
      id: Type.String(),
      jobId: Type.String(),
      documentType: Type.String(),
      fieldPath: Type.String(),
      description: Nullable(Type.String()),
      riskLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      confidence: Type.Number(),
      value: Nullable(Type.String()),
      page: Type.Integer(),
      bbox: Box,
      vision: Type.Object({
        status: Type.Union([
          Type.Literal("not_required"),
          Type.Literal("verified"),
          Type.Literal("disagreed"),
          Type.Literal("unverified"),
        ]),
        observedValue: Nullable(Type.String()),
      }),
      sudDetected: Type.Boolean(),
      // F-238 — the deterministic ICD-10-CM coding checks on a `diagnoses[n].icd10` candidate.
      codingFlags: Type.Array(
        Type.Object({
          kind: Type.String(),
          code: Type.String(),
          suggest: Type.Array(Type.String()),
          detail: Type.String(),
        }),
      ),
      writebackTarget: Type.Boolean(),
      // GAP-067 — a SUD-detected candidate whose value / evidence was withheld from this viewer.
      redacted: Type.Boolean(),
      decision: Type.Union([
        Type.Object({
          id: Type.String(),
          decision: Type.String(),
          editedValue: Nullable(Type.String()),
          reason: Nullable(Type.String()),
          partOfBulkApprove: Type.Boolean(),
          decidedAt: Type.String(),
        }),
        Type.Null(),
      ]),
    }),
  ),
});

export const SudReviewRequest = Type.Object({
  outcome: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected")]),
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
});
export const SudReviewResponseSchema = Type.Object({
  batchId: Type.String(),
  sudStatus: SudStatus,
});

// F-238 — a reviewer's answer for ONE document whose identity check is possible / mismatch.
export const IdentityReviewRequest = Type.Object({
  pageFrom: Type.Integer({ minimum: 1, maximum: 10_000 }),
  resolution: Type.Union([Type.Literal("same_patient"), Type.Literal("other_patient")]),
  reason: Type.String({ minLength: 5, maxLength: 1000 }),
});
export const IdentityReviewResponseSchema = Type.Object({
  batchId: Type.String(),
  pageFrom: Type.Integer(),
  resolution: Type.Union([Type.Literal("same_patient"), Type.Literal("other_patient")]),
  identityStatus: IdentityBatchStatus,
});

// F-238 — move a misfiled batch to another patient and/or referral before its review completes.
export const RelinkRequest = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  referralId: Type.Optional(Type.String({ format: "uuid" })),
  reason: Type.String({ minLength: 5, maxLength: 1000 }),
});
export const RelinkResponseSchema = Type.Object({
  batchId: Type.String(),
  patientId: Nullable(Type.String()),
  referralId: Nullable(Type.String()),
  identityStatus: IdentityBatchStatus,
});

const BatchParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const PageParams = Type.Object({
  id: Type.String({ format: "uuid" }),
  page: Type.Integer({ minimum: 1, maximum: 10_000 }),
});
const PlatformBatchParams = Type.Object({
  organizationId: Type.String({ format: "uuid" }),
  id: Type.String({ format: "uuid" }),
});
const PlatformPageParams = Type.Object({
  organizationId: Type.String({ format: "uuid" }),
  id: Type.String({ format: "uuid" }),
  page: Type.Integer({ minimum: 1, maximum: 10_000 }),
});
export const PlatformSupportQuery = Type.Object({
  supportSessionId: Type.String({ format: "uuid" }),
});

// Compile-time pins: the published schema matches what the service returns.
type Conforms<T extends V, V> = T;
type _Workspace = Conforms<
  Static<typeof ReviewWorkspaceResponseSchema>,
  Awaited<ReturnType<ReviewWorkspaceService["getWorkspace"]>>
>;

const INTAKE_READ = requirePermission("intake.read") as PreHandler;
const INTAKE_REVIEW = requirePermission("intake.review") as PreHandler;
const SUPERADMIN = requireRole("superadmin") as PreHandler;
const REJECT_AI = rejectAiActor(
  "AI principals cannot commit a WardenLens extraction review",
) as PreHandler;
const REQUIRE_HUMAN_SUPPORT_ACTOR: PreHandler = async (request) => {
  if (request.context.attributes.actorKind !== "user") {
    throw new ForbiddenError(
      "WardenLens support-session access requires an authenticated human superadmin",
    );
  }
};
const IDEMPOTENT = requireIdempotencyKey() as PreHandler;
// §7.4 W4 — confirming or rejecting a Part 2 detection is a high-risk act: RN-or-above, like a
// medication field. The target is a constant flag; nothing about it comes from the request.
const ABAC_SUD_REVIEWER = requireAbac("intake.review", "extraction_reviewer_eligible", {
  getTarget: () => ({ sudReview: true }),
}) as PreHandler;

// GAP-067 — the DocLens READ surface (workspace values + evidence, page images) for a batch with a pending or
// confirmed Part 2 detection. Two named predicates, composed here and never decided from the request: the
// licence arm of `extraction_reviewer_eligible`, and M39's `sud_consent_present` (42 CFR Part 2 need-to-know)
// for the BATCH'S patient — which the service loads from the batch row and passes in (`getTarget` is
// synchronous, so the route cannot look it up itself). The gate (sud-content-gate.ts) decides which are
// needed: a PENDING detection needs only the licence (adjudication is internal use, spec §7.4 W4 — consent
// is captured later), a CONFIRMED batch needs both. `requireAbac` throws on denial; for a READ a denial
// is not a refusal of the whole request but a redaction, so the throw is the answer, caught here and turned
// into `false`. Any error (an unregistered predicate, a down consent seam) is a `false` too: fail closed.
// ADR-0115 adds a separate, explicit human tenant-administrator read probe; it is not break glass and never
// admits a reserved platform role. The policy approves a future superadmin path only after M34's consented,
// PHI-elevated support session is composed server-side; this generic tenant route has no such context. The
// underlying ABAC checks remain non-break-glass-bypassable.
const SUD_READ_ELIGIBLE = requireAbac("intake.review", "extraction_reviewer_eligible", {
  getTarget: () => ({ sudReview: true }),
  breakGlassBypassable: false,
});
const sudConsentFor = (patientId: string) =>
  requireAbac("intake.review", "sud_consent_present", {
    getTarget: () => ({ patientId }),
    breakGlassBypassable: false,
  });

function sudContentAccessOf(request: FastifyRequest): SudContentAccess {
  const guardRequest: GuardRequest = request;
  // Each probe is a registered ABAC predicate; a denial or a throw reaches the gate as a rejection, which it
  // turns into `false` (fail closed). Which probes a batch needs depends on its state: see sud-content-gate.
  return {
    // ADR-0115 — a human tenant administrator is admitted only without reserved platform authority. A
    // platform-owned superadmin is deliberately denied here: ADR-0112 prevents tenant membership, and this
    // route has no server-derived support-session identity/elevation. The ordinary RBAC permission, tenant
    // context/RLS, AI refusal on decisions, review ownership and every candidate-level rule continue to apply.
    administratorOverride: async () => {
      const roles = request.context.roles;
      const tenantAdministrator = roles.includes("administrator") || roles.includes("org_admin");
      // A request from outside the platform console's allowlist has its platform roles stripped (CW-AC-22): this check, which DENIES
      // on platform authority, must still see that the caller carried it, or the strip would admit it here.
      return (
        request.context.attributes.actorKind === "user" &&
        tenantAdministrator &&
        !carriesPlatformAuthority(request.context)
      );
    },
    reviewerEligible: async () => {
      await SUD_READ_ELIGIBLE(guardRequest);
      return true;
    },
    consentPresent: async (patientId) => {
      await sudConsentFor(patientId)(guardRequest);
      return true;
    },
  };
}

/** M34-owned narrow port: the route never reads support-session tables or trusts a client tenant claim. */
export interface WardenLensPlatformSupportAccess {
  runAuthorizedRead<T>(
    input: {
      actorMembershipId: string;
      organizationId: string;
      supportSessionId: string;
      resourceKind: "intake_review_workspace" | "intake_page_image";
      resourceId: string;
      correlationId: string;
      actorIp: string | null;
      route: string;
      pageNumber?: number;
    },
    resolvePatient: (organizationId: string) => Promise<string | null>,
    read: (
      organizationId: string,
      patientId: string | null,
      scope: "organization_scoped" | "patient_scoped",
    ) => Promise<T>,
  ): Promise<T>;
}

/** A patient-scoped consent grant covers the batch's filed patient only (see `SupportReadScope`). */
const supportReadScopeOf = (
  scope: "organization_scoped" | "patient_scoped",
  authorizedPatientId: string | null,
): SupportReadScope => ({
  patientContentOnly: scope === "patient_scoped",
  expectedPatientId: authorizedPatientId,
});

const SUPPORT_SESSION_SUD_ACCESS: SudContentAccess = {
  administratorOverride: async () => true,
  reviewerEligible: async () => false,
  consentPresent: async () => false,
};

export function registerDocLensReviewWorkspaceRoutes(
  app: FastifyInstance,
  service: ReviewWorkspaceService,
  platformSupportAccess?: WardenLensPlatformSupportAccess,
): void {
  app.get(
    "/api/v1/intake/uploads",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_batch", list: true } },
    },
    async (request) => {
      const { organizationId } = writeActorOf(request);
      const q = parse(ReviewQueueQuerySchema, request.query ?? {});
      return service.listQueue(organizationId, {
        view: q.view ?? "open",
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.sudStatus ? { sudStatus: q.sudStatus } : {}),
      });
    },
  );

  // ADR-0115 / ADR-0112 — the platform-owned superadmin is never admitted through the generic tenant
  // route. This dedicated read-only path composes an exact superadmin role with M34's actor-bound,
  // tenant-consented support session. M34 resolves the tenant, enforces grant/patient scope and writes
  // the durable support-session + critical audit records before this handler returns any PHI.
  if (platformSupportAccess) {
    app.get(
      "/api/v1/platform/organizations/:organizationId/intake/uploads/:id/workspace",
      {
        preHandler: [SUPERADMIN, REQUIRE_HUMAN_SUPPORT_ACTOR, INTAKE_REVIEW],
        config: {
          auditRead: {
            resourceKind: "intake_review_workspace",
            resourceIdParam: "id",
            organizationIdParam: "organizationId",
            patientIdContextAttribute: "readAuditPatientId",
            severity: "critical",
            failClosed: true,
          },
        },
      },
      async (request, reply) => {
        const { membershipId } = writeActorOf(request);
        const { organizationId: requestedOrganizationId, id } = parse(
          PlatformBatchParams,
          request.params,
        );
        const { supportSessionId } = parse(PlatformSupportQuery, request.query ?? {});
        let auditedPatientId: string | null = null;
        const workspace = await platformSupportAccess.runAuthorizedRead(
          {
            actorMembershipId: membershipId,
            organizationId: requestedOrganizationId,
            supportSessionId,
            resourceKind: "intake_review_workspace",
            resourceId: id,
            correlationId: request.id,
            actorIp: request.ip ?? null,
            route: "/api/v1/platform/organizations/:organizationId/intake/uploads/:id/workspace",
          },
          async (authorizedOrganizationId) => {
            auditedPatientId = await service.getBatchPatientId(authorizedOrganizationId, id);
            return auditedPatientId;
          },
          (authorizedOrganizationId, authorizedPatientId, scope) =>
            service.getWorkspace(
              authorizedOrganizationId,
              id,
              membershipId,
              SUPPORT_SESSION_SUD_ACCESS,
              supportReadScopeOf(scope, authorizedPatientId),
            ),
        );
        request.context.attributes.readAuditPatientId = auditedPatientId;
        return reply.header("cache-control", "no-store").send(workspace);
      },
    );

    app.get(
      "/api/v1/platform/organizations/:organizationId/intake/uploads/:id/pages/:page/image",
      {
        preHandler: [SUPERADMIN, REQUIRE_HUMAN_SUPPORT_ACTOR, INTAKE_REVIEW],
        config: {
          auditRead: {
            resourceKind: "intake_page_image",
            resourceIdParam: "id",
            organizationIdParam: "organizationId",
            patientIdContextAttribute: "readAuditPatientId",
            severity: "critical",
            failClosed: true,
          },
        },
      },
      async (request, reply) => {
        const { membershipId } = writeActorOf(request);
        const {
          organizationId: requestedOrganizationId,
          id,
          page,
        } = parse(PlatformPageParams, {
          ...(request.params as Record<string, unknown>),
          page: Number((request.params as { page?: string }).page),
        });
        const { supportSessionId } = parse(PlatformSupportQuery, request.query ?? {});
        let auditedPatientId: string | null = null;
        const out = await platformSupportAccess.runAuthorizedRead(
          {
            actorMembershipId: membershipId,
            organizationId: requestedOrganizationId,
            supportSessionId,
            resourceKind: "intake_page_image",
            resourceId: id,
            correlationId: request.id,
            actorIp: request.ip ?? null,
            route:
              "/api/v1/platform/organizations/:organizationId/intake/uploads/:id/pages/:page/image",
            pageNumber: page,
          },
          async (authorizedOrganizationId) => {
            auditedPatientId = await service.getBatchPatientId(authorizedOrganizationId, id);
            return auditedPatientId;
          },
          (authorizedOrganizationId, authorizedPatientId, scope) =>
            service.renderPage(
              authorizedOrganizationId,
              id,
              page,
              request.id,
              SUPPORT_SESSION_SUD_ACCESS,
              supportReadScopeOf(scope, authorizedPatientId),
            ),
        );
        request.context.attributes.readAuditPatientId = auditedPatientId;
        return (
          reply
            .header("content-type", "image/png")
            // A revoked/expired support session must not leave a reusable Part 2 page in browser or
            // intermediary caches. Tenant review keeps its existing short private cache below.
            .header("cache-control", "no-store")
            .header("x-page-width", String(out.pageWidth))
            .header("x-page-height", String(out.pageHeight))
            .send(Buffer.from(out.png))
        );
      },
    );
  }

  app.get(
    "/api/v1/intake/uploads/:id/workspace",
    {
      preHandler: [INTAKE_REVIEW],
      // The patient the packet is filed under joins the read to a patient, for the accounting of disclosures.
      config: {
        auditRead: {
          resourceKind: "intake_review_workspace",
          resourceIdParam: "id",
          patientIdPayloadPath: "batch.patientId",
        },
      },
    },
    async (request) => {
      const { organizationId, membershipId } = writeActorOf(request);
      const { id } = parse(BatchParams, request.params);
      return service.getWorkspace(organizationId, id, membershipId, sudContentAccessOf(request));
    },
  );

  app.get(
    "/api/v1/intake/uploads/:id/pages/:page/image",
    {
      preHandler: [INTAKE_REVIEW],
      config: {
        auditRead: {
          resourceKind: "intake_page_image",
          resourceIdParam: "id",
          // The render knows the patient the packet is filed under; the audit names it.
          patientIdContextAttribute: "readAuditPatientId",
        },
      },
    },
    async (request, reply) => {
      const { organizationId } = writeActorOf(request);
      const { id, page } = parse(PageParams, {
        ...(request.params as Record<string, unknown>),
        page: Number((request.params as { page?: string }).page),
      });
      const out = await service.renderPage(
        organizationId,
        id,
        page,
        request.id,
        sudContentAccessOf(request),
      );
      if (out.patientId) request.context.attributes.readAuditPatientId = out.patientId;
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "private, max-age=300")
        .header("x-page-width", String(out.pageWidth))
        .header("x-page-height", String(out.pageHeight))
        .send(Buffer.from(out.png));
    },
  );

  app.post(
    "/api/v1/intake/uploads/:id/sud-review",
    { preHandler: [REJECT_AI, INTAKE_REVIEW, ABAC_SUD_REVIEWER, IDEMPOTENT] },
    async (request) => {
      const { organizationId, userId, membershipId } = writeActorOf(request);
      const { id } = parse(BatchParams, request.params);
      const body = parse(SudReviewRequest, request.body);
      return service.resolveSud(
        organizationId,
        { userId, membershipId },
        id,
        body.outcome,
        body.reason ?? null,
      );
    },
  );

  app.post(
    "/api/v1/intake/uploads/:id/identity-review",
    { preHandler: [REJECT_AI, INTAKE_REVIEW, IDEMPOTENT] },
    async (request) => {
      const { organizationId, userId, membershipId } = writeActorOf(request);
      const { id } = parse(BatchParams, request.params);
      const body = parse(IdentityReviewRequest, request.body);
      return service.resolveIdentity(
        organizationId,
        { userId, membershipId },
        id,
        body.pageFrom,
        body.resolution,
        body.reason,
      );
    },
  );

  app.post(
    "/api/v1/intake/uploads/:id/relink",
    { preHandler: [REJECT_AI, INTAKE_REVIEW, IDEMPOTENT] },
    async (request) => {
      const { organizationId, userId, membershipId } = writeActorOf(request);
      const { id } = parse(BatchParams, request.params);
      const body = parse(RelinkRequest, request.body);
      return service.relink(
        organizationId,
        { userId, membershipId },
        id,
        {
          patientId: body.patientId ?? null,
          referralId: body.referralId ?? null,
          reason: body.reason,
        },
        request.id,
      );
    },
  );
}
