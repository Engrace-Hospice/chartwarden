// apps/backend/__tests__/field-safety-inject.test.ts — M20-T06 (§4.1) HTTP-layer smoke suite
// (TASK-050A / TEST-001 closure for Module 20, Field Safety).
//
// Module 20 had ZERO Fastify `.inject()` coverage before this file: `field-safety-consumers.test.ts` /
// `-contracts.test.ts` / `-eraser.test.ts` / `-lifecycle.test.ts` / `-routes.test.ts` / `-schema.test.ts` /
// `-seams.test.ts` all exercise pure functions or Drizzle fixtures directly, and `field-safety-routes.
// test.ts`'s own header says outright these are "about the DECISIONS, not the SQL" — none of them calls
// `.inject()`. That leaves the module's twenty-nine §4.1 route defs (thirty registered handlers — row 13
// is a list AND a detail route) with no proof a mis-wired guard, a permission key that does not match the
// catalog, an ABAC predicate name that does not resolve, or a TypeBox schema drifted from the body it
// guards. This file closes that gap the `orders-routes.test.ts` way: `buildServer()` mounts the host,
// `mountM20Routes()` mounts the five §4.1 route plugins (check-ins, SOS, incidents, admin/config,
// dashboard) via the module's ONE aggregator (`routes/mount.ts`), the REAL Authorization Contract gates
// every route on the real §4.6 permission keys, and the REAL `buildFieldSafetyAbacPredicates` resolves the
// six §4.7 predicates M20 owns.
//
// M20 ships no `createInMemory*Backend` for the route surface — only `createInMemorySafetyEraseStore` /
// `createInMemorySafetySeamStore`, which are for erasure/seams, not routing (grepped
// `apps/backend/src/modules/20-field-safety/index.ts` and `routes/index.ts`) — so this file hand-rolls a
// minimal in-memory `M20ReadService`/`M20WriteService` pair against the REAL, exported service contracts
// (the M16/M19 `-inject.test.ts` precedent for a module in this exact situation). It is a WIRING smoke
// test, not a re-test of the §2.2–§2.5 lifecycle machines already covered by `field-safety-lifecycle.
// test.ts`: the fake write service applies each route's implied mutation UNCONDITIONALLY (no re-derived
// state machine, no `If-Match` value comparison, no OSHA-signoff-requires-submitted-first gate) — every
// 2xx case here exists to prove the route is MOUNTED, gated on the right §4.6 permission key + §4.7 ABAC
// predicate, and returns the documented status code, not that the transition is clinically valid.
//
// ONE DELIBERATE SIMPLIFICATION IN THE FAKE'S SOS STATE: `raiseSos` seeds the alert straight into
// `acknowledging` (skipping `raised` / `cancel_window_open`), and `acknowledgeSos` leaves the state at
// `acknowledging` rather than advancing to `acknowledged`. Real M20 threads the SOS spine through many more
// states (`../lifecycle/sos-alert.ts`, `field-safety-lifecycle.test.ts`), but `active_sos_responder`
// (`../abac-predicates.ts`) ONLY admits `acknowledging | escalation_tier_* | emergency_terminus` — NOT
// `acknowledged` — so acknowledge AND resolve both bind the SAME single predicate and both need the row to
// still read as "active" the moment each route's guard runs. Keeping the fake in `acknowledging`
// throughout is what lets both routes reach 2xx without reimplementing the real machine.
//
// A test-local `SafetyAbacPorts.onCallForProviderEntity` stand-in always answers with the SUPER actor's
// own membership, standing in for the M19 `OnCallProvider` seam `active_sos_responder`'s on-call arm reads
// through `getSeam(...)` (../abac-predicates.ts) — registering the real M19 machinery would pull in a
// cross-module seam this file has no business standing up for a wiring smoke test. `step_up_recent` is
// M3's predicate, not M20's; it is stubbed to read `context.attributes.stepUpRecent === true`, mirroring
// the real M2 session fact `requireStepUp` composes on (the M19-T07 `oncall-inject.test.ts` precedent).
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  NotFoundError,
  SAFETY_SOS_TERMINAL_STATES,
  type SafetyCheckInKind,
  type SafetyCheckInStatus,
  type SafetyDashboardSnapshot,
  type SafetyPolicyEffectiveDto,
} from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type SafetyAbacPorts,
  type SafetyAbacResolver,
  buildFieldSafetyAbacPredicates,
} from "../src/modules/20-field-safety/abac-predicates";
import { M20_PERMISSION_KEY_LIST } from "../src/modules/20-field-safety/permission-keys";
import type {
  ActiveSosView,
  CursorPage,
  M20ReadService,
  M20WriteService,
  SafetyCheckInView,
  SafetyConsentSurface,
  SafetyConsentView,
  SafetyHighRiskAreaView,
  SafetyIncidentView,
  SafetyMyDayView,
  SafetySosAlertView,
  SafetySubscriptionView,
  SosLocationStreamPage,
} from "../src/modules/20-field-safety/routes/index";
import { mountM20Routes } from "../src/modules/20-field-safety/routes/mount";

