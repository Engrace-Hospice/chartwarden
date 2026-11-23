// apps/backend/__tests__/wounds-routes.test.ts — M9 longitudinal wounds: the routes through the FULL M1 middleware chain
// (Fastify `inject`, no live infra) over the in-memory service. The REAL Authorization Contract gates every route on the
// existing M9 keys (`assessment.read` / `assessment.author` / `assessment.amend`) plus the shared `caseload_or_scope`
// predicate; a header-auth shim fills `request.context`. Covers 401/403, patient scope, a 422 per validation rule, create,
// observe, correct (If-Match), resolve and tenant / patient isolation.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { EncounterDraftFacts, EncounterDraftReader } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  createInMemoryWoundService,
  registerWoundRoutes,
} from "../src/modules/09-assessments/index";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "11111111-1111-4111-8111-222222222222";
const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_RN = "77777777-7777-4777-8777-000000000001";
const NOW = new Date("2026-11-19T15:00:00.000Z");
/** The visit the RN is writing: M8 answers it for the RN's own patient, still a draft. */
const OPEN_VISIT: EncounterDraftFacts = {
  patientId: PATIENT,
  status: "draft",
  authoredByMembershipId: MEMBERSHIP_RN,
  templateStatesWounds: true,
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = request.headers["x-test-membership"] ?? "";
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["rn"];
  request.context.attributes.actorKind = "user";
}

const PERMISSIONS = [
  { userId: "rn_1", permissions: ["assessment.read", "assessment.author", "assessment.amend"] },
  { userId: "viewer_1", permissions: ["assessment.read"] },
  { userId: "nobody_1", permissions: [] },
];

type IsInCaseload = (q: {
  organizationId: string;
  userId: string;
  patientId: string;
}) => Promise<boolean>;

function makeServer(
  options: {
    isInCaseload?: IsInCaseload;
    /** The visits M8 would answer for, by encounter id (default: the RN's open visit). */
    visits?: Readonly<Record<string, EncounterDraftFacts>>;
    /** A scripted reader instead (it wins over `visits`): to change the answer between two calls. */
    reader?: EncounterDraftReader;
  } = {},
) {
  const known = options.visits ?? { [ENCOUNTER]: OPEN_VISIT };
  const backend = createInMemoryWoundService({
    now: () => NOW,
    visits: options.reader ?? { draftOf: async ({ encounterId }) => known[encounterId] ?? null },
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSIONS.flatMap((s) =>
        [ORG, ORG_B].map((org) => ({
          orgId: org,
          userId: s.userId,
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
          ],
        })),
      ),
    ).store,
  );
  const registry = createPredicateRegistry();
  const m7 = buildCarePlanAbacPredicates({
    resolver: {
      loadPlan: async () => null,
      loadProblem: async () => null,
      loadVersion: async () => null,
    },
    isInCaseload: options.isInCaseload ?? (async () => true),
  });
  registry.register("caseload_or_scope", m7.caseload_or_scope);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerWoundRoutes(app, { service: backend.service });
  return { app, backend };
}

/** The routes that append a row (register, observe, correct) require an Idempotency-Key: each request gets its own. */
const withKey = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  "idempotency-key": randomUUID(),
});

const as = (user: string, org = ORG) => ({
  "x-test-user": user,
  "x-test-org": org,
  "x-test-membership":
    user === "rn_1" ? MEMBERSHIP_RN : `77777777-7777-4777-8777-0000000000${user.length}`,
});
const RN = as("rn_1");
const VIEWER = as("viewer_1");

const woundsUrl = (patient = PATIENT) => `/api/v1/patients/${patient}/wounds`;
const heel = {
  siteCode: "heel",
  laterality: "left",
  etiology: "pressure_injury",
  acquired: "present_on_admission",
};

async function create(
  app: FastifyInstance,
  body: Record<string, unknown> = heel,
  headers = RN,
  patient = PATIENT,
) {
  return app.inject({
    method: "POST",
    url: woundsUrl(patient),
    headers: withKey(headers),
    payload: body,
  });
}
async function observe(
  app: FastifyInstance,
  woundId: string,
  body: Record<string, unknown> = {},
  headers = RN,
  patient = PATIENT,
) {
  return app.inject({
    method: "POST",
    url: `${woundsUrl(patient)}/${woundId}/observations`,
    headers: withKey(headers),
    payload: body,
  });
}

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

