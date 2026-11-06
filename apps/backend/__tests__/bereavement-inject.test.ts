// apps/backend/__tests__/bereavement-inject.test.ts — M16-T06 (§4.1) HTTP-layer route-inventory smoke
// (TASK-050A, TEST-001 closure for Module 16).
//
// Module 16 had ZERO Fastify `.inject()` coverage before this file: `bereavement-authz.test.ts` /
// `-lifecycle.test.ts` / `-risk.test.ts` / `-seams.test.ts` all exercise pure functions directly, so a
// mis-wired guard, a schema drift, or a route that never got mounted would be invisible to them — only a
// REAL `inject()` through the full M1 middleware chain (auth → RBAC → ABAC → TypeBox → handler) catches
// that class of bug. This file is the M11 `orders-routes.test.ts` pattern applied to M16: `buildServer()`
// mounts the host, `mountM16Routes()` mounts the §4.1 inventory over a small hand-rolled in-memory
// `M16ReadService`/`M16WriteService` (M16 does not export an in-memory backend the way M11/M40 do — the
// module ships only the Drizzle-backed builders — so this file owns its own fake, seeded through the SAME
// `BereavementAbacResolver` shape the real §4.8 predicates consume). A fresh predicate registry is built
// per server from `buildBereavementAbacPredicates` (the M11-T06 precedent — the shared registry would
// otherwise close over a PRIOR test's backend); the platform `step_up_recent` predicate (owned by M3, not
// M16) is stubbed to always-pass, since freshness policy itself is already covered by
// `step-up-policy.test.ts` / `consent-surface.test.ts` and is not this file's concern.
//
// This is a WIRING smoke test, not a re-test of the §2.2–§2.4 lifecycle machines (already covered, over the
// REAL pure functions, by `bereavement-lifecycle.test.ts`): the fake write service applies each route's
// implied mutation unconditionally rather than re-deriving the state machine, so every 2xx case exists to
// prove the route is MOUNTED, gated on the right §4.7 permission key + §4.8 ABAC predicate, and returns the
// documented status code — not to prove the transition is clinically valid.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { factorsToWire } from "@chartwarden/bereavement";
import { ForbiddenError, NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type BereavedContactAbacFacts,
  type BereavementAbacResolver,
  type BereavementPlanAbacFacts,
  M16_PERMISSION_KEY_LIST,
  type PreDeathAssessorProbe,
  buildBereavementAbacPredicates,
  mountM16Routes,
} from "../src/modules/16-bereavement/index";
import {
  BereavementStateError,
  checkVersion,
  decideLetterApproval,
  decideLetterDecline,
} from "../src/modules/16-bereavement/lifecycle/index";
import type {
  M16DraftService,
  PreDeathDraftView,
} from "../src/modules/16-bereavement/routes/draft-service";
import type {
  BereavedContactRowView,
  BereavementAssessmentTaskView,
  BereavementClosureView,
  BereavementContactLogView,
  BereavementOutreachRowView,
  BereavementPlanDetail,
  BereavementPlanListItem,
  BereavementRiskScoreView,
  M16ReadService,
  M16WriteService,
  PlanActivationView,
  ScheduleRegenerationView,
} from "../src/modules/16-bereavement/routes/index";
import type {
  M16LetterService,
  PhysicianLetterView,
} from "../src/modules/16-bereavement/routes/letter-service";
import type {
  M16MailingService,
  MailingRunView,
} from "../src/modules/16-bereavement/routes/mailing-service";
import type { RecomputeRiskInput } from "../src/modules/16-bereavement/routes/write-service";

// ── the M2 header-auth test shim (the M11/M40 `orders-routes.test.ts` / `mdm-routes.test.ts` precedent) ──
// Extended with `x-test-membership` / `x-test-session-class` / `x-test-portal-account`, because M16's
// `writeActorOf` (routes/actor.ts) requires a server-assembled `context.attributes.membershipId` — the
// plain userId/org/roles shim the other route-inventory files use is not enough for a module whose write
// actor is stamped from the active MEMBERSHIP, not the session user.
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
  const sessionClass = request.headers["x-test-session-class"];
  if (typeof sessionClass === "string" && sessionClass.length > 0) {
    request.context.attributes.sessionClass = sessionClass;
  }
  const portalAccount = request.headers["x-test-portal-account"];
  if (typeof portalAccount === "string" && portalAccount.length > 0) {
    request.context.attributes.portalAccountId = portalAccount;
  }
}

const ORG = "org_a";
const NOW = "2026-06-08T12:00:00.000Z";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const COUNSELOR_ID = "33333333-3333-4333-8333-333333333333";
const VOLUNTEER_ID = "44444444-4444-4444-8444-444444444444";
const SUPERVISOR_ID = "55555555-5555-4555-8555-555555555555";
const NO_PERMS_ID = "66666666-6666-4666-8666-666666666666";
const EXTERNAL_RESOURCE = "77777777-7777-4777-8777-777777777777";
/** ADR-0109 D5 — the pre-death draft is addressed by admission; one resolves to a patient, one does not exist. */
const ADMISSION_ID = "10000000-0000-4000-8000-000000000001";
const UNKNOWN_ADMISSION = "10000000-0000-4000-8000-0000000000ff";
const DRAFT_PATIENT = "10000000-0000-4000-8000-0000000000aa";
/** ADR-0109 D6 — the physician letter fixtures: the plan the letter belongs to and the internal clinician it addresses. */
const LETTER_PLAN_ID = "10000000-0000-4000-8000-0000000000bb";
const LETTER_ATTENDING = "10000000-0000-4000-8000-0000000000cc";
/** ADR-0109 D10 — the one mailing run the fake mailing service knows. */
const MAILING_RUN_ID = "10000000-0000-4000-8000-0000000000f1";
const PICKED_CLINICIAN = "10000000-0000-4000-8000-0000000000dd";
/** The care team of `DRAFT_PATIENT`: only the plan counselor's user sits on it. */
const ASSESSOR_PROBE: PreDeathAssessorProbe = {
  async patientOfAdmission(_org, admissionId) {
    return admissionId === UNKNOWN_ADMISSION ? null : DRAFT_PATIENT;
  },
  async isOnCareTeam(_org, _patient, userId) {
    return userId === "counselor_user";
  },
};

// ── internal fake-backend record shapes (deliberately loose on enum-ish fields — cast `as never` at the
// DTO boundary, the same convention `bereavement-authz.test.ts`'s `planFacts()` helper already uses) ─────
interface PlanRecord {
  planId: string;
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  locationId: string | null;
  status: string;
  deathDate: string;
  deathTime: string | null;
  windowEndsAt: string;
  openedAt: string | null;
  pausedAt: string | null;
  pauseKind: string | null;
  closedAt: string | null;
  assignedCounselorUserId: string | null;
  assignedCounselorAssignedAt: string | null;
  assignedVolunteerUserId: string | null;
  assignedVolunteerAssignedAt: string | null;
  contactIds: string[];
  currentRiskTier: string | null;
  currentRiskComputedAt: string | null;
  legalHoldId: string | null;
  version: number;
  updatedAt: string;
  closure: BereavementClosureView | null;
  pendingEarlyClose: { reason: string; requestedBy: string } | null;
}

interface ContactRecord {
  contactId: string;
  planId: string;
  status: string;
  displayName: string;
  relationshipCode: string;
  preferredLanguageIso639: string;
  portalAccountId: string | null;
  consentRecordId: string | null;
  allowedOutreachKinds: string[];
  volunteerVisibleOnly: boolean;
  confirmedAt: string | null;
  optedOutAt: string | null;
  unreachableAt: string | null;
  unreachableProposedAt?: string | null;
  deceasedAt: string | null;
  currentRiskTier: string | null;
  version: number;
}

interface OutreachRecord {
  outreachId: string;
  planId: string;
  contactId: string;
  kind: string;
  status: string;
  anniversaryMark: string | null;
  dueAt: string;
  lateGraceUntil: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  assigneeUserId: string | null;
  renderedDocumentId: string | null;
  sourceEncounterId: string | null;
  version: number;
}

