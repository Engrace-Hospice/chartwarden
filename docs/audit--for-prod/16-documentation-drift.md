# 16 — Documentation and implementation drift

`CW-QA-0018` captures three confirmed contradictions:

1. The repository guide describes M41 as a placeholder while the generated matrix and source show a
   structural implementation.
2. The generated status matrix says M38 lacks routes, while the OpenAPI report enumerates enriched
   M38 API surface; the heuristic does not fit its layout.
3. `e2e/specs/billing.spec.ts` says Medicare assembly is unconditionally unreachable, but current
   seams and the live claim-assembly suite execute it; the browser test still only proves empty-state
   rendering.

Additional documentation correctly discloses important limitations: DoseSpot is unbound until
configured, green gates are proxies, the restore drill is demo-scale, and rollback after migration
is unsafe. Those candid statements were used as evidence rather than repeated as new defects.

Setup/build instructions were substantially reproducible. The audit did not treat architecture
proposals as implementation truth where executable code differed. Stale TODO/comment searches were
triaged and only the reachable contradictions above retained.
