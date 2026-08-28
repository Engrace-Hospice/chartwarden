// apps/backend/__tests__/idg-inject.test.ts — M14 (IDG) §4.1 route-inventory HTTP-layer smoke test
// (TASK-050A). Closes TEST-001 for M14: before this file, M14 had zero `app.inject()` coverage —
// `idg-workflow-acceptance.test.ts` / `m14-idg-read-service.live.test.ts` / `m14-idg-write.live.test.ts` /
// `care-plan-idg-consumer.test.ts` test pure logic or a real Postgres, never the route layer, so a
// mis-wired guard/schema/service binding on a route would be invisible to every existing M14 test.
//
// Clones the `orders-routes.test.ts` (M11-T06) pattern exactly: `buildServer()` mounts the host,
// `registerIdgRoutes()` mounts the §4.1 inventory over the in-memory IDG backend, the REAL Authorization
// Contract gates every route on the §4.6 keys, and a header-auth shim populates `request.context`. M14's
// `idg_meeting_scope` / `quorate_decision` / `per_patient_review_floor_clear` §4.7 predicates are built via
// `buildIdgAbacPredicates` over the SAME in-memory backend (it doubles as the `IdgAbacResolver`) and
// registered into a fresh per-server predicate registry — the orders precedent again (a shared registry
// would persist a predicate closed over a prior test's backend across the file).
//
// KNOWN LIMITATION surfaced by driving the real route+schema layer (this is exactly what TEST-001 exists to
// catch): every `:id` param in M14's route table is validated against `IdParamsSchema` (`format: "uuid"`,
// `idg-typebox.ts`), but the in-memory backend's `nextId()` (`routes/service.ts`) mints ids shaped like
// `idg-att-00000001` — NOT uuid-shaped (the M11 in-memory backend's `nextId()` deliberately mints
// `00000000-0000-4000-8000-xxxxxxxxxxxx` for exactly this reason; M14's does not). So every follow-on
// PATCH/DELETE/POST that references a server-generated sub-resource id (attendance / agenda item / decision
// / action item / minutes / recurring policy — everything except the meeting id, which the caller supplies)
// 422s on the `id` PARAM before the handler ever runs, for a fully-permissioned actor with a well-formed
// body. Confirmed empirically (not inferred): see the "known limitation" block below, which asserts this
// REAL, current behavior rather than fabricating a 2xx the source cannot produce. The production Drizzle
// backend (`createDbIdgBackend`) generates real UUIDs, so this is an in-memory-scaffold-only defect — but it
// is precisely the class of bug a pure-function test can never see and only `app.inject()` surfaces.
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";
import type { IdgMeetingSeed } from "../src/modules/14-idg/routes/service";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // actorOf() in idg-routes.ts reads the acting MEMBERSHIP id from here (not ctx.userId) — any
  // non-empty string satisfies it; the routes only use it for write-attribution.
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // M14's §4.7 `idg_meeting_scope` predicate gates on the caller's location memberships
  // (`AbacContext.locationIds`) — M11's shim has no location-scoped predicate so it never needed this;
  // M14 does, so this shim also lifts a test-only `x-test-loc` header into `request.context.locationIds`.
  const loc = request.headers["x-test-loc"];
  request.context.locationIds = typeof loc === "string" && loc.length > 0 ? loc.split(",") : [];
  // F-028 — the ADJOURN route's D13 step-up used to be `request.headers["x-step-up"] === "fresh"`, a
  // client-supplied string this shim did not have to model at all. It now resolves the REAL session
  // through M2's `SessionContextResolver` seam, so the shim stamps the session id the way the
  // production authenticate hook does and the seam stub below decides freshness.
  const session = request.headers["x-test-session"];
  if (typeof session === "string" && session.length > 0)
    request.context.attributes.sessionId = session;
}

const ORG = "org_a";
const LOC = "22222222-2222-4222-8222-222222222222";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const RN_MSHIP = "33333333-3333-4333-8333-333333333333";
const MSW_MSHIP = "44444444-4444-4444-8444-444444444444";
const CHAP_MSHIP = "55555555-5555-4555-8555-555555555555";
const PHYS_MSHIP = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-06-08T12:00:00.000Z";