let uuidSeq = 100;
/** A deterministic, monotonically-unique value that satisfies m16-typebox's UUID format check. */
function fakeId(): string {
  uuidSeq += 1;
  return `${String(uuidSeq).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function createFakeBackend() {
  const plans = new Map<string, PlanRecord>();
  const contacts = new Map<string, ContactRecord>();
  const outreach = new Map<string, OutreachRecord>();
  const contactLogs: BereavementContactLogView[] = [];
  const riskScores: BereavementRiskScoreView[] = [];
  const assessmentTasks: BereavementAssessmentTaskView[] = [];
  const recomputeInputs: RecomputeRiskInput[] = [];
  const careGoalWrites: Array<{
    contactId: string;
    goals: readonly string[];
    expectedVersion: number;
  }> = [];

  function seedPlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
    const planId = overrides.planId ?? fakeId();
    const rec: PlanRecord = {
      planId,
      patientId: fakeId(),
      admissionId: fakeId(),
      providerEntityId: PROVIDER,
      locationId: null,
      status: "active",
      deathDate: "2026-01-01",
      deathTime: null,
      windowEndsAt: "2027-02-01T00:00:00.000Z",
      openedAt: NOW,
      pausedAt: null,
      pauseKind: null,
      closedAt: null,
      assignedCounselorUserId: null,
      assignedCounselorAssignedAt: null,
      assignedVolunteerUserId: null,
      assignedVolunteerAssignedAt: null,
      contactIds: [],
      currentRiskTier: null,
      currentRiskComputedAt: null,
      legalHoldId: null,
      version: 1,
      updatedAt: NOW,
      closure: null,
      pendingEarlyClose: null,
      ...overrides,
    };
    plans.set(planId, rec);
    return rec;
  }

  function seedContact(planId: string, overrides: Partial<ContactRecord> = {}): ContactRecord {
    const contactId = overrides.contactId ?? fakeId();
    const rec: ContactRecord = {
      contactId,
      planId,
      status: "active",
      displayName: "Jane Survivor",
      relationshipCode: "spouse",
      preferredLanguageIso639: "en",
      portalAccountId: null,
      consentRecordId: null,
      allowedOutreachKinds: ["phone_call"],
      volunteerVisibleOnly: false,
      confirmedAt: NOW,
      optedOutAt: null,
      unreachableAt: null,
      deceasedAt: null,
      currentRiskTier: null,
      version: 1,
      ...overrides,
    };
    contacts.set(contactId, rec);
    const plan = plans.get(planId);
    if (plan && !plan.contactIds.includes(contactId)) plan.contactIds.push(contactId);
    return rec;
  }

  function seedOutreach(
    planId: string,
    contactId: string,
    overrides: Partial<OutreachRecord> = {},
  ): OutreachRecord {
    const outreachId = overrides.outreachId ?? fakeId();
    const rec: OutreachRecord = {
      outreachId,
      planId,
      contactId,
      kind: "phone_call",
      status: "scheduled",
      anniversaryMark: null,
      dueAt: NOW,
      lateGraceUntil: NOW,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      assigneeUserId: null,
      renderedDocumentId: null,
      sourceEncounterId: null,
      version: 1,
      ...overrides,
    };
    outreach.set(outreachId, rec);
    return rec;
  }

  const bump = (row: { version: number }) => {
    row.version += 1;
  };

  const zeroStats = () => ({
    completedCount: 0,
    missedCount: 0,
    contactsActiveCount: 0,
    contactsOptedOutCount: 0,
  });

  function contactRow(c: ContactRecord): BereavedContactRowView {
    return {
      contactId: c.contactId,
      planId: c.planId,
      status: c.status as never,
      displayName: c.displayName,
      relationshipCode: c.relationshipCode as never,
      preferredLanguageIso639: c.preferredLanguageIso639,
      portalAccountId: c.portalAccountId,
      consentRecordId: c.consentRecordId,
      allowedOutreachKinds: c.allowedOutreachKinds as never,
      volunteerVisibleOnly: c.volunteerVisibleOnly,
      confirmedAt: c.confirmedAt,
      optedOutAt: c.optedOutAt,
      unreachableAt: c.unreachableAt,
      unreachableProposed: (c.unreachableProposedAt ?? null) !== null && c.status !== "unreachable",
      unreachableProposedAt: c.status === "unreachable" ? null : (c.unreachableProposedAt ?? null),
      deceasedAt: c.deceasedAt,
      mayRescindOptOut: true,
      mailingsAllowed: true,
      currentRiskTier: c.currentRiskTier as never,
      version: c.version,
    };
  }

  function planListItem(p: PlanRecord): BereavementPlanListItem {
    return {
      planId: p.planId,
      patientId: p.patientId,
      admissionId: p.admissionId,
      status: p.status as never,
      deathDate: p.deathDate,
      windowEndsAt: p.windowEndsAt,
      assignedCounselorUserId: p.assignedCounselorUserId,
      assignedVolunteerUserId: p.assignedVolunteerUserId,
      currentRiskTier: p.currentRiskTier as never,
      contactsActiveCount: p.contactIds.length,
      nextOutreachDueAt: null,
      overdueOutreachCount: 0,
      externalSourceCosignPending: false,
      version: p.version,
      updatedAt: p.updatedAt,
    };
  }

  function planDetail(p: PlanRecord): BereavementPlanDetail {
    return {
      planId: p.planId,
      patientId: p.patientId,
      admissionId: p.admissionId,
      providerEntityId: p.providerEntityId,
      locationId: p.locationId,
      status: p.status as never,
      deathDate: p.deathDate,
      deathTime: p.deathTime,
      windowEndsAt: p.windowEndsAt,
      openedAt: p.openedAt,
      pausedAt: p.pausedAt,
      pauseKind: p.pauseKind as never,
      closedAt: p.closedAt,
      assignedCounselorUserId: p.assignedCounselorUserId,
      assignedCounselorAssignedAt: p.assignedCounselorAssignedAt,
      assignedVolunteerUserId: p.assignedVolunteerUserId,
      assignedVolunteerAssignedAt: p.assignedVolunteerAssignedAt,
      externalSource: null,
      firstContactAllowed: true,
      firstContactGateReason: null,
      contacts: p.contactIds.map((id) => contactRow(contacts.get(id)!)),
      stats: { ...zeroStats(), contactsActiveCount: p.contactIds.length },
      currentRiskTier: p.currentRiskTier as never,
      currentRiskComputedAt: p.currentRiskComputedAt,
      legalHoldId: p.legalHoldId,
      version: p.version,
      updatedAt: p.updatedAt,
      redactedCategories: [],
    };
  }

  function outreachRow(o: OutreachRecord): BereavementOutreachRowView {
    return {
      outreachId: o.outreachId,
      planId: o.planId,
      contactId: o.contactId,
      kind: o.kind as never,
      status: o.status as never,
      anniversaryMark: o.anniversaryMark as never,
      cadenceMark: null,
      dueAt: o.dueAt,
      lateGraceUntil: o.lateGraceUntil,
      startedAt: o.startedAt,
      completedAt: o.completedAt,
      cancelledAt: o.cancelledAt,
      assigneeUserId: o.assigneeUserId,
      renderedDocumentId: o.renderedDocumentId,
      sourceEncounterId: o.sourceEncounterId,
      version: o.version,
    };
  }

  const readService: M16ReadService = {
    async listPlans() {
      return { data: [...plans.values()].map(planListItem), next_cursor: null, has_more: false };
    },
    async getPlan(_actor, planId) {
      const p = plans.get(planId);
      return p ? planDetail(p) : null;
    },
    async getClosure(_actor, planId) {
      return plans.get(planId)?.closure ?? null;
    },
    async listOutreach(_actor, planId) {
      const p = plans.get(planId);
      if (!p) return null;
      const rows = [...outreach.values()].filter((o) => o.planId === planId).map(outreachRow);
      return { data: rows, next_cursor: null, has_more: false };
    },
    async listRiskScores(_actor, planId) {
      const p = plans.get(planId);
      if (!p) return null;
      const rows = riskScores.filter((r) => r.planId === planId);
      return { data: rows, next_cursor: null, has_more: false };
    },
    async listAssessmentTasks(_actor, planId) {
      if (!plans.has(planId)) return null;
      return {
        items: assessmentTasks.filter((t) => t.planId === planId),
        redactedCategories: [],
      };
    },
    async listContactTimeline(_actor, contactId) {
      if (!contacts.has(contactId)) return null;
      return {
        data: [
          {
            entryId: "10000000-0000-4000-8000-0000000000e1",
            at: NOW as never,
            source: "program_activity",
            kind: null,
            activityKind: "newsletter_mailing",
            outcome: "mailed",
          },
        ],
        next_cursor: null,
        has_more: false,
        redactedCategories: [],
      };
    },
    async counselorDashboard(actor, query) {
      const mine = [...plans.values()].filter(
        (p) => p.assignedCounselorUserId === actor.membershipId,
      );
      return {
        counselorUserId: actor.membershipId ?? "",
        caseloadCount: mine.length,
        dueWithinDays: query.dueWithinDays ?? 7,
        dueSoon: [],
        overdue: [],
        tierDistribution: { low: 0, moderate: 0, high: 0, complicated: 0 },
        externalSourceCosignPendingCount: 0,
      };
    },
    async supervisorDashboard() {
      return {
        planCountsByStatus: {
          eligible: 0,
          initiating: 0,
          active: plans.size,
          paused: 0,
          closed_completed: 0,
          closed_declined: 0,
          closed_early: 0,
          closed_legal_hold_extended: 0,
        },
        outreachCountsByStatus: {
          scheduled: 0,
          in_progress: 0,
          completed: 0,
          declined: 0,
          no_response: 0,
          missed: 0,
          cancelled: 0,
        },
        copCounts: { numerator: 0, denominator: 0 },
        tierDistribution: { low: 0, moderate: 0, high: 0, complicated: 0 },
        closureCountsByReason: {
          thirteen_month_completion: 0,
          all_contacts_declined: 0,
          patient_opt_out_pre_death: 0,
          patient_opt_out_post_creation: 0,
          tenant_offboarding: 0,
          all_bereaved_deceased: 0,
          geographic_relocation: 0,
          family_legal_action: 0,
          other_early: 0,
        },
        unassignedPlanCount: 0,
        externalSourceCosignPendingCount: 0,
      };
    },
  };

  const writeService: M16WriteService = {
    async assignCounselor(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      p.assignedCounselorUserId = input.counselorUserId;
      p.assignedCounselorAssignedAt = NOW;
      bump(p);
      return planDetail(p);
    },
    async assignVolunteer(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      p.assignedVolunteerUserId = input.volunteerUserId;
      p.assignedVolunteerAssignedAt = NOW;
      bump(p);
      return planDetail(p);
    },
    async seedRosterAndSchedule(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      p.status = "active";
      p.openedAt = NOW;
      bump(p);
      let seeded = 0;
      for (const c of input.additionalContacts ?? []) {
        seedContact(planId, {
          displayName: c.displayName,
          relationshipCode: c.relationshipCode,
        });
        seeded += 1;
      }
      const activation: PlanActivationView = {
        plan: planDetail(p),
        contactsSeededCount: seeded,
        outreachScheduledCount: 0,
        anniversaryRemindersCount: 0,
        effects: [],
      };
      return activation;
    },
    async pausePlan(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      p.status = "paused";
      p.pausedAt = NOW;
      p.pauseKind = input.pauseKind;
      bump(p);
      return planDetail(p);
    },
    async resumePlan(_actor, planId) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      p.status = "active";
      p.pausedAt = null;
      p.pauseKind = null;
      bump(p);
      return planDetail(p);
    },
    async closeEarly(actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      // GAP-047 — a request only: the plan keeps its state and no closure exists yet.
      p.pendingEarlyClose = { reason: input.reason, requestedBy: actor.membershipId };
      bump(p);
      return planDetail(p);
    },
    async cosignClose(actor, planId) {
      const p = plans.get(planId);
      if (!p?.pendingEarlyClose) throw new NotFoundError("bereavement plan closure not found");
      if (p.pendingEarlyClose.requestedBy === actor.membershipId) {
        throw new ForbiddenError("the cosign must come from someone other than the requester");
      }
      p.status = "closed_early";
      p.closedAt = NOW;
      p.closure = {
        closureId: fakeId(),
        planId,
        reason: p.pendingEarlyClose.reason as never,
        closeKind: "manual",
        closedAt: NOW,
        closedByUserId: p.pendingEarlyClose.requestedBy as never,
        cosignedByUserId: actor.membershipId,
        cosignedAt: NOW,
        stats: zeroStats(),
        bereavementSummaryDocumentId: null,
        dischargeSummaryDocumentId: null,
      };
      p.pendingEarlyClose = null;
      bump(p);
      return p.closure;
    },
    async createContact(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      const c = seedContact(planId, {
        displayName: input.displayName,
        relationshipCode: input.relationshipCode,
        status: "proposed",
        confirmedAt: null,
        allowedOutreachKinds: input.outreachPreferences?.allowedKinds
          ? [...input.outreachPreferences.allowedKinds]
          : ["phone_call"],
      });
      return contactRow(c);
    },
    async updateContact(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      if (input.displayName !== undefined) c.displayName = input.displayName;
      if (input.preferredLanguageIso639 !== undefined)
        c.preferredLanguageIso639 = input.preferredLanguageIso639;
      bump(c);
      return contactRow(c);
    },
    async confirmContact(_actor, contactId) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "active";
      c.confirmedAt = NOW;
      bump(c);
      return contactRow(c);
    },
    async optOutContact(_actor, contactId) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "opted_out";
      c.optedOutAt = NOW;
      bump(c);
      return contactRow(c);
    },
    async rescindOptOut(_actor, contactId) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "active";
      c.optedOutAt = null;
      bump(c);
      return contactRow(c);
    },
    async markContactDeceased(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "deceased";
      c.deceasedAt = input.deceasedAt;
      bump(c);
      return contactRow(c);
    },
    async markContactUnreachable(_actor, contactId) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "unreachable";
      c.unreachableAt = NOW;
      bump(c);
      return contactRow(c);
    },
    async dismissUnreachableProposal(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      if ((c.version ?? 0) !== input.expectedVersion && input.expectedVersion !== undefined)
        throw new Error("version mismatch");
      c.unreachableProposedAt = null;
      bump(c);
      return contactRow(c);
    },
    async flagComplicatedGrief(_actor, contactId) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      c.status = "ineligible_post_review";
      bump(c);
      return contactRow(c);
    },
    async startOutreach(_actor, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "in_progress";
      o.startedAt = NOW;
      bump(o);
      return outreachRow(o);
    },
    async completeOutreach(_actor, outreachId, input) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "completed";
      o.completedAt = NOW;
      bump(o);
      contactLogs.push({
        contactLogId: fakeId(),
        planId: o.planId,
        contactId: o.contactId,
        outreachId: o.outreachId,
        kind: input.kind,
        outcome: input.outcome,
        contactAt: NOW,
        artifactDocumentId: input.artifactDocumentId ?? null,
      });
      return outreachRow(o);
    },
    async declineOutreach(_actor, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "declined";
      bump(o);
      return outreachRow(o);
    },
    async noResponseOutreach(_actor, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "no_response";
      bump(o);
      return outreachRow(o);
    },
    async cancelOutreach(_actor, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "cancelled";
      o.cancelledAt = NOW;
      bump(o);
      return outreachRow(o);
    },
    async lateAttemptOutreach(_actor, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) throw new NotFoundError("bereavement outreach not found");
      o.status = "in_progress";
      o.startedAt = NOW;
      bump(o);
      return outreachRow(o);
    },
    async logDirectContact(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      const log: BereavementContactLogView = {
        contactLogId: fakeId(),
        planId: c.planId,
        contactId,
        outreachId: fakeId(),
        kind: input.kind,
        outcome: input.outcome,
        contactAt: input.contactAt,
        artifactDocumentId: input.artifactDocumentId ?? null,
      };
      contactLogs.push(log);
      return log;
    },
    async regenerateSchedule(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      const contactId = input.contactId ?? p.contactIds[0];
      const generated = contactId ? [seedOutreach(planId, contactId, { status: "scheduled" })] : [];
      const view: ScheduleRegenerationView = {
        planId,
        cancelledCount: 0,
        generatedCount: generated.length,
        outreach: generated.map(outreachRow),
      };
      return view;
    },
    async setCareGoals(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      if (input.expectedVersion !== c.version) {
        throw new BereavementStateError("STALE_VERSION", "the contact has moved on");
      }
      careGoalWrites.push({
        contactId,
        goals: input.goals,
        expectedVersion: input.expectedVersion,
      });
      bump(c);
      return { ...contactRow(c), careGoals: input.goals };
    },
    async recomputeRisk(actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      recomputeInputs.push(input);
      const score: BereavementRiskScoreView = {
        scoreId: fakeId(),
        planId,
        contactId: input.bereavedContactId ?? null,
        scoreKind: "rule_deterministic",
        assessedAt: NOW,
        assessedByUserId: actor.membershipId,
        tier: "low",
        deterministicTier: "low",
        ruleScore: 10,
        dataCompleteness: "partial",
        confidenceBand: "MEDIUM",
        factors: {},
        pg13Score: null,
        ipgrScore: null,
        evidenceDegraded: false,
        redactedCategories: [],
      };
      riskScores.push(score);
      p.currentRiskTier = score.tier;
      p.currentRiskComputedAt = NOW;
      return score;
    },
    async referExternal(_actor, contactId, input) {
      const c = contacts.get(contactId);
      if (!c) throw new NotFoundError("bereaved contact not found");
      const log: BereavementContactLogView = {
        contactLogId: fakeId(),
        planId: c.planId,
        contactId,
        outreachId: fakeId(),
        kind: "external_referral",
        outcome: "requested_followup",
        contactAt: input.contactAt ?? NOW,
        artifactDocumentId: null,
      };
      contactLogs.push(log);
      return log;
    },
    async initiateContact(_actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
      const o = seedOutreach(planId, input.contactId, {
        kind: input.kind ?? "phone_call",
        status: "in_progress",
        startedAt: NOW,
      });
      return outreachRow(o);
    },
  };

  function planFacts(p: PlanRecord): BereavementPlanAbacFacts {
    return {
      organizationId: ORG,
      planId: p.planId,
      status: p.status as never,
      assignedCounselorUserId: p.assignedCounselorUserId,
      assignedVolunteerUserId: p.assignedVolunteerUserId,
    };
  }

  const DISCIPLINE_MAP: Record<string, string> = {
    [COUNSELOR_ID]: "bereavement_counselor",
    [VOLUNTEER_ID]: "bereavement_volunteer",
  };

  const resolver: BereavementAbacResolver = {
    async loadPlan(_orgId, planId) {
      const p = plans.get(planId);
      return p ? planFacts(p) : null;
    },
    async loadPlanForContact(_orgId, contactId) {
      const c = contacts.get(contactId);
      if (!c) return null;
      const p = plans.get(c.planId);
      return p ? planFacts(p) : null;
    },
    async loadPlanForOutreach(_orgId, outreachId) {
      const o = outreach.get(outreachId);
      if (!o) return null;
      const p = plans.get(o.planId);
      return p ? planFacts(p) : null;
    },
    async loadContact(_orgId, contactId): Promise<BereavedContactAbacFacts | null> {
      const c = contacts.get(contactId);
      if (!c) return null;
      return {
        organizationId: ORG,
        contactId: c.contactId,
        planId: c.planId,
        portalAccountId: c.portalAccountId,
      };
    },
    async disciplineOf(_orgId, subjectId) {
      return DISCIPLINE_MAP[subjectId] ?? null;
    },
  };

  // ── the pre-death draft (ADR-0109 D5): an in-memory stand-in that applies the same version / lock contract ──
  const drafts = new Map<string, { factors: PreDeathDraftView["factors"]; version: number }>();
  const lockedAdmissions = new Set<string>();
  const draftWrites: Array<{ admissionId: string; membershipId: string; expectedVersion: number }> =
    [];
  const draftView = (admissionId: string): PreDeathDraftView => {
    const row = drafts.get(admissionId);
    return {
      admissionId,
      exists: row !== undefined,
      factors:
        row?.factors ??
        ({
          ambivalent_relationship: "unknown",
          sudden_unexpected_death: "unknown",
          prior_unresolved_loss: "unknown",
          preexisting_mental_health: "unknown",
          social_isolation: "unknown",
          financial_strain: "unknown",
          primary_caregiver_role: "unknown",
          active_substance_use: "unknown",
        } as const),
      lastEditedDiscipline: row === undefined ? null : "medical_social_worker",
      lastEditedAt: row === undefined ? null : (NOW as never),
      carriedScoreId: null,
      carriedAt: null,
      locked: lockedAdmissions.has(admissionId),
      version: row?.version ?? 0,
      redactedCategories: ["sud"],
    };
  };
  const draftService: M16DraftService = {
    async getDraft(_actor, admissionId) {
      return admissionId === UNKNOWN_ADMISSION ? null : draftView(admissionId);
    },
    async putDraft(actor, admissionId, input) {
      if (admissionId === UNKNOWN_ADMISSION) throw new NotFoundError("admission not found");
      if (lockedAdmissions.has(admissionId)) {
        throw new BereavementStateError("DRAFT_LOCKED", "a plan already exists");
      }
      const held = drafts.get(admissionId)?.version ?? 0;
      if (input.expectedVersion !== held) {
        throw new BereavementStateError("STALE_VERSION", "the draft has moved on");
      }
      draftWrites.push({
        admissionId,
        membershipId: actor.membershipId,
        expectedVersion: input.expectedVersion,
      });
      drafts.set(admissionId, { factors: factorsToWire(input.factors), version: held + 1 });
      return draftView(admissionId);
    },
  };

  // ADR-0109 D6 — the physician letter queue. The fake applies the REAL pure approve / decline rules, so the wiring tests also see
  // the 409 / 422 / 412 a reviewer would, without a database.
  const letters = new Map<string, PhysicianLetterView & { note: string | null }>();
  const letterEvents: Array<{ letterId: string; templateKey: string; documentKind: string }> = [];
  const seedLetter = (over: Partial<PhysicianLetterView> = {}) => {
    const letterId =
      over.letterId ?? `aaaa0000-0000-4000-8000-${String(letters.size + 1).padStart(12, "0")}`;
    const letter = {
      letterId,
      planId: LETTER_PLAN_ID,
      patientId: DRAFT_PATIENT,
      status: "pending_review" as const,
      dueAt: "2026-06-10T00:00:00.000Z",
      createdAt: NOW,
      attendingUserId: LETTER_ATTENDING as string | null,
      hasPersonalNote: false,
      declineReason: null,
      reviewedAt: null,
      renderedDocumentId: null,
      version: 0,
      note: null as string | null,
      ...over,
    };
    letters.set(letterId, letter);
    return letter;
  };
  const publicLetter = ({ note: _note, ...view }: PhysicianLetterView & { note: string | null }) =>
    view;
  const letterOf = (letterId: string) => {
    const letter = letters.get(letterId);
    if (!letter) throw new BereavementStateError("PHYSICIAN_LETTER_NOT_FOUND", "not found");
    return letter;
  };
  const letterService: M16LetterService = {
    async listLetters(_actor, input) {
      const data = [...letters.values()]
        .filter((l) => input.status === undefined || l.status === input.status)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .map(publicLetter);
      return { data, next_cursor: null, has_more: false };
    },
    async getLetterForPlan(_actor, planId) {
      const found = [...letters.values()].find((l) => l.planId === planId);
      return found ? publicLetter(found) : null;
    },
    async approveLetter(actor, letterId, input) {
      const letter = letterOf(letterId);
      checkVersion(input.expectedVersion, letter.version);
      const decision = decideLetterApproval(letter, {
        personalNote: input.personalNote,
        attendingUserId: input.attendingUserId,
      });
      const next = {
        ...letter,
        status: "approved" as const,
        attendingUserId: decision.attendingUserId,
        hasPersonalNote: decision.personalNote !== null,
        note: decision.personalNote,
        reviewedAt: NOW,
        version: letter.version + 1,
      };
      letters.set(letterId, next);
      letterEvents.push({
        letterId,
        templateKey: "bereavement_physician_condolence_letter",
        documentKind: `by:${actor.membershipId}`,
      });
      return publicLetter(next);
    },
    async declineLetter(_actor, letterId, input) {
      const letter = letterOf(letterId);
      checkVersion(input.expectedVersion, letter.version);
      const reason = decideLetterDecline(letter, input.reason);
      const next = {
        ...letter,
        status: "declined" as const,
        declineReason: reason,
        reviewedAt: NOW,
        version: letter.version + 1,
      };
      letters.set(letterId, next);
      return publicLetter(next);
    },
  };

  // ADR-0109 D10 — a minimal fake of the mailing service: the routes' wiring (guards, headers, status codes) is what this file proves; the state machine,
  // the set-based selection and the worker are proven over a real database in `m16-mailings.live.test.ts`.
  const mailingCalls: { method: string; runId?: string; expectedVersion?: number | undefined }[] =
    [];
  const mailingRun = (runId: string, over: Partial<MailingRunView> = {}): MailingRunView => ({
    runId,
    runKind: "newsletter",
    mailingKey: "newsletter_quarterly",
    occurrenceKey: "newsletter_quarterly:2026-Q4",
    scheduledFor: "2026-10-15",
    status: "draft",
    content: {},
    recipientCount: 0,
    excludedCount: 0,
    failureCode: null,
    hasDocument: false,
    generatedAt: null,
    mailedAt: null,
    itemCounts: { included: 0, excluded: 0, logged: 0, excludedAfterRender: 0 },
    version: 0,
    createdAt: NOW,
    ...over,
  });
  const mailingService: M16MailingService = {
    async listConfigs() {
      return ["newsletter_quarterly", "holiday_december", "mothers_day", "fathers_day"].map(
        (mailingKey) => ({
          mailingKey: mailingKey as never,
          configured: false,
          enabled: false,
          leadDays: 10,
          schedule: {},
          audienceRelationships: null,
          content: {},
          version: 0,
          updatedAt: null,
        }),
      );
    },
    async putConfig(_actor, mailingKey, input) {
      mailingCalls.push({ method: "putConfig", expectedVersion: input.expectedVersion });
      return {
        mailingKey,
        configured: true,
        enabled: input.enabled,
        leadDays: input.leadDays,
        schedule: input.schedule ?? {},
        audienceRelationships: input.audienceRelationships,
        content: input.content,
        version: input.expectedVersion + 1,
        updatedAt: NOW,
      };
    },
    async listRuns() {
      return { data: [mailingRun(MAILING_RUN_ID)], next_cursor: null, has_more: false };
    },
    async getRun(_actor, runId) {
      return runId === MAILING_RUN_ID ? mailingRun(runId) : null;
    },
    async listItems(_actor, runId) {
      return runId === MAILING_RUN_ID ? { data: [], next_cursor: null, has_more: false } : null;
    },
    async updateRunContent(_actor, runId, input) {
      mailingCalls.push({
        method: "updateRunContent",
        runId,
        expectedVersion: input.expectedVersion,
      });
      return mailingRun(runId, { content: input.content, version: input.expectedVersion + 1 });
    },
    async generateRun(_actor, runId, input) {
      mailingCalls.push({ method: "generateRun", runId, expectedVersion: input.expectedVersion });
      checkVersion(input.expectedVersion, 0);
      return mailingRun(runId, { status: "generating", version: 1 });
    },
    async downloadRun(_actor, runId) {
      mailingCalls.push({ method: "downloadRun", runId });
      return { runId, url: "https://objects.example.test/batch", expiresAt: NOW };
    },
    async confirmMailed(_actor, runId, input) {
      mailingCalls.push({ method: "confirmMailed", runId, expectedVersion: input.expectedVersion });
      return mailingRun(runId, { status: "mailed", version: input.expectedVersion + 1 });
    },
    async cancelRun(_actor, runId, input) {
      mailingCalls.push({ method: "cancelRun", runId, expectedVersion: input.expectedVersion });
      return mailingRun(runId, { status: "cancelled", version: input.expectedVersion + 1 });
    },
  };

  return {
    readService,
    writeService,
    draftService,
    letterService,
    mailingService,
    mailingCalls,
    seedLetter,
    letters,
    letterEvents,
    resolver,
    seedPlan,
    seedContact,
    seedOutreach,
    assessmentTasks,
    recomputeInputs,
    careGoalWrites,
    lockedAdmissions,
    draftWrites,
  };
}

type FakeBackend = ReturnType<typeof createFakeBackend>;

function makeServer(): { app: ReturnType<typeof buildServer>; backend: FakeBackend } {
  const backend = createFakeBackend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "counselor_user",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M16_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "supervisor_user",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M16_PERMISSION_KEY_LIST],
        },
      ],
    },
    // Holders of every key whose DISCIPLINE or care-team seat the predicate (not RBAC) is what refuses.
    ...["offteam_msw_user", "volunteer_user"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M16_PERMISSION_KEY_LIST],
        },
      ],
    })),
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server — the shared registry would otherwise close over a PRIOR test's
  // in-memory backend (the M11-T06 `orders-routes.test.ts` precedent). `step_up_recent` is M3's predicate,
  // not M16's; it is stubbed to always-pass here because freshness policy is exercised elsewhere
  // (`step-up-policy.test.ts`, `consent-surface.test.ts`) and is not this file's concern.
  const reg = createPredicateRegistry();
  const predicates = buildBereavementAbacPredicates({
    resolver: backend.resolver,
    volunteerGatesSatisfied: async ({ volunteerMembershipId }) =>
      volunteerMembershipId === VOLUNTEER_ID,
    preDeathAssessor: ASSESSOR_PROBE,
  });
  for (const [name, predicate] of Object.entries(predicates)) reg.register(name, predicate);
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM16Routes(app, {
    readService: backend.readService,
    writeService: backend.writeService,
    draftService: backend.draftService,
    letterService: backend.letterService,
    mailingService: backend.mailingService,
  });
  return { app, backend };
}

const COUNSELOR = {
  "x-test-user": "counselor_user",
  "x-test-org": ORG,
  "x-test-roles": "bereavement_counselor",
  "x-test-membership": COUNSELOR_ID,
};
const SUPERVISOR = {
  "x-test-user": "supervisor_user",
  "x-test-org": ORG,
  "x-test-roles": "clinical_supervisor",
  "x-test-membership": SUPERVISOR_ID,
};
const OFFTEAM_MSW = {
  "x-test-user": "offteam_msw_user",
  "x-test-org": ORG,
  "x-test-roles": "msw",
  "x-test-membership": "77777777-7777-4777-8777-77777777aaaa",
};
const VOLUNTEER = {
  "x-test-user": "volunteer_user",
  "x-test-org": ORG,
  "x-test-roles": "bereavement_volunteer",
  "x-test-membership": VOLUNTEER_ID,
};
const NO_PERMS = {
  "x-test-user": "noperm_user",
  "x-test-org": ORG,
  "x-test-roles": "auditor",
  "x-test-membership": NO_PERMS_ID,
};

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

// ── 401 / 403 / 422 ─────────────────────────────────────────────────────────────────────────────────────

describe("M16 §4.1 route inventory — the boundary cases", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/bereavement/plans" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("route 34 dismiss-unreachable-proposal denies a user without mark_unreachable (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bereavement/contacts/55555555-5555-4555-8555-555555555555/dismiss-unreachable-proposal",
      headers: { ...NO_PERMS, "idempotency-key": "k-34" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a user holding NO bereavement permissions is denied (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bereavement/plans",
      headers: NO_PERMS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an empty pause payload fails TypeBox validation (422)", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/pause`,
      headers: { ...COUNSELOR, "idempotency-key": "pause-422" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── routes 1,2,3,4,5,6,7,19 — worklist, detail, assignment ladder, activation, pause/resume, touchpoints ─

describe("M16 §4.1 routes 1–7, 19 — plan worklist, assignment, activation, pause/resume", () => {
  it("lists → assigns counselor + volunteer → activates → pauses → resumes → lists touchpoints", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "initiating" });

    // 1
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/bereavement/plans",
      headers: SUPERVISOR,
    });
    expect(list.statusCode).toBe(200);

    // 3
    const assignCounselor = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/assign-counselor`,
      headers: { ...SUPERVISOR, "idempotency-key": "ac-1" },
      payload: { counselorUserId: COUNSELOR_ID },
    });
    expect(assignCounselor.statusCode).toBe(200);
    expect(assignCounselor.json().assignedCounselorUserId).toBe(COUNSELOR_ID);

    // 4
    const assignVolunteer = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/assign-volunteer`,
      headers: { ...SUPERVISOR, "idempotency-key": "av-1" },
      payload: { volunteerUserId: VOLUNTEER_ID },
    });
    expect(assignVolunteer.statusCode).toBe(200);
    expect(assignVolunteer.json().assignedVolunteerUserId).toBe(VOLUNTEER_ID);

    // 5
    const seed = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/seed-roster-and-schedule`,
      headers: { ...SUPERVISOR, "idempotency-key": "seed-1" },
      payload: {
        seedFromCaregivers: false,
        additionalContacts: [{ displayName: "Jane Roe", relationshipCode: "spouse" }],
      },
    });
    expect(seed.statusCode).toBe(200);
    expect(seed.json().contactsSeededCount).toBe(1);

    // 2
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/bereavement/plans/${plan.planId}`,
      headers: COUNSELOR,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe("active");

    // 6
    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/pause`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "p-1",
        "if-match": String(detail.json().version),
      },
      payload: { pauseKind: "operational", reason: "counselor temporarily unavailable" },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().status).toBe("paused");

    // 7
    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/resume`,
      headers: { ...COUNSELOR, "idempotency-key": "r-1", "if-match": String(pause.json().version) },
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().status).toBe("active");

    // 19
    const outreachList = await app.inject({
      method: "GET",
      url: `/api/v1/bereavement/plans/${plan.planId}/outreach`,
      headers: COUNSELOR,
    });
    expect(outreachList.statusCode).toBe(200);

    await app.close();
  });
});

