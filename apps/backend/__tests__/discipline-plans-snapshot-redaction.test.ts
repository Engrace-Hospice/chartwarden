// apps/backend/__tests__/discipline-plans-snapshot-redaction.test.ts — 42 CFR Part 2 (§7.8) on the M15
// version ledger. A version's sealed `stateSnapshot` holds EVERY goal, `sudRelated: true` ones included, so
// the version detail read and the finalize / sign results must redact it for a caller without Part 2
// disclosure — the same verdict `getPlan` applies to the live goals. Pure-function cases first, then the
// real M3 contract + M1 middleware over stub services and an injected M39 disclosure port (no live infra).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M15_PERMISSION_KEY_LIST,
  mountM15Routes,
} from "../src/modules/15-discipline-care-plans/index";
import type {
  DisclosurePort,
  M15ReadService,
  M15WriteService,
} from "../src/modules/15-discipline-care-plans/routes/index";
import { redactDisciplineSnapshot } from "../src/modules/15-discipline-care-plans/routes/snapshot-redaction";

const SUD_TEXT = "SYNTHETIC-SUD-GOAL-TEXT";
const PLAIN_TEXT = "SYNTHETIC-PLAIN-GOAL-TEXT";

const sudGoal = { goalId: "g-sud", originalText: SUD_TEXT, sudRelated: true };
const plainGoal = { goalId: "g-plain", originalText: PLAIN_TEXT, sudRelated: false };
const flaglessGoal = { goalId: "g-flagless", originalText: "no flag at all" };

describe("redactDisciplineSnapshot", () => {
  it("passes the snapshot through untouched when SUD disclosure is allowed", () => {
    const snapshot = { goals: [sudGoal, plainGoal] };
    expect(redactDisciplineSnapshot(snapshot, true)).toBe(snapshot);
  });

  it("drops a sudRelated goal when disclosure is not allowed", () => {
    const out = redactDisciplineSnapshot({ sealedAt: "t", goals: [sudGoal, plainGoal] }, false);
    expect(out).toEqual({ sealedAt: "t", goals: [plainGoal] });
  });

  it("drops a goal with a missing or non-false sudRelated flag (fail closed)", () => {
    const out = redactDisciplineSnapshot(
      { goals: [flaglessGoal, { sudRelated: "false" }, null, "x", plainGoal] },
      false,
    );
    expect(out).toEqual({ goals: [plainGoal] });
  });

  it("withholds the whole snapshot when goals is not an array", () => {
    expect(redactDisciplineSnapshot({ goals: "oops" }, false)).toBeNull();
    expect(redactDisciplineSnapshot({ goals: null }, false)).toBeNull();
    expect(redactDisciplineSnapshot({ goals: { 0: sudGoal } }, false)).toBeNull();
  });

  it("withholds a snapshot that is not an object", () => {
    for (const bad of ["str", 7, true, [sudGoal]]) {
      expect(redactDisciplineSnapshot(bad, false)).toBeNull();
    }
  });

  it("returns null for a null or undefined snapshot", () => {
    expect(redactDisciplineSnapshot(null, false)).toBeNull();
    expect(redactDisciplineSnapshot(undefined, false)).toBeNull();
    expect(redactDisciplineSnapshot(null, true)).toBeNull();
  });

  it("passes a draft working snapshot (no goals key) through as is", () => {
    const draft = { volunteerOutOfScopeAcknowledged: ["a"] };
    expect(redactDisciplineSnapshot(draft, false)).toBe(draft);
  });

  it("does not mutate its input", () => {
    const snapshot = Object.freeze({ goals: Object.freeze([sudGoal, plainGoal]) });
    const out = redactDisciplineSnapshot(snapshot, false);
    expect(snapshot.goals).toEqual([sudGoal, plainGoal]);
    expect(out).not.toBe(snapshot);
  });
});

