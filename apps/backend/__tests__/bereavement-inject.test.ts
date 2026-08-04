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
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type BereavedContactAbacFacts,
  type BereavementAbacResolver,
  type BereavementPlanAbacFacts,
  M16_PERMISSION_KEY_LIST,
  buildBereavementAbacPredicates,
  mountM16Routes,
} from "../src/modules/16-bereavement/index";
import type {
  BereavedContactRowView,
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
      deceasedAt: c.deceasedAt,
      mayRescindOptOut: true,
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
      p.status = "closed_early";
      p.closedAt = NOW;
      bump(p);
      const closure: BereavementClosureView = {
        closureId: fakeId(),
        planId,
        reason: input.reason as never,
        closeKind: "early_pending_cosign",
        closedAt: NOW,
        closedByUserId: actor.membershipId,
        cosignedByUserId: null,
        cosignedAt: null,
        stats: zeroStats(),
        bereavementSummaryDocumentId: null,
      };
      p.closure = closure;
      return closure;
    },
    async cosignClose(actor, planId) {
      const p = plans.get(planId);
      if (!p || !p.closure) throw new NotFoundError("bereavement plan closure not found");
      p.closure = {
        ...p.closure,
        cosignedByUserId: actor.membershipId,
        cosignedAt: NOW,
        closeKind: "early_cosigned",
      };
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
    async recomputeRisk(actor, planId, input) {
      const p = plans.get(planId);
      if (!p) throw new NotFoundError("bereavement plan not found");
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

  return { readService, writeService, resolver, seedPlan, seedContact, seedOutreach };
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
  });
  for (const [name, predicate] of Object.entries(predicates)) reg.register(name, predicate);
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM16Routes(app, { readService: backend.readService, writeService: backend.writeService });
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
    expect(close.statusCode).toBe(201);
    const closureId = close.json().closureId as string;

    const cosign = await app.inject({
      method: "POST",
      url: `/api/v1/bereavement/plans/${plan.planId}/cosign-close`,
      headers: { ...SUPERVISOR, "idempotency-key": "cc-1" },
      payload: { attestation: "confirmed by clinical supervisor" },
    });
    expect(cosign.statusCode).toBe(200);
    expect(cosign.json().cosignedByUserId).toBe(SUPERVISOR_ID);

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