// ── routes 8,9,10 — early close, supervisor cosign, the closure record ─────────────────────────────────

describe("M16 §4.1 routes 8–10 — early close + cosign + closure", () => {
  it("counselor requests an early close (step-up); supervisor cosigns; the closure record reads back", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });

    const close = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/close-early`,
      headers: { ...COUNSELOR, "idempotency-key": "ce-1", "if-match": String(plan.version) },
      payload: { reason: "geographic_relocation", narrative: "x".repeat(45) },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().status).toBe("active");

    const cosign = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/cosign-close`,
      headers: { ...SUPERVISOR, "idempotency-key": "cc-1" },
      payload: { attestation: "confirmed by clinical supervisor" },
    });
    expect(cosign.statusCode).toBe(200);
    expect(cosign.json().cosignedByUserId).toBe(SUPERVISOR_ID);
    expect(cosign.json().closedByUserId).toBe(COUNSELOR_ID);
    const closureId = cosign.json().closureId as string;

    const closure = await app.inject({
      method: "GET",
      url: `/api/v1/bereavement/plans/${plan.planId}/closure`,
      headers: COUNSELOR,
    });
    expect(closure.statusCode).toBe(200);
    expect(closure.json().closureId).toBe(closureId);

    await app.close();
  });
});

// ── routes 11–18, 26, 32 — the per-contact surface ─────────────────────────────────────────────────────

