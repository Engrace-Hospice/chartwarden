// A tenant's first admin must be able to sign in and finish onboarding while the organization is still `created`, but no
// clinical route may open before go-live: the gate is an allowlist on the authenticate hook (see bootstrap/onboarding-org-gate.ts).
import {
  type ResolvedActor,
  STEP_UP_POLICY,
  type SessionContextResolver,
} from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";
import {
  PRE_ACTIVATION_ALLOWED_ROOTS,
  createOrganizationStageReader,
  preActivationMayCall,
} from "../src/bootstrap/onboarding-org-gate";

const ORG = "33333333-3333-4333-8333-333333333333";
const actor: ResolvedActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  roles: ["org_admin"],
  providerEntityIds: [],
  locationIds: [],
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
};
const resolver: SessionContextResolver = {
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
};

function request(method: string, url: string): FastifyRequest {
  return {
    method,
    url,
    headers: {},
    context: {
      userId: "",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      attributes: {},
    },
  } as unknown as FastifyRequest;
}

const hook = (
  preActivation: boolean | (() => Promise<boolean>),
  activeOrganizationId: string | null = ORG,
) =>
  createSessionAuthenticate({
    getSnapshot: async () => ({
      sessionId: "session-1",
      userId: actor.userId,
      activeOrganizationId,
    }),
    getResolver: () => resolver,
    organizationStage: {
      isPreActivation:
        typeof preActivation === "boolean" ? async () => preActivation : preActivation,
    },
  });

describe("preActivationMayCall", () => {
  it.each([
    "/api/auth/get-session",
    "/api/v1/auth/select-organization",
    "/api/v1/me/permissions",
    "/api/v1/sessions/step-up",
    "/api/v1/sessions/step-up/initiate",
    "/api/v1/tenant/onboarding",
    "/api/v1/tenant/onboarding/abc/attest?x=1",
    "/api/v1/tenant/go-live/attest",
    "/api/v1/tenant/account",
    `/api/v1/orgs/${ORG}/invitations`,
    "/api/v1/locations",
    "/api/v1/provider-entities/abc",
    "/api/v1/memberships/abc/roles",
    "/api/v1/roles",
    "/health",
  ])("allows %s", (url) => {
    expect(preActivationMayCall(url)).toBe(true);
  });

  it.each([
    "/api/v1/patients",
    "/api/v1/patients/abc/chart",
    "/api/v1/admissions",
    "/api/v1/encounters",
    "/api/v1/claims",
    "/api/v1/messages",
    "/api/v1/portal/me",
    "/api/v1/documents",
    "/api/v1/platform/organizations",
    "/api/v1/users/abc/deactivate",
    // look-alikes: a prefix is a path root, not a string prefix
    "/api/v1/tenants",
    "/api/v1/tenant-export",
    "/api/v1/orgs-secret",
    "/api/v1/me-too",
    // an encoded or dotted path must not borrow an allowed root to reach a route outside it
    "/api/v1/tenant/../patients",
    "/api/v1/me/%2e%2e/patients",
    "/api/v1/tenant/..%2fpatients",
    "/api/v1/tenant%5c..%5cpatients",
    "/api/v1/%zz",
    "",
  ])("refuses %s", (url) => {
    expect(preActivationMayCall(url)).toBe(false);
  });

  it("every allowed root is a bare path root", () => {
    for (const root of PRE_ACTIVATION_ALLOWED_ROOTS) {
      expect(root.startsWith("/")).toBe(true);
      expect(root.endsWith("/")).toBe(false);
    }
  });
});

describe("authenticate on a not-yet-live organization", () => {
  it("refuses a clinical route with 403 ORGANIZATION_ONBOARDING, whatever the method", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/patients"],
      ["POST", "/api/v1/patients"],
      ["GET", "/api/v1/patients/abc"],
      ["PATCH", "/api/v1/admissions/abc"],
      ["POST", "/api/v1/claims/abc/submit"],
    ] as const) {
      await expect(hook(true)(request(method, url)), `${method} ${url}`).rejects.toMatchObject({
        code: "ORGANIZATION_ONBOARDING",
        statusCode: 403,
      });
    }
  });

  it("lets the onboarding, go-live, account and identity routes through, org-bound as usual", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/tenant/onboarding"],
      ["POST", "/api/v1/tenant/go-live/attest"],
      ["GET", "/api/v1/tenant/account"],
      ["GET", "/api/v1/me/permissions"],
      ["POST", `/api/v1/orgs/${ORG}/invitations`],
    ] as const) {
      const req = request(method, url);
      await expect(hook(true)(req), `${method} ${url}`).resolves.toBeUndefined();
      expect(req.context.organizationId).toBe(ORG);
    }
  });

  it("changes nothing once the organization is active", async () => {
    const req = request("GET", "/api/v1/patients");
    await expect(hook(false)(req)).resolves.toBeUndefined();
    expect(req.context.organizationId).toBe(ORG);
  });

  it("is not consulted before an organization is bound (the picker, sign-in)", async () => {
    const stage = vi.fn(async () => true);
    const req = request("GET", "/api/v1/auth/memberships");
    await expect(hook(stage, null)(req)).resolves.toBeUndefined();
    expect(stage).not.toHaveBeenCalled();
  });

  it("fails closed when the stage cannot be read: the request errors, it never skips the gate", async () => {
    const broken = hook(async () => {
      throw new Error("organization status unavailable");
    });
    await expect(broken(request("GET", "/api/v1/patients"))).rejects.toThrow(
      /organization status unavailable/,
    );
  });
});

describe("createOrganizationStageReader", () => {
  it("reads `created` as pre-activation and anything else as live, caching briefly", async () => {
    let clock = 0;
    const read = vi.fn(async () => "created" as const);
    const reader = createOrganizationStageReader(read, { ttlMs: 1_000, now: () => clock });

    expect(await reader.isPreActivation(ORG)).toBe(true);
    expect(await reader.isPreActivation(ORG)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    clock = 1_000;
    read.mockResolvedValueOnce("active" as never);
    expect(await reader.isPreActivation(ORG)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidate makes an activation visible at once", async () => {
    let status: "created" | "active" = "created";
    const reader = createOrganizationStageReader(async () => status, { ttlMs: 60_000 });
    expect(await reader.isPreActivation(ORG)).toBe(true);
    status = "active";
    expect(await reader.isPreActivation(ORG)).toBe(true); // still cached
    reader.invalidate(ORG);
    expect(await reader.isPreActivation(ORG)).toBe(false);
  });

  it("treats suspended, closed and unknown as not pre-activation (those sessions are revoked or never bound)", async () => {
    for (const status of ["suspended", "closed", null] as const) {
      const reader = createOrganizationStageReader(async () => status);
      expect(await reader.isPreActivation(ORG), String(status)).toBe(false);
    }
  });
});
