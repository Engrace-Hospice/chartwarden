// apps/backend/__tests__/consent-routes-abac.test.ts — GAP-109: the M39 §4.1 / §4.11 per-route ABAC.
//
// Before this fix every consent route was gated on `requirePermission` (+ step-up) only, so any
// `consent.read` holder could read ANY patient's Part 2 releases and DPOA records, and any
// author/sign/revoke holder could act on any patient. This suite drives the REAL Authorization Contract
// through Fastify `inject` with the REAL `caseload_or_scope` resolver (M7's factory) over an in-memory
// caseload, and pins, per route family:
//   - patient-keyed routes: off-caseload ⇒ 404 (existence non-leak); org-wide scope roles pass;
//   - consent-keyed routes: the consent's PATIENT comes from the STORED row (never the request);
//   - the drafter / compliance / privacy / bereavement rules the spec names;
//   - break-glass opens READS only, never a write;
//   - the SERVICE layer enforces the same rules independently of the route guards, and an internal
//     caller must carry the explicit typed system-actor marker (a role string is never a bypass).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import {
  type ConsentRecordView,
  ConsentRouteError,
  createInMemoryConsentRouteService,
} from "@chartwarden/consent";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";
import {
  CONSENT_SYSTEM_ACTOR,
  type ConsentStaffActor,
  createScopedConsentRouteService,
  registerConsentAbacPredicates,
  registerConsentRoutes,
} from "../src/modules/39-consent/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0)
    request.context.attributes = { ...request.context.attributes, membershipId: membership };
}

const ORG = "org_a";
const HOUR_MS = 60 * 60 * 1000;
type TestShift = {
  status: string;
  shiftStartsAt: string;
  shiftEndsAt: string;
  primaryOnCallMembershipId: string | null;
  backupMembershipId: string | null;
};
/** What the M19 `OnCallProvider.activeShiftsAt` seam answers; `null` ⇒ the seam throws (an outage). */
let ONCALL_SHIFTS: readonly TestShift[] | null = [];
const shift = (over: Partial<TestShift> = {}): TestShift => ({
  status: "active",
  shiftStartsAt: new Date(Date.now() - HOUR_MS).toISOString(),
  shiftEndsAt: new Date(Date.now() + HOUR_MS).toISOString(),
  primaryOnCallMembershipId: "m_off",
  backupMembershipId: null,
  ...over,
});
const P_ON = "pat-on";
const P_OFF = "pat-off";
const C_ON = "con-on";
const C_OFF = "con-off";
const ALL_PERMS = [
  "consent.read_catalog",
  "consent.read",
  "consent.read_history",
  "consent.read_eval_audit",
  "consent.author",
  "consent.sign",
  "consent.revoke",
  "consent.manage_overlay",
  "consent.admin_re_render",
  "consent.cascade_admin",
  "consent.bereavement_outreach_author",
];
const USERS = [
  "rn_on",
  "rn_off",
  "drafter_off",
  "compliance_1",
  "privacy_1",
  "admin_1",
  "bereave_1",
  "portal_1",
];
/** `userId → patients on that user's caseload` — what the M5 `CaseloadProvider` seam answers. */
const CASELOAD = new Set([`${ORG}:rn_on:${P_ON}`]);

const record = (id: string, patientId: string, createdById: string): ConsentRecordView => ({
  id,
  organizationId: ORG,
  patientId,
  typeKey: "hipaa_release",
  grantorKind: "patient_self",
  captureMethod: "typed_signature_in_app",
  scopeDescriptor: { all: true },
  status: "draft",
  version: 1,
  effectiveAt: null,
  expiresAt: null,
  signedAt: null,
  createdById,
});

