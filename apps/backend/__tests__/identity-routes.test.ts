// apps/backend/__tests__/identity-routes.test.ts — M2-T06 identity route-inventory
// integration tests (M2 spec §4.1–4.2; the §7.1, §7.2, §7.5, §7.6 happy paths + §7.7 / D4
// boundary). Exercises the routes through the FULL M1 middleware chain (request-context +
// error envelope + security) via Fastify `inject` with no live infra: buildServer() mounts
// the foundation host, then registerIdentityRoutes() mounts the M2 routes with in-memory
// adapters. A header-auth shim populates request.context; the REAL Authorization Contract
// (M3-T10) then gates every admin route — `registerEffectivePermissionResolver` seeds the
// org_admin actor's §4.7 keys (member.invite / member.manage / user.deactivate / org.manage)
// so `requirePermission` resolves them, and a fresh predicate registry binds
// `caseload_membership` for the §7.6 collaborator route's `requireAbac`. This is the M2 routes
// flipping from the M1 deny-stub to the live contract (M2-T08 / M3-T10), staying gate-green.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type Actor,
  type IdentityRouteDeps,
  type MembershipRecord,
  createContextActorResolver,
  createFixedActorResolver,
  createInMemoryAuditExecutor,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  registerIdentityRoutes,
} from "../src/modules/02-identity/index";

