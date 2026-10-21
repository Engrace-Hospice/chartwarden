/**
 * GAP-003 — legal holds / destruction certificates / audit exports / integrity report against
 * REAL Postgres. The route files (legal-holds.ts, destruction-certificates.ts, audit-exports.ts,
 * audit-integrity.ts) talk to Drizzle + `withOrgContext` directly (not an in-memory port), so their
 * RLS scoping, the append-only-grant read, the rate limit, and the bounded match-count scan are
 * only provable against a live cluster — the m39-consent-lifecycle.live.test.ts precedent.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/gap-003-compliance-routes.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleSeams } from "../src/index";
import { mountAuditRoutes } from "../src/modules/04-audit/index";
import { openMessageCertificate } from "../src/modules/04-audit/messaging-hold-workflow";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PATIENT = "33333333-3333-3333-3333-333333333333";
const SESSION = "sess-gap003";

describe.skipIf(!DB_URL)("GAP-003 compliance routes — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof buildServer>;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  /** header-auth shim (audit-accounting.test.ts precedent) + the sessionId step_up_recent reads. */
  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    request.context.organizationId = ORG;
    request.context.roles = ["compliance"];
    request.context.attributes = { sessionId: SESSION };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap003','GAP-003 Org','GAP-003 Org')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap003-live@x.test')`, [USER]);
    await admin.query("ALTER ROLE wardenx_app LOGIN PASSWORD 'wardenx-gap003-test'");
    const appUrl = new URL(DB_URL as string);
    appUrl.username = "wardenx_app";
    appUrl.password = "wardenx-gap003-test";
    handle = createDbClient({ connectionString: appUrl.toString() });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();

    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              "legalhold.read",
              "legalhold.manage",
              "destruction.read",
              "destruction.approve",
              "audit.export",
              "audit.integrity",
              "audit.read",
            ],
          },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);

    // Real step_up_recent evaluation (not a stub): a fresh totp step-up on SESSION.
    const { store: sessionStore } = createInMemorySessionContextStore([
      {
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: SESSION,
        userId: USER,
        membershipId: null,
        organizationId: ORG,
        roles: ["compliance"],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "totp",
      },
    ]);
    wireModuleSeams({ sessionContextStore: sessionStore });
    // wireModuleSeams re-registers its own abac evaluator over `abacRegistry`; nothing else to do.

    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountAuditRoutes(app, handle.db);
  });

  afterEach(async () => {
    await app?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    // Clean the mutable M4 tables between tests (cheaper than a full schema reset per test).
    await admin.query(
      "TRUNCATE legal_hold, destruction_certificate, audit_export RESTART IDENTITY CASCADE",
    );
    await admin.query("DELETE FROM audit_event");
  });

  const HEADERS = { "x-test-user": USER };

  async function seedDisclosureEvent(
    overrides: Partial<{ patientId: string; resourceKind: string }> = {},
  ) {
    await admin.query(
      `INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind,
         resource_id, outcome, severity, before, after, context, correlation_id, retention_class)
       VALUES ($1,$2,'user','patient.disclosed',$3,$4::uuid,'success','info','{}','{}',
         jsonb_build_object('patientId', $4::text), 'corr-1', 'compliance')`,
      [ORG, USER, overrides.resourceKind ?? "patient", overrides.patientId ?? PATIENT],
    );
  }

  describe("legal holds", () => {
    it("applies a hold with a REAL matched-record count, lists it, then releases it", async () => {
      await seedDisclosureEvent();
      await seedDisclosureEvent();
      await seedDisclosureEvent({ patientId: "44444444-4444-4444-4444-444444444444" });

      const create = await app.inject({
        method: "POST",
        url: "/api/v1/legal-holds",
        headers: HEADERS,
        payload: {
          name: "Litigation hold — Smith v. WardenX",
          reason: "Pending litigation discovery request received 2026-08-08",
          criteria: { patientIds: [PATIENT] },
        },
      });
      expect(create.statusCode).toBe(201);
      const created = create.json();
      expect(created.matchedRecordCount).toBe(2); // only the 2 events for PATIENT match

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/legal-holds",
        headers: HEADERS,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].status).toBe("active");

      const release = await app.inject({
        method: "POST",
        url: `/api/v1/legal-holds/${created.legalHoldId}/release`,
        headers: HEADERS,
        payload: { reason: "Litigation resolved, discovery hold no longer required" },
      });
      expect(release.statusCode).toBe(200);
      expect(release.json()).toEqual({ released: true, restoredRecordCount: 2 });

      // Two independent capture paths land rows here: the DB-level write-audit trigger on
      // `legal_hold` (migration 0012's `legal_hold_audit`, `legal_hold.insert`/`.update`) fires on
      // every row change, and the route's own explicit compliance-lifecycle audit() call fires the
      // semantic `data.legal_hold_applied`/`_released` events (§7) — both are expected; assert the
      // semantic ones are present rather than assuming either mechanism is the only writer.
      const events = await admin.query(
        "SELECT event_type FROM audit_event WHERE resource_kind='legal_hold' ORDER BY created_at",
      );
      const semanticEvents = events.rows
        .map((r) => r.event_type)
        .filter((t) => t.startsWith("data.legal_hold_"));
      expect(semanticEvents).toEqual(["data.legal_hold_applied", "data.legal_hold_released"]);
    });

    it("422s an empty-criteria hold request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/legal-holds",
        headers: HEADERS,
        payload: { name: "No criteria", reason: "This should be refused as empty", criteria: {} },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("EMPTY_CRITERIA");
    });
  });

  describe("destruction certificates", () => {
    async function seedCertificate(dataClass = "audit_event"): Promise<string> {
      const result = await admin.query(
        `INSERT INTO destruction_certificate
           (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
         VALUES ($1,$2,10,'2020-01-01','2020-06-30','crypto_erasure','pending') RETURNING id`,
        [ORG, dataClass],
      );
      return result.rows[0].id;
    }

    it("approves a pending certificate with no active hold covering its data class", async () => {
      const certId = await seedCertificate();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/destruction-certificates/${certId}/approve`,
        headers: HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "approved" });
      const row = await admin.query(
        "SELECT status, approved_by FROM destruction_certificate WHERE id=$1",
        [certId],
      );
      expect(row.rows[0].status).toBe("approved");
      expect(row.rows[0].approved_by).toBe(USER);
    });

    it("409s HELD_RECORDS_PRESENT when an active legal hold covers the certificate's data class", async () => {
      const certId = await seedCertificate("audit_event");
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, status)
         VALUES ($1,'Covers audit_event', $2,'Pre-seeded covering hold for the live test','active')`,
        [ORG, JSON.stringify({ resourceKinds: ["audit_event"] })],
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/destruction-certificates/${certId}/approve`,
        headers: HEADERS,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("HELD_RECORDS_PRESENT");
    });

    it("a messaging-only (channelIds) hold is accepted, counts no audit rows, and does not block an audit certificate", async () => {
      await seedDisclosureEvent();
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/legal-holds",
        headers: HEADERS,
        payload: {
          name: "Channel hold",
          reason: "Preserve one channel for a pending inquiry",
          criteria: { channelIds: ["44444444-4444-4444-8444-444444444444"] },
        },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().matchedRecordCount).toBe(0);
      const certId = await seedCertificate("audit_event");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/destruction-certificates/${certId}/approve`,
        headers: HEADERS,
      });
      expect(res.statusCode).toBe(200);
    });

    it("openMessageCertificate is idempotent on (dataClass, rangeStart)", async () => {
      const input = {
        organizationId: ORG,
        dataClass: "message.operational",
        rangeStart: new Date("2025-01-01T00:00:00Z"),
        rangeEnd: new Date("2025-01-31T23:59:59Z"),
        recordCount: 4,
      };
      const first = await withOrgContext<DbClient, { id: string; created: boolean }>(
        handle.db,
        { organizationId: ORG, userId: USER },
        (tx) => openMessageCertificate(tx, input),
      );
      const second = await withOrgContext<DbClient, { id: string; created: boolean }>(
        handle.db,
        { organizationId: ORG, userId: USER },
        (tx) => openMessageCertificate(tx, { ...input, recordCount: 9 }),
      );
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
      const rows = await admin.query(
        "SELECT status, record_count FROM destruction_certificate WHERE data_class='message.operational'",
      );
      expect(rows.rows).toEqual([{ status: "pending", record_count: 4 }]);
    });

    it("defers a certificate to held with a reason", async () => {
      const certId = await seedCertificate();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/destruction-certificates/${certId}/hold`,
        headers: HEADERS,
        payload: { reason: "Litigation hold pending review of this data class" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "held" });
    });
  });

  describe("audit exports", () => {
    it("requests an export, retrieves it, and rate-limits a second request within the hour", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/audit/exports",
        headers: HEADERS,
        payload: {
          scope: { from: "2020-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
          justification: "Quarterly compliance review export for the board",
          format: "csv",
        },
      });
      expect(create.statusCode).toBe(202);
      const { exportId } = create.json();
      expect(create.json().status).toBe("pending");

      const get = await app.inject({
        method: "GET",
        url: `/api/v1/audit/exports/${exportId}`,
        headers: HEADERS,
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ id: exportId, status: "pending", format: "csv" });
      expect(get.json().downloadUrl).toBeUndefined();

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/audit/exports",
        headers: HEADERS,
        payload: {
          scope: { from: "2020-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
          justification: "A second export requested in the same hour",
          format: "ndjson",
        },
      });
      expect(second.statusCode).toBe(429);
    });
  });

  describe("integrity report", () => {
    it("reports the append-only GRANT model as verified (migration 0001/0119 hold)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/integrity/report",
        headers: HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.appendOnly.grantsVerified).toBe(true);
      expect(body.backupSampling).toBeUndefined();
      expect(body.sealChain).toBeUndefined();
    });
  });
});
