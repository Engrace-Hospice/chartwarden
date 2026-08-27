// @wardenx/terminology — code-system identity + the per-system concept shape.
//
// M38-T01 (spec §2.3, §3.1, §3.2). This file is the TYPE-LEVEL home for the
// terminology enums and the union concept shape that the `TerminologyProvider`
// seam (provider.ts) returns. The Drizzle `pgEnum` DDL and the per-system Drizzle
// tables land in `packages/db/src/schema/terminology/*` at M38-T02 — manifest is
// law there (M38 owns 13 tables; concept tables ship only for the four Phase-1
// systems with bespoke property shapes: icd10cm, loinc, rxnorm, snomed).
//
// Design call (§2.3): one table per code system, NOT one polymorphic `concept`
// table. The type system mirrors that — `ConceptProperties<S>` is keyed per
// system so a LOINC concept's axes and an RxNorm concept's term-type are distinct
// at compile time, while consumers see only the union `ResolvedConcept<S>`.

/**
 * The code systems M38 owns. Mirrors the `code_system_id` pgEnum (§3.2) / the
 * §4.5 seam union. `'cpt'` is deliberately absent until D4 unlocks (AMA license):
 * the type itself prevents any consumer from compiling against CPT prematurely.
 *
 * All eleven systems exist in the `code_system` catalog in Phase 1; per-system
 * concept *tables* (and thus bespoke `ConceptProperties`) ship for the four whose
 * hot-path columns differ enough to warrant their own shape — see §2.3.
 */
export type CodeSystemId =
  | "icd10cm"
  | "icd10pcs"
  | "snomed"
  | "loinc"
  | "rxnorm"
  | "ndc"
  | "hcpcs"
  | "cvx"
  | "revenue"
  | "carc"
  | "rarc"
  | "cms_hope";
// 'cpt' — reserved; not in the union until D4 (§1.2, §1.3 AMA CPT license row).
// 'cms_hope' — the CMS HOPE assessment-instrument item roster (F-059). Added because `hope_j_codes` is
// defined in PLATFORM_VALUE_SETS while `value_set_member.system_id` is this union, so the set had no
// system to be curated under and M10's §86 Section-J rule could never resolve. It belongs with
// `revenue`/`carc`/`rarc` — administrative code lists published by an authority — not with the concept
// graphs; like those three it ships no concept table.

/**
 * Runtime list of every Phase-1 code system — the value-level mirror of {@link CodeSystemId}
 * for places that need the systems at runtime (e.g. the `:system` route-param TypeBox union,
 * M38-T06). `satisfies` pins each entry to a real member; `'cpt'` stays absent until D4 so a
 * `:system=cpt` request is rejected as an unknown system, never routed.
 */
export const CODE_SYSTEM_IDS = [
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
  "cms_hope",
] as const satisfies readonly CodeSystemId[];

/** Per-row concept lifecycle (§2.4.1). A `retired` row is still returned by an
 * as-of lookup whose `asOf <= end_date` — historical record validation needs it. */
export type ConceptStatus = "active" | "deprecated" | "retired";

/** Value-set scope (§3.2). */
export type ValueSetScope = "platform" | "hospice" | "hqrp";

/** Successor relationship a deprecation carries (§3.2, §2.2). */
export type DeprecationMappingKind = "equivalent" | "broader" | "narrower" | "none" | "see_other";

/** Code-system version lifecycle (§2.4.2, §3.2). */
export type VersionLoadStatus = "loading" | "staged" | "active" | "superseded" | "failed";

/** Append-only `terminology_update_log` action (§3.2). */
export type TerminologyUpdateAction =
  | "loaded"
  | "deprecated"
  | "expanded"
  | "embedded"
  | "tenant_extension_added"
  | "tenant_extension_removed";

// ── Per-system concept properties (§2.3, §3.4) ──────────────────────────────
// Each Phase-1 concept table contributes a strongly-typed `properties` shape.
// Systems without a bespoke Phase-1 table fall back to `GenericConceptProperties`
// (their `code`/`display`/status/effective dates still resolve via the catalog).

/** ICD-10-CM concept-specific columns (§3.4). */
export interface Icd10cmProperties {
  readonly isBillableLeaf: boolean;
  readonly chapter: string | null;
  readonly parentCode: string | null;
}

