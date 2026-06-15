// apps/backend/__tests__/audit-routes.test.ts — M4-T06 audit query route-inventory integration
// tests (M4 spec §4.1–4.3; §10.1 "no mutation escapes the log"; §10.2 "who touched this chart").
//
// Exercises M4's audit-query routes through the FULL M1 middleware chain via Fastify `inject`
// with no live infra: buildServer() mounts the foundation host, registerAuditRoutes() mounts the
// query routes against the in-memory `AuditQuery` adapter (@wardenx/audit) seeded with the rows a
// PHI write trigger / read helper would produce. The REAL Authorization Contract gates every
// route (`requirePermission("audit.read")`); a header-auth shim populates request.context.
import { createInMemoryAuditQuery } from "@wardenx/audit";
import type { AuditEventRecord } from "@wardenx/audit";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import { generateAuditTrigger, registerAuditRoutes } from "../src/modules/04-audit/index";

/** Test-only auth shim: populate request.context from headers (mirrors authz-routes.test). */
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
const PATIENT = "11111111-1111-1111-1111-111111111111";
const PATIENT_OTHER = "22222222-2222-2222-2222-222222222222";
const EVT = (n: number) => `0000000${n}-0000-0000-0000-00000000000${n}`;

/** Records the slice seeds: the rows the write trigger + read helpers would have produced. */
function seedRecords(): AuditEventRecord[] {
  const base = {
    organizationId: ORG,
    actorKind: "user",
    outcome: "success" as const,
    severity: "info" as const,
    before: null,
    after: null,
    retentionClass: "compliance" as const,
  };
  return [
    // §10.1 write-capture rows (what the encounter trigger emits on a mutation).
    { ...base, id: EVT(1), createdAt: "2026-06-01T01:00:00.000Z", actorUserId: "rn_1", actorRole: "clinical_rn", eventType: "encounter.insert", resourceKind: "encounter", resourceId: EVT(8), context: { patientId: PATIENT } },
    { ...base, id: EVT(2), createdAt: "2026-06-01T02:00:00.000Z", actorUserId: "rn_1", actorRole: "clinical_rn", eventType: "encounter.update", resourceKind: "encounter", resourceId: EVT(8), context: { patientId: PATIENT } },
    // §10.2 access rows for the patient (a chart open + an under-glass access).
    { ...base, id: EVT(3), createdAt: "2026-06-02T01:00:00.000Z", actorUserId: "rn_1", actorRole: "clinical_rn", eventType: "patient.viewed", resourceKind: "patient", resourceId: PATIENT, context: { patientId: PATIENT, fields: ["name", "dob"] } },
    { ...base, id: EVT(4), createdAt: "2026-06-02T02:00:00.000Z", actorUserId: "rn_2", actorRole: "clinical_rn", eventType: "m3.breakglass.access", resourceKind: "patient", resourceId: PATIENT, severity: "critical", context: { patientId: PATIENT, breakGlassEventId: "bg_1" } },
    // a different patient's access — must NOT appear in PATIENT's history.
    { ...base, id: EVT(5), createdAt: "2026-06-02T03:00:00.000Z", actorUserId: "rn_1", actorRole: "clinical_rn", eventType: "patient.viewed", resourceKind: "patient", resourceId: PATIENT_OTHER, context: { patientId: PATIENT_OTHER } },
    // another org's row — must never be visible to ORG.
    { ...base, id: EVT(6), createdAt: "2026-06-02T04:00:00.000Z", organizationId: "org_b", actorUserId: "x", actorRole: null, eventType: "patient.viewed", resourceKind: "patient", resourceId: PATIENT, context: { patientId: PATIENT } },
  ];
}

const PERMISSION_SEED = [
  { organizationId: ORG, userId: "co_1", permissions: ["audit.read"] }, // Compliance Officer
  { organizationId: ORG, userId: "rn_1", permissions: ["patient.read"] }, // no audit.read
  { organizationId: ORG, userId: "plat_1", permissions: ["audit.read"] }, // elevated reader
];

