// apps/backend/__tests__/hope-routes.test.ts — M10-T06 route-inventory + §4.6 RBAC gating + §4.7
// `hope.authorDisciplineAllowed` / `hope.sfvAuthorAllowed` / `hope.correctionAuthorAllowed` ABAC + the D4
// J2051 trigger / SFV creation + §2.4 outbox emission + §4.9.1 out-of-band PHI strip (M10 spec §4.1, §4.4,
// §4.6, §4.7, §4.9) + (GAP-018) `hope.scope` caseload/provider-entity scoping.
//
// Exercises M10's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerHopeRoutes() mounts the §4.1 inventory over the in-memory HOPE
// backend. The REAL Authorization Contract gates every route on the §4.6 keys; a header-auth shim
// populates request.context (extended with `x-test-pe` — the M24 precedent — since `hope.scope`'s
// provider-entity branch reads `context.providerEntityIds`). The four predicates M10 owns are registered
// into a FRESH ABAC registry over the slice's resolver (the GAP-011 pattern — reusing the shared
// module-level `abacRegistry` would silently pin every test after the first to whatever backend the FIRST
// test's registration closed over).
import {
  abacRegistry,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import { buildOutOfBandPayload, buildTimepointWindowAlert } from "@chartwarden/hope";
import { HOPE_ATTESTATION_VERSION } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, buildServer } from "../src/bootstrap/index";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import { createRouteRateLimit } from "../src/bootstrap/plugins/route-rate-limit";
import { registerIdentitySeams } from "../src/modules/02-identity/index";
import { registerAuthorizationAbacPredicates } from "../src/modules/03-authorization/abac-predicates";
import {
  type HopeRouteDeps,
  buildHopeAbacPredicates,
  createInMemoryHopeBackend,
  registerHopeRoutes,
} from "../src/modules/10-hope/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // hope-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const pe = request.headers["x-test-pe"];
  request.context.providerEntityIds = typeof pe === "string" && pe.length > 0 ? pe.split(",") : [];
  // R-05: a fresh step-up is a header the harness maps onto the attribute `step_up_recent` reads (the
  // care-plan-routes.test.ts harness); absent = stale, so a forgotten header fails visibly.
  request.context.attributes.stepUpRecent = request.headers["x-test-step-up"] === "true";
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string") request.context.attributes.actorKind = actorKind;
  // The REAL `step_up_recent` predicate resolves recency from the session, not from a header.
  const session = request.headers["x-test-session"];
  if (typeof session === "string") request.context.attributes.sessionId = session;
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const SIGNED_A = "90000000-0000-4000-8000-000000000010";
const SUB_REJECTED = "c0000000-0000-4000-8000-000000000001";
const SUB_QUEUED = "c0000000-0000-4000-8000-000000000002";
const SUB_PACKAGED = "c0000000-0000-4000-8000-000000000003";
const SFV_SEEDED = "d0000000-0000-4000-8000-000000000001";
// R-01: a second patient/admission, and an OPEN SFV that belongs to the FIRST (PATIENT / ADMISSION).
const PATIENT_2 = "22222222-2222-4222-8222-222222222222";
const ADMISSION_2 = "44444444-4444-4444-8444-444444444444";
const TRIGGER_P1 = "90000000-0000-4000-8000-00000000ab20"; // hex letters on purpose: the case-insensitive filter test needs them
const SFV_OPEN_P1 = "d0000000-0000-4000-8000-000000000002";
// The SAME patient re-admitted (ADMISSION_2 is PATIENT's second admission), with its own open SFV.
const TRIGGER_READMIT = "90000000-0000-4000-8000-000000000030";
const SFV_READMIT = "d0000000-0000-4000-8000-000000000003";
// An SFV filed under ADMISSION but carrying ANOTHER patient (a corrupt pairing the service must not sign).
const TRIGGER_MISPAIRED = "90000000-0000-4000-8000-000000000040";
const SFV_MISPAIRED = "d0000000-0000-4000-8000-000000000004";
const NOW = "2026-06-08T12:00:00.000Z";
// The J2053 follow-up content (A-H) a completion must carry; anything less is refused.
const SFV_DATA = {
  J: {
    J2053: Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
    ),
  },
};

const READ_KEYS = ["hope.schedule.read", "hope.timepoint.read", "hope.sfv.read"];
const WRITE_KEYS = ["hope.timepoint.write", "hope.timepoint.sign", "hope.timepoint.correct"];
const SUB_KEYS = ["hope.submission.read", "hope.submission.manage", "hope.dashboard.read"];
const PERMISSION_SEED = [
  {
    userId: "rn_1",
    permissions: [
      ...READ_KEYS,
      ...WRITE_KEYS,
      "hope.schedule.skip",
      ...SUB_KEYS,
      "hope.admin.regenerate_schedules",
    ],
  },
  { userId: "np_1", permissions: [...READ_KEYS, ...WRITE_KEYS] },
  { userId: "chap_1", permissions: [...READ_KEYS, ...WRITE_KEYS] },
  { userId: "lpn_1", permissions: [...READ_KEYS, ...WRITE_KEYS] },
  { userId: "lvn_1", permissions: [...READ_KEYS, ...WRITE_KEYS] },
  // GAP-015 — the platform-admin deadline override is its own key; RN (hope.timepoint.write) does not hold it.
  {
    userId: "admin_1",
    permissions: [...READ_KEYS, ...WRITE_KEYS, "hope.admin.late_deadline_override"],
  },
  { userId: "viewer_1", permissions: ["hope.schedule.read"] },
  { userId: "md_1", permissions: [...READ_KEYS] },
  { userId: "compliance_1", permissions: SUB_KEYS },
];

type IsInCaseload = (q: {
  organizationId: string;
  userId: string;
  patientId: string;
}) => Promise<boolean>;
type ResolveAdmissionPatient = (
  organizationId: string,
  admissionId: string,
) => Promise<{ patientId: string } | null>;

function makeServer(
  options: {
    isInCaseload?: IsInCaseload;
    resolveAdmissionPatient?: ResolveAdmissionPatient;
    /** #48 — the M6 admission status the §2.3 active-admission guard turns on (default `active`). */
    admissionStatus?: string;
    /** GAP-182 — the caller's caseload (patient ids) for the org-wide worklist narrowing (default: PATIENT). */
    caseload?: readonly string[];
    /** GAP-182 — the caseload seam rejects (the worklist must fail CLOSED). */
    caseloadFails?: boolean;
    /** #883 regression: model a pre-1452 row whose frozen attribution is absent. */
    assessmentAuthorDisciplineOverride?: string | null;
    /** R-08: also seed a generated, never-uploaded package (`SUB_PACKAGED`) holding `SIGNED_A`. */
    packagedSubmission?: boolean;
    /** R-01: seed an OPEN SFV owned by PATIENT / ADMISSION (triggering id `TRIGGER_P1`). */
    openSfvForPatientOne?: boolean;
    /** Seed PATIENT's SECOND admission (ADMISSION_2) with its own open SFV (`TRIGGER_READMIT`). */
    readmission?: boolean;
    /** Seed an open SFV on ADMISSION whose patient is PATIENT_2, not the admission's (`TRIGGER_MISPAIRED`). */
    mispairedSfv?: boolean;
    /** Gate on the REAL M3 `step_up_recent` predicate (session-backed) instead of the header stub. */
    realStepUp?: boolean;
    /** Admissions whose M6 status seam throws (an outage): an SFV completion on one is a retryable 503. */
    unavailableAdmissions?: readonly string[];
    /** The per-actor limiter the composition root binds on the SFV completion route (none by default). */
    sfvCompletionRateLimit?: HopeRouteDeps["sfvCompletionRateLimit"];
  } = {},
) {
  const backend = createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    // #45 — the M6 `AdmissionStatusReader` stand-in. `recordTimepoint` resolves the subject of the
    // record here instead of writing the `admissionId` into `patient_id`; an admission absent from this
    // map is a projection gap and the record is refused.
    // ADMISSION_2 is PATIENT's re-admission when `readmission` is seeded, and otherwise another patient's own
    // admission (the cross-admission attacker scenarios); the slice fails closed on an admission it cannot resolve.
    admissionPatients: {
      [ADMISSION]: PATIENT,
      [ADMISSION_2]: options.readmission ? PATIENT : PATIENT_2,
    },
    ...(options.unavailableAdmissions
      ? { unavailableAdmissions: options.unavailableAdmissions }
      : {}),
    ...(options.admissionStatus
      ? { admissionStatuses: { [ADMISSION]: options.admissionStatus } }
      : {}),
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
    assessments: [
      {
        id: SIGNED_A,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        rfaKind: "01_admission",
        status: "signed",
        signedAt: "2026-06-02T10:00:00.000Z",
        signedBy: "rn_1",
        // Pre-1452 production rows may be NULL even though new in-memory records are typed non-null.
        ...(options.assessmentAuthorDisciplineOverride !== undefined
          ? { authorDiscipline: options.assessmentAuthorDisciplineOverride as unknown as string }
          : {}),
      },
    ],
    submissions: [
      {
        id: SUB_REJECTED,
        organizationId: ORG,
        providerEntityId: "pe_1",
        status: "rejected",
        itemCount: 3,
        rejectedCount: 3,
      },
      {
        id: SUB_QUEUED,
        organizationId: ORG,
        providerEntityId: "pe_1",
        status: "queued",
        itemCount: 2,
      },
      ...(options.packagedSubmission
        ? [
            {
              id: SUB_PACKAGED,
              organizationId: ORG,
              providerEntityId: "pe_1",
              status: "packaged" as const,
              itemCount: 1,
              packageFilename: "HOPE_pe_1_batch.zip",
              packageSha256: "a".repeat(64),
              packageContentBase64: Buffer.from("PK-fake-zip").toString("base64"),
              items: [
                {
                  id: "c1000000-0000-4000-8000-000000000001",
                  assessmentId: SIGNED_A,
                  status: "pending" as const,
                  iqiesRecordId: null,
                  processedAt: null,
                },
              ],
            },
          ]
        : []),
    ],
    sfvs: [
      // status "missed" (not "open") so this seed row doesn't inflate the D4-trigger test's
      // `?state=open` count assertion below.
      {
        id: SFV_SEEDED,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        triggeringAssessmentId: SIGNED_A,
        status: "missed",
        triggeredAt: "2026-06-02T10:00:00.000Z",
        dueAt: "2026-06-16T10:00:00.000Z",
      },
      ...(options.mispairedSfv
        ? [
            {
              id: SFV_MISPAIRED,
              organizationId: ORG,
              patientId: PATIENT_2,
              admissionId: ADMISSION,
              triggeringAssessmentId: TRIGGER_MISPAIRED,
              status: "open" as const,
              triggeredAt: "2026-06-07T10:00:00.000Z",
              dueAt: "2026-06-20T10:00:00.000Z",
            },
          ]
        : []),
      ...(options.readmission
        ? [
            {
              id: SFV_READMIT,
              organizationId: ORG,
              patientId: PATIENT,
              admissionId: ADMISSION_2,
              triggeringAssessmentId: TRIGGER_READMIT,
              status: "open" as const,
              triggeredAt: "2026-06-07T10:00:00.000Z",
              dueAt: "2026-06-20T10:00:00.000Z",
            },
          ]
        : []),
      ...(options.openSfvForPatientOne
        ? [
            {
              id: SFV_OPEN_P1,
              organizationId: ORG,
              patientId: PATIENT,
              admissionId: ADMISSION,
              triggeringAssessmentId: TRIGGER_P1,
              status: "open" as const,
              triggeredAt: "2026-06-07T10:00:00.000Z",
              dueAt: "2026-06-20T10:00:00.000Z",
            },
          ]
        : []),
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // GAP-018: a FRESH registry per server/test — reusing the shared module-level `abacRegistry` would
  // silently pin every test after the first to whatever backend the FIRST test's registration closed over
  // (`registerPredicateIdempotent`'s same-source-string reboot check can't tell two DIFFERENT in-memory
  // backends apart). See the GAP-011 memory note for the full mechanism. `hope.scope` is entirely M10-owned
  // (unlike M9's `assessment.scope`, it never binds the shared `caseload_or_scope` by name), so no
  // cross-module predicate needs registering here.
  const registry = createPredicateRegistry();
  const resolver =
    options.assessmentAuthorDisciplineOverride === undefined
      ? backend
      : {
          ...backend,
          async loadAssessment(organizationId: string, assessmentId: string) {
            const facts = await backend.loadAssessment(organizationId, assessmentId);
            return facts
              ? { ...facts, authorDiscipline: options.assessmentAuthorDisciplineOverride ?? null }
              : null;
          },
        };
  const predicates = buildHopeAbacPredicates({
    resolver,
    isInCaseload: options.isInCaseload ?? (async () => true),
    resolveAdmissionPatient:
      options.resolveAdmissionPatient ??
      (async (_organizationId, admissionId) =>
        admissionId === ADMISSION ? { patientId: PATIENT } : null),
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  if (options.realStepUp) {
    // The production predicate (M3 -> `stepUpFreshFor` -> the SessionContextResolver seam), registered
    // by the REAL boot function into the shared registry and delegated to from this fresh per-test one.
    registerAuthorizationAbacPredicates();
    registry.register("step_up_recent", (context, target) =>
      abacRegistry.evaluate("step_up_recent", context, target),
    );
  } else {
    registry.register(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );
  }
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, {
    service: backend,
    // Required by the route options: a no-op unless a case brings a limiter.
    sfvCompletionRateLimit: options.sfvCompletionRateLimit ?? (async () => undefined),
    caseloadPatientIds: async () => {
      if (options.caseloadFails) throw new Error("caseload seam unavailable");
      return options.caseload ?? [PATIENT];
    },
  });
  return { app, backend };
}

const RN = {
  "x-test-user": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "rn",
  "x-test-pe": "pe_1",
  "x-test-step-up": "true",
};
const NP = {
  "x-test-user": "np_1",
  "x-test-org": ORG,
  "x-test-roles": "np",
  "x-test-pe": "pe_1",
  "x-test-step-up": "true",
};
const NP_CLINICAL_LEAD = {
  ...NP,
  "x-test-roles": "np,clinical_lead",
};
const ADMIN_OVERRIDER = {
  "x-test-user": "admin_1",
  "x-test-org": ORG,
  "x-test-roles": "rn",
  "x-test-pe": "pe_1",
  "x-test-step-up": "true",
};
const MEDICAL_DIRECTOR = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "medical_director",
  "x-test-step-up": "true",
};
const CHAPLAIN = {
  "x-test-user": "chap_1",
  "x-test-org": ORG,
  "x-test-roles": "chaplain",
  "x-test-step-up": "true",
};
const LPN = {
  "x-test-user": "lpn_1",
  "x-test-org": ORG,
  "x-test-roles": "lpn",
  "x-test-pe": "pe_1",
  "x-test-step-up": "true",
};
const LVN = {
  "x-test-user": "lvn_1",
  "x-test-org": ORG,
  "x-test-roles": "lvn",
  "x-test-pe": "pe_1",
  "x-test-step-up": "true",
};
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const COMPLIANCE = {
  "x-test-user": "compliance_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
};

const huv1Body = (over: Record<string, unknown> = {}) => ({
  rfaKind: "02_huv1",
  targetDate: NOW,
  authorDiscipline: "RN",
  data: {
    J: {
      J2051: {
        entries: [
          { symptomCode: "pain", severity: "moderate" },
          { symptomCode: "nausea_vomiting", severity: "mild" },
        ],
      },
    },
  },
  ...over,
});

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

describe("M10-T06 — §4.6 RBAC gating", () => {
  it("serves the admission-scoped HOPE workflow summary without table-by-table reconstruction", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}/hope`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.admissionId).toBe(ADMISSION);
    expect(body.patientId).toBe(PATIENT);
    expect(body.admissionAssessment.status).toBe("completed");
    expect(body.admissionAssessment.assessmentId).toBe(SIGNED_A);
    expect(body.huv1.status).toBe("open");
    expect(body.huv1.windowStart).toBe("2026-06-06T00:00:00.000Z");
    expect(body.huv1.attention.state).toBe("none");
    expect(body.huv2.status).toBe("workflow_not_initialized");
    expect(body.huv2.attention.state).toBe("workflow_issue");
    expect(body.dischargeAssessment.status).toBe("not_applicable");
    expect(body.dischargeAssessment.attention.state).toBe("none");
    expect(body.sfvs).toHaveLength(1);
    expect(body.sfvs[0]).toMatchObject({
      id: SFV_SEEDED,
      status: "missed",
      triggeringAssessmentId: SIGNED_A,
      triggeringRfaKind: "01_admission",
      attention: { state: "missed", severity: "critical" },
    });
    expect(body.summary.actionableCount).toBe(1);
    expect(body.summary.overdueCount).toBe(1);
    expect(body.summary.workflowIssueCount).toBe(1);
    expect(body.summary.highestSeverity).toBe("critical");
    await app.close();
  });

  it("RN with hope.schedule.read lists schedules; a viewer without the key is 403 only on protected routes", async () => {
    const { app } = makeServer();
    // Names the patient: an UNFILTERED list is an org-wide read that `hope.scope` now reserves for
    // the org-wide scope roles, and this test is about the RBAC key, not the scope claim.
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/hope/schedules?patientId=${PATIENT}`,
      headers: VIEWER,
    });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({ method: "GET", url: "/api/v1/hope/sfv", headers: VIEWER });
    expect(denied.statusCode).toBe(403); // viewer lacks hope.sfv.read
    await app.close();
  });

  it("compliance officer reads submissions + dashboard; cannot record a timepoint", async () => {
    const { app } = makeServer();
    const subs = await app.inject({
      method: "GET",
      url: "/api/v1/hope/submissions",
      headers: COMPLIANCE,
    });
    expect(subs.statusCode).toBe(200);
    const dash = await app.inject({
      method: "GET",
      url: "/api/v1/hope/dashboard/compliance",
      headers: COMPLIANCE,
    });
    expect(dash.statusCode).toBe(200);
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: COMPLIANCE,
      payload: huv1Body(),
    });
    expect(write.statusCode).toBe(403);
    await app.close();
  });
});

