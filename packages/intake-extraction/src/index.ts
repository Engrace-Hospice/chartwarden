// @wardenx/intake-extraction — Module 22 Pillar 3: DocLens (the §25.14 adapter-mandate boundary).
//
// This is the ONLY place the DocLens layout-extraction client (docling-worker) + the M32 deny-stub may live;
// dependency-cruiser forbids any other module from calling them. The M22 backend consumes ONLY the contracts
// re-exported here.
//
// M22-T01 landed the §3.1 `ExtractionSchema` contract (the layout). The 11 per-doc-type schemas, the
// docling-client + M32 deny-stub adapters, the cross-source / chart-existing discrepancy detector, and the
// SUD pattern flagger land in M22-T08 — DocLens is built but gated OFF behind `documents.doclens` (Phase 1
// routes return 503 EXTRACTION_DISABLED).
export * from "./schemas/interface";
