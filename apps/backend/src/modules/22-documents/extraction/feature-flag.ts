// apps/backend/src/modules/22-documents/extraction/feature-flag.ts — M22-T08 the `documents.doclens`
// feature-flag gate (the M38-T09 `ai.full` precedent, mirrored for DocLens).
//
// DocLens is BUILT-NOT-ACTIVE in Phase 1: the full §7.1 W1 pipeline exists (packages/intake-extraction) but
// depends on M32 binding the real classifier/extractor/vision-verifier. Until then every DocLens entry point
// is gated behind `documents.doclens` (default OFF for every tenant), and the routes return
// `503 EXTRACTION_DISABLED` with `Retry-After: 0` (M22 spec §depends-on-32; §8.5 AI boundary).
//
// The port is structurally identical to M1's `FeatureFlagReader` so boot wiring passes the same reader; when
// absent every flag reads off — the Phase-1 default. This is a CAPABILITY flag (Phase 2), not a UI rollout
// flag: it stays OFF until M32 lands AND the per-tenant capability is registered-and-not-denied.

/** Resolves an org's feature flags. Structurally `FeatureFlagReader`; absent ⇒ all flags off (Phase-1). */
export interface DocumentFeatureFlagReader {
  forOrg(orgId: string): Promise<Record<string, boolean>>;
}

/** The capability flag that unlocks the DocLens extraction pipeline (§7.1 W1) — Phase 2, default OFF. */
export const DOCLENS_FLAG = "documents.doclens" as const;

/** The error code the DocLens routes return when the flag is OFF (the Phase-1 default for every tenant). */
export const EXTRACTION_DISABLED_CODE = "EXTRACTION_DISABLED" as const;

/**
 * Resolve whether DocLens extraction is enabled for an org. PURE-ish (the only effect is the async flag
 * read): no reader ⇒ false (Phase-1 default); any flag map without `documents.doclens=true` ⇒ false.
 */
export async function isDocLensEnabled(
  orgId: string | undefined,
  flags: DocumentFeatureFlagReader | undefined,
): Promise<boolean> {
  if (!orgId || !flags) return false;
  const resolved = await flags.forOrg(orgId);
  return resolved[DOCLENS_FLAG] === true;
}
