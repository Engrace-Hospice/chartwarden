// Dev-only visual harness (mock ApiClient, no backend) for the patient Clinical tab + M14 IDG screens. Not a build entry: vite.config.ts builds index.html only. Open via `vite` at /clinical-preview.html?idg=<live|detail|minutes|packet|schedule|actions>.
import "@fontsource-variable/inter";
import "./index.css";
import {
  type ApiClient,
  ApiClientProvider,
  FeatureFlagProvider,
  SystemStatusProvider,
  ToastProvider,
} from "@wardenx/ui";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PatientChart } from "./modules/05-patient/patient-chart";
import { CarePlanView } from "./modules/07-care-plan/care-plan-view";
import { PatientOrders } from "./modules/11-orders/patient-orders";
import { PatientMedications } from "./modules/12-dosespot/patient-medications";
import { IdgSchedule } from "./modules/14-idg/idg-schedule";
import { LiveMeeting } from "./modules/14-idg/live-meeting";
import { MeetingDetail } from "./modules/14-idg/meeting-detail";
import { Minutes } from "./modules/14-idg/minutes";
import { MyActionItems } from "./modules/14-idg/my-action-items";
import { PatientIdgHistory } from "./modules/14-idg/patient-idg-history";
import { PatientPacket } from "./modules/14-idg/patient-packet";
import { CalendarPage } from "./modules/17-scheduling/calendar-page";
import { DocumentExplorer } from "./modules/22-documents/document-explorer";
import { PatientDocuments } from "./modules/22-documents/patient-documents";
import { ArDashboard } from "./modules/23-billing-medicare/ar-dashboard";
import { PatientClaims } from "./modules/23-billing-medicare/patient-claims";
import { TransferNotices } from "./modules/23-billing-medicare/transfer-notices";
import { AppLayout } from "./shell/layout";
import { PRIMARY_NAV } from "./shell/primary-nav";
import { RoleHome } from "./shell/role-home";
import { SessionProvider } from "./shell/session";

