// apps/backend/__tests__/assessment-routes.test.ts — M9-T05 route-inventory + §4.6 RBAC gating + §4.7
// `discipline_can_record_scale` / `cosigner_role_match` ABAC + §2.3 optimistic-concurrency smoke tests
// (M9 spec §4.1, §4.4, §4.6, §4.7).
//
// Exercises M9's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerAssessmentRoutes() mounts the §4.1 inventory over the in-memory
// assessment backend. The REAL Authorization Contract gates every route on the §4.6 keys; a header-auth
// shim populates request.context. The three predicates M9 owns are registered into a FRESH ABAC registry
// over the slice's resolver. Covers: RBAC gating (2xx with key, 403 without), the discipline floor
// (chaplain → AIMS 403), the §10 record pipeline (license/discipline gates), LPN cosignature (RN ∧
// not-self-recorder), the §2.3 If-Match version race (412 STALE_VERSION), significant-change ack, and
// (GAP-015) caseload scoping (§4.1 `caseload_or_scope` / M9-owned `assessment.scope`).
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
  buildAssessmentAbacPredicates,
  createInMemoryAssessmentBackend,
  registerAssessmentRoutes,
} from "../src/modules/09-assessments/index";
// GAP-015: M9's routes bind the SHARED `caseload_or_scope` predicate (M7-owned) by name for the 9 routes
// that already carry `patientId`; a fresh per-test registry (the GAP-011 pattern, see below) needs it
// registered too, or every one of those routes would fail-closed-deny in this file. `caseload_or_scope`'s
// `patientId` branch (the only one M9 ever exercises) never calls the M7 resolver, so a stub that's never
// invoked is safe here — this is a test-only import (dependency-cruiser's module-boundary rule scopes each
// module's own codePaths, not `__tests__`; `clinical-consumer-contracts.test.ts` already cross-imports
// M7+M8 the same way).
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // assessments-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PPS_BY_LPN = "90000000-0000-4000-8000-000000000001";
const PAINAD_ACTIVE = "90000000-0000-4000-8000-000000000002";
const PPS_B = "90000000-0000-4000-8000-000000000003";
const PPS_BY_RN = "90000000-0000-4000-8000-000000000004";
const CHANGE_OPEN = "e0000000-0000-4000-8000-0000000000aa";

const NOW = "2026-06-20T12:00:00.000Z";

const PERMISSION_SEED = [
  {
    userId: "rn_1",
    permissions: [
      "assessment.read",
      "assessment.author",
      "assessment.amend",
      "assessment.cosign",
      "assessment.read_trend",
      "assessment.acknowledge_change",
      "assessment.read_summary",
    ],
  },
  { userId: "rn_2", permissions: ["assessment.read", "assessment.cosign"] },
  { userId: "chap_1", permissions: ["assessment.author"] },
  { userId: "viewer_1", permissions: ["assessment.read"] },
  {
    userId: "admin_1",
    permissions: [
      "assessment.license_read",
      "assessment.license_admin",
      "assessment.policy_read",
      "assessment.policy_admin",
    ],
  },
];

type ExtraSeed = { assessments?: any[]; consents?: any[] };
type IsInCaseload = (q: {
  organizationId: string;
  userId: string;
  patientId: string;
}) => Promise<boolean>;

