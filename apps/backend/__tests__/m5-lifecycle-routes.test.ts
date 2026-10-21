// apps/backend/__tests__/m5-lifecycle-routes.test.ts — GAP-018 / GAP-019 / GAP-012: the M5 §4.3 routes
// that were specified and never registered (status, deceased, PATCH, identifiers, caregivers, the match
// queue, unmerge, amendment list / staff inbox / statement). Route layer only: permission + the REAL
// `caseload_or_scope` predicate + a stub `step_up_recent` + validation + typed-error → HTTP mapping over
// an injected in-memory port. The Drizzle port is exercised by the pure-rule tests below and, on the
// Docker stack, by the live suite (not run here).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { IdentifierCipherUnboundError } from "../src/modules/05-patient/identifiers/identifier-cipher";
import { IdentifierNotRevealableError } from "../src/modules/05-patient/identifiers/sensitive-identifiers-db";
import {
  AmendmentNotDeniedError,
  type AmendmentRecord,
  IdentifierConflictError,
  InvalidStatusTransitionError,
  MatchReviewClosedError,
  type PatientLifecyclePort,
  PrimaryCaregiverExistsError,
  UnmergeWindowExpiredError,
  isAllowedManualTransition,
  isWithinUnmergeWindow,
} from "../src/modules/05-patient/patient-lifecycle";
import { registerPatientLifecycleRoutes } from "../src/modules/05-patient/routes/lifecycle-routes";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "pat-1";
const ALL = [
  "patient.read",
  "patient.edit",
  "patient.edit_identifiers",
  "patient.transition_status",
  "patient.record_death",
  "patient.match_review",
  "patient.merge",
  "patient.amend_review",
  "patient.amend_request_submit",
];
// GAP-010: the SSN keys are NOT part of ALL — a plain identifier editor holds neither.
const ALL_SSN = [...ALL, "phi.write_ssn", "phi.read_ssn"];
const SEED = [
  { userId: "admin_1", permissions: ALL_SSN },
  { userId: "nostep_1", permissions: ALL_SSN },
  { userId: "plain_1", permissions: ALL },
  { userId: "reader_1", permissions: ["patient.read"] },
  { userId: "off_1", permissions: ALL_SSN },
];
const CASELOAD = new Set([
  `${ORG}:admin_1:${PATIENT}`,
  `${ORG}:nostep_1:${PATIENT}`,
  `${ORG}:plain_1:${PATIENT}`,
  `${ORG}:reader_1:${PATIENT}`,
]);
const FRESH = new Set(["admin_1", "off_1", "plain_1"]);
const hdr = (u: string) => ({ "x-test-user": u, "x-test-org": ORG, "x-test-roles": "rn" });
const ADMIN = hdr("admin_1");
const NOSTEP = hdr("nostep_1");
const READER = hdr("reader_1");
const PLAIN = hdr("plain_1");
const OFF = hdr("off_1");

const amendment = (over: Partial<AmendmentRecord> = {}): AmendmentRecord => ({
  id: "am-1",
  patientId: PATIENT,
  scope: "demographic",
  rationale: "wrong dob",
  status: "pending",
  denialReason: null,
  statementOfDisagreement: null,
  receivedAt: "2026-10-01T00:00:00.000Z",
  decidedAt: null,
  slaDueAt: "2026-11-30T00:00:00.000Z",
  ...over,
});

