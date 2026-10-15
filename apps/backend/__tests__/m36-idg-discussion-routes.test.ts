// WP 3.6 - GET /messaging/channels/:id/idg-discussions over the route stack and the REAL Authorization Contract, with a
// fake store (the SQL half is proven by m36-idg-coordination.live.test.ts).
//
//   flag combos:  messaging.idg AND messaging.clinical_links => enabled; either off / unreadable => 200 {enabled:false}
//   guards:       the pin list's exact guards: non-member and malformed id are the 404 of a random id, BEFORE flag and store
//   shape/limit:  default 50, 1..100, anything else is a 422
//   audit:        the route is read-audited as one list event carrying the channel's patient
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requireAbac,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildIdgDiscussionDeps } from "../src/modules/36-messaging/idg/binding";
import type { IdgDiscussionStore } from "../src/modules/36-messaging/idg/idg-discussion-store-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import {
  DISABLED_IDG_DISCUSSIONS,
  type IdgDiscussionRouteDeps,
  registerIdgDiscussionRoutes,
} from "../src/modules/36-messaging/routes/idg-discussion-routes";

type PreHandler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;
const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1";
const PATIENT = "bbbbbbbb-bbbb-4bbb-8bbb-0000000000b1";
const KEYS = ["messaging.read"];

let listCalls: Array<{ userId: string; channelId: string; limit: number }> = [];
let flagReads = 0;
let flag: boolean | "throw" = true;
const store: IdgDiscussionStore = {
  list: async (_org, input) => {
    listCalls.push(input);
    return { discussions: [{ messageId: "m1" } as never], patientId: PATIENT };
  },
};
const deps = (): IdgDiscussionRouteDeps => ({
  isEnabled: async () => {
    flagReads += 1;
    if (flag === "throw") throw new Error("db down");
    return flag;
  },
  store,
  canViewChannel: async (_o, userId, channelId) => userId !== "outsider" && channelId === CH,
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function server(routeDeps: IdgDiscussionRouteDeps = deps()) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      ["member", "outsider"].map((userId) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    ctx.userId !== "outsider" ? target.id === CH : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgDiscussionRoutes(
    app,
    {
      read: requirePermission("messaging.read") as PreHandler,
      viewChannel: requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as PreHandler,
    },
    routeDeps,
  );
  return app;
}
const get = (app: ReturnType<typeof server>, user: string | null, id = CH, query = "") =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/channels/${id}/idg-discussions${query}`,
    headers: user ? { "x-test-user": user } : {},
  });

beforeEach(() => {
  listCalls = [];
  flagReads = 0;
  flag = true;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /messaging/channels/:id/idg-discussions", () => {
  it("returns the discussions and the channel's patient to a member when the flags are on, default limit 50", async () => {
    const app = server();
    const res = await get(app, "member");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      discussions: [{ messageId: "m1" }],
      patientId: PATIENT,
    });
    expect(listCalls).toEqual([{ userId: "member", channelId: CH, limit: 50 }]);
    await app.close();
  });

  it("answers enabled:false and never touches the store when the flag is off or unreadable", async () => {
    for (const f of [false, "throw"] as const) {
      flag = f;
      const app = server();
      const res = await get(app, "member");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, discussions: [], patientId: null });
      await app.close();
    }
    expect(listCalls).toEqual([]);
  });

  it("is disabled by default when the boot supplies no deps", async () => {
    const app = server({ ...DISABLED_IDG_DISCUSSIONS, canViewChannel: deps().canViewChannel });
    expect((await get(app, "member")).json()).toEqual({
      enabled: false,
      discussions: [],
      patientId: null,
    });
    await app.close();
  });

  it("refuses a non-member exactly as a random channel, and a malformed id with 404, before flag and store", async () => {
    const app = server();
    const outsider = await get(app, "outsider");
    const random = await get(app, "member", "99999999-9999-4999-8999-999999999999");
    const malformed = await get(app, "member", "nope");
    // The channel guard's denial (the pin list's own); the non-member answer is the answer a random channel gets.
    expect(outsider.statusCode).toBeGreaterThanOrEqual(403);
    expect(outsider.statusCode).toBe(random.statusCode);
    expect(outsider.json().error?.code ?? outsider.json().code).toBe(
      random.json().error?.code ?? random.json().code,
    );
    expect(malformed.statusCode).toBe(404);
    expect(flagReads).toBe(0);
    expect(listCalls).toEqual([]);
    await app.close();
  });

  it("is 401 anonymous", async () => {
    const app = server();
    expect((await get(app, null)).statusCode).toBe(401);
    await app.close();
  });

  it("re-checks channel visibility itself when the guard is bypassed", async () => {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: "outsider",
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
        },
      ]).store,
    );
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    const pass: PreHandler = async () => {};
    registerIdgDiscussionRoutes(app, { read: pass, viewChannel: pass }, deps());
    expect((await get(app as never, "outsider")).statusCode).toBe(404);
    expect(listCalls).toEqual([]);
    await app.close();
  });

  it("accepts limits 1..100 and rejects 0, 101 and non-numbers", async () => {
    const app = server();
    expect((await get(app, "member", CH, "?limit=1")).statusCode).toBe(200);
    expect((await get(app, "member", CH, "?limit=100")).statusCode).toBe(200);
    expect(listCalls.map((c) => c.limit)).toEqual([1, 100]);
    for (const bad of ["0", "101", "abc", "-5"]) {
      expect((await get(app, "member", CH, `?limit=${bad}`)).statusCode, bad).toBe(422);
    }
    await app.close();
  });

  it("is read-audited as one list event with the patient taken from the payload,", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = server();
    // Route options are captured on registration of a second instance of the same routes.
    const probe = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    probe.addHook("onRoute", (route) => {
      seen.push((route.config ?? {}) as Record<string, unknown>);
    });
    registerIdgDiscussionRoutes(
      probe,
      { read: async () => {}, viewChannel: async () => {} },
      deps(),
    );
    const config = seen.find((c) => c.auditRead);
    expect(config?.auditRead).toEqual({
      resourceKind: "message",
      list: true,
      patientIdPayloadPath: "patientId",
    });
    await app.close();
    await probe.close();
  });
});

describe("buildIdgDiscussionDeps flag", () => {
  const build = (flags: Record<string, boolean>) =>
    buildIdgDiscussionDeps({ db: {} as never, flags: { forOrg: async () => flags } });

  it.each([
    [{ "messaging.idg": true, "messaging.clinical_links": true }, true],
    [{ "messaging.idg": true }, false],
    [{ "messaging.clinical_links": true }, false],
    [{}, false],
  ])("enabled only when both flags are on: %j => %s", async (flags, expected) => {
    expect(await build(flags).isEnabled(ORG)).toBe(expected);
  });

  it("is off with no flag reader", async () => {
    expect(await buildIdgDiscussionDeps({ db: {} as never }).isEnabled(ORG)).toBe(false);
  });
});
