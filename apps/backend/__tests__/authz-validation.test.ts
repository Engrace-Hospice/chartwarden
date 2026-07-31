// apps/backend/__tests__/authz-validation.test.ts — M3 route-boundary validation (§4.2/§4.3).
//
// M3's routes previously read their bodies with ad-hoc `typeof x === "string"` probes: an
// off-vocabulary `category`, a non-uuid `target_patient_id`, or a garbage `expiresAt` sailed
// through the handler and only failed at the INSERT — a pgEnum/uuid cast error surfacing as a 500,
// on the surface that GRANTS PERMISSIONS. Every body + path param is now checked against
// `routes/authz-typebox` at the boundary (the M24/M30 `parse(...)` precedent).
//
// These tests pin two things: the refusals themselves, and — just as important — the ORDER they
// happen in. Validation must never preempt the §6 meta-permission gate or a route's existence
// lookup, or the §9.3 IDOR guarantees change shape: an unauthorized actor must still see 403 (a
// 422 would confirm the route/object exists), and an authorized actor must still see 404 for an
// absent object. authz-idor.test.ts owns the disclosure matrix; this file owns the boundary.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import {
  type AuthzRouteDeps,
  createFixedPermissionResolver,
  createInMemoryAuditorSessionMinter,
  createInMemoryBreakGlassStore,
  createInMemoryComplianceNotifier,
  createInMemoryEngagementStore,
  createInMemoryMembershipRoleStore,
  createInMemoryRoleStore,
  registerAuthorizationRoutes,
} from "../src/modules/03-authorization/index";

/** Test-only auth shim: populate request.context from headers (mirrors authz-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

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
];

function makeServer() {
  const roles = createInMemoryRoleStore();
  const membershipRoles = createInMemoryMembershipRoleStore();
  const breakGlass = createInMemoryBreakGlassStore();
  const engagements = createInMemoryEngagementStore();
  const auditorSessions = createInMemoryAuditorSessionMinter();
  const notifier = createInMemoryComplianceNotifier();
  const perms = createFixedPermissionResolver(PERMISSION_SEED);
  const auditSink = createInMemoryAuditExecutor();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: s.organizationId,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const deps: AuthzRouteDeps = {
    roles: roles.store,
    membershipRoles: membershipRoles.store,
    breakGlass: breakGlass.store,
    engagements: engagements.store,
    auditorSessions: auditorSessions.minter,
    notifier: notifier.notifier,
    effectivePermissions: perms.resolver,
    audit: auditSink.executor,
  };
  registerAuthorizationRoutes(app, deps);
  return { app, roles, membershipRoles, engagements, auditSink };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_a", "x-test-roles": "org_admin" };
const COMPLIANCE = { "x-test-user": "co_1", "x-test-org": "org_a", "x-test-roles": "compliance" };
const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": "org_a", "x-test-roles": "clinical_rn" };

const MISSING = "00000000-0000-0000-0000-000000000000"; // valid uuid, absent object
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PATIENT = "11111111-1111-4111-8111-111111111111";

/** A well-formed create-role body the cases below mutate one field at a time. */
const VALID_ROLE = {
  key: "weekend_float_rn",
  name: "Weekend Float RN",
  category: "temporary_special",
  permissionKeys: ["patient.read"],
};

