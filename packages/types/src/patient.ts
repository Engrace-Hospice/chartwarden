// @wardenx/types — Module 5 (Patient & Demographics) leaf contracts (M5-T01; spec §2.2, §4.6, §4.8).
//
// Per ADR-0005 D1 the cross-module CONTRACTS live in this leaf package (the spec's references to a
// `packages/foundation/seams` resolve here — architecture wins; there is no foundation package).
// M5-T01 ships the type-level surface every later M5 task + every cross-module consumer builds on:
// the §2.2 identifier strategy as data, the `m5.patient.*` outbox event names (§4.6), and the
// `PatientReader` data shape (§4.8) — the seam IMPLEMENTATIONS + their registry wiring land in
// M5-T07/T08 (CaseloadProvider / PatientReader / PatientMutator), the routes in T09, the outbox
// publication in T10.

// ── §2.2 patient identifier strategy (as data) ────────────────────────────────────────────────

/** The seven identifier kinds the §2.2 strategy tracks (mirrors the `patient_identifier_kind` enum). */
export type PatientIdentifierKind =
  | "mrn"
  | "mbi"
  | "ssn"
  | "state_id"
  | "prior_mrn"
  | "hospice_external"
  | "partner_mrn";

/** How an identifier is stored — plaintext, or envelope-encrypted with a plaintext `last4` (§2.2). */
export type PatientIdentifierStorage = "plaintext" | "encrypted_last4";

/** One row of the §2.2 strategy table: storage, mutability, indexing, and uniqueness scope. */
export interface PatientIdentifierRule {
  readonly kind: PatientIdentifierKind;
  readonly storage: PatientIdentifierStorage;
  /** `immutable` after create; `replaceable` (CMS/SSA rotate); `append_only` at migration/ADT. */
  readonly mutability: "immutable" | "replaceable" | "append_only";
  /** Whether the value is searchable/indexed. SSN/state_id are NOT indexed (§2.2). */
  readonly indexed: boolean;
  /** Uniqueness scope within an org, or `null` when the value is not unique (SSN/state_id). */
  readonly uniqueScope: "per_org" | "per_org_per_issuer" | null;
}

/**
 * The §2.2 identifier strategy verbatim — the single source consumers read instead of re-deriving
 * per-kind handling. `ssn`/`state_id` are envelope-encrypted (plaintext `value_last4` for display),
 * not indexed; `mrn` is immutable-post-create and unique per org; the partner/prior/hospice external
 * kinds are append-only and unique per (org, issuer).
 */
export const PATIENT_IDENTIFIER_RULES: {
  readonly [K in PatientIdentifierKind]: PatientIdentifierRule & { kind: K };
} = {
  mrn: {
    kind: "mrn",
    storage: "plaintext",
    mutability: "immutable",
    indexed: true,
    uniqueScope: "per_org",
  },
  mbi: {
    kind: "mbi",
    storage: "plaintext",
    mutability: "replaceable",
    indexed: true,
    uniqueScope: "per_org",
  },
  ssn: {
    kind: "ssn",
    storage: "encrypted_last4",
    mutability: "replaceable",
    indexed: false,
    uniqueScope: null,
  },
  state_id: {
    kind: "state_id",
    storage: "encrypted_last4",
    mutability: "replaceable",
    indexed: false,
    uniqueScope: null,
  },
  prior_mrn: {
    kind: "prior_mrn",
    storage: "plaintext",
    mutability: "append_only",
    indexed: true,
    uniqueScope: "per_org_per_issuer",
  },
  hospice_external: {
    kind: "hospice_external",
    storage: "plaintext",
    mutability: "append_only",
    indexed: true,
    uniqueScope: "per_org_per_issuer",
  },
  partner_mrn: {
    kind: "partner_mrn",
    storage: "plaintext",
    mutability: "append_only",
    indexed: true,
    uniqueScope: "per_org_per_issuer",
  },
} as const;

/** The CMS MBI alphabet (§2.2): digits + A–Z minus the visually-ambiguous S/L/O/I/B/Z. */
export const MBI_ALLOWED_LETTERS = "ACDEFGHJKMNPQRTUVWXY";

// ── §4.6 outbox event names (the `m5.*` namespace the dispatcher validates) ─────────────────────

