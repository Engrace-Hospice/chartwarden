import { audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/10-hope — PRODUCTION HopeRouteService (M10L reads + writes, mirrors M9L).
//
// The screen-driving READS (timepoint-schedule worklist, HOPE assessment chart + detail, SFV worklist,
// iQIES submission list/detail, pre-submission validation findings, the compliance dashboard) run as real
// Drizzle queries over the M10-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `chartwarden_app` role. `hope_assessment` is PARTITION BY RANGE
// (target_date) with a DEFAULT partition so inserts always land. The WRITE lifecycle is now real (M10L):
// record (draft insert, linked to the open schedule) · sign (server-authoritative J2051 verdict → the DB
// schedule-mark-completed trigger closes the schedule; a fired trigger opens the SFV) · correct (the
// append-only amendment whose insert fires the DB supersede trigger) · SFV completion · schedule skip ·
// submission assemble/retry · summary-PDF request. The transitions that have a catalog event (sign, correct, inactivate,
// SFV opened/completed, submission queued/transmitted/settled, summary request) emit their `m10.hope.*` event on the
// caller's transactional outbox; the draft insert, the schedule skip and the package cancel emit none (the M4 write-audit
// trigger records them). No route is left at 501.
//
// The backend object IS BOTH the HopeRouteService AND the §4.7 HopeAbacResolver. Because the interface
// threads no siting nor an M9 snapshot into the DB backend, this slice makes documented compromises (the
// M8/M9 convention): (1) writes envelope `withOrgContext` with `userId:""` → the M4 write-audit trigger
// fires with a NULL actor (the acting membership is the passed `userId`, stored as created/signed_by);
// (2) GAP-019 / GAP-204: the D8 PPS/ESAS-r snapshot is taken at signature through M9's published
// `LatestAssessmentProvider` seam (null only when M9 cannot answer, and then a compliance finding is
// raised — no external dependency blocks the write path, §7.13); (3) a new draft's provider/location siting is
// the admission summary's, and null when the M6 seam has none (a finding cannot be stored without it, and says so in the
// log); the SFV `alert_cadence` is a minimal default until the alert planner is threaded. A correction REUSES the
// original's `target_date` (the composite self-FK `(corrects_assessment_id, target_date) → (id,
// target_date)` demands it); the DB supersede trigger flips the original only when the correction signs.
import {
  type CaptureDecision,
  HopeStateError,
  assertCaptureAllowed,
  assertRfaMatchesSchedule,
  captureInstantOf,
  requireAttestation,
  require_,
} from "@chartwarden/hope";
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { withOrgContext } from "@chartwarden/tenancy";
import type { HopeRfaKind, LatestAssessment, ScaleType } from "@chartwarden/types";
import { ConflictError, NotFoundError, ValidationError } from "@chartwarden/types";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { getSeam } from "../../bootstrap/index";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "./abac-predicates";
import { createHopeAdmissionPrefillService } from "./hope-admission-prefill-service";
import { createHopeAssessmentAnswerService } from "./hope-answer-service";
import {
  lockAssessmentRow,
  lockRecordKey,
  mapLockTimeoutToBusy,
  takeBoundedLock,
} from "./hope-assessment-lock";
import { requireCalendarDateTime, requireCalendarTargetDate } from "./hope-calendar-date";
import { HopeSubmissionPayloadError, serializeHopeAssessmentXml } from "./hope-cms-xml-serializer";
import { createHopeDischargePrefillService } from "./hope-discharge-prefill-service";
import { errorClassForLog, idForLog } from "./hope-log-id";
import {
  HopeAssessmentNotReadyToSignError,
  createHopeAssessmentReadinessService,
} from "./hope-readiness-service";
import {
  createHopeAssessmentAnswerWriter,
  initializeHopeCorrection,
  initializeHopeInactivation,
  initializeNewHopeRecord,
} from "./hope-record-initializer";
import { requireSkipReasonCode } from "./hope-schedule-skip";
import { reconcileCompletedSfvRegulatoryAnswers } from "./hope-sfv-completion-answers";
import { timepointProjectionGapMessage } from "./hope-sfv-completion-guards";
import { createSfvCompletionRecorder } from "./hope-sfv-completion-record";
import { recordSignedTail } from "./hope-sign-tail";
import {
  HOPE_SIGN_STEP_UP_OPERATION,
  type HopeAuditRequestFacts,
  auditHopeSignature,
  clientCorrelationContext,
  hopeAuditActor,
} from "./hope-signature-audit";
import { createHopeSpecRegistry, logSpecNotInForce } from "./hope-spec-registry";
import { requireNotCancelled } from "./hope-submission-cancel";
import { advancePackagedToExported, cancelHopeSubmission } from "./hope-submission-cancel-db";
import { buildHopeSubmissionHeader, readHopeSoftwareVendor } from "./hope-submission-header";
import {
  LIGHT_ITEM,
  LIGHT_SUB_COLUMNS,
  type LightSubmissionColumns,
  loadSubmissionFindings,
  loadSubmissionItems,
  resolutionCountsByBatch,
} from "./hope-submission-reads-db";
import {
  ACCEPTED_BATCH_STATUSES,
  ANSWERED_BATCH_STATUSES,
  appendReportResults,
  classifyCmsResult,
  deriveBatchOutcome,
  isResultImportable,
  isSettledItemStatus,
  manualUploadTransmittedPayload,
  reportHashes,
  resultRefusalCode,
  settledBatchEvent,
  worstOutcome,
} from "./hope-submission-result";
import { canonicalUuidOrNull, sameUuid, uuidOrNotFound } from "./hope-uuid";
import {
  HopeValidationFindingSitingError,
  createHopeValidationService,
} from "./hope-validation-service";
import { buildDeterministicZip } from "./hope-zip";
import { ASSEMBLE_BLOCKING_ITEM_STATUSES } from "./jobs/assemble-store";
import type { HopeWriteOutboxPort } from "./outbox-port";
import type {
  CorrectTimepointArgs,
  HopeAssessmentView,
  HopeComplianceView,
  HopeRouteService,
  HopeScheduleView,
  HopeSfvView,
  HopeSignResult,
  HopeSubmissionDetailView,
  HopeSubmissionView,
  HopeWorkflowStateView,
  RecordSfvArgs,
  RecordTimepointArgs,
} from "./routes/service";
import { buildWorkflowState, rateOf } from "./routes/service";
import { regenerateSchedulesForAdmission } from "./scheduling/schedule-writer";

const ASSESS = schema.hopeAssessments;
const SCHED = schema.hopeTimepointSchedules;
const SFV = schema.symptomFollowUpVisits;
const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;
const ANSWER = schema.hopeAssessmentAnswers;
const ITEM = schema.hopeSpecItems;
const RESULT = schema.hopeSubmissionResultEvents;
const answerWriter = createHopeAssessmentAnswerWriter();
const dischargePrefillService = createHopeDischargePrefillService();

/**
 * Run the draft-mode validation that follows an answer write, and let ONE failure through quietly: a draft with no
 * provider entity or location siting (the admission summary had none) cannot have its findings stored. That is the
 * ordinary case for such a draft, but it repeats on every autosave, so it leaves a line naming the assessment and the org
 * (ids only) rather than disappearing; any other failure is the caller's.
 */
async function validateDraftAfterWrite(
  validate: () => Promise<unknown>,
  organizationId: string,
  assessmentId: string,
): Promise<void> {
  try {
    await validate();
  } catch (error) {
    if (!(error instanceof HopeValidationFindingSitingError)) throw error;
    console.warn(
      `m10: draft validation findings of assessment ${idForLog(assessmentId)} (org ${idForLog(organizationId)}) were not stored: the draft has no provider entity / location siting.`,
    );
  }
}

/**
 * Why a review's SFV self-heal repaired nothing in the ordinary case: no completed SFV, answers already right, or a
 * record that is no longer a draft (every review of a signed record). Any other reason is a completed SFV whose
 * J2052/J2053 answers cannot be rebuilt.
 */
const EXPECTED_SFV_HEAL_REASONS: ReadonlySet<string> = new Set([
  "sfv_not_completed",
  "up_to_date",
  "triggering_not_draft",
]);

type ScheduleRow = typeof SCHED.$inferSelect;
type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;
type SubmissionRow = typeof SUB.$inferSelect;
// Reads that only render the view skip `acceptance_report` (base64 ZIP + raw CMS results). The report
// reference is projected out of the jsonb instead.
const LIGHT_SUB = {
  ...LIGHT_SUB_COLUMNS,
  reportReference: sql<string | null>`${SUB.acceptanceReport}->>'reportReference'`.as(
    "report_reference",
  ),
};
type LightSubmissionRow = Omit<SubmissionRow, "acceptanceReport"> & {
  reportReference?: string | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** D9 — is Section Q (Participation) present on the payload? A death discharge must NOT carry it; every
 * other discharge reason must. Presence is the key existing with any value, mirroring how the §J reader
 * below treats its own section: the CMS item-level rules are the validation engine's job, not this gate's. */
const sectionQPresent = (data: Record<string, unknown>): boolean =>
  Object.hasOwn(data, "Q") && data.Q != null;

/** The transactional-outbox port (§2.4). Declared in ./outbox-port.ts — a leaf both this file and
 * scheduling/schedule-writer.ts can import without depending on each other. Re-exported here so the
 * existing import sites keep working. */
export type { HopeWriteOutboxPort } from "./outbox-port";
const NOOP_OUTBOX: HopeWriteOutboxPort = { async publish() {} };

/**
 * `column = <the provider entity or patient the caller named>`, decided by the DATABASE on the canonical id: compared in
 * JavaScript on the caller's spelling, an upper-case or braced id would silently match nothing. No id named is no
 * predicate (the whole organisation, which `hope.scope` allows only an org-wide role). A value that is no uuid names no
 * record, so it matches nothing (as the JavaScript comparison always did) instead of reaching a `::uuid` cast and
 * answering a 500.
 */
function canonicalIdFilter(column: AnyPgColumn, id: string | undefined): SQL | undefined {
  if (!id) return undefined;
  const canonical = canonicalUuidOrNull(id);
  return canonical === null ? sql`false` : eq(column, canonical);
}

/**
 * A free-string filter on an enum column: false when the value is no member. Such a value matches no row, and sent to
 * the database as `column = value` it would raise 22P02 (a 500) instead of answering an empty list.
 */
const isEnumMember = (column: { enumValues: readonly string[] }, value: string): boolean =>
  column.enumValues.includes(value);

/** `status -> number of rows` from a `select status, count(*) ... group by status`: the dashboard needs counts, not rows. */
const countsByStatus = (rows: readonly { status: string; n: number }[]): Map<string, number> =>
  new Map(rows.map((r) => [r.status, Number(r.n)]));

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new NotFoundError(msg);
  return r;
}

/**
 * The §D8 scales snapshotted onto `clinical_context_snapshot` at HOPE sign (GAP-019). The DB backend
 * used to skip this entirely — `clinical_context_snapshot` was written only by a CORRECTION copying the
 * original's (always-null) value, so no production HOPE assessment has ever carried the PPS/ESAS-r
 * context the D8 rule exists to preserve.
 */
const D8_SNAPSHOT_SCALES = ["pps", "esas_r"] as const;

const OFFICIAL_RFA_KINDS = [
  "01_admission",
  "02_huv1",
  "03_huv2",
  "05_discharge",
] as const satisfies readonly HopeRfaKind[];

function isOfficialRfaKind(rfaKind: string): rfaKind is (typeof OFFICIAL_RFA_KINDS)[number] {
  return (OFFICIAL_RFA_KINDS as readonly string[]).includes(rfaKind);
}

const toAssessmentView = (r: AssessmentRow): HopeAssessmentView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  rfaKind: r.rfaKind as HopeAssessmentView["rfaKind"],
  status: r.status as HopeAssessmentView["status"],
  targetDate: r.targetDate.toISOString(),
  authorDiscipline: r.authorDiscipline ?? "",
  j2051MaxSeverity: r.j2051MaxSeverity as HopeAssessmentView["j2051MaxSeverity"],
  j2051TriggerFired: r.j2051TriggerFired,
  wasLate: r.wasLate,
  signedAt: iso(r.signedAt),
  signedBy: r.signedByMembershipId ?? null,
  correctsAssessmentId: r.correctsAssessmentId ?? null,
  supersededByAssessmentId: r.supersededById ?? null,
  snapshot: (r.clinicalContextSnapshot as Record<string, number | null> | null) ?? null,
  regulatory: {
    specVersionId: r.specVersionId ?? null,
    isc: (r.isc as HopeAssessmentView["regulatory"]["isc"]) ?? null,
  },
  version: r.version,
});

