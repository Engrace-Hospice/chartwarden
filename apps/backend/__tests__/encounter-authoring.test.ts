// apps/backend/__tests__/encounter-authoring.test.ts — M8-T10 vitals + mileage authoring (§2.2),
// the RN routine-visit happy path (§7.1), and the MD/NP F2F dual-write with M6 (§7.4, D1).
//
// Two layers: (1) pure-machine unit tests over the authoring engines (envelope/CNI validation, BMI,
// the D10 mileage resolution, and the F2F dual-write plan + its structural abort); (2) the §7.1/§7.4
// workflow-acceptance flows driven end-to-end through the §4.1 routes via Fastify `inject` over the
// in-memory backend, asserting the published `m8.*` outbox events and the cross-module F2F attestation
// write the dual-write requests of M6.
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
import { STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildEncounterAbacPredicates,
  computeBmi,
  createInMemoryEncounterBackend,
  deriveAbnormalFlags,
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
  registerEncounterRoutes,
  resolveMiles,
} from "../src/modules/08-encounters/index";
import { requiredSectionSelections } from "./_hearthnote-fixtures";

/**
 * Document a draft to the §2.6 Layer-3 gate's floor (#121) — one selection per required template
 * section. Every §7 flow below goes through it because a clinician does: the gate refuses to finalize a
 * note with nothing in it, which is the whole point of the gate.
 */
async function document(
  app: { inject: (o: unknown) => Promise<{ statusCode: number }> },
  id: string,
  headers: Record<string, string>,
  encounterType: "routine_visit" | "face_to_face",
  discipline: "rn" | "md",
): Promise<void> {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/encounters/${id}/selections`,
    headers: { ...headers, "if-match": "0" },
    payload: requiredSectionSelections(encounterType, discipline),
  });
  if (res.statusCode !== 200) throw new Error(`documenting the draft failed: ${res.statusCode}`);
}

/** GAP-014 — see encounter-routes.test.ts's identical helper for why this reimplements step_up_recent
 *  inline over a fresh per-test registry instead of `registerAuthorizationAbacPredicates()` (which
 *  writes into the shared singleton a fresh registry bypasses). */
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

/** Assert `fn` throws an EncounterStateError carrying the given §2.7 machine code. */
function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected a throw with code ${code}`).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
}

// ── (1) pure authoring machines ──────────────────────────────────────────────────────────────────────

describe("M8-T10 — vitals authoring (§2.2)", () => {
  it("derives BMI from metric weight + height (kg/m², 1 d.p.)", () => {
    expect(computeBmi({ weight: "70", weightUnit: "kg", height: "175", heightUnit: "cm" })).toBe(
      "22.9",
    );
  });

  it("derives BMI from imperial weight + height", () => {
    // 154 lb ≈ 69.85 kg; 69 in ≈ 1.7526 m → ~22.7
    expect(computeBmi({ weight: "154", weightUnit: "lb", height: "69", heightUnit: "in" })).toBe(
      "22.7",
    );
  });

  it("returns null BMI when height or weight is absent", () => {
    expect(computeBmi({ weight: "70", weightUnit: "kg" })).toBeNull();
  });

  it("flags abnormal vitals for the m8.vitals.captured payload", () => {
    const flags = deriveAbnormalFlags({ bpSystolic: 150, spo2: 88, painScore: 8, heartRate: 110 });
    expect(flags).toEqual(
      expect.arrayContaining(["bp_systolic", "spo2", "pain_score", "heart_rate"]),
    );
  });

  it("captures the field roster + audit/outbox effects on a valid set", () => {
    const plan = planVitalsCapture({ bpSystolic: 120, bpDiastolic: 80, spo2: 98 });
    expect(plan.fieldsCaptured).toEqual(["bp_systolic", "bp_diastolic", "spo2"]);
    expect(plan.effects).toContainEqual({ kind: "outbox", event: "m8.vitals.captured" });
  });

  it("rejects an out-of-range reading (mirrors the vitals_* DB CHECK)", () => {
    expectCode(() => planVitalsCapture({ spo2: 20 }), "VITALS_OUT_OF_RANGE");
    expectCode(() => planVitalsCapture({ bpSystolic: 300 }), "VITALS_OUT_OF_RANGE");
  });

  it("requires a reason ≥ 20 chars when a CNI field list is present (§2.2)", () => {
    expectCode(
      () =>
        planVitalsCapture({
          clinicallyNotIndicatedFields: ["weight"],
          clinicallyNotIndicatedReason: "n/a",
        }),
      "VITALS_CNI_REASON_REQUIRED",
    );
    expect(() =>
      planVitalsCapture({
        clinicallyNotIndicatedFields: ["weight"],
        clinicallyNotIndicatedReason: "patient bed-bound; scale unavailable today",
      }),
    ).not.toThrow();
  });
});

