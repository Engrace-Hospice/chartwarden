// @wardenx/intake-extraction — Module 22 Pillar 3: DocLens (the §25.14 adapter-mandate boundary).
//
// This is the ONLY place the DocLens layout-extraction client (docling-worker) + the M32 capability seams /
// deny-stubs may live; dependency-cruiser forbids any other module from calling them. The M22 backend consumes
// ONLY the contracts re-exported here.
//
// M22-T01 landed the §3.1 `ExtractionSchema` contract (the layout). M22-T08 lands the rest of Pillar 3, built but
// gated OFF behind `documents.doclens` (Phase 1 routes return 503 EXTRACTION_DISABLED): the four §8.5 M32 capability
// seams + their deny-stubs, the docling-worker HTTP client, the eleven §3.1 per-doc-type extraction schemas, the
// §7.1 W1 pipeline orchestrator (which NEVER auto-commits — it terminates at human-review-ready candidates), the
// §7.1 W1 cross-source / chart-existing discrepancy detector, and the §7.4 W4 rule-based SUD flagger.
export * from "./schemas/interface";
export * from "./schemas/library";
export * from "./adapters/seams";
export * from "./adapters/deny-stub";
export * from "./adapters/docling-client";
export * from "./discrepancy/detector";
export * from "./sud-detection/flagger";
export * from "./pipeline/orchestrator";
export * from "./boot";
