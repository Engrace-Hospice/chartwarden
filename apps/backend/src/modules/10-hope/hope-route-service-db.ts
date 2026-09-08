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
// (2) the D8 PPS/ESAS-r snapshot is skipped (null) — it needs M9's LatestAssessmentProvider, not threaded
// here (§7.13: no external dependency blocks the write path); (3) provider/location siting is null; the
// SFV `alert_cadence` is a minimal default until the alert planner is threaded. A correction REUSES the
// original's `target_date` (the composite self-FK `(corrects_assessment_id, target_date) → (id,
// target_date)` demands it); the DB supersede trigger flips the original.
import {
  type J2051SymptomReading,
  assertCaptureAllowed,
  evaluateJ2051Trigger,
  planSfvCompletion,
  planSfvCreation,
  require_,
} from "@wardenx/hope";
import { withOrgContext } from "@wardenx/tenancy";
import type { HopeRfaKind, J2051Severity, LatestAssessment, ScaleType } from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "./abac-predicates";
import { createHopeAssessmentAnswerService } from "./hope-answer-service";
import { createHopeAdmissionPrefillService } from "./hope-admission-prefill-service";
import {
  createHopeAssessmentAnswerWriter,
  initializeHopeCorrection,
  initializeNewHopeRecord,
} from "./hope-record-initializer";
import { createHopeSpecRegistry } from "./hope-spec-registry";
import { createHopeValidationService } from "./hope-validation-service";
import type {
  CorrectTimepointArgs,
  HopeAssessmentView,
  HopeComplianceView,
  HopeRouteService,
  HopeScheduleView,
  HopeSfvView,
  HopeSubmissionView,
  HopeWorkflowStateView,
  RecordSfvArgs,
  RecordTimepointArgs,
} from "./routes/service";
import { buildWorkflowState } from "./routes/service";

const ASSESS = schema.hopeAssessments;
const SCHED = schema.hopeTimepointSchedules;
const SFV = schema.symptomFollowUpVisits;
const SUB = schema.hopeSubmissions;
const FINDING = schema.hopeValidationFindings;
const ANSWER = schema.hopeAssessmentAnswers;
const ITEM = schema.hopeSpecItems;
const answerWriter = createHopeAssessmentAnswerWriter();

type ScheduleRow = typeof SCHED.$inferSelect;
type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;
type SubmissionRow = typeof SUB.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The transactional-outbox port (§2.4): the bound publisher validates every emit against the boot
 * catalog and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests
 * commit without a dispatcher. Mirrors M7/M8/M9. */
export interface HopeWriteOutboxPort {
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

/** The §D8 scales snapshotted at HOPE sign — skipped in the DB backend (M9 seam not threaded; §7.13). */
const j2051EntriesOf = (data: Record<string, unknown>): J2051SymptomReading[] => {
  const j = (data as { J?: { J2051?: { entries?: unknown } } }).J?.J2051?.entries;
  if (!Array.isArray(j)) return [];
  return j.flatMap((e) =>
    e && typeof e === "object" && typeof (e as { severity?: unknown }).severity === "string"
      ? [
          {
            symptomCode: String((e as { symptomCode?: unknown }).symptomCode ?? "other"),
            severity: (e as { severity: J2051Severity }).severity,
          },
        ]
      : [],
  );
};

const J2051_ITEM_CODES = ["J2051A", "J2051B", "J2051C", "J2051D", "J2051E", "J2051F", "J2051G", "J2051H"];
const J2051_VALUE_TO_SEVERITY: Record<string, J2051Severity | null> = {
  "0": "none",
  "1": "mild",
  "2": "moderate",
  "3": "severe",
  "9": null,
};

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
  itemCount: r.itemCount,
  acceptedCount: r.acceptedCount,
  rejectedCount: r.rejectedCount,
  transmittedAt: iso(r.transmittedAt),
  acceptedAt: iso(r.acceptedAt),
});