describe("M16 §4.1 routes 11–18, 26, 32 — bereaved-contact lifecycle", () => {
  it("creates → updates → confirms → opts out → rescinds → logs → refers → flags → unreachable → deceased", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });

    // 11
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/contacts`,
      headers: { ...COUNSELOR, "idempotency-key": "c-create" },
      payload: { displayName: "Jane Roe", relationshipCode: "spouse" },
    });
    expect(create.statusCode).toBe(201);
    const contactId = create.json().contactId as string;

    // 12
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/bereavement/contacts/${contactId}`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "c-update",
        "if-match": String(create.json().version),
      },
      payload: { displayName: "Jane A. Roe" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().displayName).toBe("Jane A. Roe");

    // 13
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/confirm`,
      headers: { ...COUNSELOR, "idempotency-key": "c-confirm" },
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("active");

    // 14
    const optOut = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/opt-out`,
      headers: { ...COUNSELOR, "idempotency-key": "c-optout" },
      payload: { optOutKind: "full", sourceKind: "counselor_recorded" },
    });
    expect(optOut.statusCode).toBe(200);
    expect(optOut.json().status).toBe("opted_out");

    // 15
    const rescind = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/rescind-opt-out`,
      headers: { ...COUNSELOR, "idempotency-key": "c-rescind" },
      payload: {},
    });
    expect(rescind.statusCode).toBe(200);
    expect(rescind.json().status).toBe("active");

    // 26
    const logDirect = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/log-direct`,
      headers: { ...COUNSELOR, "idempotency-key": "c-logdirect" },
      payload: { kind: "phone_call", outcome: "engaged", contactAt: NOW, contactResponded: true },
    });
    expect(logDirect.statusCode).toBe(201);

    // 32
    const referExternal = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/refer-external`,
      headers: { ...COUNSELOR, "idempotency-key": "c-refer" },
      payload: { externalResourceId: EXTERNAL_RESOURCE },
    });
    expect(referExternal.statusCode).toBe(201);

    // 18 — ABAC_DISCIPLINE_SELF, on top of ABAC_WINDOW_CONTACT
    const flag = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/flag-complicated-grief`,
      headers: { ...COUNSELOR, "idempotency-key": "c-flag" },
      payload: { externalResourceId: EXTERNAL_RESOURCE },
    });
    expect(flag.statusCode).toBe(200);

    // 17
    const unreachable = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/mark-unreachable`,
      headers: { ...COUNSELOR, "idempotency-key": "c-unreachable" },
      payload: {},
    });
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json().status).toBe("unreachable");

    // 34 — unreachable is terminal here, but the route still resolves for a known contact
    const keepTrying = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/dismiss-unreachable-proposal`,
      headers: { ...COUNSELOR, "idempotency-key": "c-keep-trying" },
      payload: {},
    });
    expect(keepTrying.statusCode).toBe(200);
    expect(keepTrying.json().unreachableProposed).toBe(false);
    const keepTryingNoKey = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/dismiss-unreachable-proposal`,
      headers: { ...COUNSELOR },
      payload: {},
    });
    expect(keepTryingNoKey.statusCode).toBeGreaterThanOrEqual(400);

    // 16
    const deceased = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/contacts/${contactId}/mark-deceased`,
      headers: { ...COUNSELOR, "idempotency-key": "c-deceased" },
      payload: { deceasedAt: NOW, deathSource: "family report" },
    });
    expect(deceased.statusCode).toBe(200);
    expect(deceased.json().status).toBe("deceased");

    await app.close();
  });
});