const toScheduleView = (r: ScheduleRow): HopeScheduleView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  rfaKind: r.rfaKind as HopeScheduleView["rfaKind"],
  status: r.status as HopeScheduleView["status"],
  windowOpensAt: r.windowOpensAt.toISOString(),
  windowClosesAt: r.windowClosesAt.toISOString(),
  lateDeadlineAt: r.lateDeadlineAt.toISOString(),
  generatedBy: r.generatedBy as HopeScheduleView["generatedBy"],
  completedByAssessmentId: r.completedByAssessmentId ?? null,
});

const toSfvView = (r: SfvRow): HopeSfvView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  triggeringAssessmentId: r.triggeringAssessmentId,
  status: r.status as HopeSfvView["status"],
  triggeredAt: r.triggeredAt.toISOString(),
  dueAt: r.dueAt.toISOString(),
  completingAssessmentId: r.completingAssessmentId ?? null,
});

const NO_RESOLUTIONS = { needs: 0, inProgress: 0, resubmitted: 0 };
const toSubmissionView = (
  r: LightSubmissionRow,
  resolutions: typeof NO_RESOLUTIONS = NO_RESOLUTIONS,
): HopeSubmissionView => ({
  id: r.id,
  providerEntityId: r.providerEntityId,
  submissionPeriod: r.submissionPeriod,
  status: r.status as HopeSubmissionView["status"],
  transportMode: (r as { transportMode?: string }).transportMode ?? "manual_iqies_upload",
  validationProfile: (r as { validationProfile?: string | null }).validationProfile ?? null,
  packageFilename: (r as { packageFilename?: string | null }).packageFilename ?? null,
  packageSha256: (r as { packageSha256?: string | null }).packageSha256 ?? null,
  packageSizeBytes: (r as { packageSizeBytes?: number | null }).packageSizeBytes ?? null,
  itemCount: r.itemCount,
  acceptedCount: r.acceptedCount,
  rejectedCount: r.rejectedCount,
  transmittedAt: iso(r.transmittedAt),
  exportedAt: iso((r as { exportedAt?: Date | null }).exportedAt ?? null),
  submittedAt: iso((r as { submittedAt?: Date | null }).submittedAt ?? null),
  acceptedAt: iso(r.acceptedAt),
  iqiesSubmissionReference:
    (r as { iqiesSubmissionReference?: string | null }).iqiesSubmissionReference ?? null,
  cancelledAt: iso(r.cancelledAt ?? null),
  cancelReasonCode: (r.cancelReasonCode ?? null) as HopeSubmissionView["cancelReasonCode"],
  needsCorrectionCount: resolutions.needs,
  correctionInProgressCount: resolutions.inProgress,
  resubmittedCount: resolutions.resubmitted,
});

const reportReferenceOf = (r: LightSubmissionRow): string | null => {
  if (typeof r.reportReference === "string") return r.reportReference;
  const report = (r as { acceptanceReport?: { reportReference?: unknown } | null })
    .acceptanceReport;
  return typeof report?.reportReference === "string" ? report.reportReference : null;
};

/**
 * The production, RLS-backed HopeRouteService + HopeAbacResolver (one object). Reads and writes are
 * real (Drizzle + RLS). Org is bound from the request context by the caller and passed as `organizationId` —
 * never the body. Every read runs under `withOrgContext` so RLS scopes rows to the active org.
 */