describe("M8-T10 — mileage authoring (§2.2 D10)", () => {
  it("computes miles from the odometer pair", () => {
    expect(resolveMiles({ source: "odometer", odometerStart: 1000, odometerEnd: 1042 })).toBe("42");
  });

  it("uses the explicit figure for route_calc", () => {
    expect(
      resolveMiles({ source: "route_calc", milesDriven: "18.4", routeProposedMiles: "18.4" }),
    ).toBe("18.4");
  });

  it("rejects a reversed odometer pair", () => {
    expectCode(
      () => planMileageCapture({ source: "odometer", odometerStart: 1042, odometerEnd: 1000 }),
      "MILEAGE_ODOMETER_ORDER",
    );
  });

  it("requires a ≥ 20-char reason for a manual override", () => {
    expectCode(
      () =>
        planMileageCapture({
          source: "manual_override",
          milesDriven: "30",
          manualOverrideReason: "rt",
        }),
      "MILEAGE_OVERRIDE_REASON_REQUIRED",
    );
    expect(() =>
      planMileageCapture({
        source: "manual_override",
        milesDriven: "30",
        manualOverrideReason: "odometer broken; estimated from prior route",
      }),
    ).not.toThrow();
  });
});

describe("M8-T10 — F2F dual-write coordination (§7.4, D1)", () => {
  const base = {
    status: "finalized" as const,
    encounterId: "e0000000-0000-4000-8000-000000000001",
    faceToFaceEncounterId: "f0000000-0000-4000-8000-000000000009",
    discipline: "md" as const,
    gatePassed: true,
    stepUpFresh: true,
    at: "2026-06-21",
  };

  it("pairs the M8 sign with an attested M6 attestation write referencing the encounter", () => {
    const plan = planF2fDualWrite(base);
    expect(plan.encounter.to).toBe("signed");
    expect(plan.attestation).toEqual({
      kind: "create_f2f_attestation",
      encounterId: base.encounterId,
      faceToFaceEncounterId: base.faceToFaceEncounterId,
      status: "attested",
    });
  });

  it("aborts BOTH sides when the M6 id is absent (F2F_DUAL_WRITE_REQUIRED)", () => {
    expectCode(
      () => planF2fDualWrite({ ...base, faceToFaceEncounterId: null }),
      "F2F_DUAL_WRITE_REQUIRED",
    );
  });

  it("aborts BOTH sides when step-up is stale (no attestation produced)", () => {
    expectCode(() => planF2fDualWrite({ ...base, stepUpFresh: false }), "STEP_UP_AUTH_REQUIRED");
  });
});

// ── (2) §7.1 / §7.4 workflow acceptance through the routes ────────────────────────────────────────────

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const F2F_ID = "f0000000-0000-4000-8000-000000000099";

const AUTHOR_KEYS = [
  "encounter.read",
  "encounter.author",
  "encounter.finalize",
  "encounter.sign",
  "vitals.author",
  "mileage.author",
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // The sign route's requireStepUp(...) gate + signingActorOf() both read these.
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
}

