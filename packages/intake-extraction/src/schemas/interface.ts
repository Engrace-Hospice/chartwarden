// @wardenx/intake-extraction — the §3.1 `ExtractionSchema` contract (M22-T01).
//
// Per architecture §25.14 (the adapter mandate) the DocLens layout-extraction client (docling-worker) and
// the M32 deny-stub may only live here; dependency-cruiser forbids any other module from calling them. The
// M22 backend consumes ONLY these contracts — the per-doc-type extraction schemas (risk levels + writeback
// targets), the docling-client HTTP adapter, the cross-source / chart-existing discrepancy detector, and the
// SUD pattern flagger.
//
// M22-T01 ships the `ExtractionSchema` contract (the layout). The 11 per-doc-type schemas (§3.1), the
// docling-client + M32 deny-stub adapters, the discrepancy detector, and the SUD flagger land in M22-T08
// (DocLens is built but gated OFF behind `documents.doclens` — the routes return 503 EXTRACTION_DISABLED in
// Phase 1). This file is type-only.
//
// PHI boundary: extracted candidate values are encrypted by the caller before persist (`value_cipher`); a
// candidate MUST carry `sourcePage` + `sourceBoundingBox` (architecture §10.6.3 / §2.3 NOT NULL CHECK).

import type {
  ChartTargetModule,
  ClassifiedPageDocType,
  ExtractionCandidateCodeSystem,
  ExtractionCandidateFieldKind,
  ExtractionCandidateRiskLevel,
} from "@wardenx/types";

/** The §3.1 per-field descriptor an `ExtractionSchema` declares: its risk level (gates the high-risk
 * per-field-only enforcement, D4/§2.3), typed-value kind, optional coding system, and writeback target. */
export interface ExtractionFieldSchema {
  /** The dotted field path the candidate writes back to (e.g. `'medications[].rxnorm'`). */
  readonly fieldPath: string;
  readonly fieldKind: ExtractionCandidateFieldKind;
  readonly codeSystem: ExtractionCandidateCodeSystem;
  /** High-risk fields can never be bulk-approved (§2.3 DB CHECK); they route to the vision verifier (§2.2.6). */
  readonly riskLevel: ExtractionCandidateRiskLevel;
  /** The module a committed candidate drafts into (the `m22.extraction.commit_requested` discriminator). */
  readonly targetModule: ChartTargetModule;
}

/** §3.1 — the per-doc-type extraction schema the langextract worker drives. One per `classified_page_doc_type`
 * (discharge-summary, med-recon, hp, lab, …). The TypeBox candidate-shape schema is opaque here; M22-T08
 * lands the concrete schemas. */
export interface ExtractionSchema {
  readonly docType: ClassifiedPageDocType;
  /** The semver version label of this extraction schema. */
  readonly version: string;
  /** The TypeBox schema validating the extractor's raw candidate output (opaque at this boundary). */
  readonly candidateSchema: unknown;
  /** The per-field descriptors (risk levels + writeback targets) for this doc type. */
  readonly fields: readonly ExtractionFieldSchema[];
}
