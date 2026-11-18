// modules-preview fixtures for M16 Bereavement. Typed against the module's own wire shapes so a drifted field fails
// the typecheck instead of rendering blank. Every name and id is invented.
import type { PlanDetail, SupervisorDashboard } from "../modules/16-bereavement/bereavement-api";
import type { GroupListItem } from "../modules/16-bereavement/programs-api";
import { bereavementScreens } from "../modules/16-bereavement/screens";
import type { Fixtures } from "./mock-client";
import type { ModulePreview } from "./types";

const NOW = Date.now();
const iso = (days: number): string => new Date(NOW + days * 864e5).toISOString();
const day = (days: number): string => iso(days).slice(0, 10);

const contacts: PlanDetail["contacts"] = [
  ["c1", "Elena Rivera", "child", "active", "low"],
  ["c2", "Marco Rivera", "spouse", "active", "moderate"],
  ["c3", "Sofia Nunez", "friend", "proposed", null],
].map(([contactId, displayName, relationshipCode, status, tier]) => ({
  contactId: contactId as string,
  planId: "pl-1",
  status: status as PlanDetail["contacts"][number]["status"],
  displayName: displayName as string,
  relationshipCode: relationshipCode as PlanDetail["contacts"][number]["relationshipCode"],
  preferredLanguageIso639: "en",
  portalAccountId: null,
  consentRecordId: null,
  allowedOutreachKinds: ["phone_call", "sympathy_card", "email"],
  volunteerVisibleOnly: false,
  confirmedAt: status === "active" ? iso(-30) : null,
  optedOutAt: null,
  unreachableAt: null,
  unreachableProposed: false,
  unreachableProposedAt: null,
  deceasedAt: null,
  mayRescindOptOut: false,
  mailingsAllowed: true,
  currentRiskTier: tier as PlanDetail["contacts"][number]["currentRiskTier"],
  careGoals: [],
  version: 1,
}));

const plan: PlanDetail = {
  planId: "pl-1",
  patientId: "p-rivera",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  locationId: null,
  status: "active",
  deathDate: day(-45),
  deathTime: null,
  windowEndsAt: iso(320),
  openedAt: iso(-40),
  pausedAt: null,
  pauseKind: null,
  closedAt: null,
  assignedCounselorUserId: "u-counselor",
  assignedCounselorAssignedAt: iso(-40),
  assignedVolunteerUserId: null,
  assignedVolunteerAssignedAt: null,
  externalSource: null,
  firstContactAllowed: true,
  firstContactGateReason: null,
  contacts,
  stats: { completedCount: 6, missedCount: 1, contactsActiveCount: 2, contactsOptedOutCount: 0 },
  currentRiskTier: "moderate",
  currentRiskComputedAt: iso(-7),
  legalHoldId: null,
  earlyCloseRequest: null,
  version: 3,
  updatedAt: iso(-2),
  redactedCategories: [],
};

const groups: GroupListItem[] = [
  ["g1", "Evening grief circle", "recurring", "in_person", "open", 6, 12],
  ["g2", "Drop-in coffee hour", "drop_in", "in_person", "open", 9, null],
  ["g3", "Spring workshop for new widows", "recurring", "virtual", "draft", 0, 10],
].map(([groupId, name, format, modality, status, enrolledCount, capacity]) => ({
  groupId: groupId as string,
  name: name as string,
  description: null,
  format: format as GroupListItem["format"],
  modality: modality as GroupListItem["modality"],
  enrollmentRequired: format === "recurring",
  facilitatorKind: "staff",
  facilitatorUserId: "u-counselor",
  coFacilitatorUserId: null,
  capacity: capacity as number | null,
  status: status as GroupListItem["status"],
  recurrence:
    format === "recurring"
      ? { firstDate: day(7), startTime: "18:30", durationMinutes: 90, intervalWeeks: 1, count: 8 }
      : null,
  timezone: "America/New_York",
  venueText: modality === "in_person" ? "Chapel room, 2nd floor" : null,
  hasJoinUrl: modality === "virtual",
  enrolledCount: enrolledCount as number,
  nextSessionAt: status === "open" ? iso(5) : null,
  openedAt: status === "open" ? iso(-14) : null,
  closedAt: null,
  version: 1,
  createdAt: iso(-20),
}));

const supervisor: SupervisorDashboard = {
  planCountsByStatus: {
    eligible: 4,
    initiating: 2,
    active: 31,
    paused: 3,
    closed_completed: 58,
    closed_declined: 7,
    closed_early: 5,
    closed_legal_hold_extended: 1,
  },
  outreachCountsByStatus: {
    scheduled: 22,
    in_progress: 4,
    completed: 187,
    declined: 6,
    no_response: 14,
    missed: 9,
    cancelled: 3,
  },
  copCounts: { numerator: 54, denominator: 58 },
  tierDistribution: { low: 12, moderate: 14, high: 4, complicated: 1 },
  closureCountsByReason: {
    thirteen_month_completion: 58,
    all_contacts_declined: 4,
    patient_opt_out_pre_death: 1,
    patient_opt_out_post_creation: 0,
    tenant_offboarding: 0,
    all_bereaved_deceased: 0,
    geographic_relocation: 3,
    family_legal_action: 0,
    other_early: 1,
  },
  unassignedPlanCount: 2,
  externalSourceCosignPendingCount: 1,
};

const fixtures: Fixtures = {
  "/api/v1/bereavement/plans/{planId}": plan,
  "/api/v1/bereavement/groups": { data: groups, next_cursor: null, has_more: false },
  "/api/v1/bereavement/dashboard/supervisor": supervisor,
};

export const preview16: ModulePreview = {
  screens: bereavementScreens,
  fixtures,
  start: "/bereavement/supervisor",
  // Beyond each screen's read key: the write actions the screens gate their buttons on.
  extraPermissions: ["bereavement.group.manage"],
};