// ── fixed test ids ───────────────────────────────────────────────────────────────────────────────────
const ORG = "org_a";
/** The ONE actor almost every 2xx case drives — she carries every §4.6 permission key plus BOTH an
 *  oversight role (`administrator` ⇒ `safety_supervisor_or_above`) and a field-eligible role
 *  (`registered_nurse` ⇒ `field_eligible_for_sos`), so `clinician_self` (she is the poster of every row
 *  she creates) and the supervisor/oversight predicates are BOTH satisfiable without a second identity —
 *  the same one-actor-drives-everything shape `oncall-inject.test.ts` uses. */
const SUPER_ID = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-01T12:00:00.000Z";

// ── record shapes the in-memory backend stores (supersets of the published views are fine — the routes
//    declare no Fastify response schema stripping unknown fields, and these ARE exactly the view shapes) ──
interface CheckInRecord {
  id: string;
  scheduleId: string | null;
  visitId: string | null;
  postedByMembershipId: string;
  postedAt: string;
  kind: SafetyCheckInKind;
  status: SafetyCheckInStatus;
  concernNote: string | null;
  coordinatesCaptured: boolean;
  isPartOfSosBracket: boolean;
  correctsCheckInId: string | null;
  supersededAt: string | null;
  supersededByCheckInId: string | null;
  amendableUntil: string | null;
}

interface SosAlertRecord {
  id: string;
  providerEntityId: string;
  postedByMembershipId: string;
  postedAt: string;
  lastKnownVisitId: string | null;
  lifecycleState: SafetySosAlertView["lifecycleState"];
  cancelWindowExpiredAt: string;
  cancelStatus: SafetySosAlertView["cancelStatus"];
  cancelAttemptedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByMembershipId: string | null;
  resolvedAt: string | null;
  resolvedByMembershipId: string | null;
  outcome: SafetySosAlertView["outcome"];
  resolutionNarrative: string | null;
  resolutionNarrativeAvailable: boolean;
  linkedIncidentId: string | null;
  coordinatesCaptured: boolean;
  version: number;
  stateHistory: SafetySosAlertView["stateHistory"][number][];
  acknowledgments: SafetySosAlertView["acknowledgments"][number][];
}

interface IncidentRecord {
  id: string;
  providerEntityId: string;
  affectedClinicianMembershipId: string;
  reportedByMembershipId: string;
  category: SafetyIncidentView["category"];
  severity: SafetyIncidentView["severity"];
  visitId: string | null;
  patientId: string | null;
  occurredAt: string;
  reportedAt: string;
  locationDescription: string | null;
  narrative: string | null;
  narrativeAvailable: boolean;
  witnesses: string | null;
  oshaReportable: boolean;
  oshaReportableSignedOffByMembershipId: string | null;
  oshaReportableSignedOffAt: string | null;
  workersCompClaimInitiated: boolean;
  workersCompClaimReference: string | null;
  linkedSosAlertId: string | null;
  lifecycleState: SafetyIncidentView["lifecycleState"];
  submittedAt: string | null;
  reviewedByMembershipId: string | null;
  reviewedAt: string | null;
  actionPlan: string | null;
  actionPlanAvailable: boolean;
  closedAt: string | null;
  reopenReason: string | null;
  version: number;
  stateHistory: SafetyIncidentView["stateHistory"][number][];
}

interface SubscriptionRecord {
  id: string;
  supervisorMembershipId: string;
  clinicianMembershipId: string | null;
  locationId: string | null;
  providerEntityId: string | null;
  scopeKind: SafetySubscriptionView["scopeKind"];
  alertKinds: SafetySubscriptionView["alertKinds"];
  isVacationForwarding: boolean;
  vacationForwardToMembershipId: string | null;
  createdAt: string;
}

interface HighRiskAreaRecord {
  id: string;
  riskCategory: SafetyHighRiskAreaView["riskCategory"];
  advisoryMessage: string;
  polygon: SafetyHighRiskAreaView["polygon"];
  policyForVisitsToArea: SafetyHighRiskAreaView["policyForVisitsToArea"];
  effectiveFrom: string;
  effectiveTo: string | null;
  createdByMembershipId: string | null;
}

interface ConsentRecord {
  purpose: SafetyConsentView["purpose"];
  status: SafetyConsentView["status"];
  grantedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  acknowledgmentTextSnapshot: string;
  contactOnFile: boolean;
}

function page<T>(data: readonly T[]): CursorPage<T> {
  return { data: [...data], next_cursor: null, has_more: false };
}

/** Build the in-memory `M20ReadService`/`M20WriteService`/`SafetyAbacResolver`/`SafetyAbacPorts` quartet
 *  this file exercises over HTTP. */