document.documentElement.classList.toggle("dark", new URLSearchParams(location.search).has("dark"));
const now = Date.now();
const d = (n: number) => new Date(now - n * 864e5).toISOString();
const esas = (n: number, v: Record<string, number>) => ({
  id: `e${n}`,
  scaleType: "esas_r",
  data: v,
  score: 0,
  scoreInterpretation: null,
  capturedAt: d(n),
});
const routes: Record<string, unknown> = {
  "/api/v1/patients/{id}": {
    id: "p1",
    organizationId: "o",
    mrn: "MRN-88901325A7AC",
    firstName: "Henry",
    lastName: "Nakamura",
    dob: "1936-01-18",
    status: "prospective",
  },
  "/api/v1/patients/{id}/demographics": { sexAssignedAtBirth: "M" },
  "/api/v1/patients/{id}/identifiers": {
    identifiers: [{ kind: "mbi", value: null, last4: "5234" }],
  },
  "/api/v1/patients/{id}/addresses": { addresses: [] },
  "/api/v1/patients/{id}/care-team": {
    assignments: [],
    emergencyContacts: [
      {
        id: "k1",
        name: "Aiko Nakamura",
        relationship: "daughter",
        phone: "(541) 555-0123",
        priority: 1,
      },
      {
        id: "k2",
        name: "David Nakamura",
        relationship: "son",
        phone: "(541) 555-0456",
        priority: 2,
      },
    ],
  },
  "/api/v1/orgs/{id}/members": {
    members: [
      { membershipId: "m1", userId: "x", displayName: "Maria Lopez, RN" },
      { membershipId: "m2", userId: "y", displayName: "Sarah Patel, LCSW" },
      { membershipId: "m3", userId: "z", displayName: "Dr. James Wilson" },
    ],
  },
  "/api/v1/patients/{patientId}/care-plan": {
    problems: [
      {
        id: "a",
        icd10Code: "C34.90",
        description: "Malignant neoplasm of bronchus and lung, unspecified",
        kind: "terminal",
        status: "active",
        onsetAt: "2024-10-12",
      },
      {
        id: "b",
        icd10Code: "I48.91",
        description: "Atrial fibrillation",
        kind: "related",
        status: "active",
      },
      {
        id: "c",
        icd10Code: "E11.9",
        description: "Type 2 diabetes mellitus",
        kind: "related",
        status: "active",
      },
      { id: "e", icd10Code: "J44.9", description: "COPD", kind: "related", status: "active" },
      {
        id: "f",
        icd10Code: "I10",
        description: "Essential (primary) hypertension",
        kind: "related",
        status: "active",
      },
      {
        id: "g",
        icd10Code: "G89.3",
        description: "Neoplasm related pain",
        kind: "related",
        status: "active",
      },
    ],
  },
  "/api/v1/patients/{patientId}/election-certification": {
    admission: null,
    periods: [
      { id: "pr", sequenceNumber: 1, effectiveAt: d(4), scheduledEndAt: d(-86), status: "active" },
    ],
    complianceWindows: [],
  },
  "/api/v1/encounters": {
    encounters: [
      {
        id: "n1",
        serviceDate: d(4).slice(0, 10),
        status: "signed",
        encounterType: "routine_visit",
        authoredByUserId: "x",
      },
      {
        id: "n2",
        serviceDate: d(7).slice(0, 10),
        status: "signed",
        encounterType: "msw_followup",
        authoredByUserId: "y",
      },
      {
        id: "n3",
        serviceDate: d(10).slice(0, 10),
        status: "signed",
        encounterType: "face_to_face",
        authoredByUserId: "z",
      },
    ],
  },
  "/api/v1/visits": [
    {
      id: "v1",
      assignedMembershipId: "m1",
      visitPurpose: "sn_visit",
      scheduledStartedAt: d(-1),
      status: "scheduled",
    },
    {
      id: "v2",
      assignedMembershipId: "m2",
      visitPurpose: "idg_meeting",
      scheduledStartedAt: d(-3),
      status: "scheduled",
    },
  ],
  "/api/v1/documents": {
    items: [
      { id: "d1", title: "SN Visit Note", aggregateType: "clinical_note", createdAt: d(4) },
      { id: "d2", title: "Plan of Care v2", aggregateType: "care_plan", createdAt: d(7) },
      { id: "d3", title: "Comfort Kit Order", aggregateType: "order", createdAt: d(10) },
      {
        id: "d4",
        title: "Comprehensive Assessment",
        aggregateType: "assessment",
        createdAt: d(15),
      },
    ],
  },
  "/api/v1/patients/{patientId}/medications/active": { orders: [] },
  "/api/v1/patients/{id}/privacy-flags": { flags: [], sudRestricted: false },
  "/api/v1/patients/{patientId}/scales/{scaleType}/series": {
    points: [30, 24, 17, 10, 3].map((n, i) => ({
      assessmentId: `p${i}`,
      capturedAt: d(n),
      score: [70, 70, 60, 50, 50][i],
      scoreInterpretation: null,
      significantChange: false,
    })),
  },
  "/api/v1/patients/{patientId}/scales/{scaleType}/latest": {
    id: "p",
    scaleType: "pps",
    data: { selfCare: "considerable_assist", consciousness: "full" },
    score: 50,
    capturedAt: d(3),
  },
  "/api/v1/patients/{patientId}/assessments": {
    assessments: [
      esas(6, {
        pain: 4,
        shortnessOfBreath: 5,
        nausea: 2,
        anxiety: 3,
        tiredness: 5,
        lackOfAppetite: 5,
      }),
      esas(4, {
        pain: 3,
        shortnessOfBreath: 4,
        nausea: 1,
        anxiety: 2,
        tiredness: 6,
        lackOfAppetite: 4,
      }),
      esas(2, {
        pain: 4,
        shortnessOfBreath: 3,
        nausea: 2,
        anxiety: 2,
        tiredness: 5,
        lackOfAppetite: 5,
      }),
      esas(1, {
        pain: 3,
        shortnessOfBreath: 4,
        nausea: 1,
        anxiety: 2,
        tiredness: 6,
        lackOfAppetite: 4,
      }),
    ],
  },
  "/api/v1/patients/{patientId}/significant-changes": {
    events: [
      { id: "s1", ruleId: "painad_ge_4", status: "open", severity: "high" },
      { id: "s2", ruleId: "morse_ge_51", status: "open", severity: "medium" },
    ],
  },
  "/api/v1/patients/{patientId}/consents": {
    data: [
      {
        id: "c1",
        typeKey: "advance_directive_acknowledgment",
        status: "active",
        signedAt: "2024-08-15",
      },
      { id: "c2", typeKey: "dpoa_healthcare", status: "active", signedAt: "2024-08-15" },
    ],
  },
  "/api/v1/patients/{patientId}/dpoa/active-primary": {
    data: {
      agentName: "Aiko Nakamura",
      agentRelationship: "daughter",
      scopeKind: "healthcare_full",
    },
  },
};
const med = (
  id: string,
  drugName: string,
  strength: string,
  dose: [number, string],
  route: string,
  freq: string,
  prn: string | null,
  status: string,
  days: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  patientId: "p1",
  medClass: "standard",
  status,
  drugName,
  strength,
  doseForm: "tablet",
  route,
  isControlledSubstance: false,
  deaSchedule: null,
  refillsAuthorized: 2,
  refillsRemaining: 2,
  cosignRequired: false,
  cosignStatus: null,
  prescriberDiscipline: "md",
  createdAt: d(days),
  signedAt: d(days),
  discontinuedAt: null,
  discontinuationReason: null,
  data: {
    sigStructured: {
      doseQuantity: dose[0],
      doseUnit: dose[1],
      route,
      frequencyCode: freq,
      asNeeded: Boolean(prn),
      asNeededReasonCode: prn ?? undefined,
    },
  },
  ...extra,
});
routes["/api/v1/medication-orders"] = {
  orders: [
    med("m1", "Morphine sulfate", "10 mg/5 mL", [5, "mg"], "po", "q4h", "pain", "active", 15, {
      medClass: "controlled_substance",
      isControlledSubstance: true,
      deaSchedule: "II",
      refillsAuthorized: 0,
      refillsRemaining: 0,
      data: {
        sigStructured: {
          doseQuantity: 5,
          doseUnit: "mg",
          route: "po",
          frequencyCode: "q4h",
          asNeeded: true,
          asNeededReasonCode: "moderate_to_severe_pain",
        },
        sigFreeText: "Start low, monitor for sedation and constipation. Educate family on PRN use.",
        daysSupply: 14,
      },
    }),
    med("m2", "Lorazepam", "0.5 mg", [0.5, "mg"], "po", "q6h", "anxiety", "active", 15, {
      medClass: "controlled_substance",
      isControlledSubstance: true,
      deaSchedule: "IV",
    }),
    med("m3", "Senna", "8.6 mg", [8.6, "mg"], "po", "BID", null, "active", 14),
    med("m4", "Acetaminophen", "650 mg", [650, "mg"], "po", "q6h", "pain_fever", "active", 14),
    med("m5", "Haloperidol", "0.5 mg", [0.5, "mg"], "po", "q4h", "agitation_nausea", "active", 10),
    med("m6", "Hyoscyamine", "0.125 mg", [0.125, "mg"], "sl", "q4h", "secretions", "active", 10),
    med("m7", "Duloxetine", "30 mg", [30, "mg"], "po", "Daily", null, "pending_signature", 2),
    med("m8", "Metformin", "500 mg", [500, "mg"], "po", "BID", null, "discontinued", 36, {
      discontinuedAt: d(3),
      discontinuationReason: "Deprescribed — goals of care",
    }),
  ],
};
const pr = (id: string, icd10Code: string, description: string, kind = "related") => ({
  id,
  planId: "cp1",
  icd10Code,
  snomedCode: null,
  description,
  kind,
  source: "clinical",
  sudRelated: false,
  status: "active",
  onsetAt: null,
  resolvedAt: null,
  resolutionNote: null,
  version: 1,
});
const goal = (
  id: string,
  problemId: string,
  text: string,
  outcome: string,
  status: string,
  note: string,
) => ({
  id,
  planId: "cp1",
  problemId,
  originalText: text,
  revisedText: null,
  source: "clinical",
  actingConsentId: null,
  measurableOutcome: outcome,
  targetAt: "2026-10-21",
  status,
  statusNote: note,
  version: 1,
});
const iv = (
  id: string,
  problemId: string,
  goalRefs: string[],
  scopeText: string,
  discipline: string,
  freq: string,
  status = "active",
) => ({
  id,
  planId: "cp1",
  problemId,
  goalRefs,
  scopeText,
  frequencyText: freq,
  frequencyValue: "",
  discipline,
  responsibleRole: null,
  linkedOrderId: null,
  status,
  discontinueReason: null,
  version: 1,
});
const carePlan = {
  id: "cp1",
  patientId: "p1",
  admissionId: "ad1",
  status: "active",
  activeVersionId: "v2",
  version: 3,
  redacted: false,
  versions: [
    {
      id: "v2",
      planId: "cp1",
      sequence: 2,
      kind: "idg_review",
      status: "active",
      idgMeetingId: null,
      requiredSignerSet: [],
      signatures: [],
      draftedAt: "2026-09-19",
      signedAt: "2026-09-21",
      supersededAt: null,
      version: 2,
    },
    {
      id: "v3",
      planId: "cp1",
      sequence: 3,
      kind: "interim_revision",
      status: "draft",
      idgMeetingId: null,
      requiredSignerSet: [],
      signatures: [],
      draftedAt: "2026-09-24",
      signedAt: null,
      supersededAt: null,
      version: 1,
    },
  ],
  problems: [
    pr("a", "C34.90", "Lung cancer", "terminal"),
    pr("b", "R06.00", "Dyspnea"),
    pr("c", "R63.0", "Impaired nutrition"),
    pr("e", "G89.29", "Chronic pain"),
    pr("f", "G47.00", "Insomnia"),
    pr("g", "Z91.81", "Fall risk"),
  ],
  goals: [
    goal(
      "g1",
      "b",
      "Maintain comfortable breathing",
      "Dyspnea ≤ 3/10",
      "in_progress",
      "Patient will report breathing comfort at rest.",
    ),
    goal(
      "g2",
      "c",
      "Maintain adequate nutrition",
      "> 50% of meals",
      "in_progress",
      "Patient will maintain adequate oral intake as tolerated.",
    ),
    goal(
      "g3",
      "e",
      "Maintain pain at acceptable level",
      "Pain ≤ 3/10",
      "in_progress",
      "Patient will report pain ≤ 3/10 most of the time.",
    ),
    goal(
      "g4",
      "a",
      "Maintain dignity and quality of life",
      "Family reports satisfaction",
      "in_progress",
      "Patient and family will verbalize satisfaction with quality of life.",
    ),
    goal(
      "g5",
      "f",
      "Improve sleep",
      "≥ 6 hours/night",
      "met",
      "Patient will sleep at least 6 hours per night.",
    ),
    goal(
      "g6",
      "g",
      "Maintain safety and prevent falls",
      "0 falls",
      "not_met",
      "Patient will remain free from falls during hospice care.",
    ),
  ],
  interventions: [
    iv("i1", "b", ["g1"], "Assess respiratory status and titrate oxygen", "rn", "Every visit"),
    iv("i2", "c", ["g2"], "Assist with meals and oral care", "chha", "3x weekly"),
    iv("i3", "e", ["g3"], "Pain assessment and medication review", "md_np", "Weekly"),
    iv("i4", "a", ["g4"], "Psychosocial support and advance care planning", "msw", "2x monthly"),
    iv("i5", "f", ["g5"], "Spiritual support and sleep hygiene discussion", "chaplain", "Monthly"),
    iv("i6", "g", ["g6"], "Home safety evaluation", "rn", "Once", "discontinued"),
  ],
};
routes["/api/v1/patients/{patientId}/care-plan"] = carePlan;
routes["/api/v1/care-plans/{planId}/readiness"] = {
  planId: "cp1",
  openVersionId: "v3",
  canFinalize: true,
  canSign: false,
  blockers: [],
  signatures: { required: [], collected: [], missing: [] },
};
routes["/api/v1/care-plans/{planId}/review-status"] = {
  planId: "cp1",
  nextReviewDueAt: d(-26),
  status: "not_due",
  overdueByDays: 0,
  openReviewVersionId: null,
  openReviewVersionStatus: null,
  canStartReview: false,
};
const details: Record<string, unknown> = {
  n1: {
    id: "n1",
    serviceDate: d(4).slice(0, 10),
    encounterType: "routine_visit",
    authoredByUserId: "x",
    status: "signed",
    finalDocumentation: "Increased dyspnea with exertion. Educated family on energy conservation.",
    vitals: {
      bpSystolic: 118,
      bpDiastolic: 72,
      heartRate: 78,
      respiratoryRate: 18,
      temperature: "98.2",
      temperatureUnit: "F",
      spo2: 94,
      weight: "150",
      weightUnit: "lb",
      capturedAt: d(4),
    },
  },
  n2: {
    id: "n2",
    serviceDate: d(7).slice(0, 10),
    encounterType: "msw_followup",
    authoredByUserId: "y",
    status: "signed",
    finalDocumentation: "Family coping well. Discussed respite options.",
    vitals: null,
  },
  n3: {
    id: "n3",
    serviceDate: d(10).slice(0, 10),
    encounterType: "face_to_face",
    authoredByUserId: "z",
    status: "signed",
    finalDocumentation: "Pain well controlled. Continue current regimen.",
    vitals: null,
  },
};
const ord = (
  id: string,
  kind: string,
  status: string,
  days: number,
  mdm: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id,
  patientId: "p1",
  admissionId: "ad1",
  kind,
  status,
  priority: "routine",
  version: 1,
  drafterMembershipId: "m1",
  drafterDiscipline: "rn",
  orderingPhysicianMdmId: mdm,
  cosignRequired: false,
  cosignStatus: null,
  transmissionStatus: "not_required",
  resultsStatus: "not_expected",
  verbalDeadlineAt: null,
  discontinuationReason: null,
  replacesOrderId: null,
  triggeringAssessmentId: null,
  triggeringHopeAssessmentId: null,
  signedAt:
    status === "draft" || status === "pending_signature" || status === "verbal_pending"
      ? null
      : d(days),
  signedBy: null,
  completedAt: status === "completed" ? d(days - 2) : null,
  createdAt: d(days),
  __data: data,
  ...extra,
});
const orders = [
  ord("o1", "comfort_kit", "active", 4, "phy1", {
    kitSku: "CK-STD-01",
    deploymentSite: "patient_home",
    notes: "Morphine, lorazepam, haloperidol, atropine",
  }),
  ord("o2", "dme", "active", 4, "phy2", { notes: "Oxygen concentrator 2 L/min via nasal cannula" }),
  ord(
    "o3",
    "ancillary_service",
    "verbal_pending",
    1,
    "phy1",
    { notes: "SN visit 2x per week — assess symptoms, med review" },
    { verbalDeadlineAt: d(-1.2), priority: "asap" },
  ),
  ord("o4", "level_of_care_change", "pending_signature", 2, "phy2", {
    fromLevel: "rhc",
    toLevel: "chc",
    effectiveAt: d(-1),
    clinicalJustification: "Uncontrolled dyspnea requiring continuous nursing",
  }),
  ord("o5", "dme", "completed", 7, "phy1", {
    notes: "Semi-electric hospital bed with rails and mattress",
  }),
  ord(
    "o6",
    "supply",
    "discontinued",
    10,
    "phy1",
    { notes: "Incontinence supplies" },
    { discontinuationReason: "no_longer_indicated" },
  ),
  ord("o7", "lab", "completed", 15, "phy2", {
    testCodes: [{ code: "58410-2", display: "CBC with Differential" }],
    clinicalJustification: "Routine lab work",
    priority: "routine",
  }),
  ord("o8", "recertification", "draft", 0, "phy1", {
    periodEndDate: "2026-12-19",
    certifyingPhysicianMdmId: "phy1",
  }),
];
routes["/api/v1/orders"] = { orders };
const mdm: Record<string, string> = { phy1: "Dr. Maria Lopez", phy2: "Dr. James Wilson" };
routes["/api/v1/patients/{id}/care-team"] = {
  caregivers: [],
  emergencyContacts: (routes["/api/v1/patients/{id}/care-team"] as { emergencyContacts: unknown[] })
    .emergencyContacts,
  assignments: [
    {
      id: "a1",
      clinicianUserId: "x",
      role: "primary_rn",
      assignedAt: d(20),
      unassignedAt: null,
      current: true,
    },
    {
      id: "a2",
      clinicianUserId: "y",
      role: "case_manager_msw",
      assignedAt: d(20),
      unassignedAt: null,
      current: true,
    },
    {
      id: "a3",
      clinicianUserId: "c",
      role: "chaplain",
      assignedAt: d(19),
      unassignedAt: null,
      current: true,
    },
    {
      id: "a4",
      clinicianUserId: "h",
      role: "aide",
      assignedAt: d(18),
      unassignedAt: null,
      current: true,
    },
    {
      id: "a5",
      clinicianUserId: "z",
      role: "md",
      assignedAt: d(20),
      unassignedAt: null,
      current: true,
    },
  ],
};
(routes["/api/v1/orgs/{id}/members"] as { members: unknown[] }).members.push(
  { membershipId: "m4", userId: "c", displayName: "David Kim" },
  { membershipId: "m5", userId: "h", displayName: "Linda Kim" },
);
const mt = (
  id: string,
  days: number,
  status: string,
  decisions: [string, boolean][],
  items: [string, number][],
) => ({
  meetingId: id,
  status,
  scheduledStart: d(days),
  actualStart: status === "adjourned" ? d(days) : null,
  actualEnd: null,
  reviewedAt: status === "adjourned" ? d(days) : null,
  packetFrozenAt: null,
  decisions: decisions.map(([k, q], i) => ({
    id: `${id}d${i}`,
    decisionKind: k,
    status: "emitted",
    wasQuorate: q,
    recordedAt: d(days),
  })),
  actionItems: items.map(([st, due], i) => ({
    id: `${id}a${i}`,
    status: st,
    discipline: "rn",
    dueDate: d(due).slice(0, 10),
    closedAt: null,
  })),
});
routes["/api/v1/patients/{patientId}/idg-history"] = {
  meetings: [
    mt("mt0", -3, "packets_ready", [], []),
    mt(
      "mt1",
      11,
      "adjourned",
      [
        ["care_plan_update", true],
        ["medication_change", true],
      ],
      [
        ["open", 2],
        ["in_progress", -3],
        ["open", -1],
      ],
    ),
    mt(
      "mt2",
      28,
      "adjourned",
      [["symptom_management", true]],
      [
        ["completed", 20],
        ["open", 5],
      ],
    ),
    mt("mt3", 42, "adjourned", [["psychosocial_plan", false]], [["completed", 35]]),
    mt("mt4", 56, "adjourned", [], []),
  ],
};
routes["/api/v1/locations"] = {
  items: [{ id: "loc1", name: "Pendleton Office", status: "active" }],
};
routes["/api/v1/idg/schedule"] = [];
const hoursFromNow = (h: number) => new Date(now + h * 36e5).toISOString();
const homeRoutes: Record<string, unknown> = {
  "/api/v1/patients/census-metrics": {
    total: 58,
    byStatus: { active: 42, prospective: 6, discharged: 7, deceased: 3 },
  },
  "/api/v1/referrals": {
    items: [
      { id: "r1", state: "received" },
      { id: "r2", state: "triaged" },
    ],
    nextCursor: null,
  },
  "/api/v1/admissions": {
    items: [...Array(6)]
      .map((_, i) => ({ id: `ad${i}`, state: "pending" }))
      .concat([{ id: "ax", state: "active" }]),
    nextCursor: null,
  },
  "/api/v1/hope/schedules": {
    schedules: [
      {
        id: "h1",
        patientId: "pp2",
        admissionId: "ad1",
        rfaKind: "01_admission",
        status: "open",
        windowOpensAt: d(5),
        windowClosesAt: d(0).slice(0, 10),
        lateDeadlineAt: d(-3),
      },
      {
        id: "h2",
        patientId: "pp3",
        admissionId: "ad2",
        rfaKind: "02_huv1",
        status: "open",
        windowOpensAt: d(3),
        windowClosesAt: d(-1).slice(0, 10),
        lateDeadlineAt: d(-3),
      },
      {
        id: "h3",
        patientId: "pp5",
        admissionId: "ad3",
        rfaKind: "04_sfv",
        status: "open",
        windowOpensAt: d(3),
        windowClosesAt: d(-3).slice(0, 10),
        lateDeadlineAt: d(-5),
      },
      {
        id: "h4",
        patientId: "pp4",
        admissionId: "ad4",
        rfaKind: "03_huv2",
        status: "open",
        windowOpensAt: d(3),
        windowClosesAt: d(-5).slice(0, 10),
        lateDeadlineAt: d(-7),
      },
      {
        id: "h5",
        patientId: "pp6",
        admissionId: "ad5",
        rfaKind: "01_admission",
        status: "open",
        windowOpensAt: d(3),
        windowClosesAt: d(2).slice(0, 10),
        lateDeadlineAt: d(-7),
      },
    ],
  },
  "/api/v1/locations": { items: [{ id: "loc1", name: "Pendleton Office", status: "active" }] },
  "/api/v1/idg/schedule": [
    {
      id: "i1",
      locationId: "loc1",
      status: "scheduled",
      scheduledStart: hoursFromNow(1),
      scheduledEnd: hoursFromNow(2),
    },
    {
      id: "i2",
      locationId: "loc1",
      status: "scheduled",
      scheduledStart: hoursFromNow(3),
      scheduledEnd: hoursFromNow(4),
    },
  ],
  "/api/v1/idg/action-items": [
    {
      id: "a1",
      meetingId: "i0",
      decisionId: null,
      patientId: "pp4",
      assignedToMembershipId: "me",
      status: "open",
      dueDate: d(-2),
      linkedArtifactKind: "care_plan_version",
    },
  ],
  "/api/v1/orders": {
    orders: [
      {
        id: "o1",
        patientId: "pp1",
        kind: "comfort_kit",
        status: "pending_signature",
        verbalDeadlineAt: null,
      },
      {
        id: "o2",
        patientId: "pp5",
        kind: "dme",
        status: "pending_signature",
        verbalDeadlineAt: d(-1),
      },
    ],
  },
  "/api/v1/encounters/my-drafts": {
    encounters: [{ id: "e1", patientId: "pp1", encounterType: "routine_visit" }],
  },
  "/api/v1/visits": [
    {
      id: "v1",
      patientId: "pp1",
      visitPurpose: "routine_visit",
      scheduledStartedAt: hoursFromNow(0.5),
      status: "scheduled",
    },
    {
      id: "v2",
      patientId: "pp2",
      visitPurpose: "admission_visit",
      scheduledStartedAt: hoursFromNow(2),
      status: "scheduled",
    },
    {
      id: "v3",
      patientId: "pp3",
      visitPurpose: "msw_followup",
      scheduledStartedAt: hoursFromNow(4),
      status: "scheduled",
    },
  ],
  "/api/v1/safety/dashboard": { activeSosCount: 0, overdueCheckInCount: 1, clinicians: [] },
  "/api/v1/quality/incidents": {
    items: [{ id: "q1", state: "submitted", severity: "severe" }],
    nextCursor: null,
  },
  "/api/v1/billing/ar-dashboard": {
    bucket0to30Cents: 18450000,
    bucket31to60Cents: 4120000,
    bucket61to90Cents: 1530000,
    bucket90PlusCents: 425000,
  },
  "/api/v1/billing/metrics": {
    buckets: [
      { key: "ready_to_submit", count: 7, amountCents: 0 },
      { key: "submitted", count: 5, amountCents: 0 },
      { key: "rejected", count: 2, amountCents: 0 },
      { key: "paid", count: 30, amountCents: 0 },
    ],
  },
  "/api/v1/patients": {
    items: [
      { id: "pp1", firstName: "Henry", lastName: "Nakamura", dob: "1936-01-18", status: "active" },
      {
        id: "pp2",
        firstName: "Maria",
        lastName: "Lopez",
        dob: "1948-04-02",
        status: "prospective",
      },
      { id: "pp3", firstName: "James", lastName: "Wilson", dob: "1952-11-14", status: "active" },
      { id: "pp4", firstName: "Linda", lastName: "Kim", dob: "1957-05-06", status: "active" },
      { id: "pp5", firstName: "Robert", lastName: "Chen", dob: "1939-08-21", status: "active" },
      {
        id: "pp6",
        firstName: "Patricia",
        lastName: "Davis",
        dob: "1944-02-11",
        status: "prospective",
      },
    ],
    nextCursor: null,
  },
};

