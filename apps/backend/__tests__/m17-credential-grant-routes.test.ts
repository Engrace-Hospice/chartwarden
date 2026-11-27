// CW-AC-46 follow-up — the professional-licence roster's write routes (`membership_credential.grant` / `.revoke`) through the FULL M1
// middleware chain (Fastify `inject`), no live infra: the REAL Authorization Contract gates each route on its permission, step-up is
// the real M3 decision over the session seam, and the in-memory M17 service backs the writes. Proves: a stale step-up is refused
// with STEP_UP_REQUIRED and nothing is written (grant and revoke), a self-grant is refused 403 CREDENTIAL_SELF_GRANT_REFUSED even
// with a fresh step-up and is recorded for the audit, another member's grant works and names the grantor, and a revoke of one's own
// licence is allowed (it only removes a fact). Synthetic ids only.
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  isStepUpRecent,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import {
  SchedulingRouteService,
  buildSchedulingAbacPredicates,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";
import { createDrizzleCredentialStore } from "../src/modules/17-scheduling/seams/credentials-drizzle-store";

const ORG = "org_a";
const OTHER_ORG = "org_b";
const NOW = "2026-11-27T00:00:00.000Z";
/** Synthetic membership ids: the acting administrator, a second administrator, and the nurse whose licence is recorded. */
const ADMIN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ADMIN_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NURSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const STALE_AT = new Date(Date.now() - 10 * 60 * 1000);

const GRANT_PERMS = [
  "membership_credential.read",
  "membership_credential.grant",
  "membership_credential.revoke",
];
const PERMISSION_SEED = [
  { userId: ADMIN_1, permissions: GRANT_PERMS },
  { userId: ADMIN_2, permissions: GRANT_PERMS },
  { userId: VIEWER, permissions: ["membership_credential.read"] },
];

function stepUpRecentPredicate(context: {
  organizationId: string;
  attributes: Record<string, unknown>;
}) {
  const sessionId =
    typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
  if (!sessionId || !context.organizationId) return Promise.resolve(false);
  return getSeam("SessionContextResolver")
    .resolveStepUpState({ orgId: context.organizationId }, sessionId)
    .then((state) => isStepUpRecent(state, STEP_UP_POLICY, Date.now()));
}

const session = (userId: string, lastStepUpAt: Date | null, organizationId = ORG) => ({
  sessionId: userId,
  userId,
  membershipId: userId,
  organizationId,
  roles: [],
  providerEntityIds: [],
  locationIds: [],
  lastStepUpAt,
  lastStepUpFactor: lastStepUpAt === null ? null : ("webauthn" as const),
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
});

/** The acting MEMBERSHIP id is the user id here (the routes read it as the grantor), as in the other M17 inject tests. */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

function makeServer() {
  const backend = new SchedulingRouteService({
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    seed: { disciplines: {}, credentialedMemberships: [], unassignedPoolOrgs: [] },
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSION_SEED.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
  resetAbacRegistry();
  const registry = createPredicateRegistry({
    ...M3_INTRINSIC_PREDICATES,
    step_up_recent: stepUpRecentPredicate,
  });
  for (const [name, predicate] of Object.entries(
    buildSchedulingAbacPredicates({ resolver: backend }),
  )) {
    registry.register(name, predicate);
  }
  registerAbacRegistry(registry);
  __resetSeamsForTest();
  const sessions = createInMemorySessionContextStore(
    PERMISSION_SEED.map((s) => session(s.userId, new Date())),
  );
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSchedulingRoutes(app, { service: backend, caseloadPatientIds: async () => [] });
  return { app, backend, sessions };
}

const as = (user: string, org = ORG) => ({ "x-test-user": user, "x-test-org": org });
let keySeq = 0;
const keyed = (user: string, org = ORG) => ({
  ...as(user, org),
  "idempotency-key": `cred-key-${++keySeq}`,
});
const GRANT_BODY = { credentialType: "rn", effectiveAt: "2026-01-01", issuingBody: "State Board" };
const grantUrl = (membershipId: string) => `/api/v1/memberships/${membershipId}/credentials`;

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

describe("POST /api/v1/memberships/:membershipId/credentials", () => {
  it("records another member's licence with a fresh step-up and names the grantor", async () => {
    const { app, backend } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: grantUrl(NURSE),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      membershipId: NURSE,
      credentialType: "rn",
      status: "active",
      grantedByMembershipId: ADMIN_1,
    });
    expect(backend.credentialSelfGrantRefusals).toEqual([]);
  });

  it("refuses a stale step-up with STEP_UP_REQUIRED and writes nothing", async () => {
    const { app, backend, sessions } = makeServer();
    sessions.put(session(ADMIN_1, STALE_AT));

    const res = await app.inject({
      method: "POST",
      url: grantUrl(NURSE),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(await backend.listCredentials(ORG, NURSE)).toEqual([]);
  });

  it("refuses a session that never stepped up", async () => {
    const { app, sessions } = makeServer();
    sessions.put(session(ADMIN_1, null));

    const res = await app.inject({
      method: "POST",
      url: grantUrl(NURSE),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
  });

  it("refuses a caller without the grant permission before any step-up", async () => {
    const { app, sessions } = makeServer();
    // a STALE session: were the step-up checked first, the answer would be STEP_UP_REQUIRED, not FORBIDDEN
    sessions.put(session(VIEWER, STALE_AT));

    const res = await app.inject({
      method: "POST",
      url: grantUrl(NURSE),
      headers: keyed(VIEWER),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("refuses a self-grant 403 CREDENTIAL_SELF_GRANT_REFUSED even with a fresh step-up, writes no row and records the refusal", async () => {
    const { app, backend } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: grantUrl(ADMIN_1),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("CREDENTIAL_SELF_GRANT_REFUSED");
    expect(body.error.message).not.toContain(ADMIN_1);
    expect(await backend.listCredentials(ORG, ADMIN_1)).toEqual([]);
    expect(backend.credentialSelfGrantRefusals).toEqual([
      { organizationId: ORG, membershipId: ADMIN_1, credentialType: "rn" },
    ]);
  });

  it("refuses a self-grant whose id differs only in letter case", async () => {
    const { app, backend } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: grantUrl(ADMIN_1.toUpperCase()),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CREDENTIAL_SELF_GRANT_REFUSED");
    expect(backend.credentialSelfGrantRefusals).toHaveLength(1);
  });

  it("answers the refusal even when recording it fails", async () => {
    const { app, backend } = makeServer();
    backend.recordCredentialSelfGrantRefusal = async () => {
      throw new Error("audit store down");
    };

    const res = await app.inject({
      method: "POST",
      url: grantUrl(ADMIN_1),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CREDENTIAL_SELF_GRANT_REFUSED");
  });

  it("lets a second administrator record the first one's licence (no second approver is required)", async () => {
    const { app } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: grantUrl(ADMIN_1),
      headers: keyed(ADMIN_2),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ membershipId: ADMIN_1, grantedByMembershipId: ADMIN_2 });
  });

  it("does not count another organization's session as a fresh step-up for this one", async () => {
    const { app, sessions } = makeServer();
    sessions.put(session(ADMIN_1, new Date(), OTHER_ORG));

    const res = await app.inject({
      method: "POST",
      url: grantUrl(NURSE),
      headers: keyed(ADMIN_1),
      payload: GRANT_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
  });
});

describe("the Drizzle credential store (the one place the row is written)", () => {
  it("refuses a self-grant before it opens any transaction: the backstop under the route", async () => {
    // No database is reachable from this object: a refusal that came from anywhere but the guard would throw a different error.
    const store = createDrizzleCredentialStore({} as never);

    await expect(
      store.grant(ORG, {
        membershipId: ADMIN_1,
        grantedByMembershipId: ADMIN_1.toUpperCase(),
        credentialType: "rn",
        effectiveAt: "2026-01-01",
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_SELF_GRANT_REFUSED", statusCode: 403 });
  });
});

describe("DELETE /api/v1/memberships/:membershipId/credentials/:credentialId", () => {
  const seedCredential = async (backend: SchedulingRouteService) =>
    backend.grantCredential(ORG, ADMIN_2, {
      membershipId: ADMIN_1,
      credentialType: "rn",
      effectiveAt: "2026-01-01",
    });
  const revokeUrl = (membershipId: string, credentialId: string) =>
    `/api/v1/memberships/${membershipId}/credentials/${credentialId}`;

  it("revokes with a fresh step-up", async () => {
    const { app, backend } = makeServer();
    const granted = await seedCredential(backend);

    const res = await app.inject({
      method: "DELETE",
      url: revokeUrl(ADMIN_1, granted.id),
      headers: keyed(ADMIN_2),
      payload: { reason: "licence lapsed" },
    });

    expect(res.statusCode).toBe(204);
    expect((await backend.listCredentials(ORG, ADMIN_1))[0]?.status).toBe("revoked");
  });

  it("refuses a stale step-up with STEP_UP_REQUIRED and revokes nothing", async () => {
    const { app, backend, sessions } = makeServer();
    const granted = await seedCredential(backend);
    sessions.put(session(ADMIN_2, STALE_AT));

    const res = await app.inject({
      method: "DELETE",
      url: revokeUrl(ADMIN_1, granted.id),
      headers: keyed(ADMIN_2),
      payload: { reason: "licence lapsed" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect((await backend.listCredentials(ORG, ADMIN_1))[0]?.status).toBe("active");
  });

  it("lets a member revoke their own licence (it only removes a fact)", async () => {
    const { app, backend } = makeServer();
    const granted = await seedCredential(backend);

    const res = await app.inject({
      method: "DELETE",
      url: revokeUrl(ADMIN_1, granted.id),
      headers: keyed(ADMIN_1),
      payload: { reason: "left the profession" },
    });

    expect(res.statusCode).toBe(204);
  });
});
