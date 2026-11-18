// modules-preview fixtures for M15 Discipline Care Plans. Typed against the module's own wire shapes so a drifted
// field fails the typecheck instead of rendering blank. Every name and id is invented.
import type {
  AssessmentView,
  AssignmentView,
  CursorPage,
  GateView,
  GoalView,
  HourRatioView,
  InterventionView,
  PlanDetail,
  PlanListItem,
  PlanSummary,
  SupervisoryVisitView,
  VersionDetail,
  VersionListItem,
} from "../modules/15-discipline-care-plans/discipline-api";
import { disciplinePlanScreens } from "../modules/15-discipline-care-plans/screens";
import type { Fixtures } from "./mock-client";
import type { ModulePreview } from "./types";

const PATIENT = "p-rivera";
const NOW = Date.now();
const iso = (days: number): string => new Date(NOW + days * 864e5).toISOString();
const page = <T>(data: T[]): CursorPage<T> => ({ data, next_cursor: null, has_more: false });

const goals: GoalView[] = [
  ["g1", "Keep pain at or below 3/10 at rest", "in_progress"],
  ["g2", "Family can name the comfort-kit steps", "in_progress"],
  ["g3", "Complete the life-review conversation", "met"],
].map(([goalId, text, status]) => ({
  goalId: goalId as string,
  parentProblemId: null,
  parentGoalId: null,
  source: "clinical",
  status: status as string,
  originalText: text as string,
  revisedText: null,
  measurableOutcome: "Reported at each visit",
  targetAt: iso(21),
  frequencyText: "Every visit",
  frequencyValue: "1",
  modalityText: null,
  sudRelated: false,
  addedByDiscipline: "msw",
  addedAt: iso(-20),
  version: 1,
}));

const interventions: InterventionView[] = [
  ["i1", "Weekly supportive counselling with patient and daughter", "Weekly", ["g3"]],
  ["i2", "Teach comfort-kit use and when to call the nurse", "Once, then review", ["g2"]],
  ["i3", "Review pain scores and report a change to the RN", "Every visit", ["g1"]],
].map(([interventionId, scopeText, frequencyText, goalRefs]) => ({
  interventionId: interventionId as string,
  parentInterventionId: null,
  goalRefs: goalRefs as string[],
  scopeText: scopeText as string,
  frequencyText: frequencyText as string,
  frequencyValue: "1",
  discipline: "msw",
  responsibleRoles: ["msw"],
  status: "active",
  discontinuationReason: null,
  addedByDiscipline: "msw",
  addedAt: iso(-20),
  version: 1,
}));

const assessments: AssessmentView[] = [
  ["a1", "initial_psychosocial", "signed", true],
  ["a2", "reassessment", "draft", false],
].map(([assessmentId, kind, status, isInitial]) => ({
  assessmentId: assessmentId as string,
  kind: kind as string,
  status: status as string,
  capturedAt: iso(-18),
  isInitial: isInitial as boolean,
  sudFlag: false,
  familyViolenceFlag: false,
  sourceEncounterId: null,
  data: { narrative: "Patient and daughter engaged; coping well." },
  amendsAssessmentId: null,
  amendmentReason: null,
  capturedByMembershipId: "m-lopez",
  signedAt: status === "signed" ? iso(-17) : null,
  signedByMembershipId: status === "signed" ? "m-lopez" : null,
  version: 1,
}));

const supervisoryVisits: SupervisoryVisitView[] = [
  {
    supervisoryVisitId: "sv1",
    aideMembershipId: "m-park",
    supervisingRnMembershipId: "m-lopez",
    sourceEncounterId: null,
    supervisoryAt: iso(-9),
    attestationMode: "in_person",
    aidePerformanceSatisfactory: true,
    correctiveActions: null,
    supervisoryNarrative: "Care delivered per plan; patient comfortable.",
    nextDueAt: iso(5),
    cadenceDaysAtInsert: 14,
    signedAt: iso(-9),
    version: 1,
  },
];

const volunteerAssignments: AssignmentView[] = [
  {
    assignmentId: "va1",
    volunteerMembershipId: "m-chen",
    coordinatorMembershipId: "m-kim",
    activities: ["companionship", "respite"],
    startsAt: iso(-12),
    endsAt: null,
    coordinatorAcknowledgedAt: iso(-12),
    inactivatedAt: null,
    inactivationReason: null,
    version: 1,
  },
];

const versions: VersionListItem[] = [
  {
    versionId: "v2",
    planId: "plan-msw",
    sequence: 2,
    status: "draft",
    kind: "interim_revision",
    idgMeetingId: null,
    finalizedAt: null,
    signedAt: null,
    supersededAt: null,
    version: 1,
  },
  {
    versionId: "v1",
    planId: "plan-msw",
    sequence: 1,
    status: "signed",
    kind: "initial",
    idgMeetingId: null,
    finalizedAt: iso(-17),
    signedAt: iso(-17),
    supersededAt: null,
    version: 3,
  },
];

