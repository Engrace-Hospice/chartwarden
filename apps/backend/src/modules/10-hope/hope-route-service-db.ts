// apps/backend/src/modules/10-hope — PRODUCTION HopeRouteService, READ-first (M10L wiring, mirrors M6L-T01).
//
// The screen-driving READS (timepoint-schedule worklist, HOPE assessment chart + detail, SFV worklist,
// iQIES submission list/detail, pre-submission validation findings, the compliance dashboard) run as real
// Drizzle queries over the M10-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role. `hope_assessment` is PARTITION BY RANGE
// (target_date) — reads query the parent table. The full WRITE lifecycle (record/sign/correct timepoint,
// SFV completion, submission assemble/retry, summary-PDF request, schedule skip, with the `m10.hope.*`
// outbox) is the follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is
// satisfied and the mount is real. `createInMemoryHopeBackend` (`routes/service.ts`) stays the behavioral
// reference for those writes.
//
// The backend object IS BOTH the HopeRouteService AND the §4.7 HopeAbacResolver (the scaffold mounts M10
// as `registerHopeRoutes(app, { service })` + `registerHopeAbacPredicates({ resolver })` over one object):
// `loadAssessment` reads the corrected-of-record signer facts org-scoped (RLS-backstopped), returning
// `null` on an absent / cross-tenant row so the correction predicate fails closed.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "./abac-predicates";
import type {
  HopeAssessmentView,
  HopeComplianceView,
  HopeRouteService,
  HopeScheduleView,
  HopeSfvView,
  HopeSubmissionView,
} from "./routes/service";

const ASSESS = schema.hopeAssessments;
const SCHED = schema.hopeTimepointSchedules;
const SFV = schema.symptomFollowUpVisits;
const SUB = schema.hopeSubmissions;
const FINDING = schema.hopeValidationFindings;

type ScheduleRow = typeof SCHED.$inferSelect;
type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;
type SubmissionRow = typeof SUB.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A never-returning stub for the M10 write lifecycle still owed by the follow-up Drizzle wiring. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "HOPE writes arrive in the M10L follow-up (the Drizzle write lifecycle)",
    501,
  );
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
  version: 1,
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
export function createDbHopeBackend(db: DbClient): HopeRouteService {
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
        const [r] = (await tx.select().from(SCHED).where(eq(SCHED.id, id)).limit(1)) as ScheduleRow[];
        if (!r) throw new NotFoundError(`HOPE schedule ${id} not found`);
        return toScheduleView(r);
      });
    },

    // ── HOPE assessment reads (parent of the partitioned hope_assessment) ──────────────────────────
    async getAssessment(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx.select().from(ASSESS).where(eq(ASSESS.id, id)).limit(1)) as AssessmentRow[];
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
    async getValidation(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [a] = (await tx.select({ id: ASSESS.id }).from(ASSESS).where(eq(ASSESS.id, id)).limit(1)) as {
          id: string;
        }[];
        if (!a) throw new NotFoundError(`HOPE assessment ${id} not found`);
        const rows = await tx
          .select({ ruleId: FINDING.ruleId, severity: FINDING.severity, message: FINDING.message })
          .from(FINDING)
          .where(eq(FINDING.hopeAssessmentId, id));
        return { assessmentId: id, findings: rows.map((f) => ({ ruleId: f.ruleId, severity: String(f.severity), message: f.message })) };
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
        const scheds = (await tx.select({ status: SCHED.status }).from(SCHED)) as { status: string }[];
        const completed = scheds.filter((s) => s.status === "completed").length;
        const expired = scheds.filter((s) => s.status === "expired").length;
        const denom = completed + expired;
        const sfvAll = (await tx.select({ status: SFV.status }).from(SFV)) as { status: string }[];
        const sfvOnTime = sfvAll.filter((s) => s.status === "completed").length;
        const sfvDenom = sfvAll.filter((s) => s.status === "completed" || s.status === "missed").length;
        const subsAll = (await tx
          .select({ status: SUB.status, providerEntityId: SUB.providerEntityId })
          .from(SUB)) as { status: string; providerEntityId: string }[];
        const subs = subsAll.filter((s) => !providerEntityId || s.providerEntityId === providerEntityId);
        const accepted = subs.filter((s) => s.status === "accepted").length;
        return {
          providerEntityId: providerEntityId ?? null,
          hopeOnTimeRate: denom === 0 ? 1 : completed / denom,
          sfvOnTimeRate: sfvDenom === 0 ? 1 : sfvOnTime / sfvDenom,
          submissionAcceptanceRate: subs.length === 0 ? 1 : accepted / subs.length,
        };
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

    // ── §4.7 ABAC resolver — the correction predicate's original-signer facts (fail-closed on absent) ─
    async loadAssessment(organizationId, assessmentId): Promise<HopeAssessmentAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select({ signedByMembershipId: ASSESS.signedByMembershipId })
          .from(ASSESS)
          .where(and(eq(ASSESS.id, assessmentId), eq(ASSESS.organizationId, organizationId)))
          .limit(1)) as { signedByMembershipId: string | null }[];
        if (!r) return null; // absent / cross-tenant → deny
        return { originalSignedBy: r.signedByMembershipId ?? null };
      });
    },

    // ── Writes — the M10L follow-up Drizzle lifecycle. Fail-closed 501 until then. ──────────────────
    skipSchedule: async () => notImpl(),
    recordTimepoint: async () => notImpl(),
    recordSfv: async () => notImpl(),
    updateDraft: async () => notImpl(),
    signTimepoint: async () => notImpl(),
    correctTimepoint: async () => notImpl(),
    requestSummaryPdf: async () => notImpl(),
    retrySubmission: async () => notImpl(),
    assembleSubmission: async () => notImpl(),

    // No in-process outbox buffer in the DB backend (the transactional relay owns emission) — drain empty.
    drainEvents() {
      return [];
    },
  };
}
