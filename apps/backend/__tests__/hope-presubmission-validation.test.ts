// apps/backend/__tests__/hope-presubmission-validation.test.ts — F-057. The CMS HOPE pre-submission
// rule set, driven through the real §4.1 routes.
//
// `validateHopeAssessment` (@wardenx/hope) is a 268-line deterministic rule set with its own unit suite
// and, before this suite, NO caller anywhere outside that suite. `hope_validation_finding` had exactly
// one writer in the whole repo — the D8 missing-PPS warning — so `GET /hope/assessments/:id/validation`
// returned `findings: []` for every assessment ever recorded, and the HOPE Assessment Detail rail
// rendered "No findings." over an assessment that had never been checked. An empty findings list and a
// clean one are indistinguishable on screen, which is why it stayed invisible.
//
// Every case here asserts through the ROUTE, not the engine: the engine was already green. What was
// missing was the projection from the `data` jsonb to the engine's typed inputs, the M38 oracle, and a
// caller. Each assertion below returns an empty list against the pre-change service.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { HOPE_VALIDATION_RULES } from "@wardenx/hope";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildHopeAbacPredicates,
  createInMemoryHopeBackend,
  registerHopeRoutes,
} from "../src/modules/10-hope/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.providerEntityIds = ["pe_1"];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-06-08T12:00:00.000Z";

const KEYS = [
  "hope.schedule.read",
  "hope.timepoint.read",
  "hope.timepoint.write",
  "hope.timepoint.sign",
  "hope.timepoint.correct",
];

function makeServer() {
  const backend = createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    admissionPatients: { [ADMISSION]: PATIENT },
    schedules: [
      {
        id: SCHEDULE,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        rfaKind: "02_huv1",
        status: "open",
        windowOpensAt: "2026-06-06T00:00:00.000Z",
        windowClosesAt: "2026-06-20T00:00:00.000Z",
        lateDeadlineAt: "2026-06-27T00:00:00.000Z",
      },
    ],
  });
  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "rn_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);
  const registry = createPredicateRegistry();
  const predicates = buildHopeAbacPredicates({
    resolver: backend,
    isInCaseload: async () => true,
    resolveAdmissionPatient: async (_org, admissionId) =>
      admissionId === ADMISSION ? { patientId: PATIENT } : null,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, { service: backend });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };

/** Every A–Z section the comprehensive instrument requires, each carrying something. */
const COMPLETE_SECTIONS: Record<string, unknown> = {
  A: { dateOfBirth: "1948-02-11" },
  B: { hearing: "adequate" },
  C: { bims: 13 },
  D: { phq2: 1 },
  E: { behaviors: "none" },
  F: { codeStatus: "dnr" },
  G: { adlBathing: "dependent" },
  H: { continence: "occasionally_incontinent" },
  I: { primaryDiagnosisIcd10: "C34.90" },
  J: {
    J2030: { screened: "no" },
    J2050: { screened: "no" },
    J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] },
  },
  K: { swallowing: "no_impairment" },
  M: { pressureUlcers: "none" },
  N: { opioidPrescribed: false },
  O: { oxygen: true },
  Q: { participation: "patient" },
  X: { preferredPlaceOfDeath: "home" },
  Z: { completionDate: "2026-06-08" },
};

type ApiFinding = { ruleId: string; severity: string; message: string };

/** Record a timepoint, sign it, and read back the on-demand validation report. */
async function recordSignAndValidate(
  app: ReturnType<typeof makeServer>["app"],
  body: Record<string, unknown>,
): Promise<ApiFinding[]> {
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
    headers: RN,
    payload: body,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const signed = await app.inject({
    method: "POST",
    url: `/api/v1/hope/assessments/${id}/sign`,
    headers: RN,
    payload: { attestationConfirmed: true },
  });
  expect(signed.statusCode).toBe(200);
  const report = await app.inject({
    method: "GET",
    url: `/api/v1/hope/assessments/${id}/validation`,
    headers: RN,
  });
  expect(report.statusCode).toBe(200);
  return report.json().findings as ApiFinding[];
}

const admissionBody = (data: Record<string, unknown>) => ({
  rfaKind: "01_admission",
  targetDate: NOW,
  authorDiscipline: "RN",
  data,
});

const rules = (findings: ApiFinding[], ruleId: string): ApiFinding[] =>
  findings.filter((f) => f.ruleId === ruleId);

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

describe("F-057 — required-items matrix (§2.3)", () => {
  it("an Admission RFA signed with an EMPTY payload reports one blocking error per missing section", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(app, admissionBody({}));
    const missing = rules(findings, HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);
    // The comprehensive instrument is all 17 CMS-used letters. This is the case that made the defect
    // legible: an assessment carrying NONE of them used to report a clean bill of health.
    expect(missing.length).toBe(17);
    expect(missing.every((f) => f.severity === "error")).toBe(true);
  });

  it("a section present but EMPTY counts as missing — an opened tab is not a completed section", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({ ...COMPLETE_SECTIONS, M: {} }),
    );
    const missing = rules(findings, HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);
    expect(missing.map((f) => f.message)).toEqual([
      "Required Section M is missing for RFA 01_admission.",
    ]);
  });

  it("a complete comprehensive payload reports NO blocking error", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(app, admissionBody(COMPLETE_SECTIONS));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("F-057 — Section J cross-field rules (§86)", () => {
  it("J2030 screened Yes with no pain characteristics is a blocking error", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: { ...(COMPLETE_SECTIONS.J as object), J2030: { screened: "yes" } },
      }),
    );
    const f = rules(findings, HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });

  it("J2030 screened Yes WITH characteristics is clean — the rule reads the characteristics, not the screen", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: {
          ...(COMPLETE_SECTIONS.J as object),
          J2030: { screened: "yes", characteristics: { frequency: "daily" } },
        },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING)).toEqual([]);
  });

  it("J2050 screened Yes with an EMPTY characteristics object still fires — a half-filled form is the case", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: {
          ...(COMPLETE_SECTIONS.J as object),
          J2050: { screened: "yes", characteristics: {} },
        },
      }),
    );
    expect(
      rules(findings, HOPE_VALIDATION_RULES.J2050_DYSPNEA_CHARACTERISTICS_MISSING).length,
    ).toBe(1);
  });
});

