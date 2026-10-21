// apps/backend/__tests__/authz-routes.test.ts — M3-T08 authorization route-inventory
// integration tests (M3 spec §4.3–4.4; the §6 meta-permission matrix; the §7.4 break-glass,
// §7.5 auditor-engagement, and §7.6 tenant-catalog-customize workflows).
//
// Exercises M3's routes through the FULL M1 middleware chain (request-context + error envelope
// + security) via Fastify `inject` with no live infra: buildServer() mounts the foundation
// host, then registerAuthorizationRoutes() mounts the M3 routes with in-memory adapters. The
// REAL Authorization Contract gates every route — `registerEffectivePermissionResolver` seeds
// each actor's effective permissions so `requirePermission` resolves them (this is the
// contract going live, not a deny-stub). A header-auth shim populates request.context.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requireAbac,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import {
  type AuthzRouteDeps,
  type RoleView,
  createFixedPermissionResolver,
  createInMemoryAuditorSessionMinter,
  createInMemoryBreakGlassStore,
  createInMemoryComplianceNotifier,
  createInMemoryEngagementStore,
  createInMemoryMembershipRoleStore,
  createInMemoryRoleStore,
  registerAuthorizationRoutes,
  registerBreakGlassContract,
} from "../src/modules/03-authorization/index";

/** Test-only auth shim: populate request.context from headers (mirrors identity-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

/** Each actor's effective permission set (drives both the contract gate + anti-escalation). */
const PERMISSION_SEED = [
  {
    organizationId: "org_a",
    userId: "admin_1",
    permissions: ["role.read", "role.manage", "role.assign", "patient.read", "visit.read"],
  },
  {
    organizationId: "org_a",
    userId: "co_1",
    permissions: ["breakglass.read", "breakglass.cosign", "engagement.manage", "engagement.read"],
  },
  { organizationId: "org_a", userId: "rn_1", permissions: ["breakglass.invoke"] },
  // The actor the §7.4 two-person control exists for: one user holding BOTH halves. Nothing stops
  // a tenant granting `breakglass.invoke` and `breakglass.cosign` to the same person — the
  // distinctness check is what stops that person from approving their own emergency PHI access.
  {
    organizationId: "org_a",
    userId: "both_1",
    permissions: ["breakglass.invoke", "breakglass.cosign", "breakglass.read"],
  },
];

