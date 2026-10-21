// apps/backend/__tests__/idg-schedule-meeting.test.ts — POST /api/v1/idg/meetings (schedule ONE ad-hoc meeting)
// + the coordinator on the meeting read model. Fastify inject over the in-memory IDG backend, REAL
// Authorization Contract (idg.schedule) — same harness shape as idg-routes.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  request.context.roles = ["idg_coordinator"];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
}

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const OTHER_LOC = "55555555-5555-4555-8555-555555555555";
const COORD = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-06-01T12:00:00.000Z";
const h = (user: string, locations = LOC) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-locations": locations,
});
const body = (over: Record<string, unknown> = {}) => ({
  locationId: LOC,
  scheduledStart: "2026-06-10T14:00:00.000Z",
  scheduledEnd: "2026-06-10T16:00:00.000Z",
  ...over,
});

function makeServer(seed: Parameters<typeof createInMemoryIdgBackend>[0] = {}) {
  const backend = createInMemoryIdgBackend({ now: () => NOW, ...seed });
  const grants = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "scheduler",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["idg.schedule", "idg.read"],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "reader",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["idg.read"] }],
    },
  ]);
  registerEffectivePermissionResolver(grants.store);
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildIdgAbacPredicates({ resolver: backend })))
    registry.register(name, fn);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

const post = (
  app: ReturnType<typeof makeServer>["app"],
  user: string,
  payload: unknown,
  loc?: string,
) =>
  app.inject({
    method: "POST",
    url: "/api/v1/idg/meetings",
    headers: h(user, loc),
    payload: payload as never,
  });

describe("POST /api/v1/idg/meetings", () => {
  it("creates a scheduled meeting, defaults the coordinator to the acting membership, emits m14.meeting.scheduled", async () => {
    const { app, backend } = makeServer();
    const res = await post(app, "scheduler", body());
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({
      organizationId: ORG,
      locationId: LOC,
      status: "scheduled",
      coordinatorMembershipId: "scheduler",
      adjournedAt: null,
    });
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m14.meeting.scheduled");
    await app.close();
  });

  it("honours an explicit coordinatorMembershipId and returns it on GET /meetings/:id and the schedule list", async () => {
    const { app } = makeServer();
    const created = (await post(app, "scheduler", body({ coordinatorMembershipId: COORD }))).json();
    expect(created.coordinatorMembershipId).toBe(COORD);
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${created.id}`,
      headers: h("scheduler"),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().coordinatorMembershipId).toBe(COORD);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/idg/schedule?location=${LOC}&from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z`,
      headers: h("scheduler"),
    });
    expect(list.json()[0].coordinatorMembershipId).toBe(COORD);
    await app.close();
  });

  it("403 without idg.schedule", async () => {
    const { app } = makeServer();
    expect((await post(app, "reader", body())).statusCode).toBe(403);
    await app.close();
  });

  it("404 for a location outside the caller's scope (no existence oracle)", async () => {
    const { app } = makeServer();
    expect((await post(app, "scheduler", body({ locationId: OTHER_LOC }))).statusCode).toBe(404);
    await app.close();
  });

  it("422 on end<=start, > 12h, past start, malformed body", async () => {
    const { app } = makeServer();
    for (const bad of [
      body({ scheduledEnd: "2026-06-10T14:00:00.000Z" }),
      body({ scheduledEnd: "2026-06-11T14:00:00.000Z" }),
      body({
        scheduledStart: "2026-05-01T14:00:00.000Z",
        scheduledEnd: "2026-05-01T15:00:00.000Z",
      }),
      { locationId: "not-a-uuid" },
    ]) {
      const res = await post(app, "scheduler", bad);
      expect(res.statusCode).toBe(422);
      expect(res.json().error?.code ?? res.json().code).toBe("VALIDATION_FAILED");
    }
    await app.close();
  });

  it("409 IDG_MEETING_OVERLAP on an overlapping live meeting; back-to-back is allowed", async () => {
    const { app } = makeServer();
    expect((await post(app, "scheduler", body())).statusCode).toBe(201);
    const clash = await post(
      app,
      "scheduler",
      body({
        scheduledStart: "2026-06-10T15:00:00.000Z",
        scheduledEnd: "2026-06-10T17:00:00.000Z",
      }),
    );
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error?.code ?? clash.json().code).toBe("IDG_MEETING_OVERLAP");
    const adjacent = await post(
      app,
      "scheduler",
      body({
        scheduledStart: "2026-06-10T16:00:00.000Z",
        scheduledEnd: "2026-06-10T17:00:00.000Z",
      }),
    );
    expect(adjacent.statusCode).toBe(201);
    await app.close();
  });
});

