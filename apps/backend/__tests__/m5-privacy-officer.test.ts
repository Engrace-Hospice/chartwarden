// apps/backend/__tests__/m5-privacy-officer.test.ts — the Privacy Officer surface (M5 §4.2 resync, §4.7
// `privacy.admin`, §5.1 "Privacy flags"): the pure origin/resync/drift decisions and the route guards.
// The Drizzle service is proven live in `m39-consent-privacy.live.test.ts` (the M5 privacy live suite).
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type IntakeSudBatchFact,
  NO_PART2_CONSENT,
  type Part2ConsentState,
  type PatientPrivacyView,
  type PrivacyOfficerService,
  batchContributes,
  decideResync,
  detectDrift,
  flagSinceFromHistory,
  registerPatientPrivacyRoutes,
} from "../src/modules/05-patient/index";

const PATIENT = "8a3c1a52-6a43-4b8e-9d3a-111111111111";
const OTHER_ORG_PATIENT = "8a3c1a52-6a43-4b8e-9d3a-222222222222";

const snap = (flags: string[], origin: string | null, scv: string | null = null) => ({
  flags,
  sudFlagOrigin: origin,
  sourceConsentVersion: scv,
  capturedAt: "2026-10-01T00:00:00.000Z",
  invalidatedAt: null,
});
const batch = (
  sudStatus: IntakeSudBatchFact["sudStatus"],
  batchStatus = "in_review",
): IntakeSudBatchFact => ({
  batchId: `b-${sudStatus}-${batchStatus}`,
  sudStatus,
  batchStatus,
  receivedAt: "2026-10-01T00:00:00.000Z",
  pageCount: 4,
  resolvedAt: null,
});
const consent = (state: Part2ConsentState["state"]): Part2ConsentState => ({
  ...NO_PART2_CONSENT,
  state,
  consentRecordId: state === "none" ? null : "c-1",
  status: state === "active" ? "active" : state === "inactive" ? "revoked" : null,
});

describe("batchContributes — which DocLens batches hold a flag", () => {
  it("a confirmed detection holds it, even on a discarded batch", () => {
    expect(batchContributes(batch("confirmed"))).toBe(true);
    expect(batchContributes(batch("confirmed", "discarded"))).toBe(true);
  });
  it("a pending detection holds it unless the batch was discarded", () => {
    expect(batchContributes(batch("detected"))).toBe(true);
    expect(batchContributes(batch("detected", "discarded"))).toBe(false);
  });
  it("a rejected detection never holds it", () => {
    expect(batchContributes(batch("rejected"))).toBe(false);
  });
});

describe("decideResync — re-derive from M39 (M5 §4.2)", () => {
  it("an active Part 2 release lifts sud (even a DocLens one) and keeps other flags", () => {
    const d = decideResync(snap(["hiv", "sud"], "m22_intake_confirmed"), consent("active"), [
      batch("confirmed"),
    ]);
    expect(d).toEqual({
      flags: ["hiv"],
      sudFlagOrigin: null,
      sourceConsentVersion: "c-1",
      flagsChanged: true,
    });
  });
  it("an inactive release restricts sud, consent-governed", () => {
    const d = decideResync(snap([], null), consent("inactive"), []);
    expect(d.flags).toEqual(["sud"]);
    expect(d.sudFlagOrigin).toBeNull();
    expect(d.sourceConsentVersion).toBe("c-1");
    expect(d.flagsChanged).toBe(true);
  });
  it("M39 silent: a live detection is re-applied when the flag is missing", () => {
    expect(decideResync(null, consent("none"), [batch("detected")])).toMatchObject({
      flags: ["sud"],
      sudFlagOrigin: "m22_intake_unconfirmed",
      flagsChanged: true,
    });
    expect(decideResync(snap([], null), consent("none"), [batch("confirmed")])).toMatchObject({
      flags: ["sud"],
      sudFlagOrigin: "m22_intake_confirmed",
    });
  });
  it("M39 silent: a confirmed detection promotes an unconfirmed flag", () => {
    const d = decideResync(snap(["sud"], "m22_intake_unconfirmed"), consent("none"), [
      batch("confirmed"),
    ]);
    expect(d).toMatchObject({
      flags: ["sud"],
      sudFlagOrigin: "m22_intake_confirmed",
      flagsChanged: false,
    });
  });
  it("M39 silent: a resync NEVER lifts a DocLens flag — that is the reviewer's act", () => {
    const d = decideResync(snap(["sud"], "m22_intake_unconfirmed"), consent("none"), [
      batch("rejected"),
      batch("detected", "discarded"),
    ]);
    expect(d.flags).toEqual(["sud"]);
    expect(d.sudFlagOrigin).toBe("m22_intake_unconfirmed");
    expect(d.flagsChanged).toBe(false);
  });
  it("M39 silent: a discarded unreviewed detection is not re-applied", () => {
    expect(decideResync(null, consent("none"), [batch("detected", "discarded")]).flags).toEqual([]);
  });
});

describe("detectDrift", () => {
  it("flags what a resync would change", () => {
    expect(detectDrift(snap(["sud"], null, "c-0"), consent("active"), [])).toEqual([
      "consent_active_but_restricted",
    ]);
    expect(detectDrift(snap([], null), consent("inactive"), [])).toEqual([
      "consent_inactive_but_unrestricted",
    ]);
    expect(detectDrift(snap([], null), consent("none"), [batch("detected")])).toEqual([
      "intake_detection_without_flag",
    ]);
    expect(detectDrift(snap(["sud"], "m22_intake_unconfirmed"), consent("none"), [])).toEqual([
      "intake_flag_without_detection",
    ]);
    expect(
      detectDrift(
        { ...snap([], null), invalidatedAt: "2026-10-02T00:00:00.000Z" },
        NO_PART2_CONSENT,
        [],
      ),
    ).toEqual(["snapshot_stale"]);
  });
});

