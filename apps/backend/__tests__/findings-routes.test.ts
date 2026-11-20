// WF09 — the findings routes (ADLs, nutrition, weight history) through the FULL M1 middleware chain via Fastify `inject`, no live
// infra: the REAL Authorization Contract gates every route (`encounter.read` / `vitals.author`), the M8-owned `encounter.scope` and
// `is_author_or_supervisor` predicates run over the in-memory dataset, and the read-audit coverage hook refuses a GET that omits
// its `config.auditRead`.
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  ADL_DEVICES,
  ADL_ITEMS,
  ADL_LEVELS,
  APPETITE_LEVELS,
  CONTINENCE_LEVELS,
  FLUID_INTAKE_LEVELS,
  NUTRITION_SUPPORTS,
  SWALLOWING_LEVELS,
} from "@chartwarden/hearthnote";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type FindingsEncounterSeed,
  createInMemoryFindingsBackend,
  registerFindingsRoutes,
} from "../src/modules/08-encounters/findings/index";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ENC = "a0000000-0000-4000-8000-000000000001";
const ENC_PRIOR = "a0000000-0000-4000-8000-000000000002";
const ENC_ORG_B = "b0000000-0000-4000-8000-000000000003";
const MISSING = "c0000000-0000-4000-8000-000000000009";

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ["encounter.read", "vitals.author"] },
  { userId: "rn_2", permissions: ["encounter.read", "vitals.author"] },
  { userId: "sup_1", permissions: ["encounter.read", "vitals.author"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
  { userId: "nobody_1", permissions: [] },
];

const SEED: readonly FindingsEncounterSeed[] = [
  {
    id: ENC,
    organizationId: ORG,
    patientId: PATIENT,
    status: "draft",
    serviceDate: "2026-03-10",
    authoredByMembershipId: "rn_1",
    weights: [{ weight: "150.5", weightUnit: "lb" }],
  },
  {
    id: ENC_PRIOR,
    organizationId: ORG,
    patientId: PATIENT,
    status: "signed",
    serviceDate: "2026-03-03",
    authoredByMembershipId: "rn_1",
    weights: [{ weight: "152", weightUnit: "lb" }],
  },
  {
    id: ENC_ORG_B,
    organizationId: ORG_B,
    patientId: PATIENT,
    status: "draft",
    serviceDate: "2026-03-10",
    authoredByMembershipId: "rn_1",
  },
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
  const kind = request.headers["x-test-actor-kind"];
  request.context.attributes.actorKind = typeof kind === "string" ? kind : "user";
}

function makeServer(
  options: { inCaseload?: boolean; extraSeed?: readonly FindingsEncounterSeed[] } = {},
) {
  const backend = createInMemoryFindingsBackend(
    [...SEED, ...(options.extraSeed ?? [])],
    () => new Date("2026-03-10T15:00:00Z"),
  );
  const grants = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ),
  );
  registerEffectivePermissionResolver(grants.store);
  resetAbacRegistry();
  const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
  const predicates = buildEncounterAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => options.inCaseload ?? true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerFindingsRoutes(app, { service: backend.service });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const RN_NOT_AUTHOR = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "rn" };
const SUPERVISOR = {
  "x-test-user": "sup_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_supervisor",
};
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const NOBODY = { "x-test-user": "nobody_1", "x-test-org": ORG, "x-test-roles": "rn" };

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

const url = (kind: "adl" | "nutrition" | "weight-history", id = ENC) =>
  `/api/v1/encounters/${id}/${kind}`;
const bodyOf = (res: { body: string }) => JSON.parse(res.body);

const GOOD_ADL = {
  items: { bathing: "limited_assist", dressing: "supervision", eating: "independent" },
  bladder: "occasionally_incontinent",
  bowel: "continent",
  devices: ["walker", "hospital_bed"],
};
const GOOD_NUTRITION = {
  appetite: "poor",
  mealIntakePercent: 25,
  fluidIntake: "decreased",
  swallowing: "difficulty_solids",
  support: "oral_supplements",
};

