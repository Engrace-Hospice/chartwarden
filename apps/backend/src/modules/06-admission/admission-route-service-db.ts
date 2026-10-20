// apps/backend/src/modules/06-admission — PRODUCTION AdmissionRouteService (M6L-T01 reads, T02–T03 writes).
//
// READS (referral inbox, admission census + detail, election periods, compliance windows) run as real
// Drizzle queries under `withOrgContext`, RLS-scoped as the unprivileged `wardenx_app` role. The WRITE
// lifecycle is real for T02 (referral intake → triage → accept → draft-from-referral cascade → NOR ack →
// activate → hold/resume), T03 (election statement draft/sign/void; election period create/patch; CTI
// draft/hospice-MD sign [recert activates its period]/attending sign/void/mark-late), and T04 (F2F
// schedule/complete/attest/window-override; LOC change/patch; revocation; transfer in/out; discharge with
// the D11 for-cause file → medical-director cosign cascade, death → bereavement). Each write drives the
// §2.3.1/2.3.4/2.3.5 pure state machines, enforces optimistic concurrency (stale `ifVersion` → 409),
// executes the §2.5 declarative effects (windows open/close, LOC + election-period end cascades), and
// emits `m6.*` on the transactional outbox. T05 (compliance-window close/override) completes the surface:
// the WHOLE M6 write lifecycle is now real Drizzle — no route left at 501.

import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  type PatientAdmissionClearance,
  type PatientAdmissionClearanceReader,
  type PatientIntakeResolver,
  ValidationError,
  WardenXError,
  isValidMedicaidNumber,
  isValidMedicareNumber,
  normalizeMedicaidNumber,
  normalizeMedicareNumber,
} from "@wardenx/types";
import type { LevelOfCare, LocalDate } from "@wardenx/types";
import {
  type AnyColumn,
  type SQL,
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { getSeam } from "../../bootstrap/index";
import { readCurrentResidenceAddress } from "../05-patient/address-reader";
import { getMdmEntityProvider } from "../40-mdm/seams";
import type { ActorSite } from "./actor-site";
import { createDocumentReaderEvidenceValidator } from "./admission-document-validator";
import {
  type AdmissionEvidenceDocumentValidator,
  createAdmissionEvidenceService,
} from "./admission-evidence-service";
import {
  requirementsForUploadedCti,
  requirementsForUploadedElectionStatement,
  requirementsForUploadedNoticeOfRights,
} from "./admission-uploaded-evidence";
import { type F2fPerformerRole, resolveF2fPerformerRole } from "./certification/f2f-performer";
import {
  assertPlausibleEncounterDate,
  expectedStartFromPriorEnd,
} from "./certification/f2f-window";
import {
  type AssessmentWindowKind,
  addCalendarDays,
  computeAssessmentWindowDeadline,
  computeCtiSignatureDueAt,
  computeF2fWindow,
  computeWrittenCertDeadline,
  isAssessmentWindowKind,
  localDateOfInstant,
} from "./certification/window-math";
import { resolveForCauseDischarge } from "./discharge/for-cause";
import {
  type DischargeReason,
  checkDischargeNarrative,
  checkPlaceOfDeath,
  dischargeRequiresCosign,
  issueDetails,
  resolvePlaceOfDeath,
} from "./discharge/permission-map";
import {
  type TransferInInput,
  planTransferIn,
  transferInPeriodConflict,
  transferInSourceRefusal,
} from "./discharge/transfer-in";
import { addendumRequiredForElection } from "./election-addendum/due-dates";
import {
  exemptionReasonForDischarge,
  listAddendumVersions,
  loadAddendumAdmissionFacts,
  openAddendumWindows,
  openInitialAddendumInTx,
  settleAddendumOnLeavingCareInTx,
} from "./election-addendum/store";
import {
  CTI_STATUS_RANK,
  ELECTION_STATEMENT_STATUS_RANK,
  F2F_STATUS_RANK,
  pickOnePerPeriod,
} from "./election-cert-picks";
import { completeActiveElectionPeriod } from "./election-period-completion";
import {
  type AdmissionReadinessFacts,
  type AdmissionReadinessResult,
  computeActivationGate,
  evaluateAdmissionReadiness,
} from "./intake";
import { F2F_EXCEPTION_DAYS_AFTER_ADMISSION } from "./intake/benefit-period";
import { type PhysicianAuthorityPort, dischargeOrderRequired } from "./physician-authority";
import { createDbPhysicianAuthority } from "./physician-authority-db";
import {
  resolveCosignerCapacity,
  validateAdmissionRecommendation,
  validateDischargeOrder,
} from "./physician-signer-checks";
import { resolveFirstBenefitPeriod } from "./readmission-service-db";
import {
  DEFAULT_ORG_TZ,
  assertRecertPeriodReady,
  hasAttestedF2f,
  predecessorHandsOver,
  recertPeriodContextInTx,
  resolvePeriodF2fWindowStart,
  startRecertPeriodInTx,
} from "./recert-period-activation";
import { referralPatientFields } from "./referral-patient-fields";
import {
  type RenderBuildCtx,
  type RenderSourcesPort,
  buildCtiRenderPayload,
  buildDischargeRenderPayload,
  buildF2fRenderPayload,
  buildNorRenderPayload,
  buildOrOmit,
  buildRevocationRenderPayload,
  buildTransferRenderPayload,
  createSeamRenderSources,
} from "./render-payloads";
import type {
  CosignDischargeInput,
  CtiDraftInput,
  DeclineDischargeInput,
  DischargeInput,
  DischargeResult,
  F2fScheduleInput,
  ReferralActivityView,
  ReferralNoteView,
  ReferralReadView,
  RevocationInput,
  TransferOutInput,
} from "./routes/service";
import {
  ActivationPreconditionError,
  ExternalReferralAlreadyIngestedError,
  InvalidReferralStateError,
  LocationProviderMismatchError,
  RECOMMENDATION_CLOSED_STATES,
  ReferralAdmissionPathError,
  ReferralAlreadyConvertedError,
  ReferralNotReadyError,
  ReferralNotTriagedError,
  ResourceNotFoundError,
  SIGNER_KIND_BY_ROLE,
  VersionMismatchError,
} from "./routes/service";
import type {
  AdmissionAbacResolver,
  AdmissionDetail,
  AdmissionRouteService,
  ComplianceWindowRow,
  MutationResult,
  Page,
  PatientAdmissionSummary,
  PatientElectionCertificationView,
  SummaryRow,
} from "./routes/service";
import {
  type AdmissionEvent,
  type AdmissionState,
  transitionAdmission,
} from "./state-machines/admission";
import { planDischarge, planRevocation, planTransferOut } from "./state-machines/commands";
import type { SideEffect } from "./state-machines/effects";
import {
  type ElectionPeriodState,
  RECERT_SEQUENCE_FLOOR,
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
  transitionElectionPeriod,
} from "./state-machines/election-period";
import { AdmissionStateError, ELECTION_STATEMENT_CONFLICT_MESSAGE } from "./state-machines/errors";
import type { SignedNoteFacts } from "./state-machines/f2f-attestation-rules";
import { type FaceToFaceState, transitionFaceToFace } from "./state-machines/face-to-face";
import { type LevelOfCareState, transitionLevelOfCare } from "./state-machines/level-of-care";
import { TEXT_MINIMUMS } from "./state-machines/validation";
import { mapUniqueViolation } from "./unique-violation";

/**
 * The transactional-outbox port (§4.4): the composition root binds M1's catalog-validating publisher
 * pinned to caller-module `m6`; `publish` writes the `outbox_event` row on the CALLER'S tx. The default
 * is a no-op so the slice/tests commit without a dispatcher (the state + windows are the load-bearing
 * effects; downstream consumers ride the outbox once it is wired at the mount).
 */
export interface AdmissionWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: AdmissionWriteOutboxPort = { async publish() {} };

/**
 * The real §2.3.5 "bedId verified with M37" check — M37's `IpuBedAssignmentProvider` seam narrowed to
 * the one method `confirmLocBedAssignment` needs. Optional: an absent binding fails the confirm route
 * closed with a precise 503 rather than silently trusting an unverified bed (matches the M24 composition-
 * root reader posture — degrade with a message, never fake success).
 */
/**
 * Confirms a provider entity belongs to THIS org (#44). `provider_entity` is an M1 FOUNDATION table
 * that M6 does not own and must not import (`arch:tables`: cross-module reads go through the owner's
 * service, never its schema), so the check is injected from the composition root.
 *
 * It is needed because the FK on `election_statement.provider_entity_id` / `admission.provider_entity_id`
 * is a plain single-column reference with no organization in it — nothing at the database level stops
 * one tenant from electing another tenant's hospice. While the field was being discarded that was
 * moot; persisting it makes the check load-bearing.
 *
 * Optional, and an absent binding fails the draft route CLOSED with a precise 503 rather than writing
 * an unverified provider entity — the same posture as {@link IpuBedAssignmentReaderPort} below.
 */
export interface ProviderEntityOrgCheckPort {
  belongsToOrg(organizationId: string, providerEntityId: string): Promise<boolean>;
}

/**
 * Lists the ACTIVE service locations under a provider entity (#50) — how activation sites an admission.
 *
 * Same reasoning as {@link ProviderEntityOrgCheckPort}: `location` is an M1 FOUNDATION table M6 does not
 * own and must not import, so the composition root binds it.
 *
 * `admission.location_id` was never written by ANY code path — no route accepted a location, no
 * transition assigned one, nothing backfilled it. It is the second half of the #44 siting gap, and it
 * kept every admission unsited at the location level: M10 refuses to create a HOPE timepoint schedule
 * (`hope_timepoint_schedule.location_id` is NOT NULL), M10's D8 compensating validation finding cannot
 * be written for the same reason, and every M9 capture is recorded with a null location.
 *
 * Optional. An absent binding leaves the admission unsited rather than blocking activation: the
 * admission is ALREADY unsited today, and turning a data gap into an availability outage would be the
 * wrong trade — the downstream modules already refuse loudly on their own behalf.
 */
export interface ProviderEntityLocationPort {
  activeLocationsFor(organizationId: string, providerEntityId: string): Promise<readonly string[]>;
}

/**
 * GAP-022 — the role keys a user ACTUALLY holds in this org (enabled roles on unexpired assignments), the
 * authority the F2F performer role is derived from. Memberships / roles are M3's tables, so the lookup is
 * injected from the composition root. `null` = the user has no live membership in the org. An absent
 * binding fails a human-driven schedule CLOSED (503) rather than trusting the request body's role.
 */
export interface F2fClinicianRolePort {
  roleKeysForUser(organizationId: string, userId: string): Promise<readonly string[] | null>;
}

/**
 * FY2027 R-F2F-06 (42 CFR 418.22(b)(4)) — the facts of one M8 clinical note, for the signed-note F2F
 * attestation. Encounters are M8's table, so the read is injected from the composition root (bound over
 * M8's `signedEncounterNoteForOrg`). `null` = no such encounter in this org. An ABSENT binding refuses the
 * signed-note path (503) rather than accepting an unverified note; the written-narrative path is unaffected.
 */
export interface F2fSignedNotePort {
  signedNoteFor(organizationId: string, encounterId: string): Promise<SignedNoteFacts | null>;
}

/**
 * R-EL-01 — does this patient have an ACTIVE M39 `dpoa_healthcare` consent right now?
 *
 * The one fact `transitionElectionPeriod`'s `signElectionStatement` guard needs that M6 cannot resolve
 * itself: the consent record lives in M39's tables, which M6 must not import (§2.5). Bound at the
 * composition root over M39's `ConsentStore`, the same way {@link ProviderEntityOrgCheckPort} is bound
 * over M1's `provider_entity`.
 *
 * Absent binding DENIES a representative-signed election rather than allowing it. That is the opposite
 * default from {@link ProviderEntityLocationPort} on purpose: an unsited admission is a data gap, while
 * an unverified representative signature is a legal record asserting an authority nobody checked — and
 * the rule this port exists for has been unenforced since M6 shipped, so "allow when unbound" is the
 * exact state being fixed. A PATIENT-signed election never reaches this port.
 */
export interface DpoaConsentCheckPort {
  hasActiveDpoaHealthcareConsent(organizationId: string, patientId: string): Promise<boolean>;
}

export interface IpuBedAssignmentReaderPort {
  activeBedAssignmentForLevelOfCarePeriod(
    organizationId: string,
    levelOfCarePeriodId: string,
  ): Promise<{
    ipuAdmissionId: string;
    bedAssignmentId: string;
    bedId: string;
  } | null>;
}

type ReferralSourceChannel =
  | "phone"
  | "fax"
  | "portal"
  | "walk_in"
  | "self_referral"
  | "physician_office"
  | "hospital_discharge_planner";

/** First row of a `RETURNING`/`SELECT` under `noUncheckedIndexedAccess`, or a 404 (unreachable after a write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new WardenXError("NOT_FOUND", msg, 404);
  return r;
}

/** Structured, PHI-free report that a typed render payload could not be built (ids and paths only). */
const logRenderPayload = (event: string, detail: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
};

const REF = schema.referrals;
const ADM = schema.admissions;
const EP = schema.electionPeriods;
const ES = schema.electionStatements;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const LOC = schema.levelOfCarePeriods;
const NOR = schema.noticeOfRightsAcknowledgments;
const CW = schema.complianceWindows;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;
const RE = schema.revocationEvents;
const RA = schema.referralActivities;
const RN = schema.referralNotes;

/**
 * F-223 — the ONE place a PENDING election-period shell is opened: next `sequence_number`, the §418.21(a)
 * `period_kind`, the expected start and the row, all on the caller's tx. Shared by the HTTP
 * route (`createElectionPeriod`) and the `m11.order.recertification_signed` consumer so the insert logic is
 * never duplicated. It opens a PENDING shell only: the F2F/CTI adequacy gate is enforced at the recert CTI
 * signature and again at ACTIVATION (`recert-period-activation.ts`), never here, so calling this cannot bypass it.
 *
 * `sourceOrderId` (logical M11 order id, migration 0297) is stamped by the consumer. When it is given the
 * insert is `ON CONFLICT DO NOTHING` (either `(admission, sequence)` — staff already opened the period —
 * or `(org, source_order_id)` — a redelivery) and `null` is returned instead of a 23505 that would abort
 * the transaction; the route (no `sourceOrderId`) keeps the plain, throwing insert.
 */
export async function openNextElectionPeriodInTx(
  tx: DbClient,
  args: { organizationId: string; admissionId: string; sourceOrderId?: string },
): Promise<{ id: string; status: string; version: number; sequence: number } | null> {
  const { organizationId, admissionId, sourceOrderId } = args;
  const [adm] = await tx.select({ id: ADM.id }).from(ADM).where(eq(ADM.id, admissionId)).limit(1);
  if (!adm) throw new ResourceNotFoundError(admissionId);
  const [max] = await tx
    .select({ seq: sql<number>`coalesce(max(${EP.sequenceNumber}), 0)` })
    .from(EP)
    .where(eq(EP.admissionId, admissionId));
  const nextSequence = Number(max?.seq ?? 0) + 1;
  // F-226 - the pending period's EXPECTED START = the preceding period's scheduled_end_at + 1 day (benefit
  // periods are contiguous). Persisted so the F2F prior-to window can be computed against a real date when
  // the encounter is completed, long before activation stamps `effective_at`. NULL when the preceding
  // period has no scheduled end yet (not derivable; the window is then unverifiable and fails closed).
  const [prior] = await tx
    .select({ scheduledEndAt: EP.scheduledEndAt })
    .from(EP)
    .where(and(eq(EP.admissionId, admissionId), eq(EP.sequenceNumber, nextSequence - 1)))
    .limit(1);
  const expectedStart = expectedStartFromPriorEnd(prior?.scheduledEndAt ?? null);
  const insert = tx.insert(EP).values({
    organizationId,
    admissionId,
    sequenceNumber: nextSequence,
    // 42 CFR 418.21(a): periods 1 and 2 are 90-day, every later period is 60-day. This was a
    // hard-coded `ninety_day` at every insert site, which is right only for the two seeds that
    // are always sequence 1 — a recert period and a transfer-in's carried sequence can be any
    // number, and the kind is what `scheduled_end_at` is derived from.
    periodKind: electionPeriodKindForSequence(nextSequence),
    ...(expectedStart ? { expectedStart } : {}),
    ...(sourceOrderId ? { sourceOrderId } : {}),
  });
  const returning = { id: EP.id, status: EP.status, version: EP.version };
  let ep: { id: string; status: string; version: number } | undefined;
  if (sourceOrderId) {
    [ep] = await insert.onConflictDoNothing().returning(returning);
    if (!ep) return null;
  } else {
    ep = firstOrThrow(await insert.returning(returning), "election period insert returned no row");
  }
  // No `m6.election.period_started` here: a pending shell has not started. The event fires once, when the
  // period actually becomes active on its start date (`recert-period-activation.ts`) — announcing it at
  // creation as well emitted it twice, the first time up to weeks before the benefit period began.
  return { id: ep.id, status: ep.status, version: Number(ep.version), sequence: nextSequence };
}

/** §4.2.7 discharge reason → the §2.3.1 `executeDischarge` discriminator the pure state machine reads. */
const REASON_TO_SM_TYPE: Record<
  DischargeReason,
  "death" | "moved" | "no_longer_terminal" | "for_cause" | "routine"
> = {
  death: "death",
  moved_out_of_service_area: "moved",
  no_longer_terminal: "no_longer_terminal",
  for_cause: "for_cause",
  other: "routine",
};
/** §4.2.7 discharge reason → the `discharge_type` enum persisted on the discharge_event row. */
const REASON_TO_DB_TYPE: Record<
  DischargeReason,
  "death" | "moved_out_of_service_area" | "no_longer_terminal" | "for_cause" | "other"
> = {
  death: "death",
  moved_out_of_service_area: "moved_out_of_service_area",
  no_longer_terminal: "no_longer_terminal",
  for_cause: "for_cause",
  other: "other",
};
/** The four CMS levels of care — validates the free-string `newLevel` route 33 hands `changeLoc`. */
const LEVELS_OF_CARE: readonly LevelOfCare[] = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
];

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
/** The in-memory slice cursors on an integer offset (`String(offset)`); mirror it exactly. */
const parseOffset = (cursor?: string): number => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const toSummary = (r: {
  id: string;
  state: string;
  version: number;
  patientId?: string | null;
}): SummaryRow => ({
  id: r.id,
  state: r.state,
  version: Number(r.version),
  patientId: r.patientId ?? null,
});

/**
 * Referral intake's Medicare number: normalized ("1EG4-TE5-MK73" → "1EG4TE5MK73"), "" → null, and held
 * to the CMS MBI format — a typo is a 422 on the field, not a broken chart identifier later.
 */
function referralMedicareNumber(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const mbi = normalizeMedicareNumber(raw);
  if (!isValidMedicareNumber(mbi)) {
    throw new ValidationError("Medicare number is not a valid MBI", [
      {
        field: "medicareNumberAtReceipt",
        code: "INVALID_MBI",
        message: "Enter the 11-character Medicare Beneficiary Identifier (e.g. 1EG4-TE5-MK73).",
      },
    ]);
  }
  return mbi;
}

/** Referral intake's Medicaid number: normalized, "" → null, 1-14 letters/digits (HOPE A0700). */
function referralMedicaidNumber(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const id = normalizeMedicaidNumber(raw);
  if (!isValidMedicaidNumber(id)) {
    throw new ValidationError("Medicaid number is not valid", [
      {
        field: "medicaidNumberAtReceipt",
        code: "INVALID_MEDICAID_NUMBER",
        message: "Enter the Medicaid number: up to 14 letters and digits.",
      },
    ]);
  }
  return id;
}

function toReferralReadView(
  r: {
    id: string;
    status: string;
    version: number;
    patientId: string | null;
    patientResolutionStatus: string;
    patientNameAtReceipt: string;
    patientDobAtReceipt: string | null;
    medicareNumberAtReceipt: string | null;
    medicaidNumberAtReceipt: string | null;
    sexAssignedAtBirth: string | null;
    referringDxText: string | null;
    icd10TerminalPrimary: string | null;
    sourceChannel: string;
    referrerName: string | null;
    referrerOrganization: string | null;
    referrerPhone: string | null;
    externalReferralId: string | null;
    priority: string;
    assignedToUserId: string | null;
    receivedAt: Date;
    reviewedAt: Date | null;
    qualifiedAt: Date | null;
    declinedAt: Date | null;
    convertedAt: Date | null;
    convertedAdmissionId: string | null;
    rejectionReason: string | null;
  },
  qualificationBlockers: readonly { code: string; message: string }[],
): ReferralReadView {
  return {
    id: r.id,
    state: r.status,
    status: r.status,
    version: Number(r.version),
    patientId: r.patientId,
    patientResolutionStatus: r.patientResolutionStatus,
    patientNameAtReceipt: r.patientNameAtReceipt,
    patientDobAtReceipt: r.patientDobAtReceipt,
    medicareNumberAtReceipt: r.medicareNumberAtReceipt,
    medicaidNumberAtReceipt: r.medicaidNumberAtReceipt,
    sexAssignedAtBirth: r.sexAssignedAtBirth,
    referringDxText: r.referringDxText,
    icd10TerminalPrimary: r.icd10TerminalPrimary,
    source: r.sourceChannel,
    referrerName: r.referrerName,
    referrerOrganization: r.referrerOrganization,
    referrerPhone: r.referrerPhone,
    externalReferralId: r.externalReferralId,
    priority: r.priority,
    assignedToUserId: r.assignedToUserId,
    receivedAt: r.receivedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    qualifiedAt: r.qualifiedAt?.toISOString() ?? null,
    declinedAt: r.declinedAt?.toISOString() ?? null,
    convertedAt: r.convertedAt?.toISOString() ?? null,
    convertedAdmissionId: r.convertedAdmissionId,
    rejectionReason: r.rejectionReason,
    qualificationBlockers,
  };
}

const conflict = (msg: string): WardenXError => new WardenXError("INVALID_STATE", msg, 409);
/** Create-patient hit `patient_identifier_mbi_unique`: says nothing about WHO the existing patient is. */
const duplicatePatientMbi = (): ConflictError =>
  new ConflictError(
    "A patient with this Medicare number already exists in your organization. This may be a possible duplicate patient; review the referral and match the existing patient instead of creating a new one.",
  );

/**
 * §2.5 compliance-window deadlines from open instant (only the T02 `createAdmission` kinds). The two 42 CFR
 * 418.54 assessment windows are NOT here: their deadline is election-anchored calendar math
 * (`computeAssessmentWindowDeadline` — 48 hours, and election date as day 0 + 5 days), not a flat hour count.
 */
const WINDOW_HOURS: Record<string, number> = {
  care_plan_5d: 24 * 5,
  notice_of_rights: 48,
};

/** The 418.54 windows re-anchored on the election when the admission activates. */
const ASSESSMENT_WINDOW_KINDS: readonly AssessmentWindowKind[] = [
  "initial_assessment_48h",
  "comprehensive_assessment_5d",
];

/**
 * 42 CFR 418.54 — the initial (48 h) and comprehensive (election day 0 + 5) assessment clocks run from the
 * ELECTION, and activation is the election here (the first period's `effective_at` is the activation day). The
 * windows `createAdmission` opened were anchored on the DRAFT, which can precede the election by days — so every
 * still-open one is re-dated from `electedAt` (and back to `open`: a provisional deadline that lapsed before the
 * patient elected was never a real breach). A closed window is left alone.
 */
async function reanchorAssessmentWindows(
  tx: DbClient,
  admissionId: string,
  electedAt: Date,
): Promise<void> {
  for (const kind of ASSESSMENT_WINDOW_KINDS) {
    await tx
      .update(CW)
      .set({
        startsAt: electedAt,
        mustCompleteBy: computeAssessmentWindowDeadline(kind, electedAt, DEFAULT_ORG_TZ),
        status: "open",
        updatedAt: electedAt,
        version: sql`${CW.version} + 1`,
      })
      .where(
        and(
          eq(CW.admissionId, admissionId),
          eq(CW.windowKind, kind),
          inArray(CW.status, ["open", "closing_soon", "overdue"]),
        ),
      );
  }
}

/** The deadline a newly opened window carries, opened at `openedAt`. */
function windowDeadline(window: string, openedAt: Date): Date {
  if (isAssessmentWindowKind(window))
    return computeAssessmentWindowDeadline(window, openedAt, DEFAULT_ORG_TZ);
  return new Date(openedAt.getTime() + (WINDOW_HOURS[window] ?? 48) * 3600_000);
}

/**
 * The production, RLS-backed AdmissionRouteService. Every read and every write is real Drizzle over
 * `withOrgContext` (referral/admission [T02], election/CTI [T03], F2F/LOC/discharge/transfer/revocation
 * [T04], compliance-window close/override [T05]) — each write state-machine-driven, optimistic-locked,
 * and emitting `m6.*` on the transactional outbox. Org is bound from the request context, never the body.
 */