describe("F-057 — Section N advisory rule (§2.3)", () => {
  it("an opioid with no bowel regimen and no documented contraindication is a WARNING, not a blocker", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({ ...COMPLETE_SECTIONS, N: { opioidPrescribed: true } }),
    );
    const f = rules(findings, HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("warning");
    expect(findings.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("a documented contraindication satisfies it without a scheduled regimen", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({
        ...COMPLETE_SECTIONS,
        N: { opioidPrescribed: true, bowelRegimenContraindication: "complete bowel obstruction" },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING)).toEqual([]);
  });
});

describe("F-057 — value-set availability (the rule that must NOT become a blocker)", () => {
  it("an unresolvable M38 value set reports 'could not be checked', never 'diagnosis invalid'", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(app, admissionBody(COMPLETE_SECTIONS));
    // M38's `hospice_terminal_diagnosis` / `hope_j_codes` ship as DEFINITIONS with no curated members
    // until the per-system loaders run, and the seam is a deny-stub here. `isMemberOf` cannot tell "not
    // a member" from "no members exist" — so a naive wiring would have made rule 2 (an ERROR) fire on
    // every assessment carrying a terminal diagnosis, which is an outage reported as a data defect.
    const unavailable = rules(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE);
    expect(unavailable.length).toBe(2); // one for Section I, one for Section J
    expect(unavailable.every((f) => f.severity === "warning")).toBe(true);
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET)).toEqual([]);
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET)).toEqual([]);
  });

  it("no diagnosis and no J-codes means nothing to check — no unavailability finding either", async () => {
    const { app } = makeServer();
    const findings = await recordSignAndValidate(
      app,
      admissionBody({
        ...COMPLETE_SECTIONS,
        I: { note: "deferred" },
        J: { J2030: { screened: "no" } },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE)).toEqual([]);
  });
});

describe("F-057 — cross-RFA temporal order (§2.3)", () => {
  it("a HUV1 dated on or before the signed Admission timepoint is a blocking error", async () => {
    const { app } = makeServer();
    // The Admission RFA is signed first, at NOW; the HUV1 then targets the SAME instant, which is not
    // strictly after it.
    await recordSignAndValidate(app, admissionBody(COMPLETE_SECTIONS));
    const findings = await recordSignAndValidate(app, {
      rfaKind: "02_huv1",
      targetDate: NOW,
      authorDiscipline: "RN",
      scheduleId: SCHEDULE,
      data: COMPLETE_SECTIONS,
    });
    const f = rules(findings, HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });

  it("a HUV1 dated after the Admission timepoint is clean", async () => {
    const { app } = makeServer();
    await recordSignAndValidate(app, {
      ...admissionBody(COMPLETE_SECTIONS),
      targetDate: "2026-06-07T12:00:00.000Z",
    });
    const findings = await recordSignAndValidate(app, {
      rfaKind: "02_huv1",
      targetDate: NOW,
      authorDiscipline: "RN",
      scheduleId: SCHEDULE,
      data: COMPLETE_SECTIONS,
    });
    expect(rules(findings, HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER)).toEqual([]);
  });
});

describe("F-057 — the report is available BEFORE the signature", () => {
  it("a DRAFT reports its findings, which is the only point at which the clinician can still act", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: admissionBody({}),
    });
    expect(created.statusCode).toBe(201);
    const report = await app.inject({
      method: "GET",
      url: `/api/v1/hope/assessments/${created.json().id}/validation`,
      headers: RN,
    });
    expect(report.statusCode).toBe(200);
    const findings = report.json().findings as ApiFinding[];
    expect(rules(findings, HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING).length).toBe(17);
  });
});

describe("F-057 — the D9 Section-Q divergence the record gate cannot see", () => {
  it("a live discharge whose Section Q is an EMPTY object passes the record gate and fails the CMS rule", async () => {
    const { app } = makeServer();
    // `assertSectionQForDischarge` (record time) asks whether the key EXISTS; the CMS rule asks whether
    // the section was COMPLETED. `{ Q: {} }` satisfies the first and not the second — an opened tab.
    const findings = await recordSignAndValidate(app, {
      rfaKind: "05_discharge",
      targetDate: NOW,
      authorDiscipline: "RN",
      dischargeReason: "live_discharge",
      data: {
        A: { dob: "1948-02-11" },
        I: { primaryDiagnosisIcd10: "C34.90" },
        J: { J2030: { screened: "no" } },
        X: { pref: "home" },
        Z: { completionDate: "2026-06-08" },
        Q: {},
      },
    });
    const f = rules(findings, HOPE_VALIDATION_RULES.SECTION_Q_REQUIRED);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });
});
