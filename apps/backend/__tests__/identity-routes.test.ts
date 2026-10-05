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
import { WardenXError } from "@wardenx/types";
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
  createInMemoryUserIdentityReader,
  registerIdentityRoutes,
} from "../src/modules/02-identity/index";
import { createProposedRoleGuard } from "../src/modules/03-authorization/proposed-role-ceiling";

/** Test-only auth shim: populate request.context from headers (mirrors api.test.ts). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // No `x-test-orgname` here any more. This shim used to stamp
  // `context.attributes.organizationName`, which is the ONLY reason the invitation cases below
  // asserted a real org name: nothing in production ever wrote that attribute, so every WardenX
  // invitation was stored — and previewed to the invitee — as the literal `Organization` (F-030).
  // The suite writing the fact it was testing for is the exact shape `arch:context-attributes`
  // excludes test files to avoid blessing.
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

/**
 * The inviting admin's OWN membership in `org_a`, seeded by DEFAULT.
 *
 * Not optional in reality: `member.invite` is a grant held IN an org, so an admin who can reach
 * these routes necessarily has an active membership there — and since F-030 that membership is
 * where the invitation's org name comes from.
 */
const ADMIN_MEMBERSHIP = membership({
  membershipId: "m_admin",
  userId: "admin_1",
  organizationId: "org_a",
  organizationName: "Engrace",
  isAdmin: true,
});

interface CapturingEmailTransport {
  send(email: { to: string; subject: string; text: string }): Promise<void>;
  sent: Array<{ to: string; subject: string; text: string }>;
}
function capturingEmailTransport(): CapturingEmailTransport {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
    },
  };
}