// Meeting ids the caller supplies (never server-generated), one per lifecycle branch under test.
const MEETING_LIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEETING_BUILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEETING_START = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEETING_CANCEL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MEETING_RESCHED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MEETING_KL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

// §4.6 permission keys M14 contributes (`M14_CONTRIBUTED_PERMISSIONS`, packages/auth/src/permissions/contributed.ts).
const ALL_IDG_PERMISSIONS = [
  "idg.read",
  "idg.attend",
  "idg.coordinate",
  "idg.decide",
  "idg.act",
  "idg.schedule",
  "idg.amend_minutes",
];
const PERMISSION_SEED = [
  { userId: "coord_1", permissions: ALL_IDG_PERMISSIONS },
  { userId: "noperm_1", permissions: [] as string[] },
];

function makeServer(meetings: readonly IdgMeetingSeed[] = []) {
  const backend = createInMemoryIdgBackend({ now: () => NOW, meetings });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH predicate registry per server — the shared registry would otherwise persist a predicate closed
  // over a prior test's backend across the file (the M11-T06 precedent).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildIdgAbacPredicates({ resolver: backend }))) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend });
  return { app, backend };
}

const SUPER = {
  "x-test-user": "coord_1",
  "x-test-org": ORG,
  "x-test-roles": "idg_coordinator",
  "x-test-loc": LOC,
};
const NOPERM = {
  "x-test-user": "noperm_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-loc": LOC,
};

// Two sessions, identical except for when they last stepped up: `SESSION_FRESH` is inside the
// `STEP_UP_POLICY` 300s window, `SESSION_STALE` is well outside it. The ADJOURN route's D13 gate is
// the ONLY thing that distinguishes them, which is what makes the forgery test below meaningful.
const SESSION_FRESH = "sess_fresh";
const SESSION_STALE = "sess_stale";
const SUPER_FRESH = { ...SUPER, "x-test-session": SESSION_FRESH };
const SUPER_STALE = { ...SUPER, "x-test-session": SESSION_STALE };

