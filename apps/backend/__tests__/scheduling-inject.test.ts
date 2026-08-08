import { randomUUID } from "node:crypto";
// apps/backend/__tests__/scheduling-inject.test.ts — M17-T07 HTTP-layer smoke coverage (TASK-050A / TEST-001).
//
// M17 (Scheduling) had ZERO Fastify `.inject()` coverage before this file: `scheduling-consumers.test.ts` /
// `scheduling-seams.test.ts` / `scheduling-workflow-acceptance.test.ts` exercise pure domain logic, and the
// `m17-scheduling-*.live.test.ts` pair hits real Postgres — none of them drive a request through the actual
// route table + the REAL Authorization Contract (RBAC + the four §4.7 pre-schedule ABAC predicates) the way a
// production request would. This file clones the M11 `orders-routes.test.ts` pattern: `buildServer()` mounts
// the host, `registerSchedulingRoutes()` mounts the §4.1 route inventory over the in-memory
// `SchedulingRouteService` (which ALSO implements `SchedulingAbacResolver`, so the same seeded facts back both
// RBAC and ABAC), and a header-auth shim populates `request.context` from `x-test-user`/`x-test-org`/
// `x-test-roles`.
//
// Every one of the 29 routes `registerSchedulingRoutes` mounts gets a genuine 2xx case (a correctly-
// permissioned, correctly-payloaded `inject()` call), plus one 401 (no auth headers), one 403 (a user with NO
// permissions), and one 422 (TypeBox validation failure on a write route with no ABAC gate in front of it, so
// the failure is unambiguously a validation failure and not an ABAC deny).
//
// One documented deviation: the in-memory `publishProposal` assigns the CREATED visit's `assignedMembershipId`
// to `proposal.id` itself (`routes/service.ts` — "placeholder; the prod proposal carries the proposed
// membership"). To reach a genuine 201 on `POST /visit-proposals/:id/publish` without touching module source,
// the seeded "publishable" proposal's id is ALSO registered as a credentialed `rn` membership in the pool-open
// org, so the D8 gate the service recomputes at publish time passes on the same coincidence the placeholder
// creates. See `PUBLISHABLE_PROPOSAL_ID` below.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  SchedulingRouteService,
  type SchedulingSeed,
  buildSchedulingAbacPredicates,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // actorOf() in scheduling-routes.ts reads the acting MEMBERSHIP id from here (not ctx.userId) —
  // any non-empty string satisfies it; the routes only use it for write-attribution, never a
  // credentialed-membership lookup.
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const RN_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const RN_MEMBERSHIP_2 = "44444444-4444-4444-8444-444444444444";
/** Dual-purpose id: a proposal AND a seeded membership (see the file banner's `publishProposal` note). */
const PUBLISHABLE_PROPOSAL_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-01T00:00:00.000Z";

const ALL_PERMS = [
  "visit.read",
  "visit.read_metrics",
  "visit.create",
  "visit.edit",
  "visit.start",
  "visit.cancel",
  "visit.reschedule",
  "visit.reassign",
  "visit.mark_no_show",
  "visit.proposal.read",
  "visit.proposal.dismiss",
  "recurring_visit.read",
  "recurring_visit.create",
  "recurring_visit.discontinue",
  "availability.read",
  "availability.edit_own",
  "time_off.read_own",
  "time_off.request_own",
  "time_off.approve",
  "time_off.cancel_own",
  "route.optimize_on_demand",
  "route.read_metrics",
  "portal.visit.read_upcoming",
];
const PERMISSION_SEED = [
  { userId: "sched_1", permissions: ALL_PERMS },
  { userId: "viewer_1", permissions: ["visit.read"] },
  { userId: "none_1", permissions: [] as string[] },
];

function makeServer() {
  const seed: SchedulingSeed = {
    disciplines: {
      [RN_MEMBERSHIP]: "rn",
      [RN_MEMBERSHIP_2]: "rn",
      [PUBLISHABLE_PROPOSAL_ID]: "rn",
    },
    credentialedMemberships: [RN_MEMBERSHIP, RN_MEMBERSHIP_2, PUBLISHABLE_PROPOSAL_ID],
    unassignedPoolOrgs: [ORG],
  };
  const backend = new SchedulingRouteService({ now: () => NOW, newId: () => randomUUID(), seed });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // A fresh predicate registry per server — same rationale as M11's orders-routes.test.ts: the shared registry
  // is single-owner/no-clear, so a fresh one per test isolates each test's seeded facts.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildSchedulingAbacPredicates({ resolver: backend }),
  )) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSchedulingRoutes(app, { service: backend });
  return { app, backend };
}

