// M34 onboarding wizard v2 - the platform and tenant routes driven through the REAL guards (RBAC, the M34 ABAC
// predicates, step-up, the AI-actor block) over the in-memory wizard store:
//   platform: GET onboarding, POST skip | attest | reopen, PATCH org-profile, PUT compliance-officer,
//             POST go-live/approve | revoke
//   tenant:   GET onboarding, POST start | attest | complete | reopen | block, PATCH org-profile,
//             PUT compliance-officer, POST go-live/attest
// The rules themselves (sequence, owner, evidence, go-live) are proven in onboarding-wizard-service.test.ts; this file
// proves each route composes the right guards and maps a refusal to the typed envelope.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
  createMemoryOrgProfile,
  createMemoryWizardRunner,
  createMemoryWizardState,
  createOnboardingWizard,
  memoryMember,
  memoryTask,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import type { StepTemplate } from "../src/modules/34-saas-tenant-platform/onboarding/model";

const PLATFORM_ORG = "99999999-9999-4999-8999-999999999999";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const OFFICER_MEMBERSHIP = "30000000-0000-4000-8000-0000000000c0";

const tpl = (key: string, sequence: number, over: Partial<StepTemplate> = {}): StepTemplate => ({
  key,
  title: key,
  description: "",
  sequence,
  owner: "platform_ops",
  completionMode: "attestation",
  optional: false,
  canonical: true,
  ...over,
});
const TEMPLATES = [
  tpl("organisation", 1),
  tpl("billing", 2, { owner: "either" }),
  tpl("go_live_checklist_complete", 3, { owner: "compliance_officer" }),
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId =
    request.headers["x-test-membership"] ?? "30000000-0000-4000-8000-000000000001";
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  if (request.headers["x-actor-kind"])
    request.context.attributes.actorKind = request.headers["x-actor-kind"];
}

const OPS = { "x-test-user": "ops", "x-test-org": PLATFORM_ORG, "x-test-roles": "platform_ops" };
const ADMIN = {
  "x-test-user": "admin",
  "x-test-org": TENANT_ORG,
  "x-test-roles": "org_admin",
  "x-test-membership": "30000000-0000-4000-8000-0000000000ad",
};
const OFFICER = {
  "x-test-user": "co",
  "x-test-org": TENANT_ORG,
  "x-test-roles": "compliance_officer",
  "x-test-membership": OFFICER_MEMBERSHIP,
};
const FRESH = { "x-step-up": "fresh" };

const PLATFORM_KEYS = [
  "onboarding.read_platform",
  "onboarding.skip",
  "onboarding.manage_platform",
  "go_live.approve_platform",
];
const TENANT_ADMIN_KEYS = ["onboarding.read_own", "onboarding.update", "onboarding.manage_own"];
const OFFICER_KEYS = ["onboarding.read_own", "go_live.attest"];

function makeServer() {
  const state = createMemoryWizardState({
    tenants: [
      {
        tenantAccountId: TENANT,
        organizationId: TENANT_ORG,
        orgSlug: "acme",
        status: "onboarding",
        legalBusinessName: "Acme",
        complianceOfficerMembershipId: null,
      },
    ],
    templates: TEMPLATES,
    tasks: TEMPLATES.map((t) => memoryTask(TENANT, t.key)),
    members: new Map([memoryMember(TENANT_ORG, OFFICER_MEMBERSHIP, "co", ["compliance_officer"])]),
    baa: new Map([[TENANT, { baaStatus: "executed", expiresOn: "2028-01-01" }]]),
    profiles: new Map([[TENANT_ORG, { displayName: "Acme", orgTimezone: "America/New_York" }]]),
  });
  const wizard = createOnboardingWizard({
    runner: createMemoryWizardRunner(state),
    orgProfile: createMemoryOrgProfile(state),
  });
  const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
    orgId,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant(PLATFORM_ORG, "ops", PLATFORM_KEYS),
      grant(TENANT_ORG, "admin", TENANT_ADMIN_KEYS),
      grant(TENANT_ORG, "co", OFFICER_KEYS),
    ]).store,
  );
  const resolver: TenantPlatformAbacResolver = {
    async hasActiveConsentedSupportSession() {
      return false;
    },
    async loadConsentGrant() {
      return null;
    },
    async loadFeatureFlag() {
      return null;
    },
    async loadOnboardingTask() {
      return null;
    },
  };
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => false }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const registered: { method: string | string[]; url: string; config: unknown }[] = [];
  app.addHook("onRoute", (route) => {
    registered.push({ method: route.method, url: route.url, config: route.config });
  });
  mountTenantPlatformRoutes(app, {} as DbClient, { onboarding: { wizard } });
  const id = (key: string) => (state.tasks.find((t) => t.templateKey === key) as { id: string }).id;
  return { app, state, id, registered };
}

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