function makeServer() {
  const audit = createInMemoryAuditQuery(seedRecords());
  const auditSink = createInMemoryAuditExecutor();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: s.organizationId,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAuditRoutes(app, { query: audit.query, audit: auditSink.executor });
  return { app, auditSink };
}

const COMPLIANCE = { "x-test-user": "co_1", "x-test-org": ORG, "x-test-roles": "compliance" };
const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const PLATFORM = { "x-test-user": "plat_1", "x-test-org": ORG, "x-test-roles": "platform_ops" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M4-T06 audit query route inventory", () => {
  describe("audit.read meta-permission gate (the contract gates the read)", () => {
    it("unauthenticated → 401", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/events" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("an actor without audit.read → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/events", headers: CLINICIAN });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("§10.1 no mutation escapes the log", () => {
    it("the capture contract emits an append-only trigger that writes audit_event", () => {
      const ddl = generateAuditTrigger({ table: "encounter", resourceKind: "encounter" });
      expect(ddl).toContain("INSERT INTO audit_event");
      expect(ddl).toContain("AFTER INSERT OR UPDATE OR DELETE ON encounter");
    });

    it("the captured mutation rows are queryable via GET /audit/events", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events?resourceKind=encounter",
        headers: COMPLIANCE,
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().items.map((e: { id: string }) => e.id);
      expect(ids).toEqual([EVT(2), EVT(1)]); // both mutations logged, newest-first
      await app.close();
    });

    it("scopes the search to the actor's org (no cross-tenant leakage)", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/events", headers: COMPLIANCE });
      const orgs = new Set(res.json().items.map((e: { organizationId: string }) => e.organizationId));
      expect(orgs).toEqual(new Set([ORG]));
      await app.close();
    });
  });

  describe("§10.2 who touched this chart", () => {
    it("returns every internal access + disclosure for the patient, break-glass flagged", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/audit/patients/${PATIENT}/access`,
        headers: COMPLIANCE,
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{
        eventId: string;
        actorUserId: string;
        eventType: string;
        fields: string[];
        viaBreakGlass: boolean;
      }>;
      // newest-first: the under-glass access then the chart open; the mutation + other patient excluded.
      expect(items.map((e) => e.eventId)).toEqual([EVT(4), EVT(3)]);
      const glass = items.find((e) => e.eventId === EVT(4))!;
      expect(glass.viaBreakGlass).toBe(true);
      expect(glass.actorUserId).toBe("rn_2");
      const open = items.find((e) => e.eventId === EVT(3))!;
      expect(open.fields).toEqual(["name", "dob"]);
      expect(open.viaBreakGlass).toBe(false);
      await app.close();
    });

    it("a different patient's chart yields no leakage of PATIENT's accesses", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/audit/patients/${PATIENT_OTHER}/access`,
        headers: COMPLIANCE,
      });
      const ids = res.json().items.map((e: { eventId: string }) => e.eventId);
      expect(ids).toEqual([EVT(5)]);
      await app.close();
    });
  });

  describe("§4.2 single-event detail", () => {
    it("returns the event by id; 404 for a missing id", async () => {
      const { app } = makeServer();
      const ok = await app.inject({ method: "GET", url: `/api/v1/audit/events/${EVT(1)}`, headers: COMPLIANCE });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().id).toBe(EVT(1));
      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events/99999999-9999-9999-9999-999999999999",
        headers: COMPLIANCE,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("EVENT_NOT_FOUND");
      await app.close();
    });
  });

  describe("§2.6 audit-of-audit", () => {
    it("an ELEVATED reader's audit read emits audit.elevated_access; a tenant read does not", async () => {
      const { app, auditSink } = makeServer();
      await app.inject({ method: "GET", url: "/api/v1/audit/events", headers: COMPLIANCE });
      expect(auditSink.rows.some((r) => r.eventType === "audit.elevated_access")).toBe(false);

      await app.inject({ method: "GET", url: "/api/v1/audit/events", headers: PLATFORM });
      const meta = auditSink.rows.find((r) => r.eventType === "audit.elevated_access");
      expect(meta).toBeTruthy();
      expect(meta?.severity).toBe("warn");
      await app.close();
    });
  });
});