function createFieldSafetyTestBackend() {
  const checkIns = new Map<string, CheckInRecord>();
  const sosAlerts = new Map<string, SosAlertRecord>();
  const incidents = new Map<string, IncidentRecord>();
  const subscriptions = new Map<string, SubscriptionRecord>();
  const areas = new Map<string, HighRiskAreaRecord>();
  /** Keyed `${membershipId}:${purpose}` — §2.2.8's data subject is the clinician, one row per purpose. */
  const consents = new Map<string, ConsentRecord>();

  let policy: SafetyPolicyEffectiveDto = {
    organizationId: ORG,
    versionId: randomUUID(),
    effectiveFrom: NOW,
    effectiveTo: null,
    midVisitCadenceMinutes: 120,
    midVisitMinVisitDurationMinutes: 30,
    preVisitWindowMinutes: 15,
    postVisitWindowMinutes: 15,
    gentleReminderMinutes: 10,
    supervisorAlertMinutes: 20,
    escalationMinutes: 30,
    sosEquivalentMinutes: 45,
    sosCancelWindowSeconds: 10,
    sosCancelRequiresBiometric: false,
    sosContinuousLocationEnabled: false,
    sosContinuousLocationSampleSeconds: 30,
    sosContinuousLocationMaxDurationHours: 4,
    sosTier1SlaSeconds: 60,
    sosTier2SlaSeconds: 180,
    sosTier3SlaSeconds: 300,
    subscriptionModel: "role_scoped",
    afterHoursStartHour: 20,
    afterHoursEndHour: 6,
    oshaReportableAutoFlagCategories: [],
  };

  function requireCheckIn(id: string): CheckInRecord {
    const row = checkIns.get(id);
    if (!row) throw new NotFoundError("safety_check_in", id);
    return row;
  }
  function requireSosAlert(id: string): SosAlertRecord {
    const row = sosAlerts.get(id);
    if (!row) throw new NotFoundError("safety_sos_alert", id);
    return row;
  }
  function requireIncident(id: string): IncidentRecord {
    const row = incidents.get(id);
    if (!row) throw new NotFoundError("safety_incident", id);
    return row;
  }
  function requireSubscription(id: string): SubscriptionRecord {
    const row = subscriptions.get(id);
    if (!row) throw new NotFoundError("safety_supervisor_subscription", id);
    return row;
  }
  function requireArea(id: string): HighRiskAreaRecord {
    const row = areas.get(id);
    if (!row) throw new NotFoundError("safety_high_risk_area", id);
    return row;
  }

  const checkInView = (r: CheckInRecord): SafetyCheckInView => ({ ...r });
  const sosAlertView = (r: SosAlertRecord): SafetySosAlertView => ({ ...r });
  const incidentView = (r: IncidentRecord): SafetyIncidentView => ({ ...r });
  const subscriptionView = (r: SubscriptionRecord): SafetySubscriptionView => ({ ...r });
  const areaView = (r: HighRiskAreaRecord): SafetyHighRiskAreaView => ({ ...r });
  const consentView = (r: ConsentRecord): SafetyConsentView => ({ ...r });

  const readService: M20ReadService = {
    async getCheckIn(_actor, checkInId) {
      return checkInView(requireCheckIn(checkInId));
    },
    async getMyDay(actor, _filters): Promise<SafetyMyDayView> {
      const mine = [...checkIns.values()].filter(
        (r) => r.postedByMembershipId === actor.membershipId,
      );
      return { asOf: NOW, obligations: [], recentCheckIns: mine.map(checkInView) };
    },
    async getSosAlert(_actor, sosAlertId) {
      return sosAlertView(requireSosAlert(sosAlertId));
    },
    async getLocationStream(_actor, sosAlertId, _filters): Promise<SosLocationStreamPage> {
      requireSosAlert(sosAlertId);
      return {
        sosAlertId,
        samples: [
          { id: randomUUID(), sampledAt: NOW, latitude: 45.52, longitude: -122.68, accuracyM: 10 },
        ],
        next_cursor: null,
        has_more: false,
        auditWarningBanner:
          "Coordinate access is logged; the clinician will see this on her self-service surface.",
      };
    },
    async listActiveSos(_actor): Promise<ActiveSosView> {
      const alerts = [...sosAlerts.values()]
        .filter(
          (r) => !(SAFETY_SOS_TERMINAL_STATES as readonly string[]).includes(r.lifecycleState),
        )
        .map((r) => ({
          id: r.id,
          postedByMembershipId: r.postedByMembershipId,
          postedByFirstName: "Test",
          postedAt: r.postedAt,
          lifecycleState: r.lifecycleState,
          minutesOpen: 0,
          acknowledgedAt: r.acknowledgedAt,
        }));
      return { alerts, fetchedAt: NOW };
    },
    async getIncident(_actor, incidentId) {
      return incidentView(requireIncident(incidentId));
    },
    async listIncidents(_actor, _filters) {
      return page([...incidents.values()].map(incidentView));
    },
    async getPolicy(_actor, _asOfIso) {
      return policy;
    },
    async listSubscriptions(_actor, _filters) {
      return page([...subscriptions.values()].map(subscriptionView));
    },
    async listHighRiskAreas(_actor, _filters) {
      return page([...areas.values()].map(areaView));
    },
    async getDashboard(_actor, _filters): Promise<SafetyDashboardSnapshot> {
      const activeSosCount = [...sosAlerts.values()].filter(
        (r) => !(SAFETY_SOS_TERMINAL_STATES as readonly string[]).includes(r.lifecycleState),
      ).length;
      return { clinicians: [], activeSosCount, overdueCount: 0, fetchedAt: NOW };
    },
    async getConsentSurface(actor, purpose): Promise<SafetyConsentSurface> {
      const mine = [...consents.entries()]
        .filter(([key]) => key.startsWith(`${actor.membershipId}:`))
        .map(([, v]) => v)
        .filter((v) => purpose === undefined || v.purpose === purpose);
      return { consents: mine.map(consentView), asOf: NOW };
    },
  };

  const writeService: M20WriteService = {
    async recordCheckIn(actor, input) {
      const row: CheckInRecord = {
        id: randomUUID(),
        scheduleId: input.scheduleId ?? null,
        visitId: input.visitId ?? null,
        postedByMembershipId: actor.membershipId,
        postedAt: NOW,
        kind: input.kind,
        status: input.status,
        concernNote: input.concernNote ?? null,
        coordinatesCaptured: input.postedCoordinates !== undefined,
        isPartOfSosBracket: false,
        correctsCheckInId: null,
        supersededAt: null,
        supersededByCheckInId: null,
        amendableUntil: "2026-08-01T12:05:00.000Z",
      };
      checkIns.set(row.id, row);
      return { checkIn: checkInView(row), scheduleClosed: false, warningsSurfaced: [] };
    },
    async amendCheckIn(_actor, checkInId, input) {
      const row = requireCheckIn(checkInId);
      if (input.status !== undefined) row.status = input.status;
      if (input.concernNote !== undefined) row.concernNote = input.concernNote;
      return checkInView(row);
    },
    async raiseSos(actor, input) {
      const row: SosAlertRecord = {
        id: randomUUID(),
        providerEntityId: PE,
        postedByMembershipId: actor.membershipId,
        postedAt: NOW,
        lastKnownVisitId: input.lastKnownVisitId ?? null,
        // see the module header — seeded straight into an ACTIVE-RESPONDER state.
        lifecycleState: "acknowledging",
        cancelWindowExpiredAt: NOW,
        cancelStatus: "not_cancelled",
        cancelAttemptedAt: null,
        acknowledgedAt: null,
        acknowledgedByMembershipId: null,
        resolvedAt: null,
        resolvedByMembershipId: null,
        outcome: null,
        resolutionNarrative: null,
        resolutionNarrativeAvailable: false,
        linkedIncidentId: null,
        coordinatesCaptured: input.postedCoordinates !== undefined,
        version: 1,
        stateHistory: [],
        acknowledgments: [],
      };
      sosAlerts.set(row.id, row);
      return {
        id: row.id,
        postedAt: row.postedAt,
        cancelWindowExpiresAt: row.cancelWindowExpiredAt,
        lifecycleState: row.lifecycleState,
        acknowledgersDispatched: 0,
        warningsSurfaced: [],
      };
    },
    async cancelSos(_actor, sosAlertId, _input) {
      const row = requireSosAlert(sosAlertId);
      row.cancelStatus = "cancelled_in_window";
      row.cancelAttemptedAt = NOW;
      row.lifecycleState = "cancelled_in_window";
      return {
        id: row.id,
        cancelStatus: "cancelled_in_window",
        lifecycleState: row.lifecycleState,
      };
    },
    async acknowledgeSos(actor, sosAlertId, input) {
      const row = requireSosAlert(sosAlertId);
      row.acknowledgedAt = NOW;
      row.acknowledgedByMembershipId = actor.membershipId;
      row.acknowledgments.push({
        id: randomUUID(),
        acknowledgedByMembershipId: actor.membershipId,
        acknowledgedAt: NOW,
        actionTaken: input.actionTaken,
        outcome: input.outcome ?? null,
      });
      // deliberately NOT advancing lifecycleState — see the module header on why `resolve` needs the row
      // to still read as an active-responder state when ITS guard runs.
      return sosAlertView(row);
    },
    async resolveSos(actor, sosAlertId, input) {
      const row = requireSosAlert(sosAlertId);
      row.resolvedAt = NOW;
      row.resolvedByMembershipId = actor.membershipId;
      row.outcome = input.outcome;
      row.resolutionNarrative = input.resolutionNarrative;
      row.resolutionNarrativeAvailable = true;
      row.lifecycleState = "resolved";
      return sosAlertView(row);
    },
    async createIncident(actor, input) {
      const row: IncidentRecord = {
        id: randomUUID(),
        providerEntityId: PE,
        affectedClinicianMembershipId: input.affectedClinicianMembershipId,
        reportedByMembershipId: actor.membershipId,
        category: input.category,
        severity: input.severity,
        visitId: input.visitId ?? null,
        patientId: input.patientId ?? null,
        occurredAt: input.occurredAt,
        reportedAt: NOW,
        locationDescription: input.locationDescription ?? null,
        narrative: input.narrative,
        narrativeAvailable: true,
        witnesses: input.witnesses ?? null,
        oshaReportable: false,
        oshaReportableSignedOffByMembershipId: null,
        oshaReportableSignedOffAt: null,
        workersCompClaimInitiated: input.workersCompClaimInitiated ?? false,
        workersCompClaimReference: input.workersCompClaimReference ?? null,
        linkedSosAlertId: input.linkedSosAlertId ?? null,
        lifecycleState: "draft",
        submittedAt: null,
        reviewedByMembershipId: null,
        reviewedAt: null,
        actionPlan: null,
        actionPlanAvailable: false,
        closedAt: null,
        reopenReason: null,
        version: 1,
        stateHistory: [],
      };
      incidents.set(row.id, row);
      return incidentView(row);
    },
    async patchIncident(_actor, incidentId, input) {
      const row = requireIncident(incidentId);
      if (input.category !== undefined) row.category = input.category;
      if (input.severity !== undefined) row.severity = input.severity;
      if (input.occurredAt !== undefined) row.occurredAt = input.occurredAt;
      if (input.locationDescription !== undefined)
        row.locationDescription = input.locationDescription;
      if (input.narrative !== undefined) row.narrative = input.narrative;
      if (input.witnesses !== undefined) row.witnesses = input.witnesses;
      if (input.workersCompClaimInitiated !== undefined) {
        row.workersCompClaimInitiated = input.workersCompClaimInitiated;
      }
      if (input.workersCompClaimReference !== undefined) {
        row.workersCompClaimReference = input.workersCompClaimReference;
      }
      row.version += 1;
      return incidentView(row);
    },
    async submitIncident(_actor, incidentId, input) {
      const row = requireIncident(incidentId);
      row.lifecycleState = "submitted";
      row.submittedAt = NOW;
      row.oshaReportable = input.oshaReportable;
      if (input.finalNarrative !== undefined) row.narrative = input.finalNarrative;
      row.version += 1;
      return incidentView(row);
    },
    async transitionIncident(actor, incidentId, input) {
      const row = requireIncident(incidentId);
      row.stateHistory.push({
        fromState: row.lifecycleState,
        toState: input.toState,
        transitionedAt: NOW,
        transitionedByMembershipId: actor.membershipId,
        reason: input.reason,
      });
      row.lifecycleState = input.toState;
      if (input.actionPlan !== undefined) {
        row.actionPlan = input.actionPlan;
        row.actionPlanAvailable = true;
      }
      if (input.toState === "closed_with_action_plan" || input.toState === "closed_no_action") {
        row.closedAt = NOW;
      }
      row.version += 1;
      return incidentView(row);
    },
    async oshaSignoff(actor, incidentId, input) {
      const row = requireIncident(incidentId);
      row.oshaReportable = input.oshaReportable;
      row.oshaReportableSignedOffByMembershipId = actor.membershipId;
      row.oshaReportableSignedOffAt = NOW;
      row.version += 1;
      return incidentView(row);
    },
    async patchPolicy(_actor, input) {
      policy = {
        ...policy,
        midVisitCadenceMinutes: input.midVisitCadenceMinutes ?? policy.midVisitCadenceMinutes,
        midVisitMinVisitDurationMinutes:
          input.midVisitMinVisitDurationMinutes ?? policy.midVisitMinVisitDurationMinutes,
        preVisitWindowMinutes: input.preVisitWindowMinutes ?? policy.preVisitWindowMinutes,
        postVisitWindowMinutes: input.postVisitWindowMinutes ?? policy.postVisitWindowMinutes,
        gentleReminderMinutes: input.gentleReminderMinutes ?? policy.gentleReminderMinutes,
        supervisorAlertMinutes: input.supervisorAlertMinutes ?? policy.supervisorAlertMinutes,
        escalationMinutes: input.escalationMinutes ?? policy.escalationMinutes,
        sosEquivalentMinutes: input.sosEquivalentMinutes ?? policy.sosEquivalentMinutes,
        sosCancelWindowSeconds: input.sosCancelWindowSeconds ?? policy.sosCancelWindowSeconds,
        sosCancelRequiresBiometric:
          input.sosCancelRequiresBiometric ?? policy.sosCancelRequiresBiometric,
        sosContinuousLocationEnabled:
          input.sosContinuousLocationEnabled ?? policy.sosContinuousLocationEnabled,
        subscriptionModel: input.subscriptionModel ?? policy.subscriptionModel,
      };
      return policy;
    },
    async createSubscription(_actor, input) {
      const row: SubscriptionRecord = {
        id: randomUUID(),
        supervisorMembershipId: input.supervisorMembershipId,
        clinicianMembershipId: input.clinicianMembershipId ?? null,
        locationId: input.locationId ?? null,
        providerEntityId: input.providerEntityId ?? null,
        scopeKind: input.scopeKind,
        alertKinds: [...input.alertKinds],
        isVacationForwarding: input.isVacationForwarding ?? false,
        vacationForwardToMembershipId: input.vacationForwardToMembershipId ?? null,
        createdAt: NOW,
      };
      subscriptions.set(row.id, row);
      return subscriptionView(row);
    },
    async deleteSubscription(_actor, subscriptionId) {
      const row = requireSubscription(subscriptionId);
      subscriptions.delete(row.id);
      return { id: row.id, deactivatedAt: NOW, coverageGapsCreated: [] };
    },
    async createHighRiskArea(actor, input) {
      const row: HighRiskAreaRecord = {
        id: randomUUID(),
        riskCategory: input.riskCategory,
        advisoryMessage: input.advisoryMessage,
        polygon: input.polygon,
        policyForVisitsToArea: input.policyForVisitsToArea ?? "advisory_only",
        effectiveFrom: input.effectiveFrom ?? NOW,
        effectiveTo: input.effectiveTo ?? null,
        createdByMembershipId: actor.membershipId,
      };
      areas.set(row.id, row);
      return areaView(row);
    },
    async patchHighRiskArea(_actor, areaId, input) {
      const row = requireArea(areaId);
      if (input.riskCategory !== undefined) row.riskCategory = input.riskCategory;
      if (input.advisoryMessage !== undefined) row.advisoryMessage = input.advisoryMessage;
      if (input.polygon !== undefined) row.polygon = input.polygon;
      if (input.policyForVisitsToArea !== undefined)
        row.policyForVisitsToArea = input.policyForVisitsToArea;
      if (input.effectiveTo !== undefined) row.effectiveTo = input.effectiveTo;
      return areaView(row);
    },
    async grantConsent(actor, input) {
      const row: ConsentRecord = {
        purpose: input.purpose,
        status: "granted",
        grantedAt: NOW,
        revokedAt: null,
        expiresAt: input.expiresAt ?? null,
        acknowledgmentTextSnapshot: input.acknowledgmentTextSnapshot,
        contactOnFile: input.contact !== undefined,
      };
      consents.set(`${actor.membershipId}:${input.purpose}`, row);
      return consentView(row);
    },
    async revokeConsent(actor, input) {
      const key = `${actor.membershipId}:${input.purpose}`;
      const row = consents.get(key);
      if (!row) throw new NotFoundError("safety_emergency_contact_consent", key);
      row.status = "revoked";
      row.revokedAt = NOW;
      return consentView(row);
    },
  };

  const resolver: SafetyAbacResolver = {
    async loadSosAlert(orgId, sosAlertId) {
      if (orgId !== ORG) return null;
      const row = sosAlerts.get(sosAlertId);
      if (!row) return null;
      return {
        organizationId: ORG,
        sosAlertId: row.id,
        providerEntityId: row.providerEntityId,
        postedByMembershipId: row.postedByMembershipId,
        lifecycleState: row.lifecycleState,
      };
    },
    async loadCheckIn(orgId, checkInId) {
      if (orgId !== ORG) return null;
      const row = checkIns.get(checkInId);
      if (!row) return null;
      return {
        organizationId: ORG,
        checkInId: row.id,
        providerEntityId: PE,
        clinicianMembershipId: row.postedByMembershipId,
        postedAt: row.postedAt,
      };
    },
    async loadIncident(orgId, incidentId) {
      if (orgId !== ORG) return null;
      const row = incidents.get(incidentId);
      if (!row) return null;
      return {
        organizationId: ORG,
        incidentId: row.id,
        providerEntityId: row.providerEntityId,
        affectedClinicianMembershipId: row.affectedClinicianMembershipId,
        reportedByMembershipId: row.reportedByMembershipId,
        lifecycleState: row.lifecycleState,
      };
    },
    async subscriptionsForSupervisor(orgId, supervisorMembershipId) {
      if (orgId !== ORG) return null;
      return [...subscriptions.values()]
        .filter((s) => s.supervisorMembershipId === supervisorMembershipId)
        .map((s) => ({
          supervisorMembershipId: s.supervisorMembershipId,
          clinicianMembershipId: s.clinicianMembershipId,
          locationId: s.locationId,
          providerEntityId: s.providerEntityId,
          scopeKind: s.scopeKind,
          isVacationForwarding: s.isVacationForwarding,
          vacationForwardToMembershipId: s.vacationForwardToMembershipId,
        }));
    },
    async clinicianScope(orgId, membershipId) {
      if (orgId !== ORG) return null;
      return { membershipId, locationIds: [], providerEntityId: PE };
    },
    async roleKeysOf() {
      // never reached in this file — the header-auth shim always populates `context.roles` directly, and
      // `roleKeysFor` (../abac-predicates.ts) prefers the context over a resolver round-trip.
      return null;
    },
  };

  /** Always answers with the SUPER actor's own membership — see the module header. */
  const ports: SafetyAbacPorts = {
    async onCallForProviderEntity() {
      return [SUPER_ID];
    },
  };

  return { readService, writeService, resolver, ports };
}