export function createDbAdmissionRouteService(
  db: DbClient,
  outbox: AdmissionWriteOutboxPort = NOOP_OUTBOX,
  ipuBedAssignmentReader?: IpuBedAssignmentReaderPort,
  providerEntityOrgCheck?: ProviderEntityOrgCheckPort,
  providerEntityLocations?: ProviderEntityLocationPort,
  dpoaConsent?: DpoaConsentCheckPort,
  f2fClinicianRoles?: F2fClinicianRolePort,
  f2fSignedNotes?: F2fSignedNotePort,
  // 42 CFR 418.25(a) / 418.26(b) — the physician signer facts (role grants + IDG care-team membership).
  physicianAuthority: PhysicianAuthorityPort = createDbPhysicianAuthority(db),
  // GAP-033 - the patient / physician facts a signed CoP document carries (M5 / M40 seams, resolved lazily).
  renderSources: RenderSourcesPort = createSeamRenderSources(),
): AdmissionRouteService {
  const now = () => new Date();

  // Cross-module siting reads go through the OWNING module's exported reader, never its schema
  // (scripts/check-table-ownership.ts): M5's current-residence read and M1's location reads both run on
  // the caller's org-context `tx` (same RLS scope + snapshot as the admission update they feed).
  const foundationSites = buildFoundationSiteReader();

  /**
   * GAP-033 - the typed `renderPayload` for an M6 CoP document, built on the signing transaction's own `tx` so it
   * snapshots exactly what was signed. Returns `{}` (the event is then published id-only and M22 refuses it, loudly)
   * when a SOURCE did not resolve - ids are logged, never PHI. A SQL error is not swallowed.
   */
  async function renderPayloadFor<T>(
    tx: DbClient,
    organizationId: string,
    detail: Record<string, unknown>,
    build: (ctx: RenderBuildCtx) => Promise<T>,
  ): Promise<{ renderPayload: T } | Record<string, never>> {
    const ctx: RenderBuildCtx = {
      tx,
      organizationId,
      sources: renderSources,
      hospiceName: async (providerEntityId) =>
        providerEntityId
          ? foundationSites.providerEntityLegalName(tx, organizationId, providerEntityId)
          : null,
    };
    const payload = await buildOrOmit(logRenderPayload, { organizationId, ...detail }, () =>
      build(ctx),
    );
    return payload === undefined ? {} : { renderPayload: payload };
  }

  /**
   * Uploaded admission-evidence validation over M22's published `DocumentReader` seam (M6 does not list
   * M22 in `dependsOn`, so it may not import M22 — the seam's leaf-typed contract is the sanctioned path).
   * The version must be the document's ACTIVE version and the document must be linked to this admission
   * and patient.
   */
  const admissionDocumentValidator: AdmissionEvidenceDocumentValidator =
    createDocumentReaderEvidenceValidator(() => getSeam("DocumentReader"));

  /**
   * #50 — the service location this activation sites the admission at.
   *
   * The rule, in the order it fails:
   *   · no elected provider entity yet → `null`. Nothing to scope a location to, and the admission is
   *     already unsited at the PE level (#44's transfer-in residue); blocking activation on that
   *     pre-existing gap would convert missing data into an outage.
   *   · no location port bound → `null`, same reasoning.
   *   · the caller NAMED a location → it must be one of the PE's active locations, else 422. A name
   *     that does not belong is refused rather than silently replaced by a derived one.
   *   · the PE has EXACTLY ONE active location → derive it. This is not a default: with one candidate
   *     there is no choice to make, so asking a human to confirm it produces a click, not a decision.
   *   · the PE has MORE THAN ONE, and none was named → 422. There is no defensible pick (`location`
   *     carries no primary flag), and guessing would put a federal capture window and its timezone at
   *     the wrong site.
   *   · the PE has ZERO active locations → 422, naming that as the cause. Distinct from "choose one".
   */
  async function resolveActivationLocation(
    organizationId: string,
    providerEntityId: string | null,
    requested: string | null,
  ): Promise<string | null> {
    if (!providerEntityId || !providerEntityLocations) return null;
    const active = await providerEntityLocations.activeLocationsFor(
      organizationId,
      providerEntityId,
    );
    if (requested) {
      if (!active.includes(requested)) {
        throw new WardenXError(
          "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY",
          `location ${requested} is not an active location of the admission's elected provider entity`,
          422,
        );
      }
      return requested;
    }
    if (active.length === 1) return active[0] as string;
    if (active.length === 0) {
      throw new WardenXError(
        "M6_LOCATION_REQUIRED",
        "the elected provider entity has no active location, so this admission cannot be sited; activate a location first",
        422,
      );
    }
    throw new WardenXError(
      "M6_LOCATION_REQUIRED",
      `the elected provider entity has ${active.length} active locations; name the one this admission is served from (locationId)`,
      422,
    );
  }

  /** Optimistic lock: a stale `ifVersion` is a 409 VERSION_MISMATCH (matches the in-memory slice). */
  function assertVersion(id: string, current: number, expected: number): void {
    if (current !== expected) throw new VersionMismatchError(id, current, expected);
  }

  /**
   * Execute a transition's declarative side effects (§2.5) on the caller's tx. Handles the T02 subset —
   * outbox emit, compliance-window open/close. `set_timestamp`/`set_flag` are folded into the aggregate
   * UPDATE by the caller; `audit` is the M4 write-audit trigger (automatic); the LOC/election cascades
   * belong to T04 and are asserted unreachable here.
   */
  async function runEffects(
    tx: DbClient,
    ctx: {
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
      admissionId: string;
    },
    effects: ReadonlyArray<SideEffect>,
    // TASK-031: per-event extra payload fields, keyed by event name — the generic `{aggregateId,
    // admissionId}` envelope alone doesn't satisfy every effect's declared events-by-m6.ts schema
    // (e.g. `m6.admission.draft_created` also requires `patientId`/`referralId`); callers that know
    // those facts at the point they trigger the effect pass them through here rather than `runEffects`
    // re-querying for state it doesn't otherwise need. Unlisted events keep the base shape (harmless
    // extra properties — TypeBox `Type.Object` allows them unless a schema opts into strict mode).
    extraPayloadByEvent: Readonly<Record<string, Record<string, unknown>>> = {},
  ): Promise<void> {
    for (const e of effects) {
      if (e.kind === "outbox") {
        await outbox.publish(tx, {
          eventName: e.event,
          payload: {
            aggregateId: ctx.aggregateId,
            admissionId: ctx.admissionId,
            ...extraPayloadByEvent[e.event],
          },
          organizationId: ctx.organizationId,
          aggregateKind: ctx.aggregateKind,
          aggregateId: ctx.aggregateId,
        });
      } else if (e.kind === "open_window") {
        // A draft admission's 418.54 windows are PROVISIONAL here (anchored on the draft); activation — the
        // election — re-anchors them (`activateAdmission`).
        const openedAt = now();
        await tx.insert(CW).values({
          organizationId: ctx.organizationId,
          admissionId: ctx.admissionId,
          windowKind: e.window,
          status: "open",
          startsAt: openedAt,
          mustCompleteBy: windowDeadline(e.window, openedAt),
        });
      } else if (e.kind === "close_window") {
        await tx
          .update(CW)
          .set({
            status: "closed",
            closedAt: now(),
            version: sql`${CW.version} + 1`,
          })
          .where(
            and(
              eq(CW.admissionId, ctx.admissionId),
              eq(CW.windowKind, e.window),
              ne(CW.status, "closed"),
            ),
          );
      } else if (e.kind === "end_level_of_care") {
        // §2.3.5 — close the admission's currently-open LOC period (there is at most one; the partial
        // unique `lcp_adm_open_idx` enforces it). No-op when none is open.
        await tx
          .update(LOC)
          .set({
            endedAt: now(),
            status: "ended",
            version: sql`${LOC.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(LOC.admissionId, ctx.admissionId), sql`${LOC.endedAt} is null`));
      } else if (e.kind === "end_election_period") {
        // §2.3.1 discharge/revocation/transfer cascade — complete every non-terminal benefit period.
        //
        // `actual_end_at` is stamped here, not left null: it is the `complete` transition's own
        // `set_timestamp` effect (state-machines/election-period.ts), and a completed period whose
        // actual end is unknown makes the period's real length unrecoverable — which is the whole
        // question HCI indicator 2 and M28's benefit-period projection ask of this row. Only ever SET
        // on the transition, never recomputed, so a period completed earlier keeps its own date.
        //
        // §2.3.2 `complete` runs per ROW rather than as one blanket UPDATE, because the graph accepts
        // `complete` only from `active`: a period still `pending` or `signed` when its admission is
        // discharged never started, and completing it would record an election that never ran. Those
        // rows are left where they are — the cascade ends the ACTIVE election, which is what
        // "end_election_period" means.
        const openPeriods = await tx
          .select({
            id: EP.id,
            admissionId: EP.admissionId,
            sequenceNumber: EP.sequenceNumber,
            status: EP.status,
          })
          .from(EP)
          .where(and(eq(EP.admissionId, ctx.admissionId), ne(EP.status, "completed")));
        const endedAt = isoDay(now());
        for (const row of openPeriods) {
          // GAP-025: the shared helper completes the period AND publishes `m6.election.period_ended`
          // (the transition's own `outbox` effect used to be discarded here, so M23's revalidate
          // consumer bound to the event never fired). It skips non-active rows itself.
          await completeActiveElectionPeriod(
            tx,
            { outbox, now },
            { organizationId: ctx.organizationId, period: row, cause: e.cause, endDate: endedAt },
          );
        }
      }
      // `audit`, `set_timestamp`, `set_flag`, `start_level_of_care` are folded into the aggregate
      // INSERT/UPDATE by the caller; `audit` is the M4 write-audit trigger (automatic).
    }
  }

  // ── the §2.3.2 election-period machine, actually reached ────────────────────────────────────────
  //
  // `transitionElectionPeriod` used to be called by nothing outside its own unit test: every write here
  // set `election_period.status` with a bare UPDATE, so the graph never rejected an illegal jump and
  // none of the guards ran. The consequences were not theoretical —
  //
  //   · R-F2F-04 (42 CFR 418.22(a)(4)): a third-or-later benefit period could activate through
  //     `signCtiHospiceMd` with no attested face-to-face encounter. `decideRecertSign` has no F2F term,
  //     and `F2F_REQUIRED_FOR_RECERT` appeared nowhere but inside the unreached machine.
  //   · R-EL-01 / R-EL-02 / R-EL-04 and the overlap check: the three §2.4 election validators were
  //     likewise called only from the machine, so an election statement could be signed by a
  //     representative with no DPOA authority, for a patient already elected elsewhere, with the
  //     curative-care acknowledgment declined.
  //   · `election_period.status = 'signed'` was written by NOTHING. The real lifecycle was
  //     `pending → active → completed`, so the documented graph could not have been followed even if
  //     something had tried: `pending` accepts only `signElectionStatement`.
  //
  // The transitions below load each guard's facts org-scoped (never from the request body) and dispatch
  // through the machine, which throws the typed §2.4 code the M1 error handler renders.

  /** The election-period row a transition is about, plus the patient it belongs to (via its admission). */
  async function electionPeriodFacts(
    tx: DbClient,
    periodId: string,
  ): Promise<{
    status: ElectionPeriodState;
    sequenceNumber: number;
    admissionId: string;
    patientId: string;
    providerEntityId: string | null;
  } | null> {
    const [row] = await tx
      .select({
        status: EP.status,
        sequenceNumber: EP.sequenceNumber,
        admissionId: EP.admissionId,
        patientId: ADM.patientId,
        providerEntityId: ADM.providerEntityId,
      })
      .from(EP)
      .innerJoin(ADM, eq(EP.admissionId, ADM.id))
      .where(eq(EP.id, periodId))
      .limit(1);
    if (!row) return null;
    return {
      status: row.status as ElectionPeriodState,
      sequenceNumber: Number(row.sequenceNumber),
      admissionId: row.admissionId,
      patientId: row.patientId,
      providerEntityId: row.providerEntityId,
    };
  }

  /**
   * R-EL-02 + the overlap guard, in one scan.
   *
   * Both ask about election periods for the SAME PATIENT on a DIFFERENT ADMISSION that have not been
   * completed. Same-admission periods are excluded because they are sequential by construction — period
   * 2 of an admission does not overlap period 1 of it, and counting them would refuse every recert.
   *
   * They differ by one term, and it is the term CMS cares about: `existingActiveElectionElsewhere` is
   * restricted to a DIFFERENT provider entity (a patient may not be elected at two hospices at once),
   * while `wouldOverlap` covers any other open election including one at this same hospice — a second
   * concurrent admission here is equally invalid, just not the thing 42 CFR 418.24 names.
   */
  async function concurrentElectionFacts(
    tx: DbClient,
    organizationId: string,
    facts: { patientId: string; admissionId: string; providerEntityId: string | null },
  ): Promise<{ existingActiveElectionElsewhere: boolean; wouldOverlap: boolean }> {
    const rows = await tx
      .select({ providerEntityId: ADM.providerEntityId })
      .from(EP)
      .innerJoin(ADM, eq(EP.admissionId, ADM.id))
      .where(
        and(
          eq(EP.organizationId, organizationId),
          eq(ADM.patientId, facts.patientId),
          ne(EP.admissionId, facts.admissionId),
          ne(EP.status, "completed"),
        ),
      );
    return {
      wouldOverlap: rows.length > 0,
      existingActiveElectionElsewhere: rows.some(
        (r) => r.providerEntityId !== null && r.providerEntityId !== facts.providerEntityId,
      ),
    };
  }

  /** MBPM ch. 9 §20.1(5)(d) — does this period carry a documented F2F exceptional circumstance? */
  async function periodHasF2fException(tx: DbClient, periodId: string): Promise<boolean> {
    const [ep] = await tx
      .select({ reason: EP.f2fExceptionReason })
      .from(EP)
      .where(eq(EP.id, periodId))
      .limit(1);
    return !!ep?.reason;
  }

  /** A `Date` → the UTC `YYYY-MM-DD` string M6's `date` columns store. */
  function isoDay(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * The `election_period` window a `setActive` stamps: the day the period became effective plus the
   * INCLUSIVE last day 42 CFR 418.21(a) gives a period of that sequence (1–2 → 90 days, 3+ → 60).
   * Spread into the same `.set({...})` as `status`, so a period cannot go active without a window.
   */
  function electionPeriodWindow(
    effectiveAt: Date,
    sequenceNumber: number,
  ): { effectiveAt: string; scheduledEndAt: string } {
    const effectiveOn = isoDay(effectiveAt);
    return {
      effectiveAt: effectiveOn,
      scheduledEndAt: electionPeriodScheduledEnd(
        effectiveOn,
        electionPeriodKindForSequence(sequenceNumber),
      ),
    };
  }

  /** Load a referral's lock/state facts, or 404. */
  async function loadRef(
    tx: DbClient,
    id: string,
  ): Promise<{
    status: string;
    version: number;
    patientId: string | null;
    patientResolutionStatus: string;
    patientNameAtReceipt: string;
    patientDobAtReceipt: string | null;
    medicareNumberAtReceipt: string | null;
    sexAssignedAtBirth: string | null;
    referringDxText: string | null;
    referrerName: string | null;
    referrerOrganization: string | null;
    externalReferralId: string | null;
  }> {
    const [r] = await tx
      .select({
        status: REF.status,
        version: REF.version,
        patientId: REF.patientId,
        patientResolutionStatus: REF.patientResolutionStatus,
        patientNameAtReceipt: REF.patientNameAtReceipt,
        patientDobAtReceipt: REF.patientDobAtReceipt,
        medicareNumberAtReceipt: REF.medicareNumberAtReceipt,
        sexAssignedAtBirth: REF.sexAssignedAtBirth,
        referringDxText: REF.referringDxText,
        referrerName: REF.referrerName,
        referrerOrganization: REF.referrerOrganization,
        externalReferralId: REF.externalReferralId,
      })
      .from(REF)
      .where(eq(REF.id, id))
      .limit(1);
    if (!r) throw new ResourceNotFoundError(id);
    return { ...r, version: Number(r.version), patientId: r.patientId ?? null };
  }

  const patientResolver = (): PatientIntakeResolver => getSeam("PatientIntakeResolver");
  const patientClearanceReader = (): PatientAdmissionClearanceReader =>
    getSeam("PatientAdmissionClearanceReader");

  async function recordReferralActivity(
    tx: DbClient,
    organizationId: string,
    referralId: string,
    actorId: string,
    action: string,
    fromStatus: string | null,
    toStatus: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(RA).values({
      organizationId,
      referralId,
      actorId: actorId || null,
      action,
      fromStatus,
      toStatus,
      metadata,
    });
  }

  function qualificationBlockers(ref: Awaited<ReturnType<typeof loadRef>>) {
    const blockers: Array<{ code: string; message: string }> = [];
    if (!ref.patientId || !["matched", "created"].includes(ref.patientResolutionStatus)) {
      blockers.push({
        code: "PATIENT_UNRESOLVED",
        message: "A patient must be confirmed or created before qualification.",
      });
    }
    if (!ref.referringDxText && !ref.externalReferralId) {
      blockers.push({
        code: "CLINICAL_INDICATION_MISSING",
        message: "A referral reason or clinical indication is required before qualification.",
      });
    }
    if (!ref.referrerName && !ref.referrerOrganization && !ref.externalReferralId) {
      blockers.push({
        code: "SOURCE_INFORMATION_MISSING",
        message: "Referral source information is required before qualification.",
      });
    }
    return blockers;
  }

  const referralProjection = {
    id: REF.id,
    status: REF.status,
    version: REF.version,
    patientId: REF.patientId,
    patientResolutionStatus: REF.patientResolutionStatus,
    patientNameAtReceipt: REF.patientNameAtReceipt,
    patientDobAtReceipt: REF.patientDobAtReceipt,
    medicareNumberAtReceipt: REF.medicareNumberAtReceipt,
    medicaidNumberAtReceipt: REF.medicaidNumberAtReceipt,
    sexAssignedAtBirth: REF.sexAssignedAtBirth,
    referringDxText: REF.referringDxText,
    icd10TerminalPrimary: REF.icd10TerminalPrimary,
    sourceChannel: REF.sourceChannel,
    referrerName: REF.referrerName,
    referrerOrganization: REF.referrerOrganization,
    referrerPhone: REF.referrerPhone,
    externalReferralId: REF.externalReferralId,
    priority: REF.priority,
    assignedToUserId: REF.assignedToUserId,
    receivedAt: REF.receivedAt,
    reviewedAt: REF.reviewedAt,
    qualifiedAt: REF.qualifiedAt,
    declinedAt: REF.declinedAt,
    convertedAt: REF.convertedAt,
    convertedAdmissionId: REF.convertedAdmissionId,
    rejectionReason: REF.rejectionReason,
  };

  /** Load an admission's lock/state facts, or 404. */
  async function loadAdm(
    tx: DbClient,
    id: string,
  ): Promise<{
    status: AdmissionState;
    version: number;
    providerEntityId: string | null;
    locationId: string | null;
  }> {
    const [r] = await tx
      // `providerEntityId` joined the projection for #50: activation scopes the location it sites the
      // admission at to the ELECTED provider entity, so it has to be read on the same row it guards.
      // `locationId` too: an admission already sited by `updateAdmission` keeps its location.
      .select({
        status: ADM.status,
        version: ADM.version,
        providerEntityId: ADM.providerEntityId,
        locationId: ADM.locationId,
      })
      .from(ADM)
      .where(eq(ADM.id, id))
      .limit(1);
    if (!r) throw new ResourceNotFoundError(id);
    return {
      status: r.status as AdmissionState,
      version: Number(r.version),
      providerEntityId: r.providerEntityId ?? null,
      locationId: r.locationId ?? null,
    };
  }

  /** An UPDATE guarded by `WHERE id=? AND version=?` returned nothing → distinguish 404 vs stale-409. */
  async function failStale(
    tx: DbClient,
    table: typeof REF | typeof ADM,
    id: string,
    ifVersion: number,
  ): Promise<never> {
    const [row] = await tx
      .select({ version: table.version })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(id);
    throw new VersionMismatchError(id, Number(row.version), ifVersion);
  }

  /**
   * The period activation is gated on: the admission's FIRST election period. For an ordinary admission
   * that is sequence 1; for a transfer-in (D9) it is the INHERITED period (sequence = the carried
   * `priorBenefitPeriodSequence`, never 1), which `transferIn` inserts already `active` and which runs on
   * the sending hospice's certification. This used to be hard-wired to `sequence_number = 1`, so a
   * transfer-in found no period at all and could never satisfy the election-statement / CTI gate.
   */
  async function activationPeriodFor(
    tx: DbClient,
    admissionId: string,
  ): Promise<{
    period:
      | {
          id: string;
          sequenceNumber: number;
          effectiveAt: string | null;
          scheduledEndAt: string | null;
          expectedStart: string | null;
          f2fExceptionReason: string | null;
        }
      | undefined;
    inherited: boolean;
  }> {
    const [period] = await tx
      .select({
        id: EP.id,
        sequenceNumber: EP.sequenceNumber,
        effectiveAt: EP.effectiveAt,
        scheduledEndAt: EP.scheduledEndAt,
        expectedStart: EP.expectedStart,
        f2fExceptionReason: EP.f2fExceptionReason,
      })
      .from(EP)
      .where(eq(EP.admissionId, admissionId))
      .orderBy(EP.sequenceNumber)
      .limit(1);
    if (!period) return { period, inherited: false };
    const [xin] = await tx
      .select({ id: TE.id })
      .from(TE)
      .where(
        and(
          eq(TE.admissionId, admissionId),
          eq(TE.direction, "in"),
          eq(TE.periodSequenceAtTransfer, period.sequenceNumber),
        ),
      )
      .limit(1);
    return { period, inherited: !!xin };
  }

  /**
   * The R-AC-01 gate facts (§7.2). This now resolves NOR/election/CTI completion through admission
   * evidence, and returns the period-1 id/dates so `activateAdmission` can build the
   * `m6.election.period_started` outbox payload without a second query.
   */
  async function gateFacts(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
  ): Promise<{
    electionSigned: boolean;
    ctiHospiceMdSigned: boolean;
    norAcknowledged: boolean;
    periodSequence: number;
    periodId: string | null;
    periodEffectiveAt: string | null;
    periodScheduledEndAt: string | null;
    /** D9 — the activation period is the sending hospice's inherited one (transfer-in). */
    inheritedPeriod: boolean;
    /** MBPM ch. 9 §20.1(5)(d) — a period-3+ new admission's documented F2F exceptional circumstance. */
    f2fExceptionDocumented: boolean;
  }> {
    await backfillLegacyEvidenceForAdmission(tx, organizationId, admissionId);
    const { period, inherited } = await activationPeriodFor(tx, admissionId);
    let electionSigned = false;
    let ctiHospiceMdSigned = false;
    if (period) {
      const evidence = createAdmissionEvidenceService(tx);
      electionSigned =
        (await evidence.hasValidEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          requirementType: "election_statement",
        })) &&
        (await evidence.hasValidEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          requirementType: "election_signature",
        }));
      // D9 — a transfer-in's inherited period runs on the SENDING hospice's certification, so the
      // receiving hospice owes no CTI (or F2F) on it; our own CTI is drafted against the NEXT pending
      // period and gates that period's activation, not this admission's.
      ctiHospiceMdSigned =
        inherited ||
        ((await evidence.hasValidEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          requirementType: "cti",
        })) &&
          (await evidence.hasValidEvidence({
            organizationId,
            admissionId,
            electionPeriodId: period.id,
            requirementType: "cti_signature",
          })));
    }
    const evidence = createAdmissionEvidenceService(tx);
    const norAcknowledged = await evidence.hasValidEvidence({
      organizationId,
      admissionId,
      electionPeriodId: null,
      requirementType: "notice_of_rights",
    });
    return {
      electionSigned,
      ctiHospiceMdSigned,
      norAcknowledged,
      periodSequence: period?.sequenceNumber ?? 1,
      periodId: period?.id ?? null,
      periodEffectiveAt: period?.effectiveAt ?? null,
      periodScheduledEndAt: period?.scheduledEndAt ?? null,
      inheritedPeriod: inherited,
      f2fExceptionDocumented: !!period?.f2fExceptionReason,
    };
  }

  async function backfillLegacyEvidenceForAdmission(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
  ): Promise<void> {
    const evidence = createAdmissionEvidenceService(tx);
    const [nor] = await tx
      .select({
        id: NOR.id,
        patientId: NOR.patientId,
        acknowledgedAt: NOR.acknowledgedAt,
      })
      .from(NOR)
      .where(eq(NOR.admissionId, admissionId))
      .limit(1);
    if (nor) {
      const existing = await evidence.findValidEvidence({
        organizationId,
        admissionId,
        electionPeriodId: null,
        requirementType: "notice_of_rights",
      });
      if (!existing) {
        await evidence.recordStructuredEvidence({
          organizationId,
          admissionId,
          patientId: nor.patientId,
          requirementType: "notice_of_rights",
          structuredEntityType: "notice_of_rights",
          structuredEntityId: nor.id,
          completedAt: new Date(`${nor.acknowledgedAt}T00:00:00.000Z`),
          metadata: { legacyFallback: true },
        });
      }
    }
    const [period] = await tx
      .select({ id: EP.id })
      .from(EP)
      .where(eq(EP.admissionId, admissionId))
      .orderBy(EP.sequenceNumber)
      .limit(1);
    if (!period) return;
    const [es] = await tx
      .select({
        id: ES.id,
        patientId: ES.patientId,
        status: ES.status,
        signedAt: ES.signedAt,
      })
      .from(ES)
      // The period's LIVE statement: a voided one may sit beside it (partial `election_statement_period_idx`).
      .where(and(eq(ES.electionPeriodId, period.id), ne(ES.status, "voided")))
      .limit(1);
    if (es && es.status !== "voided") {
      if (
        !(await evidence.findValidEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          requirementType: "election_statement",
        }))
      ) {
        await evidence.recordStructuredEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          patientId: es.patientId,
          requirementType: "election_statement",
          structuredEntityType: "election_statement",
          structuredEntityId: es.id,
          metadata: { legacyFallback: true },
        });
      }
      if (
        es.status === "signed" &&
        es.signedAt &&
        !(await evidence.findValidEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          requirementType: "election_signature",
        }))
      ) {
        await evidence.recordStructuredEvidence({
          organizationId,
          admissionId,
          electionPeriodId: period.id,
          patientId: es.patientId,
          requirementType: "election_signature",
          structuredEntityType: "election_statement",
          structuredEntityId: es.id,
          completedAt: new Date(`${es.signedAt}T00:00:00.000Z`),
          metadata: { legacyFallback: true },
        });
      }
    }
    const [cti] = await tx
      .select({
        id: CTI.id,
        status: CTI.status,
        hospiceMdSignedAt: CTI.hospiceMdSignedAt,
      })
      .from(CTI)
      .where(and(eq(CTI.electionPeriodId, period.id), ne(CTI.status, "voided")))
      .limit(1);
    if (cti) {
      const [adm] = await tx
        .select({ patientId: ADM.patientId })
        .from(ADM)
        .where(eq(ADM.id, admissionId))
        .limit(1);
      if (adm) {
        if (
          !(await evidence.findValidEvidence({
            organizationId,
            admissionId,
            electionPeriodId: period.id,
            requirementType: "cti",
          }))
        ) {
          await evidence.recordStructuredEvidence({
            organizationId,
            admissionId,
            electionPeriodId: period.id,
            patientId: adm.patientId,
            requirementType: "cti",
            structuredEntityType: "cti",
            structuredEntityId: cti.id,
            metadata: { legacyFallback: true },
          });
        }
        if (
          cti.hospiceMdSignedAt &&
          !(await evidence.findValidEvidence({
            organizationId,
            admissionId,
            electionPeriodId: period.id,
            requirementType: "cti_signature",
          }))
        ) {
          await evidence.recordStructuredEvidence({
            organizationId,
            admissionId,
            electionPeriodId: period.id,
            patientId: adm.patientId,
            requirementType: "cti_signature",
            structuredEntityType: "cti",
            structuredEntityId: cti.id,
            completedAt: cti.hospiceMdSignedAt,
            metadata: { legacyFallback: true, signedBy: "hospice_physician" },
          });
        }
      }
    }
  }

  /** FY2027 — the informational 42 CFR 418.24(c) checklist facts (never blocking; see activation-gate.ts). */
  async function addendumReadinessFacts(
    tx: DbClient,
    admissionId: string,
    activated: boolean,
  ): Promise<NonNullable<AdmissionReadinessFacts["electionAddendum"]>> {
    const addendumFacts = await loadAddendumAdmissionFacts(tx, admissionId);
    const effective = addendumFacts?.electionEffectiveDate ?? null;
    // Before activation the effective date is not set; activation dates it today, so judge by today.
    const required = addendumRequiredForElection(effective ?? isoDay(now()));
    const [latest] = await listAddendumVersions(tx, admissionId);
    const windows = await openAddendumWindows(tx, admissionId);
    return {
      activated: activated && effective !== null,
      required,
      latestStatus: latest?.status ?? null,
      overdue: windows.some((w) => w.status === "overdue"),
    };
  }

  async function readinessForAdmission(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
  ): Promise<AdmissionReadinessResult | null> {
    const [adm] = await tx
      .select({
        id: ADM.id,
        patientId: ADM.patientId,
        referralId: ADM.referralId,
        admissionAt: ADM.admissionAt,
        providerEntityId: ADM.providerEntityId,
        locationId: ADM.locationId,
        patientResidenceAddressId: ADM.patientResidenceAddressId,
        serviceAddressLine1: ADM.serviceAddressLine1,
        attendingPhysicianId: ADM.attendingPhysicianId,
        recommendedByUserId: ADM.recommendedByUserId,
        activatedAt: ADM.activatedAt,
      })
      .from(ADM)
      .where(eq(ADM.id, admissionId))
      .limit(1);
    if (!adm) return null;
    await backfillLegacyEvidenceForAdmission(tx, organizationId, admissionId);

    const [ref] = adm.referralId
      ? await tx
          .select({
            patientId: REF.patientId,
            patientResolutionStatus: REF.patientResolutionStatus,
            primaryDiagnosis: REF.icd10TerminalPrimary,
          })
          .from(REF)
          .where(eq(REF.id, adm.referralId))
          .limit(1)
      : [null];

    const { period, inherited: inheritedPeriod } = await activationPeriodFor(tx, admissionId);

    const [es] = period
      ? await tx
          .select({
            status: ES.status,
            signedAt: ES.signedAt,
            electionPeriodId: ES.electionPeriodId,
          })
          .from(ES)
          // The period's LIVE statement (a voided one may sit beside it — partial index, migration 0398).
          .where(and(eq(ES.electionPeriodId, period.id), ne(ES.status, "voided")))
          .limit(1)
      : [null];
    const [cti] = period
      ? await tx
          .select({
            status: CTI.status,
            hospiceMdId: CTI.hospiceMdId,
            hospiceMdSignedAt: CTI.hospiceMdSignedAt,
            attendingMdId: CTI.attendingMdId,
            attendingMdSignedAt: CTI.attendingMdSignedAt,
            terminalDiagnosisIcd10: CTI.terminalDiagnosisIcd10,
          })
          .from(CTI)
          .where(and(eq(CTI.electionPeriodId, period.id), ne(CTI.status, "voided")))
          .limit(1)
      : [null];
    const [nor] = await tx
      .select({
        id: NOR.id,
        signerKind: NOR.signerKind,
        acknowledgedAt: NOR.acknowledgedAt,
        acknowledgmentMethod: NOR.acknowledgmentMethod,
      })
      .from(NOR)
      .where(eq(NOR.admissionId, admissionId))
      .limit(1);
    const [f2f] = period
      ? await tx
          .select({
            status: F2F.status,
            encounterDate: F2F.encounterDate,
            attestationSignedAt: F2F.attestationSignedAt,
            windowOverride: F2F.windowOverride,
          })
          .from(F2F)
          .where(eq(F2F.electionPeriodId, period.id))
          .orderBy(desc(F2F.createdAt))
          .limit(1)
      : [null];
    const evidenceFacts = await createAdmissionEvidenceService(tx).readFacts({
      organizationId,
      admissionId,
      electionPeriodId: period?.id ?? null,
    });

    let clearance: PatientAdmissionClearance;
    try {
      clearance = await patientClearanceReader().evaluatePatientAdmissionClearance({
        organizationId,
        patientId: adm.patientId,
      });
    } catch {
      clearance = {
        allowed: false,
        reason: "PRIVACY_CLEARANCE_UNAVAILABLE" as const,
      };
    }

    const facts: AdmissionReadinessFacts = {
      admissionId,
      patientIdentity: {
        patientId: adm.patientId,
        referralPatientId: ref?.patientId ?? undefined,
        referralPatientResolutionStatus: ref?.patientResolutionStatus ?? undefined,
      },
      admissionDetails: {
        admissionDatePresent: !!adm.admissionAt || !!period?.effectiveAt,
        // primaryDiagnosisPresent: !!(cti?.terminalDiagnosisIcd10 ?? ref?.primaryDiagnosis),
        // hospiceMedicalDirectorPresent: !!cti?.hospiceMdId,

        providerEntityPresent: !!adm.providerEntityId,
        locationPresent: !!adm.locationId,
      },
      patientPrivacy: {
        allowed: clearance.allowed,
        reason: clearance.reason,
        restriction: clearance.restriction,
        overrideAllowed: clearance.overrideAllowed,
      },
      noticeOfRights: {
        acknowledged: !!evidenceFacts.noticeOfRights,
        acknowledgedAtPresent: !!evidenceFacts.noticeOfRights?.completedAt || !!nor?.acknowledgedAt,
        signerValid:
          !!evidenceFacts.noticeOfRights ||
          nor?.signerKind === "patient" ||
          nor?.signerKind === "representative",
        methodValid: !!evidenceFacts.noticeOfRights || !!nor?.acknowledgmentMethod,
        evidence: evidenceFacts.noticeOfRights,
      },
      electionStatement: {
        exists: !!evidenceFacts.electionStatement,
        status: es?.status ?? null,
        signedAtPresent: !!evidenceFacts.electionSignature?.completedAt || !!es?.signedAt,
        belongsToCurrentPeriod: !!period && !!evidenceFacts.electionStatement,
        evidence: evidenceFacts.electionStatement,
        signatureEvidence: evidenceFacts.electionSignature,
      },
      // D9 — an inherited (transfer-in) period is certified by the sending hospice: no CTI and no F2F
      // are owed on it by us (our CTI/F2F gate the NEXT pending period).
      cti: inheritedPeriod
        ? {
            exists: true,
            status: "inherited",
            hospiceMdSigned: true,
            evidence: {
              sourceType: "structured",
              evidenceId: "inherited",
              structuredEntityId: "inherited",
            },
            signatureEvidence: {
              sourceType: "structured",
              evidenceId: "inherited",
              structuredEntityId: "inherited",
            },
          }
        : {
            exists: !!evidenceFacts.cti,
            status: cti?.status ?? null,
            evidence: evidenceFacts.cti,
            signatureEvidence: evidenceFacts.ctiSignature,
            hospiceMdSigned: !!evidenceFacts.ctiSignature,
          },
      f2f: {
        required: !inheritedPeriod && (period?.sequenceNumber ?? 1) >= 3,
        exists: !!f2f,
        status: f2f?.status ?? null,
        completed: f2f?.status === "completed" || f2f?.status === "attested",
        attestationRequired: !inheritedPeriod && (period?.sequenceNumber ?? 1) >= 3,
        attested: !!f2f?.attestationSignedAt || f2f?.status === "attested",
        satisfiedBy: f2f?.windowOverride ? "override" : undefined,
        exceptionDocumented: !inheritedPeriod && !!period?.f2fExceptionReason,
        exceptionDueBy: (() => {
          const start =
            period?.effectiveAt ??
            period?.expectedStart ??
            (adm.admissionAt ? adm.admissionAt.toISOString().slice(0, 10) : null);
          return start ? addCalendarDays(start, F2F_EXCEPTION_DAYS_AFTER_ADMISSION) : null;
        })(),
      },
      admissionRecommendation: { recorded: adm.recommendedByUserId !== null },
      electionAddendum: await addendumReadinessFacts(tx, admissionId, !!adm.activatedAt),
    };
    return evaluateAdmissionReadiness(facts);
  }

  /** Drive a state-machine admission event: load → assertVersion → transition → UPDATE + effects. */
  async function admissionEvent(
    organizationId: string,
    id: string,
    ifVersion: number,
    event: AdmissionEvent,
    extraSet: Record<string, unknown> = {},
    // F-100 — the per-event payload fields, same contract as `runEffects`. This parameter did not exist,
    // so `holdAdmission` and `resumeAdmission` emitted `m6.admission.on_hold` / `.resumed` with the bare
    // `{aggregateId, admissionId}` envelope while both schemas require more, and both routes 500'd on
    // `payload_schema_violation` for every caller.
    extraPayloadByEvent: Readonly<Record<string, Record<string, unknown>>> = {},
  ): Promise<MutationResult> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const cur = await loadAdm(tx, id);
      assertVersion(id, cur.version, ifVersion);
      const t = transitionAdmission(cur.status, event);
      const r = firstOrThrow(
        await tx
          .update(ADM)
          .set({ status: t.to, version: sql`${ADM.version} + 1`, ...extraSet })
          .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
          .returning({ id: ADM.id, status: ADM.status, version: ADM.version }),
        "row not found",
      );
      await runEffects(
        tx,
        {
          organizationId,
          aggregateKind: "admission",
          aggregateId: id,
          admissionId: id,
        },
        t.effects,
        extraPayloadByEvent,
      );
      return { id: r.id, state: r.status, version: Number(r.version) };
    });
  }
  /** Page a status-bearing table on the integer-offset cursor, newest-first. */
  const complianceWindowColumns = {
    id: CW.id,
    state: CW.status,
    version: CW.version,
    admissionId: CW.admissionId,
    windowKind: CW.windowKind,
    severity: CW.severity,
    mustCompleteBy: CW.mustCompleteBy,
  };
  function toComplianceWindowRow(r: {
    id: string;
    state: string;
    version: number;
    admissionId: string;
    windowKind: string;
    severity: string;
    mustCompleteBy: Date;
  }): ComplianceWindowRow {
    return {
      ...toSummary(r),
      admissionId: r.admissionId,
      windowKind: r.windowKind,
      severity: r.severity,
      dueAt: r.mustCompleteBy.toISOString(),
    };
  }

  async function pageByStatus(
    organizationId: string,
    table: typeof REF | typeof ADM | typeof CW,
    orderCol: AnyColumn,
    query: { state?: string; cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>> {
    const limit = clampLimit(query.limit);
    const offset = parseOffset(query.cursor);
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const where = query.state ? eq(table.status as never, query.state as never) : undefined;
      const rows = (await tx
        .select({ id: table.id, state: table.status, version: table.version })
        .from(table)
        .where(where)
        .orderBy(desc(orderCol as never), desc(table.id))
        .limit(limit + 1)
        .offset(offset)) as { id: string; state: string; version: number }[];
      const items = rows.slice(0, limit).map(toSummary);
      const nextCursor = rows.length > limit ? String(offset + limit) : null;
      return { items, nextCursor };
    });
  }

  /** Does an admission exist for this org? (RLS-scoped) — reads return `null` → 404 when it does not. */
  async function admissionExists(tx: DbClient, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: ADM.id }).from(ADM).where(eq(ADM.id, id)).limit(1);
    return !!row;
  }

  /**
   * The chart target for a §4.11 render request (F-100). M22 writes `document.patient_id` from the
   * payload and cannot resolve one itself — it `dependsOn [1, 5]` and reads every source module through
   * the event STRING — so a CoP document whose request omits this files against NO CHART. That is worse
   * than not rendering it: an unrendered request is a visible `pending` outbox row, an off-chart signed
   * certification is a filed document nobody can find.
   *
   * `admission.patient_id` is NOT NULL, so a missing row is the only failure and it means the admission
   * was deleted inside this transaction — never a silent null. The caller throws rather than emitting a
   * chart-less request.
   */
  async function patientForAdmission(tx: DbClient, admissionId: string): Promise<string> {
    const [row] = await tx
      .select({ patientId: ADM.patientId })
      .from(ADM)
      .where(eq(ADM.id, admissionId))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(admissionId);
    return row.patientId;
  }

  /** {@link patientForAdmission} one hop further out: the CTI and the F2F hang off an election PERIOD,
   *  which is the aggregate that carries the admission. One join, on the write path only. */
  async function patientForElectionPeriod(tx: DbClient, electionPeriodId: string): Promise<string> {
    const [row] = await tx
      .select({ patientId: ADM.patientId })
      .from(EP)
      .innerJoin(ADM, eq(ADM.id, EP.admissionId))
      .where(eq(EP.id, electionPeriodId))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(electionPeriodId);
    return row.patientId;
  }

  /** The latest benefit period for an admission (highest sequence), or `null`. */
  async function latestPeriod(
    tx: DbClient,
    admissionId: string,
  ): Promise<{ id: string; sequence: number; status: string } | null> {
    const [p] = await tx
      .select({ id: EP.id, seq: EP.sequenceNumber, status: EP.status })
      .from(EP)
      .where(eq(EP.admissionId, admissionId))
      .orderBy(desc(EP.sequenceNumber))
      .limit(1);
    return p ? { id: p.id, sequence: Number(p.seq), status: p.status } : null;
  }

  /**
   * Drive the §2.3.1 `executeDischarge` event on the admission: load → transition (guards + the
   * death-certifier check) → UPDATE to the target state → run the LOC/election-period end cascades +
   * the `m6.admission.discharged` outbox fan-out. Called by discharge (immediate reasons), the for-cause
   * cosign, revocation, and transfer-out. Never called on the for-cause FILING (the admission stays
   * active until cosign). `deathCertifierId` identifies WHO certified a death (`checkDischargeNarrative`
   * already required it be present for `reason === "death"` before this function is ever reached) — see
   * that call's caveat below for what this guard does and does NOT verify.
   */
  async function dischargeAdmissionTx(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
    ev: {
      dischargeType:
        | "death"
        | "revocation"
        | "transfer"
        | "routine"
        | "for_cause"
        | "moved"
        | "no_longer_terminal";
      effectiveAt: string;
      forCauseCosigned: boolean;
      deathCertifierId?: string;
      // Required to fire `m6.discharge.created`/`m6.discharge.death` (both need `dischargeEventId`;
      // `m6.discharge.created` also needs the original §4.2.7 `DischargeReason` string, not this
      // function's own broader `dischargeType` discriminator — see callers). Omitted by
      // revocation/transferOut, which never create a `discharge_event` row and, per the state-machine
      // fix above, no longer need to.
      dischargeEventId?: string;
      reason?: string;
      /** F-227 — an external (M29) death: the certifier is the sending facility's, attested later by the
       *  medical-director cosign (M6 §4.8.4), so R-DC-01's credentialed-certifier guard is satisfied by
       *  provenance rather than an identified `deathCertifierId`. */
      externalDeath?: boolean;
    },
  ): Promise<{ state: AdmissionState; version: number }> {
    const [row] = await tx
      .select({
        status: ADM.status,
        admissionAt: ADM.admissionAt,
        patientId: ADM.patientId,
      })
      .from(ADM)
      .where(eq(ADM.id, admissionId))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(admissionId);
    const admissionAt = row.admissionAt
      ? row.admissionAt.toISOString().slice(0, 10)
      : ev.effectiveAt;
    // §2.3.6 — the pure command guard (for_cause cosign + R-DC-01 death-certifier check), called for
    // validation ahead of `transitionAdmission`'s own equivalent inline guards below (kept as-is,
    // defense-in-depth). `forCauseCosigned` is already a real caller-supplied fact (false while a
    // for-cause filing awaits cosign, true only from `cosignDischarge` after it happens). `today` uses
    // the REAL clock rather than `ev.effectiveAt` (which made the R-DC-01 date-order half of the check
    // trivially true by construction, comparing a value to itself). `deathCertifierCredentialed` is now
    // a real fact too — `!!ev.deathCertifierId` — but be precise about what that proves: it confirms an
    // IDENTITY was captured (`DischargeCreateSchema.deathCertifierId`, enforced present for `death` by
    // `checkDischargeNarrative` before this runs), NOT that the identified person actually holds an
    // MD/NP/RN license, nor that their license permits pronouncing death under the ADMISSION'S OWN
    // state's rules (which vary — RN can pronounce in some states, per the spec's R-DC-01 note). Full
    // state-law-aware role/license verification would need an M40 physician-registry role lookup plus a
    // per-state credentialing ruleset, neither of which exists yet — a materially larger feature than
    // this fix. `cosignDischarge`'s `cosignerName`/`cosignerNpi` remain a separate, still-unpersisted
    // capture (no `discharge_event` column for them, by design — see `CosignDischargeInput`'s doc).
    planDischarge({
      dischargeType: ev.dischargeType,
      forCauseCosigned: ev.forCauseCosigned,
      deathAt: ev.dischargeType === "death" ? ev.effectiveAt : undefined,
      today: now().toISOString().slice(0, 10),
      deathCertifierCredentialed:
        ev.dischargeType === "death"
          ? !!ev.deathCertifierId || ev.externalDeath === true
          : undefined,
    });
    const t = transitionAdmission(row.status as AdmissionState, {
      type: "executeDischarge",
      dischargeType: ev.dischargeType,
      effectiveAt: ev.effectiveAt,
      admissionAt,
      forCauseCosigned: ev.forCauseCosigned,
      deathAt: ev.dischargeType === "death" ? ev.effectiveAt : undefined,
      today: ev.effectiveAt,
      deathCertifierCredentialed:
        ev.dischargeType === "death"
          ? !!ev.deathCertifierId || ev.externalDeath === true
          : undefined,
    } satisfies AdmissionEvent);
    const r = firstOrThrow(
      await tx
        .update(ADM)
        .set({
          status: t.to,
          dischargedAt: now(),
          version: sql`${ADM.version} + 1`,
        })
        .where(eq(ADM.id, admissionId))
        .returning({ status: ADM.status, version: ADM.version }),
      "admission not found",
    );
    // FY2027 — 42 CFR 418.24(d)(3)/(d)(4): leaving hospice care settles any open addendum obligation (an
    // unfurnished draft → not_required, a furnished-but-unsigned version → signature_not_required), with the
    // reason noted on the addendum, and closes the addendum windows.
    await settleAddendumOnLeavingCareInTx(tx, outbox, {
      organizationId,
      admissionId,
      reason: exemptionReasonForDischarge(ev.dischargeType),
      at: now(),
    });
    // `m6.admission.discharged`'s `reason`/`dischargeDate` were previously never supplied (`runEffects`'
    // base payload is just `{aggregateId, admissionId}`) — 500ing on EVERY discharge/revocation/
    // transfer-out. `m6.discharge.created`/`.death` need `dischargeEventId` too, but only real discharge
    // reasons still fire that effect (state-machine fix above); revocation/transfer never provide one.
    await runEffects(
      tx,
      {
        organizationId,
        aggregateKind: "admission",
        aggregateId: admissionId,
        admissionId,
      },
      t.effects,
      {
        "m6.admission.discharged": {
          reason: ev.reason ?? ev.dischargeType,
          dischargeDate: ev.effectiveAt,
        },
        ...(ev.dischargeEventId
          ? {
              "m6.discharge.created": {
                dischargeEventId: ev.dischargeEventId,
                reason: ev.reason ?? ev.dischargeType,
                dischargeDate: ev.effectiveAt,
                requiresMedicalDirectorCosign: false,
                // F-100 — the chart. Already read at the top of this function for the transition guard.
                patientId: row.patientId,
                // GAP-033 - a death renders no discharge summary (it fires `.death`, not `.created`).
                ...(ev.dischargeType === "death" || !ev.dischargeEventId
                  ? {}
                  : await renderPayloadFor(
                      tx,
                      organizationId,
                      { dischargeId: ev.dischargeEventId },
                      (ctx) => buildDischargeRenderPayload(ctx, ev.dischargeEventId as string),
                    )),
              },
              "m6.discharge.death": {
                dischargeEventId: ev.dischargeEventId,
                dischargeDate: ev.effectiveAt,
                // F-172 (#248) — required by the catalog schema (M37's `ipu_body_release
                // .pronouncing_physician_id`, NOT NULL). Only ever reaches this branch for
                // `dischargeType === "death"`, and `checkDischargeNarrative` already refused the
                // discharge request upstream if `deathCertifierId` was absent for that reason — so
                // this is a real, already-verified fact at this point, never a guess.
                // F-227 — absent (by design) for an external death: the sending facility pronounced it.
                deathCertifierId:
                  ev.dischargeType === "death"
                    ? (ev.deathCertifierId ??
                      (ev.externalDeath
                        ? undefined
                        : (() => {
                            throw conflict(
                              "m6.discharge.death cannot be emitted without deathCertifierId",
                            );
                          })()))
                    : undefined,
              },
            }
          : {}),
        // Fires only when `t.effects` actually includes it (death → 'bereavement'), but
        // `dischargeAdmissionTx` never supplied `patientId`/`eligibleAt` either — same bug class,
        // one more event, same 500 on every death discharge.
        "m6.bereavement.eligible": {
          patientId: row.patientId,
          eligibleAt: ev.effectiveAt,
        },
      },
    );
    return { state: r.status as AdmissionState, version: Number(r.version) };
  }

  return {
    // ── Referral reads ───────────────────────────────────────────────────────────────────────────
    async listReferrals(organizationId, query, actorUserId, scope) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const limit = clampLimit(query.limit);
        const offset = parseOffset(query.cursor);
        const filters: SQL[] = [];
        // GAP-182 — mirror `referral.scope`: no location (org-level) OR one of the caller's locations.
        if (scope) {
          filters.push(
            scope.locationIds.length > 0
              ? (or(isNull(REF.locationId), inArray(REF.locationId, [...scope.locationIds])) as SQL)
              : isNull(REF.locationId),
          );
        }
        const status = query.status ?? query.state;
        if (status) filters.push(eq(REF.status, status as never));
        else if (!query.includeConverted) filters.push(ne(REF.status, "converted"));
        if (query.source) filters.push(eq(REF.sourceChannel, query.source as never));
        if (query.patientResolutionStatus)
          filters.push(eq(REF.patientResolutionStatus, query.patientResolutionStatus as never));
        if (query.priority) filters.push(eq(REF.priority, query.priority as never));
        if (query.assigned === "unassigned") filters.push(isNull(REF.assignedToUserId));
        if (query.assigned === "mine" && actorUserId)
          filters.push(eq(REF.assignedToUserId, actorUserId));
        if (query.q?.trim()) {
          const q = `%${query.q.trim()}%`;
          filters.push(
            or(
              ilike(REF.patientNameAtReceipt, q),
              ilike(REF.referrerName, q),
              ilike(REF.referrerOrganization, q),
              ilike(REF.externalReferralId, q),
              ilike(REF.referringDxText, q),
            ) as SQL,
          );
        }
        const where = filters.length ? and(...filters) : undefined;
        const rows = await tx
          .select(referralProjection)
          .from(REF)
          .where(where)
          .orderBy(desc(REF.receivedAt), desc(REF.id))
          .limit(limit + 1)
          .offset(offset);
        const items = rows.slice(0, limit).map((r) =>
          toReferralReadView(
            r,
            qualificationBlockers({
              status: r.status,
              version: Number(r.version),
              patientId: r.patientId,
              patientResolutionStatus: r.patientResolutionStatus,
              patientNameAtReceipt: r.patientNameAtReceipt,
              patientDobAtReceipt: r.patientDobAtReceipt,
              medicareNumberAtReceipt: r.medicareNumberAtReceipt,
              sexAssignedAtBirth: r.sexAssignedAtBirth,
              referringDxText: r.referringDxText,
              referrerName: r.referrerName,
              referrerOrganization: r.referrerOrganization,
              externalReferralId: r.externalReferralId,
            }),
          ),
        );
        return {
          items,
          nextCursor: rows.length > limit ? String(offset + limit) : null,
        };
      });
    },
    async getReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx.select(referralProjection).from(REF).where(eq(REF.id, id)).limit(1);
        return r
          ? toReferralReadView(
              r,
              qualificationBlockers({
                status: r.status,
                version: Number(r.version),
                patientId: r.patientId,
                patientResolutionStatus: r.patientResolutionStatus,
                patientNameAtReceipt: r.patientNameAtReceipt,
                patientDobAtReceipt: r.patientDobAtReceipt,
                medicareNumberAtReceipt: r.medicareNumberAtReceipt,
                sexAssignedAtBirth: r.sexAssignedAtBirth,
                referringDxText: r.referringDxText,
                referrerName: r.referrerName,
                referrerOrganization: r.referrerOrganization,
                externalReferralId: r.externalReferralId,
              }),
            )
          : null;
      });
    },

    // ── Admission reads ──────────────────────────────────────────────────────────────────────────
    async listAdmissions(organizationId, query, scope) {
      const limit = clampLimit(query.limit);
      const offset = parseOffset(query.cursor);
      // GAP-020 — narrow to the caller's caseload in SQL; an empty caseload reads nothing (no query).
      const scopedIds = scope?.patientIds ?? null;
      if (scopedIds !== null && scopedIds.length === 0) return { items: [], nextCursor: null };
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const filters: SQL[] = [];
        if (query.state) {
          filters.push(eq(ADM.status, query.state as never));
        }
        if (query.patientId) {
          filters.push(eq(ADM.patientId, query.patientId));
        }
        if (scopedIds !== null) filters.push(inArray(ADM.patientId, [...scopedIds]));
        const where = filters.length ? and(...filters) : undefined;
        const rows = await tx
          .select({
            id: ADM.id,
            state: ADM.status,
            version: ADM.version,
            patientId: ADM.patientId,
            // F-195 (#248) — M6's own spec (line 2983) names these "surfaced in M30's operational
            // dashboard"; this org-wide, `state`-filterable list (`?state=on_hold`) IS that dashboard read.
            holdReason: ADM.holdReason,
            holdAt: ADM.holdAt,
            releasedAt: ADM.releasedAt,
          })
          .from(ADM)
          .where(where)
          .orderBy(desc(ADM.admissionAt), desc(ADM.id))
          .limit(limit + 1)
          .offset(offset);
        const items = rows.slice(0, limit).map((r) => ({
          ...toSummary(r),
          holdReason: r.holdReason ?? null,
          holdAt: r.holdAt ? r.holdAt.toISOString() : null,
          releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
        }));
        const nextCursor = rows.length > limit ? String(offset + limit) : null;
        return { items, nextCursor };
      });
    },
    /**
     * F-065 — the patient's admissions, newest first. Every clinical CREATE is keyed by `admissionId`
     * and nothing could resolve one for a patient: the org-wide census takes no patient filter and its
     * items carry no `patientId`, and the patient read carries no admission. Ordered by `admission_at`
     * with the id as a tiebreak so a draft admission with no date still has a stable position.
     */
    async listPatientAdmissions(organizationId, patientId): Promise<PatientAdmissionSummary[]> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            id: ADM.id,
            state: ADM.status,
            admissionAt: ADM.admissionAt,
            dischargedAt: ADM.dischargedAt,
          })
          .from(ADM)
          .where(eq(ADM.patientId, patientId))
          .orderBy(desc(ADM.admissionAt), desc(ADM.id));
        return rows.map((r) => ({
          id: r.id,
          state: r.state,
          admissionAt: r.admissionAt ? r.admissionAt.toISOString() : null,
          dischargedAt: r.dischargedAt ? r.dischargedAt.toISOString() : null,
        }));
      });
    },
    async getAdmission(organizationId, id): Promise<AdmissionDetail | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({
            id: ADM.id,
            status: ADM.status,
            version: ADM.version,
            patientId: ADM.patientId,
            referralId: ADM.referralId,
            admissionAt: ADM.admissionAt,
            activatedAt: ADM.activatedAt,
            providerEntityId: ADM.providerEntityId,
            locationId: ADM.locationId,
            patientResidenceAddressId: ADM.patientResidenceAddressId,
            serviceAddressLine1: ADM.serviceAddressLine1,
            serviceAddressLine2: ADM.serviceAddressLine2,
            serviceAddressCity: ADM.serviceAddressCity,
            serviceAddressState: ADM.serviceAddressState,
            serviceAddressPostalCode: ADM.serviceAddressPostalCode,
            serviceAddressCountry: ADM.serviceAddressCountry,
            hospicePhysicianId: ADM.hospicePhysicianId,
            attendingPhysicianId: ADM.attendingPhysicianId,
            primaryDiagnosisIcd10: REF.icd10TerminalPrimary,
            referringDxText: REF.referringDxText,
            recommendedByUserId: ADM.recommendedByUserId,
            recommenderCapacity: ADM.recommenderCapacity,
            recommendedAt: ADM.recommendedAt,
            attendingConsulted: ADM.attendingConsulted,
            attendingConsultNote: ADM.attendingConsultNote,
            admissionTypeCode: ADM.admissionTypeCode,
            admissionSourceCode: ADM.admissionSourceCode,
          })
          .from(ADM)
          .leftJoin(REF, eq(REF.id, ADM.referralId))
          .where(eq(ADM.id, id))
          .limit(1);
        if (!adm) return null;
        const readiness = await readinessForAdmission(tx, organizationId, id);
        const legacy = await gateFacts(tx, organizationId, id);
        const activationGate = computeActivationGate(legacy);
        const physician = adm.hospicePhysicianId
          ? await getMdmEntityProvider().resolvePhysician(organizationId, adm.hospicePhysicianId)
          : null;
        return {
          id: adm.id,
          state: adm.status,
          version: Number(adm.version),
          patientId: adm.patientId,
          referralId: adm.referralId,
          admissionAt: adm.admissionAt?.toISOString() ?? null,
          activatedAt: adm.activatedAt?.toISOString() ?? null,
          providerEntityId: adm.providerEntityId ?? null,
          locationId: adm.locationId ?? null,
          patientResidenceAddressId: adm.patientResidenceAddressId ?? null,
          serviceAddressSnapshot:
            adm.serviceAddressLine1 && adm.serviceAddressCity && adm.serviceAddressPostalCode
              ? {
                  line1: adm.serviceAddressLine1,
                  line2: adm.serviceAddressLine2,
                  city: adm.serviceAddressCity,
                  state: adm.serviceAddressState,
                  postalCode: adm.serviceAddressPostalCode,
                  country: adm.serviceAddressCountry ?? "US",
                }
              : null,
          hospicePhysicianId: adm.hospicePhysicianId ?? null,
          hospicePhysician: physician
            ? {
                id: physician.id,
                displayName: physician.canonical.displayName,
                npi: physician.canonical.identifierValue ?? null,
              }
            : null,
          primaryDiagnosisIcd10: adm.primaryDiagnosisIcd10 ?? null,
          referringDxText: adm.referringDxText ?? null,
          admissionRecommendation:
            adm.recommendedByUserId && adm.recommenderCapacity && adm.recommendedAt
              ? {
                  recommendedByUserId: adm.recommendedByUserId,
                  capacity: adm.recommenderCapacity,
                  recommendedAt: adm.recommendedAt.toISOString(),
                  attendingConsulted: adm.attendingConsulted ?? false,
                  attendingConsultNote: adm.attendingConsultNote ?? null,
                }
              : null,
          attendingPhysicianId: adm.attendingPhysicianId ?? null,
          admissionTypeCode: adm.admissionTypeCode ?? null,
          admissionSourceCode: adm.admissionSourceCode ?? null,
          activationGate,
          readiness: readiness ?? undefined,
        };
      });
    },
    async getAdmissionReadiness(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        readinessForAdmission(tx, organizationId, id),
      );
    },
    async getPatientElectionCertification(
      organizationId,
      patientId,
    ): Promise<PatientElectionCertificationView> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
        // The patient's newest admission (RLS scopes to org). `patient_id` is NOT NULL, no FK.
        const [adm] = await tx
          .select({
            id: ADM.id,
            status: ADM.status,
            admissionAt: ADM.admissionAt,
            activatedAt: ADM.activatedAt,
            dischargedAt: ADM.dischargedAt,
            version: ADM.version,
          })
          .from(ADM)
          .where(eq(ADM.patientId, patientId))
          .orderBy(desc(ADM.admissionAt), desc(ADM.createdAt))
          .limit(1);
        if (!adm) return { admission: null, periods: [], complianceWindows: [] };

        const periodRows = await tx
          .select({
            id: EP.id,
            sequenceNumber: EP.sequenceNumber,
            periodKind: EP.periodKind,
            effectiveAt: EP.effectiveAt,
            scheduledEndAt: EP.scheduledEndAt,
            actualEndAt: EP.actualEndAt,
            status: EP.status,
          })
          .from(EP)
          .where(eq(EP.admissionId, adm.id))
          .orderBy(EP.sequenceNumber);
        const periodIds = periodRows.map((p) => p.id);

        // One query each for the period-scoped bundles (avoids N+1 across the ladder).
        const esRows = periodIds.length
          ? await tx
              .select({
                id: ES.id,
                electionPeriodId: ES.electionPeriodId,
                status: ES.status,
                signerKind: ES.signerKind,
                signedAt: ES.signedAt,
                createdAt: ES.createdAt,
                version: ES.version,
              })
              .from(ES)
              .where(inArray(ES.electionPeriodId, periodIds))
          : [];
        const ctiRows = periodIds.length
          ? await tx
              .select({
                id: CTI.id,
                electionPeriodId: CTI.electionPeriodId,
                status: CTI.status,
                version: CTI.version,
                hospiceMdSignedAt: CTI.hospiceMdSignedAt,
                attendingMdSignedAt: CTI.attendingMdSignedAt,
                signedLate: CTI.signedLate,
                periodStart: CTI.periodStart,
                periodEnd: CTI.periodEnd,
                createdAt: CTI.createdAt,
              })
              .from(CTI)
              .where(inArray(CTI.electionPeriodId, periodIds))
          : [];
        const evidenceService = createAdmissionEvidenceService(tx);

        const evidenceByPeriod = new Map<
          string,
          Awaited<ReturnType<typeof evidenceService.readFacts>>
        >();

        for (const periodId of periodIds) {
          const facts = await evidenceService.readFacts({
            organizationId,
            admissionId: adm.id,
            electionPeriodId: periodId,
          });

          evidenceByPeriod.set(periodId, facts);
        }
        const f2fRows = periodIds.length
          ? await tx
              .select({
                id: F2F.id,
                electionPeriodId: F2F.electionPeriodId,
                status: F2F.status,
                performerRole: F2F.performerRole,
                encounterDate: F2F.encounterDate,
                encounterLocation: F2F.encounterLocation,
                encounterId: F2F.encounterId,
                performedByUserId: F2F.performedByUserId,
                withinWindow: F2F.withinWindow,
                windowOverride: F2F.windowOverride,
                attestationSignedAt: F2F.attestationSignedAt,
                createdAt: F2F.createdAt,
                version: F2F.version,
              })
              .from(F2F)
              .where(inArray(F2F.electionPeriodId, periodIds))
          : [];
        // One row per period, deterministically: a period can hold voided CTIs beside the live one
        // (`cti_period_active_idx` is partial) and scheduled/completed F2Fs beside the attested one, and
        // the rows come back unordered — the pick prefers the most-live status, then the newest.
        const esBy = pickOnePerPeriod(esRows, ELECTION_STATEMENT_STATUS_RANK);
        const ctiBy = pickOnePerPeriod(ctiRows, CTI_STATUS_RANK);
        const f2fBy = pickOnePerPeriod(f2fRows, F2F_STATUS_RANK);

        const periods = periodRows.map((p) => {
          const es = esBy.get(p.id);
          const cti = ctiBy.get(p.id);
          const f2f = f2fBy.get(p.id);

          const evidenceFacts = evidenceByPeriod.get(p.id);

          const electionEvidence = evidenceFacts?.electionStatement;
          const electionSignatureEvidence = evidenceFacts?.electionSignature;

          const uploadedElection =
            electionEvidence?.sourceType === "uploaded" ? electionEvidence : undefined;

          const uploadedElectionSignature =
            electionSignatureEvidence?.sourceType === "uploaded"
              ? electionSignatureEvidence
              : undefined;

          const uploadedCti = evidenceFacts?.cti;
          const uploadedCtiSignature = evidenceFacts?.ctiSignature;

          return {
            id: p.id,
            sequenceNumber: p.sequenceNumber,
            periodKind: p.periodKind,
            effectiveAt: p.effectiveAt,
            scheduledEndAt: p.scheduledEndAt,
            actualEndAt: p.actualEndAt,
            status: p.status,
            electionStatement: es
              ? {
                  id: es.id,
                  status: es.status,
                  signerKind: es.signerKind,
                  signedAt: es.signedAt,
                  sourceType: "structured" as const,
                }
              : uploadedElection
                ? {
                    id: uploadedElection.documentId ?? `uploaded-election-${p.id}`,
                    status: uploadedElectionSignature ? "signed" : "drafted",
                    signerKind: uploadedElectionSignature ? "uploaded" : "unknown",
                    signedAt: uploadedElectionSignature?.completedAt ?? null,
                    sourceType: "uploaded" as const,
                  }
                : null,
            cti: cti
              ? {
                  id: cti.id,
                  status: cti.status,
                  version: Number(cti.version),
                  sourceType: "structured" as const,
                  hospiceMdSigned: !!cti.hospiceMdSignedAt,
                  attendingMdSigned: !!cti.attendingMdSignedAt,
                  signedLate: cti.signedLate,
                  periodStart: cti.periodStart,
                  periodEnd: cti.periodEnd,
                }
              : uploadedCti
                ? {
                    id: uploadedCti.documentId ?? `uploaded-cti-${p.id}`,
                    status: uploadedCtiSignature ? "signed" : "drafted",
                    version: 0,
                    sourceType: "uploaded" as const,
                    hospiceMdSigned: !!uploadedCtiSignature,
                    attendingMdSigned: false,
                    signedLate: false,
                    periodStart: p.effectiveAt,
                    periodEnd: p.scheduledEndAt,
                  }
                : null,
            faceToFace: f2f
              ? {
                  id: f2f.id,
                  status: f2f.status,
                  performerRole: f2f.performerRole,
                  encounterDate: f2f.encounterDate,
                  // FY2027 R-F2F-05 / R-F2F-06 — the modality and the linked signed note (when the
                  // § 418.22(b)(4) attestation is a clinical note rather than a written narrative).
                  encounterLocation: f2f.encounterLocation,
                  attestationNoteEncounterId: f2f.encounterId,
                  performerUserId: f2f.performedByUserId,
                  withinWindow: f2f.withinWindow,
                  windowOverride: f2f.windowOverride,
                  attested: !!f2f.attestationSignedAt,
                }
              : null,
          };
        });

        const cwRows = await tx
          .select({
            id: CW.id,
            windowKind: CW.windowKind,
            severity: CW.severity,
            status: CW.status,
            mustCompleteBy: CW.mustCompleteBy,
            closedAt: CW.closedAt,
          })
          .from(CW)
          .where(eq(CW.admissionId, adm.id))
          .orderBy(desc(CW.mustCompleteBy));

        return {
          admission: {
            id: adm.id,
            state: adm.status,
            admissionAt: iso(adm.admissionAt),
            activatedAt: iso(adm.activatedAt),
            dischargedAt: iso(adm.dischargedAt),
            version: Number(adm.version),
          },
          periods,
          complianceWindows: cwRows.map((w) => ({
            id: w.id,
            windowKind: w.windowKind,
            severity: w.severity,
            status: w.status,
            mustCompleteBy: w.mustCompleteBy.toISOString(),
            closedAt: iso(w.closedAt),
          })),
        };
      });
    },

    // ── Election reads ───────────────────────────────────────────────────────────────────────────
    async getElectionStatement(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: ES.id,
            status: ES.status,
            version: ES.version,
            electionPeriodId: ES.electionPeriodId,
            declaredEffectiveDate: ES.declaredEffectiveDate,
            primaryDiagnosisIcd10AtElection: ES.primaryDiagnosisIcd10AtElection,
            electedProviderEntityId: ES.providerEntityId,
            electedAttendingPhysicianId: ES.attendingPhysicianId,
            waiverAcknowledged: ES.curativeCareAcknowledgment,
            stateAddendum: ES.stateAddendum,
            signerKind: ES.signerKind,
            signedAt: ES.signedAt,
          })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        return r
          ? {
              id: r.id,
              state: r.status,
              version: Number(r.version),
              electionPeriodId: r.electionPeriodId,
              effectiveDate: r.declaredEffectiveDate,
              primaryDiagnosisIcd10: r.primaryDiagnosisIcd10AtElection,
              electedProviderEntityId: r.electedProviderEntityId,
              electedAttendingPhysicianId: r.electedAttendingPhysicianId,
              waiverAcknowledged: r.waiverAcknowledged,
              stateAddendum: r.stateAddendum,
              signerKind: r.signerKind,
              signedAt: r.signedAt,
            }
          : null;
      });
    },
    async listElectionPeriods(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({
            id: EP.id,
            state: EP.status,
            version: EP.version,
            sequenceNumber: EP.sequenceNumber,
            expectedStart: EP.expectedStart,
            effectiveAt: EP.effectiveAt,
            scheduledEndAt: EP.scheduledEndAt,
            actualEndAt: EP.actualEndAt,
          })
          .from(EP)
          .where(eq(EP.admissionId, admissionId))
          .orderBy(EP.sequenceNumber);
        return rows.map((r) => ({
          ...toSummary(r),
          sequenceNumber: Number(r.sequenceNumber),
          expectedStart: r.expectedStart,
          effectiveAt: r.effectiveAt,
          scheduledEndAt: r.scheduledEndAt,
          actualEndAt: r.actualEndAt,
        }));
      });
    },

    // ── CTI / F2F reads ──────────────────────────────────────────────────────────────────────────
    async getCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: CTI.id,
            state: CTI.status,
            version: CTI.version,
            electionPeriodId: CTI.electionPeriodId,
            hospiceMedicalDirectorId: CTI.hospiceMdId,
            attendingPhysicianId: CTI.attendingMdId,
            terminalDiagnosisIcd10: CTI.terminalDiagnosisIcd10,
            secondaryDiagnoses: CTI.relatedConditionsIcd10,
            prognosisStatement: CTI.prognosisStatement,
            narrative: CTI.narrative,
            clinicalFindings: CTI.clinicalFindings,
            hospiceMdSignedAt: CTI.hospiceMdSignedAt,
            attendingMdSignedAt: CTI.attendingMdSignedAt,
            periodStart: CTI.periodStart,
            periodEnd: CTI.periodEnd,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r
          ? {
              ...toSummary(r),
              electionPeriodId: r.electionPeriodId,
              hospiceMedicalDirectorId: r.hospiceMedicalDirectorId,
              attendingPhysicianId: r.attendingPhysicianId,
              terminalDiagnosisIcd10: r.terminalDiagnosisIcd10,
              secondaryDiagnoses: r.secondaryDiagnoses,
              prognosisStatement: r.prognosisStatement,
              narrative: r.narrative,
              clinicalFindings: r.clinicalFindings,
              hospiceMdSignedAt: r.hospiceMdSignedAt?.toISOString() ?? null,
              attendingMdSignedAt: r.attendingMdSignedAt?.toISOString() ?? null,
              periodStart: r.periodStart,
              periodEnd: r.periodEnd,
            }
          : null;
      });
    },
    async getF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: F2F.id,
            state: F2F.status,
            version: F2F.version,
            electionPeriodId: F2F.electionPeriodId,
            scheduledClinicianId: F2F.performedByUserId,
            clinicianRole: F2F.performerRole,
            scheduledDate: F2F.scheduledDate,
            encounterDate: F2F.encounterDate,
            requestedWindowStart: F2F.requestedWindowStart,
            requestedWindowEnd: F2F.requestedWindowEnd,
            authoritativeWindowStart: F2F.authoritativeWindowStart,
            authoritativeWindowEnd: F2F.authoritativeWindowEnd,
            withinWindow: F2F.withinWindow,
            windowOverride: F2F.windowOverride,
            attestationSignedAt: F2F.attestationSignedAt,
          })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!r) return null;
        const currentStart = await resolvePeriodF2fWindowStart(tx as DbClient, r.electionPeriodId);
        const currentWindow = currentStart
          ? computeF2fWindow(currentStart.start, DEFAULT_ORG_TZ)
          : null;
        return {
          ...toSummary(r),
          electionPeriodId: r.electionPeriodId,
          scheduledClinicianId: r.scheduledClinicianId,
          clinicianRole: r.clinicianRole,
          scheduledDate: r.scheduledDate,
          encounterDate: r.encounterDate,
          requestedWindowStart: r.requestedWindowStart,
          requestedWindowEnd: r.requestedWindowEnd,
          authoritativeWindowStart: currentWindow?.windowStart ?? null,
          authoritativeWindowEnd: currentWindow?.windowEnd ?? null,
          withinWindow: r.withinWindow,
          windowOverride: r.windowOverride,
          attestationSignedAt: r.attestationSignedAt?.toISOString() ?? null,
        };
      });
    },

    // ── LOC / NOR reads (derived state — neither table carries a status column) ────────────────────
    async listLoc(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: LOC.id, status: LOC.status, version: LOC.version })
          .from(LOC)
          .where(eq(LOC.admissionId, admissionId))
          .orderBy(desc(LOC.effectiveAt));
        return rows.map((r) => ({
          id: r.id,
          state: r.status,
          version: Number(r.version),
        }));
      });
    },
    async getNor(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: NOR.id,
            version: NOR.version,
            acknowledgedAt: NOR.acknowledgedAt,
            acknowledgedAtInstant: NOR.acknowledgedAtInstant,
            acknowledgedByName: NOR.acknowledgedByName,
            acknowledgedByRole: NOR.signerKind,
            deliveryMethod: NOR.acknowledgmentMethod,
          })
          .from(NOR)
          .where(eq(NOR.admissionId, admissionId))
          .limit(1);
        return r
          ? {
              id: r.id,
              state: "acknowledged",
              version: Number(r.version),
              acknowledgedAt: r.acknowledgedAt,
              acknowledgedAtInstant: r.acknowledgedAtInstant?.toISOString() ?? null,
              acknowledgedByName: r.acknowledgedByName,
              acknowledgedByRole:
                r.acknowledgedByRole === "representative" ? "legal_representative" : "patient",
              deliveryMethod: r.deliveryMethod,
            }
          : null;
      });
    },

    // ── Compliance-window reads ────────────────────────────────────────────────────────────────────
    async listComplianceWindowsForAdmission(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select(complianceWindowColumns)
          .from(CW)
          .where(eq(CW.admissionId, admissionId))
          .orderBy(desc(CW.mustCompleteBy));
        return rows.map(toComplianceWindowRow);
      });
    },
    async listComplianceWindows(organizationId, query) {
      // FY2027 — its own read (not `pageByStatus`) so each row says what the window is and when it is due:
      // the dashboard could not tell an election-addendum window from any other kind.
      const limit = clampLimit(query.limit);
      const offset = parseOffset(query.cursor);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select(complianceWindowColumns)
          .from(CW)
          .where(query.state ? eq(CW.status, query.state as never) : undefined)
          .orderBy(desc(CW.mustCompleteBy), desc(CW.id))
          .limit(limit + 1)
          .offset(offset);
        return {
          items: rows.slice(0, limit).map(toComplianceWindowRow),
          nextCursor: rows.length > limit ? String(offset + limit) : null,
        };
      });
    },

    // ── Writes — the M6L-T02+ Drizzle lifecycle (live). ─────────────────────────────────────────────
    // ── M6L-T02: referral intake ───────────────────────────────────────────────────────────────
    async createReferral(organizationId, input, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        if (input.externalReferralId) {
          const existing = await tx
            .select({ id: REF.id })
            .from(REF)
            .where(
              and(
                eq(REF.organizationId, organizationId),
                eq(REF.externalReferralId, input.externalReferralId),
              ),
            )
            .limit(1);
          if (existing.length > 0) {
            throw new ExternalReferralAlreadyIngestedError(input.externalReferralId);
          }
        }

        const rows = await tx
          .insert(REF)
          .values({
            organizationId,
            patientId: input.patientId ?? null,
            patientResolutionStatus: input.patientId ? "matched" : "unresolved",
            patientNameAtReceipt: input.patientNameAtReceipt,
            patientDobAtReceipt: input.patientDobAtReceipt ?? null,
            medicareNumberAtReceipt: referralMedicareNumber(input.medicareNumberAtReceipt),
            medicaidNumberAtReceipt: referralMedicaidNumber(input.medicaidNumberAtReceipt),
            sexAssignedAtBirth: input.sexAssignedAtBirth ?? "U",
            referringDxText: input.referringDxText ?? null,
            referrerName: input.referrerName ?? null,
            referrerOrganization: input.referrerOrganization ?? null,
            referrerPhone: input.referrerPhone ?? null,
            externalReferralId: input.externalReferralId ?? null,
            receivedAt: input.receivedAt ? new Date(input.receivedAt) : now(),
            sourceChannel: input.source as ReferralSourceChannel,
          })
          .returning({
            id: REF.id,
            status: REF.status,
            version: REF.version,
          });
        const r = firstOrThrow(rows, "referral insert returned no row");
        await recordReferralActivity(
          tx,
          organizationId,
          r.id,
          actorUserId,
          "referral_received",
          null,
          r.status,
        );
        const mbi = referralMedicareNumber(input.medicareNumberAtReceipt);
        if (input.patientId && mbi) {
          // Referral for an already-known patient: seed the chart's MBI when it has none.
          await patientResolver().recordMedicareNumberIfMissing({
            organizationId,
            patientId: input.patientId,
            medicareNumber: mbi,
          });
        }
        await outbox.publish(tx, {
          eventName: "m6.referral.received",
          payload: {
            referralId: r.id,
            source: input.source,
            receivedAt: input.receivedAt,
          },
          organizationId,
          aggregateKind: "referral",
          aggregateId: r.id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async updateReferral(organizationId, id, input, ifVersion): Promise<MutationResult> {
      // Metadata edit — no state change; still optimistic-locked (§7.1 concurrency).
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (!["received", "under_review", "pending_information"].includes(cur.status)) {
          throw new InvalidReferralStateError(id, cur.status, "update referral information");
        }
        const [r] = await tx
          .update(REF)
          .set({
            medicareNumberAtReceipt:
              input.medicareNumberAtReceipt === undefined
                ? undefined
                : referralMedicareNumber(input.medicareNumberAtReceipt),
            medicaidNumberAtReceipt:
              input.medicaidNumberAtReceipt === undefined
                ? undefined
                : referralMedicaidNumber(input.medicaidNumberAtReceipt),
            referringDxText: input.referringDxText,
            referrerName: input.referrerName,
            referrerOrganization: input.referrerOrganization,
            referrerPhone: input.referrerPhone,
            sexAssignedAtBirth: input.sexAssignedAtBirth,
            version: sql`${REF.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
          .returning({ id: REF.id, status: REF.status, version: REF.version });
        if (!r) return failStale(tx, REF, id, ifVersion);
        const mbi =
          input.medicareNumberAtReceipt === undefined
            ? null
            : referralMedicareNumber(input.medicareNumberAtReceipt);
        if (cur.patientId && mbi) {
          // Already linked to a patient: the number reaches the chart only if it has none (M5 decides).
          await patientResolver().recordMedicareNumberIfMissing({
            organizationId,
            patientId: cur.patientId,
            medicareNumber: mbi,
          });
        }
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async triageReferral(organizationId, id, outcome, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "received")
          throw new InvalidReferralStateError(id, cur.status, "triage");
        const next = outcome === "eligible" ? "under_review" : "declined";
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: next,
              reviewedAt: outcome === "eligible" ? now() : null,
              declinedAt: outcome === "ineligible" ? now() : null,
              decidedAt: outcome === "ineligible" ? now() : null,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          "",
          outcome === "eligible" ? "review_started" : "declined",
          cur.status,
          r.status,
        );
        await outbox.publish(tx, {
          eventName: outcome === "eligible" ? "m6.referral.review_started" : "m6.referral.declined",
          payload:
            outcome === "eligible"
              ? { referralId: id, outcome }
              : {
                  referralId: id,
                  reason: "ineligible",
                  ...(await referralPatientFields(tx, id, cur.patientId)),
                },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        // GAP-177 — the triage OUTCOME itself is catalogued (`m6.referral.triaged`) and had no emit site.
        await outbox.publish(tx, {
          eventName: "m6.referral.triaged",
          payload: { referralId: id, outcome },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async acceptReferral(
      organizationId,
      id,
      input,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult & { admissionId: string }> {
      return this.convertReferral(organizationId, id, input, ifVersion, actorUserId, {
        emitAccepted: true,
      });
    },
    async startReferralReview(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "received" && cur.status !== "pending_information") {
          throw new InvalidReferralStateError(id, cur.status, "start review");
        }
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "under_review",
              reviewedAt: now(),
              reviewedBy: actorUserId || null,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          cur.status === "pending_information" ? "returned_to_review" : "review_started",
          cur.status,
          r.status,
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.review_started",
          payload: { referralId: id },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async runReferralPatientMatching(organizationId, id, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (!["under_review", "pending_information"].includes(cur.status)) {
          throw new InvalidReferralStateError(id, cur.status, "match patient");
        }
        const result = await patientResolver().findPatientCandidates({
          organizationId,
          patientNameAtReceipt: cur.patientNameAtReceipt,
          patientDobAtReceipt: cur.patientDobAtReceipt,
          medicareNumberAtReceipt: cur.medicareNumberAtReceipt,
        });
        const nextResolution = result.outcome === "no_match" ? "unresolved" : "possible_match";
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              patientResolutionStatus: nextResolution,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        if (result.outcome !== "no_match") {
          await recordReferralActivity(
            tx,
            organizationId,
            id,
            actorUserId,
            "patient_match_suggested",
            cur.status,
            r.status,
            {
              candidateCount: result.candidates.length,
            },
          );
        }
        return {
          id: r.id,
          state: r.status,
          version: Number(r.version),
          candidates: result.candidates,
        };
      });
    },
    async confirmReferralPatient(organizationId, id, patientId, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        const patient = await patientResolver().confirmPatient({
          organizationId,
          patientId,
        });
        if (!patient)
          throw new WardenXError("PATIENT_NOT_FOUND", "patient was not found in M5", 404);
        // The referral's Medicare number reaches the chart only if the chart has none (M5 decides).
        const medicareOnChart = cur.medicareNumberAtReceipt
          ? await patientResolver().recordMedicareNumberIfMissing({
              organizationId,
              patientId: patient.id,
              medicareNumber: cur.medicareNumberAtReceipt,
            })
          : null;
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              patientId: patient.id,
              patientResolutionStatus: "matched",
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "patient_match_confirmed",
          cur.status,
          r.status,
          {
            patientId: patient.id,
            ...(medicareOnChart ? { medicareNumber: medicareOnChart } : {}),
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async createReferralPatient(organizationId, id, ifVersion, actorUserId, actorSite) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (!cur.patientDobAtReceipt) {
          throw new ValidationError(
            "patient DOB is required to create a canonical patient from intake",
            [
              {
                field: "patientDobAtReceipt",
                code: "PATIENT_DOB_REQUIRED",
                message:
                  "Patient date of birth is required before creating a patient from referral intake.",
              },
            ],
          );
        }
        // The actor who creates the patient is put on its caseload (M5, same transaction as the patient
        // insert; the referral update below is a separate outer transaction, so a failure there leaves an
        // orphan patient and a retry gets the 409 duplicate message against it) so they can open the chart
        // and admission they just made. A duplicate MBI in this org is a conflict, never a 500; the
        // raw error carries bound parameters (PHI) and is neither logged nor returned.
        const patient = await patientResolver()
          .createPatientFromIntake({
            organizationId,
            patientNameAtReceipt: cur.patientNameAtReceipt,
            patientDobAtReceipt: cur.patientDobAtReceipt,
            medicareNumberAtReceipt: cur.medicareNumberAtReceipt,
            administrativeSex: cur.sexAssignedAtBirth ?? "U",
            ...(actorUserId ? { createdByUserId: actorUserId } : {}),
            // The creator's single default site, so a site-scoped supervisor/clinician at that site can open the
            // admission. M5's activation consumer later overwrites it with the admission's own siting.
            ...(actorSite
              ? { providerEntityId: actorSite.providerEntityId, locationId: actorSite.locationId }
              : {}),
          })
          .catch((err: unknown) => {
            throw mapUniqueViolation(err, { patient_identifier_mbi_unique: duplicatePatientMbi });
          });
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              patientId: patient.id,
              patientResolutionStatus: "created",
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "patient_created",
          cur.status,
          r.status,
          {
            patientId: patient.id,
          },
        );
        return {
          id: r.id,
          state: r.status,
          version: Number(r.version),
          patientId: patient.id,
        };
      });
    },
    async qualifyReferral(organizationId, id, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "under_review")
          throw new InvalidReferralStateError(id, cur.status, "qualify");
        const blockers = qualificationBlockers(cur);
        if (blockers.length > 0) throw new ReferralNotReadyError(blockers);
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "qualified",
              qualifiedAt: now(),
              qualifiedBy: actorUserId || null,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "qualified",
          cur.status,
          r.status,
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.qualified",
          payload: { referralId: id, patientId: cur.patientId },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async convertReferral(
      organizationId,
      id,
      input,
      ifVersion,
      actorUserId,
      opts,
    ): Promise<MutationResult & { admissionId: string }> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status === "converted") {
          const [existing] = await tx
            .select({ id: ADM.id, version: ADM.version })
            .from(ADM)
            .where(and(eq(ADM.organizationId, organizationId), eq(ADM.referralId, id)))
            .limit(1);
          if (existing)
            return {
              id,
              state: "converted",
              version: cur.version,
              admissionId: existing.id,
            };
          throw new ReferralAlreadyConvertedError(id);
        }
        if (cur.status !== "qualified") throw new ReferralNotTriagedError(id);
        if (!cur.patientId || !["matched", "created"].includes(cur.patientResolutionStatus)) {
          throw new ReferralNotReadyError(qualificationBlockers(cur));
        }
        const patientId = cur.patientId;
        const confirmed = await patientResolver().confirmPatient({
          organizationId,
          patientId,
        });
        if (!confirmed)
          throw new WardenXError("PATIENT_NOT_FOUND", "resolved M5 patient no longer exists", 409);
        // §2.3.1 no double-election: block if the patient already has an open admission.
        const [open] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.patientId, patientId),
              ne(ADM.status, "discharged"),
              ne(ADM.status, "bereavement"),
              ne(ADM.status, "closed"),
            ),
          )
          .limit(1);
        // Validate the createAdmission event FIRST (it throws PATIENT_ALREADY_ELECTED on a double open),
        // then insert the admission directly at the transition's target state — never a half-open row.
        const t = transitionAdmission("referred", {
          type: "createAdmission",
          referralAccepted: true,
          hasOtherOpenAdmission: !!open,
        } satisfies AdmissionEvent);
        // Readmission workflow — the first benefit period (staff-entered or history-suggested), validated first.
        const first = await resolveFirstBenefitPeriod(tx as DbClient, {
          organizationId,
          patientId,
          input,
          actorUserId,
          now: now(),
        });
        const adm = firstOrThrow(
          await tx
            .insert(ADM)
            .values({
              organizationId,
              patientId,
              referralId: id,
              status: t.to,
              ...(first.admissionAt ? { admissionAt: first.admissionAt } : {}),
            })
            .returning({ id: ADM.id, version: ADM.version }),
          "admission insert returned no row",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "admission",
            aggregateId: adm.id,
            admissionId: adm.id,
          },
          t.effects,
          { "m6.admission.draft_created": { patientId, referralId: id } },
        );
        // Seed the first benefit period (the §7.1 cascade — not a state-machine effect). It is period 1 only for a
        // patient with no earlier election; a re-election continues the count (42 CFR 418.21 / 418.24).
        await tx.insert(EP).values({
          organizationId,
          admissionId: adm.id,
          ...first.periodValues,
        });
        // Advance the referral to converted.
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "converted",
              icd10TerminalPrimary: input.primaryDiagnosisIcd10,
              convertedAt: now(),
              convertedAdmissionId: adm.id,
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "converted",
          cur.status,
          r.status,
          {
            admissionId: adm.id,
          },
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.converted",
          payload: { referralId: id, patientId, admissionId: adm.id },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        // GAP-177 — route 6 (accept) is the same transition seen from the intake desk; it is catalogued
        // as its own event (record-only, M36 seam) and had no emit site.
        if (opts?.emitAccepted) {
          await outbox.publish(tx, {
            eventName: "m6.referral.accepted",
            payload: { referralId: id, patientId, admissionId: adm.id },
            organizationId,
            aggregateKind: "referral",
            aggregateId: id,
          });
        }
        return {
          id: r.id,
          state: r.status,
          version: Number(r.version),
          admissionId: adm.id,
        };
      });
    },
    async declineReferral(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (!["received", "under_review", "pending_information"].includes(cur.status)) {
          throw new InvalidReferralStateError(id, cur.status, "update referral priority");
        }
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "declined",
              rejectionReason: reason,
              declinedAt: now(),
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.declined",
          payload: {
            referralId: id,
            reason,
            ...(await referralPatientFields(tx, id, cur.patientId)),
          },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async addReferralNote(organizationId, id, input, actorUserId): Promise<ReferralNoteView> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        await loadRef(tx, id);
        const r = firstOrThrow(
          await tx
            .insert(RN)
            .values({
              organizationId,
              referralId: id,
              authorId: actorUserId || null,
              content: input.content,
            })
            .returning({
              id: RN.id,
              referralId: RN.referralId,
              authorId: RN.authorId,
              content: RN.content,
              createdAt: RN.createdAt,
              updatedAt: RN.updatedAt,
            }),
          "referral note insert returned no row",
        );
        await recordReferralActivity(tx, organizationId, id, actorUserId, "note_added", null, null);
        return {
          id: r.id,
          referralId: r.referralId,
          authorId: r.authorId ?? null,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      });
    },
    async listReferralNotes(organizationId, id): Promise<readonly ReferralNoteView[]> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        await loadRef(tx, id);
        const rows = await tx
          .select({
            id: RN.id,
            referralId: RN.referralId,
            authorId: RN.authorId,
            content: RN.content,
            createdAt: RN.createdAt,
            updatedAt: RN.updatedAt,
          })
          .from(RN)
          .where(eq(RN.referralId, id))
          .orderBy(desc(RN.createdAt));
        return rows.map((r) => ({
          id: r.id,
          referralId: r.referralId,
          authorId: r.authorId ?? null,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }));
      });
    },
    async listReferralActivity(organizationId, id): Promise<readonly ReferralActivityView[]> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        await loadRef(tx, id);
        const rows = await tx
          .select({
            id: RA.id,
            referralId: RA.referralId,
            actorId: RA.actorId,
            action: RA.action,
            fromStatus: RA.fromStatus,
            toStatus: RA.toStatus,
            metadata: RA.metadata,
            createdAt: RA.createdAt,
          })
          .from(RA)
          .where(eq(RA.referralId, id))
          .orderBy(desc(RA.createdAt));
        return rows.map((r) => ({
          id: r.id,
          referralId: r.referralId,
          actorId: r.actorId ?? null,
          action: r.action,
          fromStatus: r.fromStatus ?? null,
          toStatus: r.toStatus ?? null,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
        }));
      });
    },
    async updateReferralPriority(organizationId, id, priority, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (!["received", "under_review", "pending_information"].includes(cur.status)) {
          throw new InvalidReferralStateError(id, cur.status, "update referral priority");
        }
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              priority,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "priority_updated",
          null,
          null,
          {
            priority,
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async assignReferral(organizationId, id, assignedToUserId, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              assignedToUserId: assignedToUserId ?? null,
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(tx, organizationId, id, actorUserId, "assigned", null, null, {
          assignedToUserId: assignedToUserId ?? null,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async markReferralPendingInformation(organizationId, id, reason, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "under_review") {
          throw new InvalidReferralStateError(id, cur.status, "mark pending information");
        }
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "pending_information",
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "pending_information_requested",
          cur.status,
          r.status,
          {
            reason,
          },
        );
        await tx.insert(RN).values({
          organizationId,
          referralId: id,
          authorId: actorUserId || null,
          content: `Pending information requested: ${reason}`,
        });
        await outbox.publish(tx, {
          eventName: "m6.referral.pending_information",
          payload: { referralId: id },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async markReferralDuplicate(organizationId, id, reason, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status === "converted")
          throw new InvalidReferralStateError(id, cur.status, "mark duplicate");
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "duplicate",
              rejectionReason: reason ?? "Duplicate referral",
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "duplicate",
          cur.status,
          r.status,
          {
            reason: reason ?? null,
          },
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.duplicate",
          payload: { referralId: id, ...(await referralPatientFields(tx, id, cur.patientId)) },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async withdrawReferral(organizationId, id, reason, ifVersion, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        // Only an open referral withdraws (the same four states the HL7 withdrawal path guards): a repeat withdraw
        // would re-emit `m6.referral.withdrawn`, and declined / duplicate / converted referrals are already closed.
        if (!["received", "under_review", "pending_information", "qualified"].includes(cur.status))
          throw new InvalidReferralStateError(id, cur.status, "withdraw");
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "withdrawn",
              rejectionReason: reason ?? "Referral withdrawn",
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({
              id: REF.id,
              status: REF.status,
              version: REF.version,
            }),
          "row not found",
        );
        await recordReferralActivity(
          tx,
          organizationId,
          id,
          actorUserId,
          "withdrawn",
          cur.status,
          r.status,
          {
            reason: reason ?? null,
          },
        );
        // M5 ends the creator's access grant on the patient (the catalogued event had no manual emit site).
        const [received] = await tx
          .select({ receivedAt: REF.receivedAt })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        const withdrawnAt = now();
        await outbox.publish(tx, {
          eventName: "m6.referral.withdrawn",
          payload: {
            referralId: id,
            organizationId,
            withdrawnVia: "manual",
            originalReferralReceivedAt: (received?.receivedAt ?? withdrawnAt).toISOString(),
            withdrawnAt: withdrawnAt.toISOString(),
            ...(await referralPatientFields(tx, id, cur.patientId)),
          },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T02: admission lifecycle ────────────────────────────────────────────────────────────
    // TASK-034 rewrite — this used to insert at the DB's default `status='referred'` (a fresh
    // admission's only legal transition, ADMISSION_GRAPH, is out of `referred` via the referral-accept
    // path — a direct-intake admission never reached anywhere), mapped `attendingPhysicianId` into the
    // WRONG column (`admitted_by_physician_id`, not `attending_physician_id`), and dropped
    // `hospiceMedicalDirectorId` entirely (no period, no CTI, so the activation gate could never even
    // be evaluated). Now mirrors `acceptReferral`'s cascade: the same `createAdmission` state-machine
    // event (opens the same 4 compliance windows, lands on `pending`), a seeded period 1, and a draft
    // CTI carrying the hospice-MD/attending ids the form actually asked for.
    async createAdmission(organizationId, input, actorUserId): Promise<MutationResult> {
      if (input.referralId) throw new ReferralAdmissionPathError();
      // The body's patient id must be a patient of THIS org (M5's org-scoped read — the same confirmation referral
      // conversion runs). Resolved before the transaction: the seam opens its own org context.
      const confirmed = await patientResolver().confirmPatient({
        organizationId,
        patientId: input.patientId,
      });
      if (!confirmed)
        throw new WardenXError(
          "PATIENT_NOT_FOUND",
          "the patient does not exist in this organization",
          409,
        );
      if (input.readmittedFromAdmissionId && input.intakeMethod === "transfer_in")
        throw new AdmissionStateError(
          "READMISSION_SOURCE_INVALID",
          "A transfer-in continues another hospice's election; record it through the transfer-in workflow, not as a readmission",
          [
            {
              field: "readmittedFromAdmissionId",
              code: "READMISSION_SOURCE_INVALID",
              message: "not allowed with intakeMethod transfer_in",
            },
          ],
        );
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        // §2.3.1 no double-election: same rule acceptReferral enforces — direct intake is a second
        // entry path into the same admission lifecycle, not an exemption from it.
        const [open] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.patientId, input.patientId),
              ne(ADM.status, "discharged"),
              ne(ADM.status, "bereavement"),
              ne(ADM.status, "closed"),
            ),
          )
          .limit(1);
        const t = transitionAdmission("referred", {
          type: "createAdmission",
          referralAccepted: true,
          hasOtherOpenAdmission: !!open,
        } satisfies AdmissionEvent);
        // Readmission workflow — the first benefit period is the staff-entered (or history-suggested) number,
        // validated before any write. A transfer-in inherits its sequence via `transferIn` instead (below).
        const first =
          input.intakeMethod === "transfer_in"
            ? null
            : await resolveFirstBenefitPeriod(tx as DbClient, {
                organizationId,
                patientId: input.patientId,
                input,
                actorUserId,
                now: now(),
              });
        const adm = firstOrThrow(
          await tx
            .insert(ADM)
            .values({
              organizationId,
              patientId: input.patientId,
              referralId: input.referralId ?? null,
              hospicePhysicianId: input.hospiceMedicalDirectorId,
              attendingPhysicianId: input.attendingPhysicianId ?? null,
              // UB-04 FL 14 / FL 15 (837I CL101 / CL102): null until recorded (the claim rule blocks without them).
              admissionTypeCode: input.admissionTypeCode ?? null,
              admissionSourceCode: input.admissionSourceCode ?? null,
              // §6.8 — who opened it: `admission.scope`'s creator arm while it is still unsited.
              createdByUserId: actorUserId || null,
              status: t.to,
              ...(first?.admissionAt ? { admissionAt: first.admissionAt } : {}),
              // Only once `resolveFirstBenefitPeriod` verified it is an earlier, live-ended stay of THIS patient in
              // THIS org (explicit org + patient predicates, not RLS alone).
              ...(first && input.readmittedFromAdmissionId
                ? { readmittedFromAdmissionId: input.readmittedFromAdmissionId }
                : {}),
            })
            .returning({
              id: ADM.id,
              status: ADM.status,
              version: ADM.version,
            }),
          "admission insert returned no row",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "admission",
            aggregateId: adm.id,
            admissionId: adm.id,
          },
          t.effects,
          {
            "m6.admission.draft_created": {
              patientId: input.patientId,
              ...(input.referralId ? { referralId: input.referralId } : {}),
            },
          },
        );
        // Seed benefit period 1 (mirrors acceptReferral's §7.1 cascade) — EXCEPT for a transfer-in
        // intake (W-DC-03/D9): that admission never has a "period 1" at all, since the receiving
        // hospice inherits the sending hospice's carried sequence via the dedicated `transferIn` call
        // (42 CFR 418.28, the benefit-period counter never restarts). Seeding period 1 here for a
        // transfer-in unconditionally created a spurious extra election_period row (+ a spurious CTI
        // attached to it) ahead of `transferIn`'s own inherited/next pair.
        if (!first) {
          return {
            id: adm.id,
            state: adm.status,
            version: Number(adm.version),
          };
        }
        const period = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId: adm.id,
              ...first.periodValues,
            })
            .returning({ id: EP.id }),
          "election period insert returned no row",
        );
        // Draft the CTI the form's hospiceMedicalDirectorId/attendingPhysicianId are for (mirrors
        // draftCti) — without this the id the user was required to enter had nowhere to go.
        const signatureRequestedAt = now();
        const signatureDueAt = new Date(computeCtiSignatureDueAt(signatureRequestedAt));
        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: period.id,
              hospiceMdId: input.hospiceMedicalDirectorId,
              attendingMdId: null,
              signatureRequestedAt,
              signatureDueAt,
            })
            .returning({ id: CTI.id }),
          "cti insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: {
            ctiId: cti.id,
            electionPeriodId: period.id,
            isRecert: false,
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        await outbox.publish(tx, {
          eventName: "m6.cti.signature_requested",
          payload: {
            ctiId: cti.id,
            hospiceMdId: input.hospiceMedicalDirectorId,
            requestedAt: signatureRequestedAt.toISOString(),
            dueAt: signatureDueAt.toISOString(),
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId: adm.id,
          electionPeriodId: period.id,
          patientId: input.patientId,
          requirementType: "cti",
          structuredEntityType: "cti",
          structuredEntityId: cti.id,
          metadata: { createdBy: "direct_intake" },
          createdByMembershipId: actorUserId,
        });
        return {
          id: adm.id,
          state: adm.status,
          version: Number(adm.version),
        };
      });
    },
    async updateAdmission(organizationId, id, input, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const updates: Record<string, unknown> = {
          version: sql`${ADM.version} + 1`,
          updatedAt: now(),
        };
        if (input.admissionAt !== undefined) updates.admissionAt = new Date(input.admissionAt);
        if (input.hospicePhysicianId !== undefined)
          updates.hospicePhysicianId = input.hospicePhysicianId;
        if (input.attendingPhysicianId !== undefined)
          updates.attendingPhysicianId = input.attendingPhysicianId;
        if (input.admissionTypeCode !== undefined)
          updates.admissionTypeCode = input.admissionTypeCode;
        if (input.admissionSourceCode !== undefined)
          updates.admissionSourceCode = input.admissionSourceCode;
        const [current] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            locationId: ADM.locationId,
          })
          .from(ADM)
          .where(eq(ADM.id, id))
          .limit(1);
        if (!current) throw new ResourceNotFoundError(id);
        const finalProviderEntityId =
          input.providerEntityId !== undefined ? input.providerEntityId : current.providerEntityId;
        const finalLocationId =
          input.locationId !== undefined ? input.locationId : current.locationId;
        if (finalProviderEntityId && finalLocationId) {
          const location = await foundationSites.locationProviderEntity(tx, finalLocationId);
          if (!location || location.providerEntityId !== finalProviderEntityId) {
            throw new LocationProviderMismatchError(finalLocationId, finalProviderEntityId);
          }
        }
        if (input.providerEntityId !== undefined) {
          updates.providerEntityId = input.providerEntityId;
        }
        if (input.providerEntityId !== undefined || input.admissionAt !== undefined) {
          const residence = await readCurrentResidenceAddress(
            tx,
            organizationId,
            current.patientId,
          );

          /*
           * Residence is optional while progressing through admission.
           *
           * If available, snapshot it onto the admission.
           * If absent, admission details may still be completed.
           */
          if (residence) {
            updates.patientResidenceAddressId = residence.id;
            updates.serviceAddressLine1 = residence.line1;
            updates.serviceAddressLine2 = residence.line2;
            updates.serviceAddressCity = residence.city;
            updates.serviceAddressState = residence.state;
            updates.serviceAddressPostalCode = residence.postalCode;
            updates.serviceAddressCountry = residence.country;
          }

          updates.locationId =
            input.locationId ??
            (finalProviderEntityId
              ? await foundationSites.defaultLocationIdForProviderEntity(tx, finalProviderEntityId)
              : null);
        } else if (input.locationId !== undefined) {
          updates.locationId = input.locationId;
        }
        const [r] = await tx
          .update(ADM)
          .set(updates)
          .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
          .returning({ id: ADM.id, status: ADM.status, version: ADM.version });
        if (!r) return failStale(tx, ADM, id, ifVersion);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async attachUploadedNoticeOfRights(organizationId, admissionId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            status: ADM.status,
            version: ADM.version,
          })
          .from(ADM)
          .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const svc = createAdmissionEvidenceService(tx, admissionDocumentValidator);
        for (const requirementType of requirementsForUploadedNoticeOfRights(input)) {
          await svc.recordUploadedEvidence({
            organizationId,
            admissionId,
            patientId: adm.patientId,
            requirementType,
            documentId: input.documentId,
            documentVersionId: input.documentVersionId,
            completedAt: input.acknowledgedAt ? new Date(input.acknowledgedAt) : undefined,
            metadata: { ...input },
            createdByMembershipId: actorUserId,
          });
        }
        return {
          id: admissionId,
          state: adm.status,
          version: Number(adm.version),
        };
      });
    },
    async attachUploadedElectionStatement(organizationId, electionPeriodId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [period] = await tx
          .select({ admissionId: EP.admissionId })
          .from(EP)
          .where(and(eq(EP.organizationId, organizationId), eq(EP.id, electionPeriodId)))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(electionPeriodId);
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            status: ADM.status,
            version: ADM.version,
          })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(period.admissionId);
        if (
          input.documentState === "signed" &&
          (!input.signerName || !input.signerRole || !input.signedAt)
        ) {
          throw new WardenXError(
            "UPLOADED_ELECTION_SIGNATURE_METADATA_REQUIRED",
            "Signer name, signer role, and signature date are required for a signed Election Statement.",
            400,
          );
        }
        const metadata =
          input.documentState === "signed"
            ? {
                documentState: "signed" as const,
                signedAt: input.signedAt,
                signerRole: input.signerRole ?? "patient",
                signerName: input.signerName,
              }
            : { documentState: "unsigned" as const };
        const svc = createAdmissionEvidenceService(tx, admissionDocumentValidator);
        for (const requirementType of requirementsForUploadedElectionStatement(metadata)) {
          await svc.recordUploadedEvidence({
            organizationId,
            admissionId: period.admissionId,
            electionPeriodId,
            patientId: adm.patientId,
            requirementType,
            documentId: input.documentId,
            documentVersionId: input.documentVersionId,
            completedAt: input.signedAt ? new Date(input.signedAt) : undefined,
            metadata,
            createdByMembershipId: actorUserId,
          });
        }
        return {
          id: period.admissionId,
          state: adm.status,
          version: Number(adm.version),
        };
      });
    },
    async attachUploadedElectionSignature(organizationId, electionStatementId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [es] = await tx
          .select({
            id: ES.id,
            patientId: ES.patientId,
            electionPeriodId: ES.electionPeriodId,
            status: ES.status,
          })
          .from(ES)
          .where(and(eq(ES.organizationId, organizationId), eq(ES.id, electionStatementId)))
          .limit(1);
        if (!es) throw new ResourceNotFoundError(electionStatementId);
        if (es.status === "signed") {
          throw new WardenXError(
            "ELECTION_ALREADY_SIGNED",
            "This Election Statement is already signed.",
            409,
          );
        }
        if (!input.signerName || !input.signerRole || !input.signedAt) {
          throw new WardenXError(
            "UPLOADED_ELECTION_SIGNATURE_METADATA_REQUIRED",
            "Signer name, signer role, and signature date are required for a signed Election Statement.",
            400,
          );
        }
        const [period] = await tx
          .select({ admissionId: EP.admissionId })
          .from(EP)
          .where(eq(EP.id, es.electionPeriodId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(es.electionPeriodId);
        const [adm] = await tx
          .select({ status: ADM.status, version: ADM.version })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(period.admissionId);
        await createAdmissionEvidenceService(tx, admissionDocumentValidator).recordUploadedEvidence(
          {
            organizationId,
            admissionId: period.admissionId,
            electionPeriodId: es.electionPeriodId,
            patientId: es.patientId,
            requirementType: "election_signature",
            documentId: input.documentId,
            documentVersionId: input.documentVersionId,
            completedAt: new Date(input.signedAt),
            metadata: {
              documentState: "signed",
              signerName: input.signerName,
              signerRole: input.signerRole,
              signedAt: input.signedAt,
            },
            createdByMembershipId: actorUserId,
          },
        );
        return {
          id: period.admissionId,
          state: adm.status,
          version: Number(adm.version),
        };
      });
    },
    async attachUploadedCti(organizationId, electionPeriodId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [period] = await tx
          .select({ admissionId: EP.admissionId })
          .from(EP)
          .where(and(eq(EP.organizationId, organizationId), eq(EP.id, electionPeriodId)))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(electionPeriodId);
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            status: ADM.status,
            version: ADM.version,
            hospicePhysicianId: ADM.hospicePhysicianId,
          })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(period.admissionId);
        if (!adm.hospicePhysicianId) {
          throw new WardenXError(
            "ADMISSION_HOSPICE_PHYSICIAN_REQUIRED",
            "Select a Hospice Physician before creating the CTI.",
            400,
          );
        }
        if (input.documentState === "signed" && !input.signedAt) {
          throw new WardenXError(
            "UPLOADED_CTI_SIGNATURE_DATE_REQUIRED",
            "Signature date is required for a signed CTI.",
            400,
          );
        }
        const metadata =
          input.documentState === "signed"
            ? {
                documentState: "signed" as const,
                signedAt: input.signedAt,
                signingPhysicianId: adm.hospicePhysicianId,
              }
            : { documentState: "unsigned" as const };
        const svc = createAdmissionEvidenceService(tx, admissionDocumentValidator);
        for (const requirementType of requirementsForUploadedCti(
          metadata,
          adm.hospicePhysicianId,
        )) {
          await svc.recordUploadedEvidence({
            organizationId,
            admissionId: period.admissionId,
            electionPeriodId,
            patientId: adm.patientId,
            requirementType,
            documentId: input.documentId,
            documentVersionId: input.documentVersionId,
            completedAt: input.signedAt ? new Date(input.signedAt) : undefined,
            metadata,
            createdByMembershipId: actorUserId,
          });
        }
        return {
          id: period.admissionId,
          state: adm.status,
          version: Number(adm.version),
        };
      });
    },
    async holdAdmission(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return admissionEvent(
        organizationId,
        id,
        ifVersion,
        { type: "placeOnHold", reason },
        {
          holdReason: reason,
          holdAt: now(),
        },
        { "m6.admission.on_hold": { reason, heldAt: now().toISOString() } },
      );
    },
    async resumeAdmission(organizationId, id, ifVersion): Promise<MutationResult> {
      return admissionEvent(
        organizationId,
        id,
        ifVersion,
        { type: "releaseFromHold" },
        {
          releasedAt: now(),
        },
        { "m6.admission.resumed": { resumedAt: now().toISOString() } },
      );
    },
    async activateAdmission(organizationId, id, ifVersion, input): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadAdm(tx, id);
        assertVersion(id, cur.version, ifVersion);
        const readiness = await readinessForAdmission(tx, organizationId, id);
        if (!readiness) throw new ResourceNotFoundError(id);
        const facts = await gateFacts(tx, organizationId, id);
        // `computeActivationGate` is the declared single source of truth for BOTH this write-path guard
        // and the read-side checklist (getAdmission/route 10). A caller that bypasses the UI and posts
        // directly gets the SAME 412 PRECONDITION_FAILED { missing } the checklist would have shown.
        const gate = computeActivationGate(facts);
        if (!readiness.canActivate) {
          throw new ActivationPreconditionError(gate.missing, readiness.requirements);
        }
        const t = transitionAdmission(cur.status, {
          type: "activate",
          electionStatementSigned: facts.electionSigned,
          certificationSigned: facts.ctiHospiceMdSigned,
          noticeOfRightsAcknowledged: facts.norAcknowledged,
          privacyFlagBlock: false,
          initialAssessment48hOverdue: false,
          donOverride: false,
          // The admission's FIRST period starts here — period 1 for a first election, the continuing number for a
          // re-election (readmission). A transfer-in's inherited period keeps its old rule (it started elsewhere).
          isFirstElectionPeriod: facts.inheritedPeriod ? facts.periodSequence === 1 : true,
          at: new Date().toISOString().slice(0, 10),
        } satisfies AdmissionEvent);
        const activatedAt = now();
        // #50 — activation is where the admission is sited at a LOCATION. It has to be here rather than
        // at intake: the location must belong to the ELECTED provider entity, and that is only known
        // once the §418.24 statement has been drafted (#44 sites `provider_entity_id` from it). Resolved
        // before the UPDATE so a refusal leaves the admission un-activated rather than half-sited.
        // An admission already sited by `updateAdmission` (location validated against its provider
        // entity there) keeps that location unless the activation request names a different one.
        const locationId =
          !input?.locationId && cur.locationId
            ? cur.locationId
            : await resolveActivationLocation(
                organizationId,
                cur.providerEntityId ?? null,
                input?.locationId ?? null,
              );
        const r = firstOrThrow(
          await tx
            .update(ADM)
            .set({
              status: t.to,
              activatedAt,
              // Only ever SET, never cleared: a null resolution means "could not be determined", and
              // overwriting a previously sited admission with null would lose a fact.
              ...(locationId ? { locationId } : {}),
              version: sql`${ADM.version} + 1`,
            })
            .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
            .returning({
              id: ADM.id,
              status: ADM.status,
              version: ADM.version,
              patientId: ADM.patientId,
            }),
          "row not found",
        );
        // Bug found wiring planRevocation (§2.3.6): `m6.election.period_started` fired here claiming
        // period 1 started, but NO write ever set `election_period.status = 'active'` — it stayed at
        // its `pending` default until the admission was eventually discharged (jumping pending →
        // completed, skipping active entirely). `runEffects` doesn't handle this (no `SideEffect` kind
        // exists for it, same "folded into the caller" posture as `set_timestamp`/`set_flag`), so fold
        // it in here directly, mirroring the recert path's `signCtiHospiceMd` period activation.
        // D9 — the inherited period was inserted `active` (dated from `priorElectionStartDate`) by
        // `transferIn`; it must not be re-run through `setActive` (illegal from `active`) nor re-dated.
        if (facts.periodId && !facts.inheritedPeriod) {
          // §2.3.2 `setActive`. R-AC-01 (`computeActivationGate`, above) has already refused an
          // admission missing its signed election / NOR / CTI signatures, so these guards are the
          // machine's own restatement of that for the PERIOD — plus the recert F2F rule, which the
          // admission gate does not cover and which period 1 never triggers.
          const periodFacts = await electionPeriodFacts(tx as DbClient, facts.periodId);
          if (periodFacts) {
            transitionElectionPeriod(periodFacts.status, {
              type: "setActive",
              certificationSigned: facts.ctiHospiceMdSigned,
              admissionActivated: true, // the ADM update above committed in this same transaction
              sequence: periodFacts.sequenceNumber,
              f2fAttested:
                periodFacts.sequenceNumber >= RECERT_SEQUENCE_FLOOR
                  ? await hasAttestedF2f(tx as DbClient, facts.periodId)
                  : true,
              f2fExceptionDocumented: facts.f2fExceptionDocumented,
              effectiveAt: isoDay(activatedAt),
            });
          }
          await tx
            .update(EP)
            .set({
              status: "active",
              // The `setActive` transition's `set_timestamp effective_at` effect, folded in here the
              // same way `status` is. Without it the three date columns were written by NOTHING in the
              // codebase while being read in seven places — so M6's own `ElectionPeriodReader` (which
              // filters `isNotNull(effective_at)`) returned an empty list for every admission on the
              // platform, and HCI indicator 1's denominator, which selects election periods by
              // `effective_at`, was permanently zero.
              ...electionPeriodWindow(activatedAt, facts.periodSequence),
              version: sql`${EP.version} + 1`,
            })
            .where(and(eq(EP.id, facts.periodId), ne(EP.status, "active")));
          // FY2027 — 42 CFR 418.24(d)(1): an election effective on/after 2026-10-01 owes the addendum within 5
          // calendar days of its effective date, which this transaction has just written. Opens draft v1 + the
          // `election_addendum_initial` window (a no-op for earlier elections and on re-entry). A transfer-in's
          // inherited period is not a new election and is skipped with the rest of this block.
          await openInitialAddendumInTx(tx as DbClient, outbox, {
            organizationId,
            admissionId: id,
            now: activatedAt,
          });
        }
        await reanchorAssessmentWindows(tx as DbClient, id, activatedAt);
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "admission",
            aggregateId: id,
            admissionId: id,
          },
          t.effects,
          {
            "m6.admission.activated": {
              patientId: r.patientId,
              activatedAt: activatedAt.toISOString(),
            },
            // Only fires when `isFirstElectionPeriod` — see the `m6.election.period_started` schema
            // comment (events-by-m6.ts) for why startDate/endDate are omitted rather than fabricated.
            "m6.election.period_started": {
              electionPeriodId: facts.periodId,
              sequence: facts.periodSequence,
              ...(facts.periodEffectiveAt ? { startDate: facts.periodEffectiveAt } : {}),
              ...(facts.periodScheduledEndAt ? { endDate: facts.periodScheduledEndAt } : {}),
            },
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    // ── M6L-T03: election statement + period ────────────────────────────────────────────────────
    async draftElectionStatement(
      organizationId,
      admissionId,
      electionPeriodId,
      input,
    ): Promise<MutationResult> {
      const electionStatementConflict = () =>
        new AdmissionStateError("ELECTION_STATEMENT_CONFLICT", ELECTION_STATEMENT_CONFLICT_MESSAGE);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const [period] = await tx
          .select({
            sequence: EP.sequenceNumber,
            effectiveAt: EP.effectiveAt,
            scheduledEndAt: EP.scheduledEndAt,
          })
          .from(EP)
          // GAP-024 — child-resource binding: the period must belong to THE admission in the path. A
          // period of another admission/patient reads exactly like an absent one (404, no existence leak).
          .where(and(eq(EP.id, electionPeriodId), eq(EP.admissionId, admissionId)))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(electionPeriodId);
        // `election_statement_period_idx` — one LIVE statement per period (partial: `status <> 'voided'`,
        // migration 0398), so a voided draft never blocks re-drafting. Refused here with a precise code;
        // the unique-violation mapping below is the backstop for a concurrent draft.
        const [existingStatement] = await tx
          .select({ id: ES.id })
          .from(ES)
          .where(and(eq(ES.electionPeriodId, electionPeriodId), ne(ES.status, "voided")))
          .limit(1);
        if (existingStatement) throw electionStatementConflict();
        // The elected hospice must belong to THIS org before it is written to two tables — the FK
        // carries no organization, so nothing below the app stops a cross-tenant election.
        if (!providerEntityOrgCheck) {
          throw new WardenXError(
            "PROVIDER_ENTITY_CHECK_UNBOUND",
            "cannot verify the elected provider entity belongs to this organization; refusing to " +
              "draft an election statement against an unverified hospice",
            503,
          );
        }
        if (
          !(await providerEntityOrgCheck.belongsToOrg(
            organizationId,
            input.electedProviderEntityId,
          ))
        ) {
          // Absent and cross-tenant read identically, per the §6.6 existence-non-leak convention.
          throw new ResourceNotFoundError(input.electedProviderEntityId);
        }
        const es = firstOrThrow(
          await tx
            .insert(ES)
            .values({
              organizationId,
              electionPeriodId,
              patientId: adm.patientId,
              // Draft-time intent. `signerKind` is re-stated from the SIGN request (§418.24(b)(1)
              // lets a legal representative sign) — it is NOT NULL, so the draft seeds the common
              // case and signElection corrects it from what the signer actually declared.
              signerKind: "patient",
              providerEntityId: input.electedProviderEntityId,
              declaredEffectiveDate: input.effectiveDate ?? null,
              primaryDiagnosisIcd10AtElection: input.primaryDiagnosisIcd10 ?? null,
              attendingPhysicianId: input.electedAttendingPhysicianId ?? null,
              curativeCareAcknowledgment: input.waiverAcknowledged,
              // The column is jsonb NOT NULL DEFAULT '{}', so the addendum is stored as an object
              // field rather than a bare scalar — `{}` stays the honest "no addendum" value.
              ...(input.stateAddendum === undefined
                ? {}
                : { stateAddendum: { text: input.stateAddendum } }),
            })
            .returning({ id: ES.id, status: ES.status, version: ES.version }),
          "election statement insert returned no row",
        );
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId,
          electionPeriodId,
          patientId: adm.patientId,
          requirementType: "election_statement",
          structuredEntityType: "election_statement",
          structuredEntityId: es.id,
          metadata: { status: "drafted" },
        });
        // §4.7 SITING — the reason this route is load-bearing well beyond its own table.
        // `AdmissionStatusReader.getAdmissionSummary` THROWS `AdmissionSeamDataGapError` when
        // `admission.provider_entity_id` is null (seams/drizzle-store.ts `summaryOf`), and no insert
        // or update in this file ever set it — activation writes `status`/`activatedAt` only. So the
        // seam failed for every admission ever created, and each of its five consumers degraded:
        // M9 assessments (reported as INACTIVE_ADMISSION), M10 HOPE, M16 bereavement, M21 supplies
        // (M21_SERVING_LOCATION_UNRESOLVED), plus the M14/M30 queue readers the DTO is written for.
        // The elected hospice IS the admission's serving provider entity, and this is the first
        // point in the lifecycle where the API supplies one — no other request schema accepts it.
        // Idempotent by design: re-drafting after a void must not repoint a sited admission.
        await tx
          .update(ADM)
          .set({ providerEntityId: input.electedProviderEntityId, updatedAt: now() })
          .where(and(eq(ADM.id, admissionId), isNull(ADM.providerEntityId)));
        await outbox.publish(tx, {
          eventName: "m6.election.drafted",
          payload: {
            electionPeriodId,
            sequence: period.sequence,
            // Same TASK-031 precedent as `m6.election.period_started` — omitted rather than
            // fabricated when the period hasn't been dated yet (see events-by-m6.ts).
            ...(period.effectiveAt ? { startDate: period.effectiveAt } : {}),
            ...(period.scheduledEndAt ? { endDate: period.scheduledEndAt } : {}),
          },
          organizationId,
          aggregateKind: "election_statement",
          aggregateId: es.id,
        });
        return { id: es.id, state: es.status, version: Number(es.version) };
      }).catch((err: unknown) => {
        throw mapUniqueViolation(err, {
          election_statement_period_idx: electionStatementConflict,
        });
      });
    },
    async signElection(organizationId, id, ifVersion, actorUserId, input): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({
            status: ES.status,
            version: ES.version,
            electionPeriodId: ES.electionPeriodId,
            patientId: ES.patientId,
            curativeCareAcknowledgment: ES.curativeCareAcknowledgment,
          })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status !== "drafted")
          throw conflict(`election statement ${id} is not draftable from '${cur.status}'`);

        // §2.3.2 `signElectionStatement` — the period this statement elects advances `pending → signed`,
        // and the three §2.4 election validators run on the way. Nothing wrote the `signed` state before,
        // so the enum value existed and the graph's first edge had never been traversed.
        const electedPeriod = await electionPeriodFacts(tx as DbClient, cur.electionPeriodId);
        if (!electedPeriod) throw new ResourceNotFoundError(cur.electionPeriodId);
        const signerKind = SIGNER_KIND_BY_ROLE[input.signingRole];
        const concurrent = await concurrentElectionFacts(
          tx as DbClient,
          organizationId,
          electedPeriod,
        );
        // D9 — a transfer-in's INHERITED period is inserted `active`, and the receiving hospice still needs
        // its own signed election statement against it (§2.3.6: "re-acknowledged by the patient"). The graph
        // rightly refuses re-electing an `active` period, so the validators run from `pending` and the period
        // itself is NOT moved (it stays `active`, keeping the window `transferIn` dated).
        const activation =
          electedPeriod.status === "active"
            ? await activationPeriodFor(tx as DbClient, electedPeriod.admissionId)
            : null;
        const inheritedElection =
          !!activation?.inherited && activation.period?.id === cur.electionPeriodId;
        const fromStatus = inheritedElection ? "pending" : electedPeriod.status;
        const transition = transitionElectionPeriod(fromStatus, {
          type: "signElectionStatement",
          signerKind,
          // R-EL-01 — resolved through the composition-root port over M39, and DENIED when unbound.
          // Only reached for a representative signer; the validator returns early for `patient`.
          hasActiveDpoaConsent:
            signerKind === "representative"
              ? ((await dpoaConsent?.hasActiveDpoaHealthcareConsent(
                  organizationId,
                  electedPeriod.patientId,
                )) ?? false)
              : true,
          // R-EL-04 — read from the PERSISTED draft, not from this request. The acknowledgment is a
          // property of the statement the patient was shown, and signing must not be able to supply it.
          curativeCareAcknowledgment: cur.curativeCareAcknowledgment === true,
          existingActiveElectionElsewhere: concurrent.existingActiveElectionElsewhere,
          wouldOverlap: concurrent.wouldOverlap,
        });
        if (!inheritedElection)
          await tx
            .update(EP)
            .set({
              status: transition.to,
              version: sql`${EP.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(EP.id, cur.electionPeriodId), ne(EP.status, transition.to)));

        const signedAt = new Date().toISOString().slice(0, 10);
        const [r] = await tx
          .update(ES)
          .set({
            status: "signed",
            signedAt,
            signatureMethod: "electronic_witnessed",
            // #44 — who signed, under what name, and in what capacity (§418.24(b)(1)). These came in
            // on the request and were discarded: the handler forwarded `ifVersion` alone, so
            // `patient_name_at_signing` was NULL on every row and `signer_kind` kept the draft's
            // hardcoded "patient" even when a legal representative signed.
            signerKind: SIGNER_KIND_BY_ROLE[input.signingRole],
            patientNameAtSigning: input.signingPatientName,
            // `curative_care_acknowledgment` is NOT set here any more. It used to be hardcoded
            // `true` at signing, which recorded a waiver the caller may never have given — the
            // draft's `waiverAcknowledged` was discarded, so `false` still produced `true`. The
            // draft now persists what the caller actually sent, and signing must not overwrite it.
            version: sql`${ES.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(ES.id, id), eq(ES.version, ifVersion)))
          .returning({ id: ES.id, status: ES.status, version: ES.version });
        if (!r) throw new ResourceNotFoundError(id);
        const [period] = await tx
          .select({ admissionId: EP.admissionId, effectiveAt: EP.effectiveAt })
          .from(EP)
          .where(eq(EP.id, cur.electionPeriodId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(cur.electionPeriodId);
        // FY2027 — the 42 CFR 418.24(b)(1) hospice the statement names, for M22's statement template.
        const [electingAdmission] = await tx
          .select({ providerEntityId: ADM.providerEntityId })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        const hospiceName = electingAdmission?.providerEntityId
          ? await foundationSites.providerEntityLegalName(
              tx as DbClient,
              organizationId,
              electingAdmission.providerEntityId,
            )
          : null;
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId: period.admissionId,
          electionPeriodId: cur.electionPeriodId,
          patientId: cur.patientId,
          requirementType: "election_signature",
          structuredEntityType: "election_statement",
          structuredEntityId: id,
          completedAt: new Date(`${signedAt}T00:00:00.000Z`),
          metadata: { signatureMethod: "electronic_witnessed" },
        });
        await outbox.publish(tx, {
          eventName: "m6.election.signed",
          // Same payload-schema-drift bug class as `m6.election.drafted` (fixed above) — this call
          // used to send only `electionStatementId`, throwing `payload_schema_violation` on every
          // single call (`electionPeriodId`/`signedAt` are non-optional).
          payload: {
            electionStatementId: id,
            electionPeriodId: cur.electionPeriodId,
            signedAt,
            // F-100 — the chart. `election_statement.patient_id` is on the row this path already read.
            patientId: cur.patientId,
            // FY2027 — what M22's election-statement template prints (42 CFR 418.24(b)(1), (4), (8)).
            patientName: input.signingPatientName,
            signerKind: SIGNER_KIND_BY_ROLE[input.signingRole],
            ...(hospiceName ? { hospiceName } : {}),
            ...(period.effectiveAt ? { effectiveDate: period.effectiveAt } : {}),
          },
          organizationId,
          aggregateKind: "election_statement",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async voidElection(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      void reason;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: ES.version })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const [r] = await tx
          .update(ES)
          .set({
            status: "voided",
            version: sql`${ES.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(ES.id, id), eq(ES.version, ifVersion)))
          .returning({ id: ES.id, status: ES.status, version: ES.version });
        if (!r) throw new ResourceNotFoundError(id);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async createElectionPeriod(organizationId, admissionId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const ep = await openNextElectionPeriodInTx(tx, { organizationId, admissionId });
        if (!ep) throw new WardenXError("NOT_FOUND", "election period insert returned no row", 404);
        return { id: ep.id, state: ep.status, version: ep.version };
      });
    },
    async patchElectionPeriod(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: EP.version })
          .from(EP)
          .where(eq(EP.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const [r] = await tx
          .update(EP)
          .set({ version: sql`${EP.version} + 1`, updatedAt: now() })
          .where(and(eq(EP.id, id), eq(EP.version, ifVersion)))
          .returning({ id: EP.id, status: EP.status, version: EP.version });
        if (!r) throw new ResourceNotFoundError(id);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T03: certification of terminal illness (CTI) ────────────────────────────────────────
    async draftCti(organizationId, input: CtiDraftInput, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const existing = await tx
          .select({
            id: CTI.id,
            status: CTI.status,
            version: CTI.version,
          })
          .from(CTI)
          .where(
            and(
              eq(CTI.organizationId, organizationId),
              eq(CTI.electionPeriodId, input.electionPeriodId),
              ne(CTI.status, "voided"),
            ),
          )
          .limit(1);

        if (existing[0]) {
          throw new WardenXError(
            "CTI_ALREADY_EXISTS",
            "An active Certification of Terminal Illness already exists for this election period.",
            409,
          );
        }
        const [period] = await tx
          .select({ id: EP.id, admissionId: EP.admissionId })
          .from(EP)
          .where(eq(EP.id, input.electionPeriodId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(input.electionPeriodId);
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            hospicePhysicianId: ADM.hospicePhysicianId,
          })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(period.admissionId);
        if (!adm.hospicePhysicianId) {
          throw new WardenXError(
            "ADMISSION_HOSPICE_PHYSICIAN_REQUIRED",
            "Select the admission hospice physician before drafting the CTI.",
            400,
          );
        }
        if (input.hospiceMedicalDirectorId !== adm.hospicePhysicianId) {
          throw new WardenXError(
            "CTI_HOSPICE_PHYSICIAN_MISMATCH",
            "CTI hospice physician must match the admission selected hospice physician.",
            400,
          );
        }
        const signatureRequestedAt = now();
        const signatureDueAt = new Date(computeCtiSignatureDueAt(signatureRequestedAt));

        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: input.electionPeriodId,
              hospiceMdId: adm.hospicePhysicianId,
              attendingMdId: input.attendingPhysicianId ?? null,
              terminalDiagnosisIcd10: input.terminalDiagnosisIcd10,
              relatedConditionsIcd10: [...(input.secondaryDiagnoses ?? [])],
              narrative: input.narrative,
              prognosisStatement: input.prognosisStatement,
              clinicalFindings: input.clinicalFindings,
              signatureRequestedAt,
              signatureDueAt,
            })
            .returning({
              id: CTI.id,
              status: CTI.status,
              version: CTI.version,
            }),
          "cti insert returned no row",
        );
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId: period.admissionId,
          electionPeriodId: input.electionPeriodId,
          patientId: adm.patientId,
          requirementType: "cti",
          structuredEntityType: "cti",
          structuredEntityId: cti.id,
          metadata: { status: "drafted" },
          createdByMembershipId: actorUserId,
        });
        // TASK-034: was missing `electionPeriodId`/`isRecert` — declared required by events-by-m6.ts,
        // silently dropped here, same payload-schema-drift pattern TASK-031 fixed elsewhere in M6.
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: {
            ctiId: cti.id,
            electionPeriodId: input.electionPeriodId,
            isRecert: input.isRecert,
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        await outbox.publish(tx, {
          eventName: "m6.cti.signature_requested",
          payload: {
            ctiId: cti.id,
            hospiceMdId: input.hospiceMedicalDirectorId,
            requestedAt: signatureRequestedAt.toISOString(),
            dueAt: signatureDueAt.toISOString(),
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        return { id: cti.id, state: cti.status, version: Number(cti.version) };
      });
    },
    async signCtiHospiceMd(
      organizationId,
      id,
      ifVersion,
      actorUserId,
      input = {},
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({
            status: CTI.status,
            version: CTI.version,
            epId: CTI.electionPeriodId,
            hospiceMdId: CTI.hospiceMdId,
            narrative: CTI.narrative,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        if (cti.status === "signed" || cti.status === "voided")
          throw conflict(`cti ${id} cannot be hospice-MD-signed from '${cti.status}'`);
        const [period] = await tx
          .select({ seq: EP.sequenceNumber, admissionId: EP.admissionId })
          .from(EP)
          .where(eq(EP.id, cti.epId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(cti.epId);
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            hospicePhysicianId: ADM.hospicePhysicianId,
          })
          .from(ADM)
          .where(eq(ADM.id, period.admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(period.admissionId);
        if (!adm.hospicePhysicianId) {
          throw new WardenXError(
            "ADMISSION_HOSPICE_PHYSICIAN_REQUIRED",
            "Select the admission hospice physician before signing the CTI.",
            400,
          );
        }
        if (cti.hospiceMdId !== adm.hospicePhysicianId) {
          throw new WardenXError(
            "CTI_HOSPICE_PHYSICIAN_MISMATCH",
            "CTI hospice physician must match the admission selected hospice physician.",
            400,
          );
        }
        // Readmission workflow — a re-election's FIRST period can be 2 or later, but it is not a recertification:
        // it activates with the admission (`activateAdmission`, R-AC-01 gate), never on the CTI signature alone.
        const [earlierPeriod] = await tx
          .select({ id: EP.id })
          .from(EP)
          .where(and(eq(EP.admissionId, period.admissionId), lt(EP.sequenceNumber, period.seq)))
          .limit(1);
        const isRecert = period.seq >= 2 && !!cti.epId && !!earlierPeriod;
        // Bug 3 — the signing physician may supply the § 418.22(b)(3) narrative at signature (a transfer-in
        // drafts our CTI with none). A recert can never pass the adequacy gate without a ≥ 200-character
        // narrative, so say exactly that (422) instead of the generic adequacy 409.
        const narrative = input.narrative?.trim() ? input.narrative : cti.narrative;
        const narrativeLength = narrative?.trim().length ?? 0;
        if (narrativeLength === 0 || (isRecert && narrativeLength < TEXT_MINIMUMS.ctiNarrative)) {
          throw new WardenXError(
            "CTI_NARRATIVE_REQUIRED",
            `The certification narrative is required before signing: provide a physician narrative of at least ${TEXT_MINIMUMS.ctiNarrative} characters (42 CFR 418.22(b)(3)).`,
            422,
            [
              {
                code: narrativeLength === 0 ? "CTI_NARRATIVE_MISSING" : "CTI_NARRATIVE_TOO_SHORT",
                message: `narrative must be at least ${TEXT_MINIMUMS.ctiNarrative} characters`,
              },
            ],
          );
        }
        const hospiceMdSignedAt = now();
        const [r] = await tx
          .update(CTI)
          .set({
            status: "signed",
            hospiceMdSignedAt,
            ...(narrative !== cti.narrative ? { narrative } : {}),
            version: sql`${CTI.version} + 1`,
          })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId: period.admissionId,
          electionPeriodId: cti.epId,
          patientId: adm.patientId,
          requirementType: "cti_signature",
          structuredEntityType: "cti",
          structuredEntityId: id,
          completedAt: hospiceMdSignedAt,
          metadata: {
            signedBy: "hospice_physician",
            physicianId: adm.hospicePhysicianId,
          },
          createdByMembershipId: actorUserId,
        });
        if (isRecert && cti.epId) {
          // §2.3.2 `setActive` on the RECERT path. Benefit periods are contiguous (42 CFR 418.21(a)): the
          // period starts the day after its predecessor ends, NOT on the signing day, and a recert may be
          // signed up to 15 days early (42 CFR 418.22(a)(3)). The fail-closed gate (setActive guards incl.
          // R-F2F-04 + the F-217 F2F/CTI adequacy predicate) runs NOW against that real start date, so an
          // inadequate certification still refuses at signature and the whole tx (incl. the CTI signature)
          // rolls back. The period is started here only when its start date has already arrived (a late
          // recert); otherwise it stays `pending` and the hourly period auto-end cron starts it on its start
          // date, right after completing its predecessor (`startDueRecertPeriodsForOrg`). Starting it here
          // early is what left two overlapping `active` periods.
          const ctx = await recertPeriodContextInTx(tx as DbClient, cti.epId);
          if (ctx) {
            const today = localDateInTimeZone(
              now(),
              await organizationTimezone(tx as DbClient, organizationId),
            );
            const startDate = ctx.startDate ?? today;
            const adequacy = await assertRecertPeriodReady(tx as DbClient, ctx, startDate);
            if (startDate <= today && predecessorHandsOver(ctx)) {
              await startRecertPeriodInTx(
                tx as DbClient,
                { outbox, now },
                { organizationId, ctx, startDate, adequacy },
              );
            }
          }
        }
        await outbox.publish(tx, {
          eventName: "m6.cti.signed",
          payload: {
            ctiId: id,
            electionPeriodId: cti.epId,
            signedAt: hospiceMdSignedAt.toISOString(),
            patientId: adm.patientId, // F-100 — the chart
            ...(await renderPayloadFor(tx as DbClient, organizationId, { ctiId: id }, (ctx) =>
              buildCtiRenderPayload(ctx, id),
            )),
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async signCtiAttending(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({
            status: CTI.status,
            version: CTI.version,
            epId: CTI.electionPeriodId,
            hospiceMdSignedAt: CTI.hospiceMdSignedAt,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        if (cti.status !== "awaiting_attending")
          throw conflict(
            `cti ${id} is not awaiting an attending signature (state '${cti.status}')`,
          );
        // The attending co-signs a certification the hospice physician already signed (R-CTI-03). Without that
        // signature the filed CTI cannot be built, and the m6.cti.signed render would dead-letter.
        if (!cti.hospiceMdSignedAt)
          throw conflict(`cti ${id} cannot be attending-signed before the hospice physician signs`);
        const attendingSignedAt = now();
        const [r] = await tx
          .update(CTI)
          .set({
            status: "signed",
            attendingMdSignedAt: attendingSignedAt,
            version: sql`${CTI.version} + 1`,
          })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.cti.signed",
          // Same payload-schema-drift bug — `electionPeriodId`/`signedAt` are required (confirmed live:
          // this exact call 500'd with `payload_schema_violation` on every attempt before this fix).
          payload: {
            ctiId: id,
            electionPeriodId: cti.epId,
            signedAt: attendingSignedAt.toISOString(),
            patientId: await patientForElectionPeriod(tx, cti.epId), // F-100 — the chart
            ...(await renderPayloadFor(tx as DbClient, organizationId, { ctiId: id }, (ctx) =>
              buildCtiRenderPayload(ctx, id),
            )),
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async voidCti(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({ version: CTI.version })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        const [r] = await tx
          .update(CTI)
          .set({ status: "voided", version: sql`${CTI.version} + 1` })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.cti.voided",
          // `reason` is required by the schema — this call used to discard it entirely (`void reason`)
          // and 500 on every void.
          payload: { ctiId: id, reason },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async markCtiLate(
      organizationId,
      id,
      ifVersion,
    ): Promise<MutationResult & { writtenCertDeadlineAt: string }> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({
            status: CTI.status,
            version: CTI.version,
            periodStart: CTI.periodStart,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        const [r] = await tx
          .update(CTI)
          .set({ signedLate: true, version: sql`${CTI.version} + 1` })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        // D4: written-cert deadline = period_start + 2 calendar days at 23:59 org-TZ. Computed before
        // the publish below — `writtenCertDeadlineAt` is a required field on this event's schema, and
        // this call previously omitted it entirely (the computation ran only after the now-failed
        // publish), 500ing on every call.
        const periodStart = cti.periodStart ?? new Date().toISOString().slice(0, 10);
        const writtenCertDeadlineAt = computeWrittenCertDeadline(periodStart, DEFAULT_ORG_TZ);
        await outbox.publish(tx, {
          eventName: "m6.cti.late_flagged",
          payload: { ctiId: id, writtenCertDeadlineAt },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return {
          id: r.id,
          state: r.status,
          version: Number(r.version),
          writtenCertDeadlineAt,
        };
      });
    },
    // ── M6L-T04: face-to-face encounter (§2.3.4) ──────────────────────────────────────────────────
    async scheduleF2f(organizationId, input): Promise<MutationResult> {
      const derivePerformerRole = async (i: F2fScheduleInput): Promise<F2fPerformerRole> => {
        if (i.actor.kind === "system") {
          // Trusted non-request caller: its role is already server-decided, but still must be eligible.
          return resolveF2fPerformerRole(
            i.clinicianRole === "hospice_np"
              ? ["np"]
              : i.clinicianRole === "hospice_md"
                ? ["md"]
                : [],
            i.clinicianRole,
          );
        }
        if (!f2fClinicianRoles)
          throw new WardenXError(
            "F2F_ROLE_SOURCE_UNAVAILABLE",
            "the clinician role source is not bound; refusing to trust a client-supplied performer role",
            503,
          );
        return resolveF2fPerformerRole(
          await f2fClinicianRoles.roleKeysForUser(organizationId, i.scheduledClinicianId),
          i.clinicianRole,
        );
      };
      // GAP-022 — the performer role is DERIVED from the scheduled clinician's real role grants (or,
      // for the explicit `system` actor only, the caller's server-decided role); the body's
      // `clinicianRole` is a claim that must be backed by a grant. RN / PA / attending never qualify.
      // Resolved BEFORE the outer transaction: the role port opens its own `withOrgContext`, so calling it
      // inside would hold two pool connections per request.
      const role = await derivePerformerRole(input);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [period] = await tx
          .select({ id: EP.id })
          .from(EP)
          // GAP-024 — the period must belong to the admission the route authorized, never the body's claim.
          .where(and(eq(EP.id, input.electionPeriodId), eq(EP.admissionId, input.admissionId)))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(input.electionPeriodId);
        const periodWindowStart = await resolvePeriodF2fWindowStart(
          tx as DbClient,
          input.electionPeriodId,
        );
        const authoritativeWindow = periodWindowStart
          ? computeF2fWindow(periodWindowStart.start, DEFAULT_ORG_TZ)
          : null;
        const f2f = firstOrThrow(
          await tx
            .insert(F2F)
            .values({
              organizationId,
              electionPeriodId: input.electionPeriodId,
              performedByUserId: input.scheduledClinicianId,
              performerRole: role,
              scheduledDate: input.scheduledDate,
              requestedWindowStart: input.windowStart ?? null,
              requestedWindowEnd: input.windowEnd ?? null,
              authoritativeWindowStart: authoritativeWindow?.windowStart ?? null,
              authoritativeWindowEnd: authoritativeWindow?.windowEnd ?? null,
            })
            .returning({
              id: F2F.id,
              status: F2F.status,
              version: F2F.version,
            }),
          "f2f insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.f2f.scheduled",
          // `electionPeriodId`/`scheduledDate` are required by the event catalog. `scheduledDate` is
          // persisted on the `face_to_face_encounter.scheduled_date` column by the insert above and
          // echoed here from `input`.
          payload: {
            f2fId: f2f.id,
            electionPeriodId: input.electionPeriodId,
            scheduledDate: String(input.scheduledDate),
          },
          organizationId,
          aggregateKind: "face_to_face_encounter",
          aggregateId: f2f.id,
        });
        return { id: f2f.id, state: f2f.status, version: Number(f2f.version) };
      });
    },
    async completeF2f(
      organizationId,
      id,
      ifVersion,
      encounterDate,
      modality,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({
            status: F2F.status,
            version: F2F.version,
            role: F2F.performerRole,
            override: F2F.windowOverride,
            epId: F2F.electionPeriodId, // F-100 — `m6.f2f.completed` requires it
          })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // F-226 - the REAL encounter date (validated: a calendar date, not in the future, not absurdly old)
        // against the period's REAL expected start (prior end + 1, see `resolvePeriodF2fWindowStart`).
        // Before this the body's `encounterDate` was dropped, "today" was stamped, and the window was
        // computed against today + 7, so `within_window` was true on every production write. Dates after the
        // period's first day are outside [start-30, start] (R-F2F-02; MBPM ch. 9 §20.1(5)(a)) and are refused unless a window override
        // (R-F2F-03, `overrideF2fWindow`, legal from `scheduled`) is already on file.
        assertPlausibleEncounterDate(
          encounterDate,
          localDateOfInstant(now().toISOString(), DEFAULT_ORG_TZ),
        );
        const windowStart = await resolvePeriodF2fWindowStart(tx as DbClient, cur.epId);
        const t = transitionFaceToFace(cur.status as FaceToFaceState, {
          type: "recordCompletion",
          performerRole: cur.role,
          periodStart: windowStart?.start ?? null,
          encounterDate,
          hasOverride: cur.override,
          // R-F2F-05 — telehealth through 2027-12-31 only; (A)-(C) attestation from 2026-01-31.
          encounterLocation: modality?.encounterLocation ?? null,
          telehealthEligibility: modality?.telehealthEligibility ?? null,
          exceptionDocumented: await periodHasF2fException(tx as DbClient, cur.epId),
        });
        const isTelehealth = modality?.encounterLocation === "telehealth";
        const telehealthEligibility =
          isTelehealth && modality?.telehealthEligibility
            ? { ...modality.telehealthEligibility, attestedAt: now().toISOString() }
            : null;
        const withinWindow: boolean | null = t.effects.some(
          (e) => e.kind === "set_flag" && e.field === "within_window_unknown",
        )
          ? null
          : t.effects.some((e) => e.kind === "set_flag" && e.field === "within_window_true");
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: t.to,
              encounterDate,
              ...(modality ? { encounterLocation: modality.encounterLocation } : {}),
              telehealthEligibility,
              withinWindow, // null = unverified (override on file, start not derivable): the gate fails closed
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({
              id: F2F.id,
              status: F2F.status,
              version: F2F.version,
            }),
          "f2f not found",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "face_to_face_encounter",
            aggregateId: id,
            admissionId: id,
          },
          t.effects,
          // F-100 — `runEffects`' base envelope is `{aggregateId, admissionId}` and every M6 event
          // declares more than that, so an effect emitted without its own entry here does not degrade,
          // it REFUSES: the publisher `Value.Check`s and the whole write rolls back.
          {
            "m6.f2f.completed": {
              f2fId: id,
              electionPeriodId: cur.epId,
              encounterDate,
              // The catalog schema is a required boolean; "unverified" (null) is reported as not-within.
              withinWindow: withinWindow === true,
            },
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async attestF2f(
      organizationId,
      id,
      ifVersion,
      actorUserId,
      attestationNarrative,
      signedNoteEncounterId = null,
    ): Promise<MutationResult> {
      // R-F2F-06 — exactly one § 418.22(b)(4) attestation source: the written narrative OR a linked note.
      const hasNarrative = (attestationNarrative ?? "").trim().length > 0;
      if (hasNarrative === (signedNoteEncounterId !== null && signedNoteEncounterId !== "")) {
        throw new AdmissionStateError(
          "F2F_ATTESTATION_SOURCE_REQUIRED",
          "Provide exactly one attestation: a written attestation narrative or a linked signed clinical note",
        );
      }
      // Resolved BEFORE the write transaction: the port opens its own `withOrgContext` (one pool
      // connection per request, the `f2fClinicianRoles` precedent).
      let note: SignedNoteFacts | null = null;
      if (signedNoteEncounterId) {
        if (!f2fSignedNotes)
          throw new WardenXError(
            "F2F_NOTE_SOURCE_UNAVAILABLE",
            "the clinical-note reader is not bound; refusing to accept an unverified note as the F2F attestation",
            503,
          );
        note = await f2fSignedNotes.signedNoteFor(organizationId, signedNoteEncounterId);
      }
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({
            status: F2F.status,
            version: F2F.version,
            performer: F2F.performedByUserId,
            epId: F2F.electionPeriodId,
            encounterDate: F2F.encounterDate,
          })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // GAP-022 / R-F2F-04 — run the real machine: narrative >= 100 chars (or, R-F2F-06, a note signed
        // and dated by the performer on the encounter date for THIS patient) and the attester IS the
        // performer. No falsy-actor bypass: an empty actor id never equals the stored performer.
        transitionFaceToFace(cur.status as FaceToFaceState, {
          type: "attest",
          narrative: attestationNarrative,
          signedNote: signedNoteEncounterId
            ? {
                note,
                patientId: await patientForElectionPeriod(tx as DbClient, cur.epId),
                performerUserId: cur.performer,
                encounterDate: cur.encounterDate as LocalDate | null,
              }
            : null,
          performerIsActor: actorUserId !== "" && cur.performer === actorUserId,
        });
        const attestedAt = now();
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: "attested",
              ...(signedNoteEncounterId
                ? { encounterId: signedNoteEncounterId, attestationNarrative: null }
                : { attestationNarrative: (attestationNarrative ?? "").trim() }),
              attestationSignedAt: attestedAt,
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({
              id: F2F.id,
              status: F2F.status,
              version: F2F.version,
            }),
          "f2f not found",
        );
        // Close the recert F2F window on the owning admission (best-effort; no-op when none is open).
        const [ep] = await tx
          .select({ admissionId: EP.admissionId })
          .from(EP)
          .where(eq(EP.id, cur.epId))
          .limit(1);
        if (ep) {
          await runEffects(
            tx,
            {
              organizationId,
              aggregateKind: "face_to_face_encounter",
              aggregateId: id,
              admissionId: ep.admissionId,
            },
            [
              { kind: "close_window", window: "f2f_recert_30d_prior" },
              { kind: "outbox", event: "m6.f2f.attested" },
            ],
            {
              "m6.f2f.attested": {
                f2fId: id,
                electionPeriodId: cur.epId,
                attestedAt: attestedAt.toISOString(),
                // F-100 — the chart M22 files the rendered `f2f` document against.
                patientId: await patientForAdmission(tx, ep.admissionId),
                ...(await renderPayloadFor(tx as DbClient, organizationId, { f2fId: id }, (ctx) =>
                  buildF2fRenderPayload(ctx, id),
                )),
              },
            },
          );
        }
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async overrideF2fWindow(
      organizationId,
      id,
      reason,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({ status: F2F.status, version: F2F.version })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // §2.3.4 R-F2F-03 — a Medical-Director override with a reason ≥ 20 chars (the MD role is gated by
        // the route's ABAC preHandler; the state machine enforces the reason length).
        const t = transitionFaceToFace(cur.status as FaceToFaceState, {
          type: "requestWindowOverride",
          isMedicalDirector: true,
          reason,
        });
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: t.to,
              windowOverride: true,
              windowOverrideReason: reason,
              windowOverrideBy: actorUserId || null,
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({
              id: F2F.id,
              status: F2F.status,
              version: F2F.version,
            }),
          "f2f not found",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "face_to_face_encounter",
            aggregateId: id,
            admissionId: id,
          },
          t.effects,
          // F-100 — `m6.f2f.window_overridden` requires `{f2fId, reason}`; without them this route
          // refused every medical-director override with a 500.
          { "m6.f2f.window_overridden": { f2fId: id, reason } },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T04: level-of-care period (§2.3.5) ────────────────────────────────────────────────────
    async changeLoc(
      organizationId,
      admissionId,
      newLevel,
      facilityId = null,
      effectiveStart = undefined,
      reason = "",
    ): Promise<MutationResult> {
      if (!LEVELS_OF_CARE.includes(newLevel as LevelOfCare))
        throw new WardenXError("VALIDATION_ERROR", `unknown level of care '${newLevel}'`, 422);
      const level = newLevel as LevelOfCare;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ status: ADM.status })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        // §2.3.5 requestAssign — the guards (admission active/on-hold, no overlap, GIP documentation,
        // IRC/GIP facility). IRC/GIP land in `assigning` until confirmLocBedAssignment (below) verifies a
        // real M37 bed; RHC/CHC go straight to `active`.
        const t = transitionLevelOfCare("pending", {
          type: "requestAssign",
          level,
          admissionActiveOrOnHold: adm.status === "active" || adm.status === "on_hold",
          facilityId,
          wouldOverlap: false,
          reason,
        });
        const to: LevelOfCareState = t.to;
        // Close the prior open LOC (the §2.3.5 end_level_of_care effect) BEFORE inserting the new one —
        // the partial unique `lcp_adm_open_idx` permits only one open period per admission.
        await tx
          .update(LOC)
          .set({
            endedAt: now(),
            status: "ended",
            version: sql`${LOC.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(LOC.admissionId, admissionId), sql`${LOC.endedAt} is null`));
        const loc = firstOrThrow(
          await tx
            .insert(LOC)
            .values({
              organizationId,
              admissionId,
              levelOfCare: level,
              status: to === "assigning" ? "assigning" : "active",
              facilityId,
              reason,
              effectiveAt: effectiveStart ? new Date(effectiveStart) : now(),
            })
            .returning({
              id: LOC.id,
              status: LOC.status,
              version: LOC.version,
            }),
          "loc insert returned no row",
        );
        // No outbox event while `assigning` — nothing downstream should treat an unconfirmed IPU request
        // as a real period of care yet; confirmLocBedAssignment publishes m6.loc.changed once it's real.
        if (to !== "assigning") {
          await outbox.publish(tx, {
            eventName: "m6.loc.changed",
            // Field names must match the schema exactly (`newLevel`, not `level`; `state` isn't a
            // declared field at all) — previously sent `{level, state}`, both wrong, 500ing every call.
            payload: {
              levelOfCarePeriodId: loc.id,
              newLevel: level,
              effectiveStart: (effectiveStart ? new Date(effectiveStart) : now()).toISOString(),
              admissionId,
            },
            organizationId,
            aggregateKind: "level_of_care_period",
            aggregateId: loc.id,
          });
        }
        return { id: loc.id, state: loc.status, version: Number(loc.version) };
      });
    },
    async patchLoc(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: LOC.version, status: LOC.status })
          .from(LOC)
          .where(eq(LOC.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const r = firstOrThrow(
          await tx
            .update(LOC)
            .set({ reason, version: sql`${LOC.version} + 1`, updatedAt: now() })
            .where(and(eq(LOC.id, id), eq(LOC.version, ifVersion)))
            .returning({
              id: LOC.id,
              status: LOC.status,
              version: LOC.version,
            }),
          "loc not found",
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async confirmLocBedAssignment(organizationId, locPeriodId, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({
            status: LOC.status,
            version: LOC.version,
            admissionId: LOC.admissionId,
            effectiveAt: LOC.effectiveAt,
          })
          .from(LOC)
          .where(eq(LOC.id, locPeriodId))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(locPeriodId);
        assertVersion(locPeriodId, Number(cur.version), ifVersion);
        if (!ipuBedAssignmentReader) {
          throw new WardenXError(
            "IPU_BED_ASSIGNMENT_READER_UNBOUND",
            "the M37 bed-assignment reader is not bound in this environment",
            503,
          );
        }
        const bed = await ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod(
          organizationId,
          locPeriodId,
        );
        // The real §2.3.5 "bedId verified with M37" guard — never trusts a caller-supplied bed id.
        // ipuConfirmBedAssignment's only legal destination is "active" (§2.3.5 graph) — transitionLevelOfCare
        // still runs first so the ILLEGAL_TRANSITION/guard checks fire before any write.
        transitionLevelOfCare(cur.status as LevelOfCareState, {
          type: "ipuConfirmBedAssignment",
          bedVerified: bed !== null,
        });
        const r = firstOrThrow(
          await tx
            .update(LOC)
            .set({
              status: "active",
              ipuBedAssignmentId: bed?.bedAssignmentId ?? null,
              version: sql`${LOC.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(LOC.id, locPeriodId), eq(LOC.version, ifVersion)))
            .returning({
              id: LOC.id,
              status: LOC.status,
              version: LOC.version,
              levelOfCare: LOC.levelOfCare,
            }),
          "loc not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.loc.changed",
          // Same field-name bug as `changeLoc` above (`newLevel` not `level`, no `state` field; plus
          // the missing `effectiveStart`/`admissionId`).
          payload: {
            levelOfCarePeriodId: r.id,
            newLevel: r.levelOfCare,
            effectiveStart: (cur.effectiveAt ?? now()).toString(),
            admissionId: cur.admissionId,
          },
          organizationId,
          aggregateKind: "level_of_care_period",
          aggregateId: r.id,
        });
        // M6 §2.3.5 / M37 §2.2 handshake: the activation M37 is waiting on. Same transaction as the status
        // flip, so the acknowledgement can never be published for a period that did not activate (and an
        // activation can never go unannounced). M37's consumer confirms the `bed_assigned` admission.
        await outbox.publish(tx, {
          eventName: "m6.level_of_care.activated",
          payload: {
            levelOfCarePeriodId: r.id,
            admissionId: cur.admissionId,
            newLevel: r.levelOfCare,
            activatedAt: now().toISOString(),
          },
          organizationId,
          aggregateKind: "level_of_care_period",
          aggregateId: r.id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T04: revocation / transfer / discharge (§2.3.1) ───────────────────────────────────────
    async createRevocation(
      organizationId,
      admissionId,
      input: RevocationInput,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const period = await latestPeriod(tx, admissionId);
        if (!period) throw new ResourceNotFoundError(admissionId);
        // §2.3.6 R-RV-01 — the pure command guard: the election period being revoked must actually be
        // ACTIVE (latestPeriod alone doesn't check status — a completed/pending period would otherwise
        // slip through and hit the `revocation_period_idx` unique constraint with a confusing 500) and
        // the effective date may not precede the signed date. Both dates are `input.revocationDate` (the
        // route contract carries one date, mirroring the spec's own §4.2.7 shape), which trivially
        // satisfies the second guard by construction — the ACTIVE check is the one this actually gates.
        // Only used for validation here: the cascade this returns (end period/LOC, audit, outbox) is
        // already applied by `dischargeAdmissionTx` below via `transitionAdmission`'s own equivalent
        // effects — running both would double-apply the UPDATEs and double-publish the outbox event.
        planRevocation({
          electionPeriodActive: period.status === "active",
          signedAt: input.revocationDate,
          effectiveAt: input.revocationDate,
        });
        // `signingPatientName` has no column — see RevocationInput's doc.
        const rev = firstOrThrow(
          await tx
            .insert(RE)
            .values({
              organizationId,
              admissionId,
              electionPeriodId: period.id,
              signerKind:
                input.signingRole === "legal_representative" ? "representative" : "patient",
              effectiveAt: input.revocationDate,
              signedAt: input.revocationDate,
              revocationReason: input.revocationReason,
              narrative: input.narrative,
            })
            .returning({ id: RE.id, version: RE.version }),
          "revocation insert returned no row",
        );
        // §2.3.1 — a revocation discharges the admission (end LOC + complete every benefit period).
        await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: "revocation",
          effectiveAt: input.revocationDate,
          forCauseCosigned: false,
        });
        await outbox.publish(tx, {
          eventName: "m6.revocation.created",
          // Field name must be `revocationEventId` (schema), not `revocationId`; `revocationDate` is
          // also required and was previously omitted.
          payload: {
            revocationEventId: rev.id,
            admissionId,
            revocationDate: input.revocationDate,
            patientId: await patientForAdmission(tx, admissionId), // F-100 — the chart
            ...(await renderPayloadFor(
              tx as DbClient,
              organizationId,
              { revocationId: rev.id },
              (ctx) => buildRevocationRenderPayload(ctx, rev.id),
            )),
          },
          organizationId,
          aggregateKind: "revocation_event",
          aggregateId: rev.id,
        });
        return { id: rev.id, state: "created", version: Number(rev.version) };
      });
    },
    async transferOut(
      organizationId,
      admissionId,
      input: TransferOutInput,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const period = await latestPeriod(tx, admissionId);
        if (!period) throw new ResourceNotFoundError(admissionId);
        // F-192 (#248) — the chart M22's transfer-summary render files against; `transferIn` below
        // already reads this same column for its own CTI-attribution needs.
        const [xferAdm] = await tx
          .select({ patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!xferAdm) throw new ResourceNotFoundError(admissionId);
        // §2.3.6 R-XFR-01 — only one transfer-out per benefit period (42 CFR 418.28). No DB constraint
        // enforces this (unlike revocation_event's `revocation_period_idx` unique index), so query the
        // real fact rather than assuming it can never happen (the admission-graph transition to
        // `discharged` blocks an obvious double-call today, but that's incidental, not a rule).
        const [priorTransferOut] = await tx
          .select({ id: TE.id })
          .from(TE)
          .where(
            and(
              eq(TE.admissionId, admissionId),
              eq(TE.periodSequenceAtTransfer, period.sequence),
              eq(TE.direction, "out"),
            ),
          )
          .limit(1);
        planTransferOut({
          transferAlreadyDoneThisPeriod: !!priorTransferOut,
        });
        const xfer = firstOrThrow(
          await tx
            .insert(TE)
            .values({
              organizationId,
              admissionId,
              direction: "out",
              effectiveAt: input.effectiveDate,
              periodSequenceAtTransfer: period.sequence,
              receivingOrSendingCcn: input.otherHospiceCcn ?? null,
              receivingOrSendingName: input.otherHospiceName,
              receivingCareSetting: input.receivingCareSetting,
              narrative: input.narrative,
            })
            .returning({ id: TE.id, version: TE.version }),
          "transfer insert returned no row",
        );
        // §2.3.1 — a transfer-out discharges the admission (the receiving hospice inherits the election).
        await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: "transfer",
          effectiveAt: input.effectiveDate,
          forCauseCosigned: false,
        });
        await outbox.publish(tx, {
          eventName: "m6.transfer.created",
          // Field name must be `transferEventId` (schema), not `transferId`.
          payload: {
            transferEventId: xfer.id,
            admissionId,
            direction: "out",
            // F-107 — `effectiveAt` is the transfer's own date, which M23 dates the 42 CFR 418.26
            // NOTR window from. `admission.discharged_at` is `now()` and cannot substitute.
            effectiveAt: input.effectiveDate,
            // F-192 (#248) — M22's transfer-summary render handshake.
            patientId: xferAdm.patientId,
            ...(await renderPayloadFor(
              tx as DbClient,
              organizationId,
              { transferId: xfer.id },
              (ctx) => buildTransferRenderPayload(ctx, xfer.id),
            )),
          },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        return {
          id: xfer.id,
          state: "created",
          version: Number(xfer.version),
        };
      });
    },
    async transferIn(
      organizationId,
      admissionId,
      input: TransferInInput,
      actorUserId,
    ): Promise<MutationResult & { currentElectionPeriodSequence: number }> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [adm] = await tx
          .select({
            patientId: ADM.patientId,
            hospicePhysicianId: ADM.hospicePhysicianId,
            attendingPhysicianId: ADM.attendingPhysicianId,
            providerEntityId: ADM.providerEntityId,
          })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        // CMS Pub. 100-04 ch. 11 §20.1.3 — the sending hospice must be ANOTHER provider (a different CCN), and
        // a beneficiary changes hospices at most once per benefit period: any transfer (in or out) already
        // recorded for this patient in the carried period refuses a second one. Both are the receiving
        // hospice's 8xC transfer-notice rules, enforced here at capture so a bad transfer never posts.
        const ownCcn = adm.providerEntityId
          ? ((
              await foundationSites.providerEntityIdentifiers(
                tx,
                organizationId,
                adm.providerEntityId,
              )
            )?.ccn ?? null)
          : null;
        const [priorTransferInPeriod] = await tx
          .select({ id: TE.id })
          .from(TE)
          .innerJoin(ADM, eq(ADM.id, TE.admissionId))
          .where(
            and(
              eq(ADM.patientId, adm.patientId),
              eq(TE.periodSequenceAtTransfer, input.priorBenefitPeriodSequence),
            ),
          )
          .limit(1);
        const refusal = transferInSourceRefusal({
          otherHospiceCcn: input.otherHospiceCcn ?? null,
          otherHospiceNpi: input.otherHospiceNpi ?? null,
          ownCcn,
          transferAlreadyRecordedInPeriod: !!priorTransferInPeriod,
        });
        if (refusal) throw new AdmissionStateError(refusal.code, refusal.message);
        // The carried sequence must follow every period already on this admission (e.g. a referral
        // acceptance seeds period 1): refused here with a precise code before any write; the
        // `election_period_admission_seq_idx` mapping below is the backstop for a concurrent insert.
        const existingPeriods = await tx
          .select({ sequenceNumber: EP.sequenceNumber })
          .from(EP)
          .where(eq(EP.admissionId, admissionId));
        const periodConflict = transferInPeriodConflict(
          existingPeriods.map((p) => Number(p.sequenceNumber)),
          input.priorBenefitPeriodSequence,
        );
        if (periodConflict) {
          throw new AdmissionStateError(periodConflict.code, periodConflict.message);
        }
        const selectedHospicePhysicianId = adm.hospicePhysicianId ?? input.hospiceMedicalDirectorId;
        if (input.hospiceMedicalDirectorId !== selectedHospicePhysicianId) {
          throw new WardenXError(
            "CTI_HOSPICE_PHYSICIAN_MISMATCH",
            "Transfer-in CTI physician must match the admission selected hospice physician.",
            400,
          );
        }
        // The transfer-in's attending physician was accepted by the route and then dropped; it is the 8xC's
        // Attending Physician (CMS Pub. 100-04 ch. 11 §20.1.3), so it fills an admission that names none.
        const fillAttending = !adm.attendingPhysicianId && !!input.attendingPhysicianId;
        if (!adm.hospicePhysicianId || fillAttending) {
          await tx
            .update(ADM)
            .set({
              ...(adm.hospicePhysicianId ? {} : { hospicePhysicianId: selectedHospicePhysicianId }),
              ...(fillAttending ? { attendingPhysicianId: input.attendingPhysicianId } : {}),
              version: sql`${ADM.version} + 1`,
              updatedAt: now(),
            })
            .where(eq(ADM.id, admissionId));
        }
        // W-DC-03 / D9 — inherit the carried sequence as the ACTIVE period (no CTI required from us) and
        // open the next PENDING period (our CTI required). The sequence counter never restarts.
        const plan = planTransferIn(input);
        const inheritedWindow = electionPeriodWindow(
          new Date(`${input.priorElectionStartDate}T00:00:00.000Z`),
          plan.inherited.sequence,
        );
        const inheritedPeriod = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId,
              sequenceNumber: plan.inherited.sequence,
              periodKind: electionPeriodKindForSequence(plan.inherited.sequence),
              status: plan.inherited.state,
              // The inherited period is inserted straight into `active` (42 CFR 418.28 — the sending
              // hospice's certification carries it), so it never passes the `setActive` update where
              // every other period gets its window. `priorElectionStartDate` is documented on
              // `TransferInInput` as "anchors the inherited active period's start" and was read by the
              // in-memory slice alone; the Drizzle path discarded it, leaving the one period a receiving
              // hospice cannot re-derive a start for with no start at all.
              ...inheritedWindow,
            })
            .returning({ id: EP.id }),
          "election period insert returned no row",
        );
        const nextPeriod = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId,
              sequenceNumber: plan.next.sequence,
              periodKind: electionPeriodKindForSequence(plan.next.sequence),
              status: plan.next.state,
              // F-226 - the next (pending) period starts the day after the inherited period ends.
              expectedStart: expectedStartFromPriorEnd(inheritedWindow.scheduledEndAt),
            })
            .returning({ id: EP.id }),
          "election period insert returned no row",
        );
        // D9 — draft OUR CTI against the next period (the inherited period runs on the sending
        // hospice's certification; `signCtiHospiceMd` derives the no-attending-needed rule from this
        // period's own sequenceNumber, which is never 1 for a transfer-in, so no special-casing here).
        const signatureRequestedAt = now();
        const signatureDueAt = new Date(computeCtiSignatureDueAt(signatureRequestedAt));
        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: nextPeriod.id,
              hospiceMdId: selectedHospicePhysicianId,
              attendingMdId: null,
              signatureRequestedAt,
              signatureDueAt,
            })
            .returning({ id: CTI.id }),
          "cti insert returned no row",
        );
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId,
          electionPeriodId: nextPeriod.id,
          patientId: adm.patientId,
          requirementType: "cti",
          structuredEntityType: "cti",
          structuredEntityId: cti.id,
          metadata: { createdBy: "transfer_in" },
          createdByMembershipId: actorUserId,
        });
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: {
            ctiId: cti.id,
            electionPeriodId: nextPeriod.id,
            isRecert: true,
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        await outbox.publish(tx, {
          eventName: "m6.cti.signature_requested",
          payload: {
            ctiId: cti.id,
            hospiceMdId: selectedHospicePhysicianId,
            requestedAt: signatureRequestedAt.toISOString(),
            dueAt: signatureDueAt.toISOString(),
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        const xfer = firstOrThrow(
          await tx
            .insert(TE)
            .values({
              organizationId,
              admissionId,
              direction: "in",
              effectiveAt: input.effectiveDate,
              periodSequenceAtTransfer: plan.inherited.sequence,
              receivingOrSendingCcn: input.otherHospiceCcn ?? null,
              receivingOrSendingNpi: input.otherHospiceNpi ?? null,
              receivingOrSendingName: input.otherHospiceName,
              narrative: input.narrative,
            })
            .returning({ id: TE.id, version: TE.version }),
          "transfer insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.transfer.created",
          // Field name must be `transferEventId` (schema), not `transferId`.
          payload: {
            transferEventId: xfer.id,
            admissionId,
            direction: "in",
            effectiveAt: input.effectiveDate,
            // F-192 (#248) — M22's transfer-summary render handshake; `adm.patientId` was already
            // resolved above for the CTI hospice-physician attribution.
            patientId: adm.patientId,
            ...(await renderPayloadFor(
              tx as DbClient,
              organizationId,
              { transferId: xfer.id },
              (ctx) => buildTransferRenderPayload(ctx, xfer.id),
            )),
          },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        await outbox.publish(tx, {
          eventName: "m6.election.period_started",
          // `electionPeriodId` is required and was previously omitted entirely — the inherited
          // period's own insert didn't even `.returning()` its id, so there was nothing to send.
          payload: {
            electionPeriodId: inheritedPeriod.id,
            admissionId,
            sequence: plan.inherited.sequence,
          },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        return {
          id: xfer.id,
          state: "created",
          version: Number(xfer.version),
          currentElectionPeriodSequence: plan.inherited.sequence,
        };
      }).catch((err: unknown) => {
        throw mapUniqueViolation(err, {
          election_period_admission_seq_idx: () =>
            new AdmissionStateError(
              "TRANSFER_IN_PERIOD_CONFLICT",
              "Another benefit period with the carried sequence was recorded on this admission at the " +
                "same time. Reload the admission and review its benefit periods before retrying.",
            ),
        });
      });
    },
    async discharge(
      organizationId,
      admissionId,
      input: DischargeInput,
      actorUserId,
    ): Promise<DischargeResult> {
      // 42 CFR 418.26(b) — validate (or require) the physician discharge order BEFORE the write transaction:
      // the authority port opens its own org-scoped reads, so resolving it inside would hold two connections.
      const order = input.externalSource
        ? null
        : await validateDischargeOrder({
            port: physicianAuthority,
            organizationId,
            // Only an order needs the chart (for the IDG-membership check); its absence never does.
            patientId: input.dischargeOrder
              ? await withOrgContext(db, { organizationId, userId: actorUserId }, (tx) =>
                  patientForAdmission(tx as DbClient, admissionId),
                )
              : "",
            reason: input.reason,
            dischargeDate: input.dischargeDate,
            order: input.dischargeOrder,
            now: now(),
          });
      const orderColumns = order
        ? {
            dischargeOrderSignedByUserId: order.signedByUserId,
            dischargeOrderSignerCapacity: order.capacity,
            dischargeOrderSignedAt: order.signedAt,
            dischargeOrderText: order.orderText,
            dischargeOrderReference: order.orderReference,
          }
        : {};
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        // §6.3 — the per-reason narrative gates (for_cause needs a forCauseReason; D11 tightens
        // no_longer_terminal/other). The reason→permission key is enforced at the route preHandler.
        if (input.externalSource && input.reason !== "death")
          throw new AdmissionStateError(
            "DEATH_CERTIFIER_INVALID",
            "an external-source discharge is only ever a death",
          );
        // F-227 — an external (M29-accepted) death names no pronouncing certifier at intake (R-DC-01's
        // capture is the medical-director cosign's job, M6 §4.8.4); every other gate still applies.
        const issue = checkDischargeNarrative(
          input.reason,
          input.narrative,
          input.forCauseReason,
          input.externalSource ? "external-facility" : input.deathCertifierId,
        );
        if (issue) throw new AdmissionStateError(issue.code, issue.message);
        // Claim patient status 40/41/42 (CMS Pub. 100-04 Ch. 11 §30.3) needs the place of death.
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
        const dbType = REASON_TO_DB_TYPE[input.reason];
        if (requiresMedicalDirectorCosign) {
          // W-DC-02 / D11 — filing a for-cause discharge does NOT discharge the admission; the row is
          // `pending_cosign` and the admission stays active until a medical director cosigns (route 40).
          if (!(await admissionExists(tx as DbClient, admissionId)))
            throw new ResourceNotFoundError(admissionId);
          const de = firstOrThrow(
            await tx
              .insert(DE)
              .values({
                organizationId,
                admissionId,
                dischargeType: dbType,
                status: "pending_cosign",
                cosignRequired: true, // D11 — `medical_director_cosign_required`
                effectiveAt: input.dischargeDate,
                narrative: input.narrative,
                forCauseReason: input.forCauseReason ?? null,
                // GAP-121 — the filer; the cosign refuses the same user (two-person control).
                filedByUserId: actorUserId,
              })
              .returning({
                id: DE.id,
                status: DE.status,
                version: DE.version,
              }),
            "discharge insert returned no row",
          );
          await outbox.publish(tx, {
            eventName: "m6.discharge.created",
            // Field name must be `dischargeEventId` (schema), not `dischargeId`; `reason`/
            // `dischargeDate`/`requiresMedicalDirectorCosign` are also required and were previously
            // omitted entirely.
            payload: {
              dischargeEventId: de.id,
              admissionId,
              reason: input.reason,
              dischargeDate: input.dischargeDate,
              requiresMedicalDirectorCosign,
              patientId: await patientForAdmission(tx as DbClient, admissionId), // F-100 — the chart
              ...(await renderPayloadFor(
                tx as DbClient,
                organizationId,
                { dischargeId: de.id },
                (ctx) => buildDischargeRenderPayload(ctx, de.id),
              )),
            },
            organizationId,
            aggregateKind: "discharge_event",
            aggregateId: de.id,
          });
          return {
            id: de.id,
            state: de.status,
            version: Number(de.version),
            requiresMedicalDirectorCosign,
            reason: input.reason,
          };
        }
        // Every other reason discharges immediately: death → bereavement (§2.3.1) + the M6 bereavement-
        // eligibility rule (emitted by the state machine); the rest → discharged.
        // The discharge_event row is created FIRST, not after (as it used to be) — `dischargeAdmissionTx`
        // fires `m6.discharge.created`/`m6.discharge.death` synchronously inside itself, and both require
        // a real `dischargeEventId`; creating the row afterward meant that id could never exist in time,
        // so this call 500'd with `payload_schema_violation` on every single non-cosign discharge.
        // `bereavementEligible` is knowable up front too — `dischargeTarget` is a pure function of
        // `dischargeType`, so `input.reason === "death"` already decides it without waiting on the result.
        const de = firstOrThrow(
          await tx
            .insert(DE)
            .values({
              organizationId,
              admissionId,
              dischargeType: dbType,
              status: "completed",
              effectiveAt: input.dischargeDate,
              narrative: input.narrative,
              deathAt: input.reason === "death" ? new Date(input.dischargeDate) : null,
              deathCertifierId: input.reason === "death" ? (input.deathCertifierId ?? null) : null,
              placeOfDeath: input.reason === "death" ? (placeOfDeath ?? null) : null,
              bereavementEligible: input.reason === "death",
              ...orderColumns,
              // F-227 — W-M6-31 provenance: completed NOW, flagged for the after-the-fact cosign.
              ...(input.externalSource
                ? {
                    source: "hl7_external" as const,
                    sourceProposalId: input.externalSource.proposalId,
                    cosignRequired: true,
                  }
                : {}),
            })
            .returning({ id: DE.id, status: DE.status, version: DE.version }),
          "discharge insert returned no row",
        );
        await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: REASON_TO_SM_TYPE[input.reason],
          effectiveAt: input.dischargeDate,
          forCauseCosigned: false,
          deathCertifierId: input.reason === "death" ? input.deathCertifierId : undefined,
          dischargeEventId: de.id,
          reason: input.reason,
          externalDeath: input.externalSource !== undefined,
        });
        return {
          id: de.id,
          state: de.status,
          version: Number(de.version),
          requiresMedicalDirectorCosign,
          reason: input.reason,
        };
      });
    },
    async cosignDischarge(
      organizationId,
      id,
      input: CosignDischargeInput,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      // 42 CFR 418.26(b) — the cosigner IS the discharge-order signer. Resolve the capacity BEFORE the write
      // transaction (the authority port opens its own org-scoped read); the predicate already admitted the
      // actor, this records WHICH capacity and re-checks it against the discharge date's signer set.
      const signing = await withOrgContext(
        db,
        { organizationId, userId: actorUserId },
        async (tx) => {
          const [row] = await tx
            .select({ effectiveAt: DE.effectiveAt, source: DE.source, patientId: ADM.patientId })
            .from(DE)
            .innerJoin(ADM, eq(ADM.id, DE.admissionId))
            .where(eq(DE.id, id))
            .limit(1);
          return row ?? null;
        },
      );
      if (!signing) throw new ResourceNotFoundError(id);
      const externalDeath = signing.source === "hl7_external";
      const capacity = await resolveCosignerCapacity({
        port: physicianAuthority,
        organizationId,
        actorUserId,
        actorRoleKeys: input.actorRoleKeys ?? [],
        patientId: signing.patientId,
        dischargeDate: signing.effectiveAt,
        externalDeath,
        claimed: input.capacity,
      });
      const cosignerColumns = { cosignerName: input.cosignerName, cosignerNpi: input.cosignerNpi };
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({
            status: DE.status,
            version: DE.version,
            admissionId: DE.admissionId,
            effectiveAt: DE.effectiveAt,
            source: DE.source,
            sourceProposalId: DE.sourceProposalId,
            cosignedAt: DE.cosignedAt,
            filedByUserId: DE.filedByUserId,
          })
          .from(DE)
          .where(eq(DE.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // GAP-121 — two-person control: the filer of a for-cause discharge cannot cosign it. (An external
        // death has no filer — `filed_by_user_id` is only ever set on the for-cause filing.)
        if (cur.filedByUserId !== null && cur.filedByUserId === actorUserId)
          throw new WardenXError(
            "DISCHARGE_COSIGNER_IS_FILER",
            "The person who filed a for-cause discharge cannot cosign it; another medical director must.",
            409,
          );
        // F-227 (#248) — W-M6-31: an EXTERNAL-source death is already `completed` (admission discharged at
        // intake); the director's cosign is the after-the-fact attestation, not the completion.
        if (cur.source === "hl7_external") {
          if (cur.status !== "completed" || cur.cosignedAt !== null)
            throw conflict(
              cur.cosignedAt !== null
                ? `discharge ${id} was already cosigned`
                : `discharge ${id} is not awaiting a medical-director cosign (state '${cur.status}')`,
            );
          const cosignedAt = now();
          const r = firstOrThrow(
            await tx
              .update(DE)
              .set({
                cosignedAt,
                medicalDirectorMembershipId: actorUserId,
                ...cosignerColumns,
                version: sql`${DE.version} + 1`,
                updatedAt: cosignedAt,
              })
              .where(and(eq(DE.id, id), eq(DE.version, ifVersion), isNull(DE.cosignedAt)))
              .returning({ id: DE.id, status: DE.status, version: DE.version }),
            "discharge not found",
          );
          // Close the W-M6-31 `external_discharge_notice` prompt that asked for exactly this attestation.
          await tx
            .update(CW)
            .set({
              status: "closed",
              closedAt: cosignedAt,
              closeReason: "external_death_cosigned",
              closedBy: actorUserId,
              version: sql`${CW.version} + 1`,
              updatedAt: cosignedAt,
            })
            .where(
              and(
                eq(CW.admissionId, cur.admissionId),
                eq(CW.windowKind, "external_discharge_notice"),
                ne(CW.status, "closed"),
                sql`${CW.payload} ->> 'dischargeEventId' = ${id}`,
              ),
            );
          await outbox.publish(tx, {
            eventName: "m6.discharge.cosigned",
            payload: {
              dischargeEventId: id,
              medicalDirectorCosignedAt: cosignedAt.toISOString(),
              admissionId: cur.admissionId,
              patientId: await patientForAdmission(tx, cur.admissionId),
              dischargeDate: cur.effectiveAt,
              reason: "death",
              ...(await renderPayloadFor(
                tx as DbClient,
                organizationId,
                { dischargeId: id },
                (ctx) => buildDischargeRenderPayload(ctx, id),
              )),
              // F-227 — everything M16's D18 gate-release (`decideCosignReceipt`) correlates on.
              sourceProposalId: cur.sourceProposalId ?? undefined,
              medicalDirectorMembershipId: actorUserId,
            },
            organizationId,
            aggregateKind: "discharge_event",
            aggregateId: id,
          });
          return { id: r.id, state: r.status, version: Number(r.version) };
        }
        if (cur.status !== "pending_cosign")
          throw conflict(
            `discharge ${id} is not awaiting a medical-director cosign (state '${cur.status}')`,
          );
        // W-DC-02 — the cosign completes the discharge AND discharges the admission held active while
        // awaiting governance sign-off (D11).
        const outcome = resolveForCauseDischarge("cosign");
        const r = firstOrThrow(
          await tx
            .update(DE)
            .set({
              status: outcome.dischargeState,
              // F-227 — record the director's cosign facts on the row too (columns exist since 0300).
              cosignedAt: now(),
              medicalDirectorMembershipId: actorUserId,
              ...cosignerColumns,
              // The cosign is the written 418.26(b) discharge order for a for-cause discharge.
              dischargeOrderSignedByUserId: actorUserId,
              dischargeOrderSignerCapacity: capacity,
              dischargeOrderSignedAt: now(),
              dischargeOrderText: input.orderText ?? null,
              dischargeOrderReference: input.orderReference ?? null,
              version: sql`${DE.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(DE.id, id), eq(DE.version, ifVersion)))
            .returning({ id: DE.id, status: DE.status, version: DE.version }),
          "discharge not found",
        );
        await dischargeAdmissionTx(tx, organizationId, cur.admissionId, {
          dischargeType: "for_cause",
          effectiveAt: cur.effectiveAt,
          forCauseCosigned: true,
          // Same fix as the immediate-discharge path — the discharge_event row already exists (it was
          // created `pending_cosign` by the original filing), so its id is available here to satisfy
          // `m6.discharge.created`'s required `dischargeEventId`.
          dischargeEventId: id,
          reason: "for_cause",
        });
        await outbox.publish(tx, {
          eventName: "m6.discharge.cosigned",
          // Field name must be `dischargeEventId` (schema), not `dischargeId`; `medicalDirectorCosignedAt`
          // is required and was previously omitted (and `admissionId` isn't a declared field at all).
          payload: {
            dischargeEventId: id,
            medicalDirectorCosignedAt: now().toISOString(),
            // F-176 (#248) — M22 renders a new discharge-summary version on cosign and files it on the chart.
            admissionId: cur.admissionId,
            patientId: await patientForAdmission(tx, cur.admissionId),
            dischargeDate: cur.effectiveAt,
            reason: "for_cause",
            ...(await renderPayloadFor(tx as DbClient, organizationId, { dischargeId: id }, (ctx) =>
              buildDischargeRenderPayload(ctx, id),
            )),
          },
          organizationId,
          aggregateKind: "discharge_event",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    // GAP-121 — the director's other option on a for-cause filing: decline it. The discharge is voided (the
    // admission was held `active` the whole time, so nothing else moves). Version- and status-guarded.
    async declineDischarge(
      organizationId,
      id,
      input: DeclineDischargeInput,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({ status: DE.status, version: DE.version, source: DE.source })
          .from(DE)
          .where(eq(DE.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.source === "hl7_external" || cur.status !== "pending_cosign")
          throw conflict(
            `discharge ${id} is not awaiting a medical-director cosign (state '${cur.status}')`,
          );
        const outcome = resolveForCauseDischarge("reject");
        const r = firstOrThrow(
          await tx
            .update(DE)
            .set({
              status: outcome.dischargeState,
              medicalDirectorMembershipId: actorUserId,
              // The reason lives on the audited row (free text, scrubbed by the M4 write-audit trigger).
              narrative: sql`coalesce(${DE.narrative}, '') || E'\n[declined] ' || ${input.declineReason}`,
              version: sql`${DE.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(DE.id, id), eq(DE.version, ifVersion), eq(DE.status, "pending_cosign")))
            .returning({ id: DE.id, status: DE.status, version: DE.version }),
          "discharge not found",
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async recordAdmissionRecommendation(
      organizationId,
      admissionId,
      input,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      // 42 CFR 418.25(a) — load the chart facts, validate the recommender OUTSIDE the write transaction (the
      // authority port opens its own reads), then write under optimistic locking.
      const adm = await withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [row] = await tx
          .select({
            patientId: ADM.patientId,
            status: ADM.status,
            version: ADM.version,
            attendingPhysicianId: ADM.attendingPhysicianId,
          })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        return row ?? null;
      });
      if (!adm) throw new ResourceNotFoundError(admissionId);
      assertVersion(admissionId, Number(adm.version), ifVersion);
      if (RECOMMENDATION_CLOSED_STATES.has(adm.status))
        throw new AdmissionStateError(
          "ADMISSION_RECOMMENDATION_INVALID",
          `admission ${admissionId} is ${adm.status}; a recommendation can no longer be recorded`,
        );
      const capacity = await validateAdmissionRecommendation({
        port: physicianAuthority,
        organizationId,
        patientId: adm.patientId,
        hasAttendingPhysician: adm.attendingPhysicianId !== null,
        input,
        now: now(),
      });
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const at = now();
        const [r] = await tx
          .update(ADM)
          .set({
            recommendedByUserId: input.recommendedByUserId,
            recommenderCapacity: capacity,
            recommendedAt: new Date(input.recommendedAt),
            attendingConsulted: input.attendingConsulted,
            attendingConsultNote: input.attendingConsultNote ?? null,
            recommendationRecordedByUserId: actorUserId || null,
            version: sql`${ADM.version} + 1`,
            updatedAt: at,
          })
          .where(and(eq(ADM.id, admissionId), eq(ADM.version, ifVersion)))
          .returning({ id: ADM.id, status: ADM.status, version: ADM.version });
        if (!r) throw conflict(`admission ${admissionId} changed concurrently; reload and retry`);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async getDischargeOrder(organizationId, admissionId) {
      const found = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ id: ADM.id, patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) return null;
        const [de] = await tx
          .select({
            id: DE.id,
            dischargeType: DE.dischargeType,
            status: DE.status,
            effectiveAt: DE.effectiveAt,
            signedBy: DE.dischargeOrderSignedByUserId,
            capacity: DE.dischargeOrderSignerCapacity,
            signedAt: DE.dischargeOrderSignedAt,
            orderText: DE.dischargeOrderText,
            orderReference: DE.dischargeOrderReference,
            cosignerName: DE.cosignerName,
            cosignerNpi: DE.cosignerNpi,
            cosignedAt: DE.cosignedAt,
          })
          .from(DE)
          .where(eq(DE.admissionId, admissionId))
          .limit(1);
        return { patientId: adm.patientId, de: de ?? null };
      });
      if (!found) return null;
      const { de } = found;
      if (!de) return { discharge: null };
      // The signer's display name, when they are still a listed physician for this chart (ids are the record).
      const signedByName = de.signedBy
        ? ((await physicianAuthority.listSignerCandidates(organizationId, found.patientId)).find(
            (c) => c.userId === de.signedBy,
          )?.name ?? null)
        : null;
      return {
        discharge: {
          dischargeEventId: de.id,
          reason: de.dischargeType,
          status: de.status,
          dischargeDate: de.effectiveAt,
          orderRequired: dischargeOrderRequired(de.dischargeType, de.effectiveAt),
          order:
            de.signedBy && de.capacity && de.signedAt
              ? {
                  signedByUserId: de.signedBy,
                  signedByName,
                  capacity: de.capacity,
                  signedAt: de.signedAt.toISOString(),
                  orderText: de.orderText,
                  orderReference: de.orderReference,
                }
              : null,
          cosigner:
            de.cosignerName && de.cosignerNpi
              ? {
                  name: de.cosignerName,
                  npi: de.cosignerNpi,
                  cosignedAt: de.cosignedAt?.toISOString() ?? null,
                }
              : null,
        },
      };
    },
    async listPhysicianSigners(organizationId, admissionId) {
      const patientId = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx
          .select({ patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        return row?.patientId ?? null;
      });
      if (patientId === null) return null;
      return { items: await physicianAuthority.listSignerCandidates(organizationId, patientId) };
    },
    async acknowledgeNor(organizationId, admissionId, input, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [adm] = await tx
          .select({
            status: ADM.status,
            version: ADM.version,
            patientId: ADM.patientId,
          })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const [existing] = await tx
          .select({ id: NOR.id })
          .from(NOR)
          .where(eq(NOR.admissionId, admissionId))
          .limit(1);
        // §2.3.1 pending → notice_of_rights_acknowledged (guards `alreadyAcknowledged`).
        const t = transitionAdmission(adm.status as AdmissionState, {
          type: "acknowledgeNoticeOfRights",
          alreadyAcknowledged: !!existing,
        } satisfies AdmissionEvent);
        const acknowledgedAt = new Date();
        // TASK-034: the request's `deliveryMethod`/`acknowledgedByRole` used to be validated by the
        // route then discarded here — every acknowledgment silently recorded "patient, electronic
        // witnessed" regardless of what was submitted. `acknowledgedByRole`'s wire value
        // "legal_representative" doesn't match the DB's `election_signer_kind` enum ("representative"),
        // so it's translated, not passed through.
        const nor = firstOrThrow(
          await tx
            .insert(NOR)
            .values({
              organizationId,
              admissionId,
              patientId: adm.patientId,
              signerKind:
                input.acknowledgedByRole === "legal_representative" ? "representative" : "patient",
              acknowledgedAt: acknowledgedAt.toISOString().slice(0, 10),
              acknowledgedAtInstant: input.acknowledgedAt ? new Date(input.acknowledgedAt) : null,
              acknowledgedByName: input.acknowledgedByName ?? null,
              acknowledgmentMethod: input.deliveryMethod,
            })
            .returning({ id: NOR.id }),
          "NOR insert returned no row",
        );
        await createAdmissionEvidenceService(tx).recordStructuredEvidence({
          organizationId,
          admissionId,
          patientId: adm.patientId,
          requirementType: "notice_of_rights",
          structuredEntityType: "notice_of_rights",
          structuredEntityId: nor.id,
          completedAt: acknowledgedAt,
          metadata: {
            acknowledgedByRole: input.acknowledgedByRole,
            deliveryMethod: input.deliveryMethod,
          },
          createdByMembershipId: actorUserId,
        });
        const r = firstOrThrow(
          await tx
            .update(ADM)
            .set({ status: t.to, version: sql`${ADM.version} + 1` })
            .where(eq(ADM.id, admissionId))
            .returning({
              id: ADM.id,
              status: ADM.status,
              version: ADM.version,
            }),
          "row not found",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "admission",
            aggregateId: admissionId,
            admissionId,
          },
          t.effects,
          {
            "m6.nor.acknowledged": {
              norAcknowledgmentId: nor.id,
              acknowledgedAt: acknowledgedAt.toISOString(),
              // F-100 — the chart. Already in hand: the NOR row was inserted with it two statements up.
              patientId: adm.patientId,
              ...(await renderPayloadFor(tx as DbClient, organizationId, { norId: nor.id }, (ctx) =>
                buildNorRenderPayload(ctx, nor.id),
              )),
            },
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    // ── M6L-T05: compliance-window close / override ───────────────────────────────────────────────
    async closeComplianceWindow(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ status: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status === "closed") throw conflict(`compliance window ${id} is already closed`);
        const closedAt = now();
        const r = firstOrThrow(
          await tx
            .update(CW)
            .set({
              status: "closed",
              closedAt,
              version: sql`${CW.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(CW.id, id), eq(CW.version, ifVersion)))
            .returning({ id: CW.id, status: CW.status, version: CW.version }),
          "compliance window not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.compliance.window.closed",
          // `closedAt`/`closedVia` are required and were previously omitted. This route is the
          // direct-close path (no override reason involved), hence `closedVia: "manual"`.
          payload: {
            complianceWindowId: id,
            closedAt: closedAt.toISOString(),
            closedVia: "manual",
          },
          organizationId,
          aggregateKind: "compliance_window",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async overrideComplianceWindow(
      organizationId,
      id,
      reason,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({ status: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status === "closed") throw conflict(`compliance window ${id} is already closed`);
        // §2.2 override — closes the window early with the captured reason + the overriding staff member
        // (whose role the route's ABAC preHandler gates); the reason is the audit-bearing evidence.
        const r = firstOrThrow(
          await tx
            .update(CW)
            .set({
              status: "closed",
              closedAt: now(),
              overrideReason: reason,
              closedBy: actorUserId || null,
              version: sql`${CW.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(CW.id, id), eq(CW.version, ifVersion)))
            .returning({ id: CW.id, status: CW.status, version: CW.version }),
          "compliance window not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.compliance.window.overridden",
          payload: { complianceWindowId: id, reason },
          organizationId,
          aggregateKind: "compliance_window",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
  };
}

/**
 * The production, RLS-backed AdmissionAbacResolver — the §4.6 signer-identity write predicates
 * (F2F attest, discharge medical-director cosign, compliance override) load a resource's owner facts
 * through it. Every load is a single org-scoped read under `withOrgContext` (RLS backstops), returning
 * `null` when the row is absent/cross-tenant so the predicate fails closed.
 */
export function createDbAdmissionAbacResolver(db: DbClient): AdmissionAbacResolver {
  return {
    // `admission_intake_scope` — the patient must be a patient of THIS org (M5's org-scoped read, the same
    // confirmation `createAdmission` runs), and the predicate needs to know whether it has an ongoing stay.
    async loadPatientIntakeFacts(organizationId, patientId) {
      const patient = await getSeam("PatientIntakeResolver").confirmPatient({
        organizationId,
        patientId,
      });
      if (!patient) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [open] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.organizationId, organizationId),
              eq(ADM.patientId, patientId),
              inArray(ADM.status, ["active", "on_hold"]),
            ),
          )
          .limit(1);
        const [any] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(and(eq(ADM.organizationId, organizationId), eq(ADM.patientId, patientId)))
          .limit(1);
        // The latest referral of this patient that names a site — how a never-admitted patient is placed (§6.8).
        const [ref] = await tx
          .select({ providerEntityId: REF.providerEntityId, locationId: REF.locationId })
          .from(REF)
          .where(
            and(
              eq(REF.organizationId, organizationId),
              eq(REF.patientId, patientId),
              or(isNotNull(REF.providerEntityId), isNotNull(REF.locationId)),
            ),
          )
          .orderBy(desc(REF.createdAt))
          .limit(1);
        // The chart's site comes from M5's own org-scoped read (M6 never selects M5's table).
        return {
          hasActiveOrOnHoldAdmission: open !== undefined,
          hasAnyAdmission: any !== undefined,
          providerEntityId: patient.providerEntityId ?? null,
          locationId: patient.locationId ?? null,
          referralProviderEntityId: ref?.providerEntityId ?? null,
          referralLocationId: ref?.locationId ?? null,
        };
      });
    },
    async loadReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            locationId: REF.locationId,
            providerEntityId: REF.providerEntityId,
          })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        return r
          ? {
              locationId: r.locationId ?? null,
              providerEntityId: r.providerEntityId ?? null,
            }
          : null;
      });
    },
    async loadAdmission(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
            locationId: ADM.locationId,
          })
          .from(ADM)
          // Explicit org predicate as well as RLS (defense in depth: the §6.8 predicates read through this).
          .where(and(eq(ADM.id, id), eq(ADM.organizationId, organizationId)))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
              locationId: r.locationId ?? null,
            }
          : null;
      });
    },
    async loadCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            hospiceMdId: CTI.hospiceMdId,
            attendingMdId: CTI.attendingMdId,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r
          ? {
              hospiceMedicalDirectorId: r.hospiceMdId,
              attendingPhysicianId: r.attendingMdId ?? null,
            }
          : null;
      });
    },
    async loadF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // The DB stores the performer as `performed_by_user_id`; the §4.6 predicate reads it as the
        // scheduled clinician (the person whose identity the attest gate matches).
        const [r] = await tx
          .select({ performedByUserId: F2F.performedByUserId })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        return r ? { scheduledClinicianId: r.performedByUserId } : null;
      });
    },
    async loadComplianceWindow(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // compliance_window carries no patient/provider — join the admission it belongs to.
        const [r] = await tx
          .select({
            admissionId: CW.admissionId,
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(CW)
          .innerJoin(ADM, eq(CW.admissionId, ADM.id))
          .where(eq(CW.id, id))
          .limit(1);
        return r
          ? {
              admissionId: r.admissionId,
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    // GAP-011 — the five child-resource scope loaders `admission.scope` dispatches to for a resource
    // NOT keyed by an admission id directly (abac-predicates.ts). `election_period` / `level_of_care_
    // period` carry `admission_id` directly (one join); `election_statement` / `certification_of_
    // terminal_illness` / `face_to_face_encounters` carry it only via `election_period_id` (a two-hop
    // join). All five return the SAME `{patientId, providerEntityId}` shape `loadAdmission` does, read
    // off the ADMISSION row (never the child) — `loadCti`/`loadF2f` above already prove the child
    // tables carry no patient/provider-entity column of their own.
    async loadElectionPeriodScope(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(EP)
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(eq(EP.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    async loadElectionStatementScope(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(ES)
          .innerJoin(EP, eq(ES.electionPeriodId, EP.id))
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(eq(ES.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    async loadCtiScope(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(CTI)
          .innerJoin(EP, eq(CTI.electionPeriodId, EP.id))
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(eq(CTI.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    async loadF2fScope(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(F2F)
          .innerJoin(EP, eq(F2F.electionPeriodId, EP.id))
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(eq(F2F.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    async loadLocScope(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
            createdByUserId: ADM.createdByUserId,
          })
          .from(LOC)
          .innerJoin(ADM, eq(LOC.admissionId, ADM.id))
          .where(eq(LOC.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
              createdByUserId: r.createdByUserId ?? null,
            }
          : null;
      });
    },
    async loadDischargeSigning(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ effectiveAt: DE.effectiveAt, source: DE.source, patientId: ADM.patientId })
          .from(DE)
          .innerJoin(ADM, eq(ADM.id, DE.admissionId))
          .where(eq(DE.id, id))
          .limit(1);
        return r
          ? {
              patientId: r.patientId,
              dischargeDate: r.effectiveAt,
              externalDeath: r.source === "hl7_external",
            }
          : null;
      });
    },
  };
}
