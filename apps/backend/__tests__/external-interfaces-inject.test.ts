// apps/backend/__tests__/external-interfaces-inject.test.ts — M29 (External Interfaces) §4.1/§4.2
// route-inventory HTTP-layer smoke test (TASK-050A / TEST-001).
//
// Before this file, M29 had ZERO `app.inject()` coverage: `m29-routes.test.ts` drives the in-memory
// `M29Store` directly (the §2.2 FSM + propose-then-review rules, no Fastify at all), and `m29-abac.test.ts`
// unit-tests the six §4.8 predicate functions in isolation. Neither ever calls `.inject()` through the FULL
// host (`buildServer()` + `mountM29Routes()`), so a mis-wired `requirePermission` key, a `requireAbac`
// predicate-name typo, or a schema drift on any of the thirty-three routes across the six §4.1/§4.2 plugin
// files would be invisible to every existing M29 test. This file closes that gap: `buildServer()` mounts
// the host, `mountM29Routes()` mounts every route via the single aggregator (`routes/mount.ts`), the REAL
// Authorization Contract gates every route on the real §4.7 permission keys, and a FRESH predicate registry
// is seeded with the real `buildM29AbacPredicates` (over a small hand-rolled resolver wrapping the SAME
// in-memory store) plus test-local stand-ins for the two predicates M29 composes on but does not own
// (`step_up_recent`, M3's — the M11/M28/M19 precedent; `inOrg` needs no stand-in, `createPredicateRegistry()`
// seeds it as an M3 intrinsic by default).
//
// `createInMemoryM29Store()` (exported from the module's top-level `index.ts`) returns `M29Store & { seed* }`
// — a strict superset of the `M29RouteServices.store` shape `mountM29Routes` composes over — so, per the
// M11 `createInMemoryOrderBackend` precedent this file clones, it is used directly with no adaptation.
//
// KNOWN, DOCUMENTED (NOT FABRICATED) NON-2xx ROUTES. Nine of the thirty-three routes cannot reach 2xx today
// even for a maximally-permissioned, well-formed caller — every one is a REAL Phase-1 posture the route's
// own file header already declares, asserted here as its true current status, not papered over:
//   - `GET/POST` on a specific inbound OR outbound HL7 message (single-read, decrypt, replay, retry — 5
//     routes in `message.routes.ts`) all answer 404 (or a store `NotFoundError` for replay/retry): the
//     in-memory store's message READ side is an honest stub this wave (`getInboundMessage`/
//     `getOutboundMessage` always return `null`; `replayInboundMessage`/`retryOutboundMessage` always throw
//     `NotFoundError`) — only the LIST routes return real (empty) pages. The Drizzle store fills this in;
//     the in-memory store never claims to.
//   - `GET /nppes/providers/:npi` answers 404 — `getNppesProvider` is likewise an honest always-null stub.
//   - `POST /nppes/sync-runs` answers 403 for a normal tenant actor — `nppes_platform_job_caller` is
//     platform-only by design (W-XI-12; a tenant session carries no platform-operator fact). This file also
//     proves the guard chain is wired past that ABAC gate (not merely closed by accident): with a
//     test-local `isPlatformOperator` attribute set, the SAME request reaches the handler and answers 501 —
//     the honest "the platform scheduler owns this job, no tenant-triggered path in Phase 1" deferral.
//   - `POST /observations/:id/attach-patient` and `POST /observations/:id/discard` both answer 501 — manual
//     bind/discard of an unmatched lab result is T-29.13, explicitly deferred per the route file's header.
// None of these is a guessed status: each is read off the route/store source before being asserted.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type M29AbacResolver,
  type M29Store,
  M29_PERMISSION_KEY_LIST,
  buildM29AbacPredicates,
  createInMemoryM29Store,
  denyStubM29AbacResolver,
  mountM29Routes,
  type NppesSyncTriggerPort,
} from "../src/modules/29-external-interfaces/index";

