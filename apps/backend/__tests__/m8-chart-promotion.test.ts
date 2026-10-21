// apps/backend/__tests__/m8-chart-promotion.test.ts - WP 3.7 (ADR-0063): M8 as the owner of the encounter-addendum chart
// promotion target. Routes through the full M1 chain over the in-memory encounter backend and a stubbed
// `ChartPromotionSourceReader` seam. Proves: the reviewer's own draft carries the proposal; a plain addendum is untouched;
// `m8.chart_promotion.decided` is published on SIGN (accepted) and on reject, never on create or finalize; a proposal that is
// not available, is for another patient, or already has an addendum is refused; the owning module's permission is required.
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  isStepUpRecent,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type ChartPromotionReview, STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildEncounterAbacPredicates,
  createInMemoryEncounterBackend,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const ENC = "a0000000-0000-4000-8000-000000000001";
const ENC_OTHER_ORG = "b0000000-0000-4000-8000-000000000003";
const REQ = "c0000000-0000-4000-8000-000000000001";
const REQ_OTHER_PATIENT = "c0000000-0000-4000-8000-000000000002";
const AUTHOR_USER = "d0000000-0000-4000-8000-000000000001";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
}

const REVIEWER_PERMS = [
  "encounter.read",
  "encounter.addendum_author",
  "encounter.addendum_sign",
  "encounter.finalize",
];
const PERMISSION_SEED = [
  { userId: "rn_1", permissions: REVIEWER_PERMS },
  // Can author an addendum but not sign one: may not decline a proposal.
  {
    userId: "author_only",
    permissions: ["encounter.read", "encounter.addendum_author"],
  },
  // Holds the messaging promote permission in the real tenant but NOTHING from M8: must be refused by the owner.
  {
    userId: "promoter_only",
    permissions: ["messaging.promote", "messaging.read", "encounter.read"],
  },
];

const review = (over: Partial<ChartPromotionReview> = {}): ChartPromotionReview => ({
  requestId: REQ,
  patientId: PATIENT,
  targetModule: "m8",
  targetKind: "encounter_addendum",
  requestedByUserId: "e0000000-0000-4000-8000-000000000001",
  requestedAt: "2026-10-14T10:00:00.000Z",
  sourceAuthorUserId: AUTHOR_USER,
  sourceSentAt: "2026-10-14T09:59:00.000Z",
  sourceMessageId: "f0000000-0000-4000-8000-000000000001",
  sourceChannelId: "f0000000-0000-4000-8000-000000000002",
  suggestedTargetRef: null,
  sourceBodySha256: "a".repeat(64),
  snapshotText: "Patient reports new pain at night",
  sourceState: "current",
  ...over,
});

interface SeamState {
  enabled: boolean;
  reviews: Map<string, ChartPromotionReview>;
  throws: boolean;
  withTextCalls: boolean[];
  pendingLimits: number[];
}

function stepUpRecentPredicate(context: {
  organizationId: string;
  attributes: Record<string, unknown>;
}) {
  const sessionId =
    typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
  if (!sessionId || !context.organizationId) return Promise.resolve(false);
  return getSeam("SessionContextResolver")
    .resolveStepUpState({ orgId: context.organizationId }, sessionId)
    .then((state) => isStepUpRecent(state, STEP_UP_POLICY, Date.now()));
}

function makeServer(seam: SeamState) {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENC,
        organizationId: ORG,
        patientId: PATIENT,
        status: "signed",
        authoredByUserId: "rn_1",
      },
      {
        id: ENC_OTHER_ORG,
        organizationId: "org_b",
        patientId: PATIENT,
        status: "signed",
        authoredByUserId: "rn_1",
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSION_SEED.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
  resetAbacRegistry();
  const registry = createPredicateRegistry({
    ...M3_INTRINSIC_PREDICATES,
    step_up_recent: stepUpRecentPredicate,
  });
  for (const [name, fn] of Object.entries(
    buildEncounterAbacPredicates({ resolver: backend.resolver, isInCaseload: async () => true }),
  )) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  __resetSeamsForTest();
  registerSeam(
    "SessionContextResolver",
    createSessionContextResolver(
      createInMemorySessionContextStore(
        PERMISSION_SEED.map((s) => ({
          sessionId: s.userId,
          userId: s.userId,
          membershipId: s.userId,
          organizationId: ORG,
          roles: [],
          providerEntityIds: [],
          locationIds: [],
          lastStepUpAt: new Date(),
          lastStepUpFactor: "webauthn" as const,
          sessionClass: "staff",
          portalAccountId: null,
          sessionPatientId: null,
        })),
      ).store,
    ),
  );
  registerSeam("ChartPromotionSourceReader", {
    enabled: async () => {
      if (seam.throws) throw new Error("seam down");
      return seam.enabled;
    },
    pendingForPatients: async (_org, q) => {
      seam.pendingLimits.push(q.limit);
      return [...seam.reviews.values()].filter((r) => q.patientIds.includes(r.patientId));
    },
    forReview: async (_org, id, q) => {
      if (seam.throws) throw new Error("seam down");
      seam.withTextCalls.push(q.withText === true);
      const r = seam.reviews.get(id);
      return r && q.targetModule === "m8" ? r : null;
    },
  });
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => [PATIENT],
  });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1" };