function makeServer() {
  const { service, data } = createInMemoryConsentRouteService({
    records: [record(C_ON, P_ON, "drafter_off"), record(C_OFF, P_OFF, "someone_else")],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      USERS.map((userId) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ALL_PERMS }],
      })),
    ).store,
  );
  registerAbacRegistry();
  registerPredicateIdempotent("step_up_recent", () => true);
  const carePlan = buildCarePlanAbacPredicates({
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
  registerPredicateIdempotent("caseload_or_scope", carePlan.caseload_or_scope);
  registerConsentAbacPredicates();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerConsentRoutes(app, { service });
  return { app, service, data };
}

const as = (user: string, roles = "rn_case_manager", membership?: string) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  ...(membership ? { "x-test-membership": membership } : {}),
});
const RN_ON = as("rn_on");
const RN_OFF = as("rn_off");
const DRAFTER_OFF = as("drafter_off");
const COMPLIANCE = as("compliance_1", "compliance_officer");
const PRIVACY = as("privacy_1", "privacy_officer");
const ADMIN = as("admin_1", "org_admin");
const BEREAVE = as("bereave_1", "clinical_supervisor");

beforeEach(() => {
  ONCALL_SHIFTS = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
  registerSeam("CaseloadProvider", {
    async isInCaseload({
      organizationId,
      userId,
      patientId,
    }: { organizationId: string; userId: string; patientId: string }) {
      return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
    },
    async caseloadPatientIds() {
      return [P_ON];
    },
  } as never);
  registerSeam("OnCallProvider", {
    async activeShiftsAt() {
      if (ONCALL_SHIFTS === null) throw new Error("on-call outage");
      return ONCALL_SHIFTS;
    },
    async currentOnCallActors() {
      return [];
    },
  } as never);
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

type Call = { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: object };
const get = (url: string): Call => ({ method: "GET", url });
const post = (url: string, payload: object = {}): Call => ({ method: "POST", url, payload });

/** A request that cleared every guard reaches the handler. The guards' own refusals are a 403 or the
 *  generic "resource not found" 404; a handler's 404/409/422 about a fake id is a pass for THIS purpose. */
const notRefused = (res: { statusCode: number; body: string }) => {
  const guardRefusal =
    res.statusCode === 403 || (res.statusCode === 404 && /resource not found/i.test(res.body));
  expect(guardRefusal).toBe(false);
};

describe("GAP-109 — patient-keyed routes: caseload_or_scope, 404 on deny", () => {
  const PATIENT_READS: Array<[string, (p: string) => Call]> = [
    ["3 list consents", (p) => get(`/api/v1/patients/${p}/consents`)],
    ["17 dpoa active-primary", (p) => get(`/api/v1/patients/${p}/dpoa/active-primary`)],
    ["18 expiring-consents", (p) => get(`/api/v1/patients/${p}/expiring-consents`)],
    ["21 delegated-access", (p) => get(`/api/v1/patients/${p}/delegated-access`)],
  ];
  for (const [name, call] of PATIENT_READS) {
    it(`route ${name}: on-caseload reads, off-caseload is a 404, an org-wide role reads`, async () => {
      const { app } = makeServer();
      const on = await app.inject({ ...call(P_ON), headers: RN_ON });
      const off = await app.inject({ ...call(P_ON), headers: RN_OFF });
      const wide = await app.inject({ ...call(P_ON), headers: COMPLIANCE });
      expect(on.statusCode).toBe(200);
      expect(off.statusCode).toBe(404);
      expect(wide.statusCode).toBe(200);
      await app.close();
    });
  }

  it("route 6 create draft: off-caseload is a 404 and nothing is written", async () => {
    const { app, data } = makeServer();
    const before = data.records.length;
    const payload = {
      typeKey: "hipaa_release",
      grantorKind: "patient_self",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: { all: true },
    };
    const off = await app.inject({
      ...post(`/api/v1/patients/${P_ON}/consents`, payload),
      headers: RN_OFF,
    });
    expect(off.statusCode).toBe(404);
    expect(data.records.length).toBe(before);
    const on = await app.inject({
      ...post(`/api/v1/patients/${P_ON}/consents`, payload),
      headers: RN_ON,
    });
    expect(on.statusCode).toBe(201);
    await app.close();
  });
});

describe("GAP-109 — consent-keyed reads: consent_owner_or_compliance, patient from the STORED row", () => {
  const CONSENT_READS: Array<[string, (id: string) => Call]> = [
    ["4 record", (id) => get(`/api/v1/consents/${id}`)],
    ["5 version-chain", (id) => get(`/api/v1/consents/${id}/version-chain`)],
    ["11 recipients", (id) => get(`/api/v1/consents/${id}/recipients`)],
    ["14 dpoa-agents", (id) => get(`/api/v1/consents/${id}/dpoa-agents`)],
    ["19 renewal-cycle", (id) => get(`/api/v1/consents/${id}/renewal-cycle`)],
  ];
  for (const [name, call] of CONSENT_READS) {
    it(`route ${name}: on-caseload and compliance read; off-caseload and unknown ids are both 404`, async () => {
      const { app } = makeServer();
      expect((await app.inject({ ...call(C_ON), headers: RN_ON })).statusCode).toBe(200);
      expect((await app.inject({ ...call(C_ON), headers: COMPLIANCE })).statusCode).toBe(200);
      expect((await app.inject({ ...call(C_ON), headers: PRIVACY })).statusCode).toBe(200);
      expect((await app.inject({ ...call(C_ON), headers: RN_OFF })).statusCode).toBe(404);
      expect((await app.inject({ ...call("no-such-consent"), headers: RN_ON })).statusCode).toBe(
        404,
      );
      await app.close();
    });
  }

  it("a drafter who is no longer on the patient's caseload cannot read the consent", async () => {
    const { app } = makeServer();
    const res = await app.inject({ ...get(`/api/v1/consents/${C_ON}`), headers: DRAFTER_OFF });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-109 — consent-keyed writes: caseload_or_scope over the stored patient", () => {
  const WRITES: Array<[string, Call]> = [
    ["9 supersede", post(`/api/v1/consents/${C_ON}/supersede`, {})],
    [
      "10 revoke",
      post(`/api/v1/consents/${C_ON}/revoke`, {
        revokedByKind: "staff",
        reasonText: "x".repeat(40),
      }),
    ],
    ["12 add recipient", post(`/api/v1/consents/${C_ON}/recipients`, {})],
    [
      "13 remove recipient",
      { method: "DELETE", url: `/api/v1/consents/${C_ON}/recipients/r1`, payload: {} },
    ],
    ["15 add dpoa agent", post(`/api/v1/consents/${C_ON}/dpoa-agents`, {})],
    [
      "16 update dpoa agent",
      { method: "PATCH", url: `/api/v1/consents/${C_ON}/dpoa-agents/a1`, payload: {} },
    ],
    ["20 renew", post(`/api/v1/consents/${C_ON}/renew`, {})],
  ];
  for (const [name, call] of WRITES) {
    it(`route ${name}: off-caseload is a 404; on-caseload reaches the handler`, async () => {
      const { app } = makeServer();
      const off = await app.inject({ ...call, headers: RN_OFF });
      const on = await app.inject({ ...call, headers: RN_ON });
      expect(off.statusCode).toBe(404);
      notRefused(on);
      await app.close();
    });
  }

  it("route 10 revoke: a compliance officer (org-wide) is not blocked by caseload", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      ...post(`/api/v1/consents/${C_ON}/revoke`, {
        revokedByKind: "staff",
        reasonText: "x".repeat(40),
      }),
      headers: COMPLIANCE,
    });
    notRefused(res);
    await app.close();
  });
});

describe("GAP-109 — drafter rules (routes 7 and 8)", () => {
  it("route 7 PATCH: only the consent's drafter (from the stored row) — an on-caseload non-drafter is a 403", async () => {
    const { app } = makeServer();
    const patch = (headers: Record<string, string>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/consents/${C_ON}`,
        headers,
        payload: { scopeDescriptor: { all: false } },
      });
    notRefused(await patch(DRAFTER_OFF));
    expect((await patch(RN_ON)).statusCode).toBe(403);
    expect((await patch(COMPLIANCE)).statusCode).toBe(403);
    await app.close();
  });

  it("route 8 sign: the drafter OR an on-caseload signer; anyone else is a 404", async () => {
    const { app } = makeServer();
    const sign = (headers: Record<string, string>) =>
      app.inject({ ...post(`/api/v1/consents/${C_ON}/sign`, {}), headers });
    notRefused(await sign(DRAFTER_OFF));
    notRefused(await sign(RN_ON));
    expect((await sign(RN_OFF)).statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-109 — compliance / privacy / admin routes", () => {
  it("routes 22 and 23 (eval-audit): compliance or privacy officer only", async () => {
    const { app } = makeServer();
    for (const url of [
      `/api/v1/consents/${C_ON}/eval-audit`,
      `/api/v1/consents/eval-audit/by-patient?patientId=${P_ON}`,
    ]) {
      expect((await app.inject({ method: "GET", url, headers: COMPLIANCE })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url, headers: PRIVACY })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url, headers: RN_ON })).statusCode).toBe(403);
    }
    await app.close();
  });

  it("routes 24 and 30 (re-render, cascade retry): compliance officer only", async () => {
    const { app } = makeServer();
    for (const url of [
      `/api/v1/consents/${C_ON}/document/re-render`,
      `/api/v1/consents/${C_ON}/cascade/retry`,
    ]) {
      expect((await app.inject({ ...post(url), headers: RN_ON })).statusCode).toBe(403);
      expect((await app.inject({ ...post(url), headers: PRIVACY })).statusCode).toBe(403);
      notRefused(await app.inject({ ...post(url), headers: COMPLIANCE }));
    }
    await app.close();
  });

  it("route 2 (overlay): org admin or compliance only", async () => {
    const { app } = makeServer();
    const url = "/api/v1/consent-types/overlay";
    expect((await app.inject({ ...post(url, {}), headers: RN_ON })).statusCode).toBe(403);
    notRefused(await app.inject({ ...post(url, {}), headers: ADMIN }));
    notRefused(await app.inject({ ...post(url, {}), headers: COMPLIANCE }));
    await app.close();
  });
});

describe("GAP-109 — bereavement routes (28, 29)", () => {
  it("route 28 post-mortem-eligible: caseload OR bereavement oversight; everyone else 404", async () => {
    const { app } = makeServer();
    const url = `/api/v1/consents/post-mortem-eligible/${P_ON}`;
    const MSW_ON = as("rn_on", "msw");
    expect((await app.inject({ method: "GET", url, headers: MSW_ON })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: BEREAVE })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url, headers: as("rn_off", "msw") })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("route 29 bereavement-outreach: the bereavement window only — a caseload nurse is a 404", async () => {
    const { app } = makeServer();
    const url = "/api/v1/consents/bereavement-outreach";
    const body = {
      patientId: P_ON,
      grantorKind: "bereaved_family",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: { all: true },
    };
    expect((await app.inject({ ...post(url, body), headers: RN_ON })).statusCode).toBe(404);
    notRefused(await app.inject({ ...post(url, body), headers: BEREAVE }));
    await app.close();
  });
});

describe("GAP-109 — break-glass is read-only", () => {
  it("an active grant opens a consent READ but never a consent WRITE", async () => {
    const { app } = makeServer();
    setBreakGlassChecker(() => ({ eventId: "bg-1" }));
    const read = await app.inject({ ...get(`/api/v1/consents/${C_ON}`), headers: RN_OFF });
    const write = await app.inject({
      ...post(`/api/v1/consents/${C_ON}/revoke`, {
        revokedByKind: "staff",
        reasonText: "x".repeat(40),
      }),
      headers: RN_OFF,
    });
    const create = await app.inject({
      ...post(`/api/v1/patients/${P_ON}/consents`, {
        typeKey: "hipaa_release",
        grantorKind: "patient_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: { all: true },
      }),
      headers: RN_OFF,
    });
    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(404);
    expect(create.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-109 — the SERVICE layer enforces the same rules (defense in depth)", () => {
  const staff = (
    userId: string,
    roles: readonly string[] = ["rn_case_manager"],
    over: Partial<ConsentStaffActor> = {},
  ): ConsentStaffActor => ({
    kind: "staff",
    organizationId: ORG,
    userId,
    roles,
    sessionPatientId: null,
    breakGlassEventId: null,
    ...over,
  });
  const scoped = () => {
    const { service } = createInMemoryConsentRouteService({
      records: [record(C_ON, P_ON, "drafter_off"), record(C_OFF, P_OFF, "someone_else")],
    });
    return createScopedConsentRouteService(service, {
      caseload: {
        async isInCaseload({ organizationId, userId, patientId }) {
          return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
        },
      },
    });
  };

  it("denies a patient read, a consent read and a consent write to an off-caseload actor (not_found)", async () => {
    const svc = scoped();
    const off = staff("rn_off");
    await expect(svc.listConsentsForPatient(off, ORG, P_ON)).rejects.toBeInstanceOf(
      ConsentRouteError,
    );
    expect(await svc.getConsent(off, ORG, C_ON)).toBeNull();
    await expect(svc.listRecipients(off, ORG, C_ON, "2026-10-04T00:00:00.000Z")).rejects.toThrow(
      /not found/i,
    );
    await expect(
      svc.revokeConsent(
        off,
        ORG,
        C_ON,
        {
          actorIsStaff: true,
          revokedByKind: "staff",
          reasonText: "x",
          evidenceDocumentId: null,
          revokedById: "rn_off",
        },
        "2026-10-04T00:00:00.000Z",
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("allows an on-caseload actor and an org-wide role", async () => {
    const svc = scoped();
    expect((await svc.getConsent(staff("rn_on"), ORG, C_ON))?.id).toBe(C_ON);
    expect((await svc.getConsent(staff("c", ["compliance_officer"]), ORG, C_ON))?.id).toBe(C_ON);
  });

  it("lets only the typed system actor through — a 'system' role string is NOT a bypass", async () => {
    const svc = scoped();
    expect((await svc.getConsent(CONSENT_SYSTEM_ACTOR, ORG, C_OFF))?.id).toBe(C_OFF);
    expect(
      await svc.getConsent(staff("rn_off", ["system", "service", "internal"]), ORG, C_OFF),
    ).toBeNull();
  });

  it("break-glass opens a service READ, never a service WRITE", async () => {
    const svc = scoped();
    const glass = staff("rn_off", ["rn_case_manager"], { breakGlassEventId: "bg-1" });
    expect((await svc.getConsent(glass, ORG, C_ON))?.id).toBe(C_ON);
    await expect(
      svc.addRecipient(glass, ORG, C_ON, {} as never, "2026-10-04T00:00:00.000Z"),
    ).rejects.toThrow(/not found/i);
  });

  it("only compliance may re-render or retry a cascade; only compliance/privacy read the decision audit", async () => {
    const svc = scoped();
    const rn = staff("rn_on");
    await expect(
      svc.requestDocumentReRender(rn, ORG, C_ON, "rn_on", "2026-10-04T00:00:00.000Z"),
    ).rejects.toBeInstanceOf(ConsentRouteError);
    await expect(
      svc.listEvalAudit(rn, ORG, { consentId: C_ON }, { pageSize: 5 }),
    ).rejects.toBeInstanceOf(ConsentRouteError);
    await expect(
      svc.listEvalAudit(staff("p", ["privacy_officer"]), ORG, { consentId: C_ON }, { pageSize: 5 }),
    ).resolves.toBeDefined();
  });
});

const ON_CALL_RN = as("rn_off", "rn_case_manager", "m_off");

describe("§4.11 discipline scope — which disciplines read which consent routes", () => {
  const NON_CLINICAL = as("rn_on", "billing_clerk");
  const READS: Array<[string, Call]> = [
    ["3 list", get(`/api/v1/patients/${P_ON}/consents`)],
    ["4 record", get(`/api/v1/consents/${C_ON}`)],
    ["11 recipients", get(`/api/v1/consents/${C_ON}/recipients`)],
    ["14 dpoa-agents", get(`/api/v1/consents/${C_ON}/dpoa-agents`)],
    ["17 dpoa active-primary", get(`/api/v1/patients/${P_ON}/dpoa/active-primary`)],
    ["21 delegated-access", get(`/api/v1/patients/${P_ON}/delegated-access`)],
  ];
  for (const [name, call] of READS) {
    it(`route ${name}: an on-caseload member outside every discipline is a 404; compliance and privacy bypass`, async () => {
      const { app } = makeServer();
      expect((await app.inject({ ...call, headers: NON_CLINICAL })).statusCode).toBe(404);
      expect((await app.inject({ ...call, headers: RN_ON })).statusCode).toBe(200);
      expect((await app.inject({ ...call, headers: COMPLIANCE })).statusCode).toBe(200);
      expect((await app.inject({ ...call, headers: PRIVACY })).statusCode).toBe(200);
      await app.close();
    });
  }

  it("route 17 is clinical-only: a bereavement counselor on the caseload is refused, route 21 admits one", async () => {
    const { app } = makeServer();
    const counselor = as("rn_on", "bereavement_counselor");
    const r17 = get(`/api/v1/patients/${P_ON}/dpoa/active-primary`);
    const r21 = get(`/api/v1/patients/${P_ON}/delegated-access`);
    expect((await app.inject({ ...r17, headers: counselor })).statusCode).toBe(404);
    expect((await app.inject({ ...r21, headers: counselor })).statusCode).toBe(200);
    expect((await app.inject({ ...r17, headers: as("rn_on", "msw") })).statusCode).toBe(200);
    await app.close();
  });

  it("route 17 admits director_of_nursing (org-wide clinical oversight) and the plain rn seat; lpn and non-clinical roles stay out", async () => {
    const { app } = makeServer();
    const r17 = get(`/api/v1/patients/${P_ON}/dpoa/active-primary`);
    expect(
      (await app.inject({ ...r17, headers: as("rn_on", "director_of_nursing") })).statusCode,
    ).toBe(200);
    expect((await app.inject({ ...r17, headers: as("rn_on", "rn") })).statusCode).toBe(200);
    // still clinical-only: lpn / chaplain / aide are not widened
    for (const role of ["lpn", "chaplain", "chha", "volunteer"]) {
      expect((await app.inject({ ...r17, headers: as("rn_on", role) })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("prescribers (np / md / hospice_physician) pass the clinical discipline set on route 17", async () => {
    const { app } = makeServer();
    const r17 = get(`/api/v1/patients/${P_ON}/dpoa/active-primary`);
    for (const role of ["np", "md", "hospice_physician"]) {
      expect((await app.inject({ ...r17, headers: as("rn_on", role) })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("route 28 also admits bereavement_program_coordinator (M16 oversight role), nothing wider", async () => {
    const { app } = makeServer();
    const url = `/api/v1/consents/post-mortem-eligible/${P_ON}`;
    const read = (headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
    expect((await read(as("rn_on", "bereavement_program_coordinator"))).statusCode).toBe(200);
    expect((await read(as("rn_on", "director_of_nursing"))).statusCode).toBe(404);
    expect((await read(as("rn_on", "rn"))).statusCode).toBe(404);
    await app.close();
  });

  it("route 28 admits only bereavement_counselor / msw / clinical_supervisor / compliance", async () => {
    const { app } = makeServer();
    const url = `/api/v1/consents/post-mortem-eligible/${P_ON}`;
    const read = (headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
    expect((await read(RN_ON)).statusCode).toBe(404); // on caseload, rn_case_manager is not listed
    expect((await read(as("rn_on", "msw"))).statusCode).toBe(200);
    expect((await read(as("rn_on", "bereavement_counselor"))).statusCode).toBe(200);
    expect((await read(COMPLIANCE)).statusCode).toBe(200);
    expect((await read(as("rn_on", "billing_clerk"))).statusCode).toBe(404);
    await app.close();
  });

  it("a break-glass grant still opens a READ regardless of discipline", async () => {
    const { app } = makeServer();
    setBreakGlassChecker(() => ({ eventId: "bg-1" }));
    const res = await app.inject({
      ...get(`/api/v1/consents/${C_ON}`),
      headers: as("rn_off", "billing_clerk"),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("§4.11 on-call window — an on-call clinician outside the caseload reads inside the window", () => {
  const ON_CALL_READS: Array<[string, Call]> = [
    ["3 list", get(`/api/v1/patients/${P_ON}/consents`)],
    ["4 record", get(`/api/v1/consents/${C_ON}`)],
    ["11 recipients", get(`/api/v1/consents/${C_ON}/recipients`)],
    ["14 dpoa-agents", get(`/api/v1/consents/${C_ON}/dpoa-agents`)],
    ["17 dpoa active-primary", get(`/api/v1/patients/${P_ON}/dpoa/active-primary`)],
    ["21 delegated-access", get(`/api/v1/patients/${P_ON}/delegated-access`)],
  ];
  for (const [name, call] of ON_CALL_READS) {
    it(`route ${name}: primary and backup on-call read off-caseload; no active shift is a 404`, async () => {
      const { app } = makeServer();
      expect((await app.inject({ ...call, headers: ON_CALL_RN })).statusCode).toBe(404);
      ONCALL_SHIFTS = [shift()];
      expect((await app.inject({ ...call, headers: ON_CALL_RN })).statusCode).toBe(200);
      ONCALL_SHIFTS = [
        shift({ primaryOnCallMembershipId: "m_other", backupMembershipId: "m_off" }),
      ];
      expect((await app.inject({ ...call, headers: ON_CALL_RN })).statusCode).toBe(200);
      await app.close();
    });
  }

  it("fails closed: someone else's shift, a not-yet-active / expired shift, an outage, no membership", async () => {
    const { app } = makeServer();
    const url = `/api/v1/consents/${C_ON}`;
    const read = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url, headers }).then((r) => r.statusCode);
    ONCALL_SHIFTS = [shift({ primaryOnCallMembershipId: "m_other" })];
    expect(await read(ON_CALL_RN)).toBe(404);
    ONCALL_SHIFTS = [shift({ status: "scheduled" })];
    expect(await read(ON_CALL_RN)).toBe(404);
    ONCALL_SHIFTS = [
      shift({
        shiftStartsAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        shiftEndsAt: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    ];
    expect(await read(ON_CALL_RN)).toBe(404);
    ONCALL_SHIFTS = null;
    expect(await read(ON_CALL_RN)).toBe(404);
    ONCALL_SHIFTS = [shift()];
    expect(await read(as("rn_off", "rn_case_manager"))).toBe(404); // no server-derived membership
    await app.close();
  });

  it("on-call does not waive the discipline check, and never opens route 28 or any write", async () => {
    const { app } = makeServer();
    ONCALL_SHIFTS = [shift()];
    const nonClinical = as("rn_off", "billing_clerk", "m_off");
    expect(
      (await app.inject({ ...get(`/api/v1/consents/${C_ON}`), headers: nonClinical })).statusCode,
    ).toBe(404);
    const msw = as("rn_off", "msw", "m_off");
    const r28 = await app.inject({
      method: "GET",
      url: `/api/v1/consents/post-mortem-eligible/${P_ON}`,
      headers: msw,
    });
    expect(r28.statusCode).toBe(404);
    const revoke = await app.inject({
      ...post(`/api/v1/consents/${C_ON}/revoke`, {
        revokedByKind: "staff",
        reasonText: "x".repeat(40),
      }),
      headers: ON_CALL_RN,
    });
    const create = await app.inject({
      ...post(`/api/v1/patients/${P_ON}/consents`, {
        typeKey: "hipaa_release",
        grantorKind: "patient_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: { all: true },
      }),
      headers: ON_CALL_RN,
    });
    expect(revoke.statusCode).toBe(404);
    expect(create.statusCode).toBe(404);
    await app.close();
  });
});

describe("§4.11 — the SERVICE layer enforces discipline scope and the on-call window", () => {
  const staff = (userId: string, roles: readonly string[], membershipId: string | null = null) =>
    ({
      kind: "staff",
      organizationId: ORG,
      userId,
      roles,
      membershipId,
      sessionPatientId: null,
      breakGlassEventId: null,
    }) as ConsentStaffActor;
  const svc = (onCall: boolean | "throw" = false) => {
    const { service } = createInMemoryConsentRouteService({
      records: [record(C_ON, P_ON, "drafter_off")],
    });
    return createScopedConsentRouteService(service, {
      caseload: {
        async isInCaseload({ organizationId, userId, patientId }) {
          return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
        },
      },
      onCallWindow: {
        async isOnCallNow() {
          if (onCall === "throw") throw new Error("seam down");
          return onCall;
        },
      },
    });
  };
  const NOW = "2026-10-04T00:00:00.000Z";

  it("denies an on-caseload member outside the discipline set on every governed read", async () => {
    const s = svc();
    const bad = staff("rn_on", ["billing_clerk"]);
    expect(await s.getConsent(bad, ORG, C_ON)).toBeNull();
    await expect(s.listConsentsForPatient(bad, ORG, P_ON)).rejects.toThrow(/not found/i);
    await expect(s.listRecipients(bad, ORG, C_ON, NOW)).rejects.toThrow(/not found/i);
    await expect(s.listDpoaAgents(bad, ORG, C_ON, NOW)).rejects.toThrow(/not found/i);
    await expect(s.activePrimaryDpoa(bad, ORG, P_ON, NOW)).rejects.toThrow(/not found/i);
    await expect(s.listDelegatedAccess(bad, ORG, P_ON, NOW)).rejects.toThrow(/not found/i);
    expect((await s.getConsent(staff("rn_on", ["rn_case_manager"]), ORG, C_ON))?.id).toBe(C_ON);
  });

  it("admits an off-caseload clinician only through the on-call window, and never for a write", async () => {
    const off = staff("rn_off", ["rn_case_manager"], "m_off");
    expect(await svc(false).getConsent(off, ORG, C_ON)).toBeNull();
    expect((await svc(true).getConsent(off, ORG, C_ON))?.id).toBe(C_ON);
    expect(await svc("throw").getConsent(off, ORG, C_ON)).toBeNull();
    expect(
      await svc(true).getConsent(staff("rn_off", ["rn_case_manager"], null), ORG, C_ON),
    ).toBeNull();
    await expect(svc(true).addRecipient(off, ORG, C_ON, {} as never, NOW)).rejects.toThrow(
      /not found/i,
    );
  });

  it("route 17 / 28 service rules admit director_of_nursing / bereavement_program_coordinator", async () => {
    const s = svc(false);
    await expect(
      s.activePrimaryDpoa(staff("rn_on", ["director_of_nursing"]), ORG, P_ON, NOW),
    ).resolves.toBeDefined();
    await expect(
      s.activePrimaryDpoa(staff("rn_on", ["rn"]), ORG, P_ON, NOW),
    ).resolves.toBeDefined();
    await expect(s.activePrimaryDpoa(staff("rn_on", ["lpn"]), ORG, P_ON, NOW)).rejects.toThrow(
      /not found/i,
    );
    await expect(
      s.listPostMortemEligible(staff("rn_on", ["bereavement_program_coordinator"]), ORG, P_ON),
    ).resolves.toBeDefined();
    await expect(
      s.listPostMortemEligible(staff("rn_on", ["director_of_nursing"]), ORG, P_ON),
    ).rejects.toThrow(/not found/i);
  });

  it("route 28 service rule: discipline-gated, no on-call override", async () => {
    const s = svc(true);
    await expect(
      s.listPostMortemEligible(staff("rn_on", ["rn_case_manager"]), ORG, P_ON),
    ).rejects.toThrow(/not found/i);
    await expect(
      s.listPostMortemEligible(staff("rn_off", ["msw"], "m_off"), ORG, P_ON),
    ).rejects.toThrow(/not found/i);
    await expect(
      s.listPostMortemEligible(staff("rn_on", ["msw"]), ORG, P_ON),
    ).resolves.toBeDefined();
  });
});
