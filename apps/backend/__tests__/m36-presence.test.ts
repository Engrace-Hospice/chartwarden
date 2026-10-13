// WP 2.12 - presence/typing: the in-memory store (throttle, TTL expiry on an injected clock), the Valkey store's script
// contract over a fake client, and the routes (flag off writes nothing, member-only, cross-tenant, typed disabled answer).
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
import type { DbClient } from "@wardenx/db";
import { createInMemoryMessagingService } from "@wardenx/messaging";
import type { IdempotencyStore } from "@wardenx/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { cacheFlagRead } from "../src/modules/36-messaging/presence/binding";
import {
  PRESENCE_LIST_LIMIT,
  type PresenceStore,
  createInMemoryPresenceStore,
} from "../src/modules/36-messaging/presence/presence-store";
import { createValkeyPresenceStore } from "../src/modules/36-messaging/presence/valkey-presence-store";
import { registerPresenceRoutes } from "../src/modules/36-messaging/routes/presence-routes";

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const OTHER_CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c5c5";
const scope = { organizationId: ORG, channelId: CH };

describe("in-memory presence store", () => {
  it("lists a marked user until the TTL passes (injected clock)", async () => {
    let now = 1_000;
    const store = createInMemoryPresenceStore(() => now, {
      presenceTtlMs: 60_000,
      typingTtlMs: 6_000,
      throttleMs: 3_000,
    });
    await store.mark(scope, "u1", "present");
    await store.mark(scope, "u1", "typing");
    expect(await store.list(scope, "present")).toEqual(["u1"]);
    now += 6_000;
    expect(await store.list(scope, "typing")).toEqual([]);
    expect(await store.list(scope, "present")).toEqual(["u1"]);
    now += 54_000;
    expect(await store.list(scope, "present")).toEqual([]);
  });

  it("throttles a second write inside the window and accepts one after it", async () => {
    let now = 0;
    const store = createInMemoryPresenceStore(() => now);
    expect(await store.mark(scope, "u1", "present")).toBe("written");
    now += 2_999;
    expect(await store.mark(scope, "u1", "present")).toBe("throttled");
    expect(await store.mark(scope, "u1", "typing")).toBe("written"); // kinds throttle independently
    now += 1;
    expect(await store.mark(scope, "u1", "present")).toBe("written");
  });

  it("keeps channels and organisations apart", async () => {
    const store = createInMemoryPresenceStore();
    await store.mark(scope, "u1", "present");
    expect(await store.list({ ...scope, channelId: OTHER_CH }, "present")).toEqual([]);
    expect(await store.list({ ...scope, organizationId: "org_b" }, "present")).toEqual([]);
  });
});

describe("valkey presence store (script contract over a fake client)", () => {
  it("passes ids only, hash-tagged keys and the configured TTL/throttle, and maps the result", async () => {
    const calls: unknown[][] = [];
    const store = createValkeyPresenceStore(
      {
        eval: async (...args) => {
          calls.push(args);
          return args[1] === 2 ? 1 : ["u1", "u2"];
        },
      },
      { presenceTtlMs: 1_000, typingTtlMs: 500, throttleMs: 200 },
    );
    expect(await store.mark(scope, "u1", "typing")).toBe("written");
    expect(await store.list(scope, "present")).toEqual(["u1", "u2"]);
    const [, , setKey, throttleKey, member, ttl, throttle] = calls[0] as [
      string,
      number,
      string,
      string,
      string,
      number,
      number,
    ];
    expect(setKey).toBe(`presence:{${ORG}:${CH}}:typing`);
    expect(throttleKey).toBe(`${setKey}:throttle:u1`);
    expect([member, ttl, throttle]).toEqual(["u1", 500, 200]);
    expect(calls[1]?.slice(2)).toEqual([`presence:{${ORG}:${CH}}:present`, PRESENCE_LIST_LIMIT]);
  });

  it("reports throttled when the script answers 0", async () => {
    const store = createValkeyPresenceStore({ eval: async () => 0 });
    expect(await store.mark(scope, "u1", "present")).toBe("throttled");
  });
});

const ORG_B = "org_b";
const tenants: Record<string, string> = { rn_1: ORG, rn_2: ORG, rn_out: ORG, rn_b: ORG_B };

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = tenants[user] ?? ORG;
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

