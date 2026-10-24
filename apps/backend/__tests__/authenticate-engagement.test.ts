// apps/backend/__tests__/authenticate-engagement.test.ts — GAP-093(c): the authenticate hook stamps
// `attributes.engagementId` ONLY from the resolver's server-side session state, never from a header.
import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@chartwarden/types";
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
  auditorStage: "active",
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

const run = async (actor: ResolvedActor, headers: Record<string, string> = {}, url = "/") => {
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
  await hook({ context: ctx, headers, method: "GET", url } as unknown as FastifyRequest);
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
  });

  it("stamps NO read scope for an enrolment-stage auditor (M2 §7.7) - only the enrolment engagement", async () => {
    const attrs = await run(
      { ...ACTOR, auditorStage: "enrolment" },
      {},
      "/api/v1/auditors/enrolment/state",
    );
    expect(attrs.engagementId).toBeUndefined();
    expect(attrs.auditorEnrolmentEngagementId).toBe(ENGAGEMENT);
    expect(attrs.auditorStage).toBe("enrolment");
  });

  it("FAILS CLOSED: an auditor actor with no stage is an enrolment session and reads nothing", async () => {
    const { auditorStage: _omit, ...legacy } = ACTOR;
    await expect(run(legacy as ResolvedActor)).rejects.toMatchObject({
      code: "AUDITOR_ENROLMENT_REQUIRED",
    });
  });
});

// #589 - POST /api/v1/auth/unlock re-proves the session's own password and mints nothing, so it is deliberately
// reachable by BOTH auditor stages (the lock overlay arms for auditors); no other mutation is.
describe("authenticate hook - screen unlock for auditor sessions (#589)", () => {
  const callAs = async (actor: ResolvedActor, method: string, url: string) => {
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
    await hook({ context: ctx, headers: {}, method, url } as unknown as FastifyRequest);
  };

  it("lets an ACTIVE auditor unlock, but still refuses any other write", async () => {
    await expect(callAs(ACTOR, "POST", "/api/v1/auth/unlock")).resolves.toBeUndefined();
    await expect(callAs(ACTOR, "POST", "/api/v1/patients")).rejects.toMatchObject({ code: "AUDITOR_READ_ONLY" });
  });

  it("lets an ENROLMENT-stage auditor unlock, but still refuses the engagement read", async () => {
    const enrolling = { ...ACTOR, auditorStage: "enrolment" as const };
    await expect(callAs(enrolling, "POST", "/api/v1/auth/unlock")).resolves.toBeUndefined();
    await expect(callAs(enrolling, "GET", "/api/v1/patients")).rejects.toMatchObject({
      code: "AUDITOR_ENROLMENT_REQUIRED",
    });
  });
});
