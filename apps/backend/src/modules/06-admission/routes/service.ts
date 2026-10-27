// apps/backend/src/modules/06-admission/routes/service.ts — M6-T06 the AdmissionRouteService + an
// in-memory slice (§4.1–4.2). The route handlers compose over this; production injects a Drizzle-
// backed service (writes under withOrgContext so RLS scopes by app.org_id). The slice also exposes
// an AdmissionAbacResolver over the SAME dataset so M6's §4.6 ABAC predicates resolve a resource's
// owner facts (patient / signer ids) without a cross-module schema import. Pure-ish: no clock except
// the injected `now()` so version/date math is deterministic in tests.

import { localDateInTimeZone } from "@chartwarden/shared/dates";
import type { AdmissionSourceCode, AdmissionTypeCode, LocalDate } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import type { ActorSite } from "../actor-site";
import {
  DEFAULT_ORG_TIME_ZONE,
  computeF2fWindow,
  computeWrittenCertDeadline,
  decideRecertSign,
  isF2fScheduledWithinWindow,
} from "../certification";
import {
  type DischargeReason,
  type TransferInInput,
  checkDischargeNarrative,
  checkPlaceOfDeath,
  decideBereavementEligibility,
  dischargeRequiresCosign,
  fileForCauseDischarge,
  issueDetails,
  planTransferIn,
  resolveForCauseDischarge,
  resolvePlaceOfDeath,
  transferInPeriodConflict,
} from "../discharge";
import {
  type ActivationGap,
  type ActivationGate,
  type AdmissionReadinessFacts,
  type AdmissionReadinessResult,
  type AdmissionRequirementEvidence,
  computeActivationGate,
  evaluateAdmissionReadiness,
} from "../intake";
export type { AdmissionReadinessResult } from "../intake";
import { resolveF2fPerformerRole } from "../certification/f2f-performer";
import { addCalendarDays } from "../certification/window-math";
import {
  CTI_STATUS_RANK,
  ELECTION_STATEMENT_STATUS_RANK,
  F2F_STATUS_RANK,
  pickOnePerPeriod,
} from "../election-cert-picks";
import {
  type BenefitPeriodEntry,
  assertBenefitPeriodEntry,
  assertF2fExceptionReason,
} from "../intake/benefit-period";
import {
  type PhysicianAuthorityPort,
  type PhysicianSignerCandidate,
  type PhysicianSignerCapacity,
  dischargeOrderRequired,
  heldSignerCapacities,
} from "../physician-authority";
import {
  type AdmissionRecommendationInput,
  type DischargeOrderInput,
  resolveCosignerCapacity,
  validateAdmissionRecommendation,
  validateDischargeOrder,
} from "../physician-signer-checks";
import {
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
} from "../state-machines/election-period";
import { AdmissionStateError, ELECTION_STATEMENT_CONFLICT_MESSAGE } from "../state-machines/errors";
import type {
  F2fEncounterLocation,
  TelehealthEligibilityAttestation,
} from "../state-machines/f2f-attestation-rules";
import { transitionFaceToFace } from "../state-machines/face-to-face";
import { TEXT_MINIMUMS, daysBetween } from "../state-machines/validation";

/** 409 VERSION_MISMATCH — an optimistic-lock failure on a state-change route (§4 intro). */
export class VersionMismatchError extends ChartWardenError {
  constructor(id: string, current: number, attempted: number) {
    super(
      "VERSION_MISMATCH",
      `stale write on ${id} (current v${current}, sent v${attempted})`,
      409,
    );
  }
}

/** 404 NOT_FOUND — the resource is absent or cross-tenant (§6.6 non-leak). */
export class ResourceNotFoundError extends ChartWardenError {
  constructor(id: string) {
    super("NOT_FOUND", `${id} not found`, 404);
  }
}

/** 409 EXTERNAL_REFERRAL_ALREADY_INGESTED — re-ingest of a known `externalReferralId` (W-RF-02). */
export class ExternalReferralAlreadyIngestedError extends ChartWardenError {
  constructor(externalReferralId: string) {
    super(
      "EXTERNAL_REFERRAL_ALREADY_INGESTED",
      `external referral ${externalReferralId} was already ingested`,
      409,
    );
  }
}

/** 409 INVALID_STATE — a referral transition attempted from the wrong state (§4.2.1 / W-RF-03). */
export class InvalidReferralStateError extends ChartWardenError {
  constructor(id: string, state: string, action: string) {
    super("INVALID_STATE", `referral ${id} cannot ${action} from state '${state}'`, 409);
  }
}

/** 409 INELIGIBLE_NOT_TRIAGED — accept attempted on a referral that is not yet `triaged` (§4.2.1). */
export class ReferralNotTriagedError extends ChartWardenError {
  constructor(id: string) {
    super(
      "INELIGIBLE_NOT_TRIAGED",
      `referral ${id} must be triaged before it can be accepted`,
      409,
    );
  }
}

export class ReferralNotReadyError extends ChartWardenError {
  constructor(public readonly blockers: readonly { code: string; message: string }[]) {
    super(
      "REFERRAL_NOT_READY",
      "referral is not ready to qualify",
      422,
      blockers.map((b) => ({
        field: "referral",
        code: b.code,
        message: b.message,
      })),
    );
  }
}

export class ReferralAlreadyConvertedError extends ChartWardenError {
  constructor(id: string) {
    super("REFERRAL_ALREADY_CONVERTED", `referral ${id} has already produced an admission`, 409);
  }
}

export class ReferralAdmissionPathError extends ChartWardenError {
  constructor() {
    super(
      "REFERRAL_CONVERSION_REQUIRED",
      "direct admission with referralId is not supported; use the referral conversion endpoint",
      409,
    );
  }
}

export class LocationProviderMismatchError extends ChartWardenError {
  constructor(locationId: string, providerEntityId: string) {
    super(
      "LOCATION_PROVIDER_MISMATCH",
      `location ${locationId} does not belong to provider entity ${providerEntityId}`,
      422,
      [
        {
          field: "locationId",
          code: "provider_entity_mismatch",
          message: "Selected location must belong to the selected provider entity.",
        },
      ],
    );
  }
}

/**
 * 422 F2F_OUTSIDE_WINDOW — a scheduled F2F date falls outside the CMS 418.22 prior-to window
 * `[period_start − 30, period_start]` (§7.4 W-F2F-01). The window is server-computed in org TZ.
 */
export class F2fScheduleOutOfWindowError extends ChartWardenError {
  constructor(scheduledDate: string, windowStart: string, windowEnd: string) {
    super(
      "F2F_OUTSIDE_WINDOW",
      `F2F date ${scheduledDate} is outside the recert window [${windowStart}, ${windowEnd}]`,
      422,
    );
  }
}

/**
 * 412 PRECONDITION_FAILED — the R-AC-01 activation gate is not satisfied (§4.2.2 / §7.2 W-AD-05). The
 * unmet gate codes ride in the envelope `details` (one entry per gap) so the §5.2.5 checklist can
 * re-render against server truth without a bespoke field on the envelope.
 */
export class ActivationPreconditionError extends ChartWardenError {
  constructor(
    public readonly missing: readonly ActivationGap[],
    public readonly requirements?: AdmissionReadinessResult["requirements"],
  ) {
    super(
      requirements ? "ADMISSION_NOT_READY" : "PRECONDITION_FAILED",
      requirements
        ? "Admission requirements are incomplete."
        : `admission activation blocked; missing: ${missing.join(", ")}`,
      412,
      requirements
        ? requirements
            .filter((r) => r.blocking && r.status !== "complete")
            .map((r) => ({
              field: r.code,
              code: r.status,
              message: r.message ?? `${r.label} is incomplete.`,
            }))
        : missing.map((gap) => ({
            field: gap,
            code: "PRECONDITION_FAILED",
            message: `${gap} required`,
          })),
    );
  }
}

/** A minimal mutation result every state-change route returns (§4.2 `{ id, state, version }`). */
export interface MutationResult {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}

/** The org-scoped owner facts M6's §4.6 ABAC predicates evaluate against (never client input). */
export interface ReferralFacts {
  readonly locationId: string | null;
  readonly providerEntityId: string | null;
}
export interface AdmissionFacts {
  readonly patientId: string;
  readonly providerEntityId: string | null;
  /** The stay's service location (`admission_clinical_site_scope`'s fallback site); optional for child-keyed loaders. */
  readonly locationId?: string | null;
  /** Who opened it through POST /admissions (`admission.scope`'s creator arm for an unsited admission, §6.8). */
  readonly createdByUserId?: string | null;
}
export interface CtiFacts {
  readonly hospiceMedicalDirectorId: string;
  readonly attendingPhysicianId: string | null;
}
export interface F2fFacts {
  readonly scheduledClinicianId: string;
}
export interface ComplianceWindowFacts {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId?: string | null;
  readonly createdByUserId?: string | null;
}
/** `admission_intake_scope` — the facts about a patient of the caller's org that decide intake reach. */
export interface PatientIntakeFacts {
  /** The patient has an admission in `active` or `on_hold` — an ongoing stay, not intake's business. */
  readonly hasActiveOrOnHoldAdmission: boolean;
  /** The patient has ANY admission in this org (`admission_clinical_site_scope`: a never-admitted patient has no site). */
  readonly hasAnyAdmission: boolean;
  /** The chart's site (M5 stamps it from the activated admission); null until a stay of theirs is activated. */
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  /**
   * The site of the patient's latest referral that names one — how a never-admitted (never-sited) patient is placed at
   * a site (`admission_clinical_site_scope`, §6.8). Null when no referral names a site.
   */
  readonly referralProviderEntityId: string | null;
  readonly referralLocationId: string | null;
}

/**
 * The read-side resolver M6's ABAC predicates (§4.6) load a resource's owner facts through. Every
 * method is org-scoped (RLS backstops in prod) and returns `null` when the resource is absent /
 * cross-tenant — the predicate then fails closed. Kept separate from the write service so a predicate
 * never reaches a mutation method.
 */