describe("M10-T06 — §4.7 hope.sfvAuthorAllowed (RN/NP/LPN/LVN; CMS HOPE Guidance Manual v1.03)", () => {
  /** RN records + signs a moderate-J2051 HUV1, which opens a real SFV obligation on that assessment. */
  const openSfv = async () => {
    const ctx = makeServer();
    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    const triggeringAssessmentId = rec.json().id as string;
    const signed = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${triggeringAssessmentId}/sign`,
      headers: RN,
      payload: { ifVersion: rec.json().version, attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    return { ...ctx, triggeringAssessmentId };
  };
  const sfvPayload = (triggeringAssessmentId: string, authorDiscipline: string) => ({
    triggeringAssessmentId,
    targetDate: NOW,
    authorDiscipline,
    data: SFV_DATA,
    attestationConfirmed: true,
  });
  const postSfv = (
    app: Awaited<ReturnType<typeof openSfv>>["app"],
    headers: Record<string, string>,
    triggeringAssessmentId: string,
    authorDiscipline: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers,
      payload: sfvPayload(triggeringAssessmentId, authorDiscipline),
    });

  it("an LPN records an SFV attributed to LPN (201)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const res = await postSfv(app, LPN, triggeringAssessmentId, "LPN");
    expect(res.statusCode).toBe(201);
    await app.close();
  });
  it("an LPN cannot attribute the SFV to RN (403, M10_DISCIPLINE_NOT_PERMITTED)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const res = await postSfv(app, LPN, triggeringAssessmentId, "RN");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("M10_DISCIPLINE_NOT_PERMITTED");
    await app.close();
  });
  it("an RN cannot attribute the SFV to LPN (403)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    expect((await postSfv(app, RN, triggeringAssessmentId, "LPN")).statusCode).toBe(403);
    await app.close();
  });
  it("an LVN-role actor records an SFV attributed to LVN (201)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const res = await postSfv(app, LVN, triggeringAssessmentId, "LVN");
    expect(res.statusCode).toBe(201);
    await app.close();
  });
  it("a medical director (MD) is still denied the SFV route (403)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    expect((await postSfv(app, MEDICAL_DIRECTOR, triggeringAssessmentId, "MD")).statusCode).toBe(
      403,
    );
    await app.close();
  });
  it("an LPN is still denied a non-SFV timepoint (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: LPN,
      payload: huv1Body(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
  it("the LPN who signed an SFV can correct it, edit the draft and sign it; a non-SFV correction by an LPN is refused", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const sfv = await postSfv(app, LPN, triggeringAssessmentId, "LPN");
    const sfvId = sfv.json().id as string;
    const corrected = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${sfvId}/correct`,
      headers: LPN,
      payload: {
        correctionReason: "typo",
        targetDate: NOW,
        authorDiscipline: "LPN",
        data: huv1Body().data,
      },
    });
    expect(corrected.statusCode).toBe(201);
    const draftId = corrected.json().id as string;
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${draftId}/sign`,
      headers: LPN,
      payload: { ifVersion: corrected.json().version, attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    // Claiming RN on an SFV correction is not forbidden by the floor, but LPN on a non-SFV record is.
    const nonSfv = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${triggeringAssessmentId}/correct`,
      headers: LPN,
      payload: {
        correctionReason: "x",
        targetDate: NOW,
        authorDiscipline: "LPN",
        data: huv1Body().data,
      },
    });
    expect(nonSfv.statusCode).toBe(403);
    await app.close();
  });

  const correctBody = (authorDiscipline: string) => ({
    correctionReason: "x",
    targetDate: NOW,
    authorDiscipline,
    data: huv1Body().data,
  });
  const correct = (
    app: Awaited<ReturnType<typeof openSfv>>["app"],
    headers: Record<string, string>,
    id: string,
    authorDiscipline: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${id}/correct`,
      headers,
      payload: correctBody(authorDiscipline),
    });

  it("a correction cannot attribute an SFV to a discipline the actor does not hold (LPN as RN: 403)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const sfvId = (await postSfv(app, LPN, triggeringAssessmentId, "LPN")).json().id as string;
    const res = await correct(app, LPN, sfvId, "RN");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("M10_DISCIPLINE_NOT_PERMITTED");
    await app.close();
  });
  it("a correction cannot attribute a non-SFV record to another discipline (RN as NP: 403; as RN: 201)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    expect((await correct(app, RN, triggeringAssessmentId, "NP")).statusCode).toBe(403);
    expect((await correct(app, RN, triggeringAssessmentId, "LPN")).statusCode).toBe(403);
    expect((await correct(app, RN, triggeringAssessmentId, "RN")).statusCode).toBe(201);
    await app.close();
  });
  it("a chaplain cannot edit, patch or sign an SFV correction draft (403)", async () => {
    const { app, triggeringAssessmentId } = await openSfv();
    const sfvId = (await postSfv(app, LPN, triggeringAssessmentId, "LPN")).json().id as string;
    const draftId = (await correct(app, LPN, sfvId, "LPN")).json().id as string;
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/hope/assessments/${draftId}`,
      headers: CHAPLAIN,
      payload: { data: huv1Body().data },
    });
    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${draftId}/sign`,
      headers: CHAPLAIN,
      payload: { ifVersion: 1, attestationConfirmed: true },
    });
    expect(put.statusCode).toBe(403);
    expect(sign.statusCode).toBe(403);
    await app.close();
  });
  it("an LPN cannot edit, patch or sign a NON-SFV draft (403)", async () => {
    const { app } = makeServer();
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    const id = rec.json().id as string;
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/hope/assessments/${id}`,
      headers: LPN,
      payload: { data: huv1Body().data },
    });
    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${id}/sign`,
      headers: LPN,
      payload: { ifVersion: rec.json().version, attestationConfirmed: true },
    });
    expect(put.statusCode).toBe(403);
    expect(sign.statusCode).toBe(403);
    await app.close();
  });
});

describe("M10-T06 — §4.7 hope.authorDisciplineAllowed (RN/NP/MD only)", () => {
  it("a chaplain holding the RBAC key is still blocked by the discipline ABAC floor (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: CHAPLAIN,
      payload: huv1Body(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("freezes the claimed discipline: RN cannot record as NP, and NP cannot edit or sign an RN draft", async () => {
    const { app } = makeServer();
    const falseClaim = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body({ authorDiscipline: "NP" }),
    });
    expect(falseClaim.statusCode).toBe(403);

    const recorded = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().authorDiscipline).toBe("RN");
    const id = recorded.json().id as string;

    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/hope/assessments/${id}`,
      headers: NP,
      payload: { data: huv1Body().data },
    });
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${id}/sign`,
      headers: NP,
      payload: { ifVersion: recorded.json().version, attestationConfirmed: true },
    });
    expect(edited.statusCode).toBe(403);
    expect(signed.statusCode).toBe(403);
    await app.close();
  });

  it("guards HUV completion-date writes by the stored discipline and fails closed for a legacy NULL", async () => {
    const { app } = makeServer();
    const recorded = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(recorded.statusCode).toBe(201);
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/v1/hope/assessments/${recorded.json().id}/huv/completion-date`,
      headers: NP,
      payload: { ifVersion: recorded.json().version, z0350: "2026-06-12" },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();

    const { app: legacyApp } = makeServer({ assessmentAuthorDisciplineOverride: null });
    const legacyDraft = await legacyApp.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(legacyDraft.statusCode).toBe(201);
    const legacyDenied = await legacyApp.inject({
      method: "PATCH",
      url: `/api/v1/hope/assessments/${legacyDraft.json().id}/huv/completion-date`,
      headers: RN,
      payload: { ifVersion: legacyDraft.json().version, z0350: "2026-06-12" },
    });
    expect(legacyDenied.statusCode).toBe(403);
    await legacyApp.close();
  });

  it.each([
    ["a Feb 30", "2026-02-30"],
    ["a non-leap Feb 29", "2026-02-29"],
    ["month 13", "2026-13-01"],
  ])(
    "refuses %s as a HUV completion date with 422 and changes nothing (as the DB backend does)",
    async (_label, z0350) => {
      const { app, backend } = makeServer();
      const recorded = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
        headers: RN,
        payload: huv1Body(),
      });
      expect(recorded.statusCode).toBe(201);
      const before = await backend.getAssessment(ORG, recorded.json().id);

      await expect(
        backend.setHuvCompletionDate(ORG, "member-1", recorded.json().id, {
          ifVersion: recorded.json().version,
          z0350,
        }),
      ).rejects.toMatchObject({ statusCode: 422 });

      expect(await backend.getAssessment(ORG, recorded.json().id)).toEqual(before);
      await app.close();
    },
  );
});

describe("M10-T06 — D4 J2051 trigger + SFV creation + §2.4 outbox", () => {
  it("record → sign with a moderate J2051 entry fires the trigger, creates an SFV, and emits the §2.4 events", async () => {
    const { app, backend } = makeServer();
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(rec.statusCode).toBe(201);
    const draftId = rec.json().id as string;
    backend.drainEvents(); // clear

    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${draftId}/sign`,
      headers: RN,
      payload: { ifVersion: rec.json().version, attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.status).toBe("signed");
    expect(body.z0500b).toBe(NOW.slice(0, 10));
    expect(body.signedByMembershipId).toBe("rn_1");

    const events = backend.drainEvents().map((e) => e.eventName);
    expect(events).toContain("m10.hope.timepoint_signed");
    expect(events).toContain("m10.hope.j2051_trigger_fired");
    expect(events).toContain("m10.hope.sfv_created");

    // The matching open schedule transitioned to completed; an open SFV worklist row now exists.
    const sched = await app.inject({
      method: "GET",
      url: `/api/v1/hope/schedules/${SCHEDULE}`,
      headers: RN,
    });
    expect(sched.json().status).toBe("completed");
    const sfvs = await app.inject({
      method: "GET",
      url: "/api/v1/hope/sfv?state=open",
      headers: RN,
    });
    expect(sfvs.json().sfvs.length).toBe(1);
    await app.close();
  });

  it("a mild-only J2051 reading does NOT fire the trigger (no SFV)", async () => {
    const { app, backend } = makeServer();
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body({
        data: { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } },
      }),
    });
    const draftId = rec.json().id as string;
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${draftId}/sign`,
      headers: RN,
      payload: { ifVersion: rec.json().version, attestationConfirmed: true },
    });
    expect(signed.json().status).toBe("signed");
    expect(backend.drainEvents().map((e) => e.eventName)).not.toContain("m10.hope.sfv_created");
    await app.close();
  });
});