// ── routes 20–25 — the per-touchpoint §2.4 lifecycle ───────────────────────────────────────────────────

describe("M16 §4.1 routes 20–25 — outreach lifecycle", () => {
  it("start → complete; decline; no-response; cancel; late-attempt", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const contact = backend.seedContact(plan.planId);

    // 20 then 21 (same touchpoint)
    const scheduled = backend.seedOutreach(plan.planId, contact.contactId, { status: "scheduled" });
    const start = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${scheduled.outreachId}/start`,
      headers: { ...COUNSELOR, "idempotency-key": "o-start" },
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe("in_progress");

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${scheduled.outreachId}/complete`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "o-complete",
        "if-match": String(start.json().version),
      },
      payload: { kind: "phone_call", outcome: "engaged", contactResponded: true },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("completed");

    // 22
    const forDecline = backend.seedOutreach(plan.planId, contact.contactId, {
      status: "in_progress",
    });
    const decline = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${forDecline.outreachId}/decline`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "o-decline",
        "if-match": String(forDecline.version),
      },
      payload: {},
    });
    expect(decline.statusCode).toBe(200);
    expect(decline.json().status).toBe("declined");

    // 23
    const forNoResponse = backend.seedOutreach(plan.planId, contact.contactId, {
      status: "in_progress",
    });
    const noResponse = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${forNoResponse.outreachId}/no-response`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "o-noresponse",
        "if-match": String(forNoResponse.version),
      },
      payload: {},
    });
    expect(noResponse.statusCode).toBe(200);
    expect(noResponse.json().status).toBe("no_response");

    // 24
    const forCancel = backend.seedOutreach(plan.planId, contact.contactId, { status: "scheduled" });
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${forCancel.outreachId}/cancel`,
      headers: {
        ...COUNSELOR,
        "idempotency-key": "o-cancel",
        "if-match": String(forCancel.version),
      },
      payload: { reason: "family requested a pause" },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");

    // 25
    const forLate = backend.seedOutreach(plan.planId, contact.contactId, { status: "missed" });
    const late = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/outreach/${forLate.outreachId}/late-attempt`,
      headers: { ...COUNSELOR, "idempotency-key": "o-late", "if-match": String(forLate.version) },
      payload: {},
    });
    expect(late.statusCode).toBe(200);
    expect(late.json().status).toBe("in_progress");

    await app.close();
  });
});

// ── routes 27, 28, 29 — schedule regeneration + risk recompute + risk-score history ────────────────────

