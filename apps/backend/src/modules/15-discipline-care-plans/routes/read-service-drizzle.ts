// apps/backend/src/modules/15-discipline-care-plans/routes/read-service-drizzle.ts — the Drizzle-backed
// M15 READ service (§4.1 routes 1–5, 19, 23, 25–28).
//
// Every method opens `withOrgContext(db, {organizationId, userId}, tx => …)` so Postgres RLS scopes each
// statement to the acting org (§3.7) — the service never filters by org in the WHERE clause and never
// switches tenants. Paging is keyset (§4.6.1), never OFFSET.
//
// The §7.8 / §7.9 confidentiality gates are applied as SQL PREDICATES, not as a post-fetch filter: a caller
// without a Part 2 release never has the SUD row in the result set (so it cannot leak through a serializer,
// a log line, or a stack trace), and the withheld category rides `redacted_categories`. The §4.1
// `caseload_or_scope` equivalent runs BEFORE the query (`actorMayReadPatient`) and answers `null` — the
// route turns that into a 404, so an off-caseload plan is indistinguishable from a non-existent one.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { FiscalYear, IsoInstant, MembershipId, ProviderEntityId } from "@wardenx/types";
import { and, asc, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import {
  evaluateSupervisoryCadence,
  hoursOverdue,
  isSupervisoryGateEngaged,
} from "../lifecycle/index";
import {
  GATE_STORE_UNAVAILABLE,
  type VolunteerGateFacts,
  computeVolunteerHourRatio,
  deriveGateStatus,
  effectiveStatusFor,
} from "../volunteer/index";
import type { M15ReadActor } from "./actor";
import {
  type CursorPage,
  M15_PAGE_SIZES,
  type PageSizePolicy,
  clampLimit,
  decodeCursor,
  toCursorPage,
} from "./concurrency";
import {
  type CaseloadPort,
  type DisclosureDecision,
  type DisclosurePort,
  SUMMARY_DISCLOSURE,
  actorMayReadPatient,
  resolveDisclosure,
  seamCaseloadPort,
  seamDisclosurePort,
} from "./disclosure";
import type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanDetail,
  DisciplinePlanListItem,
  DisciplinePlanSummary,
  DisciplinePlanVersionDetail,
  DisciplinePlanVersionListItem,
  GateListQuery,
  HourRatioQuery,
  InternalListQuery,
  M15ReadService,
  PlanListQuery,
  RelevantElementsView,
  SupervisoryCadenceRowView,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
  VolunteerEffectiveStatusView,
} from "./read-service";

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Deps the composition root may override (tests inject deterministic clocks + in-memory gates). */
export interface M15ReadDeps {
  readonly now?: () => IsoInstant;
  readonly disclosure?: DisclosurePort;
  readonly caseload?: CaseloadPort;
}

