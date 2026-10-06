// @wardenx/types — Module 6 (Admission, Election & Certification) leaf contracts (M6-T01).
//
// Per ADR-0005 D1 the cross-module CONTRACTS live in this leaf package (the M6 spec's references to
// `packages/domain/admission/src/readers` resolve here — there is no domain/foundation package on
// the cross-module read path; architecture wins). M6-T01 ships the type-level surface every later M6
// task + every cross-module consumer builds on: the §2.2 per-entity constraint data (audit denylists
// + the external-signal window payload), the `m6.*` outbox event names (§4.4), and the §4.7 reader
// seam interfaces. The seam IMPLEMENTATIONS + their M1-registry wiring land in M6-T05; routes in
// M6-T06; the full outbox publication in M6-T10.
//
// Seam-set reconciliation (plan vs spec): the Wave-D plan's interplay + M6-T05 name SIX reader seams
// — ElectionPeriodReader, CertificationReader, FaceToFaceReader, LevelOfCareReader,
// AdmissionStatusReader, AdmissionCensusReader. The spec §4.7 defines only THREE concrete interfaces
// (ElectionPeriodReader, AdmissionStatusReader, ComplianceReader) and folds LOC-day reads into
// AdmissionStatusReader. This file defines the spec's three verbatim PLUS focused interfaces for the
// plan's extra names so M6-T05 has every named seam available; T05 makes the final
// register/validate decisions (which seams go into REQUIRED_SEAMS, which fold together).

// ── Leaf-safe id + value aliases (mirror the §3.2 pgEnums; packages/types cannot import @wardenx/db) ─

/** A patient id (M5 owns the row; M6 reads it). */
export type PatientId = string;
export type AdmissionId = string;
export type ReferralId = string;
export type ElectionPeriodId = string;
export type ElectionStatementId = string;
export type CertificationId = string;
export type FaceToFaceEncounterId = string;
export type LevelOfCarePeriodId = string;
export type RevocationEventId = string;
export type TransferEventId = string;
export type DischargeEventId = string;
export type ComplianceWindowId = string;
export type OrgId = string;
export type ProviderEntityId = string;

/** ISO `yyyy-mm-dd` calendar date (timezone-aware math is the org's tz, done service-side). */
export type LocalDate = string;

/** An ISO-8601 instant (`yyyy-mm-ddThh:mm:ss.sssZ`). Declared MODULE-PRIVATE here (no `export`): the package
 * already exports the canonical `IsoInstant` from ./care-plan, and admission is a LOWER leaf than care-plan
 * (care-plan imports admission, not the reverse), so importing it would create an import cycle the no-circular
 * fitness rule forbids. A local string alias keeps admission a base leaf with the same leaf-safe-alias idiom as
 * `LocalDate` above — used internally only, so the package's `export *` surface keeps one exported definition. */
type IsoInstant = string;

/** The four CMS hospice levels of care (mirrors the `level_of_care` enum, §3.2). */
export type LevelOfCare =
  | "routine_home_care"
  | "continuous_home_care"
  | "inpatient_respite_care"
  | "general_inpatient_care";

/** CMS benefit-period length (mirrors `election_period_kind`, §2.2: 90,90,60,60,…). */
export type ElectionPeriodKind = "ninety_day" | "sixty_day";

/** The §3.2 admission lifecycle status (mirrors `admission_status`). */
export type AdmissionStatusValue =
  | "referred"
  | "pending"
  | "notice_of_rights_acknowledged"
  | "active"
  | "on_hold"
  | "discharged"
  | "bereavement"
  | "closed";

/** The §3.2 compliance-window lifecycle status (mirrors `compliance_window_status`). */
export type ComplianceWindowStatusValue = "open" | "closing_soon" | "overdue" | "closed";

/** The §3.2 compliance-window severity (mirrors `compliance_window_severity`; `info` = D15 signals). */
export type ComplianceWindowSeverity = "warning" | "alert" | "info";

/** The §3.2 compliance-window kinds (mirrors `compliance_window_kind`). */
export type ComplianceWindowKind =
  | "initial_assessment_48h"
  | "comprehensive_assessment_5d"
  | "care_plan_5d"
  | "f2f_recert_30d_prior"
  | "recert_due_14d"
  | "recert_due_7d"
  | "cti_signature_lookahead_14d"
  | "notice_of_rights"
  | "concurrent_hospital_admission"
  | "external_discharge_notice"
  | "hl7_admission_cancellation"
  // FY2027 — 42 CFR 418.24(d) election statement addendum clocks (mig 0380).
  | "election_addendum_initial"
  | "election_addendum_update";