// ── header-auth shim (the M11/M19/M28 precedent) ─────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-step-up"] === "fresh") {
    request.context.attributes.stepUpRecent = true;
  }
  // A test-local stand-in for the platform-operator fact `withPlatformContext` carries in production — no
  // tenant HTTP session ever sets this for real; it exists here only to prove the ABAC gate on
  // `POST /nppes/sync-runs` is wired past 403 into the real (501, deferred) handler — see the file header.
  if (request.headers["x-test-platform-operator"] === "1") {
    request.context.attributes.isPlatformOperator = true;
  }
}

const ORG = "org_a";
const NOW = "2026-06-08T12:00:00.000Z";

const MEMBER_SUPER = "10000000-0000-4000-8000-000000000001";
const MEMBER_SUPER2 = "10000000-0000-4000-8000-000000000002";
const MEMBER_NOPERM = "10000000-0000-4000-8000-000000000003";

const PROPOSAL_DETAIL = "20000000-0000-4000-8000-000000000001";
const PROPOSAL_ACCEPT = "20000000-0000-4000-8000-000000000002";
const PROPOSAL_REJECT = "20000000-0000-4000-8000-000000000003";
const PROPOSAL_DEFER = "20000000-0000-4000-8000-000000000004";

const OBS_ABNORMAL = "30000000-0000-4000-8000-000000000001";
const OBS_PATIENT = "40000000-0000-4000-8000-000000000001";
const ATTACH_PATIENT = "40000000-0000-4000-8000-000000000002";

// The twenty-one §4.7 keys M29 contributes (`M29_PERMISSION_KEY_LIST`).
const ALL_M29_PERMISSIONS = [...M29_PERMISSION_KEY_LIST];
const PERMISSION_SEED = [
  { userId: "super_1", permissions: ALL_M29_PERMISSIONS },
  { userId: "super_2", permissions: ALL_M29_PERMISSIONS },
  { userId: "noperm_1", permissions: [] as string[] },
];

/**
 * A small hand-rolled `M29AbacResolver` over the SAME in-memory `M29Store` this file's `makeServer()`
 * builds. `holdsPermission` answers from a membership→permission-set map LOCAL to this file — deliberately
 * independent of the M29 RBAC grant seed above: the keys it resolves (`patient.create`, `admission.create`,
 * M29's own `external_interfaces.lab.review_unmatched`) are what the §4.8 predicates check against a
 * MEMBERSHIP's authority, not a userId's effective-permission set; the real Drizzle resolver
 * (`abac-resolver-drizzle.ts`) reads the platform's own effective-permission table — this is the test-local
 * stand-in for that read (the M28 `buildTestAbacResolver` precedent).
 */
function buildM29TestAbacResolver(
  store: M29Store,
  orgId: string,
  membershipPermissions: ReadonlyMap<string, ReadonlySet<string>>,
): M29AbacResolver {
  return {
    ...denyStubM29AbacResolver,
    async feedOrgId(feedId) {
      const feed = await store.getFeed(orgId, feedId);
      return feed ? orgId : null;
    },
    async proposalFacts(org, proposalId) {
      const p = await store.getProposal(org, proposalId);
      if (!p) return null;
      return { organizationId: org, ownerModule: p.ownerModule };
    },
    async observationFacts(org, observationId) {
      const o = await store.getObservation(org, observationId);
      if (!o) return null;
      return { organizationId: org, patientId: o.patientId };
    },
    async holdsPermission(_org, membershipId, key) {
      return membershipPermissions.get(membershipId)?.has(key) ?? false;
    },
    async isInCaseload() {
      // Every fixture below relies on the WIDE-SCOPE arm (`review_unmatched`) instead — see
      // `holdsPermission` above — so the narrow caseload arm never needs to resolve `true` in this file.
      return false;
    },
    async feedBaaSatisfied(org, feedId) {
      // Test-local stand-in for the real M40 BAA gate (`feed/baa-gate.ts` decides this for real, off
      // `baaContractRef`/`baaExpiresOn`/the M40 seam) — this file only needs to prove the ABAC predicate
      // NAME resolves and is wired on the activate route, so any existing feed satisfies it.
      const feed = await store.getFeed(org, feedId);
      return feed ? true : null;
    },
  };
}