export interface AdmissionAbacResolver {
  loadReferral(organizationId: string, id: string): Promise<ReferralFacts | null>;
  loadAdmission(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadCti(organizationId: string, id: string): Promise<CtiFacts | null>;
  loadF2f(organizationId: string, id: string): Promise<F2fFacts | null>;
  loadComplianceWindow(organizationId: string, id: string): Promise<ComplianceWindowFacts | null>;
  // GAP-011 (§4.6 `admission.scope`) — the six resource kinds `admission.scope` is asked to scope
  // that are NOT keyed by an admission id directly: each resolves the admission the resource belongs
  // to (election_period/level_of_care_period carry `admission_id` directly; election_statement/CTI/
  // face_to_face carry it only via `election_period_id`, a two-hop join) and returns the SAME
  // `AdmissionFacts` shape `loadAdmission` does, so `admission.scope`'s one predicate body stays
  // resource-agnostic once it has the right loader.
  loadElectionPeriodScope(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadElectionStatementScope(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadCtiScope(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadF2fScope(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadLocScope(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  /**
   * `admission_intake_scope` — is `patientId` a patient of `organizationId`, and does it have an active / on-hold
   * admission? `null` when the patient is absent or another org's (the predicate then fails closed).
   */
  loadPatientIntakeFacts(
    organizationId: string,
    patientId: string,
  ): Promise<PatientIntakeFacts | null>;
  /** 42 CFR 418.26(b) — the facts the route-40 cosign predicate judges the signer against. */
  loadDischargeSigning(organizationId: string, id: string): Promise<DischargeSigningFacts | null>;
}

/** A discharge's signing facts: whose chart, which date's signer set, and whether it is an external death. */
export interface DischargeSigningFacts {
  readonly patientId: string | null;
  readonly dischargeDate: string;
  readonly externalDeath: boolean;
}

/** The capture contracts the routes hand the service (§4.2; abbreviated to the load-bearing fields). */
export interface ReferralCreateInput {
  readonly source: string;
  readonly receivedAt: string;
  readonly receivingUserId?: string;
  readonly patientId?: string;
  readonly patientNameAtReceipt: string;
  readonly patientDobAtReceipt?: string;
  readonly medicareNumberAtReceipt?: string;
  readonly medicaidNumberAtReceipt?: string;
  readonly sexAssignedAtBirth?: "F" | "M" | "O" | "U";
  readonly referringDxText?: string;
  readonly referrerName?: string;
  readonly referrerOrganization?: string;
  readonly referrerPhone?: string;
  readonly externalReferralId?: string;
}
/**
 * The first benefit period a NEW admission elects into (intake/benefit-period.ts). Absent = our own history's
 * suggestion, recorded as `internal_history` (1 for a patient we never served — the pre-readmission behaviour).
 */
export interface FirstBenefitPeriodInput {
  readonly benefitPeriod?: BenefitPeriodEntry;
  /** Period 3+ only: the documented exceptional circumstance (MBPM ch. 9 §20.1(5)(d)). */
  readonly f2fException?: { readonly reason: string };
  /** The planned admission / election date (`YYYY-MM-DD`); anchors the F2F window of a period-3+ admission. */
  readonly admissionDate?: string;
}
export interface AdmissionCreateInput extends FirstBenefitPeriodInput {
  readonly patientId: string;
  readonly referralId?: string;
  readonly intakeMethod: string;
  readonly attendingPhysicianId?: string;
  readonly hospiceMedicalDirectorId: string;
  /** UB-04 FL 14 / FL 15 (837I CL101 / CL102); optional at creation, completed on update before a claim. */
  readonly admissionTypeCode?: AdmissionTypeCode;
  readonly admissionSourceCode?: AdmissionSourceCode;
  /** A readmission: the patient's earlier, live-discharged admission this one follows. */
  readonly readmittedFromAdmissionId?: string;
}
export interface AdmissionUpdateInput {
  readonly admissionAt?: string;
  readonly hospicePhysicianId?: string | null;
  readonly attendingPhysicianId?: string;
  readonly providerEntityId?: string | null;
  readonly locationId?: string | null;
  /** `null` clears a mis-recorded value. */
  readonly admissionTypeCode?: AdmissionTypeCode | null;
  readonly admissionSourceCode?: AdmissionSourceCode | null;
}
export interface UploadedNoticeOfRightsInput {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedByName?: string;
  readonly acknowledgedByRole?: "patient" | "legal_representative" | "caregiver";
}
export interface UploadedElectionInput {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentState: "unsigned" | "signed";
  readonly signerName?: string;
  readonly signerRole?: "patient" | "legal_representative" | "caregiver";
  readonly signedAt?: string;
}
export interface UploadedCtiInput {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentState: "unsigned" | "signed";
  readonly signedAt?: string;
}
/** §4.2.1 accept body — links/creates the M5 patient and supplies the primary dx (W-RF-04). */
export interface AcceptReferralInput extends FirstBenefitPeriodInput {
  readonly patientId?: string;
  readonly primaryDiagnosisIcd10: string;
  readonly attendingPhysicianId?: string;
}

export interface ReferralUpdateInput {
  readonly medicareNumberAtReceipt?: string;
  readonly medicaidNumberAtReceipt?: string;
  readonly referringDxText?: string;
  readonly referrerName?: string;
  readonly referrerOrganization?: string;
  readonly referrerPhone?: string;
  readonly sexAssignedAtBirth?: "F" | "M" | "O" | "U";
}

export interface ReferralNoteInput {
  readonly content: string;
}

export interface ReferralNoteView {
  readonly id: string;
  readonly referralId: string;
  readonly authorId: string | null;
  /** Server-resolved in-org author name on reads (no email); absent when unresolved or system-authored. */
  readonly authorDisplayName?: string | null;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReferralActivityView {
  readonly id: string;
  readonly referralId: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ReferralReadView extends SummaryRow {
  readonly status: string;
  readonly patientId: string | null;
  readonly patientResolutionStatus: string;
  readonly patientNameAtReceipt: string;
  readonly patientDobAtReceipt: string | null;
  readonly medicareNumberAtReceipt: string | null;
  readonly medicaidNumberAtReceipt: string | null;
  readonly sexAssignedAtBirth: string | null;
  readonly referringDxText: string | null;
  readonly icd10TerminalPrimary: string | null;
  readonly source: string;
  readonly referrerName: string | null;
  readonly referrerOrganization: string | null;
  readonly referrerPhone: string | null;
  readonly externalReferralId: string | null;
  readonly priority: string;
  readonly assignedToUserId: string | null;
  /** Server-resolved in-org display name of `assignedToUserId` (name only, never email); absent when unassigned
   *  or when the membership no longer resolves — the client then shows a neutral "Staff member". */
  readonly assignedToDisplayName?: string | null;
  readonly receivedAt: string;
  readonly reviewedAt: string | null;
  readonly qualifiedAt: string | null;
  readonly declinedAt: string | null;
  readonly convertedAt: string | null;
  readonly convertedAdmissionId: string | null;
  readonly rejectionReason: string | null;
  readonly qualificationBlockers: readonly { code: string; message: string }[];
}
/**
 * Route 25 body beyond `ifVersion`. `narrative` is the signing physician's § 418.22(b)(3) narrative, taken at
 * signature when the draft has none (a transfer-in drafts our CTI without one) or replaces the draft's.
 */
export interface CtiSignInput {
  readonly narrative?: string;
}
export interface CtiDraftInput {
  readonly electionPeriodId: string;
  readonly hospiceMedicalDirectorId: string;
  readonly attendingPhysicianId?: string;
  readonly terminalDiagnosisIcd10: string;
  readonly secondaryDiagnoses?: readonly string[];
  readonly prognosisStatement: string;
  readonly narrative: string;
  readonly clinicalFindings: Record<string, unknown>;
  readonly isRecert: boolean;
}
/**
 * §4.2.2 route 41 body (NorAcknowledgeSchema), narrowed to the two fields the
 * `notice_of_rights_acknowledgment` table can actually store (`acknowledgment_method`/`signer_kind`).
 * `formVersionId`/`acknowledgedByName` are validated by the route but have no column to land in today —
 * TASK-034 fixes the ones that do rather than widening this type to fields that would still be dropped.
 */
export interface NorAcknowledgeInput {
  readonly deliveryMethod: "wet_ink_scanned" | "electronic_witnessed" | "verbal_with_witness";
  readonly acknowledgedByRole: "patient" | "legal_representative";
  readonly acknowledgedAt?: string;
  readonly acknowledgedByName?: string;
}
/**
 * GAP-022 — who is scheduling. `user` = a human session: the performer role is DERIVED from the
 * scheduled clinician's real role grants. `system` is the one explicit, frozen marker for trusted
 * non-request callers (workers / fixtures) whose `clinicianRole` is already server-decided; it is never
 * built from request data and never inferred from a role string (cf. 11-orders SYSTEM_ORDER_ACTOR).
 */
export type F2fScheduleActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "system" };
export const SYSTEM_F2F_ACTOR: F2fScheduleActor = Object.freeze({ kind: "system" as const });

export interface F2fScheduleInput {
  readonly admissionId: string;
  readonly electionPeriodId: string;
  readonly scheduledClinicianId: string;
  /** A CLAIM only (the request body's value): for a `user` actor it must be backed by the clinician's grants. */
  readonly clinicianRole?: string;
  readonly actor: F2fScheduleActor;
  /** Org-local F2F date (§7.4 W-F2F-01) — validated against the server-computed recert window. */
  readonly scheduledDate?: LocalDate;
  readonly windowStart?: LocalDate;
  readonly windowEnd?: LocalDate;
}
export interface DischargeInput {
  readonly reason: DischargeReason;
  readonly dischargeDate: string;
  readonly narrative: string;
  readonly forCauseReason?: string;
  /** R-DC-01 — required when `reason === 'death'` (`checkDischargeNarrative` enforces it). */
  readonly deathCertifierId?: string;
  /** Required when `reason === 'death'` (`checkPlaceOfDeath`); claim patient status 40/41/42. An external
   *  (HL7) death that cannot know it records `unknown`. */
  readonly placeOfDeath?: "home" | "facility" | "unknown";
  /**
   * F-227 (#248) — set ONLY by the M29 proposal applier (`recordExternalDeath`, W-M6-31): the death was
   * reported by an external facility, so R-DC-01's pronouncing-certifier capture does not apply at intake
   * (M6 §4.8.4's recordExternalDeath inserts directly) and the row is stamped `hl7_external` +
   * `cosign_required` with the M29 proposal it came from. Never reachable from the HTTP route body.
   */
  readonly externalSource?: { readonly proposalId: string };
  /** 42 CFR 418.26(b) — the written physician discharge order (required for live discharges from 2026-10-01). */
  readonly dischargeOrder?: DischargeOrderInput;
}

/** §4.2.7 route 37 body (TransferOutSchema) — the receiving hospice's identity + the transfer narrative. */
export interface TransferOutInput {
  readonly effectiveDate: string;
  readonly otherHospiceName: string;
  readonly otherHospiceCcn?: string;
  /** Where the receiving hospice cares for the patient — claim patient status 50 (home) / 51 (facility). */
  readonly receivingCareSetting: "home" | "facility";
  readonly narrative: string;
}

/** §4.2.7 route 36 body (RevocationCreateSchema) — the patient-initiated hospice election revocation. */
export interface RevocationInput {
  readonly revocationDate: string;
  readonly narrative: string;
  /**
   * Validated at the route but has no `revocation_event` column to land in today (same posture as
   * `NorAcknowledgeInput`'s dropped fields, TASK-034) — the rendered revocation form (M22, via
   * `revocation_event.document_id`) is the durable record of the signer's name, not this table.
   */
  readonly signingPatientName: string;
  readonly signingRole: "patient" | "legal_representative";
  readonly revocationReason:
    | "seek_curative_treatment"
    | "dissatisfaction"
    | "transferred_out"
    | "other";
}

/** The discharge outcome the route returns (§4.2 — `requiresMedicalDirectorCosign` drives route 40). */
export interface DischargeResult extends MutationResult {
  readonly requiresMedicalDirectorCosign: boolean;
  readonly reason: DischargeReason;
}

/**
 * §4.2.7 route 40 body (DischargeCosignSchema) — the cosigning physician's identity on a for-cause cosign.
 * Since migration 0388 the name/NPI are PERSISTED on `discharge_event` (`cosigner_name`/`cosigner_npi`;
 * they used to be validated then discarded), and the cosign is recorded as the 42 CFR 418.26(b) discharge
 * order: the signer is the actor, judged on `actorRoleKeys` — the SERVER-derived `request.context.roles`,
 * never a body field — plus the IDG care-team fact. `capacity` is an optional claim that must be backed.
 */
/** GAP-121 — body of the for-cause decline route. */
export interface DeclineDischargeInput {
  readonly declineReason: string;
}

export interface CosignDischargeInput {
  readonly cosignerName: string;
  readonly cosignerNpi: string;
  readonly actorRoleKeys?: readonly string[];
  readonly capacity?: PhysicianSignerCapacity;
  readonly orderText?: string;
  readonly orderReference?: string;
}

/** 42 CFR 418.26(b) — the discharge order + route-40 cosigner on an admission's discharge (read view). */
export interface DischargeOrderView {
  readonly dischargeEventId: string;
  readonly reason: string;
  readonly status: string;
  readonly dischargeDate: string;
  /** True when 418.26(b) required an order for this discharge (live, non-death, dated on/after 2026-10-01). */
  readonly orderRequired: boolean;
  readonly order: {
    readonly signedByUserId: string;
    readonly signedByName: string | null;
    readonly capacity: PhysicianSignerCapacity;
    readonly signedAt: string;
    readonly orderText: string | null;
    readonly orderReference: string | null;
  } | null;
  readonly cosigner: {
    readonly name: string;
    readonly npi: string;
    readonly cosignedAt: string | null;
  } | null;
}

/** A pending event's own concurrency token; never substitute admission.version. */
export interface DischargeCosignContext {
  readonly dischargeEventId: string;
  readonly admissionId: string;
  readonly status: "pending_cosign";
  readonly dischargeEventVersion: number;
  readonly dischargeDate: string;
}

/** 42 CFR 418.25(a) — the recorded physician admission recommendation (route 10 projection). */
export interface AdmissionRecommendationView {
  readonly recommendedByUserId: string;
  readonly capacity: PhysicianSignerCapacity;
  readonly recommendedAt: string;
  readonly attendingConsulted: boolean;
  readonly attendingConsultNote: string | null;
}

/** A cursor-paginated page (§4: `?cursor=&limit=` → `{ items, nextCursor }`). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** A summary row for the list routes (state + version + the resource's create instant). */
export interface SummaryRow {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly patientId?: string | null;
}

/** A compliance-window worklist row: the summary plus what the window IS and when it is due (FY2027 — so the
 *  compliance dashboard can show the election-addendum kinds). The DB service fills the extras. */
export interface ComplianceWindowRow extends SummaryRow {
  readonly admissionId?: string;
  readonly windowKind?: string;
  readonly severity?: string;
  readonly dueAt?: string;
}

/** Only the identity needed by an admission list or context header. */
export interface AdmissionPatientIdentity {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
}

/** F-195 (#248) — `GET /api/v1/admissions`'s own row, carrying the hold/resume facts M6's spec (line 2983)
 *  names as surfaced on "M30's operational dashboard" — `holdReason`/`holdAt`/`releasedAt` were write-only
 *  everywhere in this module until now (see `events-by-m6.ts`'s corrected `m30` declaration on
 *  `m6.admission.on_hold`/`.resumed` for the full citation). A dedicated type rather than widening the
 *  shared `SummaryRow` (also used by referral summaries, which have no hold concept at all). */
export interface AdmissionSummary extends SummaryRow {
  readonly patient: AdmissionPatientIdentity | null;
  readonly holdReason: string | null;
  readonly holdAt: string | null;
  readonly releasedAt: string | null;
}

/** One of a patient's admissions (F-065) — enough to pick the one being documented against. */
export interface PatientAdmissionSummary {
  readonly id: string;
  readonly state: string;
  readonly admissionAt: string | null;
  readonly dischargedAt: string | null;
}

/** The admission aggregate (route 10) — summary + the R-AC-01 activation gate (§7.2 / §5.2.5). */
export interface AdmissionDetail extends SummaryRow {
  readonly patient: AdmissionPatientIdentity | null;
  readonly patientId?: string;
  readonly referralId?: string | null;
  /** Existing nullable self-FK; null for direct intake and unknown historical episodes. */
  readonly readmittedFromAdmissionId?: string | null;
  readonly admissionAt?: string | null;
  readonly activatedAt?: string | null;
  readonly providerEntityId?: string | null;
  readonly locationId?: string | null;
  readonly patientResidenceAddressId?: string | null;
  readonly serviceAddressSnapshot?: {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly state: string | null;
    readonly postalCode: string;
    readonly country: string;
  } | null;
  readonly hospicePhysicianId?: string | null;
  readonly hospicePhysician?: {
    readonly id: string;
    readonly displayName: string;
    readonly npi?: string | null;
  } | null;
  readonly primaryDiagnosisIcd10?: string | null;
  readonly referringDxText?: string | null;
  readonly admissionRecommendation?: AdmissionRecommendationView | null;
  /** M40 attending physician id (418.25(a): "in consultation with … the attending physician (if any)"). */
  readonly attendingPhysicianId?: string | null;
  /** UB-04 FL 14 Type of Admission (837I CL101); null until recorded. */
  readonly admissionTypeCode?: string | null;
  /** UB-04 FL 15 Point of Origin (837I CL102); null until recorded. */
  readonly admissionSourceCode?: string | null;
  readonly activationGate: ActivationGate;
  readonly readiness?: AdmissionReadinessResult;
}

/**
 * The patient-scoped Election & Certification aggregate — the read that backs the patient-chart
 * "Election & Certification" tab (§5.2/§5.3). Resolves the patient's current admission, then its
 * benefit-period ladder with each period's election statement / CTI / F2F recert bundle, plus the
 * admission's compliance windows. `admission` is `null` (with empty ladders) when the patient has no
 * admission yet — a truthful empty, never a 404. All fields are read-only projections (no PHI narrative);
 * SUD/consent gating is not applicable here (election/cert metadata is not Part-2 content).
 */
export interface PatientElectionCertificationView {
  readonly admission: {
    readonly id: string;
    readonly state: string;
    readonly admissionAt: string | null;
    readonly activatedAt: string | null;
    readonly dischargedAt: string | null;
    readonly version: number;
  } | null;
  readonly periods: readonly {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly periodKind: string;
    readonly effectiveAt: string | null;
    readonly scheduledEndAt: string | null;
    readonly actualEndAt: string | null;
    readonly status: string;
    readonly electionStatement: {
      readonly id: string;
      readonly status: string;
      readonly signerKind: string;
      readonly signedAt: string | null;
      readonly sourceType: "structured" | "uploaded";
    } | null;
    readonly cti: {
      readonly id: string;
      readonly status: string;
      readonly sourceType: "structured" | "uploaded";
      readonly hospiceMdSigned: boolean;
      readonly attendingMdSigned: boolean;
      readonly signedLate: boolean;
      readonly periodStart: string | null;
      readonly periodEnd: string | null;
    } | null;
    readonly faceToFace: {
      readonly id: string;
      readonly status: string;
      readonly performerRole: string;
      readonly encounterDate: string | null;
      readonly withinWindow: boolean | null;
      readonly windowOverride: boolean;
      readonly attested: boolean;
    } | null;
  }[];
  readonly complianceWindows: readonly {
    readonly id: string;
    readonly windowKind: string;
    readonly severity: string;
    readonly status: string;
    readonly mustCompleteBy: string;
    readonly closedAt: string | null;
  }[];
}

/**
 * The §4.1 route surface. One method per state-change / read route; org binding is server-side
 * (`organizationId` is the request context, never the body). `actorUserId` is the staff member
 * capturing the action (D-AUTHZ-01: patient-side signatures are evidence on the row, not identities).
 */
/**
 * The §418.24 election-statement content the draft route accepts (#44).
 *
 * Every field here used to be validated by `ElectionStatementDraftSchema` and then dropped: the
 * handler passed `electionPeriodId` and nothing else, so `election_statement.provider_entity_id`,
 * `attending_physician_id`, `curative_care_acknowledgment` and `state_addendum` were NULL on every
 * row ever written, and `admission.provider_entity_id` — which `AdmissionStatusReader` requires
 * non-null — was never sited by ANY code path, breaking that seam for every admission in every org.
 */
export interface ElectionStatementDraftInput {
  readonly effectiveDate?: LocalDate;
  readonly primaryDiagnosisIcd10?: string;
  /** The hospice the patient elects (§418.24(b)) — also sites `admission.provider_entity_id`. */
  readonly electedProviderEntityId: string;
  /** The attending physician the patient designates; absent when they name none. */
  readonly electedAttendingPhysicianId?: string;
  /** The patient's acknowledgment that curative treatment for the terminal condition is waived. */
  readonly waiverAcknowledged: boolean;
  /** Free-text state addendum, stored under `state_addendum.text` (the column defaults to `{}`). */
  readonly stateAddendum?: string;
}

/** Who signed the election statement, and under what name (§418.24(b)(1)). */
/**
 * The wire vocabulary and the column vocabulary differ: `ElectionSignSchema` says
 * `legal_representative`, the `election_signer_kind` enum says `representative`. Mapping explicitly
 * beats widening either one — the API contract is published and the enum is in the database.
 */
export const SIGNER_KIND_BY_ROLE = {
  patient: "patient",
  legal_representative: "representative",
  // The sign request also accepts `caregiver` (the admission UI offers it). The enum has no caregiver
  // value, and a non-patient signer is a representative for §418.24(b)(1) purposes — so it is recorded
  // as one, which also routes it through the R-EL-01 DPOA-authority guard rather than around it.
  caregiver: "representative",
} as const satisfies Record<string, "patient" | "representative">;

export interface ElectionSignInput {
  readonly signingPatientName: string;
  readonly signingRole: "patient" | "legal_representative" | "caregiver";
}

/**
 * GAP-020 — the caseload narrowing the org-wide admission list applies. `undefined` / `patientIds: null`
 * means org-wide (an org-wide scope role); an array restricts rows to those patients (empty = none).
 */
export interface AdmissionReadScope {
  readonly patientIds: readonly string[] | null;
  /**
   * The Readmit list only (discharge worklist `recently_discharged`): rows whose ADMISSION is at one of these sites are
   * ALSO in scope (OR'd with `patientIds`; ignored when `patientIds` is null). Same site test as M6's
   * `admission_clinical_site_scope`: the location decides when both the row and the caller know one, else the
   * provider entity.
   */
  readonly sites?: {
    readonly providerEntityIds: readonly string[];
    readonly locationIds: readonly string[];
  };
}

/** R-F2F-05 — what the clinician records about HOW the face-to-face took place. */
export interface F2fCompletionModality {
  readonly encounterLocation: F2fEncounterLocation;
  /** The § 418.22(a)(4)(ii)(A)–(C) attestation; required for telehealth from 2026-01-31. */
  readonly telehealthEligibility: TelehealthEligibilityAttestation | null;
}

export interface AdmissionRouteService {
  // Referral (routes 1–7)
  createReferral(
    organizationId: string,
    input: ReferralCreateInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  listReferrals(
    organizationId: string,
    query: {
      status?: string;
      state?: string;
      source?: string;
      patientResolutionStatus?: string;
      priority?: string;
      assigned?: "mine" | "unassigned";
      includeConverted?: boolean;
      q?: string;
      cursor?: string;
      limit?: number;
    },
    actorUserId?: string,
    /**
     * GAP-182 — the SAME location scope `referral.scope` applies to a single referral, applied to the list:
     * a location-restricted caller sees referrals with no location (the documented org-level steady state)
     * or one of THEIR locations. Absent = org-wide (the caller carries no location restriction).
     */
    scope?: { readonly locationIds: readonly string[] },
  ): Promise<Page<ReferralReadView>>;
  getReferral(organizationId: string, id: string): Promise<ReferralReadView | null>;
  updateReferral(
    organizationId: string,
    id: string,
    input: ReferralUpdateInput,
    ifVersion: number,
  ): Promise<MutationResult>;
  triageReferral(
    organizationId: string,
    id: string,
    outcome: "eligible" | "ineligible",
    ifVersion: number,
  ): Promise<MutationResult>;
  acceptReferral(
    organizationId: string,
    id: string,
    input: AcceptReferralInput,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult & { admissionId: string }>;
  startReferralReview(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  runReferralPatientMatching(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult & { candidates: readonly unknown[] }>;
  confirmReferralPatient(
    organizationId: string,
    id: string,
    patientId: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  createReferralPatient(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
    /** The creating actor's single default site (see `actor-site.ts`), stamped on the new patient; omit when unsited. */
    actorSite?: ActorSite,
  ): Promise<MutationResult & { patientId: string }>;
  qualifyReferral(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  convertReferral(
    organizationId: string,
    id: string,
    input: AcceptReferralInput,
    ifVersion: number,
    actorUserId: string,
    /** `emitAccepted` — the route-6 accept path also publishes `m6.referral.accepted` (GAP-177). */
    opts?: { readonly emitAccepted?: boolean },
  ): Promise<MutationResult & { admissionId: string }>;
  declineReferral(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  addReferralNote(
    organizationId: string,
    id: string,
    input: ReferralNoteInput,
    actorUserId: string,
  ): Promise<ReferralNoteView>;
  listReferralNotes(organizationId: string, id: string): Promise<readonly ReferralNoteView[]>;
  listReferralActivity(
    organizationId: string,
    id: string,
  ): Promise<readonly ReferralActivityView[]>;
  updateReferralPriority(
    organizationId: string,
    id: string,
    priority: "routine" | "high" | "urgent",
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  assignReferral(
    organizationId: string,
    id: string,
    assignedToUserId: string | undefined,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  markReferralPendingInformation(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  markReferralDuplicate(
    organizationId: string,
    id: string,
    reason: string | undefined,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  withdrawReferral(
    organizationId: string,
    id: string,
    reason: string | undefined,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  // Admission (routes 8–14)
  createAdmission(
    organizationId: string,
    input: AdmissionCreateInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  listAdmissions(
    organizationId: string,
    query: {
      state?: string;
      patientId?: string;
      cursor?: string;
      limit?: number;
    },
    scope?: AdmissionReadScope,
  ): Promise<Page<AdmissionSummary>>;
  getAdmission(organizationId: string, id: string): Promise<AdmissionDetail | null>;
  getAdmissionReadiness(
    organizationId: string,
    id: string,
  ): Promise<AdmissionReadinessResult | null>;
  /**
   * The patient's admissions, newest first (F-065).
   *
   * Every clinical CREATE in this platform is keyed by `admissionId` — a medication order, an
   * encounter, a care plan — and until this route nothing could answer "which admission am I
   * documenting against" for a given patient. `GET /api/v1/admissions` is an org-wide census that takes
   * no patient filter and whose items carry `{ id, state, version }` with no `patientId`, and
   * `GET /api/v1/patients/:id` carries no admission. So the id had to come from a row that already had
   * one — which is fine for acting on an existing record and impossible for creating the first one.
   *
   * The two workarounds in the tree say it plainly: M07's `screens.ts` declines to offer plan creation
   * because "a 'create care plan' button would need an admissionId this screen does not read", and
   * M24's claim-assembly wizard renders a raw text input for it — a billing clerk typing a uuid.
   *
   * Summary only (no PHI beyond the dates), so it needs no redaction; org-scoped by RLS and
   * patient-scoped by the filter, so a cross-tenant patient literal resolves nothing.
   */
  listPatientAdmissions(
    organizationId: string,
    patientId: string,
  ): Promise<readonly PatientAdmissionSummary[]>;
  /** Patient-scoped Election & Certification aggregate (patient-chart tab); empty admission when none. */
  getPatientElectionCertification(
    organizationId: string,
    patientId: string,
  ): Promise<PatientElectionCertificationView>;
  updateAdmission(
    organizationId: string,
    id: string,
    input: AdmissionUpdateInput,
    ifVersion: number,
  ): Promise<MutationResult>;
  attachUploadedNoticeOfRights(
    organizationId: string,
    admissionId: string,
    input: UploadedNoticeOfRightsInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  attachUploadedElectionStatement(
    organizationId: string,
    electionPeriodId: string,
    input: UploadedElectionInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  attachUploadedElectionSignature(
    organizationId: string,
    electionStatementId: string,
    input: UploadedElectionInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  attachUploadedCti(
    organizationId: string,
    electionPeriodId: string,
    input: UploadedCtiInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  holdAdmission(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  resumeAdmission(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  activateAdmission(
    organizationId: string,
    id: string,
    ifVersion: number,
    /** #50 — the service location this admission is served from. Required only when the elected
     * provider entity has more than one active location; derived when it has exactly one. */
    input?: { readonly locationId?: string },
  ): Promise<MutationResult>;
  // Election (routes 15–21)
  draftElectionStatement(
    organizationId: string,
    admissionId: string,
    electionPeriodId: string,
    input: ElectionStatementDraftInput,
  ): Promise<MutationResult>;
  getElectionStatement(organizationId: string, id: string): Promise<SummaryRow | null>;
  signElection(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
    input: ElectionSignInput,
  ): Promise<MutationResult>;
  voidElection(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  listElectionPeriods(
    organizationId: string,
    admissionId: string,
  ): Promise<readonly SummaryRow[] | null>;
  createElectionPeriod(organizationId: string, admissionId: string): Promise<MutationResult>;
  patchElectionPeriod(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  // CTI (routes 22–27)
  draftCti(
    organizationId: string,
    input: CtiDraftInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  getCti(organizationId: string, id: string): Promise<SummaryRow | null>;
  signCtiHospiceMd(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
    input?: CtiSignInput,
  ): Promise<MutationResult>;
  signCtiAttending(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  voidCti(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  markCtiLate(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult & { writtenCertDeadlineAt: string }>;
  // F2F (routes 28–32)
  scheduleF2f(organizationId: string, input: F2fScheduleInput): Promise<MutationResult>;
  getF2f(organizationId: string, id: string): Promise<SummaryRow | null>;
  /** F-226 - `encounterDate` (YYYY-MM-DD) is the clinician-reported encounter date; it is validated and the R-F2F-02 window is computed from it. */
  completeF2f(
    organizationId: string,
    id: string,
    ifVersion: number,
    encounterDate: string,
    /** R-F2F-05 — the encounter modality (the route requires it; omitted = not recorded). */
    modality?: F2fCompletionModality,
  ): Promise<MutationResult>;
  /**
   * GAP-022 - `attestationNarrative` (>= 100 chars, R-F2F-04) is persisted; the attester must be the
   * performer. R-F2F-06 — OR `signedNoteEncounterId` links an M8 note signed and dated by the performer on
   * the encounter date (§ 418.22(b)(4)); exactly one source is required.
   */
  attestF2f(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
    attestationNarrative: string | null,
    signedNoteEncounterId?: string | null,
  ): Promise<MutationResult>;
  overrideF2fWindow(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  // LOC (routes 33–35)
  changeLoc(
    organizationId: string,
    admissionId: string,
    newLevel: string,
    facilityId?: string | null,
    effectiveStart?: string,
    reason?: string,
  ): Promise<MutationResult>;
  listLoc(organizationId: string, admissionId: string): Promise<readonly SummaryRow[] | null>;
  patchLoc(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  /** The §2.3.5 confirm handshake (M6-T04 fix) — verifies a real M37 bed assignment, then
   *  `assigning` → `active`. ILLEGAL_TRANSITION if the period isn't `assigning`; IPU_FACILITY_REQUIRED
   *  if M37 has no active bed assignment for it yet. */
  confirmLocBedAssignment(
    organizationId: string,
    locPeriodId: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  // Revocation / transfer / discharge (routes 36–40)
  createRevocation(
    organizationId: string,
    admissionId: string,
    input: RevocationInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  transferOut(
    organizationId: string,
    admissionId: string,
    input: TransferOutInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  transferIn(
    organizationId: string,
    admissionId: string,
    input: TransferInInput,
    actorUserId: string,
  ): Promise<MutationResult & { currentElectionPeriodSequence: number }>;
  discharge(
    organizationId: string,
    admissionId: string,
    input: DischargeInput,
    actorUserId: string,
  ): Promise<DischargeResult>;
  cosignDischarge(
    organizationId: string,
    id: string,
    input: CosignDischargeInput,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  /** GAP-121 — decline a for-cause discharge awaiting cosign: voided, admission stays active. */
  declineDischarge(
    organizationId: string,
    id: string,
    input: DeclineDischargeInput,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  // 42 CFR 418.25(a) / 418.26(b) physician signer set
  recordAdmissionRecommendation(
    organizationId: string,
    admissionId: string,
    input: AdmissionRecommendationInput,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  /** The admission's discharge order + cosigner (`null` = unknown admission; `discharge: null` = none yet). */
  getDischargeOrder(
    organizationId: string,
    admissionId: string,
  ): Promise<{ readonly discharge: DischargeOrderView | null } | null>;
  /** Called only behind the same permission and signer ABAC as cosign/decline. */
  getDischargeCosignContext(
    organizationId: string,
    dischargeEventId: string,
    actorUserId: string,
  ): Promise<DischargeCosignContext | null>;
  /** The physicians who may sign for this admission's patient (`null` = unknown admission). */
  listPhysicianSigners(
    organizationId: string,
    admissionId: string,
  ): Promise<{ readonly items: readonly PhysicianSignerCandidate[] } | null>;
  // NOR (routes 41–42)
  acknowledgeNor(
    organizationId: string,
    admissionId: string,
    input: NorAcknowledgeInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  getNor(organizationId: string, admissionId: string): Promise<SummaryRow | null>;
  // Compliance windows (routes 43–46)
  listComplianceWindowsForAdmission(
    organizationId: string,
    admissionId: string,
  ): Promise<readonly ComplianceWindowRow[] | null>;
  listComplianceWindows(
    organizationId: string,
    query: { state?: string; cursor?: string; limit?: number },
    scope?: AdmissionReadScope,
  ): Promise<Page<ComplianceWindowRow>>;
  closeComplianceWindow(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  overrideComplianceWindow(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
}

// ── in-memory backend ────────────────────────────────────────────────────────────────────────────

interface Rec {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  state: string;
  version: number;
  // owner facts for ABAC (§4.6)
  patientId?: string;
  providerEntityId?: string | null;
  locationId?: string | null;
  createdByUserId?: string | null;
  patientResidenceAddressId?: string | null;
  admissionId?: string;
  admissionAt?: string | null;
  hospiceMedicalDirectorId?: string;
  attendingPhysicianId?: string | null;
  /** UB-04 FL 14 / FL 15 (837I CL101 / CL102) recorded on the admission. */
  admissionTypeCode?: string | null;
  admissionSourceCode?: string | null;
  terminalDiagnosisIcd10?: string;
  secondaryDiagnoses?: readonly string[];
  prognosisStatement?: string | null;
  clinicalFindings?: Record<string, unknown> | null;
  scheduledClinicianId?: string;
  // §418.24 election-statement content (#44) — persisted rather than discarded. `signerKind` is
  // NOT redeclared here: Rec already carries it for the revocation facts below, and the election
  // statement's signer uses the same "patient" | "representative" column vocabulary.
  curativeCareAcknowledgment?: boolean;
  stateAddendum?: Record<string, unknown>;
  effectiveDate?: string | null;
  patientNameAtSigning?: string;
  // intake/wizard linkage (§7.1/§7.2) — referral idempotency + the period-1 activation bundle
  externalReferralId?: string;
  source?: string;
  priority?: "routine" | "high" | "urgent";
  assignedToUserId?: string | null;
  receivedAt?: string;
  qualifiedAt?: string | null;
  convertedAt?: string | null;
  convertedAdmissionId?: string | null;
  rejectionReason?: string | null;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  actorId?: string | null;
  action?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown>;
  referringDxText?: string;
  referrerName?: string;
  referrerOrganization?: string;
  referrerPhone?: string;
  patientNameAtReceipt?: string;
  patientDobAtReceipt?: string;
  medicareNumberAtReceipt?: string;
  medicaidNumberAtReceipt?: string;
  sexAssignedAtBirth?: "F" | "M" | "O" | "U";
  patientResolutionStatus?: "unresolved" | "possible_match" | "matched" | "created";
  electionPeriodId?: string;
  sequence?: number;
  primaryDiagnosisIcd10?: string;
  readmittedFromAdmissionId?: string | null;
  scheduledDate?: LocalDate | null;
  requestedWindowStart?: LocalDate | null;
  requestedWindowEnd?: LocalDate | null;
  authoritativeWindowStart?: LocalDate | null;
  authoritativeWindowEnd?: LocalDate | null;
  // recert/F2F linkage (§7.3/§7.4) — the period start date drives the D4 deadline + F2F window math
  periodStartDate?: LocalDate;
  // discharge linkage (§6.3/§7.6) — for-cause stays active until cosign (D11); opt-out gates W-DC-01
  pendingForCauseDischarge?: boolean;
  bereavementOptOut?: boolean;
  reason?: DischargeReason;
  // NOR acknowledgment facts (TASK-034) — what was actually submitted, not a hardcoded default.
  deliveryMethod?: NorAcknowledgeInput["deliveryMethod"];
  acknowledgedByRole?: NorAcknowledgeInput["acknowledgedByRole"];
  acknowledgedAtInstant?: string | null;
  acknowledgedByName?: string | null;
  // transfer facts (§4.2.7 routes 37/38) — the counterparty hospice identity + narrative, what was
  // actually submitted rather than silently dropped.
  direction?: "in" | "out";
  effectiveAt?: string;
  otherHospiceName?: string;
  otherHospiceCcn?: string | null;
  receivingCareSetting?: "home" | "facility" | null;
  narrative?: string;
  // revocation facts (§4.2.7 route 36) — what was actually submitted, not a hardcoded default.
  signedAt?: string;
  signerKind?: "patient" | "representative";
  evidence?: Partial<
    Record<
      "notice_of_rights" | "election_statement" | "election_signature" | "cti" | "cti_signature",
      AdmissionRequirementEvidence
    >
  >;
  revocationReason?: RevocationInput["revocationReason"];
  signingPatientName?: string;
  privacyAdmissionAllowed?: boolean;
  signedAtPresent?: boolean;
  acknowledgedAtPresent?: boolean;
  methodValid?: boolean;
  signerValid?: boolean;
  f2fAttested?: boolean;
  // 42 CFR 418.25(a) / 418.26(b) — the recommendation (admission) and the discharge order (discharge).
  recommendation?: AdmissionRecommendationView;
  dischargeOrderSignedByUserId?: string;
  dischargeOrderCapacity?: PhysicianSignerCapacity;
  dischargeOrderSignedAt?: string;
  dischargeOrderText?: string | null;
  dischargeOrderReference?: string | null;
  cosignedAt?: string;
  /** GAP-121 — the user who filed a for-cause discharge (the cosigner must differ). */
  filedByUserId?: string;
  cosignerName?: string;
  cosignerNpi?: string;
}

/** Admission states in which a 418.25(a) recommendation can no longer be recorded (the episode is over). */
export const RECOMMENDATION_CLOSED_STATES: ReadonlySet<string> = new Set([
  "discharged",
  "bereavement",
  "closed",
]);

/** A seed record for the slice (lets a test pre-populate a resource with owner facts for ABAC). */
export interface AdmissionSeedRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly state?: string;
  readonly patientId?: string;
  readonly providerEntityId?: string | null;
  readonly locationId?: string | null;
  /** The admission's creator (POST /admissions actor) — `admission.scope`'s §6.8 creator arm. */
  readonly createdByUserId?: string | null;
  readonly admissionId?: string;
  readonly hospiceMedicalDirectorId?: string;
  readonly attendingPhysicianId?: string | null;
  readonly scheduledClinicianId?: string;
  /** §7.3/§7.4 — the benefit-period sequence + start date (lets a test seed a recert / F2F window). */
  readonly sequence?: number;
  readonly periodStartDate?: LocalDate;
  /** §7.6 W-DC-01 — the M5 per-patient bereavement opt-out flag (suppresses `m6.bereavement.eligible`). */
  readonly bereavementOptOut?: boolean;
  readonly privacyAdmissionAllowed?: boolean;
  /** Readiness facts, so a test can seed a gate-ready admission bundle without driving every write. */
  readonly admissionAt?: string | null;
  readonly electionPeriodId?: string;
  readonly deliveryMethod?: NorAcknowledgeInput["deliveryMethod"];
  readonly acknowledgedByRole?: NorAcknowledgeInput["acknowledgedByRole"];
}

export interface AdmissionBackendSeed {
  readonly records?: readonly AdmissionSeedRecord[];
  /** Patient identities supplied by the M5 test double; absent identities resolve to null. */
  readonly patientIdentities?: Readonly<
    Record<string, NonNullable<AdmissionSummary["patient"]> & { readonly organizationId: string }>
  >;
  readonly now?: () => Date;
  /** Org timezone (M2 `organization.timezone`; D8) — drives the D4 deadline + F2F window math. */
  readonly orgTimeZone?: string;
  /**
   * #50 — providerEntityId → its ACTIVE service locations, standing in for the M1 location directory
   * the Drizzle backend reads through an injected port. Activation sites the admission from this:
   * exactly one candidate is derived, more than one must be named, none is a refusal. A provider entity
   * absent from the map yields no candidates.
   */
  readonly providerEntityLocations?: Readonly<Record<string, readonly string[]>>;
  /**
   * GAP-022 — user id -> the role keys that user actually holds (the stand-in for the M3 grants the
   * Drizzle backend reads through an injected port). A user absent from the map has no membership.
   * With no map seeded, a `user` actor falls back to the claimed role (legacy slice tests).
   */
  readonly clinicianRoleKeys?: Readonly<Record<string, readonly string[]>>;
  /**
   * 42 CFR 418.25(a) / 418.26(b) — patientId -> user ids holding an open `md` care-team assignment (the
   * physician member of that patient's IDG), standing in for M5's `patient_assignment`.
   */
  readonly idgPhysicianAssignments?: Readonly<Record<string, readonly string[]>>;
  /** user id -> display name for the signer picker. */
  readonly userNames?: Readonly<Record<string, string>>;
}

/**
 * Build an in-memory {@link AdmissionRouteService} + {@link AdmissionAbacResolver} over ONE dataset
 * (M40-style backend) so the slice's route writes and the ABAC predicate reads stay consistent. The
 * `events` array records emitted outbox event names for assertion. Deterministic — no I/O, injected
 * clock.
 */
/**
 * The in-memory slice's first benefit period: the staff entry (validated like the Drizzle path) or 1 — the slice
 * keeps no discharge history to suggest from (the Drizzle path's suggestion is proven by its live suite).
 */
function firstSequence(input: FirstBenefitPeriodInput): number {
  if (!input.benefitPeriod) return 1;
  assertBenefitPeriodEntry(input.benefitPeriod, new Date().toISOString().slice(0, 10));
  assertF2fExceptionReason(input.f2fException?.reason, input.benefitPeriod.sequence);
  return input.benefitPeriod.sequence;
}

/** The in-memory twin of the Drizzle resolver's latest site-naming referral of a patient (last seeded wins). */
function referralSiteOf(
  ofOrg: readonly Rec[],
  patientId: string,
): { referralProviderEntityId: string | null; referralLocationId: string | null } {
  const sited = ofOrg.filter(
    (r) =>
      r.kind === "referral" &&
      r.patientId === patientId &&
      (r.providerEntityId != null || r.locationId != null),
  );
  const last = sited[sited.length - 1];
  return {
    referralProviderEntityId: last?.providerEntityId ?? null,
    referralLocationId: last?.locationId ?? null,
  };
}

export function createInMemoryAdmissionBackend(seed: AdmissionBackendSeed = {}): {
  service: AdmissionRouteService;
  resolver: AdmissionAbacResolver;
  physicianAuthority: PhysicianAuthorityPort;
  events: string[];
} {
  const events: string[] = [];
  const patientIdentity = (organizationId: string, patientId: string | null | undefined) => {
    const identity = patientId ? seed.patientIdentities?.[patientId] : undefined;
    return identity && identity.id === patientId && identity.organizationId === organizationId
      ? {
          id: identity.id,
          firstName: identity.firstName,
          lastName: identity.lastName,
          mrn: identity.mrn,
        }
      : null;
  };
  const byId = new Map<string, Rec>();
  for (const r of seed.records ?? []) {
    byId.set(r.id, {
      id: r.id,
      organizationId: r.organizationId,
      kind: r.kind,
      state: r.state ?? "pending",
      version: 1,
      patientId: r.patientId,
      providerEntityId: r.providerEntityId ?? null,
      locationId: r.locationId ?? null,
      createdByUserId: r.createdByUserId ?? null,
      admissionId: r.admissionId,
      hospiceMedicalDirectorId: r.hospiceMedicalDirectorId,
      attendingPhysicianId: r.attendingPhysicianId ?? null,
      scheduledClinicianId: r.scheduledClinicianId,
      sequence: r.sequence,
      periodStartDate: r.periodStartDate,
      bereavementOptOut: r.bereavementOptOut,
      privacyAdmissionAllowed: r.privacyAdmissionAllowed,
      admissionAt: r.admissionAt,
      electionPeriodId: r.electionPeriodId,
      deliveryMethod: r.deliveryMethod,
      acknowledgedByRole: r.acknowledgedByRole,
    });
  }
  const now = seed.now ?? (() => new Date("2026-06-20T00:00:00Z"));
  /** The slice's PhysicianAuthorityPort over the seeded role keys + IDG care-team assignments. */
  const physicianAuthority: PhysicianAuthorityPort = {
    async signerFacts(_organizationId, userId, patientId) {
      return {
        roleKeys: seed.clinicianRoleKeys?.[userId] ?? null,
        idgPhysicianOfPatient: (seed.idgPhysicianAssignments?.[patientId] ?? []).includes(userId),
      };
    },
    async listSignerCandidates(_organizationId, patientId) {
      const idg = seed.idgPhysicianAssignments?.[patientId] ?? [];
      return Object.entries(seed.clinicianRoleKeys ?? {})
        .map(([userId, roleKeys]) => ({
          userId,
          name: seed.userNames?.[userId] ?? null,
          capacities: heldSignerCapacities({
            roleKeys,
            idgPhysicianOfPatient: idg.includes(userId),
          }),
        }))
        .filter((c) => c.capacities.length > 0);
    },
  };
  const orgTimeZone = seed.orgTimeZone ?? DEFAULT_ORG_TIME_ZONE;
  const providerEntityLocations = seed.providerEntityLocations;
  /**
   * #50 — the slice's copy of the Drizzle backend's activation-siting rule. Kept a mirror rather than a
   * shared helper because the two read their candidates from different places (a seeded map vs. an
   * injected M1 port) and the RULE is what has to stay identical, not the lookup.
   *
   * With no map seeded at all the whole rule is inert (`null`), so every existing slice test that
   * activates an admission is unaffected — the behaviour only turns on for a seed that opts in.
   */
  const resolveSliceActivationLocation = (
    providerEntityId: string | null,
    requested: string | undefined,
  ): string | null => {
    if (!providerEntityId || !providerEntityLocations) return null;
    const active = providerEntityLocations[providerEntityId] ?? [];
    if (requested) {
      if (!active.includes(requested)) {
        throw new ChartWardenError(
          "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY",
          `location ${requested} is not an active location of the admission's elected provider entity`,
          422,
        );
      }
      return requested;
    }
    if (active.length === 1) return active[0] as string;
    if (active.length === 0) {
      throw new ChartWardenError(
        "M6_LOCATION_REQUIRED",
        "the elected provider entity has no active location, so this admission cannot be sited; activate a location first",
        422,
      );
    }
    throw new ChartWardenError(
      "M6_LOCATION_REQUIRED",
      `the elected provider entity has ${active.length} active locations; name the one this admission is served from (locationId)`,
      422,
    );
  };
  let seq = 0;
  // Mint uuid-shaped synthetic ids so a created id round-trips through a uuid-validated request body
  // (e.g. the wizard posts a server-created electionPeriodId back on the CTI draft, §7.2). The id is
  // deterministic in `seq` — the slice stands in for the Drizzle backend's uuid PKs.
  const nextId = (_kind: string) =>
    // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
    `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

  const insert = (
    kind: string,
    organizationId: string,
    state: string,
    facts: Partial<Rec> = {},
  ): Rec => {
    const id = nextId(kind);
    const rec: Rec = { id, organizationId, kind, state, version: 1, ...facts };
    byId.set(id, rec);
    return rec;
  };
  const get = (organizationId: string, id: string, kind?: string): Rec | null => {
    const rec = byId.get(id);
    if (!rec || rec.organizationId !== organizationId) return null; // §6.6 cross-tenant non-leak
    if (kind && rec.kind !== kind) return null;
    return rec;
  };
  /** Apply a state transition with optimistic-lock check; bumps version + emits `event`. */
  const transition = (
    rec: Rec,
    state: string,
    ifVersion: number,
    event?: string,
  ): MutationResult => {
    if (rec.version !== ifVersion) {
      throw new VersionMismatchError(rec.id, rec.version, ifVersion);
    }
    rec.state = state;
    rec.version += 1;
    if (event) events.push(event);
    return { id: rec.id, state: rec.state, version: rec.version };
  };
  const summary = (rec: Rec): SummaryRow => ({
    id: rec.id,
    state: rec.state,
    version: rec.version,
    patientId: rec.patientId ?? null,
  });
  const referralView = (rec: Rec): ReferralReadView => {
    const blockers: Array<{ code: string; message: string }> = [];
    if (
      !rec.patientId ||
      !["matched", "created"].includes(rec.patientResolutionStatus ?? "unresolved")
    ) {
      blockers.push({
        code: "PATIENT_UNRESOLVED",
        message: "A patient must be confirmed or created before qualification.",
      });
    }
    if (!rec.referringDxText && !rec.externalReferralId) {
      blockers.push({
        code: "CLINICAL_INDICATION_MISSING",
        message: "A referral reason or clinical indication is required before qualification.",
      });
    }
    if (!rec.referrerName && !rec.referrerOrganization && !rec.externalReferralId) {
      blockers.push({
        code: "SOURCE_INFORMATION_MISSING",
        message: "Referral source information is required before qualification.",
      });
    }
    return {
      ...summary(rec),
      status: rec.state,
      patientId: rec.patientId ?? null,
      patientResolutionStatus: rec.patientResolutionStatus ?? "unresolved",
      patientNameAtReceipt: rec.patientNameAtReceipt ?? "Unknown patient",
      patientDobAtReceipt: rec.patientDobAtReceipt ?? null,
      medicareNumberAtReceipt: rec.medicareNumberAtReceipt ?? null,
      medicaidNumberAtReceipt: rec.medicaidNumberAtReceipt ?? null,
      sexAssignedAtBirth: rec.sexAssignedAtBirth ?? "U",
      referringDxText: rec.referringDxText ?? null,
      icd10TerminalPrimary: rec.primaryDiagnosisIcd10 ?? null,
      source: rec.source ?? "phone",
      referrerName: rec.referrerName ?? null,
      referrerOrganization: rec.referrerOrganization ?? null,
      referrerPhone: rec.referrerPhone ?? null,
      externalReferralId: rec.externalReferralId ?? null,
      priority: rec.priority ?? "routine",
      assignedToUserId: rec.assignedToUserId ?? null,
      receivedAt: rec.receivedAt ?? now().toISOString(),
      reviewedAt: null,
      qualifiedAt: rec.qualifiedAt ?? null,
      declinedAt: null,
      convertedAt: rec.convertedAt ?? null,
      convertedAdmissionId: rec.convertedAdmissionId ?? null,
      rejectionReason: rec.rejectionReason ?? null,
      qualificationBlockers: blockers,
    };
  };
  const page = <T extends SummaryRow>(
    rows: T[],
    query: { cursor?: string; limit?: number },
  ): Page<T> => {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const slice = rows.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return {
      items: slice,
      nextCursor: nextOffset < rows.length ? String(nextOffset) : null,
    };
  };
  const listOfKind = (organizationId: string, kind: string): Rec[] =>
    [...byId.values()].filter((r) => r.organizationId === organizationId && r.kind === kind);

  /**
   * Compute the R-AC-01 activation gate (§7.2 / §5.2.5) over an admission's period-1 bundle. Both the
   * read aggregate (route 10) and `activateAdmission` (route 14) call this ONE helper so the §5.2.5
   * checklist and the server gate can never disagree. CTI signature progress is read off the CTI
   * state (`awaiting_attending` = hospice-MD signed; `signed` = both signed).
   */
  const gateFor = (adm: Rec): ActivationGate => {
    const childrenOf = (kind: string): Rec[] =>
      listOfKind(adm.organizationId, kind).filter((r) => r.admissionId === adm.id);
    const period =
      childrenOf("election_period").sort((a, b) => (a.sequence ?? 1) - (b.sequence ?? 1))[0] ??
      null;
    const cti = childrenOf("cti").find((c) => !period || c.electionPeriodId === period.id);
    return computeActivationGate({
      periodSequence: period?.sequence ?? 1,
      electionSigned: childrenOf("election_statement").some(
        (s) => s.state === "signed" && (s.signedAtPresent ?? true),
      ),
      norAcknowledged: childrenOf("nor").some((n) => n.state === "acknowledged"),
      ctiHospiceMdSigned: cti?.state === "awaiting_attending" || cti?.state === "signed",
    });
  };

  const readinessFor = (adm: Rec): AdmissionReadinessResult => {
    const childrenOf = (kind: string): Rec[] =>
      listOfKind(adm.organizationId, kind).filter((r) => r.admissionId === adm.id);
    const periods = childrenOf("election_period").sort(
      (a, b) => (a.sequence ?? 1) - (b.sequence ?? 1),
    );
    const period = periods[0];
    const election = childrenOf("election_statement").find(
      (s) => (!period || s.electionPeriodId === period.id) && s.state !== "voided",
    );
    const cti = childrenOf("cti").find((c) => !period || c.electionPeriodId === period.id);
    const nor = childrenOf("nor")[0];
    const f2f = childrenOf("f2f").find((f) => !period || f.electionPeriodId === period.id);
    const facts: AdmissionReadinessFacts = {
      admissionId: adm.id,

      patientIdentity: {
        patientId: adm.patientId ?? null,
        referralPatientId: adm.externalReferralId ? (adm.patientId ?? null) : undefined,
        referralPatientResolutionStatus: adm.externalReferralId ? "created" : undefined,
      },

      admissionDetails: {
        admissionDatePresent: !!adm.admissionAt,
        providerEntityPresent: !!adm.providerEntityId,
        locationPresent: !!adm.locationId,
      },

      patientPrivacy: {
        allowed: adm.privacyAdmissionAllowed !== false,
      },

      noticeOfRights: {
        acknowledged: !!nor,
        acknowledgedAtPresent: nor?.acknowledgedAtPresent ?? !!nor,
        signerValid: nor?.signerValid ?? !!nor?.acknowledgedByRole,
        methodValid: nor?.methodValid ?? !!nor?.deliveryMethod,
        evidence: nor
          ? {
              sourceType: "structured",
              evidenceId: nor.id,
              structuredEntityId: nor.id,
            }
          : adm.evidence?.notice_of_rights,
      },

      electionStatement: {
        exists: !!election || !!adm.evidence?.election_statement,
        status: election?.state ?? null,
        signedAtPresent: election?.signedAtPresent ?? election?.state === "signed",
        belongsToCurrentPeriod:
          !!adm.evidence?.election_statement ||
          (!!election && (!period || election.electionPeriodId === period.id)),
        evidence: election
          ? {
              sourceType: "structured",
              evidenceId: election.id,
              structuredEntityId: election.id,
            }
          : adm.evidence?.election_statement,
        signatureEvidence:
          election?.state === "signed"
            ? {
                sourceType: "structured",
                evidenceId: election.id,
                structuredEntityId: election.id,
              }
            : adm.evidence?.election_signature,
      },

      cti: {
        exists: !!cti || !!adm.evidence?.cti,
        status: cti?.state ?? null,
        evidence: cti
          ? {
              sourceType: "structured",
              evidenceId: cti.id,
              structuredEntityId: cti.id,
            }
          : adm.evidence?.cti,
        signatureEvidence:
          cti?.state === "awaiting_attending" || cti?.state === "signed"
            ? {
                sourceType: "structured",
                evidenceId: cti.id,
                structuredEntityId: cti.id,
              }
            : adm.evidence?.cti_signature,
        hospiceMdSigned: cti?.state === "awaiting_attending" || cti?.state === "signed",
      },

      f2f: {
        required: (period?.sequence ?? 1) >= 3,
        exists: !!f2f,
        status: f2f?.state ?? null,
        completed: f2f?.state === "completed" || f2f?.state === "attested",
        attestationRequired: (period?.sequence ?? 1) >= 3,
        attested: f2f?.state === "attested" || f2f?.f2fAttested === true,
      },

      admissionRecommendation: { recorded: adm.recommendation !== undefined },
    };
    return evaluateAdmissionReadiness(facts);
  };

  const notFound = (id: string): never => {
    throw new ResourceNotFoundError(id);
  };

  const service: AdmissionRouteService = {
    async createReferral(organizationId, input, actorUserId) {
      void actorUserId;
      // W-RF-02: re-ingest of a known externalReferralId is a no-op-with-409, never a duplicate row.
      if (input.externalReferralId) {
        const dup = listOfKind(organizationId, "referral").find(
          (r) => r.externalReferralId === input.externalReferralId,
        );
        if (dup) throw new ExternalReferralAlreadyIngestedError(input.externalReferralId);
      }
      const rec = insert("referral", organizationId, "received", {
        locationId: null,
        externalReferralId: input.externalReferralId,
        source: input.source,
        patientNameAtReceipt: input.patientNameAtReceipt,
        patientDobAtReceipt: input.patientDobAtReceipt,
        medicareNumberAtReceipt: input.medicareNumberAtReceipt,
        medicaidNumberAtReceipt: input.medicaidNumberAtReceipt,
        sexAssignedAtBirth: input.sexAssignedAtBirth ?? "U",
        referringDxText: input.referringDxText,
        referrerName: input.referrerName,
        referrerOrganization: input.referrerOrganization,
        referrerPhone: input.referrerPhone,
        receivedAt: input.receivedAt,
        patientId: input.patientId,
        patientResolutionStatus: input.patientId ? "matched" : "unresolved",
        priority: "routine",
      });
      events.push("m6.referral.received");
      return summary(rec);
    },
    async listReferrals(organizationId, query, actorUserId, scope) {
      let rows = listOfKind(organizationId, "referral");
      if (scope) {
        const allowed = scope.locationIds;
        rows = rows.filter((r) => {
          const loc = (r as { locationId?: string | null }).locationId ?? null;
          return loc === null || allowed.includes(loc);
        });
      }
      const status = query.status ?? query.state;
      if (status) rows = rows.filter((r) => r.state === status);
      else if (!query.includeConverted) rows = rows.filter((r) => r.state !== "converted");
      if (query.source) rows = rows.filter((r) => r.source === query.source);
      if (query.patientResolutionStatus)
        rows = rows.filter(
          (r) => (r.patientResolutionStatus ?? "unresolved") === query.patientResolutionStatus,
        );
      if (query.priority) rows = rows.filter((r) => (r.priority ?? "routine") === query.priority);
      if (query.assigned === "unassigned") rows = rows.filter((r) => !r.assignedToUserId);
      if (query.assigned === "mine" && actorUserId)
        rows = rows.filter((r) => r.assignedToUserId === actorUserId);
      if (query.q?.trim()) {
        const q = query.q.trim().toLowerCase();
        rows = rows.filter((r) =>
          [
            r.patientNameAtReceipt,
            r.referrerName,
            r.referrerOrganization,
            r.externalReferralId,
            r.referringDxText,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        );
      }
      return page(rows.map(referralView), query);
    },
    async getReferral(organizationId, id) {
      const rec = get(organizationId, id, "referral");
      return rec ? referralView(rec) : null;
    },
    async updateReferral(organizationId, id, input, ifVersion) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      if (!["received", "under_review", "pending_information"].includes(rec.state)) {
        throw new InvalidReferralStateError(id, rec.state, "update referral information");
      }
      if (input.sexAssignedAtBirth) rec.sexAssignedAtBirth = input.sexAssignedAtBirth;
      return transition(rec, rec.state, ifVersion);
    },
    async triageReferral(organizationId, id, outcome, ifVersion) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      // Optimistic lock first (§7.1 concurrency edge): a stale write is a VERSION_MISMATCH, even when
      // the winning write already advanced the state out of `received`.
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      if (rec.state !== "received") throw new InvalidReferralStateError(id, rec.state, "triage");
      const next = outcome === "eligible" ? "under_review" : "declined";
      return transition(
        rec,
        next,
        ifVersion,
        outcome === "eligible" ? "m6.referral.review_started" : "m6.referral.declined",
      );
    },
    async acceptReferral(organizationId, id, input, ifVersion, actorUserId) {
      return this.convertReferral(organizationId, id, input, ifVersion, actorUserId);
    },
    async startReferralReview(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state !== "received" && rec.state !== "pending_information") {
        throw new InvalidReferralStateError(id, rec.state, "start review");
      }
      return transition(rec, "under_review", ifVersion, "m6.referral.review_started");
    },
    async runReferralPatientMatching(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      rec.patientResolutionStatus = "possible_match";
      rec.version += 1;
      events.push("m6.referral.patient_match_suggested");
      return { ...summary(rec), candidates: [] };
    },
    async confirmReferralPatient(organizationId, id, patientId, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      rec.patientId = patientId;
      rec.patientResolutionStatus = "matched";
      rec.version += 1;
      return summary(rec);
    },
    async createReferralPatient(organizationId, id, ifVersion, actorUserId, actorSite) {
      void actorUserId;
      void actorSite;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      const patientId = nextId("patient");
      rec.patientId = patientId;
      rec.patientResolutionStatus = "created";
      rec.version += 1;
      return { ...summary(rec), patientId };
    },
    async qualifyReferral(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state !== "under_review")
        throw new InvalidReferralStateError(id, rec.state, "qualify");
      if (
        !rec.patientId ||
        !["matched", "created"].includes(rec.patientResolutionStatus ?? "unresolved")
      ) {
        throw new ReferralNotReadyError([
          {
            code: "PATIENT_UNRESOLVED",
            message: "A patient must be confirmed or created before qualification.",
          },
        ]);
      }
      return transition(rec, "qualified", ifVersion, "m6.referral.qualified");
    },
    async convertReferral(organizationId, id, input, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state === "converted") {
        const existing = listOfKind(organizationId, "admission").find(
          (r) => r.externalReferralId === rec.id,
        );
        if (existing) return { ...summary(rec), admissionId: existing.id };
        throw new ReferralAlreadyConvertedError(id);
      }
      if (rec.state !== "qualified") throw new ReferralNotTriagedError(id);
      if (
        !rec.patientId ||
        !["matched", "created"].includes(rec.patientResolutionStatus ?? "unresolved")
      ) {
        throw new ReferralNotReadyError([
          {
            code: "PATIENT_UNRESOLVED",
            message: "A patient must be confirmed or created before qualification.",
          },
        ]);
      }
      const res = transition(rec, "converted", ifVersion, "m6.referral.converted");
      const patientId = rec.patientId;
      const adm = insert("admission", organizationId, "pending", {
        patientId,
        externalReferralId: rec.id,
        providerEntityId: null,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        primaryDiagnosisIcd10: input.primaryDiagnosisIcd10,
      });
      insert("election_period", organizationId, "pending", {
        admissionId: adm.id,
        patientId,
        sequence: firstSequence(input),
        primaryDiagnosisIcd10: input.primaryDiagnosisIcd10,
      });
      insert("compliance_window", organizationId, "open", {
        admissionId: adm.id,
        patientId,
      }); // NOR window
      events.push("m6.admission.draft_created");
      return { ...res, admissionId: adm.id };
    },
    async declineReferral(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      return transition(rec, "declined", ifVersion, "m6.referral.declined");
    },
    async addReferralNote(organizationId, id, input, actorUserId) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      const note = insert("referral_note", organizationId, "created", {
        admissionId: rec.id,
        content: input.content,
        actorId: actorUserId,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      });
      return {
        id: note.id,
        referralId: rec.id,
        authorId: actorUserId,
        content: input.content,
        createdAt: note.createdAt ?? now().toISOString(),
        updatedAt: note.updatedAt ?? now().toISOString(),
      };
    },
    async listReferralNotes(organizationId, id) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      return listOfKind(organizationId, "referral_note")
        .filter((n) => n.admissionId === rec.id)
        .map((n) => ({
          id: n.id,
          referralId: rec.id,
          authorId: n.actorId ?? null,
          content: n.content ?? "",
          createdAt: n.createdAt ?? now().toISOString(),
          updatedAt: n.updatedAt ?? now().toISOString(),
        }));
    },
    async listReferralActivity(organizationId, id) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      return listOfKind(organizationId, "referral_activity")
        .filter((a) => a.admissionId === rec.id)
        .map((a) => ({
          id: a.id,
          referralId: rec.id,
          actorId: a.actorId ?? null,
          action: a.action ?? "referral_received",
          fromStatus: a.fromStatus ?? null,
          toStatus: a.toStatus ?? null,
          metadata: a.metadata ?? {},
          createdAt: a.createdAt ?? now().toISOString(),
        }));
    },
    async updateReferralPriority(organizationId, id, priority, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      if (!["received", "under_review", "pending_information"].includes(rec.state)) {
        throw new InvalidReferralStateError(id, rec.state, "update referral priority");
      }
      rec.priority = priority;
      rec.version += 1;
      return summary(rec);
    },
    async assignReferral(organizationId, id, assignedToUserId, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      rec.assignedToUserId = assignedToUserId ?? null;
      rec.version += 1;
      return summary(rec);
    },
    async markReferralPendingInformation(organizationId, id, reason, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state !== "under_review")
        throw new InvalidReferralStateError(id, rec.state, "mark pending information");
      rec.rejectionReason = reason;
      return transition(rec, "pending_information", ifVersion);
    },
    async markReferralDuplicate(organizationId, id, reason, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state === "converted")
        throw new InvalidReferralStateError(id, rec.state, "mark duplicate");
      rec.rejectionReason = reason ?? "Duplicate referral";
      return transition(rec, "duplicate", ifVersion);
    },
    async withdrawReferral(organizationId, id, reason, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state === "converted") throw new InvalidReferralStateError(id, rec.state, "withdraw");
      rec.rejectionReason = reason ?? "Referral withdrawn";
      return transition(rec, "withdrawn", ifVersion);
    },

    async createAdmission(organizationId, input, actorUserId) {
      if (input.referralId) throw new ReferralAdmissionPathError();
      const rec = insert("admission", organizationId, "pending", {
        patientId: input.patientId,
        readmittedFromAdmissionId: input.readmittedFromAdmissionId ?? null,
        providerEntityId: null,
        createdByUserId: actorUserId || null,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        admissionTypeCode: input.admissionTypeCode ?? null,
        admissionSourceCode: input.admissionSourceCode ?? null,
        primaryDiagnosisIcd10: "C00",
      });
      const sequence = firstSequence(input);
      const period = insert("election_period", organizationId, "pending", {
        admissionId: rec.id,
        patientId: input.patientId,
        sequence,
        primaryDiagnosisIcd10: "C00",
      });
      insert("cti", organizationId, "drafted", {
        admissionId: rec.id,
        electionPeriodId: period.id,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        sequence,
      });
      return summary(rec);
    },
    async listAdmissions(organizationId, query, scope) {
      let rows = listOfKind(organizationId, "admission");
      // GAP-020 — narrow to the caller's caseload (in-memory mirror of the SQL `inArray`).
      const ids = scope?.patientIds ?? null;
      if (ids !== null) rows = rows.filter((r) => !!r.patientId && ids.includes(r.patientId));
      if (query.state) rows = rows.filter((r) => r.state === query.state);
      if (query.patientId) rows = rows.filter((r) => r.patientId === query.patientId);
      // F-195 (#248) — this in-memory slice's `holdAdmission`/`resumeAdmission` discard the reason and
      // never persist a timestamp (a lightweight state-transition double, not the D1 record); the real
      // values are proven against the Drizzle implementation's own live suite.
      return page(
        rows.map((r) => ({
          ...summary(r),
          patient: patientIdentity(organizationId, r.patientId),
          holdReason: null,
          holdAt: null,
          releasedAt: null,
        })),
        query,
      );
    },
    async getAdmission(organizationId, id) {
      const rec = get(organizationId, id, "admission");
      return rec
        ? {
            ...summary(rec),
            patient: patientIdentity(organizationId, rec.patientId),
            patientId: rec.patientId,
            referralId: rec.externalReferralId ?? null,
            readmittedFromAdmissionId: rec.readmittedFromAdmissionId ?? null,
            admissionAt: rec.admissionAt ?? null,
            activatedAt: rec.state === "active" ? now().toISOString() : null,
            providerEntityId: rec.providerEntityId ?? null,
            locationId: rec.locationId ?? null,
            primaryDiagnosisIcd10: rec.primaryDiagnosisIcd10 ?? null,
            referringDxText: rec.referringDxText ?? null,
            admissionRecommendation: rec.recommendation ?? null,
            attendingPhysicianId: rec.attendingPhysicianId ?? null,
            admissionTypeCode: rec.admissionTypeCode ?? null,
            admissionSourceCode: rec.admissionSourceCode ?? null,
            activationGate: gateFor(rec),
            readiness: readinessFor(rec),
          }
        : null;
    },
    async getAdmissionReadiness(organizationId, id) {
      const rec = get(organizationId, id, "admission");
      return rec ? readinessFor(rec) : null;
    },
    async listPatientAdmissions(organizationId, patientId) {
      // Ids are monotonic in insert order, so reversing gives newest-first (the DB path orders by
      // `admission_at`; both agree on "the current admission is the first row").
      return listOfKind(organizationId, "admission")
        .filter((r) => r.patientId === patientId)
        .reverse()
        .map((r) => ({
          id: r.id,
          state: r.state,
          // The in-memory `Rec` carries no admission/discharge timestamps — the slice models the
          // lifecycle, not the calendar. Null here, real in the Drizzle path.
          admissionAt: null,
          dischargedAt: null,
        }));
    },
    async getPatientElectionCertification(organizationId, patientId) {
      // Newest admission for the patient (ids are monotonic in insert order → last is newest).
      const admissions = listOfKind(organizationId, "admission").filter(
        (r) => r.patientId === patientId,
      );
      const adm = admissions.length ? admissions[admissions.length - 1] : null;
      if (!adm) return { admission: null, periods: [], complianceWindows: [] };
      const childrenOf = (kind: string): Rec[] =>
        listOfKind(organizationId, kind).filter((r) => r.admissionId === adm.id);
      // Election statement / CTI / F2F link to a period via `electionPeriodId`. A period can hold a
      // voided CTI beside the live one, so the pick ranks by status (election-cert-picks.ts) instead of
      // letting the last-inserted row win; insertion order is the remaining tiebreak.
      const byPeriod = (
        kind: string,
        rank: Readonly<Record<string, number>>,
      ): ReadonlyMap<string, Rec> =>
        new Map(
          [
            ...pickOnePerPeriod(
              listOfKind(organizationId, kind).flatMap((r) =>
                r.electionPeriodId
                  ? [{ rec: r, electionPeriodId: r.electionPeriodId, status: r.state }]
                  : [],
              ),
              rank,
            ),
          ].map(([periodId, c]) => [periodId, c.rec]),
        );
      const esBy = byPeriod("election_statement", ELECTION_STATEMENT_STATUS_RANK);
      const ctiBy = byPeriod("cti", CTI_STATUS_RANK);
      const f2fBy = byPeriod("face_to_face", F2F_STATUS_RANK);
      const periods = childrenOf("election_period")
        .slice()
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((p) => {
          const es = esBy.get(p.id);
          const cti = ctiBy.get(p.id);
          const f2f = f2fBy.get(p.id);
          return {
            id: p.id,
            sequenceNumber: p.sequence ?? 1,
            periodKind: "initial",
            effectiveAt: p.periodStartDate ?? null,
            scheduledEndAt: null,
            actualEndAt: null,
            status: p.state,
            electionStatement: es
              ? {
                  id: es.id,
                  status: es.state,
                  signerKind: "patient",
                  signedAt: null,
                  sourceType: "structured" as const,
                }
              : null,

            cti: cti
              ? {
                  id: cti.id,
                  status: cti.state,
                  version: Number(cti.version),
                  sourceType: "structured" as const,
                  hospiceMdSigned: cti.state === "awaiting_attending" || cti.state === "signed",
                  attendingMdSigned: cti.state === "signed",
                  signedLate: false,
                  periodStart: p.periodStartDate ?? null,
                  periodEnd: null,
                }
              : null,
            faceToFace: f2f
              ? {
                  id: f2f.id,
                  status: f2f.state,
                  performerRole: "hospice_physician",
                  encounterDate: null,
                  withinWindow: null,
                  windowOverride: false,
                  attested: f2f.state === "attested",
                }
              : null,
          };
        });
      const complianceWindows = childrenOf("compliance_window").map((w) => ({
        id: w.id,
        windowKind: "recert",
        severity: "warning",
        status: w.state,
        mustCompleteBy: new Date(0).toISOString(),
        closedAt: null,
      }));
      return {
        admission: {
          id: adm.id,
          state: adm.state,
          admissionAt: null,
          activatedAt: null,
          dischargedAt: null,
          version: adm.version,
        },
        periods,
        complianceWindows,
      };
    },
    async updateAdmission(organizationId, id, input, ifVersion) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      const finalProviderEntityId =
        input.providerEntityId !== undefined ? input.providerEntityId : rec.providerEntityId;
      const defaultLocationId = finalProviderEntityId
        ? listOfKind(organizationId, "location")
            .filter((loc) => loc.providerEntityId === finalProviderEntityId)
            .sort((a, b) => {
              const aRank = a.state === "active" ? 0 : 1;
              const bRank = b.state === "active" ? 0 : 1;
              return aRank - bRank || a.id.localeCompare(b.id);
            })[0]?.id
        : null;
      const finalLocationId =
        input.locationId !== undefined ? input.locationId : (rec.locationId ?? defaultLocationId);
      if (finalProviderEntityId && finalLocationId) {
        const loc = get(organizationId, finalLocationId, "location");
        if (!loc || loc.providerEntityId !== finalProviderEntityId) {
          throw new LocationProviderMismatchError(finalLocationId, finalProviderEntityId);
        }
      }
      Object.assign(rec, {
        admissionAt: input.admissionAt ?? rec.admissionAt,
        attendingPhysicianId: input.attendingPhysicianId ?? rec.attendingPhysicianId,
        // `null` clears a mis-recorded value; `undefined` leaves it.
        admissionTypeCode:
          input.admissionTypeCode !== undefined ? input.admissionTypeCode : rec.admissionTypeCode,
        admissionSourceCode:
          input.admissionSourceCode !== undefined
            ? input.admissionSourceCode
            : rec.admissionSourceCode,
        providerEntityId: finalProviderEntityId ?? null,
        locationId: finalLocationId ?? null,
        patientResidenceAddressId:
          input.providerEntityId !== undefined || input.admissionAt !== undefined
            ? (rec.patientResidenceAddressId ?? nextId("patient_address"))
            : rec.patientResidenceAddressId,
      });
      return transition(rec, rec.state, ifVersion);
    },
    async attachUploadedNoticeOfRights(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      rec.evidence = {
        ...rec.evidence,
        notice_of_rights: {
          sourceType: "uploaded",
          evidenceId: nextId("admission_evidence"),
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          completedAt: input.acknowledgedAt ?? now().toISOString(),
        },
      };
      return summary(rec);
    },
    async attachUploadedElectionStatement(organizationId, electionPeriodId, input, actorUserId) {
      void actorUserId;
      const period =
        get(organizationId, electionPeriodId, "election_period") ?? notFound(electionPeriodId);
      const rec =
        get(organizationId, period.admissionId ?? "", "admission") ??
        notFound(period.admissionId ?? "");
      rec.evidence = {
        ...rec.evidence,
        election_statement: {
          sourceType: "uploaded",
          evidenceId: nextId("admission_evidence"),
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          completedAt: now().toISOString(),
        },
        ...(input.documentState === "signed"
          ? {
              election_signature: {
                sourceType: "uploaded" as const,
                evidenceId: nextId("admission_evidence"),
                documentId: input.documentId,
                documentVersionId: input.documentVersionId,
                completedAt: input.signedAt ?? now().toISOString(),
              },
            }
          : {}),
      };
      return summary(rec);
    },
    async attachUploadedElectionSignature(organizationId, electionStatementId, input, actorUserId) {
      void actorUserId;
      const election =
        get(organizationId, electionStatementId, "election_statement") ??
        notFound(electionStatementId);
      if (election.state === "signed")
        throw new ChartWardenError(
          "ELECTION_ALREADY_SIGNED",
          "This Election Statement is already signed.",
          409,
        );
      const rec =
        get(organizationId, election.admissionId ?? "", "admission") ??
        notFound(election.admissionId ?? "");
      rec.evidence = {
        ...rec.evidence,
        election_signature: {
          sourceType: "uploaded",
          evidenceId: nextId("admission_evidence"),
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          completedAt: input.signedAt ?? now().toISOString(),
        },
      };
      return summary(rec);
    },
    async attachUploadedCti(organizationId, electionPeriodId, input, actorUserId) {
      void actorUserId;
      const period =
        get(organizationId, electionPeriodId, "election_period") ?? notFound(electionPeriodId);
      const rec =
        get(organizationId, period.admissionId ?? "", "admission") ??
        notFound(period.admissionId ?? "");
      if (!rec.hospiceMedicalDirectorId) {
        throw new ChartWardenError(
          "ADMISSION_HOSPICE_PHYSICIAN_REQUIRED",
          "Select a Hospice Physician before creating the CTI.",
          400,
        );
      }
      rec.evidence = {
        ...rec.evidence,
        cti: {
          sourceType: "uploaded",
          evidenceId: nextId("admission_evidence"),
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          completedAt: now().toISOString(),
        },
        ...(input.documentState === "signed"
          ? {
              cti_signature: {
                sourceType: "uploaded" as const,
                evidenceId: nextId("admission_evidence"),
                documentId: input.documentId,
                documentVersionId: input.documentVersionId,
                completedAt: input.signedAt ?? now().toISOString(),
              },
            }
          : {}),
      };
      return summary(rec);
    },
    async holdAdmission(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      return transition(rec, "on_hold", ifVersion, "m6.admission.on_hold");
    },
    async resumeAdmission(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      return transition(rec, "active", ifVersion, "m6.admission.resumed");
    },
    async activateAdmission(organizationId, id, ifVersion, input) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      // R-AC-01 (§7.2 W-AD-05): the gate is server-truth; a stale UI checklist cannot bypass it.
      const readiness = readinessFor(rec);
      const gate = gateFor(rec);
      if (!readiness.canActivate)
        throw new ActivationPreconditionError(gate.missing, readiness.requirements);
      // #50 — the slice mirrors the Drizzle backend's siting rule over its seeded location map so the
      // route tests exercise the same refusals (see `resolveActivationLocation` there for the order).
      // An admission already sited by `updateAdmission` keeps its location unless one is named.
      const sited =
        !input?.locationId && rec.locationId
          ? rec.locationId
          : resolveSliceActivationLocation(rec.providerEntityId ?? null, input?.locationId);
      if (sited) rec.locationId = sited;
      return transition(rec, "active", ifVersion, "m6.admission.activated");
    },

    async draftElectionStatement(organizationId, admissionId, electionPeriodId, input) {
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      // GAP-024 — the period must belong to THE admission in the path (404, like absent).
      const ownPeriod = get(organizationId, electionPeriodId, "election_period");
      if (!ownPeriod || ownPeriod.admissionId !== adm.id) notFound(electionPeriodId);
      // One LIVE election statement per period (mirrors the partial `election_statement_period_idx`,
      // `WHERE status <> 'voided'`, in the Drizzle path): a voided statement never blocks a re-draft.
      if (
        listOfKind(organizationId, "election_statement").some(
          (r) => r.electionPeriodId === electionPeriodId && r.state !== "voided",
        )
      ) {
        throw new AdmissionStateError(
          "ELECTION_STATEMENT_CONFLICT",
          ELECTION_STATEMENT_CONFLICT_MESSAGE,
        );
      }
      const rec = insert("election_statement", organizationId, "drafted", {
        admissionId: adm.id,
        patientId: adm.patientId,
        electionPeriodId,
        // #44 — the slice mirrors the Drizzle service's persisted shape so a test written against
        // one is meaningful against the other.
        providerEntityId: input.electedProviderEntityId,
        effectiveDate: input.effectiveDate ?? null,
        primaryDiagnosisIcd10: input.primaryDiagnosisIcd10,
        attendingPhysicianId: input.electedAttendingPhysicianId ?? null,
        curativeCareAcknowledgment: input.waiverAcknowledged,
        stateAddendum: input.stateAddendum === undefined ? {} : { text: input.stateAddendum },
      });
      events.push("m6.election.drafted");
      return summary(rec);
    },
    async getElectionStatement(organizationId, id) {
      const rec = get(organizationId, id, "election_statement");
      return rec
        ? {
            ...summary(rec),
            electionPeriodId: rec.electionPeriodId,
            effectiveDate: rec.effectiveDate,
            primaryDiagnosisIcd10: rec.primaryDiagnosisIcd10 ?? null,
            electedProviderEntityId: rec.providerEntityId,
            electedAttendingPhysicianId: rec.attendingPhysicianId,
            waiverAcknowledged: rec.curativeCareAcknowledgment,
            stateAddendum: rec.stateAddendum,
            signerKind: rec.signerKind,
          }
        : null;
    },
    async signElection(organizationId, id, ifVersion, actorUserId, input) {
      void actorUserId;
      const rec = get(organizationId, id, "election_statement") ?? notFound(id);
      // #44 — carry the signer's declared capacity and name, as the Drizzle service now does.
      rec.signerKind = SIGNER_KIND_BY_ROLE[input.signingRole];
      rec.patientNameAtSigning = input.signingPatientName;
      return transition(rec, "signed", ifVersion, "m6.election.signed");
    },
    async voidElection(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "election_statement") ?? notFound(id);
      return transition(rec, "voided", ifVersion);
    },
    async listElectionPeriods(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "election_period")
        .filter((r) => r.admissionId === admissionId)
        .map((r) => ({
          ...summary(r),
          sequenceNumber: r.sequence,
          expectedStart: r.periodStartDate ?? null,
          effectiveAt: r.periodStartDate ?? null,
          scheduledEndAt: null,
          actualEndAt: null,
        }));
    },
    async createElectionPeriod(organizationId, admissionId) {
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("election_period", organizationId, "pending", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.election.drafted");
      return summary(rec);
    },
    async patchElectionPeriod(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "election_period") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },

    async draftCti(organizationId, input, actorUserId) {
      void actorUserId;
      // Resolve the period → admission so the activation gate can find this CTI in the period-1 bundle.
      const period = get(organizationId, input.electionPeriodId, "election_period");
      const rec = insert("cti", organizationId, "drafted", {
        admissionId: period?.admissionId,
        electionPeriodId: input.electionPeriodId,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        terminalDiagnosisIcd10: input.terminalDiagnosisIcd10,
        secondaryDiagnoses: input.secondaryDiagnoses ?? [],
        prognosisStatement: input.prognosisStatement,
        clinicalFindings: input.clinicalFindings,
        narrative: input.narrative,
        // §7.3 — carry the period sequence + start date so the recert sign can advance the period
        // (W-CTI-03) and mark-late can compute the D4 written-cert deadline off the period start.
        sequence: period?.sequence,
        periodStartDate: period?.periodStartDate,
      });
      events.push("m6.cti.drafted");
      return summary(rec);
    },
    async getCti(organizationId, id) {
      const rec = get(organizationId, id, "cti");
      return rec
        ? {
            ...summary(rec),
            electionPeriodId: rec.electionPeriodId,
            hospiceMedicalDirectorId: rec.hospiceMedicalDirectorId,
            attendingPhysicianId: rec.attendingPhysicianId,
            terminalDiagnosisIcd10: rec.terminalDiagnosisIcd10,
            secondaryDiagnoses: rec.secondaryDiagnoses,
            prognosisStatement: rec.prognosisStatement,
            narrative: rec.narrative,
            clinicalFindings: rec.clinicalFindings,
          }
        : null;
    },
    async signCtiHospiceMd(organizationId, id, ifVersion, actorUserId, input = {}) {
      void actorUserId;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      const isRecert = (rec.sequence ?? 1) >= 2;
      // Bug 3 — the narrative may be supplied at signature (a transfer-in drafts our CTI with none); a recert
      // needs >= 200 characters (42 CFR 418.22(b)(3); the Drizzle path's adequacy gate), so refuse with 422.
      const narrative = input.narrative?.trim() ? input.narrative : rec.narrative;
      const narrativeLength = narrative?.trim().length ?? 0;
      if (narrativeLength === 0 || (isRecert && narrativeLength < TEXT_MINIMUMS.ctiNarrative)) {
        throw new ChartWardenError(
          "CTI_NARRATIVE_REQUIRED",
          `The certification narrative is required before signing: provide a physician narrative of at least ${TEXT_MINIMUMS.ctiNarrative} characters (42 CFR 418.22(b)(3)).`,
          422,
        );
      }
      rec.narrative = narrative;
      // W-CTI-03/04: period 1 with an attending needs the co-sign (→ awaiting_attending); a recert
      // (period ≥ 2) is fully signed on the MD signature alone and advances its period to `active` AT ITS
      // START DATE (42 CFR 418.21(a) contiguous periods) — never earlier: a recert may be signed up to 15
      // days before the period starts (42 CFR 418.22(a)(3)), and the period stays `pending` until then.
      const outcome = decideRecertSign({
        sequence: rec.sequence ?? 1,
        patientHasAttending: rec.attendingPhysicianId != null,
        hospiceMdSigned: true,
        attendingSigned: false,
      });
      const res = transition(
        rec,
        outcome.progress,
        ifVersion,
        outcome.fullySigned ? "m6.cti.signed" : undefined,
      );
      if (outcome.activatesPeriod && rec.electionPeriodId) {
        const period = get(organizationId, rec.electionPeriodId, "election_period");
        const today = localDateInTimeZone(now(), orgTimeZone);
        const started = !period?.periodStartDate || period.periodStartDate <= today;
        if (period && period.state !== "active" && started) {
          period.state = "active";
          period.version += 1;
          events.push("m6.election.period_started");
        }
      }
      return res;
    },
    async signCtiAttending(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      return transition(rec, "signed", ifVersion, "m6.cti.signed");
    },
    async voidCti(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      return transition(rec, "voided", ifVersion, "m6.cti.voided");
    },
    async markCtiLate(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      const res = transition(rec, rec.state, ifVersion, "m6.cti.late_flagged");
      // D4 (§7.3 late-cert path): written-cert deadline = period_start + 2 calendar days at 23:59
      // org-TZ. Fall back to the org-local day of `now()` only when no period start is on file.
      const periodStart = rec.periodStartDate ?? now().toISOString().slice(0, 10);
      const writtenCertDeadlineAt = computeWrittenCertDeadline(periodStart, orgTimeZone);
      return { ...res, writtenCertDeadlineAt };
    },

    async scheduleF2f(organizationId, input) {
      // GAP-022 — the performer role is derived from the clinician's grants, never the body.
      if (input.actor.kind === "user" && seed.clinicianRoleKeys) {
        resolveF2fPerformerRole(
          seed.clinicianRoleKeys[input.scheduledClinicianId] ?? null,
          input.clinicianRole,
        );
      }
      // W-F2F-01: the scheduled date must fall inside the CMS 418.22 prior-to window, computed
      // server-side in org TZ off the period start. Validated only when the period start is on file.
      const period = get(organizationId, input.electionPeriodId, "election_period");
      // GAP-024 — the period must belong to the admission the route authorized (404, like absent).
      if (!period || period.admissionId !== input.admissionId) notFound(input.electionPeriodId);
      if (input.scheduledDate && period?.periodStartDate) {
        const window = computeF2fWindow(period.periodStartDate, orgTimeZone);
        if (!isF2fScheduledWithinWindow(input.scheduledDate, window)) {
          throw new F2fScheduleOutOfWindowError(
            input.scheduledDate,
            window.windowStart,
            window.windowEnd,
          );
        }
      }
      const rec = insert("f2f", organizationId, "scheduled", {
        admissionId: input.admissionId,
        electionPeriodId: input.electionPeriodId,
        scheduledClinicianId: input.scheduledClinicianId,
        periodStartDate: period?.periodStartDate,
        scheduledDate: input.scheduledDate ?? null,
        requestedWindowStart: input.windowStart ?? null,
        requestedWindowEnd: input.windowEnd ?? null,
        authoritativeWindowStart: period?.periodStartDate
          ? computeF2fWindow(period.periodStartDate, orgTimeZone).windowStart
          : null,
        authoritativeWindowEnd: period?.periodStartDate
          ? computeF2fWindow(period.periodStartDate, orgTimeZone).windowEnd
          : null,
      });
      events.push("m6.f2f.scheduled");
      return summary(rec);
    },
    async getF2f(organizationId, id) {
      const rec = get(organizationId, id, "f2f");
      return rec
        ? {
            ...summary(rec),
            electionPeriodId: rec.electionPeriodId,
            scheduledClinicianId: rec.scheduledClinicianId,
            scheduledDate: rec.scheduledDate,
            requestedWindowStart: rec.requestedWindowStart,
            requestedWindowEnd: rec.requestedWindowEnd,
            authoritativeWindowStart: rec.authoritativeWindowStart,
            authoritativeWindowEnd: rec.authoritativeWindowEnd,
          }
        : null;
    },
    async completeF2f(organizationId, id, ifVersion, encounterDate, modality) {
      void encounterDate;
      void modality;
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      return transition(rec, "completed", ifVersion);
    },
    async attestF2f(
      organizationId,
      id,
      ifVersion,
      actorUserId,
      attestationNarrative,
      signedNoteEncounterId,
    ) {
      void actorUserId;
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      // GAP-022 — R-F2F-04: the >= 100-char narrative guard runs through the real machine. The in-memory
      // store has no M8 notes to validate a linked note against, so the signed-note path is refused here.
      if (signedNoteEncounterId) {
        throw new AdmissionStateError(
          "F2F_ATTESTATION_NOTE_INVALID",
          "The linked clinical note was not found",
        );
      }
      transitionFaceToFace("completed", {
        type: "attest",
        narrative: attestationNarrative,
        performerIsActor: true,
      });
      return transition(rec, "attested", ifVersion, "m6.f2f.attested");
    },
    async overrideF2fWindow(organizationId, id, reason, ifVersion, actorUserId) {
      void reason;
      void actorUserId;
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      return transition(rec, rec.state, ifVersion, "m6.f2f.window_overridden");
    },

    async changeLoc(
      organizationId,
      admissionId,
      newLevel,
      facilityId,
      effectiveStart,
      reason = "",
    ) {
      void effectiveStart;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const needsIpuBed =
        newLevel === "inpatient_respite_care" || newLevel === "general_inpatient_care";
      if (needsIpuBed && !facilityId) {
        throw new AdmissionStateError("IPU_FACILITY_REQUIRED", "IRC/GIP requires a facility_id");
      }
      if (newLevel === "general_inpatient_care" && reason.trim().length < 30) {
        throw new AdmissionStateError(
          "GIP_DOCUMENTATION_INSUFFICIENT",
          "GIP requires ≥ 30 characters of uncontrolled-symptom / end-of-life documentation",
        );
      }
      const rec = insert("loc", organizationId, needsIpuBed ? "assigning" : "active", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      if (!needsIpuBed) events.push("m6.loc.changed");
      return summary(rec);
    },
    async listLoc(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "loc")
        .filter((r) => r.admissionId === admissionId)
        .map(summary);
    },
    async patchLoc(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "loc") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },
    async confirmLocBedAssignment(organizationId, locPeriodId, ifVersion) {
      const rec = get(organizationId, locPeriodId, "loc") ?? notFound(locPeriodId);
      if (rec.state !== "assigning") {
        throw new AdmissionStateError(
          "ILLEGAL_TRANSITION",
          `level-of-care period cannot ipuConfirmBedAssignment from '${rec.state}'`,
        );
      }
      return transition(rec, "active", ifVersion, "m6.loc.changed");
    },

    async createRevocation(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      adm.state = "discharged";
      adm.version += 1;
      const rec = insert("revocation", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
        effectiveAt: input.revocationDate,
        signedAt: input.revocationDate,
        signerKind: input.signingRole === "legal_representative" ? "representative" : "patient",
        revocationReason: input.revocationReason,
        narrative: input.narrative,
        // signingPatientName intentionally not stored — see RevocationInput's doc comment.
      });
      events.push("m6.revocation.created");
      events.push("m6.admission.discharged");
      return summary(rec);
    },
    async transferOut(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      adm.state = "discharged";
      adm.version += 1;
      const rec = insert("transfer", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
        direction: "out",
        effectiveAt: input.effectiveDate,
        otherHospiceName: input.otherHospiceName,
        otherHospiceCcn: input.otherHospiceCcn ?? null,
        receivingCareSetting: input.receivingCareSetting,
        narrative: input.narrative,
      });
      events.push("m6.transfer.created");
      events.push("m6.admission.discharged");
      return summary(rec);
    },
    async transferIn(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      // W-DC-03 / D9: the receiving hospice inherits the carried sequence as the ACTIVE period (no CTI
      // required from us) and opens the next PENDING period (our CTI required). No counter restart.
      const periodConflict = transferInPeriodConflict(
        listOfKind(organizationId, "election_period")
          .filter((r) => r.admissionId === adm.id)
          .map((r) => r.sequence ?? 1),
        input.priorBenefitPeriodSequence,
      );
      if (periodConflict)
        throw new AdmissionStateError(periodConflict.code, periodConflict.message);
      const plan = planTransferIn(input);
      insert("election_period", organizationId, plan.inherited.state, {
        admissionId: adm.id,
        patientId: adm.patientId,
        sequence: plan.inherited.sequence,
        periodStartDate: input.priorElectionStartDate,
      });
      // Contiguous benefit periods (42 CFR 418.21(a)): ours starts the day after the inherited one ends.
      const nextStart = addCalendarDays(
        electionPeriodScheduledEnd(
          input.priorElectionStartDate,
          electionPeriodKindForSequence(plan.inherited.sequence),
        ),
        1,
      );
      const nextPeriod = insert("election_period", organizationId, plan.next.state, {
        admissionId: adm.id,
        patientId: adm.patientId,
        sequence: plan.next.sequence,
        periodStartDate: nextStart,
      });
      // D9 — draft OUR CTI against the next period (the inherited period runs on the sending
      // hospice's certification, no CTI required from us).
      insert("cti", organizationId, "drafted", {
        admissionId: adm.id,
        electionPeriodId: nextPeriod.id,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        sequence: plan.next.sequence,
        periodStartDate: nextStart,
      });
      const rec = insert("transfer", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
        direction: "in",
        effectiveAt: input.effectiveDate,
        otherHospiceName: input.otherHospiceName,
        otherHospiceCcn: input.otherHospiceCcn ?? null,
        narrative: input.narrative,
      });
      events.push("m6.transfer.created");
      events.push("m6.election.period_started");
      events.push("m6.cti.drafted");
      return {
        ...summary(rec),
        currentElectionPeriodSequence: plan.inherited.sequence,
      };
    },
    async discharge(organizationId, admissionId, input, actorUserId) {
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      // §6.3 — the per-reason narrative gates (D11 tightens no_longer_terminal/other; for_cause needs a
      // forCauseReason). The reason→permission key is already enforced at the route preHandler.
      const issue = checkDischargeNarrative(
        input.reason,
        input.narrative,
        input.forCauseReason,
        input.deathCertifierId,
      );
      if (issue) throw new AdmissionStateError(issue.code, issue.message);
      // 42 CFR 418.26(b) — the physician discharge order (required for live discharges from 2026-10-01).
      const order = await validateDischargeOrder({
        port: physicianAuthority,
        organizationId,
        patientId: adm.patientId ?? "",
        reason: input.reason,
        dischargeDate: input.dischargeDate,
        order: input.dischargeOrder,
        now: now(),
      });
      const orderFacts: Partial<Rec> = order
        ? {
            dischargeOrderSignedByUserId: order.signedByUserId,
            dischargeOrderCapacity: order.capacity,
            dischargeOrderSignedAt: order.signedAt.toISOString(),
            dischargeOrderText: order.orderText,
            dischargeOrderReference: order.orderReference,
          }
        : {};
      const placeOfDeath = resolvePlaceOfDeath(
        input.reason,
        input.placeOfDeath,
        input.externalSource !== undefined,
      );
      const placeIssue = checkPlaceOfDeath(input.reason, placeOfDeath);
      if (placeIssue)
        throw new AdmissionStateError(
          placeIssue.code,
          placeIssue.message,
          issueDetails(placeIssue),
        );
      const requiresMedicalDirectorCosign = dischargeRequiresCosign(input.reason);
      events.push("m6.discharge.created");
      if (requiresMedicalDirectorCosign) {
        // W-DC-02 / D11 — filing a for-cause discharge does NOT discharge the admission; it stays
        // `active` with a pending flag until the medical director cosigns via route 40.
        const filing = fileForCauseDischarge();
        adm.pendingForCauseDischarge = true;
        const rec = insert("discharge", organizationId, filing.dischargeState, {
          admissionId: adm.id,
          patientId: adm.patientId,
          reason: input.reason,
          effectiveAt: input.dischargeDate,
          filedByUserId: actorUserId,
        });
        return {
          ...summary(rec),
          requiresMedicalDirectorCosign,
          reason: input.reason,
        };
      }
      // Every other reason discharges immediately. `death` routes the admission to `bereavement`
      // (§2.3.1) and runs the M6-owned bereavement-eligibility rule (W-DC-01); the rest → `discharged`.
      const isDeath = input.reason === "death";
      adm.state = isDeath ? "bereavement" : "discharged";
      adm.version += 1;
      events.push("m6.admission.discharged");
      const rec = insert("discharge", organizationId, "completed", {
        admissionId: adm.id,
        patientId: adm.patientId,
        reason: input.reason,
        effectiveAt: input.dischargeDate,
        ...orderFacts,
      });
      if (isDeath) {
        events.push("m6.discharge.death");
        // W-DC-01: days on active election = earliest active period start → discharge date (≥1 day);
        // default to eligible when no period start is on file. Opt-out (M5) suppresses the event.
        const periodStart = listOfKind(organizationId, "election_period")
          .filter((p) => p.admissionId === adm.id && p.periodStartDate)
          .map((p) => p.periodStartDate as LocalDate)
          .sort()[0];
        const days = periodStart ? daysBetween(periodStart, input.dischargeDate) : 1;
        const { eligible } = decideBereavementEligibility({
          reason: input.reason,
          daysOnActiveElectionBeforeDeath: days,
          bereavementOptOut: adm.bereavementOptOut ?? false,
        });
        if (eligible) events.push("m6.bereavement.eligible");
      }
      return {
        ...summary(rec),
        requiresMedicalDirectorCosign,
        reason: input.reason,
      };
    },
    async cosignDischarge(organizationId, id, input, ifVersion, actorUserId) {
      const rec = get(organizationId, id, "discharge") ?? notFound(id);
      // GAP-121 — two-person control: the person who filed a for-cause discharge cannot cosign it.
      if (rec.filedByUserId && rec.filedByUserId === actorUserId)
        throw new ChartWardenError(
          "DISCHARGE_COSIGNER_IS_FILER",
          "The person who filed a for-cause discharge cannot cosign it; another medical director must.",
          409,
        );
      // 42 CFR 418.26(b) — the cosigner is the discharge-order signer (the actor; server-derived roles).
      const capacity = await resolveCosignerCapacity({
        port: physicianAuthority,
        organizationId,
        actorUserId,
        actorRoleKeys: input.actorRoleKeys ?? [],
        patientId: rec.patientId ?? null,
        dischargeDate: rec.effectiveAt ?? now().toISOString().slice(0, 10),
        externalDeath: false,
        claimed: input.capacity,
      });
      rec.dischargeOrderSignedByUserId = actorUserId;
      rec.dischargeOrderCapacity = capacity;
      rec.dischargeOrderSignedAt = now().toISOString();
      rec.dischargeOrderText = input.orderText ?? null;
      rec.dischargeOrderReference = input.orderReference ?? null;
      rec.cosignedAt = now().toISOString();
      rec.cosignerName = input.cosignerName;
      rec.cosignerNpi = input.cosignerNpi;
      // W-DC-02 — the medical-director cosign completes the discharge AND discharges the admission that
      // was held `active` with the pending flag while awaiting governance sign-off (D11).
      const outcome = resolveForCauseDischarge("cosign");
      const res = transition(rec, outcome.dischargeState, ifVersion, "m6.discharge.cosigned");
      if (rec.admissionId) {
        const adm = get(organizationId, rec.admissionId, "admission");
        if (adm) {
          adm.state = outcome.admissionState;
          adm.pendingForCauseDischarge = outcome.pendingForCauseDischarge;
          adm.version += 1;
          events.push("m6.admission.discharged");
        }
      }
      return res;
    },

    async declineDischarge(organizationId, id, _input, ifVersion, _actorUserId) {
      const rec = get(organizationId, id, "discharge") ?? notFound(id);
      if (rec.state !== "awaiting_cosign")
        throw new ChartWardenError(
          "INVALID_STATE",
          `discharge ${id} is not awaiting a medical-director cosign (state '${rec.state}')`,
          409,
        );
      // GAP-121 — a decline voids the discharge and releases the admission (it never left `active`).
      const outcome = resolveForCauseDischarge("reject");
      const res = transition(rec, outcome.dischargeState, ifVersion);
      if (rec.admissionId) {
        const adm = get(organizationId, rec.admissionId, "admission");
        if (adm) {
          adm.pendingForCauseDischarge = outcome.pendingForCauseDischarge;
          adm.version += 1;
        }
      }
      return res;
    },

    async recordAdmissionRecommendation(
      organizationId,
      admissionId,
      input,
      ifVersion,
      actorUserId,
    ) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      if (adm.version !== ifVersion) throw new VersionMismatchError(adm.id, adm.version, ifVersion);
      if (RECOMMENDATION_CLOSED_STATES.has(adm.state))
        throw new AdmissionStateError(
          "ADMISSION_RECOMMENDATION_INVALID",
          `admission ${admissionId} is ${adm.state}; a recommendation can no longer be recorded`,
        );
      const capacity = await validateAdmissionRecommendation({
        port: physicianAuthority,
        organizationId,
        patientId: adm.patientId ?? "",
        hasAttendingPhysician: !!adm.attendingPhysicianId,
        input,
        now: now(),
      });
      adm.recommendation = {
        recommendedByUserId: input.recommendedByUserId,
        capacity,
        recommendedAt: new Date(input.recommendedAt).toISOString(),
        attendingConsulted: input.attendingConsulted,
        attendingConsultNote: input.attendingConsultNote ?? null,
      };
      adm.version += 1;
      return summary(adm);
    },
    async getDischargeOrder(organizationId, admissionId) {
      const adm = get(organizationId, admissionId, "admission");
      if (!adm) return null;
      const de = listOfKind(organizationId, "discharge").find((r) => r.admissionId === adm.id);
      if (!de) return { discharge: null };
      return {
        discharge: {
          dischargeEventId: de.id,
          reason: de.reason ?? "other",
          status: de.state,
          dischargeDate: de.effectiveAt ?? "",
          orderRequired: dischargeOrderRequired(de.reason ?? "other", de.effectiveAt ?? ""),
          order:
            de.dischargeOrderSignedByUserId && de.dischargeOrderCapacity
              ? {
                  signedByUserId: de.dischargeOrderSignedByUserId,
                  signedByName: seed.userNames?.[de.dischargeOrderSignedByUserId] ?? null,
                  capacity: de.dischargeOrderCapacity,
                  signedAt: de.dischargeOrderSignedAt ?? "",
                  orderText: de.dischargeOrderText ?? null,
                  orderReference: de.dischargeOrderReference ?? null,
                }
              : null,
          cosigner:
            de.cosignerName && de.cosignerNpi
              ? { name: de.cosignerName, npi: de.cosignerNpi, cosignedAt: de.cosignedAt ?? null }
              : null,
        },
      };
    },
    async getDischargeCosignContext(organizationId, dischargeEventId, actorUserId) {
      const de = get(organizationId, dischargeEventId, "discharge");
      if (
        !de ||
        !["pending_cosign", "awaiting_cosign"].includes(de.state) ||
        de.filedByUserId === actorUserId ||
        !de.admissionId
      )
        return null;
      return {
        dischargeEventId: de.id,
        admissionId: de.admissionId,
        status: "pending_cosign",
        dischargeEventVersion: de.version,
        dischargeDate: de.effectiveAt ?? "",
      };
    },
    async listPhysicianSigners(organizationId, admissionId) {
      const adm = get(organizationId, admissionId, "admission");
      if (!adm) return null;
      return {
        items: await physicianAuthority.listSignerCandidates(organizationId, adm.patientId ?? ""),
      };
    },

    async acknowledgeNor(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("nor", organizationId, "acknowledged", {
        admissionId: adm.id,
        patientId: adm.patientId,
        deliveryMethod: input.deliveryMethod,
        acknowledgedByRole: input.acknowledgedByRole,
        acknowledgedAtInstant: input.acknowledgedAt ?? null,
        acknowledgedByName: input.acknowledgedByName ?? null,
      });
      events.push("m6.nor.acknowledged");
      // W-AD-04: acknowledging the NOR closes its open compliance window (admission.recompute_windows).
      const window = listOfKind(organizationId, "compliance_window").find(
        (w) => w.admissionId === adm.id && w.state === "open",
      );
      if (window) {
        window.state = "closed";
        window.version += 1;
        events.push("m6.compliance.window.closed");
      }
      return summary(rec);
    },
    async getNor(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      const rec = listOfKind(organizationId, "nor").find((r) => r.admissionId === admissionId);
      return rec
        ? {
            ...summary(rec),
            acknowledgedAtInstant: rec.acknowledgedAtInstant,
            acknowledgedByName: rec.acknowledgedByName,
            acknowledgedByRole: rec.acknowledgedByRole,
            deliveryMethod: rec.deliveryMethod,
          }
        : null;
    },

    async listComplianceWindowsForAdmission(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "compliance_window")
        .filter((r) => r.admissionId === admissionId)
        .map(summary);
    },
    async listComplianceWindows(organizationId, query, scope) {
      let rows = listOfKind(organizationId, "compliance_window");
      const ids = scope?.patientIds ?? null;
      if (ids !== null) rows = rows.filter((r) => !!r.patientId && ids.includes(r.patientId));
      if (query.state) rows = rows.filter((r) => r.state === query.state);
      return page(rows.map(summary), query);
    },
    async closeComplianceWindow(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "compliance_window") ?? notFound(id);
      return transition(rec, "closed", ifVersion, "m6.compliance.window.closed");
    },
    async overrideComplianceWindow(organizationId, id, reason, ifVersion, actorUserId) {
      void reason;
      void actorUserId;
      const rec = get(organizationId, id, "compliance_window") ?? notFound(id);
      return transition(rec, "closed", ifVersion, "m6.compliance.window.overridden");
    },
  };

  /** GAP-011 — resolve `{patientId, providerEntityId}` off the `admission` record `admissionId`
   *  points to (the child record's own patientId, if any, is intentionally ignored — see the
   *  loader comments above). */
  const resolveAdmissionFacts = (
    organizationId: string,
    admissionId: string | undefined,
  ): AdmissionFacts | null => {
    if (!admissionId) return null;
    const adm = get(organizationId, admissionId, "admission");
    return adm?.patientId
      ? {
          patientId: adm.patientId,
          providerEntityId: adm.providerEntityId ?? null,
          createdByUserId: adm.createdByUserId ?? null,
        }
      : null;
  };

  const resolver: AdmissionAbacResolver = {
    async loadReferral(organizationId, id) {
      const rec = get(organizationId, id, "referral");
      return rec
        ? {
            locationId: rec.locationId ?? null,
            providerEntityId: rec.providerEntityId ?? null,
          }
        : null;
    },
    async loadAdmission(organizationId, id) {
      const rec = get(organizationId, id, "admission");
      return rec?.patientId
        ? {
            patientId: rec.patientId,
            providerEntityId: rec.providerEntityId ?? null,
            locationId: rec.locationId ?? null,
            createdByUserId: rec.createdByUserId ?? null,
          }
        : null;
    },
    async loadCti(organizationId, id) {
      const rec = get(organizationId, id, "cti");
      return rec?.hospiceMedicalDirectorId
        ? {
            hospiceMedicalDirectorId: rec.hospiceMedicalDirectorId,
            attendingPhysicianId: rec.attendingPhysicianId ?? null,
          }
        : null;
    },
    async loadF2f(organizationId, id) {
      const rec = get(organizationId, id, "f2f");
      return rec?.scheduledClinicianId ? { scheduledClinicianId: rec.scheduledClinicianId } : null;
    },
    async loadComplianceWindow(organizationId, id) {
      const rec = get(organizationId, id, "compliance_window");
      return rec?.admissionId && rec.patientId
        ? {
            admissionId: rec.admissionId,
            patientId: rec.patientId,
            providerEntityId: rec.providerEntityId ?? null,
          }
        : null;
    },
    // GAP-011 — resolve the owning admission's scope facts for a child resource. `patientId` is read
    // off the ADMISSION record (never the child), matching the Drizzle resolver's join-through
    // behavior: `cti`/`f2f` records never carry `patientId` directly (see `draftCti`/`scheduleF2f`
    // above), so joining through `admission` is the only path that works for every kind uniformly.
    async loadElectionPeriodScope(organizationId, id) {
      const rec = get(organizationId, id, "election_period");
      return resolveAdmissionFacts(organizationId, rec?.admissionId);
    },
    async loadElectionStatementScope(organizationId, id) {
      const rec = get(organizationId, id, "election_statement");
      return resolveAdmissionFacts(organizationId, rec?.admissionId);
    },
    async loadCtiScope(organizationId, id) {
      const rec = get(organizationId, id, "cti");
      return resolveAdmissionFacts(organizationId, rec?.admissionId);
    },
    async loadF2fScope(organizationId, id) {
      const rec = get(organizationId, id, "f2f");
      return resolveAdmissionFacts(organizationId, rec?.admissionId);
    },
    async loadLocScope(organizationId, id) {
      const rec = get(organizationId, id, "loc");
      return resolveAdmissionFacts(organizationId, rec?.admissionId);
    },
    async loadDischargeSigning(organizationId, id) {
      const rec = get(organizationId, id, "discharge");
      return rec
        ? {
            patientId: rec.patientId ?? null,
            dischargeDate: rec.effectiveAt ?? now().toISOString().slice(0, 10),
            externalDeath: false,
          }
        : null;
    },
    // The slice has no patient table: a patient "exists in the org" when a `patient` record or any of the
    // org's records names it (the Drizzle resolver asks M5's org-scoped patient read instead).
    async loadPatientIntakeFacts(organizationId, patientId) {
      const ofOrg = [...byId.values()].filter((r) => r.organizationId === organizationId);
      const known = ofOrg.some(
        (r) => (r.kind === "patient" && r.id === patientId) || r.patientId === patientId,
      );
      if (!known) return null;
      const stays = ofOrg.filter((r) => r.kind === "admission" && r.patientId === patientId);
      const chart = ofOrg.find((r) => r.kind === "patient" && r.id === patientId);
      return {
        hasActiveOrOnHoldAdmission: stays.some(
          (r) => r.state === "active" || r.state === "on_hold",
        ),
        hasAnyAdmission: stays.length > 0,
        providerEntityId: chart?.providerEntityId ?? null,
        locationId: chart?.locationId ?? null,
        ...referralSiteOf(ofOrg, patientId),
      };
    },
  };

  return { service, resolver, physicianAuthority, events };
}