export function createDbHopeBackend(
  unmappedDb: DbClient,
  outbox: HopeWriteOutboxPort = NOOP_OUTBOX,
  /** GAP-015: the SERVER clock the capture gate judges lateness / the hard cutoff on (injectable for tests). */
  clock: () => Date = () => new Date(),
): HopeRouteService {
  // Every HOPE service below runs on this database, so a lock timeout (55P03) raised by ANY statement of a bounded
  // transaction is the typed retryable `409 M10_RECORD_BUSY`, never a generic 500.
  const db = mapLockTimeoutToBusy(unmappedDb);
  /**
   * GAP-015 — record a CRITICAL audit event when a platform admin's deadline override actually lifted the
   * hard cutoff, on the same transaction as the row it let through. The route has already required the
   * `hope.admin.late_deadline_override` permission and a justification. The row carries the same request facts as the
   * signature audit (session user, request id, address, sanitised user agent). The context also carries the justification
   * text (`justification`): it is the only record of why the HQRP cutoff was lifted, and the trail is immutable. It is free
   * text a person typed, so the route guard has already screened it for patient identifiers; the screen runs again here,
   * at the one place the text is written, so a second caller of the service cannot put an identifier in the trail.
   */
  async function auditDeadlineOverride(
    t: DbClient,
    organizationId: string,
    membershipId: string,
    resource: { kind: string; id: string },
    context: Record<string, unknown>,
    request?: HopeAuditRequestFacts,
  ): Promise<void> {
    if (typeof context.justification === "string") {
      assertNoPatientIdentifier("adminOverrideJustification", context.justification);
    }
    // M10's acting id is the MEMBERSHIP id (not a user id), so it rides in the context, not `actor_user_id`.
    await audit(
      t as never,
      hopeAuditActor(organizationId, `hope-late-deadline-override:${resource.id}`, request),
      {
        eventType: "hope.late_deadline_override",
        resourceKind: resource.kind,
        resourceId: resource.id,
        outcome: "success",
        severity: "critical",
        context: { ...context, byMembershipId: membershipId, ...clientCorrelationContext(request) },
      },
    );
  }
  const answerService = createHopeAssessmentAnswerService(db, {
    // §2.4 / §4.9 — the SFV obligation opens while the draft's J2050/J2051 answers are patched, so
    // `m10.hope.sfv_created` (M36's SFV-obligation alert) is emitted on THAT tx, beside the row.
    onSfvOpened: (tx, e) =>
      emit(tx, e.organizationId, "m10.hope.sfv_created", "symptom_follow_up_visit", e.sfvId, {
        sfvId: e.sfvId,
        triggeringAssessmentId: e.triggeringAssessmentId,
        dueAt: e.dueAt,
      }),
  });
  const validationService = createHopeValidationService(db);
  const readinessService = createHopeAssessmentReadinessService(db);
  const admissionPrefillService = createHopeAdmissionPrefillService();
  /** Emit one `m10.hope.*` event on the caller's tx (validated + persisted by the bound publisher). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** Load a tenant-scoped assessment row (RLS-scoped) or raise the non-leaking 404. */
  /**
   * GAP-019 — the §D8 PPS/ESAS-r snapshot, through M9's published `LatestAssessmentProvider` seam.
   * Returns `null` when the seam cannot answer (unregistered, deny-stub, RLS-empty): §7.13 is explicit
   * that no external dependency blocks a clinical write, so a missing snapshot degrades to the
   * compensating warning finding below rather than refusing the signature.
   *
   * Called OUTSIDE the sign transaction: M9's store opens its own `withOrgContextFromRequest`, and
   * nesting that inside an open `withOrgContext` would set the GUC on an already-bound connection.
   */
  async function d8Snapshot(patientId: string): Promise<Record<string, number | null> | null> {
    try {
      const rows = await getSeam("LatestAssessmentProvider").latestBatch(patientId, [
        ...D8_SNAPSHOT_SCALES,
      ] as unknown as ReadonlyArray<ScaleType>);
      const byScale = new Map<string, number | null>(
        rows.map((r: LatestAssessment) => [String(r.scaleType), r.score ?? null]),
      );
      const snap: Record<string, number | null> = {};
      for (const scale of D8_SNAPSHOT_SCALES) snap[scale] = byScale.get(scale) ?? null;
      return snap;
    } catch (error) {
      // No snapshot is recorded and the missing-PPS compliance finding takes its place (see `signTimepoint`); this line
      // names the cause, which the finding cannot.
      console.warn(
        `m10: the M9 assessment seam threw ${errorClassForLog(error)} reading the D8 snapshot for patient ${idForLog(patientId)}.`,
      );
      return null;
    }
  }

  /**
   * The admission's PE/location siting, through M6's `AdmissionStatusReader`. Needed ONLY to write a
   * `hope_validation_finding`, whose `provider_entity_id` / `location_id` are NOT NULL while
   * `hope_assessment`'s are nullable and a draft takes them from the admission summary, null when it has none (documented
   * compromise #3).
   * `null` when unresolvable — the finding then cannot be written and says so in the log rather than
   * disappearing.
   */
  async function admissionSiting(
    organizationId: string,
    patientId: string,
    admissionId: string,
  ): Promise<{ providerEntityId: string; locationId: string } | null> {
    try {
      const summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(
        organizationId,
        admissionId,
      );
      // Two spellings of one uuid (case, hyphenation) are the same id; ids that are not uuids match only when identical.
      const same = (a: string, b: string): boolean => a === b || sameUuid(a, b);
      if (!same(summary.organizationId, organizationId) || !same(summary.patientId, patientId))
        return null;
      const providerEntityId = summary.providerEntityId;
      const locationId = summary.locationId ?? null;
      if (!providerEntityId || !locationId) return null;
      return { providerEntityId, locationId };
    } catch (error) {
      console.warn(
        `m10: the M6 admission seam threw ${errorClassForLog(error)} resolving the siting of admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}).`,
      );
      return null;
    }
  }

  async function writeZ0500B(
    tx: DbClient,
    assessment: AssessmentRow,
    organizationId: string,
    z0500b: string,
    at: Date,
  ): Promise<void> {
    if (!assessment.specVersionId || !assessment.isc) return;
    const [row] = await tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(schema.hopeSpecItemIsc, eq(schema.hopeSpecItemIsc.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, assessment.specVersionId),
          eq(ITEM.itemCode, "Z0500B"),
          eq(schema.hopeSpecItemIsc.isc, assessment.isc),
          eq(schema.hopeSpecItemIsc.active, true),
        ),
      )
      .limit(1);
    if (!row) throw new ConflictError("Z0500B is not active for this HOPE assessment ISC");
    await tx
      .insert(ANSWER)
      .values({
        organizationId,
        providerEntityId: assessment.providerEntityId,
        locationId: assessment.locationId,
        hopeAssessmentId: assessment.id,
        specVersionId: assessment.specVersionId,
        specItemId: row.item.id,
        state: "answered",
        value: z0500b,
        source: "derived",
        sourceReference: { reason: "record_completion_signature" },
        answeredAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
        set: {
          state: "answered",
          value: z0500b,
          source: "derived",
          sourceReference: { reason: "record_completion_signature" },
          answeredAt: at,
          answeredByMembershipId: null,
          updatedAt: at,
        },
      });
  }

  /**
   * Chart facts captured after the draft was created (e.g. a Medicare number added to the patient's
   * coverage at intake) flow into the draft when it is opened. Only answers the clinician has not
   * typed (`source !== "user"`) are refreshed, and an unchanged chart writes nothing. A refresh that changes an answer
   * bumps the draft's `version` (see `prefillAdmission`), so a signer who reviewed the older version is refused.
   */
  async function refreshChartPrefill(
    tx: DbClient,
    organizationId: string,
    assessment: AssessmentRow,
  ): Promise<void> {
    if (
      assessment.status !== "draft" ||
      assessment.correctsAssessmentId ||
      !assessment.specVersionId ||
      !assessment.isc ||
      !["01_admission", "02_huv1", "03_huv2", "05_discharge"].includes(assessment.rfaKind)
    )
      return;
    const [spec] = await tx
      .select({ code: schema.hopeSpecVersions.code })
      .from(schema.hopeSpecVersions)
      .where(eq(schema.hopeSpecVersions.id, assessment.specVersionId))
      .limit(1);
    if (!spec) return;
    const admission = await getSeam("AdmissionStatusReader").getAdmissionSummary(
      organizationId,
      assessment.admissionId,
    );
    if (!admission || admission.organizationId !== organizationId) return;
    await admissionPrefillService.prefillAdmission({
      tx,
      organizationId,
      assessment,
      specVersionCode: spec.code,
      admissionDate: (admission.admissionAt ?? assessment.targetDate.toISOString()).slice(0, 10),
      refreshOnly: true,
    });
  }

  /**
   * The draft a sign is about to freeze, LOCKED (the assessment row, never the shared spec-version row) so two parallel
   * signs serialise: the loser waits, re-reads the row `signed`, and takes the 409 below instead of an UPDATE that
   * matches no row and surfaces as a misleading 404. Status, version and the frozen spec are judged on the LOCKED row.
   * Waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`) and retries once on a row that moved partition under the
   * wait (a HUV completion date), exactly as `lockAssessmentRow` does.
   */
  async function lockDraftForSign(
    t: DbClient,
    organizationId: string,
    id: string,
    ifVersion: number | undefined,
  ): Promise<{ r: AssessmentRow; specCode: string; expectedVersion: number }> {
    const [loaded] = await takeBoundedLock(
      t,
      (statement) =>
        statement
          .select({ assessment: ASSESS, specCode: schema.hopeSpecVersions.code })
          .from(ASSESS)
          .innerJoin(schema.hopeSpecVersions, eq(schema.hopeSpecVersions.id, ASSESS.specVersionId))
          .where(and(eq(ASSESS.id, id), eq(ASSESS.organizationId, organizationId)))
          .limit(1)
          .for("update", { of: ASSESS }),
      {
        retryMovedRow: true,
        lock: `sign lock on assessment ${idForLog(id)} (org ${idForLog(organizationId)})`,
      },
    );
    if (!loaded) throw new NotFoundError(`HOPE assessment ${id} not found`);
    const r = loaded.assessment as AssessmentRow;
    require_(
      r.status === "draft",
      "M10_CORRECTION_TARGET_NOT_SIGNED",
      `Assessment ${id} is not a draft and cannot be signed.`,
    );
    const expectedVersion = ifVersion ?? r.version;
    if (r.version !== expectedVersion) {
      throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
    }
    if (!r.specVersionId || !r.isc) {
      throw new ConflictError(`HOPE assessment ${id} has no frozen spec version / ISC`);
    }
    return { r, specCode: loaded.specCode, expectedVersion };
  }

  async function ensureDraftSpecInitialized(
    tx: DbClient,
    organizationId: string,
    id: string,
  ): Promise<AssessmentRow> {
    const assessment = await loadA(tx, id);
    if (assessment.specVersionId && assessment.isc) return assessment;
    if (assessment.status !== "draft" || !isOfficialRfaKind(assessment.rfaKind)) {
      return assessment;
    }

    const init = await logSpecNotInForce(
      `assessment ${idForLog(id)} (org ${idForLog(organizationId)})`,
      () =>
        initializeNewHopeRecord(createHopeSpecRegistry(tx), {
          rfaKind: assessment.rfaKind,
          targetDate: assessment.targetDate,
        }),
    );
    const at = new Date();
    // Freezes the spec version and ISC without bumping `version` (it never has): the content an editor reviewed is not
    // changed, only the spec it is judged against is pinned.
    // The UPDATE takes the row lock, so it waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: the spec was not frozen by this step).
    // It judges the row it waited for: only a still-DRAFT row that still lacks its spec or ISC is written. `assessment`
    // above is an unlocked read, so a concurrent request may have frozen the spec, or signed the draft, since; the UPDATE
    // then matches no row, and this returns the row as it now stands WITHOUT writing derived control answers onto it.
    const [updated] = (await takeBoundedLock(
      tx,
      (statement) =>
        statement
          .update(ASSESS)
          .set({
            specVersionId: assessment.specVersionId ?? init.specVersionId,
            isc: assessment.isc ?? init.isc,
            updatedAt: at,
          })
          .where(
            and(
              eq(ASSESS.id, id),
              eq(ASSESS.organizationId, organizationId),
              eq(ASSESS.status, "draft"),
              or(isNull(ASSESS.specVersionId), isNull(ASSESS.isc)),
            ),
          )
          .returning(),
      {
        lock: `spec initialisation of assessment ${idForLog(id)} (org ${idForLog(organizationId)})`,
      },
    )) as AssessmentRow[];
    if (!updated) return loadA(tx, id);
    await answerWriter.writeDerivedControlAnswers(tx, {
      organizationId,
      providerEntityId: updated.providerEntityId,
      locationId: updated.locationId,
      hopeAssessmentId: updated.id,
      specVersionId: updated.specVersionId ?? init.specVersionId,
      controlAnswers: init.controlAnswers,
    });
    return updated;
  }

  async function loadA(t: DbClient, id: string): Promise<AssessmentRow> {
    const assessmentId = uuidOrNotFound(id, `HOPE assessment ${id} not found`);
    const [r] = (await t
      .select()
      .from(ASSESS)
      .where(eq(ASSESS.id, assessmentId))
      .limit(1)) as AssessmentRow[];
    if (!r) throw new NotFoundError(`HOPE assessment ${id} not found`);
    return r;
  }

  async function pendingLineageOperation(
    t: DbClient,
    sourceId: string,
  ): Promise<AssessmentRow | null> {
    const [row] = (await t
      .select()
      .from(ASSESS)
      .where(and(eq(ASSESS.correctsAssessmentId, sourceId), eq(ASSESS.status, "draft")))
      .limit(1)) as AssessmentRow[];
    return row ?? null;
  }

  /**
   * Refuse a second correction or inactivation of a record that already has one pending. The check and the insert that
   * follows it are serialised per source record by an advisory lock (taken here, before any row lock of the caller's
   * transaction), so two concurrent requests cannot both see "nothing pending" and both insert a draft. The caller takes
   * this BEFORE it reads the source record: the record is then judged (signed, not superseded) after the lock, on a read
   * that sees everything a request that held the lock before it committed. `sourceId` is the CANONICAL uuid text (the
   * callers answer 404 for an id that is none BEFORE this lock, whose key parses it as a uuid), and the lock keys on the
   * id as Postgres writes it (`lockRecordKey`).
   */
  async function assertNoPendingLineageOperation(
    t: DbClient,
    organizationId: string,
    sourceId: string,
  ): Promise<void> {
    await lockRecordKey(t, `m10:lineage:${organizationId}`, sourceId);
    const pending = await pendingLineageOperation(t, sourceId);
    if (pending) {
      throw new ConflictError(
        `HOPE assessment ${sourceId} already has a pending regulatory operation (${pending.id})`,
      );
    }
  }

  async function answerValueMap(t: DbClient, assessmentId: string): Promise<Map<string, unknown>> {
    const rows = await t
      .select({ itemCode: ITEM.itemCode, answer: ANSWER })
      .from(ANSWER)
      .innerJoin(ITEM, eq(ITEM.id, ANSWER.specItemId))
      .where(eq(ANSWER.hopeAssessmentId, assessmentId));
    return new Map(rows.map((row) => [row.itemCode, row.answer.value as unknown]));
  }

  async function assertCorrectionHasSubstantiveChange(t: DbClient, correction: AssessmentRow) {
    if (!correction.correctsAssessmentId || correction.isc === "XX") return;
    const [original] = (await t
      .select()
      .from(ASSESS)
      .where(eq(ASSESS.id, correction.correctsAssessmentId))
      .limit(1)) as AssessmentRow[];
    if (!original) throw new ConflictError("Correction source assessment is missing");
    if (original.status !== "signed") {
      throw new ConflictError("Correction source is no longer the current signed record");
    }
    const originalAnswers = await answerValueMap(t, original.id);
    const correctionAnswers = await answerValueMap(t, correction.id);
    const ignored = new Set(["A0050", "A0250", "Z0500B"]);
    const itemCodes = new Set([...originalAnswers.keys(), ...correctionAnswers.keys()]);
    for (const itemCode of itemCodes) {
      if (ignored.has(itemCode)) continue;
      if (
        JSON.stringify(originalAnswers.get(itemCode) ?? null) !==
        JSON.stringify(correctionAnswers.get(itemCode) ?? null)
      ) {
        return;
      }
    }
    throw new ValidationError("No substantive HOPE correction changes have been made", [
      {
        field: "assessment",
        code: "NO_REGULATORY_CHANGES",
        message: "No changes have been made to this correction.",
      },
    ]);
  }

  async function copyActiveAnswersForIsc(input: {
    readonly tx: DbClient;
    readonly organizationId: string;
    readonly source: AssessmentRow;
    readonly target: AssessmentRow;
    readonly isc: "HA" | "HUV" | "HD" | "XX";
    readonly at: Date;
  }) {
    const active = await input.tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(schema.hopeSpecItemIsc, eq(schema.hopeSpecItemIsc.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, input.target.specVersionId!),
          eq(schema.hopeSpecItemIsc.isc, input.isc),
          eq(schema.hopeSpecItemIsc.active, true),
        ),
      );
    const activeIds = new Set(active.map((row) => row.item.id));
    const sourceAnswers = await input.tx
      .select({ answer: ANSWER, itemCode: ITEM.itemCode })
      .from(ANSWER)
      .innerJoin(ITEM, eq(ITEM.id, ANSWER.specItemId))
      .where(eq(ANSWER.hopeAssessmentId, input.source.id));
    for (const row of sourceAnswers) {
      if (!activeIds.has(row.answer.specItemId)) continue;
      if (row.itemCode === "A0050" || row.itemCode === "A0250" || row.itemCode === "Z0500B")
        continue;
      await input.tx.insert(ANSWER).values({
        organizationId: input.organizationId,
        providerEntityId: input.target.providerEntityId,
        locationId: input.target.locationId,
        hopeAssessmentId: input.target.id,
        specVersionId: input.target.specVersionId!,
        specItemId: row.answer.specItemId,
        state: row.answer.state,
        value: row.answer.value,
        source: "correction_copy",
        sourceReference: { originalAssessmentId: input.source.id },
        answeredAt: input.at,
        answeredByMembershipId: null,
      });
    }
  }

  function submissionPackageName(
    providerEntityId: string,
    period: string,
    submissionId: string,
  ): string {
    return `HOPE_${providerEntityId}_${period}_${submissionId}.zip`.replace(
      /[^A-Za-z0-9_.-]/g,
      "_",
    );
  }

  function packageBytesFromReport(report: unknown): Buffer | null {
    const encoded =
      report && typeof report === "object"
        ? (report as { packageContentBase64?: unknown }).packageContentBase64
        : null;
    return typeof encoded === "string" ? Buffer.from(encoded, "base64") : null;
  }

  async function loadSubmissionDetail(
    t: DbClient,
    r: LightSubmissionRow,
  ): Promise<HopeSubmissionDetailView> {
    const items = await loadSubmissionItems(t, r.id);
    const count = (x: string) => items.filter((i) => i.resolution === x).length;
    return {
      ...toSubmissionView(r, {
        needs: count("needs_correction"),
        inProgress: count("correction_in_progress"),
        resubmitted: count("resubmitted"),
      }),
      resultImportedAt: iso(r.resultImportedAt ?? null),
      resultReportReference: reportReferenceOf(r),
      items,
      findings: await loadSubmissionFindings(t, r.id),
    };
  }

  return {
    // ── Timepoint-schedule reads (§2.2.1 window ledger) ────────────────────────────────────────────
    async listSchedules(organizationId, filter) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (filter.patientIds?.length === 0) return { schedules: [] };
        // Every predicate is the database's, so the patient timeline reads its own rows through
        // `idx_hope_sched_by_patient_open` and not the organisation's whole ledger (with its alert_cadence jsonb).
        if (filter.status && !isEnumMember(SCHED.status, filter.status)) return { schedules: [] };
        if (filter.rfaKind && !isEnumMember(SCHED.rfaKind, filter.rfaKind))
          return { schedules: [] };
        const rows = (await tx
          .select()
          .from(SCHED)
          .where(
            and(
              filter.patientIds ? inArray(SCHED.patientId, [...filter.patientIds]) : undefined,
              canonicalIdFilter(SCHED.patientId, filter.patientId),
              filter.status ? eq(SCHED.status, filter.status as ScheduleRow["status"]) : undefined,
              filter.rfaKind
                ? eq(SCHED.rfaKind, filter.rfaKind as ScheduleRow["rfaKind"])
                : undefined,
            ),
          )) as ScheduleRow[];
        return { schedules: rows.map(toScheduleView) };
      });
    },
    async getSchedule(organizationId, id) {
      const scheduleId = uuidOrNotFound(id, `HOPE schedule ${id} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select()
          .from(SCHED)
          .where(eq(SCHED.id, scheduleId))
          .limit(1)) as ScheduleRow[];
        if (!r) throw new NotFoundError(`HOPE schedule ${id} not found`);
        return toScheduleView(r);
      });
    },

    // ── HOPE assessment reads (parent of the partitioned hope_assessment) ──────────────────────────
    async getAssessment(organizationId, id) {
      const assessmentId = uuidOrNotFound(id, `HOPE assessment ${id} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select()
          .from(ASSESS)
          .where(eq(ASSESS.id, assessmentId))
          .limit(1)) as AssessmentRow[];
        if (!r) throw new NotFoundError(`HOPE assessment ${id} not found`);
        return toAssessmentView(r);
      });
    },
    async listPatientAssessments(organizationId, patientId) {
      // A patient id that is no uuid has no assessments (an org-wide role is not checked against a caseload, so nothing
      // upstream has looked at it): an empty list, not a `::uuid` cast.
      const patient = canonicalUuidOrNull(patientId);
      if (patient === null) return { assessments: [] };
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select()
          .from(ASSESS)
          .where(eq(ASSESS.patientId, patient))) as AssessmentRow[];
        return { assessments: rows.map(toAssessmentView) };
      });
    },

    // ── SFV worklist reads (§2.2.3) ────────────────────────────────────────────────────────────────
    async listSfv(organizationId, state, patientIds, triggeringAssessmentId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (patientIds?.length === 0) return { sfvs: [] };
        if (state && !isEnumMember(SFV.status, state)) return { sfvs: [] };
        const rows = (await tx
          .select()
          .from(SFV)
          .where(
            and(
              canonicalIdFilter(SFV.triggeringAssessmentId, triggeringAssessmentId),
              state ? eq(SFV.status, state as SfvRow["status"]) : undefined,
              patientIds ? inArray(SFV.patientId, [...patientIds]) : undefined,
            ),
          )) as SfvRow[];
        return { sfvs: rows.map(toSfvView) };
      });
    },
    async getSfv(organizationId, id) {
      const sfvId = uuidOrNotFound(id, `SFV ${id} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx.select().from(SFV).where(eq(SFV.id, sfvId)).limit(1)) as SfvRow[];
        if (!r) throw new NotFoundError(`SFV ${id} not found`);
        return toSfvView(r);
      });
    },

    // ── Pre-submission validation findings (§3.3 hope_validation_finding) ───────────────────────────
    async getValidation(organizationId, urlId, options) {
      if (options?.submissionDate !== undefined) {
        requireCalendarDateTime(options.submissionDate, "submissionDate");
      }
      const assessmentId = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      return validationService.validateAssessment({
        organizationId,
        assessmentId,
        mode: options?.mode ?? "final",
        submissionDate: options?.submissionDate,
      });
    },

    // ── iQIES submission reads (§2.2.4) ────────────────────────────────────────────────────────────
    async listSubmissions(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const scoped = (await tx
          .select(LIGHT_SUB)
          .from(SUB)
          .where(
            canonicalIdFilter(SUB.providerEntityId, providerEntityId),
          )) as LightSubmissionRow[];
        const resolutions = await resolutionCountsByBatch(
          tx as unknown as DbClient,
          scoped.filter((r) => r.rejectedCount > 0).map((r) => r.id),
        );
        return { submissions: scoped.map((r) => toSubmissionView(r, resolutions.get(r.id))) };
      });
    },
    async getSubmission(organizationId, id) {
      const submissionId = uuidOrNotFound(id, `HOPE submission ${id} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select(LIGHT_SUB)
          .from(SUB)
          .where(eq(SUB.id, submissionId))
          .limit(1)) as LightSubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        return loadSubmissionDetail(tx as unknown as DbClient, r);
      });
    },
    async listAssessmentSubmissions(organizationId, urlAssessmentId) {
      const assessmentId = uuidOrNotFound(
        urlAssessmentId,
        `HOPE assessment ${urlAssessmentId} not found`,
      );
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadA(t, assessmentId);
        const rows = await t
          .select({ item: { itemStatus: SUBITEM.itemStatus }, sub: LIGHT_SUB_COLUMNS })
          .from(SUBITEM)
          .innerJoin(SUB, eq(SUB.id, SUBITEM.hopeSubmissionId))
          .where(eq(SUBITEM.hopeAssessmentId, assessmentId))
          .orderBy(desc(SUBITEM.createdAt));
        return {
          submissions: rows.map(({ item, sub }) => ({
            submissionId: sub.id,
            status: sub.status as HopeSubmissionView["status"],
            itemStatus: item.itemStatus as HopeSubmissionDetailView["items"][number]["status"],
            packageFilename: (sub as { packageFilename?: string | null }).packageFilename ?? null,
            submittedAt: iso((sub as { submittedAt?: Date | null }).submittedAt ?? null),
            resultImportedAt: iso(sub.resultImportedAt ?? null),
          })),
        };
      });
    },

    // ── Compliance dashboard (§7 — mirrors the in-mem rate math over the RLS-scoped org rows) ────────
    async complianceDashboard(organizationId, providerEntityId): Promise<HopeComplianceView> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // One provider entity named: every read is narrowed to it IN SQL. The schedule and SFV rates used to be
        // org-wide under a response labelled with the entity, so a caller scoped to one CCN read counts from the others.
        // Counts, not rows: each table answers `group by status`, so the dashboard never ships the ledger.
        const sched = countsByStatus(
          await tx
            .select({ status: SCHED.status, n: count() })
            .from(SCHED)
            .where(canonicalIdFilter(SCHED.providerEntityId, providerEntityId))
            .groupBy(SCHED.status),
        );
        const completed = sched.get("completed") ?? 0;
        const expired = sched.get("expired") ?? 0;
        const denom = completed + expired;
        const sfv = countsByStatus(
          await tx
            .select({ status: SFV.status, n: count() })
            .from(SFV)
            .where(canonicalIdFilter(SFV.providerEntityId, providerEntityId))
            .groupBy(SFV.status),
        );
        const sfvOnTime = sfv.get("completed") ?? 0;
        const sfvDenom = sfvOnTime + (sfv.get("missed") ?? 0);
        const subs = countsByStatus(
          await tx
            .select({ status: SUB.status, n: count() })
            .from(SUB)
            .where(canonicalIdFilter(SUB.providerEntityId, providerEntityId))
            .groupBy(SUB.status),
        );
        // F-058 (#150) — the acceptance-rate DENOMINATOR is the terminal batches only.
        //
        // It used to be every submission of any status, which read as 0% acceptance for an agency whose
        // batches are merely queued. That was latent while nothing created a batch with anything in it;
        // it becomes live the moment force-assemble does real work, and 0% is the §1.3 APU-penalty band
        // — the worst possible reading to hand a compliance officer for "assembled, not yet sent". A
        // `queued` or `in_flight` batch has no acceptance outcome, so it belongs in neither half of the
        // ratio. M30's `submissionBatches` rollup reads the same list (`ANSWERED_BATCH_STATUSES`).
        const countOf = (statuses: readonly string[]) =>
          statuses.reduce((total, status) => total + (subs.get(status) ?? 0), 0);
        const terminalTotal = countOf(ANSWERED_BATCH_STATUSES);
        // A batch iQIES accepted with CMS warnings is accepted (the batch's `accepted_count` counts its warning items).
        const accepted = countOf(ACCEPTED_BATCH_STATUSES);
        return {
          // The id as Postgres writes it (as `regenerateSchedules` answers), not the caller's spelling.
          providerEntityId:
            providerEntityId === undefined
              ? null
              : (canonicalUuidOrNull(providerEntityId) ?? providerEntityId),
          hopeOnTimeRate: rateOf(completed, denom),
          hopeOnTimeCounts: { onTime: completed, total: denom },
          sfvOnTimeRate: rateOf(sfvOnTime, sfvDenom),
          sfvOnTimeCounts: { onTime: sfvOnTime, total: sfvDenom },
          submissionAcceptanceRate: rateOf(accepted, terminalTotal),
          submissionAcceptanceCounts: { accepted, total: terminalTotal },
        };
      });
    },
    async getWorkflowState(organizationId, urlAdmissionId): Promise<HopeWorkflowStateView> {
      // The id as Postgres writes it (as `regenerateSchedules` and the dashboard answer), never the caller's spelling; an id
      // that is no uuid names no admission (404, before the M6 seam or any statement).
      const admissionId = uuidOrNotFound(urlAdmissionId, `Admission ${urlAdmissionId} not found`);
      let admission: {
        patientId?: string | null;
        status?: string | null;
        admissionAt?: string | null;
        activatedAt?: string | null;
        dischargedAt?: string | null;
      } | null = null;
      try {
        const summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(
          organizationId,
          admissionId,
        );
        if (summary.organizationId === organizationId) {
          admission = {
            patientId: summary.patientId,
            status: summary.status,
            admissionAt: summary.admissionAt,
            activatedAt: summary.activatedAt,
            dischargedAt: summary.dischargedAt,
          };
        }
      } catch (error) {
        // The workflow state is answered without the admission rather than refused; say why it is incomplete.
        console.warn(
          `m10: the M6 admission seam threw ${errorClassForLog(error)} reading admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}) for its workflow state.`,
        );
        admission = null;
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const schedRows = (await tx
          .select()
          .from(SCHED)
          .where(eq(SCHED.admissionId, admissionId))) as ScheduleRow[];
        const assessmentRows = (await tx
          .select()
          .from(ASSESS)
          .where(eq(ASSESS.admissionId, admissionId))) as AssessmentRow[];
        // The URL admission's own SFVs, not the patient's across every admission. A re-admitted
        // patient has one admission per episode, and an SFV of another one is not completable through this
        // one (the R-01 binding refuses it), so listing it here would hand the capture workspace a dead end.
        const sfvRows = (await tx
          .select()
          .from(SFV)
          .where(eq(SFV.admissionId, admissionId))) as SfvRow[];
        return buildWorkflowState({
          admissionId,
          nowIso: new Date().toISOString(),
          schedules: schedRows.map(toScheduleView),
          assessments: assessmentRows.map(toAssessmentView),
          sfvs: sfvRows.map(toSfvView),
          admission,
        });
      });
    },

    // ── §4.1 route 20 — admin regenerate: materialize every window the admission is entitled to ──────
    //
    // #48 — this used to be a COUNT, documented in place as "regeneration itself is a write, deferred".
    // It was the only route whose name promised the write path nothing in the repo performed, so an
    // operator looking at an empty timepoint worklist had a button that reported the emptiness back to
    // them. It now regenerates, idempotently, which is also the supported way to backfill an admission
    // activated before the scheduling consumer shipped. The returned count is the total AFTER the write.
    async regenerateSchedules(organizationId, urlAdmissionId) {
      // The id as Postgres writes it (never the body's spelling); an id that is no uuid names no admission (404, before the
      // M6 seam or any statement).
      const admissionId = uuidOrNotFound(urlAdmissionId, `Admission ${urlAdmissionId} not found`);
      await regenerateSchedulesForAdmission(db, outbox, { organizationId, admissionId });
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // A count, not the rows: only the total is answered.
        const [total] = await tx
          .select({ n: count() })
          .from(SCHED)
          .where(and(eq(SCHED.admissionId, admissionId), eq(SCHED.organizationId, organizationId)));
        return { admissionId, scheduleCount: total?.n ?? 0 };
      });
    },

    // ── §4.7 / GAP-018 ABAC resolver — correction + scope predicate facts (fail-closed on absent) ─────
    // The four loaders answer "absent" (null: `hope.scope` and the correction predicate fail closed) for an id that is no
    // uuid, without sending it to a `::uuid` comparison: a 22P02 here would be a 500 out of the authorization step.
    async loadAssessment(organizationId, assessmentId): Promise<HopeAssessmentAbacFacts | null> {
      const id = canonicalUuidOrNull(assessmentId);
      if (id === null) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({
            patientId: ASSESS.patientId,
            signedByMembershipId: ASSESS.signedByMembershipId,
            rfaKind: ASSESS.rfaKind,
            authorDiscipline: ASSESS.authorDiscipline,
          })
          .from(ASSESS)
          .where(and(eq(ASSESS.id, id), eq(ASSESS.organizationId, organizationId)))
          .limit(1)) as {
          patientId: string;
          signedByMembershipId: string | null;
          rfaKind: string;
          authorDiscipline: string | null;
        }[];
        if (!r) return null; // absent / cross-tenant → deny
        return {
          patientId: r.patientId,
          originalSignedBy: r.signedByMembershipId ?? null,
          rfaKind: r.rfaKind,
          authorDiscipline: r.authorDiscipline,
        };
      });
    },
    async loadSchedule(organizationId, scheduleId) {
      const id = canonicalUuidOrNull(scheduleId);
      if (id === null) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ patientId: SCHED.patientId })
          .from(SCHED)
          .where(and(eq(SCHED.id, id), eq(SCHED.organizationId, organizationId)))
          .limit(1)) as { patientId: string }[];
        return r ? { patientId: r.patientId } : null;
      });
    },
    async loadSfv(organizationId, sfvId) {
      const id = canonicalUuidOrNull(sfvId);
      if (id === null) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ patientId: SFV.patientId })
          .from(SFV)
          .where(and(eq(SFV.id, id), eq(SFV.organizationId, organizationId)))
          .limit(1)) as { patientId: string }[];
        return r ? { patientId: r.patientId } : null;
      });
    },
    async loadSubmission(organizationId, submissionId) {
      const id = canonicalUuidOrNull(submissionId);
      if (id === null) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ providerEntityId: SUB.providerEntityId })
          .from(SUB)
          .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
          .limit(1)) as { providerEntityId: string }[];
        return r ? { providerEntityId: r.providerEntityId } : null;
      });
    },

    // ── Schedule skip (§2.2.1) ────────────────────────────────────────────────────────────────────
    async skipSchedule(organizationId, id, reasonCode) {
      // A closed code list (the route's schema is the first gate; a caller that reaches the service another way is judged here too).
      const skipReasonCode = requireSkipReasonCode(reasonCode);
      const scheduleId = uuidOrNotFound(id, `HOPE schedule ${id} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Only an OPEN schedule can be skipped (spec §2.2.1). The UPDATE judges the row it waits for: a sign that closes the
        // schedule (`trg_hope_schedule_mark_completed`) between a read and this write would otherwise be overwritten with
        // 'skipped', and an already completed / expired schedule would be rewritten. It queues behind that sign's row lock,
        // so it waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: the skip was not applied).
        const rows = (await takeBoundedLock(
          t,
          (statement) =>
            statement
              .update(SCHED)
              .set({
                status: "skipped",
                skipReasonCode,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(SCHED.id, scheduleId),
                  eq(SCHED.organizationId, organizationId),
                  eq(SCHED.status, "open"),
                ),
              )
              .returning(),
          {
            lock: `schedule row ${idForLog(scheduleId)} (org ${idForLog(organizationId)}) for a skip`,
          },
        )) as ScheduleRow[];
        if (rows.length > 0)
          return toScheduleView(firstOrThrow(rows, "schedule skip matched no row"));
        const [current] = await t
          .select({ status: SCHED.status })
          .from(SCHED)
          .where(and(eq(SCHED.id, scheduleId), eq(SCHED.organizationId, organizationId)))
          .limit(1);
        if (!current) throw new NotFoundError(`HOPE schedule ${id} not found`);
        throw new ConflictError(
          `HOPE schedule ${id} is ${current.status}; only an open schedule can be skipped`,
        );
      });
    },

    // ── Record a draft timepoint (§2.2.1 — linked to its open schedule if one exists) ───────────────
    async recordTimepoint(organizationId, userId, urlAdmissionId, args: RecordTimepointArgs) {
      // A date that does not exist is refused, never rolled forward (Apr 31 would otherwise be stored, and gated, as May 1).
      requireCalendarTargetDate(args.targetDate);
      // An RFA-04 SFV is completed through `recordSfv` (it is inserted signed, against an open SFV obligation), not
      // recorded as a draft timepoint: it has no official CMS initialisation, so letting it through answered a 500.
      if (args.rfaKind === "04_sfv") {
        throw new ValidationError(
          "An SFV completion is recorded with POST /admissions/{admissionId}/hope/sfv, not as a timepoint.",
          [
            {
              field: "rfaKind",
              code: "M10_RFA_KIND_NOT_A_TIMEPOINT",
              message: "rfaKind 04_sfv is completed through the SFV route.",
            },
          ],
        );
      }
      // The admission as Postgres writes it (the M6 seam read, the schedule and draft lookups and the advisory key all take
      // that text), and a 404 for an id that is no uuid, before the seam or any statement.
      const admissionId = uuidOrNotFound(urlAdmissionId, `Admission ${urlAdmissionId} not found`);
      // The M6 seam opens its own connection, so it is read BEFORE the transaction opens (inside it, this request would hold
      // one pool connection while waiting for a second: the self-starvation `signTimepoint` and the workspace read avoid the
      // same way). A seam that throws, or answers another tenant's admission (404), refuses exactly as it did inside.
      const admissionSummary =
        args.rfaKind === "01_admission" ||
        args.rfaKind === "02_huv1" ||
        args.rfaKind === "03_huv2" ||
        args.rfaKind === "05_discharge"
          ? await getSeam("AdmissionStatusReader").getAdmissionSummary(organizationId, admissionId)
          : null;
      if (admissionSummary && admissionSummary.organizationId !== organizationId) {
        throw new NotFoundError(`Admission ${admissionId} not found`);
      }
      const view = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const regulatoryTargetDate =
          args.rfaKind === "01_admission"
            ? (admissionSummary?.admissionAt ?? args.targetDate)
            : args.rfaKind === "05_discharge"
              ? (admissionSummary?.dischargedAt ?? args.targetDate)
              : args.targetDate;
        const init = await logSpecNotInForce(
          `a new ${args.rfaKind} record on admission ${idForLog(admissionId)} (org ${idForLog(organizationId)})`,
          () =>
            initializeNewHopeRecord(createHopeSpecRegistry(t), {
              rfaKind: args.rfaKind,
              targetDate: args.targetDate,
            }),
        );
        // The window ledger row this capture is gated against (#48, restored from the lost Aug 25–30
        // history). When the caller names the `scheduleId` it is completing, that row is loaded and
        // `assertRfaMatchesSchedule` is a real check; otherwise the row is resolved by `rfa_kind`.
        // `open` first, but ANY status is returned: looking only at `open` made an EXPIRED window
        // indistinguishable from an unscheduled one — the case `M10_TIMEPOINT_EXPIRED` exists for.
        const [sched] = (await t
          .select()
          .from(SCHED)
          .where(
            args.scheduleId
              ? and(eq(SCHED.id, args.scheduleId), eq(SCHED.admissionId, admissionId))
              : and(eq(SCHED.admissionId, admissionId), eq(SCHED.rfaKind, args.rfaKind)),
          )
          .orderBy(sql`CASE WHEN ${SCHED.status} = 'open' THEN 0 ELSE 1 END`, desc(SCHED.createdAt))
          .limit(1)) as ScheduleRow[];
        // A named schedule that does not resolve is a 404, never a silent fall-through to ungated capture.
        if (args.scheduleId && !sched) {
          throw new NotFoundError(
            `HOPE schedule ${args.scheduleId} not found on admission ${admissionId}`,
          );
        }
        if (
          args.rfaKind === "01_admission" ||
          args.rfaKind === "02_huv1" ||
          args.rfaKind === "03_huv2" ||
          args.rfaKind === "05_discharge"
        ) {
          // One draft per admission and RFA: the existing-draft read and the insert below are serialised per
          // (admission, RFA) by an advisory lock, so two concurrent records converge on one draft instead of each
          // inserting its own (no row exists yet for a row lock to hold).
          // The admission id is the canonical text, and `lockRecordKey` parses it as a uuid again: a differently cased or
          // braced spelling is the same admission and must take the same lock.
          await lockRecordKey(t, `m10:record:${organizationId}`, admissionId, `:${args.rfaKind}`);
          const [existingDraft] = (await t
            .select()
            .from(ASSESS)
            .where(
              and(
                eq(ASSESS.admissionId, admissionId),
                eq(ASSESS.rfaKind, args.rfaKind),
                eq(ASSESS.status, "draft"),
              ),
            )
            .orderBy(desc(ASSESS.createdAt))
            .limit(1)) as AssessmentRow[];
          if (existingDraft) {
            const normalized = await ensureDraftSpecInitialized(
              t,
              organizationId,
              existingDraft.id,
            );

            await admissionPrefillService.prefillAdmission({
              tx: t,
              organizationId,
              assessment: normalized,
              specVersionCode: init.specVersionCode,
              admissionDate: (admissionSummary?.admissionAt ?? regulatoryTargetDate).slice(0, 10),
            });

            return toAssessmentView(normalized);
          }
        }
        let capture: CaptureDecision = { wasLate: false, lateReasonCode: null };
        let overrideLifted = false;
        if (sched) {
          assertRfaMatchesSchedule(args.rfaKind, {
            rfaKind: sched.rfaKind,
            generatedBy: sched.generatedBy,
          });
          const nowIso = clock().toISOString();
          capture = assertCaptureAllowed(
            args.targetDate,
            {
              windowOpensAt: sched.windowOpensAt.toISOString(),
              windowClosesAt: sched.windowClosesAt.toISOString(),
              lateDeadlineAt: sched.lateDeadlineAt.toISOString(),
            },
            {
              lateReasonCode: args.lateCompletionReasonCode,
              adminOverride: args.adminOverride,
              nowIso,
            },
          );
          overrideLifted =
            args.adminOverride === true &&
            Date.parse(captureInstantOf(args.targetDate, nowIso)) > sched.lateDeadlineAt.getTime();
        }
        // The record's subject is never guessed: the M6 summary's patient, else the schedule row's, else a refusal. The
        // admission id used to stand in for a patient here, which wrote a chart that belonged to nobody.
        const patientId = admissionSummary?.patientId ?? sched?.patientId;
        if (!patientId) {
          console.warn(
            `m10: a new ${args.rfaKind} record was refused: the M6 admission seam returned no patient for admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}) and no schedule row names one.`,
          );
          throw new HopeStateError(
            "M10_ADMISSION_PROJECTION_GAP",
            timepointProjectionGapMessage(admissionId),
          );
        }
        const row = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId,
              admissionId,
              // Only an OPEN window is linked: `trg_hope_schedule_mark_completed` closes the linked
              // schedule on sign and its own WHERE is `status = 'open'`.
              scheduleId: sched?.status === "open" ? sched.id : null,
              rfaKind: args.rfaKind,
              specVersionId: init.specVersionId,
              isc: init.isc,
              status: "draft",
              data: args.data,
              authorDiscipline: args.authorDiscipline as AssessmentRow["authorDiscipline"],
              providerEntityId: admissionSummary?.providerEntityId ?? null,
              locationId: admissionSummary?.locationId ?? null,
              dischargeReason: args.dischargeReason as AssessmentRow["dischargeReason"],
              targetDate: new Date(args.targetDate),
              sourceEncounterId: args.sourceEncounterId ?? null,
              wasLate: capture.wasLate,
              lateCompletionReasonCode: capture.lateReasonCode,
              createdByMembershipId: userId,
            })
            .returning(),
          "hope_assessment insert returned no row",
        );
        if (overrideLifted) {
          await auditDeadlineOverride(
            t,
            organizationId,
            userId,
            { kind: "hope_assessment", id: row.id },
            {
              rfaKind: args.rfaKind,
              scheduleId: sched?.id ?? null,
              targetDate: args.targetDate,
              justification: args.adminOverrideJustification ?? null,
            },
            args.request,
          );
        }
        await answerWriter.writeDerivedControlAnswers(t, {
          organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          hopeAssessmentId: row.id,
          specVersionId: init.specVersionId,
          controlAnswers: init.controlAnswers,
        });
        if (
          row.rfaKind === "01_admission" ||
          row.rfaKind === "02_huv1" ||
          row.rfaKind === "03_huv2" ||
          row.rfaKind === "05_discharge"
        ) {
          await admissionPrefillService.prefillAdmission({
            tx: t,
            organizationId,
            assessment: row,
            specVersionCode: init.specVersionCode,
            admissionDate: (admissionSummary?.admissionAt ?? regulatoryTargetDate).slice(0, 10),
          });
        }
        if (row.rfaKind === "05_discharge") {
          await dischargePrefillService.prefillDischarge({
            tx: t,
            organizationId,
            assessment: row,
            dischargeDate: regulatoryTargetDate.slice(0, 10),
            dischargeReason: args.dischargeReason ?? null,
          });
        }
        return toAssessmentView(row);
      });
      if (
        (view.rfaKind === "01_admission" && view.regulatory.isc === "HA") ||
        ((view.rfaKind === "02_huv1" || view.rfaKind === "03_huv2") &&
          view.regulatory.isc === "HUV") ||
        (view.rfaKind === "05_discharge" && view.regulatory.isc === "HD")
      ) {
        await validationService.validateAssessment({
          organizationId,
          assessmentId: view.id,
          mode: "draft",
        });
      }
      return view;
    },

    // ── Record an RFA-04 SFV completion (§2.2.3) — see ./hope-sfv-completion-record.ts ──────────────────
    recordSfv: createSfvCompletionRecorder({
      db,
      clock,
      emit,
      auditDeadlineOverride,
      toView: toAssessmentView,
    }),

    // ── Update a draft's payload (§2.2.2 — draft only) ───────────────────────────────────────────────
    async updateDraft(organizationId, id, data) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // The assessment row FIRST (M10's lock order), and the draft judged on the locked row: a sign that committed since an
        // unlocked read would otherwise leave this write rewriting a SIGNED record (an UPDATE without a status or version
        // predicate re-evaluates its WHERE on the new row version and still matches). The merge happens in the UPDATE, on
        // the locked row's own `data`, so no stale copy of the payload is merged back.
        // (`lockAssessmentRow` answers "absent", with no statement, for an id that is no uuid.)
        const locked = await lockAssessmentRow(t, organizationId, id);
        if (!locked) throw new NotFoundError(`HOPE assessment ${id} not found`);
        require_(
          locked.status === "draft",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${locked.id} is not a draft.`,
        );
        const rows = (await t
          .update(ASSESS)
          .set({
            data: sql`${ASSESS.data} || ${JSON.stringify(data)}::jsonb`,
            version: locked.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ASSESS.id, locked.id),
              eq(ASSESS.organizationId, organizationId),
              eq(ASSESS.status, "draft"),
              eq(ASSESS.version, locked.version),
            ),
          )
          .returning()) as AssessmentRow[];
        return toAssessmentView(firstOrThrow(rows, "updateDraft matched no row"));
      });
    },

    async getAssessmentWorkspace(organizationId, urlId, options) {
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      // Spec initialisation (an assessment UPDATE for a legacy spec-less draft) commits in its OWN transaction first, as
      // review and sign do: the prefill below makes seam calls on their own pooled connections, and left in the same
      // transaction the UPDATE's row lock and connection would be held across them (a bounded self-starvation on a
      // draft's first open).
      const assessment = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        ensureDraftSpecInitialized(tx as unknown as DbClient, organizationId, id),
      );
      // The chart refresh REWRITES draft answers (and bumps `version` when it changes one), so it is a write: only a caller
      // holding `hope.timepoint.write` runs it. A read-only caller (an auditor included) is shown the stored state.
      if (options?.mayWrite !== false) {
        await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
          refreshChartPrefill(tx as unknown as DbClient, organizationId, assessment),
        );
      }
      return answerService.getWorkspace(organizationId, id);
    },

    async getAssessmentReview(organizationId, urlId, options) {
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      // Spec initialisation (an assessment UPDATE, then control answers) commits in its OWN transaction first, as
      // `signTimepoint` does with `pre`: left in the heal's transaction it would take the assessment row before the heal
      // takes the SFV row, the reverse of M10's lock order (SFV, assessment, answers).
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        ensureDraftSpecInitialized(tx as unknown as DbClient, organizationId, id),
      );
      // The self-heal writes draft answers, so only a caller holding `hope.timepoint.write` runs it; a read-only caller
      // reads the stored state (the next writer to open the review repairs it). Spec initialisation above stays: a review
      // of a spec-less legacy draft is a 409 without it.
      if (options?.mayWrite === false)
        return readinessService.getReview({ organizationId, assessmentId: id });
      const healed = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        reconcileCompletedSfvRegulatoryAnswers(tx as unknown as DbClient, organizationId, id),
      );
      // A read path reports rather than refuses, so an SFV that was completed but whose J2052/J2053 answers cannot be
      // rebuilt would otherwise only show as required items missing, with nothing saying why.
      if (!healed.repaired && healed.reason && !EXPECTED_SFV_HEAL_REASONS.has(healed.reason)) {
        console.warn(
          `m10: the completed SFV's regulatory answers of assessment ${idForLog(id)} (org ${idForLog(organizationId)}) were not repaired: ${healed.reason}.`,
        );
      }
      return readinessService.getReview({ organizationId, assessmentId: id });
    },

    async patchAssessmentAnswers(organizationId, userId, urlId, input) {
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      const result = await answerService.patchAnswers(organizationId, userId, id, input);
      await validateDraftAfterWrite(
        () =>
          validationService.validateAssessment({ organizationId, assessmentId: id, mode: "draft" }),
        organizationId,
        id,
      );
      return result;
    },

    async setHuvCompletionDate(organizationId, userId, urlId, input) {
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      const result = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadA(t, id);
        if ((r.rfaKind !== "02_huv1" && r.rfaKind !== "03_huv2") || r.isc !== "HUV") {
          throw new ConflictError(`HOPE assessment ${id} is not a HUV record`);
        }
        require_(
          r.status === "draft",
          "M10_ASSESSMENT_IMMUTABLE",
          `Assessment ${id} is not a draft.`,
        );
        if (r.version !== input.ifVersion) {
          throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
        }
        // The assessment row BEFORE the answer write (it is UPDATEd below): M10's lock order is SFV, assessment,
        // answers, and this path used to write the answer first. Status and version are judged again on the locked row.
        const locked = await lockAssessmentRow(t, organizationId, id);
        if (locked?.status !== "draft" || locked.version !== input.ifVersion) {
          throw new ConflictError(
            `HOPE assessment ${id} is no longer the draft you loaded; reload and retry`,
          );
        }
        const at = new Date();
        const answer = await answerService.setWorkflowAnswer(t, {
          organizationId,
          membershipId: userId,
          assessment: r,
          itemCode: "Z0350",
          value: input.z0350,
          sourceReference: { reason: "huv_completion_date_workflow" },
          at,
        });
        const [updated] = (await t
          .update(ASSESS)
          .set({
            targetDate: new Date(`${input.z0350}T00:00:00.000Z`),
            version: r.version + 1,
            updatedAt: at,
          })
          .where(
            and(
              eq(ASSESS.id, id),
              eq(ASSESS.organizationId, organizationId),
              eq(ASSESS.version, input.ifVersion),
            ),
          )
          .returning({ version: ASSESS.version })) as { version: number }[];
        if (!updated)
          throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
        return {
          assessmentId: r.id, // the stored id, not the URL's spelling of it
          version: updated.version,
          answers: [answer],
        };
      });
      await validateDraftAfterWrite(
        () =>
          validationService.validateAssessment({ organizationId, assessmentId: id, mode: "draft" }),
        organizationId,
        id,
      );
      return result;
    },

    // ── Sign a draft (§2.2.2 / Phase 3C — final validation + Z0500B candidate, then immutable) ─
    async signTimepoint(organizationId, userId, urlId, args): Promise<HopeSignResult> {
      // R-05: the service itself refuses an unattested signature (not only the route's schema).
      const attestationConfirmed = args?.attestationConfirmed;
      requireAttestation(attestationConfirmed, args?.attestationVersion);
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      // GAP-019 — the D8 clinical-context snapshot and the siting the compensating finding needs both
      // come from OTHER modules' seams, each of which opens its own tenant context. They are resolved
      // here, before the write transaction, and the assessment is re-read inside it so the draft guard
      // and the UPDATE still see one consistent row.
      const pre = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        ensureDraftSpecInitialized(tx as unknown as DbClient, organizationId, id),
      );
      const snapshot = pre.status === "draft" ? await d8Snapshot(pre.patientId) : null;
      // A snapshot with no PPS reading is the case §D8 names: "if no PPS is on file at the time of
      // signing, the validator emits a warning-severity finding (not blocking)". An ABSENT snapshot
      // (M9 unreachable) is the same compliance gap from the reviewer's side, so both take the finding.
      const ppsMissing = pre.status === "draft" && (snapshot === null || snapshot.pps === null);
      const siting = ppsMissing
        ? await admissionSiting(organizationId, pre.patientId, pre.admissionId)
        : null;

      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const { r, specCode, expectedVersion } = await lockDraftForSign(
          t,
          organizationId,
          id,
          args?.ifVersion,
        );
        await assertCorrectionHasSubstantiveChange(t, r);
        const at = new Date();
        const z0500b = at.toISOString().slice(0, 10);
        const review = await readinessService.evaluateCandidateInTx(t, {
          assessment: r,
          specVersionCode: specCode,
          isc: r.isc as "HA" | "HUV" | "HD" | "XX",
          candidateZ0500B: z0500b,
        });
        if (!review.readiness.readyToSign) throw new HopeAssessmentNotReadyToSignError(review);
        await writeZ0500B(t, r, organizationId, z0500b, at);
        // The AFTER-UPDATE `trg_hope_schedule_mark_completed` closes the linked open schedule on draft→signed.
        const signed = firstOrThrow(
          await t
            .update(ASSESS)
            .set({
              status: "signed",
              signedAt: at,
              signedByMembershipId: userId,
              // D8 (GAP-019) — the PPS/ESAS-r context as of the signature. `null` only when M9 could
              // not answer at all; a resolved snapshot with a null PPS is still recorded, because
              // "we looked and there was none" is a different fact from "we never looked".
              clinicalContextSnapshot: snapshot,
              j2051MaxSeverity: r.j2051MaxSeverity,
              j2051TriggerFired: r.j2051TriggerFired,
              version: r.version + 1,
              updatedAt: at,
            })
            .where(
              and(
                eq(ASSESS.id, id),
                eq(ASSESS.organizationId, organizationId),
                eq(ASSESS.version, expectedVersion),
              ),
            )
            .returning(),
          "signTimepoint matched no row",
        );
        // R-05: the signature ceremony's own evidence, on the same tx as the signed row (the M4 trigger only
        // records the row diff, not that the signer attested or which step-up the route demanded).
        await auditHopeSignature(t, {
          organizationId,
          membershipId: userId,
          eventType: "hope.timepoint_signed",
          // The ROW's id, not the URL's: the audit resource id and correlation id must be the stored id
          // however the caller cased or formatted the path parameter, so a lookup by either one finds it.
          assessmentId: signed.id,
          rfaKind: r.rfaKind,
          version: signed.version,
          stepUpRequiredOperation: HOPE_SIGN_STEP_UP_OPERATION,
          attestationConfirmed,
          attestationVersion: args?.attestationVersion,
          ...args?.request,
        });
        await recordSignedTail(
          t,
          {
            organizationId,
            membershipId: userId,
            draft: r,
            signed,
            at,
            ppsMissing,
            snapshotTaken: snapshot !== null,
            siting,
            admissionId: pre.admissionId,
          },
          emit,
        );
        return {
          assessmentId: signed.id,
          status: "signed",
          version: signed.version,
          signedAt: at.toISOString(),
          signedByMembershipId: userId,
          z0500b,
          validation: {
            errorCount: review.validation.errorCount,
            warningCount: review.validation.warningCount,
            hasBlockingErrors: review.validation.hasBlockingErrors,
          },
        };
      });
    },

    // ── Correct a signed timepoint (§2.4 / D7 — append-only; signing supersedes the original) ─
    async correctTimepoint(organizationId, userId, urlId, args: CorrectTimepointArgs) {
      // Before the advisory key below, which parses the id as a uuid (22P02 for one that is none).
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // The advisory lock and the pending check FIRST, then the source is read and judged: a correction that signed
        // (and superseded the source) before this request got the lock is seen by that read, so a second correction can
        // never be inserted against a record that is no longer current.
        await assertNoPendingLineageOperation(t, organizationId, id);
        const original = await loadA(t, id);
        require_(
          original.status === "signed",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${id} must be signed to correct (edit the draft instead).`,
        );
        require_(
          original.supersededById == null,
          "M10_CORRECTION_TARGET_SUPERSEDED",
          `Assessment ${id} is already superseded; correct the latest instead.`,
        );
        if (args.ifVersion != null && original.version !== args.ifVersion) {
          throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
        }
        const at = new Date();
        const init = await initializeHopeCorrection(createHopeSpecRegistry(t), {
          id: original.id,
          rfaKind: original.rfaKind as HopeRfaKind,
          specVersionId: original.specVersionId,
        });
        const correction = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: original.patientId,
              admissionId: original.admissionId,
              rfaKind: original.rfaKind,
              specVersionId: init.specVersionId,
              isc: init.isc,
              status: "draft",
              data: args.data,
              authorDiscipline: args.authorDiscipline as AssessmentRow["authorDiscipline"],
              // The composite self-FK forces the correction to REUSE the original's target_date.
              targetDate: original.targetDate,
              j2051MaxSeverity: original.j2051MaxSeverity,
              j2051TriggerFired: original.j2051TriggerFired,
              wasLate: original.wasLate,
              clinicalContextSnapshot: original.clinicalContextSnapshot,
              // F-058 — copied, never re-resolved: the CCN a correction is submitted under is the one
              // the ORIGINAL was captured under.
              providerEntityId: original.providerEntityId,
              locationId: original.locationId,
              signedAt: null,
              signedByMembershipId: null,
              createdByMembershipId: userId,
              correctsAssessmentId: id,
            })
            .returning(),
          "hope_assessment (correction) insert returned no row",
        );
        await answerWriter.writeDerivedControlAnswers(t, {
          organizationId,
          providerEntityId: correction.providerEntityId,
          locationId: correction.locationId,
          hopeAssessmentId: correction.id,
          specVersionId: init.specVersionId,
          controlAnswers: init.controlAnswers,
        });
        await copyActiveAnswersForIsc({
          tx: t,
          organizationId,
          source: original,
          target: correction,
          isc: init.isc,
          at,
        });
        await emit(
          t,
          organizationId,
          "m10.hope.correction_submitted",
          "hope_assessment",
          correction.id,
          {
            correctionAssessmentId: correction.id,
            originalAssessmentId: original.id,
          },
        );
        return toAssessmentView(correction);
      });
    },

    async inactivateTimepoint(organizationId, userId, urlId, args) {
      // Before the advisory key `assertNoPendingLineageOperation` takes, which parses the id as a uuid (22P02 for one that is none).
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Lock and pending check first, then judge the source (see `correctTimepoint`).
        await assertNoPendingLineageOperation(t, organizationId, id);
        const original = await loadA(t, id);
        require_(
          original.status === "signed",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${id} must be signed to inactivate.`,
        );
        require_(
          original.supersededById == null,
          "M10_CORRECTION_TARGET_SUPERSEDED",
          `Assessment ${id} is already superseded; target the current record instead.`,
        );
        if (original.isc === "XX") {
          throw new ConflictError(`HOPE assessment ${id} is already an inactivation record`);
        }
        if (args.ifVersion != null && original.version !== args.ifVersion) {
          throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
        }
        const at = new Date();
        const init = await initializeHopeInactivation(createHopeSpecRegistry(t), {
          id: original.id,
          rfaKind: original.rfaKind as HopeRfaKind,
          specVersionId: original.specVersionId,
        });
        const inactivation = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: original.patientId,
              admissionId: original.admissionId,
              rfaKind: original.rfaKind,
              specVersionId: init.specVersionId,
              isc: "XX",
              status: "draft",
              data: { inactivationReason: args.reason },
              targetDate: original.targetDate,
              providerEntityId: original.providerEntityId,
              locationId: original.locationId,
              signedAt: null,
              signedByMembershipId: null,
              authorDiscipline: args.authorDiscipline as AssessmentRow["authorDiscipline"],
              createdByMembershipId: userId,
              correctsAssessmentId: id,
            })
            .returning(),
          "hope_assessment (inactivation) insert returned no row",
        );
        await answerWriter.writeDerivedControlAnswers(t, {
          organizationId,
          providerEntityId: inactivation.providerEntityId,
          locationId: inactivation.locationId,
          hopeAssessmentId: inactivation.id,
          specVersionId: init.specVersionId,
          controlAnswers: init.controlAnswers,
        });
        await copyActiveAnswersForIsc({
          tx: t,
          organizationId,
          source: original,
          target: inactivation,
          isc: "XX",
          at,
        });
        await emit(
          t,
          organizationId,
          "m10.hope.inactivation_created",
          "hope_assessment",
          inactivation.id,
          { inactivationAssessmentId: inactivation.id, targetAssessmentId: original.id },
        );
        return toAssessmentView(inactivation);
      });
    },

    // ── Request the printable HOPE summary (§4.5 — emits summary_requested; M22 renders) ─────────────
    async requestSummaryPdf(organizationId, userId, urlId) {
      const id = uuidOrNotFound(urlId, `HOPE assessment ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadA(t, id); // 404 before emit if absent/cross-tenant
        await emit(t, organizationId, "m10.hope.summary_requested", "hope_assessment", a.id, {
          assessmentId: a.id,
          requestedBy: userId,
          // F-099 — the chart target. M22 files a render against `document.patient_id`, and it reads the
          // value off THIS payload; the row was already loaded for the 404, so carrying it costs no query.
          // Without it the summary rendered patient-independent — on no chart, for a patient-scoped record.
          patientId: a.patientId,
        });
        return { assessmentId: a.id, requested: true as const };
      });
    },

    // ── iQIES submission retry / assemble (§2.2.4) ───────────────────────────────────────────────────
    async retrySubmission(organizationId, urlId) {
      const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Light columns: the package ZIP in `acceptance_report` is neither judged nor returned by a status flip.
        const [r] = (await t
          .select(LIGHT_SUB_COLUMNS)
          .from(SUB)
          .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
          .limit(1)) as LightSubmissionColumns[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        require_(
          r.status === "rejected",
          "M10_SUBMISSION_RETRY_NOT_REJECTED",
          `Submission ${id} is ${r.status}; only a rejected submission can be retried.`,
        );
        // The UPDATE judges the row it waits for: two clicks both read `rejected`, and the second UPDATE queues behind the
        // first, re-reads the row as `queued` and matches nothing (a 409), so the batch is queued, and the event emitted,
        // once. It waits at most `M10_LOCK_TIMEOUT_MS` for that row lock (then `M10_RECORD_BUSY`: the retry was not applied).
        const rows = (await takeBoundedLock(
          t,
          (statement) =>
            statement
              .update(SUB)
              .set({ status: "queued", updatedAt: new Date() })
              .where(
                and(
                  eq(SUB.id, id),
                  eq(SUB.organizationId, organizationId),
                  eq(SUB.status, "rejected"),
                ),
              )
              .returning(LIGHT_SUB_COLUMNS),
          { lock: `submission row ${idForLog(id)} (org ${idForLog(organizationId)}) for a retry` },
        )) as LightSubmissionColumns[];
        require_(
          rows.length > 0,
          "M10_SUBMISSION_RETRY_NOT_REJECTED",
          `Submission ${id} is no longer rejected; only a rejected submission can be retried.`,
        );
        await emit(t, organizationId, "m10.hope.submission_queued", "hope_submission", r.id, {
          submissionId: r.id,
          providerEntityId: r.providerEntityId,
          itemCount: r.itemCount,
        });
        return toSubmissionView(firstOrThrow(rows, "retrySubmission matched no row"));
      });
    },
    /**
     * Phase 7 manual iQIES package: validate (final mode) and serialize every eligible signed assessment
     * for this provider entity into CMS XML (with the #240 submission header), write one
     * `hope_submission_item` per record, and store a deterministic zip on a `packaged` batch.
     *
     * Recovery note: the lost F-058 (#150/#176) rewrite of this method (batch per CMS period via
     * `jobs/assemble-store.ts`, `queued` status, no XML) is NOT restored — this path already writes the
     * items and runs the validator, and the manual upload flow is the transport.
     */
    async assembleSubmission(organizationId, urlProviderEntityId) {
      // An entity id that is no uuid names no entity, so it has nothing eligible: the same answer as an entity with no
      // signed records, never a `::uuid` cast (22P02) out of the advisory key or the candidate read. The route's body schema
      // already refuses it with a 422; this is for a direct caller.
      const providerEntityId = canonicalUuidOrNull(urlProviderEntityId);
      if (providerEntityId === null) {
        throw new ConflictError(
          "No signed HOPE assessments are eligible for iQIES package generation",
        );
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Serialise assembles of one provider entity BEFORE the candidates are read. Two parallel assembles both read the
        // same signed records (no item yet), and the one that lost the race for `uniq_hope_sub_item_assessment_active`
        // queued behind the winner without a bound, then failed with an unmapped 23505 (a 500). Behind this key the loser
        // waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`), or, once the winner committed, reads that the
        // records the winner packaged already carry a pending item and skips them (the ordinary 409 "nothing eligible"
        // when that was all of them).
        await lockRecordKey(t, `m10:assemble:${organizationId}`, providerEntityId);
        const period = new Date().toISOString().slice(0, 7);
        // Only the records that can be packaged are read, and every test is the database's: a signed record stays
        // `signed` after it is accepted, so reading the entity's whole signed history and checking each row (a query per
        // row, behind the advisory key above) grew with every month of the entity's life, and a second assemble waited that
        // long for the key (then `M10_RECORD_BUSY`). Eligible: frozen to a spec and ISC, no iQIES record id yet (an empty
        // one is none, as before), and no item that is pending or already answered. A rejected original is never re-sent unchanged: it is
        // fixed by a correction (a new signed row, which carries no item yet and so is picked up here) in a NEW batch. A
        // cancelled item does not count, so the record is packaged again.
        const candidates = (await t
          .select()
          .from(ASSESS)
          .where(
            and(
              eq(ASSESS.organizationId, organizationId),
              eq(ASSESS.providerEntityId, providerEntityId),
              eq(ASSESS.status, "signed"),
              isNotNull(ASSESS.specVersionId),
              isNotNull(ASSESS.isc),
              or(isNull(ASSESS.iqiesRecordId), eq(ASSESS.iqiesRecordId, "")),
              sql`not exists (select 1 from ${SUBITEM} where ${SUBITEM.hopeAssessmentId} = ${ASSESS.id} and ${inArray(
                SUBITEM.itemStatus,
                [...ASSEMBLE_BLOCKING_ITEM_STATUSES],
              )})`,
            ),
          )
          .orderBy(asc(ASSESS.signedAt), asc(ASSESS.id))) as AssessmentRow[];
        const eligible: AssessmentRow[] = [];
        for (const candidate of candidates) {
          const validation = await validationService.validateAssessment({
            organizationId,
            assessmentId: candidate.id,
            mode: "final",
          });
          if (validation.findings.some((finding) => finding.severity === "error")) continue;
          eligible.push(candidate);
        }
        if (eligible.length === 0) {
          throw new ConflictError(
            "No signed HOPE assessments are eligible for iQIES package generation",
          );
        }
        // The CMS submission header (facility ID, state, software vendor) is the same for every record
        // in the package. A header or payload problem is a fixable setup gap, so it surfaces as a 422
        // naming what to set, never a 500.
        const serialized = [];
        try {
          const header = buildHopeSubmissionHeader(
            await buildFoundationSiteReader().providerEntitySubmissionProfile(
              t,
              organizationId,
              providerEntityId,
            ),
            readHopeSoftwareVendor(),
          );
          for (const assessment of eligible) {
            serialized.push({
              assessment,
              payload: await serializeHopeAssessmentXml(t, assessment, header),
            });
          }
        } catch (error) {
          if (error instanceof HopeSubmissionPayloadError) {
            throw new ValidationError(error.message, [
              { field: "hope_submission", code: error.code, message: error.message },
            ]);
          }
          throw error;
        }
        const row = firstOrThrow(
          await t
            .insert(SUB)
            .values({
              organizationId,
              providerEntityId,
              submissionPeriod: period,
              status: "packaged",
              itemCount: serialized.length,
              transportMode: "manual_iqies_upload",
              validationProfile: serialized[0]?.payload.validationProfile ?? null,
            })
            .returning(),
          "hope_submission insert returned no row",
        );
        const zip = buildDeterministicZip(
          serialized.map(({ payload }) => ({
            filename: payload.filename,
            content: payload.bytes,
          })),
        );
        // The id the database stored, not the spelling of the request body, for the package name and the event.
        const filename = submissionPackageName(row.providerEntityId, period, row.id);
        for (const { assessment, payload } of serialized) {
          await t.insert(SUBITEM).values({
            organizationId,
            hopeSubmissionId: row.id,
            hopeAssessmentId: assessment.id,
            itemStatus: "pending",
            operation: payload.operation,
            specVersionId: assessment.specVersionId,
            assessmentVersion: String(assessment.version),
            validationProfile: payload.validationProfile,
            xmlFilename: payload.filename,
            xmlStorageUri: `db://hope_submission/${row.id}/${payload.filename}`,
            xmlSha256: payload.sha256,
            xmlSizeBytes: payload.bytes.length,
            iqiesValidationResult: {
              xmlContentBase64: payload.bytes.toString("base64"),
            },
          });
        }
        const [packaged] = (await t
          .update(SUB)
          .set({
            packageFilename: filename,
            packageStorageUri: `db://hope_submission/${row.id}/package`,
            packageSha256: zip.sha256,
            packageSizeBytes: zip.bytes.length,
            envelopeStorageUri: `db://hope_submission/${row.id}/package`,
            envelopeSha256: zip.sha256,
            acceptanceReport: {
              transportMode: "manual_iqies_upload",
              packageContentBase64: zip.bytes.toString("base64"),
              files: serialized.map(({ payload }) => ({
                filename: payload.filename,
                sha256: payload.sha256,
                operation: payload.operation,
              })),
            },
            updatedAt: new Date(),
          })
          .where(eq(SUB.id, row.id))
          .returning(LIGHT_SUB_COLUMNS)) as LightSubmissionColumns[];
        await emit(t, organizationId, "m10.hope.submission_queued", "hope_submission", row.id, {
          submissionId: row.id,
          providerEntityId: row.providerEntityId,
          transportMode: "manual_iqies_upload",
          itemCount: serialized.length,
          packageSha256: zip.sha256,
        });
        return toSubmissionView(packaged ?? row);
      });
    },
    async downloadSubmissionPackage(organizationId, urlId) {
      const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // No row lock on the read: re-downloading an exported or settled batch must not queue behind a result
        // import or a cancel. Only the `packaged -> exported` write needs serialising, and it does that itself
        // (see advancePackagedToExported), so a download racing a cancel is refused, never written over it.
        // Light columns first: the package ZIP (multi-MB base64 in acceptance_report) is read only once the batch is
        // known to exist and not be cancelled, so a refused download never pulls it out of the database.
        const [r] = (await t
          .select(LIGHT_SUB_COLUMNS)
          .from(SUB)
          .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
          .limit(1)) as LightSubmissionColumns[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        // R-08: a cancelled package is dead evidence (the bytes stay stored) and must not be uploaded to CMS.
        requireNotCancelled(id, r.status);
        // The status is selected WITH the bytes, in the same statement: a cancel that committed after the light read
        // above is seen here, and the bytes only leave with the row version that was judged (an `exported` batch has
        // no advance guard to catch it later).
        const [report] = await t
          .select({ status: SUB.status, acceptanceReport: SUB.acceptanceReport })
          .from(SUB)
          .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
          .limit(1);
        if (!report) throw new NotFoundError(`HOPE submission ${id} not found`);
        requireNotCancelled(id, report.status);
        const bytes = packageBytesFromReport(report.acceptanceReport);
        if (!bytes || !r.packageFilename)
          throw new ConflictError("HOPE submission package is not available");
        // Only a freshly packaged batch advances; re-downloading a settled/uploaded batch just streams the bytes
        // (otherwise a recorded result could be re-opened for recording by a mere download).
        if (report.status === "packaged") await advancePackagedToExported(t, organizationId, id);
        return {
          filename: r.packageFilename,
          contentType: "application/zip",
          bytes,
        };
      });
    },
    async cancelSubmission(organizationId, userId, id, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const row = await cancelHopeSubmission(t, {
          id,
          organizationId,
          actorMembershipId: userId,
          reasonCode: args.reasonCode,
          now: clock(),
        });
        return toSubmissionView(row);
      });
    },
    async markSubmissionUploaded(organizationId, userId, urlId, args) {
      // A date that does not exist (or has no explicit offset) is refused, never stored as the next valid one.
      if (args.submittedAt !== undefined) requireCalendarDateTime(args.submittedAt, "submittedAt");
      const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Row lock: a double submit must not emit twice, and a cancel racing this sees one status. Light columns
        // only: the package ZIP is neither needed nor re-read under the lock.
        const [r] = (await takeBoundedLock(
          t,
          (statement) =>
            statement
              .select(LIGHT_SUB_COLUMNS)
              .from(SUB)
              .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
              .limit(1)
              .for("update"),
          { lock: `submission row ${idForLog(id)} (org ${idForLog(organizationId)})` },
        )) as LightSubmissionColumns[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        requireNotCancelled(id, r.status); // R-08: its own 409 code, before the generic "wrong status" conflict
        if (r.status !== "packaged" && r.status !== "exported") {
          throw new ConflictError(
            `Submission ${id} is ${r.status}; only packaged/exported batches can be marked uploaded`,
          );
        }
        // `transmitted_at` is the CMS retention anchor (the destruction eraser and the retention scan count their 10 years
        // from it), so it is the SERVER's instant of recording, never a date the caller sent: a back-dated or far-future
        // `submittedAt` would otherwise move the horizon. The caller's date is kept in `submitted_at` (when the operator
        // says the upload happened) and in the event's `submittedAt`.
        const transmittedAt = clock();
        const submittedAt = args.submittedAt ? new Date(args.submittedAt) : transmittedAt;
        const [updated] = (await t
          .update(SUB)
          .set({
            status: "submitted_pending_result",
            transmittedAt,
            submittedAt,
            submittedByMembershipId: userId,
            iqiesSubmissionReference: args.iqiesSubmissionReference ?? null,
            updatedAt: transmittedAt,
          })
          .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
          .returning(LIGHT_SUB_COLUMNS)) as LightSubmissionColumns[];
        await emit(
          t,
          organizationId,
          "m10.hope.submission_transmitted",
          "hope_submission",
          r.id,
          manualUploadTransmittedPayload(r.id, r.packageSha256, transmittedAt, submittedAt),
        );
        return toSubmissionView(
          firstOrThrow(updated ? [updated] : [], "markSubmissionUploaded matched no row"),
        );
      });
    },
    async importSubmissionResult(organizationId, userId, urlId, args) {
      const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Row lock: serialises concurrent recordings of one batch (waits at most `M10_LOCK_TIMEOUT_MS`, then `M10_RECORD_BUSY`).
        const [r] = (await takeBoundedLock(
          t,
          (statement) => statement.select().from(SUB).where(eq(SUB.id, id)).limit(1).for("update"),
          { lock: `submission row ${idForLog(id)} (org ${idForLog(organizationId)})` },
        )) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        const { canonical: reportHash, legacy: legacyReportHash } = reportHashes(args.results);
        if (r.resultReportHash === reportHash || r.resultReportHash === legacyReportHash)
          return loadSubmissionDetail(t, r); // idempotent replay
        // Replay of an OLDER report (A, B, A): its rows are already stored; re-appending them or overwriting the
        // import metadata would corrupt the audit trail, and verdicts are final. Return the view untouched.
        const [seen] = await t
          .select({ id: RESULT.id })
          .from(RESULT)
          .where(
            and(
              eq(RESULT.hopeSubmissionId, id),
              inArray(RESULT.reportHash, [reportHash, legacyReportHash]),
            ),
          )
          .limit(1);
        if (seen) return loadSubmissionDetail(t, r);
        require_(
          isResultImportable(r.status),
          resultRefusalCode(r.status),
          `Submission ${id} is ${r.status}; a result can only be recorded for a batch that was downloaded/uploaded and is still awaiting its CMS result.`,
        );
        const items = await t
          .select(LIGHT_ITEM)
          .from(SUBITEM)
          .where(eq(SUBITEM.hopeSubmissionId, id));
        const byAssessmentId = new Map(items.map((item) => [item.hopeAssessmentId, item]));
        // A report row names its assessment in free text (a pasted report, a CSV cell): any spelling Postgres reads as
        // that uuid finds the item, and a value that is no uuid names none (the row is stored as unmatched).
        const itemOf = (raw: { assessmentId?: unknown }) => {
          if (typeof raw.assessmentId !== "string") return undefined;
          const canonical = canonicalUuidOrNull(raw.assessmentId.trim());
          return canonical === null ? undefined : byAssessmentId.get(canonical);
        };
        require_(
          args.results.some((raw) => itemOf(raw) !== undefined),
          "M10_SUBMISSION_RESULT_NO_MATCH",
          `None of the ${args.results.length} report rows names an assessment in submission ${id}.`,
        );
        const now = new Date();
        const finalStatus = new Map<string, string>(items.map((i) => [i.id, i.itemStatus]));
        // One report row per finding: merge per assessment, worst outcome wins, independent of row order.
        const worst = new Map<
          string,
          { status: ReturnType<typeof classifyCmsResult>; raw: Record<string, unknown> }
        >();
        for (const raw of args.results) {
          const item = itemOf(raw);
          const status = classifyCmsResult(raw);
          const prev = item ? worst.get(item.id) : undefined;
          if (
            item &&
            !isSettledItemStatus(item.itemStatus) && // a CMS verdict is final; later reports only add audit rows
            status !== "pending" &&
            (!prev || worstOutcome(prev.status, status) === status)
          )
            worst.set(item.id, { status, raw: prev?.status === status ? prev.raw : raw });
        }
        for (const item of items) {
          const w = worst.get(item.id);
          if (!w) continue;
          finalStatus.set(item.id, w.status);
          await t
            .update(SUBITEM)
            .set({
              itemStatus: w.status,
              iqiesRecordId:
                typeof w.raw.iqiesRecordId === "string" ? w.raw.iqiesRecordId : item.iqiesRecordId,
              iqiesValidationResult: w.raw,
              processedAt: now,
              updatedAt: now,
            })
            .where(eq(SUBITEM.id, item.id));
          if (w.status !== "rejected" && typeof w.raw.iqiesRecordId === "string") {
            await t
              .update(ASSESS)
              .set({ iqiesRecordId: w.raw.iqiesRecordId, updatedAt: now })
              .where(eq(ASSESS.id, item.hopeAssessmentId));
          }
        }
        for (const raw of args.results) {
          const item = itemOf(raw);
          const resultStatus = classifyCmsResult(raw);
          await t
            .insert(RESULT)
            .values({
              organizationId,
              hopeSubmissionId: id,
              hopeSubmissionItemId: item?.id ?? null,
              reportHash,
              reportReference: args.reportReference ?? null,
              resultScope: item ? "record" : "unmatched",
              resultStatus,
              cmsSeverity: typeof raw.severity === "string" ? raw.severity : null,
              cmsEditCode: typeof raw.code === "string" ? raw.code : null,
              itemCode: typeof raw.itemCode === "string" ? raw.itemCode : null,
              message: typeof raw.message === "string" ? raw.message : null,
              rawResult: raw,
              processedAt: now,
            })
            .onConflictDoNothing();
        }
        // Counts and status are derived from ALL items, so a replayed or follow-up report is idempotent.
        const outcome = deriveBatchOutcome([...finalStatus.values()] as Parameters<
          typeof deriveBatchOutcome
        >[0]);
        const settled = outcome.pendingCount === 0;
        const [updated] = (await t
          .update(SUB)
          .set({
            status: outcome.status,
            acceptedCount: outcome.acceptedCount,
            rejectedCount: outcome.rejectedCount,
            acceptedAt: settled && outcome.rejectedCount === 0 ? now : null,
            resultImportedAt: now,
            resultImportedByMembershipId: userId,
            resultReportHash: reportHash,
            acceptanceReport: {
              // keep the stored package (packageContentBase64): the ZIP must stay downloadable after a result.
              ...(r.acceptanceReport && typeof r.acceptanceReport === "object"
                ? r.acceptanceReport
                : {}),
              reportReference: args.reportReference ?? null,
              reportHash,
              results: appendReportResults(
                (r.acceptanceReport as { results?: unknown } | null)?.results,
                args.results,
              ),
            },
            updatedAt: now,
          })
          .where(eq(SUB.id, id))
          .returning()) as SubmissionRow[];
        if (settled && updated) {
          const event = settledBatchEvent(
            updated.id,
            updated.providerEntityId,
            outcome,
            args.results,
          );
          await emit(
            t,
            organizationId,
            event.eventName,
            "hope_submission",
            updated.id,
            event.payload,
          );
        }
        return loadSubmissionDetail(
          t,
          firstOrThrow(updated ? [updated] : [], "importSubmissionResult matched no row"),
        );
      });
    },

    // No in-process outbox buffer in the DB backend (the transactional relay owns emission) — drain empty.
    drainEvents() {
      return [];
    },
  };
}