const SCHED = { "x-test-user": "sched_1", "x-test-org": ORG, "x-test-roles": "scheduler" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const NONE = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "none" };

const visitBody = (over: Record<string, unknown> = {}) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  patientAddressId: null,
  externalFacilityId: null,
  assignedMembershipId: RN_MEMBERSHIP,
  visitPurpose: "routine_visit",
  visitSetting: "patient_home",
  scheduledStartedAt: "2026-07-02T09:00:00.000Z",
  scheduledEndedAt: "2026-07-02T10:00:00.000Z",
  ...over,
});

/** The private `proposals` map has no route-level insert path (only the DB-backed prod service's recurring/
 * frequency workers populate it) — this reaches into the in-memory backend's private state to seed a REAL
 * backing row for the publish/dismiss routes under test, the only way to exercise them without a fabricated,
 * backend-absent id. */
interface ProposalSeedRow {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly proposedVisitPurpose: string;
  readonly proposedForDate: string;
  readonly status: "pending" | "published" | "dismissed" | "stale";
}
function seedProposal(backend: SchedulingRouteService, row: ProposalSeedRow): void {
  (backend as unknown as { proposals: Map<string, ProposalSeedRow> }).proposals.set(row.id, row);
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

describe("M17-T07 — §4.6 RBAC gating", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/visits" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("a user holding NO permissions → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/visits", headers: NONE });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("M17-T07 — §4.2 TypeBox validation", () => {
  it("an empty body on a permissioned, non-ABAC-gated write route → 422", async () => {
    const { app } = makeServer();
    // recurring-visit create carries no owned ABAC predicate (unlike POST /visits), so an empty payload
    // reaches `parse()` and fails on TypeBox schema validation, not an ABAC deny.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/recurring-visits",
      headers: SCHED,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe("M17-T07 — routes 1-4: list / get / create / edit a visit", () => {
  it("creates a visit (§4.7 D8 gate passes), lists it, fetches it, and edits it (non-reassigning)", async () => {
    const { app, backend } = makeServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("published");
    const id = created.json().id as string;
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m17.visit.published");

    const list = await app.inject({ method: "GET", url: "/api/v1/visits", headers: SCHED });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).map((v) => v.id)).toContain(id);

    const got = await app.inject({ method: "GET", url: `/api/v1/visits/${id}`, headers: SCHED });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(id);

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/visits/${id}`,
      headers: SCHED,
      payload: { visitSetting: "facility" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().visitSetting).toBe("facility");
    await app.close();
  });
});

describe("M17-T07 — route 5: self-attest EVV start", () => {
  it("starts a published visit via the EVV path (no self-attest reason) → 200", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-02T11:00:00.000Z",
        scheduledEndedAt: "2026-07-02T12:00:00.000Z",
      }),
    });
    const id = created.json().id as string;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${id}/start`,
      headers: SCHED,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe("en_route");
    await app.close();
  });
});

describe("M17-T07 — route 6: cancel", () => {
  it("cancels a published visit (reason ≥ 20 chars) → 200", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-02T13:00:00.000Z",
        scheduledEndedAt: "2026-07-02T14:00:00.000Z",
      }),
    });
    const id = created.json().id as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${id}/cancel`,
      headers: SCHED,
      payload: {
        reason: "Patient declined the visit due to a change in condition.",
        reasonCode: "clinical_status_change",
      },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    await app.close();
  });
});

describe("M17-T07 — route 7: reschedule", () => {
  it("reschedules a published visit (original → rescheduled, new visit created) → 201", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-02T15:00:00.000Z",
        scheduledEndedAt: "2026-07-02T16:00:00.000Z",
      }),
    });
    const id = created.json().id as string;
    const rescheduled = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${id}/reschedule`,
      headers: SCHED,
      payload: {
        newScheduledStartedAt: "2026-07-03T15:00:00.000Z",
        newScheduledEndedAt: "2026-07-03T16:00:00.000Z",
        reason: "Clinician requested a different day for this visit.",
      },
    });
    expect(rescheduled.statusCode).toBe(201);
    expect(rescheduled.json().original.status).toBe("rescheduled");
    expect(rescheduled.json().created.status).toBe("published");
    await app.close();
  });
});

