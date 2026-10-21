// apps/backend/__tests__/consent-routes.test.ts — M39-T07 route-inventory integration tests
// (M39 spec §4.1–4.2; the §4.7 permission handshake; §4.1 step-up; §4.12 cursor pagination).
//
// Exercises M39's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerConsentRoutes() mounts the §4.1 slice over an in-memory
// ConsentRouteService. The REAL Authorization Contract gates every route on the §4.7 keys; a
// header-auth shim populates request.context. Covers: permission gating (allow + 403 deny), the
// step-up gate on sign/revoke (denied without recent step-up, mirroring M40 merge.approve), and the
// §4.12 cursor pagination on the consent-decision audit query.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type EvalAuditRow, createInMemoryConsentRouteService } from "@chartwarden/consent";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerConsentRoutes } from "../src/modules/39-consent/index";
import {
  DEFAULT_TEST_ROLE,
  PERMISSIVE_ACCESS,
  ROLE_FOR_TEST_USER,
  installPermissiveConsentAbac,
} from "./consent-abac-harness";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PAT = "patient-1";

const PERMISSION_SEED = [
  { userId: "reader", permissions: ["consent.read_catalog", "consent.read"] },
  { userId: "author", permissions: ["consent.read_catalog", "consent.author"] },
  { userId: "signer", permissions: ["consent.sign", "consent.revoke"] },
  { userId: "compliance", permissions: ["consent.read_eval_audit"] },
  { userId: "nobody", permissions: [] },
];

function evalRow(n: number): EvalAuditRow {
  return {
    id: `ea-${n.toString().padStart(3, "0")}`,
    organizationId: ORG,
    patientId: PAT,
    consentRecordId: "c-1",
    typeKey: "42_cfr_part_2_release",
    allowed: n % 2 === 0,
    denyReason: n % 2 === 0 ? null : "no_active_recipient_matches",
    callerModule: "m28",
    evaluatedAt: `2026-06-${(10 + n).toString().padStart(2, "0")}T00:00:00.000Z`,
  };
}

function makeServer() {
  const { service } = createInMemoryConsentRouteService({
    evalAudit: [1, 2, 3, 4, 5].map(evalRow),
  });
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  installPermissiveConsentAbac();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerConsentRoutes(app, { service, access: PERMISSIVE_ACCESS });
  return { app, service };
}

function h(user: string) {
  return {
    "x-test-user": user,
    "x-test-org": ORG,
    "x-test-roles": ROLE_FOR_TEST_USER[user] ?? DEFAULT_TEST_ROLE,
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

describe("M39-T07 — consent routes (§4.1–4.2, §4.7 gating, §4.12 pagination)", () => {
  it("GET /consent-types returns the catalog for any holder of consent.read_catalog", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/consent-types",
      headers: h("reader"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0);
    await app.close();
  });

  it("denies a patient-consents read without consent.read (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PAT}/consents`,
      headers: h("nobody"),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("creates a draft for an authorizer (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PAT}/consents`,
      headers: h("author"),
      payload: {
        typeKey: "hipaa_release",
        grantorKind: "patient_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: { all: true },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe("draft");
    await app.close();
  });

  it("sign is STEP-UP gated — denied without recent step-up even with consent.sign", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consents/some-id/sign",
      headers: h("signer"),
    });
    expect(res.statusCode).toBe(403); // step_up_recent not satisfied → gate holds closed
    await app.close();
  });

  it("revoke is STEP-UP gated for staff (403 without recent step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consents/some-id/revoke",
      headers: h("signer"),
      payload: { revokedByKind: "staff", reasonText: "x".repeat(40) },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("§4.12 eval-audit query is cursor-paginated (opaque cursor, never offset)", async () => {
    const { app } = makeServer();
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/consents/eval-audit/by-patient?patientId=${PAT}&pageSize=2`,
      headers: h("compliance"),
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(2);
    expect(typeof body1.nextCursor).toBe("string");
    // newest-first: ea-005 then ea-004
    expect(body1.data[0].id).toBe("ea-005");

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/consents/eval-audit/by-patient?patientId=${PAT}&pageSize=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: h("compliance"),
    });
    const body2 = page2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.data[0].id).toBe("ea-003");
    expect(body2.data.map((r: EvalAuditRow) => r.id)).not.toContain("ea-005"); // no overlap

    await app.close();
  });

  it("denies the eval-audit query without consent.read_eval_audit (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/consents/eval-audit/by-patient?patientId=${PAT}`,
      headers: h("reader"),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
