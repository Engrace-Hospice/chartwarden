// apps/backend/src/modules/15-discipline-care-plans/seams/drizzle-store.ts — the Drizzle-backed
// {@link DisciplinePlanSeamStore} the seven §4.3 published seams read through (TASK-002; the M21
// `store-drizzle.ts` pattern over M15's eleven tables, migrations 0098–0099).
//
// TENANCY. Reads keyed on a subject id open `withOrgContextFromRequest`, which pins `app.org_id` from the
// CONSUMER'S ambient request context — M15's seams never switch tenants; RLS scopes every statement (§3.6).
// Called outside a request scope, those reads THROW rather than reading unscoped. The scope-parameter
// aggregates (`overdueSupervisoryClocks`, `complianceCounts`) carry `scope.orgId` explicitly, so they open
// `withOrgContext` on that org AND keep an explicit `organization_id` predicate as the second wall — the
// M30 recompute worker calls them per-org from a job, where there is no ambient request.
//
// FAIL DIRECTION, preserved from the port contract (seams/store.ts):
//   • `gatesForMembership` is the ONE read that catches its own failure and answers `null` — §8.7 turns
//     that into the fail-CLOSED `isActive:false` + `service_unavailable` sentinel. An ABSENT gate row is
//     NOT an active gate: it comes back as an empty slice, and `effectiveStatusFor` fails the missing kind.
//   • `volunteerHourTotals.staffPatientCareMinutes` stays `null` while the M27 patient-care-HOURS seam is
//     unbound (M15-F04), so `computeVolunteerHourRatio` badges `unavailable` — never a fabricated 0% CoP
//     breach. The optional `staffPatientCareMinutes` dep is where the M27 bind attaches later.
//   • Every other read propagates a store failure (the supervisory readers' contracts use `null` for "no
//     obligation armed", and an outage must not impersonate that answer).
//
// DERIVATIONS STAY IN THE DOMAIN. The store returns raw clock columns and count pairs; the §7.1 ladder,
// the D10 initial clocks and the 418.78 gate derivation run through `../lifecycle` / `../volunteer`
// (`evaluateInitialClock`, `effectiveStatusFor`) — never re-implemented in SQL — so "day 12 warn / day 14
// red / day 16 block" has one implementation whichever surface reads it.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  ComplianceScope,
  DisciplineAssessmentDto,
  DisciplineGoalDto,
  DisciplineInterventionDto,
  DisciplinePlanDigest,
  DisciplinePlanFull,
  DisciplinePlanIdgDigest,
  DisciplineRequiredSignerSet,
  IsoInstant,
  MembershipId,
  MswRiskFactor,
} from "@wardenx/types";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import {
  evaluateInitialClock,
  evaluateSupervisoryCadence,
  resolveRequiredSignerSet,
} from "../lifecycle/index";
import { type VolunteerGateFacts, effectiveStatusFor } from "../volunteer/index";
import type {
  DisciplineComplianceCounts,
  DisciplinePlanSeamStore,
  RateCounts,
  SupervisoryClockRow,
  VolunteerHourTotals,
} from "./store";

type PlanRow = typeof schema.disciplineCarePlan.$inferSelect;
type GoalRow = typeof schema.disciplineGoal.$inferSelect;
type InterventionRow = typeof schema.disciplineIntervention.$inferSelect;
type AssessmentRow = typeof schema.disciplineAssessment.$inferSelect;
type GateRow = typeof schema.volunteerComplianceGate.$inferSelect;

const MS_PER_DAY = 86_400_000;

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;
const isoN = (d: Date | string | null): IsoInstant | null => (d === null ? null : iso(d));
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Deps the composition root may override (tests inject a deterministic clock; the M27 bind lands here). */
export interface DrizzleDisciplinePlanSeamDeps {
  readonly now?: () => IsoInstant;
  /**
   * The M27 patient-care-HOURS denominator for the 418.78(e) ratio (M15-F04 — hours, never dollars).
   * Unbound ⇒ `null` ⇒ the provider's honest `unavailable` badge, never a fabricated 0%.
   */
  readonly staffPatientCareMinutes?: (input: {
    providerEntityId: string;
    fiscalYear: number;
  }) => Promise<number | null>;
}

