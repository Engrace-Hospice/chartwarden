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
import {
  isSudAnchored,
  redactDisciplineSnapshot,
} from "../src/modules/15-discipline-care-plans/routes/snapshot-redaction";

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

  it("withholds a no-goals snapshot that is not the draft shape (fail closed on an unknown shape)", () => {
    expect(
      redactDisciplineSnapshot({ volunteerOutOfScopeAcknowledged: [], notes: "x" }, false),
    ).toBeNull();
    expect(redactDisciplineSnapshot({ interventions: [] }, false)).toBeNull();
  });

  describe("interventions that serve a hidden goal", () => {
    const serving = (id: string, goalRefs: string[]) => ({
      interventionId: id,
      goalRefs,
      scopeText: `text-${id}`,
    });
    const interventions = [
      serving("i-sud", ["G-SUD"]), // upper case: a uuid is case-insensitive
      serving("i-mixed", ["g-plain", "g-sud"]),
      serving("i-plain", ["g-plain"]),
      serving("i-free", []),
    ];

    it("drops them, so neither their text nor the hidden goal's id survives", () => {
      const out = redactDisciplineSnapshot(
        { goals: [sudGoal, plainGoal], interventions },
        false,
      ) as {
        interventions: { interventionId: string }[];
      };
      expect(out.interventions.map((i) => i.interventionId)).toEqual(["i-plain", "i-free"]);
      expect(JSON.stringify(out).toLowerCase()).not.toContain("g-sud");
    });

    it("keeps every intervention when disclosure is allowed", () => {
      const snapshot = { goals: [sudGoal, plainGoal], interventions };
      expect(redactDisciplineSnapshot(snapshot, true)).toBe(snapshot);
    });

    it("treats a goal with no flag as hidden, and so the interventions that serve it", () => {
      const out = redactDisciplineSnapshot(
        { goals: [flaglessGoal, plainGoal], interventions: [serving("i-x", ["g-flagless"])] },
        false,
      ) as { interventions: unknown[] };
      expect(out.interventions).toEqual([]);
    });

    it("withholds the whole snapshot when interventions is not an array", () => {
      expect(
        redactDisciplineSnapshot({ goals: [plainGoal], interventions: "oops" }, false),
      ).toBeNull();
    });
  });

  it("isSudAnchored matches a goal ref against the hidden ids case-insensitively and ignores junk refs", () => {
    const hidden = new Set(["abc-1"]);
    expect(isSudAnchored(["ABC-1"], hidden)).toBe(true);
    expect(isSudAnchored(["other", 7, null], hidden)).toBe(false);
    expect(isSudAnchored("abc-1", hidden)).toBe(false);
    expect(isSudAnchored(undefined, hidden)).toBe(false);
    expect(isSudAnchored(["abc-1"], new Set())).toBe(false);
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

/** A write-service call the stub recorded: the method and its input (the fourth argument of every command). */
interface RecordedCall {
  readonly name: string;
  readonly input: Record<string, unknown> | undefined;
}

function makeServer(disclosure: DisclosurePort, calls: RecordedCall[] = []) {
  const writeService = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) =>
      name === "planPatientId"
        ? async (_actor: unknown, planId: string) => (planId === PLAN ? PATIENT : null)
        : async (...args: unknown[]) => {
            calls.push({ name, input: args[3] as RecordedCall["input"] });
            return versionDetail;
          },
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

// A write RESULT carries the row it touched (a goal's text, an assessment's `data`), so the write routes hand the
// service the caller's disclosure gate and the service answers "not found" for confidential content.
describe("M15 goal, intervention and assessment writes carry the caller's disclosure gate", () => {
  const GOAL = "44444444-4444-4444-8444-444444444444";
  const INTERVENTION = "55555555-5555-4555-8555-555555555555";
  const ASSESSMENT = "66666666-6666-4666-8666-666666666666";
  const plan = `/api/v1/discipline-plans/${PLAN}`;
  const WRITES = [
    {
      name: "goal edit",
      service: "updateGoal",
      method: "PATCH",
      url: `${plan}/goals/${GOAL}`,
      payload: { measurableOutcome: "m" },
    },
    {
      name: "intervention edit",
      service: "updateIntervention",
      method: "PATCH",
      url: `${plan}/interventions/${INTERVENTION}`,
      payload: { scopeText: "s" },
    },
    {
      name: "assessment sign",
      service: "signAssessment",
      method: "POST",
      url: `${plan}/assessments/${ASSESSMENT}/sign`,
      payload: undefined,
    },
    {
      name: "assessment amend",
      service: "amendAssessment",
      method: "POST",
      url: `${plan}/assessments/${ASSESSMENT}/amend`,
      payload: { amendmentReason: "Corrected the recorded history.", data: {} },
    },
  ] as const;

  const send = async (
    route: (typeof WRITES)[number],
    user: string,
    port: DisclosurePort,
    payload: Record<string, unknown> | undefined = route.payload,
  ) => {
    const calls: RecordedCall[] = [];
    const app = makeServer(port, calls);
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: { ...as(user), "idempotency-key": `k-${++keySeq}` },
      payload,
    });
    await app.close();
    return { res, input: calls.find((c) => c.name === route.service)?.input };
  };

  for (const route of WRITES) {
    it(`${route.name}: hands the service a CLOSED gate for a caller without disclosure`, async () => {
      const { res, input } = await send(route, UNCLEARED, clearedPort);
      expect(res.statusCode).toBeLessThan(300);
      expect(input).toMatchObject({ sudAllowed: false, familyViolenceAllowed: false });
    });

    it(`${route.name}: opens the Part 2 gate for a caller cleared by M39`, async () => {
      const { input } = await send(route, CLEARED, clearedPort);
      expect(input).toMatchObject({ sudAllowed: true });
    });

    it(`${route.name}: fails closed when the disclosure lookup throws`, async () => {
      const outage: DisclosurePort = {
        part2ReleaseActive: async () => {
          throw new Error("M39 outage");
        },
        familyViolenceRedacted: async () => {
          throw new Error("M39 outage");
        },
      };
      const { input } = await send(route, CLEARED, outage);
      expect(input).toMatchObject({ sudAllowed: false, familyViolenceAllowed: false });
    });

    it(`${route.name}: a body that claims the gate cannot widen it`, async () => {
      const claimed = { ...(route.payload ?? {}), sudAllowed: true, familyViolenceAllowed: true };
      const { input } = await send(route, UNCLEARED, clearedPort, claimed);
      // Either the body is stripped or refused; the service never sees a widened gate.
      if (input) expect(input).toMatchObject({ sudAllowed: false, familyViolenceAllowed: false });
    });
  }
});
