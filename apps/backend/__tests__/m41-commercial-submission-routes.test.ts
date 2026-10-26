// M41 submission routes (ADR-0053 D10) over the route stack and the REAL Authorization Contract, with a recording fake for the service
// (the SQL and the transaction are proven by m41-commercial-submission.live.test.ts):
//   submit: commercial_billing.submit (403), session (401), Idempotency-Key (400), FRESH step-up (403 STEP_UP_REQUIRED), AI actor (403),
//           caseload scope (404), 202 queued / 200 replay, a gate refusal in the standard error envelope with every reason as a detail;
//   send-gate and timeline: read permission, 200, read-audited by claim id.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { COMMERCIAL_ERROR_CODES, ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerCommercialBillingRoutes } from "../src/modules/41-billing-commercial/routes/commercial-billing.routes";
import type { CommercialSubmissionService } from "../src/modules/41-billing-commercial/services/submission-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const CLAIM = "33333333-3333-4333-8333-333333333333";
const OTHER_CLAIM = "33333333-3333-4333-8333-999999999999";
const KEYS: Record<string, string[]> = {
  sender: ["commercial_billing.submit", "commercial_billing.read"],
  reader: ["commercial_billing.read"],
  nobody: [],
};

let submitCalls: { claimId: string; key: string; kind: string }[] = [];
let reconcileCalls: {
  claimId: string;
  submissionId: string;
  outcome: string;
  kind: string;
  evidence?: string;
}[] = [];
let refuse = false;
let replay = false;

const submissions: CommercialSubmissionService = {
  async submit(actor, claimId, key) {
    submitCalls.push({ claimId, key, kind: actor.actorKind });
    if (refuse) {
      throw new ChartWardenError(
        COMMERCIAL_ERROR_CODES.sendRefused,
        "The claim was not sent.",
        503,
        [{ field: "claim", code: "CH_NOT_WIRED", message: "No clearinghouse is connected." }],
      );
    }
    return {
      submissionId: "44444444-4444-4444-8444-444444444444",
      claimId,
      status: "queued",
      controlNumber: "260401-abc",
      clearinghouseKey: "stedi",
      attemptCount: 0,
      requestedAt: "2026-10-25T00:00:00.000Z",
      replayed: replay,
    };
  },
  async sendGate(_actor, claimId) {
    return {
      claimId,
      state: "ready",
      patientId: "55555555-5555-4555-8555-555555555555",
      canSubmit: false,
      clearinghouseKey: null,
      reasons: [{ code: "CH_NOT_WIRED", message: "No clearinghouse is connected." }],
    };
  },
  async reconcile(actor, claimId, submissionId, outcome, evidence) {
    reconcileCalls.push({ claimId, submissionId, outcome, kind: actor.actorKind, evidence });
    return {
      submissionId,
      claimId,
      status: outcome === "received" ? "sent" : "failed",
      controlNumber: "260401-abc",
      clearinghouseKey: "stedi",
      attemptCount: 1,
      requestedAt: "2026-10-25T00:00:00.000Z",
      replayed: false,
    };
  },
  async timeline(_actor, claimId) {
    return {
      claimId,
      patientId: "55555555-5555-4555-8555-555555555555",
      state: "ready",
      items: [],
      truncated: false,
    };
  },
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  request.context.attributes.membershipId = "66666666-6666-4666-8666-666666666666";
  if (request.headers["x-fresh"] === "1") request.context.attributes.stepUpRecent = true;
  if (request.headers["x-ai"] === "1") request.context.attributes.actorKind = "ai_assistant";
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register("step_up_recent", async (ctx) => ctx.attributes.stepUpRecent === true);
  registry.register(
    "commercial_claim_in_billing_caseload",
    async (_ctx, target) => (target as { claimId?: string }).claimId === CLAIM,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCommercialBillingRoutes(app, {
    submissions,
    reads: {} as never,
    assembly: {} as never,
    lifecycle: {} as never,
    authorizations: {} as never,
  });
  return app;
}

beforeEach(() => {
  submitCalls = [];
  reconcileCalls = [];
  refuse = false;
  replay = false;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

const submitUrl = (id = CLAIM) => `/api/v1/billing/commercial/claims/${id}/submit`;
let keySeq = 0;
const nextKey = (): string => {
  keySeq += 1;
  return `sub-${keySeq}`;
};
const as = (user: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "idempotency-key": nextKey(),
  ...extra,
});
const code = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;

describe("POST /billing/commercial/claims/:id/submit", () => {
  it("answers 202 with the queued submission and passes the Idempotency-Key through", async () => {
    const headers = as("sender", { "x-fresh": "1" });
    const res = await makeServer().inject({ method: "POST", url: submitUrl(), headers });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "queued", replayed: false, claimId: CLAIM });
    expect(submitCalls).toEqual([
      { claimId: CLAIM, key: headers["idempotency-key"], kind: "user" },
    ]);
  });

  it("answers 200 when the service replays an earlier request", async () => {
    replay = true;
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(),
      headers: as("sender", { "x-fresh": "1" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
  });

  it("is 401 without a session and 403 without commercial_billing.submit", async () => {
    const app = makeServer();
    expect((await app.inject({ method: "POST", url: submitUrl() })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: submitUrl(),
          headers: as("reader", { "x-fresh": "1" }),
        })
      ).statusCode,
    ).toBe(403);
    expect(submitCalls).toEqual([]);
  });

  it("needs a FRESH step-up (403 STEP_UP_REQUIRED) and never reaches the service without it", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(),
      headers: as("sender"),
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("STEP_UP_REQUIRED");
    expect(submitCalls).toEqual([]);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(),
      headers: { "x-test-user": "sender", "x-fresh": "1" },
    });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(submitCalls).toEqual([]);
  });

  it("rejects an AI actor", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(),
      headers: as("sender", { "x-fresh": "1", "x-ai": "1" }),
    });
    expect(res.statusCode).toBe(403);
    expect(submitCalls).toEqual([]);
  });

  it("is 404 (not 403) for a claim outside the actor's caseload scope", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(OTHER_CLAIM),
      headers: as("sender", { "x-fresh": "1" }),
    });
    expect(res.statusCode).toBe(404);
    expect(submitCalls).toEqual([]);
  });

  it("answers a gate refusal in the standard error envelope with every reason as a detail", async () => {
    refuse = true;
    const res = await makeServer().inject({
      method: "POST",
      url: submitUrl(),
      headers: as("sender", { "x-fresh": "1" }),
    });
    expect(res.statusCode).toBe(503);
    expect(code(res)).toBe("COMMERCIAL_SEND_REFUSED");
    expect(JSON.stringify(res.json())).toContain("CH_NOT_WIRED");
  });
});

