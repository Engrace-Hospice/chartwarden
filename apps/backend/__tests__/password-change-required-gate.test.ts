import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";

const actor: ResolvedActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
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

function hook(passwordChangeRequired: boolean, activeOrganizationId: string | null) {
  return createSessionAuthenticate({
    getSnapshot: async () => ({
      sessionId: "session-1",
      userId: actor.userId,
      activeOrganizationId,
      passwordChangeRequired,
    }),
    getResolver: () => resolver,
  });
}

describe("PASSWORD_CHANGE_REQUIRED authenticate boundary", () => {
  it.each([
    ["GET", "/api/v1/patients"],
    ["GET", "/api/v1/auth/memberships"],
    ["POST", "/api/v1/auth/select-organization"],
    ["POST", "/api/v1/orgs/33333333-3333-4333-8333-333333333333/users"],
  ])("blocks %s %s before org and permission resolution", async (method, url) => {
    await expect(hook(true, null)(request(method, url))).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
      statusCode: 403,
    });
  });

  it.each([
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/v1/auth/credential-status"],
    ["POST", "/api/v1/auth/password/complete-required-change"],
  ])("allows only the exact limited-session route %s %s", async (method, url) => {
    const req = request(method, url);
    await expect(hook(true, null)(req)).resolves.toBeUndefined();
    expect(req.context.userId).toBe(actor.userId);
  });

  it("does not let a passkey/old org-bound session bypass the global state", async () => {
    await expect(hook(true, actor.organizationId)(request("GET", "/api/v1/patients"))).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  });

  it("leaves active credentials on the existing session path", async () => {
    const req = request("GET", "/api/v1/patients");
    await expect(hook(false, actor.organizationId)(req)).resolves.toBeUndefined();
    expect(req.context.organizationId).toBe(actor.organizationId);
  });
});