// ── the M15/M16/M19/M21/M24/M26 header-auth test shim ───────────────────────────────────────────────
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
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
}

function makeServer() {
  const backend = createFieldSafetyTestBackend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M20_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "nobody_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server, seeded with M3's intrinsics (`inOrg` among them) plus M20's real
  // six §4.7 predicates, plus the ONE test-local stand-in for `step_up_recent` (M3's, not M20's).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildFieldSafetyAbacPredicates({ resolver: backend.resolver, ports: backend.ports }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM20Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator,registered_nurse",
  "x-test-membership": SUPER_ID,
  "x-test-step-up": "1",
};
const NOBODY = { "x-test-user": "nobody_1", "x-test-org": ORG };
/** A FRESH Idempotency-Key per mutating call (ADR-0021's per-key replay store keys on `(orgId, key)`). */
const idemp = () => ({ "idempotency-key": randomUUID() });
const IFM = { "if-match": "1" };

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

// ── auth/shape smoke: 401 / 403 / 422 ────────────────────────────────────────────────────────────────

describe("M20-T06 auth + schema boundary", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/safety/check-ins/me/today" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/safety/check-ins/me/today",
      headers: NOBODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor posting an empty check-in body → 422 (TypeBox VALIDATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/safety/check-ins",
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── rows 1-4 — check-ins ─────────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.1 check-ins (rows 1-4)", () => {
  it("records, reads, amends, then reads the clinician's own day", async () => {
    const { app } = makeServer();

    // 1
    const recorded = await app.inject({
      method: "POST",
      url: "/api/v1/safety/check-ins",
      headers: { ...SUPER, ...idemp() },
      payload: { kind: "ad_hoc", status: "ok" },
    });
    expect(recorded.statusCode).toBe(201);
    const checkInId = recorded.json().checkIn.id as string;

    // 2
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/safety/check-ins/${checkInId}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(checkInId);

    // 3
    const amended = await app.inject({
      method: "PATCH",
      url: `/api/v1/safety/check-ins/${checkInId}`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        amendmentReason: "correcting the status after a follow-up call with the clinician",
      },
    });
    expect(amended.statusCode).toBe(200);

    // 4
    const myDay = await app.inject({
      method: "GET",
      url: "/api/v1/safety/check-ins/me/today",
      headers: SUPER,
    });
    expect(myDay.statusCode).toBe(200);
    expect(Array.isArray(myDay.json().recentCheckIns)).toBe(true);

    await app.close();
  });
});