const attest = {
  evidenceNote: "signed order form on file",
  evidenceRef: "DOC-1",
  reason: "customer confirmed by phone",
};

describe("platform onboarding routes", () => {
  it("reads the ordered wizard, keeps the older names as aliases, and 404s an unknown slug", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants/acme/onboarding",
      headers: OPS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.steps.map((s: { key: string }) => s.key)).toEqual(TEMPLATES.map((t) => t.key));
    expect(body.currentStepKey).toBe("organisation");
    expect(body.currentStep).toBe("organisation");
    expect(body.tasks).toEqual(body.steps);
    expect(body.steps[1]).toMatchObject({ locked: true, lockedBy: "organisation" });
    expect(body.goLive.state).toBe("not_ready");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/platform/tenants/nope/onboarding",
          headers: OPS,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("denies the read to a tenant org_admin and to no session", async () => {
    const { app } = makeServer();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/platform/tenants/acme/onboarding",
          headers: ADMIN,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/platform/tenants/acme/onboarding" }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });

  it("attest needs step-up, a human actor and a reason; it stores the evidence and refuses out of order", async () => {
    const { app, id } = makeServer();
    const url = (key: string) => `/api/v1/platform/tenants/acme/onboarding/${id(key)}/attest`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: url("organisation"),
          headers: OPS,
          payload: attest,
        })
      ).statusCode,
    ).toBe(403);
    const stepped = { ...OPS, ...FRESH };
    const ai = await app.inject({
      method: "POST",
      url: url("organisation"),
      headers: { ...stepped, "x-actor-kind": "ai_agent" },
      payload: attest,
    });
    expect(ai.statusCode).toBe(403);
    expect(ai.json().error.message).toContain("AI principals");
    expect(
      (
        await app.inject({
          method: "POST",
          url: url("organisation"),
          headers: stepped,
          payload: { evidenceNote: "ok" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: url("organisation"),
          headers: stepped,
          payload: { ...attest, evidenceNote: "x".repeat(2001) },
        })
      ).statusCode,
    ).toBe(422);
    const outOfOrder = await app.inject({
      method: "POST",
      url: url("billing"),
      headers: stepped,
      payload: attest,
    });
    expect(outOfOrder.statusCode).toBe(409);
    expect(outOfOrder.json().error.code).toBe("ONBOARDING_STEP_OUT_OF_ORDER");
    const ok = await app.inject({
      method: "POST",
      url: url("organisation"),
      headers: stepped,
      payload: attest,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: "done",
      evidence: { note: "signed order form on file", ref: "DOC-1" },
      attestedBy: { actorKind: "platform_ops" },
    });
    await app.close();
  });

  it("skip, re-open, org profile and compliance officer each need step-up and are denied to a tenant admin", async () => {
    const { app, id } = makeServer();
    const stepped = { ...OPS, ...FRESH };
    const skip = `/api/v1/platform/tenants/acme/onboarding/${id("organisation")}/skip`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: skip,
          headers: OPS,
          payload: { skipRationale: "customer migrating" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: skip,
          headers: { ...ADMIN, ...FRESH },
          payload: { skipRationale: "customer migrating" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: skip,
          headers: stepped,
          payload: { skipRationale: "customer migrating" },
        })
      ).json().status,
    ).toBe("skipped");

    const reopen = `/api/v1/platform/tenants/acme/onboarding/${id("organisation")}/reopen`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: reopen,
          headers: OPS,
          payload: { reason: "recorded the wrong name" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: reopen,
          headers: stepped,
          payload: { reason: "short" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: reopen,
          headers: stepped,
          payload: { reason: "recorded the wrong name" },
        })
      ).json().status,
    ).toBe("in_progress");

    const profile = "/api/v1/platform/tenants/acme/org-profile";
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: profile,
          headers: OPS,
          payload: { orgTimezone: "America/Chicago" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: profile,
          headers: stepped,
          payload: { orgTimezone: "Mars/Olympus" },
        })
      ).json().error.code,
    ).toBe("INVALID_ORG_TIMEZONE");
    expect(
      (await app.inject({ method: "PATCH", url: profile, headers: stepped, payload: {} }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: profile,
          headers: stepped,
          payload: { orgTimezone: "America/Chicago", displayName: "Acme Hospice" },
        })
      ).json(),
    ).toEqual({ orgTimezone: "America/Chicago", displayName: "Acme Hospice" });

    const officer = "/api/v1/platform/tenants/acme/compliance-officer";
    const reason = "customer named a new officer on the call";
    expect(
      (
        await app.inject({
          method: "PUT",
          url: officer,
          headers: OPS,
          payload: { membershipId: OFFICER_MEMBERSHIP, reason },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: officer,
          headers: stepped,
          payload: { membershipId: "30000000-0000-4000-8000-0000000000ff", reason },
        })
      ).json().error.code,
    ).toBe("COMPLIANCE_OFFICER_NOT_A_MEMBER");
    // a platform assignment says why: no reason, or one outside 8 to 500 characters, is refused before anything is written
    for (const payload of [
      { membershipId: OFFICER_MEMBERSHIP },
      { membershipId: OFFICER_MEMBERSHIP, reason: "short" },
      { membershipId: OFFICER_MEMBERSHIP, reason: "r".repeat(501) },
    ]) {
      const refused = await app.inject({ method: "PUT", url: officer, headers: stepped, payload });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(refused.statusCode).toBeLessThan(500);
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: officer,
          headers: stepped,
          payload: { membershipId: OFFICER_MEMBERSHIP, reason },
        })
      ).json(),
    ).toEqual({ complianceOfficerMembershipId: OFFICER_MEMBERSHIP });
    await app.close();
  });

  it("approving needs a pending attestation: without one it is refused 409 and nothing changes", async () => {
    const { app, state } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants/acme/go-live/approve",
      headers: { ...OPS, ...FRESH },
      payload: { reason: "reviewed everything twice" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("GO_LIVE_NOT_ATTESTED");
    expect(state.tenants[0]?.status).toBe("onboarding");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/platform/tenants/acme/go-live/approve",
          headers: OPS,
          payload: { reason: "reviewed everything twice" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/platform/tenants/acme/go-live/revoke",
          headers: { ...ADMIN, ...FRESH },
          payload: { reason: "reviewed everything twice" },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe("tenant onboarding routes", () => {
  it("any holder of onboarding.read_own reads the wizard, including the compliance officer", async () => {
    const { app } = makeServer();
    for (const headers of [ADMIN, OFFICER]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/tenant/onboarding", headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual(res.json().steps);
      expect(res.json()).toMatchObject({ hasMore: false, nextCursor: null });
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/tenant/onboarding" })).statusCode).toBe(
      401,
    );
    await app.close();
  });

  it("declares a read-audit event for the tenant wizard read, as the platform read does", async () => {
    const { app, registered } = makeServer();
    const read = registered.find(
      (r) => r.method === "GET" && r.url === "/api/v1/tenant/onboarding",
    );
    expect(read?.config).toMatchObject({
      auditRead: { resourceKind: "onboarding_task", list: true },
    });
    await app.close();
  });

  it("never returns a platform operator's membership to the tenant, and still returns the reason", async () => {
    const { app, state } = makeServer();
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "organisation"
        ? {
            ...t,
            status: "done" as const,
            evidenceNote: "legal name confirmed",
            attestedByMembershipId: "40000000-0000-4000-8000-0000000000aa",
            attestedByActorKind: "platform_ops" as const,
            attestedAt: new Date("2026-11-05T12:00:00Z"),
          }
        : t,
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/onboarding",
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("40000000-0000-4000-8000-0000000000aa");
    expect(res.json().steps[0]).toMatchObject({
      evidence: { note: "legal name confirmed" },
      attestedBy: {
        membershipId: null,
        actorKind: "platform_ops",
        label: "ChartWarden operations",
        at: "2026-11-05T12:00:00.000Z",
      },
    });
    await app.close();
  });

  it("a step the org_admin does not own is refused 403, an owned one is attested in order and the deprecated /complete is the same", async () => {
    const { app, state, id } = makeServer();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tenant/onboarding/${id("organisation")}/attest`,
          headers: ADMIN,
          payload: { evidenceNote: "done" },
        })
      ).json().error.code,
    ).toBe("ONBOARDING_STEP_OWNER_MISMATCH");
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "organisation" ? { ...t, status: "done" as const } : t,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tenant/onboarding/${id("billing")}/complete`,
          headers: ADMIN,
          payload: {},
        })
      ).json().error.code,
    ).toBe("ONBOARDING_EVIDENCE_REQUIRED");
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${id("billing")}/complete`,
      headers: ADMIN,
      payload: { evidenceNote: "chose Stedi" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "done", attestedBy: { actorKind: "tenant" } });
    await app.close();
  });

  it("an AI principal cannot start, block, attest or re-open", async () => {
    const { app, id } = makeServer();
    const ai = { ...ADMIN, "x-actor-kind": "ai_agent" };
    for (const action of ["start", "block"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tenant/onboarding/${id("billing")}/${action}`,
        headers: ai,
        payload: action === "block" ? { blockerReason: "waiting on the customer" } : {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain("AI principals");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tenant/onboarding/${id("billing")}/attest`,
          headers: ai,
          payload: { evidenceNote: "done" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tenant/onboarding/${id("billing")}/reopen`,
          headers: ai,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("a tenant re-open without a written reason is refused before the service runs", async () => {
    const { app, state, id } = makeServer();
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "organisation" ? { ...t, status: "done" as const } : t,
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${id("billing")}/attest`,
      headers: ADMIN,
      payload: { evidenceNote: "chose Stedi" },
    });
    for (const payload of [{}, { reason: "no" }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tenant/onboarding/${id("billing")}/reopen`,
        headers: ADMIN,
        payload,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(state.tasks.find((t) => t.templateKey === "billing")?.status).toBe("done");
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${id("billing")}/reopen`,
      headers: ADMIN,
      payload: { reason: "chose the wrong vendor" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("org profile is the org_admin's alone; the compliance officer assignment also needs step-up", async () => {
    const { app } = makeServer();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/tenant/org-profile",
          headers: ADMIN,
          payload: { orgTimezone: "America/Denver" },
        })
      ).json().orgTimezone,
    ).toBe("America/Denver");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/tenant/org-profile",
          headers: OFFICER,
          payload: { orgTimezone: "America/Denver" },
        })
      ).statusCode,
    ).toBe(403);
    const url = "/api/v1/tenant/compliance-officer";
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: ADMIN,
          payload: { membershipId: OFFICER_MEMBERSHIP },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: { ...ADMIN, ...FRESH },
          payload: { membershipId: OFFICER_MEMBERSHIP },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("go-live attestation is the compliance officer's alone, needs step-up and explicit confirmation", async () => {
    const { app, state } = makeServer();
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "go_live_checklist_complete" ? t : { ...t, status: "done" as const },
    );
    const url = "/api/v1/tenant/go-live/attest";
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...ADMIN, ...FRESH },
          payload: { attestationConfirmed: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: OFFICER,
          payload: { attestationConfirmed: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url, headers: { ...OFFICER, ...FRESH }, payload: {} }))
        .statusCode,
    ).toBe(422);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { ...OFFICER, ...FRESH },
      payload: { attestationConfirmed: true, note: "reviewed" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().goLive).toMatchObject({
      state: "awaiting_approval",
      attestation: { status: "pending", attestationNote: "reviewed" },
    });
    await app.close();
  });
});
