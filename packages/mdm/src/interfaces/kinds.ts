// @wardenx/mdm — entity-kind discriminator + the canonical-vs-overlay dividing line.
//
// M40-T01 (spec §2.3, §2.4, §3.1, §3.2). This file is the TYPE-LEVEL home for the MDM
// enums and, above all, the §2.3 "what is canonical vs overlay" decision encoded as data —
// the single hardest design call in MDM ("which field goes where"). The Drizzle `pgEnum`
// DDL lives in packages/db/src/enums.ts (M40-T01); the per-table schema lands in
// packages/db/src/schema/mdm/* at M40-T02 — manifest is law there (M40 owns 11 tables:
// canonical external_physician/facility/payer, the external_physician_tenant_overlay, and
// the cross-cutting merge/provisional/baa/nppes-sync tables, §3.3–3.5). The resolution
// engine (M40-T04), the MdmEntityProvider / BaaStatusProvider seams (M40-T05/T06), routes
// (M40-T07), and the eraser (M40-T10) build on the shared kind/enum types shipped here.
//
// Design call (§2.3): anything observable from a public registry or invariant about the
// entity itself is CANONICAL (one org-less row, registry-sourced, same answer for everyone);
// anything that is this-tenant's-opinion-about-the-entity is OVERLAY (org-scoped, RLS-isolated).
// A field that drifts based on who you ask is by definition not canonical. When in doubt,
// overlay — promoting overlay→canonical is an admin reconciliation; demoting canonical→overlay
// is a destructive splay across tenants.

// ── §3.2 enum unions (type-level mirrors of packages/db/src/enums.ts) ─────────────────────

/**
 * The seven real-world entity kinds MDM canonicalizes (§2.3). The discriminator on
 * `entity_relationship` / `merge_request` / `mdm_provisional` that constrains which canonical
 * table a row references (the §2.5 intra-kind CHECKs). Mirrors the `mdm_entity_kind` pgEnum.
 *
 * Phase 1 materializes canonical tables for `physician`/`facility`/`payer` only (see
 * {@link MDM_ENTITY_KIND_DESCRIPTORS}); the other four are forward-declared in the enum so the
 * Postgres type is stable when their tables land in a later phase.
 */
export type MdmEntityKind =
  | "physician"
  | "facility"
  | "pharmacy"
  | "referral_source"
  | "payer"
  | "dme_vendor"
  | "funeral_home";

/** Runtime list of every entity kind — the value-level mirror of {@link MdmEntityKind} for
 *  places that need the kinds at runtime (e.g. a `:kind` route-param union, M40-T07). */
export const MDM_ENTITY_KINDS = [
  "physician",
  "facility",
  "pharmacy",
  "referral_source",
  "payer",
  "dme_vendor",
  "funeral_home",
] as const satisfies readonly MdmEntityKind[];

/** The canonical-entity lifecycle (§2.4.1). `merged` rows carry a non-null `merged_into_id`
 *  (the §2.5 CHECK) and redirect transparently to their survivor (§7.2). */
export type MdmEntityStatus = "active" | "deactivated" | "merged" | "provisional";

/** The merge-request lifecycle (§2.4.2). `approved` locks canonical_id + duplicate_id;
 *  `executed` means the duplicate flipped to `merged` and re-pointing was enqueued. */
export type MdmMergeStatus = "pending" | "approved" | "rejected" | "executed";

/** Who proposed a merge (§2.4.2). */
export type MdmMergeProposer = "nppes" | "admin" | "tenant" | "fuzzy_job";

/** The provisional-entity lifecycle (§2.4.3) — a tenant-proposed row with no identifier
 *  match yet. Provisional rows are org-scoped (§2.5 NOT NULL); only canonical is org-less. */
export type MdmProvisionalStatus = "pending" | "promoted" | "merged" | "rejected";

/** The registry-sync cadence recorded on `nppes_sync_log` (§4.3). The nightly delta is the
 *  Phase-1 authoritative sync path (M40-T08); on-demand is a single-NPI lookup. */
