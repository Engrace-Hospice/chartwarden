import { type Static, Type } from "@sinclair/typebox";
// apps/backend/src/modules/22-documents/extraction/review-workspace-routes.ts — the DocLens review screen's
// routes (§5.1 INTAKE.ReviewSideBySide; F-237).
//
//   GET  /api/v1/intake/uploads                       the intake work queue (no values)
//   GET  /api/v1/intake/uploads/:id/workspace         one batch for review (decrypted values — PHI)
//   GET  /api/v1/intake/uploads/:id/pages/:page/image the page image the boxes are drawn on (PHI)
//   POST /api/v1/intake/uploads/:id/sud-review        §7.4 W4 step 6: confirm / reject a SUD detection
//
// Authorization is the server's: `intake.read` for the queue, `intake.review` for everything that shows
// values or decides; the SUD resolution additionally needs the high-risk licence (the
// `extraction_reviewer_eligible` predicate's `sudReview` arm) and refuses AI principals. Every PHI read
// carries an `auditRead` declaration, so the host's read-audit hook records who looked at which batch.
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectAiActor, requireIdempotencyKey } from "../routes/concurrency";
import { parse } from "../routes/documents-typebox";
import type { ReviewWorkspaceService } from "./review-workspace";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Box = Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]);
const SudStatus = Type.Union([
  Type.Literal("not_detected"),
  Type.Literal("detected"),
  Type.Literal("confirmed"),
  Type.Literal("rejected"),
]);
const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const ReviewQueueQuerySchema = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")])),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
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
  }),
  sud: Type.Object({
    status: SudStatus,
    detectorRef: Nullable(Type.String()),
    resolvedAt: Nullable(Type.String()),
    resolvedByMembershipId: Nullable(Type.String()),
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
      return service.getWorkspace(organizationId, id, membershipId);
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
      const out = await service.renderPage(organizationId, id, page, request.id);
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
}