function makeServer(extra: ExtraSeed = {}, options: { isInCaseload?: IsInCaseload } = {}) {
  const backend = createInMemoryAssessmentBackend({
    now: () => NOW,
    admissions: [
      {
        id: ADMISSION,
        organizationId: ORG,
        patientId: PATIENT,
        status: "active",
        activatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    licenses: [
      {
        id: "c0000000-0000-4000-8000-000000000001",
        organizationId: ORG,
        scaleType: "pps",
        vendor: "Victoria Hospice",
        effectiveDate: "2026-01-01",
        expiresAt: "2027-01-01",
        seats: null,
      },
    ],
    consents: extra.consents ?? [],
    assessments: [
      {
        id: PPS_BY_LPN,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        scaleType: "pps",
        capturedByDiscipline: "lpn",
        recordedByUserId: "lpn_1",
        cosignRequired: true,
        score: 60,
        capturedAt: "2026-06-19T10:00:00.000Z",
      },
      {
        id: PAINAD_ACTIVE,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        scaleType: "painad",
        capturedByDiscipline: "rn",
        recordedByUserId: "rn_1",
        score: 4,
        version: 1,
        capturedAt: "2026-06-18T10:00:00.000Z",
      },
      {
        id: PPS_BY_RN,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        scaleType: "pps",
        capturedByDiscipline: "rn",
        recordedByUserId: "rn_1",
        cosignRequired: true,
        score: 60,
        capturedAt: "2026-06-17T10:00:00.000Z",
      },
      {
        id: PPS_B,
        organizationId: ORG_B,
        patientId: PATIENT,
        admissionId: ADMISSION,
        scaleType: "pps",
        capturedByDiscipline: "rn",
        recordedByUserId: "rn_1",
      },
      ...(extra.assessments ?? []),
    ],
    significantChanges: [
      {
        id: CHANGE_OPEN,
        organizationId: ORG,
        patientId: PATIENT,
        assessmentId: PAINAD_ACTIVE,
        priorAssessmentId: null,
        ruleId: "pps_drop_20_in_14d",
        status: "open",
        severity: "high",
      },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
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
  registerEffectivePermissionResolver(grantStore.store);

  // GAP-015: a FRESH registry per server/test — reusing the shared module-level `abacRegistry` would
  // silently pin every test after the first to whatever backend the FIRST test's registration closed
  // over (`registerPredicateIdempotent`'s same-source-string reboot check can't tell two DIFFERENT
  // in-memory backends apart). See the GAP-011 memory note for the full mechanism. `caseload_or_scope`
  // is M7-owned but 9 of M9's routes bind it by name, so it's registered here too (over a resolver that's
  // never called — see the import comment above).
  const isInCaseload = options.isInCaseload ?? (async () => true);
  const registry = createPredicateRegistry();
  const m9Predicates = buildAssessmentAbacPredicates({ resolver: backend.resolver, isInCaseload });
  const m7Predicates = buildCarePlanAbacPredicates({
    resolver: { loadPlan: async () => null, loadProblem: async () => null },
    isInCaseload,
  });
  registry.register("caseload_or_scope", m7Predicates.caseload_or_scope);
  for (const [name, fn] of Object.entries(m9Predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAssessmentRoutes(app, { service: backend.service });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "rn" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };

const painadBody = (over: Record<string, unknown> = {}) => ({
  admissionId: ADMISSION,
  scaleType: "painad",
  capturedAt: NOW,
  data: {
    breathing: 1,
    negativeVocalization: 1,
    facialExpression: 0,
    bodyLanguage: 0,
    consolability: 0,
  },
  ...over,
});
const ppsData = {
  ambulation: "full",
  activity: "normal",
  selfCare: "full",
  intake: "normal",
  consciousness: "full",
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

describe("M9-T05 — assessment routes (§4.1, §4.6 RBAC gating)", () => {
  it("POST /assessments records a scale for an eligible author (201, server-computed score)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: painadBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scaleType).toBe("painad");
    expect(res.json().score).toBe(2); // 1+1+0+0+0
    expect(res.json().id).toMatch(/^90000000-/);
  });

  it("rejects an author without the permission key (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: VIEWER,
      payload: painadBody(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("discipline floor: a chaplain recording AIMS is denied by ABAC (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: CHAPLAIN,
      payload: {
        admissionId: ADMISSION,
        scaleType: "aims",
        capturedAt: NOW,
        sudContext: false,
        data: { facialMuscles: 0 },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("M9-T05 — license + admission gates (§4.4)", () => {
  it("records a licensed scale (PPS) when the tenant has an active license (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: { admissionId: ADMISSION, scaleType: "pps", capturedAt: NOW, data: ppsData },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().score).toBe(90); // PPS v2: full/normal ⇒ 90 ("some disease"), never 100 in hospice
  });

  it("refuses a record against an unknown / inactive admission (422 INACTIVE_ADMISSION)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: painadBody({ admissionId: "44444444-4444-4444-8444-444444444444" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INACTIVE_ADMISSION");
  });
});

describe("M9-T05 — LPN cosignature (§7.4, §4.7 cosigner_role_match)", () => {
  it("an RN (not the recorder) cosigns an LPN-recorded PPS (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_LPN}/cosignatures`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().cosigned).toBe(true);
  });

  it("self-cosign is denied: the recorder cannot cosign their own row (ABAC 403)", async () => {
    const { app } = makeServer();
    // PPS_BY_RN was recorded by rn_1; rn_1 attempting to cosign it fails `cosigner_role_match` (no self-cosign).
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_RN}/cosignatures`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
    // A different eligible RN (not the recorder) may cosign the same row (201).
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_RN}/cosignatures`,
      headers: RN2,
      payload: { attestationConfirmed: true },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("a non-cosigner role is denied (no permission key → 403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_LPN}/cosignatures`,
      headers: CHAPLAIN,
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("M9-T05 — correction-of-record (§2.3 If-Match → STALE_VERSION)", () => {
  it("corrects the active row when If-Match matches the version (201, supersede)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments/${PAINAD_ACTIVE}/corrections`,
      headers: { ...RN, "if-match": "1" },
      payload: painadBody({ correctionReason: "transcription error on the original PAINAD score" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().correctsAssessmentId).toBe(PAINAD_ACTIVE);
    expect(res.json().version).toBe(2);
  });

  it("a stale If-Match version is a 412 STALE_VERSION", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments/${PAINAD_ACTIVE}/corrections`,
      headers: { ...RN, "if-match": "99" },
      payload: painadBody({ correctionReason: "transcription error on the original PAINAD score" }),
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("STALE_VERSION");
  });

  it("a missing If-Match is a 428 PRECONDITION_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments/${PAINAD_ACTIVE}/corrections`,
      headers: RN,
      payload: painadBody({ correctionReason: "transcription error on the original PAINAD score" }),
    });
    expect(res.statusCode).toBe(428);
  });
});

describe("M9-T05 — reads, trends, significant-change ack, admin", () => {
  it("GET latest returns the active row; cross-tenant id is a non-leaking 404", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/scales/painad/latest`,
      headers: RN,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().scaleType).toBe("painad");
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assessments/${PPS_B}`,
      headers: RN,
    });
    expect(cross.statusCode).toBe(404);
  });

  it("acknowledges an open significant-change event (open → acknowledged)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/significant-changes/${CHANGE_OPEN}/acknowledge`,
      headers: RN,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("acknowledged");
  });

  it("org_admin lists + registers a scale license (201)", async () => {
    const { app } = makeServer();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/scales/licenses",
      headers: ADMIN,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().licenses.length).toBe(1);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/scales/licenses",
      headers: ADMIN,
      payload: {
        scaleType: "fast",
        vendor: "Reisberg",
        effectiveDate: "2026-06-01",
        expiresAt: "2027-06-01",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("active");
  });

  it("a non-admin cannot read the license registry (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/scales/licenses",
      headers: RN,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── M9-T08 §9.3 security / authorization — SUD Part-2 disclosure-read gate (D10 / M09-F05 / ADR-0014 D1)
// + DPOA proxy-attribution write gate (§4.4). AIMS is a Phase-1 not-yet-scored scale, so the SUD rows are
// SEEDED (creation is never consent-blocked — the row's mere existence proves the write path persisted it
// with `sud_context=true`) and the gate is exercised on the READ/disclosure boundary, which is where Part 2
// attaches. Cross-tenant RLS-shape isolation is exercised live in rls-isolation.live.test.ts (§9.4).
describe("M9-T08 — §9.3 SUD Part-2 disclosure-read gate (D10 / M09-F05)", () => {
  const SUD_PAT_CONSENTED = "22222222-2222-4222-8222-222222222221";
  const SUD_PAT_NOCONSENT = "22222222-2222-4222-8222-222222222222";
  const AIMS_VISIBLE = "90000000-0000-4000-8000-0000000000a1";
  const AIMS_REDACTED = "90000000-0000-4000-8000-0000000000a2";

  const sudSeed = (): ExtraSeed => ({
    consents: [{ organizationId: ORG, patientId: SUD_PAT_CONSENTED, sudReleaseActive: true }],
    assessments: [
      {
        id: AIMS_VISIBLE,
        organizationId: ORG,
        patientId: SUD_PAT_CONSENTED,
        admissionId: ADMISSION,
        scaleType: "aims",
        capturedByDiscipline: "rn",
        recordedByUserId: "rn_1",
        sudContext: true,
        score: 4,
        scoreInterpretation: "AIMS 4",
        data: { facialMuscles: 1 },
        capturedAt: "2026-06-19T09:00:00.000Z",
      },
      {
        id: AIMS_REDACTED,
        organizationId: ORG,
        patientId: SUD_PAT_NOCONSENT,
        admissionId: ADMISSION,
        scaleType: "aims",
        capturedByDiscipline: "rn",
        recordedByUserId: "rn_1",
        sudContext: true,
        score: 4,
        scoreInterpretation: "AIMS 4",
        data: { facialMuscles: 1 },
        capturedAt: "2026-06-19T09:00:00.000Z",
      },
    ],
  });

  it("a non-consented read returns the redacted-shape row (redacted=true, empty data, null score) — never a hard block", async () => {
    const { app } = makeServer(sudSeed());
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${SUD_PAT_NOCONSENT}/assessments/${AIMS_REDACTED}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200); // the clinician sees "there IS an AIMS but you can't see it"
    const row = res.json();
    expect(row.redacted).toBe(true);
    expect(row.sudContext).toBe(true);
    expect(row.data).toEqual({});
    expect(row.score).toBeNull();
    expect(row.scoreInterpretation).toBeNull();
  });

  it("an active 42 CFR Part 2 release discloses the AIMS in full (redacted=false)", async () => {
    const { app } = makeServer(sudSeed());
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${SUD_PAT_CONSENTED}/assessments/${AIMS_VISIBLE}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const row = res.json();
    expect(row.redacted).toBe(false);
    expect(row.score).toBe(4);
    expect(row.data).toEqual({ facialMuscles: 1 });
  });

  it("latest() applies the same redaction projection for a non-consented SUD-context AIMS", async () => {
    const { app } = makeServer(sudSeed());
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${SUD_PAT_NOCONSENT}/scales/aims/latest`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redacted).toBe(true);
    expect(res.json().score).toBeNull();
  });

  it("series withholds the score of a non-consented SUD-context AIMS trend point", async () => {
    const { app } = makeServer(sudSeed());
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${SUD_PAT_NOCONSENT}/scales/aims/series?from=2026-06-01&to=2026-06-30`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const pts = res.json().points;
    expect(pts.length).toBe(1);
    expect(pts[0].score).toBeNull();
  });

  it("non-SUD scales are never redacted regardless of consent (PPS reads in full)", async () => {
    const { app } = makeServer(sudSeed());
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/scales/pps/latest`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redacted).toBe(false);
    expect(res.json().score).toBe(60);
  });
});

describe("M9-T08 — §9.3 DPOA proxy-attribution write gate (§4.4)", () => {
  const repBody = () => painadBody({ actingAs: "patient_representative" });

  it("a representative report without an active DPOA is refused (403 DPOA_CONSENT_REQUIRED)", async () => {
    const { app } = makeServer(); // no consent seeded for PATIENT
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: repBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("DPOA_CONSENT_REQUIRED");
  });

  it("a representative report with an active DPOA is accepted (201)", async () => {
    const { app } = makeServer({
      consents: [{ organizationId: ORG, patientId: PATIENT, dpoaActive: true }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: repBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().actingAs).toBe("patient_representative");
  });

  it("a self-attributed report needs no DPOA (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: painadBody({ actingAs: "self" }),
    });
    expect(res.statusCode).toBe(201);
  });
});

// ── GAP-015 — caseload scoping (§4.1 `caseload_or_scope` / M9-owned `assessment.scope`) ──────────────────
// Proves the wiring closes the gap: an RN outside the patient's caseload is denied a non-leaking 404 on
// every route class (patientId-keyed, assessmentId-keyed cosign, eventId-keyed acknowledge), and caseload
// membership restores access. `makeServer`'s default `isInCaseload` is permissive (`async () => true`) for
// every other describe block in this file — these tests are the only ones that override it.
describe("GAP-015 — caseload scoping", () => {
  it("GET the patient's assessment list denies an RN outside the caseload (404, non-leaking)", async () => {
    const { app } = makeServer({}, { isInCaseload: async () => false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST records a scale only for an RN whose caseload covers the patient (404 outside, 201 inside)", async () => {
    const outside = makeServer({}, { isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: painadBody(),
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer(
      {},
      { isInCaseload: async ({ patientId }) => patientId === PATIENT },
    );
    const allowed = await inside.app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: RN,
      payload: painadBody(),
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("an org-wide scope role (medical_director) reads a patient's assessments without caseload membership", async () => {
    const { app } = makeServer({}, { isInCaseload: async () => false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assessments`,
      headers: { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "medical_director" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("LPN cosignature (assessmentId-keyed assessment.scope): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({}, { isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_LPN}/cosignatures`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer(
      {},
      { isInCaseload: async ({ patientId }) => patientId === PATIENT },
    );
    const allowed = await inside.app.inject({
      method: "POST",
      url: `/api/v1/assessments/${PPS_BY_LPN}/cosignatures`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("significant-change acknowledge (eventId-keyed assessment.scope): denied outside caseload, allowed inside", async () => {
    const outside = makeServer({}, { isInCaseload: async () => false });
    const denied = await outside.app.inject({
      method: "POST",
      url: `/api/v1/significant-changes/${CHANGE_OPEN}/acknowledge`,
      headers: RN,
      payload: {},
    });
    expect(denied.statusCode).toBe(404);

    const inside = makeServer(
      {},
      { isInCaseload: async ({ patientId }) => patientId === PATIENT },
    );
    const allowed = await inside.app.inject({
      method: "POST",
      url: `/api/v1/significant-changes/${CHANGE_OPEN}/acknowledge`,
      headers: RN,
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });
});
