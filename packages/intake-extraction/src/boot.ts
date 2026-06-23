// @wardenx/intake-extraction — the §4.4 / §8.5 DocLens seam-registration descriptor (M22-T08).
//
// The boot-validation contract (§8.5): every M32 DocLens capability M22 references resolves to a registered M32
// capability OR a deny-stub — never neither. This descriptor lists the seam keys + their Phase-1 deny-stub default
// so the M22 composition root can register them `optional`-with-deny-stub (the M16 D2 / M8 D7 pattern) and the
// boot check can enumerate them. The keys mirror the §4.4 init block (`m32.doclens-*`).

import {
  denyStubDocLensClassifier,
  denyStubDocLensExtractor,
  denyStubDocLensSudDetector,
  denyStubDocLensVisionVerifier,
  denyStubDoclingParser,
} from "./adapters/deny-stub";

/** A DocLens seam M22 consumes from M32: the registry key + the Phase-1 deny-stub it boots with until M32 lands. */
export interface DocLensSeamDescriptor {
  readonly key:
    | "m32.docling-parser"
    | "m32.doclens-classifier"
    | "m32.doclens-extractor"
    | "m32.doclens-vision-verifier"
    | "m32.doclens-sud-detector";
  readonly denyStub: unknown;
}

/** The §8.5 four DocLens capabilities (+ the docling parser) M22 registers `optional`-with-deny-stub at boot. */
export const DOCLENS_SEAM_DESCRIPTORS: readonly DocLensSeamDescriptor[] = [
  { key: "m32.docling-parser", denyStub: denyStubDoclingParser },
  { key: "m32.doclens-classifier", denyStub: denyStubDocLensClassifier },
  { key: "m32.doclens-extractor", denyStub: denyStubDocLensExtractor },
  { key: "m32.doclens-vision-verifier", denyStub: denyStubDocLensVisionVerifier },
  { key: "m32.doclens-sud-detector", denyStub: denyStubDocLensSudDetector },
];