/** An inclusive calendar-date range used by day-count reads (§4.7). */
export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

// ── §2.2 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror) ──────
// Captured here as data so M6-T03's `generateAuditTrigger(...)` denylist arguments are derived from a
// single source rather than re-typed per table. Tables with no sensitive free-text are listed `[]`.

/** The M6 table names that own a write-audit trigger (one per §3.3 table). */
export type M6TableName =
  | "referral"
  | "admission"
  | "election_period"
  | "election_statement"
  | "certification_of_terminal_illness"
  | "face_to_face_encounter"
  | "level_of_care_period"
  | "revocation_event"
  | "transfer_event"
  | "discharge_event"
  | "notice_of_rights_acknowledgment"
  | "compliance_window"
  | "election_addendum";

/** Per-table audit denylist (§2.2). The trigger records that a write happened but never mirrors the
 * listed high-sensitivity columns into the audit row. Empty array = no free-text PHI on that table. */
export const M6_AUDIT_DENYLIST: {
  readonly [K in M6TableName]: readonly string[];
} = {
  referral: [
    "patient_name_at_receipt",
    "patient_dob_at_receipt",
    "referring_dx_text",
    "referrer_phone",
  ],
  admission: ["hold_reason"],
  election_period: [],
  // `narrative` was never a real column on this table (§2.2's stated free-text field is the jsonb
  // `state_addendum`, which the trigger already scrubs) — corrected to match reality (TASK-063/ARCH-020).
  election_statement: ["patient_name_at_signing", "state_addendum"],
  certification_of_terminal_illness: ["narrative", "late_reason"],
  face_to_face_encounter: ["attestation_narrative", "window_override_reason"],
  level_of_care_period: ["reason"],
  revocation_event: ["narrative"],
  transfer_event: ["narrative"],
  discharge_event: ["narrative", "for_cause_reason"],
  notice_of_rights_acknowledgment: [],
  compliance_window: ["close_reason", "override_reason"],
  // FY2027 — the addendum's identifying snapshot, diagnoses, item list and every free-text note.
  election_addendum: [
    "patient_name",
    "medical_record_number",
    "terminal_diagnosis",
    "related_diagnoses",
    "items",
    "clinical_explanation",
    "guideline_references",
    "representative_name",
    "representative_relationship",
    "refusal_reason",
    "signature_not_required_note",
  ],
} as const;

/** The typed payload shape carried on the three external-signal compliance windows (§2.2 note / D15).
 * These windows are informational (`severity='info'`) and opened by the `AdmissionEventApplier`. */
export interface ExternalSignalWindowPayload {
  readonly source: "m29_proposal_accept";
  readonly proposalId: string;
  readonly sourceMessageId: string;
  readonly resourceKind: "discharge_event" | "admission_event" | "cancel_admission";
  readonly reasonCode: string;
  readonly summary: string;
}

// ── §4.4 outbox event names (the `m6.*` namespace the dispatcher + arch:gaps catalog validate) ──────

/** The full §4.4 M6 outbox taxonomy, in subscriber-facing `m6.*` form. The system keys off the
 * interplay subset (`m6.election.signed`/`m6.cti.signed`/`m6.f2f.attested`/`m6.loc.changed`/
 * `m6.revocation.created`/`m6.transfer.created`/`m6.discharge.created`/`m6.discharge.death`/
 * `m6.bereavement.eligible`); the full set is published in M6-T10. */