describe("M10-T06 — correction chain (§4.4)", () => {
  it("the original signer corrects a signed assessment (supersede); correcting a draft is 409", async () => {
    const { app, backend } = makeServer();
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${SIGNED_A}/correct`,
      headers: RN,
      payload: {
        correctionReason: "typo in Section I",
        targetDate: NOW,
        authorDiscipline: "RN",
        data: {},
      },
    });
    expect(ok.statusCode).toBe(201);
    // Migration 0225 (hope_assessment_supersede_on_correction_sign): a DRAFT correction must not
    // supersede its source — "merely opening a draft" is no longer destructive. The original stays the
    // current signed record until the correction is signed.
    expect((await backend.getAssessment(ORG, SIGNED_A)).status).toBe("signed");

    // While that correction draft is pending, a second correction is refused (one pending lineage op).
    const pending = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${SIGNED_A}/correct`,
      headers: RN,
      payload: {
        correctionReason: "second draft",
        targetDate: NOW,
        authorDiscipline: "RN",
        data: {},
      },
    });
    expect(pending.statusCode).toBe(409);

    // Signing the correction supersedes the original.
    const signedCorrection = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${ok.json().id}/sign`,
      headers: RN,
      payload: { ifVersion: ok.json().version, attestationConfirmed: true },
    });
    expect(signedCorrection.statusCode).toBe(200);
    const original = await backend.getAssessment(ORG, SIGNED_A);
    expect(original.status).toBe("superseded");
    expect(original.supersededByAssessmentId).toBe(ok.json().id);

    // Correcting the now-superseded original is 409.
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${SIGNED_A}/correct`,
      headers: RN,
      payload: { correctionReason: "again", targetDate: NOW, authorDiscipline: "RN", data: {} },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });
});

describe("M10-T06 — inactivation attribution", () => {
  const inactivate = (
    app: ReturnType<typeof makeServer>["app"],
    headers: Record<string, string>,
    authorDiscipline: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${SIGNED_A}/inactivations`,
      headers,
      payload: {
        reason: "recorded against the wrong chart",
        authorDiscipline,
      },
    });

  it("binds same-discipline and cross-discipline clinical-lead drafts to the acting clinician", async () => {
    const { app: sameDisciplineApp } = makeServer();
    const sameDiscipline = await inactivate(sameDisciplineApp, RN, "RN");
    expect(sameDiscipline.statusCode).toBe(201);
    expect(sameDiscipline.json().authorDiscipline).toBe("RN");
    await sameDisciplineApp.close();

    const { app: clinicalLeadApp } = makeServer();
    const clinicalLead = await inactivate(clinicalLeadApp, NP_CLINICAL_LEAD, "NP");
    expect(clinicalLead.statusCode).toBe(201);
    expect(clinicalLead.json().authorDiscipline).toBe("NP");
    await clinicalLeadApp.close();
  });

  it("fails closed when a clinical lead claims an unheld discipline", async () => {
    const { app } = makeServer();
    const denied = await inactivate(app, NP_CLINICAL_LEAD, "RN");
    expect(denied.statusCode).toBe(403);
    expect(JSON.stringify(denied.json())).toContain("M10_DISCIPLINE_NOT_PERMITTED");
    await app.close();
  });

  it("re-attributes a legacy NULL original to the acting clinical lead's validated discipline", async () => {
    const { app, backend } = makeServer({ assessmentAuthorDisciplineOverride: null });
    expect((await backend.loadAssessment(ORG, SIGNED_A))?.authorDiscipline).toBeNull();
    const res = await inactivate(app, NP_CLINICAL_LEAD, "NP");
    expect(res.statusCode).toBe(201);
    expect(res.json().authorDiscipline).toBe("NP");
    await app.close();
  });
});

describe("M10-T06 — submission retry guard (§4.4)", () => {
  it("retry on a rejected submission re-queues; retry on a queued submission is 409", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_REJECTED}/retry`,
      headers: RN,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("queued");
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_QUEUED}/retry`,
      headers: RN,
      payload: {},
    });
    expect(bad.statusCode).toBe(409);
    await app.close();
  });
});

// ── §D13 — the operator writes that are not signatures refuse an AI principal ────────────────────────
// The principal below HOLDS every permission these routes ask for (it is `rn_1`); only its actor kind is `ai_*`.
describe("§D13 — skip, retry, mark-uploaded, cancel, results, assemble, package download and regenerate refuse an AI principal", () => {
  const AI = { ...RN, "x-test-actor-kind": "ai_agent" };
  const ASSEMBLE_PE = "77777777-7777-4777-8777-777777777777";
  type Server = ReturnType<typeof makeServer>;
  const cases: readonly {
    name: string;
    url: string;
    /** POST unless a case says otherwise (the package download is a GET). */
    method?: "GET" | "POST";
    payload?: Record<string, unknown>;
    unchanged: (s: Server) => Promise<unknown>;
  }[] = [
    {
      name: "skip a schedule",
      url: `/api/v1/hope/schedules/${SCHEDULE}/skip`,
      payload: { reasonCode: "other" },
      unchanged: async (s) => (await s.backend.getSchedule(ORG, SCHEDULE)).status,
    },
    {
      name: "retry a submission",
      url: `/api/v1/hope/submissions/${SUB_REJECTED}/retry`,
      payload: {},
      unchanged: async (s) => (await s.backend.getSubmission(ORG, SUB_REJECTED)).status,
    },
    {
      name: "mark a package uploaded",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/mark-uploaded`,
      payload: {},
      unchanged: async (s) => (await s.backend.getSubmission(ORG, SUB_PACKAGED)).status,
    },
    {
      name: "cancel a package",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/cancel`,
      payload: { reasonCode: "package_lost" },
      unchanged: async (s) => (await s.backend.getSubmission(ORG, SUB_PACKAGED)).status,
    },
    {
      name: "import a CMS result",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/results`,
      payload: { results: [{ assessmentId: SIGNED_A, status: "accepted" }] },
      unchanged: async (s) => (await s.backend.getSubmission(ORG, SUB_PACKAGED)).status,
    },
    {
      name: "assemble a package",
      url: "/api/v1/hope/submissions/assemble",
      payload: { providerEntityId: ASSEMBLE_PE },
      unchanged: async (s) => (await s.backend.listSubmissions(ORG)).submissions.length,
    },
    {
      name: "download a package (it advances packaged -> exported and streams the PHI package)",
      method: "GET",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/package`,
      unchanged: async (s) => (await s.backend.getSubmission(ORG, SUB_PACKAGED)).status,
    },
    {
      name: "regenerate schedules",
      url: "/api/v1/hope/admin/regenerate-schedules",
      payload: { admissionId: ADMISSION },
      unchanged: async (s) => JSON.stringify(await s.backend.getWorkflowState(ORG, ADMISSION)),
    },
  ];

  it.each(cases)(
    "$name: an ai_* principal holding the permission is refused (403) and nothing changes",
    async ({ url, method, payload, unchanged }) => {
      const server = makeServer({ packagedSubmission: true });
      const before = await unchanged(server);

      const res = await server.app.inject({ method: method ?? "POST", url, headers: AI, payload });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain("AI principals");
      expect(await unchanged(server)).toEqual(before);
      await server.app.close();
    },
  );

  it.each(cases)(
    "$name: the same request from the same user as a person is not refused for its actor kind",
    async ({ url, method, payload }) => {
      const server = makeServer({ packagedSubmission: true });

      const res = await server.app.inject({
        method: method ?? "POST",
        url,
        headers: { ...RN, "x-test-pe": `pe_1,${ASSEMBLE_PE}` },
        payload,
      });

      expect(res.statusCode).not.toBe(403);
      await server.app.close();
    },
  );
});

describe("GET /hope/submissions/:id/package — who took the package out", () => {
  it("hands the service the acting membership, which it stamps as exported_by_membership_id", async () => {
    const server = makeServer({ packagedSubmission: true });
    const download = vi.spyOn(server.backend, "downloadSubmissionPackage");

    await server.app.inject({
      method: "GET",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/package`,
      headers: RN,
    });

    expect(download).toHaveBeenCalledWith(ORG, SUB_PACKAGED, "rn_1");
    await server.app.close();
  });
});