function makeServer(over: Partial<PatientLifecyclePort> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    <K extends keyof PatientLifecyclePort>(name: K, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const port = {
    updateDemographics: rec("updateDemographics", { patientId: PATIENT, changed: ["dob"] }),
    transitionStatus: rec("transitionStatus", {
      patientId: PATIENT,
      fromStatus: "active",
      toStatus: "on_hold",
    }),
    recordDeath: rec("recordDeath", {
      patientId: PATIENT,
      status: "deceased",
      deceasedDate: "2026-10-01",
      alreadyDeceased: false,
    }),
    addIdentifier: rec("addIdentifier", { id: "i1", patientId: PATIENT, kind: "mbi" }),
    addSensitiveIdentifier: rec("addSensitiveIdentifier", {
      id: "i2",
      patientId: PATIENT,
      kind: "ssn",
      valueLast4: "6789",
      effectiveFrom: "2026-10-08",
    }),
    revealIdentifier: rec("revealIdentifier", { kind: "ssn", value: "123456789" }),
    listCaregivers: rec("listCaregivers", [{ id: "c1" }]),
    addCaregiver: rec("addCaregiver", { id: "c1" }),
    listMatchReviews: rec("listMatchReviews", [{ id: "r1" }]),
    mergeMatchReview: rec("mergeMatchReview", {
      reviewId: "r1",
      mergeId: "m1",
      sourcePatientId: "new",
      targetPatientId: "old",
    }),
    markNotAMatch: rec("markNotAMatch", { id: "r1", status: "not_a_match" }),
    unmerge: rec("unmerge", { mergeId: "m1", restoredStatus: "prospective" }),
    listAmendments: rec("listAmendments", [amendment()]),
    listPendingAmendments: rec("listPendingAmendments", [amendment()]),
    recordStatement: rec("recordStatement", amendment({ status: "denied" })),
    ...over,
  } as unknown as PatientLifecyclePort;

  const grantStore = createInMemoryEffectivePermissionStore(
    SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();
  const predicates = buildCarePlanAbacPredicates({
    resolver: {
      async loadPlan() {
        return null;
      },
      async loadProblem() {
        return null;
      },
      async loadVersion() {
        return null;
      },
    },
    async isInCaseload({ organizationId, userId, patientId }) {
      return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
    },
  });
  registerPredicateIdempotent("caseload_or_scope", predicates.caseload_or_scope);
  registerPredicateIdempotent("step_up_recent", (ctx: { userId?: string }) =>
    FRESH.has(String(ctx.userId)),
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientLifecycleRoutes(app, { lifecycle: port });
  return { app, calls };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

type Req = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers: Record<string, string>;
  payload?: Record<string, unknown>;
};
const req = (
  method: Req["method"],
  url: string,
  headers = ADMIN,
  payload?: Req["payload"],
): Req => ({
  method,
  url,
  headers,
  ...(payload ? { payload } : {}),
});

describe("pure lifecycle rules", () => {
  it("allows only the §2.4.1 manual edges", () => {
    expect(isAllowedManualTransition("active", "on_hold")).toBe(true);
    expect(isAllowedManualTransition("on_hold", "active")).toBe(true);
    expect(isAllowedManualTransition("discharged", "active")).toBe(true);
    expect(isAllowedManualTransition("deceased", "active")).toBe(false);
    expect(isAllowedManualTransition("merged", "active")).toBe(false);
    expect(isAllowedManualTransition("prospective", "discharged")).toBe(false);
  });
  it("bounds the unmerge window at 30 days", () => {
    const merged = new Date("2026-09-01T00:00:00Z");
    expect(isWithinUnmergeWindow(merged, new Date("2026-09-30T00:00:00Z"))).toBe(true);
    expect(isWithinUnmergeWindow(merged, new Date("2026-10-05T00:00:00Z"))).toBe(false);
  });
});

describe("PATCH /patients/:id", () => {
  it("applies a demographics patch for a caseload editor", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("PATCH", `/api/v1/patients/${PATIENT}`, ADMIN, { dob: "1950-01-02" }),
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args[2]).toEqual({ dob: "1950-01-02" });
    await app.close();
  });
  it("refuses an immutable / unknown field (mrn, status)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(req("PATCH", `/api/v1/patients/${PATIENT}`, ADMIN, { mrn: "X" }));
    expect(res.statusCode).toBe(422);
    const res2 = await app.inject(
      req("PATCH", `/api/v1/patients/${PATIENT}`, ADMIN, { status: "active" }),
    );
    expect(res2.statusCode).toBe(422);
    expect(calls).toHaveLength(0);
    await app.close();
  });
  it("404s off caseload and 403s without patient.edit", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject(req("PATCH", `/api/v1/patients/${PATIENT}`, OFF, { dob: "1950-01-02" })))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject(req("PATCH", `/api/v1/patients/${PATIENT}`, READER, { dob: "1950-01-02" })))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe("POST /patients/:id/status", () => {
  it("transitions and passes the actor", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/status`, ADMIN, { toStatus: "on_hold" }),
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args[3]).toBe("admin_1");
    await app.close();
  });
  it("refuses deceased/merged targets at the schema (they have their own paths)", async () => {
    const { app } = makeServer();
    for (const toStatus of ["deceased", "merged"]) {
      const res = await app.inject(
        req("POST", `/api/v1/patients/${PATIENT}/status`, ADMIN, { toStatus }),
      );
      expect(res.statusCode).toBe(422);
    }
    await app.close();
  });
  it("maps an illegal edge to 409", async () => {
    const { app } = makeServer({
      async transitionStatus() {
        throw new InvalidStatusTransitionError("deceased", "active");
      },
    });
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/status`, ADMIN, { toStatus: "active" }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("INVALID_STATUS_TRANSITION");
    await app.close();
  });
});

