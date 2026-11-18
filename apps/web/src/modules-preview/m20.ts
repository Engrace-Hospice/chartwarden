import type {
  CursorPage,
  SafetyCheckInView,
  SafetyHighRiskAreaView,
  SafetyIncidentView,
  SafetyMyDayView,
  SafetyPolicyView,
  SafetySubscriptionView,
} from "../modules/20-field-safety/safety-api";
// modules-preview fixtures for M20 Field Safety. Typed against the module's own wire shapes so a drifted field fails
// the typecheck instead of rendering blank. Every name and id is invented.
import { fieldSafetyScreens } from "../modules/20-field-safety/screens";
import type { Fixtures } from "./mock-client";
import type { ModulePreview } from "./types";

const NOW = Date.now();
const iso = (hours: number): string => new Date(NOW + hours * 36e5).toISOString();

const page = <T>(data: T[]): CursorPage<T> => ({ data, next_cursor: null, has_more: false });

const incident: SafetyIncidentView = {
  id: "inc-1",
  providerEntityId: "pe-1",
  affectedClinicianMembershipId: "m-lopez",
  reportedByMembershipId: "m-lopez",
  category: "dog_bite",
  severity: "moderate",
  visitId: "visit-1",
  patientId: null,
  occurredAt: iso(-30),
  reportedAt: iso(-28),
  locationDescription: "Front porch of the home",
  narrative:
    "The family's dog broke its tether and bit the nurse's forearm while she was at the door.",
  narrativeAvailable: true,
  witnesses: "The daughter was present and called the supervisor.",
  oshaReportable: false,
  oshaReportableSignedOffByMembershipId: null,
  oshaReportableSignedOffAt: null,
  workersCompClaimInitiated: false,
  workersCompClaimReference: null,
  linkedSosAlertId: null,
  lifecycleState: "submitted",
  submittedAt: iso(-27),
  reviewedByMembershipId: null,
  reviewedAt: null,
  actionPlan: null,
  actionPlanAvailable: false,
  closedAt: null,
  reopenReason: null,
  version: 2,
  stateHistory: [
    {
      fromState: null,
      toState: "draft",
      transitionedAt: iso(-28),
      transitionedByMembershipId: "m-lopez",
      reason: null,
    },
    {
      fromState: "draft",
      toState: "submitted",
      transitionedAt: iso(-27),
      transitionedByMembershipId: "m-lopez",
      reason: null,
    },
  ],
};

const areas: SafetyHighRiskAreaView[] = [
  [
    "a1",
    "documented_prior_incident",
    "Two assaults reported on this block in the last year.",
    "requires_buddy_visit",
  ],
  [
    "a2",
    "nighttime_only_advisory",
    "Poor lighting after dark; visit before 6pm where possible.",
    "advisory_only",
  ],
  [
    "a3",
    "community_self_reported_unsafe",
    "Loose dogs reported near the east entrance.",
    "requires_pre_visit_check_in",
  ],
].map(([id, category, message, policy]) => ({
  id: id as string,
  riskCategory: category as SafetyHighRiskAreaView["riskCategory"],
  advisoryMessage: message as string,
  polygon: [
    [
      [-122.68, 45.52],
      [-122.67, 45.52],
      [-122.67, 45.53],
      [-122.68, 45.53],
      [-122.68, 45.52],
    ],
  ],
  policyForVisitsToArea: policy as SafetyHighRiskAreaView["policyForVisitsToArea"],
  effectiveFrom: iso(-24 * 90),
  effectiveTo: null,
  createdByMembershipId: "m-supervisor",
}));

const subscriptions: SafetySubscriptionView[] = [
  {
    id: "s1",
    supervisorMembershipId: "m-supervisor",
    clinicianMembershipId: "m-lopez",
    locationId: null,
    providerEntityId: null,
    scopeKind: "explicit",
    alertKinds: ["sos", "overdue"],
    isVacationForwarding: false,
    vacationForwardToMembershipId: null,
    createdAt: iso(-24 * 40),
  },
  {
    id: "s2",
    supervisorMembershipId: "m-supervisor",
    clinicianMembershipId: null,
    locationId: null,
    providerEntityId: "pe-1",
    scopeKind: "provider_entity",
    alertKinds: ["sos", "incident", "high_risk_area"],
    isVacationForwarding: true,
    vacationForwardToMembershipId: "m-okafor",
    createdAt: iso(-24 * 12),
  },
];

const policy: SafetyPolicyView = {
  organizationId: "org-1",
  versionId: "pol-v3",
  effectiveFrom: iso(-24 * 60),
  effectiveTo: null,
  midVisitCadenceMinutes: 45,
  midVisitMinVisitDurationMinutes: 30,
  preVisitWindowMinutes: 15,
  postVisitWindowMinutes: 30,
  gentleReminderMinutes: 10,
  supervisorAlertMinutes: 20,
  escalationMinutes: 35,
  sosEquivalentMinutes: 60,
  sosCancelWindowSeconds: 5,
  sosCancelRequiresBiometric: false,
  sosContinuousLocationEnabled: true,
  sosContinuousLocationSampleSeconds: 30,
  sosContinuousLocationMaxDurationHours: 4,
  sosTier1SlaSeconds: 60,
  sosTier2SlaSeconds: 180,
  sosTier3SlaSeconds: 300,
  subscriptionModel: "explicit_only",
  afterHoursStartHour: 18,
  afterHoursEndHour: 7,
  oshaReportableAutoFlagCategories: ["physical_assault"],
};

const checkIn: SafetyCheckInView = {
  id: "ci-1",
  scheduleId: null,
  visitId: "visit-1",
  postedByMembershipId: "m-lopez",
  postedAt: iso(-0.05),
  kind: "mid_visit",
  status: "ok",
  concernNote: null,
  coordinatesCaptured: false,
  isPartOfSosBracket: false,
  correctsCheckInId: null,
  supersededAt: null,
  supersededByCheckInId: null,
  amendableUntil: null,
};

const myDay: SafetyMyDayView = {
  asOf: iso(0),
  obligations: [],
  recentCheckIns: [
    checkIn,
    {
      ...checkIn,
      id: "ci-0",
      postedAt: iso(-26),
      kind: "post_visit",
      status: "concerned_continue",
      concernNote: "Dog loose in the yard on arrival.",
    },
  ],
};

const fixtures: Fixtures = {
  "/api/v1/safety/incidents/{incidentId}": incident,
  "/api/v1/safety/high-risk-areas": page(areas),
  "/api/v1/safety/supervisor-subscriptions": page(subscriptions),
  "/api/v1/safety/policy": policy,
  "/api/v1/safety/check-ins/me/today": myDay,
  "/api/v1/safety/check-ins/{checkInId}": { ...checkIn, amendableUntil: iso(0.08) },
};

export const preview20: ModulePreview = {
  screens: fieldSafetyScreens,
  fixtures,
  start: "/safety/high-risk-areas",
  extraPermissions: [],
};