/** Test-only auth shim: populate request.context from headers (mirrors api.test.ts). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const orgName = request.headers["x-test-orgname"];
  if (typeof orgName === "string") request.context.attributes.organizationName = orgName;
}

function membership(over: Partial<MembershipRecord> & { membershipId: string }): MembershipRecord {
  return {
    userId: "user_rn",
    organizationId: "org_a",
    organizationName: "Engrace",
    status: "active",
    isAdmin: false,
    defaultLocationIds: [],
    ...over,
  };
}

function makeServer(opts: { seed?: MembershipRecord[]; actors?: Actor | null | "context" } = {}) {
  const memberships = createInMemoryMembershipRepository(opts.seed ?? []);
  const sessions = createInMemorySessionWriter();
  const invitations = createInMemoryInvitationStore();
  const collaborators = createInMemoryCollaboratorLinkStore();
  const users = createInMemoryUserDirectory();
  const auditSink = createInMemoryAuditExecutor();
  const actors =
    opts.actors === undefined || opts.actors === "context"
      ? createContextActorResolver()
      : createFixedActorResolver(opts.actors);

  // The org_admin actor (ADMIN headers below) holds Module 2's §4.7 admin permission keys;
  // the contract resolver grants them so the flipped `requirePermission` guards allow.
  const grants = createInMemoryEffectivePermissionStore([
    {
      orgId: "org_a",
      userId: "admin_1",
      grants: [
        {
          roleKey: "org_admin",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["member.invite", "member.manage", "user.deactivate", "org.manage"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grants.store);
  // The §7.6 collaborator route gates on `caseload_membership`; in production M5/M17 register
  // the real CaseloadProvider-backed predicate — here a fresh registry binds it to "on caseload".
  registerAbacRegistry(createPredicateRegistry({ caseload_membership: () => true }));

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const deps: IdentityRouteDeps = {
    actors,
    memberships: memberships.repo,
    sessions: sessions.writer,
    invitations: invitations.store,
    collaborators: collaborators.store,
    users: users.directory,
    audit: auditSink.executor,
  };
  registerIdentityRoutes(app, deps);
  return { app, memberships, sessions, invitations, collaborators, users, auditSink };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_a", "x-test-roles": "org_admin" };

describe("M2-T06 identity route inventory", () => {
  // The Authorization Contract is global module state; reset to fail-closed defaults around
  // every case so resolver/predicate registrations don't bleed across tests (mirrors authz-routes).
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  describe("§7.2 traveling nurse — memberships + one-time org binding", () => {
    const seed = [
      membership({ membershipId: "m_a", organizationId: "org_a", organizationName: "Engrace" }),
      membership({
        membershipId: "m_b",
        organizationId: "org_b",
        organizationName: "Second Agency",
      }),
    ];

    it("GET /auth/memberships lists the user's memberships (pre-org)", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/memberships",
        headers: { "x-test-user": "user_rn" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().memberships).toHaveLength(2);
      await app.close();
    });

    it("unauthenticated → 401 envelope", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/memberships" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("select-organization binds the chosen org (200)", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/select-organization",
        headers: { "x-test-user": "user_rn" },
        payload: { organizationId: "org_a" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        activeOrganizationId: "org_a",
        organizationName: "Engrace",
      });
      await app.close();
    });

    it("selecting an org without an active membership → 403 NO_ACTIVE_MEMBERSHIP", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/select-organization",
        headers: { "x-test-user": "user_rn" },
        payload: { organizationId: "org_x" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("NO_ACTIVE_MEMBERSHIP");
      await app.close();
    });

    it("a second binding on an already-bound session → 409 ORG_ALREADY_BOUND", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/select-organization",
        headers: { "x-test-user": "user_rn", "x-test-org": "org_a" }, // already org-bound
        payload: { organizationId: "org_b" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ORG_ALREADY_BOUND");
      await app.close();
    });
  });

  describe("§7.1 invite & onboard a clinician", () => {
    it("admin invites → 201 (token never in body) + redacted m2.user.invited audit", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: { ...ADMIN, "x-test-orgname": "Engrace" },
        payload: {
          email: "rn@example.com",
          proposedRoleKeys: ["clinical_rn"],
          proposedDefaultLocationIds: ["loc_1"],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().invitationId).toBeTruthy();
      expect(res.body).not.toContain("token");
      const row = auditSink.rows.find((r) => r.eventType === "m2.user.invited");
      expect(row?.retentionClass).toBe("compliance");
      expect((row?.after as { email: string }).email).toBe("[REDACTED]"); // denylist applied
      await app.close();
    });

    it("non-admin caller → 403 FORBIDDEN (real RBAC: lacks member.invite)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: { "x-test-user": "rn_1", "x-test-org": "org_a" }, // no member.invite grant
        payload: { email: "x@example.com" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a path org other than the bound org → 403 (server-side org binding)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_b/invitations", // bound to org_a
        headers: ADMIN,
        payload: { email: "x@example.com" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("duplicate pending invite for the same email → 409 PENDING_INVITE_EXISTS", async () => {
      const { app } = makeServer();
      const invite = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/orgs/org_a/invitations",
          headers: ADMIN,
          payload: { email: "dup@example.com" },
        });
      expect((await invite()).statusCode).toBe(201);
      expect((await invite()).statusCode).toBe(409);
      await app.close();
    });

    it("invitee accepts the token → active membership; double-accept → 409 LINK_ALREADY_USED", async () => {
      const { app, invitations, auditSink } = makeServer();
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: { ...ADMIN, "x-test-orgname": "Engrace" },
        payload: { email: "new@example.com", proposedDefaultLocationIds: ["loc_9"] },
      });
      const token = invitations.tokenFor("new@example.com");
      expect(token).toBeTruthy();

      const accept = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: { "x-test-user": "new_user" },
          payload: { token },
        });

      const first = await accept();
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ organizationId: "org_a", status: "active" });
      expect(auditSink.rows.some((r) => r.eventType === "m2.membership.accepted")).toBe(true);

      const second = await accept();
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("LINK_ALREADY_USED");
      await app.close();
    });
  });

  describe("§7.5 offboard — member lifecycle + last-admin lockout guard", () => {
    const seed = () => [
      membership({ membershipId: "adm_1", userId: "admin_1", isAdmin: true }),
      membership({ membershipId: "adm_2", userId: "admin_2", isAdmin: true }),
      membership({ membershipId: "rn_1", userId: "rn_user" }),
    ];

    it("GET /orgs/:id/members lists the org's memberships", async () => {
      const { app } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/members",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().members).toHaveLength(3);
      // FB-T11 — the view now carries userId (the staff-facet identity key).
      expect(res.json().members[0]).toHaveProperty("userId");
      await app.close();
    });

    it("GET /orgs/:id/members?q narrows the roster by user identity (FB-T11 staff facet)", async () => {
      const { app } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/members?q=rn_user",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      const members = res.json().members as Array<{ membershipId: string; userId: string }>;
      expect(members).toHaveLength(1);
      expect(members[0]!.membershipId).toBe("rn_1");
      await app.close();
    });

    it("PATCH suspends a membership → 200 + m2.membership.suspended audit", async () => {
      const { app, auditSink } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/orgs/org_a/members/rn_1",
        headers: ADMIN,
        payload: { status: "suspended" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("suspended");
      expect(auditSink.rows.some((r) => r.eventType === "m2.membership.suspended")).toBe(true);
      await app.close();
    });

    it("DELETE revokes a membership → reaps its sessions + m2.membership.revoked audit", async () => {
      const { app, sessions, auditSink } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/orgs/org_a/members/rn_1",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(sessions.revokedMemberships()).toContain("rn_1");
      expect(auditSink.rows.some((r) => r.eventType === "m2.membership.revoked")).toBe(true);
      await app.close();
    });

    it("suspending the last active admin → 409 LAST_ADMIN", async () => {
      const { app } = makeServer({
        seed: [membership({ membershipId: "only_adm", userId: "admin_1", isAdmin: true })],
      });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/orgs/org_a/members/only_adm",
        headers: ADMIN,
        payload: { status: "suspended" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("LAST_ADMIN");
      await app.close();
    });

    it("deactivating a user disables creds everywhere + reaps all sessions", async () => {
      const { app, users, sessions, auditSink } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/rn_user/deactivate",
        headers: ADMIN,
        payload: { reason: "left the company" },
      });
      expect(res.statusCode).toBe(200);
      expect(users.isDeactivated("rn_user")).toBe(true);
      expect(sessions.revokedUsers()).toContain("rn_user");
      expect(auditSink.rows.some((r) => r.eventType === "m2.user.deactivated")).toBe(true);
      await app.close();
    });
  });

  describe("§7.6 external collaborator — per-patient magic-link", () => {
    const STAFF: Actor = {
      userId: "rn_user",
      sessionId: "sess_rn",
      organizationId: "org_a",
      membershipId: "mem_rn",
      roles: ["clinical_rn"],
    };

    it("staff mints a per-patient link (201, token not in body), then it consumes once", async () => {
      const { app, collaborators, auditSink } = makeServer({ actors: STAFF });
      const invite = await app.inject({
        method: "POST",
        url: "/api/v1/collaborators/invite",
        headers: { "x-test-user": "rn_user", "x-test-org": "org_a" },
        payload: { patientId: "pat_1" },
      });
      expect(invite.statusCode).toBe(201);
      expect(invite.json().linkId).toBeTruthy();
      expect(invite.body).not.toContain("token");
      expect(auditSink.rows.some((r) => r.eventType === "m2.collaborator.invited")).toBe(true);

      const token = collaborators.tokenFor("pat_1");
      const consume = await app.inject({
        method: "POST",
        url: "/api/v1/collaborators/consume",
        payload: { token },
      });
      expect(consume.statusCode).toBe(200);
      expect(consume.json()).toMatchObject({
        sessionClass: "external_collaborator",
        scope: { patientId: "pat_1" },
      });
      const started = auditSink.rows.find((r) => r.eventType === "m2.collaborator.session_started");
      expect(started?.actorKind).toBe("external_collaborator");
      await app.close();
    });

    it("consuming the same link twice → 409 LINK_ALREADY_USED", async () => {
      const { app, collaborators } = makeServer({ actors: STAFF });
      await app.inject({
        method: "POST",
        url: "/api/v1/collaborators/invite",
        headers: { "x-test-user": "rn_user", "x-test-org": "org_a" },
        payload: { patientId: "pat_2" },
      });
      const token = collaborators.tokenFor("pat_2");
      const consume = () =>
        app.inject({ method: "POST", url: "/api/v1/collaborators/consume", payload: { token } });
      expect((await consume()).statusCode).toBe(200);
      const second = await consume();
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("LINK_ALREADY_USED");
      await app.close();
    });

    it("an unknown/expired link token → 410 LINK_EXPIRED", async () => {
      const { app } = makeServer({ actors: STAFF });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/collaborators/consume",
        payload: { token: "does-not-exist" },
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe("LINK_EXPIRED");
      await app.close();
    });
  });

  describe("§7.7 auditor — boundary (D4: served by M3, not M2)", () => {
    it("POST /api/v1/auditors/invite is NOT mounted by M2 → 404", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auditors/invite",
        headers: ADMIN,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
