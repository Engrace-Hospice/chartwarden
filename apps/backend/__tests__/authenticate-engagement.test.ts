// apps/backend/__tests__/authenticate-engagement.test.ts — GAP-093(c): the authenticate hook stamps
// `attributes.engagementId` ONLY from the resolver's server-side session state, never from a header.
import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";

const ENGAGEMENT = "44444444-4444-4444-8444-444444444444";

const ACTOR: ResolvedActor = {
  sessionClass: "auditor",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
  engagementId: ENGAGEMENT,
  userId: "u1",
  membershipId: null,
  organizationId: "org1",
  roles: [],
  providerEntityIds: [],
  locationIds: [],
};

const resolverReturning = (actor: ResolvedActor): SessionContextResolver => ({
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
});

const run = async (actor: ResolvedActor, headers: Record<string, string> = {}) => {
  const ctx = {
    userId: "",
    organizationId: "",
    roles: [] as string[],
    providerEntityIds: [] as string[],
    locationIds: [] as string[],
    attributes: {} as Record<string, unknown>,
  };
  const hook = createSessionAuthenticate({
    getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
    getResolver: () => resolverReturning(actor),
  });
  await hook({ context: ctx, headers } as unknown as FastifyRequest);
  return ctx.attributes;
};

describe("authenticate hook — engagementId (GAP-093(c))", () => {
  it("stamps the session's engagement for an auditor-class session", async () => {
    expect((await run(ACTOR)).engagementId).toBe(ENGAGEMENT);
  });

  it("never stamps it off a request header", async () => {
    const staff: ResolvedActor = { ...ACTOR, sessionClass: "staff", engagementId: null };
    const attrs = await run(staff, {
      "x-engagement-id": ENGAGEMENT,
      "x-test-engagement": ENGAGEMENT,
    });
    expect(attrs.engagementId).toBeUndefined();
  });

  it("does not stamp for a non-auditor class even if the resolver carried an id", async () => {
    const attrs = await run({ ...ACTOR, sessionClass: "staff" });
    expect(attrs.engagementId).toBeUndefined();
  });

  it("does not stamp when the auditor session has no engagement", async () => {
    expect((await run({ ...ACTOR, engagementId: null })).engagementId).toBeUndefined();
    const { engagementId: _omit, ...legacy } = ACTOR;
    expect((await run(legacy as ResolvedActor)).engagementId).toBeUndefined();
  });
});
