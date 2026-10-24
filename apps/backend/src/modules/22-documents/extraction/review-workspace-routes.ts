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
// `extraction_reviewer_eligible` predicate's `sudReview` arm) and refuses AI principals. Every PHI read
// carries an `auditRead` declaration, so the host's read-audit hook records who looked at which batch.
import { type GuardRequest, requireAbac, requirePermission } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectAiActor, requireIdempotencyKey } from "../routes/concurrency";
import { parse } from "../routes/documents-typebox";
import type { ReviewWorkspaceService } from "./review-workspace";
import type { SudContentAccess } from "./sud-content-gate";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

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
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
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

// Compile-time pins: the published schema matches what the service returns.
type Conforms<T extends V, V> = T;
type _Workspace = Conforms<
  Static<typeof ReviewWorkspaceResponseSchema>,
  Awaited<ReturnType<ReviewWorkspaceService["getWorkspace"]>>
>;

const INTAKE_READ = requirePermission("intake.read") as PreHandler;
const INTAKE_REVIEW = requirePermission("intake.review") as PreHandler;
const REJECT_AI = rejectAiActor() as PreHandler;
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
// Not break-glass-bypassable: an emergency grant is not a Part 2 need-to-know.
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

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  membershipId: string;
} {
  const ctx = request.context;
  const membershipId = ctx?.attributes.membershipId;
  if (
    !ctx?.organizationId ||
    typeof ctx.userId !== "string" ||
    ctx.userId.length === 0 ||
    typeof membershipId !== "string"
  ) {
    throw new UnauthorizedError();
  }
  return { organizationId: ctx.organizationId, userId: ctx.userId, membershipId };
}

export function registerDocLensReviewWorkspaceRoutes(
  app: FastifyInstance,
  service: ReviewWorkspaceService,
): void {
  app.get(
    "/api/v1/intake/uploads",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_batch", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
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

  app.get(
    "/api/v1/intake/uploads/:id/workspace",
    {
      preHandler: [INTAKE_REVIEW],
      config: { auditRead: { resourceKind: "intake_review_workspace", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parse(BatchParams, request.params);
      return service.getWorkspace(organizationId, id, membershipId, sudContentAccessOf(request));
    },
  );

  app.get(
    "/api/v1/intake/uploads/:id/pages/:page/image",
    {
      preHandler: [INTAKE_REVIEW],
      config: { auditRead: { resourceKind: "intake_page_image", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
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
      const { organizationId, userId, membershipId } = actorOf(request);
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
      const { organizationId, userId, membershipId } = actorOf(request);
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
      const { organizationId, userId, membershipId } = actorOf(request);
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
