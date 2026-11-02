// GAP-115 — POST /api/v1/funeral/invite (M2 §4.1, §3.6): a per-deceased funeral-home magic link, 72h, one-time.
// Gated like the collaborator link (session + caseload ABAC), fail-closed on the one M5 fact it needs.
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
import { FUNERAL_LINK_TTL_SEC } from "../src/modules/02-identity/identity-ports";
import {
  type IdentityRouteDeps,
  createContextActorResolver,
  createInMemoryAuditExecutor,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  registerIdentityRoutes,
} from "../src/modules/02-identity/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.sessionId = "sess";
  request.context.attributes.membershipId = `m_${user}`;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

const NURSE = { "x-test-user": "rn_1", "x-test-org": "org_a" };
const NOBODY = { "x-test-user": "nobody", "x-test-org": "org_a" };
const DECEASED = "11111111-1111-4111-8111-111111111111";
const LIVING = "22222222-2222-4222-8222-222222222222";
const FH = "33333333-3333-4333-8333-333333333333";
const FH_NO_BAA = "44444444-4444-4444-8444-444444444444";

function makeServer(
  opts: { deceasedReader?: boolean; onCaseload?: boolean; baaReader?: "ok" | "unbound" | "throws" } = {},
) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: "org_a",
        userId: "rn_1",
        grants: [
          { roleKey: "rn", enabled: true, expiresAt: null, permissionKeys: ["funeral.invite"] },
        ],
      },
    ]).store,
  );
  registerAbacRegistry(
    createPredicateRegistry({ caseload_membership: () => opts.onCaseload ?? true }),
  );
  const memberships = createInMemoryMembershipRepository([]);
  const collaborators = createInMemoryCollaboratorLinkStore();
  const auditSink = createInMemoryAuditExecutor();
  const published: string[] = [];
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const deps: IdentityRouteDeps = {
    actors: createContextActorResolver(),
    memberships: memberships.repo,
    sessions: createInMemorySessionWriter().writer,
    invitations: createInMemoryInvitationStore().store,
    collaborators: collaborators.store,
    users: createInMemoryUserDirectory(memberships.repo).directory,
    audit: auditSink.executor,
    outbox: {
      async publish(e) {
        published.push(e.eventName);
      },
    },
    ...(opts.baaReader === "unbound"
      ? {}
      : {
          funeralHomeBaaActive: async (_org: string, funeralHomeId: string) => {
            if (opts.baaReader === "throws") throw new Error("mdm down");
            return funeralHomeId === FH;
          },
        }),
    ...(opts.deceasedReader === false
      ? {}
      : { deceasedPatients: { isDeceased: async (_org, id) => id === DECEASED } }),
  };
  registerIdentityRoutes(app, deps);
  return { app, collaborators, auditSink, published };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("POST /api/v1/funeral/invite", () => {
  it("mints a 72h link for a deceased patient: audited, published, token never in the body", async () => {
    const { app, collaborators, auditSink, published } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: DECEASED, funeralHomeId: FH },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "linkId"]);
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan((FUNERAL_LINK_TTL_SEC - 60) * 1000);
    expect(ttlMs).toBeLessThanOrEqual(FUNERAL_LINK_TTL_SEC * 1000);
    expect(auditSink.rows.some((r) => r.eventType === "m2.funeral.invited")).toBe(true);
    expect(published).toEqual(["m2.funeral.invited"]);

    // The link is one-time and yields the funeral-home session class.
    const token = collaborators.tokenFor(DECEASED) as string;
    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/collaborators/consume",
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json().sessionClass).toBe("funeral_home");
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/collaborators/consume",
      payload: { token },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("refuses a patient who is not deceased (409) and mints nothing", async () => {
    const { app, collaborators } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: LIVING, funeralHomeId: FH },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PATIENT_NOT_DECEASED");
    expect(collaborators.tokenFor(LIVING)).toBeUndefined();
    await app.close();
  });

  it("fails closed (503) when no deceased-status reader is bound", async () => {
    const { app } = makeServer({ deceasedReader: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: DECEASED, funeralHomeId: FH },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DECEASED_STATUS_UNAVAILABLE");
    await app.close();
  });

  it("needs funeral.invite and the caseload ABAC (403 each)", async () => {
    const noKey = makeServer();
    expect(
      (
        await noKey.app.inject({
          method: "POST",
          url: "/api/v1/funeral/invite",
          headers: NOBODY,
          payload: { patientId: DECEASED, funeralHomeId: FH },
        })
      ).statusCode,
    ).toBe(403);
    await noKey.app.close();

    resetAuthorizationContract();
    resetRbacEngine();
    const offCaseload = makeServer({ onCaseload: false });
    expect(
      (
        await offCaseload.app.inject({
          method: "POST",
          url: "/api/v1/funeral/invite",
          headers: NURSE,
          payload: { patientId: DECEASED, funeralHomeId: FH },
        })
      ).statusCode,
    ).toBe(403);
    await offCaseload.app.close();
  });

  it("refuses 409 FUNERAL_HOME_BAA_REQUIRED without an executed BAA for that funeral home, and writes no link, audit or event", async () => {
    const { app, collaborators, auditSink, published } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: DECEASED, funeralHomeId: FH_NO_BAA },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("FUNERAL_HOME_BAA_REQUIRED");
    expect(collaborators.tokenFor(DECEASED)).toBeUndefined();
    expect(auditSink.rows).toHaveLength(0);
    expect(published).toEqual([]);
    await app.close();
  });

  it("fails closed (503 FUNERAL_BAA_UNAVAILABLE) when the BAA reader is unbound, and (409) when it throws", async () => {
    const unbound = makeServer({ baaReader: "unbound" });
    const a = await unbound.app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: DECEASED, funeralHomeId: FH },
    });
    expect(a.statusCode).toBe(503);
    expect(a.json().error.code).toBe("FUNERAL_BAA_UNAVAILABLE");
    expect(unbound.collaborators.tokenFor(DECEASED)).toBeUndefined();
    await unbound.app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    const throws = makeServer({ baaReader: "throws" });
    const b = await throws.app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: { patientId: DECEASED, funeralHomeId: FH },
    });
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe("FUNERAL_HOME_BAA_REQUIRED");
    expect(throws.collaborators.tokenFor(DECEASED)).toBeUndefined();
    await throws.app.close();
  });

  it("a missing or malformed funeralHomeId is 422", async () => {
    const { app } = makeServer();
    for (const payload of [{ patientId: DECEASED }, { patientId: DECEASED, funeralHomeId: "not-a-uuid" }]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/funeral/invite", headers: NURSE, payload });
      expect(res.statusCode).toBe(422);
    }
    await app.close();
  });

  it("a missing patientId is 422", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: NURSE,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
