// WP 3.10 / Workflow D: "aide has no ordering route". Mounts the REAL M11 and M12 route registrars behind the REAL
// Authorization Contract with services that fail the test if reached, and proves an aide who can ask a nurse about a
// medication (messaging.read + messaging.send, even with prescribing.read) is refused every order-writing route before any
// handler or service runs. The live harness does not mount M11/M12, so this is the route-level half of live case 4.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerOrderRoutes } from "../src/modules/11-orders/routes/orders-routes";
import { registerDoseSpotRoutes } from "../src/modules/12-dosespot/routes/dosespot-routes";

const ORG = "org_a";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PATIENT = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";

let serviceTouched = false;
const trap = new Proxy(
  {},
  {
    get: () => async () => {
      serviceTouched = true;
      throw new Error("service reached");
    },
  },
);

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  request.context.attributes.membershipId = user;
}

const WRITES: ReadonlyArray<readonly ["POST" | "PATCH", string]> = [
  ["POST", "/api/v1/orders"],
  ["POST", "/api/v1/verbal-orders"],
  ["PATCH", `/api/v1/orders/${ID}`],
  ["POST", `/api/v1/orders/${ID}/request-signature`],
  ["POST", `/api/v1/orders/${ID}/sign`],
  ["POST", `/api/v1/orders/${ID}/sign-on-behalf`],
  ["POST", `/api/v1/orders/${ID}/verbal`],
  ["POST", "/api/v1/medication-orders"],
  ["PATCH", `/api/v1/medication-orders/${ID}`],
  ["POST", `/api/v1/medication-orders/${ID}/request-signature`],
  ["POST", `/api/v1/medication-orders/${ID}/sign`],
  ["POST", `/api/v1/medication-orders/${ID}/sign-controlled/initiate`],
];

function makeServer(permissionKeys: string[]) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "aide",
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      },
    ]).store,
  );
  registerAbacRegistry(createPredicateRegistry());
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrderRoutes(app, { service: trap as never, caseloadPatientIds: async () => [PATIENT] });
  registerDoseSpotRoutes(app, { service: trap as never });
  return app;
}

beforeEach(() => {
  serviceTouched = false;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("an aide who can ask a nurse about a medication has no ordering route", () => {
  it.each([
    ["messaging only", ["messaging.read", "messaging.send"]],
    [
      "messaging plus read-only prescribing and orders",
      ["messaging.read", "messaging.send", "prescribing.read", "orders.read"],
    ],
  ])("is refused every M11 and M12 order-writing route (%s)", async (_label, keys) => {
    const app = makeServer(keys);
    for (const [method, url] of WRITES) {
      const res = await app.inject({
        method,
        url,
        headers: { "x-test-user": "aide", "idempotency-key": `k-${method}-${url}` },
        payload: { patientId: PATIENT, patient_id: PATIENT, kind: "medication" },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(serviceTouched).toBe(false);
    await app.close();
  });
});
