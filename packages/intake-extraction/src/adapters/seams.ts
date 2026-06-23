// @wardenx/intake-extraction — the M32 DocLens capability seam contracts (M22-T08, §4.4 / §8.5).
//
// Per architecture §25.14 (the adapter mandate) the DocLens layout-extraction client and the M32 capability
// seams may ONLY be declared and consumed inside this package; dependency-cruiser forbids any other module from
// importing them. M22's backend reaches them exclusively through `@wardenx/intake-extraction` (re-exported from
// `index.ts`). M22 holds NO AI code (no Anthropic SDK, no Ollama client, no DistilBERT inference) — every AI
// surface is one of the four §8.5 M32 capabilities below, each returning a typed {@link CapabilityResult} so the
// caller can fail safe (queue worker pauses → `awaiting_capability` / `stalled`) when the capability is denied or
// not yet registered. This is the M16 D2 / M8 D7 `NarrativeEnhancementProvider` deny-stub pattern (§8.5).
//
// PHI boundary: a `RawCandidate.value` is plaintext PHI — the backend encrypts it to `extraction_candidate
// .value_cipher` (M1 per-tenant DEK) BEFORE persist. A candidate MUST carry `sourcePage` + `sourceBoundingBox`
// (architecture §10.6.3 / §2.3 NOT NULL CHECK); the pipeline rejects any candidate that does not.

import type {
  ClassifiedPageDocType,
  ExtractionCandidateCodeSystem,
  ExtractionCandidateFieldKind,
} from "@wardenx/types";

/** Why an M32 capability could not run. `capability_unavailable` = not registered (Phase 1, M32 not landed);
 * `capability_denied` = registered but the AI-governance policy refused this tenant/tier; `circuit_open` = the
 * capability's circuit breaker is open (§8.10 degraded mode). All three fail the pipeline closed (never proceed). */
export type CapabilityUnavailableReason = "capability_unavailable" | "capability_denied" | "circuit_open";

/** The result every M32 DocLens capability returns: a typed value when available, else a fail-safe deny reason. */
export type CapabilityResult<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: CapabilityUnavailableReason };

/** The §8.5 AI provenance every AI-derived value records (mirrors `extraction_candidate.capability_id` /
 * `capability_version` / `model_version_at_extraction_time`) so a surveyor can reconstruct which AI pass produced
 * a field. M32 owns the registry these resolve against (`doclens/extract_meds_v2` → model + backend at runtime). */
export interface CapabilityProvenance {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly modelVersion: string;
}

/** A normalized bounding box on the source page (architecture §10.6.3). Coordinates are page-relative. */
export interface BoundingBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// ── 1. DoclingParser — layout extraction (uploaded → docling_complete) ───────────────────────────────────

/** The per-page processing-failure class written to `classified_page.error_class` (W1 AC); null on success. */
export type DoclingParseErrorClass = "docling_parse_failed";

/** One parsed page: its layout text + opaque per-page image object key. `parseError` non-null = page failed
 * (the pipeline marks the page and continues per the W1 AC; only an all-pages failure terminates `parse_failed`). */
export interface DoclingPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly imageObjectKey: string | null;
  readonly parseError: DoclingParseErrorClass | null;
}

export interface DoclingParseInput {
  readonly batchId: string;
  /** The tenant-scoped opaque object key of the uploaded `original.pdf` (no PHI in the key, §2.2.2 / D11). */
  readonly objectKey: string;
  readonly pageCount: number;
}

/** §3.1 — the docling-worker layout-extraction capability. */
export interface DoclingParser {
  parse(input: DoclingParseInput): Promise<CapabilityResult<{ pages: readonly DoclingPage[] }>>;
}

// ── 2. DocLensClassifier — per-page doc-type classification (docling_complete → classifier_complete) ─────

export interface ClassifierPageInput {
  readonly pageNumber: number;
  readonly text: string;
}

