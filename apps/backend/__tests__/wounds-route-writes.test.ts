// WF09 — the guards on the wound WRITE routes (M9): an AI principal is refused, and the three routes that append a row (register a
// wound, add an observation, correct one) require an Idempotency-Key, so a retry after a lost reply cannot record a second open
// wound or a duplicate observation. Over a stub service: the rules live in the pre-handlers, ahead of any service call.
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerWoundRoutes } from "../src/modules/09-assessments/wounds/routes";
import type { WoundRouteService } from "../src/modules/09-assessments/wounds/service";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const WOUND = "22222222-2222-4222-8222-222222222222";
const OBSERVATION = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "77777777-7777-4777-8777-000000000001";
const base = `/api/v1/patients/${PATIENT}/wounds`;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
  request.context.attributes.membershipId = MEMBERSHIP;
  const kind = request.headers["x-test-actor-kind"];
  request.context.attributes.actorKind = typeof kind === "string" ? kind : "user";
}

const stubService = () => {
  const stub = {
    createWound: vi.fn(async () => ({ id: WOUND })),
    recordObservation: vi.fn(async () => ({ id: OBSERVATION })),
    correctObservation: vi.fn(async () => ({ id: OBSERVATION })),
    resolveWound: vi.fn(async () => ({ id: WOUND })),
  };
  return { stub, service: stub as unknown as WoundRouteService };
};

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["assessment.read", "assessment.author", "assessment.amend"],
          },
        ],
      },
    ]).store,
  );
  resetAbacRegistry();
  const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
  registry.register("caseload_or_scope", async () => true);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const { stub, service } = stubService();
  registerWoundRoutes(app, { service });
  return { app, stub };
}

const RN = { "x-test-user": "rn_1" };
const AI = { ...RN, "x-test-actor-kind": "ai_agent" };
let keyCounter = 0;
const withKey = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  "idempotency-key": `wound-write-${++keyCounter}`,
});
const heel = {
  siteCode: "heel",
  laterality: "left",
  etiology: "pressure_injury",
  acquired: "present_on_admission",
};
const correction = { correctionReason: "entry_error" };

/** The four write routes with a body that passes validation, each with its extra headers (a correction needs If-Match). */
const WRITES = [
  { name: "register a wound", url: base, payload: heel, extra: {} },
  { name: "add an observation", url: `${base}/${WOUND}/observations`, payload: {}, extra: {} },
  {
    name: "correct an observation",
    url: `${base}/${WOUND}/observations/${OBSERVATION}/corrections`,
    payload: correction,
    extra: { "if-match": "1" },
  },
  {
    name: "resolve a wound",
    url: `${base}/${WOUND}/resolve`,
    payload: { status: "healed" },
    extra: {},
  },
] as const;

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

describe("wound write routes refuse an AI principal", () => {
  it.each(WRITES)("$name: 403 and no service call", async ({ url, payload, extra }) => {
    const { app, stub } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: withKey({ ...AI, ...extra }),
      payload,
    });
    expect(res.statusCode).toBe(403);
    for (const fn of Object.values(stub)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the routes that append a row require an Idempotency-Key", () => {
  it.each(WRITES.slice(0, 3))(
    "$name: 400 IDEMPOTENCY_KEY_REQUIRED without one, and no service call",
    async ({ url, payload, extra }) => {
      const { app, stub } = makeServer();
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...RN, ...extra },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      for (const fn of Object.values(stub)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("registering a wound and adding an observation reach the service with a key", async () => {
    const { app, stub } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: base,
      headers: withKey(RN),
      payload: heel,
    });
    expect(created.statusCode).toBe(201);
    expect(stub.createWound).toHaveBeenCalledTimes(1);
    const observed = await app.inject({
      method: "POST",
      url: `${base}/${WOUND}/observations`,
      headers: withKey(RN),
      payload: {},
    });
    expect(observed.statusCode).toBe(201);
    expect(stub.recordObservation).toHaveBeenCalledTimes(1);
  });

  it("resolving a wound is one-way and needs no key: a human with the permission reaches the service", async () => {
    const { app, stub } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${base}/${WOUND}/resolve`,
      headers: RN,
      payload: { status: "healed" },
    });
    expect(res.statusCode).toBe(200);
    expect(stub.resolveWound).toHaveBeenCalledTimes(1);
  });
});