describe.each([
  ["adl", GOOD_ADL],
  ["nutrition", GOOD_NUTRITION],
] as const)("findings route /%s", (kind, good) => {
  it("answers 401 without a session", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: url(kind) })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: url(kind), payload: good })).statusCode).toBe(
      401,
    );
  });

  it("answers 403 to a caller without the permission", async () => {
    const { app } = makeServer();
    const read = await app.inject({ method: "GET", url: url(kind), headers: NOBODY });
    const write = await app.inject({
      method: "PUT",
      url: url(kind),
      headers: VIEWER,
      payload: good,
    });
    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
  });

  it("lets a reader without vitals.author read but not write", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: url(kind), headers: VIEWER })).statusCode).toBe(
      200,
    );
  });

  it("answers 404 outside the caller's caseload, for a read and a write", async () => {
    const { app } = makeServer({ inCaseload: false });
    const read = await app.inject({ method: "GET", url: url(kind), headers: RN });
    const write = await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: good });
    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
  });

  it("answers 404 for another tenant's encounter and for one that does not exist", async () => {
    const { app } = makeServer();
    const other = await app.inject({ method: "GET", url: url(kind, ENC_ORG_B), headers: RN });
    const missing = await app.inject({
      method: "PUT",
      url: url(kind, MISSING),
      headers: RN,
      payload: good,
    });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it("answers 422 to a malformed encounter id before any scope lookup", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: url(kind, "not-a-uuid"), headers: RN });
    expect(res.statusCode).toBe(422);
  });

  it("answers 403 to an author-only write by someone who is neither author nor supervisor", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: url(kind),
      headers: RN_NOT_AUTHOR,
      payload: good,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets a supervisor write a note they did not author", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: url(kind),
      headers: SUPERVISOR,
      payload: good,
    });
    expect(res.statusCode).toBe(200);
  });

  it("reads null before anything was recorded", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toBeNull();
  });

  it("stores the record and reads it back", async () => {
    const { app } = makeServer();
    const put = await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: good });
    const get = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(put.statusCode).toBe(200);
    expect(bodyOf(get)).toMatchObject({ encounterId: ENC, ...good });
    expect(bodyOf(put)).toEqual(bodyOf(get));
  });

  it("refuses a write with 409 IMMUTABLE_AFTER_SIGN once the encounter is signed, but still reads", async () => {
    const { app, backend } = makeServer();
    await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: good });
    backend.setStatus(ENC, "signed");
    const write = await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: {} });
    const read = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(write.statusCode).toBe(409);
    expect(bodyOf(write).error.code).toBe("IMMUTABLE_AFTER_SIGN");
    expect(read.statusCode).toBe(200);
    expect(bodyOf(read)).toMatchObject(good);
  });

  it("refuses a write with 409 NOTE_PINNED_AT_FINALIZE once the encounter is finalized: the note text is pinned, a later record would disagree with it", async () => {
    const { app, backend } = makeServer();
    await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: good });
    backend.setStatus(ENC, "finalized");
    const write = await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: {} });
    const read = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(write.statusCode).toBe(409);
    expect(bodyOf(write).error.code).toBe("NOTE_PINNED_AT_FINALIZE");
    expect(bodyOf(read)).toMatchObject(good); // untouched, and still readable
  });

  it("refuses an AI principal with 403 and records nothing", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: url(kind),
      headers: { ...RN, "x-test-actor-kind": "ai_agent" },
      payload: good,
    });
    expect(res.statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(bodyOf(read)).toBeNull();
  });

  it("answers the record's patient and version (also as the ETag header), 0 when nothing is recorded", async () => {
    const { app } = makeServer();
    const empty = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(empty.headers.etag).toBe('"0"');
    const put = await app.inject({ method: "PUT", url: url(kind), headers: RN, payload: good });
    const view = bodyOf(put);
    expect(view.patientId).toBe(PATIENT);
    expect(view.version).toBeGreaterThan(0);
    expect(put.headers.etag).toBe(`"${view.version}"`);
    const get = await app.inject({ method: "GET", url: url(kind), headers: RN });
    expect(get.headers.etag).toBe(`"${view.version}"`);
  });

  it("takes an OPTIONAL If-Match: a stale version is 409 STALE_VERSION and writes nothing, the current one and none at all succeed", async () => {
    const { app } = makeServer();
    const put = (payload: object, ifMatch?: string) =>
      app.inject({
        method: "PUT",
        url: url(kind),
        headers: ifMatch === undefined ? RN : { ...RN, "if-match": ifMatch },
        payload,
      });
    const first = await put(good, "0"); // "no record yet" is version 0
    expect(first.statusCode).toBe(200);
    const v1 = bodyOf(first).version as number;
    // The current version with an UNCHANGED body is a no-op: it succeeds and the version stays.
    const noop = await put(good, `"${v1}"`); // quoted, as fetch and caches send it
    expect(noop.statusCode).toBe(200);
    expect(bodyOf(noop).version).toBe(v1);
    const second = await put({}, String(v1)); // a CHANGED body (cleared) on the current version replaces the record
    expect(second.statusCode).toBe(200);
    const v2 = bodyOf(second).version as number;
    expect(v2).toBeGreaterThan(v1); // moves on even though the test clock is frozen

    const stale = await put(good, String(v1));
    expect(stale.statusCode).toBe(409);
    expect(bodyOf(stale).error.code).toBe("STALE_VERSION");
    expect((await put(good, "0")).statusCode).toBe(409); // a record now exists
    expect((await put(good, "abc")).statusCode).toBe(400);
    const unchanged = bodyOf(await app.inject({ method: "GET", url: url(kind), headers: RN }));
    expect(unchanged.version).toBe(v2); // nothing the refused writes sent was stored
    expect(unchanged.updatedAt).toBe(bodyOf(second).updatedAt);
    expect((await put(good)).statusCode).toBe(200); // no header: as before
  });
});