describe("flagSinceFromHistory", () => {
  it("dates each present flag from when it last appeared", () => {
    const since = flagSinceFromHistory([
      // newest first
      {
        at: "2026-10-03T00:00:00.000Z",
        actorUserId: null,
        eventType: "patient_privacy_flag_snapshot.update",
        before: { flags: ["hiv"] },
        after: { flags: ["hiv", "sud"] },
      },
      {
        at: "2026-10-02T00:00:00.000Z",
        actorUserId: null,
        eventType: "patient_privacy_flag_snapshot.update",
        before: { flags: ["sud"] },
        after: { flags: ["hiv"] },
      },
      {
        at: "2026-10-01T00:00:00.000Z",
        actorUserId: null,
        eventType: "patient_privacy_flag_snapshot.insert",
        before: null,
        after: { flags: ["sud"] },
      },
    ]);
    expect(since.get("hiv")).toBe("2026-10-02T00:00:00.000Z");
    expect(since.get("sud")).toBe("2026-10-03T00:00:00.000Z");
  });
});

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────

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
const VIEW: PatientPrivacyView = {
  patient: { id: PATIENT, displayName: "Doe, Jane", mrn: "MRN-1", status: "active" },
  snapshot: {
    exists: true,
    flags: ["sud"],
    capturedAt: "2026-10-01T00:00:00.000Z",
    stale: false,
    invalidatedAt: null,
    sourceConsentVersion: null,
  },
  restrictions: [
    {
      flag: "sud",
      origin: "intake_unconfirmed",
      since: "2026-10-01T00:00:00.000Z",
      sinceFromHistory: true,
    },
  ],
  part2Consent: NO_PART2_CONSENT,
  intakeDetections: [{ ...batch("detected"), contributes: true }],
  history: [],
  drift: [],
};

function makeServer() {
  const calls: { resync: string[]; list: unknown[] } = { resync: [], list: [] };
  const service: PrivacyOfficerService = {
    async getPatientPrivacy(org, id) {
      return org === ORG && id === PATIENT ? VIEW : null;
    },
    async resync(org, id, actor) {
      if (org !== ORG || id !== PATIENT) return null;
      calls.resync.push(actor);
      return {
        patientId: id,
        flagsBefore: ["sud"],
        flagsAfter: ["sud"],
        sudOriginAfter: "m22_intake_unconfirmed",
        sourceConsentVersion: null,
        flagsChanged: false,
        eventEmitted: false,
        capturedAt: "2026-10-04T00:00:00.000Z",
      };
    },
    async listRestricted(_org, q) {
      calls.list.push(q);
      return {
        items: [],
        nextCursor: null,
        counts: {
          total: 0,
          consent: 0,
          intake_unconfirmed: 0,
          intake_confirmed: 0,
          unattributed: 0,
          stale: 0,
        },
      };
    },
  };
  const grantStore = createInMemoryEffectivePermissionStore(
    [
      { userId: "officer_1", permissions: ["privacy.admin"] },
      // Holds every chart read and the org-admin ROLE, but not `privacy.admin` (M5 §6: org_admin ❌).
      { userId: "admin_1", permissions: ["patient.read", "patient.edit", "consent.read"] },
      { userId: "rn_1", permissions: ["patient.read", "intake.review"] },
    ].map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientPrivacyRoutes(app, { service });
  return { app, calls };
}

const OFFICER = {
  "x-test-user": "officer_1",
  "x-test-org": ORG,
  "x-test-roles": "hipaa_privacy_officer",
};
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };

describe("Privacy Officer routes — privacy.admin (M5 §4.7)", () => {
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("serves the officer view to privacy.admin", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/privacy`,
      headers: OFFICER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restrictions[0].origin).toBe("intake_unconfirmed");
  });

  it("refuses org_admin and a clinical reviewer (403) on all three routes", async () => {
    const { app, calls } = makeServer();
    for (const headers of [ADMIN, RN]) {
      for (const [method, url] of [
        ["GET", `/api/v1/patients/${PATIENT}/privacy`],
        ["POST", `/api/v1/patients/${PATIENT}/privacy-flags/resync`],
        ["GET", "/api/v1/privacy/restricted-patients"],
      ] as const) {
        const res = await app.inject({ method, url, headers });
        expect(res.statusCode, `${headers["x-test-user"]} ${method} ${url}`).toBe(403);
      }
    }
    expect(calls.resync).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/patients/${PATIENT}/privacy` });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("another tenant's (or an unknown) patient is a 404 — view and resync", async () => {
    const { app, calls } = makeServer();
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${OTHER_ORG_PATIENT}/privacy`,
      headers: OFFICER,
    });
    expect(view.statusCode).toBe(404);
    const resync = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${OTHER_ORG_PATIENT}/privacy-flags/resync`,
      headers: OFFICER,
    });
    expect(resync.statusCode).toBe(404);
    expect(calls.resync).toEqual([]);
  });

  it("resync runs as the acting officer", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT}/privacy-flags/resync`,
      headers: OFFICER,
    });
    expect(res.statusCode).toBe(200);
    expect(calls.resync).toEqual(["officer_1"]);
  });

  it("the queue validates its origin filter", async () => {
    const { app, calls } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/restricted-patients?origin=intake_unconfirmed",
      headers: OFFICER,
    });
    expect(ok.statusCode).toBe(200);
    expect(calls.list).toEqual([{ origin: "intake_unconfirmed" }]);
    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/restricted-patients?origin=everything",
      headers: OFFICER,
    });
    expect(bad.statusCode).toBe(422);
  });
});