const planRow = (kind: PlanListItem["kind"], planId: string, status: string): PlanListItem => ({
  planId,
  patientId: PATIENT,
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  kind,
  status,
  nextSupervisoryDueAt: kind === "aide_poc" ? iso(5) : null,
  initialAssessmentClockStartedAt: iso(-18),
  initialAssessmentSignedAt: iso(-17),
  spiritualCareDeclinedAt: null,
  updatedAt: iso(-1),
  version: 4,
  actionSummary: {
    openVersion: { versionId: "v2", sequence: 2, status: "draft", kind: "interim_revision" },
    latestSignedVersion: { versionId: "v1", sequence: 1, signedAt: iso(-17) },
    missingSignerRoles: ["msw"],
    ownerMembershipIds: [],
    idgDecisionId: null,
  },
});

const rows: PlanListItem[] = [
  planRow("aide_poc", "plan-aide", "active"),
  planRow("msw_plan", "plan-msw", "draft_revising"),
  planRow("spiritual_plan", "plan-spiritual", "active"),
  planRow("volunteer_plan", "plan-volunteer", "active"),
];

const detail = (planId: string): PlanDetail => {
  const row = rows.find((r) => r.planId === planId) ?? (rows[1] as PlanListItem);
  return {
    ...row,
    aideMembershipId: "m-park",
    supervisingRnMembershipId: "m-lopez",
    supervisoryCadenceDaysOverride: null,
    spiritualCareDeclined: null,
    goals,
    interventions,
    assessments,
    supervisoryVisits: row.kind === "aide_poc" ? supervisoryVisits : [],
    volunteerAssignments: row.kind === "volunteer_plan" ? volunteerAssignments : [],
    versions,
    supervisoryCadence:
      row.kind === "aide_poc"
        ? { nextDueAt: iso(5), cadenceDays: 14, status: "on_track", hoursOverdue: 0 }
        : null,
    redacted_categories: [],
  };
};

const versionDetail: VersionDetail = {
  ...(versions[1] as VersionListItem),
  stateSnapshot: { goals, interventions },
  requiredSignerSet: [{ role: "msw", count: 1, isAcknowledgment: false }],
  signatures: [
    {
      signatureId: "sig1",
      signerMembershipId: "m-lopez",
      signerRole: "msw",
      isAcknowledgment: false,
      signedAt: iso(-17),
    },
  ],
};

const summary: PlanSummary = {
  planId: "plan-msw",
  kind: "msw_plan",
  status: "active",
  goals: goals.map((g) => ({
    goalId: g.goalId,
    text: g.originalText,
    status: g.status,
    targetAt: g.targetAt,
  })),
  interventions: interventions.map((i) => ({
    interventionId: i.interventionId,
    scopeText: i.scopeText,
    frequencyText: i.frequencyText,
    status: i.status,
  })),
  spiritualCareDeclined: false,
  redacted_categories: [],
};

const gates: GateView[] = [
  ["background_check", "active", iso(-300), iso(65)],
  ["tb_screening", "expiring", iso(-350), iso(14)],
  ["orientation", "expired", iso(-400), iso(-10)],
].map(([gateKind, effectiveStatus, validFrom, validUntil], i) => ({
  gateId: `gate${i}`,
  volunteerMembershipId: "m-chen",
  gateKind: gateKind as string,
  storedStatus: effectiveStatus as string,
  effectiveStatus: effectiveStatus as string,
  validFrom: validFrom as string,
  validUntil: validUntil as string,
  revokedAt: null,
  sourceDocumentId: null,
  version: 1,
}));

const ratio: HourRatioView = {
  providerEntityId: "pe-1",
  fiscalYear: new Date(NOW).getFullYear(),
  volunteerHourMinutes: 21_600,
  staffPatientCareMinutes: 372_000,
  ratio: 0.058,
  status: "compliant",
};

const fixtures: Fixtures = {
  "/api/v1/patients/{id}": {
    id: PATIENT,
    organizationId: "org-1",
    mrn: "MRN-0007",
    firstName: "June",
    lastName: "Rivera",
    dob: "1950-02-14",
    status: "active",
  },
  "/api/v1/discipline-plans": ({ params }: { params?: { query?: Record<string, string> } }) => {
    const kind = params?.query?.kind;
    return page(kind ? rows.filter((r) => r.kind === kind) : rows);
  },
  "/api/v1/discipline-plans/{planId}": ({
    params,
  }: { params?: { path?: Record<string, string> } }) => detail(params?.path?.planId ?? ""),
  "/api/v1/discipline-plans/{planId}/summary": summary,
  "/api/v1/discipline-plans/{planId}/versions": page(versions),
  "/api/v1/discipline-plans/{planId}/versions/{versionId}": versionDetail,
  "/api/v1/volunteer-compliance-gates": page(gates),
  "/api/v1/volunteer-hour-ratio": ratio,
};

export const preview15: ModulePreview = {
  screens: disciplinePlanScreens,
  fixtures,
  start: `/patients/${PATIENT}/discipline-plans`,
  // Beyond each screen's read key: the author/sign/finalize actions the screens gate their buttons on.
  extraPermissions: [
    "discipline_plan.author",
    "discipline_plan.sign",
    "discipline_plan.finalize",
    "discipline_assessment.author",
  ],
};
