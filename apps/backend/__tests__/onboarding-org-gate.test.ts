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
  PRE_ACTIVATION_ALLOWED_ROUTES,
  VENDOR_AUTH_ROUTE_TEMPLATE,
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

/**
 * A request as the authenticate hook sees it: `url` is what the client sent, `routeOptions.url` the TEMPLATE Fastify matched
 * (`/api/v1/tenant/onboarding/:taskId/start`). The gate decides on the template; `template` defaults to the url's own path.
 */
function request(method: string, url: string, template?: string | null): FastifyRequest {
  const routeUrl = template === undefined ? (url.split("?")[0] ?? url) : (template ?? undefined);
  return {
    method,
    url,
    routeOptions: { url: routeUrl },
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
      isConfined: typeof preActivation === "boolean" ? async () => preActivation : preActivation,
    },
  });

const may = (method: string, template: string | undefined, rawUrl = template ?? "") =>
  preActivationMayCall({ method, routeTemplate: template, rawUrl });

describe("preActivationMayCall: exact METHOD + route template pairs", () => {
  it.each([
    ["GET", "/api/v1/auth/context"],
    ["GET", "/api/v1/auth/csrf"],
    ["GET", "/api/v1/auth/memberships"],
    ["POST", "/api/v1/auth/select-organization"],
    ["POST", "/api/v1/auth/unlock"],
    ["GET", "/api/v1/me/permissions"],
    ["GET", "/api/v1/me/session"],
    ["POST", "/api/v1/sessions/step-up"],
    ["POST", "/api/v1/sessions/step-up/initiate"],
    ["GET", "/api/v1/tenant/onboarding"],
    ["POST", "/api/v1/tenant/onboarding/:taskId/attest"],
    ["POST", "/api/v1/tenant/onboarding/:taskId/start"],
    ["PATCH", "/api/v1/tenant/org-profile"],
    ["PUT", "/api/v1/tenant/compliance-officer"],
    ["POST", "/api/v1/tenant/go-live/attest"],
    ["GET", "/api/v1/tenant/account"],
    ["GET", "/api/v1/tenant/baa"],
    ["POST", "/api/v1/tenant/baa/:id/attest"],
    ["GET", "/api/v1/orgs/:id/members"],
    ["POST", "/api/v1/orgs/:id/invitations"],
    ["GET", "/api/v1/locations"],
    ["POST", "/api/v1/locations"],
    ["PATCH", "/api/v1/provider-entities/:id"],
    ["GET", "/api/v1/roles"],
    ["POST", "/api/v1/memberships/:id/roles"],
    ["GET", "/health"],
  ])("allows %s %s", (method, template) => {
    expect(may(method, template)).toBe(true);
  });

  it.each([
    // the review's findings: roots that exposed tenant-wide exports, consent grants, staff, credentials and user provisioning
    ["GET", "/api/v1/tenant/dsar-export-jobs"],
    ["GET", "/api/v1/tenant/dsar-export-jobs/:id/download"],
    ["POST", "/api/v1/tenant/dsar-export-jobs"],
    ["GET", "/api/v1/tenant/tenant-export-jobs/:id/download"],
    ["POST", "/api/v1/tenant/tenant-export-jobs"],
    ["POST", "/api/v1/tenant/support-consent-grants"],
    ["POST", "/api/v1/tenant/support-consent-grants/:id/revoke"],
    ["GET", "/api/v1/tenant/feature-flags"],
    ["POST", "/api/v1/tenant/feature-flags/:flagKey"],
    ["GET", "/api/v1/orgs/:id/care-team-staff"],
    ["GET", "/api/v1/memberships/:membershipId/credentials"],
    ["POST", "/api/v1/memberships/:membershipId/credentials"],
    ["POST", "/api/v1/orgs/:orgId/users"],
    ["POST", "/api/v1/orgs/:orgId/users/:userId/password-reset"],
    ["DELETE", "/api/v1/orgs/:id/members/:mId"],
    ["POST", "/api/v1/roles"],
    ["DELETE", "/api/v1/roles/:id"],
    // clinical, billing and platform routes
    ["GET", "/api/v1/patients"],
    ["GET", "/api/v1/patients/:id/chart"],
    ["POST", "/api/v1/claims/:id/submit"],
    ["GET", "/api/v1/platform/organizations"],
    // the right path with the wrong method, and look-alikes
    ["DELETE", "/api/v1/tenant/onboarding"],
    ["POST", "/api/v1/tenant/account"],
    ["GET", "/api/v1/tenants"],
    ["GET", "/api/v1/tenant-export"],
  ])("refuses %s %s", (method, template) => {
    expect(may(method, template)).toBe(false);
  });

  it("refuses a request that matched no route (a 404 has no template), whatever its path says", () => {
    expect(may("GET", undefined, "/api/v1/tenant/onboarding")).toBe(false);
    expect(may("GET", "", "/api/v1/tenant/onboarding")).toBe(false);
  });

  it("is decided on the matched TEMPLATE: a concrete path that merely looks allowed does not open another route", () => {
    // The router matched the export route; the URL borrowing an allowed prefix changes nothing.
    expect(
      may("GET", "/api/v1/tenant/dsar-export-jobs/:id/download", "/api/v1/tenant/onboarding/x"),
    ).toBe(false);
    // And the allowed route stays allowed whatever the concrete ids are.
    expect(
      may(
        "POST",
        "/api/v1/tenant/onboarding/:taskId/start",
        "/api/v1/tenant/onboarding/..%2fx/start",
      ),
    ).toBe(true);
  });

  it("the vendor auth catch-all is admitted only for a clean /api/auth/ path", () => {
    expect(may("GET", VENDOR_AUTH_ROUTE_TEMPLATE, "/api/auth/get-session")).toBe(true);
    expect(may("POST", VENDOR_AUTH_ROUTE_TEMPLATE, "/api/auth/two-factor/verify-totp?x=1")).toBe(
      true,
    );
    for (const raw of [
      "/api/auth/../v1/patients",
      "/api/auth/%2e%2e/v1/patients",
      "/api/auth/..%2fv1/patients",
      "/api/auth%5c..%5cpatients",
      "/api/auth/%zz",
      "/api/authx/anything",
      "",
    ]) {
      expect(may("GET", VENDOR_AUTH_ROUTE_TEMPLATE, raw), raw).toBe(false);
    }
  });

  it("every allowed entry is a bare METHOD + absolute template", () => {
    for (const entry of PRE_ACTIVATION_ALLOWED_ROUTES) {
      const [method, template, ...rest] = entry.split(" ");
      expect(rest, entry).toEqual([]);
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"], entry).toContain(method);
      expect(template?.startsWith("/"), entry).toBe(true);
      expect(template?.endsWith("/") && template !== "/", entry).toBe(false);
      expect(template?.includes("*"), entry).toBe(false);
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
    for (const [method, url, template] of [
      ["GET", "/api/v1/tenant/onboarding", undefined],
      ["POST", "/api/v1/tenant/go-live/attest", undefined],
      ["GET", "/api/v1/tenant/account", undefined],
      ["GET", "/api/v1/me/permissions", undefined],
      ["POST", `/api/v1/orgs/${ORG}/invitations`, "/api/v1/orgs/:id/invitations"],
      ["POST", "/api/v1/tenant/onboarding/abc/start", "/api/v1/tenant/onboarding/:taskId/start"],
    ] as const) {
      const req = request(method, url, template);
      await expect(hook(true)(req), `${method} ${url}`).resolves.toBeUndefined();
      expect(req.context.organizationId).toBe(ORG);
    }
  });

  it("refuses the export, consent, care-team, credentials and user-provisioning routes of a not-yet-live organization", async () => {
    for (const [method, url, template] of [
      [
        "GET",
        "/api/v1/tenant/dsar-export-jobs/abc/download",
        "/api/v1/tenant/dsar-export-jobs/:id/download",
      ],
      ["POST", "/api/v1/tenant/tenant-export-jobs", "/api/v1/tenant/tenant-export-jobs"],
      ["POST", "/api/v1/tenant/support-consent-grants", "/api/v1/tenant/support-consent-grants"],
      ["GET", `/api/v1/orgs/${ORG}/care-team-staff`, "/api/v1/orgs/:id/care-team-staff"],
      [
        "GET",
        "/api/v1/memberships/abc/credentials",
        "/api/v1/memberships/:membershipId/credentials",
      ],
      ["POST", `/api/v1/orgs/${ORG}/users`, "/api/v1/orgs/:orgId/users"],
    ] as const) {
      await expect(
        hook(true)(request(method, url, template)),
        `${method} ${url}`,
      ).rejects.toMatchObject({ code: "ORGANIZATION_ONBOARDING", statusCode: 403 });
    }
  });

  it("refuses a request that matched no route (no template) rather than trusting its path", async () => {
    await expect(
      hook(true)(request("GET", "/api/v1/tenant/onboarding", null)),
    ).rejects.toMatchObject({ code: "ORGANIZATION_ONBOARDING" });
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
  it("reads `active` as live and everything else as confined, caching briefly", async () => {
    let clock = 0;
    const read = vi.fn(async () => "created" as const);
    const reader = createOrganizationStageReader(read, { ttlMs: 1_000, now: () => clock });

    expect(await reader.isConfined(ORG)).toBe(true);
    expect(await reader.isConfined(ORG)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    clock = 1_000;
    read.mockResolvedValueOnce("active" as never);
    expect(await reader.isConfined(ORG)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidate makes an activation visible at once", async () => {
    let status: "created" | "active" = "created";
    const reader = createOrganizationStageReader(async () => status, { ttlMs: 60_000 });
    expect(await reader.isConfined(ORG)).toBe(true);
    status = "active";
    expect(await reader.isConfined(ORG)).toBe(true); // still cached
    reader.invalidate(ORG);
    expect(await reader.isConfined(ORG)).toBe(false);
  });

  it("confines anything but `active`, suspended, closed and unknown included (security L1: it used to fail open for those)", async () => {
    for (const status of ["created", "suspended", "closed", null] as const) {
      const reader = createOrganizationStageReader(async () => status);
      expect(await reader.isConfined(ORG), String(status)).toBe(true);
    }
    const live = createOrganizationStageReader(async () => "active");
    expect(await live.isConfined(ORG)).toBe(false);
  });
});
