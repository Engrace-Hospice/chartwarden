// apps/backend/src/modules/22-documents/extraction/pipeline-service.ts — M22-T08 the DocLens extraction
// pipeline SERVICE: the gated entry point that composes the pure §7.1 W1 pipeline (packages/intake-extraction)
// over the M32 capability seam, behind the `documents.doclens` feature flag.
//
// BUILT-NOT-ACTIVE: when the flag is OFF (the Phase-1 default for every tenant) every method throws
// `503 EXTRACTION_DISABLED` BEFORE touching the capability — the pipeline is never reached, no AI call is
// made. When the flag is injected ON (the §7 tests, over a fake M32), the pipeline runs end-to-end:
// classify → extract → verify → discrepancy → review (run), then decisions → commit-intents → provenance.
//
// The service holds no DB: chart values + the source document id are injected (fetched via reader seams
// upstream in prod). It is the impure seam composing the pure transforms; the live outbox dispatch
// (`m22.extraction.commit_requested` / `m22.extraction.commit_completed`) is forward-declared (M22-T06
// deferral pattern) — T08 produces the intents + provenance; the dispatcher binding lands with M32.
import {
  type ChartValue,
  type CommitIntent,
  type DocLensCapabilityPort,
  type PipelineRunResult,
  type ProvenanceRecord,
  type ReviewerDecision,
  buildProvenance,
  planCommitIntents,
  runExtractionPipeline,
} from "@wardenx/intake-extraction";
import { ChartWardenError } from "@wardenx/types";
import {
  type DocumentFeatureFlagReader,
  EXTRACTION_DISABLED_CODE,
  isDocLensEnabled,
} from "./feature-flag";

export interface DocLensPipelineDeps {
  /** The M32 capability (Phase-1 deny-stub via {@link resolveDocLensCapability}; fake in tests). */
  capability: DocLensCapabilityPort;
  /** Resolves the org's flags; absent ⇒ DocLens OFF (Phase-1 default). */
  flags?: DocumentFeatureFlagReader;
}

/** The committed plan for a finished review (W1 steps 11–12): the writeback intents + their provenance. */
export interface CommitPlan {
  readonly intents: readonly CommitIntent[];
  readonly provenance: readonly ProvenanceRecord[];
}

/** Thrown (→ 503 EXTRACTION_DISABLED, `Retry-After: 0`) whenever DocLens is OFF — the Phase-1 default. */
export function extractionDisabled(): ChartWardenError {
  return new ChartWardenError(
    EXTRACTION_DISABLED_CODE,
    "WardenLens extraction is not enabled for this tenant (the 'documents.doclens' capability is OFF; Phase 1)",
    503,
  );
}

/**
 * The DocLens pipeline service. EVERY method is gated: it asserts `documents.doclens` is ON first and throws
 * 503 EXTRACTION_DISABLED otherwise — so in Phase 1 (flag OFF for all tenants) the pipeline body is dead code
 * at runtime even though it is fully built. The route layer also gates (defense in depth) so the 503 carries
 * `Retry-After: 0`; this service-level gate guarantees no caller can reach the capability without the flag.
 */
export function createDocLensPipelineService(deps: DocLensPipelineDeps) {
  const { capability, flags } = deps;

  async function assertEnabled(organizationId: string): Promise<void> {
    if (!(await isDocLensEnabled(organizationId, flags))) throw extractionDisabled();
  }

  return {
    /** §7.1 W1 steps 4–8 — run a batch through classify → extract → verify → discrepancy → review. */
    async runBatch(input: {
      organizationId: string;
      batchId: string;
      jobId: string;
      pageCount: number;
      chartValues: readonly ChartValue[];
      confidenceFloor?: number;
    }): Promise<PipelineRunResult> {
      await assertEnabled(input.organizationId);
      return runExtractionPipeline(capability, input);
    },

    /** §7.1 W1 steps 11–12 — turn the reviewer's decisions into chart-writeback intents + provenance. */
    async commitReview(input: {
      organizationId: string;
      jobId: string;
      sourceDocumentId: string;
      run: Extract<PipelineRunResult, { status: "ready_for_review" }>;
      chartTargets: readonly ChartValue[];
      decisions: readonly ReviewerDecision[];
    }): Promise<CommitPlan> {
      await assertEnabled(input.organizationId);
      const candidates = input.run.review.candidates;
      const intents = planCommitIntents(candidates, input.chartTargets, input.decisions);
      const provenance = buildProvenance(
        input.jobId,
        input.sourceDocumentId,
        candidates,
        input.decisions,
        intents,
      );
      return { intents, provenance };
    },
  };
}

/** The wired DocLens pipeline service type. */
export type DocLensPipelineService = ReturnType<typeof createDocLensPipelineService>;