describe("M17-T07 — route 8: no-show", () => {
  it("marks a published visit no-show → 200", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-02T17:00:00.000Z",
        scheduledEndedAt: "2026-07-02T18:00:00.000Z",
      }),
    });
    const id = created.json().id as string;
    const noShow = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${id}/no-show`,
      headers: SCHED,
      payload: { reason: "Clinician arrived; no answer at the door after two attempts." },
    });
    expect(noShow.statusCode).toBe(200);
    expect(noShow.json().status).toBe("no_show");
    await app.close();
  });
});

describe("M17-T07 — route 9: reassign", () => {
  it("reassigns a published visit to a different credentialed clinician (reruns the D8 gate) → 200", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-02T19:00:00.000Z",
        scheduledEndedAt: "2026-07-02T20:00:00.000Z",
      }),
    });
    const id = created.json().id as string;
    const reassigned = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${id}/reassign`,
      headers: SCHED,
      payload: { newAssignedMembershipId: RN_MEMBERSHIP_2 },
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json().assignedMembershipId).toBe(RN_MEMBERSHIP_2);
    await app.close();
  });
});

describe("M17-T07 — routes 10-11: proposal inbox + publish", () => {
  it("lists a pending proposal and publishes it into a visit → 201", async () => {
    const { app, backend } = makeServer();
    seedProposal(backend, {
      id: PUBLISHABLE_PROPOSAL_ID,
      organizationId: ORG,
      patientId: PATIENT,
      admissionId: ADMISSION,
      proposedVisitPurpose: "routine_visit",
      proposedForDate: "2026-07-10",
      status: "pending",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/visit-proposals",
      headers: SCHED,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).map((p) => p.id)).toContain(
      PUBLISHABLE_PROPOSAL_ID,
    );

    const published = await app.inject({
      method: "POST",
      url: `/api/v1/visit-proposals/${PUBLISHABLE_PROPOSAL_ID}/publish`,
      headers: SCHED,
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().status).toBe("published");
    await app.close();
  });
});

describe("M17-T07 — route 12: dismiss proposal", () => {
  it("dismisses a pending proposal (reason) → 200", async () => {
    const { app, backend } = makeServer();
    const proposalId = randomUUID();
    seedProposal(backend, {
      id: proposalId,
      organizationId: ORG,
      patientId: PATIENT,
      admissionId: ADMISSION,
      proposedVisitPurpose: "routine_visit",
      proposedForDate: "2026-07-11",
      status: "pending",
    });
    const dismissed = await app.inject({
      method: "POST",
      url: `/api/v1/visit-proposals/${proposalId}/dismiss`,
      headers: SCHED,
      payload: { reason: "No longer needed per updated care plan." },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().status).toBe("dismissed");
    await app.close();
  });
});

describe("M17-T07 — routes 13-15: recurring visit policy", () => {
  it("creates a recurring policy, lists it, then discontinues it", async () => {
    const { app } = makeServer();
    const recurringBody = {
      patientId: PATIENT,
      admissionId: ADMISSION,
      assignedMembershipId: RN_MEMBERSHIP,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      rrule: "FREQ=WEEKLY;COUNT=4;BYDAY=MO",
      timeOfDayStart: "09:00",
      timeOfDayEnd: "10:00",
      timeZone: "America/New_York",
      startDate: "2026-07-06",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/recurring-visits",
      headers: SCHED,
      payload: recurringBody,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/recurring-visits?patient=${PATIENT}`,
      headers: SCHED,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).map((r) => r.id)).toContain(id);

    const discontinued = await app.inject({
      method: "POST",
      url: `/api/v1/recurring-visits/${id}/discontinue`,
      headers: SCHED,
      payload: {},
    });
    expect(discontinued.statusCode).toBe(200);
    expect(discontinued.json().status).toBe("discontinued");
    await app.close();
  });
});

describe("M17-T07 — routes 16-17: clinician availability", () => {
  it("upserts a clinician's weekly availability, then reads it back", async () => {
    const { app } = makeServer();
    const upserted = await app.inject({
      method: "PUT",
      url: `/api/v1/availability/${RN_MEMBERSHIP}`,
      headers: SCHED,
      payload: {
        timeZone: "America/New_York",
        slots: [{ weekday: 1, startTime: "08:00", endTime: "16:00" }],
      },
    });
    expect(upserted.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/availability?membership=${RN_MEMBERSHIP}`,
      headers: SCHED,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().membershipId).toBe(RN_MEMBERSHIP);
    expect(read.json().slots).toHaveLength(1);
    await app.close();
  });
});

describe("M17-T07 — routes 18-20: time-off request, list, approve", () => {
  it("requests time off, lists it, then approves it", async () => {
    const { app } = makeServer();
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/time-off",
      headers: SCHED,
      payload: {
        membershipId: RN_MEMBERSHIP,
        kind: "pto",
        startsAt: "2026-08-15T00:00:00.000Z",
        endsAt: "2026-08-16T00:00:00.000Z",
      },
    });
    expect(requested.statusCode).toBe(201);
    const id = requested.json().id as string;
    expect(requested.json().state).toBe("requested");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/time-off?membership=${RN_MEMBERSHIP}`,
      headers: SCHED,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).map((t) => t.id)).toContain(id);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/approve`,
      headers: SCHED,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("approved");
    await app.close();
  });
});