const docDefs: [string, string, string, string, number, boolean][] = [
  ["Plan of Care", "other", "manual_upload", "active", 1, false],
  ["Physician Certification", "cti", "fax", "active", 4, false],
  ["HOPE Assessment", "other", "manual_upload", "active", 4, false],
  ["Face Sheet", "intake_source", "fax", "active", 5, true],
  ["Medication List", "other", "email", "active", 5, true],
  ["Patient POLST", "code_status_directive", "scanned_physical", "active", 6, true],
  ["Hospice Election Statement", "election_statement", "manual_upload", "active", 8, false],
  ["Notice of Rights", "notice_of_rights", "manual_upload", "uploaded", 8, false],
  ["Referral Packet", "referral", "fax", "active", 9, false],
  ["Hospice consent", "consent_record", "scanned_physical", "active", 9, false],
  ["Wound photo", "other", "manual_upload", "rendering", 11, false],
  ["Discharge summary (hospital)", "intake_source", "fax", "active", 12, false],
];
routes["/api/v1/documents"] = {
  items: docDefs.map(([title, type, src, status, age, pf], i) => ({
    id: `doc${i}`,
    patientId: "p1",
    admissionId: null,
    retentionClass: "clinical_record",
    aggregateType: "patient",
    aggregateId: "p1",
    title,
    patientFacing: pf,
    metadata: { documentType: type, sourceChannel: src },
    status,
    version: 1,
    versionsCount: 1,
    createdAt: d(age),
    updatedAt: d(age),
  })),
};
routes["/api/v1/documents/{id}/versions"] = {
  items: [
    {
      id: "ver1",
      documentId: "doc",
      versionNumber: 2,
      mimeType: "application/pdf",
      byteSize: 184320,
      uploadedAt: d(1),
      createdAt: d(1),
    },
  ],
};

