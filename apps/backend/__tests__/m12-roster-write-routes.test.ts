// apps/backend/__tests__/m12-roster-write-routes.test.ts — HTTP-layer proof of the prescriber-roster WRITES
// (`POST /api/v1/admin/dosespot-prescribers/:membershipId/enroll` and `/revoke`) over the REAL Authorization Contract and a
// recording service: a fresh step-up, a human actor and an Idempotency-Key are all required, and the link's asserter handed to
// the service is the session's MEMBERSHIP id (`attributes.membershipId`), never the Better Auth user id.
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
import { registerDoseSpotRoutes } from "../src/modules/12-dosespot/routes/dosespot-routes";
import type { MedicationOrderRouteService } from "../src/modules/12-dosespot/routes/service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ACTING_MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";
const TARGET = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const PHYSICIAN = "77777777-7777-4777-8777-777777777777";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.attributes.membershipId = ACTING_MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

function makeServer() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    async enrollPrescriber(...args: unknown[]) {
      calls.push({ method: "enroll", args });
      return {
        membershipId: TARGET,
        enrolled: true,
        deaAuthorizedSchedules: [],
        ial2Status: "not_started",
        externalPhysicianMdmId: PHYSICIAN,
      };
    },
    async revokePrescriber(...args: unknown[]) {
      calls.push({ method: "revoke", args });
      return { status: "revoked" };
    },
  } as unknown as MedicationOrderRouteService;
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "roster_user_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["prescribing.admin.roster"],
          },
        ],
      },
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDoseSpotRoutes(app, { service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "roster_user_1", "x-test-step-up": "1" };
let seq = 0;
const idem = () => ({ "idempotency-key": `roster-${++seq}` });
const BASE = `/api/v1/admin/dosespot-prescribers/${TARGET}`;

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

describe("prescriber-roster write routes", () => {
  const WRITES = [
    { url: `${BASE}/enroll`, payload: { externalPhysicianMdmId: PHYSICIAN } },
    { url: `${BASE}/revoke`, payload: { reason: "left the practice" } },
  ] as const;

  for (const w of WRITES) {
    it(`POST ${w.url}: refuses a stale step-up, an AI actor and a missing Idempotency-Key`, async () => {
      const { app, calls } = makeServer();
      const send = (headers: Record<string, string>) =>
        app.inject({ method: "POST", url: w.url, headers, payload: w.payload });
      const stale = await send({ "x-test-user": "roster_user_1", ...idem() });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error?.code ?? stale.json().code).toBe("STEP_UP_REQUIRED");
      expect(
        (await send({ ...ADMIN, "x-test-actor-kind": "ai_agent", ...idem() })).statusCode,
      ).toBe(403);
      const missingKey = await send(ADMIN);
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json().error?.code ?? missingKey.json().code).toBe(
        "IDEMPOTENCY_KEY_REQUIRED",
      );
      expect(calls).toEqual([]);
      await app.close();
    });
  }

  it("enroll hands the service the session's MEMBERSHIP id as the linker, not the user id", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/enroll`,
      headers: { ...ADMIN, ...idem() },
      payload: { externalPhysicianMdmId: PHYSICIAN },
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toEqual([
      { method: "enroll", args: [ORG, TARGET, [], PHYSICIAN, ACTING_MEMBERSHIP] },
    ]);
    expect(calls[0]?.args).not.toContain("roster_user_1");
    await app.close();
  });

  it("revoke reaches the service for the path's membership in the session's org", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/revoke`,
      headers: { ...ADMIN, ...idem() },
      payload: { reason: "left the practice" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ method: "revoke", args: [ORG, TARGET, "left the practice"] }]);
    await app.close();
  });
});