export const M6_EVENT_NAMES = [
  "m6.referral.received",
  "m6.referral.review_started",
  "m6.referral.pending_information",
  "m6.referral.qualified",
  "m6.referral.duplicate",
  "m6.referral.converted",
  "m6.referral.triaged",
  "m6.referral.accepted",
  "m6.referral.declined",
  "m6.referral.withdrawn",
  "m6.admission.draft_created",
  "m6.admission.activated",
  "m6.admission.on_hold",
  "m6.admission.resumed",
  "m6.admission.discharged",
  "m6.election.drafted",
  "m6.election.signed",
  "m6.election.period_started",
  "m6.election.period_ended",
  "m6.cti.drafted",
  "m6.cti.signed",
  "m6.cti.late_flagged",
  "m6.cti.voided",
  "m6.cti.due_7d",
  "m6.cti.due_3d",
  "m6.cti.overdue_1d",
  "m6.cti.signature_requested",
  "m6.cti.signature_due_1d",
  "m6.cti.signature_overdue",
  "m6.f2f.scheduled",
  // F-100 — completion used to re-emit `m6.f2f.scheduled`, which this union happily accepted: it pins
  // NAMES, and a real name emitted from the wrong transition with the wrong payload is still a real name.
  "m6.f2f.completed",
  "m6.f2f.attested",
  "m6.f2f.window_overridden",
  "m6.f2f.window_missed",
  "m6.f2f.due_7d",
  "m6.f2f.due_3d",
  "m6.f2f.overdue_1d",
  "m6.loc.changed",
  "m6.level_of_care.activated",
  "m6.revocation.created",
  "m6.transfer.created",
  "m6.discharge.created",
  "m6.discharge.death",
  "m6.discharge.cosigned",
  "m6.nor.acknowledged",
  "m6.compliance.window.opened",
  "m6.compliance.window.closed",
  "m6.compliance.window.overdue",
  "m6.compliance.window.overridden",
  // FY2027 — the 42 CFR 418.24(c)/(d) election statement addendum lifecycle.
  "m6.election_addendum.drafted",
  "m6.election_addendum.furnished",
  "m6.election_addendum.acknowledged",
  "m6.election_addendum.not_required",
  "m6.election_addendum.overdue",
  "m6.bereavement.eligible",
  "m6.applier.refused",
] as const;

/** An M6 outbox event name (§4.4). */
export type M6EventName = (typeof M6_EVENT_NAMES)[number];

// ── §4.7 reader-seam DTOs (read-only; returned by the seams below, never Drizzle rows) ──────────────

/** A single election period as seen by external readers (§4.7). */
export interface ElectionPeriodSummary {
  readonly periodId: ElectionPeriodId;
  readonly admissionId: AdmissionId;
  readonly sequence: number;
  readonly periodKind: ElectionPeriodKind;
  readonly status: "pending" | "signed" | "active" | "completed";
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly actualEndDate: LocalDate | null;
}

/** The active-period projection M23 binds a claim to (§4.7 `findActivePeriodForPatient`). */
export interface ActiveElectionPeriod {
  readonly periodId: ElectionPeriodId;
  readonly sequence: number;
  readonly levelOfCare: LevelOfCare;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
}

/** The admission projection M14/M30 render queues from (§4.7 `getAdmissionSummary`). */
export interface AdmissionSummary {
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  /**
   * The admission's location anchor (task-11 — the M9 capture-siting source; nullable on the row
   * until activation sites it). Optional so existing in-memory seeds stay valid; the Drizzle
   * reader always projects it.
   */
  readonly locationId?: string | null;
  /** Location-local time zone resolved by M6 for downstream scheduling consumers. */
  readonly locationTimeZone?: string | null;
  readonly status: AdmissionStatusValue;
  readonly admissionAt: LocalDate;
  readonly activatedAt: LocalDate | null;
  readonly dischargedAt: LocalDate | null;
  readonly currentElectionPeriodId: ElectionPeriodId | null;
  readonly currentLevelOfCare: LevelOfCare | null;
}

/** Days-of-care by level of care over a range (§4.7; M26 reads this to compute the aggregate cap). */
export interface LevelOfCareDays {
  readonly admissionId: AdmissionId;
  readonly range: DateRange;
  readonly daysByLevel: { readonly [L in LevelOfCare]: number };
}

/** The current/most-recent level-of-care period for an admission (§4.7 LevelOfCareReader). `status`
 *  (M6-T04 confirm-handshake fix): `assigning` means an IRC/GIP period awaiting M37 bed confirmation —
 *  NOT yet a real period of care; `getCurrentLevelOfCare`/`getLevelOfCareDays` must never treat it as
 *  "current" or count its days. */
export interface LevelOfCarePeriodSummary {
  readonly levelOfCarePeriodId: LevelOfCarePeriodId;
  readonly admissionId: AdmissionId;
  readonly levelOfCare: LevelOfCare;
  readonly status: "assigning" | "active" | "ended";
  readonly effectiveAt: LocalDate;
  readonly endedAt: LocalDate | null;
}