export type MdmNppesSyncMode = "nightly_delta" | "weekly_full" | "on_demand";

/** Per-tenant BAA execution state on `mdm_baa_record` (§7.7). The disclosure gate denies
 *  where a BAA is required and the tenant's record is not `executed`. */
export type MdmBaaStatus = "executed" | "pending" | "n_a";

/** The canonical `facility` subtype (§3.3). */
export type FacilityKind = "hospital" | "alf" | "snf" | "ipu" | "clinic" | "other";

/** The canonical `payer` subtype (§3.3). */
export type PayerKind =
  | "medicare"
  | "medicaid"
  | "medicare_advantage"
  | "commercial"
  | "other";

// ── §2.3 the canonical-vs-overlay dividing line, as data ──────────────────────────────────

/**
 * Where a field lives (§2.3). `canonical` = one org-less, registry-sourced row shared by every
 * tenant; `overlay` = an org-scoped, RLS-isolated this-tenant opinion. This is the MDM analog
 * of M36's `channel_kind` discriminator: one decision drives storage, RLS, and write-grant.
 */
export type FieldPlacement = "canonical" | "overlay";

/** The classes of field §2.3 sorts by placement. The placement of a concrete column is read
 *  from {@link FIELD_PLACEMENT_RULES} rather than re-deciding it per table. */
export type FieldClass =
  | "public_identifier"
  | "demographic_registry_attribute"
  | "operational_status"
  | "hierarchy_parent"
  | "preferred_contact"
  | "relationship_rating"
  | "do_not_refer"
  | "is_preferred"
  | "contract_terms"
  | "per_location_preference"
  | "baa_execution_state";

/** One row of the §2.3 placement table: a field class, where it lives, and why. */
export interface FieldPlacementRule {
  readonly fieldClass: FieldClass;
  readonly placement: FieldPlacement;
  /** A representative example column (§2.3). */
  readonly example: string;
  /** The §2.3 rationale — the test is "does the answer drift based on who you ask?". */
  readonly why: string;
}

/**
 * The §2.3 table verbatim — the dividing line as the single source consumers (schema authors,
 * the overlay-join resolver M40-T04, route validators) read instead of re-deriving the rule.
 * The default when uncertain is `overlay` (§2.3 closing note).
 */
export const FIELD_PLACEMENT_RULES: {
  readonly [C in FieldClass]: FieldPlacementRule & { fieldClass: C };
} = {
  public_identifier: {
    fieldClass: "public_identifier",
    placement: "canonical",
    example: "NPI, CCN, NCPDP, X12 payer id",
    why: "Identity. The reason the row exists.",
  },
  demographic_registry_attribute: {
    fieldClass: "demographic_registry_attribute",
    placement: "canonical",
    example: "name, credentials, specialty taxonomy, license_states, primary_address",
    why: "Sourced from NPPES / public filings; same answer for everyone.",
  },
  operational_status: {
    fieldClass: "operational_status",
    placement: "canonical",
    example: "active / deactivated",
    why: "Comes from the registry; affects every tenant.",
  },
  hierarchy_parent: {
    fieldClass: "hierarchy_parent",
    placement: "canonical",
    example: "facility parent, payer parent (entity_relationship)",
    why: "Reflects real-world structure.",
  },
  preferred_contact: {
    fieldClass: "preferred_contact",
    placement: "overlay",
    example: "the phone/email this tenant actually uses to reach them",
    why: "Tenants have different preferred contacts; the registry's number is often wrong.",
  },
  relationship_rating: {
    fieldClass: "relationship_rating",
    placement: "overlay",
    example: '"great communicator", "always late on F2F"',
    why: "Tenant opinion.",
  },
  do_not_refer: {
    fieldClass: "do_not_refer",
    placement: "overlay",
    example: "this tenant won't send patients to this physician",
    why: "Tenant policy.",
  },
  is_preferred: {
    fieldClass: "is_preferred",
    placement: "overlay",
    example: "preferred-list ordering / top referral targets",
    why: "Tenant relationship.",
  },
  contract_terms: {
    fieldClass: "contract_terms",
    placement: "overlay",
    example: "per-tenant negotiated price/SLA (Payer, DmeVendor)",
    why: "Each tenant's contract is its own.",
  },
  per_location_preference: {
    fieldClass: "per_location_preference",
    placement: "overlay",
    example: "per-Location preferred pharmacy (overlay row references location_id)",
    why: "Tenant operational layout.",
  },
  baa_execution_state: {
    fieldClass: "baa_execution_state",
    placement: "overlay",
    example: "tenant has a BAA with this entity (mdm_baa_record)",
    why: "Per-tenant relationship.",
  },
} as const;