describe("M16 §4.1 routes 27–29 — schedule regeneration + risk", () => {
  it("regenerates the forward schedule, recomputes the deterministic score, and reads the history", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const contact = backend.seedContact(plan.planId);

    const regen = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/regenerate-schedule`,
      headers: { ...COUNSELOR, "idempotency-key": "rs-1" },
      payload: { contactId: contact.contactId },
    });
    expect(regen.statusCode).toBe(200);
    expect(regen.json().generatedCount).toBe(1);

    const recompute = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/recompute-risk`,
      headers: { ...COUNSELOR, "idempotency-key": "rr-1" },
      payload: { bereavedContactId: contact.contactId },
    });
    expect(recompute.statusCode).toBe(201);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/bereavement/plans/${plan.planId}/risk-scores`,
      headers: COUNSELOR,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.length).toBeGreaterThan(0);

    await app.close();
  });
});

// ── route 28 (the honored `factors`) + route 37 (assessment tasks) — ADR-0109 D3 / D5 ───────────────────

const EIGHT_FACTORS = {
  ambivalent_relationship: true,
  sudden_unexpected_death: "unknown",
  prior_unresolved_loss: false,
  preexisting_mental_health: "unknown",
  social_isolation: true,
  financial_strain: "unknown",
  primary_caregiver_role: false,
  active_substance_use: "unknown",
} as const;

describe("M16 §4.1 route 28 — recompute-risk honors `factors` and names an assessment task", () => {
  const url = (planId: string) => `/api/v1/bereavement/plans/${planId}/recompute-risk`;

  it("maps the wire factors onto the service input and passes the task, screen totals and contact through", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const contact = backend.seedContact(plan.planId);
    const taskId = "77777777-7777-4777-8777-777777777778";

    const res = await app.inject({
      method: "POST",
      url: url(plan.planId),
      headers: { ...COUNSELOR, "idempotency-key": "rr-factors" },
      payload: {
        bereavedContactId: contact.contactId,
        assessmentTaskId: taskId,
        factors: { ...EIGHT_FACTORS, pg13_score: 31, ipgr_score: 12, notes: "not stored" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(backend.recomputeInputs.at(-1)).toEqual({
      bereavedContactId: contact.contactId,
      assessmentTaskId: taskId,
      manualFactors: {
        ambivalentRelationship: true,
        suddenUnexpectedDeath: "unknown",
        priorUnresolvedLoss: false,
        preExistingMentalHealth: "unknown",
        socialIsolation: true,
        financialStrain: "unknown",
        primaryCaregiverRole: false,
        activeSubstanceUse: "unknown",
      },
      pg13Score: 31,
      ipgrScore: 12,
    });
    await app.close();
  });

  it("passes no manual factors when the body carries none", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({
      method: "POST",
      url: url(plan.planId),
      headers: { ...COUNSELOR, "idempotency-key": "rr-none" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(backend.recomputeInputs.at(-1)).toEqual({});
    await app.close();
  });

  it.each([
    ["a factor missing from the eight", { factors: { ambivalent_relationship: true } }],
    [
      "a factor that is not tri-state",
      { factors: { ...EIGHT_FACTORS, financial_strain: "maybe" } },
    ],
    ["a screen total out of range", { factors: { ...EIGHT_FACTORS, pg13_score: 99 } }],
    ["an assessment task id that is not a uuid", { assessmentTaskId: "task-1" }],
  ])("rejects %s with a TypeBox 422", async (_name, payload) => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({
      method: "POST",
      url: url(plan.planId),
      headers: { ...COUNSELOR, "idempotency-key": "rr-bad" },
      payload,
    });
    expect(res.statusCode).toBe(422);
    expect(backend.recomputeInputs).toHaveLength(0);
    await app.close();
  });

  it("requires an Idempotency-Key (400)", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({
      method: "POST",
      url: url(plan.planId),
      headers: COUNSELOR,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("M16 §4.1 route 37 — GET /plans/:planId/assessment-tasks", () => {
  const url = (planId: string) => `/api/v1/bereavement/plans/${planId}/assessment-tasks`;
  const task = (planId: string): BereavementAssessmentTaskView => ({
    taskId: "88888888-8888-4888-8888-888888888881",
    planId: planId as never,
    contactId: "99999999-9999-4999-8999-999999999991" as never,
    taskKind: "initial_assessment",
    status: "scheduled",
    dueAt: NOW as never,
    lateGraceUntil: NOW as never,
    completedAt: null,
    completedByMembershipId: null,
    riskScoreId: null,
    assigneeUserId: null,
    version: 0,
  });

  it("the plan's counselor reads the checkpoints", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    backend.assessmentTasks.push(task(plan.planId));
    const res = await app.inject({ method: "GET", url: url(plan.planId), headers: COUNSELOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({
      taskKind: "initial_assessment",
      status: "scheduled",
    });
    await app.close();
  });

  it("oversight reads a plan it does not hold", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({ method: "GET", url: url(plan.planId), headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a counselor outside the plan window 404s, and an unknown plan 404s (nothing about who died leaks)", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: SUPERVISOR_ID });
    const other = await app.inject({ method: "GET", url: url(plan.planId), headers: COUNSELOR });
    expect(other.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "GET",
      url: url("00000000-0000-4000-8000-00000000dead"),
      headers: SUPERVISOR,
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("is refused without bereavement.risk.read (403)", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const res = await app.inject({ method: "GET", url: url(plan.planId), headers: NO_PERMS });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ── routes 35 / 36 — the pre-death risk-assessment draft (ADR-0109 D5) ──────────────────────────────────

describe("M16 §4.1 routes 35 / 36 — pre-death risk-assessment draft", () => {
  const url = (admission = ADMISSION_ID) =>
    `/api/v1/bereavement/pre-death-assessments/${admission}`;
  const put = (
    app: ReturnType<typeof buildServer>,
    headers: Record<string, string>,
    payload: unknown = { factors: EIGHT_FACTORS },
    admission = ADMISSION_ID,
  ) => app.inject({ method: "PUT", url: url(admission), headers, payload: payload as object });

  it("the care-team counselor reads an empty draft, writes it (If-Match 0), and reads it back at version 1", async () => {
    const { app, backend } = makeServer();
    const empty = await app.inject({ method: "GET", url: url(), headers: COUNSELOR });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ exists: false, version: 0, locked: false });

    const saved = await put(app, { ...COUNSELOR, "idempotency-key": "d-1", "if-match": '"0"' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ exists: true, version: 1 });
    expect(saved.json().factors.ambivalent_relationship).toBe(true);
    expect(backend.draftWrites).toEqual([
      { admissionId: ADMISSION_ID, membershipId: COUNSELOR_ID, expectedVersion: 0 },
    ]);

    const second = await put(app, { ...COUNSELOR, "idempotency-key": "d-2", "if-match": '"1"' });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(2);
    await app.close();
  });

  it("requires If-Match on the PUT (428) and an Idempotency-Key (400)", async () => {
    const { app } = makeServer();
    expect((await put(app, { ...COUNSELOR, "idempotency-key": "d-3" })).statusCode).toBe(428);
    expect((await put(app, { ...COUNSELOR, "if-match": '"0"' })).statusCode).toBe(400);
    await app.close();
  });

  it("a stale If-Match is refused 412", async () => {
    const { app } = makeServer();
    await put(app, { ...COUNSELOR, "idempotency-key": "d-4", "if-match": '"0"' });
    const stale = await put(app, { ...COUNSELOR, "idempotency-key": "d-5", "if-match": '"0"' });
    expect(stale.statusCode).toBe(412);
    await app.close();
  });

  it("is refused 409 DRAFT_LOCKED once a plan exists for the admission", async () => {
    const { app, backend } = makeServer();
    backend.lockedAdmissions.add(ADMISSION_ID);
    const locked = await put(app, { ...COUNSELOR, "idempotency-key": "d-6", "if-match": '"0"' });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error?.code ?? locked.json().code).toBe("DRAFT_LOCKED");
    // Reading a locked draft is still allowed: it is a closed record, not a hidden one.
    const read = await app.inject({ method: "GET", url: url(), headers: COUNSELOR });
    expect(read.statusCode).toBe(200);
    expect(read.json().locked).toBe(true);
    await app.close();
  });

  it.each([
    ["a missing factor", { factors: { ambivalent_relationship: true } }],
    ["a non tri-state factor", { factors: { ...EIGHT_FACTORS, social_isolation: "sometimes" } }],
    ["no factors object", {}],
  ])("rejects %s with a TypeBox 422", async (_name, payload) => {
    const { app, backend } = makeServer();
    const res = await put(
      app,
      { ...COUNSELOR, "idempotency-key": "d-7", "if-match": '"0"' },
      payload,
    );
    expect(res.statusCode).toBe(422);
    expect(backend.draftWrites).toHaveLength(0);
    await app.close();
  });

  it("rejects a non-uuid admission id with 422", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bereavement/pre-death-assessments/not-a-uuid",
      headers: COUNSELOR,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("oversight reads and writes without a care-team seat", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: url(), headers: SUPERVISOR })).statusCode).toBe(
      200,
    );
    const saved = await put(app, { ...SUPERVISOR, "idempotency-key": "d-8", "if-match": '"0"' });
    expect(saved.statusCode).toBe(200);
    await app.close();
  });

  it("an MSW who is NOT on the care team, and a volunteer, are denied (404 — the admission is not theirs to know)", async () => {
    const { app } = makeServer();
    for (const [i, who] of [OFFTEAM_MSW, VOLUNTEER].entries()) {
      expect((await app.inject({ method: "GET", url: url(), headers: who })).statusCode).toBe(404);
      expect(
        (await put(app, { ...who, "idempotency-key": `d-9-${i}`, "if-match": '"0"' })).statusCode,
      ).toBe(404);
    }
    await app.close();
  });

  it("a portal session is denied even with the staff roles", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: url(),
      headers: {
        ...COUNSELOR,
        "x-test-session-class": "bereaved_portal",
        "x-test-portal-account": "acct-1",
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an unknown admission is a 404, and a caller without the key is a 403", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: url(UNKNOWN_ADMISSION), headers: SUPERVISOR }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: url(), headers: NO_PERMS })).statusCode).toBe(
      403,
    );
    expect(
      (await put(app, { ...NO_PERMS, "idempotency-key": "d-10", "if-match": '"0"' })).statusCode,
    ).toBe(403);
    await app.close();
  });
});

// ── routes 38 / 39 / 40 — the physician condolence letter queue (ADR-0109 D6) ────────────────────────────

describe("M16 §4.1 routes 38 / 39 / 40 — physician letter review queue", () => {
  const LIST = "/api/v1/bereavement/physician-letters";
  const forPlan = (planId = LETTER_PLAN_ID) =>
    `/api/v1/bereavement/plans/${planId}/physician-letter`;
  const approve = (
    app: ReturnType<typeof buildServer>,
    letterId: string,
    headers: Record<string, string>,
    payload: unknown = {},
  ) =>
    app.inject({
      method: "POST",
      url: `${LIST}/${letterId}/approve`,
      headers,
      payload: payload as object,
    });
  const decline = (
    app: ReturnType<typeof buildServer>,
    letterId: string,
    headers: Record<string, string>,
    payload: unknown,
  ) =>
    app.inject({
      method: "POST",
      url: `${LIST}/${letterId}/decline`,
      headers,
      payload: payload as object,
    });

  it("oversight lists the queue (filtered by status) and reads the plan's letter", async () => {
    const { app, backend } = makeServer();
    const pending = backend.seedLetter();
    backend.seedLetter({ planId: "10000000-0000-4000-8000-0000000000be", status: "declined" });
    const all = await app.inject({ method: "GET", url: LIST, headers: SUPERVISOR });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toHaveLength(2);
    const only = await app.inject({
      method: "GET",
      url: `${LIST}?status=pending_review`,
      headers: SUPERVISOR,
    });
    expect(only.json().data.map((l: { letterId: string }) => l.letterId)).toEqual([
      pending.letterId,
    ]);
    const plan = await app.inject({ method: "GET", url: forPlan(), headers: SUPERVISOR });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ letterId: pending.letterId, status: "pending_review" });
    expect(plan.json()).not.toHaveProperty("note");
    await app.close();
  });

  it("answers 404 when a plan has no letter, and refuses offset pagination and a bad status", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: forPlan(), headers: SUPERVISOR })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `${LIST}?offset=5`, headers: SUPERVISOR }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${LIST}?status=bogus`, headers: SUPERVISOR }))
        .statusCode,
    ).toBe(422);
    await app.close();
  });

  it("approves with a trimmed personal note: If-Match + Idempotency-Key, version bumps, the stamp is the reviewer", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    const res = await approve(
      app,
      letter.letterId,
      { ...SUPERVISOR, "idempotency-key": "l-1", "if-match": '"0"' },
      { personalNote: "  Thank you for caring for this family.  " },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "approved",
      version: 1,
      attendingUserId: LETTER_ATTENDING,
      hasPersonalNote: true,
    });
    expect(res.json()).not.toHaveProperty("note");
    expect(backend.letters.get(letter.letterId)?.note).toBe(
      "Thank you for caring for this family.",
    );
    expect(backend.letterEvents).toEqual([
      {
        letterId: letter.letterId,
        templateKey: "bereavement_physician_condolence_letter",
        documentKind: `by:${SUPERVISOR_ID}`,
      },
    ]);
    await app.close();
  });

  it("requires If-Match (428) and Idempotency-Key (400); a stale version is 412", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    expect(
      (await approve(app, letter.letterId, { ...SUPERVISOR, "idempotency-key": "l-2" })).statusCode,
    ).toBe(428);
    expect(
      (await approve(app, letter.letterId, { ...SUPERVISOR, "if-match": '"0"' })).statusCode,
    ).toBe(400);
    expect(
      (
        await approve(app, letter.letterId, {
          ...SUPERVISOR,
          "idempotency-key": "l-3",
          "if-match": '"7"',
        })
      ).statusCode,
    ).toBe(412);
    expect(backend.letterEvents).toHaveLength(0);
    await app.close();
  });

  it("the If-Match header decides the version: an `expectedVersion` in the body cannot override a stale header", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    const res = await approve(
      app,
      letter.letterId,
      { ...SUPERVISOR, "idempotency-key": "l-hdr", "if-match": '"7"' },
      { expectedVersion: 0 } as never,
    );
    expect(res.statusCode).toBe(412);
    expect(backend.letterEvents).toHaveLength(0);
    await app.close();
  });

  it("refuses to approve with no attending (422), then approves once the reviewer names an internal clinician", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter({ attendingUserId: null });
    const headers = { ...SUPERVISOR, "if-match": '"0"' };
    const refused = await approve(app, letter.letterId, { ...headers, "idempotency-key": "l-4a" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error?.code ?? refused.json().code).toBe(
      "PHYSICIAN_LETTER_ATTENDING_REQUIRED",
    );
    const ok = await approve(
      app,
      letter.letterId,
      { ...headers, "idempotency-key": "l-4b" },
      { attendingUserId: PICKED_CLINICIAN },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().attendingUserId).toBe(PICKED_CLINICIAN);
    await app.close();
  });

  it("rejects a note over 1000 characters and a non-uuid clinician with a TypeBox 422", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    const headers = { ...SUPERVISOR, "if-match": '"0"' };
    expect(
      (
        await approve(
          app,
          letter.letterId,
          { ...headers, "idempotency-key": "l-5a" },
          { personalNote: "x".repeat(1001) },
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await approve(
          app,
          letter.letterId,
          { ...headers, "idempotency-key": "l-5b" },
          { attendingUserId: "not-a-uuid" },
        )
      ).statusCode,
    ).toBe(422);
    expect(backend.letterEvents).toHaveLength(0);
    await app.close();
  });

  it("declines with a reason of 20+ characters; a short one is 422 and a second decision is 409", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    const headers = { ...SUPERVISOR, "if-match": '"0"' };
    expect(
      (
        await decline(
          app,
          letter.letterId,
          { ...headers, "idempotency-key": "l-6a" },
          {
            reason: "too short",
          },
        )
      ).statusCode,
    ).toBe(422);
    const ok = await decline(
      app,
      letter.letterId,
      { ...headers, "idempotency-key": "l-6b" },
      {
        reason: "The attending left the practice last month.",
      },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "declined", version: 1 });
    const again = await approve(app, letter.letterId, {
      ...headers,
      "idempotency-key": "l-6c",
      "if-match": '"1"',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error?.code ?? again.json().code).toBe("PHYSICIAN_LETTER_NOT_PENDING");
    await app.close();
  });

  it("denies a counselor (permission without the oversight predicate), a volunteer and a portal session; a keyless user is 403", async () => {
    const { app, backend } = makeServer();
    const letter = backend.seedLetter();
    for (const [i, who] of [COUNSELOR, VOLUNTEER].entries()) {
      expect((await app.inject({ method: "GET", url: LIST, headers: who })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: forPlan(), headers: who })).statusCode).toBe(
        403,
      );
      expect(
        (
          await approve(app, letter.letterId, {
            ...who,
            "idempotency-key": `l-7-${i}`,
            "if-match": '"0"',
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: LIST,
          // A bereaved family member's session: a portal class, a portal account, and no staff role.
          headers: {
            ...COUNSELOR,
            "x-test-roles": "bereaved_family",
            "x-test-session-class": "bereaved_portal",
            "x-test-portal-account": "acct-1",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: LIST, headers: NO_PERMS })).statusCode).toBe(
      403,
    );
    expect(backend.letterEvents).toHaveLength(0);
    await app.close();
  });

  it("a letter that does not exist is a 404", async () => {
    const { app } = makeServer();
    const res = await approve(app, "10000000-0000-4000-8000-0000000000ff", {
      ...SUPERVISOR,
      "idempotency-key": "l-8",
      "if-match": '"0"',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── route 41 — the contact's care goals (ADR-0109) ──────────────────────────────────────────────────────

describe("M16 §4.1 route 41 — PUT /contacts/:contactId/care-plan", () => {
  const url = (contactId: string) => `/api/v1/bereavement/contacts/${contactId}/care-plan`;
  const setup = () => {
    const made = makeServer();
    const plan = made.backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const contact = made.backend.seedContact(plan.planId);
    return { ...made, plan, contact };
  };
  const put = (
    app: ReturnType<typeof buildServer>,
    contactId: string,
    headers: Record<string, string>,
    payload: unknown,
  ) => app.inject({ method: "PUT", url: url(contactId), headers, payload: payload as object });

  it("the plan's counselor records up to three goals (If-Match = the version read) and gets the contact back", async () => {
    const { app, backend, contact } = setup();
    const goals = ["Sleep through the night", "Call my sister on Sundays"];
    const read = contact.version;
    const res = await put(
      app,
      contact.contactId,
      { ...COUNSELOR, "idempotency-key": "cg-1", "if-match": `"${read}"` },
      { goals },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contactId: contact.contactId, careGoals: goals });
    expect(backend.careGoalWrites).toEqual([
      { contactId: contact.contactId, goals, expectedVersion: read },
    ]);
    await app.close();
  });

  it("an empty list clears the goals", async () => {
    const { app, backend, contact } = setup();
    const res = await put(
      app,
      contact.contactId,
      { ...COUNSELOR, "idempotency-key": "cg-2", "if-match": `"${contact.version}"` },
      { goals: [] },
    );
    expect(res.statusCode).toBe(200);
    expect(backend.careGoalWrites[0]?.goals).toEqual([]);
    await app.close();
  });

  it.each([
    ["four goals", { goals: ["a", "b", "c", "d"] }],
    ["a blank goal", { goals: ["   "] }],
    ["an empty goal", { goals: [""] }],
    ["a goal over 280 characters", { goals: ["x".repeat(281)] }],
    ["goals that are not strings", { goals: [1] }],
    ["no goals field", {}],
  ])("rejects %s with a TypeBox 422", async (_name, payload) => {
    const { app, backend, contact } = setup();
    const res = await put(
      app,
      contact.contactId,
      { ...COUNSELOR, "idempotency-key": "cg-3", "if-match": `"${contact.version}"` },
      payload,
    );
    expect(res.statusCode).toBe(422);
    expect(backend.careGoalWrites).toHaveLength(0);
    await app.close();
  });

  it("accepts exactly 280 characters and exactly three goals", async () => {
    const { app, contact } = setup();
    const res = await put(
      app,
      contact.contactId,
      { ...COUNSELOR, "idempotency-key": "cg-4", "if-match": `"${contact.version}"` },
      { goals: ["x".repeat(280), "b", "c"] },
    );
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("requires If-Match (428), an Idempotency-Key (400), and refuses a stale version (412)", async () => {
    const { app, contact } = setup();
    expect(
      (
        await put(
          app,
          contact.contactId,
          { ...COUNSELOR, "idempotency-key": "cg-5" },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(428);
    expect(
      (
        await put(
          app,
          contact.contactId,
          { ...COUNSELOR, "if-match": `"${contact.version}"` },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await put(
          app,
          contact.contactId,
          { ...COUNSELOR, "idempotency-key": "cg-6", "if-match": `"${contact.version + 7}"` },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(412);
    await app.close();
  });

  it("a counselor outside the plan window 404s; a caller without the key is 403; an unknown contact 404s", async () => {
    const { app, backend } = setup();
    const heldBySupervisor = backend.seedPlan({
      status: "active",
      assignedCounselorUserId: SUPERVISOR_ID,
    });
    const theirs = backend.seedContact(heldBySupervisor.planId);
    expect(
      (
        await put(
          app,
          theirs.contactId,
          { ...COUNSELOR, "idempotency-key": "cg-7", "if-match": `"${theirs.version}"` },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await put(
          app,
          theirs.contactId,
          { ...NO_PERMS, "idempotency-key": "cg-8", "if-match": `"${theirs.version}"` },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await put(
          app,
          "00000000-0000-4000-8000-00000000dead",
          { ...SUPERVISOR, "idempotency-key": "cg-9", "if-match": '"1"' },
          { goals: ["a"] },
        )
      ).statusCode,
    ).toBe(404);
    expect(backend.careGoalWrites).toHaveLength(0);
    await app.close();
  });
});

// ── route 33 — the D18-gated counselor first contact ───────────────────────────────────────────────────

describe("M16 §4.1 route 33 — initiate-contact", () => {
  it("the counselor's first contact opens a touchpoint against the named survivor (201)", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });
    const contact = backend.seedContact(plan.planId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/initiate-contact`,
      headers: { ...COUNSELOR, "idempotency-key": "ic-1" },
      payload: { contactId: contact.contactId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contactId).toBe(contact.contactId);

    await app.close();
  });
});

// ── routes 30, 31 — the two dashboards ─────────────────────────────────────────────────────────────────

describe("M16 §4.1 routes 30–31 — dashboards", () => {
  it("the counselor's own caseload, and the full-tenant supervisor rollup", async () => {
    const { app, backend } = makeServer();
    backend.seedPlan({ status: "active", assignedCounselorUserId: COUNSELOR_ID });

    const counselorDash = await app.inject({
      method: "GET",
      url: "/api/v1/bereavement/dashboard/counselor",
      headers: COUNSELOR,
    });
    expect(counselorDash.statusCode).toBe(200);
    expect(counselorDash.json().caseloadCount).toBeGreaterThan(0);

    const supervisorDash = await app.inject({
      method: "GET",
      url: "/api/v1/bereavement/dashboard/supervisor",
      headers: SUPERVISOR,
    });
    expect(supervisorDash.statusCode).toBe(200);

    await app.close();
  });
});

// ── routes 42-52 — the mailing program and the contact timeline (ADR-0109 D10) ───────────────────────────

describe("M16 §4.1 routes 42-51 — the mailing program (bereavement oversight only)", () => {
  const BASE = "/api/v1/bereavement/mailings";
  const RUN = `${BASE}/runs/${MAILING_RUN_ID}`;
  const UNKNOWN_RUN = `${BASE}/runs/10000000-0000-4000-8000-0000000000fe`;
  // the platform idempotency middleware keys on the header: a reused key with a different request is a 409, so every write gets its own
  let keySeq = 0;
  const nextKey = (prefix: string): string => {
    keySeq += 1;
    return `${prefix}${keySeq}`;
  };
  const write = (version = 0) => ({
    "idempotency-key": nextKey("m-"),
    "if-match": `"${version}"`,
  });
  const CONTENT = {
    en: {
      title: "Autumn note",
      greeting: "Dear {name},",
      paragraphs: ["We are thinking of you."],
      signoff: "With care",
    },
  };
  const CONFIG_BODY = {
    enabled: true,
    leadDays: 10,
    audienceRelationships: null,
    content: CONTENT,
  };

  it("oversight reads the configs, the runs, one run and its items", async () => {
    const { app } = makeServer();
    const configs = await app.inject({ method: "GET", url: `${BASE}/config`, headers: SUPERVISOR });
    expect(configs.statusCode).toBe(200);
    expect(configs.json().map((c: { mailingKey: string }) => c.mailingKey)).toEqual([
      "newsletter_quarterly",
      "holiday_december",
      "mothers_day",
      "fathers_day",
    ]);
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/runs`, headers: SUPERVISOR })).json().data,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: RUN, headers: SUPERVISOR })).json(),
    ).toMatchObject({ runId: MAILING_RUN_ID, status: "draft" });
    expect(
      (await app.inject({ method: "GET", url: `${RUN}/items`, headers: SUPERVISOR })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("a counselor holding every key is still refused: the predicate is oversight, the batch holds every address", async () => {
    const { app, backend } = makeServer();
    const calls = [
      app.inject({ method: "GET", url: `${BASE}/config`, headers: COUNSELOR }),
      app.inject({ method: "GET", url: `${BASE}/runs`, headers: COUNSELOR }),
      app.inject({ method: "GET", url: RUN, headers: COUNSELOR }),
      app.inject({ method: "GET", url: `${RUN}/download`, headers: COUNSELOR }),
      app.inject({
        method: "PUT",
        url: `${BASE}/config/newsletter_quarterly`,
        headers: { ...COUNSELOR, ...write() },
        payload: CONFIG_BODY,
      }),
      app.inject({ method: "POST", url: `${RUN}/generate`, headers: { ...COUNSELOR, ...write() } }),
      app.inject({
        method: "POST",
        url: `${RUN}/confirm-mailed`,
        headers: { ...COUNSELOR, ...write() },
      }),
      app.inject({ method: "POST", url: `${RUN}/cancel`, headers: { ...COUNSELOR, ...write() } }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(403);
    expect(backend.mailingCalls).toEqual([]);
    await app.close();
  });

  it("a volunteer and a caller with no permission are refused the whole surface", async () => {
    const { app } = makeServer();
    for (const headers of [VOLUNTEER, NO_PERMS]) {
      expect((await app.inject({ method: "GET", url: `${BASE}/runs`, headers })).statusCode).toBe(
        403,
      );
      expect(
        (await app.inject({ method: "GET", url: `${RUN}/download`, headers })).statusCode,
      ).toBe(403);
    }
    await app.close();
  });

  it("every write needs Idempotency-Key (400) and If-Match (428)", async () => {
    const { app, backend } = makeServer();
    const writes: [string, string, unknown][] = [
      ["PUT", `${BASE}/config/newsletter_quarterly`, CONFIG_BODY],
      ["PATCH", `${RUN}/content`, { content: CONTENT }],
      ["POST", `${RUN}/generate`, undefined],
      ["POST", `${RUN}/confirm-mailed`, undefined],
      ["POST", `${RUN}/cancel`, undefined],
    ];
    for (const [method, url, payload] of writes) {
      const send = (headers: Record<string, string>) =>
        app.inject({
          method: method as "PUT",
          url,
          headers: { ...SUPERVISOR, ...headers },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      expect(
        (await send({ "if-match": '"0"', "x-note": "no-key" })).statusCode,
        `${method} ${url} without a key`,
      ).toBe(400);
      expect(
        (await send({ "idempotency-key": nextKey("m-x") })).statusCode,
        `${method} ${url} without If-Match`,
      ).toBe(428);
    }
    expect(backend.mailingCalls).toEqual([]);
    await app.close();
  });

  it("the If-Match header names the version the service decides on; a stale one is 412", async () => {
    const { app, backend } = makeServer();
    const ok = await app.inject({
      method: "POST",
      url: `${RUN}/generate`,
      headers: { ...SUPERVISOR, ...write() },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "generating", version: 1 });
    const stale = await app.inject({
      method: "POST",
      url: `${RUN}/generate`,
      headers: { ...SUPERVISOR, "idempotency-key": nextKey("m-y"), "if-match": '"9"' },
    });
    expect(stale.statusCode).toBe(412);
    expect(backend.mailingCalls.map((c) => c.expectedVersion)).toEqual([0, 9]);
    await app.close();
  });

  it("config: the first write is If-Match 0; a bad lead, a bad date and the deferred birthday mailing are refused", async () => {
    const { app } = makeServer();
    const put = (key: string, payload: unknown) =>
      app.inject({
        method: "PUT",
        url: `${BASE}/config/${key}`,
        headers: { ...SUPERVISOR, ...write() },
        payload: payload as object,
      });
    const ok = await put("mothers_day", CONFIG_BODY);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ mailingKey: "mothers_day", enabled: true, version: 1 });
    expect((await put("mothers_day", { ...CONFIG_BODY, leadDays: 2 })).statusCode).toBe(422);
    expect((await put("mothers_day", { ...CONFIG_BODY, leadDays: 61 })).statusCode).toBe(422);
    expect(
      (await put("newsletter_quarterly", { ...CONFIG_BODY, schedule: { monthDays: ["13-40"] } }))
        .statusCode,
    ).toBe(422);
    expect((await put("decedent_birthday", CONFIG_BODY)).statusCode).toBe(422);
    expect(
      (
        await put("mothers_day", {
          ...CONFIG_BODY,
          content: { en: { ...CONTENT.en, paragraphs: Array(13).fill("x") } },
        })
      ).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("a run that does not exist is a 404 on every read, and offset pagination is refused", async () => {
    const { app } = makeServer();
    for (const suffix of ["", "/items"]) {
      expect(
        (await app.inject({ method: "GET", url: `${UNKNOWN_RUN}${suffix}`, headers: SUPERVISOR }))
          .statusCode,
      ).toBe(404);
    }
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/runs?offset=5`, headers: SUPERVISOR }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/runs?status=bogus`, headers: SUPERVISOR }))
        .statusCode,
    ).toBe(422);
    await app.close();
  });

  it("download hands out a URL that is never cached", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({ method: "GET", url: `${RUN}/download`, headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runId: MAILING_RUN_ID,
      url: "https://objects.example.test/batch",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(backend.mailingCalls).toEqual([{ method: "downloadRun", runId: MAILING_RUN_ID }]);
    await app.close();
  });
});

describe("M16 §4.1 route 52 — a contact's program timeline", () => {
  it("answers the contact's touchpoints and activities, refuses offset pagination, and 404s an absent contact", async () => {
    const { app, backend } = makeServer();
    const plan = backend.seedPlan();
    const contact = backend.seedContact(plan.planId);
    const url = `/api/v1/bereavement/contacts/${contact.contactId}/timeline`;
    const res = await app.inject({ method: "GET", url, headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      source: "program_activity",
      activityKind: "newsletter_mailing",
      outcome: "mailed",
    });
    expect(res.json()).toHaveProperty("redactedCategories");
    expect(
      (await app.inject({ method: "GET", url: `${url}?offset=5`, headers: SUPERVISOR })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/bereavement/contacts/10000000-0000-4000-8000-0000000000fd/timeline",
          headers: SUPERVISOR,
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url, headers: NO_PERMS })).statusCode).toBe(403);
    await app.close();
  });
});