describe("POST /api/v1/idg/meetings — coordinator must be an active member of the caller's org", () => {
  const FOREIGN = "77777777-7777-4777-8777-777777777777"; // active in ANOTHER org only
  const seedMembers = { activeMembershipsByOrg: { [ORG]: [COORD], org_b: [FOREIGN] } };

  it("accepts an active member of the caller's org", async () => {
    const { app } = makeServer(seedMembers);
    const res = await post(app, "scheduler", body({ coordinatorMembershipId: COORD }));
    expect(res.statusCode).toBe(201);
    expect(res.json().coordinatorMembershipId).toBe(COORD);
    await app.close();
  });

  it("422 VALIDATION_FAILED for a foreign-org / unknown id, with identical responses (no existence oracle)", async () => {
    const { app, backend } = makeServer(seedMembers);
    const foreign = await post(app, "scheduler", body({ coordinatorMembershipId: FOREIGN }));
    const unknown = await post(
      app,
      "scheduler",
      body({ coordinatorMembershipId: "88888888-8888-4888-8888-888888888888" }),
    );
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error.code).toBe("VALIDATION_FAILED");
    expect(unknown.statusCode).toBe(422);
    const strip = (r: { json(): { error: Record<string, unknown> } }) => {
      const { correlationId: _c, ...rest } = r.json().error;
      return rest;
    };
    expect(strip(foreign)).toEqual(strip(unknown));
    expect(backend.drainEvents().map((e) => e.eventName)).not.toContain("m14.meeting.scheduled");
    await app.close();
  });

  it("the default coordinator (the caller) is not subject to the check", async () => {
    const { app } = makeServer(seedMembers);
    expect((await post(app, "scheduler", body())).statusCode).toBe(201);
    await app.close();
  });
});

describe("POST /api/v1/idg/meetings/:id/cancel|reschedule — review-floor ABAC target comes from the ROUTE", () => {
  const MTG = "99999999-9999-4999-8999-999999999999";
  const seed = {
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        scheduledStart: "2026-06-10T14:00:00.000Z",
        scheduledEnd: "2026-06-10T15:00:00.000Z",
      },
    ],
  };
  const cancel = (app: ReturnType<typeof makeServer>["app"], payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/cancel`,
      headers: h("scheduler"),
      payload: payload as never,
    });

  it("regression: an empty-agenda meeting with a body lacking proposedTransition is a 422, NOT a 403 from the predicate", async () => {
    const { app } = makeServer(seed);
    const res = await cancel(app, { reason: "no longer needed" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("cancels a clear meeting with the full body (200)", async () => {
    const { app } = makeServer(seed);
    const res = await cancel(app, { proposedTransition: "cancel", reason: "no longer needed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    await app.close();
  });

  it("a REAL breach still denies (403) without the override, whatever the body claims", async () => {
    const { app } = makeServer({
      ...seed,
      reviewFloorBreaches: { [MTG]: [{ patientId: "p1", floorAt: "2026-06-12T00:00:00.000Z" }] },
    });
    const res = await cancel(app, { proposedTransition: "cancel", reason: "x" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