describe("the note template decides whether a record can be taken", () => {
  const SLP = "a0000000-0000-4000-8000-0000000000a1";
  const PT = "a0000000-0000-4000-8000-0000000000a2";
  const extraSeed: readonly FindingsEncounterSeed[] = [
    {
      id: SLP,
      organizationId: ORG,
      patientId: "11111111-1111-4111-8111-1111111111a1",
      status: "draft",
      encounterType: "slp_visit",
      discipline: "slp",
      serviceDate: "2026-03-10",
      authoredByMembershipId: "rn_1",
    },
    {
      id: PT,
      organizationId: ORG,
      patientId: "11111111-1111-4111-8111-1111111111a2",
      status: "draft",
      encounterType: "pt_visit",
      discipline: "pt",
      serviceDate: "2026-03-10",
      authoredByMembershipId: "rn_1",
    },
  ];

  it("refuses ADLs on a note whose template has no ADL section (422 FINDING_NOT_IN_NOTE), and takes nutrition there", async () => {
    const { app } = makeServer({ extraSeed });
    const adl = await app.inject({
      method: "PUT",
      url: url("adl", SLP),
      headers: RN,
      payload: GOOD_ADL,
    });
    expect(adl.statusCode).toBe(422);
    expect(bodyOf(adl).error.code).toBe("FINDING_NOT_IN_NOTE");
    expect(
      bodyOf(await app.inject({ method: "GET", url: url("adl", SLP), headers: RN })),
    ).toBeNull();
    const nutrition = await app.inject({
      method: "PUT",
      url: url("nutrition", SLP),
      headers: RN,
      payload: GOOD_NUTRITION,
    });
    expect(nutrition.statusCode).toBe(200);
  });

  it("refuses nutrition on a note whose template has no nutrition section, and takes ADLs there", async () => {
    const { app } = makeServer({ extraSeed });
    const nutrition = await app.inject({
      method: "PUT",
      url: url("nutrition", PT),
      headers: RN,
      payload: GOOD_NUTRITION,
    });
    expect(nutrition.statusCode).toBe(422);
    expect(bodyOf(nutrition).error.code).toBe("FINDING_NOT_IN_NOTE");
    const adl = await app.inject({
      method: "PUT",
      url: url("adl", PT),
      headers: RN,
      payload: GOOD_ADL,
    });
    expect(adl.statusCode).toBe(200);
  });
});

