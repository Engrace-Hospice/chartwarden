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
  /**
   * The patient's agency (`patient.provider_entity_id`, ARCH-011). Added for GAP-044: M29's manual
   * unmatched-lab bind must materialize a `lab_observation`, whose `provider_entity_id` is NOT NULL, and
   * M29 may not read M5's table to find it. Optional and possibly `null` — a patient row may predate
   * agency assignment, and a consumer that needs it must fail closed rather than invent one.
   */
  readonly providerEntityId?: string | null;
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

export interface PatientHopeAdmissionPrefillFacts {
  readonly patientId: string;
  readonly organizationId: string;
  readonly legalFirstName: string;
  readonly legalMiddleName: string | null;
  readonly legalLastName: string;
  readonly legalNameSuffix: string | null;
  readonly dob: string;
  readonly sexAssignedAtBirth: string;
  readonly raceCodes: readonly string[];
  readonly ethnicityCodes: readonly string[];
  readonly preferredLanguageCode: string | null;
  readonly identifiers: readonly {
    readonly kind: PatientIdentifierKind;
    readonly value: string | null;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
}

/** M5 narrow read seam for M10 HOPE Admission prefill. It deliberately exposes plaintext only for
 * identifier kinds that M5 already treats as plaintext-readable through normal routes; SSN/state id
 * remain last4/encrypted outside this contract. */
export interface PatientHopeAdmissionPrefillReader {
  factsForHopeAdmissionPrefill(input: {
    readonly organizationId: string;
    readonly patientId: string;
  }): Promise<PatientHopeAdmissionPrefillFacts | null>;
}

export interface PatientIntakeCandidate {
  readonly patientId: string;
  readonly confidence: "deterministic" | "probable";
  readonly matchedOn?: string;
  readonly score?: number;
}

/** CMS Medicare Beneficiary Identifier format — the `patient_identifier_mbi_format` CHECK (M5). */
export const MBI_PATTERN = /^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$/;

/** People type MBIs as "1EG4-TE5-MK73" / "1eg4 te5 mk73"; the chart stores "1EG4TE5MK73". */
export function normalizeMedicareNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidMedicareNumber(raw: string): boolean {
  return MBI_PATTERN.test(normalizeMedicareNumber(raw));
}

/** People type SSNs as "123-45-6789" / "123 45 6789"; CMS submits "123456789". */
export function normalizeSsn(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** The SSN values CMS HOPE edit -3003 rejects outright (well-known placeholder / test numbers). */
export const CMS_REJECTED_SSNS: readonly string[] = [
  "111111111",
  "333333333",
  "123456789",
  "999999999",
];

/**
 * The CMS HOPE fatal format edits for A0600A (Detailed Data Specifications v1.00.1), applied to the
 * value (normalized unless `asStored`): -3015 digits only · -3001 exactly 9 · -3002 not starting "000" · -3003 not a
 * rejected placeholder. Returns the failing edit, or null when the SSN passes (or is the "^" blank).
 */
export function ssnCmsProblem(
  raw: string,
  /** `asStored`: judge the value exactly as it would be submitted (server); else as typed (form). */
  options: { asStored?: boolean } = {},
): { ruleId: string; message: string } | null {
  const ssn = options.asStored ? raw : normalizeSsn(raw);
  if (ssn === "" || ssn === "^") return null;
  if (!/^[0-9]+$/.test(ssn))
    return { ruleId: "-3015", message: "SSN may contain only the digits 0-9." };
  if (ssn.length !== 9) return { ruleId: "-3001", message: "SSN must be exactly 9 digits." };
  if (ssn.startsWith("000")) return { ruleId: "-3002", message: "SSN cannot start with 000." };
  if (CMS_REJECTED_SSNS.includes(ssn))
    return { ruleId: "-3003", message: "This SSN is a placeholder CMS rejects." };
  return null;
}

/**
 * Medicaid IDs: formats vary by state, so only the HOPE A0700 shape is enforced — 1-14 letters/digits
 * once spaces and dashes are removed.
 */
export const MEDICAID_NUMBER_PATTERN = /^[A-Z0-9]{1,14}$/;

export function normalizeMedicaidNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidMedicaidNumber(raw: string): boolean {
  return MEDICAID_NUMBER_PATTERN.test(normalizeMedicaidNumber(raw));
}

export interface PatientIntakeSubject {
  readonly organizationId: string;
  readonly patientNameAtReceipt: string;
  readonly patientDobAtReceipt?: string | null;
  /** Normalized MBI from referral intake — sharpens matching and seeds the chart's `mbi` identifier. */
  readonly medicareNumberAtReceipt?: string | null;
}

export interface PatientCreateFromIntakeInput extends PatientIntakeSubject {
  readonly administrativeSex?: "M" | "F" | "U" | "O" | string;
}

/** M5-owned intake resolver seam. M6 orchestrates referrals; M5 remains patient identity authority. */
export interface PatientIntakeResolver {
  findPatientCandidates(input: PatientIntakeSubject): Promise<{
    readonly outcome: "no_match" | "possible_match" | "deterministic_match";
    readonly candidates: readonly PatientIntakeCandidate[];
  }>;
  confirmPatient(input: {
    readonly organizationId: string;
    readonly patientId: string;
  }): Promise<PatientIdentity | null>;
  createPatientFromIntake(input: PatientCreateFromIntakeInput): Promise<PatientIdentity>;
  /**
   * Records an intake-supplied MBI on an existing patient's chart — only when the chart has no active
   * MBI. Never overwrites: a differing chart value is reported, not replaced (M5 owns identity, D12).
   */
  recordMedicareNumberIfMissing(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly medicareNumber: string;
  }): Promise<"added" | "already_on_chart" | "different_on_chart">;
}

export type PatientAdmissionClearanceReason =
  | "PATIENT_NOT_FOUND"
  | "PRIVACY_RESTRICTION"
  | "PRIVACY_CLEARANCE_UNAVAILABLE";

/**
 * WHICH kind of restriction holds a `PRIVACY_RESTRICTION` in place — the minimum an admission screen
 * needs to send the user to the workflow that can lift it. Deliberately coarse and category-free: it
 * names the next step, never the flag category or any record content.
 *
 *   INTAKE_DETECTION_UNREVIEWED  an intake document (M22 DocLens, W4) put an interim restriction on the
 *                                patient that no reviewer has confirmed or rejected yet
 *   CONSENT_REQUIRED             a confirmed restriction that only a patient consent (M39) lifts
 *   RESTRICTED                   any other restriction (no self-service path from the admission screen)
 */
export type PatientAdmissionRestriction =
  | "INTAKE_DETECTION_UNREVIEWED"
  | "CONSENT_REQUIRED"
  | "RESTRICTED";

export interface PatientAdmissionClearance {
  readonly allowed: boolean;
  readonly reason?: PatientAdmissionClearanceReason;
  /** Present only with `reason: "PRIVACY_RESTRICTION"`. */
  readonly restriction?: PatientAdmissionRestriction;
  readonly overrideAllowed?: boolean;
}

/**
 * M5-owned privacy/admission clearance seam. M6 asks for the high-level admission-readiness decision
 * and never reads M5 privacy tables directly.
 */
export interface PatientAdmissionClearanceReader {
  evaluatePatientAdmissionClearance(input: {
    readonly organizationId: string;
    readonly patientId: string;
  }): Promise<PatientAdmissionClearance>;
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

// ── PatientCaregiverReader / PatientAddressReader seams (TASK-015 — M31 portal ABAC) ─────────────────

/**
 * The M31 `portal_caregiver_is_primary_or_dpoa` ABAC predicate's read: is a given M2 `userId` the
 * PRIMARY caregiver on file for a patient? DENY-STUB ONLY today — `patient_caregiver` records
 * `caregiverId`/`isPrimary` but M5's `caregiver` row carries no column linking it to an M2 user
 * account, and `portal_account` carries a `userId` with no back-link to `caregiverId` either. No
 * schema path from a caregiver row to a `userId` exists yet, so a real impl cannot honestly answer
 * this question — it would have to guess or over-claim. The predicate's own fail-closed default
 * (§8.2: an unreadable seam denies) is the correct behavior until that link is added.
 */
export interface PatientCaregiverReader {
  /** The M2 userId of the patient's PRIMARY caregiver, or null (none on file, or no user link). */
  primaryCaregiverUserId(organizationId: string, patientId: string): Promise<string | null>;
}

/**
 * The M31 `state_two_party_recording_consent_present` ABAC predicate's read (D9 / §3.8): a patient's
 * current residence state, to check against the two-party recording-consent matrix. REAL impl —
 * `patient_address` already carries `state` + `isPrimary` + `effectiveTo` (M5 §3.3), a straightforward
 * current-primary-row query.
 */
/** M5 `patient_address.kind` (§3.3) — mirrors the DB enum without a cross-package import (leaf-typed). */
export type PatientAddressKind = "home" | "facility" | "mailing" | "temporary" | "prior";

export interface PatientResidenceSnapshot {
  readonly kind: PatientAddressKind;
  /** M40 Facility id, set only when `kind === "facility"`. */
  readonly facilityId: string | null;
  readonly postalCode: string | null;
}

/**
 * One PRIMARY address-history row overlapping a queried date range (F-213 — M23 claim place-of-service).
 * Kind + facility id + its effective window ONLY: no street/city/postal/state (no PHI beyond what the
 * residence kind implies). `effectiveTo` null = still current.
 */
export interface PatientResidenceSpan {
  readonly kind: PatientAddressKind;
  /** M40 Facility id, set only when `kind === "facility"`. */
  readonly facilityId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/**
 * The patient's CURRENT PRIMARY street address, for a consumer that must snapshot a delivery/service
 * address onto its own row (F-229 — M21 supply-request `deliveryAddress`). PHI: hold it in memory only;
 * never put it in an outbox payload (consumers PULL it through the seam at consume time).
 */
export interface PatientPrimaryAddress {
  readonly kind: PatientAddressKind;
  /** M40 Facility id, set only when `kind === "facility"`. */
  readonly facilityId: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  /** 2-letter for a US address; null for a non-US one. */
  readonly state: string | null;
  readonly postalCode: string;
  readonly country: string;
  readonly county: string | null;
}

export interface PatientAddressReader {
  /**
   * The patient's current (effective_to IS NULL) PRIMARY address in full, or null when none is on file.
   * Org-explicit: the tenant is the `organizationId` argument (RLS + an explicit predicate), so it is
   * safe from an outbox relay tick with no request context. The one seam that returns street-level PHI.
   */
  primaryAddress(organizationId: string, patientId: string): Promise<PatientPrimaryAddress | null>;
  /** The 2-letter state code of the patient's current (effective_to IS NULL) PRIMARY address, or null
   *  (no primary address, or its state is unset — e.g. a non-US address). */
  primaryResidenceState(organizationId: string, patientId: string): Promise<string | null>;
  /**
   * The patient's PRIMARY address effective as of `asOfDate` (M24 WX-PR-011 place-of-service follow-up:
   * was this hospice day delivered at home vs. an ALF/SNF/other facility?) — the address-history row
   * with `effectiveFrom <= asOfDate` and (`effectiveTo IS NULL` or `effectiveTo >= asOfDate`). Null if no
   * primary address covers that date.
   */
  residenceAt(
    organizationId: string,
    patientId: string,
    asOfDate: string,
  ): Promise<PatientResidenceSnapshot | null>;
  /**
   * Every PRIMARY address-history row overlapping `[from, to]` (inclusive), oldest first — so a caller
   * can tell whether the residence CHANGED (or has a coverage gap) inside a date range, which a single
   * `residenceAt` point read cannot (F-213: a claim's service range can span a move).
   */
  residencesBetween(
    organizationId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<readonly PatientResidenceSpan[]>;
  /**
   * The geocoded coordinate of the patient's service address (GAP-054 — M18's EVV geofence baseline): the
   * address row `patientAddressId` names when given (it must belong to `patientId`), else the current PRIMARY
   * address. Null when the address is absent, was never geocoded, or its coordinate is unreadable — the caller
   * treats that as "no baseline" (advisory), never as a pass. PHI: hold in memory only.
   */
  serviceAddressCoordinate(
    organizationId: string,
    patientId: string,
    patientAddressId: string | null,
  ): Promise<PatientAddressCoordinate | null>;
}

/** A WGS-84 coordinate in decimal degrees (a patient address's geocode). */
export interface PatientAddressCoordinate {
  readonly lat: number;
  readonly lng: number;
}

// ── PatientPrivacyFlagReader seam (GAP-061 — the M37 §2.2 shared-room occupancy gate) ────────────────

/**
 * How a patient's recorded sex resolves for a shared-room occupancy decision. M5 stores
 * `patient.sex_assigned_at_birth` as a USCDI value-set code; `unspecified` collapses every code that
 * is neither male nor female (`U`, `O`, `UNK`, an unmapped SNOMED code, …).
 *
 * `unspecified` is NOT a third sex for rooming purposes — it means the record cannot PROVE same-sex
 * occupancy, which is why M37's gate refuses a shared room on it rather than treating it as a match.
 */
export type PatientSexClass = "male" | "female" | "unspecified";

/**
 * The minimum M5 facts a shared-room occupancy decision needs about ONE patient. Deliberately not a
 * `PatientIdentity`: the occupancy gate must read the CURRENT ROOMMATES' records, and a roommate is
 * someone the assigning nurse may have no other right to see — so the seam hands back the two facts
 * the decision consumes and nothing that identifies the person (no name, no MRN, no DOB).
 */
export interface PatientRoomingFacts {
  readonly patientId: string;
  readonly sexClass: PatientSexClass;
  /**
   * The patient's ACTIVE privacy flags — the `flags` array of M5's `patient_privacy_flag_snapshot`
   * (§3.5: a subset of `sud | hiv | mental_health | genetic | minor_restricted | abuse_victim`).
   * Empty when no snapshot row exists (the snapshot is a cache, and its absence means "no flag
   * recorded", not "unreadable"). Every flag in M5's v1 vocabulary is RESTRICTIVE — none of them
   * grants a permission — see M37's `evaluateRoomOccupancy` for how the consumer reads them.
   */
  readonly privacyFlags: readonly string[];
}

/**
 * M5 §3.5 — the privacy-flag / rooming read M37's `assignBed` gate consults (M37 spec §2.2 route-table
 * row 170: "the bed's room is not occupied by an opposite-sex patient unless the room is private or
 * the patient privacy flag permits (M5 `PrivacyFlagReader`)"). GAP-061.
 *
 * A seam rather than a shared read: M37 gains no schema edge into M5 (ADR-0005), and the PHI that
 * crosses is bounded to the two facts the decision consumes. The POLICY lives in M37 — M5 owns what a
 * patient's sex and privacy flags ARE, M37 owns what a room may hold.
 */
export interface PatientPrivacyFlagReader {
  /**
   * Rooming facts for a set of patients in one round trip (the incoming patient + every current
   * roommate). Patients with no readable row are OMITTED from the result — the caller decides what an
   * absent answer means, and M37's gate treats it as unprovable (refuse the shared room) rather than
   * as a match.
   */
  roomingFactsFor(input: {
    organizationId: string;
    patientIds: readonly string[];
  }): Promise<readonly PatientRoomingFacts[]>;
}

// ── PatientAllergyReader seam (GAP-036 — the M12 requestSignature allergy gate) ──────────────────────

/** One entry of a patient's allergy list as the prescribing gate reads it. */
export interface PatientAllergyEntry {
  /** The attested allergen text, verbatim (PHI). */
  readonly allergenText: string;
  /** `unverified` entries (e.g. DocLens referral lines) count: hiding an unverified allergy is the unsafe failure. */
  readonly verificationStatus: "unverified" | "verified";
  readonly severity: "mild" | "moderate" | "severe" | "unknown" | null;
}

/**
 * M5 — the patient's CURRENT allergy list (every row not `entered_in_error`), read by M12's
 * `requestSignature` allergy gate. Returns `null` when the patient is unknown / cross-tenant / not
 * readable: the caller must treat that as "cannot check", never as "no allergies" (an empty array means
 * the patient exists and has no recorded allergy). A missing/unreadable M5 throws via the deny-stub.
 */
export interface PatientAllergyReader {
  activeAllergies(input: {
    organizationId: string;
    patientId: string;
  }): Promise<readonly PatientAllergyEntry[] | null>;
}