function makeServer(opts: {
  enabled: boolean | "throws";
  store: PresenceStore;
  idempotencyStore?: IdempotencyStore;
}) {
  const messaging = createInMemoryMessagingService({
    seed: {
      eligibleStaff: ["rn_1", "rn_2", "rn_out"].map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["clinical_rn"],
      })),
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_1",
          members: [{ userId: "rn_1" }, { userId: "rn_2" }],
        },
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore(
    Object.entries(tenants).map(([userId, orgId]) => ({
      orgId,
      userId,
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["messaging.read"] },
      ],
    })),
  );
  registerEffectivePermissionResolver(grants.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    typeof target.id === "string" && ctx.organizationId && ctx.userId
      ? messaging.canViewChannel(ctx.organizationId, ctx.userId, target.id)
      : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({
    db: {} as DbClient,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
    ...(opts.idempotencyStore ? { idempotencyStore: opts.idempotencyStore } : {}),
  });
  registerPresenceRoutes(
    app,
    {
      store: opts.store,
      isEnabled: async () => {
        if (opts.enabled === "throws") throw new Error("flag db down");
        return opts.enabled;
      },
    },
    {
      read: requirePermission("messaging.read") as (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<void>,
      viewChannel: requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<void>,
    },
  );
  return app;
}

const as = (user: string) => ({ "x-test-user": user });
const url = (channel = CH) => `/api/v1/messaging/channels/${channel}/presence`;

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

describe("presence routes", () => {
  it("flag off: a member gets the typed disabled answer and nothing is written", async () => {
    const store = createInMemoryPresenceStore();
    const app = makeServer({ enabled: false, store });
    const post = await app.inject({ method: "POST", url: url(), headers: as("rn_1"), payload: {} });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe("PRESENCE_DISABLED");
    const get = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect(get.statusCode).toBe(403);
    expect(await store.list(scope, "present")).toEqual([]);
    expect(await store.list(scope, "typing")).toEqual([]);
    await app.close();
  });

  it("flag on: a heartbeat is visible to another member; typing implies present; repeats are 204 no-ops", async () => {
    const store = createInMemoryPresenceStore();
    const app = makeServer({ enabled: true, store });
    const beat = await app.inject({ method: "POST", url: url(), headers: as("rn_1") });
    expect(beat.statusCode).toBe(204);
    const typing = await app.inject({
      method: "POST",
      url: url(),
      headers: as("rn_2"),
      payload: { typing: true },
    });
    expect(typing.statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: url(), headers: as("rn_1") })).statusCode).toBe(
      204,
    ); // throttled: still 204
    const seen = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect(seen.statusCode).toBe(200);
    expect([...seen.json().present].sort()).toEqual(["rn_1", "rn_2"]);
    expect(seen.json().typing).toEqual(["rn_2"]);
    await app.close();
  });

  it("a non-member and another tenant get exactly what a random channel id gets, on both verbs, and write nothing", async () => {
    const store = createInMemoryPresenceStore();
    const app = makeServer({ enabled: true, store });
    for (const user of ["rn_out", "rn_b"]) {
      const post = await app.inject({
        method: "POST",
        url: url(),
        headers: as(user),
        payload: { typing: true },
      });
      const get = await app.inject({ method: "GET", url: url(), headers: as(user) });
      const random = await app.inject({ method: "GET", url: url(OTHER_CH), headers: as(user) });
      expect(random.statusCode).toBeGreaterThanOrEqual(400);
      expect([post.statusCode, get.statusCode]).toEqual([random.statusCode, random.statusCode]);
      expect(get.json().error.code).toBe(random.json().error.code);
      expect(get.json().error.code).not.toBe("PRESENCE_DISABLED");
      expect(get.body.includes("rn_1")).toBe(false);
    }
    expect(await store.list(scope, "present")).toEqual([]);
    await app.close();
  });

  it("a flag-off tenant does not disclose the flag to a non-member (the guard's refusal, not PRESENCE_DISABLED)", async () => {
    const app = makeServer({ enabled: false, store: createInMemoryPresenceStore() });
    const res = await app.inject({ method: "GET", url: url(), headers: as("rn_out") });
    expect(res.json().error.code).not.toBe("PRESENCE_DISABLED");
    await app.close();
  });

  it("never reaches the idempotency store even when the web client sends an Idempotency-Key", async () => {
    const touched: string[] = [];
    const spy: IdempotencyStore = {
      load: async () => {
        touched.push("load");
        return null;
      },
      putPending: async () => {
        touched.push("putPending");
        return true;
      },
      complete: async () => {
        touched.push("complete");
      },
    };
    const app = makeServer({
      enabled: true,
      store: createInMemoryPresenceStore(),
      idempotencyStore: spy,
    });
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...as("rn_1"), "idempotency-key": "11111111-1111-4111-8111-111111111111" },
      payload: { typing: true },
    });
    expect(res.statusCode).toBe(204);
    expect(touched).toEqual([]);
    await app.close();
  });

  it("an unreadable flag answers 503 (retry), never the 403 that means genuinely off", async () => {
    const store = createInMemoryPresenceStore();
    const app = makeServer({ enabled: "throws", store });
    const post = await app.inject({ method: "POST", url: url(), headers: as("rn_1") });
    const get = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect([post.statusCode, get.statusCode]).toEqual([503, 503]);
    expect(await store.list(scope, "present")).toEqual([]);
    await app.close();
  });

  it("a store outage never fails the caller", async () => {
    const broken: PresenceStore = {
      mark: async () => {
        throw new Error("valkey down");
      },
      list: async () => {
        throw new Error("valkey down");
      },
    };
    const app = makeServer({ enabled: true, store: broken });
    expect((await app.inject({ method: "POST", url: url(), headers: as("rn_1") })).statusCode).toBe(
      204,
    );
    const get = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect(get.json()).toEqual({ present: [], typing: [] });
    await app.close();
  });
});

describe("cacheFlagRead", () => {
  it("reads once per org per window, expires on the injected clock, and never caches a failure", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const read = cacheFlagRead(
      async () => {
        calls++;
        if (fail) throw new Error("down");
        return true;
      },
      5_000,
      () => now,
    );
    expect(await read("a")).toBe(true);
    expect(await read("a")).toBe(true);
    expect(calls).toBe(1);
    await read("b");
    expect(calls).toBe(2);
    now = 5_000;
    fail = true;
    await expect(read("a")).rejects.toThrow("down");
    fail = false;
    expect(await read("a")).toBe(true);
    expect(calls).toBe(4);
  });
});
