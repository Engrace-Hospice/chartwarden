// apps/backend/src/modules/22-documents/extraction/doclens-capability.ts — M22-T08 the M32 AI-capability
// DENY-STUB consumer (the M22-T06 `consent-gate.ts` opaque-consumption precedent).
//
// The DocLens classifier / extractor / vision-verifier are Module 32 (AI Platform) capabilities. M22
// `dependsOn` is `[1, 5]` — it does NOT depend on M32, so it MUST NOT import `packages/ai-platform`
// (that would create a dependency-cruiser edge). It also MUST NOT add `DocLensCapability` to the typed M1
// `SeamName`/`SeamContracts` union — that registration is M32's to own when the AI Platform lands. Until
// then M22 holds only the M22-side STRUCTURAL projection {@link DocLensCapabilityPort} and resolves it to
// the {@link denyStubDocLensCapability} — every arm reports `unavailable`, so the pipeline can never make a
// real AI call (§8.5 AI boundary).
//
// Phase 1: `resolveDocLensCapability()` returns the deny-stub. The routes never even reach the pipeline in
// Phase 1 (the `documents.doclens` flag is OFF → 503); this resolver exists so the wired service is complete
// and so the forward-binding to the real M32 seam is a single, documented edit. The §7 tests inject a fake
// capability directly into the service (they do not go through this resolver), exactly as M22-T06's tests
// inject a fake `ConsentEvaluator` rather than the registry deny-stub.
import { type DocLensCapabilityPort, denyStubDocLensCapability } from "@wardenx/intake-extraction";

/** The seam key under which M32 will publish the DocLens classifier/extractor/vision capability (forward
 * reference; NOT yet a member of the typed M1 `SeamName` union — M32 owns that registration). */
export const DOCLENS_CAPABILITY_SEAM = "DocLensCapability" as const;

/**
 * Resolve the M32 DocLens capability. Phase 1 (M32 not landed): always the deny-stub — every arm reports
 * `unavailable`, never a real AI call. When M32 lands it will register the capability under
 * {@link DOCLENS_CAPABILITY_SEAM} in the M1 registry and this resolver flips to read it opaquely (one edit,
 * mirroring `getSeam("ConsentEvaluator")` in `consent-gate.ts`) — no M22→M32 dependency edge.
 */
export function resolveDocLensCapability(): DocLensCapabilityPort {
  return denyStubDocLensCapability; // Phase 1: capability_unavailable on every arm (M32 unregistered)
}
