// @wardenx/mdm — the `MdmEntityProvider` seam: the contract every consumer imports (M40-T05, §4.5).
//
// This is the read surface every clinical/billing/interop consumer of master data imports (a
// patient's attending physician, a claim's payer, an order's facility). The rich interface lives
// HERE in the feature package — not the leaf @wardenx/types — because its per-kind generics
// (`CanonicalFields<K>`/`OverlayFields<K>`) and merge-redirect shape can't live in a leaf
// (`leaves-stay-leaves`, ARCHITECTURE §25.15). Consumers that list `40` in their manifest
// `dependsOn` import this TYPE and resolve the runtime instance through the module-40 typed
// accessor; the M1 seam registry holds the instance opaquely (`SeamContracts["MdmEntityProvider"]
// = unknown`) and only validates it is present + fail-closed at boot.
//
// The provider (provider.ts) is pure ORCHESTRATION over an injected {@link MdmStore}: it runs the
// T04 merge-redirect chase (`followMerge`) and the canonical+overlay join (`joinOverlay`) over the
// rows the store returns, so the §7.2 "redirect is invisible to consumers" guarantee has exactly
// one home and every consumer sees the same resolution.

import type { CanonicalIdentifier, MdmEntityKind } from "./kinds";

// ── Per-kind canonical payloads (§2.3 — registry-sourced, one row shared by every tenant) ──────

/** Fields every canonical kind exposes regardless of kind — the resolved identity surface. */
export interface CanonicalBaseFields {
  /** The canonical id (post-redirect survivor). */
  readonly id: string;
  /** Which public identifier anchors this kind's identity (§2.3 "the reason the row exists"). */
  readonly identifierType: CanonicalIdentifier;
  /** The identifier value (NPI/CCN/X12 payer id/NCPDP), or `null` for a provisional canonical. */
  readonly identifierValue: string | null;
  /** A human label for the entity (name / org name). */
  readonly displayName: string;
}

/** Canonical `external_physician` projection (§3.3) — NPPES-sourced demographic attributes. */
export interface CanonicalPhysicianFields extends CanonicalBaseFields {
  readonly firstName: string;
  readonly lastName: string;
  readonly credentials: string | null;
  readonly isNp: boolean;
  readonly specialtyTaxonomy: string | null;
  readonly licenseStates: readonly string[] | null;
}

/** Canonical `facility` projection (§3.3). */
export interface CanonicalFacilityFields extends CanonicalBaseFields {
  readonly ccn: string | null;
  readonly npi: string | null;
  readonly sendingFacilityCodes: readonly string[];
}

/** Canonical `payer` projection (§3.3). */
export interface CanonicalPayerFields extends CanonicalBaseFields {
  readonly x12PayerId: string | null;
}

/** Per-kind canonical payload map. Phase 1 materializes physician/facility/payer concretely; the
 *  forward-declared kinds resolve to the base shape until their tables land (manifest §3.3–3.5). */
export interface CanonicalFieldsByKind {
  physician: CanonicalPhysicianFields;
  facility: CanonicalFacilityFields;
  payer: CanonicalPayerFields;
  pharmacy: CanonicalBaseFields;
  referral_source: CanonicalBaseFields;
  dme_vendor: CanonicalBaseFields;
  funeral_home: CanonicalBaseFields;
}

/** The canonical payload for a kind (§4.5 `MdmResolved.canonical`). */
export type CanonicalFields<K extends MdmEntityKind> = CanonicalFieldsByKind[K];

// ── Per-kind overlay payloads (§2.3 — this-tenant opinion, org-scoped, RLS-isolated) ───────────

/** This tenant's overlay opinion of an `external_physician` (§3.4) — the only Phase-1 overlay. */
export interface OverlayPhysicianFields {
  readonly preferredContactPhone: string | null;
  readonly preferredContactEmail: string | null;
  readonly relationshipNotes: string | null;
  readonly doNotRefer: boolean;
  readonly isPreferred: boolean;
  readonly preferredRank: number | null;
}

/**
 * Per-kind overlay payload map. Only `physician` ships a Phase-1 overlay table; every other kind
 * is `never`, so {@link OverlayFields} of those kinds collapses to `never | null` = `null` — the
 * type system encodes "this kind has no overlay" directly (a facility always resolves `overlay:null`).
 */
export interface OverlayFieldsByKind {
  physician: OverlayPhysicianFields;
  facility: never;
  payer: never;
  pharmacy: never;
  referral_source: never;
  dme_vendor: never;
  funeral_home: never;
}

/** The overlay payload for a kind, or `never` for the overlay-less kinds (§4.5). */
export type OverlayFields<K extends MdmEntityKind> = OverlayFieldsByKind[K];

// ── The resolved shape + the provider contract (§4.5) ──────────────────────────────────────────

