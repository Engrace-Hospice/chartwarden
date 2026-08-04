// apps/backend/__tests__/discipline-plans-inject.test.ts — M15 (Discipline Care Plans) HTTP-layer smoke
// suite (TASK-050A / TEST-001).
//
// M15 had ZERO Fastify `.inject()` coverage before this file: `discipline-plans-authz.test.ts`,
// `discipline-plans-lifecycle.test.ts`, `discipline-plans-seams.test.ts` and
// `discipline-plans-volunteer.test.ts` all exercise pure functions directly, so a mis-wired guard, a typo'd
// permission key, or a schema that never reaches the handler is invisible to every one of them — only a
// real `inject()` through the FULL M1 middleware chain (auth → RBAC → ABAC → TypeBox → handler) catches
// that class of bug. This file is that pass, cloned from `orders-routes.test.ts` (the reference
// implementation for this effort): `buildServer()` mounts the host, `mountM15Routes()` mounts the §4.1
// twenty-eight-route inventory over a hand-rolled in-memory `{ readService, writeService }` pair (M15 ships
// no `createInMemory*Backend` export the way M7/M11 do, so this file is that backend, scoped to this file
// only), the REAL Authorization Contract gates every route on the §4.4 permission keys, and the four §4.5
// ABAC predicates M15 owns are built with `buildDisciplinePlanAbacPredicates` over a resolver closed on
// this same in-memory plan store — the `buildOrderAbacPredicates`-over-`createInMemoryOrderBackend` pattern
// M11's test established. A permissive `step_up_recent` stub is registered alongside them (this file's own
// fresh predicate registry, never the shared boot one) so the sign/amend routes' `requireStepUp` gate is
// exercised as PASSING at least once, matching how `discipline_plan.sign` etc. actually behave once M2's
// session step-up is satisfied — the alternative (asserting 403 on every step-up route, as several other
// inject suites do when they reuse the shared un-seeded registry) would leave those routes' 2xx path
// completely unexercised, exactly the gap this file exists to close.
//
// The business RULES (discipline-scope authoring, the 418.78 gate ladder, the §7.8/§7.9 disclosure filter,
// optimistic-concurrency STALE_VERSION) are already pinned by the four pure-function suites above and by
// the Drizzle live suite; this file does not re-derive them. Its in-memory service intentionally skips that
// logic (no state-machine validation, no disclosure filtering) so it can focus on what only `inject()` can
// prove: every one of the twenty-eight routes reaches its handler with the RIGHT permission key, the RIGHT
// ABAC composition, and a body that TypeBox actually validates — a 401 with no session, a 403 with no
// grant, a 422 on a malformed body, and one legitimately-authorized 2xx call per route.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M15_PERMISSION_KEY_LIST,
  buildDisciplinePlanAbacPredicates,
  mountM15Routes,
  type DisciplinePlanAbacResolver,
  type VolunteerGateFacts,
} from "../src/modules/15-discipline-care-plans/index";
import { toCursorPage } from "../src/modules/15-discipline-care-plans/routes/index";
import type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanDetail,
  DisciplinePlanListItem,
  DisciplinePlanSummary,
  DisciplinePlanVersionDetail,
  M15ReadService,
  RelevantElementsView,
  SupervisoryCadenceRowView,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
  VolunteerEffectiveStatusView,
} from "../src/modules/15-discipline-care-plans/routes/read-service";
import type { M15WriteService, VolunteerHourEntryView } from "../src/modules/15-discipline-care-plans/routes/write-service";

// ── the header-auth shim (the M7/M11 precedent), extended with the extra `request.context.attributes`
// M15's route/actor layer reads: `membershipId` (write attribution + `aide_supervisor_eligible`),
// `stepUpRecent` (the write-actor shape) and `actorKind` (the §4.1 `/internal/...` system-principal lock).
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  request.context.attributes.stepUpRecent = true;
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

// ── fixed ids (the M7/M11 style — distinct, valid-`uuid`-format constants) ────────────────────────────
const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const ADMISSION = "44444444-4444-4444-8444-444444444444";
const PROVIDER_ENTITY = "55555555-5555-4555-8555-555555555555";
const LOCATION = "66666666-6666-4666-8666-666666666666";
const RN_MEMBERSHIP = "77777777-7777-4777-8777-777777777777";
const AIDE_MEMBERSHIP = "88888888-8888-4888-8888-888888888888";
const VOLUNTEER = "99999999-9999-4999-8999-999999999999";
const PROBLEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GOAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTERVENTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSESSMENT_DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASSESSMENT_SIGNED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VISIT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ASSIGNMENT = "01010101-0101-4101-8101-010101010101";
const GATE = "02020202-0202-4202-8202-020202020202";
const NOW = "2026-07-30T12:00:00.000Z";