// ── rows 5-11 — the SOS spine ────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.1 SOS (rows 5-11)", () => {
  it("raises, reads, lists active; cancels a second alert; acknowledges+resolves a third then reads coords", async () => {
    const { app } = makeServer();

    // 5 — NO idempotency key on the press (§4.1's own Idempotent column is `no` for this row)
    const raised1 = await app.inject({
      method: "POST",
      url: "/api/v1/safety/sos",
      headers: SUPER,
      payload: {},
    });
    expect(raised1.statusCode).toBe(201);
    const alert1 = raised1.json().id as string;

    // 9
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/safety/sos/${alert1}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(alert1);

    // 11
    const active = await app.inject({
      method: "GET",
      url: "/api/v1/safety/sos/active",
      headers: SUPER,
    });
    expect(active.statusCode).toBe(200);
    expect(Array.isArray(active.json().alerts)).toBe(true);

    // 6 — a fresh alert, so the cancel does not disturb the acknowledge/resolve flow below
    const raised2 = await app.inject({
      method: "POST",
      url: "/api/v1/safety/sos",
      headers: SUPER,
      payload: {},
    });
    const alert2 = raised2.json().id as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/safety/sos/${alert2}/cancel`,
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);

    // 7 + 8 — a third alert, acknowledged then resolved
    const raised3 = await app.inject({
      method: "POST",
      url: "/api/v1/safety/sos",
      headers: SUPER,
      payload: {},
    });
    const alert3 = raised3.json().id as string;
    const acked = await app.inject({
      method: "POST",
      url: `/api/v1/safety/sos/${alert3}/acknowledge`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {
        actionTaken:
          "Called the clinician back and confirmed she is safe and continuing her visit.",
      },
    });
    expect(acked.statusCode).toBe(200);

    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/safety/sos/${alert3}/resolve`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { resolutionNarrative: "x".repeat(110), outcome: "clinician_safe_continued" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().lifecycleState).toBe("resolved");

    // 10 — the D6 coordinate stream, read AFTER the alert closed (the `safety_supervisor_or_above` arm)
    const coords = await app.inject({
      method: "GET",
      url: `/api/v1/safety/sos/${alert3}/location-stream`,
      headers: SUPER,
    });
    expect(coords.statusCode).toBe(200);
    expect(Array.isArray(coords.json().samples)).toBe(true);

    await app.close();
  });
});