describe("POST /patients/:id/deceased", () => {
  it("records a death for a fresh step-up", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/deceased`, ADMIN, { deceasedDate: "2026-10-01" }),
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args[2]).toEqual({ deceasedDate: "2026-10-01" });
    await app.close();
  });
  it("rejects a stale session (step-up) before touching the port", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/deceased`, NOSTEP, { deceasedDate: "2026-10-01" }),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe("POST /patients/:id/identifiers/:identifierId/reveal (GAP-010)", () => {
  const url = `/api/v1/patients/${PATIENT}/identifiers/6f0f2d0e-9f5a-4f0e-8d0e-0a0a0a0a0a0a/reveal`;
  it("reveals for a phi.read_ssn holder on the chart with a fresh step-up, uncacheable", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(req("POST", url, ADMIN));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ kind: "ssn", value: "123456789" });
    expect(calls.map((c) => c.name)).toEqual(["revealIdentifier"]);
    await app.close();
  });
  it("refuses without phi.read_ssn (403), on a stale step-up, and off the chart (404)", async () => {
    const { app, calls } = makeServer();
    expect((await app.inject(req("POST", url, PLAIN))).statusCode).toBe(403);
    const stale = await app.inject(req("POST", url, NOSTEP));
    expect(stale.statusCode).toBeGreaterThanOrEqual(401);
    expect(stale.statusCode).toBeLessThan(500);
    expect(calls).toHaveLength(0);
    await app.close();
  });
  it("is a 404 for a holder who is not on the chart's caseload (no existence leak)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(req("POST", url, OFF));
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    await app.close();
  });
  it("maps a missing/destroyed key to 503 and an unrevealable row to 404", async () => {
    const unbound = makeServer({
      async revealIdentifier() {
        throw new IdentifierCipherUnboundError("open");
      },
    });
    expect((await unbound.app.inject(req("POST", url, ADMIN))).statusCode).toBe(503);
    await unbound.app.close();
    const gone = makeServer({
      async revealIdentifier() {
        throw new IdentifierNotRevealableError();
      },
    });
    expect((await gone.app.inject(req("POST", url, ADMIN))).statusCode).toBe(404);
    await gone.app.close();
  });
});