/**
 * The production, RLS-backed HopeRouteService + HopeAbacResolver (one object). Reads are real; writes
 * fail-closed 501. Org is bound from the request context by the caller and passed as `organizationId` —
 * never the body. Every read runs under `withOrgContext` so RLS scopes rows to the active org.
 */
export function createDbHopeBackend(
  db: DbClient,
  outbox: HopeWriteOutboxPort = NOOP_OUTBOX,
): HopeRouteService {
  const answerService = createHopeAssessmentAnswerService(db);
  const validationService = createHopeValidationService(db);
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

  async function canonicalJ2051Entries(
    tx: DbClient,
    assessmentId: string,
  ): Promise<J2051SymptomReading[] | null> {
    const rows = await tx
      .select({ itemCode: ITEM.itemCode, state: ANSWER.state, value: ANSWER.value })
      .from(ANSWER)
      .innerJoin(ITEM, eq(ITEM.id, ANSWER.specItemId))
      .where(
        and(
          eq(ANSWER.hopeAssessmentId, assessmentId),
          inArray(ITEM.itemCode, ["J2050A", ...J2051_ITEM_CODES]),
        ),
      );
    if (rows.length === 0) return null;
    if (rows.some((row) => row.itemCode === "J2050A" && row.state === "answered" && row.value === "0")) {
      return [];
    }
    return rows.flatMap((row) => {
      if (row.itemCode === "J2050A" || row.state !== "answered") return [];
      const value = typeof row.value === "string" ? row.value : null;
      const severity = value ? J2051_VALUE_TO_SEVERITY[value] : null;
      return severity ? [{ symptomCode: row.itemCode, severity }] : [];
    });
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
    async listSfv(organizationId, state) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx.select().from(SFV)) as SfvRow[];
        const sfvs = rows.filter((r) => !state || r.status === state).map(toSfvView);
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
        const sfvAll = (await tx.select({ status: SFV.status }).from(SFV)) as { status: string }[];
        const sfvOnTime = sfvAll.filter((s) => s.status === "completed").length;
        const sfvDenom = sfvAll.filter(
          (s) => s.status === "completed" || s.status === "missed",
        ).length;
        const subsAll = (await tx
          .select({ status: SUB.status, providerEntityId: SUB.providerEntityId })
          .from(SUB)) as { status: string; providerEntityId: string }[];
        const subs = subsAll.filter(
          (s) => !providerEntityId || s.providerEntityId === providerEntityId,
        );
        const accepted = subs.filter((s) => s.status === "accepted").length;
        return {
          providerEntityId: providerEntityId ?? null,
          hopeOnTimeRate: denom === 0 ? 1 : completed / denom,
          sfvOnTimeRate: sfvDenom === 0 ? 1 : sfvOnTime / sfvDenom,
          submissionAcceptanceRate: subs.length === 0 ? 1 : accepted / subs.length,
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

    // ── Schedule count for an admission (read; regeneration itself is a write, deferred) ────────────
    async regenerateSchedules(organizationId, admissionId) {
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
          .limit(1)) as { patientId: string; signedByMembershipId: string | null }[];
        if (!r) return null; // absent / cross-tenant → deny
        return { patientId: r.patientId, originalSignedBy: r.signedByMembershipId ?? null };
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
          .set({ status: "skipped", skipReasonCode: reasonCode, updatedAt: new Date() })
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
          args.rfaKind === "01_admission"
            ? await getSeam("AdmissionStatusReader").getAdmissionSummary(organizationId, admissionId)
            : null;
        if (admissionSummary && admissionSummary.organizationId !== organizationId) {
          throw new NotFoundError(`Admission ${admissionId} not found`);
        }
        const regulatoryTargetDate = admissionSummary?.admissionAt ?? args.targetDate;
        const init = await initializeNewHopeRecord(createHopeSpecRegistry(t), {
          rfaKind: args.rfaKind,
          targetDate: regulatoryTargetDate,
        });
        // Link the draft to the open schedule for (admission, rfa) so the sign trigger can close it.
        const [sched] = (await t
          .select()
          .from(SCHED)
          .where(
            and(
              eq(SCHED.admissionId, admissionId),
              eq(SCHED.rfaKind, args.rfaKind),
              eq(SCHED.status, "open"),
            ),
          )
          .limit(1)) as ScheduleRow[];
        let capture: { wasLate: boolean; lateReasonCode: string | null } = {
          wasLate: false,
          lateReasonCode: null,
        };
        if (sched) {
          capture = assertCaptureAllowed(
            regulatoryTargetDate,
            {
              windowOpensAt: sched.windowOpensAt.toISOString(),
              windowClosesAt: sched.windowClosesAt.toISOString(),
              lateDeadlineAt: sched.lateDeadlineAt.toISOString(),
            },
            {
              lateReasonCode: args.lateCompletionReasonCode,
              adminOverride: args.adminOverride,
            },
          );
        }
        const row = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: admissionSummary?.patientId ?? sched?.patientId ?? admissionId,
              admissionId,
              scheduleId: sched?.id ?? null,
              rfaKind: args.rfaKind,
              specVersionId: init.specVersionId,
              isc: init.isc,
              status: "draft",
              data: args.data,
              providerEntityId: admissionSummary?.providerEntityId ?? null,
              locationId: admissionSummary?.locationId ?? null,
              dischargeReason: args.dischargeReason as AssessmentRow["dischargeReason"],
              targetDate: new Date(regulatoryTargetDate),
              sourceEncounterId: args.sourceEncounterId ?? null,
              wasLate: capture.wasLate,
              lateCompletionReasonCode: capture.lateReasonCode,
              createdByMembershipId: userId,
            })
            .returning(),
          "hope_assessment insert returned no row",
        );
        await answerWriter.writeDerivedControlAnswers(t, {
          organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          hopeAssessmentId: row.id,
          specVersionId: init.specVersionId,
          controlAnswers: init.controlAnswers,
        });
        await admissionPrefillService.prefillAdmission({
          tx: t,
          organizationId,
          assessment: row,
          specVersionCode: init.specVersionCode,
          admissionDate: regulatoryTargetDate.slice(0, 10),
        });
        return toAssessmentView(row);
      });
      if (view.rfaKind === "01_admission" && view.regulatory.isc === "HA") {
        await validationService.validateAssessment({ organizationId, assessmentId: view.id, mode: "draft" });
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
        const at = new Date();
        // Insert the signed RFA-04 row, then complete the open SFV (the §4.4 guards live in planSfvCompletion).
        const row = firstOrThrow(
          await t
            .insert(ASSESS)
            .values({
              organizationId,
              patientId: sfv.patientId,
              admissionId,
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
          { id: sfv.id, status: sfv.status, dueAt: iso(sfv.dueAt) ?? at.toISOString() },
          row.id,
          args.targetDate,
          { adminOverride: args.adminOverride },
        );
        await t
          .update(SFV)
          .set({
            status: "completed",
            completingAssessmentId: plan.completingAssessmentId,
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(SFV.id, sfv.id));
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
      return answerService.getWorkspace(organizationId, id);
    },

    async patchAssessmentAnswers(organizationId, userId, id, input) {
      return answerService.patchAnswers(organizationId, userId, id, input);
    },

    // ── Sign a draft (§2.2.2 — server-authoritative J2051 verdict; triggers close the schedule + open the SFV) ─
    async signTimepoint(organizationId, userId, id) {
      // GAP-019 — the D8 clinical-context snapshot and the siting the compensating finding needs both
      // come from OTHER modules' seams, each of which opens its own tenant context. They are resolved
      // here, before the write transaction, and the assessment is re-read inside it so the draft guard
      // and the UPDATE still see one consistent row.
      const pre = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        loadA(tx as unknown as DbClient, id),
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
        const r = await loadA(t, id);
        require_(
          r.status === "draft",
          "M10_CORRECTION_TARGET_NOT_SIGNED",
          `Assessment ${id} is not a draft and cannot be signed.`,
        );
        const at = new Date();
        const canonicalJ2051 =
          (await canonicalJ2051Entries(t, id)) ?? j2051EntriesOf(r.data as Record<string, unknown>);
        const verdict = evaluateJ2051Trigger({ entries: canonicalJ2051 }); // D4
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
              j2051MaxSeverity: verdict.maxSeverity ?? "none",
              j2051TriggerFired: verdict.triggerFired,
              version: r.version + 1,
              updatedAt: at,
            })
            .where(eq(ASSESS.id, id))
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
          j2051TriggerFired: verdict.triggerFired,
          wasLate: r.wasLate,
        });
        if (verdict.triggerFired) {
          // D4 — exactly one SFV per source timepoint; due_at anchored to the ASSESSMENT date, never
          // the signature (ADR-0018 D1 — a late signing must not extend the federal window).
          const descriptor = planSfvCreation({
            triggeringAssessmentId: id,
            assessmentDate: r.targetDate.toISOString(),
            signedAt: at.toISOString(),
            timeZone: "UTC",
          });
          const sfv = firstOrThrow(
            await t
              .insert(SFV)
              .values({
                organizationId,
                patientId: r.patientId,
                admissionId: r.admissionId,
                triggeringAssessmentId: id,
                status: "open",
                triggeredAt: new Date(descriptor.triggeredAt),
                dueAt: new Date(descriptor.dueAt),
                alertCadence: {}, // minimal default until the §4.9 alert planner is threaded
              })
              .returning({ id: SFV.id }),
            "symptom_follow_up_visit insert returned no row",
          );
          await emit(t, organizationId, "m10.hope.j2051_trigger_fired", "hope_assessment", id, {
            assessmentId: id,
            sfvId: sfv.id,
            maxSeverity: verdict.maxSeverity ?? "none",
            triggeredAt: descriptor.triggeredAt,
            dueAt: descriptor.dueAt,
          });
          await emit(t, organizationId, "m10.hope.sfv_created", "symptom_follow_up_visit", sfv.id, {
            sfvId: sfv.id,
            triggeringAssessmentId: id,
            dueAt: descriptor.dueAt,
          });
        }
        return toAssessmentView(signed);
      });
    },

    // ── Correct a signed timepoint (§2.4 / D7 — append-only; the DB supersede trigger flips the original) ─
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
              status: "signed",
              data: args.data,
              // The composite self-FK forces the correction to REUSE the original's target_date.
              targetDate: original.targetDate,
              j2051MaxSeverity: original.j2051MaxSeverity,
              j2051TriggerFired: original.j2051TriggerFired,
              wasLate: original.wasLate,
              clinicalContextSnapshot: original.clinicalContextSnapshot,
              signedAt: at,
              signedByMembershipId: userId,
              createdByMembershipId: userId,
              correctsAssessmentId: id, // the AFTER-INSERT supersede trigger flips the original
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

    // ── Request the printable HOPE summary (§4.5 — emits summary_requested; M22 renders) ─────────────
    async requestSummaryPdf(organizationId, userId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadA(t, id); // 404 before emit if absent/cross-tenant
        await emit(t, organizationId, "m10.hope.summary_requested", "hope_assessment", id, {
          assessmentId: id,
          requestedBy: userId,
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
    async assembleSubmission(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const period = new Date().toISOString().slice(0, 7);
        const row = firstOrThrow(
          await t
            .insert(SUB)
            .values({
              organizationId,
              providerEntityId,
              submissionPeriod: period,
              status: "queued",
              itemCount: 0,
            })
            .returning(),
          "hope_submission insert returned no row",
        );
        await emit(t, organizationId, "m10.hope.submission_queued", "hope_submission", row.id, {
          submissionId: row.id,
          providerEntityId,
          itemCount: 0,
        });
        return toSubmissionView(row);
      });
    },

    // No in-process outbox buffer in the DB backend (the transactional relay owns emission) — drain empty.
    drainEvents() {
      return [];
    },
  };
}
