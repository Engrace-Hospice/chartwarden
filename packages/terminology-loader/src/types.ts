// @wardenx/terminology-loader — the shapes every parser, the stage-and-diff step and the orchestrator share
// (M38 §3.1 `packages/terminology-loader`, §4.3 `terminology.load_version`).
import type { CodeSystemId } from "@wardenx/terminology";

/** Systems the loader can ingest: every catalog system except `cms_hope` (an instrument roster with no release file). */
export type LoadableSystemId = Exclude<CodeSystemId, "cms_hope">;

/** The ten systems that have a parser (CPT is absent by design — D4). */
export const LOADABLE_SYSTEMS = [
  "icd10cm",
  "icd10pcs",
  "snomed",
  "loinc",
  "rxnorm",
  "ndc",
  "hcpcs",
  "cvx",
  "revenue",
  "carc",
  "rarc",
] as const satisfies readonly LoadableSystemId[];

/** Narrow an arbitrary catalog id to a loadable one. */
export function isLoadableSystem(system: string): system is LoadableSystemId {
  return (LOADABLE_SYSTEMS as readonly string[]).includes(system);
}

/** `concept_status` enum values. */
export type ConceptStatus = "active" | "deprecated" | "retired";

/** One concept row a parser produced, before it is staged. Dates are ISO `YYYY-MM-DD` or null. */
export interface ParsedConcept {
  readonly code: string;
  readonly display: string;
  readonly status: ConceptStatus;
  /** Null = the version's own effective_from (the DB fills it at activation). */
  readonly effectiveDate: string | null;
  readonly endDate: string | null;
  /** System-specific attributes; the activation function splits the typed columns out of this. */
  readonly properties: Readonly<Record<string, unknown>>;
}

/** The `deprecation_mapping_kind` enum. */
export type DeprecationMappingKind = "equivalent" | "broader" | "narrower" | "none" | "see_other";

/** A parser/diff-supplied deprecation detail (successors + guidance) for a code the new version retires. */
export interface DeprecationHint {
  readonly code: string;
  readonly successors: readonly string[];
  readonly mappingKind: DeprecationMappingKind;
  readonly guidance: string;
}

/** What a pure parser returns. */
export interface ParsedSource {
  readonly system: LoadableSystemId;
  readonly concepts: readonly ParsedConcept[];
  /** Non-fatal observations (rows skipped on purpose, optional companion files absent). Never row content. */
  readonly warnings: readonly string[];
}

/**
 * The files inside one uploaded/fetched source. A zip upload exposes its entries; a raw file exposes one
 * entry named `upload`. Reads are lazy so a multi-hundred-MB archive is inflated one entry at a time.
 */
export interface SourceBundle {
  readonly names: readonly string[];
  read(name: string): Uint8Array;
}
