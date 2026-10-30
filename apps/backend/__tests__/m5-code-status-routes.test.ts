// apps/backend/__tests__/m5-code-status-routes.test.ts — ADR-0104: the M5 patient code-status routes
// (GET/POST /patients/:id/code-status, POST .../:entryId/entered-in-error). Route layer only: permission + the REAL
// `caseload_or_scope` predicate + validation + typed-error → HTTP mapping over an injected in-memory port. The Drizzle
// port (RLS, append-only grant, audit trigger, document-seam check) is proven live in `m5-code-status.live.test.ts`.
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
import {
  CodeStatusAlreadyEnteredInErrorError,
  CodeStatusEntryNotFoundError,
  CodeStatusPatientNotFoundError,
  CodeStatusSourceDocumentInvalidError,
  type CodeStatusView,
  type PatientCodeStatusPort,
} from "../src/modules/05-patient/code-status";
import { registerPatientCodeStatusRoutes } from "../src/modules/05-patient/routes/code-status-routes";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["rn"];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes = { ...request.context.attributes, membershipId: membership };
  }
}

const PERMISSION_SEED = [
  { userId: "md_1", permissions: ["patient.read", "patient.edit_code_status"] },
  { userId: "md_off", permissions: ["patient.read", "patient.edit_code_status"] },
  { userId: "rn_1", permissions: ["patient.read"] },
];
const CASELOAD = new Set([`${ORG}:md_1:${PATIENT}`, `${ORG}:rn_1:${PATIENT}`]);

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-membership": MEMBERSHIP };
const MD_NO_MEMBERSHIP = { "x-test-user": "md_1", "x-test-org": ORG };
const MD_OFF = { "x-test-user": "md_off", "x-test-org": ORG, "x-test-membership": MEMBERSHIP };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-membership": MEMBERSHIP };

const view = (over: Partial<CodeStatusView> = {}): CodeStatusView => ({
  id: ENTRY,
  patientId: PATIENT,
  codeStatus: "dnr",
  reason: "Patient and family chose DNR at the admission visit",
  sourceDocumentId: null,
  recordedByMembershipId: MEMBERSHIP,
  recordedAt: "2026-10-29T12:00:00.000Z",
  enteredInErrorAt: null,
  ...over,
});

interface Calls {
  set: { patientId: string; codeStatus: string; sourceDocumentId?: string; membershipId: string }[];
  eie: { entryId: string; reason: string }[];
}