function makeServer(
  opts: {
    cosignRequired?: boolean;
    extraRoles?: readonly RoleView[];
    auditorLinkDelivery?: AuthzRouteDeps["auditorLinkDelivery"];
    /** GAP-007 — the membership's default reach the grant's scope is bounded by. */
    reach?: { providerEntityIds: string[]; locationIds: string[] };
  } = {},
) {
  const roles = createInMemoryRoleStore();
  const membershipRoles = createInMemoryMembershipRoleStore();
  const breakGlass = createInMemoryBreakGlassStore();
  const engagements = createInMemoryEngagementStore();
  const auditorSessions = createInMemoryAuditorSessionMinter();
  const notifier = createInMemoryComplianceNotifier();
  const perms = createFixedPermissionResolver(PERMISSION_SEED);
  const auditSink = createInMemoryAuditExecutor();

  // Register the REAL contract resolver so requirePermission resolves each actor's keys.
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: s.organizationId,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // Wire the §2.2 break-glass branch off M3's break-glass store.
  registerBreakGlassContract({ store: breakGlass.store, audit: auditSink.executor });

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  // Rows the in-memory store cannot mint itself (a platform-owned role, a pre-0318 tenant row).
  const extra = new Map((opts.extraRoles ?? []).map((r) => [r.roleId, r]));
  const deps: AuthzRouteDeps = {
    roles: { ...roles.store, get: (id) => extra.get(id) ?? roles.store.get(id) },
    membershipRoles: opts.reach
      ? { ...membershipRoles.store, reachOf: () => opts.reach as never }
      : membershipRoles.store,
    breakGlass: breakGlass.store,
    engagements: engagements.store,
    auditorSessions: auditorSessions.minter,
    ...(opts.auditorLinkDelivery ? { auditorLinkDelivery: opts.auditorLinkDelivery } : {}),
    notifier: notifier.notifier,
    effectivePermissions: perms.resolver,
    audit: auditSink.executor,
    // audit C2 — tenant policy, not the request body. The slice pins the registered default;
    // `cosignRequired: true` is the tenant that turned the two-person control ON.
    cosignPolicy: async () => opts.cosignRequired ?? false,
  };
  registerAuthorizationRoutes(app, deps);
  return {
    app,
    roles,
    membershipRoles,
    breakGlass,
    engagements,
    auditorSessions,
    notifier,
    auditSink,
  };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_a", "x-test-roles": "org_admin" };
const COMPLIANCE = { "x-test-user": "co_1", "x-test-org": "org_a", "x-test-roles": "compliance" };
const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": "org_a", "x-test-roles": "clinical_rn" };
/** Holds `breakglass.invoke` AND `breakglass.cosign` — the self-cosign case (§7.4). */
const BOTH = { "x-test-user": "both_1", "x-test-org": "org_a", "x-test-roles": "clinical_rn" };

// `break_glass_event.target_patient_id` is a uuid column, and the route validates the body against
// `authz-typebox` at the boundary — so the glass fixtures are real uuids, not opaque handles.
const TARGET_PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

/** A role row with the defaults the GAP-003 assign/edit cases do not care about. */
function roleView(
  r: Pick<RoleView, "roleId" | "organizationId" | "key"> & Partial<RoleView>,
): RoleView {
  return {
    name: r.key,
    category: "operations",
    scopeLevel: "organization",
    systemDefault: false,
    systemLocked: false,
    enabled: true,
    customized: false,
    permissionKeys: [],
    ...r,
  };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M3-T08 authorization route inventory", () => {
  describe("§6 meta-permission gate (the contract goes live)", () => {
    it("unauthenticated → 401 envelope", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/roles" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("an actor without role.manage → 403 (deny by default)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: CLINICIAN, // holds only breakglass.invoke
        payload: { key: "x", name: "X", category: "operations", permissionKeys: [] },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("GET /me/permissions returns the actor's effective set", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me/permissions",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().permissions).toContain("role.manage");
      await app.close();
    });
  });

  describe("§7.6 tenant customizes the catalog", () => {
    it("clones a custom role with a narrower permission set (201)", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: {
          key: "weekend_float_rn",
          name: "Weekend Float RN",
          category: "temporary_special",
          permissionKeys: ["patient.read", "visit.read"],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ key: "weekend_float_rn", customized: true });
      expect(auditSink.rows.some((r) => r.eventType === "m3.role.created")).toBe(true);
      await app.close();
    });

    it("cannot grant a permission the admin does not hold → 403 + escalation_blocked audit", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: {
          key: "super",
          name: "Super",
          category: "operations",
          permissionKeys: ["org.delete"],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(auditSink.rows.some((r) => r.eventType === "m3.authz.escalation_blocked")).toBe(true);
      await app.close();
    });

    it.each([
      { key: "platform_admin", category: "operations" },
      { key: "platform_ops", category: "operations" },
      { key: "helpdesk", category: "platform_staff" },
    ])("GAP-003 a tenant cannot mint platform authority ($key / $category) → 422", async (role) => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        // Zero permissions: anti-escalation passes trivially, which is exactly how the spoof got in.
        payload: { ...role, name: "Spoof", permissionKeys: [] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("RESERVED_ROLE");
      expect(auditSink.rows.some((r) => r.eventType === "m3.role.created")).toBe(false);
      await app.close();
    });

    it.each([
      {
        label: "platform-owned platform_admin",
        organizationId: null,
        key: "platform_admin",
        category: "operations",
      },
      {
        label: "platform-owned platform_staff",
        organizationId: null,
        key: "helpdesk",
        category: "platform_staff",
      },
    ])("GAP-003 a tenant cannot assign a $label role → 422 RESERVED_ROLE", async (r) => {
      const platformRole = roleView({ roleId: "plat_1", ...r });
      const { app, membershipRoles } = makeServer({ extraRoles: [platformRole] });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/memberships/${MEMBERSHIP}/roles`,
        headers: ADMIN,
        // The platform row carries no permissions, so anti-escalation alone let this through.
        payload: { roleId: "plat_1" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("RESERVED_ROLE");
      expect(await membershipRoles.store.listForMembership(MEMBERSHIP)).toEqual([]);
      await app.close();
    });

    it("GAP-096 a tenant cannot mint or assign ai_safety_owner (platform authority, no prefix) → 422", async () => {
      const { app, auditSink, membershipRoles } = makeServer({
        extraRoles: [
          roleView({
            roleId: "aso_1",
            organizationId: null,
            key: "ai_safety_owner",
            category: "operations",
          }),
        ],
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: {
          key: "ai_safety_owner",
          category: "clinical_staff",
          name: "Spoof",
          permissionKeys: [],
        },
      });
      expect(created.statusCode).toBe(422);
      expect(created.json().error.code).toBe("RESERVED_ROLE");
      expect(auditSink.rows.some((r) => r.eventType === "m3.role.created")).toBe(false);
      const assigned = await app.inject({
        method: "POST",
        url: `/api/v1/memberships/${MEMBERSHIP}/roles`,
        headers: ADMIN,
        payload: { roleId: "aso_1" },
      });
      expect(assigned.statusCode).toBe(422);
      expect(await membershipRoles.store.listForMembership(MEMBERSHIP)).toEqual([]);
      await app.close();
    });

    it("GAP-003 a legacy tenant platform_* row cannot be edited → 422, not a raw 23514", async () => {
      const legacy = roleView({ roleId: "legacy_1", organizationId: "org_a", key: "platform_ops" });
      const { app } = makeServer({ extraRoles: [legacy] });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/legacy_1",
        headers: ADMIN,
        payload: { name: "Renamed" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("RESERVED_ROLE");
      await app.close();
    });

    it("renames a system_locked role (allowed) → marks it customized", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/tmpl_administrator",
        headers: ADMIN,
        payload: { name: "Site Administrator" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "Site Administrator", customized: true });
      await app.close();
    });

    it("cannot delete a system_locked CoP role → 409 ROLE_LOCKED", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/roles/tmpl_medical_director",
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ROLE_LOCKED");
      await app.close();
    });

    it("cannot strip a system_locked role below its CoP floor → 409 ROLE_LOCKED", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/tmpl_medical_director",
        headers: ADMIN,
        payload: { permissionKeys: [] }, // would strip the floor
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ROLE_LOCKED");
      await app.close();
    });
  });

  describe("§7.4 break-glass emergency access", () => {
    it("rejects a too-short reason → 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: { targetPatientId: TARGET_PATIENT, reason: "short" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("invokes glass → 201 active, Compliance notified, critical invoked audit", async () => {
      const { app, notifier, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: {
          targetPatientId: TARGET_PATIENT,
          reason: "covering nurse, chest pain emergency",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: "active" });
      expect(res.json().expiresAt).toBeTruthy();
      expect(notifier.delivered().some((d) => d.kind === "breakglass.invoked")).toBe(true);
      const invoked = auditSink.rows.find((r) => r.eventType === "m3.breakglass.invoked");
      expect(invoked?.severity).toBe("critical");
      await app.close();
    });

    it("under glass, an ABAC-denied access is allowed + audited at critical; off-target denies", async () => {
      const { app, breakGlass, auditSink } = makeServer();
      const invoke = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: {
          targetPatientId: TARGET_PATIENT,
          reason: "covering nurse, chest pain emergency",
        },
      });
      const eventId = invoke.json().breakGlassId;
      expect(breakGlass.all()).toHaveLength(1);

      // A consuming module's PHI guard: caseload_membership denies (no predicate registered),
      // so the §2.2 break-glass branch is consulted. The covered target passes under glass.
      const guard = requireAbac("patient.read", "caseload_membership");
      const probe = (patientId: string) => ({
        context: {
          correlationId: "c",
          userId: "rn_1",
          organizationId: "org_a",
          providerEntityIds: [],
          locationIds: [],
          roles: [],
          attributes: {} as Record<string, unknown>,
          ip: "",
          userAgent: "",
          startTime: 0,
        },
        params: { patientId },
      });

      await expect(guard(probe(TARGET_PATIENT))).resolves.toBeUndefined(); // allowed under glass
      const access = auditSink.rows.find((r) => r.eventType === "m3.breakglass.access");
      expect(access?.severity).toBe("critical");
      expect((access?.context as { breakGlassEventId: string }).breakGlassEventId).toBe(eventId);

      // A patient NOT covered by the glass stays denied (deny by default).
      await expect(guard(probe(OTHER_PATIENT))).rejects.toMatchObject({ statusCode: 403 });
      await app.close();
    });

    it("Compliance reads the glass log + revokes early", async () => {
      const { app } = makeServer();
      const invoke = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: {
          targetPatientId: TARGET_PATIENT,
          reason: "covering nurse, chest pain emergency",
        },
      });
      const eventId = invoke.json().breakGlassId;

      const log = await app.inject({
        method: "GET",
        url: "/api/v1/breakglass",
        headers: COMPLIANCE,
      });
      expect(log.statusCode).toBe(200);
      expect(log.json().events).toHaveLength(1);

      const revoke = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/revoke`,
        headers: COMPLIANCE,
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().status).toBe("revoked");
      await app.close();
    });

    it("GAP-117 revoking an already-revoked event → 409 BREAKGLASS_NOT_REVOCABLE (status guard)", async () => {
      const { app } = makeServer();
      const invoke = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: {
          targetPatientId: TARGET_PATIENT,
          reason: "covering nurse, chest pain emergency",
        },
      });
      const eventId = invoke.json().breakGlassId;
      const url = `/api/v1/breakglass/${eventId}/revoke`;
      const first = await app.inject({ method: "POST", url, headers: COMPLIANCE });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url, headers: COMPLIANCE });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("BREAKGLASS_NOT_REVOCABLE");
      await app.close();
    });
  });

  describe("GAP-117 last-required-role guard", () => {
    const OTHER_MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
    const DON = roleView({
      roleId: "role_don",
      organizationId: "org_a",
      key: "director_of_nursing",
    });
    const assign = (app: Awaited<ReturnType<typeof makeServer>>["app"], membership: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/memberships/${membership}/roles`,
        headers: ADMIN,
        payload: { roleId: "role_don" },
      });
    const remove = (app: Awaited<ReturnType<typeof makeServer>>["app"], membership: string) =>
      app.inject({
        method: "DELETE",
        url: `/api/v1/memberships/${membership}/roles/role_don`,
        headers: ADMIN,
      });

    it("refuses to remove the only holder of a CoP-required role → 409 LAST_REQUIRED_ROLE", async () => {
      const { app, membershipRoles } = makeServer({ extraRoles: [DON] });
      expect((await assign(app, MEMBERSHIP)).statusCode).toBe(201);
      const res = await remove(app, MEMBERSHIP);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("LAST_REQUIRED_ROLE");
      expect(await membershipRoles.store.listForMembership(MEMBERSHIP)).toHaveLength(1);
      await app.close();
    });

    it("allows the removal once another member holds the role", async () => {
      const { app } = makeServer({ extraRoles: [DON] });
      await assign(app, MEMBERSHIP);
      await assign(app, OTHER_MEMBERSHIP);
      expect((await remove(app, MEMBERSHIP)).statusCode).toBe(200);
      await app.close();
    });
  });

  // ── §7.4 two-person control (AC-01) ────────────────────────────────────────────────────────
  //
  // These run with `cosignRequired: true` — the tenant setting that makes the co-signature the
  // control rather than a formality. Under the default (`false`) glass opens `active` on
  // invocation and the cosign route is never on the path, which is why the defect survived: the
  // only pre-existing test of this route asserted a 404 for an unknown id.
  describe("§7.4 break-glass co-signature is a two-person control", () => {
    const GLASS = {
      targetPatientId: TARGET_PATIENT,
      reason: "covering nurse, chest pain emergency",
    };

    async function invokeGlass(app: ReturnType<typeof makeServer>["app"], headers: typeof BOTH) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers,
        payload: GLASS,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("cosign_pending"); // the control is armed
      return res.json().breakGlassId as string;
    }

    it("refuses the invoker as their own co-signer → 409, and the glass stays shut", async () => {
      const { app, breakGlass, auditSink } = makeServer({ cosignRequired: true });
      const eventId = await invokeGlass(app, BOTH);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/cosign`,
        headers: BOTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("BREAKGLASS_SELF_COSIGN");

      // The security property, not just the status code: the grant never opened.
      expect(breakGlass.all()[0]?.status).toBe("cosign_pending");
      const guard = requireAbac("patient.read", "caseload_membership");
      await expect(
        guard({
          context: {
            correlationId: "c",
            userId: "both_1",
            organizationId: "org_a",
            providerEntityIds: [],
            locationIds: [],
            roles: [],
            attributes: {} as Record<string, unknown>,
            ip: "",
            userAgent: "",
            startTime: 0,
          },
          params: { patientId: TARGET_PATIENT },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      // A refusal is a signal Compliance must be able to find in the trail.
      const refused = auditSink.rows.find((r) => r.eventType === "m3.breakglass.cosign_refused");
      expect(refused?.severity).toBe("critical");
      expect(refused?.outcome).toBe("denied");
      expect((refused?.context as { reason: string }).reason).toBe("self_cosign");
      expect(auditSink.rows.some((r) => r.eventType === "m3.breakglass.cosigned")).toBe(false);
      await app.close();
    });

    it("a DISTINCT co-signer opens the glass → 200 active", async () => {
      const { app, breakGlass, auditSink } = makeServer({ cosignRequired: true });
      const eventId = await invokeGlass(app, CLINICIAN);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/cosign`,
        headers: COMPLIANCE, // co_1 — not the invoker
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
      expect(breakGlass.all()[0]?.status).toBe("active");
      expect(auditSink.rows.some((r) => r.eventType === "m3.breakglass.cosigned")).toBe(true);
      await app.close();
    });

    it("a co-signature cannot resurrect a REVOKED event → 409", async () => {
      const { app, breakGlass } = makeServer({ cosignRequired: true });
      const eventId = await invokeGlass(app, CLINICIAN);

      const revoked = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/revoke`,
        headers: COMPLIANCE,
      });
      expect(revoked.json().status).toBe("revoked");

      // cosign and revoke share `breakglass.cosign`, so whoever ended the grant could re-open it:
      // the old cosign matched on id alone and set status='active' whatever the current status was.
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/cosign`,
        headers: COMPLIANCE,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("BREAKGLASS_NOT_PENDING");
      expect(breakGlass.all()[0]?.status).toBe("revoked");
      await app.close();
    });

    it("an ALREADY-ACTIVE grant cannot be re-co-signed → 409 (no second cosigner overwrite)", async () => {
      const { app } = makeServer({ cosignRequired: true });
      const eventId = await invokeGlass(app, CLINICIAN);
      const first = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/cosign`,
        headers: COMPLIANCE,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${eventId}/cosign`,
        headers: BOTH,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("BREAKGLASS_NOT_PENDING");
      await app.close();
    });
  });

  describe("§7.5 auditor engagement, least privilege + accountability", () => {
    it("creates an engagement, enrolls an auditor (M2 mints the link), reports the summary", async () => {
      const { app, auditorSessions, auditSink, notifier } = makeServer();
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: {
          engagementType: "cms_survey",
          auditorAgency: "CMS Region IX",
          scope: { tenantWide: true },
          startAt: "2026-07-01T00:00:00.000Z",
          endAt: "2026-07-15T00:00:00.000Z",
        },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json()).toMatchObject({ status: "scheduled" });
      expect(notifier.delivered().some((d) => d.kind === "engagement.created")).toBe(true);
      const engagementId = create.json().engagementId;

      const enroll = await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${engagementId}/auditors`,
        headers: COMPLIANCE,
        payload: { name: "Dana Auditor", email: "dana@cms.example" },
      });
      expect(enroll.statusCode).toBe(201);
      expect(enroll.body).not.toContain("magicLinkToken");
      expect(auditorSessions.mints().some((m) => m.engagementId === engagementId)).toBe(true);
      // The auditor email is redacted in the audit trail (PHI field denylist).
      const enrolled = auditSink.rows.find((r) => r.eventType === "m3.engagement.auditor_enrolled");
      expect((enrolled?.after as { email: string }).email).toBe("[REDACTED]");

      const summary = await app.inject({
        method: "GET",
        url: `/api/v1/engagements/${engagementId}/summary`,
        headers: COMPLIANCE,
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().auditorsEnrolled).toBe(1);
      await app.close();
    });

    it("DELIVERS the minted link to the auditor (token only to the delivery port, never the response)", async () => {
      const delivered: Array<{
        organizationId: string;
        engagementId: string;
        auditorEmail: string;
        token: string;
        expiresAt: Date;
      }> = [];
      const { app, auditorSessions } = makeServer({
        auditorLinkDelivery: {
          async deliver(input) {
            delivered.push(input);
          },
        },
      });
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: {
          engagementType: "cms_survey",
          auditorAgency: "CMS",
          scope: { tenantWide: true },
          startAt: "2026-07-01T00:00:00.000Z",
          endAt: "2026-07-15T00:00:00.000Z",
        },
      });
      const engagementId = create.json().engagementId;
      const enroll = await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${engagementId}/auditors`,
        headers: COMPLIANCE,
        payload: { name: "Dana Auditor", email: "dana@cms.example" },
      });
      expect(enroll.statusCode).toBe(201);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        organizationId: "org_a",
        engagementId,
        auditorEmail: "dana@cms.example",
        expiresAt: new Date("2026-07-15T00:00:00.000Z"),
      });
      expect(delivered[0]?.token.length).toBeGreaterThan(8);
      expect(enroll.body).not.toContain(delivered[0]?.token ?? "never");
      expect(auditorSessions.mints()).toHaveLength(1);
      await app.close();
    });

    it("FAILS the enrolment (503) when delivery fails, and records no enrolment", async () => {
      const { app } = makeServer({
        auditorLinkDelivery: {
          async deliver() {
            throw new Error("smtp down: secret-detail");
          },
        },
      });
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: {
          engagementType: "cms_survey",
          auditorAgency: "CMS",
          scope: { tenantWide: true },
          startAt: "2026-07-01T00:00:00.000Z",
          endAt: "2026-07-15T00:00:00.000Z",
        },
      });
      const engagementId = create.json().engagementId;
      const enroll = await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${engagementId}/auditors`,
        headers: COMPLIANCE,
        payload: { name: "Dana Auditor", email: "dana@cms.example" },
      });
      expect(enroll.statusCode).toBe(503);
      expect(enroll.json().error.code).toBe("AUDITOR_LINK_DELIVERY_FAILED");
      expect(enroll.body).not.toContain("secret-detail");
      const summary = await app.inject({
        method: "GET",
        url: `/api/v1/engagements/${engagementId}/summary`,
        headers: COMPLIANCE,
      });
      expect(summary.json().auditorsEnrolled).toBe(0);
      await app.close();
    });

    it("rejects an inverted engagement window → 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: {
          engagementType: "tpe_probe",
          auditorAgency: "MAC",
          startAt: "2026-07-15T00:00:00.000Z",
          endAt: "2026-07-01T00:00:00.000Z",
        },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });
  });
});