/** The 16 §4.6 patient outbox topics, in the `m5.patient.*` subscriber-facing form. */
export const M5_PATIENT_EVENT_NAMES = [
  "m5.patient.created",
  "m5.patient.updated",
  "m5.patient.status_changed",
  "m5.patient.address_changed",
  "m5.patient.payer_changed",
  "m5.patient.assignment_created",
  "m5.patient.assignment_ended",
  "m5.patient.privacy_flag_changed",
  "m5.patient.deceased",
  "m5.patient.merged",
  "m5.patient.unmerged",
  "m5.patient.archived",
  "m5.patient.amendment_request_received",
  "m5.patient.amendment_decided",
  "m5.patient.bereavement_opt_out_changed",
  "m5.patient.draft_created_from_extraction",
] as const;

/** A patient outbox event name (§4.6). */
export type M5PatientEventName = (typeof M5_PATIENT_EVENT_NAMES)[number];

// ── §4.8 PatientReader data shape (the read seam M29 consumes; impl + wiring in M5-T08) ──────────

/** An external-system MRN carried on a resolved {@link PatientIdentity} (§4.8). */
export interface ExternalMrn {
  readonly assigningAuthority: string;
  readonly value: string;
}

/**
 * The resolved patient identity the `PatientReader` seam returns (§4.8). Merge-redirect is resolved
 * transparently by the seam; `mergedIntoId` is exposed only for chain traversal. PHI-minimal — the
 * read surface M29's patient-match cascade consumes, not the full chart.
 */
export interface PatientIdentity {
  readonly id: string;
  readonly organizationId: string;
  readonly mrn: string;
  readonly externalMrns: readonly ExternalMrn[];
  readonly lastName: string;
  readonly firstName: string;
  readonly dateOfBirth: string; // ISO yyyy-mm-dd
  readonly administrativeSex: "M" | "F" | "U" | "O" | string;
  readonly ssnLast4?: string;
  readonly mergedIntoId?: string;
}

/**
 * The §4.8 PatientReader seam — the typed read interface M29's T-29.05 patient-match cascade
 * consumes. Merge-redirect is resolved TRANSPARENTLY by the seam (a merged patient resolves to its
 * survivor, ≤ 3 hops); `PatientIdentity.mergedIntoId` is exposed only for chain traversal. Per-call
 * p95 ≤ 200ms SLO (D11). M5 registers the real impl over the M1 deny-stub at boot (M5-T08).
 */
export interface PatientReader {
  findByMrn(input: { organizationId: string; mrn: string }): Promise<PatientIdentity | null>;
  findByExternalMrn(input: {
    organizationId: string;
    assigningAuthority: string;
    value: string;
  }): Promise<PatientIdentity | null>;
  findBySsnLast4AndDob(input: {
    organizationId: string;
    ssnLast4: string;
    dateOfBirth: string;
  }): Promise<readonly PatientIdentity[]>;
  findByNameDobSex(input: {
    organizationId: string;
    lastName: string;
    firstName: string;
    dateOfBirth: string;
    administrativeSex: string;
  }): Promise<readonly PatientIdentity[]>;
  findByLooseName(input: {
    organizationId: string;
    lastName: string;
    firstNameInitial?: string;
    dateOfBirth: string;
  }): Promise<readonly PatientIdentity[]>;
  findById(input: { organizationId: string; id: string }): Promise<PatientIdentity | null>;
}

// ── §4.9 PatientMutator seam (the M29 proposal-accept apply path; D12) ───────────────────────────

/**
 * The fields an M29-proposal / amendment / admin patch MAY carry (§4.9.1). The demographic + contact
 * set is applied; the forbidden identifiers (`mrn`/`mbi`/`ssn`/`stateId`/`status`/`mergedIntoId`/`id`/
 * `organizationId`) are accepted in the shape for caller convenience but SILENTLY STRIPPED at apply
 * time (D12 / W-M5-17 defense in depth — their presence is not an error, the audit records the strip).
 */