// ── ?sched: Scheduling calendar ──
const isSched = new URLSearchParams(location.search).has("sched");
const mon = new Date();
mon.setHours(0, 0, 0, 0);
mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
const at = (day: number, h: number, m = 0) =>
  new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + day, h, m).toISOString();
const staffDefs: [string, string, string][] = [
  ["m1", "Maria Lopez", "rn"],
  ["m2", "James Wilson", "md"],
  ["m3", "Sarah Patel", "msw"],
  ["m4", "David Kim", "chaplain"],
  ["m5", "Linda Kim", "chha"],
  ["m6", "Robert Chen", "chha"],
  ["m7", "Elizabeth Garcia", "rn"],
];
const schedPatients = [
  "Henry Nakamura",
  "Barbara Park",
  "Thomas Kim",
  "Robert Chen",
  "Aiko Nakamura",
  "James Wilson",
  "Maria Lopez",
  "David Lee",
  "Linda Kim",
  "Elizabeth Garcia",
];
const vdefs: [number, number, number, string, number, string, string, number?][] = [
  [0, 8, 0, "m1", 0, "routine_visit", "published", 60],
  [0, 10, 0, "m1", 1, "routine_visit", "completed"],
  [0, 11, 0, "m3", 2, "msw_assessment", "completed"],
  [0, 13, 0, "m6", 3, "aide_poc", "completed"],
  [0, 15, 0, "m4", 4, "chaplain_visit", "completed"],
  [1, 9, 0, "m2", 5, "f2f", "published"],
  [1, 11, 0, "m3", 6, "msw_followup", "published"],
  [1, 14, 0, "m1", 6, "recert", "published"],
  [1, 16, 0, "m5", 7, "aide_poc", "published"],
  [2, 8, 0, "m5", 8, "aide_poc", "en_route"],
  [2, 10, 0, "m7", 9, "routine_visit", "published"],
  [2, 13, 0, "m1", 0, "routine_visit", "published", 30],
  [2, 13, 15, "m2", 1, "f2f", "published"],
  [2, 15, 0, "m2", 5, "routine_visit", "cancelled"],
  [3, 9, 0, "m1", 6, "prn", "in_visit"],
  [3, 11, 0, "m6", 3, "aide_poc", "published"],
  [3, 14, 0, "m7", 1, "routine_visit", "published"],
  [4, 8, 0, "m3", 2, "msw_followup", "published"],
  [4, 11, 0, "m1", 2, "loc_change", "published"],
  [4, 14, 0, "m3", 7, "msw_assessment", "published"],
  [4, 16, 0, "m4", 4, "chaplain_assessment", "published"],
  [5, 10, 0, "m4", 0, "chaplain_visit", "published"],
  [6, 11, 0, "m1", 3, "prn", "published"],
  [6, 14, 30, "m2", 9, "f2f", "published"],
];
const schedVisits = vdefs.map(([day, h, m, staff, pi, purpose, status, dur], i) => ({
  id: `sv${i}`,
  patientId: `sp${pi}`,
  admissionId: `sa${pi}`,
  assignedMembershipId: staff,
  visitPurpose: purpose,
  visitSetting:
    purpose === "f2f" && day === 6 ? "telephonic" : pi === 7 ? "facility" : "patient_home",
  scheduledStartedAt: at(day, h, m),
  scheduledEndedAt: new Date(Date.parse(at(day, h, m)) + (dur ?? 60) * 6e4).toISOString(),
  serviceDate: at(day, 0).slice(0, 10),
  status,
  patientAddressId: null,
  externalFacilityId: null,
  rescheduledIntoVisitId: null,
}));
const schedPatient = (id: string) => {
  const i = Number(id.slice(2));
  const [f, l] = schedPatients[i]!.split(" ");
  return {
    id,
    firstName: f,
    lastName: l,
    mrn: `MRN-4410${i}A7AC`,
    dob: `19${36 + i}-01-18`,
    status: "active",
  };
};
const schedPerms = [
  "visit.read",
  "visit.read_team",
  "visit.create",
  "visit.proposal.read",
  "recurring_visit.read",
  "time_off.read_team",
  "membership_credential.read",
  "availability.read",
  "visit.read_metrics",
];
const schedGet = (
  p: string,
  o?: { params?: { path?: Record<string, string>; query?: Record<string, string> } },
): unknown => {
  const path = o?.params?.path ?? {};
  const q = o?.params?.query ?? {};
  if (p === "/api/v1/visits")
    return schedVisits.filter(
      (v) => (!q.from || v.scheduledStartedAt >= q.from) && (!q.to || v.scheduledStartedAt <= q.to),
    );
  if (p === "/api/v1/patients/{id}") return schedPatient(path.id!);
  if (p === "/api/v1/orgs/{id}/members")
    return {
      members: staffDefs.map(([id, name]) => ({
        membershipId: id,
        displayName: name,
        email: null,
        status: "active",
      })),
    };
  if (p === "/api/v1/memberships/{membershipId}/credentials")
    return staffDefs
      .filter(([id]) => id === path.membershipId && id !== "m7")
      .map(([, , d]) => ({ credentialType: d, status: "active" }));
  if (p === "/api/v1/availability")
    return q.membership === "m6"
      ? null
      : {
          slots: [0, 1, 2, 3, 4, 5, 6].map((w) => ({
            weekday: w,
            startTime: q.membership === "m4" ? "13:00" : "07:00",
            endTime: q.membership === "m4" ? "14:00" : "23:00",
          })),
        };
  if (p === "/api/v1/time-off")
    return [{ membershipId: "m7", startsAt: at(-1, 0), endsAt: at(8, 0), state: "approved" }];
  if (p === "/api/v1/visit-proposals")
    return [
      {
        id: "pr1",
        patientId: "sp5",
        proposedVisitPurpose: "prn",
        proposedForDate: at(2, 12).slice(0, 10),
        status: "pending",
      },
      {
        id: "pr2",
        patientId: "sp3",
        proposedVisitPurpose: "routine_visit",
        proposedForDate: at(3, 12).slice(0, 10),
        status: "pending",
      },
      {
        id: "pr3",
        patientId: "sp4",
        proposedVisitPurpose: "aide_poc",
        proposedForDate: at(4, 12).slice(0, 10),
        status: "pending",
      },
    ];
  if (p === "/api/v1/encounters")
    return {
      encounters: [
        {
          id: "en1",
          patientId: "sp1",
          admissionId: "sa1",
          visitId: "sv1",
          encounterType: "routine_visit",
          discipline: "rn",
          serviceDate: "",
          status: "signed",
          signedAt: at(0, 11),
          cosignedAt: null,
        },
      ],
    };
  return undefined;
};

// ── ?billing ──
const isBilling = new URLSearchParams(location.search).has("billing");
const claimStates = [
  "paid",
  "ack_pending",
  "denied",
  "paid",
  "submitted",
  "ready",
  "partial_paid",
  "validating",
  "paid",
  "draft",
  "ack_accepted",
  "paid",
  "submitted",
];
const billingGet = (p: string, o?: { params?: { path?: Record<string, string> } }): unknown => {
  if (p === "/api/v1/billing/claims")
    return {
      items: claimStates.map((st, i) => ({
        claimId: `c${i}`,
        patientId: `sp${i % 10}`,
        tob: i % 4 === 0 ? "811" : "813",
        state: st,
        serviceFrom: i < 6 ? "2026-09-01" : "2026-08-01",
        serviceTo: i < 6 ? "2026-09-30" : "2026-08-31",
        claimControlNumber: `CLM-000${229 + i}`,
        macJurisdiction: "J15",
        totalChargeCents: 180000 + i * 23117,
        totalExpectedPaymentCents: 170000 + i * 21000,
      })),
      nextCursor: "n",
      hasMore: true,
    };
  if (p === "/api/v1/billing/ar-dashboard")
    return {
      bucket0to30Cents: 1845000,
      bucket31to60Cents: 312000,
      bucket61to90Cents: 86000,
      bucket90PlusCents: 27000,
    };
  if (p === "/api/v1/billing/metrics")
    return {
      buckets: [
        { key: "draft", count: 3, amountCents: 0 },
        { key: "validating", count: 2, amountCents: 0 },
        { key: "ready", count: 4, amountCents: 0 },
        { key: "submitted", count: 11, amountCents: 0 },
        { key: "ack_pending", count: 7, amountCents: 0 },
        { key: "paid", count: 15, amountCents: 3842000 },
        { key: "partial_paid", count: 1, amountCents: 120000 },
        { key: "denied", count: 2, amountCents: 0 },
      ],
    };
  if (p === "/api/v1/noe-records")
    return {
      items: [
        {
          state: "submitted",
          windowTargetAt: new Date(now + 864e5).toISOString(),
          windowBreachedAt: null,
        },
        {
          state: "draft",
          windowTargetAt: new Date(now + 5 * 864e5).toISOString(),
          windowBreachedAt: null,
        },
      ],
    };
  if (p === "/api/v1/notr-records")
    return { items: [{ state: "draft", windowTargetAt: null, windowBreachedAt: d(1) }] };
  if (p === "/api/v1/patients/{id}") return schedPatient(o?.params?.path?.id ?? "sp0");
  return undefined;
};