// ── rows 12-17 — incidents + the D9 OSHA sign-off ───────────────────────────────────────────────────

describe("M20-T06 §4.1 incidents (rows 12-17)", () => {
  it("creates, lists, reads, patches, submits and transitions one incident; signs off OSHA on a second", async () => {
    const { app } = makeServer();

    // 12
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/safety/incidents",
      headers: { ...SUPER, ...idemp() },
      payload: {
        affectedClinicianMembershipId: SUPER_ID,
        category: "dog_bite",
        severity: "moderate",
        occurredAt: NOW,
        narrative: "x".repeat(210),
      },
    });
    expect(created.statusCode).toBe(201);
    const incidentId = created.json().id as string;

    // 13 (list)
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/safety/incidents",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);

    // 13 (detail)
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/safety/incidents/${incidentId}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);

    // 14
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/safety/incidents/${incidentId}`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { locationDescription: "Front porch, unfenced yard" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().locationDescription).toBe("Front porch, unfenced yard");

    // 15
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/safety/incidents/${incidentId}/submit`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { oshaReportable: false },
    });
    expect(submitted.statusCode).toBe(200);

    // 16
    const transitioned = await app.inject({
      method: "POST",
      url: `/api/v1/safety/incidents/${incidentId}/state`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {
        toState: "under_review",
        reason: "Reviewing the clinician's account and the dog owner's statement.",
      },
    });
    expect(transitioned.statusCode).toBe(200);
    expect(transitioned.json().lifecycleState).toBe("under_review");

    // 17 — a SECOND incident for the OSHA sign-off (step-up)
    const created2 = await app.inject({
      method: "POST",
      url: "/api/v1/safety/incidents",
      headers: { ...SUPER, ...idemp() },
      payload: {
        affectedClinicianMembershipId: SUPER_ID,
        category: "vehicle_accident_on_duty",
        severity: "serious",
        occurredAt: NOW,
        narrative: "y".repeat(210),
      },
    });
    const incidentId2 = created2.json().id as string;
    const signedOff = await app.inject({
      method: "POST",
      url: `/api/v1/safety/incidents/${incidentId2}/osha-signoff`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {
        oshaReportable: true,
        reason: "State regulation requires reporting any vehicle accident occurring on duty.",
        stateCode: "OR",
        reportingWindowHours: 24,
      },
    });
    expect(signedOff.statusCode).toBe(200);
    expect(signedOff.json().oshaReportable).toBe(true);

    await app.close();
  });
});