describe("wound routes: authentication, authorization and patient scope", () => {
  it("answers 401 without a session", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: woundsUrl() });
    expect(res.statusCode).toBe(401);
  });

  it("answers 403 to a reader who cannot author, and to a user with no key at all", async () => {
    const { app } = makeServer();
    expect((await create(app, heel, VIEWER)).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: woundsUrl(), headers: as("nobody_1") })).statusCode,
    ).toBe(403);
  });

  it("lets a reader read", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: woundsUrl(), headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wounds: [] });
  });

  it("is a non-leaking 404 for a patient outside the caseload, on every route", async () => {
    // Arrange: a wound exists, then the caller's caseload no longer covers the patient
    const inCaseload = { value: true };
    const { app } = makeServer({ isInCaseload: async () => inCaseload.value });
    const woundId = (await create(app)).json().id as string;
    inCaseload.value = false;
    // Act + Assert
    const reads = [
      app.inject({ method: "GET", url: woundsUrl(), headers: RN }),
      app.inject({ method: "GET", url: `${woundsUrl()}/${woundId}`, headers: RN }),
    ];
    const writes = [
      create(app),
      observe(app, woundId),
      app.inject({
        method: "POST",
        url: `${woundsUrl()}/${woundId}/resolve`,
        headers: RN,
        payload: { status: "healed" },
      }),
    ];
    for (const res of await Promise.all([...reads, ...writes])) expect(res.statusCode).toBe(404);
  });
});

describe("wound routes: create and read", () => {
  it("registers a wound and states its location as a display phrase", async () => {
    const { app } = makeServer();
    const res = await create(app);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      patientId: PATIENT,
      siteCode: "heel",
      laterality: "left",
      site: "left heel",
      etiology: "pressure_injury",
      acquired: "present_on_admission",
      status: "open",
      closedOn: null,
      onsetOn: null,
    });
    expect(res.json()).not.toHaveProperty("organizationId");
  });

  it("defaults acquired to unknown", async () => {
    const { app } = makeServer();
    const res = await create(app, {
      siteCode: "sacrum",
      laterality: "midline",
      etiology: "pressure_injury",
    });
    expect(res.json().acquired).toBe("unknown");
  });

  it("lists each wound with its newest current observation, open wounds first, and filters by status", async () => {
    // Arrange
    const { app } = makeServer();
    const first = (await create(app, { ...heel, siteCode: "sacrum", laterality: "midline" })).json()
      .id as string;
    const second = (
      await create(app, { siteCode: "knee", laterality: "right", etiology: "surgical" })
    ).json().id as string;
    await observe(app, first, {
      observedAt: "2026-11-10T10:00:00.000Z",
      lengthCm: 4,
      widthCm: 2.5,
    });
    await observe(app, first, {
      observedAt: "2026-11-17T10:00:00.000Z",
      lengthCm: 3,
      widthCm: 2.5,
    });
    await app.inject({
      method: "POST",
      url: `${woundsUrl()}/${second}/resolve`,
      headers: RN,
      payload: { status: "healed" },
    });
    // Act
    const all = (await app.inject({ method: "GET", url: woundsUrl(), headers: RN })).json().wounds;
    const open = (
      await app.inject({ method: "GET", url: `${woundsUrl()}?status=open`, headers: RN })
    ).json().wounds;
    const healed = (
      await app.inject({ method: "GET", url: `${woundsUrl()}?status=healed`, headers: RN })
    ).json().wounds;
    // Assert
    expect(all.map((w: { id: string }) => w.id)).toEqual([first, second]);
    expect(all[0].latestObservation).toMatchObject({
      observedAt: "2026-11-17T10:00:00.000Z",
      areaCm2: 7.5,
      areaChangePercent: -25,
    });
    expect(all[1].latestObservation).toBeNull();
    expect(open.map((w: { id: string }) => w.id)).toEqual([first]);
    expect(healed.map((w: { id: string }) => w.id)).toEqual([second]);
  });

  it("rejects an unknown status filter", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `${woundsUrl()}?status=gone`, headers: RN });
    expect(res.statusCode).toBe(422);
  });

  it("returns a wound with its observations newest first and the computed area and percent change", async () => {
    // Arrange
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    await observe(app, woundId, {
      observedAt: "2026-11-01T10:00:00.000Z",
      lengthCm: 4,
      widthCm: 2.5,
      stage: "stage_3",
    });
    await observe(app, woundId, {
      observedAt: "2026-11-08T10:00:00.000Z",
      lengthCm: 3,
      widthCm: 2.5,
      stage: "stage_3",
    });
    // Act
    const res = await app.inject({ method: "GET", url: `${woundsUrl()}/${woundId}`, headers: RN });
    // Assert
    expect(res.statusCode).toBe(200);
    const { wound, observations } = res.json();
    expect(wound.id).toBe(woundId);
    expect(observations.map((o: { observedAt: string }) => o.observedAt)).toEqual([
      "2026-11-08T10:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
    ]);
    expect(observations[0]).toMatchObject({
      areaCm2: 7.5,
      areaChangePercent: -25,
      areaChangeSinceObservedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(observations[1]).toMatchObject({ areaCm2: 10, areaChangePercent: null });
  });

  it("is a 404 for a wound that does not exist, and one asked for under another patient", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    const missing = await app.inject({
      method: "GET",
      url: `${woundsUrl()}/99999999-9999-4999-8999-999999999999`,
      headers: RN,
    });
    const wrongPatient = await app.inject({
      method: "GET",
      url: `${woundsUrl(OTHER_PATIENT)}/${woundId}`,
      headers: RN,
    });
    expect(missing.statusCode).toBe(404);
    expect(wrongPatient.statusCode).toBe(404);
  });

  it("refuses a body with a field it does not know (no client-set status or ids)", async () => {
    const { app } = makeServer();
    const res = await create(app, { ...heel, status: "healed", organizationId: ORG_B });
    expect(res.statusCode).toBe(422);
  });
});