// ── ?explorer ──
const isExplorer = new URLSearchParams(location.search).has("explorer");
const explorerGet = (p: string, o?: { params?: { path?: Record<string, string> } }): unknown => {
  if (p === "/api/v1/documents") {
    const base = (routes["/api/v1/documents"] as { items: Record<string, unknown>[] }).items.map(
      (x, i) => ({
        ...x,
        patientId: `sp${i % 6}`,
        retentionClass: i === 11 ? "compliance_42cfr_part2" : x.retentionClass,
      }),
    );
    return {
      items: [
        ...base,
        {
          ...base[8],
          id: "docr",
          patientId: null,
          aggregateType: "referral",
          aggregateId: "ref1",
          title: "Referral fax — St. Mary's",
          metadata: { documentType: "referral", sourceChannel: "fax" },
          retentionClass: "intake_artifact",
          status: "uploaded",
        },
      ],
      nextCursor: "n",
      hasMore: true,
    };
  }
  if (p === "/api/v1/patients/{id}") return schedPatient(o?.params?.path?.id ?? "sp0");
  return undefined;
};
// ── ?xfer: Billing → Transfers (TOB 8xC worklist + rail) ──
const isXfer = new URLSearchParams(location.search).has("xfer");
const xferNotice = (i: number, over: Record<string, unknown>) => ({
  transferNoticeId: `tn${i}`,
  patientId: `xp${i}`,
  admissionId: `xa${i}`,
  action: "original",
  supersedesNoticeId: null,
  state: "draft",
  tob: "81C",
  statementFromDate: "2026-09-21",
  originalTransferDate: null,
  admissionDate: "2026-09-21",
  benefitPeriodSequence: 2,
  benefitPeriodStartDate: "2026-07-01",
  priorHospiceName: "Sunrise Hospice of Salem",
  priorHospiceCcn: "381777",
  priorHospiceNpi: "1234567893",
  providerCcn: "381501",
  priorBillingConfirmedAt: null,
  priorHospiceThroughDate: null,
  priorHospicePatientStatus: null,
  controlNumber: `381501-260921-a${i}c4e-00`,
  payerControlNumber: null,
  latestSubmissionOutcome: null,
  cancelReason: null,
  blockers: [
    {
      code: "PRIOR_BILLING_NOT_CONFIRMED",
      message:
        "Confirm that the transferring hospice has finalized its billing. The transfer notice is not submitted until then.",
      citation: "CMS Pub. 100-04 ch. 11 §20.1.3",
    },
  ],
  warnings: [],
  conditionCodes: [],
  occurrenceCodes: [],
  allowedActions: ["confirm_prior_billing", "cancel"],
  followUp: null,
  version: 2,
  createdAt: "2026-09-22T00:00:00Z",
  ...over,
});
const xferGet = (p: string): unknown => {
  if (p === "/api/v1/billing/transfer-notices")
    return {
      items: [
        xferNotice(0, {}),
        xferNotice(1, {
          state: "ready",
          blockers: [],
          priorBillingConfirmedAt: "2026-09-30T00:00:00Z",
          priorHospiceThroughDate: "2026-09-21",
          priorHospicePatientStatus: "50",
          allowedActions: ["confirm_prior_billing", "submit", "cancel"],
          priorHospiceName: "Cascade Valley Hospice",
        }),
        xferNotice(2, {
          state: "ack_accepted",
          blockers: [],
          statementFromDate: "2026-08-04",
          benefitPeriodStartDate: "2026-08-04",
          occurrenceCodes: [{ code: "27", date: "2026-08-04" }],
          payerControlNumber: "21926080400512",
          allowedActions: ["correct_date", "void"],
          priorHospiceName: "Willamette Hospice",
        }),
      ],
      nextCursor: null,
      hasMore: false,
    };
  if (p === "/api/v1/patients/{id}") return { firstName: "Margaret", lastName: "Hale" };
  return undefined;
};
// ── ?pclaims: patient chart Claims tab ──
const isPClaims = new URLSearchParams(location.search).has("pclaims");
const pclaimsGet = (p: string): unknown => {
  const mc: [string, string, string, string][] = [
    ["paid", "2026-06-01", "2026-06-30", "811"],
    ["paid", "2026-07-01", "2026-07-31", "813"],
    ["denied", "2026-08-01", "2026-08-31", "813"],
    ["replaced", "2026-08-01", "2026-08-31", "813"],
    ["ack_pending", "2026-08-01", "2026-08-31", "817"],
    ["submitted", "2026-09-01", "2026-09-24", "813"],
  ];
  if (p === "/api/v1/billing/claims")
    return {
      items: mc.map(([state, f, t2, tob], i) => ({
        claimId: `pc${i}`,
        patientId: "p1",
        tob,
        state,
        serviceFrom: f,
        serviceTo: t2,
        claimControlNumber: `CLM-000${229 + i}`,
        macJurisdiction: "J15",
        totalChargeCents: 610000 + i * 14250,
        totalExpectedPaymentCents: 587500 + i * 13100,
      })),
    };
  if (p === "/api/v1/medicaid-claims")
    return {
      items: [
        {
          id: "mc1",
          serviceState: "OR",
          kind: "RB",
          tob: "813",
          serviceFrom: "2026-08-01",
          serviceTo: "2026-08-31",
          medicaidClaimControlNumber: "MCD-00417",
          state: "AWAITING_MEDICARE_PRIMARY",
        },
        {
          id: "mc2",
          serviceState: "OR",
          kind: "RB",
          tob: "813",
          serviceFrom: "2026-07-01",
          serviceTo: "2026-07-31",
          medicaidClaimControlNumber: "MCD-00388",
          state: "PAID",
        },
      ],
    };
  if (p === "/api/v1/noe-records")
    return {
      items: [
        {
          noeId: "n1",
          state: "ack_accepted",
          noeControlNumber: "NOE-20417",
          electionEffectiveDate: "2026-06-03",
          windowTargetAt: "2026-06-08T00:00:00Z",
          windowBreachedAt: null,
        },
      ],
    };
  if (p === "/api/v1/notr-records") return { items: [] };
  return undefined;
};
// ── ?idg=<live|detail|minutes|packet|schedule|actions>: M14 IDG screens (&cf=N, &noquorum=1, &status=packets_building) ──
const idgQ = new URLSearchParams(location.search);
const idgScreen = idgQ.get("idg") ?? "";
const isIdg = ["live", "detail", "minutes", "packet", "schedule", "actions"].includes(idgScreen);
const idgUuid = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;
const IDG_ORG = idgUuid(9000);
const IDG_LOC = idgUuid(9100);
const IDG_MEET = "mt1";
const idgPatients = [
  "Henry Nakamura",
  "Barbara Park",
  "Thomas Kim",
  "Robert Chen",
  "Aiko Nakamura",
  "James Wilson",
  "Maria Lopez",
  "Elizabeth Garcia",
];
const idgPid = (i: number) => idgUuid(100 + i);
const idgMembers: [string, string, string][] = [
  ["m1", "Dr. Elena Ruiz", "hospice_physician"],
  ["m2", "Sarah Bennett, RN", "rn_case_manager"],
  ["m3", "Marcus Odum, MSW", "msw"],
  ["m4", "David Kim", "chaplain"],
  ["m5", "Linda Torres, LVN", "aide"],
];
// &adjourned=1 = shorthand for &status=adjourned (late-addendum variant); &addwindow=closed puts adjournment 20 days back.
const idgStatus =
  idgQ.get("status") ??
  (idgQ.has("adjourned") ? "adjourned" : idgScreen === "detail" ? "packets_ready" : "live");
const idgAddWindowClosed = idgQ.get("addwindow") === "closed";
const idgAdjournedHoursAgo = idgAddWindowClosed ? 20 * 24 : 24.6;
const idgCf = Math.max(0, Number(idgQ.get("cf") ?? 2) || 0);
// &superseded=1 = a newer IDG adjourned for the selected patient (Henry N.): addendum composer disabled there.
const idgSuperseded = idgQ.has("superseded");
const idgNoQuorum = idgQ.has("noquorum");
const idgMeeting = {
  id: IDG_MEET,
  organizationId: IDG_ORG,
  locationId: IDG_LOC,
  status: idgStatus,
  scheduledStart: hoursFromNow(idgStatus === "live" ? -0.75 : idgStatus === "adjourned" ? -26 : 20),
  scheduledEnd: hoursFromNow(
    idgStatus === "live" ? 0.75 : idgStatus === "adjourned" ? -24.5 : 21.5,
  ),
  adjournedAt: idgStatus === "adjourned" ? hoursFromNow(-idgAdjournedHoursAgo) : null,
};
const idgPackets =
  idgStatus === "scheduled"
    ? []
    : idgPatients.slice(0, 6).map((_, i) => ({
        packetId: idgUuid(200 + i),
        meetingId: IDG_MEET,
        patientId: idgPid(i),
        frozenAt: idgStatus === "packets_building" ? null : hoursFromNow(-6 - i),
      }));
const idgAgenda = [
  ...idgPatients.slice(0, 6).map((_, i) => ({
    id: idgUuid(300 + i),
    meetingId: IDG_MEET,
    kind: "patient_review",
    patientId: idgPid(i),
  })),
  ...Array.from({ length: idgCf }, (_, i) => ({
    id: idgUuid(320 + i),
    meetingId: IDG_MEET,
    kind: "carry_forward",
    patientId: idgPid(6 + (i % 2)),
  })),
  { id: idgUuid(340), meetingId: IDG_MEET, kind: "administrative_note", patientId: null },
];
const idgAttendance = idgMembers.slice(0, 4).map(([mid, , disc], i) => ({
  id: idgUuid(400 + i),
  meetingId: IDG_MEET,
  membershipId: mid,
  discipline: disc,
  status: idgNoQuorum && disc === "chaplain" ? "absent" : i === 2 ? "tardy" : "present",
  checkedInAt: hoursFromNow(-0.8 + i * 0.05),
}));
const idgDecisions = [
  {
    id: idgUuid(500),
    meetingId: IDG_MEET,
    patientId: idgPid(0),
    agendaItemId: idgUuid(300),
    decisionKind: "care_plan_update",
    status: "emitted",
    wasQuorate: true,
    recordedByMembershipId: "m2",
    recordedAt: hoursFromNow(-0.6),
    supersededByDecisionId: null,
  },
  {
    id: idgUuid(501),
    meetingId: IDG_MEET,
    patientId: idgPid(1),
    agendaItemId: idgUuid(301),
    decisionKind: "medication_recommendation",
    status: "emitted",
    wasQuorate: true,
    recordedByMembershipId: "m1",
    recordedAt: hoursFromNow(-0.5),
    supersededByDecisionId: null,
  },
  {
    id: idgUuid(502),
    meetingId: IDG_MEET,
    patientId: idgPid(2),
    agendaItemId: idgUuid(302),
    decisionKind: "family_meeting_needed",
    status: "open",
    wasQuorate: false,
    recordedByMembershipId: "m3",
    recordedAt: hoursFromNow(-0.4),
    supersededByDecisionId: null,
  },
  {
    id: idgUuid(503),
    meetingId: IDG_MEET,
    patientId: idgPid(3),
    agendaItemId: idgUuid(303),
    decisionKind: "level_of_care_consideration",
    status: "emitted",
    wasQuorate: true,
    recordedByMembershipId: "m1",
    recordedAt: hoursFromNow(-0.3),
    supersededByDecisionId: null,
  },
];
const dayStr = (n: number) => new Date(now + n * 864e5).toISOString().slice(0, 10);
const idgActions = [
  ["open", 5, 0, "m2"],
  ["in_progress", -3, 1, "m1"],
  ["open", -1, 2, "m3"],
  ["open", -6, 3, "m4"],
  ["completed", -2, 0, "m5"],
  ["in_progress", 2, 4, "m2"],
  ["cancelled", -4, 5, "m3"],
  ["open", 0, 1, "m1"],
].map(([st, due, pi, mem], i) => ({
  id: idgUuid(600 + i),
  meetingId: i < 6 ? IDG_MEET : idgUuid(9200),
  decisionId: i < 4 ? idgUuid(500 + i) : null,
  patientId: idgPid(pi as number),
  assignedToMembershipId: mem as string,
  status: st,
  dueDate: dayStr(due as number),
  linkedArtifactKind: i === 1 ? "order" : i === 3 ? "care_plan_version" : null,
  linkedArtifactId: null,
}));
const idgSchedule = [
  [-26, "adjourned"],
  [-0.75, "live"],
  [20, "packets_ready"],
  [7 * 24 + 3, "scheduled"],
  [14 * 24 + 3, "scheduled"],
  [21 * 24 + 3, "scheduled"],
  [-7 * 24, "adjourned"],
  [-14 * 24, "adjourned"],
].map(([h, st], i) => ({
  id: i === 1 ? IDG_MEET : idgUuid(700 + i),
  locationId: IDG_LOC,
  status: st,
  scheduledStart: hoursFromNow(h as number),
  scheduledEnd: hoursFromNow((h as number) + 1.5),
}));
// M14 schedule/detail name enrichment (coordinator id; patient displayName + mrnSuffix) — mock only.
const idgPatientRef = (pid: string | null) => {
  const i = idgPatients.findIndex((_, k) => idgPid(k) === pid);
  return i < 0
    ? null
    : {
        displayName: `${idgPatients[i]!.split(" ")[0]} ${idgPatients[i]!.split(" ")[1]![0]}.`,
        mrnSuffix: String(4100 + i),
      };
};
for (const r of idgPackets as { patientId: string; patient?: unknown }[])
  r.patient = idgPatientRef(r.patientId);