/** Register the real `SessionContextResolver` seam over an in-memory store holding both sessions. */
function registerStepUpSeam(): void {
  const base = {
    userId: "coord_1",
    membershipId: "coord_1",
    organizationId: ORG,
    roles: ["idg_coordinator"],
    providerEntityIds: [] as string[],
    locationIds: [LOC],
  };
  registerSeam(
    "SessionContextResolver",
    createSessionContextResolver(
      createInMemorySessionContextStore([
        {
          ...base,
          sessionId: SESSION_FRESH,
          lastStepUpAt: new Date(Date.now() - 30_000),
          lastStepUpFactor: "totp",
        },
        {
          ...base,
          sessionId: SESSION_STALE,
          lastStepUpAt: new Date(Date.now() - 86_400_000),
          lastStepUpFactor: "totp",
        },
      ]).store,
    ),
  );
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
  registerStepUpSeam();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

describe("M14-idg-inject — auth gating", () => {
  it("no auth headers at all → 401 (route: GET /idg/schedule)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/schedule?location=${LOC}&from=2026-06-01T00:00:00.000Z&to=2026-06-15T00:00:00.000Z`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("authenticated actor holding NO permissions → 403 (route: GET /idg/schedule, requires idg.read)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/schedule?location=${LOC}&from=2026-06-01T00:00:00.000Z&to=2026-06-15T00:00:00.000Z`,
      headers: NOPERM,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor with an empty body → 422 VALIDATION_FAILED (route: POST /idg/recurring-policies)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/idg/recurring-policies",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

describe("M14-idg-inject — meeting lifecycle transitions (each on its own freshly-seeded meeting)", () => {
  it("POST /idg/meetings/:id/packets/build — scheduled → packets_building (201/200)", async () => {
    const { app } = makeServer([
      {
        id: MEETING_BUILD,
        organizationId: ORG,
        locationId: LOC,
        scheduledStart: NOW,
        scheduledEnd: NOW,
        includedPatientIds: [PATIENT],
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_BUILD}/packets/build`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("packets_building");
    await app.close();
  });

  it("POST /idg/meetings/:id/start — packets_ready → live (200)", async () => {
    const { app } = makeServer([
      {
        id: MEETING_START,
        organizationId: ORG,
        locationId: LOC,
        status: "packets_ready",
        scheduledStart: NOW,
        scheduledEnd: NOW,
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_START}/start`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("live");
    await app.close();
  });

  it("POST /idg/meetings/:id/cancel — scheduled → cancelled (200, per_patient_review_floor_clear passes on no breaches)", async () => {
    const { app } = makeServer([
      {
        id: MEETING_CANCEL,
        organizationId: ORG,
        locationId: LOC,
        scheduledStart: NOW,
        scheduledEnd: NOW,
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_CANCEL}/cancel`,
      headers: SUPER,
      payload: { proposedTransition: "cancel", reason: "location closed for the day" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    await app.close();
  });

  it("POST /idg/meetings/:id/reschedule — scheduled → rescheduled (200)", async () => {
    const { app } = makeServer([
      {
        id: MEETING_RESCHED,
        organizationId: ORG,
        locationId: LOC,
        scheduledStart: NOW,
        scheduledEnd: NOW,
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_RESCHED}/reschedule`,
      headers: SUPER,
      payload: {
        proposedTransition: "reschedule",
        reason: "coordinator conflict",
        newScheduledStart: "2026-06-15T09:00:00.000Z",
        newScheduledEnd: "2026-06-15T10:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rescheduled");
    await app.close();
  });
});

describe("M14-idg-inject — live meeting: reads + attendance + packets + agenda + decision + action item + adjourn", () => {
  it("walks the §4.1 read/write inventory over one live meeting end to end", async () => {
    const { app } = makeServer([
      {
        id: MEETING_LIVE,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-08T09:00:00.000Z",
        scheduledEnd: "2026-06-08T10:00:00.000Z",
        includedPatientIds: [PATIENT],
      },
    ]);

    // route #10 — record the four IDG_REQUIRED_QUORUM disciplines present (unblocks the decisions route's
    // `quorate_decision` §4.7 predicate below).
    const rn = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/attendance`,
      headers: SUPER,
      payload: { membershipId: RN_MSHIP, discipline: "rn_case_manager" },
    });
    expect(rn.statusCode).toBe(201);
    const msw = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/attendance`,
      headers: SUPER,
      payload: { membershipId: MSW_MSHIP, discipline: "msw" },
    });
    expect(msw.statusCode).toBe(201);
    const chap = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/attendance`,
      headers: SUPER,
      payload: { membershipId: CHAP_MSHIP, discipline: "chaplain" },
    });
    expect(chap.statusCode).toBe(201);
    const phys = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/attendance`,
      headers: SUPER,
      payload: { membershipId: PHYS_MSHIP, discipline: "hospice_physician" },
    });
    expect(phys.statusCode).toBe(201);

    // route #12b (F-062) — the attendance roster the three attendance WRITES shipped without. Before
    // this read existed a coordinator could check four clinicians in and no route in the module would
    // return them, so the §5 live quorum gauge had no source.
    const roster = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/attendance`,
      headers: SUPER,
    });
    expect(roster.statusCode).toBe(200);
    expect(
      roster
        .json()
        .map((a: { discipline: string }) => a.discipline)
        .sort(),
    ).toEqual(["chaplain", "hospice_physician", "msw", "rn_case_manager"]);

    // route #1 — schedule list (location + date-range scoped).
    const schedule = await app.inject({
      method: "GET",
      url: `/api/v1/idg/schedule?location=${LOC}&from=2026-06-01T00:00:00.000Z&to=2026-06-15T00:00:00.000Z`,
      headers: SUPER,
    });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json().map((m: { id: string }) => m.id)).toContain(MEETING_LIVE);

    // route #4 — read one meeting (idg_meeting_scope).
    const meeting = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}`,
      headers: SUPER,
    });
    expect(meeting.statusCode).toBe(200);
    expect(meeting.json().status).toBe("live");

    // route #13 — list a meeting's packets.
    const packets = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/packets`,
      headers: SUPER,
    });
    expect(packets.statusCode).toBe(200);
    expect(packets.json()).toHaveLength(1);

    // route #14 — read one patient's packet.
    const packet = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/packets/${PATIENT}`,
      headers: SUPER,
    });
    expect(packet.statusCode).toBe(200);
    expect(packet.json().patientId).toBe(PATIENT);

    // route #14b — patient-scoped IDG review history.
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/idg-history`,
      headers: SUPER,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().meetings).toHaveLength(1);

    // route #15 — add an agenda item.
    const agenda = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/agenda`,
      headers: SUPER,
      payload: { kind: "patient_review", patientId: PATIENT },
    });
    expect(agenda.statusCode).toBe(201);

    // route #17b (F-062) — the agenda list. add/update/remove existed; nothing read them back.
    const agendaList = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/agenda`,
      headers: SUPER,
    });
    expect(agendaList.statusCode).toBe(200);
    expect(agendaList.json()).toHaveLength(1);
    expect(agendaList.json()[0].kind).toBe("patient_review");

    // route #18 — record a decision (quorate_decision §4.7 predicate; quorum satisfied above).
    const decision = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/decisions`,
      headers: SUPER,
      payload: {
        patientId: PATIENT,
        payload: {
          kind: "referral",
          referralKind: "social_services",
          referralTargetMdmId: null,
          rationaleText: "IDG requested a social-services referral.",
        },
      },
    });
    expect(decision.statusCode).toBe(201);
    expect(decision.json().wasQuorate).toBe(true);

    // route #20b (F-062) — the meeting's decision ledger. The only prior reader anywhere was the
    // PATIENT-scoped history tab, so "what did THIS meeting decide" — the question an adjournment
    // commits to — was unanswerable.
    const ledger = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/decisions`,
      headers: SUPER,
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toHaveLength(1);
    expect(ledger.json()[0].decisionKind).toBe("referral");
    expect(ledger.json()[0].wasQuorate).toBe(true);
    expect(ledger.json()[0].recordedByMembershipId).toBe("coord_1");
    // The PHI posture is a PROPERTY of this read, not an accident of the current projection: the D4
    // payload is the §3.3 denylisted narrative and a list read must never carry it.
    expect(ledger.json()[0].payload).toBeUndefined();
    expect(ledger.json()[0].quorumSnapshot).toBeUndefined();

    // route #21 — create an action item.
    const actionItem = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/action-items`,
      headers: SUPER,
      payload: {
        patientId: PATIENT,
        assignedToMembershipId: RN_MSHIP,
        dueDate: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(actionItem.statusCode).toBe(201);

    // route #24 — list action items (org-scoped).
    const actionItems = await app.inject({
      method: "GET",
      url: "/api/v1/idg/action-items",
      headers: SUPER,
    });
    expect(actionItems.statusCode).toBe(200);
    expect(actionItems.json().length).toBeGreaterThanOrEqual(1);

    // route #25 — read the meeting's minutes (still in_progress pre-adjournment).
    const minutesBefore = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/minutes`,
      headers: SUPER,
    });
    expect(minutesBefore.statusCode).toBe(200);
    expect(minutesBefore.json().status).toBe("in_progress");
    // Null, not 0, while in progress: "no decisions were recorded" and "the snapshot has not been
    // taken" are different facts about a meeting, and a screen has to be able to tell them apart.
    expect(minutesBefore.json().attendanceCount).toBeNull();
    expect(minutesBefore.json().decisionCount).toBeNull();

    // route #9 — adjourn (fresh step-up required, §2.2 D13); the commit point: emits the open decision,
    // finalizes the minutes.
    const adjourn = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/adjourn`,
      headers: SUPER_FRESH,
      payload: {},
    });
    expect(adjourn.statusCode).toBe(200);
    expect(adjourn.json().status).toBe("adjourned");

    // route #25 again (F-062) — the finalized minutes. This read used to project 3 of the row's 13
    // columns (`{ id, meetingId, status }`), so the §418.56(d) evidence document reported only that it
    // was final. It now carries the finalize attribution and the SIZES of the three frozen snapshots —
    // which adjournment also had to start writing, since it stamped the status and left all three NULL.
    const minutesAfter = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/minutes`,
      headers: SUPER,
    });
    expect(minutesAfter.statusCode).toBe(200);
    expect(minutesAfter.json().status).toBe("final");
    expect(minutesAfter.json().finalizedAt).not.toBeNull();
    expect(minutesAfter.json().finalizedByMembershipId).toBe("coord_1");
    expect(minutesAfter.json().attendanceCount).toBe(4);
    expect(minutesAfter.json().decisionCount).toBe(1);
    expect(minutesAfter.json().actionItemCount).toBe(1);

    await app.close();
  });
});

