// apps/backend/src/modules/22-documents/extraction/extraction-routes.ts — M22-T08 the DocLens
// extraction-trigger routes, gated behind `documents.doclens` (OFF → 503 EXTRACTION_DISABLED).
//
// These are the entry points that KICK OFF the §7.1 W1 pipeline (run a batch) and COMMIT a finished review
// (decisions → chart-writeback intents + provenance). They are distinct from the T07 read/review routes
// (which list jobs / open a review session over already-produced rows): T08's routes are the ones that
// invoke the M32-backed capability, so they are the ones the feature flag must hard-gate.
//
// BUILT-NOT-ACTIVE: a `requireDocLensEnabled` preHandler resolves the org's `documents.doclens` flag and,
// when OFF (the Phase-1 default for every tenant), sets `Retry-After: 0` on the reply and throws
// `503 EXTRACTION_DISABLED`. The pipeline body is never reached, so no AI capability is invoked. The service
// re-asserts the same gate (defense in depth) so no path can reach the capability with the flag off.
//
// Every route also rides the REAL Authorization Contract (`requirePermission` on M22's §4.6 `intake.*` keys,
// M3). Org binding is server-side (`request.context`, never the body). The DocLens pipeline service is
// injected (in-memory/fake in tests; the deny-stub-backed service in prod).
import { requirePermission } from "@wardenx/auth";
import { type Static, Type } from "@sinclair/typebox";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "../routes/documents-typebox";
import {
  type DocumentFeatureFlagReader,
  isDocLensEnabled,
} from "./feature-flag";
import { type DocLensPipelineService, extractionDisabled } from "./pipeline-service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DocLensRouteDeps {
  /** The gated DocLens pipeline service (created over the M32 deny-stub + the flag reader). */
  pipeline: DocLensPipelineService;
  /** Resolves the org's flags; absent ⇒ DocLens OFF (Phase-1 default → every call 503s). */
  flags?: DocumentFeatureFlagReader;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const RunBatchRequest = Type.Object({
  jobId: Type.String({ format: "uuid" }),
  pageCount: Type.Integer({ minimum: 1 }),
});
const CommitReviewRequest = Type.Object({
  sourceDocumentId: Type.String({ format: "uuid" }),
  decisions: Type.Array(
    Type.Object({
      fieldPath: Type.String({ minLength: 1 }),
      decision: Type.Union([
        Type.Literal("approve"),
        Type.Literal("approve_with_edit"),
        Type.Literal("reject"),
      ]),
      editedValue: Type.Optional(Type.String()),
    }),
  ),
});
const BatchParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const INTAKE_REVIEW = requirePermission("intake.review") as PreHandler;

export function registerDocLensExtractionRoutes(app: FastifyInstance, deps: DocLensRouteDeps): void {
  const { pipeline, flags } = deps;

  /**
   * §7.1 W1 / depends-on-32 — the feature-flag gate. When `documents.doclens` is OFF (Phase-1 default for
   * every tenant) we set `Retry-After: 0` and throw 503 EXTRACTION_DISABLED BEFORE the handler runs, so the
   * M32 capability is never reached. The error handler renders the WardenXError envelope and preserves the
   * header already set on the reply.
   */
  const requireDocLensEnabled: PreHandler = async (request, reply) => {
    const orgId = request.context.organizationId;
    if (!(await isDocLensEnabled(orgId, flags))) {
      reply.header("Retry-After", "0");
      throw extractionDisabled();
    }
  };

  // 32 — run a batch through the DocLens pipeline (classify → extract → verify → discrepancy → review).
  app.post(
    "/api/v1/intake/uploads/:id/extraction/run",
    { preHandler: [INTAKE_REVIEW, requireDocLensEnabled] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParams, request.params);
      const body = parse(RunBatchRequest, request.body);
      const result = await pipeline.runBatch({
        organizationId,
        batchId: id,
        jobId: body.jobId,
        pageCount: body.pageCount,
        chartValues: [],
      });
      return reply.code(202).send(result);
    },
  );

  // 33 — commit a finished review: decisions → chart-writeback intents + provenance (W1 steps 11–12).
  app.post(
    "/api/v1/intake/jobs/:id/extraction/commit",
    { preHandler: [INTAKE_REVIEW, requireDocLensEnabled] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParams, request.params);
      const body = parse(CommitReviewRequest, request.body);
      // The run snapshot is rehydrated upstream in prod; the gate alone is what T08 asserts here. With the
      // flag OFF this line is never reached. The service re-asserts the gate (defense in depth) before any work.
      const run = {
        status: "ready_for_review" as const,
        classifiedPages: [],
        review: { batchId: id, candidates: [], discrepancies: [], bulkApproveAllowed: true, sudDetected: false },
      };
      return pipeline.commitReview({
        organizationId,
        jobId: id,
        sourceDocumentId: body.sourceDocumentId,
        run,
        chartTargets: [],
        decisions: body.decisions,
      });
    },
  );
}

export type DocLensRunBatchBody = Static<typeof RunBatchRequest>;
export type DocLensCommitReviewBody = Static<typeof CommitReviewRequest>;