for (const r of idgAgenda as { patientId: string | null; patient?: unknown }[])
  r.patient = idgPatientRef(r.patientId);
for (const r of idgSchedule as { coordinatorMembershipId?: string }[])
  r.coordinatorMembershipId = "m2";
(idgMeeting as { coordinatorMembershipId?: string }).coordinatorMembershipId = "m2";
// IDG: patient display refs ("First L." + MRN suffix) the reads now carry; index 7 is left null to exercise the id fallback.
const idgRef = (id: string | null | undefined) => {
  const i = idgPatients.findIndex((_, k) => idgPid(k) === id);
  if (i < 0 || i === 7) return null;
  const [f, l] = idgPatients[i]!.split(" ");
  return { displayName: `${f} ${l![0]}.`, mrnSuffix: i === 5 ? null : `${4410 + i}A7` };
};
const idgWithPt = <T extends { patientId?: string | null }>(rows: T[]) =>
  rows.map((r) => ({ ...r, patient: idgRef(r.patientId) }));
// Recert/F2F windows, one variant per agenda patient (?f2f=none|error simulates a missing / failing route).
const idgRecert = () => ({
  meetingId: IDG_MEET,
  generatedAt: hoursFromNow(0),
  items: [
    ["window_open", "window_open", 12, true, -20, 12],
    ["missed", "overdue", -2, true, -35, -2],
    ["attested", null, 31, true, -60, -25],
    ["unknown", null, null, null, null, null],
    ["not_yet_open", "not_due", 74, true, 14, 44],
    ["not_required", null, 88, false, null, null],
  ].map(([st, ws, days, req, fs, fe], i) => ({
    patientId: idgPid(i),
    patient: idgRef(idgPid(i)),
    admissionId: idgUuid(700 + i),
    currentPeriodSequence: 3,
    benefitPeriodStart: dayStr(-60),
    benefitPeriodEnd: days === null ? null : dayStr(days as number),
    nextRecertDueDate: days === null ? null : dayStr(days as number),
    nextPeriodSequence: 4,
    daysUntilNextRecert: days,
    f2fRequired: req,
    f2fWindowStart: fs === null ? null : dayStr(fs as number),
    f2fWindowEnd: fe === null ? null : dayStr(fe as number),
    f2fStatus: st,
    f2fWindowState: ws,
    f2fScheduledDate: null,
  })),
});
// Packet read body (?idg=packet|live): rich snapshot for patient 0, sparse "real dev data" (empty lists, HOPE not
// captured) for the others; &sud=1 → Part 2 redacted variant; &nocontent=1 → content null (snapshot missing).
const idgPacketBody = (pid: string) => {
  const sud = idgQ.has("sud");
  const notice =
    "Some information in this packet is restricted under 42 CFR Part 2 and is not shown.";
  if (idgQ.has("nocontent"))
    return { content: null, appliedSudRedaction: sud, redactionNotice: sud ? notice : null };
  const rich = pid === idgPid(0) || sud;
  const iso = (h: number) => hoursFromNow(h);
  const item = (
    kind: string,
    n: number,
    label: string,
    summary: string,
    severity: string | null,
  ) => ({
    sourceKind: kind,
    sourceId: idgUuid(1000 + n),
    label,
    summary,
    severity,
  });
  const discs = ["rn", "msw", "chaplain", "aide", "md_np", "medical_director", "volunteer"];
  const disciplines = discs.map((discipline, i) => ({
    discipline,
    oneLineSummary: rich
      ? ({
          rn: "Pain controlled on scheduled morphine; two PRN doses in the last 72 hours.",
          msw: "Daughter is caregiver-strained; respite options discussed.",
          chaplain: "Requests weekly visit; spiritual distress eased after last visit.",
          aide: "Bathing 3x/week tolerated; skin intact, sacrum monitored.",
          md_np: "Dyspnea increasing; consider level-of-care review.",
          medical_director: "Prognosis unchanged; recertification supported.",
          volunteer: "Companion visits Tuesdays; enjoys music.",
        }[discipline] ?? "")
      : "No new activity since the last IDG review.",
    items:
      rich && i < 4
        ? [
            item(
              "encounter",
              10 + i,
              "RN visit",
              "Symptom review, edema 1+ bilateral",
              i === 0 ? "attention" : "info",
            ),
            item(
              "assessment",
              20 + i,
              "PPS 40%",
              "Down from 50% at last IDG",
              i === 0 ? "urgent" : null,
            ),
          ]
        : [],
    openQuestions: rich && i < 2 ? ["Is the family ready for a level-of-care change?"] : [],
  }));
  const content = rich
    ? {
        schemaVersion: "2026-01-v1",
        cover: {
          summary:
            "82-year-old on routine home care, day 47 of service. Primary diagnosis: heart failure. Care plan review is overdue; recert due in 12 days with the F2F window open.",
          builtAt: iso(-7),
          sinceCursorAt: iso(-24 * 14),
          sinceContext: "prior_idg",
          nameAtBuild: "Henry N.",
          age: 82,
          primaryDiagnosisIcd10: "I50.9",
          primaryDiagnosisLabel: "Heart failure, unspecified",
          levelOfCare: "routine",
          daysOnService: 47,
          hasActiveDpoa: true,
          activeSudFlag: false,
          recert: { nextRecertDueAt: dayStr(12), f2fWindowState: "window_open" },
          carePlan: {
            activeProblemCount: 4,
            activeGoalCount: 3,
            activeInterventionCount: 9,
            lastSignedAt: iso(-24 * 30),
            nextReviewDueAt: iso(-24 * 2),
            isReviewOverdue: true,
          },
          discussionFlags: [
            { kind: "care_plan_overdue", detail: "Review was due 2 days ago" },
            { kind: "caregiver_strain", detail: "Daughter reports exhaustion" },
          ],
          counts: {
            signedEncounters: 3,
            assessmentChanges: 2,
            hopeTriggers: 1,
            orderChanges: 2,
            medicationChanges: 2,
            flaggedEvents: 2,
            carryForwardActionItems: 2,
          },
        },
        disciplines,
        signedEncounters: [
          {
            encounterId: idgUuid(1100),
            encounterType: "routine_visit",
            discipline: "rn",
            signedAt: iso(-30),
          },
          {
            encounterId: idgUuid(1101),
            encounterType: "psychosocial_visit",
            discipline: "msw",
            signedAt: iso(-52),
          },
          {
            encounterId: idgUuid(1102),
            encounterType: "spiritual_visit",
            discipline: "chaplain",
            signedAt: iso(-70),
          },
        ],
        assessmentChanges: [
          {
            assessmentId: idgUuid(1110),
            scaleKind: "pps",
            changeKind: "declined",
            occurredAt: iso(-30),
          },
          {
            assessmentId: idgUuid(1111),
            scaleKind: "esas",
            changeKind: "new",
            occurredAt: iso(-55),
          },
        ],
        hopeTimepoints: {
          captured: true,
          upcoming: [{ timepoint: "hope_update_visit_1", dueAt: iso(24 * 9) }],
          openSfvCount: 1,
          symptomImpactTriggers: [
            { hopeAssessmentId: idgUuid(1120), triggerKind: "pain_severe", firedAt: iso(-40) },
          ],
        },
        // Preview fixture only — a real pull is ingested by M12's MedHx worker (F-230).
        externalMedicationHistory: {
          captured: true,
          state: "available",
          recordCount: sud ? null : 4,
          lastPulledAt: iso(-26),
          message: null,
        },
        orderChanges: [
          {
            orderId: idgUuid(1130),
            orderKind: "medication",
            changeKind: "created",
            changedAt: iso(-33),
          },
          {
            orderId: idgUuid(1131),
            orderKind: "dme",
            changeKind: "discontinued",
            changedAt: iso(-60),
          },
        ],
        medicationChanges: [
          {
            medicationOrderId: idgUuid(1140),
            drugLabel: "Morphine sulfate 5 mg/0.25 mL",
            changeKind: "dose_increased",
            changedAt: iso(-33),
          },
          {
            medicationOrderId: idgUuid(1141),
            drugLabel: "Lorazepam 0.5 mg",
            changeKind: "started",
            changedAt: iso(-80),
          },
        ],
        flaggedEvents: [
          { kind: "fall", sourceId: idgUuid(1150), occurredAt: iso(-45), severity: "urgent" },
          {
            kind: "missed_visit",
            sourceId: idgUuid(1151),
            occurredAt: iso(-90),
            severity: "attention",
          },
        ],
        carryForwardActionItems: [
          {
            actionItemId: idgUuid(1160),
            assignedToMembershipId: "m2",
            dueDate: iso(-24 * 3),
            carryForwardCount: 2,
          },
          {
            actionItemId: idgUuid(1161),
            assignedToMembershipId: "m3",
            dueDate: iso(24 * 4),
            carryForwardCount: 1,
          },
        ],
      }
    : {
        schemaVersion: "2026-01-v1",
        cover: {
          summary:
            "76-year-old on routine home care, day 12 of service. Primary diagnosis: lung cancer.",
          builtAt: iso(-7),
          sinceCursorAt: iso(-24 * 12),
          sinceContext: "first_idg",
          nameAtBuild: "Barbara P.",
          age: 76,
          primaryDiagnosisIcd10: "C34.90",
          primaryDiagnosisLabel: "Malignant neoplasm of lung",
          levelOfCare: "routine",
          daysOnService: 12,
          hasActiveDpoa: false,
          activeSudFlag: false,
          recert: { nextRecertDueAt: dayStr(78), f2fWindowState: "not_due" },
          carePlan: {
            activeProblemCount: 2,
            activeGoalCount: 2,
            activeInterventionCount: 4,
            lastSignedAt: iso(-24 * 10),
            nextReviewDueAt: iso(24 * 20),
            isReviewOverdue: false,
          },
          discussionFlags: [],
          counts: {
            signedEncounters: 0,
            assessmentChanges: 0,
            hopeTriggers: 0,
            orderChanges: 0,
            medicationChanges: 0,
            flaggedEvents: 0,
            carryForwardActionItems: 0,
          },
        },
        disciplines,
        signedEncounters: [],
        assessmentChanges: [],
        hopeTimepoints: {
          captured: false,
          upcoming: [],
          openSfvCount: null,
          symptomImpactTriggers: [],
        },
        externalMedicationHistory: {
          captured: false,
          state: null,
          recordCount: null,
          lastPulledAt: null,
          message: null,
        },
        orderChanges: [],
        medicationChanges: [],
        flaggedEvents: [],
        carryForwardActionItems: [],
      };
  return { content, appliedSudRedaction: sud, redactionNotice: sud ? notice : null };
};
// Discipline notes (?idg=live): default = a few notes across disciplines/patients; &notes=0 = none;
// ADJOURNED (late addenda): &adjourned=1 (or &status=adjourned) = frozen originals + 2 addenda, composer becomes
// "Add late addendum"; add &addwindow=closed for the closed window; &superseded=1 = Henry N. superseded by a newer IDG (composer disabled on his tab, meeting-level still open); add &notes=sud for a withheld Part 2 note+addendum.
// &notes=sud = one Part 2 withheld note (text hidden) on Barbara P.; &note412=1 makes every edit return 412.
// POST/PATCH mutate this in-memory list so the composer / edit flows can be exercised without a backend.
const idgNoteRow = (
  n: number,
  pi: number | null,
  discipline: string,
  membershipId: string,
  authorName: string,
  bodyText: string | null,
  ago: number,
  version = 1,
  withheld = false,
  addendumReason: string | null = null,
  liveReason: string | null = null,
) => ({
  id: idgUuid(1300 + n),
  meetingId: IDG_MEET,
  patientId: pi === null ? null : idgPid(pi),
  discipline,
  bodyText,
  bodyWithheld: withheld,
  isAddendum: addendumReason !== null,
  addendumRecordedAt: addendumReason !== null ? hoursFromNow(-ago) : null,
  reason: withheld ? null : (addendumReason ?? liveReason),
  authorMembershipId: membershipId,
  authorName,
  version,
  createdAt: hoursFromNow(-ago),
  updatedAt: hoursFromNow(-ago + (version > 1 ? 0.1 : 0)),
  patient: pi === null ? null : idgRef(idgPid(pi)),
});
const idgNotesMode = idgQ.get("notes") ?? "";
const idgNotes: ReturnType<typeof idgNoteRow>[] =
  idgNotesMode === "0"
    ? []
    : [
        idgNoteRow(
          1,
          0,
          "rn_case_manager",
          "m2",
          "Sarah Bennett, RN",
          "Pain controlled on scheduled morphine; two PRN doses in 72h. Skin intact. Daughter present at last visit and engaged in care.",
          0.6,
          1,
          false,
          null,
          "Follow-up to Tuesday's symptom review.",
        ),
        idgNoteRow(
          2,
          0,
          "msw",
          "m3",
          "Marcus Odum, MSW",
          "Daughter reports caregiver strain. Respite options reviewed; referral to volunteer program agreed.",
          0.5,
          2,
        ),
        idgNoteRow(
          3,
          0,
          "hospice_physician",
          "m1",
          "Dr. Elena Ruiz",
          "Increasing dyspnea. Consider level-of-care review at next visit.",
          0.4,
        ),
        idgNoteRow(
          4,
          1,
          "rn_case_manager",
          "m2",
          "Sarah Bennett, RN",
          "New wound on left heel, stage 2. Offloading in place.",
          0.3,
          1,
          false,
          null,
          "Wound found at this morning's visit.",
        ),
        idgNoteRow(
          5,
          null,
          "chaplain",
          "m4",
          "David Kim",
          "Bereavement follow-up list reviewed for the month.",
          0.2,
        ),
        ...(idgNotesMode === "sud"
          ? [idgNoteRow(6, 1, "msw", "m3", "Marcus Odum, MSW", null, 0.1, 1, true)]
          : []),
        // Late addenda (adjourned variants): two on Henry N. (RN + MSW); with &notes=sud the Part 2 patient's
        // addendum is withheld too (text AND reason).
        ...(idgStatus === "adjourned"
          ? [
              idgNoteRow(
                7,
                0,
                "rn_case_manager",
                "m2",
                "Sarah Bennett, RN",
                "Lab result returned after the meeting: potassium 3.1. Physician notified; order for supplement received.",
                5,
                1,
                false,
                "Result arrived after adjournment and changes the plan discussed.",
              ),
              idgNoteRow(
                8,
                0,
                "msw",
                "m3",
                "Marcus Odum, MSW",
                "Daughter called to confirm respite start date, Monday.",
                2,
                1,
                false,
                "Family follow-up call the next morning.",
              ),
              ...(idgNotesMode === "sud"
                ? [idgNoteRow(9, 1, "msw", "m3", "Marcus Odum, MSW", null, 1, 1, true, "withheld")]
                : []),
            ]
          : []),
      ];