// GAP-007 — membership_role.scope / role.scope_level / expires_at are VALIDATED at grant time (spec §2.4).
describe("GAP-007 role grant scope and expiry rules", () => {
  const LOC_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const LOC_Y = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const PE_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const assign = (app: ReturnType<typeof makeServer>["app"], payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/memberships/${MEMBERSHIP}/roles`,
      headers: ADMIN,
      payload,
    });
  const locationRole = roleView({
    roleId: "role_loc",
    organizationId: "org_a",
    key: "loc_role",
    scopeLevel: "location",
  });
  const locumRole = roleView({
    roleId: "role_locum",
    organizationId: "org_a",
    key: "locum",
    category: "temporary_special",
  });
  const orgRole = roleView({ roleId: "role_org", organizationId: "org_a", key: "org_role" });
  const patientRole = roleView({
    roleId: "role_pt",
    organizationId: "org_a",
    key: "pt_role",
    scopeLevel: "patient",
  });
  const issues = (res: { json(): { error: { details?: { code: string }[] } } }) =>
    (res.json().error.details ?? []).map((d) => d.code);

  it("a location-scoped role cannot be granted org-wide, but can with location ids", async () => {
    const { app, membershipRoles } = makeServer({ extraRoles: [locationRole] });
    const wide = await assign(app, { roleId: "role_loc" });
    expect(wide.statusCode).toBe(422);
    expect(issues(wide)).toContain("ROLE_REQUIRES_NARROWING");
    expect(await membershipRoles.store.listForMembership(MEMBERSHIP)).toEqual([]);
    const ok = await assign(app, { roleId: "role_loc", scope: { locationIds: [LOC_X] } });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it("a location-scoped role rests on the membership's own default locations when no scope is named", async () => {
    const { app } = makeServer({
      extraRoles: [locationRole],
      reach: { providerEntityIds: [], locationIds: [LOC_X] },
    });
    expect((await assign(app, { roleId: "role_loc" })).statusCode).toBe(201);
    await app.close();
  });

  it("a scope wider than the role's level, or outside the membership's reach, is refused", async () => {
    const { app } = makeServer({
      extraRoles: [locationRole, orgRole],
      reach: { providerEntityIds: [PE_1], locationIds: [LOC_X] },
    });
    const wider = await assign(app, {
      roleId: "role_loc",
      scope: { locationIds: [LOC_X], providerEntityIds: [PE_1] },
    });
    expect(issues(wider)).toContain("SCOPE_WIDER_THAN_ROLE");
    const outside = await assign(app, { roleId: "role_org", scope: { locationIds: [LOC_Y] } });
    expect(outside.statusCode).toBe(422);
    expect(issues(outside)).toContain("SCOPE_OUTSIDE_MEMBERSHIP");
    await app.close();
  });

  it("an unknown or non-uuid scope shape is refused (no free-form write-only blob)", async () => {
    const { app } = makeServer({ extraRoles: [orgRole] });
    const unknownKey = await assign(app, { roleId: "role_org", scope: { floor: "3" } });
    expect(issues(unknownKey)).toContain("SCOPE_MALFORMED");
    const badIds = await assign(app, { roleId: "role_org", scope: { locationIds: ["nope"] } });
    expect(issues(badIds)).toContain("SCOPE_MALFORMED");
    await app.close();
  });

  it("patient-level scope is refused with its own code (patient reach is the caseload model)", async () => {
    const { app } = makeServer({ extraRoles: [orgRole] });
    const res = await assign(app, {
      roleId: "role_org",
      scope: { patientIds: [LOC_X] },
    });
    expect(res.statusCode).toBe(422);
    expect(issues(res)).toEqual(["PATIENT_SCOPE_UNSUPPORTED"]);
    await app.close();
  });

  it("a patient-scoped role is not grantable to a membership", async () => {
    const { app } = makeServer({ extraRoles: [patientRole] });
    expect(issues(await assign(app, { roleId: "role_pt" }))).toContain("ROLE_NOT_ASSIGNABLE");
    await app.close();
  });

  it("a time-bound role requires a future expiresAt; any past expiresAt is refused", async () => {
    const { app } = makeServer({ extraRoles: [locumRole, orgRole] });
    const missing = await assign(app, { roleId: "role_locum" });
    expect(missing.statusCode).toBe(422);
    expect(issues(missing)).toContain("EXPIRY_REQUIRED");
    const past = await assign(app, { roleId: "role_org", expiresAt: "2020-01-01T00:00:00Z" });
    expect(issues(past)).toContain("EXPIRY_NOT_FUTURE");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await assign(app, { roleId: "role_locum", expiresAt: future })).statusCode).toBe(201);
    await app.close();
  });
});