/** SNOMED CT US Edition concept-specific columns (§3.4). */
export interface SnomedProperties {
  readonly fullySpecifiedName: string;
  readonly semanticTag: string | null;
  readonly hierarchyPath: readonly string[];
}

/** LOINC concept-specific columns — the six-axis model (§3.4). */
export interface LoincProperties {
  readonly component: string | null;
  readonly property: string | null;
  readonly time: string | null;
  readonly system: string | null;
  readonly scale: string | null;
  readonly method: string | null;
  readonly shortName: string | null;
}

/** RxNorm concept-specific columns (§3.4). */
export interface RxnormProperties {
  readonly tty: string;
  readonly ingredientRxcui: string | null;
  readonly ndcs: readonly string[];
}

/** HCPCS `kind` discriminates supply / Q-code / modifier (§3.4 note). */
export interface HcpcsProperties {
  readonly kind: string | null;
}

/** Fallback for systems whose Phase-1 properties are the common shape only. */
export type GenericConceptProperties = Record<string, never>;

/** Per-system property map — keyed by every member of {@link CodeSystemId}. */
export interface ConceptPropertiesBySystem {
  icd10cm: Icd10cmProperties;
  icd10pcs: GenericConceptProperties;
  snomed: SnomedProperties;
  loinc: LoincProperties;
  rxnorm: RxnormProperties;
  ndc: GenericConceptProperties;
  hcpcs: HcpcsProperties;
  cvx: GenericConceptProperties;
  revenue: GenericConceptProperties;
  carc: GenericConceptProperties;
  rarc: GenericConceptProperties;
  // CMS HOPE items carry no bespoke properties: the instrument's per-item metadata (section letter,
  // response set) lives in M10's own required-items matrix, not in the terminology concept row. Same
  // shape as `revenue`/`carc`/`rarc` — an authority-published code list, not a concept graph.
  cms_hope: GenericConceptProperties;
}

/** The strongly-typed `properties` for a concept in system `S`. */
export type ConceptProperties<S extends CodeSystemId> = ConceptPropertiesBySystem[S];

/**
 * The union concept shape every consumer sees (§2.3, §4.5). Hides which per-system
 * Drizzle table answered the lookup; dates are ISO strings on the seam boundary.
 */
export interface ResolvedConcept<S extends CodeSystemId> {
  readonly systemId: S;
  readonly code: string;
  readonly display: string;
  readonly status: ConceptStatus;
  readonly effectiveDate: string; // ISO date (YYYY-MM-DD)
  readonly endDate: string | null;
  readonly properties: ConceptProperties<S>;
}

/** A single (system, code) row yielded by `expand()` (§4.5). */
export interface ExpansionMember {
  readonly systemId: CodeSystemId;
  readonly code: string;
  readonly display: string;
  readonly annotations: Record<string, unknown>;
}

/** Where an `isMemberOf` hit came from (§4.5) — platform members vs tenant adds. */
export type ValueSetMembershipSource = "platform" | "tenant_extension" | null;

// ── FHIR projections (§4.5, §7.9) ───────────────────────────────────────────
// M38 owns a STABLE internal projection; Module 28 maps it to FHIR R4 wire shape.
// `asFhir*` output is deterministic for the same (id, asOf) — golden-tested (§2.5).

/** Internal projection of a code system to FHIR R4 `CodeSystem` shape (§7.9). */
export interface FhirCodeSystemProjection {
  readonly resourceType: "CodeSystem";
  readonly url: string;
  readonly version: string;
  readonly status: string;
  readonly content: "complete" | "fragment" | "not-present";
  readonly concept: ReadonlyArray<{ readonly code: string; readonly display: string }>;
}

/** Internal projection of a value set to FHIR R4 `ValueSet` (expanded) shape (§7.9). */
export interface FhirValueSetProjection {
  readonly resourceType: "ValueSet";
  readonly url: string;
  readonly status: string;
  readonly expansion: {
    readonly timestamp: string;
    readonly total: number;
    readonly contains: ReadonlyArray<{
      readonly system: string;
      readonly code: string;
      readonly display: string;
    }>;
  };
}
