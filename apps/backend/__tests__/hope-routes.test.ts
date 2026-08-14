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
} from "@wardenx/auth";
import { buildOutOfBandPayload, buildTimepointWindowAlert } from "@wardenx/hope";
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
  { userId: "viewer_1", permissions: ["hope.schedule.read"] },
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
  options: { isInCaseload?: IsInCaseload; resolveAdmissionPatient?: ResolveAdmissionPatient } = {},
) {
  const backend = createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
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
  registerHopeRoutes(app, { service: backend });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn", "x-test-pe": "pe_1" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
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
      payload: { attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.status).toBe("signed");
    expect(body.j2051TriggerFired).toBe(true);
    expect(body.j2051MaxSeverity).toBe("moderate");

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
      payload: { attestationConfirmed: true },
    });
    expect(signed.json().j2051TriggerFired).toBe(false);
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
    expect((await backend.getAssessment(ORG, SIGNED_A)).status).toBe("superseded");

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
    for (const url of [
      "/api/v1/hope/schedules",
      "/api/v1/hope/submissions",
      "/api/v1/hope/dashboard/compliance",
    ]) {
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

describe("M10-T06 — §4.9.1 out-of-band PHI strip", () => {
  it("buildOutOfBandPayload carries no patient-name token for a timepoint-window alert", () => {
    const alert = buildTimepointWindowAlert({
      scheduleId: SCHEDULE,
      rfaKind: "02_huv1",
      patientId: PATIENT,
      patientDisplayName: "Jane Doe",
      windowState: "closing",
      hoursUntilDeadline: 12,
      ctaUrl: "https://app/wardenx/hope/123",
    });
    const oob = buildOutOfBandPayload(alert);
    expect(oob.body).not.toContain("Jane");
    expect(oob.body).not.toContain("02_huv1");
    expect(oob.ctaUrl).toBe("https://app/wardenx/hope/123");
  });
});