// ── the in-memory M15 backend (this file's own — M15 ships no `createInMemory*Backend`) ────────────────
interface PlanRow extends DisciplinePlanListItem {
  readonly aideMembershipId: string | null;
  readonly supervisingRnMembershipId: string | null;
  readonly supervisoryCadenceDaysOverride: number | null;
  readonly spiritualCareDeclined: string | null;
}
type VersionRow = DisciplinePlanVersionDetail;
interface GoalRow extends DisciplineGoalView {
  readonly planId: string;
}
interface InterventionRow extends DisciplineInterventionView {
  readonly planId: string;
}
interface AssessmentRow extends DisciplineAssessmentView {
  readonly planId: string;
}
interface VisitRow extends AideSupervisoryVisitView {
  readonly planId: string;
}
interface AssignmentRow extends VolunteerAssignmentView {
  readonly planId: string;
}
type GateRow = VolunteerComplianceGateView;

function stripPlan<T extends { planId: string }>(row: T): Omit<T, "planId"> {
  const { planId, ...rest } = row;
  void planId;
  return rest;
}

function createM15Backend(): {
  readonly readService: M15ReadService;
  readonly writeService: M15WriteService;
  readonly abacResolver: DisciplinePlanAbacResolver;
} {
  const plans = new Map<string, PlanRow>();
  const versions = new Map<string, VersionRow>();
  const goals = new Map<string, GoalRow>();
  const interventions = new Map<string, InterventionRow>();
  const assessments = new Map<string, AssessmentRow>();
  const visits = new Map<string, VisitRow>();
  const assignments = new Map<string, AssignmentRow>();
  const gates = new Map<string, GateRow>();
  let hourLedgerTotal = 0;
  let hourEntrySeq = 0;

  plans.set(PLAN, {
    planId: PLAN,
    patientId: PATIENT,
    admissionId: ADMISSION,
    providerEntityId: PROVIDER_ENTITY,
    locationId: LOCATION,
    kind: "aide_poc",
    status: "active",
    nextSupervisoryDueAt: null,
    initialAssessmentClockStartedAt: null,
    initialAssessmentSignedAt: null,
    spiritualCareDeclinedAt: null,
    updatedAt: NOW,
    version: 1,
    aideMembershipId: AIDE_MEMBERSHIP,
    supervisingRnMembershipId: RN_MEMBERSHIP,
    supervisoryCadenceDaysOverride: null,
    spiritualCareDeclined: null,
  });

  versions.set(VERSION, {
    versionId: VERSION,
    planId: PLAN,
    sequence: 1,
    status: "draft",
    kind: "aide_poc",
    idgMeetingId: null,
    finalizedAt: null,
    signedAt: null,
    supersededAt: null,
    version: 1,
    stateSnapshot: {},
    requiredSignerSet: [],
    signatures: [],
  });

  goals.set(GOAL, {
    planId: PLAN,
    goalId: GOAL,
    parentProblemId: PROBLEM,
    parentGoalId: null,
    source: "clinician_authored",
    status: "active",
    originalText: "Seed goal — patient will verbalize reduced pain",
    revisedText: null,
    measurableOutcome: null,
    targetAt: null,
    frequencyText: null,
    frequencyValue: null,
    modalityText: null,
    sudRelated: false,
    addedByDiscipline: "rn_case_manager",
    addedAt: NOW,
    version: 1,
  });

  interventions.set(INTERVENTION, {
    planId: PLAN,
    interventionId: INTERVENTION,
    parentInterventionId: null,
    goalRefs: [GOAL],
    scopeText: "Seed intervention — weekly wound care",
    frequencyText: "1x/week",
    frequencyValue: "1xweek",
    discipline: "rn_case_manager",
    responsibleRoles: ["rn_case_manager"],
    status: "active",
    discontinuationReason: null,
    addedByDiscipline: "rn_case_manager",
    addedAt: NOW,
    version: 1,
  });

  assessments.set(ASSESSMENT_DRAFT, {
    planId: PLAN,
    assessmentId: ASSESSMENT_DRAFT,
    kind: "msw_psychosocial",
    status: "draft",
    capturedAt: NOW,
    isInitial: true,
    sudFlag: false,
    familyViolenceFlag: false,
    sourceEncounterId: null,
    data: { note: "seed draft assessment" },
    amendsAssessmentId: null,
    amendmentReason: null,
    capturedByMembershipId: RN_MEMBERSHIP,
    signedAt: null,
    signedByMembershipId: null,
    version: 1,
  });

  assessments.set(ASSESSMENT_SIGNED, {
    planId: PLAN,
    assessmentId: ASSESSMENT_SIGNED,
    kind: "msw_psychosocial",
    status: "signed",
    capturedAt: NOW,
    isInitial: false,
    sudFlag: false,
    familyViolenceFlag: false,
    sourceEncounterId: null,
    data: { note: "seed signed assessment" },
    amendsAssessmentId: null,
    amendmentReason: null,
    capturedByMembershipId: RN_MEMBERSHIP,
    signedAt: NOW,
    signedByMembershipId: RN_MEMBERSHIP,
    version: 1,
  });

  visits.set(VISIT, {
    planId: PLAN,
    supervisoryVisitId: VISIT,
    aideMembershipId: AIDE_MEMBERSHIP,
    supervisingRnMembershipId: RN_MEMBERSHIP,
    sourceEncounterId: null,
    supervisoryAt: NOW,
    attestationMode: "aide_present",
    aidePerformanceSatisfactory: true,
    correctiveActions: null,
    supervisoryNarrative: "Seed supervisory narrative covering the aide's performance today.",
    nextDueAt: NOW,
    cadenceDaysAtInsert: 14,
    signedAt: null,
    version: 1,
  });

  assignments.set(ASSIGNMENT, {
    planId: PLAN,
    assignmentId: ASSIGNMENT,
    volunteerMembershipId: VOLUNTEER,
    coordinatorMembershipId: RN_MEMBERSHIP,
    activities: ["companionship"],
    startsAt: NOW,
    endsAt: null,
    coordinatorAcknowledgedAt: null,
    inactivatedAt: null,
    inactivationReason: null,
    version: 1,
  });

  gates.set(GATE, {
    gateId: GATE,
    volunteerMembershipId: VOLUNTEER,
    gateKind: "background_check",
    storedStatus: "satisfied",
    effectiveStatus: "satisfied",
    validFrom: NOW,
    validUntil: null,
    revokedAt: null,
    sourceDocumentId: null,
    version: 1,
  });

  function toListItem(row: PlanRow): DisciplinePlanListItem {
    const {
      aideMembershipId,
      supervisingRnMembershipId,
      supervisoryCadenceDaysOverride,
      spiritualCareDeclined,
      ...listItem
    } = row;
    void aideMembershipId;
    void supervisingRnMembershipId;
    void supervisoryCadenceDaysOverride;
    void spiritualCareDeclined;
    return listItem;
  }

  function toVersionListItem(row: VersionRow) {
    const { stateSnapshot, requiredSignerSet, signatures, ...listItem } = row;
    void stateSnapshot;
    void requiredSignerSet;
    void signatures;
    return listItem;
  }

  function toDetail(row: PlanRow): DisciplinePlanDetail {
    return {
      ...row,
      goals: [...goals.values()].filter((g) => g.planId === row.planId).map(stripPlan),
      interventions: [...interventions.values()].filter((i) => i.planId === row.planId).map(stripPlan),
      assessments: [...assessments.values()].filter((a) => a.planId === row.planId).map(stripPlan),
      supervisoryVisits: [...visits.values()].filter((v) => v.planId === row.planId).map(stripPlan),
      volunteerAssignments: [...assignments.values()].filter((a) => a.planId === row.planId).map(stripPlan),
      versions: [...versions.values()].filter((v) => v.planId === row.planId).map(toVersionListItem),
      supervisoryCadence: null,
      redacted_categories: [],
    };
  }

  const readService: M15ReadService = {
    async listPlans() {
      const rows = [...plans.values()];
      return toCursorPage(rows, 25, (r) => ({ a: r.updatedAt, id: r.planId }), toListItem);
    },
    async getPlan(_actor, planId) {
      const row = plans.get(planId);
      return row ? toDetail(row) : null;
    },
    async getPlanSummary(_actor, planId): Promise<DisciplinePlanSummary | null> {
      const row = plans.get(planId);
      if (!row) return null;
      return {
        planId: row.planId,
        kind: row.kind,
        status: row.status,
        goals: [...goals.values()]
          .filter((g) => g.planId === planId)
          .map((g) => ({ goalId: g.goalId, text: g.originalText, status: g.status, targetAt: g.targetAt })),
        interventions: [...interventions.values()]
          .filter((i) => i.planId === planId)
          .map((i) => ({
            interventionId: i.interventionId,
            scopeText: i.scopeText,
            frequencyText: i.frequencyText,
            status: i.status,
          })),
        spiritualCareDeclined: false,
        redacted_categories: [],
      };
    },
    async listVersions(_actor, planId) {
      if (!plans.has(planId)) return null;
      const rows = [...versions.values()].filter((v) => v.planId === planId);
      return toCursorPage(
        rows,
        20,
        (r) => ({ a: String(r.sequence).padStart(6, "0"), id: r.versionId }),
        toVersionListItem,
      );
    },
    async getVersion(_actor, planId, versionId) {
      const row = versions.get(versionId);
      return row && row.planId === planId ? row : null;
    },
    async listVolunteerGates() {
      const rows = [...gates.values()];
      return toCursorPage(rows, 25, (r) => ({ a: r.validFrom, id: r.gateId }), (r) => r);
    },
    async getVolunteerHourRatio(_actor, query) {
      return { providerEntityId: query.providerEntityId, fiscalYear: query.fiscalYear, status: "unavailable" };
    },
    async listRelevantElements() {
      const row = plans.get(PLAN);
      if (!row) return { data: [], next_cursor: null, has_more: false };
      const view: RelevantElementsView = {
        planId: row.planId,
        kind: row.kind,
        status: row.status,
        goals: [...goals.values()].filter((g) => g.planId === row.planId).map(stripPlan),
        interventions: [...interventions.values()].filter((i) => i.planId === row.planId).map(stripPlan),
      };
      return toCursorPage([view], 50, () => ({ a: "0", id: row.planId }), (r) => r);
    },
    async listMswRiskFactors() {
      return { data: [], next_cursor: null, has_more: false };
    },
    async getVolunteerEffectiveStatus(_actor, volunteerMembershipId): Promise<VolunteerEffectiveStatusView> {
      return { volunteerMembershipId, isActive: true, failingGates: [] };
    },
    async listSupervisoryCadence() {
      const row = plans.get(PLAN);
      if (!row) return { data: [], next_cursor: null, has_more: false };
      const cadenceRow: SupervisoryCadenceRowView = {
        planId: row.planId,
        patientId: row.patientId,
        admissionId: row.admissionId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        aideMembershipId: row.aideMembershipId,
        supervisingRnMembershipId: row.supervisingRnMembershipId,
        nextDueAt: NOW,
        cadenceDays: 14,
        status: "on_time",
        hoursOverdue: 0,
        gateEngaged: false,
      };
      return toCursorPage([cadenceRow], 50, () => ({ a: "0", id: row.planId }), (r) => r);
    },
  };

  const writeService: M15WriteService = {
    async finalizeVersion(_actor, _planId, versionId, input) {
      const row = versions.get(versionId);
      if (!row) throw new NotFoundError("plan version not found");
      const updated: VersionRow = {
        ...row,
        status: "in_review",
        finalizedAt: NOW,
        requiredSignerSet: input.requiredSignerSet ?? row.requiredSignerSet,
        version: row.version + 1,
      };
      versions.set(versionId, updated);
      return updated;
    },
    async signVersion(actor, _planId, versionId, input) {
      const row = versions.get(versionId);
      if (!row) throw new NotFoundError("plan version not found");
      const signature = {
        signatureId: `sig-${row.signatures.length + 1}`,
        signerMembershipId: actor.membershipId,
        signerRole: input.signerRole,
        isAcknowledgment: input.isAcknowledgment ?? false,
        signedAt: NOW,
      };
      const updated: VersionRow = {
        ...row,
        status: "signed",
        signedAt: NOW,
        signatures: [...row.signatures, signature],
        version: row.version + 1,
      };
      versions.set(versionId, updated);
      return updated;
    },
    async createGoal(_actor, planId, input) {
      const goalId = `${planId}-goal-${goals.size + 1}`;
      const row: GoalRow = {
        planId,
        goalId,
        parentProblemId: input.parentProblemId,
        parentGoalId: input.parentGoalId ?? null,
        source: input.source,
        status: "active",
        originalText: input.originalText,
        revisedText: null,
        measurableOutcome: input.measurableOutcome ?? null,
        targetAt: input.targetAt ?? null,
        frequencyText: input.frequencyText ?? null,
        frequencyValue: input.frequencyValue ?? null,
        modalityText: input.modalityText ?? null,
        sudRelated: input.sudRelated ?? false,
        addedByDiscipline: input.addedByDiscipline,
        addedAt: NOW,
        version: 1,
      };
      goals.set(goalId, row);
      return stripPlan(row);
    },
    async updateGoal(_actor, _planId, goalId, input) {
      const row = goals.get(goalId);
      if (!row) throw new NotFoundError("goal not found");
      const updated: GoalRow = {
        ...row,
        measurableOutcome: input.measurableOutcome ?? row.measurableOutcome,
        targetAt: input.targetAt ?? row.targetAt,
        frequencyText: input.frequencyText ?? row.frequencyText,
        frequencyValue: input.frequencyValue ?? row.frequencyValue,
        modalityText: input.modalityText ?? row.modalityText,
        version: row.version + 1,
      };
      goals.set(goalId, updated);
      return stripPlan(updated);
    },
    async createIntervention(_actor, planId, input) {
      const interventionId = `${planId}-intervention-${interventions.size + 1}`;
      const row: InterventionRow = {
        planId,
        interventionId,
        parentInterventionId: input.parentInterventionId ?? null,
        goalRefs: input.goalRefs ?? [],
        scopeText: input.scopeText,
        frequencyText: input.frequencyText,
        frequencyValue: input.frequencyValue,
        discipline: input.discipline,
        responsibleRoles: input.responsibleRoles ?? [],
        status: "active",
        discontinuationReason: null,
        addedByDiscipline: input.addedByDiscipline,
        addedAt: NOW,
        version: 1,
      };
      interventions.set(interventionId, row);
      return stripPlan(row);
    },
    async updateIntervention(_actor, _planId, interventionId, input) {
      const row = interventions.get(interventionId);
      if (!row) throw new NotFoundError("intervention not found");
      const updated: InterventionRow = {
        ...row,
        scopeText: input.scopeText ?? row.scopeText,
        frequencyText: input.frequencyText ?? row.frequencyText,
        frequencyValue: input.frequencyValue ?? row.frequencyValue,
        responsibleRoles: input.responsibleRoles ?? row.responsibleRoles,
        version: row.version + 1,
      };
      interventions.set(interventionId, updated);
      return stripPlan(updated);
    },
    async createAssessment(actor, planId, input) {
      const assessmentId = `${planId}-assessment-${assessments.size + 1}`;
      const row: AssessmentRow = {
        planId,
        assessmentId,
        kind: input.kind,
        status: "draft",
        capturedAt: input.capturedAt,
        isInitial: input.isInitial ?? false,
        sudFlag: input.sudFlag ?? false,
        familyViolenceFlag: input.familyViolenceFlag ?? false,
        sourceEncounterId: input.sourceEncounterId ?? null,
        data: input.data,
        amendsAssessmentId: null,
        amendmentReason: null,
        capturedByMembershipId: actor.membershipId,
        signedAt: null,
        signedByMembershipId: null,
        version: 1,
      };
      assessments.set(assessmentId, row);
      return stripPlan(row);
    },
    async signAssessment(actor, _planId, assessmentId) {
      const row = assessments.get(assessmentId);
      if (!row) throw new NotFoundError("assessment not found");
      const updated: AssessmentRow = {
        ...row,
        status: "signed",
        signedAt: NOW,
        signedByMembershipId: actor.membershipId,
        version: row.version + 1,
      };
      assessments.set(assessmentId, updated);
      return stripPlan(updated);
    },
    async amendAssessment(actor, planId, assessmentId, input) {
      const original = assessments.get(assessmentId);
      if (!original) throw new NotFoundError("assessment not found");
      const amendmentId = `${assessmentId}-amend`;
      const row: AssessmentRow = {
        planId,
        assessmentId: amendmentId,
        kind: original.kind,
        status: "signed",
        capturedAt: NOW,
        isInitial: false,
        sudFlag: original.sudFlag,
        familyViolenceFlag: original.familyViolenceFlag,
        sourceEncounterId: original.sourceEncounterId,
        data: input.data,
        amendsAssessmentId: assessmentId,
        amendmentReason: input.amendmentReason,
        capturedByMembershipId: actor.membershipId,
        signedAt: NOW,
        signedByMembershipId: actor.membershipId,
        version: 1,
      };
      assessments.set(amendmentId, row);
      return stripPlan(row);
    },
    async createSupervisoryVisit(_actor, planId, input) {
      const supervisoryVisitId = `${planId}-visit-${visits.size + 1}`;
      const row: VisitRow = {
        planId,
        supervisoryVisitId,
        aideMembershipId: input.aideMembershipId,
        supervisingRnMembershipId: input.supervisingRnMembershipId,
        sourceEncounterId: input.sourceEncounterId,
        supervisoryAt: input.supervisoryAt,
        attestationMode: input.attestationMode,
        aidePerformanceSatisfactory: input.aidePerformanceSatisfactory,
        correctiveActions: input.correctiveActions,
        supervisoryNarrative: input.supervisoryNarrative,
        nextDueAt: NOW,
        cadenceDaysAtInsert: 14,
        signedAt: null,
        version: 1,
      };
      visits.set(supervisoryVisitId, row);
      return stripPlan(row);
    },
    async signSupervisoryVisit(_actor, _planId, visitId) {
      const row = visits.get(visitId);
      if (!row) throw new NotFoundError("supervisory visit not found");
      const updated: VisitRow = { ...row, signedAt: NOW, version: row.version + 1 };
      visits.set(visitId, updated);
      return stripPlan(updated);
    },
    async createVolunteerAssignment(actor, planId, input) {
      const assignmentId = `${planId}-assignment-${assignments.size + 1}`;
      const row: AssignmentRow = {
        planId,
        assignmentId,
        volunteerMembershipId: input.volunteerMembershipId,
        coordinatorMembershipId: actor.membershipId,
        activities: input.activities,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        coordinatorAcknowledgedAt: null,
        inactivatedAt: null,
        inactivationReason: null,
        version: 1,
      };
      assignments.set(assignmentId, row);
      return stripPlan(row);
    },
    async updateVolunteerAssignment(_actor, _planId, assignmentId, input) {
      const row = assignments.get(assignmentId);
      if (!row) throw new NotFoundError("volunteer assignment not found");
      const updated: AssignmentRow = {
        ...row,
        activities: input.activities ?? row.activities,
        endsAt: input.endsAt !== undefined ? input.endsAt : row.endsAt,
        coordinatorAcknowledgedAt: input.coordinatorAcknowledged ? NOW : row.coordinatorAcknowledgedAt,
        inactivatedAt: input.inactivate ? NOW : row.inactivatedAt,
        inactivationReason: input.inactivate ? input.inactivate.reason : row.inactivationReason,
        version: row.version + 1,
      };
      assignments.set(assignmentId, updated);
      return stripPlan(updated);
    },
    async createVolunteerGate(_actor, input) {
      const gateId = `gate-${gates.size + 1}`;
      const row: GateRow = {
        gateId,
        volunteerMembershipId: input.volunteerMembershipId,
        gateKind: input.gateKind,
        storedStatus: "satisfied",
        effectiveStatus: "satisfied",
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        revokedAt: null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        version: 1,
      };
      gates.set(gateId, row);
      return row;
    },
    async updateVolunteerGate(_actor, gateId, input) {
      const row = gates.get(gateId);
      if (!row) throw new NotFoundError("volunteer compliance gate not found");
      const updated: GateRow = {
        ...row,
        validUntil: input.validUntil !== undefined ? input.validUntil : row.validUntil,
        sourceDocumentId: input.sourceDocumentId !== undefined ? input.sourceDocumentId : row.sourceDocumentId,
        version: row.version + 1,
      };
      gates.set(gateId, updated);
      return updated;
    },
    async revokeVolunteerGate(_actor, gateId) {
      const row = gates.get(gateId);
      if (!row) throw new NotFoundError("volunteer compliance gate not found");
      const updated: GateRow = {
        ...row,
        revokedAt: NOW,
        storedStatus: "revoked",
        effectiveStatus: "revoked",
        version: row.version + 1,
      };
      gates.set(gateId, updated);
      return updated;
    },
    async createHourEntry(_actor, input): Promise<VolunteerHourEntryView> {
      hourEntrySeq += 1;
      hourLedgerTotal += input.durationMinutes;
      return {
        hourEntryId: `hour-${hourEntrySeq}`,
        ledgerId: `ledger-${input.providerEntityId}-${input.fiscalYear}`,
        volunteerMembershipId: input.volunteerMembershipId,
        source: "manual",
        durationMinutes: input.durationMinutes,
        occurredAt: input.occurredAt,
        ledgerTotalMinutes: hourLedgerTotal,
      };
    },
  };

  const abacResolver: DisciplinePlanAbacResolver = {
    async loadPlanScope(orgId, planId) {
      if (orgId !== ORG) return null;
      const row = plans.get(planId);
      if (!row) return null;
      return {
        organizationId: ORG,
        patientId: row.patientId,
        locationId: row.locationId,
        supervisingRnMembershipId: row.supervisingRnMembershipId as never,
        aideMembershipId: row.aideMembershipId as never,
      };
    },
    async loadVolunteerGates(orgId, volunteerMembershipId) {
      if (orgId !== ORG) return null;
      return [...gates.values()]
        .filter((g) => g.volunteerMembershipId === volunteerMembershipId)
        .map(
          (g): VolunteerGateFacts => ({
            gateId: g.gateId,
            volunteerMembershipId: g.volunteerMembershipId as never,
            gateKind: g.gateKind as never,
            status: g.storedStatus as never,
            validFrom: g.validFrom as never,
            validUntil: g.validUntil as never,
            revokedAt: g.revokedAt as never,
          }),
        );
    },
  };

  return { readService, writeService, abacResolver };
}