describe("POST /hope/schedules/:id/skip — the reason is a closed code list", () => {
  const skip = (app: ReturnType<typeof makeServer>["app"], payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/hope/schedules/${SCHEDULE}/skip`,
      headers: RN,
      payload,
    });

  it("skips an open schedule for a listed code (200)", async () => {
    const { app } = makeServer();
    const res = await skip(app, { reasonCode: "patient_hospitalized" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("skipped");
    await app.close();
  });

  it("refuses free text with a 422 that does not echo it, and the schedule stays open", async () => {
    const { app, backend } = makeServer();
    const res = await skip(app, { reasonCode: "Jane Doe is in the hospital" });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).not.toContain("Jane");
    expect((await backend.getSchedule(ORG, SCHEDULE)).status).toBe("open");
    await app.close();
  });

  it("refuses a note, an absent reason and an empty body (422), and the schedule stays open", async () => {
    const { app, backend } = makeServer();
    for (const payload of [{ reasonCode: "other", note: "typed by the clinician" }, {}]) {
      expect((await skip(app, payload)).statusCode).toBe(422);
    }
    expect((await backend.getSchedule(ORG, SCHEDULE)).status).toBe("open");
    await app.close();
  });
});

// ── R-08 — cancel a package that never reached CMS ───────────────────────────────────────────────────
describe("R-08 — POST /hope/submissions/:id/cancel", () => {
  const cancel = (
    app: ReturnType<typeof makeServer>["app"],
    id: string,
    headers: Record<string, string>,
    payload: Record<string, unknown> = { reasonCode: "package_lost" },
  ) =>
    app.inject({ method: "POST", url: `/api/v1/hope/submissions/${id}/cancel`, headers, payload });

  it("cancels a packaged batch (200), replays safely, then refuses mark-uploaded/results/package/retry (409)", async () => {
    const { app } = makeServer({ packagedSubmission: true });
    const batch = { id: SUB_PACKAGED };
    const res = await cancel(app, batch.id, RN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: batch.id,
      status: "cancelled",
      cancelReasonCode: "package_lost",
    });
    const replay = await cancel(app, batch.id, RN, { reasonCode: "other" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().cancelReasonCode).toBe("package_lost");

    const url = (tail: string) => `/api/v1/hope/submissions/${batch.id}/${tail}`;
    const refused = await Promise.all([
      app.inject({ method: "POST", url: url("mark-uploaded"), headers: RN, payload: {} }),
      app.inject({
        method: "POST",
        url: url("results"),
        headers: RN,
        payload: { results: [{ assessmentId: SIGNED_A, status: "accepted" }] },
      }),
      app.inject({ method: "GET", url: url("package"), headers: RN }),
      app.inject({ method: "POST", url: url("retry"), headers: RN, payload: {} }),
    ]);
    expect(refused.map((r) => r.statusCode)).toEqual([409, 409, 409, 409]);
    expect(refused[1]?.json().error.code).toBe("M10_SUBMISSION_CANCELLED");
    expect(refused[2]?.json().error.code).toBe("M10_SUBMISSION_CANCELLED");
    await app.close();
  });

  it("a batch that was marked uploaded cannot be cancelled (409 M10_SUBMISSION_CANCEL_NOT_ALLOWED)", async () => {
    const { app, backend } = makeServer({ packagedSubmission: true });
    const batch = { id: SUB_PACKAGED };
    await backend.markSubmissionUploaded(ORG, "rn_1", batch.id, {});
    const res = await cancel(app, batch.id, RN);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("M10_SUBMISSION_CANCEL_NOT_ALLOWED");
    for (const id of [SUB_REJECTED, SUB_QUEUED]) {
      expect((await cancel(app, id, RN)).statusCode).toBe(409);
    }
    await app.close();
  });

  it("rejects a free-text or unknown reason, and a missing body (422, no write)", async () => {
    const { app, backend } = makeServer({ packagedSubmission: true });
    const batch = { id: SUB_PACKAGED };
    for (const payload of [
      { reasonCode: "the patient chart was lost" },
      { reasonCode: "other", note: "free text" },
      {},
    ]) {
      expect((await cancel(app, batch.id, RN, payload)).statusCode).toBe(422);
    }
    expect((await backend.getSubmission(ORG, batch.id)).status).toBe("packaged");
    await app.close();
  });

  it("needs hope.submission.manage (403) and the provider-entity scope (404, no existence oracle)", async () => {
    const { app, backend } = makeServer({ packagedSubmission: true });
    const batch = { id: SUB_PACKAGED };
    expect((await cancel(app, batch.id, VIEWER)).statusCode).toBe(403);
    const otherPe = { ...RN, "x-test-pe": "pe_2" };
    expect((await cancel(app, batch.id, otherPe)).statusCode).toBe(404);
    expect((await cancel(app, "c0000000-0000-4000-8000-0000000000ff", RN)).statusCode).toBe(404);
    expect((await backend.getSubmission(ORG, batch.id)).status).toBe("packaged");
    await app.close();
  });
});

// ── F-058 (#150) — force-assemble ────────────────────────────────────────────────────────────────────
// The F-058 force-assemble route tests (period batching, CCN keying, idempotent skip counts, unsited
// reporting, queued item counts) were deleted: the lost automated iQIES assemble pipeline was not
// restored — main's manual package flow (`assembleSubmission`) is the kept design — see
// audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md. The pure `planAssembleSubmissions` / `submissionPeriodFor`
// planners remain covered directly in hope-submission.test.ts.
describe("F-058 — the compliance dashboard's acceptance rate ignores unanswered batches", () => {
  it("a queued batch does not drag the acceptance rate to 0% on the compliance dashboard", async () => {
    // `submissionAcceptanceRate` used to divide by every submission of any status, so a `queued` batch
    // read as a failed one: 0% acceptance, the §1.3 APU-penalty band, shown to a compliance officer for
    // work merely awaiting transmit. A batch iQIES has not answered on belongs in neither half.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hope/dashboard/compliance?providerEntityId=pe_1",
      headers: RN,
    });
    const body = res.json();
    // pe_1 has one seeded `rejected` batch and one seeded `queued` batch. Only the rejected batch has
    // an outcome, so the denominator is 1 — not 2.
    expect(body.submissionAcceptanceCounts.total).toBe(1);
    expect(body.submissionAcceptanceCounts.accepted).toBe(0);
    await app.close();
  });
});

// ── GAP-018 — hope.scope caseload / provider-entity scoping ───────────────────────────────────────────
// Proves the wiring closes the gap across every id shape hope.scope resolves: patientId (direct),
// admissionId (via the M6 seam stand-in), scheduleId, sfvId, assessmentId, providerEntityId, and
// submissionId — an actor outside the patient's caseload / the PE's scope is denied a non-leaking 404 on
// every route class, and caseload/PE membership restores access. `makeServer`'s defaults (`isInCaseload:
// async () => true`, `resolveAdmissionPatient` matching the seeded ADMISSION→PATIENT pair) are permissive
// for every other describe block in this file — these tests are the only ones that override them.
describe("GAP-018 — hope.scope caseload / provider-entity scoping", () => {
  it("patientId-keyed route (patient HOPE timeline): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({ isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/hope/assessments`,
      headers: RN,
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const allowed = await inside.app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/hope/assessments`,
      headers: RN,
    });
    expect(allowed.statusCode).toBe(200);
    await outside.app.close();
    await inside.app.close();
  });

  it("admissionId-keyed route (record timepoint): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({ isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const allowed = await inside.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(allowed.statusCode).toBe(201);
    await outside.app.close();
    await inside.app.close();
  });

  it("an admissionId the resolver can't answer (seam gap) fails closed (404)", async () => {
    const { app } = makeServer({ resolveAdmissionPatient: async () => null });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("scheduleId-keyed route (schedule detail): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({ isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "GET",
      url: `/api/v1/hope/schedules/${SCHEDULE}`,
      headers: RN,
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const allowed = await inside.app.inject({
      method: "GET",
      url: `/api/v1/hope/schedules/${SCHEDULE}`,
      headers: RN,
    });
    expect(allowed.statusCode).toBe(200);
    await outside.app.close();
    await inside.app.close();
  });

  it("sfvId-keyed route (SFV detail): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({ isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "GET",
      url: `/api/v1/hope/sfv/${SFV_SEEDED}`,
      headers: RN,
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const allowed = await inside.app.inject({
      method: "GET",
      url: `/api/v1/hope/sfv/${SFV_SEEDED}`,
      headers: RN,
    });
    expect(allowed.statusCode).toBe(200);
    await outside.app.close();
    await inside.app.close();
  });

  it("assessmentId-keyed route (assessment detail): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({ isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "GET",
      url: `/api/v1/hope/assessments/${SIGNED_A}`,
      headers: RN,
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const allowed = await inside.app.inject({
      method: "GET",
      url: `/api/v1/hope/assessments/${SIGNED_A}`,
      headers: RN,
    });
    expect(allowed.statusCode).toBe(200);
    await outside.app.close();
    await inside.app.close();
  });

  it("providerEntityId-keyed route (submissions filtered by PE): denied outside PE scope, allowed inside", async () => {
    const { app } = makeServer();
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/hope/submissions?providerEntityId=pe_1",
      headers: { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" }, // no x-test-pe
    });
    expect(denied.statusCode).toBe(404);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/hope/submissions?providerEntityId=pe_1",
      headers: RN, // carries x-test-pe: pe_1
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("submissionId-keyed route (submission detail): denied outside PE scope, allowed inside", async () => {
    const { app } = makeServer();
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/hope/submissions/${SUB_REJECTED}`,
      headers: { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" }, // no x-test-pe
    });
    expect(denied.statusCode).toBe(404);
    const allowed = await app.inject({
      method: "GET",
      url: `/api/v1/hope/submissions/${SUB_REJECTED}`,
      headers: RN,
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("an UNFILTERED list/dashboard request is an org-wide read: denied without an org-wide scope role, allowed with one", async () => {
    // 2026-08-14 review — an optional filter is not a scope. Omitting the query param used to reach
    // hope.scope with an empty target and an unconditional `true`, handing any org member every PE's
    // submissions and every patient's schedules (the services apply no narrowing of their own when
    // the filter is absent). Now the empty target requires an ORG_WIDE_SCOPE_ROLE; a caseload/PE-
    // scoped caller must name the patient/PE they claim, which the id branches then verify.
    const { app } = makeServer({ isInCaseload: async () => false });
    // SAME user (so the RBAC keys are identical and only the ABAC decision differs) — only the role
    // changes between the denied and allowed calls.
    const rn = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" }; // no x-test-pe
    const compliance = {
      "x-test-user": "rn_1",
      "x-test-org": ORG,
      "x-test-roles": "compliance_officer",
    };
    // `/schedules` is the exception: it narrows to the caller's caseload instead (next test).
    for (const url of ["/api/v1/hope/submissions", "/api/v1/hope/dashboard/compliance"]) {
      const denied = await app.inject({ method: "GET", url, headers: rn });
      expect(denied.statusCode, `${url} unfiltered as plain rn`).toBe(404);
      const allowed = await app.inject({ method: "GET", url, headers: compliance });
      expect(allowed.statusCode, `${url} unfiltered as compliance_officer`).toBe(200);
    }
    // An EMPTY-STRING param is the same empty target (targetStr treats "" as absent) — it must not
    // sneak past as a "present" filter.
    const emptyParam = await app.inject({
      method: "GET",
      url: "/api/v1/hope/submissions?providerEntityId=",
      headers: rn,
    });
    expect(emptyParam.statusCode).toBe(404);
    // The filtered path still works for the scoped caller: an RN naming a patient in caseload.
    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/hope/schedules?patientId=${PATIENT}`,
      headers: { ...rn },
    });
    expect(filtered.statusCode).toBe(404); // isInCaseload:false — the named claim is verified too
    await app.close();
  });
});

describe("the unfiltered HOPE schedule list narrows to the caller's caseload", () => {
  const rn = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
  const ids = (res: { json: () => unknown }): string[] =>
    (res.json() as { schedules: { patientId: string }[] }).schedules.map((s) => s.patientId);

  it("an RN sees schedules for their caseload patients only", async () => {
    const { app } = makeServer({ caseload: [PATIENT] });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/schedules", headers: rn });
    expect(res.statusCode).toBe(200);
    expect(ids(res).length).toBeGreaterThan(0);
    expect(new Set(ids(res))).toEqual(new Set([PATIENT]));
    await app.close();
  });

  it("an RN with an empty caseload sees no schedules", async () => {
    const { app } = makeServer({ caseload: [] });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/schedules", headers: rn });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([]);
    await app.close();
  });

  it("fails closed when the caseload seam is unavailable", async () => {
    const { app } = makeServer({ caseloadFails: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/schedules", headers: rn });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([]);
    await app.close();
  });

  it("an org-wide role still sees every schedule regardless of caseload", async () => {
    const { app } = makeServer({ caseload: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hope/schedules",
      headers: { ...rn, "x-test-roles": "compliance_officer" },
    });
    expect(res.statusCode).toBe(200);
    expect(ids(res).length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("M10-T06 — §4.9.1 out-of-band PHI strip", () => {
  it("buildOutOfBandPayload carries no patient-name token for a timepoint-window alert", () => {
    const alert = buildTimepointWindowAlert({
      scheduleId: SCHEDULE,
      rfaKind: "02_huv1",
      patientId: PATIENT,
      patientDisplayName: "Jane Doe",
      windowState: "closing",
      hoursUntilDeadline: 12,
      ctaUrl: "https://app/chartwarden/hope/123",
    });
    const oob = buildOutOfBandPayload(alert);
    expect(oob.body).not.toContain("Jane");
    expect(oob.body).not.toContain("02_huv1");
    expect(oob.ctaUrl).toBe("https://app/chartwarden/hope/123");
  });
});

// ── #45 — the subject of a HOPE record ─────────────────────────────────────────────────────────────
//
// `hope_assessment.patient_id` used to fall back to the `admissionId` whenever no open
// `hope_timepoint_schedule` row existed for (admission, RFA). The column carries no FK — the corpus
// keeps foreign keys inside the owning module — so nothing rejected it, and the row named a subject
// that does not exist. Every route that scopes on the ASSESSMENT (sign, correct, get) then resolved
// its caseload check against that non-patient id and 404'd for the clinicians who perform the
// assessment, while the org-wide scope roles sailed through by skipping the caseload check entirely.
//
// The existing tests above never caught it because they all record `02_huv1`, and `makeServer` seeds an
// open `02_huv1` schedule. Production seeds none: no code anywhere inserts a `hope_timepoint_schedule`
// row, so the fallback was not the edge case — it was the only path.
describe("M10 — #45 the recorded timepoint's patient comes from the admission", () => {
  /** `01_admission` has no seeded schedule, so this is the path that used to fabricate the subject. */
  const unscheduledBody = () => huv1Body({ rfaKind: "01_admission" });

  it("stores the admission's patient — not the admission id — when no schedule row exists", async () => {
    const { app, backend } = makeServer();
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: unscheduledBody(),
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().patientId).toBe(PATIENT);
    expect(rec.json().patientId).not.toBe(ADMISSION);
    // The §4.7 ABAC resolver is the surface `hope.scope` reads on every assessment-scoped route.
    const facts = await backend.loadAssessment(ORG, rec.json().id as string);
    expect(facts?.patientId).toBe(PATIENT);
    await app.close();
  });

  it("an RN on the patient's caseload can then sign it (this returned 404)", async () => {
    // Caseload membership is the real predicate, resolved against the STORED patient id. With an
    // admission id stored, no assignment can ever match and `notFoundOnDeny` renders the denial as 404.
    const { app } = makeServer({ isInCaseload: async ({ patientId }) => patientId === PATIENT });
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: unscheduledBody(),
    });
    expect(rec.statusCode).toBe(201);
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${rec.json().id}/sign`,
      headers: RN,
      // main's sign contract requires the §7.7 optimistic-concurrency version.
      payload: { ifVersion: rec.json().version, attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("signed");
    await app.close();
  });

  it("uses the admission's patient even when a schedule row carries one too", async () => {
    // Two unenforced copies of `patient_id` is what let a third value slip in behind them; the
    // admission is the only authority, so it is asked on every record, not only on a schedule miss.
    const { app } = makeServer();
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(), // 02_huv1 — the seeded open schedule
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().patientId).toBe(PATIENT);
    await app.close();
  });

  it("refuses with 422 M10_ADMISSION_PROJECTION_GAP when the admission cannot be projected", async () => {
    // The ABAC guard is deliberately made permissive here: the write path must refuse on its own, not
    // because something upstream happened to deny first. `UNKNOWN_ADMISSION` is absent from the slice's
    // admission→patient map, which is how the seam reports "I cannot tell you whose admission this is".
    const UNKNOWN_ADMISSION = "33333333-3333-4333-8333-999999999999";
    const { app } = makeServer({
      resolveAdmissionPatient: async () => ({ patientId: PATIENT }),
    });
    const rec = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${UNKNOWN_ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: unscheduledBody(),
    });
    expect(rec.statusCode).toBe(422);
    expect(rec.json().error?.code ?? rec.json().code).toBe("M10_ADMISSION_PROJECTION_GAP");
    await app.close();
  });
});

// ── #48 — the §4.4 recording gate ─────────────────────────────────────────────────────────────────
//
// Every guard exercised below is a `@chartwarden/hope` function that shipped in M10-T03 with a unit test
// and ZERO production callers:
//
//   assertAdmissionActiveAtTarget   M10_ADMISSION_NOT_ACTIVE          0 callers in apps/backend/src
//   assertRfaMatchesSchedule        M10_RFA_KIND_MISMATCH             0
//   assertCaptureAllowed            M10_TIMEPOINT_NOT_OPEN / _EXPIRED / LATE_REASON_REQUIRED|INVALID  0
//   assertSectionQForDischarge      M10_REQUIRED_SECTION_MISSING / _FORBIDDEN_SECTION_PRESENT         0
//
// Each §4.4 code therefore looked enforced and was not. The seeded `02_huv1` window is
// [2026-06-06, 2026-06-20] with a late deadline of 2026-06-27, and NOW (2026-06-08) sits inside it,
// which is why every pre-existing record test above passes the gate without noticing it.
describe("M10 — #48 the §4.4 capture-window gate", () => {
  const codeOf = (res: { json(): { error?: { code?: string } } }): string | undefined =>
    res.json().error?.code;
  const record = async (
    app: { inject: (o: unknown) => Promise<{ statusCode: number; json<T = unknown>(): T }> },
    over: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(over),
    });

  it("rejects a capture before the window opens (409 M10_TIMEPOINT_NOT_OPEN)", async () => {
    const { app } = makeServer();
    const res = await record(app, { targetDate: "2026-06-01T12:00:00.000Z" });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_TIMEPOINT_NOT_OPEN");
    await app.close();
  });

  it("requires a typed late reason inside the grace span (400 M10_LATE_REASON_REQUIRED)", async () => {
    const { app } = makeServer();
    const res = await record(app, { targetDate: "2026-06-23T12:00:00.000Z" });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("M10_LATE_REASON_REQUIRED");
    await app.close();
  });

  it("rejects a late reason outside the CMS codelist (400 M10_LATE_REASON_INVALID)", async () => {
    // main's route TypeBox carries `lateCompletionReasonCode` as a free string, so the closed CMS
    // codelist is enforced by the §4.4 capture gate (`assertCaptureAllowed`) — which makes the domain
    // code reachable over HTTP, exactly as the §4.4 table states.
    const { app } = makeServer();
    const res = await record(app, {
      targetDate: "2026-06-23T12:00:00.000Z",
      lateCompletionReasonCode: "because_i_forgot",
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("M10_LATE_REASON_INVALID");
    await app.close();
  });

  it("accepts a late capture with a valid reason and marks it wasLate", async () => {
    const { app } = makeServer();
    const res = await record(app, {
      targetDate: "2026-06-23T12:00:00.000Z",
      lateCompletionReasonCode: "hospitalization",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ wasLate: boolean }>().wasLate).toBe(true);
    await app.close();
  });

  it("rejects a capture past the late deadline (409 M10_TIMEPOINT_EXPIRED)", async () => {
    const { app } = makeServer();
    const res = await record(app, {
      targetDate: "2026-07-01T12:00:00.000Z",
      lateCompletionReasonCode: "pto",
    });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_TIMEPOINT_EXPIRED");
    await app.close();
  });

  it("GAP-015 an RN with only hope.timepoint.write cannot self-declare adminOverride (403)", async () => {
    const { app } = makeServer();
    const res = await record(app, {
      targetDate: "2026-07-01T12:00:00.000Z",
      adminOverride: true,
      adminOverrideJustification: "Outage during the window; approved by the compliance lead",
      lateCompletionReasonCode: "admin_override",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("GAP-015 an override request without a justification is a 422, even for the permitted admin", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: ADMIN_OVERRIDER,
      payload: huv1Body({
        targetDate: "2026-07-01T12:00:00.000Z",
        adminOverride: true,
        lateCompletionReasonCode: "admin_override",
      }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("an override whose justification names a patient is a 422 that does not echo it, and writes nothing", async () => {
    const { app } = makeServer();
    // Synthetic: an SSN with area 900 is never issued.
    const text = "Outage; patient 900-12-3456 could not be keyed in time, approved by the lead";
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: ADMIN_OVERRIDER,
      payload: huv1Body({
        targetDate: "2026-07-01T12:00:00.000Z",
        adminOverride: true,
        adminOverrideJustification: text,
        lateCompletionReasonCode: "admin_override",
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(res.body).not.toContain("900-12-3456");
    expect(res.body).not.toContain(text);
    await app.close();
  });

  it("an override whose justification is only padding is a 422 (the length is measured after trimming)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: ADMIN_OVERRIDER,
      payload: huv1Body({
        targetDate: "2026-07-01T12:00:00.000Z",
        adminOverride: true,
        adminOverrideJustification: " ".repeat(40),
        lateCompletionReasonCode: "admin_override",
      }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("an admin override extends the hard cutoff but still demands the late reason", async () => {
    const { app } = makeServer();
    const post = (over: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
        headers: ADMIN_OVERRIDER,
        payload: huv1Body({
          targetDate: "2026-07-01T12:00:00.000Z",
          adminOverride: true,
          adminOverrideJustification: "Outage during the window; approved by the compliance lead",
          ...over,
        }),
      });
    const withoutReason = await post({});
    expect(withoutReason.statusCode).toBe(400);
    expect(codeOf(withoutReason)).toBe("M10_LATE_REASON_REQUIRED");

    const withReason = await post({ lateCompletionReasonCode: "admin_override" });
    expect(withReason.statusCode).toBe(201);
    expect(withReason.json<{ wasLate: boolean }>().wasLate).toBe(true);
    await app.close();
  });

  it("in-window capture is not late and ignores a late reason it did not need", async () => {
    const { app } = makeServer();
    const res = await record(app, { lateCompletionReasonCode: "pto" });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ wasLate: boolean }>().wasLate).toBe(false);
    await app.close();
  });
});

describe("M10 — #48 the remaining §4.4 recording guards", () => {
  const codeOf = (res: { json(): { error?: { code?: string } } }): string | undefined =>
    res.json().error?.code;
  const post = (
    app: { inject: (o: unknown) => Promise<{ statusCode: number; json<T = unknown>(): T }> },
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload,
    });

  it("refuses to record against a discharged admission (409 M10_ADMISSION_NOT_ACTIVE)", async () => {
    const { app } = makeServer({ admissionStatus: "discharged" });
    const res = await post(app, huv1Body());
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_ADMISSION_NOT_ACTIVE");
    await app.close();
  });

  it("rejects a payload RFA that disagrees with the named window (409 M10_RFA_KIND_MISMATCH)", async () => {
    // Naming the `scheduleId` is what makes this guard reachable: the worklist hands the clinician a
    // window, and the payload's RFA can disagree with it. Resolved by `rfa_kind` instead, the two agree
    // by construction and the guard is tautological — which is why this test names the schedule.
    const { app } = makeServer();
    const res = await post(app, huv1Body({ rfaKind: "01_admission", scheduleId: SCHEDULE }));
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_RFA_KIND_MISMATCH");
    await app.close();
  });

  it("404s on a named schedule that is not on this admission, rather than capturing ungated", async () => {
    const { app } = makeServer();
    const res = await post(app, huv1Body({ scheduleId: "55555555-5555-4555-8555-999999999999" }));
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  describe("D9 — the discharge RFA's Section Q branch", () => {
    const dischargeBody = (over: Record<string, unknown> = {}) => ({
      rfaKind: "05_discharge",
      targetDate: NOW,
      authorDiscipline: "RN",
      data: {},
      ...over,
    });

    it("requires a discharge_reason (400 M10_REQUIRED_SECTION_MISSING)", async () => {
      const { app } = makeServer();
      const res = await post(app, dischargeBody());
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe("M10_REQUIRED_SECTION_MISSING");
      await app.close();
    });

    it("requires Section Q on a live discharge (400 M10_REQUIRED_SECTION_MISSING)", async () => {
      const { app } = makeServer();
      const res = await post(app, dischargeBody({ dischargeReason: "live_discharge" }));
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe("M10_REQUIRED_SECTION_MISSING");
      await app.close();
    });

    it("forbids Section Q on a death discharge (400 M10_FORBIDDEN_SECTION_PRESENT)", async () => {
      const { app } = makeServer();
      const res = await post(
        app,
        dischargeBody({ dischargeReason: "death", data: { Q: { participation: "yes" } } }),
      );
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe("M10_FORBIDDEN_SECTION_PRESENT");
      await app.close();
    });

    it("accepts a death discharge without Section Q — on a CLOSED admission", async () => {
      // The active-admission guard is deliberately not applied to a Discharge RFA: by the time it is
      // captured the admission is closed by definition. This is the case that proves the exemption is
      // real rather than an accident of the seed always being active.
      const { app } = makeServer({ admissionStatus: "discharged" });
      const res = await post(app, dischargeBody({ dischargeReason: "death" }));
      expect(res.statusCode).toBe(201);
      expect(res.json<{ rfaKind: string }>().rfaKind).toBe("05_discharge");
      await app.close();
    });
  });
});

// ── #48 — "no data" is not 100% ────────────────────────────────────────────────────────────────────
describe("M10 — #48 the HQRP compliance dashboard distinguishes no-data from a perfect score", () => {
  it("returns null rates and the count pair when nothing has been measured", async () => {
    // The seeded fixture has one OPEN schedule and one MISSED SFV, so no rate has a denominator: the
    // HOPE rate counts completed+expired windows, the SFV rate counts completed+missed... which the
    // seeded `missed` row DOES populate. Only the HOPE and submission rates are genuinely empty here.
    // Every one of these used to fall back to 1 — a compliance officer was shown 100% on-time for an
    // agency that had never closed a single timepoint window.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hope/dashboard/compliance",
      headers: COMPLIANCE,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hopeOnTimeRate).toBeNull();
    expect(body.hopeOnTimeCounts).toEqual({ onTime: 0, total: 0 });
    // F-058 — the denominator is TERMINAL batches only, so of the two seeded submissions only the
    // `rejected` one counts; the `queued` one has no acceptance outcome yet. It used to be 2.
    expect(body.submissionAcceptanceRate).not.toBe(1);
    expect(body.submissionAcceptanceCounts.total).toBe(1);
    await app.close();
  });
});

describe("GAP-124 — draft writes apply the discipline floor and regenerate is scoped", () => {
  it("a chaplain holding hope.timepoint.write is 403 on PUT draft and PATCH answers", async () => {
    const { app } = makeServer();
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/hope/assessments/${SIGNED_A}`,
      headers: CHAPLAIN,
      payload: { data: {} },
    });
    expect(put.statusCode).toBe(403);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/hope/assessments/${SIGNED_A}/answers`,
      headers: CHAPLAIN,
      payload: { operations: [] },
    });
    expect(patch.statusCode).toBe(403);
    await app.close();
  });

  it("regenerate-schedules is denied for an admission outside the actor's scope", async () => {
    const { app } = makeServer({ isInCaseload: async () => false });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/hope/admin/regenerate-schedules",
      headers: RN,
      payload: { admissionId: ADMISSION },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-182 — the org-wide HOPE worklists are narrowed to the caller's caseload", () => {
  it("GET /hope/sfv returns only caseload patients' rows to a non-org-wide role", async () => {
    const { app } = makeServer({ caseload: [PATIENT] });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/sfv", headers: RN });
    expect(res.statusCode).toBe(200);
    expect(res.json().sfvs).toHaveLength(1);
    await app.close();
  });

  it("GET /hope/sfv hides a patient who is not on the caller's caseload", async () => {
    const { app } = makeServer({ caseload: [] });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/sfv", headers: RN });
    expect(res.statusCode).toBe(200);
    expect(res.json().sfvs).toHaveLength(0);
    await app.close();
  });

  it("an org-wide scope role (medical_director) sees the whole worklist with an empty caseload", async () => {
    const { app } = makeServer({ caseload: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hope/sfv",
      headers: MEDICAL_DIRECTOR,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sfvs).toHaveLength(1);
    await app.close();
  });

  it("fails closed when the caseload cannot be resolved", async () => {
    const { app } = makeServer({ caseloadFails: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/hope/sfv", headers: RN });
    expect(res.statusCode).toBe(200);
    expect(res.json().sfvs).toHaveLength(0);
    await app.close();
  });
});

// ── R-01 — SFV completion is bound to the URL admission (and so to the caller's caseload) ─────────────────
// `hope.scope` evaluates the URL admission only, and the body's `triggeringAssessmentId` is in no guard
// target. The service used to find the SFV by that id alone, so a clinician whose caseload was P2/A2 could
// complete P1's SFV through `/admissions/A2/hope/sfv`.
describe("R-01 — recordSfv is bound to the URL admission", () => {
  const BOGUS_TRIGGER = "99999999-9999-4999-8999-999999999999";
  const resolveBothAdmissions: ResolveAdmissionPatient = async (_organizationId, admissionId) => {
    if (admissionId === ADMISSION) return { patientId: PATIENT };
    return admissionId === ADMISSION_2 ? { patientId: PATIENT_2 } : null;
  };
  /** The attacker's caseload is PATIENT_2 / ADMISSION_2 only; the open SFV belongs to PATIENT / ADMISSION. */
  const attackerServer = () =>
    makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: resolveBothAdmissions,
      isInCaseload: async ({ patientId }) => patientId === PATIENT_2,
    });
  /** The broadest caller: every admission is in scope, so ONLY the binding can refuse a mismatch. */
  const broadServer = () =>
    makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: resolveBothAdmissions,
      isInCaseload: async () => true,
    });
  const sfvBody = (triggeringAssessmentId: string) => ({
    triggeringAssessmentId,
    targetDate: NOW,
    authorDiscipline: "RN",
    data: SFV_DATA,
    attestationConfirmed: true,
  });
  const postSfvTo = (
    app: ReturnType<typeof makeServer>["app"],
    admissionId: string,
    triggeringAssessmentId: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${admissionId}/hope/sfv`,
      headers: RN,
      payload: sfvBody(triggeringAssessmentId),
    });
  const codeOf = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;
  const messageShape = (res: { json(): { error?: { message?: string } } }) =>
    (res.json().error?.message ?? "").replace(/[0-9a-f-]{36}/g, "<id>");

  it("a clinician on P2/A2 cannot complete P1's SFV through their own admission (409 M10_SFV_NO_TRIGGER)", async () => {
    const { app, backend } = attackerServer();
    const before = (await backend.listPatientAssessments(ORG, PATIENT)).assessments.length;
    const res = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_SFV_NO_TRIGGER");
    // Nothing was written: the victim's SFV is still open and no RFA-04 row exists for either patient.
    expect((await backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    expect((await backend.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(before);
    expect((await backend.listPatientAssessments(ORG, PATIENT_2)).assessments).toHaveLength(0);
    // The response never discloses the victim's patient id.
    expect(JSON.stringify(res.json())).not.toContain(PATIENT);
    await app.close();
  });

  it("an out-of-admission SFV id answers exactly like a nonexistent one (no existence oracle)", async () => {
    const { app } = attackerServer();
    const foreign = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);
    const bogus = await postSfvTo(app, ADMISSION_2, BOGUS_TRIGGER);
    expect(foreign.statusCode).toBe(bogus.statusCode);
    expect(codeOf(foreign)).toBe(codeOf(bogus));
    expect(messageShape(foreign)).toBe(messageShape(bogus));
    await app.close();
  });

  it("a caller who can reach every admission still gets 409 for a mismatched (admission, SFV) pair", async () => {
    const { app, backend } = broadServer();
    const res = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("M10_SFV_NO_TRIGGER");
    expect((await backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    await app.close();
  });

  it("probing other admissions' SFVs is limited per actor: the answers within the limit are unchanged, the next request is a 429 that never reaches the service", async () => {
    const PROBES_ALLOWED = 3;
    const limiter = createRouteRateLimit({
      store: createInMemoryRateLimitStore(),
      limit: { perUser: PROBES_ALLOWED, perOrg: 100, windowMs: 60_000, failMode: "open" },
      keyPrefix: "test-sfv-completion",
    });
    const { app, backend } = makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: resolveBothAdmissions,
      isInCaseload: async (q) => q.patientId === PATIENT_2,
      sfvCompletionRateLimit: limiter,
    });
    const recordSfv = vi.spyOn(backend, "recordSfv");
    const absent = await postSfvTo(app, ADMISSION_2, BOGUS_TRIGGER);
    const foreign = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);
    const again = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);

    // Byte-identical for an absent and a foreign SFV, as without the limiter.
    expect([absent.statusCode, foreign.statusCode, again.statusCode]).toEqual([409, 409, 409]);
    expect(messageShape(foreign)).toBe(messageShape(absent));
    expect(codeOf(foreign)).toBe(codeOf(absent));
    const refused = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);

    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(recordSfv).toHaveBeenCalledTimes(PROBES_ALLOWED);
    await app.close();
  });

  it("the limiter sits after the scope guards: a caller refused by scope (404) never spends the budget", async () => {
    const limiter = createRouteRateLimit({
      store: createInMemoryRateLimitStore(),
      limit: { perUser: 1, perOrg: 100, windowMs: 60_000, failMode: "open" },
      keyPrefix: "test-sfv-completion-scope",
    });
    const { app, backend } = makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: resolveBothAdmissions,
      isInCaseload: async () => false,
      sfvCompletionRateLimit: limiter,
    });
    const recordSfv = vi.spyOn(backend, "recordSfv");

    const first = await postSfvTo(app, ADMISSION, TRIGGER_P1);
    const second = await postSfvTo(app, ADMISSION, TRIGGER_P1);

    expect([first.statusCode, second.statusCode]).toEqual([404, 404]);
    expect(recordSfv).not.toHaveBeenCalled();
    await app.close();
  });

  it("an already-completed SFV on another admission still answers NO_TRIGGER, never ALREADY_COMPLETED", async () => {
    const { app } = broadServer();
    expect((await postSfvTo(app, ADMISSION, TRIGGER_P1)).statusCode).toBe(201);
    const foreign = await postSfvTo(app, ADMISSION_2, TRIGGER_P1);
    expect(codeOf(foreign)).toBe("M10_SFV_NO_TRIGGER");
    // The owning admission is told the truth.
    expect(codeOf(await postSfvTo(app, ADMISSION, TRIGGER_P1))).toBe("M10_SFV_ALREADY_COMPLETED");
    await app.close();
  });

  it("matches the triggering assessment id case-insensitively, as the DB backend's uuid comparison does", async () => {
    const { app } = broadServer();
    const res = await postSfvTo(app, ADMISSION, TRIGGER_P1.toUpperCase());
    expect(res.statusCode).toBe(201);
    expect(res.json().admissionId).toBe(ADMISSION);
    await app.close();
  });

  it("the legitimate pair completes (201) and the row carries the SFV's own patient and admission", async () => {
    const { app } = broadServer();
    const res = await postSfvTo(app, ADMISSION, TRIGGER_P1);
    expect(res.statusCode).toBe(201);
    expect(res.json().admissionId).toBe(ADMISSION);
    expect(res.json().patientId).toBe(PATIENT);
    expect(res.json().rfaKind).toBe("04_sfv");
    await app.close();
  });

  it("a non-UUID triggeringAssessmentId is a 422 at the boundary, not a 500 from a uuid cast", async () => {
    const { app } = broadServer();
    for (const bad of ["not-a-uuid", "1", "' OR 1=1 --"]) {
      const res = await postSfvTo(app, ADMISSION, bad);
      expect(res.statusCode).toBe(422);
    }
    await app.close();
  });
});

// ── R-05 — signing is an attested, step-up-gated, AI-blocked act (POST /sign AND the SFV route) ───────────
describe("R-05 — HOPE record signature needs an attestation, a fresh step-up and a human", () => {
  const STALE = (headers: Record<string, string>) => ({ ...headers, "x-test-step-up": "false" });
  const codeOf = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;
  const draftOf = async (ctx: ReturnType<typeof makeServer>) => {
    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    expect(rec.statusCode).toBe(201);
    return rec.json() as { id: string; version: number };
  };
  const sign = (
    ctx: ReturnType<typeof makeServer>,
    id: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${id}/sign`,
      headers,
      payload,
    });
  const sfvBody = (over: Record<string, unknown> = {}) => ({
    triggeringAssessmentId: TRIGGER_P1,
    targetDate: NOW,
    authorDiscipline: "RN",
    data: SFV_DATA,
    attestationConfirmed: true,
    ...over,
  });
  const postSfv = (
    ctx: ReturnType<typeof makeServer>,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers,
      payload,
    });
  const sfvServer = () => makeServer({ openSfvForPatientOne: true });

  describe("POST /hope/assessments/:id/sign", () => {
    for (const [label, extra] of [
      ["an absent attestation", {}],
      ["an explicitly unconfirmed attestation", { attestationConfirmed: false }],
    ] as const) {
      it(`refuses ${label} (422) and leaves the draft untouched; a valid retry then signs`, async () => {
        const ctx = makeServer();
        const draft = await draftOf(ctx);
        const res = await sign(ctx, draft.id, RN, { ifVersion: draft.version, ...extra });
        expect(res.statusCode).toBe(422);
        const after = await ctx.backend.getAssessment(ORG, draft.id);
        expect(after.status).toBe("draft");
        expect(after.version).toBe(draft.version);
        const retry = await sign(ctx, draft.id, RN, {
          ifVersion: draft.version,
          attestationConfirmed: true,
        });
        expect(retry.statusCode).toBe(200);
        await ctx.app.close();
      });
    }

    it("a stale step-up is 403 STEP_UP_REQUIRED and the row is unchanged; a fresh step-up signs", async () => {
      const ctx = makeServer();
      const draft = await draftOf(ctx);
      const payload = { ifVersion: draft.version, attestationConfirmed: true };
      const stale = await sign(ctx, draft.id, STALE(RN), payload);
      expect(stale.statusCode).toBe(403);
      expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
      expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
      expect((await sign(ctx, draft.id, RN, payload)).statusCode).toBe(200);
      await ctx.app.close();
    });

    it("an active break-glass grant does not satisfy the step-up", async () => {
      const ctx = makeServer();
      const draft = await draftOf(ctx);
      setBreakGlassChecker(() => ({ eventId: "bg-1" }));
      const res = await sign(ctx, draft.id, STALE(RN), {
        ifVersion: draft.version,
        attestationConfirmed: true,
      });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe("STEP_UP_REQUIRED");
      expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
      await ctx.app.close();
    });

    it("a caller denied by discipline is never told to step up", async () => {
      const ctx = makeServer();
      const draft = await draftOf(ctx);
      const wrongDiscipline = await sign(ctx, draft.id, STALE(LPN), {
        ifVersion: draft.version,
        attestationConfirmed: true,
      });
      expect(wrongDiscipline.statusCode).toBe(403);
      expect(codeOf(wrongDiscipline)).not.toBe("STEP_UP_REQUIRED");
      await ctx.app.close();
    });

    it("a caller outside the patient's caseload is never told to step up", async () => {
      let inCaseload = true; // the draft is authored while on the caseload, then the caseload moves on
      const ctx = makeServer({ isInCaseload: async () => inCaseload });
      const draft = await draftOf(ctx);
      inCaseload = false;
      const res = await sign(ctx, draft.id, STALE(RN), {
        ifVersion: draft.version,
        attestationConfirmed: true,
      });
      expect(res.statusCode).toBe(404);
      expect(codeOf(res)).not.toBe("STEP_UP_REQUIRED");
      await ctx.app.close();
    });

    it("an AI principal cannot sign (403) and the draft is untouched", async () => {
      const ctx = makeServer();
      const draft = await draftOf(ctx);
      const res = await sign(
        ctx,
        draft.id,
        { ...RN, "x-test-actor-kind": "ai_agent" },
        { ifVersion: draft.version, attestationConfirmed: true },
      );
      expect(res.statusCode).toBe(403);
      expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
      await ctx.app.close();
    });
  });

  describe("POST /admissions/:admissionId/hope/sfv (the second signing path)", () => {
    for (const [label, over] of [
      ["an absent attestation", { attestationConfirmed: undefined }],
      ["an explicitly unconfirmed attestation", { attestationConfirmed: false }],
    ] as const) {
      it(`refuses ${label} (422), the SFV stays open; a valid retry then completes`, async () => {
        const ctx = sfvServer();
        const res = await postSfv(ctx, RN, sfvBody(over));
        expect(res.statusCode).toBe(422);
        expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
        expect((await postSfv(ctx, RN, sfvBody())).statusCode).toBe(201);
        await ctx.app.close();
      });
    }

    it("a stale step-up is 403 STEP_UP_REQUIRED and the SFV stays open; a fresh step-up completes", async () => {
      const ctx = sfvServer();
      const stale = await postSfv(ctx, STALE(RN), sfvBody());
      expect(stale.statusCode).toBe(403);
      expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      expect((await postSfv(ctx, RN, sfvBody())).statusCode).toBe(201);
      await ctx.app.close();
    });

    it("an active break-glass grant does not satisfy the step-up", async () => {
      const ctx = sfvServer();
      setBreakGlassChecker(() => ({ eventId: "bg-1" }));
      const res = await postSfv(ctx, STALE(RN), sfvBody());
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe("STEP_UP_REQUIRED");
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      await ctx.app.close();
    });

    it("a caller denied by discipline or by caseload is never told to step up", async () => {
      const ctx = sfvServer();
      const wrongDiscipline = await postSfv(ctx, STALE(MEDICAL_DIRECTOR), sfvBody());
      expect(wrongDiscipline.statusCode).toBe(403);
      expect(codeOf(wrongDiscipline)).not.toBe("STEP_UP_REQUIRED");
      await ctx.app.close();
      const outside = makeServer({ openSfvForPatientOne: true, isInCaseload: async () => false });
      const outOfScope = await postSfv(outside, STALE(RN), sfvBody());
      expect(outOfScope.statusCode).toBe(404);
      expect(codeOf(outOfScope)).not.toBe("STEP_UP_REQUIRED");
      await outside.app.close();
    });

    it("an SFV override whose justification names a patient is a 422 and the SFV stays open", async () => {
      const ctx = sfvServer();
      const text = "Visit was late; patient 900-12-3456 was in hospital, approved by the lead";
      const res = await postSfv(
        ctx,
        ADMIN_OVERRIDER,
        sfvBody({ adminOverride: true, adminOverrideJustification: text }),
      );
      expect(res.statusCode).toBe(422);
      expect(codeOf(res)).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.body).not.toContain("900-12-3456");
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      await ctx.app.close();
    });

    it("an AI principal cannot complete an SFV (403) and the SFV stays open", async () => {
      const ctx = sfvServer();
      const res = await postSfv(ctx, { ...RN, "x-test-actor-kind": "ai_agent" }, sfvBody());
      expect(res.statusCode).toBe(403);
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      await ctx.app.close();
    });
  });
});

// ── The workflow state is scoped to the URL admission (a re-admitted patient has several) ──────────
// `getWorkflowState` used to load SFVs by PATIENT, so the capture workspace, which reads the workflow state
// and posts an SFV's `triggeringAssessmentId` to the URL admission, handed a re-admitted patient's FIRST
// admission's SFV to the SECOND admission's URL: a 409 M10_SFV_NO_TRIGGER since the R-01 binding.
describe("the workflow state lists only the URL admission's own SFVs", () => {
  const resolveBoth: ResolveAdmissionPatient = async (_organizationId, admissionId) =>
    admissionId === ADMISSION || admissionId === ADMISSION_2 ? { patientId: PATIENT } : null;
  const readmitted = () => makeServer({ readmission: true, resolveAdmissionPatient: resolveBoth });
  const stateOf = (app: ReturnType<typeof makeServer>["app"], admissionId: string) =>
    app.inject({ method: "GET", url: `/api/v1/admissions/${admissionId}/hope`, headers: RN });

  it("each admission of the same patient sees its own SFV and none of the other's", async () => {
    const { app } = readmitted();
    const first = (await stateOf(app, ADMISSION)).json();
    const second = (await stateOf(app, ADMISSION_2)).json();
    expect(first.sfvs.map((s: { id: string }) => s.id)).toEqual([SFV_SEEDED]);
    expect(second.sfvs.map((s: { id: string }) => s.id)).toEqual([SFV_READMIT]);
    await app.close();
  });

  it("the SFV the re-admission's workspace shows completes through that admission (201, not NO_TRIGGER)", async () => {
    const { app } = readmitted();
    const state = (await stateOf(app, ADMISSION_2)).json();
    const sfv = state.sfvs[0] as { triggeringAssessmentId: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION_2}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: sfv.triggeringAssessmentId,
        targetDate: NOW,
        authorDiscipline: "RN",
        data: SFV_DATA,
        attestationConfirmed: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().admissionId).toBe(ADMISSION_2);
    await app.close();
  });
});

// ── The SFV's patient must be the admission's ────────────────────────────────────────────────────
describe("recordSfv refuses an SFV whose patient is not the URL admission's", () => {
  it("a mispaired SFV answers 409 M10_SFV_NO_TRIGGER, stays open and writes no RFA-04", async () => {
    const ctx = makeServer({ mispairedSfv: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: TRIGGER_MISPAIRED,
        targetDate: NOW,
        authorDiscipline: "RN",
        data: SFV_DATA,
        attestationConfirmed: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("M10_SFV_NO_TRIGGER");
    expect((await ctx.backend.getSfv(ORG, SFV_MISPAIRED)).status).toBe("open");
    expect((await ctx.backend.listPatientAssessments(ORG, PATIENT_2)).assessments).toHaveLength(0);
    await ctx.app.close();
  });
});

describe("recordSfv on an admission the slice cannot project (fails closed like the DB backend)", () => {
  it("answers 422 M10_ADMISSION_PROJECTION_GAP, not 'no SFV obligation', and writes no RFA-04", async () => {
    const unknownAdmission = "99999999-9999-4999-8999-999999999999";
    // `hope.scope` resolves it (the caller may reach it); only the slice's own M6 stand-in cannot project it.
    const ctx = makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: async () => ({ patientId: PATIENT }),
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${unknownAdmission}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: TRIGGER_P1,
        targetDate: NOW,
        authorDiscipline: "RN",
        data: SFV_DATA,
        attestationConfirmed: true,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("M10_ADMISSION_PROJECTION_GAP");
    expect((await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(1);
    await ctx.app.close();
  });
});

describe("recordSfv when the M6 admission seam is down (the slice answers like the DB backend)", () => {
  it("is a retryable 503 DEGRADED, never 'no SFV obligation' and never the data-gap 422", async () => {
    const unknownAdmission = "99999999-9999-4999-8999-999999999998";
    const ctx = makeServer({
      openSfvForPatientOne: true,
      resolveAdmissionPatient: async () => ({ patientId: PATIENT }),
      unavailableAdmissions: [unknownAdmission],
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${unknownAdmission}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: TRIGGER_P1,
        targetDate: NOW,
        authorDiscipline: "RN",
        data: SFV_DATA,
        attestationConfirmed: true,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DEGRADED");
    // The DB backend's generic text: the caller is not told which component is down.
    expect(res.json().error.message).not.toMatch(/M6|admission seam/i);
    expect(res.json().error.message).toContain(
      "a dependency this request needs is temporarily unavailable",
    );
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    await ctx.app.close();
  });
});

describe("recording a timepoint needs a real calendar date (never rolled forward)", () => {
  it.each([
    ["an Apr 31 (a JS Date would roll it to May 1)", "2026-04-31T09:00:00.000Z"],
    ["a Feb 30", "2026-02-30T09:00:00.000Z"],
    ["a timestamp with no offset (read in the server's local time)", "2026-06-07T09:00:00"],
  ])("refuses %s with 422 and records nothing", async (_label, targetDate) => {
    const ctx = makeServer();
    const before = (await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments.length;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: { rfaKind: "02_huv1", targetDate, authorDiscipline: "RN", data: {} },
    });

    expect(res.statusCode).toBe(422);
    expect((await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(
      before,
    );
    await ctx.app.close();
  });
});

describe("the other date-time inputs M10 stores or announces need a real calendar date too", () => {
  const BAD = ["2026-02-30T10:00:00Z", "2026-06-07T10:00:00", "9999-12-31T23:59:59-14:00"];

  it.each(BAD)(
    "mark-uploaded refuses submittedAt %s with 422 and leaves the batch packaged",
    async (submittedAt) => {
      const ctx = makeServer({ packagedSubmission: true });

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/hope/submissions/${SUB_PACKAGED}/mark-uploaded`,
        headers: RN,
        payload: { submittedAt },
      });

      expect(res.statusCode).toBe(422);
      expect((await ctx.backend.getSubmission(ORG, SUB_PACKAGED)).status).toBe("packaged");
      await ctx.app.close();
    },
  );

  it("mark-uploaded still accepts a real instant with an explicit offset", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/mark-uploaded`,
      headers: RN,
      payload: { submittedAt: "2026-06-07T10:00:00-07:00" },
    });

    expect(res.statusCode).toBe(200);
    await ctx.app.close();
  });

  it.each(BAD)("the validation read refuses submissionDate %s with 422", async (submissionDate) => {
    const ctx = makeServer();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/hope/assessments/${SIGNED_A}/validation?submissionDate=${encodeURIComponent(submissionDate)}`,
      headers: RN,
    });

    expect(res.statusCode).toBe(422);
    await ctx.app.close();
  });
});

describe("the operator-typed submission references: a charset in the schema, patient identifiers refused by the route", () => {
  // An SSN with area 9xx is never issued (the synthetic-identifier rule); the charset admits it, so the route's screen must refuse it.
  const SYNTHETIC_SSN = "900-12-3456";
  const REFUSED = [
    ["an SSN-shaped value", SYNTHETIC_SSN],
    ["markup", "<b>ref</b>"],
    ["a line break", "ref\nline"],
    ["an empty string", ""],
  ] as const;
  const markUploaded = (ctx: ReturnType<typeof makeServer>, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/mark-uploaded`,
      headers: RN,
      payload,
    });
  const importResult = (ctx: ReturnType<typeof makeServer>, reportReference: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/results`,
      headers: RN,
      payload: { reportReference, results: [{ assessmentId: SIGNED_A, status: "accepted" }] },
    });

  it.each(REFUSED)(
    "mark-uploaded refuses an iqiesSubmissionReference that is %s with 422, echoes none of it, and leaves the batch packaged",
    async (_label, iqiesSubmissionReference) => {
      const ctx = makeServer({ packagedSubmission: true });

      const res = await markUploaded(ctx, { iqiesSubmissionReference });

      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain(SYNTHETIC_SSN);
      expect((await ctx.backend.getSubmission(ORG, SUB_PACKAGED)).status).toBe("packaged");
      await ctx.app.close();
    },
  );

  it.each(REFUSED)(
    "the results import refuses a reportReference that is %s with 422 and echoes none of it (before the batch is even looked at)",
    async (_label, reportReference) => {
      const ctx = makeServer({ packagedSubmission: true });

      const res = await importResult(ctx, reportReference);

      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain(SYNTHETIC_SSN);
      await ctx.app.close();
    },
  );

  it("an ordinary reference passes both screens: mark-uploaded stores it, the import reaches the batch (409: a packaged batch has no result to record)", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const reached = await importResult(ctx, "FVR-2026_06: run #1/a.b");
    const marked = await markUploaded(ctx, { iqiesSubmissionReference: "UP-2026/06 #12" });

    expect(reached.statusCode).toBe(409);
    expect(marked.statusCode).toBe(200);
    await ctx.app.close();
  });

  it("a null or absent reference is nothing to screen", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await markUploaded(ctx, { iqiesSubmissionReference: null });

    expect(res.statusCode).toBe(200);
    await ctx.app.close();
  });

  it.each([
    ["only spaces", "      "],
    ["a leading space", " UP-1"],
    ["129 characters", "a".repeat(129)],
  ])(
    "a reference that is %s is refused by the schema (422) on both routes",
    async (_label, reference) => {
      const ctx = makeServer({ packagedSubmission: true });

      expect((await markUploaded(ctx, { iqiesSubmissionReference: reference })).statusCode).toBe(
        422,
      );
      expect((await importResult(ctx, reference)).statusCode).toBe(422);
      await ctx.app.close();
    },
  );

  it("a 128-character reference is the longest accepted", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await markUploaded(ctx, { iqiesSubmissionReference: "a".repeat(128) });

    expect(res.statusCode).toBe(200);
    await ctx.app.close();
  });
});

describe("the CMS result-row tokens: a format in the schema, patient identifiers refused by the route", () => {
  const SYNTHETIC_SSN = "900-12-3456";
  const SYNTHETIC_MBI = "1EG4TE5MK73";
  /** A uuid whose hex digits spell an MBI window: the MBI screen alone would refuse it. */
  const MBI_SHAPED_UUID = "1ac1ac1a-a110-4000-8000-000000000000";
  const importRows = (ctx: ReturnType<typeof makeServer>, results: Record<string, unknown>[]) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/results`,
      headers: RN,
      payload: { results },
    });
  const row = (token: Record<string, unknown>) => ({ assessmentId: SIGNED_A, ...token });

  it.each([
    ["status", { status: SYNTHETIC_SSN }],
    ["outcome", { outcome: `Run ${SYNTHETIC_SSN}` }],
    ["code", { code: SYNTHETIC_SSN }],
    ["itemCode", { itemCode: SYNTHETIC_MBI }],
    ["iqiesRecordId", { iqiesRecordId: SYNTHETIC_SSN }],
    ["message", { message: `Edit failed for ${SYNTHETIC_SSN}` }],
  ])(
    "an identifier-shaped %s is refused with a static 422 that names the field, never the value",
    async (key, token) => {
      const ctx = makeServer({ packagedSubmission: true });

      const res = await importRows(ctx, [row({ status: "accepted" }), row(token)]);

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.json().error.details).toEqual([
        expect.objectContaining({ field: `results.1.${key}` }),
      ]);
      expect(res.body).not.toContain(SYNTHETIC_SSN);
      expect(res.body).not.toContain(SYNTHETIC_MBI);
      await ctx.app.close();
    },
  );

  it.each([
    ["a non-uuid assessmentId", { assessmentId: SYNTHETIC_SSN }, "assessmentId", SYNTHETIC_SSN],
    ["a calendar date in a code", { code: "1950-03-12" }, "code", "1950"],
    ["a phone number in a record id", { iqiesRecordId: "555-867-5309" }, "iqiesRecordId", "867"],
  ])(
    "%s is refused as a patient identifier (422, field named, value not echoed)",
    async (_label, token, key, forbiddenFragment) => {
      const ctx = makeServer({ packagedSubmission: true });

      const res = await importRows(ctx, [row(token)]);

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.json().error.details).toEqual([
        expect.objectContaining({ field: `results.0.${key}` }),
      ]);
      const { correlationId, ...stableErrorEnvelope } = res.json().error;
      expect(correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      const errorText = JSON.stringify(stableErrorEnvelope);
      expect(errorText).not.toContain(forbiddenFragment);
      await ctx.app.close();
    },
  );

  it.each([
    ["markup", "<b>x</b>"],
    ["a quote", `E"1`],
    ["a line break", "E1\nE2"],
    ["only spaces", "   "],
    ["a leading space", " E1"],
    ["an inner space (a name or an MRN)", "Jane Q Example"],
    ["an MRN with a space", "MRN 00123456"],
    ["a slash date", "03/12/1950"],
    ["a name and a slash date", "Smith John 03/12/1950"],
    ["65 characters", "E".repeat(65)],
  ])("a code that is %s is refused by the schema (422)", async (_label, code) => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await importRows(ctx, [row({ code })]);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await ctx.app.close();
  });

  it.each([
    ["info", "info"],
    ["moderate", "moderate"],
    ["an MBI", SYNTHETIC_MBI],
    ["a padded severity", "error "],
  ])("a severity of %s is outside the closed set (422)", async (_label, severity) => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await importRows(ctx, [row({ severity })]);

    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(SYNTHETIC_MBI);
    await ctx.app.close();
  });

  it.each([["warning"], ["ERROR"], ["Fatal"], [""]])(
    "the severity %j passes (the closed set, any case, or empty)",
    async (severity) => {
      const ctx = makeServer({ packagedSubmission: true });

      // Past the schema and the screens: a packaged batch is refused for its status (409), not its fields.
      expect((await importRows(ctx, [row({ severity })])).statusCode).toBe(409);
      await ctx.app.close();
    },
  );

  it.each([
    ["a NUL in a message", { message: "edit\u0000zzmarker" }, "INVALID_CHARACTERS"],
    ["a lone surrogate in a message", { message: "edit \uD83D zzmarker" }, "INVALID_CHARACTERS"],
    // An assessment id is spelt with a uuid's characters (and blanks): anything else is the schema's own refusal.
    ["a NUL in an assessmentId", { assessmentId: "abc\u0000zzmarker" }, "INVALID"],
    ["a name as an assessmentId", { assessmentId: "Jane Q zzmarker" }, "INVALID"],
  ])("%s is a static 422, never a database error", async (_label, fields, detail) => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await importRows(ctx, [fields]);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].code).toBe(detail);
    expect(res.body).not.toContain("zzmarker");
    await ctx.app.close();
  });

  it("an assessmentId with a trailing carriage return (a CRLF-split CSV) is a blank, as the importer reads it", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await importRows(ctx, [{ assessmentId: `${SIGNED_A}\r` }]);

    expect(res.statusCode).toBe(409); // past the schema and the screens: a packaged batch refuses the import for its status
    await ctx.app.close();
  });

  it("a body over 3 MiB is a 413 in the standard error envelope, before it is parsed", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/submissions/${SUB_PACKAGED}/results`,
      headers: { ...RN, "content-type": "application/json" },
      payload: `{"reportReference":"${"a".repeat(3 * 1024 * 1024)}"}`,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    });
    await ctx.app.close();
  });

  it("the largest legitimate import (2000 rows with every field at its limit) is under the body limit and is read", async () => {
    const ctx = makeServer({ packagedSubmission: true });
    const full = {
      assessmentId: SIGNED_A,
      status: "s".repeat(64),
      result: "r".repeat(64),
      outcome: "o".repeat(64),
      severity: "warning",
      code: "c".repeat(64),
      itemCode: "i".repeat(64),
      iqiesRecordId: "q".repeat(64),
      message: "m".repeat(40),
    };
    const results = Array.from({ length: 2000 }, () => full);
    expect(JSON.stringify({ results }).length).toBeLessThan(3 * 1024 * 1024);

    const res = await importRows(ctx, results);

    expect(res.statusCode).toBe(409); // past the body limit, the schema and the screens: a packaged batch refuses it for its status
    await ctx.app.close();
  });

  it("a status phrase may carry commas, semicolons and parentheses (a code may not)", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const phrase = await importRows(ctx, [
      row({ status: "received, pending review (2 notes); ok" }),
    ]);
    const code = await importRows(ctx, [row({ code: "E1, E2" })]);

    expect(phrase.statusCode).toBe(409); // past the schema: the batch is only `packaged`
    expect(code.statusCode).toBe(422);
    await ctx.app.close();
  });

  it("the codes, ids and prose CMS sends still pass, a uuid record id is not read as an MBI, and a blank cell names nothing", async () => {
    const ctx = makeServer({ packagedSubmission: true });

    const res = await importRows(ctx, [
      row({
        status: "Accepted with warnings",
        severity: "ERROR",
        code: "-3015",
        itemCode: "J2051A",
        iqiesRecordId: "ERR-0012",
        message:
          "Item A0050 (Enter Type of Record) must be 1, 2 or 3.\n\tCheck the admission date.",
      }),
      row({ iqiesRecordId: MBI_SHAPED_UUID }),
      row({ code: "A0050" }),
      { assessmentId: MBI_SHAPED_UUID, iqiesRecordId: "" },
    ]);

    // Past both layers: the batch is only `packaged`, so the import is refused for its status (409), not its fields.
    expect(res.statusCode).toBe(409);
    await ctx.app.close();
  });
});

describe("an SFV completion needs a real calendar date", () => {
  it.each([
    ["Feb 30 (a JS Date would roll it to Mar 2)", "2026-02-30T00:00:00.000Z"],
    ["Apr 31", "2026-04-31T09:00:00.000Z"],
    ["a non-leap Feb 29", "2026-02-29T09:00:00.000Z"],
  ])("refuses %s with 422 and writes nothing", async (_label, targetDate) => {
    const ctx = makeServer({ openSfvForPatientOne: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: TRIGGER_P1,
        targetDate,
        authorDiscipline: "RN",
        data: SFV_DATA,
        attestationConfirmed: true,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(targetDate.slice(0, 10));
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    expect((await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(1);
    await ctx.app.close();
  });
});

// ── No J2053 content, no completion ──────────────────────────────────────────────────────────────
// A completion with no J2053 answers used to insert the signed RFA-04 and flip the SFV to `completed`;
// the J2053 answer write then returned silently, so the SFV closed with nothing behind it.
describe("an SFV completion needs its J2053 follow-up content (nothing is written otherwise)", () => {
  const withoutH = {
    J: {
      J2053: Object.fromEntries(["A", "B", "C", "D", "E", "F", "G"].map((l) => [`J2053${l}`, "1"])),
    },
  };
  const blankItem = { J: { J2053: { ...SFV_DATA.J.J2053, J2053C: "   " } } };
  const post = (
    ctx: ReturnType<typeof makeServer>,
    data: unknown,
    over: Record<string, unknown> = {},
  ) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers: RN,
      payload: {
        triggeringAssessmentId: TRIGGER_P1,
        targetDate: NOW,
        authorDiscipline: "RN",
        data,
        attestationConfirmed: true,
        ...over,
      },
    });
  const rfa04Count = async (ctx: ReturnType<typeof makeServer>) =>
    (await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments.filter(
      (a: { rfaKind: string }) => a.rfaKind === "04_sfv",
    ).length;

  for (const [label, data] of [
    ["no J section at all", {}],
    ["a J2051-only payload", huv1Body().data],
    ["a J2053 block missing J2053H", withoutH],
    ["a blank J2053 item", blankItem],
  ] as const) {
    it(`refuses ${label}: 422 M10_SFV_COMPLETION_INCOMPLETE, no RFA-04, the SFV stays open`, async () => {
      const ctx = makeServer({ openSfvForPatientOne: true });
      const res = await post(ctx, data);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("M10_SFV_COMPLETION_INCOMPLETE");
      expect(await rfa04Count(ctx)).toBe(0);
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      expect((await post(ctx, SFV_DATA)).statusCode).toBe(201); // complete content then completes it
      await ctx.app.close();
    });
  }

  // The in-memory twin used to insert the signed RFA-04 BEFORE the completion guards ran and never
  // rolled it back, so every refused completion left an orphan signed row (the DB's tx rolls it back).
  it("a refusal by a completion guard (past due without an override) leaves no RFA-04 row", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });
    const late = await post(ctx, SFV_DATA, { targetDate: "2026-07-01T00:00:00.000Z" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("M10_SFV_PAST_DUE");
    expect(await rfa04Count(ctx)).toBe(0);
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    await ctx.app.close();
  });

  it("a repeat completion (already completed) leaves exactly one RFA-04 row", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });
    expect((await post(ctx, SFV_DATA)).statusCode).toBe(201);
    const again = await post(ctx, SFV_DATA);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("M10_SFV_ALREADY_COMPLETED");
    expect(await rfa04Count(ctx)).toBe(1);
    await ctx.app.close();
  });
});

// ── The service enforces the attestation itself, and the route reads it strictly ────────────────────────────────────
describe("the attestation is enforced below the route and is strictly the boolean true", () => {
  const draftOf = async (ctx: ReturnType<typeof makeServer>) => {
    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: RN,
      payload: huv1Body(),
    });
    return rec.json() as { id: string; version: number };
  };
  const sfvPayload = (attestationConfirmed: unknown) => ({
    triggeringAssessmentId: TRIGGER_P1,
    targetDate: NOW,
    authorDiscipline: "RN",
    data: SFV_DATA,
    attestationConfirmed,
  });

  it("recordSfv and signTimepoint refuse a direct call with no attestation (422, nothing written)", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });
    const draft = await draftOf(ctx);
    const { attestationConfirmed: _omitted, ...noAttestation } = sfvPayload(true);
    await expect(
      ctx.backend.recordSfv(ORG, "rn_1", ADMISSION, noAttestation),
    ).rejects.toMatchObject({ code: "M10_ATTESTATION_REQUIRED", statusCode: 422 });
    await expect(
      ctx.backend.recordSfv(ORG, "rn_1", ADMISSION, {
        ...noAttestation,
        attestationConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "M10_ATTESTATION_REQUIRED" });
    await expect(
      ctx.backend.signTimepoint(ORG, "rn_1", draft.id, { ifVersion: draft.version }),
    ).rejects.toMatchObject({ code: "M10_ATTESTATION_REQUIRED", statusCode: 422 });
    await expect(ctx.backend.signTimepoint(ORG, "rn_1", draft.id)).rejects.toMatchObject({
      code: "M10_ATTESTATION_REQUIRED",
    });
    expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    await ctx.app.close();
  });

  // TypeBox's Value.Convert (run by `parse` before Check) turns "true" / "TRUE" / 1 / "1" into `true`.
  for (const coerced of ["true", "TRUE", 1, "1"] as const) {
    it(`a coerced attestation (${JSON.stringify(coerced)}) is refused on POST /sign and POST /hope/sfv`, async () => {
      const ctx = makeServer({ openSfvForPatientOne: true });
      const draft = await draftOf(ctx);
      const sign = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/hope/assessments/${draft.id}/sign`,
        headers: RN,
        payload: { ifVersion: draft.version, attestationConfirmed: coerced },
      });
      expect(sign.statusCode).toBe(422);
      expect(sign.json().error.code).toBe("M10_ATTESTATION_REQUIRED");
      expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
      const sfv = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
        headers: RN,
        payload: sfvPayload(coerced),
      });
      expect(sfv.statusCode).toBe(422);
      expect(sfv.json().error.code).toBe("M10_ATTESTATION_REQUIRED");
      expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
      await ctx.app.close();
    });
  }
});