// ── §2.3/§2.4 per-kind descriptor — which kinds ship Phase 1 + their identity invariants ──

/** The public identifier that anchors a canonical kind's identity (§2.3). */
export type CanonicalIdentifier = "npi" | "ccn" | "x12_payer_id" | "ncpdp";

/**
 * The per-entity-kind invariants the schema (M40-T02) and the canonical/overlay RLS pattern
 * (M40-T03 §3.6) enforce: the kind's primary public identifier, whether Phase 1 materializes
 * its canonical table, and whether it carries a tenant overlay table. In Phase 1 only the
 * `physician` overlay (`external_physician_tenant_overlay`) ships — facility/payer canonical
 * rows have no overlay table yet (manifest owns 11 tables, §3.3–3.5).
 */
export interface MdmEntityKindDescriptor {
  readonly kind: MdmEntityKind;
  /** The identifier the canonical row exists to track (§2.3 "the reason the row exists"). */
  readonly identifier: CanonicalIdentifier;
  /** Whether Phase 1 materializes this kind's canonical table (manifest, §3.3–3.5). */
  readonly phase1Canonical: boolean;
  /** Whether Phase 1 ships a per-tenant overlay table for this kind (§3.4). */
  readonly phase1Overlay: boolean;
  /** Whether the disclosure BAA gate (§7.7) can be required for this kind. */
  readonly baaGated: boolean;
}

/**
 * The §2.3/§2.4 per-kind table as data. `phase1Canonical`/`phase1Overlay` track the manifest's
 * 11 owned tables exactly: physician/facility/payer canonical + the physician overlay only.
 */
export const MDM_ENTITY_KIND_DESCRIPTORS: {
  readonly [K in MdmEntityKind]: MdmEntityKindDescriptor & { kind: K };
} = {
  physician: {
    kind: "physician",
    identifier: "npi",
    phase1Canonical: true,
    phase1Overlay: true,
    baaGated: true,
  },
  facility: {
    kind: "facility",
    identifier: "ccn",
    phase1Canonical: true,
    phase1Overlay: false,
    baaGated: true,
  },
  payer: {
    kind: "payer",
    identifier: "x12_payer_id",
    phase1Canonical: true,
    phase1Overlay: false,
    baaGated: true,
  },
  pharmacy: {
    kind: "pharmacy",
    identifier: "ncpdp",
    phase1Canonical: false,
    phase1Overlay: false,
    baaGated: false,
  },
  referral_source: {
    kind: "referral_source",
    identifier: "npi",
    phase1Canonical: false,
    phase1Overlay: false,
    baaGated: true,
  },
  dme_vendor: {
    kind: "dme_vendor",
    identifier: "npi",
    phase1Canonical: false,
    phase1Overlay: false,
    baaGated: false,
  },
  funeral_home: {
    kind: "funeral_home",
    identifier: "npi",
    phase1Canonical: false,
    phase1Overlay: false,
    baaGated: false,
  },
} as const;

/** The Phase-1 canonical kinds (physician/facility/payer) — the kinds whose canonical tables
 *  the manifest owns now (§3.3). Derived from {@link MDM_ENTITY_KIND_DESCRIPTORS}. */
export const PHASE_1_CANONICAL_KINDS = MDM_ENTITY_KINDS.filter(
  (k) => MDM_ENTITY_KIND_DESCRIPTORS[k].phase1Canonical,
) as readonly MdmEntityKind[];
