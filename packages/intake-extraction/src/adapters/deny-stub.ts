// @wardenx/intake-extraction — the M32 DocLens deny-stubs (M22-T08, §8.5 / D1).
//
// Until M32 (AI Platform) lands and registers the real `DocLensClassifier` / `DocLensExtractor` /
// `DocLensVisionVerifier` / `DocLensSudDetector` / docling-worker capabilities, M22 boots with these deny-stubs
// (exactly the M16 D2 / M8 D7 `NarrativeEnhancementProvider` precedent). Every stub returns
// `{ available: false, reason: 'capability_unavailable' }`, so the §7.1 W1 pipeline orchestrator fails safe: a
// docling deny at the START → `awaiting_capability`; a classifier/extractor/vision deny MID-pipeline → `stalled`
// (§2.2.6). No AI runs, no chart write happens, and the `documents.doclens` route gate returns 503 in Phase 1.
//
// The boot-validation rule (§8.5): every DocLens capability M22 references resolves to a registered M32
// capability OR one of these deny-stubs — never neither.

import type {
  CapabilityUnavailableReason,
  DocLensCapabilities,
  DocLensClassifier,
  DocLensExtractor,
  DocLensSudDetector,
  DocLensVisionVerifier,
  DoclingParser,
} from "./seams";

/** The Phase-1 deny reason every M32 DocLens deny-stub returns (M32 not yet registered). */
const DENY: { readonly available: false; readonly reason: CapabilityUnavailableReason } = {
  available: false,
  reason: "capability_unavailable",
};

/** Deny-stub docling layout-extraction capability (uploaded → docling_complete refuses; job → awaiting_capability). */
export const denyStubDoclingParser: DoclingParser = {
  async parse() {
    return DENY;
  },
};

/** Deny-stub per-page classifier (M32 not landed). */
export const denyStubDocLensClassifier: DocLensClassifier = {
  async classifyPages() {
    return DENY;
  },
};

/** Deny-stub per-doc-type structured extractor (M32 not landed). */
export const denyStubDocLensExtractor: DocLensExtractor = {
  async extract() {
    return DENY;
  },
};

/** Deny-stub Claude vision verifier for high-risk fields (M32 not landed). */
export const denyStubDocLensVisionVerifier: DocLensVisionVerifier = {
  async verify() {
    return DENY;
  },
};

/** Deny-stub AI SUD-content detector (M32 not landed; the pure rule-based {@link flagSud} flagger still runs). */
export const denyStubDocLensSudDetector: DocLensSudDetector = {
  async detect() {
    return DENY;
  },
};

/** The full deny-stubbed capability set M22 boots with in Phase 1 (every AI surface refuses, fail-safe). */
export const denyStubDocLensCapabilities: DocLensCapabilities = {
  parser: denyStubDoclingParser,
  classifier: denyStubDocLensClassifier,
  extractor: denyStubDocLensExtractor,
  visionVerifier: denyStubDocLensVisionVerifier,
  sudDetector: denyStubDocLensSudDetector,
};
