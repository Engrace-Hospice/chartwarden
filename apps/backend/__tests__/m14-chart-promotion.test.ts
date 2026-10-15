// apps/backend/__tests__/m14-chart-promotion.test.ts - WP 3.7 (ADR-0063): M14 as the owner of the IDG agenda-item chart
// promotion target. Routes through the full M1 chain over the in-memory IDG backend and a stubbed
// `ChartPromotionSourceReader` seam. Proves: the coordinator adds an `other` agenda item that is a pointer plus attribution
// (no text), `m14.chart_promotion.decided` is published on add and on reject only, no decision is ever recorded, a proposal
// that is unavailable, out of the caller's scope or already used is refused, and the owner's own permission is required.
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { ChartPromotionReview } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = `user-of-${user}`;
  request.context.attributes.membershipId = user;
  request.context.organizationId = "org_a";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
}

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const MTG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
const REQ = "c0000000-0000-4000-8000-000000000001";
const REQ_OUT_OF_SCOPE = "c0000000-0000-4000-8000-000000000002";
const AUTHOR_USER = "d0000000-0000-4000-8000-000000000001";
const MESSAGE = "f0000000-0000-4000-8000-000000000001";
const CHANNEL = "f0000000-0000-4000-8000-000000000002";

const h = (user: string, roles = "idg_coordinator") => ({
  "x-test-user": user,
  "x-test-roles": roles,
  "x-test-locations": LOC,
});
const postHeaders = (user: string, roles?: string, key = "k-1") => ({
  ...h(user, roles),
  "idempotency-key": key,
});

const review = (over: Partial<ChartPromotionReview> = {}): ChartPromotionReview => ({
  requestId: REQ,
  patientId: PATIENT,
  targetModule: "m14",
  targetKind: "idg_agenda_item",
  requestedByUserId: "e0000000-0000-4000-8000-000000000001",
  requestedAt: "2026-10-14T10:00:00.000Z",
  sourceAuthorUserId: AUTHOR_USER,
  sourceSentAt: "2026-10-14T09:59:00.000Z",
  sourceMessageId: MESSAGE,
  sourceChannelId: CHANNEL,
  suggestedTargetRef: null,
  sourceBodySha256: "a".repeat(64),
  snapshotText: null,
  sourceState: "current",
  ...over,
});

interface SeamState {
  enabled: boolean;
  reviews: Map<string, ChartPromotionReview>;
  throws: boolean;
  reviewerUserIds: string[];
  withText: unknown[];
}

function makeServer(seam: SeamState, status: "scheduled" | "live" | "adjourned" = "live") {
  const backend = createInMemoryIdgBackend({
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status,
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [PATIENT],
      },
    ],
  });
  const grant = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId: `${userId}`,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  // The permission store is keyed by the M2 USER id (ctx.userId), as in production.
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("user-of-coordinator", ["idg.read", "idg.coordinate"]),
      grant("user-of-director", ["idg.read", "idg.coordinate"]),
      // Holds the messaging promote permission but nothing from M14: the owner must refuse.
      grant("user-of-promoter_only", ["messaging.promote", "messaging.read"]),
    ]).store,
  );
  __resetSeamsForTest();
  registerSeam(
    "SessionContextResolver",
    createSessionContextResolver(createInMemorySessionContextStore([]).store),
  );
  registerSeam("ChartPromotionSourceReader", {
    enabled: async () => {
      if (seam.throws) throw new Error("seam down");
      return seam.enabled;
    },
    pendingForPatients: async (_org, q) => {
      seam.reviewerUserIds.push(q.reviewerUserId);
      if ((q as { withText?: boolean }).withText) seam.withText.push(true);
      return [...seam.reviews.values()].filter((r) => q.patientIds.includes(r.patientId));
    },
    forReview: async (_org, id, q) => {
      if (seam.throws) throw new Error("seam down");
      seam.reviewerUserIds.push(q.reviewerUserId);
      if (q.withText) seam.withText.push(true);
      const r = seam.reviews.get(id);
      return r && q.targetModule === "m14" ? r : null;
    },
  });
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildIdgAbacPredicates({ resolver: backend }))) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend, caseload: async () => [PATIENT] });
  return { app, backend };
}

let seam: SeamState;
beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  seam = {
    enabled: true,
    reviews: new Map([
      [REQ, review()],
      [REQ_OUT_OF_SCOPE, review({ requestId: REQ_OUT_OF_SCOPE, patientId: OTHER_PATIENT })],
    ]),
    throws: false,
    reviewerUserIds: [],
    withText: [],
  };
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

