// apps/backend/__tests__/scheduling-own-vs-any.test.ts — GAP-051: M17 availability / PTO own-vs-any.
//
// Before: the routes checked only the `*_own` keys and the services ignored the caller, so any clinician
// could edit a colleague's availability, file or cancel PTO for them, and list the whole org's PTO.
// Now the acting membership (server-derived) must equal the target membership unless the caller holds
// `availability.edit_any` / `time_off.read_team` / `time_off.approve`; self-approval is a 409.
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
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  SchedulingRouteService,
  buildSchedulingAbacPredicates,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";

const ORG = "org_a";
const NOW = "2026-07-01T00:00:00.000Z";
const CLIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const CLINICIAN_PERMS = [
  "availability.read",
  "availability.edit_own",
  "time_off.read_own",
  "time_off.request_own",
  "time_off.cancel_own",
];
// A supervisor: approve + read_team + edit_any, deliberately WITHOUT cancel_own (spec: cancel via approve).
const SUPERVISOR_PERMS = [
  "availability.read",
  "availability.edit_any",
  "time_off.read_team",
  "time_off.request_own",
  "time_off.approve",
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = `user-of-${user}`;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
}

function makeServer() {
  const backend = new SchedulingRouteService({ now: () => NOW, newId: () => randomUUID() });
  const perms: Array<[string, string[]]> = [
    [CLIN_A, CLINICIAN_PERMS],
    [CLIN_B, CLINICIAN_PERMS],
    [SUP, SUPERVISOR_PERMS],
  ];
  const store = createInMemoryEffectivePermissionStore(
    perms.map(([member, permissionKeys]) => ({
      orgId: ORG,
      userId: `user-of-${member}`,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildSchedulingAbacPredicates({ resolver: backend }),
  )) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSchedulingRoutes(app, { service: backend, caseloadPatientIds: async () => [] });
  return app;
}

const as = (member: string) => ({ "x-test-user": member });
const AVAIL = { timeZone: "UTC", slots: [{ weekday: 1, startTime: "08:00", endTime: "16:00" }] };
const PTO = (membershipId: string) => ({
  membershipId,
  kind: "pto",
  startsAt: "2026-08-15T00:00:00.000Z",
  endsAt: "2026-08-16T00:00:00.000Z",
});

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

async function filePto(app: ReturnType<typeof makeServer>, member: string, target = member) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/time-off",
    headers: as(member),
    payload: PTO(target),
  });
  return res;
}

describe("GAP-051 — availability own-vs-any", () => {
  it("A editing B's availability -> 403", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/availability/${CLIN_B}`,
      headers: as(CLIN_A),
      payload: AVAIL,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("A editing own availability -> 200", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/availability/${CLIN_A}`,
      headers: as(CLIN_A),
      payload: AVAIL,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a supervisor holding edit_any (no edit_own) edits anyone's -> 200", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/availability/${CLIN_B}`,
      headers: as(SUP),
      payload: AVAIL,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GAP-051 — time-off own-vs-any", () => {
  it("A filing PTO for B -> 403; for self -> 201", async () => {
    const app = makeServer();
    expect((await filePto(app, CLIN_A, CLIN_B)).statusCode).toBe(403);
    expect((await filePto(app, CLIN_A)).statusCode).toBe(201);
    await app.close();
  });

  it("A cancelling B's PTO -> 403; B cancelling own -> 200", async () => {
    const app = makeServer();
    const id = (await filePto(app, CLIN_B)).json().id as string;
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/cancel`,
      headers: as(CLIN_A),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    const own = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/cancel`,
      headers: as(CLIN_B),
      payload: {},
    });
    expect(own.statusCode).toBe(200);
    await app.close();
  });

  it("a supervisor holding approve (no cancel_own) cancels team PTO -> 200", async () => {
    const app = makeServer();
    const id = (await filePto(app, CLIN_B)).json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${id}/cancel`,
      headers: as(SUP),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a clinician lists only their own PTO; asking for another's -> 403; a supervisor lists all", async () => {
    const app = makeServer();
    await filePto(app, CLIN_A);
    await filePto(app, CLIN_B);
    const mine = await app.inject({ method: "GET", url: "/api/v1/time-off", headers: as(CLIN_A) });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as Array<{ membershipId: string }>).map((t) => t.membershipId)).toEqual([
      CLIN_A,
    ]);
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/time-off?membership=${CLIN_B}`,
      headers: as(CLIN_A),
    });
    expect(other.statusCode).toBe(403);
    const team = await app.inject({ method: "GET", url: "/api/v1/time-off", headers: as(SUP) });
    expect(team.json()).toHaveLength(2);
    await app.close();
  });

  it("approving a request for someone else -> 200; approving own -> 409", async () => {
    const app = makeServer();
    const others = (await filePto(app, CLIN_B)).json().id as string;
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${others}/approve`,
      headers: as(SUP),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    const own = (await filePto(app, SUP)).json().id as string;
    const self = await app.inject({
      method: "POST",
      url: `/api/v1/time-off/${own}/approve`,
      headers: as(SUP),
      payload: {},
    });
    expect(self.statusCode).toBe(409);
    await app.close();
  });

  it("a clinician without approve cannot approve or deny -> 403", async () => {
    const app = makeServer();
    const id = (await filePto(app, CLIN_B)).json().id as string;
    for (const verb of ["approve", "deny"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-off/${id}/${verb}`,
        headers: as(CLIN_A),
        payload: { reason: "x".repeat(25) },
      });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });
});

describe("GAP-051 — service layer enforces independently of the route guard", () => {
  const none = { availabilityEditAny: false, timeOffReadTeam: false, timeOffApprove: false };
  it("rejects cross-membership writes without authority", () => {
    const svc = new SchedulingRouteService({ now: () => NOW, newId: () => randomUUID() });
    expect(() => svc.upsertAvailability(ORG, CLIN_A, CLIN_B, AVAIL, none)).toThrow();
    expect(() => svc.requestTimeOff(ORG, CLIN_A, PTO(CLIN_B) as never, none)).toThrow();
    expect(() => svc.approveTimeOff(ORG, SUP, randomUUID(), none)).toThrow();
  });
});