export interface PatientMutationPatch {
  readonly legalFirstName?: string;
  readonly legalMiddleName?: string;
  readonly legalLastName?: string;
  readonly preferredName?: string;
  readonly dateOfBirth?: string;
  readonly administrativeSex?: "M" | "F" | "U" | "O" | string;
  readonly maritalStatus?: string;
  readonly preferredLanguage?: string;
  readonly address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal?: string;
  };
  readonly phoneHome?: string;
  readonly phoneMobile?: string;
  readonly email?: string;
  readonly externalMrnsToAdd?: ReadonlyArray<{ assigningAuthority: string; value: string }>;
  // forbidden (stripped at apply time):
  readonly mrn?: string;
  readonly mbi?: string;
  readonly ssn?: string;
  readonly stateId?: string;
  readonly status?: string;
  readonly mergedIntoId?: string;
  readonly id?: string;
  readonly organizationId?: string;
}

/** The source provenance of a {@link PatientMutationPatch} (§4.9.1). */
export type PatientMutationSource =
  | "m29_proposal_accept"
  | "amendment_decision"
  | "admin_correction";

/** A mutation request (§4.9.1). `sourceRef` records the provenance for the audit trail. */
export interface PatientMutatorInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly patch: PatientMutationPatch;
  readonly source: PatientMutationSource;
  readonly sourceRef:
    | { kind: "hl7_inbound_proposal"; id: string }
    | { kind: "patient_amendment_request"; id: string }
    | { kind: "admin"; rationale: string };
  readonly actorMembershipId: string;
}

/** The outcome of a mutation (§4.9.1) — what applied, what was stripped, and the side effects. */
export interface PatientMutatorResult {
  readonly patientId: string;
  readonly appliedFields: readonly string[];
  readonly strippedFields: readonly string[];
  readonly addressVersionCreated: boolean;
  readonly externalMrnsAddedCount: number;
}

/**
 * The §4.9 PatientMutator seam — applies a field-level diff from an M29 proposal acceptance (or an
 * amendment decision / admin correction) through M5's validation + cascades. Addresses follow the
 * append-only discipline (D5); forbidden identifiers are stripped (D12). M5 registers the real impl
 * over the M1 deny-stub at boot (M5-T08); emits `m5.patient.updated` with the applied-field list.
 */
export interface PatientMutator {
  apply(input: PatientMutatorInput): Promise<PatientMutatorResult>;
}

// ── §3.4 PatientCoverageReader seam (the billing payer-resolution read) ──────────────────────────

/**
 * One active/known insurance coverage on a patient (`patient_payer`, M5 §3.4), projected for the
 * modules that must resolve WHICH coverage a claim bills. `payerId` is an M40 canonical payer id —
 * the display name resolves through `MdmEntityProvider`, never from here. `rank` 1 = primary.
 *
 * PHI-minimal by construction: the coverage identity and the member id the payer needs, nothing
 * clinical. `subscriberId` is the member id (an MBI for `medicare_ffs`, the recipient id for a
 * Medicaid coverage), so a consumer that only needs to CHOOSE a coverage should read `id` and leave
 * `subscriberId` alone — M24's claim rows store the masked tail only (D12 / §3.6).
 */
export interface PatientCoverage {
  readonly id: string;
  readonly patientId: string;
  readonly payerId: string;
  readonly rank: number;
  /** `medicaid` / `medicare_ffs` / `commercial` / … (the M5 `patient_payer_coverage_kind` enum). */
  readonly coverageKind: string;
  readonly subscriberId: string;
  readonly groupNumber: string | null;
  /** True while the coverage is open (`effective_to IS NULL`). */
  readonly current: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/**
 * The §3.4 PatientCoverageReader seam — the coverage list the BILLING modules resolve a claim's payer
 * from. M23 (Medicare) and M24 (Medicaid) both need "which coverage does this claim bill, and was it
 * in force on the service date"; before this seam each had it as an open deferral and degraded claim
 * assembly to a 503, because M5's coverage data was reachable only through its HTTP route.
 *
 * `coveragesForPatient` returns every coverage (caller filters); `activeCoverageOfKind` is the
 * assembly hot path — the highest-ranked coverage of a kind in force ON a service date, or null.
 * M5 registers the real impl over the M1 deny-stub at boot.
 */
export interface PatientCoverageReader {
  coveragesForPatient(input: {
    organizationId: string;
    patientId: string;
  }): Promise<readonly PatientCoverage[]>;
  activeCoverageOfKind(input: {
    organizationId: string;
    patientId: string;
    coverageKind: string;
    /** ISO yyyy-mm-dd — the coverage must be in force on this date. */
    onDate: string;
  }): Promise<PatientCoverage | null>;
}