/** A CTI projection for a period (§4.7 CertificationReader). */
export interface CertificationSummary {
  readonly certificationId: CertificationId;
  readonly electionPeriodId: ElectionPeriodId;
  readonly status:
    | "drafted"
    | "awaiting_hospice_md"
    | "awaiting_attending"
    | "signed"
    | "voided"
    | "superseded";
  readonly hospiceMdSignedAt: LocalDate | null;
  readonly signedLate: boolean;
  readonly isRecert: boolean;
}

/** An attested F2F projection for a recert period (§4.7 FaceToFaceReader). */
export interface FaceToFaceSummary {
  readonly faceToFaceEncounterId: FaceToFaceEncounterId;
  readonly electionPeriodId: ElectionPeriodId;
  readonly status: "scheduled" | "completed" | "attested";
  readonly performerRole: "hospice_md" | "hospice_np";
  readonly encounterDate: LocalDate;
  readonly attestedAt: LocalDate | null;
  readonly windowOverride: boolean;
}

/** One open compliance window in M30's dashboard (§4.7 ComplianceReader). */
export interface ComplianceWindowSummary {
  readonly complianceWindowId: ComplianceWindowId;
  readonly admissionId: AdmissionId;
  readonly windowKind: ComplianceWindowKind;
  readonly status: ComplianceWindowStatusValue;
  readonly severity: ComplianceWindowSeverity;
  readonly mustCompleteBy: LocalDate;
}

/** One active admission row in a census/active-list read (§4.7 AdmissionCensusReader). */
export interface AdmissionCensusEntry {
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  readonly providerEntityId: ProviderEntityId;
  readonly status: AdmissionStatusValue;
  readonly currentLevelOfCare: LevelOfCare | null;
  readonly admissionAt: LocalDate;
}

/** The scope every list-style reader carries (RLS GUC is set by the consumer's withOrgContext). */
export interface AdmissionReaderScope {
  readonly orgId: OrgId;
  readonly providerEntityId?: ProviderEntityId;
}

// ── §4.7 reader seam interfaces ─────────────────────────────────────────────────────────────────────

/**
 * §4.7 — M23 binds a NOE/NOTR claim to the correct benefit period at the correct sequence. Resolved
 * within the consumer's tenant context (the reader does not switch tenants). Read-only DTOs.
 */
export interface ElectionPeriodReader {
  findActivePeriodForPatient(
    patientId: PatientId,
    on: LocalDate,
  ): Promise<ActiveElectionPeriod | null>;
  listPeriodsForAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<ElectionPeriodSummary>>;
}

/**
 * §4.7 — M14 (notifications) + M30 (operational dashboard) read admission state to render queues.
 * (The spec folds LOC-day reads in here; this build also exposes them on {@link LevelOfCareReader}
 * per the plan's split — M6-T05 picks the canonical home.)
 */
export interface AdmissionStatusReader {
  getAdmissionSummary(organizationId: string, admissionId: AdmissionId): Promise<AdmissionSummary>;
  /**
   * The admission's raw siting + anchor instants (M17 care-plan visit proposals site each proposal on
   * the admission's provider entity/location and anchor the frequency calendar on activation/admission).
   * Unlike {@link getAdmissionSummary} it never throws on a draft-time gap — every field is reported as
   * stored (nullable) so the consumer decides — and it returns null when the admission is unknown / not
   * visible under RLS.
   */
  getAdmissionSiting(
    organizationId: string,
    admissionId: AdmissionId,
  ): Promise<AdmissionSiting | null>;
}

/** §4.7 AdmissionStatusReader.getAdmissionSiting — the admission's siting as stored (nullable at draft). */
export interface AdmissionSiting {
  readonly admissionId: AdmissionId;
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId | null;
  readonly locationId: string | null;
  /** `admission.admission_at` as an ISO instant, or null (unset at draft). */
  readonly admissionAt: IsoInstant | null;
  /** `admission.activated_at` as an ISO instant, or null (not yet activated). */
  readonly activatedAt: IsoInstant | null;
}

/** §4.7 — M26 (cost reporting) reads LOC days by period; current-LOC lookups for clinical screens. */
export interface LevelOfCareReader {
  getCurrentLevelOfCare(admissionId: AdmissionId): Promise<LevelOfCarePeriodSummary | null>;
  getLevelOfCareDays(admissionId: AdmissionId, range: DateRange): Promise<LevelOfCareDays>;
}

/** §4.7 — recert gating reads: the active CTI for a period and whether it is signed. */
export interface CertificationReader {
  getActiveCertification(electionPeriodId: ElectionPeriodId): Promise<CertificationSummary | null>;
  isCertificationSignedForPeriod(electionPeriodId: ElectionPeriodId): Promise<boolean>;
}