const idgNoteWrite = (
  method: "POST" | "PATCH",
  p: string,
  o?: {
    params?: { path?: { id?: string } };
    body?: {
      patientId?: string | null;
      discipline?: string;
      bodyText?: string;
      reason?: string | null;
    };
  },
) => {
  if (p === "/api/v1/idg/meetings/{id}/discipline-notes" && method === "POST") {
    const b = o?.body ?? {};
    const isAdd = idgStatus === "adjourned";
    const row = idgNoteRow(
      50 + idgNotes.length,
      b.patientId ? idgPatients.findIndex((_, k) => idgPid(k) === b.patientId) : null,
      b.discipline ?? "rn",
      "mada",
      "Ada Administrator",
      b.bodyText ?? "",
      0,
      1,
      false,
      isAdd ? (b.reason ?? "") : null,
      !isAdd && b.reason ? b.reason : null,
    );
    idgNotes.push(row);
    return Promise.resolve({
      data: row,
      error: undefined,
      response: new Response(null, { status: 201 }),
    });
  }
  if (p === "/api/v1/idg/discipline-notes/{id}" && method === "PATCH") {
    if (idgQ.has("note412"))
      return Promise.resolve({
        data: undefined,
        error: { error: { code: "STALE_VERSION", message: "stale write" } },
        response: new Response(null, { status: 412 }),
      });
    const row = idgNotes.find((n) => n.id === o?.params?.path?.id);
    if (row) {
      row.bodyText = o?.body?.bodyText ?? row.bodyText;
      if (o?.body && "reason" in o.body) row.reason = o.body.reason ?? null;
      row.version += 1;
      row.updatedAt = hoursFromNow(0);
    }
    return Promise.resolve({ data: row, error: undefined, response: new Response() });
  }
  return res({});
};
const idgGet = (p: string, o?: { params?: { path?: Record<string, string> } }): unknown => {
  switch (p) {
    case "/api/v1/idg/meetings/{id}":
      return { ...idgMeeting, coordinatorMembershipId: "m2" };
    case "/api/v1/idg/meetings/{id}/packets":
      return idgWithPt(idgPackets);
    case "/api/v1/idg/meetings/{id}/recert-windows":
      return idgQ.get("f2f") === "error" ? undefined : idgRecert();
    case "/api/v1/idg/meetings/{meetingId}/packets/{patientId}": {
      const pid = o?.params?.path?.patientId ?? idgPid(0);
      const base = idgPackets.find((k) => k.patientId === pid) ?? {
        packetId: idgUuid(299),
        meetingId: IDG_MEET,
        patientId: pid,
        frozenAt: hoursFromNow(-6),
      };
      return { ...base, patient: idgRef(pid), ...idgPacketBody(pid) };
    }
    case "/api/v1/idg/meetings/{id}/agenda":
      return idgWithPt(idgAgenda);
    case "/api/v1/idg/meetings/{id}/attendance":
      return idgAttendance;
    case "/api/v1/idg/meetings/{id}/decisions":
      return idgWithPt(idgDecisions);
    case "/api/v1/idg/action-items":
      return idgWithPt(idgActions);
    case "/api/v1/idg/meetings/{id}/discipline-notes":
      return idgNotes.map((n) => ({ ...n }));
    case "/api/v1/idg/meetings/{id}/minutes":
      return {
        id: idgUuid(800),
        meetingId: IDG_MEET,
        status: idgStatus === "adjourned" ? "final" : "in_progress",
        finalizedAt: idgStatus === "adjourned" ? hoursFromNow(-24.6) : null,
        finalizedByMembershipId: idgStatus === "adjourned" ? "m2" : null,
        minutesDocumentId: idgStatus === "adjourned" ? idgUuid(801) : null,
        attendanceCount: idgAttendance.length,
        decisionCount: idgDecisions.length,
        actionItemCount: idgActions.filter((a) => a.meetingId === IDG_MEET).length,
        disciplineNoteCount:
          idgStatus === "adjourned" ? idgNotes.filter((n) => !n.isAddendum).length : null,
        disciplineAddendumCount: idgNotes.filter((n) => n.isAddendum).length,
        addendumState:
          idgStatus === "adjourned"
            ? {
                open: !idgAddWindowClosed,
                closesAt: hoursFromNow(-idgAdjournedHoursAgo + 14 * 24),
                closedReason: idgAddWindowClosed ? ("window_elapsed" as const) : null,
                supersededPatientIds: idgSuperseded && !idgAddWindowClosed ? [idgPid(0)] : [],
              }
            : { open: false, closesAt: null, closedReason: null, supersededPatientIds: [] },
      };
    case "/api/v1/idg/schedule":
      return idgSchedule;
    case "/api/v1/locations":
      return {
        items: [
          { id: IDG_LOC, name: "Pendleton Office", status: "active" },
          { id: idgUuid(9101), name: "Hermiston Satellite", status: "active" },
        ],
      };
    case "/api/v1/orgs/{id}/members":
      return {
        members: idgMembers.map(([membershipId, displayName]) => ({
          membershipId,
          userId: `u-${membershipId}`,
          displayName,
          email: `${membershipId}@example.org`,
        })),
      };
    case "/api/v1/patients/{id}": {
      const i = Math.max(
        0,
        [0, 1, 2, 3, 4, 5, 6, 7].find((k) => idgPid(k) === o?.params?.path?.id) ?? 0,
      );
      const [f, l] = idgPatients[i]!.split(" ");
      return {
        id: idgPid(i),
        organizationId: IDG_ORG,
        mrn: `MRN-4410${i}A7AC`,
        firstName: f,
        lastName: l,
        dob: `19${36 + i}-01-18`,
        status: "active",
      };
    }
    case "/api/v1/patients/{id}/demographics":
      return { sexAssignedAtBirth: "F" };
    case "/api/v1/patients/{id}/identifiers":
      return { identifiers: [{ kind: "mbi", value: null, last4: "5234", effectiveTo: null }] };
    default:
      return undefined;
  }
};
const idgPerms = [
  "idg.read",
  "idg.schedule",
  "idg.coordinate",
  "idg.attend",
  "idg.decide",
  "idg.act",
  "idg.amend_minutes",
  "idg.override_review_floor",
  "patient.read",
];
const idgRoutes =
  "/idg/meetings/:id/live,/idg/meetings/:id,/idg/meetings/:id/minutes,/idg/meetings/:meetingId/packets/:patientId,/idg/schedule,/idg/action-items".split(
    ",",
  );