const decided = (b: ReturnType<typeof makeServer>["backend"]) =>
  b.drainEvents().filter((e) => e.eventName === "m14.chart_promotion.decided");

const fromPromotion = (
  app: ReturnType<typeof makeServer>["app"],
  promotionRequestId: string,
  headers = postHeaders("coordinator"),
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/idg/meetings/${MTG}/agenda/from-promotion`,
    headers,
    payload: { promotionRequestId },
  });

describe("WP 3.7 M14 - GET /idg/meetings/:id/chart-promotions", () => {
  it("lists metadata only (no text, no hash) for the patients in the caller's scope", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("coordinator"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.promotions).toHaveLength(1);
    expect(body.promotions[0]).toMatchObject({ request_id: REQ, patientId: PATIENT });
    // The agenda reviewer does not need to know which message or channel it came from.
    expect(Object.keys(body.promotions[0])).not.toContain("source_message_id");
    expect(Object.keys(body.promotions[0])).not.toContain("source_channel_id");
    expect(JSON.stringify(body)).not.toContain("snapshot");
    expect(JSON.stringify(body)).not.toContain("a".repeat(64));
  });

  it("never asks the seam for message text (M14 does not pass withText)", async () => {
    const { app } = makeServer(seam);
    await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("coordinator"),
    });
    await fromPromotion(app, REQ);
    expect(seam.withText).toEqual([]);
  });

  it("asks the seam as the M2 user id, not the membership id", async () => {
    const { app } = makeServer(seam);
    await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("coordinator"),
    });
    expect(seam.reviewerUserIds).toEqual(["user-of-coordinator"]);
  });

  it("lets an org-wide role see proposals for the meeting's agenda patients", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("director", "medical_director"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().promotions.map((p: { request_id: string }) => p.request_id)).toContain(REQ);
  });

  it("answers enabled:false while the feature is off or the seam throws", async () => {
    seam.enabled = false;
    const off = await makeServer(seam).app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("coordinator"),
    });
    expect(off.json()).toEqual({ enabled: false, promotions: [] });

    seam.enabled = true;
    seam.throws = true;
    const down = await makeServer(seam).app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("coordinator"),
    });
    expect(down.json()).toEqual({ enabled: false, promotions: [] });
  });

  it("refuses a caller who holds messaging.promote but not the IDG read permission", async () => {
    const { app } = makeServer(seam);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions`,
      headers: h("promoter_only"),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("WP 3.7 M14 - POST /idg/meetings/:id/agenda/from-promotion", () => {
  it("adds an `other` item with attribution and no text, and publishes accepted with the item id", async () => {
    const { app, backend } = makeServer(seam);
    const res = await fromPromotion(app, REQ);
    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item).toMatchObject({
      kind: "other",
      patientId: PATIENT,
      promotion: {
        request_id: REQ,
        source_author_user_id: AUTHOR_USER,
        source_sent_at: "2026-10-14T09:59:00.000Z",
        source_message_id: MESSAGE,
      },
    });
    const events = decided(backend);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      organizationId: ORG,
      promotionRequestId: REQ,
      outcome: "accepted",
      resultRef: item.id,
      decidedByUserId: "user-of-coordinator",
      reasonCode: null,
    });
  });

  it("shows the attribution on the agenda list and never any message text", async () => {
    const { app } = makeServer(seam);
    await fromPromotion(app, REQ);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/agenda`,
      headers: h("coordinator"),
    });
    expect(res.json()[0].promotion.request_id).toBe(REQ);
    expect(JSON.stringify(res.json())).not.toContain("a".repeat(64));
  });

  it("records no IDG decision", async () => {
    const { app, backend } = makeServer(seam);
    await fromPromotion(app, REQ);
    const names = backend.drainEvents().map((e) => e.eventName);
    expect(names).not.toContain("idg.decision_recorded");
    expect(names).not.toContain("m14.decision.recorded_open");
    const decisions = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/decisions`,
      headers: h("coordinator"),
    });
    expect(decisions.json()).toEqual([]);
  });

  it("refuses a second item for the same proposal with 409", async () => {
    const { app } = makeServer(seam);
    expect((await fromPromotion(app, REQ)).statusCode).toBe(201);
    // A different Idempotency-Key: the SAME key would replay the stored 201, which is the middleware's job, not the rule.
    const again = await fromPromotion(app, REQ, postHeaders("coordinator", undefined, "k-2"));
    expect(again.statusCode).toBe(409);
  });

  it.each([
    ["an unknown proposal", "c0000000-0000-4000-8000-0000000000ff"],
    ["a patient outside the caller's scope", REQ_OUT_OF_SCOPE],
  ])("refuses %s with 422 PROMOTION_NOT_AVAILABLE and publishes nothing", async (_l, id) => {
    const { app, backend } = makeServer(seam);
    const res = await fromPromotion(app, id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMOTION_NOT_AVAILABLE");
    expect(decided(backend)).toHaveLength(0);
  });

  it("refuses with 422 when the seam is down (fail closed)", async () => {
    seam.throws = true;
    const { app } = makeServer(seam);
    const res = await fromPromotion(app, REQ);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMOTION_NOT_AVAILABLE");
  });

  it("refuses on an adjourned meeting and publishes nothing", async () => {
    const { app, backend } = makeServer(seam, "adjourned");
    const res = await fromPromotion(app, REQ);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(decided(backend)).toHaveLength(0);
  });

  it("requires the Idempotency-Key header and a strict body", async () => {
    const { app } = makeServer(seam);
    const noKey = await fromPromotion(app, REQ, h("coordinator") as never);
    expect(noKey.statusCode).toBe(400);
    const extra = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/agenda/from-promotion`,
      headers: postHeaders("coordinator"),
      payload: { promotionRequestId: REQ, noteText: "copied text" },
    });
    expect(extra.statusCode).toBe(422);
  });

  it("refuses a caller who holds messaging.promote but not idg.coordinate", async () => {
    const { app, backend } = makeServer(seam);
    const res = await fromPromotion(app, REQ, postHeaders("promoter_only"));
    expect(res.statusCode).toBe(403);
    expect(decided(backend)).toHaveLength(0);
  });
});

describe("WP 3.7 M14 - POST /idg/meetings/:id/chart-promotions/:requestId/reject", () => {
  const reject = (
    app: ReturnType<typeof makeServer>["app"],
    requestId: string,
    payload: Record<string, unknown>,
    headers = h("coordinator"),
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/chart-promotions/${requestId}/reject`,
      headers,
      payload,
    });

  it("publishes rejected with the reason code and adds no agenda item", async () => {
    const { app, backend } = makeServer(seam);
    const res = await reject(app, REQ, { reasonCode: "duplicate" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ promotionRequestId: REQ, outcome: "rejected" });
    expect(decided(backend)[0]?.payload).toMatchObject({
      promotionRequestId: REQ,
      outcome: "rejected",
      resultRef: null,
      reasonCode: "duplicate",
      decidedByUserId: "user-of-coordinator",
    });
    const agenda = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/agenda`,
      headers: h("coordinator"),
    });
    expect(agenda.json()).toEqual([]);
  });

  it("refuses to reject a proposal that already has an agenda item (409) and publishes nothing more", async () => {
    const { app, backend } = makeServer(seam);
    expect((await fromPromotion(app, REQ)).statusCode).toBe(201);
    backend.drainEvents();
    const res = await reject(app, REQ, { reasonCode: "other" });
    expect(res.statusCode).toBe(409);
    expect(decided(backend)).toHaveLength(0);
  });

  it.each([["requester"], ["superseded"], ["bogus"]])(
    "refuses the reject reason %s with 422",
    async (reasonCode) => {
      const { app, backend } = makeServer(seam);
      const res = await reject(app, REQ, { reasonCode });
      expect(res.statusCode).toBe(422);
      expect(decided(backend)).toHaveLength(0);
    },
  );

  it("refuses a proposal outside the caller's scope with 422 and publishes nothing", async () => {
    const { app, backend } = makeServer(seam);
    const res = await reject(app, REQ_OUT_OF_SCOPE, { reasonCode: "other" });
    expect(res.statusCode).toBe(422);
    expect(decided(backend)).toHaveLength(0);
  });

  it("refuses a caller who holds messaging.promote but not idg.coordinate", async () => {
    const { app, backend } = makeServer(seam);
    const res = await reject(app, REQ, { reasonCode: "other" }, h("promoter_only"));
    expect(res.statusCode).toBe(403);
    expect(decided(backend)).toHaveLength(0);
  });
});