describe("POST .../submissions/:submissionId/reconcile (the exit from in_doubt)", () => {
  const SUB = "44444444-4444-4444-8444-444444444444";
  const url = (claim = CLAIM) =>
    `/api/v1/billing/commercial/claims/${claim}/submissions/${SUB}/reconcile`;
  const body = { outcome: "not_received" };

  it("settles the submission and passes the outcome through", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: url(),
      headers: as("sender", { "x-fresh": "1" }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", submissionId: SUB });
    expect(reconcileCalls).toEqual([
      {
        claimId: CLAIM,
        submissionId: SUB,
        outcome: "not_received",
        kind: "user",
        evidence: undefined,
      },
    ]);
  });

  it("passes the closed-set evidence of a received attestation through, and refuses any other value", async () => {
    const app = makeServer();
    const ok = await app.inject({
      method: "POST",
      url: url(),
      headers: as("sender", { "x-fresh": "1" }),
      payload: { outcome: "received", evidence: "payer_portal" },
    });
    expect(ok.statusCode).toBe(200);
    expect(reconcileCalls[0]).toMatchObject({ outcome: "received", evidence: "payer_portal" });
    const bad = await app.inject({
      method: "POST",
      url: url(),
      headers: as("sender", { "x-fresh": "1" }),
      payload: { outcome: "received", evidence: "i just know" },
    });
    expect(bad.statusCode).toBe(422);
    expect(reconcileCalls).toHaveLength(1);
  });

  it("needs commercial_billing.submit, a FRESH step-up, an Idempotency-Key and a human", async () => {
    const app = makeServer();
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: url(), headers, payload: body });
    expect((await app.inject({ method: "POST", url: url(), payload: body })).statusCode).toBe(401);
    expect((await post(as("reader", { "x-fresh": "1" }))).statusCode).toBe(403);
    const stale = await post(as("sender"));
    expect(stale.statusCode).toBe(403);
    expect(code(stale)).toBe("STEP_UP_REQUIRED");
    expect(code(await post({ "x-test-user": "sender", "x-fresh": "1" }))).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect((await post(as("sender", { "x-fresh": "1", "x-ai": "1" }))).statusCode).toBe(403);
    expect(reconcileCalls).toEqual([]);
  });

  it("refuses free text and unknown outcomes", async () => {
    const app = makeServer();
    for (const payload of [{ outcome: "maybe" }, { outcome: "received", note: "free text" }, {}]) {
      const res = await app.inject({
        method: "POST",
        url: url(),
        headers: as("sender", { "x-fresh": "1" }),
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    expect(reconcileCalls).toEqual([]);
  });

  it("is 404 for a claim outside the caseload scope", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: url(OTHER_CLAIM),
      headers: as("sender", { "x-fresh": "1" }),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET send-gate and timeline", () => {
  it.each(["send-gate", "timeline"])(
    "%s answers 200 for a reader and 403 for nobody",
    async (leaf) => {
      const app = makeServer();
      const url = `/api/v1/billing/commercial/claims/${CLAIM}/${leaf}`;
      const ok = await app.inject({ method: "GET", url, headers: { "x-test-user": "reader" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().claimId).toBe(CLAIM);
      expect(
        (await app.inject({ method: "GET", url, headers: { "x-test-user": "nobody" } })).statusCode,
      ).toBe(403);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    },
  );

  it("is 404 for a claim outside the caseload scope", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `/api/v1/billing/commercial/claims/${OTHER_CLAIM}/timeline`,
      headers: { "x-test-user": "reader" },
    });
    expect(res.statusCode).toBe(404);
  });
});
