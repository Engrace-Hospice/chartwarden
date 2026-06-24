// @wardenx/intake-extraction — §7.1 W1 / §8.5 the M32 AI-capability PORT (the DocLens classifier /
// extractor / vision-verifier) as the M22-side STRUCTURAL projection of the M32 seam.
//
// M22 owns NO AI inference: classification, extraction and vision verification are Module 32 (AI Platform)
// capabilities reached via the M1 seam registry, never an Anthropic/Ollama/DistilBERT import here (§1.2,
// §8.5). This file declares only the minimum surface the W1 pipeline consumes; M32 owns the canonical rich
// contract. The provider arm returns a discriminated `ok | unavailable` envelope so the pure pipeline can
// short-circuit deterministically when a capability is denied / dropped mid-flight (W1 AC → `stalled`) —
// it never throws on a denied capability (an absent capability is a normal Phase-1 state, not an error).
//
// Phase 1: every capability is a DENY-STUB (`{ status: "unavailable", reason: "capability_unavailable" }`)
// and the routes never even reach the pipeline (the `documents.doclens` flag is OFF → 503). The deny-stub
// here lets the pure pipeline be tested end-to-end (flag injected ON, over a fake capability) without M32.

import type { ClassifiedPageDocType, ExtractionCandidateRiskLevel } from "@wardenx/types";

/** A capability call that either yields a typed result or reports the capability is unavailable (denied or
 * dropped mid-pipeline). Never a thrown error — unavailability is a normal Phase-1 state (§8.5). */
export type CapabilityResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string };

/** One classifier verdict for a single source page (§7.1 W1 step 4). */
export interface ClassifiedPageResult {
  readonly pageNumber: number;
  readonly documentType: ClassifiedPageDocType;
  /** Model confidence in [0, 1]; pages below the tenant floor are routed to human classification. */
  readonly confidence: number;
}

/** One extracted candidate field for a contiguous same-type page run (§7.1 W1 step 5). */
export interface ExtractedCandidate {
  readonly fieldPath: string;
  readonly value: string;
  readonly riskLevel: ExtractionCandidateRiskLevel;
  /** Per-field extractor confidence in [0, 1]; drives the review UI low-confidence badge (W1 AC). */
  readonly confidence: number;
  /** Whether the page-run/field carries potential SUD content (§7.4 W4 / D8). */
  readonly sudDetected: boolean;
  /** The source page the candidate was lifted from (provenance — §3.3 `extraction_provenance`). */
  readonly sourcePageNumber: number;
}

/** The HIGH-risk vision-verification verdict for a candidate (§7.1 W1 step 5 — high-risk types only). */
export interface VisionVerificationResult {
  readonly fieldPath: string;
  /** Whether the vision pass confirmed the extracted value against the page image (D4 high-risk gate). */
  readonly verified: boolean;
  readonly confidence: number;
}

/**
 * The M22-side structural projection of M32's DocLens capability seam (classifier + extractor + vision
 * verifier). The real (richer) contract lives in `packages/ai-platform`; M22 reads it OPAQUELY from the M1
 * registry (`getSeam`) and casts to this minimum. Every arm returns a `CapabilityResult` so the pure
 * pipeline can branch on availability without a try/catch.
 */
export interface DocLensCapabilityPort {
  /** §7.1 W1 step 4 — classify each parsed page to a document type + confidence. */
  classifyPages(args: {
    organizationId: string;
    batchId: string;
    pageCount: number;
  }): Promise<CapabilityResult<readonly ClassifiedPageResult[]>>;

  /** §7.1 W1 step 5 — extract candidate fields for a contiguous same-type page run. */
  extract(args: {
    organizationId: string;
    jobId: string;
    documentType: ClassifiedPageDocType;
    pageNumbers: readonly number[];
  }): Promise<CapabilityResult<readonly ExtractedCandidate[]>>;

  /** §7.1 W1 step 5 — vision-verify HIGH-risk candidates against the source page image (D4). */
  verify(args: {
    organizationId: string;
    jobId: string;
    candidates: readonly ExtractedCandidate[];
  }): Promise<CapabilityResult<readonly VisionVerificationResult[]>>;
}

/** The reason string the deny-stub reports (matches the M32 hard-block list vocabulary, §8.5). */
export const CAPABILITY_UNAVAILABLE = "capability_unavailable" as const;

/**
 * The Phase-1 DENY-STUB DocLens capability: every arm reports `unavailable`. This is what `getSeam` resolves
 * to until M32 binds the real classifier/extractor/vision-verifier. It also makes the pure pipeline trivially
 * testable in the "capability dropped" path (W1 AC → `stalled`) without M32.
 */
export const denyStubDocLensCapability: DocLensCapabilityPort = {
  async classifyPages() {
    return { status: "unavailable", reason: CAPABILITY_UNAVAILABLE };
  },
  async extract() {
    return { status: "unavailable", reason: CAPABILITY_UNAVAILABLE };
  },
  async verify() {
    return { status: "unavailable", reason: CAPABILITY_UNAVAILABLE };
  },
};
