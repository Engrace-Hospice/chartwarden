// apps/backend/__tests__/audit-accounting.test.ts — M4-T09 patient accounting-of-disclosures
// integration tests (M4 spec §7 scope differentiation; §10.3 §164.528; W-M4-10 Part 2 lifetime).
//
// Exercises `GET /api/v1/audit/patients/:patientId/accounting` through the FULL M1 middleware
// chain via Fastify `inject` with no live infra: buildServer() mounts the host,
// registerPatientAccountingRoute() mounts the route against the in-memory `AuditQuery`
// (@wardenx/audit) seeded with the disclosure/read rows a PHI route would have produced. The REAL
// Authorization Contract gates the route: `requirePermission('audit.disclosure_report')` plus the
// `audit_accounting_scope_allowed` ABAC predicate M4 registers into M3's registry (the `?scope=all`
// escalation). A header-auth shim populates request.context.
import { createInMemoryAuditQuery } from "@wardenx/audit";
import type { AuditEventRecord } from "@wardenx/audit";
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
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import {
  registerAccountingScopePredicate,
  registerPatientAccountingRoute,
} from "../src/modules/04-audit/index";

/** Test-only auth shim: populate request.context from headers (mirrors audit-routes.test). */
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

/** ISO timestamp `years` whole years before now — keeps the 6-year clamp test wall-clock stable. */
function yearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString();
}

/** Seeds the rows the PHI read/disclosure helpers + SUD-unredact path would have produced. */
function seedRecords(): AuditEventRecord[] {
  const base = {
    organizationId: ORG,
    actorKind: "user",
    actorUserId: "rn_1",
    actorRole: "clinical_rn" as string | null,
    outcome: "success" as const,
    severity: "info" as const,
    before: null,
    after: null,
  };
  return [
    // D1 — a recent, non-SUD external disclosure (HIPAA-accountable; within the 6-year window).
    {
      ...base,
      id: EVT(1),
      createdAt: yearsAgo(1),
      eventType: "encounter.disclosed",
      resourceKind: "encounter",
      resourceId: EVT(8),
      severity: "warn",
      retentionClass: "compliance",
      context: {
        patientId: PATIENT,
        fields: ["diagnosis"],
        disclosure: { to: "Smith & Co Law", purpose: "patient-requested copy to attorney" },
      },
    },
    // D2 — an OLD SUD disclosure (8y ago): clamped OUT of HIPAA, but in Part 2 (lifetime).
    {
      ...base,
      id: EVT(2),
      createdAt: yearsAgo(8),
      eventType: "lab_observation.disclosed",
      resourceKind: "lab_observation",
      resourceId: EVT(9),
      severity: "warn",
      retentionClass: "compliance_42cfr_part2",
      context: {
        patientId: PATIENT,
        fields: ["result"],
        disclosure: { to: "County Health Dept", purpose: "mandated public-health report" },
      },
    },
    // D3 — a SUD privileged-unredact EXERCISE (2y ago): Part 2-accountable; rationale surfaced.
    {
      ...base,
      id: EVT(3),
      createdAt: yearsAgo(2),
      eventType: "sud.unredact.exercise",
      resourceKind: "lab_observation",
      resourceId: EVT(9),
      severity: "warn",
      retentionClass: "compliance_42cfr_part2",
      context: { patientId: PATIENT, rationale: "court order #1234 — disclosure to DA" },
    },
    // V1 — routine internal TPO access (a chart open): excluded from EVERY accounting scope.
    {
      ...base,
      id: EVT(4),
      createdAt: yearsAgo(1),
      eventType: "patient.viewed",
      resourceKind: "patient",
      resourceId: PATIENT,
      retentionClass: "compliance",
      context: { patientId: PATIENT, fields: ["name", "dob"] },
    },
    // a different patient's disclosure — must NOT appear in PATIENT's accounting.
    {
      ...base,
      id: EVT(5),
      createdAt: yearsAgo(1),
      eventType: "encounter.disclosed",
      resourceKind: "encounter",
      resourceId: EVT(7),
      retentionClass: "compliance",
      context: { patientId: PATIENT_OTHER, disclosure: { to: "X", purpose: "y" } },
    },
    // another org's disclosure of PATIENT — must never be visible to ORG.
    {
      ...base,
      id: EVT(6),
      organizationId: "org_b",
      createdAt: yearsAgo(1),
      eventType: "encounter.disclosed",
      resourceKind: "encounter",
      resourceId: EVT(6),
      retentionClass: "compliance",
      context: { patientId: PATIENT, disclosure: { to: "X", purpose: "y" } },
    },
  ];
}

const PERMISSION_SEED = [
  // Compliance Officer: base accounting right, but NOT the dedicated all-scope key.
  { organizationId: ORG, userId: "co_1", permissions: ["audit.disclosure_report"] },
  // Privacy Officer: base right + the all-scope key (may request `?scope=all`).
  {
    organizationId: ORG,
    userId: "po_1",
    permissions: ["audit.disclosure_report", "audit.disclosure_report_all_scopes"],
  },
  // A clinician with no accounting right at all.
  { organizationId: ORG, userId: "rn_1", permissions: ["patient.read"] },
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

  // Register M4's accounting-scope predicate into a fresh registry (test isolation), then install
  // it as the contract's ABAC evaluator. The default probe reads the resolver registered above.
  const registry = createPredicateRegistry();
  registerAccountingScopePredicate({ registry });
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientAccountingRoute(app, { query: audit.query, audit: auditSink.executor });
  return { app, auditSink };
}