export function buildDrizzleM15ReadService(db: DbClient, deps: M15ReadDeps = {}): M15ReadService {
  const P = schema.disciplineCarePlan;
  const V = schema.disciplineCarePlanVersion;
  const SIG = schema.disciplineCarePlanSignature;
  const G = schema.disciplineGoal;
  const I = schema.disciplineIntervention;
  const A = schema.disciplineAssessment;
  const SV = schema.aideSupervisoryVisit;
  const VA = schema.volunteerAssignment;
  const GATE = schema.volunteerComplianceGate;
  const LEDGER = schema.volunteerHourLedger;

  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  const disclosurePort = deps.disclosure ?? seamDisclosurePort;
  const caseloadPort = deps.caseload ?? seamCaseloadPort;

  const scope = (actor: M15ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  const toPlanRow = (r: typeof P.$inferSelect): DisciplinePlanListItem => ({
    planId: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    providerEntityId: r.providerEntityId,
    locationId: r.locationId,
    kind: r.kind,
    status: r.status,
    nextSupervisoryDueAt: isoN(r.nextSupervisoryDueAt),
    initialAssessmentClockStartedAt: isoN(r.initialAssessmentClockStartedAt),
    initialAssessmentSignedAt: isoN(r.initialAssessmentSignedAt),
    spiritualCareDeclinedAt: isoN(r.spiritualCareDeclinedAt),
    updatedAt: iso(r.updatedAt),
    version: r.version,
  });

  const toGoal = (r: typeof G.$inferSelect): DisciplineGoalView => ({
    goalId: r.id,
    parentProblemId: r.parentProblemId ?? null,
    parentGoalId: r.parentGoalId ?? null,
    source: r.source,
    status: r.status,
    originalText: r.originalText,
    revisedText: r.revisedText ?? null,
    measurableOutcome: r.measurableOutcome ?? null,
    targetAt: isoN(r.targetAt),
    frequencyText: r.frequencyText ?? null,
    frequencyValue: r.frequencyValue ?? null,
    modalityText: r.modalityText ?? null,
    sudRelated: r.sudRelated,
    addedByDiscipline: r.addedByDiscipline,
    addedAt: iso(r.addedAt),
    version: r.version,
  });

  const toIntervention = (r: typeof I.$inferSelect): DisciplineInterventionView => ({
    interventionId: r.id,
    parentInterventionId: r.parentInterventionId ?? null,
    goalRefs: strArray(r.goalRefs),
    scopeText: r.scopeText,
    frequencyText: r.frequencyText,
    frequencyValue: r.frequencyValue,
    discipline: r.discipline,
    responsibleRoles: strArray(r.responsibleRoles),
    status: r.status,
    discontinuationReason: r.discontinuationReason ?? null,
    addedByDiscipline: r.addedByDiscipline,
    addedAt: iso(r.addedAt),
    version: r.version,
  });

  const toAssessment = (r: typeof A.$inferSelect): DisciplineAssessmentView => ({
    assessmentId: r.id,
    kind: r.kind,
    status: r.status,
    capturedAt: iso(r.capturedAt),
    isInitial: r.isInitial,
    sudFlag: r.sudFlag,
    familyViolenceFlag: r.familyViolenceFlag,
    sourceEncounterId: r.sourceEncounterId ?? null,
    data: r.data,
    amendsAssessmentId: r.amendsAssessmentId ?? null,
    amendmentReason: r.amendmentReason ?? null,
    capturedByMembershipId: r.capturedByMembershipId,
    signedAt: isoN(r.signedAt),
    signedByMembershipId: r.signedByMembershipId ?? null,
    version: r.version,
  });

  const toSupervisoryVisit = (r: typeof SV.$inferSelect): AideSupervisoryVisitView => ({
    supervisoryVisitId: r.id,
    aideMembershipId: r.aideMembershipId,
    supervisingRnMembershipId: r.supervisingRnMembershipId,
    sourceEncounterId: r.sourceEncounterId ?? null,
    supervisoryAt: iso(r.supervisoryAt),
    attestationMode: r.attestationMode,
    aidePerformanceSatisfactory: r.aidePerformanceSatisfactory,
    correctiveActions: r.correctiveActions ?? null,
    supervisoryNarrative: r.supervisoryNarrative,
    nextDueAt: iso(r.nextDueAt),
    cadenceDaysAtInsert: r.cadenceDaysAtInsert,
    signedAt: isoN(r.signedAt),
    version: r.version,
  });

  const toAssignment = (r: typeof VA.$inferSelect): VolunteerAssignmentView => ({
    assignmentId: r.id,
    volunteerMembershipId: r.volunteerMembershipId,
    coordinatorMembershipId: r.coordinatorMembershipId,
    activities: strArray(r.activities),
    startsAt: iso(r.startsAt),
    endsAt: isoN(r.endsAt),
    coordinatorAcknowledgedAt: isoN(r.coordinatorAcknowledgedAt),
    inactivatedAt: isoN(r.inactivatedAt),
    inactivationReason: r.inactivationReason ?? null,
    version: r.version,
  });

  const toVersionRow = (r: typeof V.$inferSelect): DisciplinePlanVersionListItem => ({
    versionId: r.id,
    planId: r.planId,
    sequence: r.sequence,
    status: r.status,
    kind: r.kind,
    idgMeetingId: r.idgMeetingId ?? null,
    finalizedAt: isoN(r.finalizedAt),
    signedAt: isoN(r.signedAt),
    supersededAt: isoN(r.supersededAt),
    version: r.version,
  });

  const toGateFacts = (r: typeof GATE.$inferSelect): VolunteerGateFacts => ({
    gateId: r.id,
    volunteerMembershipId: r.volunteerMembershipId as MembershipId,
    gateKind: r.gateKind,
    status: r.status,
    validFrom: iso(r.validFrom) as IsoInstant,
    validUntil: isoN(r.validUntil) as IsoInstant | null,
    revokedAt: isoN(r.revokedAt) as IsoInstant | null,
  });

  const cadenceOf = (r: typeof P.$inferSelect) => {
    const state = evaluateSupervisoryCadence(
      {
        planId: r.id as never,
        nextSupervisoryDueAt: isoN(r.nextSupervisoryDueAt) as IsoInstant | null,
        cadenceDaysOverride: r.supervisoryCadenceDaysOverride ?? null,
      },
      now(),
    );
    if (state === null) return null;
    return {
      nextDueAt: state.nextDueAt,
      cadenceDays: state.cadenceDays,
      status: state.status,
      hoursOverdue: hoursOverdue(state.nextDueAt, now()),
    };
  };

  /** Load a plan row + assert the caller may read its patient (§4.1 `caseload_or_scope`). */
  async function loadReadablePlan(
    actor: M15ReadActor,
    planId: string,
  ): Promise<typeof P.$inferSelect | null> {
    const row = await withOrgContext(db, scope(actor), async (tx) => {
      const [found] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
      return found ?? null;
    });
    if (!row) return null;
    const mayRead = await actorMayReadPatient(actor, row.patientId, caseloadPort);
    return mayRead ? row : null;
  }

  const pageLimit = (query: InternalListQuery, policy: PageSizePolicy): number =>
    clampLimit(query.limit, policy);

  return {
    // ── 1 — plan worklist (keyset on `updated_at DESC, id DESC`) ─────────────────────────────────────
    async listPlans(actor, query: PlanListQuery) {
      const limit = pageLimit(query, M15_PAGE_SIZES.plans);
      const cursor = decodeCursor(query.cursor);
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          query.patientId ? eq(P.patientId, query.patientId) : undefined,
          query.admissionId ? eq(P.admissionId, query.admissionId) : undefined,
          query.kind ? eq(P.kind, query.kind as typeof P.$inferSelect.kind) : undefined,
          query.status ? eq(P.status, query.status as typeof P.$inferSelect.status) : undefined,
          cursor
            ? or(
                lt(P.updatedAt, new Date(cursor.a)),
                and(eq(P.updatedAt, new Date(cursor.a)), lt(P.id, cursor.id)),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(P)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(P.updatedAt), desc(P.id))
          .limit(limit + 1);
      });
      // Caseload narrowing is per-patient and cannot be expressed in SQL without importing M5's schema —
      // the seam answers per patient, so the page is filtered here. The page SIZE therefore reflects rows
      // the caller may actually see, and `has_more` still drives the next keyset fetch honestly.
      const visible: (typeof P.$inferSelect)[] = [];
      for (const row of rows) {
        if (await actorMayReadPatient(actor, row.patientId, caseloadPort)) visible.push(row);
      }
      return toCursorPage(
        visible,
        limit,
        (r) => ({ a: iso(r.updatedAt), id: r.id }),
        toPlanRow,
      ) satisfies CursorPage<DisciplinePlanListItem>;
    },

    // ── 2 — the full plan (SQL-level §7.8/§7.9 filtering + the redacted_categories envelope) ─────────
    async getPlan(actor, planId) {
      const plan = await loadReadablePlan(actor, planId);
      if (!plan) return null;
      const gate: DisclosureDecision = await resolveDisclosure(
        actor,
        plan.patientId,
        disclosurePort,
      );
      return withOrgContext(db, scope(actor), async (tx) => {
        const goals = await tx
          .select()
          .from(G)
          .where(
            gate.sudAllowed
              ? eq(G.planId, planId)
              : and(eq(G.planId, planId), eq(G.sudRelated, false)),
          )
          .orderBy(asc(G.addedAt), asc(G.id));
        const interventions = await tx
          .select()
          .from(I)
          .where(eq(I.planId, planId))
          .orderBy(asc(I.addedAt), asc(I.id));
        const assessmentFilters = [eq(A.planId, planId)];
        if (!gate.sudAllowed) assessmentFilters.push(eq(A.sudFlag, false));
        if (!gate.familyViolenceAllowed) assessmentFilters.push(eq(A.familyViolenceFlag, false));
        const assessments = await tx
          .select()
          .from(A)
          .where(and(...assessmentFilters))
          .orderBy(desc(A.capturedAt), desc(A.id));
        const supervisoryVisits = await tx
          .select()
          .from(SV)
          .where(eq(SV.planId, planId))
          .orderBy(desc(SV.supervisoryAt), desc(SV.id));
        const assignments = await tx
          .select()
          .from(VA)
          .where(eq(VA.planId, planId))
          .orderBy(desc(VA.startsAt), desc(VA.id));
        const versions = await tx
          .select()
          .from(V)
          .where(eq(V.planId, planId))
          .orderBy(asc(V.sequence), asc(V.id));

        const detail: DisciplinePlanDetail = {
          ...toPlanRow(plan),
          aideMembershipId: plan.aideMembershipId ?? null,
          supervisingRnMembershipId: plan.supervisingRnMembershipId ?? null,
          supervisoryCadenceDaysOverride: plan.supervisoryCadenceDaysOverride ?? null,
          spiritualCareDeclined: plan.spiritualCareDeclined ?? null,
          goals: goals.map(toGoal),
          interventions: interventions.map(toIntervention),
          assessments: assessments.map(toAssessment),
          supervisoryVisits: supervisoryVisits.map(toSupervisoryVisit),
          volunteerAssignments: assignments.map(toAssignment),
          versions: versions.map(toVersionRow),
          supervisoryCadence: cadenceOf(plan),
          redacted_categories: gate.redactedCategories,
        };
        return detail;
      });
    },

    // ── 3 — the patient-shareable summary (both categories ALWAYS stripped, §7.9) ────────────────────
    async getPlanSummary(actor, planId) {
      const plan = await loadReadablePlan(actor, planId);
      if (!plan) return null;
      return withOrgContext(db, scope(actor), async (tx) => {
        const goals = await tx
          .select()
          .from(G)
          .where(and(eq(G.planId, planId), eq(G.sudRelated, false)))
          .orderBy(asc(G.addedAt), asc(G.id));
        const interventions = await tx
          .select()
          .from(I)
          .where(and(eq(I.planId, planId), eq(I.status, "active")))
          .orderBy(asc(I.addedAt), asc(I.id));
        const summary: DisciplinePlanSummary = {
          planId: plan.id,
          kind: plan.kind,
          status: plan.status,
          goals: goals.map((g) => ({
            goalId: g.id,
            text: g.revisedText ?? g.originalText,
            status: g.status,
            targetAt: isoN(g.targetAt),
          })),
          interventions: interventions.map((i) => ({
            interventionId: i.id,
            scopeText: i.scopeText,
            frequencyText: i.frequencyText,
            status: i.status,
          })),
          // §7.3 — the declination is acknowledged, never quoted, on a patient-facing surface.
          spiritualCareDeclined: plan.spiritualCareDeclinedAt !== null,
          redacted_categories: SUMMARY_DISCLOSURE.redactedCategories,
        };
        return summary;
      });
    },

    // ── 4 — version chain (keyset on `sequence ASC, id ASC`) ─────────────────────────────────────────
    async listVersions(actor, planId, query) {
      const plan = await loadReadablePlan(actor, planId);
      if (!plan) return null;
      const limit = pageLimit(query, M15_PAGE_SIZES.versions);
      const cursor = decodeCursor(query.cursor);
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [eq(V.planId, planId)];
        if (cursor) {
          const seq = Number(cursor.a);
          filters.push(
            or(gt(V.sequence, seq), and(eq(V.sequence, seq), gt(V.id, cursor.id))) as never,
          );
        }
        return tx
          .select()
          .from(V)
          .where(and(...filters))
          .orderBy(asc(V.sequence), asc(V.id))
          .limit(limit + 1);
      });
      return toCursorPage(rows, limit, (r) => ({ a: String(r.sequence), id: r.id }), toVersionRow);
    },

    // ── 5 — one version + its sealed snapshot + collected signatures ─────────────────────────────────
    async getVersion(actor, planId, versionId) {
      const plan = await loadReadablePlan(actor, planId);
      if (!plan) return null;
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(V)
          .where(and(eq(V.id, versionId), eq(V.planId, planId)))
          .limit(1);
        if (!row) return null;
        const signatures = await tx
          .select()
          .from(SIG)
          .where(eq(SIG.versionId, versionId))
          .orderBy(asc(SIG.signedAt), asc(SIG.id));
        const detail: DisciplinePlanVersionDetail = {
          ...toVersionRow(row),
          stateSnapshot: row.stateSnapshot,
          requiredSignerSet: row.requiredSignerSet,
          signatures: signatures.map((s) => ({
            signatureId: s.id,
            signerMembershipId: s.signerMembershipId,
            signerRole: s.signerRole,
            isAcknowledgment: s.isAcknowledgment,
            signedAt: iso(s.signedAt),
          })),
        };
        return detail;
      });
    },

    // ── 19 — compliance gates (keyset on `valid_until ASC, id ASC`) ──────────────────────────────────
    async listVolunteerGates(actor, query: GateListQuery) {
      const limit = pageLimit(query, M15_PAGE_SIZES.gates);
      const cursor = decodeCursor(query.cursor);
      const instant = now();
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const horizon =
          typeof query.expiringWithinDays === "number"
            ? new Date(Date.parse(instant) + query.expiringWithinDays * 86_400_000)
            : null;
        const filters = [
          query.volunteerMembershipId
            ? eq(GATE.volunteerMembershipId, query.volunteerMembershipId)
            : undefined,
          query.gateKind
            ? eq(GATE.gateKind, query.gateKind as typeof GATE.$inferSelect.gateKind)
            : undefined,
          horizon ? lte(GATE.validUntil, horizon) : undefined,
          cursor
            ? or(
                gt(GATE.validUntil, new Date(cursor.a)),
                and(eq(GATE.validUntil, new Date(cursor.a)), gt(GATE.id, cursor.id)),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(GATE)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(asc(GATE.validUntil), asc(GATE.id))
          .limit(limit + 1);
      });
      return toCursorPage(
        rows,
        limit,
        (r) => ({ a: iso(r.validUntil), id: r.id }),
        (r): VolunteerComplianceGateView => ({
          gateId: r.id,
          volunteerMembershipId: r.volunteerMembershipId,
          gateKind: r.gateKind,
          storedStatus: r.status,
          // Re-derived over the validity window — a missed watcher run must never read as "satisfied".
          effectiveStatus: deriveGateStatus(toGateFacts(r), instant),
          validFrom: iso(r.validFrom),
          validUntil: isoN(r.validUntil),
          revokedAt: isoN(r.revokedAt),
          sourceDocumentId: r.sourceDocumentId ?? null,
          version: r.version,
        }),
      );
    },

    // ── 23 — the 418.78(e) ratio (hours ÷ hours; `unavailable` while M27 is unbound, M15-F04) ────────
    async getVolunteerHourRatio(actor, query: HourRatioQuery) {
      // M15-F04 / 0347: the denominator is the value the nightly hour aggregator persisted on this ledger
      // row; never recomputed per request. No row / never computed ⇒ `unavailable`.
      const ledger = await withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(LEDGER)
          .where(
            and(
              eq(LEDGER.providerEntityId, query.providerEntityId),
              eq(LEDGER.fiscalYear, query.fiscalYear),
            ),
          )
          .limit(1);
        return row ?? null;
      });
      return computeVolunteerHourRatio({
        providerEntityId: query.providerEntityId as ProviderEntityId,
        fiscalYear: query.fiscalYear as FiscalYear,
        volunteerHourMinutes: ledger?.totalVolunteerHourMinutes ?? 0,
        staffPatientCareMinutes: ledger?.patientCareMinutes ?? null,
        denominatorComputedAt: ledger?.patientCareComputedAt?.toISOString() ?? null,
        now: now(),
      });
    },

    // ── 25 — the discipline elements M8 / M14 / M22 pull (system principals) ─────────────────────────
    async listRelevantElements(actor, input) {
      const limit = pageLimit(input, M15_PAGE_SIZES.relevantElements);
      const cursor = decodeCursor(input.cursor);
      const plans = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          input.patientId ? eq(P.patientId, input.patientId) : undefined,
          input.planId ? eq(P.id, input.planId) : undefined,
          cursor ? gt(P.id, cursor.id) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(P)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(asc(P.id))
          .limit(limit + 1);
      });
      const bodies = await withOrgContext(db, scope(actor), async (tx) => {
        const out = new Map<string, RelevantElementsView>();
        for (const plan of plans) {
          // A seam consumer is a SYSTEM principal with no consent context of its own — the confidential
          // categories are excluded unconditionally (§7.8 / §7.9); a downstream module that needs them
          // must go through its own consented read path.
          const goals = await tx
            .select()
            .from(G)
            .where(and(eq(G.planId, plan.id), eq(G.sudRelated, false)))
            .orderBy(asc(G.addedAt), asc(G.id));
          const interventions = await tx
            .select()
            .from(I)
            .where(eq(I.planId, plan.id))
            .orderBy(asc(I.addedAt), asc(I.id));
          out.set(plan.id, {
            planId: plan.id,
            kind: plan.kind,
            status: plan.status,
            goals: goals.map(toGoal),
            interventions: interventions.map(toIntervention),
          });
        }
        return out;
      });
      return toCursorPage(
        plans,
        limit,
        (r) => ({ a: r.id, id: r.id }),
        (r) =>
          bodies.get(r.id) ?? {
            planId: r.id,
            kind: r.kind,
            status: r.status,
            goals: [],
            interventions: [],
          },
      );
    },

    // ── 26 — the MSW psychosocial risk factors for an admission (M16's rubric input) ─────────────────
    async listMswRiskFactors(actor, input) {
      const limit = pageLimit(input, M15_PAGE_SIZES.riskFactors);
      const cursor = decodeCursor(input.cursor);
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          eq(P.admissionId, input.admissionId),
          eq(P.kind, "msw_plan" as typeof P.$inferSelect.kind),
        ];
        const planIds = (
          await tx
            .select({ id: P.id })
            .from(P)
            .where(and(...filters))
        ).map((r) => r.id);
        if (planIds.length === 0) return [];
        const assessmentFilters = [
          eq(A.kind, "msw_psychosocial" as typeof A.$inferSelect.kind),
          or(...planIds.map((id) => eq(A.planId, id))) as never,
          // Only SIGNED psychosocial content is a risk factor — a draft is a work in progress.
          or(eq(A.status, "signed"), eq(A.status, "amended")) as never,
          cursor ? gt(A.id, cursor.id) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(A)
          .where(and(...assessmentFilters))
          .orderBy(asc(A.id))
          .limit(limit + 1);
      });
      // The factors live inside the per-kind §3.4 `data` payload; the seam DTO is ids + factor + severity
      // + ICD-10 + capturedAt — never the psychosocial narrative (§8.1 payload scrubbing).
      const factorsOf = (row: typeof A.$inferSelect) => {
        const data = (row.data ?? {}) as { riskFactors?: unknown };
        const list = Array.isArray(data.riskFactors) ? data.riskFactors : [];
        return list.map((raw) => {
          const f = (raw ?? {}) as Record<string, unknown>;
          return {
            planId: row.planId,
            admissionId: input.admissionId,
            assessmentId: row.id,
            factor: typeof f.factor === "string" ? f.factor : "",
            severity:
              f.severity === "high" || f.severity === "moderate" || f.severity === "low"
                ? f.severity
                : "low",
            icd10: typeof f.icd10 === "string" ? f.icd10 : null,
            capturedAt: iso(row.capturedAt),
          };
        });
      };
      const page = toCursorPage(rows, limit, (r) => ({ a: r.id, id: r.id }), factorsOf);
      // One assessment can carry several factors: flatten AFTER paging so the keyset stays on assessments.
      return { ...page, data: page.data.flat() };
    },

    // ── 27 — the volunteer's effective 418.78 status (M17's pre-schedule gate, fail-CLOSED) ──────────
    async getVolunteerEffectiveStatus(actor, volunteerMembershipId) {
      let gates: readonly VolunteerGateFacts[] | null = null;
      try {
        gates = await withOrgContext(db, scope(actor), async (tx) => {
          const rows = await tx
            .select()
            .from(GATE)
            .where(eq(GATE.volunteerMembershipId, volunteerMembershipId));
          return rows.map(toGateFacts);
        });
      } catch {
        gates = null; // §8.7 — an unreadable gate store DENIES; it never assumes compliance.
      }
      const status = effectiveStatusFor(volunteerMembershipId as MembershipId, gates, now());
      // The pure derivation answers gate-KIND tokens; the §4.3 seam contract publishes a
      // `{gateKind, reason}` pair, so the reason is attached here (one place, so the HTTP surface and the
      // in-process seam say the same thing). `gate_store_unavailable` is the §8.7 fail-CLOSED sentinel.
      const view: VolunteerEffectiveStatusView = {
        volunteerMembershipId,
        isActive: status.isActive,
        failingGates: status.failingGates.map((gateKind) => ({
          gateKind,
          reason:
            gateKind === GATE_STORE_UNAVAILABLE
              ? "the volunteer compliance-gate store could not be read; the gate denies fail-closed (§8.7)"
              : "no current 42 CFR 418.78 gate of this kind clears for this volunteer",
        })),
      };
      return view;
    },

    // ── 28 — the supervisory cadence worklist (the §7.1 ladder, resolved per plan) ───────────────────
    async listSupervisoryCadence(actor, input) {
      const limit = pageLimit(input, M15_PAGE_SIZES.supervisoryCadence);
      const cursor = decodeCursor(input.cursor);
      const instant = now();
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          eq(P.kind, "aide_poc" as typeof P.$inferSelect.kind),
          eq(P.status, "active" as typeof P.$inferSelect.status),
          input.providerEntityId ? eq(P.providerEntityId, input.providerEntityId) : undefined,
          input.locationId ? eq(P.locationId, input.locationId) : undefined,
          // An unarmed clock carries no obligation — it is not a worklist row (§7.1).
          sql`${P.nextSupervisoryDueAt} is not null`,
          input.overdueOnly === true ? lte(P.nextSupervisoryDueAt, new Date(instant)) : undefined,
          cursor
            ? or(
                gt(P.nextSupervisoryDueAt, new Date(cursor.a)),
                and(eq(P.nextSupervisoryDueAt, new Date(cursor.a)), gt(P.id, cursor.id)),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(P)
          .where(and(...filters))
          .orderBy(asc(P.nextSupervisoryDueAt), asc(P.id))
          .limit(limit + 1);
      });
      return toCursorPage(
        rows,
        limit,
        (r) => ({ a: iso(r.nextSupervisoryDueAt), id: r.id }),
        (r): SupervisoryCadenceRowView => {
          const state = evaluateSupervisoryCadence(
            {
              planId: r.id as never,
              nextSupervisoryDueAt: isoN(r.nextSupervisoryDueAt) as IsoInstant | null,
              cadenceDaysOverride: r.supervisoryCadenceDaysOverride ?? null,
            },
            instant,
          );
          return {
            planId: r.id,
            patientId: r.patientId,
            admissionId: r.admissionId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            aideMembershipId: r.aideMembershipId ?? null,
            supervisingRnMembershipId: r.supervisingRnMembershipId ?? null,
            nextDueAt: iso(r.nextSupervisoryDueAt),
            cadenceDays: state?.cadenceDays ?? 14,
            status: state?.status ?? "on_time",
            hoursOverdue: hoursOverdue(iso(r.nextSupervisoryDueAt) as IsoInstant, instant),
            gateEngaged: isSupervisoryGateEngaged(state),
          };
        },
      );
    },
  };
}