describe("M17-T07 — route 21: deny time-off", () => {
  it("denies a requested time-off window (reason ≥ 20 chars) → 200", async () => {
    const { app } = makeServer();
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/time-off",
      headers: SCHED,
      payload: {
        membershipId: RN_MEMBERSHIP,
        kind: "sick",
        startsAt: "2026-08-20T00:00:00.000Z",
        endsAt: "2026-08-21T00:00:00.000Z",
      },
    });
    const id = requested.json().id as string;
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/deny`,
      headers: SCHED,
      payload: { reason: "Coverage is unavailable for the requested window." },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().state).toBe("denied");
    await app.close();
  });
});

describe("M17-T07 — route 22: cancel own time-off", () => {
  it("cancels a pre-start time-off window → 200", async () => {
    const { app } = makeServer();
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/time-off",
      headers: SCHED,
      payload: {
        membershipId: RN_MEMBERSHIP,
        kind: "training",
        startsAt: "2026-08-25T00:00:00.000Z",
        endsAt: "2026-08-26T00:00:00.000Z",
      },
    });
    const id = requested.json().id as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/cancel`,
      headers: SCHED,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe("cancelled");
    await app.close();
  });
});

describe("M17-T07 — routes 23-25 & 27: day/week/map views + portal upcoming", () => {
  it("reads day-view, week-view, map-view, and the portal upcoming feed for a published visit", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/visits",
      headers: SCHED,
      payload: visitBody({
        scheduledStartedAt: "2026-07-01T09:00:00.000Z",
        scheduledEndedAt: "2026-07-01T10:00:00.000Z",
      }),
    });
    const id = created.json().id as string;

    const day = await app.inject({
      method: "GET",
      url: `/api/v1/day-view?membership=${RN_MEMBERSHIP}&date=2026-07-01`,
      headers: SCHED,
    });
    expect(day.statusCode).toBe(200);
    expect((day.json().visits as Array<{ id: string }>).map((v) => v.id)).toContain(id);

    const week = await app.inject({
      method: "GET",
      url: `/api/v1/week-view?membership=${RN_MEMBERSHIP}&weekStart=2026-06-29`,
      headers: SCHED,
    });
    expect(week.statusCode).toBe(200);
    expect((week.json().visits as Array<{ id: string }>).map((v) => v.id)).toContain(id);

    const map = await app.inject({
      method: "GET",
      url: `/api/v1/map-view?membership=${RN_MEMBERSHIP}&date=2026-07-01`,
      headers: SCHED,
    });
    expect(map.statusCode).toBe(200);
    expect((map.json().stops as Array<{ id: string }>).map((v) => v.id)).toContain(id);

    const portal = await app.inject({
      method: "GET",
      url: `/api/v1/portal/upcoming?patient=${PATIENT}`,
      headers: SCHED,
    });
    expect(portal.statusCode).toBe(200);
    expect((portal.json() as Array<{ visitId: string }>).map((v) => v.visitId)).toContain(id);
    await app.close();
  });
});

describe("M17-T07 — route 26: on-demand route optimisation", () => {
  it("returns the §7.9 degraded result when route_optimization is off → 200", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/optimize-day",
      headers: SCHED,
      payload: { membershipId: RN_MEMBERSHIP, serviceDate: "2026-07-02" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(backend.drainEvents().map((e) => e.eventName)).toContain(
      "m17.route_optimization_degraded",
    );
    await app.close();
  });
});

describe("M17-T07 — routes 28-29: dashboard metrics", () => {
  it("reads org-wide visit metrics and per-clinician route-efficiency metrics", async () => {
    const { app } = makeServer();
    const window = "from=2026-06-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z";
    const visits = await app.inject({
      method: "GET",
      url: `/api/v1/metrics/visits?${window}`,
      headers: SCHED,
    });
    expect(visits.statusCode).toBe(200);
    expect(typeof visits.json().onTimeRate).toBe("number");

    const routeEff = await app.inject({
      method: "GET",
      url: `/api/v1/metrics/route-efficiency?membership=${RN_MEMBERSHIP}&${window}`,
      headers: SCHED,
    });
    expect(routeEff.statusCode).toBe(200);
    expect(routeEff.json().membershipId).toBe(RN_MEMBERSHIP);
    await app.close();
  });
});