/** Build the Drizzle-backed §4.3 seam store over M15's tables. */
export function createDrizzleDisciplinePlanSeamStore(
  db: DbClient,
  deps: DrizzleDisciplinePlanSeamDeps = {},
): DisciplinePlanSeamStore {
  const P = schema.disciplineCarePlan;
  const V = schema.disciplineCarePlanVersion;
  const G = schema.disciplineGoal;
  const I = schema.disciplineIntervention;
  const A = schema.disciplineAssessment;
  const SV = schema.aideSupervisoryVisit;
  const VA = schema.volunteerAssignment;
  const GATE = schema.volunteerComplianceGate;
  const LEDGER = schema.volunteerHourLedger;

  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  const staffMinutes = deps.staffPatientCareMinutes ?? (async () => null);

  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

  /** The newest SIGNED version per plan, in one round-trip (never N+1). The digest's `lastSigned*` pair
   *  is not a plan column — it is the max-sequence version row carrying a `signed_at`. */
  async function lastSignedByPlan(
    tx: Tx,
    planIds: readonly string[],
  ): Promise<Map<string, { versionId: string; signedAt: IsoInstant }>> {
    if (planIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: V.id, planId: V.planId, sequence: V.sequence, signedAt: V.signedAt })
      .from(V)
      .where(and(inArray(V.planId, [...planIds]), isNotNull(V.signedAt)));
    const best = new Map<string, { versionId: string; signedAt: IsoInstant; sequence: number }>();
    for (const row of rows) {
      if (row.signedAt === null) continue;
      const prior = best.get(row.planId);
      if (prior === undefined || row.sequence > prior.sequence) {
        best.set(row.planId, {
          versionId: row.id,
          signedAt: iso(row.signedAt),
          sequence: row.sequence,
        });
      }
    }
    return new Map(
      [...best].map(([k, v]) => [k, { versionId: v.versionId, signedAt: v.signedAt }]),
    );
  }

  const digestOf = (
    r: PlanRow,
    lastSigned: { versionId: string; signedAt: IsoInstant } | undefined,
  ): DisciplinePlanDigest => ({
    planId: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    providerEntityId: r.providerEntityId,
    locationId: r.locationId,
    kind: r.kind,
    status: r.status,
    lastSignedVersionId: lastSigned?.versionId ?? null,
    lastSignedAt: lastSigned?.signedAt ?? null,
    nextSupervisoryDueAt: isoN(r.nextSupervisoryDueAt),
    initialAssessmentSignedAt: isoN(r.initialAssessmentSignedAt),
    spiritualCareDeclinedAt: isoN(r.spiritualCareDeclinedAt),
  });

  const clockRowOf = (r: PlanRow): SupervisoryClockRow => ({
    planId: r.id,
    nextSupervisoryDueAt: isoN(r.nextSupervisoryDueAt),
    cadenceDaysOverride: r.supervisoryCadenceDaysOverride ?? null,
    patientId: r.patientId,
    admissionId: r.admissionId,
    providerEntityId: r.providerEntityId,
    locationId: r.locationId,
    aideMembershipId: (r.aideMembershipId ?? null) as MembershipId | null,
    supervisingRnMembershipId: (r.supervisingRnMembershipId ?? null) as MembershipId | null,
  });

  const toGoalDto = (r: GoalRow): DisciplineGoalDto => ({
    id: r.id,
    planId: r.planId,
    parentGoalId: r.parentGoalId ?? null,
    parentProblemId: r.parentProblemId ?? null,
    source: r.source,
    status: r.status,
    originalText: r.originalText,
    revisedText: r.revisedText ?? null,
    measurableOutcome: r.measurableOutcome ?? null,
    targetAt: isoN(r.targetAt),
    frequencyValue: r.frequencyValue ?? null,
    modalityText: r.modalityText ?? null,
    actingConsentId: r.actingConsentId ?? null,
    addedByMembershipId: r.addedByMembershipId as MembershipId,
    addedByDiscipline: r.addedByDiscipline as DisciplineGoalDto["addedByDiscipline"],
  });

  const toInterventionDto = (r: InterventionRow): DisciplineInterventionDto => ({
    id: r.id,
    planId: r.planId,
    parentInterventionId: r.parentInterventionId ?? null,
    goalRefs: strArray(r.goalRefs),
    scopeText: r.scopeText,
    frequencyText: r.frequencyText,
    frequencyValue: r.frequencyValue,
    discipline: r.discipline as DisciplineInterventionDto["discipline"],
    responsibleRoles: strArray(r.responsibleRoles),
    status: r.status,
    discontinuationReason: r.discontinuationReason ?? null,
  });

  // Header-only by construction (§2.3): the per-kind `data` body never enters the DTO — the seam carries
  // the SUD / family-violence FLAGS, and the free text stays behind the module's own consented read path.
  const toAssessmentDto = (r: AssessmentRow): DisciplineAssessmentDto => ({
    id: r.id,
    planId: r.planId,
    kind: r.kind,
    status: r.status,
    capturedAt: iso(r.capturedAt),
    isInitial: r.isInitial,
    sudFlag: r.sudFlag,
    familyViolenceFlag: r.familyViolenceFlag,
    amendsAssessmentId: r.amendsAssessmentId ?? null,
    signedAt: isoN(r.signedAt),
  });

  const toGateFacts = (r: GateRow): VolunteerGateFacts => ({
    gateId: r.id,
    volunteerMembershipId: r.volunteerMembershipId as MembershipId,
    gateKind: r.gateKind,
    status: r.status,
    validFrom: iso(r.validFrom),
    validUntil: isoN(r.validUntil),
    revokedAt: isoN(r.revokedAt),
  });

  /** The sealed D11 quorum off the newest version that carries one; the pure catalog default otherwise
   *  (a plan with no sealed version yet still answers its kind's declared quorum — policy, not fabrication). */
  async function requiredSignerSetFor(tx: Tx, plan: PlanRow): Promise<DisciplineRequiredSignerSet> {
    const rows = await tx
      .select({ sequence: V.sequence, requiredSignerSet: V.requiredSignerSet })
      .from(V)
      .where(and(eq(V.planId, plan.id), isNotNull(V.requiredSignerSet)));
    const newest = rows.reduce<(typeof rows)[number] | null>(
      (best, row) => (best === null || row.sequence > best.sequence ? row : best),
      null,
    );
    if (newest?.requiredSignerSet != null) {
      return newest.requiredSignerSet as DisciplineRequiredSignerSet;
    }
    return resolveRequiredSignerSet(plan.kind, "initial");
  }

  /** The org + optional PE/location walls for a scope-parameter aggregate (M15-F05 denormalization). */
  const scopeWalls = (
    cols: { org: AnyColumn; pe: AnyColumn; loc: AnyColumn },
    scope: ComplianceScope,
  ) =>
    [
      eq(cols.org, scope.orgId),
      scope.providerEntityId !== undefined ? eq(cols.pe, scope.providerEntityId) : undefined,
      scope.locationId !== undefined ? eq(cols.loc, scope.locationId) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  return {
    // ── plan reads (DisciplinePlanReader) ─────────────────────────────────────────────────────────────
    async activePlansForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly DisciplinePlanDigest[]> => {
        const plans = await tx
          .select()
          .from(P)
          .where(and(eq(P.patientId, patientId), eq(P.status, "active")))
          .orderBy(asc(P.createdAt), asc(P.id));
        const signed = await lastSignedByPlan(
          tx,
          plans.map((p) => p.id),
        );
        return plans.map((p) => digestOf(p, signed.get(p.id)));
      });
    },

    async planById(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<DisciplinePlanFull | null> => {
        const [plan] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
        if (!plan) return null;
        // A seam consumer is a SYSTEM principal with no consent context of its own — SUD-related goals
        // are excluded unconditionally (§2.3 / §7.8; the route-25 posture, mirrored here).
        const goals = await tx
          .select()
          .from(G)
          .where(and(eq(G.planId, planId), eq(G.sudRelated, false)))
          .orderBy(asc(G.addedAt), asc(G.id));
        const interventions = await tx
          .select()
          .from(I)
          .where(eq(I.planId, planId))
          .orderBy(asc(I.addedAt), asc(I.id));
        const assessments = await tx
          .select()
          .from(A)
          .where(eq(A.planId, planId))
          .orderBy(asc(A.capturedAt), asc(A.id));
        const signed = await lastSignedByPlan(tx, [plan.id]);
        return {
          digest: digestOf(plan, signed.get(plan.id)),
          // No per-kind plan-level `data` payload exists in the §3.3 schema (the D1 payload rides only
          // inside sealed version snapshots); `null` is the honest answer, never an invented body.
          data: null,
          goals: goals.map(toGoalDto),
          interventions: interventions.map(toInterventionDto),
          assessments: assessments.map(toAssessmentDto),
          requiredSignerSet: await requiredSignerSetFor(tx, plan),
        };
      });
    },

    async planIdgDigest(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<DisciplinePlanIdgDigest | null> => {
        const [plan] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
        if (!plan) return null;
        const instant = now();

        const [goalCounts] = await tx
          .select({
            active: sql<number>`count(*) filter (where ${G.sudRelated} = false and ${G.status} in ('not_started','in_progress','revised'))::int`,
            sud: sql<number>`count(*) filter (where ${G.sudRelated} = true)::int`,
          })
          .from(G)
          .where(eq(G.planId, planId));
        const [interventionCounts] = await tx
          .select({ active: sql<number>`count(*) filter (where ${I.status} = 'active')::int` })
          .from(I)
          .where(eq(I.planId, planId));
        const [confidentialAssessments] = await tx
          .select({
            n: sql<number>`count(*) filter (where ${A.sudFlag} = true or ${A.familyViolenceFlag} = true)::int`,
          })
          .from(A)
          .where(eq(A.planId, planId));
        const signed = await lastSignedByPlan(tx, [plan.id]);

        // Open compliance flags, derived from the SAME pure clocks the crons and banners read (§7.1/§7.2/
        // §7.3) — deterministic tokens, never free text.
        const flags: string[] = [];
        const cadence = evaluateSupervisoryCadence(clockRowOf(plan), instant);
        if (
          cadence !== null &&
          (cadence.status === "overdue" || cadence.status === "gate_engaged")
        ) {
          flags.push(
            cadence.status === "gate_engaged"
              ? "aide_supervisory_gate_engaged"
              : "aide_supervisory_overdue",
          );
        }
        const initial = evaluateInitialClock(
          {
            kind: plan.kind,
            clockStartedAt: isoN(plan.initialAssessmentClockStartedAt),
            initialAssessmentSignedAt: isoN(plan.initialAssessmentSignedAt),
            spiritualCareDeclinedAt: isoN(plan.spiritualCareDeclinedAt),
          },
          instant,
        );
        if (initial.overdue) flags.push("initial_assessment_overdue");

        const activeGoalCount = goalCounts?.active ?? 0;
        const activeInterventionCount = interventionCounts?.active ?? 0;
        return {
          planId: plan.id,
          kind: plan.kind,
          status: plan.status,
          // Layer-1 deterministic (§4.3) — a template over structural facts, never AI-generated.
          oneLineSummary: `${plan.kind} (${plan.status}) — ${activeGoalCount} active goal(s), ${activeInterventionCount} active intervention(s)`,
          activeGoalCount,
          activeInterventionCount,
          lastSignedAt: signed.get(plan.id)?.signedAt ?? null,
          nextSupervisoryDueAt: isoN(plan.nextSupervisoryDueAt),
          openComplianceFlags: flags,
          appliedConfidentialityFilter:
            (goalCounts?.sud ?? 0) > 0 || (confidentialAssessments?.n ?? 0) > 0,
        };
      });
    },

    // ── MSW risk-factor reads (MswRiskFactorReader) ───────────────────────────────────────────────────
    async riskFactorsForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly MswRiskFactor[]> => {
        const planIds = (
          await tx
            .select({ id: P.id })
            .from(P)
            .where(and(eq(P.admissionId, admissionId), eq(P.kind, "msw_plan")))
        ).map((r) => r.id);
        if (planIds.length === 0) return [];
        const rows = await tx
          .select()
          .from(A)
          .where(
            and(
              inArray(A.planId, planIds),
              eq(A.kind, "msw_psychosocial"),
              // Only SIGNED psychosocial content is a risk factor — a draft is a work in progress
              // (the route-26 posture, mirrored).
              inArray(A.status, ["signed", "amended"]),
            ),
          )
          .orderBy(asc(A.capturedAt), asc(A.id));
        // The factors ride inside the per-kind §3.4 `data` payload; the seam DTO is ids + factor +
        // severity + ICD-10 + capturedAt — never the psychosocial narrative (§8.1 payload scrubbing).
        const out: MswRiskFactor[] = [];
        for (const row of rows) {
          const data = (row.data ?? {}) as { riskFactors?: unknown };
          const list = Array.isArray(data.riskFactors) ? data.riskFactors : [];
          for (const raw of list) {
            const f = (raw ?? {}) as Record<string, unknown>;
            out.push({
              planId: row.planId,
              admissionId,
              assessmentId: row.id,
              factor: typeof f.factor === "string" ? f.factor : "",
              severity:
                f.severity === "high" || f.severity === "moderate" || f.severity === "low"
                  ? f.severity
                  : "low",
              icd10: typeof f.icd10 === "string" ? f.icd10 : null,
              capturedAt: iso(row.capturedAt),
            });
          }
        }
        return out;
      });
    },

    // ── volunteer-gate reads (VolunteerComplianceProvider + VolunteerGateExpiryReader) ────────────────
    async gatesForMembership(membershipId) {
      // §8.7 — the ONE self-catching read: `null` means "the rows could not be read", which the provider
      // turns into the fail-CLOSED `isActive:false` + `service_unavailable` sentinel. An empty slice is a
      // DIFFERENT answer (the volunteer has no gates — every blocking kind fails on its own merits).
      try {
        return await withOrgContextFromRequest(db, async (tx) => {
          const rows = await tx
            .select()
            .from(GATE)
            .where(eq(GATE.volunteerMembershipId, membershipId));
          return rows.map(toGateFacts);
        });
      } catch {
        return null;
      }
    },

    async expiringGateCandidates(daysOut) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly VolunteerGateFacts[]> => {
        // Coarse SQL bound only — the provider re-derives each status over the validity window against
        // ITS injected clock (a missed cron must never re-qualify anyone).
        const horizon = new Date(Date.parse(now()) + daysOut * MS_PER_DAY);
        const rows = await tx
          .select()
          .from(GATE)
          .where(
            and(isNotNull(GATE.validUntil), isNull(GATE.revokedAt), lte(GATE.validUntil, horizon)),
          )
          .orderBy(asc(GATE.validUntil), asc(GATE.id));
        return rows.map(toGateFacts);
      });
    },

    // ── supervisory clock reads (SupervisoryCadenceReader + SupervisoryCadencePlanReader) ─────────────
    async supervisoryClockForPlan(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<SupervisoryClockRow | null> => {
        const [plan] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
        return plan === undefined ? null : clockRowOf(plan);
      });
    },

    async supervisoryClockForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx): Promise<SupervisoryClockRow | null> => {
        // The admission's LIVE Aide POC clock (M17's day-view advisory): an armed clock exists only on a
        // signed, non-discharged aide_poc — the §3.3 partial unique index guarantees at most one.
        const [plan] = await tx
          .select()
          .from(P)
          .where(
            and(
              eq(P.admissionId, admissionId),
              eq(P.kind, "aide_poc"),
              ne(P.status, "discharged"),
              isNotNull(P.nextSupervisoryDueAt),
            ),
          )
          .limit(1);
        return plan === undefined ? null : clockRowOf(plan);
      });
    },

    async overdueSupervisoryClocks(scope) {
      return withOrgContext(
        db,
        { organizationId: scope.orgId, userId: "" },
        async (tx): Promise<readonly SupervisoryClockRow[]> => {
          // RLS pins the org; the explicit organization_id predicate is the deliberate second wall for a
          // scope-parameter aggregate (the worker caller carries no ambient request context).
          const rows = await tx
            .select()
            .from(P)
            .where(
              and(
                ...scopeWalls(
                  { org: P.organizationId, pe: P.providerEntityId, loc: P.locationId },
                  scope,
                ),
                eq(P.kind, "aide_poc"),
                ne(P.status, "discharged"),
                isNotNull(P.nextSupervisoryDueAt),
                // Coarse bound: at/past due. The provider re-runs the §7.1 ladder and keeps only
                // `overdue` / `gate_engaged`, so the escalation marks stay single-sourced.
                lte(P.nextSupervisoryDueAt, new Date(Date.parse(now()))),
              ),
            )
            .orderBy(asc(P.nextSupervisoryDueAt), asc(P.id));
          return rows.map(clockRowOf);
        },
      );
    },

    // ── compliance rollups (DisciplineComplianceProvider) ─────────────────────────────────────────────
    async complianceCounts(scope) {
      return withOrgContext(
        db,
        { organizationId: scope.orgId, userId: "" },
        async (tx): Promise<DisciplineComplianceCounts> => {
          const nowIso = now();
          const fromMs = scope.fromIso !== undefined ? Date.parse(scope.fromIso) : null;
          const toMs = scope.toIso !== undefined ? Date.parse(scope.toIso) : Date.parse(nowIso);
          const inWindow = (ms: number): boolean => (fromMs === null || ms >= fromMs) && ms <= toMs;

          // 1 — supervisory on-time: attested visits measured against the deadline IN FORCE when they
          // happened, i.e. the previous visit's `next_due_at` for the plan. The first visit of a plan has
          // no stored prior deadline (the initial deadline is not persisted), so it is EXCLUDED from the
          // denominator rather than counted on-time or in breach on invented evidence.
          const visits = await tx
            .select({
              planId: SV.planId,
              supervisoryAt: SV.supervisoryAt,
              nextDueAt: SV.nextDueAt,
            })
            .from(SV)
            .where(
              and(
                ...scopeWalls(
                  { org: SV.organizationId, pe: SV.providerEntityId, loc: SV.locationId },
                  scope,
                ),
                isNotNull(SV.signedAt),
                lte(SV.supervisoryAt, new Date(toMs)),
              ),
            )
            .orderBy(asc(SV.planId), asc(SV.supervisoryAt), asc(SV.id));
          const supervisoryOnTime: RateCounts = tallySupervisory(visits, inWindow);

          // 2/3 — the D10 initial clocks, resolved by the SAME pure function the crons and banners read.
          const clockPlans = await tx
            .select()
            .from(P)
            .where(
              and(
                ...scopeWalls(
                  { org: P.organizationId, pe: P.providerEntityId, loc: P.locationId },
                  scope,
                ),
                inArray(P.kind, ["msw_plan", "spiritual_plan"]),
                isNotNull(P.initialAssessmentClockStartedAt),
              ),
            );
          const mswInitialOnTime = tallyInitialClock(clockPlans, "msw_plan", nowIso, inWindow);
          const chaplainInitialOnTime = tallyInitialClock(
            clockPlans,
            "spiritual_plan",
            nowIso,
            inWindow,
          );

          // 4 — volunteer 418.78 gate compliance: volunteers holding an open assignment overlapping the
          // window, judged by the ONE pure gate derivation (`effectiveStatusFor`) — a volunteer with no
          // gate rows FAILS every blocking kind; absence is never an active gate.
          const assignmentFilters = [
            ...scopeWalls(
              { org: VA.organizationId, pe: VA.providerEntityId, loc: VA.locationId },
              scope,
            ),
            isNull(VA.inactivatedAt),
            lte(VA.startsAt, new Date(toMs)),
            fromMs !== null
              ? sql`(${VA.endsAt} is null or ${VA.endsAt} >= ${new Date(fromMs)})`
              : undefined,
          ].filter((f): f is NonNullable<typeof f> => f !== undefined);
          const assignmentRows = await tx
            .select({ volunteerMembershipId: VA.volunteerMembershipId })
            .from(VA)
            .where(and(...assignmentFilters));
          const memberships = [...new Set(assignmentRows.map((r) => r.volunteerMembershipId))];
          let clearedVolunteers = 0;
          if (memberships.length > 0) {
            const gateRows = await tx
              .select()
              .from(GATE)
              .where(inArray(GATE.volunteerMembershipId, memberships));
            const gatesByMembership = new Map<string, VolunteerGateFacts[]>();
            for (const row of gateRows) {
              const facts = toGateFacts(row);
              const bucket = gatesByMembership.get(row.volunteerMembershipId) ?? [];
              bucket.push(facts);
              gatesByMembership.set(row.volunteerMembershipId, bucket);
            }
            for (const membershipId of memberships) {
              const status = effectiveStatusFor(
                membershipId as MembershipId,
                gatesByMembership.get(membershipId) ?? [],
                nowIso,
              );
              if (status.isActive) clearedVolunteers += 1;
            }
          }
          const volunteerGateCompliance: RateCounts = {
            numerator: clearedVolunteers,
            denominator: memberships.length,
          };

          return {
            supervisoryOnTime,
            mswInitialOnTime,
            chaplainInitialOnTime,
            volunteerGateCompliance,
          };
        },
      );
    },

    async volunteerHourTotals(providerEntityId, fiscalYear) {
      const volunteerHourMinutes = await withOrgContextFromRequest(db, async (tx) => {
        const [row] = await tx
          .select({ minutes: LEDGER.totalVolunteerHourMinutes })
          .from(LEDGER)
          .where(
            and(eq(LEDGER.providerEntityId, providerEntityId), eq(LEDGER.fiscalYear, fiscalYear)),
          )
          .limit(1);
        return row?.minutes ?? 0;
      });
      // M15-F04: `null` until the M27 patient-care-HOURS seam is bound — `computeVolunteerHourRatio`
      // badges it `unavailable` with the reason, never a 0% CoP breach the agency did not commit.
      const totals: VolunteerHourTotals = {
        volunteerHourMinutes,
        staffPatientCareMinutes: await staffMinutes({ providerEntityId, fiscalYear }),
      };
      return totals;
    },
  };
}

