// apps/backend/__tests__/step-up-recent-assembly.test.ts — F-029.
//
// THE DEFECT. Fifteen modules lift `context.attributes.stepUpRecent` off the request context into
// their route actor, and their doc comments assert the authenticate hook sets it. Nothing did: the
// only assignments in the repo were in test files, each in a suite's OWN fake authenticate hook. So
// in production every one of those modules read `false`, for every request, forever.
//
// It failed CLOSED, so it was never exposure — but four write paths were worse than inert. M37's IRC
// cap override and restraint apply, M23's claim submit/replace/void and M27's cost-report submit all
// mount `requireStepUp(...)`, which PASSES (that path goes through M3's predicate and the M2 seam and
// is correct), and then hand the always-false flag to a service or a pure machine that refuses. The
// guard allowed and the domain refused, for every caller, always.
//
// WHY NOTHING SAW IT. Every test that exercised those modules supplied the fact itself — the live
// suites build the actor struct directly with `stepUpRecent: true`, and every `*-inject.test.ts`
// stubs the attribute in its own header-auth shim. The PRODUCTION assembly — the real hook writing a
// fact a real module's `writeActorOf` reads — was the one path nothing ran. That is what this file
// tests, and it is deliberately the seam rather than a whole route: the defect was never in the
// domain logic (which is well covered), it was that the fact never arrived.
import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";
import { writeActorOf as m23WriteActorOf } from "../src/modules/23-billing-medicare/routes/actor";
import { writeActorOf as m27WriteActorOf } from "../src/modules/27-cost-report/routes/actor";
import { writeActorOf as m37WriteActorOf } from "../src/modules/37-ipu/routes/actor";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SESSION = "sess_1";

const ACTOR: ResolvedActor = {
  userId: "u1",
  membershipId: MEMBERSHIP,
  organizationId: ORG,
  roles: ["org_admin"],
  providerEntityIds: [],
  locationIds: [],
};

/** `agoSec: null` — the session never stepped up; a number — it did, that long ago, with TOTP. */
const resolver = (agoSec: number | null): SessionContextResolver => ({
  resolveActor: async () => ACTOR,
  resolveStepUpState: async () =>
    agoSec === null
      ? null
      : { lastStepUpAt: new Date(Date.now() - agoSec * 1000), lastStepUpFactor: "totp" },
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
});

/** Run the REAL authenticate hook over a bare request context, exactly as the server does. */
async function authenticated(agoSec: number | null): Promise<FastifyRequest> {
  const request = {
    headers: {},
    context: {
      userId: "",
      organizationId: "",
      roles: [] as string[],
      providerEntityIds: [] as string[],
      locationIds: [] as string[],
      attributes: {} as Record<string, unknown>,
    },
  } as unknown as FastifyRequest;
  const hook = createSessionAuthenticate({
    getSnapshot: async () => ({ sessionId: SESSION, userId: "u1", activeOrganizationId: ORG }),
    getResolver: () => resolver(agoSec),
  });
  await hook(request);
  return request;
}

describe("F-029 — the step-up fact reaches the modules that read it", () => {
  it("the hook writes stepUpRecent onto the context (it never used to write it at all)", async () => {
    expect((await authenticated(30)).context.attributes.stepUpRecent).toBe(true);
    expect((await authenticated(86_400)).context.attributes.stepUpRecent).toBe(false);
    expect((await authenticated(null)).context.attributes.stepUpRecent).toBe(false);
  });

  // One case per module that HARD-REFUSES on the flag. Each reads the fact through its own
  // `writeActorOf`, which is the code that saw `false` in production no matter what the caller did.
  const modules = [
    { name: "M23 billing-medicare (claim submit / replace / void)", of: m23WriteActorOf },
    { name: "M27 cost-report (submit)", of: m27WriteActorOf },
    { name: "M37 IPU (IRC cap override, restraint apply)", of: m37WriteActorOf },
  ] as const;

  for (const { name, of } of modules) {
    it(`${name} sees a FRESH step-up`, async () => {
      expect(of(await authenticated(30)).stepUpRecent).toBe(true);
    });

    it(`${name} sees a STALE step-up as false — the fix resolves the fact, it does not assume it`, async () => {
      expect(of(await authenticated(86_400)).stepUpRecent).toBe(false);
    });
  }

  it("an anonymous request carries no step-up claim", async () => {
    const request = {
      headers: {},
      context: {
        userId: "",
        organizationId: "",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: {} as Record<string, unknown>,
      },
    } as unknown as FastifyRequest;
    const hook = createSessionAuthenticate({
      getSnapshot: async () => null,
      getResolver: () => resolver(30),
    });
    await hook(request);
    expect(request.context.attributes.stepUpRecent).toBeUndefined();
  });

  it("a PRE-ORG session (authenticated, no active org) carries no step-up claim", async () => {
    // Step-up freshness is org-scoped through the seam, so there is nothing to resolve yet — and the
    // readers all treat an absent attribute as "no step-up", which is the right answer here.
    const request = {
      headers: {},
      context: {
        userId: "",
        organizationId: "",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: {} as Record<string, unknown>,
      },
    } as unknown as FastifyRequest;
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({
        sessionId: SESSION,
        userId: "u1",
        activeOrganizationId: null,
      }),
      getResolver: () => resolver(30),
    });
    await hook(request);
    expect(request.context.attributes.stepUpRecent).toBeUndefined();
  });
});
