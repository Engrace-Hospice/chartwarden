import { createHash } from "node:crypto";
import { audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/10-hope — PRODUCTION HopeRouteService (M10L reads + writes, mirrors M9L).
//
// The screen-driving READS (timepoint-schedule worklist, HOPE assessment chart + detail, SFV worklist,
// iQIES submission list/detail, pre-submission validation findings, the compliance dashboard) run as real
// Drizzle queries over the M10-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role. `hope_assessment` is PARTITION BY RANGE
// (target_date) with a DEFAULT partition so inserts always land. The WRITE lifecycle is now real (M10L):
// record (draft insert, linked to the open schedule) · sign (server-authoritative J2051 verdict → the DB
// schedule-mark-completed trigger closes the schedule; a fired trigger opens the SFV) · correct (the
// append-only amendment whose insert fires the DB supersede trigger) · SFV completion · schedule skip ·
// submission assemble/retry · summary-PDF request. Every state transition emits its `m10.hope.*` event on
// the caller's transactional outbox. No route is left at 501.
//
// The backend object IS BOTH the HopeRouteService AND the §4.7 HopeAbacResolver. Because the interface
// threads no siting nor an M9 snapshot into the DB backend, this slice makes documented compromises (the
// M8/M9 convention): (1) writes envelope `withOrgContext` with `userId:""` → the M4 write-audit trigger
// fires with a NULL actor (the acting membership is the passed `userId`, stored as created/signed_by);
// (2) GAP-019 / GAP-204: the D8 PPS/ESAS-r snapshot is taken at signature through M9's published
// `LatestAssessmentProvider` seam (null only when M9 cannot answer, and then a compliance finding is
// raised — no external dependency blocks the write path, §7.13); (3) provider/location siting is null; the
// SFV `alert_cadence` is a minimal default until the alert planner is threaded. A correction REUSES the
// original's `target_date` (the composite self-FK `(corrects_assessment_id, target_date) → (id,
// target_date)` demands it); the DB supersede trigger flips the original only when the correction signs.
import {
  type CaptureDecision,
  assertCaptureAllowed,
  assertRfaMatchesSchedule,
  captureInstantOf,
  planSfvCompletion,
  require_,
} from "@wardenx/hope";
import { withOrgContext } from "@wardenx/tenancy";
import type { HopeRfaKind, LatestAssessment, ScaleType } from "@wardenx/types";
import { ConflictError, NotFoundError, ValidationError } from "@wardenx/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { getSeam } from "../../bootstrap/index";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "./abac-predicates";
import { createHopeAdmissionPrefillService } from "./hope-admission-prefill-service";
import { createHopeAssessmentAnswerService } from "./hope-answer-service";
import { HopeSubmissionPayloadError, serializeHopeAssessmentXml } from "./hope-cms-xml-serializer";
import { createHopeDischargePrefillService } from "./hope-discharge-prefill-service";
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
import { createHopeSpecRegistry } from "./hope-spec-registry";
import { buildHopeSubmissionHeader, readHopeSoftwareVendor } from "./hope-submission-header";
import {
  HopeValidationFindingSitingError,
  createHopeValidationService,
} from "./hope-validation-service";
import { buildDeterministicZip } from "./hope-zip";
import type { HopeWriteOutboxPort } from "./outbox-port";
import type {
  CorrectTimepointArgs,
  HopeAssessmentView,
  HopeComplianceView,
  HopeRouteService,
  HopeScheduleView,
  HopeSfvView,
  HopeSignResult,
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
const FINDING = schema.hopeValidationFindings;
const ANSWER = schema.hopeAssessmentAnswers;
const ITEM = schema.hopeSpecItems;
const RESULT = schema.hopeSubmissionResultEvents;
const answerWriter = createHopeAssessmentAnswerWriter();
const dischargePrefillService = createHopeDischargePrefillService();

type ScheduleRow = typeof SCHED.$inferSelect;
type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;
type SubmissionRow = typeof SUB.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const HOPE_J2053_ITEM_CODES = [
  "J2053A",
  "J2053B",
  "J2053C",
  "J2053D",
  "J2053E",
  "J2053F",
  "J2053G",
  "J2053H",
] as const;

export interface CompletedSfvRegulatoryAnswerPlan {
  readonly answered: ReadonlyMap<string, string>;
  readonly skipped: ReadonlySet<string>;
}

export function buildCompletedSfvRegulatoryAnswerPlan(
  completedDate: string,
  sfvData: Record<string, unknown>,
): CompletedSfvRegulatoryAnswerPlan | null {
  const sectionJ =
    sfvData.J && typeof sfvData.J === "object" && !Array.isArray(sfvData.J)
      ? (sfvData.J as Record<string, unknown>)
      : null;
  const j2053 =
    sectionJ?.J2053 && typeof sectionJ.J2053 === "object" && !Array.isArray(sectionJ.J2053)
      ? (sectionJ.J2053 as Record<string, unknown>)
      : null;

  if (!j2053) return null;

  const answered = new Map<string, string>([
    ["J2052A", "1"],
    ["J2052B", completedDate],
  ]);

  for (const itemCode of HOPE_J2053_ITEM_CODES) {
    const value = j2053[itemCode];
    if (typeof value === "string" && value.trim() !== "") {
      answered.set(itemCode, value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      answered.set(itemCode, String(value));
    } else {
      return null;
    }
  }

  return {
    answered,
    skipped: new Set(["J2052C"]),
  };
}

/** F-058 — a batch iQIES has answered on. See `complianceDashboard`. */
const SUBMISSION_TERMINAL_STATUSES = ["accepted", "rejected", "partially_accepted"];

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

/** The §D8 rule id + message the compensating warning finding carries (spec §D8 / M10 §7.13). */
const D8_MISSING_PPS_RULE = "D8_CLINICAL_CONTEXT_PPS_MISSING";

const OFFICIAL_RFA_KINDS = [
  "01_admission",
  "02_huv1",
  "03_huv2",
  "05_discharge",
] as const satisfies readonly HopeRfaKind[];

function isOfficialRfaKind(rfaKind: string): rfaKind is (typeof OFFICIAL_RFA_KINDS)[number] {
  return (OFFICIAL_RFA_KINDS as readonly string[]).includes(rfaKind);
}

// `hope_assessment` carries no author_discipline / version column (the correction chain is append-only;
// the discipline is a request-time attribute, not persisted). Reads project the stable view defaults.
const toAssessmentView = (r: AssessmentRow): HopeAssessmentView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  rfaKind: r.rfaKind as HopeAssessmentView["rfaKind"],
  status: r.status as HopeAssessmentView["status"],
  targetDate: r.targetDate.toISOString(),
  authorDiscipline: "",
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

const toSubmissionView = (r: SubmissionRow): HopeSubmissionView => ({
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
});

/**
 * The production, RLS-backed HopeRouteService + HopeAbacResolver (one object). Reads and writes are
 * real (Drizzle + RLS). Org is bound from the request context by the caller and passed as `organizationId` —
 * never the body. Every read runs under `withOrgContext` so RLS scopes rows to the active org.
 */
export function createDbHopeBackend(
  db: DbClient,
  outbox: HopeWriteOutboxPort = NOOP_OUTBOX,
  /** GAP-015: the SERVER clock the capture gate judges lateness / the hard cutoff on (injectable for tests). */
  clock: () => Date = () => new Date(),
): HopeRouteService {
  /**
   * GAP-015 — record a CRITICAL audit event when a platform admin's deadline override actually lifted the
   * hard cutoff, on the same transaction as the row it let through. The route has already required the
   * `hope.admin.late_deadline_override` permission and a justification.
   */
  async function auditDeadlineOverride(
    t: DbClient,
    organizationId: string,
    membershipId: string,
    resource: { kind: string; id: string },
    context: Record<string, unknown>,
  ): Promise<void> {
    // M10's acting id is the MEMBERSHIP id (not a user id), so it rides in the context, not `actor_user_id`.
    await audit(
      t as never,
      { organizationId, userId: null, correlationId: `hope-late-deadline-override:${resource.id}` },
      {
        eventType: "hope.late_deadline_override",
        resourceKind: resource.kind,
        resourceId: resource.id,
        outcome: "success",
        severity: "critical",
        context: { ...context, byMembershipId: membershipId },
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
    } catch {
      return null;
    }
  }

  /**
   * The admission's PE/location siting, through M6's `AdmissionStatusReader`. Needed ONLY to write a
   * `hope_validation_finding`, whose `provider_entity_id` / `location_id` are NOT NULL while
   * `hope_assessment`'s are nullable and this backend leaves them null (documented compromise #3).
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
      if (summary.organizationId !== organizationId || summary.patientId !== patientId) return null;
      const providerEntityId = summary.providerEntityId;
      const locationId = summary.locationId ?? null;
      if (!providerEntityId || !locationId) return null;
      return { providerEntityId, locationId };
    } catch {
      return null;
    }
  }

  async function writeDraftSfvCompletionAnswers(
    tx: DbClient,
    organizationId: string,
    triggeringAssessmentId: string,
    completedDate: string,
    sfvData: Record<string, unknown>,
    at: Date,
  ): Promise<void> {
    const [assessment] = (await tx
      .select()
      .from(ASSESS)
      .where(and(eq(ASSESS.id, triggeringAssessmentId), eq(ASSESS.organizationId, organizationId)))
      .limit(1)) as AssessmentRow[];

    if (
      !assessment ||
      assessment.status !== "draft" ||
      !assessment.specVersionId ||
      !assessment.isc
    ) {
      return;
    }

    const plan = buildCompletedSfvRegulatoryAnswerPlan(completedDate, sfvData);
    if (!plan) return;

    const requestedCodes = ["J2052A", "J2052B", "J2052C", ...HOPE_J2053_ITEM_CODES];

    const rows = await tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(schema.hopeSpecItemIsc, eq(schema.hopeSpecItemIsc.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, assessment.specVersionId),
          inArray(ITEM.itemCode, requestedCodes),
          eq(schema.hopeSpecItemIsc.isc, assessment.isc),
          eq(schema.hopeSpecItemIsc.active, true),
        ),
      );

    const byCode = new Map(rows.map((row) => [row.item.itemCode, row.item]));

    for (const [itemCode, value] of plan.answered) {
      const item = byCode.get(itemCode);

      if (!item) continue;

      await tx
        .insert(ANSWER)
        .values({
          organizationId,
          providerEntityId: assessment.providerEntityId,
          locationId: assessment.locationId,
          hopeAssessmentId: assessment.id,
          specVersionId: assessment.specVersionId,
          specItemId: item.id,
          state: "answered",
          value,
          source: "derived",
          sourceReference: {
            reason: "completed_sfv_regulatory_reconciliation",
            sfvWorkflow: "completed_operational_sfv",
          },
          answeredAt: at,
          answeredByMembershipId: null,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
          set: {
            state: "answered",
            value,
            source: "derived",
            sourceReference: {
              reason: "completed_sfv_regulatory_reconciliation",
              sfvWorkflow: "completed_operational_sfv",
            },
            answeredAt: at,
            answeredByMembershipId: null,
            updatedAt: at,
          },
        });
    }

    const j2052c = byCode.get("J2052C");

    if (j2052c) {
      await tx
        .insert(ANSWER)
        .values({
          organizationId,
          providerEntityId: assessment.providerEntityId,
          locationId: assessment.locationId,
          hopeAssessmentId: assessment.id,
          specVersionId: assessment.specVersionId,
          specItemId: j2052c.id,
          state: "skipped",
          value: null,
          source: "derived",
          sourceReference: {
            reason: "completed_sfv_regulatory_reconciliation",
            sfvWorkflow: "completed_operational_sfv",
            ruleId: "hope-v1.00.1-j2052-reason",
            cmsRuleId: "-3106",
            dependsOn: ["J2052A"],
          },
          answeredAt: at,
          answeredByMembershipId: null,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
          set: {
            state: "skipped",
            value: null,
            source: "derived",
            sourceReference: {
              reason: "completed_sfv_regulatory_reconciliation",
              sfvWorkflow: "completed_operational_sfv",
              ruleId: "hope-v1.00.1-j2052-reason",
              cmsRuleId: "-3106",
              dependsOn: ["J2052A"],
            },
            answeredAt: at,
            answeredByMembershipId: null,
            updatedAt: at,
          },
        });
    }
  }

  async function reconcileCompletedSfvRegulatoryAnswers(
    tx: DbClient,
    organizationId: string,
    triggeringAssessmentId: string,
    at: Date = new Date(),
  ): Promise<{ repaired: boolean; reason?: string }> {
    const [sfv] = (await tx
      .select()
      .from(SFV)
      .where(
        and(
          eq(SFV.organizationId, organizationId),
          eq(SFV.triggeringAssessmentId, triggeringAssessmentId),
        ),
      )
      .limit(1)) as SfvRow[];

    if (!sfv || sfv.status !== "completed" || !sfv.completedAt || !sfv.completingAssessmentId) {
      return { repaired: false, reason: "sfv_not_completed" };
    }

    const [completion] = (await tx
      .select()
      .from(ASSESS)
      .where(
        and(eq(ASSESS.organizationId, organizationId), eq(ASSESS.id, sfv.completingAssessmentId)),
      )
      .limit(1)) as AssessmentRow[];

    if (!completion || completion.rfaKind !== "04_sfv" || completion.status !== "signed") {
      return {
        repaired: false,
        reason: "completion_assessment_not_signed_sfv",
      };
    }

    const completionData =
      completion.data && typeof completion.data === "object" && !Array.isArray(completion.data)
        ? (completion.data as Record<string, unknown>)
        : null;
    if (!completionData) return { repaired: false, reason: "missing_sfv_data" };
    const plan = buildCompletedSfvRegulatoryAnswerPlan(
      completion.targetDate.toISOString().slice(0, 10),
      completionData,
    );
    if (!plan) return { repaired: false, reason: "missing_j2053" };

    await writeDraftSfvCompletionAnswers(
      tx,
      organizationId,
      triggeringAssessmentId,
      completion.targetDate.toISOString().slice(0, 10),
      completionData,
      at,
    );

    return { repaired: true };
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
   * typed (`source !== "user"`) are refreshed, and an unchanged chart writes nothing.
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

    const init = await initializeNewHopeRecord(createHopeSpecRegistry(tx), {
      rfaKind: assessment.rfaKind,
      targetDate: assessment.targetDate,
    });
    const at = new Date();
    const [updated] = (await tx
      .update(ASSESS)
      .set({
        specVersionId: assessment.specVersionId ?? init.specVersionId,
        isc: assessment.isc ?? init.isc,
        updatedAt: at,
      })
      .where(and(eq(ASSESS.id, id), eq(ASSESS.organizationId, organizationId)))
      .returning()) as AssessmentRow[];
    const normalized = firstOrThrow(updated ? [updated] : [], `HOPE assessment ${id} not found`);
    await answerWriter.writeDerivedControlAnswers(tx, {
      organizationId,
      providerEntityId: normalized.providerEntityId,
      locationId: normalized.locationId,
      hopeAssessmentId: normalized.id,
      specVersionId: normalized.specVersionId ?? init.specVersionId,
      controlAnswers: init.controlAnswers,
    });
    return normalized;
  }

  async function loadA(t: DbClient, id: string): Promise<AssessmentRow> {
    const [r] = (await t
      .select()
      .from(ASSESS)
      .where(eq(ASSESS.id, id))
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

  async function assertNoPendingLineageOperation(t: DbClient, sourceId: string): Promise<void> {
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

  function cmsResultStatus(
    raw: Record<string, unknown>,
  ): "accepted" | "accepted_with_warnings" | "rejected" | "pending" {
    const status = String(raw.status ?? raw.result ?? raw.outcome ?? "").toLowerCase();
    const severity = String(raw.severity ?? raw.cmsSeverity ?? "").toLowerCase();
    if (status.includes("reject") || severity === "fatal" || severity === "error")
      return "rejected";
    if (status.includes("warning") || severity === "warning") return "accepted_with_warnings";
    if (status.includes("accept")) return "accepted";
    return "pending";
  }

  return {
    // ── Timepoint-schedule reads (§2.2.1 window ledger) ────────────────────────────────────────────
    async listSchedules(organizationId, filter) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx.select().from(SCHED)) as ScheduleRow[];
        const schedules = rows
          .filter(
            (r) =>
              (!filter.patientId || r.patientId === filter.patientId) &&
              (!filter.status || r.status === filter.status) &&
              (!filter.rfaKind || r.rfaKind === filter.rfaKind),
          )
          .map(toScheduleView);
        return { schedules };
      });
    },
    async getSchedule(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select()
          .from(SCHED)
          .where(eq(SCHED.id, id))
          .limit(1)) as ScheduleRow[];
        if (!r) throw new NotFoundError(`HOPE schedule ${id} not found`);
        return toScheduleView(r);
      });
    },

    // ── HOPE assessment reads (parent of the partitioned hope_assessment) ──────────────────────────
    async getAssessment(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select()
          .from(ASSESS)
          .where(eq(ASSESS.id, id))
          .limit(1)) as AssessmentRow[];
        if (!r) throw new NotFoundError(`HOPE assessment ${id} not found`);
        return toAssessmentView(r);
      });
    },
    async listPatientAssessments(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select()
          .from(ASSESS)
          .where(eq(ASSESS.patientId, patientId))) as AssessmentRow[];
        return { assessments: rows.map(toAssessmentView) };
      });
    },

    // ── SFV worklist reads (§2.2.3) ────────────────────────────────────────────────────────────────
    async listSfv(organizationId, state, patientIds) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx.select().from(SFV)) as SfvRow[];
        const sfvs = rows
          .filter((r) => !state || r.status === state)
          .filter((r) => !patientIds || patientIds.includes(r.patientId))
          .map(toSfvView);
        return { sfvs };
      });
    },
    async getSfv(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx.select().from(SFV).where(eq(SFV.id, id)).limit(1)) as SfvRow[];
        if (!r) throw new NotFoundError(`SFV ${id} not found`);
        return toSfvView(r);
      });
    },

    // ── Pre-submission validation findings (§3.3 hope_validation_finding) ───────────────────────────
    async getValidation(organizationId, id, options) {
      return validationService.validateAssessment({
        organizationId,
        assessmentId: id,
        mode: options?.mode ?? "final",
        submissionDate: options?.submissionDate,
      });
    },

    // ── iQIES submission reads (§2.2.4) ────────────────────────────────────────────────────────────
    async listSubmissions(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx.select().from(SUB)) as SubmissionRow[];
        const submissions = rows
          .filter((r) => !providerEntityId || r.providerEntityId === providerEntityId)
          .map(toSubmissionView);
        return { submissions };
      });
    },
    async getSubmission(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx.select().from(SUB).where(eq(SUB.id, id)).limit(1)) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        return toSubmissionView(r);
      });
    },

    // ── Compliance dashboard (§7 — mirrors the in-mem rate math over the RLS-scoped org rows) ────────
    async complianceDashboard(organizationId, providerEntityId): Promise<HopeComplianceView> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const scheds = (await tx.select({ status: SCHED.status }).from(SCHED)) as {
          status: string;
        }[];
        const completed = scheds.filter((s) => s.status === "completed").length;
        const expired = scheds.filter((s) => s.status === "expired").length;
        const denom = completed + expired;
        const sfvAll = (await tx.select({ status: SFV.status }).from(SFV)) as {
          status: string;
        }[];
        const sfvOnTime = sfvAll.filter((s) => s.status === "completed").length;
        const sfvDenom = sfvAll.filter(
          (s) => s.status === "completed" || s.status === "missed",
        ).length;
        const subsAll = (await tx
          .select({
            status: SUB.status,
            providerEntityId: SUB.providerEntityId,
          })
          .from(SUB)) as { status: string; providerEntityId: string }[];
        const subs = subsAll.filter(
          (s) => !providerEntityId || s.providerEntityId === providerEntityId,
        );
        // F-058 (#150) — the acceptance-rate DENOMINATOR is the terminal batches only.
        //
        // It used to be every submission of any status, which read as 0% acceptance for an agency whose
        // batches are merely queued. That was latent while nothing created a batch with anything in it;
        // it becomes live the moment force-assemble does real work, and 0% is the §1.3 APU-penalty band
        // — the worst possible reading to hand a compliance officer for "assembled, not yet sent". A
        // `queued` or `in_flight` batch has no acceptance outcome, so it belongs in neither half of the
        // ratio. Same definition M30's `submissionBatches` rollup already uses.
        const terminal = subs.filter((s) => SUBMISSION_TERMINAL_STATUSES.includes(s.status));
        const accepted = terminal.filter((s) => s.status === "accepted").length;
        return {
          providerEntityId: providerEntityId ?? null,
          hopeOnTimeRate: rateOf(completed, denom),
          hopeOnTimeCounts: { onTime: completed, total: denom },
          sfvOnTimeRate: rateOf(sfvOnTime, sfvDenom),
          sfvOnTimeCounts: { onTime: sfvOnTime, total: sfvDenom },
          submissionAcceptanceRate: rateOf(accepted, terminal.length),
          submissionAcceptanceCounts: { accepted, total: terminal.length },
        };
      });
    },
    async getWorkflowState(organizationId, admissionId): Promise<HopeWorkflowStateView> {
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
      } catch {
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
        const patientId =
          admission?.patientId ?? schedRows[0]?.patientId ?? assessmentRows[0]?.patientId ?? null;
        const sfvRows =
          patientId == null
            ? []
            : ((await tx.select().from(SFV).where(eq(SFV.patientId, patientId))) as SfvRow[]);
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
    async regenerateSchedules(organizationId, admissionId) {
      await regenerateSchedulesForAdmission(db, outbox, { organizationId, admissionId });
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ id: SCHED.id })
          .from(SCHED)
          .where(eq(SCHED.admissionId, admissionId));
        return { admissionId, scheduleCount: rows.length };
      });
    },

    // ── §4.7 / GAP-018 ABAC resolver — correction + scope predicate facts (fail-closed on absent) ─────
    async loadAssessment(organizationId, assessmentId): Promise<HopeAssessmentAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({
            patientId: ASSESS.patientId,
            signedByMembershipId: ASSESS.signedByMembershipId,
          })
          .from(ASSESS)
          .where(and(eq(ASSESS.id, assessmentId), eq(ASSESS.organizationId, organizationId)))
          .limit(1)) as {
          patientId: string;
          signedByMembershipId: string | null;
        }[];
        if (!r) return null; // absent / cross-tenant → deny
        return {
          patientId: r.patientId,
          originalSignedBy: r.signedByMembershipId ?? null,
        };
      });
    },
    async loadSchedule(organizationId, scheduleId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ patientId: SCHED.patientId })
          .from(SCHED)
          .where(and(eq(SCHED.id, scheduleId), eq(SCHED.organizationId, organizationId)))
          .limit(1)) as { patientId: string }[];
        return r ? { patientId: r.patientId } : null;
      });
    },
    async loadSfv(organizationId, sfvId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ patientId: SFV.patientId })
          .from(SFV)
          .where(and(eq(SFV.id, sfvId), eq(SFV.organizationId, organizationId)))
          .limit(1)) as { patientId: string }[];
        return r ? { patientId: r.patientId } : null;
      });
    },
    async loadSubmission(organizationId, submissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ providerEntityId: SUB.providerEntityId })
          .from(SUB)
          .where(and(eq(SUB.id, submissionId), eq(SUB.organizationId, organizationId)))
          .limit(1)) as { providerEntityId: string }[];
        return r ? { providerEntityId: r.providerEntityId } : null;
      });
    },

    // ── Schedule skip (§2.2.1) ────────────────────────────────────────────────────────────────────
    async skipSchedule(organizationId, id, reasonCode) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [existing] = (await t
          .select()
          .from(SCHED)
          .where(eq(SCHED.id, id))
          .limit(1)) as ScheduleRow[];
        if (!existing) throw new NotFoundError(`HOPE schedule ${id} not found`);
        const rows = (await t
          .update(SCHED)
          .set({
            status: "skipped",
            skipReasonCode: reasonCode,
            updatedAt: new Date(),
          })
          .where(eq(SCHED.id, id))
          .returning()) as ScheduleRow[];
        return toScheduleView(firstOrThrow(rows, "schedule skip matched no row"));
      });
    },

    // ── Record a draft timepoint (§2.2.1 — linked to its open schedule if one exists) ───────────────
    async recordTimepoint(organizationId, userId, admissionId, args: RecordTimepointArgs) {
      const view = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const admissionSummary =
          args.rfaKind === "01_admission" ||
          args.rfaKind === "02_huv1" ||
          args.rfaKind === "03_huv2" ||
          args.rfaKind === "05_discharge"
            ? await getSeam("AdmissionStatusReader").getAdmissionSummary(
                organizationId,
                admissionId,
              )
            : null;
        if (admissionSummary && admissionSummary.organizationId !== organizationId) {
          throw new NotFoundError(`Admission ${admissionId} not found`);
        }
        const regulatoryTargetDate =
          args.rfaKind === "01_admission"
            ? (admissionSummary?.admissionAt ?? args.targetDate)
            : args.rfaKind === "05_discharge"
              ? (admissionSummary?.dischargedAt ?? args.targetDate)
              : args.targetDate;
        const init = await initializeNewHopeRecord(createHopeSpecRegistry(t), {
          rfaKind: args.rfaKind,
          targetDate: args.targetDate,
        });
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
        const row = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: admissionSummary?.patientId ?? sched?.patientId ?? admissionId,
              admissionId,
              // Only an OPEN window is linked: `trg_hope_schedule_mark_completed` closes the linked
              // schedule on sign and its own WHERE is `status = 'open'`.
              scheduleId: sched?.status === "open" ? sched.id : null,
              rfaKind: args.rfaKind,
              specVersionId: init.specVersionId,
              isc: init.isc,
              status: "draft",
              data: args.data,
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

    // ── Record an RFA-04 SFV completion (§2.2.3) ─────────────────────────────────────────────────────
    async recordSfv(organizationId, userId, admissionId, args: RecordSfvArgs) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [sfv] = (await t
          .select()
          .from(SFV)
          .where(eq(SFV.triggeringAssessmentId, args.triggeringAssessmentId))
          .limit(1)) as SfvRow[];
        require_(
          sfv != null,
          "M10_SFV_NO_TRIGGER",
          `No SFV obligation for triggering assessment ${args.triggeringAssessmentId}.`,
        );
        const at = clock();
        // GAP-015: completion is judged on the later of the client's `targetDate` and the SERVER's now, so a
        // late filer cannot send an in-window date to dodge `M10_SFV_PAST_DUE`.
        const completedAtIso = captureInstantOf(args.targetDate, at.toISOString());
        // Insert the signed RFA-04 row, then complete the open SFV (the §4.4 guards live in planSfvCompletion).
        const row = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: sfv.patientId,
              admissionId,
              // F-058 — the batch key, carried from the SFV obligation this RFA-04 completes (the same
              // denormalized siting, already resolved when the trigger created it).
              providerEntityId: sfv.providerEntityId,
              locationId: sfv.locationId,
              rfaKind: "04_sfv",
              status: "signed",
              data: args.data,
              targetDate: new Date(args.targetDate),
              signedAt: at,
              signedByMembershipId: userId,
              createdByMembershipId: userId,
            })
            .returning(),
          "hope_assessment (sfv) insert returned no row",
        );
        const plan = planSfvCompletion(
          {
            id: sfv.id,
            status: sfv.status,
            dueAt: iso(sfv.dueAt) ?? at.toISOString(),
          },
          row.id,
          completedAtIso,
          { adminOverride: args.adminOverride },
        );
        if (
          args.adminOverride === true &&
          Date.parse(completedAtIso) > Date.parse(iso(sfv.dueAt) ?? at.toISOString())
        ) {
          await auditDeadlineOverride(
            t,
            organizationId,
            userId,
            { kind: "hope_assessment", id: row.id },
            {
              sfvId: sfv.id,
              triggeringAssessmentId: args.triggeringAssessmentId,
              targetDate: args.targetDate,
              justification: args.adminOverrideJustification ?? null,
            },
          );
        }
        await t
          .update(SFV)
          .set({
            status: "completed",
            completingAssessmentId: plan.completingAssessmentId,
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(SFV.id, sfv.id));
        await writeDraftSfvCompletionAnswers(
          t,
          organizationId,
          sfv.triggeringAssessmentId,
          args.targetDate.slice(0, 10),
          args.data,
          at,
        );
        await emit(t, organizationId, "m10.hope.sfv_completed", "symptom_follow_up_visit", sfv.id, {
          sfvId: sfv.id,
          completingAssessmentId: row.id,
          completedAt: at.toISOString(),
        });
        return toAssessmentView(row);
      });
    },

    // ── Update a draft's payload (§2.2.2 — draft only) ───────────────────────────────────────────────
    async updateDraft(organizationId, id, data) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadA(t, id);
        require_(
          r.status === "draft",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${id} is not a draft.`,
        );
        const merged = { ...(r.data as Record<string, unknown>), ...data };
        const rows = (await t
          .update(ASSESS)
          .set({ data: merged, version: r.version + 1, updatedAt: new Date() })
          .where(eq(ASSESS.id, id))
          .returning()) as AssessmentRow[];
        return toAssessmentView(firstOrThrow(rows, "updateDraft matched no row"));
      });
    },

    async getAssessmentWorkspace(organizationId, id) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const assessment = await ensureDraftSpecInitialized(t, organizationId, id);
        await refreshChartPrefill(t, organizationId, assessment);
      });
      return answerService.getWorkspace(organizationId, id);
    },

    async getAssessmentReview(organizationId, id) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await ensureDraftSpecInitialized(t, organizationId, id);
        await reconcileCompletedSfvRegulatoryAnswers(t, organizationId, id);
      });
      return readinessService.getReview({ organizationId, assessmentId: id });
    },

    async patchAssessmentAnswers(organizationId, userId, id, input) {
      const result = await answerService.patchAnswers(organizationId, userId, id, input);
      try {
        await validationService.validateAssessment({
          organizationId,
          assessmentId: id,
          mode: "draft",
        });
      } catch (error) {
        if (!(error instanceof HopeValidationFindingSitingError)) throw error;
      }
      return result;
    },

    async setHuvCompletionDate(organizationId, userId, id, input) {
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
          assessmentId: id,
          version: updated.version,
          answers: [answer],
        };
      });
      try {
        await validationService.validateAssessment({
          organizationId,
          assessmentId: id,
          mode: "draft",
        });
      } catch (error) {
        if (!(error instanceof HopeValidationFindingSitingError)) throw error;
      }
      return result;
    },

    // ── Sign a draft (§2.2.2 / Phase 3C — final validation + Z0500B candidate, then immutable) ─
    async signTimepoint(organizationId, userId, id, args): Promise<HopeSignResult> {
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
        const [loaded] = await t
          .select({
            assessment: ASSESS,
            specCode: schema.hopeSpecVersions.code,
          })
          .from(ASSESS)
          .innerJoin(schema.hopeSpecVersions, eq(schema.hopeSpecVersions.id, ASSESS.specVersionId))
          .where(and(eq(ASSESS.id, id), eq(ASSESS.organizationId, organizationId)))
          .limit(1);
        if (!loaded) throw new NotFoundError(`HOPE assessment ${id} not found`);
        const r = loaded.assessment as AssessmentRow;
        require_(
          r.status === "draft",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${id} is not a draft and cannot be signed.`,
        );
        const expectedVersion = args?.ifVersion ?? r.version;
        if (r.version !== expectedVersion) {
          throw new ConflictError(`HOPE assessment ${id} version is stale; reload and retry`);
        }
        if (!r.specVersionId || !r.isc) {
          throw new ConflictError(`HOPE assessment ${id} has no frozen spec version / ISC`);
        }
        await assertCorrectionHasSubstantiveChange(t, r);
        const at = new Date();
        const z0500b = at.toISOString().slice(0, 10);
        const review = await readinessService.evaluateCandidateInTx(t, {
          assessment: r,
          specVersionCode: loaded.specCode,
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
        // §D8's compensating control (GAP-019): the missing-PPS gap must be VISIBLE to compliance /
        // HQRP review, not merely "not blocking". Without this row the gap was invisible — the
        // assessment signed clean and nothing anywhere recorded that its clinical context was absent.
        if (ppsMissing && siting) {
          await t.insert(FINDING).values({
            organizationId,
            providerEntityId: siting.providerEntityId,
            locationId: siting.locationId,
            hopeAssessmentId: id,
            ruleId: D8_MISSING_PPS_RULE,
            severity: "warning",
            section: "J",
            message:
              snapshot === null
                ? "No PPS on file at signing: the M9 assessment seam could not be reached, so no clinical-context snapshot was taken (D8)."
                : "No PPS on file at signing: the clinical-context snapshot was taken and contains no PPS score (D8).",
            evaluatedAt: at,
            resolved: false,
          });
        } else if (ppsMissing) {
          // NOT NULL siting could not be resolved, so the finding row is impossible. Say so — a
          // compliance control that silently declines to record itself is the defect this closes.
          console.warn(
            `m10: HOPE assessment ${id} signed with no PPS clinical context and the D8 warning finding could not be written (admission ${pre.admissionId} has no resolvable provider entity / location).`,
          );
        }
        await emit(t, organizationId, "m10.hope.timepoint_signed", "hope_assessment", id, {
          assessmentId: id,
          rfaKind: r.rfaKind,
          signedAt: at.toISOString(),
          signedBy: userId,
          j2051TriggerFired: signed.j2051TriggerFired,
          wasLate: r.wasLate,
        });
        // §2.4 / §4.9 — a signed record whose server-authoritative J2051 verdict fired announces it
        // (M11's order-suggestion banner, M30 Timely Follow-Up, M33). The SFV obligation it references
        // was opened while the draft was answered (readiness refuses to sign a fired trigger without
        // one), so it is read here rather than created.
        if (signed.j2051TriggerFired) {
          const [sfv] = (await t
            .select()
            .from(SFV)
            .where(and(eq(SFV.organizationId, organizationId), eq(SFV.triggeringAssessmentId, id)))
            .limit(1)) as SfvRow[];
          if (sfv) {
            await emit(t, organizationId, "m10.hope.j2051_trigger_fired", "hope_assessment", id, {
              assessmentId: id,
              sfvId: sfv.id,
              maxSeverity: signed.j2051MaxSeverity ?? "none",
              triggeredAt: sfv.triggeredAt.toISOString(),
              dueAt: sfv.dueAt.toISOString(),
            });
          }
        }
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
    async correctTimepoint(organizationId, userId, id, args: CorrectTimepointArgs) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
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
        await assertNoPendingLineageOperation(t, id);
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
            originalAssessmentId: id,
          },
        );
        return toAssessmentView(correction);
      });
    },

    async inactivateTimepoint(organizationId, userId, id, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
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
        await assertNoPendingLineageOperation(t, id);
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
          { inactivationAssessmentId: inactivation.id, targetAssessmentId: id },
        );
        return toAssessmentView(inactivation);
      });
    },

    // ── Request the printable HOPE summary (§4.5 — emits summary_requested; M22 renders) ─────────────
    async requestSummaryPdf(organizationId, userId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadA(t, id); // 404 before emit if absent/cross-tenant
        await emit(t, organizationId, "m10.hope.summary_requested", "hope_assessment", id, {
          assessmentId: id,
          requestedBy: userId,
          // F-099 — the chart target. M22 files a render against `document.patient_id`, and it reads the
          // value off THIS payload; the row was already loaded for the 404, so carrying it costs no query.
          // Without it the summary rendered patient-independent — on no chart, for a patient-scoped record.
          patientId: a.patientId,
        });
        return { assessmentId: id, requested: true as const };
      });
    },

    // ── iQIES submission retry / assemble (§2.2.4) ───────────────────────────────────────────────────
    async retrySubmission(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t.select().from(SUB).where(eq(SUB.id, id)).limit(1)) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        require_(
          r.status === "rejected",
          "M10_SUBMISSION_RETRY_NOT_REJECTED",
          `Submission ${id} is ${r.status}; only a rejected submission can be retried.`,
        );
        const rows = (await t
          .update(SUB)
          .set({ status: "queued", updatedAt: new Date() })
          .where(eq(SUB.id, id))
          .returning()) as SubmissionRow[];
        await emit(t, organizationId, "m10.hope.submission_queued", "hope_submission", id, {
          submissionId: id,
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
    async assembleSubmission(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const period = new Date().toISOString().slice(0, 7);
        const candidates = (await t
          .select()
          .from(ASSESS)
          .where(
            and(
              eq(ASSESS.organizationId, organizationId),
              eq(ASSESS.providerEntityId, providerEntityId),
              eq(ASSESS.status, "signed"),
            ),
          )
          .orderBy(asc(ASSESS.signedAt), asc(ASSESS.id))) as AssessmentRow[];
        const eligible: AssessmentRow[] = [];
        for (const candidate of candidates) {
          if (!candidate.specVersionId || !candidate.isc) continue;
          const existing = await t
            .select({ item: SUBITEM, submissionStatus: SUB.status })
            .from(SUBITEM)
            .innerJoin(SUB, eq(SUB.id, SUBITEM.hopeSubmissionId))
            .where(
              and(
                eq(SUBITEM.hopeAssessmentId, candidate.id),
                inArray(SUBITEM.itemStatus, ["pending", "accepted", "accepted_with_warnings"]),
              ),
            )
            .limit(1);
          if (candidate.iqiesRecordId || existing[0]) continue;
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
        const filename = submissionPackageName(providerEntityId, period, row.id);
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
          .returning()) as SubmissionRow[];
        await emit(t, organizationId, "m10.hope.submission_queued", "hope_submission", row.id, {
          submissionId: row.id,
          providerEntityId,
          transportMode: "manual_iqies_upload",
          itemCount: serialized.length,
          packageSha256: zip.sha256,
        });
        return toSubmissionView(packaged ?? row);
      });
    },
    async downloadSubmissionPackage(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t.select().from(SUB).where(eq(SUB.id, id)).limit(1)) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        const bytes = packageBytesFromReport(r.acceptanceReport);
        if (!bytes || !r.packageFilename)
          throw new ConflictError("HOPE submission package is not available");
        await t
          .update(SUB)
          .set({
            status: "exported",
            exportedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(SUB.id, id));
        return {
          filename: r.packageFilename,
          contentType: "application/zip",
          bytes,
        };
      });
    },
    async markSubmissionUploaded(organizationId, userId, id, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t.select().from(SUB).where(eq(SUB.id, id)).limit(1)) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        if (r.status !== "packaged" && r.status !== "exported") {
          throw new ConflictError(
            `Submission ${id} is ${r.status}; only packaged/exported batches can be marked uploaded`,
          );
        }
        const at = args.submittedAt ? new Date(args.submittedAt) : new Date();
        const [updated] = (await t
          .update(SUB)
          .set({
            status: "submitted_pending_result",
            transmittedAt: at,
            submittedAt: at,
            submittedByMembershipId: userId,
            iqiesSubmissionReference: args.iqiesSubmissionReference ?? null,
            updatedAt: new Date(),
          })
          .where(eq(SUB.id, id))
          .returning()) as SubmissionRow[];
        await emit(t, organizationId, "m10.hope.submission_transmitted", "hope_submission", id, {
          submissionId: id,
          transportMode: "manual_iqies_upload",
          submittedAt: at.toISOString(),
        });
        return toSubmissionView(
          firstOrThrow(updated ? [updated] : [], "markSubmissionUploaded matched no row"),
        );
      });
    },
    async importSubmissionResult(organizationId, userId, id, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t.select().from(SUB).where(eq(SUB.id, id)).limit(1)) as SubmissionRow[];
        if (!r) throw new NotFoundError(`HOPE submission ${id} not found`);
        const reportHash = createHash("sha256").update(JSON.stringify(args.results)).digest("hex");
        const items = await t.select().from(SUBITEM).where(eq(SUBITEM.hopeSubmissionId, id));
        const byAssessmentId = new Map(items.map((item) => [item.hopeAssessmentId, item]));
        let accepted = 0;
        let rejected = 0;
        let warnings = 0;
        for (const raw of args.results) {
          const assessmentId = typeof raw.assessmentId === "string" ? raw.assessmentId : null;
          const item = assessmentId ? byAssessmentId.get(assessmentId) : null;
          const resultStatus = cmsResultStatus(raw);
          if (item) {
            if (resultStatus === "accepted") accepted += 1;
            if (resultStatus === "accepted_with_warnings") {
              accepted += 1;
              warnings += 1;
            }
            if (resultStatus === "rejected") rejected += 1;
            await t
              .update(SUBITEM)
              .set({
                itemStatus: resultStatus === "pending" ? "pending" : resultStatus,
                iqiesRecordId:
                  typeof raw.iqiesRecordId === "string" ? raw.iqiesRecordId : item.iqiesRecordId,
                iqiesValidationResult: raw,
                processedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(SUBITEM.id, item.id));
            if (
              (resultStatus === "accepted" || resultStatus === "accepted_with_warnings") &&
              typeof raw.iqiesRecordId === "string"
            ) {
              await t
                .update(ASSESS)
                .set({
                  iqiesRecordId: raw.iqiesRecordId,
                  updatedAt: new Date(),
                })
                .where(eq(ASSESS.id, item.hopeAssessmentId));
            }
          }
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
              processedAt: new Date(),
            })
            .onConflictDoNothing();
        }
        const status =
          rejected > 0 && accepted > 0
            ? "partially_accepted"
            : rejected > 0
              ? "rejected"
              : warnings > 0
                ? "accepted_with_warnings"
                : "accepted";
        const [updated] = (await t
          .update(SUB)
          .set({
            status,
            acceptedCount: accepted,
            rejectedCount: rejected,
            acceptedAt: rejected === 0 ? new Date() : null,
            resultImportedAt: new Date(),
            resultImportedByMembershipId: userId,
            resultReportHash: reportHash,
            acceptanceReport: {
              reportReference: args.reportReference ?? null,
              reportHash,
              results: args.results,
            },
            updatedAt: new Date(),
          })
          .where(eq(SUB.id, id))
          .returning()) as SubmissionRow[];
        await emit(
          t,
          organizationId,
          rejected > 0 ? "m10.hope.submission_rejected" : "m10.hope.submission_accepted",
          "hope_submission",
          id,
          {
            submissionId: id,
            // F-150 (#248) — only `submission_accepted`'s catalog schema requires this; harmless extra
            // field on the `submission_rejected` branch (its schema doesn't declare it).
            providerEntityId: updated?.providerEntityId,
            acceptedCount: accepted,
            rejectedCount: rejected,
            reportHash,
          },
        );
        return toSubmissionView(
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