/** LAG-style pass over a plan's ordered visits: visit N's deadline is visit N−1's `next_due_at`. */
function tallySupervisory(
  visits: readonly { planId: string; supervisoryAt: Date | string; nextDueAt: Date | string }[],
  inWindow: (ms: number) => boolean,
): RateCounts {
  let numerator = 0;
  let denominator = 0;
  const priorDueByPlan = new Map<string, number>();
  for (const visit of visits) {
    const at =
      visit.supervisoryAt instanceof Date
        ? visit.supervisoryAt.getTime()
        : Date.parse(visit.supervisoryAt);
    const prior = priorDueByPlan.get(visit.planId);
    if (prior !== undefined && inWindow(at)) {
      denominator += 1;
      if (at <= prior) numerator += 1;
    }
    const nextDue =
      visit.nextDueAt instanceof Date ? visit.nextDueAt.getTime() : Date.parse(visit.nextDueAt);
    priorDueByPlan.set(visit.planId, nextDue);
  }
  return { numerator, denominator };
}

/** The D10 tally for one plan kind: denominator = clocks that CLOSED in the window (satisfied at their
 *  satisfaction instant, or lapsed at their due instant); numerator = satisfied on or before due. A clock
 *  still open (unsatisfied, not yet due) carries no verdict yet and is excluded. */
