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
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { buildOutOfBandPayload, buildTimepointWindowAlert } from "@chartwarden/hope";
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
  // hope-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const pe = request.headers["x-test-pe"];
  request.context.providerEntityIds = typeof pe === "string" && pe.length > 0 ? pe.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const SIGNED_A = "90000000-0000-4000-8000-000000000010";
const SUB_REJECTED = "c0000000-0000-4000-8000-000000000001";
const SUB_QUEUED = "c0000000-0000-4000-8000-000000000002";
const SFV_SEEDED = "d0000000-0000-4000-8000-000000000001";
const NOW = "2026-06-08T12:00:00.000Z";

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
  } = {},
) {
  const backend = createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    // #45 — the M6 `AdmissionStatusReader` stand-in. `recordTimepoint` resolves the subject of the
    // record here instead of writing the `admissionId` into `patient_id`; an admission absent from this
    // map is a projection gap and the record is refused.
    admissionPatients: { [ADMISSION]: PATIENT },
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
  const predicates = buildHopeAbacPredicates({
    resolver: backend,
    isInCaseload: options.isInCaseload ?? (async () => true),
    resolveAdmissionPatient:
      options.resolveAdmissionPatient ??
      (async (_organizationId, admissionId) =>
        admissionId === ADMISSION ? { patientId: PATIENT } : null),
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, {
    service: backend,
    caseloadPatientIds: async () => {
      if (options.caseloadFails) throw new Error("caseload seam unavailable");
      return options.caseload ?? [PATIENT];
    },
  });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn", "x-test-pe": "pe_1" };
const ADMIN_OVERRIDER = {
  "x-test-user": "admin_1",
  "x-test-org": ORG,
  "x-test-roles": "rn",
  "x-test-pe": "pe_1",
};
const MEDICAL_DIRECTOR = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "medical_director",
};
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const LPN = { "x-test-user": "lpn_1", "x-test-org": ORG, "x-test-roles": "lpn", "x-test-pe": "pe_1" };
const LVN = { "x-test-user": "lvn_1", "x-test-org": ORG, "x-test-roles": "lvn", "x-test-pe": "pe_1" };
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
    data: huv1Body().data,
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
    expect((await postSfv(app, MEDICAL_DIRECTOR, triggeringAssessmentId, "MD")).statusCode).toBe(403);
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