const COMPLIANCE = { "x-test-user": "co_1", "x-test-org": ORG, "x-test-roles": "compliance" };
const PRIVACY = { "x-test-user": "po_1", "x-test-org": ORG, "x-test-roles": "privacy" };
const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const url = (scope?: string) =>
  `/api/v1/audit/patients/${PATIENT}/accounting${scope ? `?scope=${scope}` : ""}`;

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

describe("M4-T09 patient accounting of disclosures (§7, §10.3)", () => {
  describe("the audit.disclosure_report gate", () => {
    it("unauthenticated → 401", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: url() });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("an actor without audit.disclosure_report → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: url(), headers: CLINICIAN });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("§10.3 HIPAA §164.528 accounting (default scope)", () => {
    it("lists external disclosures within 6 years, excludes routine TPO, and is itself audited", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({ method: "GET", url: url("hipaa_528"), headers: COMPLIANCE });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Only the recent non-SUD disclosure (D1): D2 is clamped out (8y), D3 is not a disclosure,
      // V1 is routine TPO, the other patient/org rows are scoped out.
      expect(body.disclosures.map((d: { eventId: string }) => d.eventId)).toEqual([EVT(1)]);
      const d1 = body.disclosures[0];
      expect(d1.recipient).toBe("Smith & Co Law");
      expect(d1.purpose).toBe("patient-requested copy to attorney");
      expect(d1.description).toContain("diagnosis");
      expect(d1.rationale).toBeUndefined(); // never surfaced for HIPAA scope
      expect(body.note).toContain("§164.528(a)(1)");
      // the generation is itself audited at the `compliance` retention class.
      const meta = auditSink.rows.find(
        (r) => r.eventType === "audit.disclosure_report_generated_hipaa",
      );
      expect(meta).toBeTruthy();
      expect(meta?.retentionClass).toBe("compliance");
      expect(meta?.resourceId).toBe(PATIENT);
      await app.close();
    });

    it("defaults to HIPAA scope when none is supplied", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: url(), headers: COMPLIANCE });
      expect(res.statusCode).toBe(200);
      expect(res.json().disclosures.map((d: { eventId: string }) => d.eventId)).toEqual([EVT(1)]);
      await app.close();
    });
  });

  describe("W-M4-10 — Part 2 §2.13 accounting returns lifetime disclosures", () => {
    it("returns every SUD disclosure ever (no 6-year clamp) + the unredact rationale; audited at Part 2 class", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({ method: "GET", url: url("part_2_13"), headers: COMPLIANCE });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // newest-first: the 2y-ago unredact exercise, then the 8y-ago SUD disclosure (lifetime).
      expect(body.disclosures.map((d: { eventId: string }) => d.eventId)).toEqual([EVT(3), EVT(2)]);
      const exercise = body.disclosures.find((d: { eventId: string }) => d.eventId === EVT(3));
      expect(exercise.rationale).toBe("court order #1234 — disclosure to DA"); // §4.6.4: not scrubbed
      // the period floor is the epoch (no clamp).
      expect(body.period.from).toBe(new Date(0).toISOString());
      // the request itself is audited at the stricter Part 2 retention class.
      const meta = auditSink.rows.find(
        (r) => r.eventType === "audit.disclosure_report_generated_part_2",
      );
      expect(meta).toBeTruthy();
      expect(meta?.retentionClass as string).toBe("compliance_42cfr_part2");
      await app.close();
    });

    it("a subsequent HIPAA request returns a strict subset (the 6-year clamp drops the old SUD row)", async () => {
      const { app } = makeServer();
      const part2 = await app.inject({ method: "GET", url: url("part_2_13"), headers: COMPLIANCE });
      const hipaa = await app.inject({ method: "GET", url: url("hipaa_528"), headers: COMPLIANCE });
      const part2Ids = new Set(part2.json().disclosures.map((d: { eventId: string }) => d.eventId));
      const hipaaIds = hipaa.json().disclosures.map((d: { eventId: string }) => d.eventId);
      expect(part2Ids).toEqual(new Set([EVT(3), EVT(2)]));
      expect(hipaaIds).toEqual([EVT(1)]); // disjoint here — HIPAA never includes the SUD set
      await app.close();
    });
  });

  describe("§7.2 — `?scope=all` requires the dedicated permission (the ABAC predicate)", () => {
    it("without audit.disclosure_report_all_scopes → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: url("all"), headers: COMPLIANCE });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("with the all-scope permission → 200, union of HIPAA + Part 2 disclosures", async () => {
      const { app, auditSink } = makeServer();
      const res = await app.inject({ method: "GET", url: url("all"), headers: PRIVACY });
      expect(res.statusCode).toBe(200);
      const ids = res.json().disclosures.map((d: { eventId: string }) => d.eventId);
      expect(new Set(ids)).toEqual(new Set([EVT(1), EVT(2), EVT(3)]));
      // `all` audits at the Part 2 retention class (it can surface Part 2 disclosures, §7.1).
      const meta = auditSink.rows.find(
        (r) => r.eventType === "audit.disclosure_report_generated_part_2",
      );
      expect(meta?.retentionClass as string).toBe("compliance_42cfr_part2");
      await app.close();
    });
  });

  describe("tenant isolation", () => {
    it("never surfaces another org's disclosure of the same patient", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: url("all"), headers: PRIVACY });
      const ids = res.json().disclosures.map((d: { eventId: string }) => d.eventId);
      expect(ids).not.toContain(EVT(6)); // org_b row
      await app.close();
    });
  });
});