function tallyInitialClock(
  plans: readonly (typeof schema.disciplineCarePlan.$inferSelect)[],
  kind: "msw_plan" | "spiritual_plan",
  nowIso: IsoInstant,
  inWindow: (ms: number) => boolean,
): RateCounts {
  let numerator = 0;
  let denominator = 0;
  for (const plan of plans) {
    if (plan.kind !== kind) continue;
    const signedAt = plan.initialAssessmentSignedAt;
    const declinedAt = plan.spiritualCareDeclinedAt;
    const state = evaluateInitialClock(
      {
        kind: plan.kind,
        clockStartedAt: signedOrNull(plan.initialAssessmentClockStartedAt),
        initialAssessmentSignedAt: signedOrNull(signedAt),
        spiritualCareDeclinedAt: signedOrNull(declinedAt),
      },
      nowIso,
    );
    if (state.dueAt === null) continue;
    const dueMs = Date.parse(state.dueAt);
    // The satisfaction instant: the signed initial artifact, or (chaplain only — the pure catalog decides
    // via `satisfiedBy`, which `state.satisfied` already reflects) the recorded declination.
    const satisfactionCandidates = [signedAt, kind === "spiritual_plan" ? declinedAt : null]
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());
    const satisfiedMs =
      state.satisfied && satisfactionCandidates.length > 0
        ? Math.min(...satisfactionCandidates)
        : null;
    const closeMs = satisfiedMs ?? (state.overdue ? dueMs : null);
    if (closeMs === null || !inWindow(closeMs)) continue;
    denominator += 1;
    if (satisfiedMs !== null && satisfiedMs <= dueMs) numerator += 1;
  }
  return { numerator, denominator };
}

const signedOrNull = (d: Date | null): IsoInstant | null =>
  d === null ? null : (d.toISOString() as IsoInstant);
