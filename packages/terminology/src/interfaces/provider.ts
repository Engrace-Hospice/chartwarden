// @wardenx/terminology — the `TerminologyProvider` seam (spec §4.5).
//
// The contract EVERY clinical/billing/interop consumer imports (M5/M7/M8/M9/M10/
// M11/M12/M13/M21/M23/M24/M27/M28/M29/M30). Consumers depend on this interface
// ONLY — never on the per-system Drizzle tables in packages/db/src/schema/
// terminology/* (the dependency-cruiser rule, architecture §25.15 check 5, blocks
// that import edge, exactly as for MDM). Adding a 12th code system later is a
// one-package change, not a 20-module refactor.
//
// M38-T01 declares the interface (part of the package layout, §3.1). The REAL
// implementation and its registration into the M1 seam registry / `validateSeams()`
// boot gate land at M38-T05; the resolution engine behind it lands at M38-T04.
//
// Design invariant (§2.1): `asOf` is in every signature, not optional sugar — a
// 2023 claim re-validated in 2025 must validate against the version active at the
// service date, never "valid now". The default is today; the parameter always exists.

import type {
  CodeSystemId,
  DeprecationMappingKind,
  ExpansionMember,
  FhirCodeSystemProjection,
  FhirValueSetProjection,
  ResolvedConcept,
  ConceptStatus,
  ValueSetMembershipSource,
} from "./kinds";

/** A deprecation's successor mapping, returned to consumers (§4.5). */
export interface DeprecationMappingResponse {
  readonly deprecatedCode: string;
  readonly deprecationEffective: string; // ISO date
  readonly successorCodes: readonly string[];
  readonly mappingKind: DeprecationMappingKind;
  readonly guidance: string | null;
}

/** Result of a version-aware `validate` (§4.5). */
export interface ValidateResult {
  readonly valid: boolean;
  readonly status?: ConceptStatus;
  readonly successor?: DeprecationMappingResponse;
}

/** Membership answer with provenance (§4.5). */
export interface MembershipResult {
  readonly isMember: boolean;
  readonly source: ValueSetMembershipSource;
}

/** Options for `expand()` (§4.5). `orgId` is required iff `includeTenantExtensions`. */
export interface ExpandOptions {
  readonly asOf?: Date;
  readonly system?: CodeSystemId;
  readonly includeTenantExtensions?: boolean;
  readonly orgId?: string;
}

/** Options for `isMemberOf()` (§4.5). */
export interface MembershipOptions {
  readonly asOf?: Date;
  readonly orgId?: string;
}

/** Search mode + filters (§4.5). `semantic` rides the `ai.full` flag (Phase 2). */
export interface SearchOptions {
  readonly mode?: "exact" | "fuzzy" | "semantic";
  readonly asOf?: Date;
  readonly limit?: number;
  readonly billableOnly?: boolean;
  readonly inValueSet?: string;
}

/**
 * The terminology read surface (§4.5). One read path, one provider interface.
 * The only mutating methods are the tenant-extension pair — tenants may ADD to a
 * platform value set, never weaken it (§2.4.3, validation rule D3).
 */
export interface TerminologyProvider {
  // validate / lookup — version aware on every call
  validate(system: CodeSystemId, code: string, asOf?: Date): Promise<ValidateResult>;
  lookup<S extends CodeSystemId>(
    system: S,
    code: string,
    asOf?: Date,
  ): Promise<ResolvedConcept<S> | null>;

  // batch (hot path — chart loads, claim lines, encounter lists)
  lookupBatch<S extends CodeSystemId>(
    system: S,
    codes: readonly string[],
    asOf?: Date,
  ): Promise<Map<string, ResolvedConcept<S>>>;

  // value-set surface (expansion is precomputed; isMemberOf is a B-tree lookup)
  expand(valueSetId: string, opts?: ExpandOptions): AsyncIterable<ExpansionMember>;
  isMemberOf(
    valueSetId: string,
    system: CodeSystemId,
    code: string,
    opts?: MembershipOptions,
  ): Promise<MembershipResult>;

  // search
  searchByText<S extends CodeSystemId>(
    system: S,
    q: string,
    opts?: SearchOptions,
  ): Promise<ResolvedConcept<S>[]>;

  // deprecation
  getDeprecationMapping(
    system: CodeSystemId,
    code: string,
  ): Promise<DeprecationMappingResponse | null>;

  // tenant extension (the only mutating surface — add-only, never weakens platform)
  addTenantExtension(
    orgId: string,
    valueSetId: string,
    system: CodeSystemId,
    code: string,
    reason: string,
    actorUserId: string,
  ): Promise<{ extensionId: string }>;
  removeTenantExtension(orgId: string, extensionId: string, actorUserId: string): Promise<void>;

  // FHIR projection (consumed by Module 28)
  asFhirCodeSystem(system: CodeSystemId, asOf?: Date): Promise<FhirCodeSystemProjection>;
  asFhirValueSet(
    valueSetId: string,
    opts?: { asOf?: Date; orgId?: string },
  ): Promise<FhirValueSetProjection>;
}