// ── The REAL step_up_recent predicate on the two signing routes (the suites above stub it) ─────────
describe("hope.timepoint.sign and hope.sfv.record resolve step-up through the real M3 predicate", () => {
  const FRESH = "sess-fresh";
  const STALE = "sess-stale";
  const session = (sessionId: string, lastStepUpAt: Date) => ({
    providerEntityIds: [],
    locationIds: [],
    sessionClass: "staff" as const,
    portalAccountId: null,
    sessionPatientId: null,
    sessionId,
    userId: "rn_1",
    membershipId: "rn_1",
    organizationId: ORG,
    roles: ["rn"],
    lastStepUpAt,
    lastStepUpFactor: "webauthn" as const,
  });
  beforeEach(() => {
    __resetSeamsForTest();
    const { store } = createInMemorySessionContextStore([
      session(FRESH, new Date(Date.now() - 60_000)), // inside the 300s floor
      session(STALE, new Date(Date.now() - 10 * 60_000)), // past it
    ]);
    registerIdentitySeams({ sessions: store });
  });
  afterEach(() => __resetSeamsForTest());

  const as = (sessionId?: string): Record<string, string> => ({
    ...RN,
    "x-test-step-up": "true", // the stub's header: it must NOT be what decides here
    ...(sessionId ? { "x-test-session": sessionId } : {}),
  });
  const codeOf = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;

  it("POST /sign: a stale or absent session is 403 STEP_UP_REQUIRED; a fresh one signs", async () => {
    const ctx = makeServer({ realStepUp: true });
    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/timepoints`,
      headers: as(FRESH),
      payload: huv1Body(),
    });
    const draft = rec.json() as { id: string; version: number };
    const payload = { ifVersion: draft.version, attestationConfirmed: true };
    const url = `/api/v1/hope/assessments/${draft.id}/sign`;
    for (const sessionId of [STALE, undefined]) {
      const res = await ctx.app.inject({ method: "POST", url, headers: as(sessionId), payload });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe("STEP_UP_REQUIRED");
    }
    expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
    expect(
      (await ctx.app.inject({ method: "POST", url, headers: as(FRESH), payload })).statusCode,
    ).toBe(200);
    await ctx.app.close();
  });

  it("POST /hope/sfv: a stale or absent session is 403 STEP_UP_REQUIRED; a fresh one completes", async () => {
    const ctx = makeServer({ realStepUp: true, openSfvForPatientOne: true });
    const url = `/api/v1/admissions/${ADMISSION}/hope/sfv`;
    const payload = {
      triggeringAssessmentId: TRIGGER_P1,
      targetDate: NOW,
      authorDiscipline: "RN",
      data: SFV_DATA,
      attestationConfirmed: true,
    };
    for (const sessionId of [STALE, undefined]) {
      const res = await ctx.app.inject({ method: "POST", url, headers: as(sessionId), payload });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe("STEP_UP_REQUIRED");
    }
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    expect(
      (await ctx.app.inject({ method: "POST", url, headers: as(FRESH), payload })).statusCode,
    ).toBe(201);
    await ctx.app.close();
  });
});

describe("the attestation wording version (the slice enforces it like the DB backend)", () => {
  const sfvPayload = (over: Record<string, unknown> = {}) => ({
    triggeringAssessmentId: TRIGGER_P1,
    targetDate: NOW,
    authorDiscipline: "RN",
    data: SFV_DATA,
    attestationConfirmed: true,
    ...over,
  });
  const postSfvWith = (ctx: ReturnType<typeof makeServer>, over: Record<string, unknown>) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/hope/sfv`,
      headers: RN,
      payload: sfvPayload(over),
    });

  it("an SFV completion that names an older wording is a 409 M10_ATTESTATION_STALE and writes nothing", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });

    const res = await postSfvWith(ctx, { attestationVersion: "1999-01-01.0" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("M10_ATTESTATION_STALE");
    expect(res.json().error.message).toMatch(/reload/i);
    expect((await ctx.backend.getSfv(ORG, SFV_OPEN_P1)).status).toBe("open");
    expect((await ctx.backend.listPatientAssessments(ORG, PATIENT)).assessments).toHaveLength(1);
    await ctx.app.close();
  });

  it.each([
    ["names the current version", { attestationVersion: HOPE_ATTESTATION_VERSION }],
    ["names no version", {}],
  ])("an SFV completion that %s completes", async (_label, over) => {
    const ctx = makeServer({ openSfvForPatientOne: true });

    const res = await postSfvWith(ctx, over);

    expect(res.statusCode).toBe(201);
    await ctx.app.close();
  });

  it("a sign that names an older wording is a 409 and leaves the draft a draft", async () => {
    const ctx = makeServer();
    const draft = await ctx.backend.recordTimepoint(ORG, "rn_1", ADMISSION, {
      rfaKind: "02_huv1",
      targetDate: NOW,
      authorDiscipline: "RN",
      data: {},
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/hope/assessments/${draft.id}/sign`,
      headers: RN,
      payload: { ifVersion: 1, attestationConfirmed: true, attestationVersion: "1999-01-01.0" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("M10_ATTESTATION_STALE");
    expect((await ctx.backend.getAssessment(ORG, draft.id)).status).toBe("draft");
    await ctx.app.close();
  });
});

describe("GET /hope/sfv filtered by triggeringAssessmentId", () => {
  const listSfvs = (ctx: ReturnType<typeof makeServer>, query: string) =>
    ctx.app.inject({ method: "GET", url: `/api/v1/hope/sfv${query}`, headers: RN });

  it("returns only the SFV that assessment triggered; an unknown id is an empty list, not a 404", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });

    const filtered = await listSfvs(ctx, `?triggeringAssessmentId=${TRIGGER_P1}`);
    const unknown = await listSfvs(
      ctx,
      "?triggeringAssessmentId=99999999-9999-4999-8999-999999999999",
    );
    const unfiltered = await listSfvs(ctx, "");

    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().sfvs.map((x: { id: string }) => x.id)).toEqual([SFV_OPEN_P1]);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().sfvs).toEqual([]);
    // Not vacuous: the unfiltered worklist holds more than the one SFV.
    expect(unfiltered.json().sfvs.length).toBeGreaterThan(1);
    await ctx.app.close();
  });

  it("matches the uuid case-insensitively, as the database's uuid equality does", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });

    const res = await listSfvs(ctx, `?triggeringAssessmentId=${TRIGGER_P1.toUpperCase()}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().sfvs.map((x: { id: string }) => x.id)).toEqual([SFV_OPEN_P1]);
    await ctx.app.close();
  });

  it("a value that is not a uuid is a 422", async () => {
    const ctx = makeServer({ openSfvForPatientOne: true });

    const res = await listSfvs(ctx, "?triggeringAssessmentId=not-a-uuid");

    expect(res.statusCode).toBe(422);
    await ctx.app.close();
  });
});