/** One classified page: predicted doc type + confidence. Pages below `CLASSIFIER_CONFIDENCE_FLOOR` are flagged
 * for human confirmation (§2.3); the pipeline never auto-confirms a low-confidence page. */
export interface ClassifiedPageResult {
  readonly pageNumber: number;
  readonly documentType: ClassifiedPageDocType;
  readonly confidence: number;
}

export interface DocLensClassifier {
  classifyPages(
    input: { batchId: string; pages: readonly ClassifierPageInput[] },
  ): Promise<CapabilityResult<{ pages: readonly ClassifiedPageResult[]; provenance: CapabilityProvenance }>>;
}

// ── 3. DocLensExtractor — per-doc-type structured extraction (classifier_complete → extraction) ─────────

export interface ExtractionRunInput {
  readonly jobId: string;
  readonly docType: ClassifiedPageDocType;
  readonly pageNumbers: readonly number[];
  readonly text: string;
}

/** A field-level extraction proposal. `value` is plaintext PHI (encrypted before persist); `code` is the
 * terminology-resolved canonical code when `codeSystem !== 'none'` (M38 resolves at the backend, not here). */
export interface RawCandidate {
  readonly fieldPath: string;
  readonly fieldKind: ExtractionCandidateFieldKind;
  readonly value: string;
  readonly codeSystem: ExtractionCandidateCodeSystem;
  readonly code: string | null;
  readonly confidence: number;
  readonly sourcePage: number;
  readonly sourceBoundingBox: BoundingBox;
}

export interface DocLensExtractor {
  extract(
    input: ExtractionRunInput,
  ): Promise<CapabilityResult<{ candidates: readonly RawCandidate[]; provenance: CapabilityProvenance }>>;
}

// ── 4. DocLensVisionVerifier — Claude vision verification of HIGH-risk fields (verifying) ────────────────

export interface VisionVerifyInput {
  readonly jobId: string;
  /** The high-risk candidates routed to the vision verifier (medications, allergies, doses, code status, …). */
  readonly candidates: readonly RawCandidate[];
}

/** The verifier's per-field verdict: agreement with the text-extractor, or a recorded disagreement (PHI; the
 * backend stores it in `extraction_candidate.vision_disagreement`, denylisted from audit values). */
export interface VisionVerdict {
  readonly fieldPath: string;
  readonly agrees: boolean;
  readonly disagreement: string | null;
  readonly confidence: number;
}

export interface DocLensVisionVerifier {
  verify(
    input: VisionVerifyInput,
  ): Promise<CapabilityResult<{ verdicts: readonly VisionVerdict[]; provenance: CapabilityProvenance }>>;
}

// ── DocLensSudDetector — AI SUD-content classifier (§8.5 4th capability; complements the pure flagger) ───

export interface SudDetectInput {
  readonly candidates: readonly RawCandidate[];
  readonly pages: readonly { pageNumber: number; text: string }[];
}

/** A detected SUD signal (42 CFR Part 2 §2.31): the field/page it was found on + the suggested SUD kind. */
export interface SudSignal {
  readonly fieldPath: string | null;
  readonly pageNumber: number | null;
  readonly sudKind: string;
  readonly confidence: number;
}

export interface DocLensSudDetector {
  detect(input: SudDetectInput): Promise<CapabilityResult<{ signals: readonly SudSignal[] }>>;
}

/** The four §8.5 M32 DocLens capabilities consumed at M22 boot (registered real by M32, deny-stubbed until then). */
export interface DocLensCapabilities {
  readonly parser: DoclingParser;
  readonly classifier: DocLensClassifier;
  readonly extractor: DocLensExtractor;
  readonly visionVerifier: DocLensVisionVerifier;
  readonly sudDetector: DocLensSudDetector;
}

/** Type guard — narrows a {@link CapabilityResult} to its available branch. */
export function isCapabilityAvailable<T>(
  result: CapabilityResult<T>,
): result is { available: true; value: T } {
  return result.available;
}