describe("ADL PUT", () => {
  it("replaces the whole record: what the second body omits is cleared", async () => {
    // Arrange
    const { app } = makeServer();
    await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload: GOOD_ADL });

    // Act
    await app.inject({
      method: "PUT",
      url: url("adl"),
      headers: RN,
      payload: { items: { bathing: "total_dependence" }, devices: ["cane"] },
    });
    const read = bodyOf(await app.inject({ method: "GET", url: url("adl"), headers: RN }));

    // Assert
    expect(read.items).toEqual({ bathing: "total_dependence" });
    expect(read.bladder).toBeNull();
    expect(read.bowel).toBeNull();
    expect(read.devices).toEqual(["cane"]);
  });

  it("is idempotent: the same body twice reads back the same record", async () => {
    const { app } = makeServer();
    const first = bodyOf(
      await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload: GOOD_ADL }),
    );
    const second = bodyOf(
      await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload: GOOD_ADL }),
    );
    expect(second).toEqual(first);
  });

  it("a PUT whose body equals the stored record is a no-op: the version and updatedAt do not move, a changed one does", async () => {
    const { app } = makeServer();
    const put = async (payload: object) =>
      bodyOf(await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload }));
    const first = await put(GOOD_ADL);
    const again = await put({ ...GOOD_ADL, devices: [...GOOD_ADL.devices].reverse() }); // the same set, sent in another order
    expect(again.version).toBe(first.version);
    expect(again.updatedAt).toBe(first.updatedAt);
    const changed = await put({ ...GOOD_ADL, bladder: "continent" });
    expect(changed.version).toBeGreaterThan(first.version);
  });

  it("answers 422 to a PUT with no body: a replace-whole write must say what it stores", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "PUT", url: url("adl"), headers: RN });
    expect(res.statusCode).toBe(422);
  });

  it("stores an empty body as a cleared record, not as no record", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload: {} });
    expect(bodyOf(res)).toMatchObject({
      encounterId: ENC,
      items: {},
      bladder: null,
      bowel: null,
      devices: [],
    });
  });

  it("accepts every documented value", async () => {
    const { app } = makeServer();
    for (const item of ADL_ITEMS)
      for (const level of ADL_LEVELS) {
        const res = await app.inject({
          method: "PUT",
          url: url("adl"),
          headers: RN,
          payload: { items: { [item]: level } },
        });
        expect(res.statusCode).toBe(200);
      }
    for (const level of CONTINENCE_LEVELS) {
      const res = await app.inject({
        method: "PUT",
        url: url("adl"),
        headers: RN,
        payload: { bladder: level, bowel: level, devices: [...ADL_DEVICES] },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it.each([
    ["an unknown level", { items: { bathing: "mostly" } }],
    ["an unknown item", { items: { swimming: "independent" } }],
    ["a continence value on an item", { items: { dressing: "continent" } }],
    ["an unknown bladder level", { bladder: "independent" }],
    ["an unknown bowel level", { bowel: "leaky" }],
    ["an unknown device", { devices: ["cane", "jetpack"] }],
    ["devices that are not an array", { devices: "cane" }],
    ["an unknown top-level field", { mobility: "good" }],
    ["items that are not an object", { items: "bathing" }],
  ])("answers 422 to %s and stores nothing", async (_name, payload) => {
    const { app } = makeServer();
    const res = await app.inject({ method: "PUT", url: url("adl"), headers: RN, payload });
    expect(res.statusCode).toBe(422);
    expect(bodyOf(res).error.code).toBe("VALIDATION_FAILED");
    const read = await app.inject({ method: "GET", url: url("adl"), headers: RN });
    expect(bodyOf(read)).toBeNull();
  });
});

describe("nutrition PUT", () => {
  it("replaces the whole record: what the second body omits is cleared", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "PUT",
      url: url("nutrition"),
      headers: RN,
      payload: GOOD_NUTRITION,
    });
    await app.inject({
      method: "PUT",
      url: url("nutrition"),
      headers: RN,
      payload: { appetite: "good" },
    });
    const read = bodyOf(await app.inject({ method: "GET", url: url("nutrition"), headers: RN }));
    expect(read).toMatchObject({
      appetite: "good",
      mealIntakePercent: null,
      fluidIntake: null,
      swallowing: null,
      support: null,
    });
  });

  it("keeps a recorded 0 percent distinct from not assessed", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: url("nutrition"),
      headers: RN,
      payload: { mealIntakePercent: 0 },
    });
    expect(bodyOf(res).mealIntakePercent).toBe(0);
  });

  it("accepts every documented value and the 0 and 100 percent edges", async () => {
    const { app } = makeServer();
    const sets: [string, readonly string[]][] = [
      ["appetite", APPETITE_LEVELS],
      ["fluidIntake", FLUID_INTAKE_LEVELS],
      ["swallowing", SWALLOWING_LEVELS],
      ["support", NUTRITION_SUPPORTS],
    ];
    for (const [field, values] of sets)
      for (const value of values) {
        const res = await app.inject({
          method: "PUT",
          url: url("nutrition"),
          headers: RN,
          payload: { [field]: value },
        });
        expect(res.statusCode).toBe(200);
      }
    for (const percent of [0, 100]) {
      const res = await app.inject({
        method: "PUT",
        url: url("nutrition"),
        headers: RN,
        payload: { mealIntakePercent: percent },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it.each([
    ["an unknown appetite", { appetite: "ravenous" }],
    ["an unknown fluid intake", { fluidIntake: "flood" }],
    ["an unknown swallowing level", { swallowing: "fine" }],
    ["an unknown support", { support: "magic" }],
    ["a percent over 100", { mealIntakePercent: 101 }],
    ["a negative percent", { mealIntakePercent: -1 }],
    ["a fractional percent", { mealIntakePercent: 12.5 }],
    ["a non-numeric percent", { mealIntakePercent: "half" }],
    ["an unknown field", { hydration: "ok" }],
  ])("answers 422 to %s and stores nothing", async (_name, payload) => {
    const { app } = makeServer();
    const res = await app.inject({ method: "PUT", url: url("nutrition"), headers: RN, payload });
    expect(res.statusCode).toBe(422);
    expect(bodyOf(res).error.code).toBe("VALIDATION_FAILED");
    const read = await app.inject({ method: "GET", url: url("nutrition"), headers: RN });
    expect(bodyOf(read)).toBeNull();
  });
});

describe("GET /weight-history", () => {
  it("answers 401 without a session and 403 without encounter.read", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: url("weight-history") })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: url("weight-history"), headers: NOBODY })).statusCode,
    ).toBe(403);
  });

  it("answers 404 outside the caseload and for another tenant's encounter", async () => {
    const out = makeServer({ inCaseload: false });
    expect(
      (await out.app.inject({ method: "GET", url: url("weight-history"), headers: RN })).statusCode,
    ).toBe(404);
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: url("weight-history", ENC_ORG_B), headers: RN }))
        .statusCode,
    ).toBe(404);
  });

  it("returns this visit's weight, the previous visit's and the history", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: url("weight-history"), headers: RN });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      patientId: PATIENT,
      weightUnitMissing: false,
      current: { value: "150.5", unit: "lb", on: "2026-03-10" },
      prior: { value: "152", unit: "lb", on: "2026-03-03" },
      history: [
        { value: "150.5", unit: "lb", on: "2026-03-10" },
        { value: "152", unit: "lb", on: "2026-03-03" },
      ],
    });
  });

  it("reports a legacy weight with no unit instead of silently dropping it: weightUnitMissing, and it is left out of the history", async () => {
    const UNITLESS = "a0000000-0000-4000-8000-0000000000d1";
    const { app } = makeServer({
      extraSeed: [
        {
          id: UNITLESS,
          organizationId: ORG,
          patientId: PATIENT,
          status: "draft",
          serviceDate: "2026-03-11",
          authoredByMembershipId: "rn_1",
          weights: [{ weight: "149", weightUnit: null }],
        },
      ],
    });
    const res = bodyOf(
      await app.inject({ method: "GET", url: url("weight-history", UNITLESS), headers: RN }),
    );
    expect(res.weightUnitMissing).toBe(true);
    expect(res.current).toBeNull();
    // the unit-less weight is not a reading: the prior is the last SIGNED visit's weight
    expect(res.prior).toEqual({ value: "152", unit: "lb", on: "2026-03-03" });
  });

  it("has no prior for the patient's first visit", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: url("weight-history", ENC_PRIOR),
      headers: RN,
    });
    expect(bodyOf(res)).toMatchObject({ prior: null, current: { value: "152" } });
  });

  it("counts only SIGNED earlier visits: another clinician's draft or finalized weight is never the prior, a void one never happened", async () => {
    const earlier = (
      id: string,
      status: FindingsEncounterSeed["status"],
      day: string,
      lb: string,
    ) =>
      ({
        id,
        organizationId: ORG,
        patientId: PATIENT,
        status,
        serviceDate: `2026-03-${day}`,
        authoredByMembershipId: "rn_2",
        weights: [{ weight: lb, weightUnit: "lb" }],
      }) satisfies FindingsEncounterSeed;
    const { app } = makeServer({
      extraSeed: [
        earlier("a0000000-0000-4000-8000-0000000000b1", "draft", "09", "140"),
        earlier("a0000000-0000-4000-8000-0000000000b2", "finalized", "08", "141"),
        earlier("a0000000-0000-4000-8000-0000000000b3", "voided", "07", "142"),
      ],
    });
    const res = bodyOf(
      await app.inject({ method: "GET", url: url("weight-history"), headers: RN }),
    );
    expect(res.prior).toEqual({ value: "152", unit: "lb", on: "2026-03-03" });
    expect(res.history.map((r: { value: string }) => r.value)).toEqual(["150.5", "152"]);
  });

  it("counts a cosign-pending and a cosigned earlier visit, and keeps this visit's own weight whatever its draft status", async () => {
    const earlier = (
      id: string,
      status: FindingsEncounterSeed["status"],
      day: string,
      lb: string,
    ) =>
      ({
        id,
        organizationId: ORG,
        patientId: PATIENT,
        status,
        serviceDate: `2026-03-${day}`,
        authoredByMembershipId: "rn_2",
        weights: [{ weight: lb, weightUnit: "lb" }],
      }) satisfies FindingsEncounterSeed;
    const { app } = makeServer({
      extraSeed: [
        earlier("a0000000-0000-4000-8000-0000000000c1", "cosign_pending", "08", "149"),
        earlier("a0000000-0000-4000-8000-0000000000c2", "cosigned", "05", "151"),
      ],
    });
    const res = bodyOf(
      await app.inject({ method: "GET", url: url("weight-history"), headers: RN }),
    );
    expect(res.current).toEqual({ value: "150.5", unit: "lb", on: "2026-03-10" }); // this visit is a draft
    expect(res.prior).toEqual({ value: "149", unit: "lb", on: "2026-03-08" });
    expect(res.history.map((r: { value: string }) => r.value)).toEqual([
      "150.5",
      "149",
      "151",
      "152",
    ]);
  });
});