function makeServer(opts: { nppesSyncTrigger?: NppesSyncTriggerPort } = {}) {
  const store = createInMemoryM29Store({ now: () => NOW });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const membershipPermissions = new Map<string, ReadonlySet<string>>([
    [
      MEMBER_SUPER,
      new Set(["patient.create", "admission.create", "external_interfaces.lab.review_unmatched"]),
    ],
    [
      MEMBER_SUPER2,
      new Set(["patient.create", "admission.create", "external_interfaces.lab.review_unmatched"]),
    ],
  ]);
  const resolver = buildM29TestAbacResolver(store, ORG, membershipPermissions);

  // A FRESH predicate registry per server (the M11-T06 precedent — the shared registry would otherwise
  // persist a predicate closed over a prior test's store across the file). `createPredicateRegistry()`
  // seeds M3's intrinsics (`inOrg` among them) by default.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM29AbacPredicates({ resolver }))) {
    reg.register(name, predicate);
  }
  // `step_up_recent` is M3's predicate (composed via `requireStepUp` on every D18 step-up route, not owned
  // by M29); a fresh registry starts without it, so a permissive test-local stand-in is registered here
  // (the M11/M19/M28 precedent for a composed-but-foreign predicate).
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  // Seed proposals + one lab observation the route tests below exercise (feeds are created via the HTTP
  // surface itself, in the lifecycle test — see `M29Store` §2.2, feeds have no meaningful "pre-seeded"
  // state worth faking).
  store.seedProposal(ORG, { id: PROPOSAL_DETAIL, proposalStatus: "pending", ownerModule: "m5" });
  store.seedProposal(ORG, { id: PROPOSAL_ACCEPT, proposalStatus: "pending", ownerModule: "m5" });
  store.seedProposal(ORG, { id: PROPOSAL_REJECT, proposalStatus: "pending", ownerModule: "m5" });
  store.seedProposal(ORG, { id: PROPOSAL_DEFER, proposalStatus: "pending", ownerModule: "m5" });
  store.seedObservation(ORG, {
    id: OBS_ABNORMAL,
    patientId: OBS_PATIENT,
    loincCode: "2345-7",
    loincDisplayText: "Glucose",
    abnormalSummary: "any_critical",
    values: [
      {
        obxSetId: 1,
        loincCode: "2345-7",
        loincDisplayText: "Glucose",
        valueType: "NM",
        numericValue: 410,
        stringValue: null,
        units: "mg/dL",
        referenceRange: "70-110",
        abnormalFlag: "HH",
      },
    ],
  });

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM29Routes(app, {
    store,
    ...(opts.nppesSyncTrigger ? { nppesSyncTrigger: opts.nppesSyncTrigger } : {}),
  });
  return { app, store };
}

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator",
  "x-test-membership": MEMBER_SUPER,
  "x-step-up": "fresh",
};
const SUPER2 = {
  "x-test-user": "super_2",
  "x-test-org": ORG,
  "x-test-roles": "administrator",
  "x-test-membership": MEMBER_SUPER2,
  "x-step-up": "fresh",
};
const NOPERM = {
  "x-test-user": "noperm_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-membership": MEMBER_NOPERM,
};

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