function makeServer(
  opts: {
    seed?: MembershipRecord[];
    actors?: Actor | null | "context";
    emailTransport?: IdentityRouteDeps["emailTransport"];
    webAppBaseUrl?: string;
    roleAttacher?: IdentityRouteDeps["roleAttacher"];
    dashboardSeeder?: IdentityRouteDeps["dashboardSeeder"];
    /** GAP-008 — defaults to a recording stub that allows; `null` binds NO guard. */
    proposedRoleGuard?: IdentityRouteDeps["proposedRoleGuard"] | null;
    /** GAP-009 — userId → account email; defaults to the accepting users the cases below use. */
    userEmails?: Record<string, string>;
    /** GAP-009 — `null` binds NO identity reader (accept must then fail closed). */
    bindUserIdentity?: boolean;
  } = {},
) {
  const guardCalls: Array<{ inviterUserId: string; roleKeys: readonly string[] }> = [];
  const defaultGuard: NonNullable<IdentityRouteDeps["proposedRoleGuard"]> = {
    async assertProposable(input) {
      guardCalls.push({ inviterUserId: input.inviterUserId, roleKeys: input.roleKeys });
    },
  };
  const memberships = createInMemoryMembershipRepository(opts.seed ?? [ADMIN_MEMBERSHIP]);
  const sessions = createInMemorySessionWriter();
  const invitations = createInMemoryInvitationStore();
  const collaborators = createInMemoryCollaboratorLinkStore();
  const users = createInMemoryUserDirectory(memberships.repo);
  const auditSink = createInMemoryAuditExecutor();
  const identity = createInMemoryUserIdentityReader(
    opts.userEmails ?? {
      new_user: "new@example.com",
      invitee_1: "roles@example.com",
      invitee_dash: "dash@example.com",
      accepted_user: "gone@example.com",
      peek_user: "peek@example.com",
    },
  );
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
    ...(opts.emailTransport ? { emailTransport: opts.emailTransport } : {}),
    ...(opts.webAppBaseUrl ? { webAppBaseUrl: opts.webAppBaseUrl } : {}),
    ...(opts.roleAttacher ? { roleAttacher: opts.roleAttacher } : {}),
    ...(opts.dashboardSeeder ? { dashboardSeeder: opts.dashboardSeeder } : {}),
    ...(opts.proposedRoleGuard === null
      ? {}
      : { proposedRoleGuard: opts.proposedRoleGuard ?? defaultGuard }),
    ...(opts.bindUserIdentity === false ? {} : { userIdentity: identity }),
  };
  registerIdentityRoutes(app, deps);
  return {
    app,
    memberships,
    sessions,
    invitations,
    collaborators,
    users,
    auditSink,
    guardCalls,
    identity,
  };
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

    it("FB-T15 GET /auth/context returns the org-bound actor's roles, membership + effective permissions", async () => {
      const { app } = makeServer({
        seed: [membership({ membershipId: "adm_1", userId: "admin_1", isAdmin: true })],
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/context",
        headers: ADMIN, // org_a / admin_1 / org_admin — granted member.invite etc. in makeServer
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        userId: string;
        organizationId: string;
        membershipId: string;
        roles: string[];
        isAdmin: boolean;
        permissions: string[];
      };
      expect(body.userId).toBe("admin_1");
      expect(body.organizationId).toBe("org_a");
      expect(body.membershipId).toBe("adm_1");
      expect(body.roles).toContain("org_admin");
      expect(body.isAdmin).toBe(true);
      // Permissions are the M3-resolved effective set (the SAME resolver requirePermission gates on).
      expect(body.permissions).toContain("member.invite");
      await app.close();
    });

    it("FB-T15 GET /auth/context for a pre-org session has no org/membership/roles/permissions", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/context",
        headers: { "x-test-user": "user_rn" }, // authenticated, not yet org-bound
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        organizationId: string | null;
        membershipId: string | null;
        roles: string[];
        permissions: string[];
      };
      expect(body.organizationId).toBeNull();
      expect(body.membershipId).toBeNull();
      expect(body.roles).toEqual([]);
      expect(body.permissions).toEqual([]);
      await app.close();
    });

    it("FB-T15 GET /auth/context unauthenticated → 401 envelope", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/context" });
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
        headers: ADMIN,
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
        headers: ADMIN,
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

    // ── GAP-009(a): the token is redeemed by the account it was issued to ─────────────────────────
    it("GAP-009 accept by an account whose email differs from the invitation → 403, token NOT burned", async () => {
      const { app, invitations, identity } = makeServer({
        userEmails: { intruder: "intruder@example.com", rightful: "Rightful@Example.com" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "rightful@example.com" },
      });
      const token = invitations.tokenFor("rightful@example.com");
      const accept = (user: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: { "x-test-user": user },
          payload: { token },
        });

      const wrong = await accept("intruder");
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.code).toBe("INVITATION_EMAIL_MISMATCH");

      // A refused accept verifies nothing.
      expect(identity.isVerified("intruder")).toBe(false);
      expect(identity.isVerified("rightful")).toBe(false);

      // The mismatch did not consume the one-time token; the case-insensitive rightful account can,
      // and redeeming it marks that account's email verified.
      const right = await accept("rightful");
      expect(right.statusCode).toBe(200);
      expect(identity.isVerified("rightful")).toBe(true);
      expect(identity.isVerified("intruder")).toBe(false);
      await app.close();
    });

    it("GAP-009 accept by an account with no email on file → 403", async () => {
      const { app, invitations } = makeServer({ userEmails: {} });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "someone@example.com" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "ghost" },
        payload: { token: invitations.tokenFor("someone@example.com") },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("GAP-009 accept fails closed (503) when no identity reader is bound", async () => {
      const { app, invitations } = makeServer({ bindUserIdentity: false });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "someone@example.com" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "anyone" },
        payload: { token: invitations.tokenFor("someone@example.com") },
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });

    // ── GAP-008: proposed roles are bounded by the inviter ────────────────────────────────────────
    it("GAP-008 an invitation proposing roles runs the guard with the INVITER and stores nothing when refused", async () => {
      const refusing: NonNullable<IdentityRouteDeps["proposedRoleGuard"]> = {
        async assertProposable() {
          throw new WardenXError("ESCALATION_BLOCKED", "no", 403);
        },
      };
      const { app, invitations } = makeServer({ proposedRoleGuard: refusing });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "esc@example.com", proposedRoleKeys: ["org_admin"] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ESCALATION_BLOCKED");
      expect(invitations.tokenFor("esc@example.com")).toBeUndefined();
      await app.close();
    });

    it("GAP-008 proposing roles with NO guard bound is refused (503), not stored unchecked", async () => {
      const { app, invitations } = makeServer({ proposedRoleGuard: null });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "noguard@example.com", proposedRoleKeys: ["org_admin"] },
      });
      expect(res.statusCode).toBe(503);
      expect(invitations.tokenFor("noguard@example.com")).toBeUndefined();
      // …while an invitation proposing nothing still needs no guard.
      const plain = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "plain@example.com" },
      });
      expect(plain.statusCode).toBe(201);
      await app.close();
    });

    it("GAP-008 the real M3 guard: member.invite alone proposing org_admin → 403 ESCALATION_BLOCKED (audited)", async () => {
      const held: Record<string, string[]> = {
        admin_1: ["member.invite"], // no role.assign, none of org_admin's permissions
      };
      const guard = createProposedRoleGuard({
        lookup: async () => [
          {
            id: "r1",
            key: "org_admin",
            category: "administration",
            permissionKeys: ["org.manage"],
          },
        ],
        effectivePermissions: ({ userId }) => new Set(held[userId] ?? []),
        audit: createInMemoryAuditExecutor().executor,
      });
      const { app, invitations } = makeServer({ proposedRoleGuard: guard });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "boss@example.com", proposedRoleKeys: ["org_admin"] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ESCALATION_BLOCKED");
      expect(invitations.tokenFor("boss@example.com")).toBeUndefined();
      await app.close();
    });

    it("GAP-008 the real M3 guard: role.assign without the role's permissions → ESCALATION_BLOCKED; reserved → 422; within ceiling → 201", async () => {
      const held = new Set(["member.invite", "role.assign", "patient.read"]);
      const roles: Record<string, { category: string; permissionKeys: string[] }> = {
        org_admin: { category: "administration", permissionKeys: ["org.manage"] },
        platform_admin: { category: "administration", permissionKeys: [] },
        reader: { category: "clinical_staff", permissionKeys: ["patient.read"] },
      };
      const guard = createProposedRoleGuard({
        lookup: async (_org, keys) =>
          keys
            .filter((k) => roles[k])
            .map((k) => ({ id: k, key: k, ...(roles[k] as (typeof roles)[string]) })),
        effectivePermissions: () => held,
        audit: createInMemoryAuditExecutor().executor,
      });
      const { app } = makeServer({ proposedRoleGuard: guard });
      const propose = (email: string, key: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/orgs/org_a/invitations",
          headers: ADMIN,
          payload: { email, proposedRoleKeys: [key] },
        });
      const escalated = await propose("a@example.com", "org_admin");
      expect(escalated.statusCode).toBe(403);
      expect(escalated.json().error.code).toBe("ESCALATION_BLOCKED");
      const reserved = await propose("b@example.com", "platform_admin");
      expect(reserved.statusCode).toBe(422);
      expect(reserved.json().error.code).toBe("RESERVED_ROLE");
      expect((await propose("c@example.com", "reader")).statusCode).toBe(201);
      await app.close();
    });

    // ── F-097: the §D3 M2→M3 role attach ─────────────────────────────────────────────────────────
    //
    // M2 §D3 records this as Decided — "M2 carries `proposedRoleKeys` … and creates the membership; M3
    // attaches roles on accept" — and nothing performed it. The route read the keys off the consumed
    // invitation and returned, carrying a comment that named M3 as the owner of a step no code took, so
    // every invitation the platform issued produced a membership with no grants. Nothing failed and
    // nothing warned; the invitation row still listed the roles that had been requested.

    /** A stand-in for M3's attacher: whatever role keys this org "has". */
    const attacherOver = (known: readonly string[]) => {
      const calls: {
        membershipId: string;
        roleKeys: readonly string[];
        grantedByUserId: string | null;
      }[] = [];
      return {
        calls,
        attacher: {
          async attach(input: {
            organizationId: string;
            membershipId: string;
            roleKeys: readonly string[];
            grantedByUserId: string | null;
          }) {
            calls.push({
              membershipId: input.membershipId,
              roleKeys: input.roleKeys,
              grantedByUserId: input.grantedByUserId,
            });
            return {
              attached: input.roleKeys.filter((key) => known.includes(key)),
              unresolved: input.roleKeys.filter((key) => !known.includes(key)),
            };
          },
        } satisfies NonNullable<IdentityRouteDeps["roleAttacher"]>,
      };
    };

    async function acceptWith(
      roleAttacher: NonNullable<IdentityRouteDeps["roleAttacher"]> | undefined,
      proposedRoleKeys: readonly string[],
    ) {
      const server = makeServer(roleAttacher ? { roleAttacher } : {});
      await server.app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "roles@example.com", proposedRoleKeys: [...proposedRoleKeys] },
      });
      const res = await server.app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "invitee_1" },
        payload: { token: server.invitations.tokenFor("roles@example.com") },
      });
      return { server, res };
    }

    it("F-097 attaches the invitation's proposedRoleKeys to the new membership", async () => {
      const { calls, attacher } = attacherOver(["clinical_rn"]);
      const { server, res } = await acceptWith(attacher, ["clinical_rn"]);
      expect(res.statusCode).toBe(200);
      // The keys reach M3 at all — which is the whole defect: before this they reached the end of the
      // handler and stopped.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.roleKeys).toEqual(["clinical_rn"]);
      expect(calls[0]!.membershipId).toBe(res.json().membershipId);
      // GAP-008 — the attach is bounded by, and recorded against, the INVITER (admin_1), not the invitee.
      expect(calls[0]!.grantedByUserId).toBe("admin_1");
      expect(res.json().rolesAttached).toEqual({ attached: ["clinical_rn"], unresolved: [] });
      await server.app.close();
    });

    it("F-097 reports a proposed role the org has no role row for, rather than dropping it", async () => {
      // The state every freshly provisioned tenant is in: M34's provision worker seeds a key ring,
      // storage prefixes, an organization, onboarding tasks and the first-admin invitation, and NO
      // `role` rows. Silence here would reproduce the defect one layer down.
      const { attacher } = attacherOver([]);
      const { server, res } = await acceptWith(attacher, ["org_admin"]);
      expect(res.json().rolesAttached).toEqual({ attached: [], unresolved: ["org_admin"] });
      // Audited as a FAILURE — nothing was granted although something was asked for.
      const row = server.auditSink.rows.find((r) => r.eventType === "m3.role.assigned");
      expect(row).toBeDefined();
      expect(row!.outcome).toBe("failure");
      await server.app.close();
    });

    it("F-097 says `null` when no attacher is bound — not an empty grant set", async () => {
      // "This deployment cannot attach roles" and "this invitation proposed none" are different facts.
      // Reporting the second for the first is exactly how the missing handshake stayed invisible.
      const { server, res } = await acceptWith(undefined, ["clinical_rn"]);
      expect(res.json().rolesAttached).toBeNull();
      await server.app.close();
    });

    it("F-097 an invitation proposing no roles attaches nothing and audits nothing", async () => {
      const { calls, attacher } = attacherOver(["clinical_rn"]);
      const { server, res } = await acceptWith(attacher, []);
      expect(res.json().rolesAttached).toEqual({ attached: [], unresolved: [] });
      expect(calls).toHaveLength(1); // called, and correctly found nothing to do
      expect(server.auditSink.rows.some((r) => r.eventType === "m3.role.assigned")).toBe(false);
      await server.app.close();
    });
  });

  describe("#138/F-060/F-116 accept seeds the day-one dashboards", () => {
    function capturingDashboardSeeder() {
      const calls: { organizationId: string; userId: string; ownerMembershipId: string }[] = [];
      return {
        calls,
        seeder: {
          async ensureSystemDashboards(input: {
            organizationId: string;
            userId: string;
            ownerMembershipId: string;
          }) {
            calls.push(input);
            return { created: ["census_org_daily"], alreadyPresent: [] };
          },
        } satisfies NonNullable<IdentityRouteDeps["dashboardSeeder"]>,
      };
    }

    async function acceptAsDashboardSeederFixture(
      dashboardSeeder: NonNullable<IdentityRouteDeps["dashboardSeeder"]> | undefined,
    ) {
      const server = makeServer(dashboardSeeder ? { dashboardSeeder } : {});
      await server.app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "dash@example.com", proposedRoleKeys: [] },
      });
      const res = await server.app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "invitee_dash" },
        payload: { token: server.invitations.tokenFor("dash@example.com") },
      });
      return { server, res };
    }

    it("calls the seeder with the new membership as owner, after the membership is created", async () => {
      const { calls, seeder } = capturingDashboardSeeder();
      const { res } = await acceptAsDashboardSeederFixture(seeder);
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.organizationId).toBe("org_a");
      expect(calls[0]!.userId).toBe("invitee_dash");
      expect(calls[0]!.ownerMembershipId).toBe(res.json().membershipId);
    });

    it("does not fail accept when no seeder is bound", async () => {
      const { res } = await acceptAsDashboardSeederFixture(undefined);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("TASK-030 invite delivery + roster + resend + peek", () => {
    // ── F-030 · the invitation carries the org's REAL name ──────────────────────────────────────
    //
    // Both invitation routes read `context.attributes.organizationName` and fell back to the literal
    // `"Organization"`. Nothing has ever written that attribute, so the fallback was not a fallback —
    // it was the only branch. Every invitation row was stored as `Organization`, the pre-auth peek
    // served that back to the invitee's browser, and the email read "invited to join your
    // organization". The name now comes from the INVITER's own active membership in the org they are
    // inviting into, which is org-scoped by construction and needs no new dependency.

    it("stores and previews the org's real display name, from the inviter's own membership", async () => {
      const transport = capturingEmailTransport();
      const { app, invitations } = makeServer({
        seed: [
          membership({
            membershipId: "m_admin",
            userId: "admin_1",
            organizationId: "org_a",
            organizationName: "Maple Hospice",
            isAdmin: true,
          }),
        ],
        emailTransport: transport,
        webAppBaseUrl: "https://app.wardenx.example",
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "named@example.com" },
      });

      const peek = await app.inject({
        method: "GET",
        url: `/api/v1/invitations/${invitations.tokenFor("named@example.com")}`,
      });
      expect(peek.json().organizationName).toBe("Maple Hospice");
      expect(transport.sent[0]!.text).toContain("Maple Hospice");
      // The literal that used to be the only possible value.
      expect(peek.json().organizationName).not.toBe("Organization");
      await app.close();
    });

    it("resend carries the same real name (it read the same dead attribute)", async () => {
      const transport = capturingEmailTransport();
      const { app } = makeServer({
        seed: [
          membership({
            membershipId: "m_admin",
            userId: "admin_1",
            organizationId: "org_a",
            organizationName: "Maple Hospice",
            isAdmin: true,
          }),
        ],
        emailTransport: transport,
        webAppBaseUrl: "https://app.wardenx.example",
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "again@example.com" },
      });
      const roster = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
      });
      const invId = (
        roster.json().invitations as Array<{ invitationId: string; email: string }>
      ).find((i) => i.email === "again@example.com")!.invitationId;
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/org_a/invitations/${invId}/resend`,
        headers: ADMIN,
      });
      expect(transport.sent).toHaveLength(2);
      expect(transport.sent[1]!.text).toContain("Maple Hospice");
      await app.close();
    });

    it("an unresolvable name degrades to the placeholder rather than failing the invite", async () => {
      // Unreachable through the guards (the inviter holds `member.invite` IN this org), but an
      // invitation that is already durably recorded must never 500 over a display string.
      const transport = capturingEmailTransport();
      const { app, invitations } = makeServer({
        seed: [], // no membership for admin_1
        emailTransport: transport,
        webAppBaseUrl: "https://app.wardenx.example",
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "nameless@example.com" },
      });
      expect(res.statusCode).toBe(201);
      const peek = await app.inject({
        method: "GET",
        url: `/api/v1/invitations/${invitations.tokenFor("nameless@example.com")}`,
      });
      expect(peek.json().organizationName).toBe("Organization");
      expect(transport.sent[0]!.text).toContain("your organization");
      await app.close();
    });

    it("with webAppBaseUrl configured: create returns inviteUrl + emails it via the transport", async () => {
      const transport = capturingEmailTransport();
      const { app } = makeServer({
        emailTransport: transport,
        webAppBaseUrl: "https://app.wardenx.example",
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "new@example.com" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { inviteUrl?: string };
      expect(body.inviteUrl).toMatch(/^https:\/\/app\.wardenx\.example\/invite\//);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.to).toBe("new@example.com");
      expect(transport.sent[0]!.text).toContain(body.inviteUrl);
      await app.close();
    });

    it("without webAppBaseUrl configured: create omits inviteUrl (token stays out of the body)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "new2@example.com" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().inviteUrl).toBeUndefined();
      await app.close();
    });

    it("GET the invitation roster lists pending invites (member.invite)", async () => {
      const { app } = makeServer();
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "roster@example.com" },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      const invitations = res.json().invitations as Array<{ email: string; status: string }>;
      expect(
        invitations.some((i) => i.email === "roster@example.com" && i.status === "pending"),
      ).toBe(true);
      await app.close();
    });

    it("resend re-mints the token (the old one stops working) and returns a fresh inviteUrl", async () => {
      const transport = capturingEmailTransport();
      const { app, invitations } = makeServer({
        emailTransport: transport,
        webAppBaseUrl: "https://app.wardenx.example",
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "resend@example.com" },
      });
      const oldToken = invitations.tokenFor("resend@example.com");
      const roster = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
      });
      const invId = (
        roster.json().invitations as Array<{ invitationId: string; email: string }>
      ).find((i) => i.email === "resend@example.com")!.invitationId;

      const resend = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/org_a/invitations/${invId}/resend`,
        headers: ADMIN,
      });
      expect(resend.statusCode).toBe(200);
      expect(transport.sent).toHaveLength(2); // create + resend

      // The OLD token is dead now.
      const acceptOld = await app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "someone" },
        payload: { token: oldToken },
      });
      expect(acceptOld.statusCode).toBe(410);
      await app.close();
    });

    it("resending an already-accepted invite → 404", async () => {
      const { app, invitations } = makeServer();
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "gone@example.com" },
      });
      const token = invitations.tokenFor("gone@example.com");
      await app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "accepted_user" },
        payload: { token },
      });
      const roster = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
      });
      const invId = (
        roster.json().invitations as Array<{ invitationId: string; email: string }>
      ).find((i) => i.email === "gone@example.com")!.invitationId;
      const resend = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/org_a/invitations/${invId}/resend`,
        headers: ADMIN,
      });
      expect(resend.statusCode).toBe(404);
      await app.close();
    });

    it("GET /invitations/:token (peek) previews the target pre-auth, without consuming it", async () => {
      const { app, invitations } = makeServer();
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs/org_a/invitations",
        headers: ADMIN,
        payload: { email: "peek@example.com" },
      });
      const token = invitations.tokenFor("peek@example.com");

      const peek = await app.inject({ method: "GET", url: `/api/v1/invitations/${token}` });
      expect(peek.statusCode).toBe(200);
      expect(peek.json()).toMatchObject({ email: "peek@example.com", organizationName: "Engrace" });

      // Peeking does not consume — accept still works afterward.
      const accept = await app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { "x-test-user": "peek_user" },
        payload: { token },
      });
      expect(accept.statusCode).toBe(200);
      await app.close();
    });

    it("GET /invitations/:token for an unknown token → 410 LINK_EXPIRED", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/invitations/does-not-exist" });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe("LINK_EXPIRED");
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

    it("FB-T12 — the roster carries name/email/last-login + a pending-invite count", async () => {
      const { app, invitations } = makeServer({
        seed: [
          membership({
            membershipId: "rn_1",
            userId: "rn_user",
            displayName: "Robin Nightingale",
            email: "robin@engrace.test",
            lastLoginAt: "2026-06-01T08:00:00.000Z",
            accountStatus: "active",
          }),
        ],
      });
      // Two still-pending org invitations back the "pending invites" KPI.
      void invitations.store.create({
        organizationId: "org_a",
        organizationName: "Engrace",
        email: "new1@engrace.test",
        proposedRoleKeys: [],
        defaultLocationIds: [],
      });
      void invitations.store.create({
        organizationId: "org_a",
        organizationName: "Engrace",
        email: "new2@engrace.test",
        proposedRoleKeys: [],
        defaultLocationIds: [],
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/members",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        members: Array<{
          displayName: string | null;
          email: string | null;
          lastLoginAt: string | null;
        }>;
        pendingInvitations: number;
      };
      expect(body.members[0]!.displayName).toBe("Robin Nightingale");
      expect(body.members[0]!.email).toBe("robin@engrace.test");
      expect(body.members[0]!.lastLoginAt).toBe("2026-06-01T08:00:00.000Z");
      expect(body.pendingInvitations).toBe(2);
      await app.close();
    });

    it("FB-T12 — ?q also matches the joined display name / email", async () => {
      const { app } = makeServer({
        seed: [
          membership({
            membershipId: "rn_1",
            userId: "rn_user",
            displayName: "Robin Nightingale",
            email: "robin@engrace.test",
          }),
          membership({
            membershipId: "md_1",
            userId: "md_user",
            displayName: "Dana Marlow",
            email: "dana@engrace.test",
          }),
        ],
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/orgs/org_a/members?q=nightingale",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      const members = res.json().members as Array<{ membershipId: string }>;
      expect(members.map((m) => m.membershipId)).toEqual(["rn_1"]);
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

    it("GAP-001 PATCH cannot revive a revoked membership (§2.2.2 revoked is terminal) → 409", async () => {
      const { app, memberships, auditSink } = makeServer({
        seed: [
          ...seed(),
          membership({ membershipId: "gone_1", userId: "gone_user", status: "revoked" }),
        ],
      });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/orgs/org_a/members/gone_1",
        headers: ADMIN,
        payload: { status: "active" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("MEMBERSHIP_REVOKED");
      expect(memberships.all().find((m) => m.membershipId === "gone_1")?.status).toBe("revoked");
      expect(auditSink.rows.some((r) => r.eventType.startsWith("m2.membership."))).toBe(false);
      await app.close();
    });

    // §2.2.2: a `pending` membership leaves only by the invitation being ACCEPTED (→ active) or by the
    // admin revoking it. Suspension is for active members; PATCH is not a second way to activate.
    // (`pending` is a real DB enum value — packages/db/src/enums.ts — that the M2 port union omits.)
    const PENDING = "pending" as MembershipRecord["status"];
    for (const next of ["suspended", "active"] as const) {
      it(`PATCH pending → ${next} → 409 MEMBERSHIP_PENDING, nothing changed`, async () => {
        const { app, memberships, auditSink } = makeServer({
          seed: [
            ...seed(),
            membership({ membershipId: "inv_1", userId: "inv_user", status: PENDING }),
          ],
        });
        const res = await app.inject({
          method: "PATCH",
          url: "/api/v1/orgs/org_a/members/inv_1",
          headers: ADMIN,
          payload: { status: next },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("MEMBERSHIP_PENDING");
        expect(memberships.all().find((m) => m.membershipId === "inv_1")?.status).toBe(PENDING);
        expect(auditSink.rows.some((r) => r.eventType.startsWith("m2.membership."))).toBe(false);
        await app.close();
      });
    }

    it("a pending membership can still be revoked (DELETE) → 200", async () => {
      const { app, memberships } = makeServer({
        seed: [
          ...seed(),
          membership({ membershipId: "inv_1", userId: "inv_user", status: PENDING }),
        ],
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/orgs/org_a/members/inv_1",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(memberships.all().find((m) => m.membershipId === "inv_1")?.status).toBe("revoked");
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

    it("deactivating a user disables creds everywhere, revokes the membership, reaps all sessions", async () => {
      const { app, users, sessions, auditSink, memberships } = makeServer({ seed: seed() });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/rn_user/deactivate",
        headers: ADMIN,
        payload: { reason: "left the company" },
      });
      expect(res.statusCode).toBe(200);
      expect(users.isDeactivated("rn_user")).toBe(true);
      // §2.2.1: "All memberships revoked".
      const after = await memberships.repo.listForUser("rn_user");
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((m) => m.status === "revoked")).toBe(true);
      expect(sessions.revokedUsers()).toContain("rn_user");
      expect(auditSink.rows.some((r) => r.eventType === "m2.user.deactivated")).toBe(true);
      await app.close();
    });

    it("GAP-001 deactivating a user with no membership in the caller's org → 404, nothing touched", async () => {
      const { app, users, sessions, auditSink } = makeServer({
        seed: [
          ...seed(),
          membership({ membershipId: "b_1", userId: "b_user", organizationId: "org_b" }),
        ],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/b_user/deactivate",
        headers: ADMIN,
        payload: { reason: "cross-tenant attempt" },
      });
      expect(res.statusCode).toBe(404);
      expect(users.isDeactivated("b_user")).toBe(false);
      expect(sessions.revokedUsers()).not.toContain("b_user");
      expect(auditSink.rows.some((r) => r.eventType === "m2.user.deactivated")).toBe(false);
      await app.close();
    });

    it("GAP-001 a user who is still a live member of another org → 409, not deactivated globally", async () => {
      const { app, users, sessions } = makeServer({
        seed: [
          ...seed(),
          membership({ membershipId: "rn_b", userId: "rn_user", organizationId: "org_b" }),
        ],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/rn_user/deactivate",
        headers: ADMIN,
        payload: { reason: "left the company" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("USER_IN_OTHER_ORGS");
      expect(users.isDeactivated("rn_user")).toBe(false);
      expect(sessions.revokedUsers()).not.toContain("rn_user");
      await app.close();
    });

    it("GAP-001 a FORMER member (revoked in the caller's org, no live membership) → 404, not deactivated", async () => {
      const { app, users, sessions, auditSink } = makeServer({
        seed: [
          ...seed(),
          membership({
            membershipId: "former_a",
            userId: "former_user",
            organizationId: "org_a",
            status: "revoked",
          }),
        ],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/former_user/deactivate",
        headers: ADMIN,
        payload: { reason: "former member, no longer ours" },
      });
      expect(res.statusCode).toBe(404);
      expect(users.isDeactivated("former_user")).toBe(false);
      expect(sessions.revokedUsers()).not.toContain("former_user");
      expect(auditSink.rows.some((r) => r.eventType === "m2.user.deactivated")).toBe(false);
      await app.close();
    });

    it("GAP-001 a revoked membership elsewhere does not block deactivation", async () => {
      const { app, users } = makeServer({
        seed: [
          ...seed(),
          membership({
            membershipId: "rn_b",
            userId: "rn_user",
            organizationId: "org_b",
            status: "revoked",
          }),
        ],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/rn_user/deactivate",
        headers: ADMIN,
        payload: { reason: "left the company" },
      });
      expect(res.statusCode).toBe(200);
      expect(users.isDeactivated("rn_user")).toBe(true);
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