/**
 * The resolved entity (§4.5): the survivor canonical id, the optional `resolvedFrom` redirect
 * breadcrumb (§7.2), the canonical payload, and this tenant's overlay (`null` when none). `status`
 * is the survivor's status post-redirect — always `active`/`deactivated`/`provisional`, never
 * `merged` (the redirect always chases through to a live row).
 */
export interface MdmResolved<K extends MdmEntityKind> {
  readonly id: string;
  readonly resolvedFrom?: string;
  readonly canonical: CanonicalFields<K>;
  readonly overlay: OverlayFields<K> | null;
  readonly status: "active" | "deactivated" | "provisional";
}

/** A search query against a kind's canonical set (the proposal / lookup path, §4.5). */
export interface SearchSpec<_K extends MdmEntityKind> {
  /** Free-text query (name / identifier substring); the store decides exact vs fuzzy. */
  readonly text?: string;
  /** An exact public-identifier match (NPI/CCN/…); short-circuits to the canonical when present. */
  readonly identifier?: string;
  /** Cap on returned candidates. */
  readonly limit?: number;
}

/** The identifying fields a `getOrCreate` proposal carries (§4.5, §7.1). */
export interface IdentifyingFields<K extends MdmEntityKind> {
  /** Which identifier the value is (anchors the §7.1 "one canonical per real-world entity" match). */
  readonly identifierType: CanonicalIdentifier;
  /** The identifier value to match against the canonical set. */
  readonly identifierValue: string;
  /** Canonical fields to seed a provisional row with, when no identifier match exists. */
  readonly proposed?: Partial<CanonicalFields<K>>;
}

/** The §4.5 BAA-gate result the provider returns (delegated to {@link BaaStatusProvider}, T06). */
export interface MdmBaaGateResult {
  readonly required: boolean;
  readonly status: "executed" | "pending" | "n_a" | "missing";
  readonly expiresOn: string | null;
}

/**
 * The boot-registered MDM read surface (§4.5). Every `resolve*` call follows `merged_into_id`
 * transparently (§7.2) and folds in this tenant's overlay (§2.3). No consumer ever imports a
 * Drizzle schema from `packages/db/src/schema/mdm/*` — they import this contract and resolve the
 * impl through the M1 registry (the dependency-cruiser rule blocks the direct schema import).
 */
export interface MdmEntityProvider {
  // resolve one (follows merged_into_id transparently; cached in production)
  resolvePhysician(orgId: string, id: string): Promise<MdmResolved<"physician"> | null>;
  resolveFacility(orgId: string, id: string): Promise<MdmResolved<"facility"> | null>;
  resolvePharmacy(orgId: string, id: string): Promise<MdmResolved<"pharmacy"> | null>;
  resolveReferralSource(orgId: string, id: string): Promise<MdmResolved<"referral_source"> | null>;
  resolvePayer(orgId: string, id: string): Promise<MdmResolved<"payer"> | null>;
  resolveDmeVendor(orgId: string, id: string): Promise<MdmResolved<"dme_vendor"> | null>;
  resolveFuneralHome(orgId: string, id: string): Promise<MdmResolved<"funeral_home"> | null>;

  /** Batch resolve (the hot path for chart loads / claim lines / encounter lists). */
  resolveBatch<K extends MdmEntityKind>(
    orgId: string,
    kind: K,
    ids: readonly string[],
  ): Promise<Map<string, MdmResolved<K>>>;

  /** Search a kind's canonical set (the lookup / proposal entry point, §7.1). */
  search<K extends MdmEntityKind>(
    orgId: string,
    kind: K,
    q: SearchSpec<K>,
  ): Promise<MdmResolved<K>[]>;

  /**
   * Get-or-create against the canonical set (§7.1): an identifier already present returns
   * `matched_canonical` (no provisional, no duplicate); otherwise a provisional is written. The
   * `fuzzy_candidates` branch (above-threshold name match) is the T07/T08 proposal-path job.
   */
  getOrCreate<K extends MdmEntityKind>(
    orgId: string,
    kind: K,
    identifying: IdentifyingFields<K>,
    actorUserId: string,
  ): Promise<
    | { kind: "matched_canonical"; entity: MdmResolved<K> }
    | { kind: "created_provisional"; provisionalId: string }
    | { kind: "fuzzy_candidates"; candidates: MdmResolved<K>[]; provisionalId: string }
  >;

  /** Hierarchy (canonical-shape; same answer for everyone — overlay is not joined). */
  parentOf<K extends MdmEntityKind>(kind: K, id: string): Promise<MdmResolved<K> | null>;
  childrenOf<K extends MdmEntityKind>(kind: K, id: string): Promise<MdmResolved<K>[]>;

  /**
   * BAA gate (§7.7) used by M22/M28/M29 before disclosing PHI to an MDM-identified recipient.
   * The real as-of time-travel implementation is the `BaaStatusProvider` seam (M40-T06); this
   * method delegates to it (`baaStatusByMdmEntity({ …, asOf: now })`).
   */
  baaStatus(orgId: string, kind: MdmEntityKind, id: string): Promise<MdmBaaGateResult>;
}