const PROMOTER_ONLY = { "x-test-user": "promoter_only" };
const REASON = "Clarification drawn from a care-team message, reviewed";

let seam: SeamState;
beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  seam = {
    enabled: true,
    reviews: new Map([
      [REQ, review()],
      [REQ_OTHER_PATIENT, review({ requestId: REQ_OTHER_PATIENT, patientId: OTHER_PATIENT })],
    ]),
    throws: false,
    withTextCalls: [],
    pendingLimits: [],
  };
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

const decided = (b: ReturnType<typeof makeServer>["backend"]) =>
  b.inspect.events().filter((e) => e.event === "m8.chart_promotion.decided");

describe("WP 3.7 M8 - GET /encounters/:id/chart-promotions", () => {
  it("lists the proposals for the encounter's patient with the quoted snapshot", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.promotions).toHaveLength(1);
    expect(body.promotions[0]).toMatchObject({
      request_id: REQ,
      snapshot_text: "Patient reports new pain at night",
      source_state: "current",
      source_author_user_id: AUTHOR_USER,
    });
  });

  it("is the only caller that asks the seam for the text, and caps how many it opens per GET", async () => {
    for (let i = 0; i < 25; i++) {
      const id = `c0000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`;
      seam.reviews.set(id, review({ requestId: id }));
    }
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().promotions.length).toBeLessThanOrEqual(10);
    expect(seam.withTextCalls.length).toBeLessThanOrEqual(10);
    expect(seam.withTextCalls.every(Boolean)).toBe(true);
    expect(seam.pendingLimits).toEqual([10]);
  });

  it("passes a null snapshot through for an edited message (the superseded text is not served)", async () => {
    seam.reviews.set(REQ, review({ snapshotText: null, sourceState: "edited_since" }));
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: RN,
    });
    expect(res.json().promotions[0]).toMatchObject({
      snapshot_text: null,
      source_state: "edited_since",
    });
  });

  it("answers 422 (not 500) for a malformed encounter id on the list route", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/not-a-uuid/chart-promotions",
      headers: RN,
    });
    expect(res.statusCode).toBe(422);
  });

  it("answers enabled:false with an empty list while the feature is off", async () => {
    seam.enabled = false;
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: RN,
    });
    expect(res.json()).toEqual({ enabled: false, promotions: [] });
  });

  it("fails closed to enabled:false when the messaging seam throws", async () => {
    seam.throws = true;
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, promotions: [] });
  });

  it("refuses a caller who holds messaging.promote but not the M8 addendum permission", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC}/chart-promotions`,
      headers: PROMOTER_ONLY,
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers 404 for another tenant's encounter", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC_OTHER_ORG}/chart-promotions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("WP 3.7 M8 - addendum authored from a proposal", () => {
  const create = (app: ReturnType<typeof makeServer>["app"], payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/addenda`,
      headers: RN,
      payload,
    });

  it("creates the reviewer's own draft for an open proposal and publishes nothing yet", async () => {
    const { app, backend } = makeServer(seam);
    const res = await create(app, { reason: REASON, promotionRequestId: REQ });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("draft");
    expect(decided(backend)).toHaveLength(0);
  });

  it.each([
    ["an unknown proposal", "c0000000-0000-4000-8000-0000000000ff"],
    ["a proposal for another patient", REQ_OTHER_PATIENT],
  ])("refuses %s with 422 PROMOTION_NOT_AVAILABLE", async (_label, requestId) => {
    const { app, backend } = makeServer(seam);
    const res = await create(app, { reason: REASON, promotionRequestId: requestId });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMOTION_NOT_AVAILABLE");
    expect(decided(backend)).toHaveLength(0);
  });

  it("refuses with 422 when the seam is down (fail closed), not 500", async () => {
    seam.throws = true;
    const { app } = makeServer(seam);
    const res = await create(app, { reason: REASON, promotionRequestId: REQ });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMOTION_NOT_AVAILABLE");
  });

  it("refuses a second live draft for the same proposal with 409", async () => {
    const { app } = makeServer(seam);
    expect((await create(app, { reason: REASON, promotionRequestId: REQ })).statusCode).toBe(201);
    const second = await create(app, { reason: REASON, promotionRequestId: REQ });
    expect(second.statusCode).toBe(409);
  });

  it("leaves a plain addendum untouched and never asks the seam", async () => {
    seam.throws = true;
    const { app, backend } = makeServer(seam);
    const res = await create(app, { reason: REASON });
    expect(res.statusCode).toBe(201);
    expect(decided(backend)).toHaveLength(0);
  });

  it("rejects a non-uuid promotionRequestId with a validation error", async () => {
    const { app } = makeServer(seam);
    const res = await create(app, { reason: REASON, promotionRequestId: "nope" });
    expect(res.statusCode).toBe(422);
  });
});