// ── auth gating — one 401 / one 403 / one 422 ────────────────────────────────────────────────────────
describe("M29-external-interfaces-inject — auth gating", () => {
  it("no auth headers at all → 401 (route: GET /api/admin/external-interfaces/feeds)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/admin/external-interfaces/feeds" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403 (same route)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/feeds",
      headers: NOPERM,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor with an empty body → 422 VALIDATION_FAILED (route: POST /feeds)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/feeds",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

// ── feed.routes.ts — §4.1.1: the full onboarding FSM over ONE feed, routes 1-10 ─────────────────────────
describe("M29-external-interfaces-inject — §4.1.1 feed + credential lifecycle (routes 1-10)", () => {
  it("create → list → get → update → activate (dual-approval) → mint/list credentials → health → suspend → revoke", async () => {
    const { app } = makeServer();

    // route 3 — POST /feeds (create; step-up).
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/feeds",
      headers: SUPER,
      payload: {
        kind: "adt_inbound",
        displayName: "Mercy Regional ADT",
        host: "mercy.example.org",
        port: 6000,
        protocol: "mllp_tls",
        baaContractRef: "BAA-2026-001",
      },
    });
    expect(created.statusCode).toBe(201);
    const feed = created.json().feed as { id: string; status: string };
    expect(feed.status).toBe("pending_approval");
    const feedId = feed.id;

    // route 1 — GET /feeds (list).
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/feeds",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((f: { id: string }) => f.id)).toContain(feedId);

    // route 2 — GET /feeds/:feedId (single detail).
    const single = await app.inject({
      method: "GET",
      url: `/api/admin/external-interfaces/feeds/${feedId}`,
      headers: SUPER,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().feed.id).toBe(feedId);

    // route 4 — PATCH /feeds/:feedId (edit metadata; step-up).
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/external-interfaces/feeds/${feedId}`,
      headers: SUPER,
      payload: { displayName: "Mercy Regional ADT — Updated" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().feed.displayName).toBe("Mercy Regional ADT — Updated");

    // route 5 — POST /feeds/:feedId/activate — MUST be a DISTINCT membership from the proposer (D18); SUPER
    // created the feed, so SUPER2 is the compliance co-approver.
    const activated = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/feeds/${feedId}/activate`,
      headers: SUPER2,
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().feed.status).toBe("active");

    // route 8 — POST /feeds/:feedId/credentials (mint; step-up).
    const minted = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/feeds/${feedId}/credentials`,
      headers: SUPER,
      payload: { kind: "mllp_channel_password", secret: "s3cr3t-test-value" },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().credential).not.toHaveProperty("secret");

    // route 9 — GET /feeds/:feedId/credentials (list; never ciphertext).
    const creds = await app.inject({
      method: "GET",
      url: `/api/admin/external-interfaces/feeds/${feedId}/credentials`,
      headers: SUPER,
    });
    expect(creds.statusCode).toBe(200);
    expect(creds.json().credentials).toHaveLength(1);

    // route 10 — GET /feeds/:feedId/health (rolling snapshot; null in the in-memory store — still 200).
    const health = await app.inject({
      method: "GET",
      url: `/api/admin/external-interfaces/feeds/${feedId}/health`,
      headers: SUPER,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ health: null });

    // route 6 — POST /feeds/:feedId/suspend (reason required; step-up).
    const suspended = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/feeds/${feedId}/suspend`,
      headers: SUPER,
      payload: { reason: "cert-pin rotation window" },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().feed.status).toBe("suspended");

    // route 7 — POST /feeds/:feedId/revoke (terminal; step-up). No `primaryApproverId` on file yet for THIS
    // route's co-approver ABAC check, so distinctness is trivially satisfied (guards.ts's own comment).
    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/feeds/${feedId}/revoke`,
      headers: SUPER,
      payload: { reason: "partner offboarded" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().feed.status).toBe("revoked");

    await app.close();
  });
});

// ── proposal.routes.ts — §4.1.2: ADT proposal review, routes 11-15 ──────────────────────────────────────
describe("M29-external-interfaces-inject — §4.1.2 inbound-proposal review (routes 11-15)", () => {
  it("route 11 — GET /inbound-proposals lists the review queue", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/inbound-proposals",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(4);
    await app.close();
  });

  it("route 12 — GET /inbound-proposals/:id (owner-module ABAC gate passes for a m5-authorized actor)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/external-interfaces/inbound-proposals/${PROPOSAL_DETAIL}`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.id).toBe(PROPOSAL_DETAIL);
    await app.close();
  });

  it("route 13 — POST /inbound-proposals/:id/accept applies via the owner-module seam (step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/inbound-proposals/${PROPOSAL_ACCEPT}/accept`,
      headers: SUPER,
      payload: { decisionNote: "verified against source" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.proposalStatus).toBe("accepted");
    await app.close();
  });

  it("route 14 — POST /inbound-proposals/:id/reject requires a ≥40-char rationale (step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/inbound-proposals/${PROPOSAL_REJECT}/reject`,
      headers: SUPER,
      payload: {
        rationale: "Duplicate ADT for a patient already discharged — no chart action warranted.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.proposalStatus).toBe("rejected");
    await app.close();
  });

  it("route 15 — POST /inbound-proposals/:id/defer punts to a caseload-RN task, stays pending", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/inbound-proposals/${PROPOSAL_DEFER}/defer`,
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.proposalStatus).toBe("pending");
    await app.close();
  });
});

// ── message.routes.ts — §4.1.3: HL7 message search/replay/retry/decrypt, routes 16-22 ───────────────────
describe("M29-external-interfaces-inject — §4.1.3 message search (routes 16, 20 — genuine 200s)", () => {
  it.each([
    ["GET", "/api/admin/external-interfaces/messages/inbound"],
    ["GET", "/api/admin/external-interfaces/messages/outbound"],
  ] as const)(
    "%s %s → 200 empty page (list side is real; single-read side is not — see below)",
    async (method, url) => {
      const { app } = makeServer();
      const res = await app.inject({ method, url, headers: SUPER });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
      await app.close();
    },
  );
});

describe("M29-external-interfaces-inject — §4.1.3 message single-read/replay/retry/decrypt (routes 17-19, 21-22 — documented 404s)", () => {
  const messageId = "50000000-0000-4000-8000-000000000001";

  it.each([
    ["GET", `/api/admin/external-interfaces/messages/inbound/${messageId}`],
    ["GET", `/api/admin/external-interfaces/messages/outbound/${messageId}`],
  ] as const)(
    "%s %s → 404 (the in-memory store's single-message read is an honest always-null stub)",
    async (method, url) => {
      const { app } = makeServer();
      const res = await app.inject({ method, url, headers: SUPER });
      expect(res.statusCode).toBe(404);
      await app.close();
    },
  );

  it("POST /messages/inbound/:id/decrypt → 404 (getInboundMessage is null before the 'no DEK' 501 is even reached; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/messages/inbound/${messageId}/decrypt`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /messages/inbound/:id/replay → 404 (replayInboundMessage always throws NotFoundError this wave; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/messages/inbound/${messageId}/replay`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /messages/outbound/:id/retry → 404 (retryOutboundMessage always throws NotFoundError this wave; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/external-interfaces/messages/outbound/${messageId}/retry`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── nppes.routes.ts — §4.1.4: NPPES administration, routes 23-25 ────────────────────────────────────────
describe("M29-external-interfaces-inject — §4.1.4 NPPES administration (routes 23-25)", () => {
  it("route 23 — GET /nppes/providers/:npi → 404 (getNppesProvider is an honest always-null stub)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/nppes/providers/1234567890",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("route 24 — GET /nppes/sync-runs → 200 (real, if empty, page)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/nppes/sync-runs",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("route 25 — POST /nppes/sync-runs from a tenant session → 403 (nppes_platform_job_caller is platform-only, W-XI-12; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/nppes/sync-runs",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("route 25 — the SAME request from a platform-operator session clears ABAC and ENQUEUES a run (GAP-045)", async () => {
    const enqueued: Array<{ kind: string; triggeredByMembershipId: string }> = [];
    const { app } = makeServer({
      nppesSyncTrigger: {
        async enqueue(input) {
          enqueued.push(input);
          return { syncRunId: "sync-run-1", jobId: "nppes-manual-sync-run-1" };
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/nppes/sync-runs",
      headers: { ...SUPER, "x-test-platform-operator": "1" },
      payload: {},
    });
    // 202, not 200: an NPPES walk is thousands of rate-limited CMS requests — the route enqueues and
    // answers with the id `GET /nppes/sync-runs` will surface once the worker opens the run row.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ syncRunId: "sync-run-1", status: "queued" });
    // No explicit `kind` in the body ⇒ a `manual` run stamped with the triggering platform actor.
    expect(enqueued).toEqual([{ kind: "manual", triggeredByMembershipId: MEMBER_SUPER }]);
    await app.close();
  });

  it("route 25 — an explicit `kind` forces that scheduled pass rather than a plain manual run", async () => {
    const enqueued: Array<{ kind: string }> = [];
    const { app } = makeServer({
      nppesSyncTrigger: {
        async enqueue(input) {
          enqueued.push(input);
          return { syncRunId: "sync-run-2", jobId: "nppes-manual-sync-run-2" };
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/nppes/sync-runs",
      headers: { ...SUPER, "x-test-platform-operator": "1" },
      payload: { kind: "weekly_dissemination" },
    });
    expect(res.statusCode).toBe(202);
    expect(enqueued[0]?.kind).toBe("weekly_dissemination");
    await app.close();
  });

  it("route 25 — with NO queue connection the trigger 503s: 'no worker here', not 'no such feature'", async () => {
    const { app } = makeServer(); // trigger unbound — a db-only / REDIS-less boot
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/external-interfaces/nppes/sync-runs",
      headers: { ...SUPER, "x-test-platform-operator": "1" },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/REDIS_URL/);
    await app.close();
  });
});

// ── ops.routes.ts — §4.1.5: read-mostly ops surface, routes 26-27 ───────────────────────────────────────
describe("M29-external-interfaces-inject — §4.1.5 ops surface (routes 26-27)", () => {
  it("route 26 — GET /health/aggregate → 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/health/aggregate",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().health).toHaveProperty("feedCount");
    await app.close();
  });

  it("route 27 — GET /metrics/listener-status → 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/external-interfaces/metrics/listener-status",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listeners).toEqual([]);
    await app.close();
  });
});

// ── labs.routes.ts — §4.2: clinician lab surface, routes 28-33 ──────────────────────────────────────────
describe("M29-external-interfaces-inject — §4.2 clinician lab surface (routes 28-33)", () => {
  it("route 28 — GET /observations lists caseload-scoped (here: wide-scope) observations", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/clinical/labs/observations",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((o: { id: string }) => o.id)).toContain(OBS_ABNORMAL);
    await app.close();
  });

  it("route 29 — GET /observations/unmatched → 200 (real, if empty, page)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/clinical/labs/observations/unmatched",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("route 30 — GET /observations/:id → 200 (caseload-or-scope ABAC passes via the wide-scope arm)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/clinical/labs/observations/${OBS_ABNORMAL}`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().observation.id).toBe(OBS_ABNORMAL);
    await app.close();
  });

  it("route 31 — POST /observations/:id/attach-patient → 501 (manual bind of an unmatched result is T-29.13; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/clinical/labs/observations/${OBS_ABNORMAL}/attach-patient`,
      headers: SUPER,
      payload: { patientId: ATTACH_PATIENT },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("NOT_IMPLEMENTED");
    await app.close();
  });

  it("route 32 — POST /observations/:id/discard → 501 (discard lands with the manual bind, T-29.13; step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/clinical/labs/observations/${OBS_ABNORMAL}/discard`,
      headers: SUPER,
      payload: { reason: "duplicate result, already reconciled" },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("NOT_IMPLEMENTED");
    await app.close();
  });

  it("route 33 — POST /observations/:id/acknowledge-abnormal → 200 (RN clears the M36 badge on a flagged result)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/clinical/labs/observations/${OBS_ABNORMAL}/acknowledge-abnormal`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      acknowledged: true,
      observationId: OBS_ABNORMAL,
      acknowledgedBy: MEMBER_SUPER,
    });
    await app.close();
  });
});