/** §4.7 — recert gating reads: the attested F2F for a period and whether one exists. */
export interface FaceToFaceReader {
  getAttestedF2fForPeriod(electionPeriodId: ElectionPeriodId): Promise<FaceToFaceSummary | null>;
  isF2fAttestedForPeriod(electionPeriodId: ElectionPeriodId): Promise<boolean>;
}

/** §4.7 — active-admission census/list reads (M30 dashboards, M22 form prep). */
export interface AdmissionCensusReader {
  listActiveAdmissions(scope: AdmissionReaderScope): Promise<ReadonlyArray<AdmissionCensusEntry>>;
}

/** §4.7 — referral existence/visibility check for modules that attach artifacts to Referral Inbox rows. */
export interface ReferralReader {
  canAccessReferral(input: {
    readonly organizationId: OrgId;
    readonly userId: string;
    readonly referralId: ReferralId;
  }): Promise<boolean>;
  /**
   * F-238 — who a referral is about, for M22's intake: records filed against a referral adopt its patient
   * once M6 resolves one, and every document in them is checked against that patient (or, before then,
   * against the name/DOB the referral was received with). Null when the referral is not visible.
   */
  getReferralSubject(input: {
    readonly organizationId: OrgId;
    readonly referralId: ReferralId;
  }): Promise<ReferralSubject | null>;
}

export interface ReferralSubject {
  readonly referralId: string;
  /** M5 patient once resolved (matched / created); null while unresolved. */
  readonly patientId: string | null;
  readonly patientNameAtReceipt: string;
  /** ISO yyyy-mm-dd, or null when the referral arrived without one. */
  readonly patientDobAtReceipt: string | null;
  readonly status: string;
}

/** §4.7 — M30 dashboard pulls open compliance windows. */
export interface ComplianceReader {
  listOpenWindows(scope: AdmissionReaderScope): Promise<ReadonlyArray<ComplianceWindowSummary>>;
}

// ── HVLDL measure-input read seam (§4.11 / M30 HQRP) ────────────────────────────────────────────────
// M6 owns the death-discharge fact (`discharge_event.dischargeType='death'`, joined to `admission` for the
// patient id). M30's HVLDL measure-recompute worker needs the decedent census for a reporting period WITHOUT
// importing M6's schema, so M6 publishes this leaf-typed reader and M30 resolves it through `getSeam`.

/**
 * One decedent row for the HVLDL denominator (§4.11). `source`/`cosignStatus` carry the §4.11 external-source
 * breakdown the calculator records. KNOWN LIMITATION: M6's frozen `discharge_event` models only the death fact
 * (no source / cosign columns), so the current impl returns `source='internal_clinician_recorded'` with an
 * undefined `cosignStatus` for every decedent — the external subset stays empty and no Risk-Register flag fires.
 * The fields live in the contract so the impl can populate them once M6 models HL7-external death intake.
 */
export interface DeathDischargeRow {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly deathAt: IsoInstant;
  readonly source: "internal_clinician_recorded" | "hl7_external";
  readonly cosignStatus?: "cosigned" | "pending";
  /** F-227 — the M29 proposal an `hl7_external` death came from (M16 D18 correlates the cosign on it). */
  readonly sourceProposalId?: string;
  /** F-227 — the cosign facts once the medical director attested (absent while `pending`). */
  readonly cosignedAt?: IsoInstant;
  readonly medicalDirectorMembershipId?: string;
}

/**
 * §4.11 — the death-discharge census read M30's HVLDL measure-recompute worker consumes. Resolved within the
 * worker's tenant context; the M6 Drizzle impl self-scopes each call to `organizationId` (it reads on a
 * different connection than the M30 worker, so it sets the per-request org GUC itself) with a belt-and-
 * suspenders org-id predicate. Aggregate-but-patient-linked WITHIN one org — nothing crosses a tenant boundary.
 */