// ── server assembly (the M11 `makeServer()` precedent) ──────────────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "volunteer_coordinator,rn_case_manager,clinical_supervisor",
  "x-test-membership": RN_MEMBERSHIP,
};
const SYSTEM_HEADERS = { ...SUPER_HEADERS, "x-test-actor-kind": "system_seam" };
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM15Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    { orgId: ORG, userId: "super_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...M15_PERMISSION_KEY_LIST] }] },
    { orgId: ORG, userId: "none_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }] },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent): the four §4.5 predicates M15 owns,
  // built over THIS backend's resolver, plus a permissive `step_up_recent` stub so the sign/amend routes'
  // `requireStepUp` gate has a real PASSING path in this file (see the file banner).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildDisciplinePlanAbacPredicates({ resolver: backend.abacResolver }))) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM15Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── §4.1 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────
describe("M15 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/discipline-plans" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M15 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discipline-plans",
      headers: NONE_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/discipline-plans/${PLAN}/goals`,
      headers: { ...SUPER_HEADERS, "idempotency-key": "k-422" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file) ──────────────────────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = (key: string) => ({ "idempotency-key": key });
const IFM = { "if-match": "1" };

const ROUTE_CASES: readonly RouteCase[] = [
  // 1–5 — plan / version reads.
  { label: "1 GET /discipline-plans", method: "GET", url: "/api/v1/discipline-plans", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "2 GET /discipline-plans/:planId", method: "GET", url: `/api/v1/discipline-plans/${PLAN}`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "3 GET /discipline-plans/:planId/summary", method: "GET", url: `/api/v1/discipline-plans/${PLAN}/summary`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "4 GET /discipline-plans/:planId/versions", method: "GET", url: `/api/v1/discipline-plans/${PLAN}/versions`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "5 GET /discipline-plans/:planId/versions/:versionId", method: "GET", url: `/api/v1/discipline-plans/${PLAN}/versions/${VERSION}`, headers: SUPER_HEADERS, expectStatus: 200 },

  // 6–7 — the version finalize / sign ladder.
  {
    label: "6 POST .../versions/:versionId/finalize",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/versions/${VERSION}/finalize`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k6"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "7 POST .../versions/:versionId/sign",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/versions/${VERSION}/sign`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k7"), ...IFM },
    payload: { signerRole: "rn_case_manager", attestationText: "I attest this plan version as accurate." },
    expectStatus: 200,
  },

  // 8–11 — goal / intervention authoring.
  {
    label: "8 POST .../goals",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/goals`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k8") },
    payload: {
      parentProblemId: PROBLEM,
      source: "clinician_authored",
      originalText: "Patient will verbalize reduced pain within two weeks",
      addedByDiscipline: "rn_case_manager",
    },
    expectStatus: 201,
  },
  {
    label: "9 PATCH .../goals/:goalId",
    method: "PATCH",
    url: `/api/v1/discipline-plans/${PLAN}/goals/${GOAL}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k9"), ...IFM },
    payload: { measurableOutcome: "Pain <=3/10 on the numeric scale" },
    expectStatus: 200,
  },
  {
    label: "10 POST .../interventions",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/interventions`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k10") },
    payload: {
      scopeText: "Weekly spiritual-care support visit",
      frequencyText: "1x/week",
      frequencyValue: "1xweek",
      discipline: "chaplain",
      addedByDiscipline: "chaplain",
    },
    expectStatus: 201,
  },
  {
    label: "11 PATCH .../interventions/:interventionId",
    method: "PATCH",
    url: `/api/v1/discipline-plans/${PLAN}/interventions/${INTERVENTION}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k11"), ...IFM },
    payload: { scopeText: "Biweekly wound care visit" },
    expectStatus: 200,
  },

  // 12–14 — assessment capture / sign / amend.
  {
    label: "12 POST .../assessments",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/assessments`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k12") },
    payload: { kind: "msw_psychosocial", capturedAt: NOW, data: { note: "captured at intake" } },
    expectStatus: 201,
  },
  {
    label: "13 POST .../assessments/:assessmentId/sign",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/assessments/${ASSESSMENT_DRAFT}/sign`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k13"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "14 POST .../assessments/:assessmentId/amend",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/assessments/${ASSESSMENT_SIGNED}/amend`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k14"), ...IFM },
    payload: { amendmentReason: "Corrected the psychosocial risk coding", data: { note: "corrected" } },
    expectStatus: 201,
  },

  // 15–16 — the §418.76(h) RN supervisory attestation.
  {
    label: "15 POST .../aide-supervisory-visits",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/aide-supervisory-visits`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k15") },
    payload: {
      aideMembershipId: AIDE_MEMBERSHIP,
      supervisingRnMembershipId: RN_MEMBERSHIP,
      sourceEncounterId: null,
      supervisoryAt: NOW,
      attestationMode: "aide_present",
      aidePerformanceSatisfactory: true,
      correctiveActions: null,
      supervisoryNarrative: "Observed the aide performing personal care tasks satisfactorily today.",
    },
    expectStatus: 201,
  },
  {
    label: "16 POST .../aide-supervisory-visits/:visitId/sign",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/aide-supervisory-visits/${VISIT}/sign`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k16"), ...IFM },
    payload: {},
    expectStatus: 200,
  },

  // 17–18 — volunteer assignments.
  {
    label: "17 POST .../volunteer-assignments",
    method: "POST",
    url: `/api/v1/discipline-plans/${PLAN}/volunteer-assignments`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k17") },
    payload: {
      volunteerMembershipId: VOLUNTEER,
      activities: ["companionship"],
      startsAt: NOW,
      // §8.6 documented override — skips the `volunteer_compliance_active` gate (see guards.ts); this
      // file does not separately seed a fully 418.78-compliant gate set to reach the non-override path.
      overrideReason: "No 418.78 gate rows seeded in this smoke test; documented override per §8.6.",
    },
    expectStatus: 201,
  },
  {
    label: "18 PATCH .../volunteer-assignments/:assignmentId",
    method: "PATCH",
    url: `/api/v1/discipline-plans/${PLAN}/volunteer-assignments/${ASSIGNMENT}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k18"), ...IFM },
    payload: { coordinatorAcknowledged: true },
    expectStatus: 200,
  },

  // 19–22 — the 418.78 compliance-gate worklist.
  { label: "19 GET /volunteer-compliance-gates", method: "GET", url: "/api/v1/volunteer-compliance-gates", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "20 POST /volunteer-compliance-gates",
    method: "POST",
    url: "/api/v1/volunteer-compliance-gates",
    headers: { ...SUPER_HEADERS, ...IDEMP("k20") },
    payload: { volunteerMembershipId: VOLUNTEER, gateKind: "background_check", validFrom: NOW, validUntil: null },
    expectStatus: 201,
  },
  {
    label: "21 PATCH /volunteer-compliance-gates/:gateId",
    method: "PATCH",
    url: `/api/v1/volunteer-compliance-gates/${GATE}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k21"), ...IFM },
    payload: { notes: "renewed evidence on file" },
    expectStatus: 200,
  },
  {
    label: "22 POST /volunteer-compliance-gates/:gateId/revoke",
    method: "POST",
    url: `/api/v1/volunteer-compliance-gates/${GATE}/revoke`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k22"), ...IFM },
    payload: { revokedReason: "volunteer resigned" },
    expectStatus: 200,
  },

  // 23–24 — the 418.78(e) hour ratio + ledger.
  {
    label: "23 GET /volunteer-hour-ratio",
    method: "GET",
    url: `/api/v1/volunteer-hour-ratio?providerEntityId=${PROVIDER_ENTITY}&fiscalYear=2026`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "24 POST /volunteer-hour-entries",
    method: "POST",
    url: "/api/v1/volunteer-hour-entries",
    headers: { ...SUPER_HEADERS, ...IDEMP("k24") },
    payload: {
      providerEntityId: PROVIDER_ENTITY,
      fiscalYear: 2026,
      volunteerMembershipId: VOLUNTEER,
      durationMinutes: 60,
      occurredAt: NOW,
      adjustmentReason: "manual correction of a missed visit",
    },
    expectStatus: 201,
  },

  // 25–28 — the `/internal/...` system-principal seam surface.
  { label: "25 GET /internal/.../relevant-elements", method: "GET", url: "/internal/discipline-plans/relevant-elements", headers: SYSTEM_HEADERS, expectStatus: 200 },
  {
    label: "26 GET /internal/.../msw-risk-factors",
    method: "GET",
    url: `/internal/discipline-plans/msw-risk-factors?admissionId=${ADMISSION}`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
  {
    label: "27 GET /internal/.../volunteer-effective-status",
    method: "GET",
    url: `/internal/discipline-plans/volunteer-effective-status?volunteerMembershipId=${VOLUNTEER}`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
  { label: "28 GET /internal/.../supervisory-cadence", method: "GET", url: "/internal/discipline-plans/supervisory-cadence", headers: SYSTEM_HEADERS, expectStatus: 200 },
];

describe.each(ROUTE_CASES)("M15 route smoke — $label", (c) => {
  it(`reaches its handler and returns ${c.expectStatus}`, async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: c.method, url: c.url, headers: c.headers, payload: c.payload });
    expect(res.statusCode).toBe(c.expectStatus);
    await app.close();
  });
});

// ── §4.1 the SYSTEM-principal lock on the internal seam surface — a non-system session is refused even
// holding the `*_internal` permission key (the second lock `requireSystemPrincipal()` is the point of).
describe("M15 route smoke — the /internal seam's system-principal lock", () => {
  it("403s a staff session (no `system*` actorKind) even with the *_internal grant", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discipline-plans/relevant-elements",
      headers: SUPER_HEADERS, // holds discipline_plan.read_internal, but carries no system actorKind
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