describe("WP 3.7 M8 - the decided event", () => {
  async function draftAndFinalize(
    app: ReturnType<typeof makeServer>["app"],
    promotionRequestId?: string,
  ): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/addenda`,
      headers: RN,
      payload: { reason: REASON, ...(promotionRequestId ? { promotionRequestId } : {}) },
    });
    const addendumId = created.json().id as string;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${ENC}/addenda/${addendumId}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [{ sectionId: "plan", entries: [], freeText: "My own words." }] },
    });
    expect(patched.statusCode).toBe(200);
    const fin = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/addenda/${addendumId}/finalize`,
      headers: RN,
      payload: {},
    });
    expect(fin.statusCode).toBe(200);
    return addendumId;
  }

  const sign = (app: ReturnType<typeof makeServer>["app"], addendumId: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/addenda/${addendumId}/sign`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });

  it("publishes accepted with the addendum id as the result only when the addendum is SIGNED", async () => {
    const { app, backend } = makeServer(seam);
    const addendumId = await draftAndFinalize(app, REQ);
    expect(decided(backend)).toHaveLength(0);

    const signed = await sign(app, addendumId);

    expect(signed.statusCode).toBe(200);
    const events = decided(backend);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      organizationId: ORG,
      promotionRequestId: REQ,
      outcome: "accepted",
      resultRef: addendumId,
      decidedByUserId: "rn_1",
      reasonCode: null,
    });
  });

  it("publishes nothing when an unfinalized addendum fails to sign", async () => {
    const { app, backend } = makeServer(seam);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/addenda`,
      headers: RN,
      payload: { reason: REASON, promotionRequestId: REQ },
    });
    const res = await sign(app, created.json().id as string);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(decided(backend)).toHaveLength(0);
  });

  it("publishes nothing when a plain addendum is signed", async () => {
    const { app, backend } = makeServer(seam);
    const addendumId = await draftAndFinalize(app);
    expect((await sign(app, addendumId)).statusCode).toBe(200);
    expect(decided(backend)).toHaveLength(0);
  });

  it("publishes rejected with the reason code on reject, and writes no addendum", async () => {
    const { app, backend } = makeServer(seam);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ}/reject`,
      headers: RN,
      payload: { reasonCode: "already_documented" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ promotionRequestId: REQ, outcome: "rejected" });
    expect(decided(backend)[0]?.payload).toMatchObject({
      promotionRequestId: REQ,
      outcome: "rejected",
      resultRef: null,
      reasonCode: "already_documented",
      decidedByUserId: "rn_1",
    });
  });

  it.each([["requester"], ["superseded"], ["bogus"]])(
    "refuses the reject reason %s (system-set or unknown) with 422",
    async (reasonCode) => {
      const { app, backend } = makeServer(seam);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ}/reject`,
        headers: RN,
        payload: { reasonCode },
      });
      expect(res.statusCode).toBe(422);
      expect(decided(backend)).toHaveLength(0);
    },
  );

  it("refuses to reject a proposal for another patient (422) and publishes nothing", async () => {
    const { app, backend } = makeServer(seam);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ_OTHER_PATIENT}/reject`,
      headers: RN,
      payload: { reasonCode: "other" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMOTION_NOT_AVAILABLE");
    expect(decided(backend)).toHaveLength(0);
  });

  it("refuses to reject once the proposal has a non-voided addendum (409) and publishes nothing", async () => {
    const { app, backend } = makeServer(seam);
    await draftAndFinalize(app, REQ);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ}/reject`,
      headers: RN,
      payload: { reasonCode: "other" },
    });
    expect(res.statusCode).toBe(409);
    expect(decided(backend)).toHaveLength(0);
  });

  it("refuses an author who cannot sign (declining needs encounter.addendum_sign)", async () => {
    const { app, backend } = makeServer(seam);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ}/reject`,
      headers: { "x-test-user": "author_only" },
      payload: { reasonCode: "other" },
    });
    expect(res.statusCode).toBe(403);
    expect(decided(backend)).toHaveLength(0);
  });

  it("answers 422 (not 500) for a malformed encounter id on the reject route", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/not-a-uuid/chart-promotions/${REQ}/reject`,
      headers: RN,
      payload: { reasonCode: "other" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses a caller without the M8 addendum permission even if they hold messaging.promote", async () => {
    const { app, backend } = makeServer(seam);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC}/chart-promotions/${REQ}/reject`,
      headers: PROMOTER_ONLY,
      payload: { reasonCode: "other" },
    });
    expect(res.statusCode).toBe(403);
    expect(decided(backend)).toHaveLength(0);
  });
});