describe("wound routes: a 422 for each rule", () => {
  const rule = async (woundBody: Record<string, unknown>, observation: Record<string, unknown>) => {
    const { app } = makeServer();
    const woundId = (await create(app, woundBody)).json().id as string;
    return observe(app, woundId, observation);
  };
  const venous = { siteCode: "calf_shin", laterality: "left", etiology: "venous_ulcer" };

  it.each([
    [
      "a stage on a wound that is not a pressure injury",
      venous,
      { stage: "stage_2" },
      "WOUND_STAGE_NOT_APPLICABLE",
    ],
    ["a depth without length and width", venous, { depthCm: 1 }, "WOUND_DEPTH_REQUIRES_AREA"],
    [
      "a dressing change without a dressing",
      venous,
      { dressingChanged: true },
      "WOUND_DRESSING_REQUIRED",
    ],
    ["a negative measurement", venous, { lengthCm: -1 }, "WOUND_MEASUREMENT_RANGE"],
    [
      "a measurement past the bound",
      venous,
      { lengthCm: 250, widthCm: 2 },
      "WOUND_MEASUREMENT_RANGE",
    ],
    ["a pain score past 10", venous, { painScore: 11 }, "WOUND_PAIN_RANGE"],
    [
      "intact skin beside another periwound finding",
      venous,
      { periwound: ["intact", "erythema"] },
      "WOUND_PERIWOUND_INTACT_EXCLUSIVE",
    ],
    [
      "a repeated wound bed tissue",
      venous,
      { woundBed: ["slough", "slough"] },
      "WOUND_BED_DUPLICATE",
    ],
    [
      "an observation dated in the future",
      venous,
      { observedAt: "2026-11-25T10:00:00.000Z" },
      "WOUND_OBSERVED_IN_FUTURE",
    ],
    [
      "an observation dated before the wound's onset",
      { ...venous, onsetOn: "2026-11-01" },
      { observedAt: "2026-10-15T10:00:00.000Z" },
      "WOUND_OBSERVED_BEFORE_ONSET",
    ],
    [
      "an observation dated before 2000",
      venous,
      { observedAt: "1999-12-31T00:00:00.000Z" },
      "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
    ],
  ])("rejects %s", async (_name, woundBody, observation, code) => {
    const res = await rule(woundBody, observation);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe(code);
  });

  it("422s a year-0000 observedAt as a malformed request, before the service converts it to a Date Postgres cannot store", async () => {
    const res = await rule(venous, { observedAt: "0000-01-01T00:00:00Z" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(res.json())).toContain("observedAt");
  });

  it("rejects a laterality the site does not have, and an onset date in the future", async () => {
    const { app } = makeServer();
    const mismatch = await create(app, { ...heel, siteCode: "sacrum", laterality: "left" });
    const future = await create(app, { ...heel, onsetOn: "2026-12-01" });
    expect(mismatch.json().error.code).toBe("WOUND_SITE_LATERALITY_MISMATCH");
    expect(future.json().error.code).toBe("WOUND_ONSET_IN_FUTURE");
    expect([mismatch.statusCode, future.statusCode]).toEqual([422, 422]);
  });

  it("rejects a value outside the vocabulary as a malformed request", async () => {
    const { app } = makeServer();
    expect((await create(app, { ...heel, etiology: "bedsore" })).statusCode).toBe(422);
    expect((await create(app, { ...heel, siteCode: "elbow_pit" })).statusCode).toBe(422);
    const woundId = (await create(app)).json().id as string;
    expect((await observe(app, woundId, { odor: "fruity" })).json().error.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("stores nothing when a rule is broken", async () => {
    const { app, backend } = makeServer();
    const woundId = (await create(app, venous)).json().id as string;
    await observe(app, woundId, { stage: "stage_2" });
    expect(backend.observations()).toEqual([]);
  });
});

describe("wound routes: observations", () => {
  it("records an observation, authored by the caller's membership, with the encounter it was recorded at", async () => {
    // Arrange
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    // Act
    const res = await observe(app, woundId, {
      observedAt: "2026-11-19T14:00:00.000Z",
      sourceEncounterId: ENCOUNTER,
      stage: "stage_2",
      lengthCm: 3.2,
      widthCm: 2.1,
      depthCm: 0.4,
      undermining: false,
      woundBed: ["granulation"],
      exudateAmount: "small",
      exudateType: "serous",
      odor: "none",
      periwound: ["erythema"],
      painScore: 3,
      dressing: "foam",
      dressingChanged: true,
      infectionSigns: false,
      trend: "new",
    });
    // Assert
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      woundId,
      patientId: PATIENT,
      observedByMembershipId: MEMBERSHIP_RN,
      sourceEncounterId: ENCOUNTER,
      stage: "stage_2",
      woundBed: ["granulation"],
      periwound: ["erythema"],
      status: "active",
      version: 1,
      correctsObservationId: null,
      areaCm2: 6.72,
      areaChangePercent: null,
    });
  });

  it("accepts an observation dated on or after the wound's onset", async () => {
    const { app } = makeServer();
    const woundId = (await create(app, { ...heel, onsetOn: "2026-11-01" })).json().id as string;
    const res = await observe(app, woundId, { observedAt: "2026-11-01T08:00:00.000Z" });
    expect(res.statusCode).toBe(201);
  });

  describe("the visit an observation is tied to", () => {
    const OTHER_MEMBERSHIP = "77777777-7777-4777-8777-000000000099";
    const ELSEWHERE = "55555555-5555-4555-8555-999999999999";
    const closed = (status: EncounterDraftFacts["status"]) => ({
      [ENCOUNTER]: { ...OPEN_VISIT, status },
    });

    it.each([
      ["an unknown visit", {}],
      ["another patient's visit", { [ENCOUNTER]: { ...OPEN_VISIT, patientId: OTHER_PATIENT } }],
      [
        "another clinician's visit",
        { [ENCOUNTER]: { ...OPEN_VISIT, authoredByMembershipId: OTHER_MEMBERSHIP } },
      ],
    ])("is a 404 for %s, and stores nothing", async (_name, visits) => {
      const { app, backend } = makeServer({ visits });
      const woundId = (await create(app)).json().id as string;
      const res = await observe(app, woundId, { sourceEncounterId: ENCOUNTER });
      expect(res.statusCode).toBe(404);
      expect(backend.observations()).toEqual([]);
    });

    it.each(["finalized", "signed", "voided"] as const)(
      "is a 409 ENCOUNTER_NOT_DRAFT for a %s note, so nothing is tied to a closed note",
      async (status) => {
        const { app, backend } = makeServer({ visits: closed(status) });
        const woundId = (await create(app)).json().id as string;
        const res = await observe(app, woundId, { sourceEncounterId: ENCOUNTER });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("ENCOUNTER_NOT_DRAFT");
        expect(backend.observations()).toEqual([]);
      },
    );

    it("is a 422 WOUND_NOT_IN_NOTE for the caller's own open note that has no wounds section (a telephonic visit), and stores nothing", async () => {
      const { app, backend } = makeServer({
        visits: { [ENCOUNTER]: { ...OPEN_VISIT, templateStatesWounds: false } },
      });
      const woundId = (await create(app)).json().id as string;
      const res = await observe(app, woundId, { sourceEncounterId: ENCOUNTER });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("WOUND_NOT_IN_NOTE");
      expect(backend.observations()).toEqual([]);
      // Recorded without the visit, the same observation is accepted: it is the link to that note that is refused.
      expect((await observe(app, woundId, { stage: "stage_2" })).statusCode).toBe(201);
    });

    it("answers 404 and 409 before 422: a note that is not the caller's, or is closed, says nothing about its template", async () => {
      const notMine = makeServer({
        visits: {
          [ENCOUNTER]: {
            ...OPEN_VISIT,
            authoredByMembershipId: OTHER_MEMBERSHIP,
            templateStatesWounds: false,
          },
        },
      });
      const closedNoWounds = makeServer({
        visits: {
          [ENCOUNTER]: { ...OPEN_VISIT, status: "finalized", templateStatesWounds: false },
        },
      });
      const statusOf = async ({ app }: ReturnType<typeof makeServer>) => {
        const woundId = (await create(app)).json().id as string;
        return (await observe(app, woundId, { sourceEncounterId: ENCOUNTER })).statusCode;
      };
      expect([await statusOf(notMine), await statusOf(closedNoWounds)]).toEqual([404, 409]);
    });

    it("refuses to move a corrected observation onto a note that has no wounds section", async () => {
      const visits: Record<string, EncounterDraftFacts> = {
        [ENCOUNTER]: OPEN_VISIT,
        [ELSEWHERE]: { ...OPEN_VISIT, templateStatesWounds: false },
      };
      const { app } = makeServer({ visits });
      const woundId = (await create(app)).json().id as string;
      const original = (await observe(app, woundId, { sourceEncounterId: ENCOUNTER })).json();
      const res = await app.inject({
        method: "POST",
        url: `${woundsUrl()}/${woundId}/observations/${original.id}/corrections`,
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: { sourceEncounterId: ELSEWHERE, correctionReason: "wrong_visit" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("WOUND_NOT_IN_NOTE");
    });

    /** A reader whose note is open when asked first (the check) and closed on every later ask (the recheck after the commit). */
    const closesAfterTheCheck = (closed: EncounterDraftFacts["status"]) => {
      let asked = 0;
      const reader: EncounterDraftReader = {
        draftOf: async () => ({ ...OPEN_VISIT, status: asked++ === 0 ? "draft" : closed }),
      };
      return { reader, asks: () => asked };
    };

    it.each(["finalized", "voided"] as const)(
      "takes an observation out of a note that was %s while it was being saved: a wrong_visit correction with no visit, returned as such",
      async (closed) => {
        const { reader, asks } = closesAfterTheCheck(closed);
        const { app, backend } = makeServer({ reader });
        const woundId = (await create(app)).json().id as string;
        const res = await observe(app, woundId, { sourceEncounterId: ENCOUNTER, painScore: 2 });
        // Committed, not refused after the fact: the answer is honest about where the observation ended up.
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({
          sourceEncounterId: null,
          painScore: 2,
          correctionReason: "wrong_visit",
          status: "active",
        });
        expect(asks()).toBe(2);
        const stored = backend.observations();
        expect(stored).toHaveLength(2);
        expect(stored.find((o) => o.status === "superseded")).toMatchObject({
          sourceEncounterId: ENCOUNTER,
          version: 2,
        });
        // The note reads only current observations: nothing of it is left on the closed visit.
        expect(
          await backend.provider.listObservationsForEncounter(ORG, ENCOUNTER, { userId: "rn_1" }),
        ).toEqual([]);
      },
    );

    it("leaves an observation tied to a note that is still open exactly as recorded", async () => {
      const { app, backend } = makeServer();
      const woundId = (await create(app)).json().id as string;
      const res = await observe(app, woundId, { sourceEncounterId: ENCOUNTER });
      expect(res.json().sourceEncounterId).toBe(ENCOUNTER);
      expect(backend.observations()).toHaveLength(1);
    });

    it("rechecks a correction that moved the observation onto a visit, and not one that kept its visit", async () => {
      // Keeping the visit asks nobody (the note may already be closed): only the first recording asked M8.
      const asked: string[] = [];
      const counting = makeServer({
        reader: {
          draftOf: async ({ encounterId }) => {
            asked.push(encounterId);
            return OPEN_VISIT;
          },
        },
      });
      const woundId = (await create(counting.app)).json().id as string;
      const original = (
        await observe(counting.app, woundId, { sourceEncounterId: ENCOUNTER })
      ).json();
      expect(asked).toEqual([ENCOUNTER, ENCOUNTER]); // the check, and the recheck after the commit
      const kept = await counting.app.inject({
        method: "POST",
        url: `${woundsUrl()}/${woundId}/observations/${original.id}/corrections`,
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: {
          sourceEncounterId: ENCOUNTER,
          painScore: 1,
          correctionReason: "assessment_error",
        },
      });
      expect(kept.json().sourceEncounterId).toBe(ENCOUNTER);
      expect(asked).toHaveLength(2);
      // Moving it onto a visit does ask, and the note closing in the gap un-tags the result.
      const { reader, asks } = closesAfterTheCheck("finalized");
      const scripted = makeServer({ reader });
      const wound2 = (await create(scripted.app)).json().id as string;
      const first = (await observe(scripted.app, wound2, {})).json();
      const moved = await scripted.app.inject({
        method: "POST",
        url: `${woundsUrl()}/${wound2}/observations/${first.id}/corrections`,
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: { sourceEncounterId: ENCOUNTER, correctionReason: "wrong_visit" },
      });
      expect(moved.statusCode).toBe(201);
      expect(moved.json().sourceEncounterId).toBeNull();
      expect(asks()).toBe(2);
    });

    it("answers a missing observation with its own 404 before it asks about the visit, as the Drizzle service does", async () => {
      const { app } = makeServer({ visits: {} });
      const woundId = (await create(app)).json().id as string;
      const res = await app.inject({
        method: "POST",
        url: `${woundsUrl()}/${woundId}/observations/${"99999999-9999-4999-8999-999999999999"}/corrections`,
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: { sourceEncounterId: ENCOUNTER, correctionReason: "wrong_visit" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toContain("wound observation");
    });

    it("stores an observed instant as UTC whatever offset the client sent, like the database does", async () => {
      const { app } = makeServer();
      const woundId = (await create(app)).json().id as string;
      const res = await observe(app, woundId, { observedAt: "2026-11-19T14:00:00+02:00" });
      expect(res.statusCode).toBe(201);
      expect(res.json().observedAt).toBe("2026-11-19T12:00:00.000Z");
    });

    it("does not ask for a visit when the observation names none", async () => {
      const { app } = makeServer({ visits: {} });
      const woundId = (await create(app)).json().id as string;
      expect((await observe(app, woundId, { stage: "stage_2" })).statusCode).toBe(201);
      expect((await observe(app, woundId, { sourceEncounterId: null })).statusCode).toBe(201);
    });

    it("refuses to move a corrected observation onto a visit that is not the caller's open note", async () => {
      const { app, backend } = makeServer({ visits: { [ENCOUNTER]: OPEN_VISIT } });
      const woundId = (await create(app)).json().id as string;
      const original = (await observe(app, woundId, { sourceEncounterId: ENCOUNTER })).json();
      const res = await app.inject({
        method: "POST",
        url: `${woundsUrl()}/${woundId}/observations/${original.id}/corrections`,
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: { sourceEncounterId: ELSEWHERE, correctionReason: "wrong_visit" },
      });
      expect(res.statusCode).toBe(404);
      expect(backend.observations().map((o) => o.status)).toEqual(["active"]);
    });
  });

  it("dates an observation now when the caller gives no time, and takes an empty one", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    const res = await observe(app, woundId, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().observedAt).toBe(NOW.toISOString());
    expect(res.json().woundBed).toEqual([]);
    expect(res.json().lengthCm).toBeNull();
  });

  it("refuses an observation on a wound that is already resolved", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    await app.inject({
      method: "POST",
      url: `${woundsUrl()}/${woundId}/resolve`,
      headers: RN,
      payload: { status: "healed" },
    });
    const res = await observe(app, woundId, { painScore: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("WOUND_NOT_OPEN");
  });
});

describe("wound routes: correction (append-only, If-Match)", () => {
  const correctionUrl = (woundId: string, observationId: string) =>
    `${woundsUrl()}/${woundId}/observations/${observationId}/corrections`;
  const setup = async () => {
    const { app, backend } = makeServer();
    const woundId = (await create(app)).json().id as string;
    const original = (
      await observe(app, woundId, {
        observedAt: "2026-11-18T10:00:00.000Z",
        lengthCm: 5,
        widthCm: 2,
        stage: "stage_2",
      })
    ).json();
    return { app, backend, woundId, original };
  };

  it("appends a superseding observation and leaves the original's values untouched", async () => {
    // Arrange
    const { app, backend, woundId, original } = await setup();
    // Act
    const res = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "1" }),
      payload: {
        lengthCm: 4.5,
        widthCm: 2,
        stage: "stage_2",
        correctionReason: "measurement_error",
      },
    });
    // Assert
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      correctsObservationId: original.id,
      correctionReason: "measurement_error",
      lengthCm: 4.5,
      observedAt: "2026-11-18T10:00:00.000Z",
      status: "active",
      version: 1,
    });
    const stored = backend.observations().find((o) => o.id === original.id);
    expect(stored).toMatchObject({ status: "superseded", version: 2, lengthCm: 5 });
  });

  describe("the visit a corrected observation stays tied to", () => {
    const tagged = async (visits?: Readonly<Record<string, EncounterDraftFacts>>) => {
      const { app, backend } = makeServer(visits ? { visits } : {});
      const woundId = (await create(app)).json().id as string;
      const original = (await observe(app, woundId, { sourceEncounterId: ENCOUNTER })).json();
      const correct = (payload: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: correctionUrl(woundId, original.id),
          headers: withKey({ ...RN, "if-match": "1" }),
          payload: { correctionReason: "wrong_visit", ...payload },
        });
      return { backend, correct, original };
    };

    it("takes the observation out of the note on an explicit null", async () => {
      const { correct, backend } = await tagged();
      const res = await correct({ sourceEncounterId: null });
      expect(res.statusCode).toBe(201);
      expect(res.json().sourceEncounterId).toBeNull();
      expect(backend.observations().filter((o) => o.sourceEncounterId === ENCOUNTER)).toEqual([
        expect.objectContaining({ status: "superseded" }),
      ]);
    });

    it("keeps the visit when the correction says nothing about it", async () => {
      const { correct } = await tagged();
      const res = await correct({ lengthCm: 2, widthCm: 2 });
      expect(res.statusCode).toBe(201);
      expect(res.json().sourceEncounterId).toBe(ENCOUNTER);
    });

    it("keeps the visit after the note is closed, even when the correction restates it", async () => {
      const visits: Record<string, EncounterDraftFacts> = { [ENCOUNTER]: OPEN_VISIT };
      const { correct } = await tagged(visits);
      visits[ENCOUNTER] = { ...OPEN_VISIT, status: "finalized" };
      const res = await correct({ sourceEncounterId: ENCOUNTER });
      expect(res.statusCode).toBe(201);
      expect(res.json().sourceEncounterId).toBe(ENCOUNTER);
    });
  });

  it("shows only the current observation by default, and the corrected one too on request", async () => {
    const { app, woundId, original } = await setup();
    const correction = (
      await app.inject({
        method: "POST",
        url: correctionUrl(woundId, original.id),
        headers: withKey({ ...RN, "if-match": "1" }),
        payload: { lengthCm: 4.5, widthCm: 2, correctionReason: "assessment_error" },
      })
    ).json();
    const current = (
      await app.inject({ method: "GET", url: `${woundsUrl()}/${woundId}`, headers: RN })
    ).json();
    const withHistory = (
      await app.inject({
        method: "GET",
        url: `${woundsUrl()}/${woundId}?includeSuperseded=true`,
        headers: RN,
      })
    ).json();
    expect(current.observations.map((o: { id: string }) => o.id)).toEqual([correction.id]);
    expect(withHistory.observations.map((o: { id: string }) => o.id).sort()).toEqual(
      [correction.id, original.id].sort(),
    );
  });

  it("is a 409 STALE_VERSION on a stale If-Match, and a 428 without one", async () => {
    const { app, woundId, original } = await setup();
    const stale = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "9" }),
      payload: { correctionReason: "wrong_visit" },
    });
    const missing = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey(RN),
      payload: { correctionReason: "wrong_visit" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_VERSION");
    expect(missing.statusCode).toBe(428);
  });

  it("will not correct an observation that was already corrected", async () => {
    const { app, woundId, original } = await setup();
    const headers = { ...RN, "if-match": "1" };
    await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey(headers),
      payload: { correctionReason: "other" },
    });
    const again = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "2" }),
      payload: { correctionReason: "other" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("CORRECTION_TARGET_NOT_ACTIVE");
  });

  it("applies the same rules to the correcting values", async () => {
    const { app, woundId, original } = await setup();
    const res = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "1" }),
      payload: { depthCm: 1, correctionReason: "measurement_error" },
    });
    expect(res.json().error.code).toBe("WOUND_DEPTH_REQUIRES_AREA");
  });

  it("needs a coded reason, and the amend key", async () => {
    const { app, woundId, original } = await setup();
    const noReason = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "1" }),
      payload: {},
    });
    const free = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...RN, "if-match": "1" }),
      payload: { correctionReason: "I mistyped the number" },
    });
    const noKey = await app.inject({
      method: "POST",
      url: correctionUrl(woundId, original.id),
      headers: withKey({ ...VIEWER, "if-match": "1" }),
      payload: { correctionReason: "other" },
    });
    expect([noReason.statusCode, free.statusCode, noKey.statusCode]).toEqual([422, 422, 403]);
  });

  it("is a 404 for an observation of another wound", async () => {
    const { app, original } = await setup();
    const otherWound = (
      await create(app, { siteCode: "knee", laterality: "left", etiology: "surgical" })
    ).json().id as string;
    const res = await app.inject({
      method: "POST",
      url: correctionUrl(otherWound, original.id),
      headers: withKey({ ...RN, "if-match": "1" }),
      payload: { correctionReason: "entered_on_wrong_wound" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("wound routes: resolve", () => {
  const resolve = (app: FastifyInstance, woundId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${woundsUrl()}/${woundId}/resolve`, headers: RN, payload });

  it("closes a wound as healed, dated today by default", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    const res = await resolve(app, woundId, { status: "healed" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: woundId, status: "healed", closedOn: "2026-11-19" });
  });

  it("closes a wound as resolved for another reason on a chosen date", async () => {
    const { app } = makeServer();
    const woundId = (await create(app, { ...heel, onsetOn: "2026-10-01" })).json().id as string;
    const res = await resolve(app, woundId, { status: "resolved_other", closedOn: "2026-11-10" });
    expect(res.json()).toMatchObject({ status: "resolved_other", closedOn: "2026-11-10" });
  });

  it("is one-way: a second resolve is a 409, and open is not a resolution", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    await resolve(app, woundId, { status: "healed" });
    expect((await resolve(app, woundId, { status: "resolved_other" })).json().error.code).toBe(
      "WOUND_NOT_OPEN",
    );
    const other = (await create(app)).json().id as string;
    expect((await resolve(app, other, { status: "open" })).statusCode).toBe(422);
  });

  it("refuses a close date before the onset or in the future", async () => {
    const { app } = makeServer();
    const woundId = (await create(app, { ...heel, onsetOn: "2026-10-01" })).json().id as string;
    const before = await resolve(app, woundId, { status: "healed", closedOn: "2026-09-01" });
    const after = await resolve(app, woundId, { status: "healed", closedOn: "2026-12-01" });
    expect(before.json().error.code).toBe("WOUND_CLOSED_BEFORE_ONSET");
    expect(after.json().error.code).toBe("WOUND_CLOSE_IN_FUTURE");
  });
});

describe("wound routes: isolation", () => {
  it("never shows one organisation's wounds to another", async () => {
    const { app } = makeServer();
    const woundId = (await create(app)).json().id as string;
    const asOrgB = as("rn_1", ORG_B);
    const list = await app.inject({ method: "GET", url: woundsUrl(), headers: asOrgB });
    const detail = await app.inject({
      method: "GET",
      url: `${woundsUrl()}/${woundId}`,
      headers: asOrgB,
    });
    const write = await observe(app, woundId, { painScore: 2 }, asOrgB);
    expect(list.json()).toEqual({ wounds: [] });
    expect(detail.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
  });

  it("never shows one patient's wounds on another patient's chart", async () => {
    const { app } = makeServer();
    await create(app);
    const list = await app.inject({ method: "GET", url: woundsUrl(OTHER_PATIENT), headers: RN });
    expect(list.json()).toEqual({ wounds: [] });
  });
});