function makeServer() {
  const backend = createInMemoryEncounterBackend();
  const actors = ["rn_1", "md_1"];
  const grantStore = createInMemoryEffectivePermissionStore(
    actors.map((userId) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: AUTHOR_KEYS }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  resetAbacRegistry();
  const registry = createPredicateRegistry({
    ...M3_INTRINSIC_PREDICATES,
    step_up_recent: stepUpRecentPredicate,
  });
  const predicates = buildEncounterAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  // Every seeded actor starts with a FRESH step-up (real M3 step_up_recent decision, real M2 seam) —
  // the sign route's requireStepUp(...) gate needs this to reach the route handler at all.
  __resetSeamsForTest();
  const sessions = createInMemorySessionContextStore(
    actors.map((userId) => ({
      sessionId: userId,
      userId,
      membershipId: userId,
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
  );
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, { service: backend.service });
  return { app, backend, sessions };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "md" };

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

describe("M8-T10 — §7.1 RN routine visit happy path", () => {
  it("create → vitals → mileage → care-plan link → finalize → sign → signed (+ m8.encounter.signed)", async () => {
    const { app, backend } = makeServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const vitals = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
      payload: {
        bpSystolic: 142,
        bpDiastolic: 88,
        spo2: 97,
        painScore: 2,
        weight: "70",
        weightUnit: "kg",
        height: "175",
        heightUnit: "cm",
      },
    });
    expect(vitals.statusCode).toBe(201);
    expect(vitals.json().bmi).toBe("22.9");
    expect(vitals.json().abnormalFlags).toContain("bp_systolic");

    const mileage = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/mileage`,
      headers: RN,
      payload: { source: "odometer", odometerStart: 1000, odometerEnd: 1018 },
    });
    expect(mileage.statusCode).toBe(201);
    expect(mileage.json().milesDriven).toBe("18");

    const link = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: { problemId: "22222222-2222-4222-8222-222222222222" },
    });
    expect(link.statusCode).toBe(201);

    await document(app, id, RN, "routine_visit", "rn");

    const finalize = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
    });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json().status).toBe("finalized");

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(200);
    expect(sign.json().status).toBe("signed");

    const events = backend.inspect
      .events()
      .filter((e) => e.encounterId === id)
      .map((e) => e.event);
    expect(events).toContain("m8.encounter.signed");
    expect(events).toContain("m8.vitals.captured");
    expect(events).toContain("m8.mileage.captured");
    expect(backend.inspect.vitalsCount(id)).toBe(1);
    expect(backend.inspect.mileageOf(id)?.milesDriven).toBe("18");
  });
});

describe("M8-T10 — §7.4 MD/NP F2F dual-write with M6 (D1)", () => {
  it("signs the encounter AND requests the M6 attestation in one unit", async () => {
    const { app, backend } = makeServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: MD,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "face_to_face",
        discipline: "md",
        serviceDate: "2026-06-20",
        faceToFaceEncounterId: F2F_ID,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    await document(app, id, MD, "face_to_face", "md");
    await app.inject({ method: "POST", url: `/api/v1/encounters/${id}/finalize`, headers: MD });
    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: MD,
      payload: { attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(200);
    expect(sign.json().status).toBe("signed");

    const signedEvents = backend.inspect
      .events()
      .filter((e) => e.encounterId === id)
      .map((e) => e.event);
    expect(signedEvents).toContain("m8.encounter.signed");

    const attestations = backend.inspect.f2fAttestations();
    expect(attestations).toEqual([
      {
        kind: "create_f2f_attestation",
        encounterId: id,
        faceToFaceEncounterId: F2F_ID,
        status: "attested",
      },
    ]);
  });

  it("refuses to sign an F2F encounter missing the M6 id (412) and writes no attestation", async () => {
    const { app, backend } = makeServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: MD,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "face_to_face",
        discipline: "md",
        serviceDate: "2026-06-20",
      },
    });
    const id = created.json().id as string;
    await document(app, id, MD, "face_to_face", "md");
    await app.inject({ method: "POST", url: `/api/v1/encounters/${id}/finalize`, headers: MD });

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: MD,
      payload: { attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(412);
    expect(sign.json().error.code).toBe("F2F_DUAL_WRITE_REQUIRED");
    expect(backend.inspect.f2fAttestations()).toHaveLength(0);
  });
});

// ── (3) #92 — the vitals read-back ────────────────────────────────────────────────────────────────────
//
// `POST .../vitals` wrote a real row and returned only the DERIVED facts (`vitalsId`, `fieldsCaptured`,
// `abnormalFlags`, `bmi`); the measured VALUES were readable through no caller-facing route at all —
// the encounter DTO carries none of them and there was no `GET .../vitals`. A clinician could record a
// blood pressure and never see it again, which satisfies the storage half of 42 CFR 418.104 and not
// the retrieval half. These drive the new read through the real Fastify stack, so the guard chain and
// the `config.auditRead` declaration are exercised too, not just the service method.
describe("M8 #92 — GET /encounters/:id/vitals reads back what was written", () => {
  async function seedEncounter(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  it("round-trips every captured measurement, not just the derived facts", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);

    const written = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
      payload: {
        bpSystolic: 142,
        bpDiastolic: 88,
        heartRate: 78,
        respiratoryRate: 16,
        temperature: "37.2",
        temperatureUnit: "c",
        spo2: 97,
        painScore: 2,
        painScale: "nrs_0_10",
        weight: "70",
        weightUnit: "kg",
        height: "175",
        heightUnit: "cm",
        bloodGlucose: 105,
        bloodGlucoseUnit: "mg_dl",
      },
    });
    expect(written.statusCode).toBe(201);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as {
      encounterId: string;
      vitals: Record<string, unknown>[];
    };
    expect(body.encounterId).toBe(id);
    expect(body.vitals).toHaveLength(1);
    const v = body.vitals[0] as Record<string, unknown>;
    expect(v.id).toBe(written.json().vitalsId);
    expect(v.encounterId).toBe(id);
    // The whole point of the issue: the MEASUREMENTS come back.
    expect(v.bpSystolic).toBe(142);
    expect(v.bpDiastolic).toBe(88);
    expect(v.heartRate).toBe(78);
    expect(v.respiratoryRate).toBe(16);
    expect(v.temperature).toBe("37.2");
    expect(v.temperatureUnit).toBe("c");
    expect(v.spo2).toBe(97);
    expect(v.painScore).toBe(2);
    expect(v.painScale).toBe("nrs_0_10");
    expect(v.weight).toBe("70");
    expect(v.height).toBe("175");
    expect(v.bloodGlucose).toBe(105);
    expect(typeof v.capturedAt).toBe("string");
  });

  it("re-derives abnormalFlags and carries the stored BMI, agreeing with the write result", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);
    const written = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
      payload: {
        bpSystolic: 142,
        bpDiastolic: 88,
        spo2: 97,
        weight: "70",
        weightUnit: "kg",
        height: "175",
        heightUnit: "cm",
      },
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
    });
    const v = read.json().vitals[0] as { bmi: string; abnormalFlags: string[] };
    expect(v.bmi).toBe(written.json().bmi);
    expect(v.abnormalFlags).toEqual(written.json().abnormalFlags);
    expect(v.abnormalFlags).toContain("bp_systolic");
  });

  it("distinguishes an unrecorded measurement (null) from one that was taken", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
      payload: { heartRate: 72 },
    });
    const v = (
      await app.inject({ method: "GET", url: `/api/v1/encounters/${id}/vitals`, headers: RN })
    ).json().vitals[0] as Record<string, unknown>;
    expect(v.heartRate).toBe(72);
    // Nullable, never absent: "nobody recorded an SpO2" is a clinical statement, and a missing key
    // would leave the client unable to tell it apart from a field the API forgot to send.
    expect(v).toHaveProperty("spo2", null);
    expect(v).toHaveProperty("painScore", null);
    expect(v).toHaveProperty("bmi", null);
  });

  it("returns every set on the encounter, newest capture first", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);
    for (const hr of [60, 70, 80]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/encounters/${id}/vitals`,
        headers: RN,
        payload: { heartRate: hr },
      });
    }
    const body = (
      await app.inject({ method: "GET", url: `/api/v1/encounters/${id}/vitals`, headers: RN })
    ).json() as { vitals: { id: string; capturedAt: string }[] };
    expect(body.vitals).toHaveLength(3);
    // The slice's clock is fixed, so this pins the id tiebreak rather than the timestamp ordering —
    // the live suite is what proves the capturedAt ordering against a real clock.
    const ids = body.vitals.map((x) => x.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  it("an edit corrects the values and preserves when they were taken", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);
    const written = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: RN,
      payload: { heartRate: 72 },
    });
    const vitalsId = written.json().vitalsId as string;
    const before = (
      await app.inject({ method: "GET", url: `/api/v1/encounters/${id}/vitals`, headers: RN })
    ).json().vitals[0].capturedAt as string;

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/vitals/${vitalsId}`,
      headers: { ...RN, "if-match": "0" },
      payload: { heartRate: 96 },
    });
    expect(edited.statusCode).toBe(200);

    const after = (
      await app.inject({ method: "GET", url: `/api/v1/encounters/${id}/vitals`, headers: RN })
    ).json().vitals[0] as { heartRate: number; capturedAt: string };
    expect(after.heartRate).toBe(96);
    expect(after.capturedAt).toBe(before);
  });

  it("404s for an encounter that is not the caller's, rather than returning an empty list", async () => {
    const { app } = makeServer();
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/99999999-9999-4999-8999-999999999999/vitals",
      headers: RN,
    });
    expect(read.statusCode).toBe(404);
  });

  it("requires encounter.read — a caller without it is refused", async () => {
    const { app } = makeServer();
    const id = await seedEncounter(app);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/vitals`,
      headers: { "x-test-user": "nobody_1", "x-test-org": ORG, "x-test-roles": "" },
    });
    expect(read.statusCode).toBeGreaterThanOrEqual(400);
    expect(read.statusCode).toBeLessThan(500);
  });
});