// ── route level ──────────────────────────────────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.attributes.stepUpRecent = true;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
/** Cleared by M39 for PATIENT's Part 2 release; every other user is not. */
const CLEARED = "cleared_rn";
const UNCLEARED = "uncleared_rn";

const versionDetail = {
  versionId: VERSION,
  planId: PLAN,
  sequence: 1,
  status: "in_review",
  kind: "aide_poc",
  idgMeetingId: null,
  finalizedAt: null,
  signedAt: null,
  supersededAt: null,
  version: 2,
  stateSnapshot: { sealedAt: "2026-07-30T12:00:00.000Z", goals: [sudGoal, plainGoal] },
  requiredSignerSet: [],
  signatures: [],
};

function makeServer(disclosure: DisclosurePort) {
  const writeService = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) =>
      name === "planPatientId"
        ? async (_actor: unknown, planId: string) => (planId === PLAN ? PATIENT : null)
        : async () => versionDetail,
  }) as unknown as M15WriteService;
  const readService = new Proxy({} as Record<string, unknown>, {
    get: () => async () => versionDetail,
  }) as unknown as M15ReadService;

  const store = createInMemoryEffectivePermissionStore(
    [CLEARED, UNCLEARED].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M15_PERMISSION_KEY_LIST],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  // This file isolates the SUD redaction: the scope and step-up predicates are permissive.
  const reg = createPredicateRegistry();
  for (const name of ["caseload_or_scope", "step_up_recent"]) {
    reg.register(name, async () => true);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM15Routes(app, { readService, writeService, disclosure });
  return app;
}

const clearedPort: DisclosurePort = {
  part2ReleaseActive: async ({ membershipId }) => ({
    allowed: membershipId === CLEARED,
    restrictedToNamedWorkforce: true,
  }),
  familyViolenceRedacted: async () => true,
};

const as = (user: string) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  // not rn_case_manager: the role path to Part 2 content must not be what grants it here
  "x-test-roles": "rn",
  "if-match": '"2"',
});

let keySeq = 0;
const base = `/api/v1/discipline-plans/${PLAN}/versions/${VERSION}`;
const ROUTES = [
  { name: "version detail", method: "GET", url: base, payload: undefined },
  { name: "finalize", method: "POST", url: `${base}/finalize`, payload: {} },
  {
    name: "sign",
    method: "POST",
    url: `${base}/sign`,
    payload: { signerRole: "rn", attestationText: "I attest this plan is accurate." },
  },
] as const;

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

describe("M15 version routes redact the sealed snapshot (42 CFR Part 2)", () => {
  for (const route of ROUTES) {
    it(`${route.name}: hides the SUD goal from a caller without disclosure`, async () => {
      const app = makeServer(clearedPort);
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...as(UNCLEARED), "idempotency-key": `k-${++keySeq}` },
        payload: route.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SUD_TEXT);
      expect(res.body).toContain(PLAIN_TEXT);
      await app.close();
    });

    it(`${route.name}: shows the SUD goal to a caller cleared by M39`, async () => {
      const app = makeServer(clearedPort);
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...as(CLEARED), "idempotency-key": `k-${++keySeq}` },
        payload: route.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(SUD_TEXT);
      expect(res.body).toContain(PLAIN_TEXT);
      await app.close();
    });

    it(`${route.name}: fails closed when the disclosure lookup throws`, async () => {
      const app = makeServer({
        part2ReleaseActive: async () => {
          throw new Error("M39 outage");
        },
        familyViolenceRedacted: async () => {
          throw new Error("M39 outage");
        },
      });
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...as(CLEARED), "idempotency-key": `k-${++keySeq}` },
        payload: route.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SUD_TEXT);
      await app.close();
    });
  }

  it("leaves the stored snapshot the service returned untouched", async () => {
    const app = makeServer(clearedPort);
    await app.inject({
      method: "GET",
      url: base,
      headers: as(UNCLEARED),
    });
    expect(versionDetail.stateSnapshot.goals).toEqual([sudGoal, plainGoal]);
    await app.close();
  });
});