const idgEntry: Record<string, string> = {
  live: `/idg/meetings/${IDG_MEET}/live`,
  detail: `/idg/meetings/${IDG_MEET}`,
  minutes: `/idg/meetings/${IDG_MEET}/minutes`,
  packet: `/idg/meetings/${IDG_MEET}/packets/${idgPid(0)}`,
  schedule: `/idg/schedule?location=${IDG_LOC}`,
  actions: "/idg/action-items",
};
const idgEls = [
  <LiveMeeting key="LiveMeeting" />,
  <MeetingDetail key="MeetingDetail" />,
  <Minutes key="Minutes" />,
  <PatientPacket key="PatientPacket" />,
  <IdgSchedule key="IdgSchedule" />,
  <MyActionItems key="MyActionItems" />,
];
const isHome = new URLSearchParams(location.search).has("home");
const res = (data: unknown) =>
  Promise.resolve({ data, error: undefined, response: new Response() });
const client = {
  GET: (p: string, o?: { params?: { path?: { encounterId?: string; id?: string } } }) =>
    res(
      isIdg && p.startsWith("/api/v1/")
        ? idgGet(p, o as never)
        : isPClaims && p.match(/claims|noe|notr/)
          ? pclaimsGet(p)
          : isXfer
            ? xferGet(p)
            : isExplorer
              ? explorerGet(p, o as never)
              : isBilling
                ? billingGet(p, o as never)
                : isSched
                  ? schedGet(p, o as never)
                  : p === "/api/v1/encounters/{encounterId}"
                    ? details[o?.params?.path?.encounterId ?? ""]
                    : p === "/api/v1/orders/{id}"
                      ? { data: orders.find((x) => x.id === o?.params?.path?.id)?.__data }
                      : p === "/api/v1/idg/meetings/{id}"
                        ? {
                            id: "mt0",
                            locationId: "loc1",
                            status: "packets_ready",
                            scheduledStart: d(-3),
                            scheduledEnd: new Date(now + 3 * 864e5 + 36e5).toISOString(),
                          }
                        : p === "/api/v1/mdm/{kind}/{id}"
                          ? { canonical: { displayName: mdm[o?.params?.path?.id ?? ""] } }
                          : isHome && p in homeRoutes
                            ? homeRoutes[p]
                            : routes[p],
    ),
  PATCH: (p: string, o?: never) => (isIdg ? idgNoteWrite("PATCH", p, o) : res({})),
  POST: (p: string, o?: never) => (isIdg ? idgNoteWrite("POST", p, o) : res({})),
} as unknown as ApiClient;
const homePerms = [
  "patient.read",
  "referral.read",
  "admission.read",
  "hope.timepoint.read",
  "idg.read",
  "orders.read",
  "encounter.read",
  "visit.read_team",
  "safety.dashboard.read",
  "incident.read",
  "billing.claim.read_ar_dashboard",
  "admission.create",
];
const homeScreens = [
  ["admission.create", "/admissions/new", "New Admission"],
  ["hope.dashboard", "/hope", "Start HOPE Assessment"],
  ["orders.sign-inbox", "/orders", "Create Order"],
  ["idg.schedule", "/idg/schedule", "IDG Meeting"],
  ["documents.explorer", "/documents", "Upload Document"],
  ["reporting.catalog", "/reports", "Run Reports"],
].map(([id, path, title]) => ({ id, path, title, screen: () => null }));
// One stand-in screen per curated nav entry, so the preview sidebar lists exactly what the app's does.
const previewNavScreens = PRIMARY_NAV.flatMap((section) =>
  section.entries
    .filter((entry) => entry.key !== "home")
    .map((entry) => ({
      id: `nav.${entry.key}`,
      path: entry.to,
      title: entry.label,
      screen: () => null,
    })),
);
if (isIdg) {
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "ada",
          organizationId: IDG_ORG,
          displayName: "Ada Administrator",
          permissions: idgPerms,
          membershipId: "mada",
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter initialEntries={[idgEntry[idgScreen]!]}>
        <ApiClientProvider client={client}>
          <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
            {/* The real app frame (sidebar + top bar + the `.wx-main` scroll container), so the packet
                reads — and its right rail sticks — exactly as it does in the app. */}
            <Routes>
              <Route
                element={
                  <FeatureFlagProvider flags={{}}>
                    <SystemStatusProvider components={[]}>
                      <ToastProvider>
                        <AppLayout screens={previewNavScreens as never} />
                      </ToastProvider>
                    </SystemStatusProvider>
                  </FeatureFlagProvider>
                }
              >
                {idgRoutes.map((path, i) => (
                  <Route key={path} path={path} element={idgEls[i]} />
                ))}
              </Route>
            </Routes>
          </div>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
} else if (isExplorer) {
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
          <DocumentExplorer />
        </div>
      </ApiClientProvider>
    </MemoryRouter>,
  );
} else if (isXfer) {
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "ada",
          organizationId: "o",
          displayName: "Ada Administrator",
          permissions: ["billing.noe.read", "billing.noe.submit"],
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter initialEntries={["/billing/transfer-notices?notice=tn0"]}>
        <ApiClientProvider client={client}>
          <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
            <Routes>
              <Route path="/billing/transfer-notices" element={<TransferNotices />} />
            </Routes>
          </div>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
} else if (isBilling) {
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "ada",
          organizationId: "o",
          displayName: "Ada Administrator",
          permissions: ["billing.claim.assemble"],
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
            <ArDashboard />
          </div>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
} else if (isSched) {
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "ada",
          organizationId: "o",
          displayName: "Ada Administrator",
          permissions: schedPerms,
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
            <CalendarPage />
          </div>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
} else if (isHome) {
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "ada",
          organizationId: "o",
          displayName: "Ada Administrator",
          permissions: homePerms,
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
            <RoleHome screens={homeScreens as never} />
          </div>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
} else
  createRoot(document.getElementById("root")!).render(
    <div style={{ height: "100vh", display: "flex" }}>
      <SessionProvider
        session={
          { permissions: ["care_plan.author", "care_plan.finalize", "care_plan.sign"] } as never
        }
      >
        <MemoryRouter
          initialEntries={[
            new URLSearchParams(location.search).has("meds")
              ? "/patients/p1/medications"
              : new URLSearchParams(location.search).has("cp")
                ? "/patients/p1/care-plan"
                : new URLSearchParams(location.search).has("orders")
                  ? "/patients/p1/orders"
                  : new URLSearchParams(location.search).has("idg")
                    ? "/patients/p1/idg-history"
                    : new URLSearchParams(location.search).has("docs")
                      ? "/patients/p1/documents"
                      : isPClaims
                        ? "/patients/p1/claims"
                        : "/patients/p1?view=clinical",
          ]}
        >
          <ApiClientProvider client={client}>
            <Routes>
              <Route path="/patients/:id" element={<PatientChart />} />
              <Route path="/patients/:patientId/medications" element={<PatientMedications />} />
              <Route path="/patients/:patientId/care-plan" element={<CarePlanView />} />
              <Route path="/patients/:patientId/orders" element={<PatientOrders />} />
              <Route path="/patients/:patientId/idg-history" element={<PatientIdgHistory />} />
              <Route path="/patients/:patientId/documents" element={<PatientDocuments />} />
              <Route path="/patients/:patientId/claims" element={<PatientClaims />} />
            </Routes>
          </ApiClientProvider>
        </MemoryRouter>
      </SessionProvider>
    </div>,
  );