/** A well-formed create-engagement body. */
const VALID_ENGAGEMENT = {
  engagementType: "cms_survey",
  auditorAgency: "CMS Region IX",
  startAt: "2026-07-01T00:00:00.000Z",
  endAt: "2026-07-15T00:00:00.000Z",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M3 route-boundary validation (§4.2)", () => {
  describe("pgEnum-backed vocabularies are closed at the boundary, not at the INSERT", () => {
    it("POST /roles — an off-vocabulary `category` → 422 VALIDATION_FAILED naming the field", async () => {
      const { app, roles } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: { ...VALID_ROLE, category: "not_a_role_category" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
      expect(res.json().error.details[0].field).toBe("category");
      // …and nothing was written: an invalid category never reaches `role_category`.
      expect(roles.all("org_a").some((r) => r.key === VALID_ROLE.key)).toBe(false);
      await app.close();
    });

    it("POST /roles — an off-vocabulary `scopeLevel` → 422 (would widen the grant)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: { ...VALID_ROLE, scopeLevel: "galaxy" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("scopeLevel");
      await app.close();
    });

    it("POST /roles — every `scope_level` enum value is accepted (the union is not too tight)", async () => {
      const { app } = makeServer();
      for (const scopeLevel of ["organization", "provider_entity", "location", "patient"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/roles",
          headers: ADMIN,
          payload: { ...VALID_ROLE, key: `float_${scopeLevel}`, scopeLevel },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().scopeLevel).toBe(scopeLevel);
      }
      await app.close();
    });

    it("POST /engagements — an off-vocabulary `engagementType` → 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: { ...VALID_ENGAGEMENT, engagementType: "friendly_visit" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("engagementType");
      await app.close();
    });
  });

  describe("uuid / timestamptz columns reached without a prior lookup", () => {
    it("POST /breakglass — a non-uuid `targetPatientId` → 422 (the column is uuid)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: { targetPatientId: "pat_42", reason: "covering nurse, chest pain emergency" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("targetPatientId");
      await app.close();
    });

    it("POST /breakglass — an absent target is still scope-level glass (201, not a 422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: { reason: "unit-wide outage, covering the whole census" },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it("POST /breakglass — a keystroke reason → 422 (§7.4 D1 ≥10 chars)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        headers: CLINICIAN,
        payload: { targetPatientId: PATIENT, reason: "oops" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
      await app.close();
    });

    it("POST /memberships/:id/roles — a non-uuid membership id → 422 (the FK is uuid)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/memberships/not-a-uuid/roles",
        headers: ADMIN,
        payload: { roleId: "tmpl_administrator" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("POST /memberships/:id/roles — a garbage `expiresAt` → 422 (the column is timestamptz)", async () => {
      const { app, membershipRoles } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/memberships/${MEMBERSHIP}/roles`,
        headers: ADMIN,
        payload: { roleId: "tmpl_administrator", expiresAt: "next tuesday" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("expiresAt");
      expect(membershipRoles.grantsFor(MEMBERSHIP)).toHaveLength(0);
      await app.close();
    });

    it("POST /engagements — a non-instant `startAt` → 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: { ...VALID_ENGAGEMENT, startAt: "July" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("POST /engagements/:id/auditors — a malformed email → 422 before M2 mints a link", async () => {
      const { app } = makeServer();
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: COMPLIANCE,
        payload: VALID_ENGAGEMENT,
      });
      const engagementId = create.json().engagementId;
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${engagementId}/auditors`,
        headers: COMPLIANCE,
        payload: { name: "Dana Auditor", email: "dana(at)cms.example" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("email");
      await app.close();
    });
  });

  describe("shape errors that used to pass silently", () => {
    it("PATCH /roles/:id — `enabled: \"yes\"` → 422 (it was previously ignored as a no-op)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/tmpl_administrator",
        headers: ADMIN,
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].field).toBe("enabled");
      await app.close();
    });

    it("POST /roles — an unknown property → 422 (a typo'd field is not silently dropped)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: { ...VALID_ROLE, permisionKeys: ["org.delete"] }, // sic — one 's'
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("POST /roles — a malformed permission key → 422 before the escalation check", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: { ...VALID_ROLE, permissionKeys: ["Patient Read"] },
      });
      expect(res.statusCode).toBe(422);
      // A shape error is not an escalation ATTEMPT — it must not pollute the §6 audit signal.
      expect(auditSink.rows.some((r) => r.eventType === "m3.authz.escalation_blocked")).toBe(false);
      await app.close();
    });

    it("PATCH /roles/:id — `permissionKeys: []` is still a meaningful strip, not a missing field", async () => {
      const { app } = makeServer();
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: ADMIN,
        payload: VALID_ROLE,
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${created.json().roleId}`,
        headers: ADMIN,
        payload: { permissionKeys: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().permissionKeys).toEqual([]);
      await app.close();
    });
  });

  describe("ordering: validation never preempts the §6 gate or the existence lookup", () => {
    it("an actor without the meta-permission + an invalid body → 403, never 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: CLINICIAN, // holds only breakglass.invoke
        payload: { category: "not_a_role_category" },
      });
      // A 422 here would confirm the route exists and the actor got past the gate.
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("an authorized actor + an absent object + an invalid body → 404, never 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${MISSING}`,
        headers: ADMIN,
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });

    it("an unauthenticated caller + an invalid body → 401, never 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/breakglass",
        payload: { reason: "x" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