function makeServer(port: Partial<PatientCodeStatusPort> = {}) {
  const calls: Calls = { set: [], eie: [] };
  const full: PatientCodeStatusPort = {
    async list() {
      return { current: view(), history: [view()] };
    },
    async set(_org, patientId, input, actor) {
      calls.set.push({
        patientId,
        codeStatus: input.codeStatus,
        sourceDocumentId: input.sourceDocumentId,
        membershipId: actor.membershipId,
      });
      return view({ codeStatus: input.codeStatus });
    },
    async enterInError(_org, _patientId, entryId, input) {
      calls.eie.push({ entryId, reason: input.reason });
      return view({ enteredInErrorAt: "2026-10-29T13:00:00.000Z" });
    },
    ...port,
  };
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSION_SEED.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
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
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientCodeStatusRoutes(app, { codeStatus: full });
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

const BODY = { codeStatus: "dnr", reason: "Patient and family chose DNR" };
const GET = (headers: Record<string, string>, id = PATIENT) => ({
  method: "GET" as const,
  url: `/api/v1/patients/${id}/code-status`,
  headers,
});
const SET = (headers: Record<string, string>, payload: unknown = BODY, id = PATIENT) => ({
  method: "POST" as const,
  url: `/api/v1/patients/${id}/code-status`,
  headers,
  payload: payload as Record<string, unknown>,
});
const EIE = (headers: Record<string, string>, payload: unknown = { reason: "wrong patient" }) => ({
  method: "POST" as const,
  url: `/api/v1/patients/${PATIENT}/code-status/${ENTRY}/entered-in-error`,
  headers,
  payload: payload as Record<string, unknown>,
});

describe("GET /patients/:id/code-status", () => {
  it("returns the current status and the history to any chart reader", async () => {
    const { app } = makeServer();
    const res = await app.inject(GET(RN));
    expect(res.statusCode).toBe(200);
    expect(res.json().current.codeStatus).toBe("dnr");
    expect(res.json().history).toHaveLength(1);
  });

  it("returns current: null when nothing is recorded (never a default Full Code)", async () => {
    const { app } = makeServer({
      async list() {
        return { current: null, history: [] };
      },
    });
    const res = await app.inject(GET(RN));
    expect(res.json()).toEqual({ current: null, history: [] });
  });

  it("404s a patient outside the caller's scope", async () => {
    const { app } = makeServer();
    expect((await app.inject(GET(MD_OFF))).statusCode).toBe(404);
  });

  it("404s when the port finds no such patient", async () => {
    const { app } = makeServer({
      async list() {
        return null;
      },
    });
    expect((await app.inject(GET(MD))).statusCode).toBe(404);
  });
});

describe("POST /patients/:id/code-status", () => {
  it("records the status as the acting membership and answers 201", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(SET(MD, { ...BODY, sourceDocumentId: DOC }));
    expect(res.statusCode).toBe(201);
    expect(calls.set).toEqual([
      { patientId: PATIENT, codeStatus: "dnr", sourceDocumentId: DOC, membershipId: MEMBERSHIP },
    ]);
  });

  it("refuses a reader without patient.edit_code_status", async () => {
    const { app, calls } = makeServer();
    expect((await app.inject(SET(RN))).statusCode).toBe(403);
    expect(calls.set).toHaveLength(0);
  });

  it("404s an editor outside the patient's scope", async () => {
    const { app } = makeServer();
    expect((await app.inject(SET(MD_OFF))).statusCode).toBe(404);
  });

  it("refuses a principal with no membership (the row records who)", async () => {
    const { app, calls } = makeServer();
    expect((await app.inject(SET(MD_NO_MEMBERSHIP))).statusCode).toBe(401);
    expect(calls.set).toHaveLength(0);
  });

  it.each([
    ["not_recorded is not a stored value", { ...BODY, codeStatus: "not_recorded" }],
    ["DNI alone is not a value", { ...BODY, codeStatus: "dni" }],
    ["a blank reason", { ...BODY, reason: "" }],
    ["a whitespace-only reason (trimmed to empty before the CHECK)", { ...BODY, reason: "   " }],
    ["a missing reason", { codeStatus: "dnr" }],
    ["a reason over 1000 chars", { ...BODY, reason: "x".repeat(1001) }],
    ["a non-uuid source document", { ...BODY, sourceDocumentId: "nope" }],
  ])("422s %s (VALIDATION_FAILED)", async (_name, payload) => {
    const { app, calls } = makeServer();
    expect((await app.inject(SET(MD, payload))).statusCode).toBe(422);
    expect(calls.set).toHaveLength(0);
  });

  it("422s a source document that is not this patient's directive", async () => {
    const { app } = makeServer({
      async set() {
        throw new CodeStatusSourceDocumentInvalidError();
      },
    });
    const res = await app.inject(SET(MD, { ...BODY, sourceDocumentId: DOC }));
    expect(res.statusCode).toBe(422);
  });

  it("404s when the port finds no such patient", async () => {
    const { app } = makeServer({
      async set() {
        throw new CodeStatusPatientNotFoundError();
      },
    });
    expect((await app.inject(SET(MD))).statusCode).toBe(404);
  });
});

describe("POST /patients/:id/code-status/:entryId/entered-in-error", () => {
  it("retracts an entry with a reason", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(EIE(MD));
    expect(res.statusCode).toBe(200);
    expect(calls.eie).toEqual([{ entryId: ENTRY, reason: "wrong patient" }]);
  });

  it("requires the reason", async () => {
    const { app } = makeServer();
    expect((await app.inject(EIE(MD, {}))).statusCode).toBe(422);
  });

  it("422s a whitespace-only reason", async () => {
    const { app, calls } = makeServer();
    expect((await app.inject(EIE(MD, { reason: "  \n " }))).statusCode).toBe(422);
    expect(calls.eie).toHaveLength(0);
  });

  it("refuses a reader", async () => {
    const { app } = makeServer();
    expect((await app.inject(EIE(RN))).statusCode).toBe(403);
  });

  it("409s an entry already entered in error", async () => {
    const { app } = makeServer({
      async enterInError() {
        throw new CodeStatusAlreadyEnteredInErrorError();
      },
    });
    expect((await app.inject(EIE(MD))).statusCode).toBe(409);
  });

  it("404s an unknown entry", async () => {
    const { app } = makeServer({
      async enterInError() {
        throw new CodeStatusEntryNotFoundError();
      },
    });
    expect((await app.inject(EIE(MD))).statusCode).toBe(404);
  });
});