export interface DeathDischargeReader {
  listDeathDischargesInPeriod(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<ReadonlyArray<DeathDischargeRow>>;
}

/**
 * M30 HCI indicator 1 (Continuous Home Care or General Inpatient provided) — an org-level aggregate over
 * `election_period` × `level_of_care_period`. Resolved within the worker's tenant context; the Drizzle impl
 * self-scopes each call to `organizationId` (the same pattern as {@link DeathDischargeReader} — it reads on
 * a different connection than the M30 worker). Aggregate-only: no patient row crosses (D6).
 */
export interface LevelOfCarePeriodReader {
  /**
   * Election periods with `effectiveAt` in `[period.from, period.to)` (denominator) and, among those, the
   * count with at least one `continuous_home_care` or `general_inpatient_care` LOC day overlapping the
   * period's own window (numerator).
   */
  chcOrGipCoverageCounts(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;

  /**
   * M30 HCI indicators 8 and 9 — every level-of-care span overlapping `[period.from, period.to)`, CLIPPED
   * to it. Both indicators are defined over routine-home-care DAYS (8: SN minutes on them ÷ the days;
   * 9: the weekend share of those minutes), and both need those days joined to per-day skilled-nursing
   * minutes M8 holds — so the day sets cannot be reduced to counts on either side of the module boundary. Spans (not day lists) keep the
   * payload proportional to LOC CHANGES rather than to census × 365.
   *
   * Admission-linked within one org, like the death census {@link DeathDischargeReader} returns: no patient
   * identifier, no diagnosis, no narrative. The admission id is the join key M30 needs to intersect these
   * spans with M8's per-admission day totals, and nothing else crosses.
   */
  levelOfCareDaySpans(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<ReadonlyArray<LevelOfCareDaySpan>>;

  /**
   * M30 HCI indicator 2 — every election period overlapping `[period.from, period.to)`, CLIPPED to it.
   * The indicator counts elections containing a skilled-nursing visit GAP longer than the CMS interval,
   * which is a within-election sequence question: the span bounds are what makes the leading and trailing
   * gaps (election start → first SN visit, last SN visit → election end) measurable at all.
   */
  electionPeriodSpans(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<ReadonlyArray<ElectionPeriodSpan>>;
}

/**
 * One level-of-care span, clipped to the requested window. `from` is INCLUSIVE and `to` is EXCLUSIVE, both
 * `YYYY-MM-DD` — the same half-open convention as {@link import("./quality").MeasurePeriod}, so the day
 * count is a plain date difference and a same-day span (`from === to`) is legitimately zero days.
 */
export interface LevelOfCareDaySpan {
  readonly admissionId: AdmissionId;
  /** The `level_of_care` enum value (`routine_home_care` | `continuous_home_care` | …). */
  readonly levelOfCare: string;
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** One election period, clipped to the requested window (half-open `[from, to)`, `YYYY-MM-DD`). */
export interface ElectionPeriodSpan {
  readonly admissionId: AdmissionId;
  readonly electionPeriodId: string;
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/**
 * M30 HCI indicators 3/4 (Early / Late Live Discharges) — an org-level aggregate over `discharge_event`
 * (ALL discharge types, unlike {@link DeathDischargeReader}'s death-only census) joined to `admission` for
 * the days-since-admission classification. Same self-scoping / aggregate-only posture as the readers above.
 */
export interface DischargeReader {
  /**
   * All discharges (live + death) with `effectiveAt` in `[period.from, period.to)` (denominator), and,
   * among the LIVE ones (`dischargeType !== 'death'`), how many were "early" (CMS: on or before day 7 since
   * admission) vs. "late" (CMS: on or after day 180 since admission).
   */
  liveDischargeTimingCounts(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{
    readonly totalDischarges: number;
    readonly earlyLiveDischarges: number;
    readonly lateLiveDischarges: number;
  }>;
}

/** One admission-onset row for M30's `opioid_on_admission_rate` denominator (§4.11-style). */
export interface AdmissionOnsetRow {
  readonly admissionId: string;
  /** ISO instant — the anchor M30's resolver windows an opioid medication-order check around. */
  readonly admissionAt: string;
}

/**
 * M30 `opioid_on_admission_rate` denominator — admissions whose `admissionAt` falls in a reporting
 * window. Same self-scoping / aggregate-only posture as {@link DeathDischargeReader}: the M30 resolver
 * combines this LIST with M12's EXISTING per-admission `MedicationOrderProvider.listForAdmission` read
 * (the HVLDL/HCI-10 precedent — a per-item loop over an M6 list calling into a SIBLING module's
 * per-entity read, never a bulk cross-module join), so no new M12 seam surface is needed.
 */
export interface AdmissionOnsetReader {
  listAdmissionsStartedInPeriod(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<ReadonlyArray<AdmissionOnsetRow>>;
}