// ── rows 18-25 — the policy + supervisor-subscription + high-risk-area config surfaces ─────────────────

describe("M20-T06 §4.1 admin: policy, subscriptions, high-risk areas (rows 18-25)", () => {
  it("reads/patches the policy; creates/lists/deletes a subscription; creates/lists/patches a high-risk area", async () => {
    const { app } = makeServer();

    // 18
    const policy = await app.inject({
      method: "GET",
      url: "/api/v1/safety/policy",
      headers: SUPER,
    });
    expect(policy.statusCode).toBe(200);

    // 19 — step-up
    const patchedPolicy = await app.inject({
      method: "PATCH",
      url: "/api/v1/safety/policy",
      headers: { ...SUPER, ...idemp() },
      payload: {
        editReason: "Tightening the mid-visit cadence after last month's coverage review.",
      },
    });
    expect(patchedPolicy.statusCode).toBe(200);

    // 21
    const createdSub = await app.inject({
      method: "POST",
      url: "/api/v1/safety/supervisor-subscriptions",
      headers: { ...SUPER, ...idemp() },
      payload: {
        supervisorMembershipId: SUPER_ID,
        scopeKind: "role",
        alertKinds: ["sos", "overdue"],
      },
    });
    expect(createdSub.statusCode).toBe(201);
    const subscriptionId = createdSub.json().id as string;

    // 20
    const listSubs = await app.inject({
      method: "GET",
      url: "/api/v1/safety/supervisor-subscriptions",
      headers: SUPER,
    });
    expect(listSubs.statusCode).toBe(200);

    // 22
    const deletedSub = await app.inject({
      method: "DELETE",
      url: `/api/v1/safety/supervisor-subscriptions/${subscriptionId}`,
      headers: { ...SUPER, ...idemp() },
    });
    expect(deletedSub.statusCode).toBe(200);
    expect(Array.isArray(deletedSub.json().coverageGapsCreated)).toBe(true);

    // 24
    const createdArea = await app.inject({
      method: "POST",
      url: "/api/v1/safety/high-risk-areas",
      headers: { ...SUPER, ...idemp() },
      payload: {
        riskCategory: "general_caution",
        advisoryMessage: "Unlit rural road; use extra caution after dusk.",
        polygon: [
          [
            [-122.6, 45.5],
            [-122.6, 45.6],
            [-122.5, 45.6],
            [-122.5, 45.5],
          ],
        ],
      },
    });
    expect(createdArea.statusCode).toBe(201);
    const areaId = createdArea.json().id as string;

    // 23
    const listAreas = await app.inject({
      method: "GET",
      url: "/api/v1/safety/high-risk-areas",
      headers: SUPER,
    });
    expect(listAreas.statusCode).toBe(200);

    // 25
    const patchedArea = await app.inject({
      method: "PATCH",
      url: `/api/v1/safety/high-risk-areas/${areaId}`,
      headers: { ...SUPER, ...idemp() },
      payload: { advisoryMessage: "Unlit rural road; buddy visits required after dusk." },
    });
    expect(patchedArea.statusCode).toBe(200);
    expect(patchedArea.json().advisoryMessage).toBe(
      "Unlit rural road; buddy visits required after dusk.",
    );

    await app.close();
  });
});

// ── rows 26-29 — the supervisor dashboard + the clinician's own consent surface ─────────────────────────

describe("M20-T06 §4.1 dashboard + consent (rows 26-29)", () => {
  it("reads the dashboard; grants a consent; reads the surface; then revokes it", async () => {
    const { app } = makeServer();

    // 26
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/v1/safety/dashboard",
      headers: SUPER,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(typeof dashboard.json().activeSosCount).toBe("number");

    // 28
    const granted = await app.inject({
      method: "POST",
      url: "/api/v1/safety/consent/grant",
      headers: { ...SUPER, ...idemp() },
      payload: {
        purpose: "sos_coordinates",
        acknowledgmentTextSnapshot: "I consent to sharing my coordinates during an SOS.",
      },
    });
    expect(granted.statusCode).toBe(201);

    // 27
    const surface = await app.inject({
      method: "GET",
      url: "/api/v1/safety/consent",
      headers: SUPER,
    });
    expect(surface.statusCode).toBe(200);
    expect(surface.json().consents.length).toBeGreaterThan(0);

    // 29
    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/safety/consent/revoke",
      headers: { ...SUPER, ...idemp() },
      payload: { purpose: "sos_coordinates" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("revoked");

    await app.close();
  });
});