describe("POST /patients/:id/identifiers", () => {
  it("adds an MBI (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, ADMIN, {
        kind: "mbi",
        value: "1EG4TE5MK73",
      }),
    );
    expect(res.statusCode).toBe(201);
    await app.close();
  });
  it("refuses the MRN (immutable, 409) without calling the port", async () => {
    const { app, calls } = makeServer();
    const mrn = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, ADMIN, {
        kind: "mrn",
        value: "MRN-1",
      }),
    );
    expect(mrn.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
    await app.close();
  });
  // GAP-010 — SSN / state id are envelope-encrypted behind phi.write_ssn + a fresh step-up.
  it("stores an SSN for a phi.write_ssn holder with a fresh step-up and never echoes the value", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, ADMIN, {
        kind: "ssn",
        value: "123-45-6789",
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("123-45-6789");
    expect(res.body).not.toContain("123456789");
    expect(JSON.parse(res.body)).toMatchObject({ kind: "ssn", valueLast4: "6789" });
    expect(calls.map((c) => c.name)).toEqual(["addSensitiveIdentifier"]);
    await app.close();
  });
  it("refuses an SSN without phi.write_ssn (403) even for a patient.edit_identifiers holder", async () => {
    const { app, calls } = makeServer();
    for (const kind of ["ssn", "state_id"]) {
      const res = await app.inject(
        req("POST", `/api/v1/patients/${PATIENT}/identifiers`, PLAIN, {
          kind,
          value: "123456789",
          issuer: "TX",
        }),
      );
      expect(res.statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });
  it("refuses an SSN on a stale step-up before touching the port", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, NOSTEP, {
        kind: "ssn",
        value: "123456789",
      }),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toHaveLength(0);
    await app.close();
  });
  it("maps an unbound tenant key to 503 IDENTIFIER_CIPHER_UNBOUND (not 422, not a plaintext write)", async () => {
    const { app } = makeServer({
      async addSensitiveIdentifier() {
        throw new IdentifierCipherUnboundError("seal");
      },
    });
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, ADMIN, {
        kind: "ssn",
        value: "123456789",
      }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error?.code ?? JSON.parse(res.body).code).toBe(
      "IDENTIFIER_CIPHER_UNBOUND",
    );
    expect(res.body).not.toContain("123456789");
    await app.close();
  });
  it("a plain identifier kind does not need phi.write_ssn", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, PLAIN, {
        kind: "mbi",
        value: "1EG4TE5MK73",
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(calls.map((c) => c.name)).toEqual(["addIdentifier"]);
    await app.close();
  });
  it("maps a duplicate to 409", async () => {
    const { app } = makeServer({
      async addIdentifier() {
        throw new IdentifierConflictError("mbi");
      },
    });
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/identifiers`, ADMIN, {
        kind: "mbi",
        value: "1EG4TE5MK73",
      }),
    );
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("caregivers", () => {
  it("lists for a reader and 404s when the patient is absent", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject(req("GET", `/api/v1/patients/${PATIENT}/caregivers`, READER))).statusCode,
    ).toBe(200);
    await app.close();
    const missing = makeServer({
      async listCaregivers() {
        return null;
      },
    });
    expect(
      (await missing.app.inject(req("GET", `/api/v1/patients/${PATIENT}/caregivers`, READER)))
        .statusCode,
    ).toBe(404);
    await missing.app.close();
  });
  it("adds a caregiver (201) and maps a second primary to 409", async () => {
    const body = { firstName: "A", lastName: "B", relationship: "spouse", isPrimary: true };
    const { app } = makeServer();
    expect(
      (await app.inject(req("POST", `/api/v1/patients/${PATIENT}/caregivers`, ADMIN, body)))
        .statusCode,
    ).toBe(201);
    await app.close();
    const dup = makeServer({
      async addCaregiver() {
        throw new PrimaryCaregiverExistsError();
      },
    });
    expect(
      (await dup.app.inject(req("POST", `/api/v1/patients/${PATIENT}/caregivers`, ADMIN, body)))
        .statusCode,
    ).toBe(409);
    await dup.app.close();
  });
  it("validates the relationship enum", async () => {
    const { app } = makeServer();
    const res = await app.inject(
      req("POST", `/api/v1/patients/${PATIENT}/caregivers`, ADMIN, {
        firstName: "A",
        lastName: "B",
        relationship: "neighbor",
      }),
    );
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe("soft-duplicate review queue (§7.3)", () => {
  it("lists the open queue (default status open) for patient.match_review", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(req("GET", "/api/v1/patient-matches"));
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args[1]).toEqual({ status: "open", limit: 100 });
    await app.close();
  });
  it("403s the queue without patient.match_review", async () => {
    const { app } = makeServer();
    expect((await app.inject(req("GET", "/api/v1/patient-matches", READER))).statusCode).toBe(403);
    await app.close();
  });
  it("merges with a fresh step-up and refuses a stale one", async () => {
    const { app, calls } = makeServer();
    const body = { reason: "confirmed same person", fieldResolutions: {} };
    expect(
      (await app.inject(req("POST", "/api/v1/patient-matches/r1/merge", ADMIN, body))).statusCode,
    ).toBe(200);
    expect(calls).toHaveLength(1);
    const stale = await app.inject(req("POST", "/api/v1/patient-matches/r1/merge", NOSTEP, body));
    expect(stale.statusCode).toBeGreaterThanOrEqual(401);
    expect(calls).toHaveLength(1);
    await app.close();
  });
  it("maps a closed review to 409 and requires a merge reason", async () => {
    const { app } = makeServer({
      async mergeMatchReview() {
        throw new MatchReviewClosedError("r1", "merged");
      },
    });
    expect(
      (
        await app.inject(
          req("POST", "/api/v1/patient-matches/r1/merge", ADMIN, {
            reason: "confirmed same person",
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject(req("POST", "/api/v1/patient-matches/r1/merge", ADMIN, { reason: "x" })))
        .statusCode,
    ).toBe(422);
    await app.close();
  });
  it("marks not-a-match", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", "/api/v1/patient-matches/r1/not-a-match", ADMIN, { reason: "different people" }),
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.name).toBe("markNotAMatch");
    await app.close();
  });
});

describe("POST /patient-merges/:id/unmerge", () => {
  it("unmerges within the window with step-up", async () => {
    const { app } = makeServer();
    const res = await app.inject(
      req("POST", "/api/v1/patient-merges/m1/unmerge", ADMIN, { reason: "merged in error" }),
    );
    expect(res.statusCode).toBe(200);
    await app.close();
  });
  it("maps an expired window to 409", async () => {
    const { app } = makeServer({
      async unmerge() {
        throw new UnmergeWindowExpiredError("m1");
      },
    });
    const res = await app.inject(
      req("POST", "/api/v1/patient-merges/m1/unmerge", ADMIN, { reason: "merged in error" }),
    );
    expect(res.statusCode).toBe(409);
    await app.close();
  });
  it("refuses a stale session", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(
      req("POST", "/api/v1/patient-merges/m1/unmerge", NOSTEP, { reason: "merged in error" }),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe("amendments (GAP-012 backend)", () => {
  it("lists a patient's amendments and 404s off caseload", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject(req("GET", `/api/v1/patients/${PATIENT}/amendments`, READER))).statusCode,
    ).toBe(200);
    expect(
      (await app.inject(req("GET", `/api/v1/patients/${PATIENT}/amendments`, OFF))).statusCode,
    ).toBe(404);
    await app.close();
  });
  it("serves the staff inbox (pending by default) to patient.amend_review only", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(req("GET", "/api/v1/amendments"));
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(calls[0]?.args[1]).toEqual({ status: "pending", limit: 100 });
    expect((await app.inject(req("GET", "/api/v1/amendments", READER))).statusCode).toBe(403);
    await app.close();
  });
  it("records a statement of disagreement, 409 when the amendment was not denied", async () => {
    const { app } = makeServer();
    expect(
      (
        await app.inject(
          req("POST", "/api/v1/amendments/am-1/statement", ADMIN, { statement: "I disagree" }),
        )
      ).statusCode,
    ).toBe(200);
    await app.close();
    const notDenied = makeServer({
      async recordStatement() {
        throw new AmendmentNotDeniedError("am-1");
      },
    });
    expect(
      (
        await notDenied.app.inject(
          req("POST", "/api/v1/amendments/am-1/statement", ADMIN, { statement: "I disagree" }),
        )
      ).statusCode,
    ).toBe(409);
    await notDenied.app.close();
  });
});