describe("M14-idg-inject — F-028: the D13 step-up is server-verified, not client-asserted", () => {
  const seed: readonly IdgMeetingSeed[] = [
    {
      id: MEETING_LIVE,
      organizationId: ORG,
      locationId: LOC,
      status: "live",
      scheduledStart: "2026-06-08T09:00:00.000Z",
      scheduledEnd: "2026-06-08T10:00:00.000Z",
      includedPatientIds: [PATIENT],
    },
  ];

  it("a STALE session cannot adjourn even while sending the old `x-step-up: fresh` header", async () => {
    const { app } = makeServer(seed);
    // The exact request that used to WORK: the header the route read for its D13 decision, sent by a
    // caller whose real session last stepped up a day ago. Before F-028 this returned 200 — the header
    // WAS the check, so anyone who could reach the commit point could satisfy it by typing it.
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/adjourn`,
      headers: { ...SUPER_STALE, "x-step-up": "fresh" },
      payload: {},
    });
    expect(forged.statusCode).toBe(412);
    expect(forged.json().error.code).toBe("STEP_UP_REQUIRED");
    await app.close();
  });

  it("a session with no step-up at all is refused, header or not", async () => {
    const { app } = makeServer(seed);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/adjourn`,
      headers: { ...SUPER, "x-step-up": "fresh" }, // no `x-test-session` ⇒ no session id on the context
      payload: {},
    });
    expect(res.statusCode).toBe(412);
    await app.close();
  });

  it("the SAME request with a fresh real session succeeds — the gate is the session, not the header", async () => {
    const { app } = makeServer(seed);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_LIVE}/adjourn`,
      headers: SUPER_FRESH, // no `x-step-up` header anywhere
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("adjourned");
    await app.close();
  });
});

describe("M14-idg-inject — known limitation: server-generated sub-resource ids are not uuid-shaped", () => {
  it("IdParamsSchema requires `format: 'uuid'`; the in-memory backend's `nextId()` mints " +
    "`<prefix>-00000001`-style ids for attendance/agenda/decision/action-item/minutes/recurring-policy — " +
    "so a fully-permissioned actor's follow-on PATCH/DELETE/POST 422s on the `id` param before the handler " +
    "runs, even with a well-formed body. This asserts the REAL current behavior (not a fabricated pass); " +
    "the production Drizzle backend mints real UUIDs so this does not reach prod. The POST calls that mint " +
    "these ids (routes #2, and #10/#15/#18/#21 already proven 2xx above) genuinely succeed — only the " +
    "follow-on id-keyed call fails.", async () => {
    const { app } = makeServer([
      {
        id: MEETING_KL,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: NOW,
        scheduledEnd: NOW,
        includedPatientIds: [PATIENT],
      },
    ]);

    // route #2 (genuine 201) → route #3 (blocked, 422 on `id`).
    const policy = await app.inject({
      method: "POST",
      url: "/api/v1/idg/recurring-policies",
      headers: SUPER,
      payload: { locationId: LOC, cadenceDays: 14 },
    });
    expect(policy.statusCode).toBe(201);
    const policyId = policy.json().id as string;
    const policyPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/idg/recurring-policies/${policyId}`,
      headers: SUPER,
      payload: { locationId: LOC, cadenceDays: 7 },
    });
    expect(policyPatch.statusCode).toBe(422);
    expect(policyPatch.json().error.details[0].field).toBe("id");

    // quorum attendance (unblocks the decisions route below).
    const rn = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/attendance`,
      headers: SUPER,
      payload: { membershipId: RN_MSHIP, discipline: "rn_case_manager" },
    });
    const attendanceId = rn.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/attendance`,
      headers: SUPER,
      payload: { membershipId: MSW_MSHIP, discipline: "msw" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/attendance`,
      headers: SUPER,
      payload: { membershipId: CHAP_MSHIP, discipline: "chaplain" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/attendance`,
      headers: SUPER,
      payload: { membershipId: PHYS_MSHIP, discipline: "hospice_physician" },
    });

    // route #11 / #12 — blocked, 422 on `id`.
    const attPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/idg/attendance/${attendanceId}`,
      headers: SUPER,
      payload: { status: "tardy" },
    });
    expect(attPatch.statusCode).toBe(422);
    const attDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/idg/attendance/${attendanceId}`,
      headers: SUPER,
    });
    expect(attDelete.statusCode).toBe(422);

    // route #15 (genuine 201) → route #16 / #17 (blocked, 422 on `id`).
    const agenda = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/agenda`,
      headers: SUPER,
      payload: { kind: "patient_review", patientId: PATIENT },
    });
    const agendaId = agenda.json().id as string;
    const agendaPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/idg/agenda/${agendaId}`,
      headers: SUPER,
      payload: { noteText: "revised" },
    });
    expect(agendaPatch.statusCode).toBe(422);
    const agendaDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/idg/agenda/${agendaId}`,
      headers: SUPER,
    });
    expect(agendaDelete.statusCode).toBe(422);

    // route #18 (genuine 201) → route #19 / #20 (blocked, 422 on `id`).
    const decision = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/decisions`,
      headers: SUPER,
      payload: {
        patientId: PATIENT,
        payload: {
          kind: "referral",
          referralKind: "social_services",
          referralTargetMdmId: null,
          rationaleText: "IDG requested a social-services referral.",
        },
      },
    });
    const decisionId = decision.json().id as string;
    const decisionPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/idg/decisions/${decisionId}`,
      headers: SUPER,
      payload: { payload: { kind: "team_note", noteText: "Updated team note." } },
    });
    expect(decisionPatch.statusCode).toBe(422);
    const decisionSupersede = await app.inject({
      method: "POST",
      url: `/api/v1/idg/decisions/${decisionId}/supersede`,
      headers: SUPER,
      payload: {},
    });
    expect(decisionSupersede.statusCode).toBe(422);

    // route #21 (genuine 201) → route #22 / #23 (blocked, 422 on `id`).
    const actionItem = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/action-items`,
      headers: SUPER,
      payload: {
        patientId: PATIENT,
        assignedToMembershipId: RN_MSHIP,
        dueDate: "2026-07-01T00:00:00.000Z",
      },
    });
    const actionItemId = actionItem.json().id as string;
    const actionItemPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/idg/action-items/${actionItemId}`,
      headers: SUPER,
      payload: { status: "in_progress" },
    });
    expect(actionItemPatch.statusCode).toBe(422);
    const actionItemDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/idg/action-items/${actionItemId}`,
      headers: SUPER,
    });
    expect(actionItemDelete.statusCode).toBe(422);

    // adjourn to finalize the minutes, then route #26 (blocked, 422 on `id`).
    const adjourn = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MEETING_KL}/adjourn`,
      headers: SUPER_FRESH,
      payload: {},
    });
    expect(adjourn.statusCode).toBe(200);
    const minutes = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MEETING_KL}/minutes`,
      headers: SUPER,
    });
    expect(minutes.json().status).toBe("final");
    const minutesId = minutes.json().id as string;
    const amendment = await app.inject({
      method: "POST",
      url: `/api/v1/idg/minutes/${minutesId}/amendments`,
      headers: SUPER,
      payload: { amendmentReason: "correction needed" },
    });
    expect(amendment.statusCode).toBe(422);
    expect(amendment.json().error.details[0].field).toBe("id");

    await app.close();
  });
});
